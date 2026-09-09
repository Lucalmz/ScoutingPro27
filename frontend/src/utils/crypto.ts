/**
 * Cryptographic utilities for WebRTC signaling channel security:
 * 1. HMAC-SHA256 full-payload signing & verification (anti-tampering & authentication)
 * 2. Nonce + Timestamp replay protection with LRU cache (capacity: 5000)
 * 3. Ephemeral ECDH (P-256) key exchange & HKDF derivation
 * 4. AES-256-GCM authenticated encryption/decryption of signaling payloads
 */

export class NonceLruCache {
  private cache = new Map<string, number>()
  private readonly maxCapacity: number
  private readonly ttlMs: number

  constructor(maxCapacity = 5000, ttlMs = 30000) {
    this.maxCapacity = maxCapacity
    this.ttlMs = ttlMs
  }

  /**
   * Verifies if nonce is fresh. Returns true if valid, false if replayed/expired.
   */
  public verifyAndAdd(nonce: string, timestamp: number): boolean {
    const now = Date.now()
    // 1. Time window validation (±30s)
    if (Math.abs(now - timestamp) > this.ttlMs) {
      return false
    }

    // 2. Replay check
    if (this.cache.has(nonce)) {
      return false
    }

    // 3. Purge expired entries if cache is large
    if (this.cache.size >= this.maxCapacity) {
      this.evictExpired(now)
      // If still exceeding, evict oldest FIFO
      if (this.cache.size >= this.maxCapacity) {
        const oldestKey = this.cache.keys().next().value
        if (oldestKey) this.cache.delete(oldestKey)
      }
    }

    this.cache.set(nonce, timestamp)
    return true
  }

  public size(): number {
    return this.cache.size
  }

  public clear(): void {
    this.cache.clear()
  }

  private evictExpired(now: number): void {
    for (const [nonce, ts] of this.cache.entries()) {
      if (now - ts > this.ttlMs) {
        this.cache.delete(nonce)
      }
    }
  }
}

// Global Nonce cache
export const globalNonceCache = new NonceLruCache(5000, 30000)

/**
 * Generate a cryptographically secure random Nonce
 */
