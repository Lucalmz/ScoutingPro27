/**
 * 手机客户端专属离线图片缓存服务 (Mobile-Only IndexedDB Cache)
 * 仅用于移动端脱机离线时暂存 WebP 压缩图片，并维护上传同步队列状态。
 * 电脑端 (PC Host) 绝对不应调用此服务。
 */

export interface CachedPhotoItem {
  key: string
  eventId: string
  dataUrl: string
  syncStatus: 'PENDING' | 'SYNCED'
  createdAt: number
}

const DB_NAME = 'ScoutingPro_MobileMedia'
const DB_VERSION = 1
const STORE_NAME = 'pit_photos'

// 内存兜底 (用于测试或无痕沙箱)
const memoryCache = new Map<string, CachedPhotoItem>()

function getDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null)
  }

  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION)

      request.onupgradeneeded = (e: IDBVersionChangeEvent) => {
        const db = (e.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' })
        }
      }

      request.onsuccess = () => resolve(request.result)
      request.onerror = () => {
        console.warn('[mobilePhotoCache] Failed to open IndexedDB, falling back to memory')
        resolve(null)
      }
    } catch {
      resolve(null)
    }
  })
}

export async function saveMobileCachedPhoto(
  key: string,
  dataUrl: string,
  eventId: string,
  syncStatus: 'PENDING' | 'SYNCED' = 'PENDING'
): Promise<string> {
  const item: CachedPhotoItem = {
    key,
    eventId,
    dataUrl,
    syncStatus,
    createdAt: Date.now()
  }
  memoryCache.set(key, item)

  const db = await getDb()
  if (!db) return key

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const req = store.put(item)
      req.onsuccess = () => resolve(key)
      req.onerror = () => resolve(key)
    } catch {
      resolve(key)
    }
  })
}

export async function getMobileCachedPhoto(key: string): Promise<string | null> {
  const mem = memoryCache.get(key)
  if (mem) {
    return mem.dataUrl
  }

  const db = await getDb()
  if (!db) return null

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const req = store.get(key)
      req.onsuccess = () => {
        const val = req.result as CachedPhotoItem | string | undefined
        if (!val) {
          resolve(null)
          return
        }
        if (typeof val === 'string') {
          resolve(val)
        } else {
          memoryCache.set(key, val)
          resolve(val.dataUrl)
        }
      }
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

export async function getPendingMobilePhotos(eventId?: string): Promise<CachedPhotoItem[]> {
  const db = await getDb()
  if (!db) {
    return Array.from(memoryCache.values()).filter(
      (item) => item.syncStatus === 'PENDING' && (!eventId || item.eventId === eventId)
    )
  }

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const req = store.getAll()
      req.onsuccess = () => {
        const all = (req.result || []) as CachedPhotoItem[]
        const pending = all.filter(
          (item) => item && item.syncStatus === 'PENDING' && (!eventId || item.eventId === eventId)
        )
        resolve(pending)
      }
      req.onerror = () => resolve([])
    } catch {
      resolve([])
    }
  })
}

export async function markMobilePhotoSynced(key: string): Promise<void> {
  const mem = memoryCache.get(key)
  if (mem) {
    mem.syncStatus = 'SYNCED'
  }

  const db = await getDb()
  if (!db) return

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const req = store.get(key)
      req.onsuccess = () => {
        const item = req.result as CachedPhotoItem | undefined
        if (item) {
          item.syncStatus = 'SYNCED'
          store.put(item)
        }
        resolve()
      }
      req.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}

export async function deleteMobileCachedPhoto(key: string): Promise<void> {
  memoryCache.delete(key)

  const db = await getDb()
  if (!db) return

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const req = store.delete(key)
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}
