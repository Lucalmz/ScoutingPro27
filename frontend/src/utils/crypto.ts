/**
 * Cryptographic utilities for WebRTC signaling channel security:
 * 1. HMAC-SHA256 full-payload signing & verification (anti-tampering & authentication)
 * 2. Nonce + Timestamp replay protection with LRU cache (capacity: 5000)
 * 3. Ephemeral ECDH (P-256) key exchange & HKDF derivation
 * 4. AES-256-GCM authenticated encryption/decryption of signaling payloads
 */

export class NonceLruCache {
  private cache = new Map<string, number>()
  private readonly maxCapacity: number
  private readonly ttlMs: number

  constructor(maxCapacity = 5000, ttlMs = 30000) {
    this.maxCapacity = maxCapacity
    this.ttlMs = ttlMs
  }

  /**
   * Verifies if nonce is fresh. Returns true if valid, false if replayed/expired.
   */
  public verifyAndAdd(nonce: string, timestamp: number): boolean {
    const now = Date.now()
    // 1. Time window validation (±30s)
    if (Math.abs(now - timestamp) > this.ttlMs) {
      return false
    }

    // 2. Replay check
    if (this.cache.has(nonce)) {
      return false
    }

    // 3. Purge expired entries if cache is large
    if (this.cache.size >= this.maxCapacity) {
      this.evictExpired(now)
      // If still exceeding, evict oldest FIFO
      if (this.cache.size >= this.maxCapacity) {
        const oldestKey = this.cache.keys().next().value
        if (oldestKey) this.cache.delete(oldestKey)
      }
    }

    this.cache.set(nonce, timestamp)
    return true
  }

  public size(): number {
    return this.cache.size
  }

  public clear(): void {
    this.cache.clear()
  }

  private evictExpired(now: number): void {
    for (const [nonce, ts] of this.cache.entries()) {
      if (now - ts > this.ttlMs) {
        this.cache.delete(nonce)
      }
    }
  }
}

// Global Nonce cache
export const globalNonceCache = new NonceLruCache(5000, 30000)

/**
 * Generate a cryptographically secure random Nonce
 */
export function generateNonce(length = 16): string {
  const bytes = new Uint8Array(length)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Derive an HMAC-SHA256 Key from inviteCode and room name
 */
export async function deriveHmacKey(inviteCode: string, roomSalt = 'scoutingpro27'): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const keyMaterial = enc.encode(`${inviteCode}:${roomSalt}`)
  return await crypto.subtle.importKey(
    'raw',
    keyMaterial,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  )
}

/**
 * Compute HMAC-SHA256 signature for canonical signaling payload
 */
export async function signSignalingPayload(hmacKey: CryptoKey, data: Record<string, any>): Promise<string> {
  // Canonical sort keys to ensure reproducible signatures
  const sortedKeys = Object.keys(data).filter(k => k !== 'signature').sort()
  const canonicalObj: Record<string, any> = {}
  for (const k of sortedKeys) {
    canonicalObj[k] = data[k]
  }
  const serialized = JSON.stringify(canonicalObj)
  const enc = new TextEncoder()
  const signatureBuffer = await crypto.subtle.sign('HMAC', hmacKey, enc.encode(serialized))
  return Array.from(new Uint8Array(signatureBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Verify HMAC-SHA256 signature for incoming signaling payload
 */
export async function verifySignalingPayload(
  hmacKey: CryptoKey,
  data: Record<string, any>,
  expectedSignature: string
): Promise<boolean> {
  if (!expectedSignature) return false
  const sortedKeys = Object.keys(data).filter(k => k !== 'signature').sort()
  const canonicalObj: Record<string, any> = {}
  for (const k of sortedKeys) {
    canonicalObj[k] = data[k]
  }
  const serialized = JSON.stringify(canonicalObj)
  const enc = new TextEncoder()
  
  const expectedBytes = new Uint8Array(
    expectedSignature.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
  )

  return await crypto.subtle.verify('HMAC', hmacKey, expectedBytes, enc.encode(serialized))
}

/**
 * Generate Ephemeral ECDH (P-256) Key Pair
 */
export async function generateEcdhKeyPair(): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits']
  )
}

/**
 * Export ECDH Public Key to raw JWK / Base64 string
 */
export async function exportEcdhPublicKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key)
  return Array.from(new Uint8Array(raw))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Import ECDH Public Key from raw hex string
 */
export async function importEcdhPublicKey(hexString: string): Promise<CryptoKey> {
  const bytes = new Uint8Array(
    hexString.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
  )
  return await crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  )
}

/**
 * Derive 256-bit AES-GCM Key from local private key and peer's public key using HKDF
 */
export async function deriveSharedAesKey(
  localPrivateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  salt = 'scoutingpro27-signaling'
): Promise<CryptoKey> {
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    localPrivateKey,
    256
  )

  // HKDF key derivation to ensure strong entropy
  const enc = new TextEncoder()
  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, { name: 'HKDF' }, false, ['deriveKey'])

  return await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: enc.encode(salt),
      info: enc.encode('webrtc-signaling-aes-gcm')
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/**
 * Encrypt plaintext string using AES-256-GCM
 */
export async function encryptSignalingData(
  aesKey: CryptoKey,
  plaintext: string
): Promise<{ iv: string; ciphertext: string }> {
  const enc = new TextEncoder()
  const iv = new Uint8Array(12)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(iv)
  }
  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    enc.encode(plaintext)
  )

  const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join('')
  const cipherHex = Array.from(new Uint8Array(encryptedBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

  return { iv: ivHex, ciphertext: cipherHex }
}

/**
 * Decrypt ciphertext using AES-256-GCM
 */
export async function decryptSignalingData(
  aesKey: CryptoKey,
  encrypted: { iv: string; ciphertext: string }
): Promise<string> {
  const ivBytes = new Uint8Array(
    encrypted.iv.match(/.{1,2}/g)?.map(b => parseInt(b, 16)) || []
  )
  const cipherBytes = new Uint8Array(
    encrypted.ciphertext.match(/.{1,2}/g)?.map(b => parseInt(b, 16)) || []
  )

  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes },
    aesKey,
    cipherBytes
  )

  const dec = new TextDecoder()
  return dec.decode(decryptedBuffer)
}
