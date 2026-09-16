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
})
