import type { ConnectionStatus } from '@/types'
import { probePublicConnectivity } from './connectivity'
import { createLogger } from '@/utils/logger'

const log = createLogger('WebRTC:SelfHealing')

export interface SelfHealingOptions {
  getStatus: () => ConnectionStatus
  reconnectNow: (forceFreshSignaling?: boolean) => Promise<boolean>
  isHealthy?: () => boolean
  pingPeer?: () => Promise<boolean>
  isConflictActive?: () => boolean
}

export function setupSelfHealing(options: SelfHealingOptions): { dispose: () => void } {
  const handleOnline = async () => {
    if (options.isConflictActive?.()) {
      log.info('Device network came online, but session conflict is active; suppressing reconnect.')
      return
    }
    log.info('Device network came online, probing public connectivity...')
    const canReachPublic = await probePublicConnectivity(2500)
    if (canReachPublic) {
      log.info('Public connectivity confirmed, reconnecting immediately with fresh signaling.')
      await options.reconnectNow(true)
    } else {
      log.warn('Public connectivity probe failed; remaining in offline state.')
    }
  }

  const handleResume = async () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      return
    }
    if (options.isConflictActive?.()) {
      log.info('App resumed, but session conflict is active; suppressing reconnect.')
      return
    }
    const status = options.getStatus()
    log.info(`App resumed (document visible), current status: ${status}`)

    // 1. 若当前状态属于离线、不稳定、降级，或停留在 connecting 状态，
    // 手机息屏休眠后套接字大概率已被操作系统静默冻结，必须立即触发全链路强制信令硬重连
    if (
      status === 'long_offline' ||
      status === 'offline' ||
      status === 'unstable' ||
      status === 'connecting' ||
      status === 'degraded'
    ) {
      log.info(`App resumed with unhealthy/pending status (${status}); performing fresh hard reconnect...`)
      await options.reconnectNow(true)
      return
    }

    // 2. 防御移动端息屏“僵尸连接（Zombie Connection）”
    // 手机息屏切后台唤醒时，底层 TCP/SCTP 套接字常被 OS 静默冻结，但 status 仍停留在 'connected'
    let isAlive = false
    if (options.pingPeer) {
      log.info('App resumed; performing fast active ping probe to eliminate zombie connection...')
      isAlive = await options.pingPeer()
    } else if (options.isHealthy) {
      isAlive = options.isHealthy()
    }

    if (!isAlive) {
      log.warn('Active ping probe failed on resume (zombie connection detected); forcing fresh reconnect.')
      await options.reconnectNow(true)
    } else {
      log.info('Active ping probe succeeded on resume; peer connection is healthy.')
    }
  }

  const networkChangeHandler = () => {
    log.info('Network connection type changed (e.g. Wi-Fi <-> Cellular), triggering self-healing...')
    handleOnline()
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('online', handleOnline)
    window.addEventListener('pageshow', handleResume)
    window.addEventListener('focus', handleResume)
    if ('connection' in navigator && (navigator as any).connection?.addEventListener) {
      try {
        ;(navigator as any).connection.addEventListener('change', networkChangeHandler)
      } catch {}
    }
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleResume)
  }

  return {
    dispose: () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleOnline)
        window.removeEventListener('pageshow', handleResume)
        window.removeEventListener('focus', handleResume)
        if ('connection' in navigator && (navigator as any).connection?.removeEventListener) {
          try {
            ;(navigator as any).connection.removeEventListener('change', networkChangeHandler)
          } catch {}
        }
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleResume)
      }
    }
  }
}
