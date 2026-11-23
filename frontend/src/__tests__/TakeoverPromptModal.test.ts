import { mount, type VueWrapper } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import TakeoverPromptModal from '../components/common/TakeoverPromptModal.vue'
import { useConnectionStore } from '../stores/connection'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, any>) => {
      if (key === 'takeover.timeout_desc') return `${params?.seconds}s timeout`
      if (key === 'takeover.description') return `Device takeover by ${params?.name}`
      return key
    }
  }),
  createI18n: () => ({
    global: {
      t: (key: string) => key
    }
  })
}))

describe('TakeoverPromptModal.vue', () => {
  const mountedWrappers: VueWrapper<any>[] = []
  const mountModal = () => {
    const w = mount(TakeoverPromptModal, {
      global: {
        stubs: {
          teleport: true
        }
      }
    })
    mountedWrappers.push(w)
    return w
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    while (mountedWrappers.length > 0) {
      mountedWrappers.pop()?.unmount()
    }
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('renders nothing when there is no takeover prompt', () => {
    const connStore = useConnectionStore()
    connStore.takeoverPrompt = null

    const wrapper = mountModal()
    expect(wrapper.find('.modal-card').exists()).toBe(false)
  })

  it('renders prompt card with requester name and countdown badge', () => {
    const connStore = useConnectionStore()
    connStore.takeoverPrompt = {
      requesterUsername: 'Alice-Mobile',
      timeoutSeconds: 15
    }

    const wrapper = mountModal()
    expect(wrapper.find('.modal-card').exists()).toBe(true)
    expect(wrapper.text()).toContain('Device takeover by Alice-Mobile')
    expect(wrapper.text()).toContain('15s timeout')
    expect(wrapper.find('.modal-actions .btn-secondary').exists()).toBe(true)
    expect(wrapper.find('.modal-actions .btn-primary').exists()).toBe(true)
  })

  it('decrements countdown timer and auto-clears on timeout', async () => {
    const connStore = useConnectionStore()
    connStore.takeoverPrompt = {
      requesterUsername: 'Bob',
      timeoutSeconds: 3
    }

    const wrapper = mountModal()
    expect(wrapper.text()).toContain('3s timeout')

    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(wrapper.text()).toContain('2s timeout')

    vi.advanceTimersByTime(2000)
    await nextTick()
    expect(connStore.takeoverPrompt).toBeNull()
  })

  it('responds with decision permit=true when clicking permit button', async () => {
    const connStore = useConnectionStore()
    connStore.takeoverPrompt = {
      requesterUsername: 'Alice-Mobile',
      timeoutSeconds: 15
    }
    const respondSpy = vi.spyOn(connStore, 'respondTakeoverDecision').mockImplementation(() => {})

    const wrapper = mountModal()
    const permitBtn = wrapper.find('.modal-actions .btn-primary')
    await permitBtn.trigger('click')

    expect(respondSpy).toHaveBeenCalledWith('Alice-Mobile', true)
  })

  it('responds with decision permit=false when clicking reject button', async () => {
    const connStore = useConnectionStore()
    connStore.takeoverPrompt = {
      requesterUsername: 'Alice-Mobile',
      timeoutSeconds: 15
    }
    const respondSpy = vi.spyOn(connStore, 'respondTakeoverDecision').mockImplementation(() => {})

    const wrapper = mountModal()
    const rejectBtn = wrapper.find('.modal-actions .btn-secondary')
    await rejectBtn.trigger('click')

    expect(respondSpy).toHaveBeenCalledWith('Alice-Mobile', false)
  })
})
