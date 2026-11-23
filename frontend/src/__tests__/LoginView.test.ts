import { mount, flushPromises, VueWrapper } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import LoginView from '../views/LoginView.vue'
import { useUserStore } from '../stores/user'
import { useToastStore } from '../stores/toast'
import * as api from '../services/api'

const mockPush = vi.fn()
const mockReplace = vi.fn()

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace
  }),
  useRoute: () => ({
    query: {}
  })
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: { value: 'en' }
  })
}))

vi.mock('@/i18n', () => ({
  switchLanguage: vi.fn(),
  i18n: {
    global: {
      t: (key: string) => key
    }
  }
}))

vi.mock('../services/api', () => ({
  checkUserExists: vi.fn()
}))

describe('LoginView.vue', () => {
  const wrappers: VueWrapper[] = []
  const track = (w: VueWrapper) => {
    wrappers.push(w)
    return w
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    mockPush.mockClear()
    mockReplace.mockClear()
    vi.clearAllMocks()
    localStorage.clear()
  })

  afterEach(() => {
    while (wrappers.length > 0) {
      wrappers.pop()!.unmount()
    }
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('handles direct form submission for existing user without manual blur', async () => {
    const userStore = useUserStore()
    const loginSpy = vi.spyOn(userStore, 'login').mockResolvedValue(true)
    vi.mocked(api.checkUserExists).mockResolvedValue({ exists: true })

    const wrapper = track(mount(LoginView))

    await wrapper.find('#username').setValue('alice')
    await wrapper.find('#password').setValue('alicePass123')

    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(api.checkUserExists).toHaveBeenCalledWith('alice')
    expect(loginSpy).toHaveBeenCalledWith('alice', 'alicePass123')
    expect(mockPush).toHaveBeenCalledWith('/dashboard')
  })

  it('prompts for confirmPassword when direct submission detects a new user', async () => {
    const userStore = useUserStore()
    const registerSpy = vi.spyOn(userStore, 'register').mockResolvedValue(true)
    vi.mocked(api.checkUserExists).mockResolvedValue({ exists: false })

    const wrapper = track(mount(LoginView))

    await wrapper.find('#username').setValue('newbie')
    await wrapper.find('#password').setValue('newbiePass123')

    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(api.checkUserExists).toHaveBeenCalledWith('newbie')
    expect(registerSpy).not.toHaveBeenCalled()
    expect(wrapper.find('#confirmPassword').exists()).toBe(true)

    await wrapper.find('#confirmPassword').setValue('newbiePass123')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(registerSpy).toHaveBeenCalledWith('newbie', 'newbiePass123')
    expect(mockPush).toHaveBeenCalledWith('/dashboard')
  })

  it('shows error toast when new user password and confirmPassword mismatch', async () => {
    const userStore = useUserStore()
    const registerSpy = vi.spyOn(userStore, 'register').mockResolvedValue(true)
    vi.mocked(api.checkUserExists).mockResolvedValue({ exists: false })

    const toastStore = useToastStore()
    const toastErrorSpy = vi.spyOn(toastStore, 'showError')

    const wrapper = track(mount(LoginView))

    await wrapper.find('#username').setValue('bob')
    await wrapper.find('#username').trigger('blur')
    await flushPromises()

    expect(wrapper.find('#confirmPassword').exists()).toBe(true)
    await wrapper.find('#password').setValue('password123')
    await wrapper.find('#confirmPassword').setValue('password456')

    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(toastErrorSpy).toHaveBeenCalledWith('login.password_mismatch')
    expect(registerSpy).not.toHaveBeenCalled()
  })

  it('resets isNewUser state when username is changed', async () => {
    vi.mocked(api.checkUserExists).mockResolvedValue({ exists: false })
    const wrapper = track(mount(LoginView))

    await wrapper.find('#username').setValue('first_user')
    await wrapper.find('#username').trigger('blur')
    await flushPromises()
    expect(wrapper.find('#confirmPassword').exists()).toBe(true)

    await wrapper.find('#username').setValue('second_user')
    await flushPromises()
    expect(wrapper.find('#confirmPassword').exists()).toBe(false)
  })

  it('does NOT render scan QR button on desktop host', async () => {
    const { ref } = await import('vue')
    const photoStorage = await import('@/services/photoStorage')
    const isMobileComposable = await import('@/composables/useIsMobile')
    vi.spyOn(photoStorage, 'isDesktopHost').mockReturnValue(true)
    vi.spyOn(isMobileComposable, 'useIsMobile').mockReturnValue({ isMobile: ref(true) } as any)

    const wrapper = track(mount(LoginView))
    expect(wrapper.find('#username').exists()).toBe(true)
    expect(wrapper.find('button[type="submit"]').exists()).toBe(true)
    expect(wrapper.find('.btn-scan-login').exists()).toBe(false)
  })

  it('renders scan QR button on mobile client', async () => {
    const { ref } = await import('vue')
    const photoStorage = await import('@/services/photoStorage')
    vi.spyOn(photoStorage, 'isDesktopHost').mockReturnValue(false)
    const isMobileComposable = await import('@/composables/useIsMobile')
    vi.spyOn(isMobileComposable, 'useIsMobile').mockReturnValue({ isMobile: ref(true) } as any)

    const wrapper = track(mount(LoginView))
    expect(wrapper.find('.btn-scan-login').exists()).toBe(true)
  })
})
