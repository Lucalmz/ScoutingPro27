import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useRecordStore } from '../stores/records'
import * as api from '../services/api'
import type { ScoutingRecord } from '../types'

vi.mock('../services/api', () => ({
  listRecords: vi.fn(),
  saveRecord: vi.fn(),
  syncRecords: vi.fn(),
  markRecordsSynced: vi.fn()
}))

const createDummyRecord = (id: string, teamNumber: number, autoScore: number, teleopScore: number, endgameScore: number, scoutId = 's1', syncStatus = 'PENDING', allianceColor = 'none'): ScoutingRecord => ({
  id,
  eventId: 'e1',
  scoutId,
  scoutName: 'Scout ' + scoutId,
  matchNumber: 1,
  teamNumber,
  autoScore,
  teleopScore,
  endgameScore,
  totalScore: autoScore + teleopScore + endgameScore,
  notes: '',
  rawData: JSON.stringify({ allianceColor }),
  syncStatus: syncStatus as any,
  createdAt: '',
  updatedAt: ''
})

describe('Records Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('rankings computation with allianceColor and splitting logic', () => {
    const store = useRecordStore()
    store.records = [
      createDummyRecord('r1', 118, 10, 20, 10, 's1', 'PENDING', 'red'), // total 40
      createDummyRecord('r2', 118, 20, 30, 10, 's2', 'PENDING', 'blue'), // total 60 (max)
      createDummyRecord('r3', 254, 30, 40, 20, 's1', 'PENDING', 'red'),  // total 90
      createDummyRecord('r4', 254, 10, 10, 10, 's2', 'PENDING', 'blue')  // total 30
    ]
    
    const rankings = store.rankings
    expect(rankings).toHaveLength(2)
    // Sorted by totalScore descending
    expect(rankings[0].teamNumber).toBe(254) // total 120
    expect(rankings[0].maxScore).toBe(90)
    expect(rankings[0].avgAutoScore).toBe(20) // (30+10)/2
    
    expect(rankings[1].teamNumber).toBe(118) // total 100
    expect(rankings[1].maxScore).toBe(60)
    expect(rankings[1].avgAutoScore).toBe(15) // (10+20)/2

    // Check that allianceColor is stored correctly in rawData
    const r1Data = JSON.parse(store.records[0].rawData)
    expect(r1Data.allianceColor).toBe('red')
  })

  it('addRecord', async () => {
    const store = useRecordStore()
    vi.mocked(api.saveRecord).mockResolvedValue(undefined)
    
    const rec = createDummyRecord('rnew', 1234, 1, 2, 3)
    const { success } = await store.addRecord(rec)
    expect(success).toBe(true)
    expect(store.records).toHaveLength(1)
  })

  it('myRecords filtering', () => {
    const store = useRecordStore()
    store.records = [
      createDummyRecord('r1', 118, 1, 1, 1, 's1'),
      createDummyRecord('r2', 254, 1, 1, 1, 's2')
    ]
    const mine = store.myRecords('s1')
    expect(mine).toHaveLength(1)
    expect(mine[0].scoutId).toBe('s1')
  })

  it('markSynced', async () => {
    const store = useRecordStore()
    store.records = [
      createDummyRecord('r1', 118, 1, 1, 1, 's1', 'PENDING')
    ]
    vi.mocked(api.markRecordsSynced).mockResolvedValue(undefined)
    await store.markSynced(['r1'])
    expect(store.records[0].syncStatus).toBe('SYNCED')
  })

  it('bulkSync applies LWW and returns only modified records', async () => {
    const store = useRecordStore()
    
    // Initial record with version 2
    store.records = [
      { ...createDummyRecord('r1', 118, 10, 10, 10), version: 2, updatedAt: '2026-08-14T10:00:00.000Z' }
    ]

    // Incoming has an older version 1 for r1, and a new record r2 with version 1
    const incoming = [
      { ...createDummyRecord('r1', 118, 5, 5, 5), version: 1, updatedAt: '2026-08-14T09:00:00.000Z' },
      { ...createDummyRecord('r2', 254, 20, 20, 20), version: 1, updatedAt: '2026-08-14T10:00:00.000Z' }
    ]

    const accepted = await store.bulkSync(incoming)
    
    // r1 should be rejected (kept version 2), r2 accepted
    expect(accepted).toHaveLength(1)
    expect(accepted[0].id).toBe('r2')
    expect(store.records.find(r => r.id === 'r1')?.version).toBe(2)
    expect(store.records.find(r => r.id === 'r1')?.totalScore).toBe(30)
  })

  it('bulkSync detects conflicts and returns both accepted incoming and updated existing records', async () => {
    const store = useRecordStore()
    
    // Scout 1 submitted Match 1 Team 9999
    store.records = [
      { ...createDummyRecord('r1', 9999, 10, 10, 10, 'scout1'), version: 1 }
    ]

    // Scout 2 submits Match 1 Team 9999
    const incoming = [
      { ...createDummyRecord('r2', 9999, 15, 15, 15, 'scout2'), version: 1 }
    ]

    const modified = await store.bulkSync(incoming)

    // Both records should be marked as conflict and returned for unified Host persistence & broadcast
    expect(modified).toHaveLength(2)
    const r1 = store.records.find(r => r.id === 'r1')
    const r2 = store.records.find(r => r.id === 'r2')
    expect(r1?.isConflict).toBe(true)
    expect(r1?.version).toBe(2)
    expect(r2?.isConflict).toBe(true)
    expect(modified.map(m => m.id).sort()).toEqual(['r1', 'r2'])
  })

  it('handles soft-delete tombstone and excludes from rankings', async () => {
    const store = useRecordStore()
    vi.mocked(api.saveRecord).mockResolvedValue(undefined)

    const rec1 = { ...createDummyRecord('r1', 27570, 50, 50, 50), version: 1 }
    const rec2 = { ...createDummyRecord('r2', 118, 30, 30, 30), version: 1 }
    store.records = [rec1, rec2]

    expect(store.rankings).toHaveLength(2)

    // Soft delete rec1
    const { success } = await store.deleteRecord('r1')
    expect(success).toBe(true)
    expect(store.records.find(r => r.id === 'r1')?.isDeleted).toBe(true)
    expect(store.records.find(r => r.id === 'r1')?.version).toBe(2)

    // Rankings should now only include rec2 (team 118)
    expect(store.rankings).toHaveLength(1)
    expect(store.rankings[0].teamNumber).toBe(118)
  })

  it('purges local expired tombstones older than 14 days', () => {
    const store = useRecordStore()
    const now = Date.now()
    const twentyDaysAgo = new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString()
    const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString()

    store.records = [
      { ...createDummyRecord('active_1', 27570, 10, 10, 10), isDeleted: false, updatedAt: twentyDaysAgo },
      { ...createDummyRecord('recent_del', 27570, 10, 10, 10), isDeleted: true, updatedAt: twoDaysAgo },
      { ...createDummyRecord('old_del', 27570, 10, 10, 10), isDeleted: true, updatedAt: twentyDaysAgo }
    ]

    store.purgeExpiredTombstones()
    expect(store.records.map(r => r.id)).toEqual(['active_1', 'recent_del'])
  })

  it('handles team tag CRUD and state updates', async () => {
    const store = useRecordStore()
    const dummyTag: TeamTagItem = {
      id: 'tag-1',
      eventId: 'e1',
      teamNumber: 27570,
      tag: 'fast_cycle',
      color: 'blue',
      isPreset: false,
      createdBy: 'user1'
    }

    // Apply tag update ADD
    store.applyTagUpdate(dummyTag, 'ADD')
    expect(store.teamTags).toHaveLength(1)
    expect(store.getTagsForTeam(27570)).toEqual([dummyTag])

    // Update existing tag (same eventId, teamNumber, tag) with different color
    const updatedTag: TeamTagItem = { ...dummyTag, color: 'purple' }
    store.applyTagUpdate(updatedTag, 'ADD')
    expect(store.teamTags).toHaveLength(1)
    expect(store.getTagsForTeam(27570)[0].color).toBe('purple')

    // Apply tag update REMOVE
    store.applyTagUpdate(dummyTag, 'REMOVE')
    expect(store.teamTags).toHaveLength(0)
    expect(store.getTagsForTeam(27570)).toEqual([])
  })

  it('handles applyTagsFullSync for full event sync', () => {
    const store = useRecordStore()
    const tags: TeamTagItem[] = [
      { id: '1', eventId: 'e1', teamNumber: 27570, tag: 'fast', color: 'blue', isPreset: false },
      { id: '2', eventId: 'e1', teamNumber: 19600, tag: 'defense', color: 'red', isPreset: false }
    ]

    store.applyTagsFullSync(tags)
    expect(store.teamTags).toHaveLength(2)
    expect(store.getTagsForTeam(27570)).toHaveLength(1)
    expect(store.getTagsForTeam(19600)).toHaveLength(1)
  })

  it('migrates scoutId and scoutName across all historical records upon user rename', () => {
    const store = useRecordStore()
    store.records = [
      createDummyRecord('r1', 27570, 10, 20, 10, 'old_scout_id', 'SYNCED'),
      createDummyRecord('r2', 27570, 15, 25, 10, 'old_scout_id', 'PENDING'),
      createDummyRecord('r3', 19600, 20, 30, 20, 'other_scout_id', 'SYNCED')
    ]

    store.migrateScoutId('old_scout_id', 'new_scout_id_88', 'Alice-88')

    // Records belonging to old_scout_id are updated
    expect(store.records[0]!.scoutId).toBe('new_scout_id_88')
    expect(store.records[0]!.scoutName).toBe('Alice-88')
    expect(store.records[0]!.version).toBe(2)

    expect(store.records[1]!.scoutId).toBe('new_scout_id_88')
    expect(store.records[1]!.scoutName).toBe('Alice-88')
    expect(store.records[1]!.version).toBe(2)

    // Other scout's record remains untouched
    expect(store.records[2]!.scoutId).toBe('other_scout_id')
    expect(store.records[2]!.scoutName).toBe('Scout other_scout_id')

    // myRecords getter works seamlessly with new ID
    const myRecs = store.myRecords('new_scout_id_88')
    expect(myRecs).toHaveLength(2)
    expect(store.myRecords('old_scout_id')).toHaveLength(0)
  })

  it('computes trend correctly without out-of-bounds when broken matches are present', () => {
    const store = useRecordStore()
    // Match 1: 50 points
    const rec1 = { ...createDummyRecord('r1', 27570, 20, 20, 10), matchNumber: 1 }
    // Match 2: isBroken = true (score ignored in trend)
    const rec2 = { ...createDummyRecord('r2', 27570, 0, 0, 0), matchNumber: 2, isBroken: true }
    // Match 3: 100 points (trend should be 'up' compared to 50)
    const rec3 = { ...createDummyRecord('r3', 27570, 40, 40, 20), matchNumber: 3 }

    store.records = [rec1, rec2, rec3]
    const ranking = store.rankings.find(r => r.teamNumber === 27570)
    expect(ranking).toBeDefined()
    expect(ranking!.matchCount).toBe(3)
    expect(ranking!.trend).toBe('up')
  })

  it('filters deleted records in activeRecords and myRecords getters', () => {
    const store = useRecordStore()
    const rec1 = { ...createDummyRecord('r1', 27570, 10, 10, 10, 'scout_1'), isDeleted: false }
    const rec2 = { ...createDummyRecord('r2', 27570, 10, 10, 10, 'scout_1'), isDeleted: true }

    store.records = [rec1, rec2]
    expect(store.records).toHaveLength(2)
    expect(store.activeRecords).toHaveLength(1)
    expect(store.activeRecords[0]!.id).toBe('r1')
    expect(store.myRecords('scout_1')).toHaveLength(1)
    expect(store.myRecords('scout_1')[0]!.id).toBe('r1')
  })

  it('fetchRecords preserves in-memory peer records and newer unpushed local records (guarded 3-way merge)', async () => {
    const store = useRecordStore()
    // Pre-existing in memory / localStorage:
    // 1. Peer stamped record received via WebRTC
    const peerStamped = { ...createDummyRecord('r_peer_stamped', 27570, 30, 30, 10, 'peer_scout'), hostSeq: 5, version: 1 }
    // 2. Local edited record awaiting sync (version 2, PENDING)
    const localEdited = { ...createDummyRecord('r_local_edit', 27570, 40, 40, 20, 's1', 'PENDING'), version: 2 }

    store.records = [peerStamped, localEdited]

    // Backend listRecords only returns older version for local_edit and does NOT have peerStamped yet
    const backendRecords = [
      { ...createDummyRecord('r_local_edit', 27570, 20, 20, 10, 's1', 'SYNCED'), version: 1 },
      { ...createDummyRecord('r_other_backend', 118, 15, 15, 10, 's3', 'SYNCED'), version: 1 }
    ]
    vi.mocked(api.listRecords).mockResolvedValue(backendRecords)

    await store.fetchRecords('e1')

    // Expect all 3 to be present!
    expect(store.records).toHaveLength(3)
    // peerStamped must NOT be wiped!
    const foundPeer = store.records.find(r => r.id === 'r_peer_stamped')
    expect(foundPeer).toBeDefined()
    expect(foundPeer!.hostSeq).toBe(5)

    // localEdited with higher version wins over backend older version!
    const foundLocal = store.records.find(r => r.id === 'r_local_edit')
    expect(foundLocal).toBeDefined()
    expect(foundLocal!.version).toBe(2)
    expect(foundLocal!.totalScore).toBe(100)

    // other backend record is added
    const foundOther = store.records.find(r => r.id === 'r_other_backend')
    expect(foundOther).toBeDefined()
  })

  it('bulkSync on client persists stamped peer records (hostSeq > 0) to local DB', async () => {
    const store = useRecordStore()
    const { useUserStore } = await import('../stores/user')
    const userStore = useUserStore()
    userStore.user = { id: 'scout_local', username: 'LocalScout', token: 'fake_jwt' }

    const peerStamped = { ...createDummyRecord('r_stamped_1', 27570, 20, 20, 10, 'peer_scout'), hostSeq: 42, version: 1 }
    await store.bulkSync([peerStamped])

    expect(api.syncRecords).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ id: 'r_stamped_1', hostSeq: 42 })
    ]))
  })

  it('currentEventId isolates records across events in rankings, activeRecords, and myRecords', () => {
    const store = useRecordStore()
    const recEvt1 = { ...createDummyRecord('r_evt1', 118, 10, 20, 10, 's1'), eventId: 'event-A' }
    const recEvt2 = { ...createDummyRecord('r_evt2', 254, 30, 30, 30, 's1'), eventId: 'event-B' }
    const recEvt1Deleted = { ...createDummyRecord('r_evt1_del', 118, 50, 50, 50, 's1'), eventId: 'event-A', isDeleted: true }

    store.records = [recEvt1, recEvt2, recEvt1Deleted]

    // When currentEventId is set to event-A
    store.currentEventId = 'event-A'

    // activeRecords only contains non-deleted records for event-A
    expect(store.activeRecords).toHaveLength(1)
    expect(store.activeRecords[0].id).toBe('r_evt1')

    // rankings only contains team 118, not 254
    expect(store.rankings).toHaveLength(1)
    expect(store.rankings[0].teamNumber).toBe(118)

    // myRecords only returns event-A records
    expect(store.myRecords('s1')).toHaveLength(1)
    expect(store.myRecords('s1')[0].id).toBe('r_evt1')

    // Switching currentEventId to event-B
    store.currentEventId = 'event-B'
    expect(store.activeRecords).toHaveLength(1)
    expect(store.activeRecords[0].id).toBe('r_evt2')
    expect(store.rankings[0].teamNumber).toBe(254)
  })

  it('scoutReliability and matchDiscrepancies respect currentEventId isolation', () => {
    const store = useRecordStore()
    store.officialMatches = [
      {
        matchNum: 1,
        scores: {
          red: { penaltyPointsCommitted: 0, totalPointsNp: 100, finalScore: 100 },
          blue: { penaltyPointsCommitted: 0, totalPointsNp: 80, finalScore: 80 }
        },
        teams: [
          { teamNumber: 118, alliance: 'Red' },
          { teamNumber: 222, alliance: 'Red' },
          { teamNumber: 333, alliance: 'Blue' },
          { teamNumber: 444, alliance: 'Blue' }
        ]
      }
    ]

    // rA: scout s1 scouts team 118 with auto=10, teleop=10, endgame=10 -> total 30 (massive discrepancy with 100)
    const rA = { ...createDummyRecord('r_evtA', 118, 10, 10, 10, 's1', 'SYNCED', 'red'), eventId: 'event-A' }
    // rB: scout s2 scouts team 118 with auto=30, teleop=40, endgame=30 -> total 100 (matches official red score)
    const rB = { ...createDummyRecord('r_evtB', 118, 30, 40, 30, 's2', 'SYNCED', 'red'), eventId: 'event-B' }

    store.records = [rA, rB]

    // Set to event-A
    store.currentEventId = 'event-A'
    expect(store.currentRecords).toHaveLength(1)
    expect(store.currentRecords[0].id).toBe('r_evtA')
    expect(store.matchDiscrepancies.length).toBeGreaterThan(0)
    expect(store.matchDiscrepancies[0].red?.scouts.some((s) => s.scoutId === 's1')).toBe(true)
    expect(store.matchDiscrepancies[0].red?.scouts.some((s) => s.scoutId === 's2')).toBe(false)

    // Set to event-B
    store.currentEventId = 'event-B'
    expect(store.currentRecords).toHaveLength(1)
    expect(store.currentRecords[0].id).toBe('r_evtB')
    expect(store.matchDiscrepancies.length).toBeGreaterThan(0)
    expect(store.matchDiscrepancies[0].red?.scouts.some((s) => s.scoutId === 's2')).toBe(true)
    expect(store.matchDiscrepancies[0].red?.scouts.some((s) => s.scoutId === 's1')).toBe(false)
  })

  it('offline addRecord catches API error gracefully and queues PENDING record', async () => {
    const store = useRecordStore()
    vi.mocked(api.saveRecord).mockRejectedValue(new Error('Network Offline'))

    const newRec = createDummyRecord('r_offline_1', 99999, 10, 20, 30, 's1', 'PENDING')
    const result = await store.addRecord(newRec)

    expect(result.success).toBe(true)
    expect(store.records.some((r) => r.id === 'r_offline_1')).toBe(true)
    const saved = store.records.find((r) => r.id === 'r_offline_1')
    expect(saved?.syncStatus).toBe('PENDING')
  })

  it('bulkSync absorbs SYNCED status when incoming has equal version and equal hostSeq', () => {
    const store = useRecordStore()
    const local = createDummyRecord('r_sync_1', 12345, 10, 20, 30, 's1', 'PENDING')
    local.version = 2
    local.hostSeq = 5
    local.updatedAt = '2026-09-09T10:00:00Z'
    store.records = [local]

    const incoming: ScoutingRecord = {
      ...local,
      syncStatus: 'SYNCED',
      updatedAt: '2026-09-09T10:00:00Z'
    }

    store.bulkSync([incoming])
    const found = store.records.find((r) => r.id === 'r_sync_1')
    expect(found?.syncStatus).toBe('SYNCED')
  })
})