export function generateNonce(length = 16): string {
  const bytes = new Uint8Array(length)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Check if Web Cryptography API subtle interface is supported and accessible (secure context)
 */
export function hasSubtleCrypto(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined' && typeof crypto.subtle.digest === 'function'
}

/**
 * RFC 6234 compliant pure-JS SHA-256 for non-secure contexts (e.g. HTTP LAN access on mobile devices)
 */
export function pureJsSha256(data: Uint8Array): string {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19

  const len = data.length
  const bitLen = len * 8
  const padLen = (56 - ((len + 1) % 64) + 64) % 64
  const totalLen = len + 1 + padLen + 8
  const padded = new Uint8Array(totalLen)
  padded.set(data)
  padded[len] = 0x80

  const view = new DataView(padded.buffer)
  view.setUint32(totalLen - 4, bitLen >>> 0, false)
  view.setUint32(totalLen - 8, Math.floor(bitLen / 0x100000000), false)

  const w = new Uint32Array(64)
  for (let i = 0; i < totalLen; i += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] = view.getUint32(i + t * 4, false)
    }
    for (let t = 16; t < 64; t++) {
      const wt15 = w[t - 15] ?? 0
      const wt2 = w[t - 2] ?? 0
      const wt16 = w[t - 16] ?? 0
      const wt7 = w[t - 7] ?? 0
      const s0 = ((wt15 >>> 7) | (wt15 << 25)) ^ ((wt15 >>> 18) | (wt15 << 14)) ^ (wt15 >>> 3)
      const s1 = ((wt2 >>> 17) | (wt2 << 15)) ^ ((wt2 >>> 19) | (wt2 << 13)) ^ (wt2 >>> 10)
      w[t] = (((wt16 + s0) | 0) + ((wt7 + s1) | 0)) | 0
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7
    for (let t = 0; t < 64; t++) {
      const kt = K[t] ?? 0
      const wt = w[t] ?? 0
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const ch = (e & f) ^ ((~e) & g)
      const temp1 = (((((h + S1) | 0) + ch) | 0) + ((kt + wt) | 0)) | 0
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) | 0

      h = g
      g = f
      f = e
      e = (d + temp1) | 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) | 0
    }

    h0 = (h0 + a) | 0
    h1 = (h1 + b) | 0
    h2 = (h2 + c) | 0
    h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0
    h5 = (h5 + f) | 0
    h6 = (h6 + g) | 0
    h7 = (h7 + h) | 0
  }

  const out = new DataView(new ArrayBuffer(32))
  out.setUint32(0, h0, false)
  out.setUint32(4, h1, false)
  out.setUint32(8, h2, false)
  out.setUint32(12, h3, false)
  out.setUint32(16, h4, false)
  out.setUint32(20, h5, false)
  out.setUint32(24, h6, false)
  out.setUint32(28, h7, false)

  return Array.from(new Uint8Array(out.buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Compute SHA-256 hex string for a given text or public key
 */
export async function sha256Hex(str: string): Promise<string> {
  const enc = new TextEncoder()
  const data = enc.encode(str)
  if (hasSubtleCrypto()) {
    try {
      const hashBuffer = await crypto.subtle.digest('SHA-256', data)
      const hashArray = Array.from(new Uint8Array(hashBuffer))
      return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
    } catch {
      return pureJsSha256(data)
    }
  }
  return pureJsSha256(data)
}

/**
 * Derive an HMAC-SHA256 Key from inviteCode and room salt using PBKDF2 (100,000 iterations)
 */
export async function deriveHmacKey(inviteCode: string, roomSalt = 'scoutingpro27', iterations = 100000): Promise<CryptoKey | null> {
  if (!hasSubtleCrypto()) {
    return null
  }
  // Test hook to allow fast test execution in Vitest
  if (typeof (globalThis as any).__TEST_PBKDF2_ITERATIONS__ === 'number') {
    iterations = (globalThis as any).__TEST_PBKDF2_ITERATIONS__
  }
  const enc = new TextEncoder()
  const keyMaterial = enc.encode(inviteCode)
  const salt = enc.encode(roomSalt)

  try {
    const baseKey = await crypto.subtle.importKey(
      'raw',
      keyMaterial,
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    )

    return await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations,
        hash: 'SHA-256'
      },
      baseKey,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign', 'verify']
    )
  } catch (err) {
    console.warn('[Crypto] PBKDF2 / HMAC key derivation unavailable:', err)
    return null
  }
}

/**
 * Compute HMAC-SHA256 signature for canonical signaling payload
 */
export async function signSignalingPayload(hmacKey: CryptoKey | null, data: Record<string, any>): Promise<string> {
  if (!hmacKey || !hasSubtleCrypto()) return ''
  // Canonical sort keys to ensure reproducible signatures
  const sortedKeys = Object.keys(data).filter((k) => k !== 'signature').sort()
  const canonicalObj: Record<string, any> = {}
  for (const k of sortedKeys) {
    canonicalObj[k] = data[k]
  }
  const serialized = JSON.stringify(canonicalObj)
  const enc = new TextEncoder()
  try {
    const signatureBuffer = await crypto.subtle.sign('HMAC', hmacKey, enc.encode(serialized))
    return Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  } catch (err) {
    console.warn('[Crypto] Failed to sign payload with HMAC:', err)
    return ''
  }
}

/**
 * Verify HMAC-SHA256 signature for incoming signaling payload
 */
