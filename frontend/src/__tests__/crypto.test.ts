import { describe, it, expect } from 'vitest'
import {
  NonceLruCache,
  generateNonce,
  deriveHmacKey,
  signSignalingPayload,
  verifySignalingPayload,
  generateEcdhKeyPair,
  exportEcdhPublicKey,
  importEcdhPublicKey,
  deriveSharedAesKey,
  encryptSignalingData,
  decryptSignalingData,
  computeSecurityFingerprint
} from '../utils/crypto'

describe('Crypto & Signaling Security Utils', () => {
  describe('NonceLruCache', () => {
    it('accepts fresh nonces within 30s time window and rejects duplicates', () => {
      const cache = new NonceLruCache(5000, 30000)
      const now = Date.now()

      expect(cache.verifyAndAdd('nonce_1', now)).toBe(true)
      // Replay of same nonce should fail
      expect(cache.verifyAndAdd('nonce_1', now)).toBe(false)
      // Second distinct nonce succeeds
      expect(cache.verifyAndAdd('nonce_2', now)).toBe(true)
      expect(cache.size()).toBe(2)
    })

    it('rejects expired nonces older than TTL window (30s)', () => {
      const cache = new NonceLruCache(5000, 30000)
      const now = Date.now()

      // 35s in the past
      expect(cache.verifyAndAdd('nonce_old', now - 35000)).toBe(false)
      // 35s in the future (skewed clock)
      expect(cache.verifyAndAdd('nonce_future', now + 35000)).toBe(false)
    })

    it('handles high-frequency candidate bursts (>1500 candidates) within capacity', () => {
      const cache = new NonceLruCache(5000, 30000)
      const now = Date.now()

      // Simulate 1500 ICE candidates burst within 30s
      for (let i = 0; i < 1500; i++) {
        const nonce = `cand_${i}_${generateNonce(8)}`
        const accepted = cache.verifyAndAdd(nonce, now)
        expect(accepted).toBe(true)
      }

      expect(cache.size()).toBe(1500)

      // Verify no duplicates accepted even under high volume
      expect(cache.verifyAndAdd('cand_500_xxx', now)).toBe(true)
      expect(cache.verifyAndAdd('cand_500_xxx', now)).toBe(false)
    })
  })

  describe('HMAC-SHA256 Payload Signing & Verification', () => {
    it('signs and successfully verifies canonical payload', async () => {
      const hmacKey = await deriveHmacKey('INVITE123')
      const payload = {
        sender: 'alice',
        target: 'bob',
        type: 'offer',
        ecdhPublicKey: '04a1b2c3d4...',
        timestamp: Date.now(),
        nonce: generateNonce()
      }

      const signature = await signSignalingPayload(hmacKey, payload)
      expect(signature).toBeDefined()
      expect(signature.length).toBe(64) // 256 bits hex

      const isValid = await verifySignalingPayload(hmacKey, payload, signature)
      expect(isValid).toBe(true)
    })

    it('rejects tampered payload (e.g. modified ecdhPublicKey or sdp)', async () => {
      const hmacKey = await deriveHmacKey('INVITE123')
      const payload = {
        sender: 'alice',
        target: 'bob',
        type: 'offer',
        ecdhPublicKey: '04legitimate_key...',
        timestamp: Date.now(),
        nonce: generateNonce()
      }

      const signature = await signSignalingPayload(hmacKey, payload)

      // Attacker tampers with the public key
      const tamperedPayload = {
        ...payload,
        ecdhPublicKey: '04malicious_attacker_key...'
      }

      const isValid = await verifySignalingPayload(hmacKey, tamperedPayload, signature)
      expect(isValid).toBe(false)
    })

    it('rejects signature derived from wrong inviteCode', async () => {
      const keyAlice = await deriveHmacKey('ROOM_AAA')
      const keyBob = await deriveHmacKey('ROOM_BBB')

      const payload = { sender: 'alice', type: 'offer', timestamp: Date.now(), nonce: generateNonce() }
      const signature = await signSignalingPayload(keyAlice, payload)

      const isValid = await verifySignalingPayload(keyBob, payload, signature)
      expect(isValid).toBe(false)
    })
  })

  describe('ECDH (P-256) & AES-256-GCM End-to-End Encryption', () => {
    it('performs ECDH key exchange and decrypts ciphertext symmetrically', async () => {
      // 1. Generate keypairs for Alice (Host) and Bob (Client)
      const aliceKeyPair = await generateEcdhKeyPair()
      const bobKeyPair = await generateEcdhKeyPair()

      // 2. Export & exchange public keys
      const alicePubHex = await exportEcdhPublicKey(aliceKeyPair.publicKey)
      const bobPubHex = await exportEcdhPublicKey(bobKeyPair.publicKey)

      const aliceImportedBobPub = await importEcdhPublicKey(bobPubHex)
      const bobImportedAlicePub = await importEcdhPublicKey(alicePubHex)

      // 3. Derive shared AES-256-GCM keys
      const aliceAesKey = await deriveSharedAesKey(aliceKeyPair.privateKey, aliceImportedBobPub)
      const bobAesKey = await deriveSharedAesKey(bobKeyPair.privateKey, bobImportedAlicePub)

      // 4. Alice encrypts an SDP offer
      const plaintextSdp = JSON.stringify({ type: 'offer', sdp: 'v=0\r\no=- 12345 2 IN IP4 127.0.0.1...' })
      const encrypted = await encryptSignalingData(aliceAesKey, plaintextSdp)

      expect(encrypted.iv).toBeDefined()
      expect(encrypted.ciphertext).toBeDefined()
      expect(encrypted.ciphertext).not.toContain('v=0')

      // 5. Bob decrypts with his shared key
      const decrypted = await decryptSignalingData(bobAesKey, encrypted)
      expect(decrypted).toBe(plaintextSdp)
      expect(JSON.parse(decrypted).type).toBe('offer')
    })

    it('fails decryption when ciphertext is tampered or key is wrong', async () => {
      const aliceKeyPair = await generateEcdhKeyPair()
      const bobKeyPair = await generateEcdhKeyPair()
      const eveKeyPair = await generateEcdhKeyPair()

      const bobPubHex = await exportEcdhPublicKey(bobKeyPair.publicKey)
      const evePubHex = await exportEcdhPublicKey(eveKeyPair.publicKey)

      const aliceAesKey = await deriveSharedAesKey(aliceKeyPair.privateKey, await importEcdhPublicKey(bobPubHex))
      const eveAesKey = await deriveSharedAesKey(eveKeyPair.privateKey, await importEcdhPublicKey(bobPubHex))

      const encrypted = await encryptSignalingData(aliceAesKey, 'sensitive-sdp-candidate-data')

      // Eve attempts to decrypt with wrong key
      await expect(decryptSignalingData(eveAesKey, encrypted)).rejects.toThrow()

      // Tampering with ciphertext fails auth tag check in AES-GCM
      const firstChar = encrypted.ciphertext[0] === '0' ? '1' : '0'
      const tampered = {
        iv: encrypted.iv,
        ciphertext: firstChar + encrypted.ciphertext.slice(1)
      }
      await expect(decryptSignalingData(aliceAesKey, tampered)).rejects.toThrow()
    })
  })

  describe('computeSecurityFingerprint (SAS / Short Authentication String)', () => {
    it('is symmetric regardless of key argument order', async () => {
      const pubA = '04a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
      const pubB = '04fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321'
      const room = 'EVENT_ROOM_99'

      const sas1 = await computeSecurityFingerprint(pubA, pubB, room)
      const sas2 = await computeSecurityFingerprint(pubB, pubA, room)

      expect(sas1).toBeDefined()
      expect(sas1.length).toBe(9) // e.g. "ABCD-EF01"
      expect(sas1).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/)
      expect(sas1).toBe(sas2)
    })

    it('is case-insensitive with hex public keys', async () => {
      const pubA = '04A1B2C3D4E5'
      const pubB = '04fedcba0987'
      const room = 'EVENT_ROOM_99'

      const sasUpper = await computeSecurityFingerprint(pubA, pubB, room)
      const sasLower = await computeSecurityFingerprint(pubA.toLowerCase(), pubB.toUpperCase(), room)

      expect(sasUpper).toBe(sasLower)
    })

    it('produces different fingerprints if public key or room code differs (MITM alert)', async () => {
      const pubAlice = '041111111111'
      const pubBob = '042222222222'
      const pubEve = '049999999999' // Attacker substituting key
      const room = 'ROOM1'

      const legitFingerprint = await computeSecurityFingerprint(pubAlice, pubBob, room)
      const mitmAliceEve = await computeSecurityFingerprint(pubAlice, pubEve, room)
      const mitmBobEve = await computeSecurityFingerprint(pubBob, pubEve, room)

      expect(legitFingerprint).not.toBe(mitmAliceEve)
      expect(legitFingerprint).not.toBe(mitmBobEve)
      expect(mitmAliceEve).not.toBe(mitmBobEve)
    })

    it('returns empty string if either key is missing', async () => {
      expect(await computeSecurityFingerprint('', '04abc', 'ROOM')).toBe('')
      expect(await computeSecurityFingerprint('04abc', '', 'ROOM')).toBe('')
    })
  })

  describe('Pure JS SHA-256 fallback', () => {
    it('computes exact standard SHA-256 hashes matching official test vectors', async () => {
      const { pureJsSha256, sha256Hex } = await import('../utils/crypto')
      const enc = new TextEncoder()
      // Test vector 1: empty string
      expect(pureJsSha256(enc.encode(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
      expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')

      // Test vector 2: "hello"
      expect(pureJsSha256(enc.encode('hello'))).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
      expect(await sha256Hex('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')

      // Test vector 3: longer string
      const str = 'The quick brown fox jumps over the lazy dog'
      const expected = 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592'
      expect(pureJsSha256(enc.encode(str))).toBe(expected)
      expect(await sha256Hex(str)).toBe(expected)
    })
  })
})

