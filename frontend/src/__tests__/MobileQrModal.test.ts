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

    // Mock fetch
    global.fetch = vi.fn().mockImplementation(async (url: string, options?: any) => {
      if (url === '/api/system/network-info') {
        return {
          ok: true,
          json: async () => ({
            primaryIp: '192.168.1.100',
            allIps: ['192.168.1.100'],
            primaryIpv6: '2409:8a00:1852:6040:66d6:9aff:fecf:fe9',
            allIpv6s: ['2409:8a00:1852:6040:66d6:9aff:fecf:fe9'],
            port: 8080,
            firewallCommand: 'netsh advfirewall firewall add rule name="ScoutingPro27 Inbound (8080)" dir=in action=allow protocol=TCP localport=8080 profile=any'
          })
        } as Response
      }
      if (url === '/api/system/open-firewall-cmd') {
        return {
          ok: true,
          json: async () => ({
            success: true,
            command: 'netsh advfirewall firewall add rule ...',
            port: 8080,
            os: 'windows'
          })
        } as Response
      }
      return { ok: false } as Response
    })
  })

  it('renders modal when modelValue is true and switches to ipv6 mode', async () => {
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

    // Switch to IPv6 mode
    const modeBtns = document.body.querySelectorAll('.mode-tab-btn')
    expect(modeBtns.length).toBe(2)
    ;(modeBtns[1] as HTMLButtonElement).click()

    await wrapper.vm.$nextTick()
    await new Promise((r) => setTimeout(r, 20))

    // Firewall helper card must be visible
    const fwCard = document.body.querySelector('.firewall-helper-card')
    expect(fwCard).toBeTruthy()
    expect(fwCard?.textContent).toContain('netsh advfirewall firewall add rule')

    // Click run CMD button
    const runBtn = fwCard?.querySelector('.btn-run-cmd') as HTMLButtonElement
    expect(runBtn).toBeTruthy()
    runBtn.click()

    await wrapper.vm.$nextTick()
    await new Promise((r) => setTimeout(r, 20))

    expect(global.fetch).toHaveBeenCalledWith('/api/system/open-firewall-cmd', { method: 'POST' })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('netsh advfirewall firewall add rule')
    )

    // Click copy command button
    const copyCmdBtn = fwCard?.querySelector('.btn-copy-cmd') as HTMLButtonElement
    expect(copyCmdBtn).toBeTruthy()
    copyCmdBtn.click()

    expect(navigator.clipboard.writeText).toHaveBeenCalled()
  })

  it('renders fw-allowed badge when firewall is already allowed', async () => {
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url === '/api/system/network-info') {
        return {
          ok: true,
          json: async () => ({
            primaryIp: '192.168.1.100',
            allIps: ['192.168.1.100'],
            primaryIpv6: '2409:8a00:1852:6040:66d6:9aff:fecf:fe9',
            allIpv6s: ['2409:8a00:1852:6040:66d6:9aff:fecf:fe9'],
            port: 8080,
            firewallAllowed: true,
            firewallCommand: 'netsh advfirewall firewall add rule ...'
          })
        } as Response
      }
      return { ok: false } as Response
    })

    const wrapper = mount(MobileQrModal, {
      props: {
        modelValue: true,
        inviteCode: 'TEST99'
      }
    })

    await wrapper.vm.$nextTick()
    await new Promise((r) => setTimeout(r, 20))

    const modeBtns = document.body.querySelectorAll('.mode-tab-btn')
    ;(modeBtns[1] as HTMLButtonElement).click()
    await wrapper.vm.$nextTick()
    await new Promise((r) => setTimeout(r, 20))

    const allowedBadge = document.body.querySelector('.fw-status-badge.fw-allowed')
    expect(allowedBadge).toBeTruthy()

    const runBtn = document.body.querySelector('.btn-run-cmd') as HTMLButtonElement
    expect(runBtn.disabled).toBe(true)
  })
})
