import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useUserStore } from '@/stores/user'
import { useRecordStore } from '@/stores/records'
import { createWebRtcService } from '@/services/webrtc'
import { generateDeterministicUserId } from '@/utils/userId'
import * as api from '@/services/api'
import mqtt from 'mqtt'

vi.mock('mqtt', () => ({
  default: {
    connect: vi.fn()
  }
}))

vi.mock('@/services/api', () => ({
  login: vi.fn(),
  syncRecords: vi.fn().mockResolvedValue(undefined),
  fetchEventRecords: vi.fn().mockResolvedValue([]),
  fetchTeamTags: vi.fn().mockResolvedValue([])
}))

describe('Legacy Alias End-to-End Flow & Authoritative ID Binding', () => {
  let mockMqttClient: any

  beforeEach(() => {
    (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ = true
    setActivePinia(createPinia())
    localStorage.clear()
    vi.clearAllMocks()

    mockMqttClient = {
      on: vi.fn(),
      subscribe: vi.fn(),
      publish: vi.fn(),
      connected: true,
      unsubscribe: vi.fn(),
      end: vi.fn()
    }
    vi.mocked(mqtt.connect).mockReturnValue(mockMqttClient)

    global.RTCPeerConnection = vi.fn().mockImplementation(() => ({
      createDataChannel: vi.fn().mockReturnValue({
        send: vi.fn(),
        readyState: 'open',
        close: vi.fn()
      }),
      createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'offer-sdp' }),
      createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'answer-sdp' }),
      setLocalDescription: vi.fn().mockResolvedValue(undefined),
      setRemoteDescription: vi.fn().mockResolvedValue(undefined),
      addIceCandidate: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      connectionState: 'new'
    })) as any
  })

  afterEach(() => {
    (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ = false
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('alias user login authoritatively stores alias ID and scopes newly created scouting records to alias account', async () => {
    const userStore = useUserStore()
    const recordStore = useRecordStore()

    const primaryAliceId = generateDeterministicUserId('Alice')
    // 'a85139c7-646c-3a4b-adf0-bfba2c631023'
    const aliasAliceId = generateDeterministicUserId('Alice (legacy-1)')
    // 'bea1a688-2f59-3268-95c6-fc07bce820db'

    expect(primaryAliceId).not.toEqual(aliasAliceId)

    // 1. User enters login with input "Alice" and secondary password
    // Backend API resolves to alias user "Alice (legacy-1)" with alias deterministic ID
    vi.mocked(api.login).mockResolvedValue({
      id: aliasAliceId,
      username: 'Alice (legacy-1)',
      token: 'jwt_token_alias_alice',
      legacyAliasNotice: '提示：由于重名冲突，您当前已自动登录至旧版别名账户「Alice (legacy-1)」。'
    })

    const loginSuccess = await userStore.login('Alice', 'SecondaryPassword123')
    expect(loginSuccess).toBe(true)

    // 2. Authoritative Verification:
    // Assert userStore.userId is strictly aliasAliceId (from server response), NOT primaryAliceId
    expect(userStore.userId).toBe(aliasAliceId)
    expect(userStore.username).toBe('Alice (legacy-1)')
    expect(userStore.userId).not.toBe(primaryAliceId)

    // 3. LocalStorage persistence check
    const cachedUser = JSON.parse(localStorage.getItem('scoutingpro-user') || '{}')
    expect(cachedUser.id).toBe(aliasAliceId)
    expect(cachedUser.username).toBe('Alice (legacy-1)')

    // 4. Create scouting record using active session userStore.userId
    const newRecord = {
      id: 'rec_alias_001',
      eventId: 'evt_2025_cmp',
      scoutId: userStore.userId,
      scoutName: userStore.username,
      matchNumber: 1,
      teamNumber: 27570,
      totalScore: 135,
      version: 1,
      isDeleted: false,
      timestamp: new Date().toISOString()
    }

    recordStore.addRecord(newRecord)

    // 5. Assert recorded scoutId belongs to Alias account and never re-hashes to Primary Alice
    expect(newRecord.scoutId).toBe(aliasAliceId)
    expect(newRecord.scoutId).not.toBe(primaryAliceId)

    const myRecords = recordStore.myRecords(userStore.userId)
    expect(myRecords).toHaveLength(1)
    expect(myRecords[0]?.scoutId).toBe(aliasAliceId)

    // An observer filtering for primary Alice will see 0 records (no cross-account data contamination)
    const primaryAliceRecords = recordStore.myRecords(primaryAliceId)
    expect(primaryAliceRecords).toHaveLength(0)
  })

  it('alias user WebRTC REQUEST_SYNC and SYNC_DATA transmits alias deterministic ID without colliding with primary user', async () => {
    const primaryAliceId = generateDeterministicUserId('Alice')
    const aliasAliceId = generateDeterministicUserId('Alice (legacy-1)')

    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockImplementation((recs) => Promise.resolve(recs)),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onClientConnected: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.host('test-room-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    // 1. Primary Alice connects first
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_primary_alice',
      offer: { type: 'offer', sdp: '...' }
    })))
    await new Promise(r => setTimeout(r, 10))
    const pcPrimary = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const dcPrimary = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pcPrimary.ondatachannel({ channel: dcPrimary })

    await dcPrimary.onmessage({
      data: JSON.stringify({
        type: 'REQUEST_SYNC',
        senderUserId: primaryAliceId,
        senderUserName: 'Alice',
        authCode: 'test-room-code'
      })
    })
    expect(callbacks.onClientConnected).toHaveBeenCalledWith(primaryAliceId, 'Alice')

    // 2. Alias Alice connects from another device
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_alias_alice',
      offer: { type: 'offer', sdp: '...' }
    })))
    await new Promise(r => setTimeout(r, 10))
    const pcAlias = vi.mocked(global.RTCPeerConnection).mock.results[1].value
    const dcAlias = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pcAlias.ondatachannel({ channel: dcAlias })

    // Alias user sends REQUEST_SYNC with alias deterministic ID
    await dcAlias.onmessage({
      data: JSON.stringify({
        type: 'REQUEST_SYNC',
        senderUserId: aliasAliceId,
        senderUserName: 'Alice (legacy-1)',
        authCode: 'test-room-code'
      })
    })

    // Both Primary Alice and Alias Alice are concurrently connected with zero session conflict
    expect(dcAlias.send).not.toHaveBeenCalledWith(expect.stringContaining('"type":"SESSION_CONFLICT"'))
    expect(callbacks.onClientConnected).toHaveBeenCalledWith(aliasAliceId, 'Alice (legacy-1)')

    // 3. Alias user pushes SYNC_DATA with their alias scoutId
    const aliasRecord = {
      id: 'rec_alias_100',
      scoutId: aliasAliceId,
      matchNumber: 2,
      teamNumber: 27570,
      totalScore: 142
    }

    await dcAlias.onmessage({
      data: JSON.stringify({
        type: 'SYNC_DATA',
        records: [aliasRecord],
        authCode: 'test-room-code'
      })
    })

    // Host accepts the record and assigns it to aliasAliceId
    expect(callbacks.onRecordsReceived).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'rec_alias_100', scoutId: aliasAliceId })],
      'peer_alias_alice'
    )
    expect(dcAlias.send).toHaveBeenCalledWith(
      expect.stringContaining('"recordIds":["rec_alias_100"]')
    )
  })
})
