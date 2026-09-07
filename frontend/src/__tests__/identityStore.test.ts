import { describe, it, expect, beforeEach } from 'vitest'
import {
  getOrCreateDeviceIdentity,
  getPeerTrustRecord,
  savePeerTrustRecord,
  listUserTrustedDevices,
  evaluatePeerKeyTrust,
  clearSecurityStoreForTesting
} from '../utils/identityStore'
import { generateEcdhKeyPair, exportEcdhPublicKey } from '../utils/crypto'

describe('identityStore - Persistent Device Identity & TOFU Engine', () => {
  beforeEach(async () => {
    await clearSecurityStoreForTesting()
  })

  it('Guarantee 1: Identity key persistence across calls', async () => {
    const dev1 = await getOrCreateDeviceIdentity()
    expect(dev1.deviceId).toBeDefined()
    expect(dev1.deviceId.startsWith('dev_')).toBe(true)
    expect(dev1.publicKeyHex.startsWith('04')).toBe(true)

    // Second call should return the exact same device identity
    const dev2 = await getOrCreateDeviceIdentity()
    expect(dev2.deviceId).toBe(dev1.deviceId)
    expect(dev2.publicKeyHex).toBe(dev1.publicKeyHex)
  })

  it('Guarantee 2 & 4: TOFU Trust On First Use & Multi-Device User Tracking', async () => {
    const keyPair1 = await generateEcdhKeyPair()
    const pubHex1 = await exportEcdhPublicKey(keyPair1.publicKey)

    // 1. First time seeing Alice on Laptop (dev_alice_laptop)
    const result1 = await evaluatePeerKeyTrust({
      eventId: 'evt_2026',
      userId: 'user_alice',
      username: 'Alice',
      deviceId: 'dev_alice_laptop',
      publicKeyHex: pubHex1
    })

    expect(result1.status).toBe('TOFU_FIRST_SEEN')
    if (result1.status === 'TOFU_FIRST_SEEN') {
      expect(result1.isNewDeviceForUser).toBe(false)
      expect(result1.existingDeviceCount).toBe(0)
    }

    // Local trust action records this device
    await savePeerTrustRecord({
      eventId: 'evt_2026',
      userId: 'user_alice',
      username: 'Alice',
      deviceId: 'dev_alice_laptop',
      publicKeyHex: pubHex1,
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
      trustedAt: Date.now(),
      trustLevel: 'TOFU_TRUSTED'
    })

    // 2. Reconnection with same device & same key -> Instant TRUSTED_MATCH
    const result2 = await evaluatePeerKeyTrust({
      eventId: 'evt_2026',
      userId: 'user_alice',
      username: 'Alice',
      deviceId: 'dev_alice_laptop',
      publicKeyHex: pubHex1
    })

    expect(result2.status).toBe('TRUSTED_MATCH')

    // 3. Alice connects using a second device (dev_alice_phone)
    const keyPair2 = await generateEcdhKeyPair()
    const pubHex2 = await exportEcdhPublicKey(keyPair2.publicKey)

    const result3 = await evaluatePeerKeyTrust({
      eventId: 'evt_2026',
      userId: 'user_alice',
      username: 'Alice',
      deviceId: 'dev_alice_phone',
      publicKeyHex: pubHex2
    })

    expect(result3.status).toBe('TOFU_FIRST_SEEN')
    if (result3.status === 'TOFU_FIRST_SEEN') {
      // Recognized as a new device for existing user, NOT a malicious key change!
      expect(result3.isNewDeviceForUser).toBe(true)
      expect(result3.existingDeviceCount).toBe(1)
    }
  })

  it('Guarantee 3: Graduated Alerting - Distinguishes Reinstall from In-Session Flapping', async () => {
    const keyPairOrig = await generateEcdhKeyPair()
    const pubHexOrig = await exportEcdhPublicKey(keyPairOrig.publicKey)

    await savePeerTrustRecord({
      eventId: 'evt_2026',
      userId: 'user_bob',
      username: 'Bob',
      deviceId: 'dev_bob_pc',
      publicKeyHex: pubHexOrig,
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
      trustedAt: Date.now(),
      trustLevel: 'TOFU_TRUSTED'
    })

    const keyPairNew = await generateEcdhKeyPair()
    const pubHexNew = await exportEcdhPublicKey(keyPairNew.publicKey)

    // Sub-case A: Normal key change (e.g. app reinstalled on same device) -> WARNING
    const resultWarning = await evaluatePeerKeyTrust({
      eventId: 'evt_2026',
      userId: 'user_bob',
      username: 'Bob',
      deviceId: 'dev_bob_pc',
      publicKeyHex: pubHexNew,
      isInSessionFlapping: false
    })

    expect(resultWarning.status).toBe('KEY_ROTATION_ALERT')
    if (resultWarning.status === 'KEY_ROTATION_ALERT') {
      expect(resultWarning.level).toBe('WARNING')
      expect(resultWarning.reason).toBe('DEVICE_KEY_CHANGED')
    }

    // Sub-case B: In-session flapping during active connection -> CRITICAL
    const resultCritical = await evaluatePeerKeyTrust({
      eventId: 'evt_2026',
      userId: 'user_bob',
      username: 'Bob',
      deviceId: 'dev_bob_pc',
      publicKeyHex: pubHexNew,
      isInSessionFlapping: true
    })

    expect(resultCritical.status).toBe('KEY_ROTATION_ALERT')
    if (resultCritical.status === 'KEY_ROTATION_ALERT') {
      expect(resultCritical.level).toBe('CRITICAL')
      expect(resultCritical.reason).toBe('IN_SESSION_FLAPPING')
    }
  })
})
