import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  PWA_RELOAD_GUARD_KEY,
  PWA_RELOAD_GUARD_MS,
  PWA_UPDATE_COOLDOWN_MS,
  registerPwaServiceWorker
} from '@/utils/pwaUpdater'

function createEventHub() {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
  return {
    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
      if (!listener) return
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(listener)
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
      if (!listener) return
      listeners.get(type)?.delete(listener)
    },
    dispatch(type: string, event: Event = new Event(type)) {
      for (const listener of Array.from(listeners.get(type) ?? [])) {
        if (typeof listener === 'function') listener(event)
        else listener.handleEvent(event)
      }
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0
    }
  }
}

function createFakeEnv(initialController: ServiceWorker | null = null) {
  const swHub = createEventHub()
  const winHub = createEventHub()
  const docHub = createEventHub()

  let visibilityState: DocumentVisibilityState = 'visible'
  let online = true
  let currentTime = 1_000_000

  const waitingWorker = { postMessage: vi.fn() } as unknown as ServiceWorker
  const registration = {
    waiting: null as ServiceWorker | null,
    update: vi.fn().mockResolvedValue(undefined)
  } as unknown as ServiceWorkerRegistration

  const serviceWorker = {
    controller: initialController,
    register: vi.fn().mockResolvedValue(registration),
    addEventListener: swHub.addEventListener,
    removeEventListener: swHub.removeEventListener
  }

  const win = {
    addEventListener: winHub.addEventListener,
    removeEventListener: winHub.removeEventListener,
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window)
  }

  const doc = {
    get visibilityState() {
      return visibilityState
    },
    addEventListener: docHub.addEventListener,
    removeEventListener: docHub.removeEventListener
  }

  const store = new Map<string, string>()
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, val: string) => {
      store.set(key, val)
    }
  }

  const reload = vi.fn()

  return {
    swHub,
    winHub,
    docHub,
    serviceWorker,
    registration,
    waitingWorker,
    win,
    doc,
    storage,
    reload,
    setVisibility(state: DocumentVisibilityState) {
      visibilityState = state
    },
    setOnline(next: boolean) {
      online = next
    },
    isOnline: () => online,
    advanceTime(ms: number) {
      currentTime += ms
    },
    now: () => currentTime
  }
}

