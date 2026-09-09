import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useInboxStore } from '../stores/inbox'
import { useUserStore } from '../stores/user'

describe('useInboxStore Outbox and Message delivery', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('adds incoming messages and computes unread count', () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Alice' }

    const inbox = useInboxStore()
    inbox.addMessage({
      title: 'Conflict Alert',
      body: 'Match 1 Team 27570',
      type: 'conflict'
    })

    expect(inbox.messages.length).toBe(1)
    expect(inbox.unreadCount).toBe(1)
    expect(inbox.messages[0].read).toBe(false)

    inbox.markRead(inbox.messages[0].id)
    expect(inbox.unreadCount).toBe(0)
  })

  it('queues direct messages in Outbox as PENDING_DELIVERY and transitions to DELIVERED upon successful send', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Alice' }

    const inbox = useInboxStore()
    const mockRtcSender = {
      sendDirectMessage: vi.fn().mockResolvedValue(true)
    }

    const item = await inbox.sendDirectMessage(
      { targetId: 'u2', targetName: 'Bob', title: 'Strategy', body: 'Go auto left' },
      mockRtcSender
    )

    expect(mockRtcSender.sendDirectMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetId: 'u2',
      title: 'Strategy',
      body: 'Go auto left'
    }))
    expect(item.status).toBe('DELIVERED')
    expect(item.deliveredAt).toBeDefined()
    expect(inbox.outbox.length).toBe(1)
  })

  it('persists PENDING_DELIVERY in Outbox if RTC send fails, and flushes on reconnect', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Alice' }

    const inbox = useInboxStore()
    const mockFailingSender = {
      sendDirectMessage: vi.fn().mockRejectedValue(new Error('RTC Channel Closed'))
    }

    const item = await inbox.sendDirectMessage(
      { targetId: 'u2', title: 'Retry test', body: 'Please read' },
      mockFailingSender
    )

    expect(item.status).toBe('PENDING_DELIVERY')
    expect(item.retryCount).toBe(1)
    expect(inbox.pendingOutboxCount).toBe(1)

    // Now simulate reconnect and successful flush
    const mockSuccessSender = {
      sendDirectMessage: vi.fn().mockResolvedValue(true)
    }

    await inbox.flushOutbox(mockSuccessSender, 'u2')

    expect(mockSuccessSender.sendDirectMessage).toHaveBeenCalledTimes(1)
    expect(inbox.outbox[0].status).toBe('DELIVERED')
    expect(inbox.pendingOutboxCount).toBe(0)
  })

  it('manages isOpen state with toggleOpen and setOpen', () => {
    const inbox = useInboxStore()
    expect(inbox.isOpen).toBe(false)

    inbox.toggleOpen()
    expect(inbox.isOpen).toBe(true)

    inbox.toggleOpen()
    expect(inbox.isOpen).toBe(false)

    inbox.setOpen(true)
    expect(inbox.isOpen).toBe(true)

    inbox.setOpen(false)
    expect(inbox.isOpen).toBe(false)
  })

  it('deduplicates messages by id and supports markAllRead, deleteMessage, clearAllMessages', () => {
    const inbox = useInboxStore()

    // Add first message with id
    inbox.addMessage({
      id: 'msg-fixed-1',
      title: 'Strategy Update',
      body: 'Autonomous plan changed',
      type: 'direct'
    })

    // Add duplicate message with same id -> should be deduplicated
    inbox.addMessage({
      id: 'msg-fixed-1',
      title: 'Strategy Update',
      body: 'Autonomous plan changed duplicate',
      type: 'direct'
    })

    expect(inbox.messages.length).toBe(1)
    expect(inbox.unreadCount).toBe(1)

    // Add second message
    inbox.addMessage({
      id: 'msg-fixed-2',
      title: 'Match 3 Ready',
      body: 'Queueing now',
      type: 'broadcast'
    })
    expect(inbox.messages.length).toBe(2)
    expect(inbox.unreadCount).toBe(2)

    // Mark all read
    inbox.markAllRead()
    expect(inbox.unreadCount).toBe(0)
    expect(inbox.messages.every((m) => m.read)).toBe(true)

    // Delete single message
    inbox.deleteMessage('msg-fixed-1')
    expect(inbox.messages.length).toBe(1)
    expect(inbox.messages[0].id).toBe('msg-fixed-2')

    // Clear all messages
    inbox.clearAllMessages()
    expect(inbox.messages.length).toBe(0)
  })
})
