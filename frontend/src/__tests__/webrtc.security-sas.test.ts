import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import {
  createWebRtcService,
  probePublicConnectivity,
  STUN_SERVERS,
  isGlobalIpv6Address,
  isIpv6Address,
  isPrivateIpv4Address,
  optimizeCandidatePriority,
  optimizeSdpCandidates,
  sortCandidatesPreferIpv6,
  classifyCandidatePair
} from '../services/webrtc'
import {
  deriveHmacKey,
  signSignalingPayload,
  generateNonce,
  generateEcdhKeyPair,
  exportEcdhPublicKey
} from '../utils/crypto'
import { savePeerTrustRecord, clearSecurityStoreForTesting } from '../utils/identityStore'
import * as api from '../services/api'
import mqtt from 'mqtt'

const origRTCPeerConnection = global.RTCPeerConnection
const origRTCSessionDescription = global.RTCSessionDescription
const origRTCIceCandidate = global.RTCIceCandidate
const origFetch = global.fetch

function resetDefaultApiMocks() {
  vi.mocked(api.syncRecords).mockResolvedValue(undefined as any)
  vi.mocked(api.login).mockImplementation(async ({ username, password }: any) => {
    if (password === 'CorrectPassword123') {
      return { id: 'user_target_id', username, token: 'target_jwt_token' }
    }
    const err: any = new Error('Invalid credentials')
    err.status = 401
    throw err
  })
  vi.mocked(api.createWebRtcTicket).mockImplementation(async (_eventId: string, ecdhPublicKey: string) => {
    return { ticket: `ticket_for_${ecdhPublicKey.slice(0, 10)}`, expiresIn: 180 }
  })
  vi.mocked(api.verifyWebRtcTicket).mockImplementation(async (ticket: string, _eventId: string, ecdhPublicKey: string) => {
    if (ticket.includes('ticket_for_') && ecdhPublicKey && ticket === `ticket_for_${ecdhPublicKey.slice(0, 10)}`) {
      return { valid: true, userId: 'scout_alice', username: 'Alice' }
    }
    if (ticket === 'valid_ticket_alice' && ecdhPublicKey === '04alice_pk') {
      return { valid: true, userId: 'scout_alice', username: 'Alice' }
    }
    if (ticket === 'valid_ticket_bob' && ecdhPublicKey === '04bob_pk') {
      return { valid: true, userId: 'scout_bob', username: 'Bob' }
    }
    if (ticket === 'cross_machine_foreign_ticket') {
      return { valid: false, error: "Invalid or expired ticket: The Token's Signature resulted invalid" }
    }
    if (ticket === 'user_not_found_ticket') {
      return { valid: false, error: 'User not found' }
    }
    return { valid: false, error: 'Public key hash mismatch' }
  })
  vi.mocked(api.verifyToken).mockImplementation(async (token: string) => {
    if (token === 'valid_jwt_alice') {
      return { valid: true, userId: 'scout_alice', username: 'Alice' }
    }
    if (token === 'valid_jwt_bob') {
      return { valid: true, userId: 'scout_bob', username: 'Bob' }
    }
    if (token === 'valid_jwt_client1' || token === 'client1') {
      return { valid: true, userId: 'client1', username: 'Client 1' }
    }
    return { valid: false }
  })
}




vi.mock('mqtt', () => {
  return {
    default: {
      connect: vi.fn()
    }
  }
})

vi.mock('../services/api', () => ({
  syncRecords: vi.fn().mockResolvedValue(undefined),
  login: vi.fn().mockImplementation(async ({ username, password }: any) => {
    if (password === 'CorrectPassword123') {
      return { id: 'user_target_id', username, token: 'target_jwt_token' }
    }
    const err: any = new Error('Invalid credentials')
    err.status = 401
    throw err
  }),
  createWebRtcTicket: vi.fn().mockImplementation(async (eventId: string, ecdhPublicKey: string) => {
    return { ticket: `ticket_for_${ecdhPublicKey.slice(0, 10)}`, expiresIn: 180 }
  }),
  verifyWebRtcTicket: vi.fn().mockImplementation(async (ticket: string, eventId: string, ecdhPublicKey: string) => {
    if (ticket.includes('ticket_for_') && ecdhPublicKey && ticket === `ticket_for_${ecdhPublicKey.slice(0, 10)}`) {
      return { valid: true, userId: 'scout_alice', username: 'Alice' }
    }
    if (ticket === 'valid_ticket_alice' && ecdhPublicKey === '04alice_pk') {
      return { valid: true, userId: 'scout_alice', username: 'Alice' }
    }
    if (ticket === 'valid_ticket_bob' && ecdhPublicKey === '04bob_pk') {
      return { valid: true, userId: 'scout_bob', username: 'Bob' }
    }
    if (ticket === 'cross_machine_foreign_ticket') {
      return { valid: false, error: "Invalid or expired ticket: The Token's Signature resulted invalid" }
    }
    if (ticket === 'user_not_found_ticket') {
      return { valid: false, error: 'User not found' }
    }
    return { valid: false, error: 'Public key hash mismatch' }
  }),
  verifyToken: vi.fn().mockImplementation(async (token: string) => {
    if (token === 'valid_jwt_alice') {
      return { valid: true, userId: 'scout_alice', username: 'Alice' }
    }
    if (token === 'valid_jwt_bob') {
      return { valid: true, userId: 'scout_bob', username: 'Bob' }
    }
    if (token === 'valid_jwt_client1' || token === 'client1') {
      return { valid: true, userId: 'client1', username: 'Client 1' }
    }
    return { valid: false }
  })
}))


