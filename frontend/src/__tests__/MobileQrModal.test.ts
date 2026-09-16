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

    // Mode buttons: cloud, lan, ipv6
    const modeBtns = document.body.querySelectorAll('.mode-tab-btn')
    expect(modeBtns.length).toBe(3)
    ;(modeBtns[2] as HTMLButtonElement).click() // switch to IPv6

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

  it('renders fw-allowed badge when firewall is already allowed in ipv6 mode', async () => {
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
    ;(modeBtns[2] as HTMLButtonElement).click()
    await wrapper.vm.$nextTick()
    await new Promise((r) => setTimeout(r, 20))

    const allowedBadge = document.body.querySelector('.fw-status-badge.fw-allowed')
    expect(allowedBadge).toBeTruthy()

    const runBtn = document.body.querySelector('.btn-run-cmd') as HTMLButtonElement
    expect(runBtn.disabled).toBe(true)
  })

  it('renders cloud mode by default with PWA badge and configurable URL', async () => {
    const wrapper = mount(MobileQrModal, {
      props: {
        modelValue: true,
        inviteCode: 'CLOUD88'
      }
    })

    await wrapper.vm.$nextTick()
    await new Promise((r) => setTimeout(r, 20))

    // Cloud status badge should be visible by default
    const cloudBadge = document.body.querySelector('.cloud-status-badge')
    expect(cloudBadge).toBeTruthy()
    expect(cloudBadge?.textContent).toContain('qr_modal.cloud_pwa_badge')

    // Join URL should point to cloud PWA by default
    const urlInput = document.body.querySelector('.url-input') as HTMLInputElement
    expect(urlInput).toBeTruthy()
    expect(urlInput.value).toContain('https://lucalmz.github.io/ScoutingPro27/#/?join=CLOUD88')

    // Open cloud URL editor
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
    expect(urlInput.value).toContain('https://custom-team.pages.dev/#/?join=CLOUD88')
  })

  it('renders 502 troubleshooting card and allows switching to macOS tab', async () => {
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url === '/api/system/network-info') {
        return {
          ok: true,
          json: async () => ({
            primaryIp: '192.168.137.1',
            allIps: ['192.168.137.1', '172.20.10.2'],
            primaryIpv6: null,
            allIpv6s: [],
            port: 8080,
            os: 'windows',
            isWindows: true,
            isMac: false,
            firewallAllowed: false,
            firewallCommand: 'netsh advfirewall firewall add rule ...',
            macFirewallCommand: 'sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate off'
          })
        } as Response
      }
      return { ok: false } as Response
    })

    const wrapper = mount(MobileQrModal, {
      props: {
        modelValue: true,
        inviteCode: 'TEST502'
      }
    })

    await wrapper.vm.$nextTick()
    await new Promise((r) => setTimeout(r, 20))

    // 502 troubleshooting card must be visible
    const card502 = document.body.querySelector('.troubleshoot-502-card')
    expect(card502).toBeTruthy()
    expect(card502?.textContent).toContain('qr_modal.troubleshoot_502_banner_title')

    // Hotspot card must be visible
    const hotspotCard = document.body.querySelector('.hotspot-card')
    expect(hotspotCard).toBeTruthy()

    // Switch to macOS tab
    const osBtns = document.body.querySelectorAll('.os-tab-btn')
    expect(osBtns.length).toBe(2)
    ;(osBtns[1] as HTMLButtonElement).click()

    await wrapper.vm.$nextTick()
    await new Promise((r) => setTimeout(r, 20))

    // macOS troubleshooting card should be visible
    const macCard = document.body.querySelector('.macos-troubleshoot-card')
    expect(macCard).toBeTruthy()
    expect(macCard?.textContent).toContain('qr_modal.macos_local_network_title')

    // macOS command card should be visible and copyable
    const macCmdCard = document.body.querySelector('.macos-cmd-card')
    expect(macCmdCard).toBeTruthy()
    expect(macCmdCard?.textContent).toContain('socketfilterfw')

    const macCopyBtn = macCmdCard?.querySelector('.btn-copy-cmd') as HTMLButtonElement
    expect(macCopyBtn).toBeTruthy()
    macCopyBtn.click()

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('socketfilterfw')
    )
  })

  it('auto-detects macOS when backend returns isMac: true', async () => {
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url === '/api/system/network-info') {
        return {
          ok: true,
          json: async () => ({
            primaryIp: '172.20.10.3',
            allIps: ['172.20.10.3'],
            primaryIpv6: null,
            allIpv6s: [],
            port: 8080,
            os: 'macos',
            isWindows: false,
            isMac: true,
            macFirewallCommand: 'sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate off'
          })
        } as Response
      }
      return { ok: false } as Response
    })

    const wrapper = mount(MobileQrModal, {
      props: {
        modelValue: true,
        inviteCode: 'MAC123'
      }
    })

    await wrapper.vm.$nextTick()
    await new Promise((r) => setTimeout(r, 20))

    // Automatically selects macOS tab
    const macCard = document.body.querySelector('.macos-troubleshoot-card')
    expect(macCard).toBeTruthy()
  })
})
