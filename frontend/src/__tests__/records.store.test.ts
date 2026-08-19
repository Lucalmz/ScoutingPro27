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
})
