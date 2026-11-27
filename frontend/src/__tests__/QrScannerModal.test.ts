import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../i18n'
import QrScannerModal from '../components/common/QrScannerModal.vue'
import jsQR from 'jsqr'

vi.mock('jsqr', () => ({
  default: vi.fn()
}))

vi.mock('@/utils/haptics', () => ({
  hapticSuccess: vi.fn(),
  hapticWarning: vi.fn(),
  hapticLight: vi.fn()
}))

describe('QrScannerModal.vue', () => {
  const wrappers: VueWrapper<any>[] = []
  const origMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
  const origImage = globalThis.Image
  const origCreateObjectUrl = URL.createObjectURL
  const origRevokeObjectUrl = URL.revokeObjectURL

  const track = <T extends VueWrapper<any>>(w: T): T => {
    wrappers.push(w)
    return w
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStorage.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    while (wrappers.length) wrappers.pop()!.unmount()
    if (origMediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', origMediaDevices)
    } else {
      delete (navigator as any).mediaDevices
    }
    globalThis.Image = origImage
    URL.createObjectURL = origCreateObjectUrl
    URL.revokeObjectURL = origRevokeObjectUrl
    document.body.innerHTML = ''
    sessionStorage.clear()
  })

  it('shows unsupported error when navigator.mediaDevices is absent', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: undefined,
      configurable: true
    })

    const w = track(
      mount(QrScannerModal, {
        props: { modelValue: true },
        global: { plugins: [i18n] }
      })
    )
    await flushPromises()
    const dialog = document.body.querySelector('.scanner-modal-dialog')
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain(i18n.global.t('qr_scanner.camera_not_supported'))
  })

  it('extracts invite code + broker from uploaded QR image and emits scan + closes', async () => {
    const stopSpy = vi.fn()
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getVideoTracks: () => [{ stop: stopSpy, getCapabilities: () => ({ torch: true }) }],
          getTracks: () => [{ stop: stopSpy }]
        })
      },
      configurable: true
    })

    URL.createObjectURL = vi.fn(() => 'blob:qr-img')
    URL.revokeObjectURL = vi.fn()

    globalThis.Image = class MockImage {
      naturalWidth = 100
      naturalHeight = 100
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_v: string) {
        queueMicrotask(() => this.onload?.())
      }
    } as any

    const mockCtx = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4), width: 100, height: 100 }))
    }
    const origCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreateElement(tag)
      if (tag.toLowerCase() === 'canvas') {
        ;(el as any).getContext = vi.fn(() => mockCtx)
      }
      return el
    })

    vi.mocked(jsQR).mockReturnValue({
      data: 'https://host.example.com/#/?join=ab12cd&b=wss://broker.emqx.io:8084/mqtt'
    } as any)

    const w = track(
      mount(QrScannerModal, {
        props: { modelValue: true },
        global: { plugins: [i18n] }
      })
    )
    await flushPromises()

    const fileInput = document.body.querySelector('input[type="file"]') as HTMLInputElement
    expect(fileInput).not.toBeNull()
    const file = new File(['dummy'], 'qr.png', { type: 'image/png' })
    Object.defineProperty(fileInput, 'files', { value: [file] })
    fileInput.dispatchEvent(new Event('change'))

    await flushPromises()
    await new Promise((r) => setTimeout(r, 20))
    await flushPromises()

    expect(w.emitted('scan')?.[0]).toEqual([
      'AB12CD',
      'https://host.example.com/#/?join=ab12cd&b=wss://broker.emqx.io:8084/mqtt'
    ])
    expect(w.emitted('update:modelValue')?.[0]).toEqual([false])
    expect(sessionStorage.getItem('sp27-active-broker')).toBe('wss://broker.emqx.io:8084/mqtt')
    expect(stopSpy).toHaveBeenCalled()
  })
})
