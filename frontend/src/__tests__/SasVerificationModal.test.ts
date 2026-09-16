import { mount } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import SasVerificationModal from '../components/common/SasVerificationModal.vue'
import { useConnectionStore } from '../stores/connection'

const mockPush = vi.fn()

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: mockPush
  })
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, defaultVal?: any) => (typeof defaultVal === 'string' ? defaultVal : key)
  }),
  createI18n: () => ({
    global: {
      t: (key: string) => key
    }
  })
}))

const mountModal = () => mount(SasVerificationModal, {
  global: {
    stubs: {
      teleport: true
    }
  }
})

describe('SasVerificationModal.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('renders nothing when there is no pending SAS', () => {
    const connStore = useConnectionStore()
    connStore.pendingSas = null

    const wrapper = mountModal()
    expect(wrapper.find('.sas-modal-overlay').exists()).toBe(false)
  })

  it('renders peer info and fingerprint when pending SAS is present', () => {
    const connStore = useConnectionStore()
    connStore.pendingSas = {
      peerId: 'peer_123',
      username: 'Bob',
      fingerprint: 'A1B2-C3D4'
    }

    const wrapper = mountModal()
    expect(wrapper.find('.sas-modal-overlay').exists()).toBe(true)
    expect(wrapper.find('.peer-value').text()).toContain('Bob (peer_123)')
    expect(wrapper.find('.sas-code-display').text()).toBe('A1B2-C3D4')
  })

  it('calls clearPendingSas on dismiss close button click', async () => {
    const connStore = useConnectionStore()
    connStore.pendingSas = {
      peerId: 'peer_123',
      username: 'Bob',
      fingerprint: 'A1B2-C3D4'
    }
    const clearSpy = vi.spyOn(connStore, 'clearPendingSas').mockImplementation(() => {})

    const wrapper = mountModal()
    const closeBtn = wrapper.find('.btn-close-sas')
    expect(closeBtn.exists()).toBe(true)
    await closeBtn.trigger('click')

    expect(clearSpy).toHaveBeenCalled()
  })

  it('calls rejectSas, disconnect, and navigates home on leave event button click', async () => {
    const connStore = useConnectionStore()
    connStore.pendingSas = {
      peerId: 'peer_123',
      username: 'Bob',
      fingerprint: 'A1B2-C3D4'
    }
    const rejectSpy = vi.spyOn(connStore, 'rejectSas').mockImplementation(() => {})
    const disconnectSpy = vi.spyOn(connStore, 'disconnect').mockImplementation(() => {})

    const wrapper = mountModal()
    const leaveBtn = wrapper.find('.btn-secondary')
    expect(leaveBtn.exists()).toBe(true)
    await leaveBtn.trigger('click')

    expect(rejectSpy).toHaveBeenCalledWith(undefined, expect.stringContaining('leave'))
    expect(disconnectSpy).toHaveBeenCalled()
    expect(mockPush).toHaveBeenCalledWith('/')
  })

  it('calls rejectSas on reject button click', async () => {
    const connStore = useConnectionStore()
    connStore.pendingSas = {
      peerId: 'peer_123',
      username: 'Bob',
      fingerprint: 'A1B2-C3D4'
    }
    const rejectSpy = vi.spyOn(connStore, 'rejectSas').mockImplementation(() => {})

    const wrapper = mountModal()
    const rejectBtn = wrapper.find('.btn-danger')
    expect(rejectBtn.exists()).toBe(true)
    await rejectBtn.trigger('click')

    expect(rejectSpy).toHaveBeenCalledWith(undefined, expect.stringContaining('rejected'))
  })

  it('calls confirmSas on confirm button click', async () => {
    const connStore = useConnectionStore()
    connStore.pendingSas = {
      peerId: 'peer_123',
      username: 'Bob',
      fingerprint: 'A1B2-C3D4'
    }
    const confirmSpy = vi.spyOn(connStore, 'confirmSas').mockImplementation(() => {})

    const wrapper = mountModal()
    const confirmBtn = wrapper.find('.btn-success')
    expect(confirmBtn.exists()).toBe(true)
    await confirmBtn.trigger('click')

    expect(confirmSpy).toHaveBeenCalled()
  })
})
