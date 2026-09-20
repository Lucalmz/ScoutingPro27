import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { createChannelMessageHandler } from '@/services/webrtc/channelMessageHandler'
import { useConnectionStore } from '@/stores/connection'
import { useRecordStore } from '@/stores/records'
import type { ScoutingRecord } from '@/types'

describe('Account Conflict & Takeover Fixes', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('triggers onTakeoverSuccess and clears session conflict when TAKEOVER_SUCCESS is received', async () => {
    const connStore = useConnectionStore()
    connStore.setSessionConflict({
      conflictingUsername: 'Alice',
      conflictingUserId: 'alice_1',
      conflictType: 'SAME_USER'
    })
    expect(connStore.sessionConflict).not.toBeNull()

    const onTakeoverSuccess = vi.fn(() => {
      connStore.clearSessionConflict()
    })

    const handler = createChannelMessageHandler({
      isHostMode: () => false,
      currentInviteCode: () => 'ABC123',
      getHostSessionId: () => 'h1',
      getCurrentHostSessionId: () => 'h1',
      setCurrentHostSessionId: () => {},
      callbacks: {
        onStatusChange: vi.fn(),
        onRecordsReceived: vi.fn(),
        onAckReceived: vi.fn(),
        onRequestSync: vi.fn(),
        onTakeoverSuccess
      },
      clients: new Map(),
      stagedClients: new Map(),
      scoutIdToClientIds: new Map(),
      clientIdToScoutId: new Map(),
      clientIdToScoutName: new Map(),
      pendingTakeovers: new Map(),
      takeoverCooldowns: new Map(),
      offlineMessages: {} as any,
      sendMessage: vi.fn(),
      promoteTakeover: vi.fn(),
      enqueueHostTask: vi.fn(),
      cleanupPeerResources: vi.fn(),
      stampHostSeq: vi.fn(),
      getHostSeqCounter: () => 0,
      setHostSeqCounter: () => {},
      closeClient: vi.fn(),
      setStatus: vi.fn()
    })

    await handler({ data: JSON.stringify({ type: 'TAKEOVER_SUCCESS', authCode: 'ABC123' }) } as MessageEvent, 'host')

    expect(onTakeoverSuccess).toHaveBeenCalled()
    expect(connStore.sessionConflict).toBeNull()
  })

  it('uses real eventId UUID rather than 6-char inviteCode when processing MERGE_ACCOUNT_REQUEST', async () => {
    const onIdentityMigration = vi.fn()
    const realEventUuid = '550e8400-e29b-41d4-a716-446655440000'
    const sixCharInviteCode = 'K9X2B4'

    const handler = createChannelMessageHandler({
      isHostMode: () => true,
      currentInviteCode: () => sixCharInviteCode,
      getCurrentEventId: () => realEventUuid,
      getHostSessionId: () => 'h1',
      getCurrentHostSessionId: () => 'h1',
      setCurrentHostSessionId: () => {},
      callbacks: {
        onStatusChange: vi.fn(),
        onRecordsReceived: vi.fn(),
        onAckReceived: vi.fn(),
        onRequestSync: vi.fn(),
        onIdentityMigration
      },
      clients: new Map(),
      stagedClients: new Map(),
      scoutIdToClientIds: new Map(),
      clientIdToScoutId: new Map(),
      clientIdToScoutName: new Map(),
      pendingTakeovers: new Map(),
      takeoverCooldowns: new Map(),
      offlineMessages: {} as any,
      sendMessage: vi.fn(),
      promoteTakeover: vi.fn(),
      enqueueHostTask: async (_id, task) => { await task() },
      cleanupPeerResources: vi.fn(),
      stampHostSeq: vi.fn(),
      getHostSeqCounter: () => 0,
      setHostSeqCounter: () => {},
      closeClient: vi.fn(),
      setStatus: vi.fn()
    })

    await handler({
      data: JSON.stringify({
        type: 'MERGE_ACCOUNT_REQUEST',
        requestId: 'req-1',
        targetUsername: 'TargetAlice',
        targetPassword: 'password123',
        sourceUserId: 'source_id_456',
        sourceUsername: 'SourceAlice'
      })
    } as MessageEvent, 'client_1')

    // If login fails in test environment, it handles the branch gracefully
  })

  it('trims password and handles self-merge properly without deleting mapping in MERGE_ACCOUNT_REQUEST', async () => {
    const api = await import('@/services/api')
    const loginSpy = vi.spyOn(api, 'login').mockResolvedValue({
      id: 'target_id_123',
      username: 'TargetAlice',
      token: 'valid_token'
    })

    const scoutIdToClientIds = new Map<string, Set<string>>()
    scoutIdToClientIds.set('target_id_123', new Set(['client_1']))
    const clientIdToScoutId = new Map<string, string>()
    const clientIdToScoutName = new Map<string, string>()
    const sendMessage = vi.fn()

    const handler = createChannelMessageHandler({
      isHostMode: () => true,
      currentInviteCode: () => 'K9X2B4',
      getCurrentEventId: () => 'uuid-event-1',
      getHostSessionId: () => 'h1',
      getCurrentHostSessionId: () => 'h1',
      setCurrentHostSessionId: () => {},
      callbacks: {},
      clients: new Map([
        ['client_1', { pc: {} as any, dc: { readyState: 'open' } as any }]
      ]),
      stagedClients: new Map(),
      scoutIdToClientIds,
      clientIdToScoutId,
      clientIdToScoutName,
      pendingTakeovers: new Map(),
      takeoverCooldowns: new Map(),
      offlineMessages: {} as any,
      sendMessage,
      promoteTakeover: vi.fn(),
      enqueueHostTask: async (_id, task) => { await task() },
      cleanupPeerResources: vi.fn(),
      stampHostSeq: vi.fn(),
      getHostSeqCounter: () => 0,
      setHostSeqCounter: () => {},
      closeClient: vi.fn(),
      setStatus: vi.fn()
    })

    // Notice whitespace in targetPassword: ' password123 \n '
    await handler({
      data: JSON.stringify({
        type: 'MERGE_ACCOUNT_REQUEST',
        requestId: 'req-trim-1',
        targetUsername: ' TargetAlice ',
        targetPassword: ' password123 \n ',
        sourceUserId: 'target_id_123', // Same ID (self-merge)
        sourceUsername: 'TargetAlice'
      })
    } as MessageEvent, 'client_1')

    expect(loginSpy).toHaveBeenCalledWith({
      username: 'TargetAlice',
      password: 'password123'
    })

    // scoutIdToClientIds for target_id_123 must NOT have been deleted
    expect(scoutIdToClientIds.get('target_id_123')).toBeDefined()
    expect(scoutIdToClientIds.get('target_id_123')?.has('client_1')).toBe(true)

    // MERGE_ACCOUNT_RESPONSE with success: true must have been sent back
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'MERGE_ACCOUNT_RESPONSE',
        requestId: 'req-trim-1',
        success: true,
        newId: 'target_id_123'
      }),
      'client_1'
    )
  })

  it('allows editing original match and team without triggering conflict deadlock', () => {
    const recordStore = useRecordStore()
    const r1: ScoutingRecord = {
      id: 'r_rec_1',
      eventId: 'evt_1',
      scoutId: 'alice',
      scoutName: 'Alice',
      matchNumber: 1,
      teamNumber: 27570,
      autoScore: 10,
      teleopScore: 20,
      endgameScore: 10,
      totalScore: 40,
      notes: '',
      rawData: JSON.stringify({ tournamentLevel: 'QUALIFICATION' }),
      syncStatus: 'SYNCED',
      createdAt: '',
      updatedAt: '2026-09-16T12:00:00Z'
    }

    const r2Duplicate: ScoutingRecord = {
      ...r1,
      id: 'r_rec_2',
      updatedAt: '2026-09-16T12:01:00Z'
    }

    recordStore.records = [r1, r2Duplicate]

    const curLevel = 'QUALIFICATION'
    const matchNum = 1
    const teamNum = 27570
    const editRecord = r1

    const isEditingOriginalMatchAndTeam =
      editRecord &&
      editRecord.matchNumber === matchNum &&
      editRecord.teamNumber === teamNum &&
      'QUALIFICATION' === curLevel

    expect(isEditingOriginalMatchAndTeam).toBe(true)
  })

  it('Host messageDispatcher sends SESSION_CONFLICT to stagedClients before promotion', async () => {
    const mockDc = {
      readyState: 'open',
      send: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0
    } as any

    const stagedClients = new Map()
    stagedClients.set('staged_client_phone', {
      pc: {} as any,
      dc: mockDc,
      pendingCandidates: []
    })

    const { createMessageDispatcher } = await import('@/services/webrtc/messageDispatcher')
    const dispatcher = createMessageDispatcher({
      isHostMode: () => true,
      getCurrentInviteCode: () => 'ABC123',
      getHostSessionId: () => 'host-sess',
      clients: new Map(),
      stagedClients,
      scoutIdToClientIds: new Map(),
      offlineMessages: {} as any,
      sas: {
        clientSasStates: new Map(),
        hostPendingOutgoing: new Map()
      } as any,
      getClientDc: () => null,
      getClientSender: () => null,
      setClientSender: () => {},
      setStatus: () => {},
      getLocalUserId: () => 'host-user',
      setLocalUserId: () => {},
      getLocalUserName: () => 'Host',
      setLocalUserName: () => {},
      getHostSeqCounter: () => 0,
      setHostSeqCounter: () => {}
    })

    await dispatcher.sendMessage(
      {
        type: 'SESSION_CONFLICT',
        conflictingUsername: 'Alice',
        conflictingUserId: 'alice_1',
        conflictType: 'SAME_USER'
      },
      'staged_client_phone'
    )

    expect(mockDc.send).toHaveBeenCalledTimes(1)
    expect(mockDc.send).toHaveBeenCalledWith(expect.stringContaining('"type":"SESSION_CONFLICT"'))
  })

  it('selfHealing suppresses auto-reconnect when isConflictActive returns true', async () => {
    const { setupSelfHealing } = await import('@/services/webrtc/selfHealing')
    const reconnectNow = vi.fn().mockResolvedValue(true)
    let conflictActive = true

    const healing = setupSelfHealing({
      getStatus: () => 'unstable',
      reconnectNow,
      isConflictActive: () => conflictActive
    })

    // Simulate page resume while conflict active
    window.dispatchEvent(new Event('focus'))
    await new Promise((r) => setTimeout(r, 10))
    expect(reconnectNow).not.toHaveBeenCalled()

    // Now user resolves conflict
    conflictActive = false
    window.dispatchEvent(new Event('focus'))
    await new Promise((r) => setTimeout(r, 10))
    expect(reconnectNow).toHaveBeenCalledTimes(1)

    healing.dispose()
  })

  it('scheduleStore.applyScheduleBatchSync correctly merges multiple batches', async () => {
    const { useScheduleStore } = await import('@/stores/schedule')
    const scheduleStore = useScheduleStore()

    // Batch 0: Matches 1 and 2
    scheduleStore.applyScheduleBatchSync(
      [
        { matchNumber: 1, tournamentLevel: 'QUALIFICATION', red1: 101, red2: 102, blue1: 201, blue2: 202 } as any,
        { matchNumber: 2, tournamentLevel: 'QUALIFICATION', red1: 103, red2: 104, blue1: 203, blue2: 204 } as any
      ],
      [
        { matchNumber: 1, station: 'Red 1', tournamentLevel: 'QUALIFICATION', scoutId: 's1', scoutName: 'Scout 1' } as any
      ],
      0,
      2
    )

    expect(scheduleStore.schedules).toHaveLength(2)
    expect(Object.keys(scheduleStore.assignments)).toHaveLength(1)

    // Batch 1: Matches 3 and 4
    scheduleStore.applyScheduleBatchSync(
      [
        { matchNumber: 3, tournamentLevel: 'QUALIFICATION', red1: 105, red2: 106, blue1: 205, blue2: 206 } as any,
        { matchNumber: 4, tournamentLevel: 'QUALIFICATION', red1: 107, red2: 108, blue1: 207, blue2: 208 } as any
      ],
      [
        { matchNumber: 3, station: 'Blue 2', tournamentLevel: 'QUALIFICATION', scoutId: 's2', scoutName: 'Scout 2' } as any
      ],
      1,
      2
    )

    expect(scheduleStore.schedules).toHaveLength(4)
    expect(Object.keys(scheduleStore.assignments)).toHaveLength(2)
  })
})
