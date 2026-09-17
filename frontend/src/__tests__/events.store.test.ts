import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEventStore } from '../stores/events'
import { useUserStore } from '../stores/user'
import * as api from '../services/api'

vi.mock('../services/api', () => ({
  listEvents: vi.fn(),
  createEvent: vi.fn(),
  joinEvent: vi.fn(),
  syncExternalEvent: vi.fn(),
  deleteEvent: vi.fn()
}))

describe('Events Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'testuser', token: 'token' }
    vi.clearAllMocks()
  })

  it('create event', async () => {
    const store = useEventStore()
    vi.mocked(api.createEvent).mockResolvedValue({ id: 'evt-1', inviteCode: 'ABCDEF' })
    
    const evt = await store.create('My Event')
    expect(evt?.id).toBe('evt-1')
    expect(evt?.name).toBe('My Event')
    expect(evt?.hostId).toBe('u1')
    expect(store.events).toHaveLength(1)
    expect(store.currentEvent?.id).toBe('evt-1')
  })

  it('join event', async () => {
    const store = useEventStore()
    vi.mocked(api.joinEvent).mockResolvedValue({ id: 'evt-2', name: 'Joined Event', inviteCode: 'ABCDEF', hostId: 'u2' })
    
    const evt = await store.join('ABCDEF', 'Joined Event')
    expect(evt?.inviteCode).toBe('ABCDEF')
    expect(store.events).toHaveLength(1)
    expect(store.currentEvent?.name).toBe('Joined Event')
  })

  it('updateFtcConfig updates both events list and currentEvent', () => {
    const store = useEventStore()
    const evt = { id: 'evt-1', name: 'My Event', inviteCode: 'ABCDEF', hostId: 'u1' }
    store.events = [evt]
    store.currentEvent = evt

    store.updateFtcConfig('evt-1', 2025, 'CNCMPLB')

    expect(store.currentEvent?.ftcYear).toBe(2025)
    expect(store.currentEvent?.ftcEventCode).toBe('CNCMPLB')
    expect(store.events[0].ftcYear).toBe(2025)
    expect(store.events[0].ftcEventCode).toBe('CNCMPLB')
  })

  it('create and join deduplicate events when event id already exists', async () => {
    const store = useEventStore()
    vi.mocked(api.createEvent).mockResolvedValue({ id: 'evt-1', inviteCode: 'ABCDEF' })
    vi.mocked(api.joinEvent).mockResolvedValue({ id: 'evt-1', name: 'Updated Event', inviteCode: 'ABCDEF', hostId: 'u1' })

    await store.create('Initial Event')
    expect(store.events).toHaveLength(1)

    // Creating again with same ID (or joining same ID) updates instead of pushing duplicate
    await store.create('Initial Event Renamed')
    expect(store.events).toHaveLength(1)
    expect(store.events[0].name).toBe('Initial Event Renamed')

    await store.join('ABCDEF', 'Updated Event')
    expect(store.events).toHaveLength(1)
    expect(store.events[0].name).toBe('Updated Event')
  })

  it('syncExternal synchronizes external event into events list and currentEvent', async () => {
    const store = useEventStore()
    const externalEvt = { id: 'evt-ext-1', name: 'External Imported Event', inviteCode: 'EXT123', hostId: 'u-remote' }
    vi.mocked(api.syncExternalEvent).mockResolvedValue(externalEvt)

    const synced = await store.syncExternal(externalEvt)
    expect(synced?.id).toBe('evt-ext-1')
    expect(store.events).toHaveLength(1)
    expect(store.currentEvent?.id).toBe('evt-ext-1')
    expect(store.events[0].name).toBe('External Imported Event')

    // Calling again updates existing
    const updated = { ...externalEvt, name: 'External Imported Event Renamed' }
    vi.mocked(api.syncExternalEvent).mockResolvedValue(updated)
    await store.syncExternal(updated)
    expect(store.events).toHaveLength(1)
    expect(store.events[0].name).toBe('External Imported Event Renamed')
  })

  describe('isHost computation resilience', () => {
    it('correctly identifies desktop creator as host even when rtcService is just created with isHostMode false', async () => {
      const { useConnectionStore } = await import('../stores/connection')
      const photoStorage = await import('../services/photoStorage')
      vi.spyOn(photoStorage, 'isDesktopHost').mockReturnValue(true)

      const store = useEventStore()
      const connStore = useConnectionStore()

      store.currentEvent = { id: 'evt-1', name: 'My Event', inviteCode: 'ABCDEF', hostId: 'u1' }

      // Before RTC service: desktop owner is host
      expect(store.isHost).toBe(true)

      // When WebRTC service is created, isHostMode() starts false before host() is called
      connStore.setRtcService({
        isHostMode: () => false
      } as any)

      // MUST STILL be host! Prevents chicken-and-egg deadlock
      expect(store.isHost).toBe(true)
    })

    it('identifies takeover host on mobile client when isHostMode returns true', async () => {
      const { useConnectionStore } = await import('../stores/connection')
      const photoStorage = await import('../services/photoStorage')
      vi.spyOn(photoStorage, 'isDesktopHost').mockReturnValue(false) // Mobile device

      const store = useEventStore()
      const connStore = useConnectionStore()

      store.currentEvent = { id: 'evt-1', name: 'My Event', inviteCode: 'ABCDEF', hostId: 'u1' }

      // On mobile before takeover: not host
      expect(store.isHost).toBe(false)

      // Mobile takes over as host: rtcService.isHostMode() becomes true
      connStore.setRtcService({
        isHostMode: () => true
      } as any)

      expect(store.isHost).toBe(true)
    })

    it('identifies desktop participant who joined someone else event as client', async () => {
      const { useConnectionStore } = await import('../stores/connection')
      const photoStorage = await import('../services/photoStorage')
      vi.spyOn(photoStorage, 'isDesktopHost').mockReturnValue(true)

      const store = useEventStore()
      const connStore = useConnectionStore()

      // Event created by u2 (not u1)
      store.currentEvent = { id: 'evt-2', name: 'Someone Event', inviteCode: 'XYZ123', hostId: 'u2' }

      connStore.setRtcService({
        isHostMode: () => false
      } as any)

      expect(store.isHost).toBe(false)
    })
  })

  describe('Event Deletion, Migration and Cache Reset', () => {
    it('deleteEvent removes event from list and clears currentEvent if matched', () => {
      const store = useEventStore()
      const evt1 = { id: 'evt-1', name: 'Event 1', inviteCode: 'CODE1', hostId: 'u1' }
      const evt2 = { id: 'evt-2', name: 'Event 2', inviteCode: 'CODE2', hostId: 'u1' }
      store.events = [evt1, evt2]
      store.currentEvent = evt1

      store.deleteEvent('evt-1')

      expect(store.events).toHaveLength(1)
      expect(store.events[0].id).toBe('evt-2')
      expect(store.currentEvent).toBeNull()
    })

    it('migratePlaceholder replaces placeholder event and cleans up ghost duplicates', () => {
      const store = useEventStore()
      const placeholder = { id: 'evt-SPWNSH', name: 'ScoutingPro 27', inviteCode: 'SPWNSH', hostId: 'remote-host' }
      const authoritative = { id: 'uuid-real-event-1', name: 'FTC Championship', inviteCode: 'SPWNSH', hostId: 'u1' }
      store.events = [placeholder]
      store.currentEvent = placeholder

      store.migratePlaceholder('evt-SPWNSH', authoritative)

      expect(store.events).toHaveLength(1)
      expect(store.events[0].id).toBe('uuid-real-event-1')
      expect(store.events[0].name).toBe('FTC Championship')
      expect(store.currentEvent?.id).toBe('uuid-real-event-1')
    })

    it('clearAllLocalCache wipes store events and all event-related localStorage keys while keeping user session', () => {
      const store = useEventStore()
      store.events = [{ id: 'evt-1', name: 'Test', inviteCode: 'TEST', hostId: 'u1' }]
      store.currentEvent = store.events[0]
      localStorage.setItem('scoutingpro-user', JSON.stringify({ id: 'u1', username: 'alice' }))
      localStorage.setItem('scoutingpro_events', JSON.stringify(store.events))
      localStorage.setItem('scoutingpro27_schedule_evt-1', '[]')
      localStorage.setItem('sp27_records_evt-1', '[]')
      localStorage.setItem('sp27_pit_records_evt-1', '[]')

      store.clearAllLocalCache()

      expect(store.events).toHaveLength(0)
      expect(store.currentEvent).toBeNull()
      expect(localStorage.getItem('scoutingpro_events')).toBeNull()
      expect(localStorage.getItem('scoutingpro27_schedule_evt-1')).toBeNull()
      expect(localStorage.getItem('sp27_records_evt-1')).toBeNull()
      expect(localStorage.getItem('sp27_pit_records_evt-1')).toBeNull()
      // User login must NOT be wiped!
      expect(localStorage.getItem('scoutingpro-user')).not.toBeNull()
    })

    it('restoreFromCache sanitizes empty names and drops placeholders when authoritative exists', () => {
      const store = useEventStore()
      const corruptedCache = [
        { id: 'evt-SPWNSH', name: '', inviteCode: 'SPWNSH' }, // ghost empty name
        { id: 'uuid-authoritative', name: 'Authoritative Event', inviteCode: 'SPWNSH' }, // real event
        { id: 'evt-ORPHAN', name: 'scoutingpro27', inviteCode: 'ORPHAN' } // ghost default title
      ]
      localStorage.setItem('scoutingpro_events', JSON.stringify(corruptedCache))

      store.restoreFromCache()

      expect(store.events).toHaveLength(2)
      // Placeholder with inviteCode SPWNSH should be dropped in favor of uuid-authoritative
      const spwnsh = store.events.find(e => e.inviteCode === 'SPWNSH')
      expect(spwnsh?.id).toBe('uuid-authoritative')
      expect(spwnsh?.name).toBe('Authoritative Event')

      // Orphan event with 'scoutingpro27' should be sanitized to 'Event ORPHAN'
      const orphan = store.events.find(e => e.inviteCode === 'ORPHAN')
      expect(orphan?.name).toBe('Event ORPHAN')
    })

    it('deleteEvent removes event from store, clears currentEvent, updates localStorage and calls api.deleteEvent', async () => {
      const store = useEventStore()
      const evt1 = { id: 'evt-del-1', name: 'Event 1', inviteCode: 'DEL1', hostId: 'u1' }
      const evt2 = { id: 'evt-del-2', name: 'Event 2', inviteCode: 'DEL2', hostId: 'u1' }
      store.events = [evt1, evt2]
      store.currentEvent = evt1
      localStorage.setItem('scoutingpro_events', JSON.stringify(store.events))
      localStorage.setItem('scoutingpro_current_event', JSON.stringify(evt1))
      localStorage.setItem('sp27_records_evt-del-1', '[]')
      localStorage.setItem('scoutingpro27_schedule_evt-del-1', '[]')

      await store.deleteEvent('evt-del-1')

      expect(store.events).toHaveLength(1)
      expect(store.events[0].id).toBe('evt-del-2')
      expect(store.currentEvent).toBeNull()
      expect(JSON.parse(localStorage.getItem('scoutingpro_events')!)).toHaveLength(1)
      expect(localStorage.getItem('scoutingpro_current_event')).toBeNull()
      expect(localStorage.getItem('sp27_records_evt-del-1')).toBeNull()
      expect(localStorage.getItem('scoutingpro27_schedule_evt-del-1')).toBeNull()
      expect(api.deleteEvent).toHaveBeenCalledWith('evt-del-1')
    })
  })
})
