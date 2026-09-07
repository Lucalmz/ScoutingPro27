/**
 * Deterministic User ID Generator (RFC 4122 v3 MD5-based UUID)
 * 100% byte-for-byte compatible with backend Java UserUtil.generateDeterministicUserId.
 */

// Self-contained MD5 implementation for universal browser/Node compatibility
function md5(inputBytes: Uint8Array): Uint8Array {
  function safeAdd(x: number, y: number): number {
    const lsw = (x & 0xffff) + (y & 0xffff)
    const msw = (x >> 16) + (y >> 16) + (lsw >> 16)
    return (msw << 16) | (lsw & 0xffff)
  }

  function bitRotateLeft(num: number, cnt: number): number {
    return (num << cnt) | (num >>> (32 - cnt))
  }

  function md5cmn(q: number, a: number, b: number, x: number, s: number, t: number): number {
    return safeAdd(bitRotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b)
  }

  function md5ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
    return md5cmn((b & c) | (~b & d), a, b, x, s, t)
  }

  function md5gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
    return md5cmn((b & d) | (c & ~d), a, b, x, s, t)
  }

  function md5hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
    return md5cmn(b ^ c ^ d, a, b, x, s, t)
  }

  function md5ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
    return md5cmn(c ^ (b | ~d), a, b, x, s, t)
  }

  // Convert byte array to 32-bit word array with padding
  const n = inputBytes.length
  const paddedLength = (((n + 8) >> 6) + 1) * 16
  const words = new Int32Array(paddedLength)

  for (let i = 0; i < n; i++) {
    const byteVal = inputBytes[i] ?? 0
    words[i >> 2] = (words[i >> 2] ?? 0) | (byteVal << ((i % 4) * 8))
  }
  // Append 0x80 padding byte
  words[n >> 2] = (words[n >> 2] ?? 0) | (0x80 << ((n % 4) * 8))

  words[paddedLength - 2] = (n * 8) & 0xffffffff
  words[paddedLength - 1] = Math.floor((n * 8) / 0x100000000)

  let a = 1732584193
  let b = -271733879
  let c = -1732584194
  let d = 271733878

  for (let i = 0; i < words.length; i += 16) {
    const olda = a
    const oldb = b
    const oldc = c
    const oldd = d

    const w0 = words[i + 0] ?? 0
    const w1 = words[i + 1] ?? 0
    const w2 = words[i + 2] ?? 0
    const w3 = words[i + 3] ?? 0
    const w4 = words[i + 4] ?? 0
    const w5 = words[i + 5] ?? 0
    const w6 = words[i + 6] ?? 0
    const w7 = words[i + 7] ?? 0
    const w8 = words[i + 8] ?? 0
    const w9 = words[i + 9] ?? 0
    const w10 = words[i + 10] ?? 0
    const w11 = words[i + 11] ?? 0
    const w12 = words[i + 12] ?? 0
    const w13 = words[i + 13] ?? 0
    const w14 = words[i + 14] ?? 0
    const w15 = words[i + 15] ?? 0

    a = md5ff(a, b, c, d, w0, 7, -680876936)
    d = md5ff(d, a, b, c, w1, 12, -389564586)
    c = md5ff(c, d, a, b, w2, 17, 606105819)
    b = md5ff(b, c, d, a, w3, 22, -1044525330)
    a = md5ff(a, b, c, d, w4, 7, -176418897)
    d = md5ff(d, a, b, c, w5, 12, 1200080426)
    c = md5ff(c, d, a, b, w6, 17, -1473231341)
    b = md5ff(b, c, d, a, w7, 22, -45705983)
    a = md5ff(a, b, c, d, w8, 7, 1770035416)
    d = md5ff(d, a, b, c, w9, 12, -1958414417)
    c = md5ff(c, d, a, b, w10, 17, -42063)
    b = md5ff(b, c, d, a, w11, 22, -1990404162)
    a = md5ff(a, b, c, d, w12, 7, 1804603682)
    d = md5ff(d, a, b, c, w13, 12, -40341101)
    c = md5ff(c, d, a, b, w14, 17, -1502002290)
    b = md5ff(b, c, d, a, w15, 22, 1236535329)

    a = md5gg(a, b, c, d, w1, 5, -165796510)
    d = md5gg(d, a, b, c, w6, 9, -1069501632)
    c = md5gg(c, d, a, b, w11, 14, 643717713)
    b = md5gg(b, c, d, a, w0, 20, -373897302)
    a = md5gg(a, b, c, d, w5, 5, -701558691)
    d = md5gg(d, a, b, c, w10, 9, 38016083)
    c = md5gg(c, d, a, b, w15, 14, -660478335)
    b = md5gg(b, c, d, a, w4, 20, -405537848)
    a = md5gg(a, b, c, d, w9, 5, 568446438)
    d = md5gg(d, a, b, c, w14, 9, -1019803690)
    c = md5gg(c, d, a, b, w3, 14, -187363961)
    b = md5gg(b, c, d, a, w8, 20, 1163531501)
    a = md5gg(a, b, c, d, w13, 5, -1444681467)
    d = md5gg(d, a, b, c, w2, 9, -51403784)
    c = md5gg(c, d, a, b, w7, 14, 1735328473)
    b = md5gg(b, c, d, a, w12, 20, -1926607734)

    a = md5hh(a, b, c, d, w5, 4, -378558)
    d = md5hh(d, a, b, c, w8, 11, -2022574463)
    c = md5hh(c, d, a, b, w11, 16, 1839030562)
    b = md5hh(b, c, d, a, w14, 23, -35309556)
    a = md5hh(a, b, c, d, w1, 4, -1530992060)
    d = md5hh(d, a, b, c, w4, 11, 1272893353)
    c = md5hh(c, d, a, b, w7, 16, -155497632)
    b = md5hh(b, c, d, a, w10, 23, -1094730640)
    a = md5hh(a, b, c, d, w13, 4, 681279174)
    d = md5hh(d, a, b, c, w0, 11, -358537222)
    c = md5hh(c, d, a, b, w3, 16, -722521979)
    b = md5hh(b, c, d, a, w6, 23, 76029189)
    a = md5hh(a, b, c, d, w9, 4, -640364487)
    d = md5hh(d, a, b, c, w12, 11, -421815835)
    c = md5hh(c, d, a, b, w15, 16, 530742520)
    b = md5hh(b, c, d, a, w2, 23, -995338651)

    a = md5ii(a, b, c, d, w0, 6, -198630844)
    d = md5ii(d, a, b, c, w7, 10, 1126891415)
    c = md5ii(c, d, a, b, w14, 15, -1416354905)
    b = md5ii(b, c, d, a, w5, 21, -57434055)
    a = md5ii(a, b, c, d, w12, 6, 1700485571)
    d = md5ii(d, a, b, c, w3, 10, -1894986606)
    c = md5ii(c, d, a, b, w10, 15, -1051523)
    b = md5ii(b, c, d, a, w1, 21, -2054922799)
    a = md5ii(a, b, c, d, w8, 6, 1873313359)
    d = md5ii(d, a, b, c, w15, 10, -30611744)
    c = md5ii(c, d, a, b, w6, 15, -1560198380)
    b = md5ii(b, c, d, a, w13, 21, 1309151649)
    a = md5ii(a, b, c, d, w4, 6, -145523070)
    d = md5ii(d, a, b, c, w11, 10, -1120210379)
    c = md5ii(c, d, a, b, w2, 15, 718787259)
    b = md5ii(b, c, d, a, w9, 21, -343485551)

    a = safeAdd(a, olda)
    b = safeAdd(b, oldb)
    c = safeAdd(c, oldc)
    d = safeAdd(d, oldd)
  }

  const out = new Uint8Array(16)
  const state = [a, b, c, d]
  for (let i = 0; i < 16; i++) {
    const s = state[i >> 2] ?? 0
    out[i] = (s >>> ((i % 4) * 8)) & 0xff
  }
  return out
}

/**
 * Generates a deterministic RFC 4122 v3 UUID based on the username and optional password.
 * Matches backend `com.bear27570.app.util.UserUtil.generateDeterministicUserId`.
 */
export function generateDeterministicUserId(username: string, password?: string): string {
  if (!username) {
    throw new Error('Username cannot be empty')
  }
  const normalized = username.trim().toLowerCase()
  const pwd = password ?? ''
  const enc = new TextEncoder()
  const bytes = enc.encode(`ScoutingPro27:v1:${normalized}:${pwd}`)
  const digest = md5(bytes)

  // RFC 4122 v3: set version to 3 (0x30)
  const b6 = digest[6] ?? 0
  digest[6] = (b6 & 0x0f) | 0x30
  // RFC 4122: set variant to IETF (0x80)
  const b8 = digest[8] ?? 0
  digest[8] = (b8 & 0x3f) | 0x80

  const hex: string[] = []
  for (let i = 0; i < 16; i++) {
    const val = digest[i] ?? 0
    hex.push(val.toString(16).padStart(2, '0'))
  }

  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
}
