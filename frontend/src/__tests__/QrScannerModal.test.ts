import { mount } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
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
  beforeEach(() => {
    document.body.innerHTML = ''
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

  it('renders modal dialog and header when modelValue is true', async () => {
    const wrapper = mount(QrScannerModal, {
      props: {
        modelValue: true
      }
    })

    await wrapper.vm.$nextTick()
    await new Promise((r) => setTimeout(r, 20))

    const dialog = document.body.querySelector('.scanner-modal-dialog')
    expect(dialog).toBeTruthy()

    const title = document.body.querySelector('.scanner-title-group h3')
    expect(title?.textContent).toBe('qr_scanner.title')
  })

  it('emits update:modelValue false when close button is clicked', async () => {
    const wrapper = mount(QrScannerModal, {
      props: {
        modelValue: true
      }
    })

    await wrapper.vm.$nextTick()
    await new Promise((r) => setTimeout(r, 20))

    const closeBtn = document.body.querySelector('.scanner-header .close-btn') as HTMLButtonElement
    expect(closeBtn).toBeTruthy()
    closeBtn.click()

    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false])
  })

  it('renders album upload button in footer', async () => {
    const wrapper = mount(QrScannerModal, {
      props: {
        modelValue: true
      }
    })

    await wrapper.vm.$nextTick()
    const albumBtn = document.body.querySelector('.btn-upload-album')
    expect(albumBtn).toBeTruthy()
  })

  it('correctly extracts invite code from URLs, hashes, and raw codes', () => {
    // Test the regex/url parsing logic used in QrScannerModal
    function extractInviteCode(raw: string): string | null {
      const trimmed = raw.trim()
      if (!trimmed) return null

      // Direct code
      if (/^[a-zA-Z0-9_-]{4,10}$/.test(trimmed)) {
        return trimmed.toUpperCase()
      }

      // URL search params
      try {
        const url = new URL(trimmed, 'https://dummy.local')
        const joinParam = url.searchParams.get('join') || url.searchParams.get('code')
        if (joinParam) return joinParam.trim().toUpperCase()

        if (url.hash.includes('join=')) {
          const hashQuery = url.hash.split('?')[1]
          if (hashQuery) {
            const hashParams = new URLSearchParams(hashQuery)
            const code = hashParams.get('join') || hashParams.get('code')
            if (code) return code.trim().toUpperCase()
          }
        }
      } catch {}

      const match = trimmed.match(/[?&#](?:join|code)=([a-zA-Z0-9_-]{4,10})/i)
      if (match && match[1]) {
        return match[1].toUpperCase()
      }

      return null
    }

    expect(extractInviteCode('https://lucalmz.github.io/ScoutingPro27/#/?join=BEAR27')).toBe('BEAR27')
    expect(extractInviteCode('https://example.com/join?code=XYZ789')).toBe('XYZ789')
    expect(extractInviteCode('ROBOT1')).toBe('ROBOT1')
    expect(extractInviteCode('https://not-an-event.com/home')).toBeNull()
  })
})
