import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  addLogEntry,
  clearDiagnosticLogs,
  createLogger,
  diagnosticLogs,
  exportDiagnosticReport
} from '../utils/logger'

describe('logger.ts - Diagnostic Logger & Report Export', () => {
  const origNodeEnv = process.env.NODE_ENV

  beforeEach(() => {
    clearDiagnosticLogs()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'debug').mockImplementation(() => {})
  })

  afterEach(() => {
    process.env.NODE_ENV = origNodeEnv
    clearDiagnosticLogs()
    vi.restoreAllMocks()
  })

  it('logs all levels in test mode and records diagnostic entries only for WebRTC:IceStats when diagnostics disabled', () => {
    const log = createLogger('WebRTC:Signaling')
    const d = log.debug('dbg msg', { a: 1 })
    const i = log.info('info msg')
    const w = log.warn('warn msg', 'detail')
    const e = log.error('err msg', new Error('boom'))

    expect(d.level).toBe('debug')
    expect(i.level).toBe('info')
    expect(w.level).toBe('warn')
    expect(e.level).toBe('error')

    expect(console.debug).toHaveBeenCalledWith('[WebRTC:Signaling] dbg msg', { a: 1 })
    expect(console.log).toHaveBeenCalledWith('[WebRTC:Signaling] info msg')
    expect(console.warn).toHaveBeenCalledWith('[WebRTC:Signaling] warn msg', 'detail')
    expect(console.error).toHaveBeenCalledWith('[WebRTC:Signaling] err msg', expect.any(Error))

    // ENABLE_DIAGNOSTICS is false in production config, so non-IceStats logs stay out of diagnosticLogs
    expect(diagnosticLogs.value).toHaveLength(0)

    const iceLog = createLogger('WebRTC:IceStats')
    const iceErr = iceLog.error('ice failed', new Error('boom'))
    expect(diagnosticLogs.value).toHaveLength(1)
    expect(iceErr.details).toMatchObject({ name: 'Error', message: 'boom' })
  })

  it('safely clones circular objects, functions, and binary buffers without throwing', () => {
    const circular: Record<string, any> = { name: 'node' }
    circular.self = circular
    circular.fn = () => 123
    circular.bytes = new Uint8Array([1, 2, 3])
    circular.buf = new ArrayBuffer(8)

    const entry = addLogEntry('info', 'WebRTC:IceStats', 'complex payload', circular)
    expect(entry.details).toEqual({
      name: 'node',
      self: '[Circular]',
      fn: '[Function]',
      bytes: '[Uint8Array (3 bytes)]',
      buf: '[ArrayBuffer (8 bytes)]'
    })
  })

  it('caps diagnosticLogs at MAX_LOG_ENTRIES (300)', () => {
    for (let i = 0; i < 315; i++) {
      addLogEntry('info', 'WebRTC:IceStats', `msg-${i}`)
    }
    expect(diagnosticLogs.value).toHaveLength(300)
    expect(diagnosticLogs.value[0]?.message).toBe('msg-15')
    expect(diagnosticLogs.value[299]?.message).toBe('msg-314')
  })

  it('formats styled console output in non-test environment across tag colors', () => {
    process.env.NODE_ENV = 'production'
    const tags = ['WebRTC:Signaling', 'WebRTC:Host', 'WebRTC:Client', 'WebRTC:SAS', 'WebRTC:Data', 'WebRTC:SelfHealing', 'Other']
    for (const tag of tags) {
      addLogEntry('info', tag, 'styled', { ok: true })
    }
    addLogEntry('warn', 'WebRTC:Host', 'warn no details')
    addLogEntry('error', 'WebRTC:Client', 'err no details')
    addLogEntry('debug', 'WebRTC:SAS', 'dbg no details')

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('%c['),
      expect.stringContaining('font-family: monospace'),
      expect.stringContaining('font-weight: bold'),
      { ok: true }
    )
    expect(console.warn).toHaveBeenCalled()
    expect(console.error).toHaveBeenCalled()
    expect(console.debug).toHaveBeenCalled()
  })

  it('exports diagnostic report with context and log history', () => {
    addLogEntry('info', 'WebRTC:IceStats', 'session ready', { epoch: 2 })
    addLogEntry('warn', 'WebRTC:IceStats', 'retry')

    const report = exportDiagnosticReport({ inviteCode: 'ABC123', stats: { peers: 3 } })
    expect(report).toContain('=== ScoutingPro27 Diagnostics Report ===')
    expect(report).toContain('inviteCode: ABC123')
    expect(report).toContain('stats: {"peers":3}')
    expect(report).toContain('[INFO] [WebRTC:IceStats] session ready | Details: {"epoch":2}')
    expect(report).toContain('[WARN] [WebRTC:IceStats] retry')
    expect(report).toContain('=== End of Diagnostics Report ===')
  })
})
