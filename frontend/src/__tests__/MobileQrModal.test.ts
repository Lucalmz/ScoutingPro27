import { mount } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import MobileQrModal from '@/components/common/MobileQrModal.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key
  }),
  createI18n: () => ({
    global: {
      t: (key: string) => key
    }
  })
}))

vi.mock('qrcode', () => ({
  default: {
    toCanvas: vi.fn().mockResolvedValue(true)
  }
}))

describe('MobileQrModal.vue', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    vi.clearAllMocks()

    // Mock clipboard
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: vi.fn().mockResolvedValue(undefined)
      },
      writable: true,
      configurable: true
    })
  })

  it('renders streamlined modal with invite code and QR canvas, without LAN/firewall cards', async () => {
    const wrapper = mount(MobileQrModal, {
      props: {
        modelValue: true,
        inviteCode: 'TEST12'
      }
    })

    await wrapper.vm.$nextTick()
    await new Promise((r) => setTimeout(r, 20))

    const dialog = document.body.querySelector('.qr-modal-dialog')
    expect(dialog).toBeTruthy()

    // Invite code badge is rendered
    const codeValue = document.body.querySelector('.code-value')
    expect(codeValue?.textContent).toBe('TEST12')

    // QR canvas container is rendered
    const canvasContainer = document.body.querySelector('.qr-canvas-container')
    expect(canvasContainer).toBeTruthy()

    // URL input is rendered and contains join link
    const urlInput = document.body.querySelector('.url-input') as HTMLInputElement
    expect(urlInput).toBeTruthy()
    expect(urlInput.value).toContain('https://lucalmz.github.io/ScoutingPro27/#/?join=TEST12')

    // Verify LAN mode tabs, firewall cards, and 502 diagnostics are completely removed
    expect(document.body.querySelector('.mode-tab-btn')).toBeNull()
    expect(document.body.querySelector('.firewall-helper-card')).toBeNull()
    expect(document.body.querySelector('.troubleshoot-502-card')).toBeNull()
    expect(document.body.querySelector('.macos-troubleshoot-card')).toBeNull()
  })

  it('copies invite code when clicking the code badge bar', async () => {
    const wrapper = mount(MobileQrModal, {
      props: {
        modelValue: true,
        inviteCode: 'JOIN99'
      }
    })

    await wrapper.vm.$nextTick()
    await new Promise((r) => setTimeout(r, 20))

    const codeBadge = document.body.querySelector('.code-badge-bar') as HTMLElement
    expect(codeBadge).toBeTruthy()
    codeBadge.click()

    await wrapper.vm.$nextTick()
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('JOIN99')
  })

  it('copies join URL when clicking the copy link button', async () => {
    const wrapper = mount(MobileQrModal, {
      props: {
        modelValue: true,
        inviteCode: 'URL456'
      }
    })

    await wrapper.vm.$nextTick()
    await new Promise((r) => setTimeout(r, 20))

    const copyBtn = document.body.querySelector('.btn-copy') as HTMLButtonElement
    expect(copyBtn).toBeTruthy()
    copyBtn.click()

    await wrapper.vm.$nextTick()
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('https://lucalmz.github.io/ScoutingPro27/#/?join=URL456')
    )
  })

  it('allows customizing cloud PWA domain', async () => {
    const wrapper = mount(MobileQrModal, {
      props: {
        modelValue: true,
        inviteCode: 'CUST77'
      }
    })

    await wrapper.vm.$nextTick()
    await new Promise((r) => setTimeout(r, 20))

    const editBtn = document.body.querySelector('.btn-edit-cloud-url') as HTMLButtonElement
    expect(editBtn).toBeTruthy()
    editBtn.click()

    await wrapper.vm.$nextTick()
    const cloudInput = document.body.querySelector('.cloud-url-input') as HTMLInputElement
    expect(cloudInput).toBeTruthy()
    cloudInput.value = 'https://custom-team.pages.dev'
    cloudInput.dispatchEvent(new Event('input'))

    const saveBtn = document.body.querySelector('.btn-save-cloud-url') as HTMLButtonElement
    saveBtn.click()

    await wrapper.vm.$nextTick()
    const urlInput = document.body.querySelector('.url-input') as HTMLInputElement
    expect(urlInput.value).toContain('https://custom-team.pages.dev/#/?join=CUST77')
  })

  it('emits update:modelValue false when closing', async () => {
    const wrapper = mount(MobileQrModal, {
      props: {
        modelValue: true,
        inviteCode: 'TEST12'
      }
    })

    await wrapper.vm.$nextTick()
    const closeBtn = document.body.querySelector('.close-btn') as HTMLButtonElement
    expect(closeBtn).toBeTruthy()
    closeBtn.click()

    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false])
  })
})
