import { ref } from 'vue'
import { ENABLE_DIAGNOSTICS } from '@/config/features'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  id: number
  time: string
  isoTime: string
  level: LogLevel
  tag: string
  message: string
  details?: any
  data?: any
}

const MAX_LOG_ENTRIES = 300
let logCounter = 0

export const diagnosticLogs = ref<LogEntry[]>([])

function formatTime(d: Date): string {
  const pad = (n: number, z = 2) => String(n).padStart(z, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

function safeClone(obj: any): any {
  if (obj === undefined || obj === null) return undefined
  if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') return obj
  if (obj instanceof Error) {
    return {
      name: obj.name,
      message: obj.message,
      stack: obj.stack
    }
  }
  try {
    const seen = new WeakSet()
    return JSON.parse(
      JSON.stringify(obj, (_key, value) => {
        if (typeof value === 'function') return '[Function]'
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[Circular]'
          seen.add(value)
        }
        if (value instanceof Uint8Array) return `[Uint8Array (${value.length} bytes)]`
        if (value instanceof ArrayBuffer) return `[ArrayBuffer (${value.byteLength} bytes)]`
        if (typeof CryptoKey !== 'undefined' && value instanceof CryptoKey) {
          return `[CryptoKey ${value.type} ${value.algorithm.name}]`
        }
        if (typeof RTCPeerConnection !== 'undefined' && value instanceof RTCPeerConnection) {
          return `[RTCPeerConnection ${value.connectionState}]`
        }
        if (typeof RTCDataChannel !== 'undefined' && value instanceof RTCDataChannel) {
          return `[RTCDataChannel ${value.label} ${value.readyState}]`
        }
        return value
      })
    )
  } catch {
    return String(obj)
  }
}

export function addLogEntry(level: LogLevel, tag: string, message: string, details?: any): LogEntry {
  const now = new Date()
  let entry: LogEntry = {
    id: ++logCounter,
    time: formatTime(now),
    isoTime: now.toISOString(),
    level,
    tag,
    message
  }

  if (ENABLE_DIAGNOSTICS) {
    const cloned = safeClone(details)
    entry.details = cloned
    entry.data = cloned

    diagnosticLogs.value.push(entry)
    if (diagnosticLogs.value.length > MAX_LOG_ENTRIES) {
      diagnosticLogs.value.splice(0, diagnosticLogs.value.length - MAX_LOG_ENTRIES)
    }
  }

  // Console output formatting with colors (DevTools in browser) or clean output (Node / Tests)
  const isTest = typeof process !== 'undefined' && process.env?.NODE_ENV === 'test'
  if (isTest) {
    const text = `[${tag}] ${message}`
    if (level === 'error') {
      if (details !== undefined) console.error(text, details)
      else console.error(text)
    } else if (level === 'warn') {
      if (details !== undefined) console.warn(text, details)
      else console.warn(text)
    } else if (level === 'debug') {
      if (details !== undefined) console.debug(text, details)
      else console.debug(text)
    } else {
      if (details !== undefined) console.log(text, details)
      else console.log(text)
    }
  } else {
    const timeStyle = 'color: #94a3b8; font-family: monospace;'
    const tagColor = tag.includes('Signaling')
      ? '#38bdf8'
      : tag.includes('Host')
      ? '#a855f7'
      : tag.includes('Client')
      ? '#34d399'
      : tag.includes('SAS')
      ? '#f59e0b'
      : tag.includes('Data')
      ? '#60a5fa'
      : tag.includes('SelfHealing')
      ? '#10b981'
      : '#f43f5e'
    const tagStyle = `color: ${tagColor}; font-weight: bold; font-family: monospace;`

    const prefix = `%c[${entry.time}]%c [${tag}] ${message}`
    if (level === 'error') {
      if (details !== undefined) {
        console.error(prefix, timeStyle, tagStyle, details)
      } else {
        console.error(prefix, timeStyle, tagStyle)
      }
    } else if (level === 'warn') {
      if (details !== undefined) {
        console.warn(prefix, timeStyle, tagStyle, details)
      } else {
        console.warn(prefix, timeStyle, tagStyle)
      }
    } else if (level === 'debug') {
      if (details !== undefined) {
        console.debug(prefix, timeStyle, tagStyle, details)
      } else {
        console.debug(prefix, timeStyle, tagStyle)
      }
    } else {
      if (details !== undefined) {
        console.log(prefix, timeStyle, tagStyle, details)
      } else {
        console.log(prefix, timeStyle, tagStyle)
      }
    }
  }

  return entry
}

export function clearDiagnosticLogs(): void {
  diagnosticLogs.value = []
}

export function createLogger(tag: string) {
  return {
    debug: (message: string, details?: any) => addLogEntry('debug', tag, message, details),
    info: (message: string, details?: any) => addLogEntry('info', tag, message, details),
    warn: (message: string, details?: any) => addLogEntry('warn', tag, message, details),
    error: (message: string, details?: any) => addLogEntry('error', tag, message, details)
  }
}

export function exportDiagnosticReport(extraContext?: Record<string, any>): string {
  const lines: string[] = [
    '=== ScoutingPro27 Diagnostics Report ===',
    `Timestamp: ${new Date().toISOString()}`,
    `User-Agent: ${typeof navigator !== 'undefined' ? navigator.userAgent : 'Node/Unknown'}`,
    `Online Status: ${typeof navigator !== 'undefined' ? (navigator.onLine ? 'ONLINE' : 'OFFLINE') : 'Unknown'}`
  ]

  if (extraContext && Object.keys(extraContext).length > 0) {
    lines.push('--- Connection & System Context ---')
    for (const [k, v] of Object.entries(extraContext)) {
      lines.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    }
  }

  lines.push('--- Diagnostic Log History (Latest ' + diagnosticLogs.value.length + ' entries) ---')
  for (const log of diagnosticLogs.value) {
    let line = `[${log.time}] [${log.level.toUpperCase()}] [${log.tag}] ${log.message}`
    if (log.details !== undefined) {
      line += ` | Details: ${typeof log.details === 'object' ? JSON.stringify(log.details) : String(log.details)}`
    }
    lines.push(line)
  }

  lines.push('=== End of Diagnostics Report ===')
  return lines.join('\n')
}
