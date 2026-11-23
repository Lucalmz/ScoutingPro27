import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useUserStore, registerBeforeLogoutHook, clearBeforeLogoutHooksForTesting } from '@/stores/user'
import { useEventStore } from '@/stores/events'
import { useRecordStore } from '@/stores/records'
import { useInboxStore } from '@/stores/inbox'
import * as api from '@/services/api'
import * as photoStorage from '@/services/photoStorage'
import {
  clearSecurityStoreForTesting,
  getOrCreateDeviceIdentity
} from '@/utils/identityStore'
import { importEcdsaPublicKey, signDataEcdsa, verifyDataEcdsa, generateEcdhKeyPair, exportEcdhPublicKey } from '@/utils/crypto'
import { saveEpochWitnessRecord, getEpochStorageKey, isPlaceholderEventId } from '@/services/webrtc/epochStore'
import { getClockAnchorKey } from '@/services/clock'

const mockDiscoverRoomWitness = vi.fn()

vi.mock('@/services/api', async () => {
  const actual = await vi.importActual<any>('@/services/api')
  return {
    ...actual,
    login: vi.fn(),
    listEvents: vi.fn(),
    createEvent: vi.fn(),
    joinEvent: vi.fn(),
    syncExternalEvent: vi.fn(),
    deleteEvent: vi.fn(),
    isStaticCloudHost: vi.fn(() => false)
  }
})

vi.mock('@/services/webrtc', async () => {
  const actual = await vi.importActual<any>('@/services/webrtc')
  return {
    ...actual,
    discoverRoomWitness: (...args: any[]) => mockDiscoverRoomWitness(...args)
  }
})

/**
 * Minimal in-memory IndexedDB shim to exercise real IndexedDB upgrade/read/write logic
 * inside happy-dom without external fake-indexeddb dependencies.
 */
function installInMemoryIndexedDbShim(seedDeviceRecord?: Record<string, any>): () => void {
  const originalIndexedDb = (globalThis as any).indexedDB
  const stores: Record<string, Map<string, any>> = {
    device_identity: new Map(),
    trusted_peers: new Map()
  }
  if (seedDeviceRecord) {
    stores.device_identity!.set(seedDeviceRecord.id, { ...seedDeviceRecord })
  }

  const fakeDb: any = {
    objectStoreNames: {
      contains: (name: string) => name in stores
    },
    createObjectStore: (name: string) => {
      if (!stores[name]) stores[name] = new Map()
      return {
        createIndex: () => {}
      }
    },
    transaction: () => {
      const tx: any = {
        oncomplete: null as any,
        objectStore: (storeName: string) => {
          const map = stores[storeName] || new Map()
          stores[storeName] = map
          return {
            get: (key: string) => {
              const req: any = { result: undefined, onsuccess: null, onerror: null }
              queueMicrotask(() => {
                req.result = map.has(key) ? { ...map.get(key) } : undefined
                req.onsuccess?.()
              })
              return req
            },
            put: (val: any) => {
              map.set(val.id, { ...val })
              queueMicrotask(() => tx.oncomplete?.())
              return {}
            },
            clear: () => {
              map.clear()
              queueMicrotask(() => tx.oncomplete?.())
              return {}
            }
          }
        }
      }
      return tx
    }
  }

  ;(globalThis as any).indexedDB = {
    open: () => {
      const req: any = { result: fakeDb, onupgradeneeded: null, onsuccess: null, onerror: null }
      queueMicrotask(() => {
        if (!seedDeviceRecord) {
          req.onupgradeneeded?.({ target: { result: fakeDb } })
        }
        req.onsuccess?.()
      })
      return req
    }
  }

  return () => {
    ;(globalThis as any).indexedDB = originalIndexedDb
  }
}

