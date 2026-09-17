import type { ConnectionStatus } from '@/types'
import { probePublicConnectivity } from './connectivity'
import { createLogger } from '@/utils/logger'

const log = createLogger('WebRTC:SelfHealing')

export interface SelfHealingOptions {
  getStatus: () => ConnectionStatus
  reconnectNow: () => Promise<boolean>
  isHealthy?: () => boolean
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

  const handleVisibilityChange = async () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      const status = options.getStatus()
      const healthy = options.isHealthy ? options.isHealthy() : status === 'connected'
      if (!healthy || status === 'long_offline' || status === 'offline' || status === 'unstable') {
        log.info('App became visible and connection is inactive or unhealthy; checking connectivity...')
        const canReach = await probePublicConnectivity(2000)
        if (canReach) {
          log.info('Connectivity probe passed after visibility change, triggering reconnectNow.')
          await options.reconnectNow()
        }
      }
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('online', handleOnline)
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }

  return {
    dispose: () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleOnline)
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange)
      }
    }
  }
}
