import { onMounted, onUnmounted } from 'vue'
import { createLogger } from './logger'

const log = createLogger('WakeLock')

export class ScreenWakeLockManager {
  private sentinel: any = null
  private isActive = false
  private visibilityHandler: (() => void) | null = null

  async request(): Promise<boolean> {
    this.isActive = true
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) {
      log.info('Screen Wake Lock API is not supported on this platform/browser')
      return false
    }

    try {
      if (document.visibilityState !== 'visible') {
        return false
      }
      this.sentinel = await (navigator as any).wakeLock.request('screen')
      log.info('Screen wake lock acquired successfully')

      this.sentinel.addEventListener('release', () => {
        log.info('Screen wake lock was released by system')
        this.sentinel = null
      })

      if (!this.visibilityHandler && typeof document !== 'undefined') {
        this.visibilityHandler = async () => {
          if (this.isActive && document.visibilityState === 'visible' && !this.sentinel) {
            log.info('Page became visible again, re-requesting wake lock...')
            try {
              this.sentinel = await (navigator as any).wakeLock.request('screen')
            } catch (err) {
              log.warn('Failed to re-acquire wake lock on resume:', err)
            }
          }
        }
        document.addEventListener('visibilitychange', this.visibilityHandler)
      }
      return true
    } catch (err) {
      log.warn('Failed to acquire screen wake lock:', err)
      return false
    }
  }

  async release(): Promise<void> {
    this.isActive = false
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler)
      this.visibilityHandler = null
    }
    if (this.sentinel) {
      try {
        await this.sentinel.release()
        log.info('Screen wake lock released manually')
      } catch (err) {
        log.warn('Error releasing wake lock:', err)
      }
      this.sentinel = null
    }
  }

  isLocked(): boolean {
    return Boolean(this.sentinel && !this.sentinel.released)
  }
}

export const globalWakeLock = new ScreenWakeLockManager()

/**
 * Vue Composable for automatic screen wake lock management during component lifecycle.
 */
export function useScreenWakeLock() {
  const manager = new ScreenWakeLockManager()

  onMounted(async () => {
    await manager.request()
  })

  onUnmounted(async () => {
    await manager.release()
  })

  return {
    manager,
    request: () => manager.request(),
    release: () => manager.release(),
    isLocked: () => manager.isLocked()
  }
}
