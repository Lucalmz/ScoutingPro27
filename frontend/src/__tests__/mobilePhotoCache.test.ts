import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  clearAllMobileCachedPhotos,
  deleteMobileCachedPhoto,
  getMobileCachedPhoto,
  getPendingMobilePhotos,
  markMobilePhotoSynced,
  migrateMobilePhotosEventId,
  saveMobileCachedPhoto
} from '../services/mobilePhotoCache'

describe('mobilePhotoCache - Memory Fallback & IndexedDB Persistence', () => {
  const origIndexedDb = globalThis.indexedDB

  beforeEach(async () => {
    // Ensure memory fallback baseline when indexedDB is absent
    Object.defineProperty(globalThis, 'indexedDB', {
      value: undefined,
      configurable: true,
      writable: true
    })
    await clearAllMobileCachedPhotos()
  })

  afterEach(async () => {
    await clearAllMobileCachedPhotos()
    Object.defineProperty(globalThis, 'indexedDB', {
      value: origIndexedDb,
      configurable: true,
      writable: true
    })
    vi.restoreAllMocks()
  })

  it('saves, retrieves, marks synced, migrates eventId, and deletes photos in memory fallback mode', async () => {
    await saveMobileCachedPhoto('pit_27570_1', 'data:image/webp;base64,AAA', 'evt-temp')
    await saveMobileCachedPhoto('pit_118_1', 'data:image/webp;base64,BBB', 'evt-other', 'PENDING')
    await saveMobileCachedPhoto('pit_999_1', 'data:image/webp;base64,CCC', 'evt-temp', 'SYNCED')

    expect(await getMobileCachedPhoto('pit_27570_1')).toBe('data:image/webp;base64,AAA')
    expect(await getMobileCachedPhoto('missing-key')).toBeNull()

    const tempPending = await getPendingMobilePhotos('evt-temp')
    expect(tempPending.map((p) => p.key)).toEqual(['pit_27570_1'])

    const allPending = await getPendingMobilePhotos()
    expect(allPending.map((p) => p.key).sort()).toEqual(['pit_118_1', 'pit_27570_1'])

    await migrateMobilePhotosEventId('evt-temp', 'evt-auth-uuid')
    expect(await getPendingMobilePhotos('evt-temp')).toHaveLength(0)
    expect((await getPendingMobilePhotos('evt-auth-uuid')).map((p) => p.key)).toEqual(['pit_27570_1'])

    await markMobilePhotoSynced('pit_27570_1')
    expect(await getPendingMobilePhotos('evt-auth-uuid')).toHaveLength(0)

    await deleteMobileCachedPhoto('pit_27570_1')
    expect(await getMobileCachedPhoto('pit_27570_1')).toBeNull()
  })

  it('persists and reads through IndexedDB when available and falls back cleanly on open error', async () => {
    const storeMap = new Map<string, any>()

    const makeReq = <T>(executor: (req: any) => void) => {
      const req: any = { result: undefined, onsuccess: null, onerror: null }
      queueMicrotask(() => executor(req))
      return req
    }

    const mockDb = {
      objectStoreNames: { contains: () => true },
      transaction: (_name: string, _mode: string) => ({
        objectStore: () => ({
          put: (val: any) =>
            makeReq((req) => {
              storeMap.set(val.key, { ...val })
              req.result = val.key
              req.onsuccess?.()
            }),
          get: (key: string) =>
            makeReq((req) => {
              req.result = storeMap.get(key)
              req.onsuccess?.()
            }),
          getAll: () =>
            makeReq((req) => {
              req.result = Array.from(storeMap.values()).map((v) => ({ ...v }))
              req.onsuccess?.()
            }),
          delete: (key: string) =>
            makeReq((req) => {
              storeMap.delete(key)
              req.onsuccess?.()
            }),
          clear: () =>
            makeReq((req) => {
              storeMap.clear()
              req.onsuccess?.()
            })
        })
      })
    }

    Object.defineProperty(globalThis, 'indexedDB', {
      value: {
        open: () => {
          const req: any = { result: mockDb, onupgradeneeded: null, onsuccess: null, onerror: null }
          queueMicrotask(() => req.onsuccess?.())
          return req
        }
      },
      configurable: true,
      writable: true
    })

    await saveMobileCachedPhoto('idb_k1', 'data:image/webp;base64,IDB1', 'evt-1', 'PENDING')
    expect(storeMap.get('idb_k1')?.dataUrl).toBe('data:image/webp;base64,IDB1')

    const pending = await getPendingMobilePhotos('evt-1')
    expect(pending).toHaveLength(1)
    expect(pending[0]?.key).toBe('idb_k1')

    await migrateMobilePhotosEventId('evt-1', 'evt-2')
    expect(storeMap.get('idb_k1')?.eventId).toBe('evt-2')

    await markMobilePhotoSynced('idb_k1')
    expect(storeMap.get('idb_k1')?.syncStatus).toBe('SYNCED')
    expect(await getPendingMobilePhotos('evt-2')).toHaveLength(0)

    await deleteMobileCachedPhoto('idb_k1')
    expect(storeMap.has('idb_k1')).toBe(false)

    // Test IndexedDB open error fallback
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    Object.defineProperty(globalThis, 'indexedDB', {
      value: {
        open: () => {
          const req: any = { onupgradeneeded: null, onsuccess: null, onerror: null }
          queueMicrotask(() => req.onerror?.())
          return req
        }
      },
      configurable: true,
      writable: true
    })
    await saveMobileCachedPhoto('mem_only', 'data:image/webp;base64,MEM', 'evt-3')
    expect(await getMobileCachedPhoto('mem_only')).toBe('data:image/webp;base64,MEM')
    expect(warnSpy).toHaveBeenCalled()
  })
})
