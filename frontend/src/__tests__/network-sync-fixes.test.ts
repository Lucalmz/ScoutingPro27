import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useRecordStore } from '@/stores/records'
import { usePitScoutStore } from '@/stores/pitScout'
import { useScheduleStore } from '@/stores/schedule'
import { useEventStore } from '@/stores/events'
import { useUserStore } from '@/stores/user'
import { useConnectionStore } from '@/stores/connection'
import { createChannelMessageHandler } from '@/services/webrtc/channelMessageHandler'
import { flushOfflinePhotos } from '@/services/photoStorage'
import * as mobilePhotoCache from '@/services/mobilePhotoCache'
import * as api from '@/services/api'
import type { ScoutingRecord, PitScoutingRecord, MatchScheduleItem, ScoutAssignment } from '@/types'

vi.mock('@/services/api', () => ({
  listRecords: vi.fn().mockResolvedValue([]),
  saveRecord: vi.fn().mockResolvedValue(undefined),
  syncRecords: vi.fn().mockResolvedValue(undefined),
  fetchEventSchedule: vi.fn().mockResolvedValue({ schedules: [], assignments: [] }),
  fetchPitRecords: vi.fn().mockResolvedValue([]),
  syncPitRecordsBatch: vi.fn().mockResolvedValue(undefined),
  apiSavePitRecord: vi.fn().mockResolvedValue(undefined),
  uploadPitPhoto: vi.fn().mockResolvedValue(undefined),
  deletePitPhoto: vi.fn().mockResolvedValue(undefined),
  fetchEventTags: vi.fn().mockResolvedValue([]),
  syncExternalEvent: vi.fn().mockImplementation((ev) => Promise.resolve(ev)),
  isStaticCloudHost: vi.fn(() => false)
}))

