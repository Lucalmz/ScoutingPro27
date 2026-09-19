import { describe, it, expect, beforeEach } from 'vitest'
import {
  getOrCreateDeviceIdentity,
  getPeerTrustRecord,
  savePeerTrustRecord,
  findPeerTrustRecordByDevice,
  listUserTrustedDevices,
  evaluatePeerKeyTrust,
  clearSecurityStoreForTesting,
  isInvalidPseudoUser,
  memTrustedPeers
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

  it('Guarantee 5: Multi-User Device Switch Detection', async () => {
    const keyPair = await generateEcdhKeyPair()
    const pubHex = await exportEcdhPublicKey(keyPair.publicKey)
    const sharedDeviceId = 'dev_shared_mobile'

    // Step 1: Alice logs in on shared mobile and establishes baseline trust
    await savePeerTrustRecord({
      eventId: 'evt_2026',
      userId: 'user_alice',
      username: 'Alice',
      deviceId: sharedDeviceId,
      publicKeyHex: pubHex,
      firstSeenAt: 1000,
      lastSeenAt: 1000,
      trustedAt: 1000,
      trustLevel: 'TOFU_TRUSTED'
    })

    // Step 2: Bob logs in on the exact same device and public key
    const bobEval = await evaluatePeerKeyTrust({
      eventId: 'evt_2026',
      userId: 'user_bob',
      username: 'Bob',
      deviceId: sharedDeviceId,
      publicKeyHex: pubHex
    })

    // MUST NOT return TRUSTED_MATCH; must require explicit verification
    expect(bobEval.status).toBe('MULTI_USER_DEVICE_SWITCH')
    if (bobEval.status === 'MULTI_USER_DEVICE_SWITCH') {
      expect(bobEval.requestedUserId).toBe('user_bob')
      expect(bobEval.existingRecord.userId).toBe('user_alice')
    }

    // Step 3: Bob completes verification and is recorded at t=2000
    await savePeerTrustRecord({
      eventId: 'evt_2026',
      userId: 'user_bob',
      username: 'Bob',
      deviceId: sharedDeviceId,
      publicKeyHex: pubHex,
      firstSeenAt: 2000,
      lastSeenAt: 2000,
      trustedAt: 2000,
      trustLevel: 'MANUAL_VERIFIED'
    })

    // Bob reconnecting immediately is trusted
    const bobReconnect = await evaluatePeerKeyTrust({
      eventId: 'evt_2026',
      userId: 'user_bob',
      username: 'Bob',
      deviceId: sharedDeviceId,
      publicKeyHex: pubHex
    })
    expect(bobReconnect.status).toBe('TRUSTED_MATCH')

    // Step 4: Alice logs back in on the shared device.
    // Even though Alice had an old record from t=1000, the device was last used by Bob at t=2000.
    // Therefore Alice must also trigger MULTI_USER_DEVICE_SWITCH!
    const aliceReturnEval = await evaluatePeerKeyTrust({
      eventId: 'evt_2026',
      userId: 'user_alice',
      username: 'Alice',
      deviceId: sharedDeviceId,
      publicKeyHex: pubHex
    })
    expect(aliceReturnEval.status).toBe('MULTI_USER_DEVICE_SWITCH')
  })

  it('Guarantee 6: Multi-Host Seamless Switching without repeated SAS alerts', async () => {
    const keyPairA = await generateEcdhKeyPair()
    const pubHexA = await exportEcdhPublicKey(keyPairA.publicKey)
    const devIdA = 'host_dev_A'

    const keyPairB = await generateEcdhKeyPair()
    const pubHexB = await exportEcdhPublicKey(keyPairB.publicKey)
    const devIdB = 'host_dev_B'

    const eventId = 'evt_championship_2026'

    // Step 1: Connect to Host A (run by user Lead Alpha) for the first time -> TOFU_FIRST_SEEN
    const hostAEval1 = await evaluatePeerKeyTrust({
      eventId,
      userId: 'user_lead_alpha',
      username: 'Lead Alpha',
      deviceId: devIdA,
      publicKeyHex: pubHexA
    })
    expect(hostAEval1.status).toBe('TOFU_FIRST_SEEN')

    // Host A trusted
    await savePeerTrustRecord({
      eventId,
      userId: 'user_lead_alpha',
      username: 'Lead Alpha',
      deviceId: devIdA,
      publicKeyHex: pubHexA,
      firstSeenAt: 1000,
      lastSeenAt: 1000,
      trustedAt: 1000,
      trustLevel: 'TOFU_TRUSTED'
    })

    // Step 2: Switch to Host B (Standby Host run by user Lead Beta) -> TOFU_FIRST_SEEN
    const hostBEval = await evaluatePeerKeyTrust({
      eventId,
      userId: 'user_lead_beta',
      username: 'Lead Beta',
      deviceId: devIdB,
      publicKeyHex: pubHexB
    })
    expect(hostBEval.status).toBe('TOFU_FIRST_SEEN')

    // Host B trusted by user verification
    await savePeerTrustRecord({
      eventId,
      userId: 'user_lead_beta',
      username: 'Lead Beta',
      deviceId: devIdB,
      publicKeyHex: pubHexB,
      firstSeenAt: 2000,
      lastSeenAt: 2000,
      trustedAt: 2000,
      trustLevel: 'MANUAL_VERIFIED'
    })

    // Step 3: Switch BACK to Host A -> MUST silently return TRUSTED_MATCH, never alert!
    const hostAReturnEval = await evaluatePeerKeyTrust({
      eventId,
      userId: 'user_lead_alpha',
      username: 'Lead Alpha',
      deviceId: devIdA,
      publicKeyHex: pubHexA
    })
    expect(hostAReturnEval.status).toBe('TRUSTED_MATCH')

    // Step 4: Switch BACK to Host B -> MUST silently return TRUSTED_MATCH, never alert!
    const hostBReturnEval = await evaluatePeerKeyTrust({
      eventId,
      userId: 'user_lead_beta',
      username: 'Lead Beta',
      deviceId: devIdB,
      publicKeyHex: pubHexB
    })
    expect(hostBReturnEval.status).toBe('TRUSTED_MATCH')

    // Step 5: Even if a host connects from another device using the same trusted key,
    // public key matching recognizes it immediately as TRUSTED_MATCH!
    const hostAFallbackDevId = await evaluatePeerKeyTrust({
      eventId,
      userId: 'user_lead_alpha',
      username: 'Lead Alpha',
      deviceId: 'host_dev_roaming_' + pubHexA.slice(0, 16),
      publicKeyHex: pubHexA
    })
    expect(hostAFallbackDevId.status).toBe('TRUSTED_MATCH')
  })

  it('Guarantee 7: Host Takeover & Demotion seamlessly binds to real user account without false MULTI_USER_DEVICE_SWITCH', async () => {
    const eventId = 'evt_takeover_2026'
    const keyPair1 = await generateEcdhKeyPair()
    const pubHex1 = await exportEcdhPublicKey(keyPair1.publicKey)
    const devId1 = 'dev_host_primary'

    // Step 1: Device 1 originally established as Host under real user 'Lucalmz'
    await savePeerTrustRecord({
      eventId,
      userId: 'user_lucalmz_83aa',
      username: 'Lucalmz',
      deviceId: devId1,
      publicKeyHex: pubHex1,
      firstSeenAt: 1000,
      lastSeenAt: 1000,
      trustedAt: 1000,
      trustLevel: 'TOFU_TRUSTED'
    })

    // Step 2: Device 2 takes over! Device 1 demotes to client and reconnects with real user 'Lucalmz'
    const demotedClientEval = await evaluatePeerKeyTrust({
      eventId,
      userId: 'user_lucalmz_83aa',
      username: 'Lucalmz',
      deviceId: devId1,
      publicKeyHex: pubHex1
    })

    // CRITICAL: Must be TRUSTED_MATCH! Must NEVER trigger MULTI_USER_DEVICE_SWITCH or demand SAS!
    expect(demotedClientEval.status).toBe('TRUSTED_MATCH')

    // Step 3: Verify the record is preserved with the real user credentials
    const updatedRecord = await getPeerTrustRecord(eventId, 'user_lucalmz_83aa', devId1)
    expect(updatedRecord).toBeDefined()
    expect(updatedRecord?.publicKeyHex).toBe(pubHex1)
  })

  it('Guarantee 8: Corrupt legacy records with userId "host" are automatically purged and do not cause false MULTI_USER_DEVICE_SWITCH', async () => {
    const eventId = 'evt_purge_2026'
    const keyPair = await generateEcdhKeyPair()
    const pubHex = await exportEcdhPublicKey(keyPair.publicKey)
    const devId = 'dev_legacy_corrupt'

    // Intentionally insert a legacy corrupt record with userId: 'host'
    await savePeerTrustRecord({
      eventId,
      userId: 'host',
      username: 'Host',
      deviceId: devId,
      publicKeyHex: pubHex,
      firstSeenAt: 500,
      lastSeenAt: 500,
      trustedAt: 500,
      trustLevel: 'TOFU_TRUSTED'
    })

    // Querying by device should purge the legacy 'host' record
    const found = await findPeerTrustRecordByDevice(eventId, devId)
    expect(found).toBeNull()

    // Evaluating real user 'Lucalmz' on this device should establish clean TOFU, not MULTI_USER_DEVICE_SWITCH
    const evalResult = await evaluatePeerKeyTrust({
      eventId,
      userId: 'user_lucalmz_83aa',
      username: 'Lucalmz',
      deviceId: devId,
      publicKeyHex: pubHex
    })
    expect(evalResult.status).toBe('TOFU_FIRST_SEEN')
  })

  it('Guarantee 9: isInvalidPseudoUser comprehensively identifies and filters all pseudo-user patterns', () => {
    expect(isInvalidPseudoUser('')).toBe(true)
    expect(isInvalidPseudoUser('   ')).toBe(true)
    expect(isInvalidPseudoUser('host')).toBe(true)
    expect(isInvalidPseudoUser('HOST')).toBe(true)
    expect(isInvalidPseudoUser('node')).toBe(true)
    expect(isInvalidPseudoUser('device_default')).toBe(true)
    expect(isInvalidPseudoUser('device:dev_xyz123')).toBe(true)
    expect(isInvalidPseudoUser('peer:host_dev_xyz')).toBe(true)
    expect(isInvalidPseudoUser('node_dev_456')).toBe(true)
    expect(isInvalidPseudoUser('dev_pub_04abcdef')).toBe(true)
    expect(isInvalidPseudoUser('dev_123456')).toBe(true)

    // Real users must NOT be treated as pseudo-users
    expect(isInvalidPseudoUser('user_lucalmz_83aa')).toBe(false)
    expect(isInvalidPseudoUser('scout-m6abc-123')).toBe(false)
    expect(isInvalidPseudoUser('4f74d081-3965-4fd2-8eb1-58fb3b342004')).toBe(false)
    expect(isInvalidPseudoUser('alice_smith')).toBe(false)
  })

  it('Guarantee 10: Seamless purge and clean TOFU establishment when previous record was pseudo/anonymous', async () => {
    const eventId = 'evt_seamless_2026'
    const keyPair = await generateEcdhKeyPair()
    const pubHex = await exportEcdhPublicKey(keyPair.publicKey)
    const devId = 'dev_seamless_bind'

    // Step 1: Simulate older anonymous or pseudo-session in store
    memTrustedPeers.set(`${eventId}:device:${devId}:${devId}`, {
      eventId,
      userId: `device:${devId}`,
      username: 'Host',
      deviceId: devId,
      publicKeyHex: pubHex,
      firstSeenAt: 100,
      lastSeenAt: 100,
      trustedAt: 100,
      trustLevel: 'TOFU_TRUSTED'
    })

    // Step 2: Real user logs in on this device with matching ECDH public key
    const evalResult = await evaluatePeerKeyTrust({
      eventId,
      userId: 'user_lucalmz_83aa',
      username: 'Lucalmz',
      deviceId: devId,
      publicKeyHex: pubHex
    })

    // Pseudo-user is purged; must establish clean TOFU_FIRST_SEEN, never false MULTI_USER_DEVICE_SWITCH!
    expect(evalResult.status).toBe('TOFU_FIRST_SEEN')

    // Step 3: Once saved, subsequent connection is instant TRUSTED_MATCH
    await savePeerTrustRecord({
      eventId,
      userId: 'user_lucalmz_83aa',
      username: 'Lucalmz',
      deviceId: devId,
      publicKeyHex: pubHex,
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
      trustedAt: Date.now(),
      trustLevel: 'TOFU_TRUSTED'
    })

    const reconnEval = await evaluatePeerKeyTrust({
      eventId,
      userId: 'user_lucalmz_83aa',
      username: 'Lucalmz',
      deviceId: devId,
      publicKeyHex: pubHex
    })
    expect(reconnEval.status).toBe('TRUSTED_MATCH')
  })

  it('Guarantee 11: Unauthenticated/empty userId incoming connection does not trigger false MULTI_USER_DEVICE_SWITCH', async () => {
    const eventId = 'evt_unauth_2026'
    const keyPair = await generateEcdhKeyPair()
    const pubHex = await exportEcdhPublicKey(keyPair.publicKey)
    const devId = 'dev_unauth_test'

    // Prior real user recorded on device
    await savePeerTrustRecord({
      eventId,
      userId: 'user_lucalmz_83aa',
      username: 'Lucalmz',
      deviceId: devId,
      publicKeyHex: pubHex,
      firstSeenAt: 1000,
      lastSeenAt: 1000,
      trustedAt: 1000,
      trustLevel: 'TOFU_TRUSTED'
    })

    // Client reconnects without userId (e.g. before login or anonymous mirror)
    const evalResult = await evaluatePeerKeyTrust({
      eventId,
      userId: '',
      username: '',
      deviceId: devId,
      publicKeyHex: pubHex
    })

    // Same key -> TRUSTED_MATCH, never false MULTI_USER_DEVICE_SWITCH
    expect(evalResult.status).toBe('TRUSTED_MATCH')
  })
})

