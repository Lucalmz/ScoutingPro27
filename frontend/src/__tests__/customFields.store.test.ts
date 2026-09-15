import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useCustomFieldsStore } from '../stores/customFields'
import { useConnectionStore } from '../stores/connection'
import { useEventStore } from '../stores/events'
import { useUserStore } from '../stores/user'
import * as api from '../services/api'
import type { CustomFieldDefinition } from '../types'

vi.mock('../services/api', () => ({
  fetchCustomFields: vi.fn(),
  createCustomField: vi.fn(),
  updateCustomField: vi.fn(),
  deleteCustomField: vi.fn()
}))

const mockField = (overrides: Partial<CustomFieldDefinition> = {}): CustomFieldDefinition => ({
  id: 'cf-1',
  eventId: 'evt-1',
  target: 'MATCH',
  phase: 'teleop',
  name: 'Low Hang',
  fieldKey: 'low_hang',
  fieldType: 'boolean',
  required: false,
  unit: undefined,
  minVal: undefined,
  maxVal: undefined,
  stepVal: undefined,
  optionsJson: undefined,
  options: [],
  orderSeq: 1,
  isActive: true,
  createdAt: '2026-09-15T00:00:00Z',
  updatedAt: '2026-09-15T00:00:00Z',
  ...overrides
})

