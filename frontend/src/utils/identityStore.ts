/**
 * Persistent Device Identity & TOFU (Trust On First Use) Security Store
 *
 * Guarantees:
 * 1. Persistent Device Identity Key: ECDH P-256 key pair + stable deviceId stored in IndexedDB.
 *    Survives browser reloads, restarts, and tab closures.
 * 2. Explicit TOFU Model: First connection records peer's public key as trusted baseline.
 * 3. Multi-Device Trust Binding: Records keyed by (eventId, userId, deviceId) to avoid false alarms
 *    when the same user switches between laptop/phone.
 * 4. Graduated Alerting (Anti-Fatigue): Distinguishes normal new devices from in-session key flapping.
 * 5. Strict Local-Only Write Path: Only local evaluation and confirmSas can write to trust store.
 */

import {
  generateEcdhKeyPair,
  exportEcdhPublicKey,
  importEcdhPublicKey,
  generateNonce
} from './crypto'

export interface DeviceIdentity {
  deviceId: string
  keyPair: CryptoKeyPair
  publicKeyHex: string
  createdAt: number
}

export interface PeerTrustRecord {
  eventId: string
  userId: string
  username: string
  deviceId: string
  publicKeyHex: string
  firstSeenAt: number
  lastSeenAt: number
  trustedAt: number
  trustLevel: 'TOFU_TRUSTED' | 'MANUAL_VERIFIED'
}

export type TrustEvaluationResult =
  | {
      status: 'TRUSTED_MATCH'
      record: PeerTrustRecord
    }
  | {
      status: 'TOFU_FIRST_SEEN'
      isNewDeviceForUser: boolean
      existingDeviceCount: number
      notice: string
    }
  | {
      status: 'KEY_ROTATION_ALERT'
      level: 'WARNING' | 'CRITICAL'
      previousKeyHex: string
      reason: string
      message: string
    }

const DB_NAME = 'scoutingpro_security_v1'
const STORE_DEVICE = 'device_identity'
const STORE_PEERS = 'trusted_peers'

// In-memory fallback cache if IndexedDB is unavailable
let memDeviceIdentity: DeviceIdentity | null = null
const memTrustedPeers = new Map<string, PeerTrustRecord>()

/**
 * Open IndexedDB database with object stores
 */
function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null)
  }

  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1)

      request.onupgradeneeded = (event: any) => {
        const db = event.target.result as IDBDatabase
        if (!db.objectStoreNames.contains(STORE_DEVICE)) {
          db.createObjectStore(STORE_DEVICE, { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains(STORE_PEERS)) {
          const store = db.createObjectStore(STORE_PEERS, { keyPath: 'id' })
          store.createIndex('eventId_userId', ['eventId', 'userId'], { unique: false })
        }
      }

      request.onsuccess = () => resolve(request.result)
      request.onerror = () => {
        console.warn('[Security Store] Failed to open IndexedDB, falling back to memory.')
        resolve(null)
      }
    } catch (e) {
      console.warn('[Security Store] IndexedDB error, using memory fallback:', e)
      resolve(null)
    }
  })
}

/**
 * Export ECDH private key to JWK
 */
export async function exportPrivateKeyJwk(key: CryptoKey): Promise<JsonWebKey> {
  return await crypto.subtle.exportKey('jwk', key)
}

/**
 * Import ECDH private key from JWK
 */
export async function importPrivateKeyJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits']
  )
}

/**
 * 1. Persistent Device Identity Key:
 * Retrieve existing key pair & deviceId from IndexedDB, or create & persist a fresh one.
 */
export async function getOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  if (memDeviceIdentity) {
    return memDeviceIdentity
  }

  const db = await openDb()
  if (db) {
    try {
      const tx = db.transaction(STORE_DEVICE, 'readonly')
      const store = tx.objectStore(STORE_DEVICE)
      const existing: any = await new Promise((resolve) => {
        const req = store.get('current_device')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(null)
      })

      if (existing && existing.privateKeyJwk && existing.publicKeyHex && existing.deviceId) {
        const privateKey = await importPrivateKeyJwk(existing.privateKeyJwk)
        const publicKey = await importEcdhPublicKey(existing.publicKeyHex)
        memDeviceIdentity = {
          deviceId: existing.deviceId,
          keyPair: { privateKey, publicKey },
          publicKeyHex: existing.publicKeyHex,
          createdAt: existing.createdAt || Date.now()
        }
        console.log(`[Security Store] Loaded persistent device identity: ${existing.deviceId} (pub: ${existing.publicKeyHex.slice(0, 10)}...)`)
        return memDeviceIdentity
      }
    } catch (e) {
      console.warn('[Security Store] Error reading device identity from IndexedDB:', e)
    }
  }

  // Generate new persistent device identity
  const deviceId = `dev_${Date.now().toString(36)}_${generateNonce(8)}`
  const keyPair = await generateEcdhKeyPair()
  const publicKeyHex = await exportEcdhPublicKey(keyPair.publicKey)
  const privateKeyJwk = await exportPrivateKeyJwk(keyPair.privateKey)
  const createdAt = Date.now()

  memDeviceIdentity = {
    deviceId,
    keyPair,
    publicKeyHex,
    createdAt
  }

  if (db) {
    try {
      const tx = db.transaction(STORE_DEVICE, 'readwrite')
      const store = tx.objectStore(STORE_DEVICE)
      store.put({
        id: 'current_device',
        deviceId,
        privateKeyJwk,
        publicKeyHex,
        createdAt
      })
      console.log(`[Security Store] Generated and persisted new device identity: ${deviceId}`)
    } catch (e) {
      console.warn('[Security Store] Error saving device identity to IndexedDB:', e)
    }
  }

  return memDeviceIdentity
}

