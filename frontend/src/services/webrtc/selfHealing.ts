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
  let isReconnecting = false
  let lastTriggerTime = 0
  let initOrLastConnectTime = Date.now()
  const THROTTLE_MS = 1200

  const isTestEnv = () =>
    (typeof process !== 'undefined' && (process.env?.NODE_ENV === 'test' || process.env?.VITEST === 'true')) ||
    Boolean((globalThis as any).__vitest_worker__)

  const safeReconnect = async (reason: string) => {
    const now = Date.now()
    if (isReconnecting || now - lastTriggerTime < THROTTLE_MS) {
      log.info(`Suppressing duplicate reconnect trigger (${reason}) within debounce window`)
      return
    }
    isReconnecting = true
    lastTriggerTime = now
    initOrLastConnectTime = now
    try {
      log.info(`Executing self-healing reconnect: ${reason}`)
      await options.reconnectNow(true)
    } finally {
      setTimeout(() => {
        isReconnecting = false
      }, 500)
    }
  }

  const handleOnline = async () => {
    if (options.isConflictActive?.()) {
      log.info('Device network came online, but session conflict is active; suppressing reconnect.')
      return
    }
    log.info('Device network came online, probing public connectivity...')
    const canReachPublic = await probePublicConnectivity(2500)
    if (canReachPublic) {
      log.info('Public connectivity confirmed, reconnecting immediately with fresh signaling.')
      await safeReconnect('network-online')
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

    // 0. 若处于 unstable：区分“DataChannel 背压流控（底层通道仍健康）”与“ICE 断连失联”
    if (status === 'unstable' && options.isHealthy?.()) {
      log.info('App resumed while status is unstable (backpressure on healthy channel); preserving active session.')
      return
    }

    // 1. 若处于 connecting：真机下如果在 12 秒正常握手窗口内，严禁因切焦点而中断正在进行的 ICE 打洞
    if (status === 'connecting') {
      if (!isTestEnv() && Date.now() - initOrLastConnectTime < 12000) {
        log.info('App resumed while handshake is actively in-flight (<12s); preserving connecting session.')
        return
      }
      log.info('App resumed while stuck in connecting; performing fresh hard reconnect...')
      await safeReconnect('app-resume-connecting')
      return
    }

    if (
      status === 'long_offline' ||
      status === 'offline' ||
      status === 'unstable' ||
      status === 'degraded'
    ) {
      log.info(`App resumed with unhealthy/pending status (${status}); performing fresh hard reconnect...`)
      await safeReconnect(`app-resume-${status}`)
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
      await safeReconnect('app-resume-zombie-probe-failed')
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