describe('WebRTC Security Hardening & SAS Gating (v2)', () => {
  let mockMqttClient: any

  beforeEach(async () => {
    await clearSecurityStoreForTesting();
    (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ = true
    resetDefaultApiMocks()
    mockMqttClient = {
      on: vi.fn(),
      subscribe: vi.fn(),
      publish: vi.fn(),
      connected: true,
      unsubscribe: vi.fn(),
      end: vi.fn()
    }
    vi.mocked(mqtt.connect).mockReturnValue(mockMqttClient)

    global.RTCPeerConnection = vi.fn().mockImplementation(() => {
      return {
        createDataChannel: vi.fn().mockReturnValue({
          send: vi.fn(),
          readyState: 'open',
          close: vi.fn(),
        }),
        createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'offer-sdp' }),
        createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'answer-sdp' }),
        setLocalDescription: vi.fn().mockResolvedValue(undefined),
        setRemoteDescription: vi.fn().mockResolvedValue(undefined),
        addIceCandidate: vi.fn().mockResolvedValue(undefined),
        restartIce: vi.fn(),
        close: vi.fn(),
        connectionState: 'new',
      }
    }) as any

    global.RTCSessionDescription = vi.fn().mockImplementation((init) => init) as any
    global.RTCIceCandidate = vi.fn().mockImplementation((init) => init) as any
  })

  afterEach(() => {
    delete (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__
    global.fetch = origFetch
    localStorage.clear()
    global.RTCPeerConnection = origRTCPeerConnection
    global.RTCSessionDescription = origRTCSessionDescription
    global.RTCIceCandidate = origRTCIceCandidate
    vi.restoreAllMocks()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('enforces mandatory HMAC verification in production mode (drops unsigned or tampered messages)', async () => {
    delete (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__

    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    const room = 'SECURE_ROOM_999'
    await service.host(room)

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]
    expect(onMessage).toBeDefined()

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // 1. Send message without signature -> should be dropped
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client_attacker',
      offer: { type: 'offer', sdp: 'fake-sdp' },
      timestamp: Date.now(),
      nonce: generateNonce()
    })))

    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing mandatory HMAC signature'))
    })
    expect(vi.mocked(global.RTCPeerConnection)).not.toHaveBeenCalled()

    // 2. Send message with forged / invalid signature -> should be dropped
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client_attacker',
      offer: { type: 'offer', sdp: 'fake-sdp' },
      timestamp: Date.now(),
      nonce: generateNonce(),
      signature: 'deadbeef1234567890'
    })))

    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('invalid HMAC signature'))
    })
    expect(vi.mocked(global.RTCPeerConnection)).not.toHaveBeenCalled()

    // 3. Send message with legitimate signature derived from room inviteCode -> accepted!
    const hmacKey = await deriveHmacKey(room)
    const legitPayload: any = {
      sender: 'client_legit',
      offer: { type: 'offer', sdp: 'valid-sdp' },
      timestamp: Date.now(),
      nonce: generateNonce(),
      ecdhPublicKey: '04legit123',
      token: 'valid_jwt_alice'
    }
    legitPayload.signature = await signSignalingPayload(hmacKey, legitPayload)

    onMessage('topic', new TextEncoder().encode(JSON.stringify(legitPayload)))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection)).toHaveBeenCalled()
    })

    warnSpy.mockRestore()
    service.disconnect()
  })

  it('client offer does not transmit plaintext auth token in outer MQTT envelope', async () => {
    localStorage.setItem('scoutingpro-user', JSON.stringify({ id: 'u1', username: 'Alice', token: 'secret_jwt_alice' }))
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.join('test-code')

    const connectCb = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'connect')?.[1]
    await connectCb?.()
    await vi.waitFor(() => {
      expect(mockMqttClient.publish).toHaveBeenCalled()
    })

    // Check message published via signaling
    expect(mockMqttClient.publish).toHaveBeenCalled()
    const publishCalls = mockMqttClient.publish.mock.calls
    for (const call of publishCalls) {
      const payloadStr = call[1]
      const payload = JSON.parse(payloadStr)
      // Check that token is NOT present on outer MQTT envelope
      expect(payload.token).toBeUndefined()
    }
    service.disconnect()
  })

  it('rejects offer when ticket pkHash does not match actual ecdhPublicKey (replay attack prevention)', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onSasVerificationRequired: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]
    expect(onMessage).toBeDefined()

    const aliceKeys = await generateEcdhKeyPair()
    const alicePubHex = await exportEcdhPublicKey(aliceKeys.publicKey)
    const eveKeys = await generateEcdhKeyPair()
    const evePubHex = await exportEcdhPublicKey(eveKeys.publicKey)

    // Attacker Eve presents Alice's ticket but with Eve's key: evePubHex
    const tamperedOfferPayload = {
      sender: 'client_attacker_eve',
      offer: {
        type: 'offer',
        sdp: 'offer-sdp',
        ticket: `ticket_for_${alicePubHex.slice(0, 10)}` // Alice's ticket
      },
      ecdhPublicKey: evePubHex, // Eve's key
      clientSessionId: 'sess-eve-1'
    }

    onMessage('topic', new TextEncoder().encode(JSON.stringify(tamperedOfferPayload)))
    await vi.waitFor(() => {
      expect(api.verifyWebRtcTicket).toHaveBeenCalled()
    })
    await flushPromises()

    // Verification failed on backend, so SAS verification should NOT be called
    expect(service.getSasState('client_attacker_eve')).toBe('REJECTED')
    expect(callbacks.onSasVerificationRequired).not.toHaveBeenCalled()
    service.disconnect()
  })

  it('TOFU auto-trusts first-seen peer without requiring manual confirmation modal', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onSasVerificationRequired: vi.fn(),
      onSasVerified: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    let channelMessageHandler: any
    let channelSendMock = vi.fn()
    const mockDc = {
      readyState: 'open',
      send: channelSendMock,
      close: vi.fn(),
      set onmessage(fn: any) { channelMessageHandler = fn },
      get onmessage() { return channelMessageHandler }
    }

    global.RTCPeerConnection = vi.fn().mockImplementation(() => ({
      createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'sdp' }),
      createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'sdp' }),
      setLocalDescription: vi.fn().mockResolvedValue(undefined),
      setRemoteDescription: vi.fn().mockResolvedValue(undefined),
      addIceCandidate: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      connectionState: 'connected',
      iceConnectionState: 'connected',
      set ondatachannel(fn: any) {
        queueMicrotask(() => fn({ channel: mockDc }))
      }
    })) as any

    const bobKeys = await generateEcdhKeyPair()
    const bobPubHex = await exportEcdhPublicKey(bobKeys.publicKey)

    const firstSeenOffer = {
      sender: 'peer_first_seen_bob',
      offer: {
        type: 'offer',
        sdp: 'offer-sdp',
        ticket: `ticket_for_${bobPubHex.slice(0, 10)}`
      },
      ecdhPublicKey: bobPubHex,
      deviceId: 'dev_bob_ipad',
      clientSessionId: 'sess-bob-1'
    }

    onMessage('topic', new TextEncoder().encode(JSON.stringify(firstSeenOffer)))
    await vi.waitFor(() => {
      expect(service.getSasState('peer_first_seen_bob')).toBe('VERIFIED')
    })

    // Under TOFU, baseline trust is established automatically without modal interruption
    expect(callbacks.onSasVerificationRequired).not.toHaveBeenCalled()
    expect(service.getSasState('peer_first_seen_bob')).toBe('VERIFIED')

    service.disconnect()
  })

  it('DataChannel blocks outgoing and incoming business messages before SAS is verified, and flushes after confirmSas', async () => {
    // Pre-seed Alice's device with an older key to trigger KEY_ROTATION_ALERT
    await savePeerTrustRecord({
      eventId: 'test-code',
      userId: 'scout_alice',
      username: 'Alice',
      deviceId: 'device_default',
      publicKeyHex: '04old_alice_key',
      firstSeenAt: Date.now() - 10000,
      lastSeenAt: Date.now() - 10000,
      trustedAt: Date.now() - 10000,
      trustLevel: 'TOFU_TRUSTED'
    })

    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onSasVerificationRequired: vi.fn(),
      onSasVerified: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    let channelMessageHandler: any
    let channelSendMock = vi.fn()
    const mockDc = {
      readyState: 'open',
      send: channelSendMock,
      close: vi.fn(),
      set onmessage(fn: any) { channelMessageHandler = fn },
      get onmessage() { return channelMessageHandler }
    }

    global.RTCPeerConnection = vi.fn().mockImplementation(() => {
      let dcHandler: any
      return {
        createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'sdp' }),
        createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'sdp' }),
        setLocalDescription: vi.fn().mockResolvedValue(undefined),
        setRemoteDescription: vi.fn().mockResolvedValue(undefined),
        addIceCandidate: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
        connectionState: 'connected',
        iceConnectionState: 'connected',
        set ondatachannel(fn: any) {
          dcHandler = fn
          queueMicrotask(() => fn({ channel: mockDc }))
        }
      }
    }) as any

    const aliceKeys = await generateEcdhKeyPair()
    const alicePubHex = await exportEcdhPublicKey(aliceKeys.publicKey)

    // Legitimate offer from Alice (with rotated key)
    const legitOffer = {
      sender: 'peer_alice',
      offer: {
        type: 'offer',
        sdp: 'offer-sdp',
        ticket: `ticket_for_${alicePubHex.slice(0, 10)}`
      },
      ecdhPublicKey: alicePubHex,
      clientSessionId: 'sess-alice-1'
    }

    onMessage('topic', new TextEncoder().encode(JSON.stringify(legitOffer)))
    await vi.waitFor(() => {
      expect(callbacks.onSasVerificationRequired).toHaveBeenCalledWith(
        expect.objectContaining({ peerId: 'peer_alice' }),
        expect.any(String)
      )
      expect(service.getSasState('peer_alice')).toBe('PENDING_VERIFICATION')
      expect(channelMessageHandler).toBeTypeOf('function')
    })

    // 1. Peer sends incoming sync request message over DataChannel
    channelMessageHandler({
      data: JSON.stringify({ type: 'REQUEST_SYNC', authCode: 'test-code', sinceVersion: 0 })
    })

    // Because SAS is pending, onRequestSync must NOT be dispatched!
    expect(callbacks.onRequestSync).not.toHaveBeenCalled()

    // 2. Host tries to send message over DataChannel to peer_alice
    await service.sendMessage({
      type: 'TEAM_TAGS_UPDATE',
      eventId: 'evt1',
      teamNumber: 27570,
      action: 'ADD',
      tag: { eventId: 'evt1', teamNumber: 27570, tag: 'Leader' } as any
    }, 'peer_alice')

    // Underlying dc.send should NOT have been called!
    expect(channelSendMock).not.toHaveBeenCalled()

    // 3. User confirms SAS!
    service.confirmSas('peer_alice')

    // State becomes VERIFIED
    expect(service.getSasState('peer_alice')).toBe('VERIFIED')
    expect(callbacks.onSasVerified).toHaveBeenCalledWith('peer_alice')

    // Queued incoming message is dispatched!
    expect(callbacks.onRequestSync).toHaveBeenCalledWith(0, 'peer_alice')

    // Queued outgoing message is sent!
    expect(channelSendMock).toHaveBeenCalled()
    expect(channelSendMock).toHaveBeenCalledWith(expect.stringContaining('TEAM_TAGS_UPDATE'))

    service.disconnect()
  })

  it('DataChannel purges queues and terminates connection immediately upon rejectSas', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onSasVerificationRequired: vi.fn(),
      onSasRejected: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    let channelMessageHandler: any
    let closeMock = vi.fn()
    const mockDc = {
      readyState: 'open',
      send: vi.fn(),
      close: closeMock,
      set onmessage(fn: any) { channelMessageHandler = fn },
      get onmessage() { return channelMessageHandler }
    }

    global.RTCPeerConnection = vi.fn().mockImplementation(() => ({
      createDataChannel: vi.fn().mockReturnValue(mockDc),
      createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'sdp' }),
      createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'sdp' }),
      setLocalDescription: vi.fn().mockResolvedValue(undefined),
      setRemoteDescription: vi.fn().mockResolvedValue(undefined),
      addIceCandidate: vi.fn().mockResolvedValue(undefined),
      restartIce: vi.fn(),
      close: closeMock,
      connectionState: 'connected',
      iceConnectionState: 'connected',
      set ondatachannel(fn: any) {
        if (typeof fn === 'function') {
          queueMicrotask(() => fn({ channel: mockDc }))
        }
      }
    })) as any

    // Pre-seed historical record to trigger KEY_ROTATION_ALERT
    await savePeerTrustRecord({
      eventId: 'test-code',
      userId: 'scout_alice',
      username: 'Alice',
      deviceId: 'device_default',
      publicKeyHex: '04old_key_for_rotation',
      firstSeenAt: Date.now() - 10000,
      lastSeenAt: Date.now() - 10000,
      trustedAt: Date.now() - 10000,
      trustLevel: 'TOFU_TRUSTED'
    })

    const bobKeys = await generateEcdhKeyPair()
    const bobPubHex = await exportEcdhPublicKey(bobKeys.publicKey)

    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_bob',
      offer: { type: 'offer', sdp: 'sdp', ticket: `ticket_for_${bobPubHex.slice(0, 10)}` },
      ecdhPublicKey: bobPubHex,
      clientSessionId: 'sess-bob-1'
    })))
    await vi.waitFor(() => {
      expect(service.getSasState('peer_bob')).toBe('PENDING_VERIFICATION')
      expect(channelMessageHandler).toBeTypeOf('function')
    })

    // User rejects SAS
    service.rejectSas('peer_bob', 'Security code mismatch')

    expect(service.getSasState('peer_bob')).toBe('REJECTED')
    expect(callbacks.onSasRejected).toHaveBeenCalledWith('peer_bob', 'Security code mismatch')
    expect(closeMock).toHaveBeenCalled()

    service.disconnect()
  })

  it('ICE watchdog notifies stall at 3000ms and recovers without premature restartIce', async () => {
    vi.useFakeTimers()
    try {
      const callbacks = {
        onStatusChange: vi.fn(),
        onRecordsReceived: vi.fn(),
        onAckReceived: vi.fn(),
        onRequestSync: vi.fn(),
        onIceStalled: vi.fn()
      }
      const service = createWebRtcService(callbacks)
      await service.join('test-code')

      const connectCb = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'connect')?.[1]
      await connectCb?.()

      // Get the RTCPeerConnection instance created for client
      const pcInstance = vi.mocked(global.RTCPeerConnection).mock.results[0]?.value
      expect(pcInstance).toBeDefined()
      pcInstance.restartIce = vi.fn()

      // Simulate ICE state entering 'checking'
      pcInstance.iceConnectionState = 'checking'
      pcInstance.oniceconnectionstatechange()

      // Advance 3000ms -> should alert stall without destroying or restarting connection
      vi.advanceTimersByTime(3000)
      expect(callbacks.onIceStalled).toHaveBeenCalledWith(true)
      expect(pcInstance.restartIce).not.toHaveBeenCalled()

      // Advance another 1000ms -> still does NOT disrupt parallel ICE checks
      await vi.advanceTimersByTimeAsync(1000)
      expect(pcInstance.restartIce).not.toHaveBeenCalled()

      // Simulate ICE recovering to 'connected'
      pcInstance.iceConnectionState = 'connected'
      pcInstance.oniceconnectionstatechange()
      expect(callbacks.onIceStalled).toHaveBeenCalledWith(false)

      service.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  it('connect watchdog times out at 15000ms and preserves pure P2P during attempts 0-2, falls back to TURN on attempt 3, and escalates to relay on attempt 4', async () => {
    vi.useFakeTimers()
    try {
      global.RTCPeerConnection = vi.fn().mockImplementation(() => ({
        createDataChannel: vi.fn().mockReturnValue({
          send: vi.fn(),
          readyState: 'connecting',
          close: vi.fn(),
        }),
        createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'offer-sdp' }),
        createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'answer-sdp' }),
        setLocalDescription: vi.fn().mockResolvedValue(undefined),
        setRemoteDescription: vi.fn().mockResolvedValue(undefined),
        addIceCandidate: vi.fn().mockResolvedValue(undefined),
        restartIce: vi.fn(),
        close: vi.fn(),
        connectionState: 'new',
      })) as any

      const callbacks = {
        onStatusChange: vi.fn(),
        onRecordsReceived: vi.fn(),
        onAckReceived: vi.fn(),
        onRequestSync: vi.fn(),
        onIceStalled: vi.fn()
      }
      const service = createWebRtcService(callbacks)
      await service.join('test-code')

      const connectCb = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'connect')?.[1]
      await connectCb?.()

      // Attempt 0: 1st PeerConnection created with default 'all' policy, zero TURN
      const firstCallConfig = vi.mocked(global.RTCPeerConnection).mock.calls[0]?.[0]
      expect(firstCallConfig?.iceTransportPolicy).toBe('all')
      expect(JSON.stringify(firstCallConfig?.iceServers).includes('turn:')).toBe(false)

      // Advance 15000ms (connect timeout) + 1000ms (attempt 1 backoff) -> Attempt 1 (policy: 'all', zero TURN)
      await vi.advanceTimersByTimeAsync(16000)
      const secondCallConfig = vi.mocked(global.RTCPeerConnection).mock.calls[1]?.[0]
      expect(secondCallConfig?.iceTransportPolicy).toBe('all')
      expect(JSON.stringify(secondCallConfig?.iceServers).includes('turn:')).toBe(false)

      // Advance 15000ms (connect timeout) + 2000ms (attempt 2 backoff) -> Attempt 2 (policy: 'all', zero TURN)
      await vi.advanceTimersByTimeAsync(17000)
      const thirdCallConfig = vi.mocked(global.RTCPeerConnection).mock.calls[2]?.[0]
      expect(thirdCallConfig?.iceTransportPolicy).toBe('all')
      expect(JSON.stringify(thirdCallConfig?.iceServers).includes('turn:')).toBe(false)

      // Advance 15000ms (connect timeout) + 4000ms (attempt 3 backoff: 2^2 * 1000) -> Attempt 3 (TURN fallback, policy: 'all')
      await vi.advanceTimersByTimeAsync(19000)
      const fourthCallConfig = vi.mocked(global.RTCPeerConnection).mock.calls[3]?.[0]
      expect(fourthCallConfig?.iceTransportPolicy).toBe('all')
      expect(JSON.stringify(fourthCallConfig?.iceServers).includes('turn:global.relay.metered.ca')).toBe(true)

      // Advance 15000ms (connect timeout) + 8000ms (attempt 4 backoff: 2^3 * 1000) -> Attempt 4 escalates to 'relay'
      await vi.advanceTimersByTimeAsync(23000)
      const calls = vi.mocked(global.RTCPeerConnection).mock.calls
      expect(calls.length).toBeGreaterThanOrEqual(5)
      const lastCallConfig = calls[calls.length - 1]?.[0]
      expect(lastCallConfig?.iceTransportPolicy).toBe('relay')
      expect(JSON.stringify(lastCallConfig?.iceServers).includes('turn:global.relay.metered.ca')).toBe(true)

      service.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  it('Scheme B: Cross-machine peer with foreign signature falls back to ECDH + SAS + TOFU without dropping offer', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onSasVerificationRequired: vi.fn(),
      onSasVerified: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    let channelMessageHandler: any
    let channelSendMock = vi.fn()
    const mockDc = {
      readyState: 'open',
      send: channelSendMock,
      close: vi.fn(),
      set onmessage(fn: any) { channelMessageHandler = fn },
      get onmessage() { return channelMessageHandler }
    }

    global.RTCPeerConnection = vi.fn().mockImplementation(() => ({
      createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'sdp' }),
      createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'sdp' }),
      setLocalDescription: vi.fn().mockResolvedValue(undefined),
      setRemoteDescription: vi.fn().mockResolvedValue(undefined),
      addIceCandidate: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      connectionState: 'connected',
      iceConnectionState: 'connected',
      set ondatachannel(fn: any) {
        queueMicrotask(() => fn({ channel: mockDc }))
      }
    })) as any

    const charlieKeys = await generateEcdhKeyPair()
    const charliePubHex = await exportEcdhPublicKey(charlieKeys.publicKey)

    const foreignOffer = {
      sender: 'peer_charlie_laptop',
      offer: {
        type: 'offer',
        sdp: 'offer-sdp',
        ticket: 'cross_machine_foreign_ticket' // Signed by foreign backend with different secret
      },
      ecdhPublicKey: charliePubHex,
      deviceId: 'dev_charlie_thinkpad',
      clientSessionId: 'sess-charlie-1'
    }

    onMessage('topic', new TextEncoder().encode(JSON.stringify(foreignOffer)))
    await vi.waitFor(() => {
      expect(service.getSasState('peer_charlie_laptop')).toBe('VERIFIED')
    })

    // Scheme B: Cross-machine peer establishes baseline trust via TOFU without spamming popup modal
    expect(callbacks.onSasVerificationRequired).not.toHaveBeenCalled()
    expect(service.getSasState('peer_charlie_laptop')).toBe('VERIFIED')

    // Now test reconnection from same device & key: TOFU recognizes it as TRUSTED_MATCH
    callbacks.onSasVerificationRequired.mockClear()
    const reconnectOffer = {
      sender: 'peer_charlie_laptop',
      offer: {
        type: 'offer',
        sdp: 'offer-sdp',
        ticket: 'cross_machine_foreign_ticket'
      },
      ecdhPublicKey: charliePubHex,
      deviceId: 'dev_charlie_thinkpad',
      clientSessionId: 'sess-charlie-2'
    }

    onMessage('topic', new TextEncoder().encode(JSON.stringify(reconnectOffer)))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection)).toHaveBeenCalledTimes(2)
      expect(service.getSasState('peer_charlie_laptop')).toBe('VERIFIED')
    })

    // Automatically trusted via TOFU IndexedDB cache without requiring SAS modal again!
    expect(callbacks.onSasVerificationRequired).not.toHaveBeenCalled()
    expect(service.getSasState('peer_charlie_laptop')).toBe('VERIFIED')

    service.disconnect()
  })

  it('Scheme B: Replay or key-tampering attacks are strictly rejected without fallback', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onSasVerificationRequired: vi.fn(),
      onSasVerified: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    const eveKeys = await generateEcdhKeyPair()
    const evePubHex = await exportEcdhPublicKey(eveKeys.publicKey)

    // Attacker Eve presents Alice's ticket with Eve's key (triggering public key hash mismatch)
    const tamperedOffer = {
      sender: 'peer_eve_tampered',
      offer: {
        type: 'offer',
        sdp: 'offer-sdp',
        ticket: 'tampered_ticket_triggering_mismatch'
      },
      ecdhPublicKey: evePubHex,
      deviceId: 'dev_eve_tamper',
      clientSessionId: 'sess-eve-tamper'
    }

    onMessage('topic', new TextEncoder().encode(JSON.stringify(tamperedOffer)))
    await vi.waitFor(() => {
      expect(service.getSasState('peer_eve_tampered')).toBe('REJECTED')
    })

    // Must be completely rejected: no SAS prompt, state is REJECTED
    expect(callbacks.onSasVerificationRequired).not.toHaveBeenCalled()
    expect(service.getSasState('peer_eve_tampered')).toBe('REJECTED')

    service.disconnect()
  })
})

