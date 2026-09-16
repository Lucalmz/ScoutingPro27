import { mount, flushPromises } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import SessionConflictModal from '../components/common/SessionConflictModal.vue'
import { useUserStore } from '../stores/user'
import { useConnectionStore } from '../stores/connection'
import { useToastStore } from '../stores/toast'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, any>) => {
      if (key === 'conflict.duplicate_name_desc') return `Duplicate name ${params?.name}`
      if (key === 'conflict.description') return `Conflict for ${params?.name}`
      return key
    }
  }),
  createI18n: () => ({
    global: {
      t: (key: string) => key
    }
  })
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: vi.fn()
  })
}))

const mountModal = () => mount(SessionConflictModal, {
  global: {
    stubs: {
      teleport: true
    }
  }
})

describe('SessionConflictModal.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('renders nothing when there is no session conflict', () => {
    const connStore = useConnectionStore()
    connStore.sessionConflict = null

    const wrapper = mountModal()
    expect(wrapper.find('.modal-card').exists()).toBe(false)
  })

  describe('DUPLICATE_NAME Conflict', () => {
    beforeEach(() => {
      const connStore = useConnectionStore()
      connStore.sessionConflict = {
        conflictingUsername: 'Alice',
        conflictingUserId: 'existing-alice-uuid',
        conflictType: 'DUPLICATE_NAME',
        suggestedName: 'Alice-99'
      }
    })

    it('renders both rename and merge account branches with divider', () => {
      const wrapper = mountModal()
      expect(wrapper.find('.modal-card').exists()).toBe(true)

      // Title & desc
      expect(wrapper.text()).toContain('conflict.duplicate_name_title')
      expect(wrapper.text()).toContain('Duplicate name Alice')

      // Rename branch
      expect(wrapper.text()).toContain('conflict.option_duplicate_rename_title')
      const renameInput = wrapper.find<HTMLInputElement>('.option-block input[type="text"]')
      expect(renameInput.exists()).toBe(true)
      expect(renameInput.element.value).toBe('Alice-99')

      // Divider
      expect(wrapper.find('.divider').exists()).toBe(true)

      // Merge branch
      expect(wrapper.text()).toContain('conflict.option_duplicate_merge_title')
      const passwordInput = wrapper.find('.merge-block input[type="password"]')
      expect(passwordInput.exists()).toBe(true)
      expect(wrapper.find('.merge-block .btn-accent').exists()).toBe(true)
    })

    it('executes rename branch successfully and clears conflict', async () => {
      const userStore = useUserStore()
      const connStore = useConnectionStore()
      userStore.user = { id: 'old-scout-id', username: 'Alice', token: 'token123' }

      const renameSpy = vi.spyOn(userStore, 'rename').mockResolvedValueOnce({
        success: true,
        oldId: 'old-scout-id',
        newId: 'new-alice-99-id',
        newUsername: 'Alice-99'
      })
      const requestSyncSpy = vi.spyOn(connStore, 'requestSync').mockImplementation(() => {})

      const wrapper = mountModal()
      const renameBtn = wrapper.find('.option-block .btn-primary')
      await renameBtn.trigger('click')
      await flushPromises()

      expect(renameSpy).toHaveBeenCalledWith('Alice-99')
      expect(connStore.sessionConflict).toBeNull()
      expect(requestSyncSpy).toHaveBeenCalledWith(0, undefined, 'old-scout-id', 'Alice')
    })

    it('executes merge account branch successfully, shows toast, and clears conflict', async () => {
      const userStore = useUserStore()
      const connStore = useConnectionStore()
      const toastStore = useToastStore()
      userStore.user = { id: 'phone-alice-id', username: 'Alice', token: 'phone-token' }

      const mergeSpy = vi.spyOn(userStore, 'mergeAccount').mockResolvedValueOnce({
        success: true,
        oldId: 'phone-alice-id',
        newId: 'primary-alice-id',
        newUsername: 'Alice'
      })
      const toastSpy = vi.spyOn(toastStore, 'showToast').mockImplementation(() => {})
      const requestSyncSpy = vi.spyOn(connStore, 'requestSync').mockImplementation(() => {})

      const wrapper = mountModal()
      const passwordInput = wrapper.find('.merge-block input[type="password"]')
      await passwordInput.setValue('CorrectSecretPass')

      const mergeBtn = wrapper.find('.merge-block .btn-accent')
      expect((mergeBtn.element as HTMLButtonElement).disabled).toBe(false)
      await mergeBtn.trigger('click')
      await flushPromises()

      expect(mergeSpy).toHaveBeenCalledWith('Alice', 'CorrectSecretPass')
      expect(connStore.sessionConflict).toBeNull()
      expect(requestSyncSpy).toHaveBeenCalledWith(0, undefined, 'primary-alice-id', 'Alice')
      expect(toastSpy).toHaveBeenCalled()
    })

    it('handles merge failure gracefully and displays error banner without clearing conflict', async () => {
      const userStore = useUserStore()
      const connStore = useConnectionStore()
      userStore.user = { id: 'phone-alice-id', username: 'Alice', token: 'phone-token' }

      vi.spyOn(userStore, 'mergeAccount').mockResolvedValueOnce({
        success: false,
        oldId: 'phone-alice-id',
        newId: '',
        newUsername: '',
        error: 'Invalid target account password'
      })

      const wrapper = mountModal()
      const passwordInput = wrapper.find('.merge-block input[type="password"]')
      await passwordInput.setValue('WrongPassword')

      const mergeBtn = wrapper.find('.merge-block .btn-accent')
      await mergeBtn.trigger('click')
      await flushPromises()

      expect(connStore.sessionConflict).not.toBeNull()
      expect(wrapper.find('.merge-block .alert-banner.error').exists()).toBe(true)
    })
  })

  describe('SAME_USER Session Conflict (Takeover Mode)', () => {
    beforeEach(() => {
      const connStore = useConnectionStore()
      connStore.sessionConflict = {
        conflictingUsername: 'Charlie',
        conflictingUserId: 'charlie-user-uuid',
        conflictType: 'SAME_USER'
      }
    })

    it('renders takeover and temporary rename options', () => {
      const wrapper = mountModal()
      expect(wrapper.find('.modal-card').exists()).toBe(true)
      expect(wrapper.text()).toContain('conflict.option_takeover')
      expect(wrapper.find('.takeover-action button').exists()).toBe(true)
      // Should NOT render merge block in takeover mode
      expect(wrapper.find('.merge-block').exists()).toBe(false)
    })

    it('triggers takeover request on button click', async () => {
      const userStore = useUserStore()
      const connStore = useConnectionStore()
      userStore.user = { id: 'charlie-user-uuid', username: 'Charlie', token: 'token' }
      const takeoverSpy = vi.spyOn(connStore, 'requestTakeover').mockImplementation(() => {})

      const wrapper = mountModal()
      const takeoverBtn = wrapper.find('.takeover-action button')
      await takeoverBtn.trigger('click')

      expect(takeoverSpy).toHaveBeenCalledWith('Charlie', 'charlie-user-uuid')
    })

    it('safely disconnects and navigates to dashboard when close or exit button clicked', async () => {
      const userStore = useUserStore()
      const connStore = useConnectionStore()
      userStore.user = { id: 'charlie-user-uuid', username: 'Charlie', token: 'token' }
      const disconnectSpy = vi.spyOn(connStore, 'disconnect').mockImplementation(() => {})

      const wrapper = mountModal()
      const closeBtn = wrapper.find('.btn-close-modal')
      await closeBtn.trigger('click')

      expect(connStore.sessionConflict).toBeNull()
      expect(disconnectSpy).toHaveBeenCalled()
    })
  })
})
