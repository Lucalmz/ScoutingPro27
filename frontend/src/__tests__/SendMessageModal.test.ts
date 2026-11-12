import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SendMessageModal from '../components/scouting/SendMessageModal.vue'
import { useInboxStore } from '../stores/inbox'
import { useConnectionStore } from '../stores/connection'
import { useToastStore } from '../stores/toast'

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string, values?: any) => {
        const dict: Record<string, string> = {
          'event.msg_modal_title': 'Send Direct Message',
          'event.msg_recipient_label': 'Recipient',
          'event.msg_content_label': 'Message Content',
          'event.msg_input_placeholder': 'Type message...',
          'event.msg_send_btn': 'Send',
          'event.msg_sending': 'Sending...',
          'event.msg_sent_success': 'Message sent successfully',
          'event.msg_queued_notice': 'Direct messaging not ready. Queued to outbox.',
          'event.msg_queued_toast': 'Realtime channel not ready. Message saved to outbox.',
          'event.msg_shortcut_tip': 'Enter to send, Shift+Enter for new line',
          'event.msg_empty_warning': 'Please enter a message',
          'event.status_online': 'Online',
          'event.status_offline': 'Offline',
          'common.cancel': 'Cancel'
        }
        return dict[key] || key
      }
    })
  }
})

describe('SendMessageModal.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders modal when visible is true with recipient name and online status', async () => {
    const wrapper = mount(SendMessageModal, {
      props: {
        visible: true,
        targetScoutId: 'scout-123',
        targetScoutName: 'Bob Builder',
        isOnline: true
      }
    })
    await flushPromises()

    const card = document.body.querySelector('.send-msg-card')
    expect(card).toBeTruthy()
    expect(card?.textContent).toContain('Bob Builder')
    expect(card?.textContent).toContain('Send Direct Message')
    const dot = card?.querySelector('.status-indicator-dot')
    expect(dot?.classList.contains('dot-online')).toBe(true)

    wrapper.unmount()
  })

  it('keeps send button disabled when input is empty or whitespace', async () => {
    const wrapper = mount(SendMessageModal, {
      props: {
        visible: true,
        targetScoutId: 'scout-123',
        targetScoutName: 'Bob'
      }
    })
    await flushPromises()

    const sendBtn = document.body.querySelector('.btn-send-action') as HTMLButtonElement
    expect(sendBtn.disabled).toBe(true)

    const textarea = document.body.querySelector('textarea') as HTMLTextAreaElement
    textarea.value = '   '
    textarea.dispatchEvent(new Event('input'))
    await flushPromises()
    expect(sendBtn.disabled).toBe(true)

    textarea.value = 'Hello scout!'
    textarea.dispatchEvent(new Event('input'))
    await flushPromises()
    expect(sendBtn.disabled).toBe(false)

    wrapper.unmount()
  })

  it('sends direct message via inboxStore when connected to WebRTC', async () => {
    const connStore = useConnectionStore()
    const mockRtcService = {
      sendDirectMessage: vi.fn().mockResolvedValue(true)
    }
    connStore.rtcService = mockRtcService as any

    const inboxStore = useInboxStore()
    const sendSpy = vi.spyOn(inboxStore, 'sendDirectMessage')
    const toastStore = useToastStore()
    const toastSpy = vi.spyOn(toastStore, 'showToast')

    const wrapper = mount(SendMessageModal, {
      props: {
        visible: true,
        targetScoutId: 'scout-123',
        targetScoutName: 'Bob',
        isOnline: true
      }
    })
    await flushPromises()

    const textarea = document.body.querySelector('textarea') as HTMLTextAreaElement
    textarea.value = 'Keep up the good scouting!'
    textarea.dispatchEvent(new Event('input'))
    await flushPromises()

    const sendBtn = document.body.querySelector('.btn-send-action') as HTMLButtonElement
    sendBtn.click()
    await flushPromises()

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: 'scout-123',
        targetName: 'Bob',
        title: 'Message from Host',
        body: 'Keep up the good scouting!'
      }),
      mockRtcService
    )
    expect(toastSpy).toHaveBeenCalledWith('Message sent successfully', 'success')
    expect(wrapper.emitted('sent')).toBeTruthy()
    expect(wrapper.emitted('update:visible')?.[0]).toEqual([false])

    wrapper.unmount()
  })

  it('queues direct message into offline outbox when rtcService is null', async () => {
    const connStore = useConnectionStore()
    connStore.rtcService = null

    const inboxStore = useInboxStore()
    const sendSpy = vi.spyOn(inboxStore, 'sendDirectMessage')
    const toastStore = useToastStore()
    const toastSpy = vi.spyOn(toastStore, 'showToast')

    const wrapper = mount(SendMessageModal, {
      props: {
        visible: true,
        targetScoutId: 'scout-456',
        targetScoutName: 'Charlie',
        isOnline: false
      }
    })
    await flushPromises()

    // Shows offline notice
    expect(document.body.querySelector('.send-msg-notice')).toBeTruthy()

    const textarea = document.body.querySelector('textarea') as HTMLTextAreaElement
    textarea.value = 'Queued note'
    textarea.dispatchEvent(new Event('input'))
    await flushPromises()

    const sendBtn = document.body.querySelector('.btn-send-action') as HTMLButtonElement
    sendBtn.click()
    await flushPromises()

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: 'scout-456',
        targetName: 'Charlie',
        body: 'Queued note'
      }),
      undefined
    )
    expect(toastSpy).toHaveBeenCalledWith('Realtime channel not ready. Message saved to outbox.', 'info')
    expect(wrapper.emitted('update:visible')?.[0]).toEqual([false])

    wrapper.unmount()
  })

  it('sends when pressing Enter without Shift', async () => {
    const inboxStore = useInboxStore()
    const sendSpy = vi.spyOn(inboxStore, 'sendDirectMessage')

    const wrapper = mount(SendMessageModal, {
      props: {
        visible: true,
        targetScoutId: 'scout-123',
        targetScoutName: 'Bob'
      }
    })
    await flushPromises()

    const textarea = document.body.querySelector('textarea') as HTMLTextAreaElement
    textarea.value = 'Enter key test'
    textarea.dispatchEvent(new Event('input'))
    await flushPromises()

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: false, bubbles: true }))
    await flushPromises()

    expect(sendSpy).toHaveBeenCalled()
    expect(wrapper.emitted('update:visible')?.[0]).toEqual([false])

    wrapper.unmount()
  })

  it('does not send on Shift+Enter (allows multi-line typing)', async () => {
    const inboxStore = useInboxStore()
    const sendSpy = vi.spyOn(inboxStore, 'sendDirectMessage')

    const wrapper = mount(SendMessageModal, {
      props: {
        visible: true,
        targetScoutId: 'scout-123',
        targetScoutName: 'Bob'
      }
    })
    await flushPromises()

    const textarea = document.body.querySelector('textarea') as HTMLTextAreaElement
    textarea.value = 'Line 1'
    textarea.dispatchEvent(new Event('input'))
    await flushPromises()

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
    await flushPromises()

    expect(sendSpy).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('emits update:visible false when clicking cancel or close button', async () => {
    const wrapper = mount(SendMessageModal, {
      props: {
        visible: true,
        targetScoutId: 'scout-123',
        targetScoutName: 'Bob'
      }
    })
    await flushPromises()

    const closeBtn = document.body.querySelector('.btn-close') as HTMLButtonElement
    closeBtn.click()
    expect(wrapper.emitted('update:visible')).toEqual([[false]])

    const cancelBtn = document.body.querySelector('.btn-secondary') as HTMLButtonElement
    cancelBtn.click()
    expect(wrapper.emitted('update:visible')).toEqual([[false], [false]])

    wrapper.unmount()
  })
})