describe('WebRTC Client SAS Verification Gating & In-Band Account Merge', () => {
  let mockMqttClient: any

  beforeEach(async () => {
    (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ = true
    resetDefaultApiMocks()
    await clearSecurityStoreForTesting()
    localStorage.clear()
    mockMqttClient = {
      on: vi.fn(),
      subscribe: vi.fn(),
      publish: vi.fn(),
      connected: true,
      unsubscribe: vi.fn(),
      end: vi.fn()
    }
    vi.mocked(mqtt.connect).mockReturnValue(mockMqttClient)

    global.RTCPeerConnection = vi.fn().mockImplementation(() => {
      let channelMessageHandler: any
      const mockDc = {
        readyState: 'open',
        send: vi.fn(),
        close: vi.fn(),
        set onmessage(fn: any) { channelMessageHandler = fn },
        get onmessage() { return channelMessageHandler }
      }
      return {
        createDataChannel: vi.fn().mockReturnValue(mockDc),
        createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'offer-sdp' }),
        createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'answer-sdp' }),
        setLocalDescription: vi.fn().mockResolvedValue(undefined),
        setRemoteDescription: vi.fn().mockResolvedValue(undefined),
        addIceCandidate: vi.fn().mockResolvedValue(undefined),
        restartIce: vi.fn(),
        close: vi.fn(),
        connectionState: 'connected',
        set ondatachannel(fn: any) {
          if (typeof fn === 'function') {
            queueMicrotask(() => fn({ channel: mockDc }))
          }
        }
      }
    }) as any
  })

  afterEach(() => {
    delete (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__
    global.fetch = origFetch
    localStorage.clear()
    global.RTCPeerConnection = origRTCPeerConnection
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('Client receives host_hello from first-seen Host: auto-approves under TOFU; gates on key rotation alert', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onSasVerificationRequired: vi.fn(),
      onSasVerified: vi.fn(),
      onSasRejected: vi.fn()
    }
    const clientService = createWebRtcService(callbacks)
    await clientService.join('sas-client-test', 'ClientUser', 'user_client_1')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    const hostKeys = await generateEcdhKeyPair()
    const hostPubHex = await exportEcdhPublicKey(hostKeys.publicKey)

    // Host sends host_hello with ECDH public key (first seen)
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      type: 'host_hello',
      sender: 'host-peer-id',
      hostSessionId: 'host-session-123',
      deviceId: 'host-device-456',
      ecdhPublicKey: hostPubHex,
      username: 'Lead Scouter',
      userId: 'user_lead_scouter'
    })))

    await vi.waitFor(() => {
      expect(clientService.getSasState('host')).toBe('VERIFIED')
      expect(callbacks.onSasVerified).toHaveBeenCalledWith('host')
    })
    expect(callbacks.onSasVerificationRequired).not.toHaveBeenCalled()

    // Now simulate unexpected key rotation alert from same host device
    const rotatedKeys = await generateEcdhKeyPair()
    const rotatedPubHex = await exportEcdhPublicKey(rotatedKeys.publicKey)

    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      type: 'host_hello',
      sender: 'host-peer-id',
      hostSessionId: 'host-session-124',
      deviceId: 'host-device-456',
      ecdhPublicKey: rotatedPubHex,
      username: 'Lead Scouter',
      userId: 'user_lead_scouter'
    })))

    await vi.waitFor(() => {
      expect(callbacks.onSasVerificationRequired).toHaveBeenCalledWith(
        expect.objectContaining({ peerId: 'host', username: 'Lead Scouter' }),
        expect.any(String)
      )
      expect(clientService.getSasState('host')).toBe('PENDING_VERIFICATION')
    })

    // Confirm SAS manually
    clientService.confirmSas('host')
    expect(clientService.getSasState('host')).toBe('VERIFIED')

    clientService.disconnect()
  })

  it('Explicit SAS rejection triggers hard circuit breaker; retrySas un-fuses and allows reconnection', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onSasVerificationRequired: vi.fn(),
      onSasVerified: vi.fn(),
      onSasRejected: vi.fn()
    }
    const clientService = createWebRtcService(callbacks)
    await clientService.join('sas-breaker-test', 'ClientUser', 'user_client_1')

    // Manually reject SAS (e.g. user taps "不一致")
    clientService.rejectSas('host', 'Manual user rejection')
    expect(clientService.getSasState('host')).toBe('REJECTED')
    expect(clientService.getStatus()).toBe('offline')

    // Verify circuit breaker: automatic reconnect is suppressed
    const reconnected = await clientService.reconnectNow()
    expect(reconnected).toBe(false)
    expect(clientService.getSasState('host')).toBe('REJECTED')

    // User taps "重新发起核验" (retrySas)
    await clientService.retrySas('host')
    expect(clientService.getSasState('host')).toBe('PENDING_VERIFICATION')

    clientService.disconnect()
  })

  it('Host handles MERGE_ACCOUNT_REQUEST from client and responds with MERGE_ACCOUNT_RESPONSE', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onIdentityMigration: vi.fn()
    }
    const hostService = createWebRtcService(callbacks)
    await hostService.host('merge-test-code', undefined, 'HostAdmin', 'user_host_admin')

    let hostChannelHandler: any
    let sentOverDc: any[] = []
    const mockDc = {
      readyState: 'open',
      send: vi.fn((data) => sentOverDc.push(JSON.parse(data))),
      close: vi.fn(),
      set onmessage(fn: any) { hostChannelHandler = fn },
      get onmessage() { return hostChannelHandler }
    }

    global.RTCPeerConnection = vi.fn().mockImplementation(() => ({
      createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'sdp' }),
      createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'sdp' }),
      setLocalDescription: vi.fn().mockResolvedValue(undefined),
      setRemoteDescription: vi.fn().mockResolvedValue(undefined),
      addIceCandidate: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      connectionState: 'connected',
      iceConnectionState: 'connected',
      set ondatachannel(fn: any) {
        queueMicrotask(() => fn({ channel: mockDc }))
      }
    })) as any

    const clientKeys = await generateEcdhKeyPair()
    const clientPubHex = await exportEcdhPublicKey(clientKeys.publicKey)

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    // Simulate client connecting
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client_peer_merge',
      offer: { type: 'offer', sdp: 'offer-sdp', ticket: 'ticket_for_' + clientPubHex.slice(0, 10) },
      ecdhPublicKey: clientPubHex,
      deviceId: 'dev_client_phone',
      clientSessionId: 'sess-client-phone'
    })))

    await vi.waitFor(() => {
      expect(hostChannelHandler).toBeTypeOf('function')
    })

    // 1. Send MERGE_ACCOUNT_REQUEST with correct password
    await hostChannelHandler({
      data: JSON.stringify({
        type: 'MERGE_ACCOUNT_REQUEST',
        requestId: 'req-merge-1',
        targetUsername: 'HostAdmin',
        targetPassword: 'CorrectPassword123',
        sourceUserId: 'user_phone_temp',
        sourceUsername: 'PhoneScout',
        authCode: 'merge-test-code'
      })
    })

    await vi.waitFor(() => {
      expect(sentOverDc.some(m => m.type === 'MERGE_ACCOUNT_RESPONSE' && m.requestId === 'req-merge-1')).toBe(true)
    })

    expect(callbacks.onIdentityMigration).toHaveBeenCalledWith(
      'merge-test-code',
      'user_phone_temp',
      'user_target_id',
      'HostAdmin'
    )

    const mergeResp = sentOverDc.find(m => m.type === 'MERGE_ACCOUNT_RESPONSE' && m.requestId === 'req-merge-1')
    expect(mergeResp).toBeDefined()
    expect(mergeResp.success).toBe(true)
    expect(mergeResp.newId).toBe('user_target_id')
    expect(mergeResp.token).toBe('target_jwt_token')

    // 2. Send MERGE_ACCOUNT_REQUEST with wrong password
    sentOverDc = []
    await hostChannelHandler({
      data: JSON.stringify({
        type: 'MERGE_ACCOUNT_REQUEST',
        requestId: 'req-merge-2',
        targetUsername: 'HostAdmin',
        targetPassword: 'WrongPassword!',
        sourceUserId: 'user_phone_temp',
        sourceUsername: 'PhoneScout',
        authCode: 'merge-test-code'
      })
    })

    await vi.waitFor(() => {
      expect(sentOverDc.some(m => m.type === 'MERGE_ACCOUNT_RESPONSE' && m.requestId === 'req-merge-2')).toBe(true)
    })

    const failResp = sentOverDc.find(m => m.type === 'MERGE_ACCOUNT_RESPONSE' && m.requestId === 'req-merge-2')
    expect(failResp).toBeDefined()
    expect(failResp.success).toBe(false)
    expect(failResp.error).toContain('Invalid')

    hostService.disconnect()
  })
})
