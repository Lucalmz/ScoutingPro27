import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEventStore } from '../stores/events'
import * as api from '../services/api'

vi.mock('../services/api', () => ({
  listEvents: vi.fn(),
  createEvent: vi.fn(),
  joinEvent: vi.fn()
}))

describe('Events Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('create event', async () => {
    const store = useEventStore()
    vi.mocked(api.createEvent).mockResolvedValue({ id: 'evt-1', inviteCode: 'ABCDEF' })
    
    const evt = await store.create('My Event')
    expect(evt?.id).toBe('evt-1')
    expect(evt?.name).toBe('My Event')
    expect(evt?.isHost).toBe(true)
    expect(store.events).toHaveLength(1)
    expect(store.currentEvent?.id).toBe('evt-1')
  })

  it('join event', async () => {
    const store = useEventStore()
    vi.mocked(api.joinEvent).mockResolvedValue(undefined)
    
    const evt = await store.join('ABCDEF', 'Joined Event')
    expect(evt?.inviteCode).toBe('ABCDEF')
    expect(evt?.isHost).toBe(false)
    expect(store.events).toHaveLength(1)
    expect(store.currentEvent?.name).toBe('Joined Event')
  })
})