describe('pwaUpdater', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('skips registration completely on desktop host (JCEF / localhost)', () => {
    const env = createFakeEnv()
    const handle = registerPwaServiceWorker({
      isDesktop: () => true,
      serviceWorker: env.serviceWorker as any,
      win: env.win,
      doc: env.doc,
      reload: env.reload
    })

    expect(handle).toBeNull()
    expect(env.serviceWorker.register).not.toHaveBeenCalled()
  })

  it('registers ./sw.js with updateViaCache="none" on mobile/cloud PWA', async () => {
    const env = createFakeEnv()
    const handle = registerPwaServiceWorker({
      isDesktop: () => false,
      serviceWorker: env.serviceWorker as any,
      win: env.win,
      doc: env.doc,
      storage: env.storage,
      isOnline: env.isOnline,
      reload: env.reload,
      now: env.now
    })

    expect(handle).not.toBeNull()
    await handle!.registrationPromise

    expect(env.serviceWorker.register).toHaveBeenCalledTimes(1)
    expect(env.serviceWorker.register).toHaveBeenCalledWith('./sw.js', { updateViaCache: 'none' })
    handle!.dispose()
  })

  it('does not reload on first-ever SW claim, but reloads on subsequent SW updates', async () => {
    const env = createFakeEnv(null)
    const handle = registerPwaServiceWorker({
      isDesktop: () => false,
      serviceWorker: env.serviceWorker as any,
      win: env.win,
      doc: env.doc,
      storage: env.storage,
      isOnline: env.isOnline,
      reload: env.reload,
      now: env.now
    })
    await handle!.registrationPromise

    // First install: controller transitions null -> swV1 (should NOT reload)
    env.serviceWorker.controller = { scriptURL: './sw.js' } as ServiceWorker
    env.swHub.dispatch('controllerchange')
    expect(env.reload).not.toHaveBeenCalled()

    // Later update in same long-lived session: swV1 -> swV2 (MUST reload)
    env.serviceWorker.controller = { scriptURL: './sw.js' } as ServiceWorker
    env.swHub.dispatch('controllerchange')
    expect(env.reload).toHaveBeenCalledTimes(1)
    expect(env.storage.getItem(PWA_RELOAD_GUARD_KEY)).toBe(String(env.now()))

    handle!.dispose()
  })

  it('reloads when an existing controller is replaced and blocks rapid reload loops via cooldown', async () => {
    const oldSw = { scriptURL: './sw.js' } as ServiceWorker
    const newSw = { scriptURL: './sw.js' } as ServiceWorker
    const env = createFakeEnv(oldSw)

    const handle = registerPwaServiceWorker({
      isDesktop: () => false,
      serviceWorker: env.serviceWorker as any,
      win: env.win,
      doc: env.doc,
      storage: env.storage,
      isOnline: env.isOnline,
      reload: env.reload,
      now: env.now
    })
    await handle!.registrationPromise

    env.serviceWorker.controller = newSw
    env.swHub.dispatch('controllerchange')
    expect(env.reload).toHaveBeenCalledTimes(1)

    // Duplicate controllerchange in same page instance is ignored
    env.swHub.dispatch('controllerchange')
    expect(env.reload).toHaveBeenCalledTimes(1)
    handle!.dispose()

    // Simulated freshly-reloaded page within reloadGuardMs must NOT loop
    env.advanceTime(PWA_RELOAD_GUARD_MS - 100)
    const handle2 = registerPwaServiceWorker({
      isDesktop: () => false,
      serviceWorker: env.serviceWorker as any,
      win: env.win,
      doc: env.doc,
      storage: env.storage,
      isOnline: env.isOnline,
      reload: env.reload,
      now: env.now
    })
    await handle2!.registrationPromise
    env.swHub.dispatch('controllerchange')
    expect(env.reload).toHaveBeenCalledTimes(1)
    handle2!.dispose()

    // Once reloadGuardMs passes, another genuine update CAN reload
    env.advanceTime(200)
    const handle3 = registerPwaServiceWorker({
      isDesktop: () => false,
      serviceWorker: env.serviceWorker as any,
      win: env.win,
      doc: env.doc,
      storage: env.storage,
      isOnline: env.isOnline,
      reload: env.reload,
      now: env.now
    })
    await handle3!.registrationPromise
    env.swHub.dispatch('controllerchange')
    expect(env.reload).toHaveBeenCalledTimes(2)
    handle3!.dispose()
  })

  it('checks for updates on visibilitychange, pageshow(persisted), online, and periodic interval with cooldown & offline guard', async () => {
    const env = createFakeEnv({ scriptURL: './sw.js' } as ServiceWorker)
    const handle = registerPwaServiceWorker({
      isDesktop: () => false,
      serviceWorker: env.serviceWorker as any,
      win: env.win,
      doc: env.doc,
      storage: env.storage,
      isOnline: env.isOnline,
      reload: env.reload,
      now: env.now,
      periodicIntervalMs: 60_000
    })
    await handle!.registrationPromise
    expect(env.registration.update).not.toHaveBeenCalled()

    // Within cooldown: visibilitychange does not spam update()
    env.advanceTime(5_000)
    env.docHub.dispatch('visibilitychange')
    expect(env.registration.update).not.toHaveBeenCalled()

    // After cooldown while visible & online: triggers update()
    env.advanceTime(PWA_UPDATE_COOLDOWN_MS)
    env.docHub.dispatch('visibilitychange')
    expect(env.registration.update).toHaveBeenCalledTimes(1)

    // Hidden or offline: suppressed
    env.advanceTime(PWA_UPDATE_COOLDOWN_MS)
    env.setVisibility('hidden')
    env.docHub.dispatch('visibilitychange')
    env.setVisibility('visible')
    env.setOnline(false)
    env.winHub.dispatch('online')
    expect(env.registration.update).toHaveBeenCalledTimes(1)

    // Coming back online triggers update()
    env.setOnline(true)
    env.winHub.dispatch('online')
    expect(env.registration.update).toHaveBeenCalledTimes(2)

    // bfcache pageshow(persisted=true) after cooldown triggers update()
    env.advanceTime(PWA_UPDATE_COOLDOWN_MS)
    const persistedEvt = Object.assign(new Event('pageshow'), { persisted: true })
    env.winHub.dispatch('pageshow', persistedEvt)
    expect(env.registration.update).toHaveBeenCalledTimes(3)

    // Periodic timer while visible triggers update()
    env.advanceTime(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(env.registration.update).toHaveBeenCalledTimes(4)

    handle!.dispose()
    expect(env.swHub.listenerCount('controllerchange')).toBe(0)
    expect(env.docHub.listenerCount('visibilitychange')).toBe(0)
    expect(env.winHub.listenerCount('pageshow')).toBe(0)
    expect(env.winHub.listenerCount('online')).toBe(0)
  })

  it('nudges an already-waiting SW via SKIP_WAITING when an existing controller is active', async () => {
    const env = createFakeEnv({ scriptURL: './sw.js' } as ServiceWorker)
    ;(env.registration as any).waiting = env.waitingWorker

    const handle = registerPwaServiceWorker({
      isDesktop: () => false,
      serviceWorker: env.serviceWorker as any,
      win: env.win,
      doc: env.doc,
      storage: env.storage,
      isOnline: env.isOnline,
      reload: env.reload,
      now: env.now
    })
    await handle!.registrationPromise

    expect((env.waitingWorker as any).postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    handle!.dispose()
  })
})
