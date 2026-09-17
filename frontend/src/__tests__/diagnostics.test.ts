import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import {
  createLogger,
  diagnosticLogs,
  clearDiagnosticLogs,
  exportDiagnosticReport
} from '../utils/logger'
import { useConnectionStore } from '../stores/connection'
import ConnectionDiagnosticsModal from '../components/common/ConnectionDiagnosticsModal.vue'
import ConnectionStatus from '../components/common/ConnectionStatus.vue'
import MobileStatusPill from '../components/common/MobileStatusPill.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, paramsOrDef?: any) => {
      if (typeof paramsOrDef === 'string') return paramsOrDef
      return key
    }
  }),
  createI18n: () => ({
    global: {
      t: (key: string) => key
    }
  })
}))

describe('Logger & Diagnostic System Unit Tests', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    clearDiagnosticLogs()
    vi.clearAllMocks()
  })

  it('records logs with createLogger across different levels', () => {
    const log = createLogger('TestTag')
    log.info('Info message', { foo: 'bar' })
    log.warn('Warning message')
    log.error('Error message', new Error('test err'))
    log.debug('Debug message')

    expect(diagnosticLogs.value.length).toBe(4)
    expect(diagnosticLogs.value[0].level).toBe('info')
    expect(diagnosticLogs.value[0].tag).toBe('TestTag')
    expect(diagnosticLogs.value[0].message).toBe('Info message')
    expect(diagnosticLogs.value[0].data).toEqual({ foo: 'bar' })

    expect(diagnosticLogs.value[1].level).toBe('warn')
    expect(diagnosticLogs.value[2].level).toBe('error')
    expect(diagnosticLogs.value[3].level).toBe('debug')
  })

  it('caps circular log buffer at MAX_LOG_ENTRIES (300 entries)', () => {
    const log = createLogger('StressTest')
    for (let i = 0; i < 350; i++) {
      log.info(`Message ${i}`)
    }

    expect(diagnosticLogs.value.length).toBe(300)
    // The first 50 entries should have been shifted out
    expect(diagnosticLogs.value[0].message).toBe('Message 50')
    expect(diagnosticLogs.value[299].message).toBe('Message 349')
  })

  it('handles circular references and non-serializable objects gracefully', () => {
    const log = createLogger('SafeCloneTest')
    const circularObj: any = { a: 1 }
    circularObj.self = circularObj

    log.info('Circular test', circularObj)
    expect(diagnosticLogs.value.length).toBe(1)
    expect(diagnosticLogs.value[0].data.self).toBe('[Circular]')
  })

  it('exports structured diagnostic markdown report', () => {
    const log = createLogger('ReportTest')
    log.info('Handshake initialized', { sessionId: 'sess-123' })
    log.warn('Candidate stalled')

    const report = exportDiagnosticReport({
      role: 'Client',
      status: 'connected',
      transport: {
        type: 'lan_p2p',
        localCandidateType: 'host',
        remoteCandidateType: 'host',
        protocol: 'udp',
        localAddress: '192.168.1.100',
        remoteAddress: '192.168.1.101',
        rttMs: 5,
        securityFingerprint: 'TEST-1234'
      }
    })

    expect(report).toContain('ScoutingPro27 Diagnostics Report')
    expect(report).toContain('lan_p2p')
    expect(report).toContain('TEST-1234')
    expect(report).toContain('Handshake initialized')
    expect(report).toContain('Candidate stalled')
  })
})

describe('ConnectionDiagnosticsModal.vue Component Tests', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    clearDiagnosticLogs()
    vi.clearAllMocks()
  })

  it('renders modal content when isDiagnosticsModalOpen is true', async () => {
    const connStore = useConnectionStore()
    connStore.openDiagnosticsModal()

    const log = createLogger('WebRTC:Peer')
    log.info('PeerConnection created')
    log.warn('ICE connection disconnected')

    const wrapper = mount(ConnectionDiagnosticsModal, {
      global: {
        stubs: {
          Teleport: true,
          Transition: false
        }
      }
    })

    expect(wrapper.find('.diag-card').exists()).toBe(true)
    const logRows = wrapper.findAll('.log-row')
    expect(logRows.length).toBe(2)
  })

  it('filters logs by level', async () => {
    const connStore = useConnectionStore()
    connStore.openDiagnosticsModal()

    const log = createLogger('WebRTC:Signaling')
    log.info('Signaling connected')
    log.error('Authentication HMAC failed')
    log.warn('Stall detected')

    const wrapper = mount(ConnectionDiagnosticsModal, {
      global: {
        stubs: {
          Teleport: true,
          Transition: false
        }
      }
    })

    expect(wrapper.findAll('.log-row').length).toBe(3)

    // Click ERROR filter
    const errorBtn = wrapper.find('.level-error')
    await errorBtn.trigger('click')

    const filteredRows = wrapper.findAll('.log-row')
    expect(filteredRows.length).toBe(1)
    expect(filteredRows[0].text()).toContain('Authentication HMAC failed')
  })

  it('clears logs when clear button is clicked', async () => {
    const connStore = useConnectionStore()
    connStore.openDiagnosticsModal()

    const log = createLogger('WebRTC:Host')
    log.info('Client joined')

    const wrapper = mount(ConnectionDiagnosticsModal, {
      global: {
        stubs: {
          Teleport: true,
          Transition: false
        }
      }
    })

    expect(diagnosticLogs.value.length).toBe(1)
    const clearBtn = wrapper.find('.btn-clear')
    await clearBtn.trigger('click')

    expect(diagnosticLogs.value.length).toBe(0)
    expect(wrapper.find('.empty-logs').exists()).toBe(true)
  })
})

describe('ConnectionStatus.vue & MobileStatusPill.vue Diagnostic Triggers', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('triggers openDiagnosticsModal from ConnectionStatus.vue button', async () => {
    const connStore = useConnectionStore()
    expect(connStore.isDiagnosticsModalOpen).toBe(false)

    const wrapper = mount(ConnectionStatus)
    const diagBtn = wrapper.find('.diagnostics-btn')
    expect(diagBtn.exists()).toBe(true)

    await diagBtn.trigger('click')
    expect(connStore.isDiagnosticsModalOpen).toBe(true)
  })

  it('triggers openDiagnosticsModal from MobileStatusPill.vue HUD button', async () => {
    const connStore = useConnectionStore()
    expect(connStore.isDiagnosticsModalOpen).toBe(false)

    const wrapper = mount(MobileStatusPill, {
      props: {
        eventName: 'Test Event',
        inviteCode: 'TEST12',
        isHost: false
      },
      global: {
        stubs: {
          Teleport: true,
          Transition: false
        }
      }
    })

    // Open HUD
    await wrapper.find('.status-pill').trigger('click')

    // Find diagnostics button in HUD
    const hudDiagBtn = wrapper.find('.btn-hud-diagnostics')
    expect(hudDiagBtn.exists()).toBe(true)

    await hudDiagBtn.trigger('click')
    expect(connStore.isDiagnosticsModalOpen).toBe(true)
  })
})

