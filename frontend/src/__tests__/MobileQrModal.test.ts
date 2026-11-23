import { mount, flushPromises, VueWrapper } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

vi.mock('@/services/api', () => ({
  getNetworkInfo: vi.fn().mockResolvedValue(null)
}))

describe('MobileQrModal.vue', () => {
  const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const wrappers: VueWrapper[] = []
  const track = (w: VueWrapper) => {
    wrappers.push(w)
    return w
  }

  beforeEach(() => {
    document.body.innerHTML = ''
    localStorage.clear()
    setActivePinia(createPinia())
    vi.clearAllMocks()

    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: vi.fn().mockResolvedValue(undefined)
      },
      writable: true,
      configurable: true
    })
  })

  afterEach(() => {
    while (wrappers.length > 0) {
      wrappers.pop()!.unmount()
    }
    document.body.innerHTML = ''
    localStorage.clear()
    if (originalClipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor)
    } else {
      delete (navigator as any).clipboard
    }
    vi.restoreAllMocks()
  })

  it('renders streamlined modal with invite code and QR canvas, without LAN/firewall cards', async () => {
    track(mount(MobileQrModal, {
      props: {
        modelValue: true,
        inviteCode: 'TEST12'
      },
      attachTo: document.body
    }))

    await flushPromises()

    const dialog = document.body.querySelector('.qr-modal-dialog')
    expect(dialog).toBeTruthy()

    const codeValue = document.body.querySelector('.code-value')
    expect(codeValue?.textContent).toBe('TEST12')

    const canvasContainer = document.body.querySelector('.qr-canvas-container')
    expect(canvasContainer).not.toBeNull()
    expect(canvasContainer?.querySelector('canvas')).not.toBeNull()

    const urlInput = document.body.querySelector('.url-input') as HTMLInputElement
    expect(urlInput).toBeTruthy()
    expect(urlInput.value).toContain('https://lucalmz.github.io/ScoutingPro27/#/?join=TEST12')

    expect(document.body.querySelector('.mode-tab-btn')).toBeNull()
    expect(document.body.querySelector('.firewall-helper-card')).toBeNull()
    expect(document.body.querySelector('.troubleshoot-502-card')).toBeNull()
    expect(document.body.querySelector('.macos-troubleshoot-card')).toBeNull()
  })

  it('copies invite code when clicking the code badge bar', async () => {
    track(mount(MobileQrModal, {
      props: {
        modelValue: true,
        inviteCode: 'JOIN99'
      },
      attachTo: document.body
    }))

    await flushPromises()

    const codeBadge = document.body.querySelector('.code-badge-bar') as HTMLElement
    expect(codeBadge).toBeTruthy()
    codeBadge.click()

    await flushPromises()
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('JOIN99')
  })

  it('copies join URL when clicking the copy link button', async () => {
    track(mount(MobileQrModal, {
      props: {
        modelValue: true,
        inviteCode: 'URL456'
      },
      attachTo: document.body
    }))

    await flushPromises()

    const copyBtn = document.body.querySelector('.btn-copy') as HTMLButtonElement
    expect(copyBtn).toBeTruthy()
    copyBtn.click()

    await flushPromises()
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('https://lucalmz.github.io/ScoutingPro27/#/?join=URL456')
    )
  })

  it('allows customizing cloud PWA domain', async () => {
    track(mount(MobileQrModal, {
      props: {
        modelValue: true,
        inviteCode: 'CUST77'
      },
      attachTo: document.body
    }))

    await flushPromises()

    const editBtn = document.body.querySelector('.btn-edit-cloud-url') as HTMLButtonElement
    expect(editBtn).toBeTruthy()
    editBtn.click()

    await flushPromises()
    const cloudInput = document.body.querySelector('.cloud-url-input') as HTMLInputElement
    expect(cloudInput).toBeTruthy()
    cloudInput.value = 'https://custom-team.pages.dev'
    cloudInput.dispatchEvent(new Event('input'))

    const saveBtn = document.body.querySelector('.btn-save-cloud-url') as HTMLButtonElement
    saveBtn.click()

    await flushPromises()
    const urlInput = document.body.querySelector('.url-input') as HTMLInputElement
    expect(urlInput.value).toContain('https://custom-team.pages.dev/#/?join=CUST77')
  })

  it('emits update:modelValue false when closing', async () => {
    const wrapper = track(mount(MobileQrModal, {
      props: {
        modelValue: true,
        inviteCode: 'TEST12'
      },
      attachTo: document.body
    }))

    await flushPromises()
    const closeBtn = document.body.querySelector('.close-btn') as HTMLButtonElement
    expect(closeBtn).toBeTruthy()
    closeBtn.click()

    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false])
  })

  it('renders channel pill bar and switches to LAN hotspot mode when networkInfo is available', async () => {
    const { getNetworkInfo } = await import('@/services/api')
    vi.mocked(getNetworkInfo).mockResolvedValueOnce({
      primaryIp: '192.168.137.1',
      allIps: ['192.168.137.1'],
      port: 8080,
      joinBaseUrl: 'http://192.168.137.1:8080'
    })

    track(mount(MobileQrModal, {
      props: {
        modelValue: true,
        inviteCode: 'LAN999'
      },
      attachTo: document.body
    }))

    await flushPromises()

    const pillBar = document.body.querySelector('.channel-pill-bar')
    expect(pillBar).toBeTruthy()

    const pills = document.body.querySelectorAll('.channel-pill-item')
    expect(pills.length).toBe(2)

    ;(pills[1] as HTMLElement).click()
    await flushPromises()

    const urlInput = document.body.querySelector('.url-input') as HTMLInputElement
    expect(urlInput.value).toBe('http://192.168.137.1:8080/#/?join=LAN999&b=lan')
  })
})
