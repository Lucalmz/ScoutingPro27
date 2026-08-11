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

  it('bulkSync', async () => {
    const store = useRecordStore()
    vi.mocked(api.syncRecords).mockResolvedValue(undefined)
    const incoming = [createDummyRecord('rsync', 999, 5, 5, 5)]
    await store.bulkSync(incoming)
    expect(store.records).toHaveLength(1)
    expect(store.records[0].id).toBe('rsync')
  })
})
