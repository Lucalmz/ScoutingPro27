import type { ConnectionStatus } from '@/types'
import { probePublicConnectivity } from './connectivity'
import { createLogger } from '@/utils/logger'

const log = createLogger('WebRTC:SelfHealing')

export interface SelfHealingOptions {
  getStatus: () => ConnectionStatus
  reconnectNow: () => Promise<boolean>
  isHealthy?: () => boolean
  pingPeer?: () => Promise<boolean>
}

export function setupSelfHealing(options: SelfHealingOptions): { dispose: () => void } {
  const handleOnline = async () => {
    log.info('Device network came online, probing public connectivity...')
    const canReachPublic = await probePublicConnectivity(2500)
    if (canReachPublic) {
      log.info('Public connectivity confirmed, reconnecting immediately.')
      await options.reconnectNow()
    } else {
      log.warn('Public connectivity probe failed; remaining in offline state.')
    }
  }

  const handleResume = async () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      return
    }
    const status = options.getStatus()

    // 1. 若当前状态本就属于离线或不稳定状态，立即探活并恢复连接
    if (status === 'long_offline' || status === 'offline' || status === 'unstable') {
      log.info('App became visible and connection is inactive or unhealthy; checking connectivity...')
      const canReach = await probePublicConnectivity(2000)
      if (canReach) {
        log.info('Connectivity probe passed after visibility change, triggering reconnectNow.')
        await options.reconnectNow()
      }
      return
    }

    // 2. 防御移动端息屏“僵尸连接（Zombie Connection）”
    // 手机息屏切后台唤醒时，底层 TCP/SCTP 套接字常被 OS 静默冻结，但 status 仍停留在 'connected'
    if (options.pingPeer) {
      log.info('App resumed; performing active ping probe to eliminate zombie connection...')
      const isAlive = await options.pingPeer()
      if (!isAlive) {
        log.warn('Active ping probe failed on resume (zombie connection detected); forcing reconnect.')
        await options.reconnectNow()
        return
      }
      log.info('Active ping probe succeeded on resume; peer connection is healthy.')
    } else if (options.isHealthy && !options.isHealthy()) {
      log.info('App resumed and isHealthy returned false, triggering reconnectNow.')
      await options.reconnectNow()
    }
  }

  const networkChangeHandler = () => {
    log.info('Network connection type changed (e.g. Wi-Fi <-> Cellular), triggering self-healing...')
    handleOnline()
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('online', handleOnline)
    window.addEventListener('pageshow', handleResume)
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