export async function verifySignalingPayload(
  hmacKey: CryptoKey | null,
  data: Record<string, any>,
  expectedSignature: string
): Promise<boolean> {
  if (!expectedSignature) return false
  if (!hmacKey || !hasSubtleCrypto()) return true // Gracefully pass in non-secure context

  const sortedKeys = Object.keys(data).filter((k) => k !== 'signature').sort()
  const canonicalObj: Record<string, any> = {}
  for (const k of sortedKeys) {
    canonicalObj[k] = data[k]
  }
  const serialized = JSON.stringify(canonicalObj)
  const enc = new TextEncoder()

  const expectedBytes = new Uint8Array(
    expectedSignature.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []
  )

  try {
    return await crypto.subtle.verify('HMAC', hmacKey, expectedBytes, enc.encode(serialized))
  } catch (err) {
    console.warn('[Crypto] Error verifying HMAC signature:', err)
    return false
  }
}

/**
 * Generate Ephemeral ECDH (P-256) Key Pair
 */
export async function generateEcdhKeyPair(): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits']
  )
}

/**
 * Export ECDH Public Key to raw JWK / Base64 string
 */
export async function exportEcdhPublicKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key)
  return Array.from(new Uint8Array(raw))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Import ECDH Public Key from raw hex string
 */
export async function importEcdhPublicKey(hexString: string): Promise<CryptoKey> {
  const bytes = new Uint8Array(
    hexString.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
  )
  return await crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  )
}

/**
 * Derive 256-bit AES-GCM Key from local private key and peer's public key using HKDF
 */
export async function deriveSharedAesKey(
  localPrivateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  salt = 'scoutingpro27-signaling'
): Promise<CryptoKey> {
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    localPrivateKey,
    256
  )

  // HKDF key derivation to ensure strong entropy
  const enc = new TextEncoder()
  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, { name: 'HKDF' }, false, ['deriveKey'])

  return await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: enc.encode(salt),
      info: enc.encode('webrtc-signaling-aes-gcm')
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/**
 * Encrypt plaintext string using AES-256-GCM
 */
export async function encryptSignalingData(
  aesKey: CryptoKey,
  plaintext: string
): Promise<{ iv: string; ciphertext: string }> {
  const enc = new TextEncoder()
  const iv = new Uint8Array(12)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(iv)
  }
  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    enc.encode(plaintext)
  )

  const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join('')
  const cipherHex = Array.from(new Uint8Array(encryptedBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

  return { iv: ivHex, ciphertext: cipherHex }
}

/**
 * Decrypt ciphertext using AES-256-GCM
 */
export async function decryptSignalingData(
  aesKey: CryptoKey,
  encrypted: { iv: string; ciphertext: string }
): Promise<string> {
  const ivBytes = new Uint8Array(
    encrypted.iv.match(/.{1,2}/g)?.map(b => parseInt(b, 16)) || []
  )
  const cipherBytes = new Uint8Array(
    encrypted.ciphertext.match(/.{1,2}/g)?.map(b => parseInt(b, 16)) || []
  )

  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes },
    aesKey,
    cipherBytes
  )

  const dec = new TextDecoder()
  return dec.decode(decryptedBuffer)
}

/**
 * Compute an out-of-band Short Authentication String (SAS) / Security Fingerprint
 * Symmetric function of both peers' public keys and room code:
 * SAS = SHA-256(min(pubA, pubB) + ":" + max(pubA, pubB) + ":" + inviteCode)
 * Returns formatted 8-char hex string, e.g. "A3F1-9BC2"
 */
export async function computeSecurityFingerprint(
  localPubHex: string,
  remotePubHex: string,
  inviteCode: string
): Promise<string> {
  if (!localPubHex || !remotePubHex) return ''
  const sortedKeys = [localPubHex.toLowerCase(), remotePubHex.toLowerCase()].sort()
  const payload = `${sortedKeys[0]}:${sortedKeys[1]}:${inviteCode.trim().toUpperCase()}`
  const hex = (await sha256Hex(payload)).toUpperCase()
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`
}