describe('Device ECDSA Identity, Safe Logout Isolation & Dual-Entry Host Device Switch', () => {
  beforeEach(async () => {
    localStorage.clear()
    clearBeforeLogoutHooksForTesting()
    await clearSecurityStoreForTesting()
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.spyOn(photoStorage, 'isDesktopHost').mockReturnValue(true)
  })

  afterEach(async () => {
    delete (globalThis as any).__TEST_ENABLE_ROOM_DISCOVERY__
    clearBeforeLogoutHooksForTesting()
    await clearSecurityStoreForTesting()
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('creates and lazily upgrades persistent ECDSA P-256 identity preserving deviceId and ECDH keys, and signs/verifies payloads', async () => {
    const legacyEcdh = await generateEcdhKeyPair()
    const legacyPubHex = await exportEcdhPublicKey(legacyEcdh.publicKey)
    const legacyPrivJwk = await crypto.subtle.exportKey('jwk', legacyEcdh.privateKey)

    const restoreIdb = installInMemoryIndexedDbShim({
      id: 'current_device',
      deviceId: 'dev_legacy_shared_laptop',
      publicKeyHex: legacyPubHex,
      privateKeyJwk: legacyPrivJwk,
      createdAt: 1_700_000_000_000
      // Notice: NO signingKeyPair / signingPubKey yet
    })

    try {
      const upgraded = await getOrCreateDeviceIdentity()

      expect(upgraded.deviceId).toBe('dev_legacy_shared_laptop')
      expect(upgraded.publicKeyHex).toBe(legacyPubHex)
      expect(upgraded.signingPubKey).toBeTruthy()
      expect(upgraded.signingKeyPair?.privateKey).toBeTruthy()

      const importedPub = await importEcdsaPublicKey(upgraded.signingPubKey!)
      expect(importedPub.type).toBe('public')

      const canonicalPayload = JSON.stringify({ eventId: 'uuid-1', teamNumber: 27570, matchNumber: 12, autoScore: 42 })
      const signature = await signDataEcdsa(upgraded.signingKeyPair!.privateKey, canonicalPayload)
      expect(signature.length).toBeGreaterThan(20)

      expect(await verifyDataEcdsa(upgraded.signingPubKey!, canonicalPayload, signature)).toBe(true)

      const tamperedPayload = JSON.stringify({ eventId: 'uuid-1', teamNumber: 27570, matchNumber: 12, autoScore: 99 })
      expect(await verifyDataEcdsa(upgraded.signingPubKey!, tamperedPayload, signature)).toBe(false)
    } finally {
      restoreIdb()
      await clearSecurityStoreForTesting()
    }

    // Also verify default non-IDB fallback creates a valid ECDSA key pair alongside deviceId
    const freshIdentity = await getOrCreateDeviceIdentity()
    expect(freshIdentity.deviceId.startsWith('dev_')).toBe(true)
    expect(freshIdentity.signingPubKey).toBeTruthy()
    expect(freshIdentity.signingKeyPair?.privateKey).toBeTruthy()
  })

  it('userStore.logout() runs beforeLogoutHooks with active JWT, clears user-scoped keys only, while clearAllLocalCache() wipes sp27_* keys', async () => {
    const userStore = useUserStore()
    const eventStore = useEventStore()
    const recordStore = useRecordStore()
    const inboxStore = useInboxStore()

    userStore.user = { id: 'alice-id', username: 'LeadAlice', token: 'jwt-alice' }
    localStorage.setItem('scoutingpro-user', JSON.stringify(userStore.user))
    localStorage.setItem('scoutingpro_events', JSON.stringify([{ id: 'uuid-1', name: 'Event', inviteCode: 'ABC123', hostId: 'alice-id' }]))
    localStorage.setItem('scoutingpro_current_event', JSON.stringify({ id: 'uuid-1', name: 'Event', inviteCode: 'ABC123', hostId: 'alice-id' }))
    localStorage.setItem('inbox-messages-alice-id', JSON.stringify([{ id: 'm1' }]))
    localStorage.setItem('inbox-outbox-alice-id', JSON.stringify([{ id: 'o1' }]))

    // Shared device / event-scoped keys that MUST survive logout()
    saveEpochWitnessRecord({
      inviteCode: 'ABC123',
      authoritativeEventId: 'uuid-1',
      eventName: 'Shared Regional',
      hostUserId: 'alice-id',
      highestSeenEpoch: 2
    })
    localStorage.setItem(
      getClockAnchorKey('uuid-1'),
      JSON.stringify({ lastHlcPt: 1_760_000_000_000, savedCalibratedMs: 1_760_000_000_000, savedWallMs: 1_760_000_000_000, calibratedByHost: true, updatedAtWallMs: 1_760_000_000_000 })
    )
    localStorage.setItem('sp27_records_uuid-1', JSON.stringify([{ id: 'rec-1' }]))
    localStorage.setItem('scoutingpro27_schedule_uuid-1', JSON.stringify([{ matchNumber: 1 }]))
    recordStore.records = [{ id: 'rec-1', eventId: 'uuid-1' } as any]
    inboxStore.messages = [{ id: 'm1' } as any]

    let seenTokenDuringHook = ''
    let hookRan = false
    registerBeforeLogoutHook(async () => {
      await Promise.resolve()
      hookRan = true
      seenTokenDuringHook = userStore.token
    })

    await userStore.logout()

    expect(hookRan).toBe(true)
    expect(seenTokenDuringHook).toBe('jwt-alice')
    expect(userStore.user).toBeNull()
    expect(userStore.isLoggedIn).toBe(false)
    expect(recordStore.records).toHaveLength(0)

    // User-scoped keys cleared
    expect(localStorage.getItem('scoutingpro-user')).toBeNull()
    expect(localStorage.getItem('scoutingpro_events')).toBeNull()
    expect(localStorage.getItem('scoutingpro_current_event')).toBeNull()
    expect(localStorage.getItem('inbox-messages-alice-id')).toBeNull()
    expect(localStorage.getItem('inbox-outbox-alice-id')).toBeNull()

    // Event-scoped / fencing / clock keys PRESERVED on account switch
    expect(localStorage.getItem(getEpochStorageKey('ABC123'))).not.toBeNull()
    expect(localStorage.getItem(getClockAnchorKey('uuid-1'))).not.toBeNull()
    expect(localStorage.getItem('sp27_records_uuid-1')).not.toBeNull()
    expect(localStorage.getItem('scoutingpro27_schedule_uuid-1')).not.toBeNull()

    // Explicit mobile Clear All Local Cache action still cleans sp27_* keys when requested
    eventStore.clearAllLocalCache()
    expect(localStorage.getItem(getEpochStorageKey('ABC123'))).toBeNull()
    expect(localStorage.getItem(getClockAnchorKey('uuid-1'))).toBeNull()
    expect(localStorage.getItem('sp27_records_uuid-1')).toBeNull()
    expect(localStorage.getItem('scoutingpro27_schedule_uuid-1')).toBeNull()
  })

  it('supports shared-DB Laptop B direct-entry host switch after AssistantBob logout -> LeadAlice login', async () => {
    const userStore = useUserStore()
    const eventStore = useEventStore()

    const sharedEvent = {
      id: 'uuid-shared-1',
      name: 'FTC Regional Shared',
      inviteCode: 'SHARED',
      hostId: 'alice-id'
    }

    // 1. AssistantBob logs in on shared Laptop B -> sees shared event with isHost === false
    vi.mocked(api.login).mockResolvedValue({ id: 'bob-id', username: 'AssistantBob', token: 'jwt-bob' })
    vi.mocked(api.listEvents).mockResolvedValue([sharedEvent])

    await userStore.login('AssistantBob', 'pw')
    await eventStore.fetchEvents('bob-id')
    eventStore.setCurrentEvent(eventStore.events[0]!)
    expect(eventStore.isHost).toBe(false)

    // 2. AssistantBob logs out, LeadAlice logs in -> Dashboard loads shared event from H2 -> direct click sets isHost === true without ext_ stub
    await userStore.logout()
    vi.mocked(api.login).mockResolvedValue({ id: 'alice-id', username: 'LeadAlice', token: 'jwt-alice' })
    vi.mocked(api.listEvents).mockResolvedValue([sharedEvent])

    await userStore.login('LeadAlice', 'pw')
    await eventStore.fetchEvents('alice-id')

    expect(eventStore.events).toHaveLength(1)
    expect(isPlaceholderEventId(eventStore.events[0]!.id)).toBe(false)

    eventStore.setCurrentEvent(eventStore.events[0]!)
    expect(eventStore.currentEvent?.id).toBe('uuid-shared-1')
    expect(eventStore.isHost).toBe(true)
    expect(api.joinEvent).not.toHaveBeenCalled()
  })

  it('resolves blank Laptop C eventStore.join("ABC123") via Witness discovery & syncExternalEvent without creating ext_ stub', async () => {
    ;(globalThis as any).__TEST_ENABLE_ROOM_DISCOVERY__ = true
    const userStore = useUserStore()
    const eventStore = useEventStore()
    userStore.user = { id: 'alice-id', username: 'LeadAlice', token: 'jwt-alice' }

    mockDiscoverRoomWitness.mockResolvedValue({
      found: true,
      hasLiveHost: false,
      authoritativeEventId: 'uuid-real',
      eventName: 'Regionals',
      hostUserId: 'alice-id',
      highestSeenEpoch: 2,
      witnessMaxHlcPts: []
    })
    vi.mocked(api.syncExternalEvent).mockImplementation(async (evt) => evt)

    const joined = await eventStore.join('abc123')

    expect(mockDiscoverRoomWitness).toHaveBeenCalledWith(
      expect.objectContaining({
        inviteCode: 'ABC123',
        userId: 'alice-id'
      })
    )
    expect(api.syncExternalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'uuid-real',
        name: 'Regionals',
        inviteCode: 'ABC123',
        hostId: 'alice-id'
      })
    )
    expect(api.joinEvent).not.toHaveBeenCalled()
    expect(joined?.id).toBe('uuid-real')
    expect(eventStore.currentEvent?.id).toBe('uuid-real')
    expect(isPlaceholderEventId(eventStore.currentEvent!.id)).toBe(false)
    expect(eventStore.isHost).toBe(true)
  })
})
