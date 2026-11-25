import { isDesktopHost } from '@/services/photoStorage'

export const PWA_SW_URL = './sw.js'
export const PWA_RELOAD_GUARD_KEY = 'sp27_sw_reloaded_at'
export const PWA_UPDATE_COOLDOWN_MS = 30_000
export const PWA_PERIODIC_CHECK_MS = 10 * 60_000
export const PWA_RELOAD_GUARD_MS = 5_000

export interface PwaUpdaterOptions {
  swUrl?: string
  isDesktop?: () => boolean
  serviceWorker?: Pick<
    ServiceWorkerContainer,
    'controller' | 'register' | 'addEventListener' | 'removeEventListener'
  >
  win?: Pick<Window, 'addEventListener' | 'removeEventListener' | 'setInterval' | 'clearInterval'>
  doc?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
  isOnline?: () => boolean
  reload?: () => void
  now?: () => number
  updateCooldownMs?: number
  periodicIntervalMs?: number
  reloadGuardMs?: number
}

export interface PwaUpdaterHandle {
  registrationPromise: Promise<ServiceWorkerRegistration | null>
  checkForUpdate: (force?: boolean) => Promise<void>
  dispose: () => void
}

function readReloadTimestamp(storage: Pick<Storage, 'getItem'> | null): number | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(PWA_RELOAD_GUARD_KEY)
    if (!raw) return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeReloadTimestamp(storage: Pick<Storage, 'setItem'> | null, timestamp: number): void {
  if (!storage) return
  try {
    storage.setItem(PWA_RELOAD_GUARD_KEY, String(timestamp))
  } catch {
    // Ignore storage quota or private-mode errors
  }
}

/**
 * Registers the PWA Service Worker on non-desktop hosts with HTTP-cache bypass,
 * foreground/online update probing, and safe reload when a new SW takes control.
 */
export function registerPwaServiceWorker(options: PwaUpdaterOptions = {}): PwaUpdaterHandle | null {
  const isDesktop = options.isDesktop ?? isDesktopHost
  if (isDesktop()) return null

  const win = options.win ?? (typeof window !== 'undefined' ? window : undefined)
  const doc = options.doc ?? (typeof document !== 'undefined' ? document : undefined)
  const serviceWorker =
    options.serviceWorker ??
    (typeof navigator !== 'undefined' && 'serviceWorker' in navigator
      ? navigator.serviceWorker
      : undefined)

  if (!win || !doc || !serviceWorker) return null

  const swUrl = options.swUrl ?? PWA_SW_URL
  const storage =
    options.storage !== undefined
      ? options.storage
      : typeof sessionStorage !== 'undefined'
        ? sessionStorage
        : null
  const isOnline =
    options.isOnline ?? (() => (typeof navigator !== 'undefined' ? navigator.onLine !== false : true))
  const reload = options.reload ?? (() => window.location.reload())
  const now = options.now ?? (() => Date.now())
  const updateCooldownMs = options.updateCooldownMs ?? PWA_UPDATE_COOLDOWN_MS
  const periodicIntervalMs = options.periodicIntervalMs ?? PWA_PERIODIC_CHECK_MS
  const reloadGuardMs = options.reloadGuardMs ?? PWA_RELOAD_GUARD_MS

  let currentController: ServiceWorker | null = serviceWorker.controller ?? null
  let refreshing = false
  let disposed = false
  let activeRegistration: ServiceWorkerRegistration | null = null
  let lastCheckAt = now()

  const onControllerChange = () => {
    const hadPreviousController = currentController !== null
    currentController = serviceWorker.controller ?? null
    if (!hadPreviousController || refreshing || disposed) return

    const currentTime = now()
    const lastReloadAt = readReloadTimestamp(storage)
    if (lastReloadAt !== null && currentTime - lastReloadAt >= 0 && currentTime - lastReloadAt < reloadGuardMs) {
      return
    }

    refreshing = true
    writeReloadTimestamp(storage, currentTime)
    reload()
  }

  serviceWorker.addEventListener('controllerchange', onControllerChange)

  const checkForUpdate = async (force = false): Promise<void> => {
    if (disposed || !activeRegistration || !isOnline()) return
    const currentTime = now()
    if (!force && currentTime - lastCheckAt < updateCooldownMs) return
    lastCheckAt = currentTime
    try {
      await activeRegistration.update()
    } catch {
      // Offline or transient CDN error: keep existing cached SW running
    }
  }

  const onVisibilityChange = () => {
    if (doc.visibilityState === 'visible') {
      void checkForUpdate()
    }
  }

  const onPageShow = (event: Event) => {
    if ((event as PageTransitionEvent).persisted) {
      void checkForUpdate()
    }
  }

  const onOnline = () => {
    void checkForUpdate()
  }

  doc.addEventListener('visibilitychange', onVisibilityChange)
  win.addEventListener('pageshow', onPageShow)
  win.addEventListener('online', onOnline)

  const intervalId =
    periodicIntervalMs > 0
      ? win.setInterval(() => {
          if (doc.visibilityState === 'visible') {
            void checkForUpdate()
          }
        }, periodicIntervalMs)
      : null

  const registrationPromise = serviceWorker
    .register(swUrl, { updateViaCache: 'none' })
    .then((registration) => {
      if (disposed) return null
      activeRegistration = registration
      lastCheckAt = now()
      if (registration.waiting && currentController !== null) {
        try {
          registration.waiting.postMessage({ type: 'SKIP_WAITING' })
        } catch {
          // Ignore if waiting worker already transitioned
        }
      }
      return registration
    })
    .catch(() => null)

  const dispose = () => {
    if (disposed) return
    disposed = true
    serviceWorker.removeEventListener('controllerchange', onControllerChange)
    doc.removeEventListener('visibilitychange', onVisibilityChange)
    win.removeEventListener('pageshow', onPageShow)
    win.removeEventListener('online', onOnline)
    if (intervalId !== null) {
      win.clearInterval(intervalId)
    }
  }

  return {
    registrationPromise,
    checkForUpdate,
    dispose
  }
}