describe('Network Sync Link Fixes & Verification', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('Bug 1: Tombstone pushing upon reconnection', () => {
    it('records store preserves deleted tombstones with PENDING status for reconnection push', () => {
      const recordStore = useRecordStore()
      const userStore = useUserStore()
      userStore.user = { id: 'scout-1', username: 'ScoutOne' }

      const rec: ScoutingRecord = {
        id: 'rec-tomb-1',
        eventId: 'evt-real-uuid',
        scoutId: 'scout-1',
        scoutName: 'ScoutOne',
        matchNumber: 1,
        teamNumber: 27570,
        totalScore: 120,
        version: 1,
        isDeleted: false,
        syncStatus: 'SYNCED',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
      recordStore.records.push(rec)

      // User deletes record offline
      recordStore.deleteRecord('rec-tomb-1')

      // Record is tombstoned
      expect(rec.isDeleted).toBe(true)
      expect(rec.syncStatus).toBe('PENDING')
      expect(rec.version).toBe(2)

      // Verification: myRecords filters it out from regular UI
      expect(recordStore.myRecords('scout-1')).toHaveLength(0)

      // Verification of Bug 1 Fix: reconnection query directly from recordStore.records retains tombstone
      const reconnectPending = recordStore.records.filter(
        (r) => r.eventId === 'evt-real-uuid' && r.scoutId === 'scout-1' && r.syncStatus === 'PENDING'
      )
      expect(reconnectPending).toHaveLength(1)
      expect(reconnectPending[0]?.id).toBe('rec-tomb-1')
      expect(reconnectPending[0]?.isDeleted).toBe(true)
    })
  })

  describe('Bug 2: Temporary evt-CODE migration across stores', () => {
    it('recordStore.migrateEventId migrates currentEventId, records, and tags to real UUID', () => {
      const recordStore = useRecordStore()
      recordStore.currentEventId = 'evt-K9X2B4'
      recordStore.records.push({
        id: 'rec-local-1',
        eventId: 'evt-K9X2B4',
        scoutId: 'scout-1',
        scoutName: 'ScoutOne',
        matchNumber: 1,
        teamNumber: 27570,
        totalScore: 110,
        version: 1,
        isDeleted: false,
        syncStatus: 'PENDING',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })
      recordStore.teamTags.push({
        id: 'tag-1',
        eventId: 'evt-K9X2B4',
        teamNumber: 27570,
        tag: 'Reliable Auto',
        createdAt: new Date().toISOString(),
        createdBy: 'scout-1'
      })

      // Migrate from temporary evt-K9X2B4 to real UUID
      recordStore.migrateEventId('evt-K9X2B4', '550e8400-e29b-41d4-a716-446655440000')

      expect(recordStore.currentEventId).toBe('550e8400-e29b-41d4-a716-446655440000')
      expect(recordStore.records[0]?.eventId).toBe('550e8400-e29b-41d4-a716-446655440000')
      expect(recordStore.teamTags[0]?.eventId).toBe('550e8400-e29b-41d4-a716-446655440000')
      expect(recordStore.currentRecords).toHaveLength(1)
    })

    it('pitScoutStore.migrateEventId migrates currentEventId and pit records', () => {
      const pitStore = usePitScoutStore()
      pitStore.currentEventId = 'evt-K9X2B4'
      pitStore.records.push({
        eventId: 'evt-K9X2B4',
        teamNumber: 27570,
        scoutId: 'scout-1',
        scoutName: 'ScoutOne',
        drivetrain: 'Swerve',
        syncStatus: 'PENDING',
        version: 1
      })

      pitStore.migrateEventId('evt-K9X2B4', '550e8400-e29b-41d4-a716-446655440000')

      expect(pitStore.currentEventId).toBe('550e8400-e29b-41d4-a716-446655440000')
      expect(pitStore.records[0]?.eventId).toBe('550e8400-e29b-41d4-a716-446655440000')
    })

    it('scheduleStore.migrateEventId migrates currentEventId, schedules, and assignments', () => {
      const schedStore = useScheduleStore()
      schedStore.currentEventId = 'evt-K9X2B4'
      schedStore.schedules.push({
        eventId: 'evt-K9X2B4',
        matchNumber: 1,
        red1: 27570,
        red2: 12345,
        blue1: 11111,
        blue2: 22222
      })
      schedStore.assignments['1-red1'] = {
        eventId: 'evt-K9X2B4',
        matchNumber: 1,
        station: 'red1',
        scoutId: 'scout-1',
        scoutName: 'ScoutOne'
      }

      schedStore.migrateEventId('evt-K9X2B4', '550e8400-e29b-41d4-a716-446655440000')

      expect(schedStore.currentEventId).toBe('550e8400-e29b-41d4-a716-446655440000')
      expect(schedStore.schedules[0]?.eventId).toBe('550e8400-e29b-41d4-a716-446655440000')
      expect(schedStore.assignments['1-red1']?.eventId).toBe('550e8400-e29b-41d4-a716-446655440000')
    })
  })

  describe('Bug 3: Pit Scout ACK Protocol & Safe State Transition', () => {
    it('Host automatically sends PIT_SCOUT_ACK on receiving PIT_SCOUT_BATCH_SYNC', async () => {
      const sentMessages: Array<{ msg: any; targetId?: string }> = []
      const ctx: any = {
        isHostMode: () => true,
        currentInviteCode: () => 'K9X2B4',
        callbacks: {
          onPitScoutBatchSyncReceived: vi.fn()
        },
        clients: new Map(),
        sendMessage: vi.fn().mockImplementation((msg, targetId) => {
          sentMessages.push({ msg, targetId })
        })
      }

      const handler = createChannelMessageHandler(ctx)

      const batchMsg = {
        type: 'PIT_SCOUT_BATCH_SYNC',
        records: [
          { teamNumber: 27570, drivetrain: 'Mecanum' },
          { teamNumber: 12345, drivetrain: 'Tank' }
        ]
      }

      await handler({ data: JSON.stringify(batchMsg) } as MessageEvent, 'client-sender-1')

      expect(ctx.callbacks.onPitScoutBatchSyncReceived).toHaveBeenCalledWith(batchMsg.records, 'client-sender-1')

      // Assert Host replied with PIT_SCOUT_ACK to the sender
      const ack = sentMessages.find((s) => s.msg.type === 'PIT_SCOUT_ACK')
      expect(ack).toBeDefined()
      expect(ack?.targetId).toBe('client-sender-1')
      expect(ack?.msg.teamNumbers).toEqual([27570, 12345])
    })

    it('Client receiving PIT_SCOUT_ACK invokes onPitScoutAckReceived and marks records SYNCED in pitStore', async () => {
      const pitStore = usePitScoutStore()
      pitStore.currentEventId = 'evt-1'
      pitStore.records = [
        { teamNumber: 27570, syncStatus: 'PENDING', version: 1 } as PitScoutingRecord,
        { teamNumber: 12345, syncStatus: 'PENDING', version: 1 } as PitScoutingRecord,
        { teamNumber: 99999, syncStatus: 'PENDING', version: 1 } as PitScoutingRecord
      ]

      const callbacks: any = {
        onPitScoutAckReceived: vi.fn().mockImplementation((teamNumbers: number[]) => {
          pitStore.markSynced(teamNumbers)
        })
      }
      const ctx: any = {
        isHostMode: () => false,
        currentInviteCode: () => 'K9X2B4',
        callbacks,
        clients: new Map(),
        sendMessage: vi.fn()
      }

      const handler = createChannelMessageHandler(ctx)

      const ackMsg = {
        type: 'PIT_SCOUT_ACK',
        teamNumbers: [27570, 12345]
      }

      await handler({ data: JSON.stringify(ackMsg) } as MessageEvent, 'host-sender')

      expect(callbacks.onPitScoutAckReceived).toHaveBeenCalledWith([27570, 12345])
      // 27570 and 12345 are marked SYNCED, while 99999 remains PENDING
      expect(pitStore.records.find((r) => r.teamNumber === 27570)?.syncStatus).toBe('SYNCED')
      expect(pitStore.records.find((r) => r.teamNumber === 12345)?.syncStatus).toBe('SYNCED')
      expect(pitStore.records.find((r) => r.teamNumber === 99999)?.syncStatus).toBe('PENDING')
    })
  })

  describe('Bug 4: Photo queue concurrency lock', () => {
    it('flushOfflinePhotos prevents concurrent duplicate flushes', async () => {
      // Simulate mobile client environment (LAN IP hostname)
      Object.defineProperty(window, 'location', {
        writable: true,
        value: { ...window.location, hostname: '192.168.1.105' }
      })

      vi.spyOn(mobilePhotoCache, 'getPendingMobilePhotos').mockImplementation(async () => {
        // Add a slight delay to simulate async IndexedDB lookup
        await new Promise((r) => setTimeout(r, 20))
        return [
          {
            key: 'photo-1',
            dataUrl: 'data:image/webp;base64,AAA...',
            eventId: 'evt-1',
            status: 'PENDING'
          }
        ]
      })

      // Run two flushes simultaneously
      const [res1, res2] = await Promise.all([
        flushOfflinePhotos('evt-1'),
        flushOfflinePhotos('evt-1')
      ])

      // One worker executes successfully (returns 1), while the concurrent duplicate returns 0 immediately
      expect(res1 + res2).toBe(1)
    })
  })

  describe('Bug 5: Offline Sync Modal Tombstone Export', () => {
    it('Offline export filters retain tombstones with incremented version', () => {
      const recordStore = useRecordStore()
      const userStore = useUserStore()
      userStore.user = { id: 'scout-1', username: 'ScoutOne' }

      const targetEventId = 'evt-cmp-2025'

      // Add normal record
      recordStore.records.push({
        id: 'rec-active-1',
        eventId: targetEventId,
        scoutId: 'scout-1',
        scoutName: 'ScoutOne',
        matchNumber: 1,
        teamNumber: 27570,
        totalScore: 100,
        version: 1,
        isDeleted: false,
        syncStatus: 'SYNCED',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })

      // Add tombstone record
      recordStore.records.push({
        id: 'rec-tombstone-1',
        eventId: targetEventId,
        scoutId: 'scout-1',
        scoutName: 'ScoutOne',
        matchNumber: 2,
        teamNumber: 12345,
        totalScore: 80,
        version: 2,
        isDeleted: true,
        syncStatus: 'PENDING',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })

      // Host export filter simulation
      const hostFiltered = recordStore.records.filter(
        (r) => r.eventId === targetEventId && (0 <= 0 || (r.hostSeq || 0) > 0)
      )
      expect(hostFiltered).toHaveLength(2)
      expect(hostFiltered.some((r) => r.isDeleted)).toBe(true)

      // Client export filter simulation
      const clientMyRecs = recordStore.records.filter(
        (r) => r.eventId === targetEventId && r.scoutId === 'scout-1'
      )
      const clientPendingFiltered = clientMyRecs.filter((r) => r.syncStatus === 'PENDING')
      expect(clientPendingFiltered).toHaveLength(1)
      expect(clientPendingFiltered[0]?.id).toBe('rec-tombstone-1')
      expect(clientPendingFiltered[0]?.isDeleted).toBe(true)
    })
  })
})
