import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import jsQR from 'jsqr'
import QrScannerModal from '@/components/common/QrScannerModal.vue'

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

vi.mock('jsqr', () => ({
  default: vi.fn()
}))

describe('QrScannerModal.vue', () => {
  let activeWrapper: VueWrapper<any> | null = null
  const origImage = global.Image
  const origMediaDevicesDesc = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
  const origCreateObjectUrlDesc = Object.getOwnPropertyDescriptor(global.URL, 'createObjectURL')
  const origRevokeObjectUrlDesc = Object.getOwnPropertyDescriptor(global.URL, 'revokeObjectURL')

  beforeEach(() => {
    document.body.innerHTML = ''
    sessionStorage.clear()
    setActivePinia(createPinia())
    vi.clearAllMocks()

    // Mock getUserMedia
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getVideoTracks: () => [
            {
              stop: vi.fn(),
              getCapabilities: () => ({ torch: true }),
              applyConstraints: vi.fn().mockResolvedValue(undefined)
            }
          ],
          getTracks: () => [
            {
              stop: vi.fn()
            }
          ]
        })
      },
      writable: true,
      configurable: true
    })
  })

  afterEach(() => {
    activeWrapper?.unmount()
    activeWrapper = null
    global.Image = origImage
    if (origMediaDevicesDesc) {
      Object.defineProperty(navigator, 'mediaDevices', origMediaDevicesDesc)
    } else {
      delete (navigator as any).mediaDevices
    }
    if (origCreateObjectUrlDesc) {
      Object.defineProperty(global.URL, 'createObjectURL', origCreateObjectUrlDesc)
    } else {
      delete (global.URL as any).createObjectURL
    }
    if (origRevokeObjectUrlDesc) {
      Object.defineProperty(global.URL, 'revokeObjectURL', origRevokeObjectUrlDesc)
    } else {
      delete (global.URL as any).revokeObjectURL
    }
    sessionStorage.clear()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('renders modal dialog and header when modelValue is true', async () => {
    activeWrapper = mount(QrScannerModal, {
      props: {
        modelValue: true
      }
    })

    await flushPromises()

    const dialog = document.body.querySelector('.scanner-modal-dialog')
    expect(dialog).not.toBeNull()

    const title = document.body.querySelector('.scanner-title-group h3')
    expect(title?.textContent).toBe('qr_scanner.title')
  })

  it('emits update:modelValue false when close button is clicked', async () => {
    activeWrapper = mount(QrScannerModal, {
      props: {
        modelValue: true
      }
    })

    await flushPromises()

    const closeBtn = document.body.querySelector('.scanner-header .close-btn') as HTMLButtonElement
    expect(closeBtn).not.toBeNull()
    closeBtn.click()

    expect(activeWrapper.emitted('update:modelValue')?.[0]).toEqual([false])
  })

  it('renders album upload button in footer with translated label and hidden file input', async () => {
    activeWrapper = mount(QrScannerModal, {
      props: {
        modelValue: true
      }
    })

    await nextTick()
    const albumBtn = document.body.querySelector('.scanner-footer .btn-upload-album')
    const fileInput = document.body.querySelector('.scanner-footer input[type="file"]') as HTMLInputElement | null
    expect(albumBtn).not.toBeNull()
    expect(albumBtn?.textContent).toContain('qr_scanner.upload_photo')
    expect(fileInput).not.toBeNull()
    expect(fileInput?.getAttribute('accept')).toBe('image/*')
  })

  it('decodes QR from uploaded album image via real QrScannerModal component and extracts inviteCode + broker', async () => {
    if (!global.URL.createObjectURL) {
      global.URL.createObjectURL = vi.fn(() => 'blob:qr-test')
      global.URL.revokeObjectURL = vi.fn()
    } else {
      vi.spyOn(global.URL, 'createObjectURL').mockReturnValue('blob:qr-test')
      vi.spyOn(global.URL, 'revokeObjectURL').mockImplementation(() => {})
    }

    global.Image = class {
      naturalWidth = 200
      naturalHeight = 200
      onload: (() => void) | null = null
      onerror: ((err: any) => void) | null = null
      set src(_val: string) {
        setTimeout(() => this.onload?.(), 0)
      }
    } as any

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({
        data: new Uint8ClampedArray(200 * 200 * 4),
        width: 200,
        height: 200
      }))
    } as any)

    activeWrapper = mount(QrScannerModal, {
      props: { modelValue: true }
    })
    await nextTick()

    const fileInput = document.body.querySelector('.scanner-footer input[type="file"]') as HTMLInputElement
    expect(fileInput).not.toBeNull()

    const triggerUploadWithQr = async (qrPayload: string) => {
      const nextCallCount = vi.mocked(jsQR).mock.calls.length + 1
      const nextEmitCount = (activeWrapper!.emitted('scan')?.length ?? 0) + 1
      vi.mocked(jsQR).mockReturnValueOnce({ data: qrPayload } as any)
      const file = new File(['qr'], 'qr.png', { type: 'image/png' })
      Object.defineProperty(fileInput, 'files', { value: [file], configurable: true })
      fileInput.dispatchEvent(new Event('change'))
      await vi.waitFor(() => {
        expect(vi.mocked(jsQR)).toHaveBeenCalledTimes(nextCallCount)
        expect(activeWrapper!.emitted('scan')?.length).toBe(nextEmitCount)
      }, { timeout: 1000 })
    }

    // 1. Hash URL with ?join=BEAR27&b=emqx
    await triggerUploadWithQr('https://lucalmz.github.io/ScoutingPro27/#/?join=bear27&b=emqx')
    expect(activeWrapper.emitted('scan')?.[0]).toEqual([
      'BEAR27',
      'https://lucalmz.github.io/ScoutingPro27/#/?join=bear27&b=emqx'
    ])
    expect(sessionStorage.getItem('sp27-active-broker')).toBe('emqx')

    // 2. Query URL with ?code=xyz789&broker=fallback
    await triggerUploadWithQr('https://example.com/join?code=xyz789&broker=fallback')
    expect(activeWrapper.emitted('scan')?.[1]).toEqual([
      'XYZ789',
      'https://example.com/join?code=xyz789&broker=fallback'
    ])
    expect(sessionStorage.getItem('sp27-active-broker')).toBe('fallback')

    // 3. Raw 6-char invite code
    await triggerUploadWithQr('  robot1  ')
    expect(activeWrapper.emitted('scan')?.[2]).toEqual(['ROBOT1', '  robot1  '])
  })
})
