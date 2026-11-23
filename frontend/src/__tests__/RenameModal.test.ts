import { nextTick } from 'vue'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import RenameModal from '@/components/common/RenameModal.vue'
import { useUserProfileTransition } from '@/composables/useUserProfileTransition'
import { useUserStore } from '@/stores/user'
import { useConnectionStore } from '@/stores/connection'

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string) => {
        const dict: Record<string, string> = {
          'common.cancel': '取消',
          'user.btn_cancel': '取消',
          'user.rename_title': '修改账号资料与密码',
          'user.nickname_label': '用户名 / 昵称',
          'user.btn_save': '保存修改',
          'user.password_mismatch': '两次输入的新密码不一致'
        }
        return dict[key] || key
      }
    })
  }
})

describe('RenameModal.vue', () => {
  const wrappers: VueWrapper<any>[] = []
  const track = <T extends VueWrapper<any>>(w: T): T => {
    wrappers.push(w)
    return w
  }
  const { resetProfileTransition } = useUserProfileTransition()
  const docAny = document as Document & { startViewTransition?: any }
  const origStartVT = docAny.startViewTransition
  const origMatchMedia = window.matchMedia

  beforeEach(() => {
    setActivePinia(createPinia())
    resetProfileTransition()
    vi.clearAllMocks()
  })

  afterEach(() => {
    while (wrappers.length) wrappers.pop()!.unmount()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    resetProfileTransition()
    if (origStartVT === undefined) {
      delete docAny.startViewTransition
    } else {
      docAny.startViewTransition = origStartVT
    }
    window.matchMedia = origMatchMedia
  })

  it('renders modal when visible is true and populates current username, showing Cancel button properly', () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Alice', token: 'tok' }

    const wrapper = track(mount(RenameModal, {
      props: {
        visible: true,
        eventId: 'evt_1'
      }
    }))

    expect(wrapper.find('.modal-title').text()).toContain('修改账号资料与密码')
    const input = wrapper.find<HTMLInputElement>('input.form-input')
    expect(input.element.value).toBe('Alice')

    const cancelBtn = wrapper.find('button.btn-secondary')
    expect(cancelBtn.text()).toBe('取消')
  })

  it('triggers rename with updated username upon save', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Alice', token: 'tok' }
    vi.spyOn(userStore, 'rename').mockResolvedValue({
      success: true,
      oldId: 'u1',
      newId: 'u2',
      newUsername: 'Alice-88'
    })

    const connStore = useConnectionStore()
    const mockRtc = {
      sendIdentityMigration: vi.fn(),
      requestSync: vi.fn()
    }
    connStore.setRtcService(mockRtc as any)

    const wrapper = track(mount(RenameModal, {
      props: {
        visible: true,
        eventId: 'evt_100'
      }
    }))

    const input = wrapper.find<HTMLInputElement>('input.form-input')
    await input.setValue('Alice-88')

    const saveBtn = wrapper.find('button.btn-primary')
    await saveBtn.trigger('click')

    expect(userStore.rename).toHaveBeenCalledWith({
      newUsername: 'Alice-88',
      oldPassword: undefined,
      newPassword: undefined
    })
    expect(mockRtc.sendIdentityMigration).toHaveBeenCalledWith('evt_100', 'u1', 'u2', 'Alice-88')
    expect(wrapper.emitted('renamed')).toBeTruthy()
    expect(wrapper.emitted('renamed')![0]).toEqual(['Alice-88'])
    expect(wrapper.emitted('update:visible')![0]).toEqual([false])
  })

  it('supports updating password when toggle is checked', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Alice', token: 'tok' }
    vi.spyOn(userStore, 'rename').mockResolvedValue({
      success: true,
      oldId: 'u1',
      newId: 'u3',
      newUsername: 'Alice'
    })

    const wrapper = track(mount(RenameModal, {
      props: {
        visible: true
      }
    }))

    // Click accordion header to expand password fields
    const accordionHeader = wrapper.find('.accordion-header')
    await accordionHeader.trigger('click')

    const inputs = wrapper.findAll<HTMLInputElement>('input[type="password"]')
    expect(inputs).toHaveLength(3)

    // Fill old password, new password, and confirm password
    await inputs[0]!.setValue('oldSecret123')
    await inputs[1]!.setValue('newSecret456')
    await inputs[2]!.setValue('newSecret456')

    const saveBtn = wrapper.find('button.btn-primary')
    await saveBtn.trigger('click')

    expect(userStore.rename).toHaveBeenCalledWith({
      newUsername: 'Alice',
      oldPassword: 'oldSecret123',
      newPassword: 'newSecret456'
    })
    expect(wrapper.emitted('renamed')).toBeTruthy()
  })

  it('orchestrates open view transition, focuses input on landing, and cleans up attrs', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Alice', token: 'tok' }

    let resolveFinished!: () => void
    docAny.startViewTransition = vi.fn((cb: () => Promise<void> | void) => {
      void Promise.resolve(cb())
      return {
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
        finished: new Promise<void>((resolve) => {
          resolveFinished = resolve
        })
      }
    })

    const triggerBtn = document.createElement('button')
    document.body.appendChild(triggerBtn)

    const { openProfileModal } = useUserProfileTransition()
    const wrapper = track(mount(RenameModal, {
      attachTo: document.body,
      props: { visible: false }
    }))

    try {
      openProfileModal((val) => {
        void wrapper.setProps({ visible: val })
      }, triggerBtn)

      await flushPromises()
      await nextTick()

      expect(document.documentElement.dataset.transitionType).toBe('user-profile')
      expect(document.documentElement.dataset.profilePhase).toBe('open')

      const overlay = wrapper.find('.modal-overlay').element as HTMLElement
      const card = wrapper.find('.modal-card').element as HTMLElement
      const textMorph = wrapper.find('.input-text-morph').element as HTMLElement
      const inputWrapper = wrapper.find('.username-input-wrapper').element as HTMLElement

      expect(overlay.style.viewTransitionName).toBe('user-profile-backdrop')
      expect(card.style.viewTransitionName).toBe('user-profile-panel')
      expect(textMorph.style.viewTransitionName).toBe('user-profile-text')
      expect(inputWrapper.style.viewTransitionName || '').toBe('')

      resolveFinished()
      await flushPromises()
      await nextTick()

      expect(document.documentElement.getAttribute('data-transition-type')).toBeNull()
      expect(document.documentElement.getAttribute('data-profile-phase')).toBeNull()
      expect(wrapper.find('.input-text-morph').exists()).toBe(false)
      expect(document.activeElement).toBe(wrapper.find('input.form-input').element)
    } finally {
      wrapper.unmount()
      triggerBtn.remove()
    }
  })

  it('orchestrates close view transition on Cancel/Escape and restores trigger focus', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Alice', token: 'tok' }

    const deferredVts: Array<{ resolve: () => void }> = []
    docAny.startViewTransition = vi.fn((cb: () => Promise<void> | void) => {
      void Promise.resolve(cb())
      return {
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
        finished: new Promise<void>((resolve) => {
          deferredVts.push({ resolve })
        })
      }
    })

    const triggerBtn = document.createElement('button')
    document.body.appendChild(triggerBtn)

    const { openProfileModal } = useUserProfileTransition()
    const wrapper = track(mount(RenameModal, {
      attachTo: document.body,
      props: {
        visible: false,
        'onUpdate:visible': (val: boolean) => {
          void wrapper.setProps({ visible: val })
        }
      }
    }))

    try {
      openProfileModal((val) => {
        void wrapper.setProps({ visible: val })
      }, triggerBtn)
      await flushPromises()
      deferredVts[0]!.resolve()
      await flushPromises()

      // Dismiss via Cancel button
      await wrapper.find('button.btn-secondary').trigger('click')
      await flushPromises()

      expect(docAny.startViewTransition).toHaveBeenCalledTimes(2)
      expect(document.documentElement.dataset.transitionType).toBe('user-profile')
      expect(document.documentElement.dataset.profilePhase).toBe('close')
      expect(wrapper.emitted('update:visible')?.slice(-1)[0]).toEqual([false])

      deferredVts[1]!.resolve()
      await flushPromises()

      expect(document.documentElement.getAttribute('data-transition-type')).toBeNull()
      expect(document.documentElement.getAttribute('data-profile-phase')).toBeNull()
      expect(document.activeElement).toBe(triggerBtn)
    } finally {
      wrapper.unmount()
      triggerBtn.remove()
    }
  })

  it('guards against stale open finished resolving after close has started', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Alice', token: 'tok' }

    const deferredVts: Array<{ resolve: () => void }> = []
    docAny.startViewTransition = vi.fn((cb: () => Promise<void> | void) => {
      void Promise.resolve(cb())
      return {
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
        finished: new Promise<void>((resolve) => {
          deferredVts.push({ resolve })
        })
      }
    })

    const { openProfileModal } = useUserProfileTransition()
    const wrapper = track(mount(RenameModal, {
      props: {
        visible: false,
        'onUpdate:visible': (val: boolean) => {
          void wrapper.setProps({ visible: val })
        }
      }
    }))

    try {
      openProfileModal((val) => {
        void wrapper.setProps({ visible: val })
      })
      await flushPromises()
      expect(document.documentElement.dataset.profilePhase).toBe('open')

      // Start close before open's vt.finished resolves
      await wrapper.find('button.btn-secondary').trigger('click')
      await flushPromises()
      expect(document.documentElement.dataset.profilePhase).toBe('close')

      // Resolve stale open transition first
      deferredVts[0]!.resolve()
      await flushPromises()
      expect(document.documentElement.dataset.transitionType).toBe('user-profile')
      expect(document.documentElement.dataset.profilePhase).toBe('close')

      // Resolve close transition
      deferredVts[1]!.resolve()
      await flushPromises()
      expect(document.documentElement.getAttribute('data-transition-type')).toBeNull()
      expect(document.documentElement.getAttribute('data-profile-phase')).toBeNull()
    } finally {
      wrapper.unmount()
    }
  })

  it('skips view transitions when prefers-reduced-motion is reduce', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Alice', token: 'tok' }

    docAny.startViewTransition = vi.fn()
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))

    const { openProfileModal } = useUserProfileTransition()
    const wrapper = track(mount(RenameModal, {
      props: { visible: false }
    }))

    try {
      openProfileModal((val) => {
        void wrapper.setProps({ visible: val })
      })
      await flushPromises()

      expect(docAny.startViewTransition).not.toHaveBeenCalled()
      expect(wrapper.find('.modal-card').exists()).toBe(true)

      await wrapper.find('button.btn-secondary').trigger('click')
      await flushPromises()

      expect(docAny.startViewTransition).not.toHaveBeenCalled()
      expect(wrapper.emitted('update:visible')?.[0]).toEqual([false])
    } finally {
      wrapper.unmount()
    }
  })

  it('calls skipTransition before clearing attrs when close safety timer fires', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Alice', token: 'tok' }

    const callOrder: string[] = []
    const origRemoveAttr = document.documentElement.removeAttribute.bind(document.documentElement)
    const removeSpy = vi
      .spyOn(document.documentElement, 'removeAttribute')
      .mockImplementation((name: string) => {
        if (name === 'data-transition-type' || name === 'data-profile-phase') {
          callOrder.push(`remove:${name}`)
        }
        return origRemoveAttr(name)
      })

    const skipTransition = vi.fn(() => {
      callOrder.push('skipTransition')
      expect(document.documentElement.getAttribute('data-transition-type')).toBe('user-profile')
      expect(document.documentElement.getAttribute('data-profile-phase')).toBe('close')
    })

    docAny.startViewTransition = vi.fn((cb: () => Promise<void> | void) => {
      void Promise.resolve(cb())
      return {
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
        finished: new Promise<void>(() => {}), // simulate stalled vt.finished
        skipTransition
      }
    })

    vi.useFakeTimers()
    const wrapper = track(mount(RenameModal, {
      props: {
        visible: true,
        'onUpdate:visible': (val: boolean) => {
          void wrapper.setProps({ visible: val })
        }
      }
    }))

    try {
      await wrapper.find('button.btn-secondary').trigger('click')
      await flushPromises()

      expect(skipTransition).not.toHaveBeenCalled()
      expect(document.documentElement.dataset.profilePhase).toBe('close')

      await vi.advanceTimersByTimeAsync(1000)
      await flushPromises()

      expect(skipTransition).toHaveBeenCalledTimes(1)
      expect(callOrder[0]).toBe('skipTransition')
      expect(callOrder).toContain('remove:data-transition-type')
      expect(callOrder).toContain('remove:data-profile-phase')
      expect(document.documentElement.getAttribute('data-transition-type')).toBeNull()
      expect(document.documentElement.getAttribute('data-profile-phase')).toBeNull()
    } finally {
      vi.useRealTimers()
      removeSpy.mockRestore()
      wrapper.unmount()
    }
  })
})
