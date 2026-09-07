import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach } from 'vitest'
import { useNavigationStore } from '../stores/navigation'

describe('Navigation Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStorage.clear()
  })

  it('saves and retrieves event position for rankings tab', () => {
    const store = useNavigationStore()
    store.saveEventPosition({
      eventId: 'evt-101',
      fromTab: 'rankings',
      contentScrollTop: 450,
      contentScrollLeft: 0,
      tableScrollLeft: 120,
      teamNumber: 27570
    })

    const retrieved = store.getEventPosition('evt-101')
    expect(retrieved).not.toBeNull()
    expect(retrieved?.eventId).toBe('evt-101')
    expect(retrieved?.fromTab).toBe('rankings')
    expect(retrieved?.contentScrollTop).toBe(450)
    expect(retrieved?.tableScrollLeft).toBe(120)
    expect(retrieved?.teamNumber).toBe(27570)
    expect(retrieved?.aiChatScrollTop).toBeNull()
  })

  it('saves and retrieves event position for AI chat tab', () => {
    const store = useNavigationStore()
    store.saveEventPosition({
      eventId: 'evt-202',
      fromTab: 'ai',
      contentScrollTop: 0,
      aiChatScrollTop: 780,
      teamNumber: 12345
    })

    const retrieved = store.getEventPosition('evt-202')
    expect(retrieved).not.toBeNull()
    expect(retrieved?.eventId).toBe('evt-202')
    expect(retrieved?.fromTab).toBe('ai')
    expect(retrieved?.aiChatScrollTop).toBe(780)
    expect(retrieved?.teamNumber).toBe(12345)
  })

  it('persists to sessionStorage and restores if memory is cleared', () => {
    const store1 = useNavigationStore()
    store1.saveEventPosition({
      eventId: 'evt-storage',
      fromTab: 'history',
      contentScrollTop: 300
    })

    expect(sessionStorage.getItem('sp27_nav_pos_evt-storage')).toBeTruthy()

    // Simulate page reload by creating new Pinia instance
    setActivePinia(createPinia())
    const store2 = useNavigationStore()
    const restored = store2.getEventPosition('evt-storage')
    expect(restored).not.toBeNull()
    expect(restored?.fromTab).toBe('history')
    expect(restored?.contentScrollTop).toBe(300)
  })

  it('consumes event position (returns and deletes)', () => {
    const store = useNavigationStore()
    store.saveEventPosition({
      eventId: 'evt-consume',
      fromTab: 'rankings',
      contentScrollTop: 100
    })

    const consumed = store.consumeEventPosition('evt-consume')
    expect(consumed).not.toBeNull()
    expect(consumed?.fromTab).toBe('rankings')

    // Subsequent retrieval should return null
    expect(store.getEventPosition('evt-consume')).toBeNull()
    expect(sessionStorage.getItem('sp27_nav_pos_evt-consume')).toBeNull()
  })

  it('clears event position', () => {
    const store = useNavigationStore()
    store.saveEventPosition({
      eventId: 'evt-clear',
      fromTab: 'scout',
      contentScrollTop: 50
    })

    store.clearEventPosition('evt-clear')
    expect(store.getEventPosition('evt-clear')).toBeNull()
    expect(sessionStorage.getItem('sp27_nav_pos_evt-clear')).toBeNull()
  })

  it('handles multiple events independently', () => {
    const store = useNavigationStore()
    store.saveEventPosition({
      eventId: 'event-A',
      fromTab: 'rankings',
      contentScrollTop: 100
    })
    store.saveEventPosition({
      eventId: 'event-B',
      fromTab: 'ai',
      contentScrollTop: 200,
      aiChatScrollTop: 350
    })

    expect(store.getEventPosition('event-A')?.fromTab).toBe('rankings')
    expect(store.getEventPosition('event-A')?.contentScrollTop).toBe(100)

    expect(store.getEventPosition('event-B')?.fromTab).toBe('ai')
    expect(store.getEventPosition('event-B')?.aiChatScrollTop).toBe(350)
  })
})