/**
 * 2. Get trusted peer record by (eventId, userId, deviceId)
 */
export async function getPeerTrustRecord(
  eventId: string,
  userId: string,
  deviceId: string
): Promise<PeerTrustRecord | null> {
  const recordId = `${eventId}:${userId}:${deviceId}`
  if (memTrustedPeers.has(recordId)) {
    return memTrustedPeers.get(recordId)!
  }

  const db = await openDb()
  if (!db) return null

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_PEERS, 'readonly')
      const store = tx.objectStore(STORE_PEERS)
      const req = store.get(recordId)
      req.onsuccess = () => {
        const res = req.result
        if (res) {
          memTrustedPeers.set(recordId, res)
          resolve(res)
        } else {
          resolve(null)
        }
      }
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

/**
 * 3. List all trusted devices for a user in a given event
 */
export async function listUserTrustedDevices(
  eventId: string,
  userId: string
): Promise<PeerTrustRecord[]> {
  const db = await openDb()
  const results: PeerTrustRecord[] = []

  // Check memory
  for (const record of memTrustedPeers.values()) {
    if (record.eventId === eventId && record.userId === userId) {
      results.push(record)
    }
  }

  if (!db) return results

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_PEERS, 'readonly')
      const store = tx.objectStore(STORE_PEERS)
      const index = store.index('eventId_userId')
      const req = index.getAll([eventId, userId])
      req.onsuccess = () => {
        const list: PeerTrustRecord[] = req.result || []
        // merge with memory
        const map = new Map<string, PeerTrustRecord>()
        for (const r of list) map.set(r.deviceId, r)
        for (const r of results) map.set(r.deviceId, r)
        resolve(Array.from(map.values()))
      }
      req.onerror = () => resolve(results)
    } catch {
      resolve(results)
    }
  })
}

/**
 * 4. Strict Local-Only Write Path:
 * Save or update peer trust record. Never accepts direct network payloads.
 */
export async function savePeerTrustRecord(record: PeerTrustRecord): Promise<void> {
  const recordId = `${record.eventId}:${record.userId}:${record.deviceId}`
  memTrustedPeers.set(recordId, record)

  const db = await openDb()
  if (!db) return

  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_PEERS, 'readwrite')
      const store = tx.objectStore(STORE_PEERS)
      const req = store.put({
        id: recordId,
        ...record
      })
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    } catch (e) {
      resolve() // silent memory fallback
    }
  })
}

/**
 * 5. Multi-Device & TOFU Evaluation with Graduated Alerting
 */
export async function evaluatePeerKeyTrust(params: {
  eventId: string
  userId: string
  username: string
  deviceId: string
  publicKeyHex: string
  isInSessionFlapping?: boolean
}): Promise<TrustEvaluationResult> {
  const { eventId, userId, username, deviceId, publicKeyHex, isInSessionFlapping } = params

  if (!publicKeyHex) {
    return {
      status: 'TOFU_FIRST_SEEN',
      isNewDeviceForUser: false,
      existingDeviceCount: 0,
      notice: 'No public key provided'
    }
  }

  const existingRecord = await getPeerTrustRecord(eventId, userId, deviceId)

  // Case 1: Same device, public key matches historical record
  if (existingRecord) {
    if (existingRecord.publicKeyHex.toLowerCase() === publicKeyHex.toLowerCase()) {
      existingRecord.lastSeenAt = Date.now()
      await savePeerTrustRecord(existingRecord)
      return {
        status: 'TRUSTED_MATCH',
        record: existingRecord
      }
    }

    // Case 2: Same device presents DIFFERENT public key!
    // Distinguish active in-session flapping from normal key reinstallation
    if (isInSessionFlapping) {
      return {
        status: 'KEY_ROTATION_ALERT',
        level: 'CRITICAL',
        previousKeyHex: existingRecord.publicKeyHex,
        reason: 'IN_SESSION_FLAPPING',
        message: `安全严重警报：设备 [${deviceId}] 在当前活跃会话中公钥突然变动！疑似网络中间人劫持，已切断通信。`
      }
    }

    return {
      status: 'KEY_ROTATION_ALERT',
      level: 'WARNING',
      previousKeyHex: existingRecord.publicKeyHex,
      reason: 'DEVICE_KEY_CHANGED',
      message: `设备公钥更新：侦察员 [${username}] 的设备公钥与历史记录不符（可能对端重装了应用或清除了数据）。请核对安全码确认。`
    }
  }

  // Case 3: Device not seen before for this (eventId, userId)
  // Check if user has other devices
  const userDevices = await listUserTrustedDevices(eventId, userId)
  const isNewDeviceForUser = userDevices.length > 0

  return {
    status: 'TOFU_FIRST_SEEN',
    isNewDeviceForUser,
    existingDeviceCount: userDevices.length,
    notice: isNewDeviceForUser
      ? `检测到侦察员 [${username}] 使用新设备连入（已绑定 ${userDevices.length} 台其他设备）。`
      : `首次连入活动：建立初次信任 (TOFU)。`
  }
}

/**
 * Test helper: resets memory and IndexedDB state
 */
export async function clearSecurityStoreForTesting(): Promise<void> {
  memDeviceIdentity = null
  memTrustedPeers.clear()

  const db = await openDb()
  if (db) {
    try {
      const tx = db.transaction([STORE_DEVICE, STORE_PEERS], 'readwrite')
      tx.objectStore(STORE_DEVICE).clear()
      tx.objectStore(STORE_PEERS).clear()
      await new Promise(r => { tx.oncomplete = r })
    } catch {}
  }
}
