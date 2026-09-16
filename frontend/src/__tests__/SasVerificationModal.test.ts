import { mount } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import SasVerificationModal from '../components/common/SasVerificationModal.vue'
import { useConnectionStore } from '../stores/connection'
import { useEventStore } from '../stores/events'
import { useUserStore } from '../stores/user'

const mockPush = vi.fn()

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: mockPush
  })
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, paramsOrDef?: any) => {
      if (typeof paramsOrDef === 'string') return paramsOrDef
      if (key === 'connection.sas_queue_hint') return `Queue: ${paramsOrDef?.current}/${paramsOrDef?.total}`
      return key
    }
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

  it('renders nothing when there is no pending SAS or modal is closed', () => {
    const connStore = useConnectionStore()
    connStore.pendingSas = null

    const wrapper = mountModal()
    expect(wrapper.find('.sas-modal-overlay').exists()).toBe(false)
  })

  describe('Client Mode (!isHost)', () => {
    beforeEach(() => {
      const connStore = useConnectionStore()
      const userStore = useUserStore()
      const eventStore = useEventStore()
      userStore.user = { id: 'client_1', username: 'Scout' }
      eventStore.currentEvent = { id: 'evt_1', hostId: 'host_999' } as any

      connStore.setPendingSas({
        peerId: 'peer_123',
        username: 'Host',
        fingerprint: 'A1B2-C3D4'
      })
    })

    it('renders peer info, fingerprint, and client buttons', () => {
      const wrapper = mountModal()
      expect(wrapper.find('.sas-modal-overlay').exists()).toBe(true)
      expect(wrapper.find('.peer-value').text()).toContain('Host (peer_123)')
      expect(wrapper.find('.sas-code-display').text()).toBe('A1B2-C3D4')
      expect(wrapper.find('.btn-secondary').text()).toContain('离开赛事')
      expect(wrapper.find('.btn-danger').text()).toContain('不一致（立即断开）')
      expect(wrapper.find('.btn-success').text()).toContain('确认一致')
    })

    it('calls closeSasModal on close button click', async () => {
      const connStore = useConnectionStore()
      const closeSpy = vi.spyOn(connStore, 'closeSasModal').mockImplementation(() => {})

      const wrapper = mountModal()
      const closeBtn = wrapper.find('.btn-close-sas')
      await closeBtn.trigger('click')

      expect(closeSpy).toHaveBeenCalled()
    })

    it('calls rejectSas, disconnect, and navigates home on leave event button click', async () => {
      const connStore = useConnectionStore()
      const rejectSpy = vi.spyOn(connStore, 'rejectSas').mockImplementation(() => {})
      const disconnectSpy = vi.spyOn(connStore, 'disconnect').mockImplementation(() => {})

      const wrapper = mountModal()
      const leaveBtn = wrapper.find('.btn-secondary')
      await leaveBtn.trigger('click')

      expect(rejectSpy).toHaveBeenCalledWith('peer_123', expect.stringContaining('leave'))
      expect(disconnectSpy).toHaveBeenCalled()
      expect(mockPush).toHaveBeenCalledWith('/')
    })

    it('calls rejectSas on reject button click', async () => {
      const connStore = useConnectionStore()
      const rejectSpy = vi.spyOn(connStore, 'rejectSas').mockImplementation(() => {})

      const wrapper = mountModal()
      const rejectBtn = wrapper.find('.btn-danger')
      await rejectBtn.trigger('click')

      expect(rejectSpy).toHaveBeenCalledWith('peer_123', expect.stringContaining('rejected'))
    })

    it('calls confirmSas on confirm button click', async () => {
      const connStore = useConnectionStore()
      const confirmSpy = vi.spyOn(connStore, 'confirmSas').mockImplementation(() => {})

      const wrapper = mountModal()
      const confirmBtn = wrapper.find('.btn-success')
      await confirmBtn.trigger('click')

      expect(confirmSpy).toHaveBeenCalledWith('peer_123')
    })
  })

  describe('Host Mode (isHost)', () => {
    beforeEach(() => {
      const connStore = useConnectionStore()
      const userStore = useUserStore()
      const eventStore = useEventStore()
      userStore.user = { id: 'host_1', username: 'HostUser' }
      eventStore.currentEvent = { id: 'evt_1', hostId: 'host_1' } as any

      connStore.setPendingSas({
        peerId: 'client_scout_1',
        username: 'Alice',
        fingerprint: '55AA-40BF'
      })
    })

    it('renders host title, connecting device labels, and safe host action buttons', () => {
      const wrapper = mountModal()
      expect(wrapper.find('.sas-modal-header h3').text()).toContain('节点接入安全核验 (SAS)')
      expect(wrapper.find('.peer-value').text()).toContain('Alice (client_scout_1)')

      // Host buttons: Dismiss, Reject Device, Confirm Device (NO leave event!)
      expect(wrapper.text()).not.toContain('离开赛事')
      expect(wrapper.find('.btn-secondary').text()).toContain('忽略')
      expect(wrapper.find('.btn-danger').text()).toContain('拒绝接入')
      expect(wrapper.find('.btn-success').text()).toContain('确认一致（允许接入）')
    })

    it('calls closeSasModal when Host clicks dismiss button', async () => {
      const connStore = useConnectionStore()
      const closeSpy = vi.spyOn(connStore, 'closeSasModal').mockImplementation(() => {})

      const wrapper = mountModal()
      const dismissBtn = wrapper.find('.btn-secondary')
      await dismissBtn.trigger('click')

      expect(closeSpy).toHaveBeenCalled()
    })

    it('shows queue badge when multiple clients are in pendingSasQueue', () => {
      const connStore = useConnectionStore()
      connStore.setPendingSas({
        peerId: 'client_scout_2',
        username: 'Bob',
        fingerprint: '9988-1122'
      })

      const wrapper = mountModal()
      const badge = wrapper.find('.queue-badge')
      expect(badge.exists()).toBe(true)
      expect(badge.text()).toContain('Queue: 1/2')
    })
  })
})