describe('CustomFields Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    const userStore = useUserStore()
    userStore.user = { id: 'me', username: 'host', token: 'tok' }
    vi.clearAllMocks()
  })

  it('fetchFields loads from API and caches to localStorage', async () => {
    const store = useCustomFieldsStore()
    const fields = [
      mockField({ id: 'cf-1', name: 'Auto Cycle Count', fieldType: 'number', orderSeq: 1 }),
      mockField({
        id: 'cf-2',
        name: 'Shot Consistency',
        fieldType: 'select',
        optionsJson: JSON.stringify([{ label: 'High', value: 'high' }]),
        orderSeq: 2
      })
    ]
    vi.mocked(api.fetchCustomFields).mockResolvedValue(fields)

    const res = await store.fetchFields('evt-1')
    expect(res).toHaveLength(2)
    expect(res[1].options).toEqual([{ label: 'High', value: 'high' }])
    expect(store.getFields('evt-1')).toHaveLength(2)

    // Check localStorage cache
    const cached = localStorage.getItem('sp27_custom_fields_evt-1')
    expect(cached).toBeTruthy()
    expect(JSON.parse(cached!)).toHaveLength(2)
  })

  it('fetchFields falls back smoothly to localStorage cache on network error', async () => {
    const store = useCustomFieldsStore()
    const cached = [mockField({ id: 'cf-cached', name: 'Offline Field' })]
    localStorage.setItem('sp27_custom_fields_evt-offline', JSON.stringify(cached))

    vi.mocked(api.fetchCustomFields).mockRejectedValue(new Error('Network error'))

    const res = await store.fetchFields('evt-offline')
    expect(res).toHaveLength(1)
    expect(res[0].name).toBe('Offline Field')
    expect(store.error).toBe('Network error')
  })

  it('getFields filters by target, phase, and sorts by orderSeq', () => {
    const store = useCustomFieldsStore()
    store.fieldsByEvent['evt-1'] = [
      mockField({ id: 'cf-3', target: 'MATCH', phase: 'endgame', orderSeq: 30 }),
      mockField({ id: 'cf-1', target: 'MATCH', phase: 'auto', orderSeq: 10 }),
      mockField({ id: 'cf-2', target: 'MATCH', phase: 'auto', orderSeq: 20 }),
      mockField({ id: 'cf-pit', target: 'PIT', phase: 'hardware', orderSeq: 5 })
    ]

    const matchAuto = store.getFields('evt-1', 'MATCH', 'auto')
    expect(matchAuto.map((f) => f.id)).toEqual(['cf-1', 'cf-2'])

    const allMatch = store.getFields('evt-1', 'MATCH')
    expect(allMatch.map((f) => f.id)).toEqual(['cf-1', 'cf-2', 'cf-3'])

    const allPit = store.getFields('evt-1', 'PIT')
    expect(allPit.map((f) => f.id)).toEqual(['cf-pit'])
  })

  it('getActiveFields returns only active definitions', () => {
    const store = useCustomFieldsStore()
    store.fieldsByEvent['evt-1'] = [
      mockField({ id: 'cf-1', isActive: true, orderSeq: 1 }),
      mockField({ id: 'cf-2', isActive: false, orderSeq: 2 }),
      mockField({ id: 'cf-3', isActive: true, orderSeq: 3 })
    ]

    const active = store.getActiveFields('evt-1', 'MATCH')
    expect(active.map((f) => f.id)).toEqual(['cf-1', 'cf-3'])
  })

  it('createField adds field, saves to localStorage, and broadcasts if host', async () => {
    const store = useCustomFieldsStore()
    const eventStore = useEventStore()
    const connStore = useConnectionStore()

    eventStore.currentEvent = { id: 'evt-1', hostId: 'me', name: 'Test' } as any
    const broadcastSpy = vi.fn()
    connStore.rtcService = { sendMessage: broadcastSpy } as any

    const newField = mockField({ id: 'cf-new', name: 'Climb Rating' })
    vi.mocked(api.createCustomField).mockResolvedValue(newField)

    const created = await store.createField('evt-1', { name: 'Climb Rating' })
    expect(created.id).toBe('cf-new')
    expect(store.getFields('evt-1')).toHaveLength(1)
    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'CUSTOM_FIELD_UPDATE',
        action: 'CREATE',
        eventId: 'evt-1',
        field: expect.objectContaining({ id: 'cf-new' })
      })
    )
  })

  it('updateField updates store and calls broadcast', async () => {
    const store = useCustomFieldsStore()
    const eventStore = useEventStore()
    const connStore = useConnectionStore()

    eventStore.currentEvent = { id: 'evt-1', hostId: 'me' } as any
    const broadcastSpy = vi.fn()
    connStore.rtcService = { sendMessage: broadcastSpy } as any

    store.fieldsByEvent['evt-1'] = [mockField({ id: 'cf-1', name: 'Old Name' })]
    const updated = mockField({ id: 'cf-1', name: 'New Name' })
    vi.mocked(api.updateCustomField).mockResolvedValue(updated)

    const res = await store.updateField('evt-1', 'cf-1', { name: 'New Name' })
    expect(res.name).toBe('New Name')
    expect(store.fieldsByEvent['evt-1'][0].name).toBe('New Name')
    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'CUSTOM_FIELD_UPDATE',
        action: 'UPDATE'
      })
    )
  })

  it('deleteField removes field and broadcasts deletion', async () => {
    const store = useCustomFieldsStore()
    const eventStore = useEventStore()
    const connStore = useConnectionStore()

    eventStore.currentEvent = { id: 'evt-1', hostId: 'me' } as any
    const broadcastSpy = vi.fn()
    connStore.rtcService = { sendMessage: broadcastSpy } as any

    store.fieldsByEvent['evt-1'] = [mockField({ id: 'cf-del', name: 'To Delete' })]
    vi.mocked(api.deleteCustomField).mockResolvedValue()

    await store.deleteField('evt-1', 'cf-del')
    expect(store.fieldsByEvent['evt-1']).toHaveLength(0)
    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'CUSTOM_FIELD_UPDATE',
        action: 'DELETE',
        field: expect.objectContaining({ id: 'cf-del' })
      })
    )
  })

  it('toggleFieldActive inverts active state', async () => {
    const store = useCustomFieldsStore()
    store.fieldsByEvent['evt-1'] = [mockField({ id: 'cf-1', isActive: true })]

    vi.mocked(api.updateCustomField).mockImplementation(async (_eid, _id, def) => ({
      ...mockField({ id: 'cf-1' }),
      ...def
    }))

    const toggled = await store.toggleFieldActive('evt-1', 'cf-1')
    expect(toggled?.isActive).toBe(false)
  })

  it('moveFieldOrder swaps orderSeq between items', async () => {
    const store = useCustomFieldsStore()
    store.fieldsByEvent['evt-1'] = [
      mockField({ id: 'cf-1', orderSeq: 10 }),
      mockField({ id: 'cf-2', orderSeq: 20 })
    ]

    vi.mocked(api.updateCustomField).mockImplementation(async (_eid, _id, def) => ({
      ...mockField({ id: _id }),
      ...def
    }))

    // Move cf-2 up
    await store.moveFieldOrder('evt-1', 'cf-2', 'up', 'MATCH')
    expect(api.updateCustomField).toHaveBeenCalledWith('evt-1', 'cf-2', expect.objectContaining({ orderSeq: 10 }))
    expect(api.updateCustomField).toHaveBeenCalledWith('evt-1', 'cf-1', expect.objectContaining({ orderSeq: 20 }))
  })

  it('WebRTC applyFullSync replaces definitions and saves to localStorage', () => {
    const store = useCustomFieldsStore()
    const incoming = [
      mockField({ id: 'cf-peer-1', name: 'Synced Field 1' }),
      mockField({ id: 'cf-peer-2', name: 'Synced Field 2' })
    ]

    store.applyFullSync('evt-sync', incoming)
    expect(store.getFields('evt-sync')).toHaveLength(2)
    const cached = localStorage.getItem('sp27_custom_fields_evt-sync')
    expect(cached).toBeTruthy()
    expect(JSON.parse(cached!)).toHaveLength(2)
  })

  it('WebRTC applyRemoteUpdate supports CREATE, UPDATE, DELETE', () => {
    const store = useCustomFieldsStore()
    store.fieldsByEvent['evt-1'] = [mockField({ id: 'cf-1', name: 'Field 1' })]

    // Remote CREATE
    store.applyRemoteUpdate('evt-1', mockField({ id: 'cf-2', name: 'Field 2' }), 'CREATE')
    expect(store.fieldsByEvent['evt-1']).toHaveLength(2)

    // Remote UPDATE
    store.applyRemoteUpdate('evt-1', mockField({ id: 'cf-1', name: 'Field 1 Renamed' }), 'UPDATE')
    expect(store.fieldsByEvent['evt-1'].find((f) => f.id === 'cf-1')?.name).toBe('Field 1 Renamed')

    // Remote DELETE
    store.applyRemoteUpdate('evt-1', mockField({ id: 'cf-2' }), 'DELETE')
    expect(store.fieldsByEvent['evt-1'].map((f) => f.id)).toEqual(['cf-1'])
  })

  describe('Edge Cases & Boundary Protections', () => {
    it('handles malformed optionsJson safely and falls back to empty options array', async () => {
      const store = useCustomFieldsStore()
      const fields = [
        mockField({
          id: 'cf-malformed',
          name: 'Broken JSON Field',
          optionsJson: '{not-valid-json'
        })
      ]
      vi.mocked(api.fetchCustomFields).mockResolvedValue(fields)

      const res = await store.fetchFields('evt-edge')
      expect(res[0].options).toEqual([])
    })

    it('handles corrupted localStorage data without throwing or crashing', () => {
      const store = useCustomFieldsStore()
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      localStorage.setItem('sp27_custom_fields_evt-corrupted', '{{{corrupted json')

      expect(() => {
        store.loadFromLocalStorage('evt-corrupted')
      }).not.toThrow()
      expect(store.getFields('evt-corrupted')).toEqual([])
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })

    it('returns empty array when empty eventId is passed to getFields or fetchFields', async () => {
      const store = useCustomFieldsStore()
      expect(store.getFields('')).toEqual([])
      expect(store.getActiveFields('', 'MATCH')).toEqual([])

      const res = await store.fetchFields('')
      expect(res).toEqual([])
      expect(api.fetchCustomFields).not.toHaveBeenCalled()
    })

    it('moveFieldOrder gracefully ignores out-of-bounds moves (top up, bottom down, non-existent)', async () => {
      const store = useCustomFieldsStore()
      store.fieldsByEvent['evt-bounds'] = [
        mockField({ id: 'cf-1', orderSeq: 1 }),
        mockField({ id: 'cf-2', orderSeq: 2 })
      ]

      // Moving top item 'up' -> swapIdx -1 < 0 -> no-op
      await store.moveFieldOrder('evt-bounds', 'cf-1', 'up', 'MATCH')
      expect(api.updateCustomField).not.toHaveBeenCalled()

      // Moving bottom item 'down' -> swapIdx 2 >= length -> no-op
      await store.moveFieldOrder('evt-bounds', 'cf-2', 'down', 'MATCH')
      expect(api.updateCustomField).not.toHaveBeenCalled()

      // Moving non-existent field -> idx === -1 -> no-op
      await store.moveFieldOrder('evt-bounds', 'cf-non-existent', 'up', 'MATCH')
      expect(api.updateCustomField).not.toHaveBeenCalled()
    })

    it('toggleFieldActive returns null and does not call API when field does not exist', async () => {
      const store = useCustomFieldsStore()
      store.fieldsByEvent['evt-1'] = [mockField({ id: 'cf-1' })]

      const res = await store.toggleFieldActive('evt-1', 'cf-missing')
      expect(res).toBeNull()
      expect(api.updateCustomField).not.toHaveBeenCalled()
    })

    it('applyFullSync ignores falsy eventId or non-array incoming data safely', () => {
      const store = useCustomFieldsStore()
      store.applyFullSync('', [mockField({ id: 'cf-1' })])
      expect(store.getFields('')).toEqual([])

      store.applyFullSync('evt-1', null as any)
      expect(store.getFields('evt-1')).toEqual([])
    })

    it('applyRemoteUpdate is idempotent: CREATE replaces duplicate ID, UPDATE upserts, DELETE ignores missing', () => {
      const store = useCustomFieldsStore()
      store.fieldsByEvent['evt-remote'] = [
        mockField({ id: 'cf-1', name: 'Original Name' })
      ]

      // CREATE on existing ID -> replaces rather than duplicating
      store.applyRemoteUpdate(
        'evt-remote',
        mockField({ id: 'cf-1', name: 'Replaced Via Create' }),
        'CREATE'
      )
      expect(store.fieldsByEvent['evt-remote']).toHaveLength(1)
      expect(store.fieldsByEvent['evt-remote'][0].name).toBe('Replaced Via Create')

      // UPDATE on non-existing ID -> pushes as new item
      store.applyRemoteUpdate(
        'evt-remote',
        mockField({ id: 'cf-new-remote', name: 'Upserted Item' }),
        'UPDATE'
      )
      expect(store.fieldsByEvent['evt-remote']).toHaveLength(2)
      expect(store.fieldsByEvent['evt-remote'].map((f) => f.id)).toContain('cf-new-remote')

      // DELETE on non-existing ID -> safe no-op
      store.applyRemoteUpdate(
        'evt-remote',
        mockField({ id: 'cf-ghost' }),
        'DELETE'
      )
      expect(store.fieldsByEvent['evt-remote']).toHaveLength(2)

      // Null safety
      store.applyRemoteUpdate('', mockField(), 'CREATE')
      store.applyRemoteUpdate('evt-remote', null as any, 'CREATE')
      expect(store.fieldsByEvent['evt-remote']).toHaveLength(2)
    })

    it('deleteField does not broadcast when target field does not exist in store', async () => {
      const store = useCustomFieldsStore()
      const connStore = useConnectionStore()
      const eventStore = useEventStore()
      eventStore.currentEvent = { id: 'evt-1', hostId: 'me' } as any
      const broadcastSpy = vi.fn()
      connStore.rtcService = { sendMessage: broadcastSpy } as any

      store.fieldsByEvent['evt-1'] = [mockField({ id: 'cf-1' })]
      vi.mocked(api.deleteCustomField).mockResolvedValue()

      await store.deleteField('evt-1', 'cf-missing')
      expect(api.deleteCustomField).toHaveBeenCalledWith('evt-1', 'cf-missing')
      // broadcast should NOT be called because targetField was not found
      expect(broadcastSpy).not.toHaveBeenCalled()
    })
  })
})

