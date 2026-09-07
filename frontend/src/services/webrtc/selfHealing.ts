import type { ConnectionStatus } from '@/types'
import { probePublicConnectivity } from './connectivity'

export interface SelfHealingOptions {
  getStatus: () => ConnectionStatus
  reconnectNow: () => Promise<boolean>
}

export function setupSelfHealing(options: SelfHealingOptions): { dispose: () => void } {
  const handleOnline = async () => {
    console.log('[WebRTC Self-Healing] Device came online, probing public connectivity...')
    const canReachPublic = await probePublicConnectivity(2500)
    if (canReachPublic) {
      console.log('[WebRTC Self-Healing] Public connectivity confirmed, reconnecting immediately.')
      await options.reconnectNow()
    } else {
      console.warn('[WebRTC Self-Healing] Public connectivity probe failed; remaining in offline state.')
    }
  }

  const handleVisibilityChange = async () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      const status = options.getStatus()
      if (status === 'long_offline' || status === 'offline' || status === 'unstable') {
        console.log('[WebRTC Self-Healing] App became visible and connection is inactive; checking connectivity...')
        const canReach = await probePublicConnectivity(2000)
        if (canReach) {
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
