import { mount } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach } from 'vitest'
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
    t: (key: string, params?: any) => key,
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
  beforeEach(() => {
    setActivePinia(createPinia())
    mockPush.mockClear()
    mockReplace.mockClear()
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('handles direct form submission for existing user without manual blur', async () => {
    const userStore = useUserStore()
    const loginSpy = vi.spyOn(userStore, 'login').mockResolvedValue(true)
    vi.mocked(api.checkUserExists).mockResolvedValue({ exists: true })

    const wrapper = mount(LoginView)

    const usernameInput = wrapper.find('#username')
    const passwordInput = wrapper.find('#password')

    await usernameInput.setValue('alice')
    await passwordInput.setValue('alicePass123')

    // Submit form directly without triggering blur on username
    await wrapper.find('form').trigger('submit')
    await new Promise((r) => setTimeout(r, 60))

    expect(api.checkUserExists).toHaveBeenCalledWith('alice')
    expect(loginSpy).toHaveBeenCalledWith('alice', 'alicePass123')
    expect(mockPush).toHaveBeenCalledWith('/dashboard')
  })

  it('prompts for confirmPassword when direct submission detects a new user', async () => {
    const userStore = useUserStore()
    const registerSpy = vi.spyOn(userStore, 'register').mockResolvedValue(true)
    vi.mocked(api.checkUserExists).mockResolvedValue({ exists: false })

    const wrapper = mount(LoginView)

    const usernameInput = wrapper.find('#username')
    const passwordInput = wrapper.find('#password')

    await usernameInput.setValue('newbie')
    await passwordInput.setValue('newbiePass123')

    // Submit directly without confirmPassword
    await wrapper.find('form').trigger('submit')
    await new Promise((r) => setTimeout(r, 60))

    expect(api.checkUserExists).toHaveBeenCalledWith('newbie')
    // Should NOT have registered yet because confirmPassword was not entered
    expect(registerSpy).not.toHaveBeenCalled()
    expect(wrapper.find('#confirmPassword').exists()).toBe(true)

    // Now enter matching confirm password and submit
    await wrapper.find('#confirmPassword').setValue('newbiePass123')
    await wrapper.find('form').trigger('submit')
    await new Promise((r) => setTimeout(r, 60))

    expect(registerSpy).toHaveBeenCalledWith('newbie', 'newbiePass123')
    expect(mockPush).toHaveBeenCalledWith('/dashboard')
  })

  it('shows error toast when new user password and confirmPassword mismatch', async () => {
    const userStore = useUserStore()
    const registerSpy = vi.spyOn(userStore, 'register').mockResolvedValue(true)
    vi.mocked(api.checkUserExists).mockResolvedValue({ exists: false })

    const toastStore = useToastStore()
    const toastErrorSpy = vi.spyOn(toastStore, 'showError')

    const wrapper = mount(LoginView)

    await wrapper.find('#username').setValue('bob')
    await wrapper.find('#username').trigger('blur')
    await new Promise((r) => setTimeout(r, 20))

    expect(wrapper.find('#confirmPassword').exists()).toBe(true)
    await wrapper.find('#password').setValue('password123')
    await wrapper.find('#confirmPassword').setValue('password456')

    await wrapper.find('form').trigger('submit')
    await new Promise((r) => setTimeout(r, 20))

    expect(toastErrorSpy).toHaveBeenCalledWith('login.password_mismatch')
    expect(registerSpy).not.toHaveBeenCalled()
  })

  it('resets isNewUser state when username is changed', async () => {
    vi.mocked(api.checkUserExists).mockResolvedValue({ exists: false })
    const wrapper = mount(LoginView)

    await wrapper.find('#username').setValue('first_user')
    await wrapper.find('#username').trigger('blur')
    await new Promise((r) => setTimeout(r, 20))
    expect(wrapper.find('#confirmPassword').exists()).toBe(true)

    // Change username -> should reset isNewUser so confirmPassword collapses
    await wrapper.find('#username').setValue('second_user')
    await new Promise((r) => setTimeout(r, 20))
    expect(wrapper.find('#confirmPassword').exists()).toBe(false)
  })
})
