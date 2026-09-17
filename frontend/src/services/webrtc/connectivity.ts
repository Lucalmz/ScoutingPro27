import type { TransportType } from '@/types'

let lastSuccessfulProbeTime = 0
const PROBE_THROTTLE_MS = 20000 // 20秒节流窗口，避免高频 online/visibilitychange 频繁新建探测 WebSocket 增加公共 Broker 负担

export async function probePublicConnectivity(timeoutMs = 2500, bypassThrottle = false): Promise<boolean> {
  const now = Date.now()
  if (!bypassThrottle && now - lastSuccessfulProbeTime < PROBE_THROTTLE_MS) {
    return true
  }

  // 优先直接尝试对实际信令端点 wss://broker.emqx.io:8084/mqtt 做极短握手探测，确保真实端口可达
  if (typeof WebSocket !== 'undefined') {
    return new Promise((resolve) => {
      let resolved = false
      let ws: WebSocket | null = null
      let timer: NodeJS.Timeout | null = setTimeout(() => {
        done(false)
      }, timeoutMs)

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        if (ws) {
          ws.onopen = null
          ws.onerror = null
          ws.onclose = null
          try {
            ws.close()
          } catch {}
          ws = null
        }
      }

      const done = (ok: boolean) => {
        if (!resolved) {
          resolved = true
          if (ok) {
            lastSuccessfulProbeTime = Date.now()
          }
          cleanup()
          resolve(ok)
        }
      }

      try {
        ws = new WebSocket('wss://broker.emqx.io:8084/mqtt', ['mqtt'])
        ws.onopen = () => done(true)
        ws.onerror = () => done(false)
        ws.onclose = (ev) => {
          if (ev.wasClean || ev.code === 1000) done(true)
          else done(false)
        }
      } catch {
        done(false)
      }
    })
  }

  // Node 环境测试降级
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    await fetch('https://broker.emqx.io', { method: 'HEAD', mode: 'no-cors', signal: controller.signal })
    clearTimeout(timer)
    lastSuccessfulProbeTime = Date.now()
    return true
  } catch {
    return false
  }
}

/**
 * 读取构建期注入的 VITE_* 环境变量（与 src/config/features.ts 保持同一套约定）。
 * 测试/Node 环境下 import.meta.env 可能不存在，需容错。
 */
function readViteEnv(name: string): string | undefined {
  try {
    const env: any = typeof import.meta !== 'undefined' ? (import.meta as any).env : undefined
    const raw = env ? env[name] : undefined
    if (raw !== undefined && raw !== null && String(raw).trim() !== '') return String(raw).trim()
  } catch {}
  return undefined
}

/**
 * TURN 中继凭据。
 *
 * 中继是 IPv6/NAT 打洞全部失败后的唯一兜底通道，而 Metered.ca 的凭据是
 * **会过期/轮换的账号级令牌**，硬编码在源码里一旦失效，
 * `iceTransportPolicy:"relay"` 的重建将收集不到任何候选、永远连不上。
 * 因此这里允许通过 VITE_TURN_* 在构建期覆盖，默认值仅作开发兜底。
 */
const TURN_HOST = readViteEnv('VITE_TURN_HOST') || 'global.relay.metered.ca'
const TURN_USERNAME = readViteEnv('VITE_TURN_USERNAME') || 'ac2f17ce5be760e70209a1da'
const TURN_CREDENTIAL = readViteEnv('VITE_TURN_CREDENTIAL') || 'hnCbsBr54qxItqgo'

const TURN_ENTRY = TURN_USERNAME && TURN_CREDENTIAL
  ? { username: TURN_USERNAME, credential: TURN_CREDENTIAL }
  : undefined

export const STUN_SERVERS: RTCConfiguration = {
  iceServers: [
    // 1. Cloudflare Anycast STUN（全球 Anycast、低延迟双栈）
    {
      urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53']
    },
    // 2. Google STUN（全球 Anycast 冗余节点）
    {
      urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']
    },
    // 3. 国内主流 Anycast STUN（腾讯、小米、哔哩哔哩，全网极低延迟、零丢包、支持 IPv4/IPv6 双栈）
    {
      urls: [
        'stun:stun.qq.com:3478',
        'stun:stun.miwifi.com:3478',
        'stun:stun.chat.bilibili.com:3478'
      ]
    },
    // 4. Metered STUN
    {
      urls: 'stun:stun.relay.metered.ca:80'
    },
    // 4. TURN 备用中继（对称型 NAT 且无法通过 IPv6 直连时的兜底代理）
    {
      urls: `turn:${TURN_HOST}:80`,
      ...TURN_ENTRY
    },
    {
      urls: `turn:${TURN_HOST}:80?transport=tcp`,
      ...TURN_ENTRY
    },
    {
      urls: `turn:${TURN_HOST}:443`,
      ...TURN_ENTRY
    },
    {
      urls: `turns:${TURN_HOST}:443?transport=tcp`,
      ...TURN_ENTRY
    }
  ],
  iceCandidatePoolSize: 2
}

/**
 * 剥离 IPv6 地址上的 zone-id (RFC 6874，如 `fe80::1%eth0` / `fe80::1%25eth0`)
 * 与 SDP/Stats 中偶发出现的方括号包裹形式 (如 `[2408::1]`)。
 * 旧实现直接用 /^[0-9a-f:]+$/ 校验，导致所有带 zone-id 的链路本地候选被误判为“非 IPv6”。
 */
export function stripIpv6ZoneAndBrackets(ip: string): string {
  if (!ip || typeof ip !== 'string') return ''
  let s = ip.trim()
  const pct = s.indexOf('%')
  if (pct !== -1) s = s.slice(0, pct)
  if (s.length > 1 && s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  return s.toLowerCase()
}

/**
 * 解析首个十六进制位组 (hextet) 的数值。
 * 必须补齐前导零后再比较：`2::1` == `0002::1`，并不属于 2000::/3。
 */
function firstHextet(body: string): number | null {
  const m = /^([0-9a-f]{1,4})(?::|$)/i.exec(body)
  const token = m?.[1]
  if (!token) return null
  return parseInt(token, 16)
}

/**
 * 解析第二个 hextet；对 `2001::x` 这类压缩写法返回 0 (即 2001:0000:...)。
 */
function secondHextet(body: string): number | null {
  const idx = body.indexOf(':')
  if (idx === -1) return null
  const rest = body.slice(idx + 1)
  if (rest === '') return null
  const nextIdx = rest.indexOf(':')
  const token = nextIdx === -1 ? rest : rest.slice(0, nextIdx)
  if (token === '') return 0 // "2001::" -> 2001:0000:...
  if (!/^[0-9a-f]{1,4}$/i.test(token)) return null
  return parseInt(token, 16)
}

/**
 * 校验是否为合法的公网全球单播 IPv6 地址 (Global Unicast Address, 2000::/3)
 *
 * 采用「先归一化再按位掩码比对」的方式，取代原先的前缀字符串匹配：
 * 前缀匹配无法处理省略前导零的写法 (2::1 / 23::1 / 234::1 曾被误判为 GUA)，
 * 也会漏掉大小写与压缩形式的差异。
 */
export function isGlobalIpv6Address(ip: string): boolean {
  if (!ip || typeof ip !== 'string') return false
  const clean = stripIpv6ZoneAndBrackets(ip)
  if (!clean.includes(':')) return false
  if (!/^[0-9a-f:.]+$/.test(clean)) return false

  const h1 = firstHextet(clean)
  if (h1 === null) {
    // 以 "::" 开头的压缩地址 (环回 / 未指定 / IPv4-mapped / NAT64) 一律不是 GUA
    return false
  }
  const h2 = secondHextet(clean)

  // 环回 ::1 与未指定 ::
  if (clean === '::1' || clean === '::') return false

  // 组播 ff00::/8
  if ((h1 & 0xff00) === 0xff00) return false
  // 链路本地 fe80::/10
  if ((h1 & 0xffc0) === 0xfe80) return false
  // 唯一本地 ULA fc00::/7
  if ((h1 & 0xfe00) === 0xfc00) return false
  // 丢弃专用段 100::/64 (RFC 6666)
  if (h1 === 0x0100 && (h2 === 0 || h2 === null)) return false
  // NAT64 知名前缀 64:ff9b::/96 (RFC 6052)
  if (h1 === 0x0064 && h2 === 0xff9b) return false
  // 6to4 过渡前缀 2002::/16
  if (h1 === 0x2002) return false

  if (h1 === 0x2001 && h2 !== null) {
    if (h2 === 0x0000) return false // Teredo 2001::/32
    if (h2 === 0x0db8) return false // 文档保留 2001:db8::/32
    if (h2 === 0x0002) return false // 基准测试 2001:2::/48
    if ((h2 & 0xfff0) === 0x0010) return false // ORCHID 2001:10::/28
    if ((h2 & 0xfff0) === 0x0020) return false // ORCHIDv2 2001:20::/28
  }

  // 全球单播前缀 2000::/3 —— 首 hextet 数值必须落在 0x2000..0x3fff
  return h1 >= 0x2000 && h1 <= 0x3fff
}

/**
 * 校验是否为任意有效 IPv6 地址 (含带 zone-id 的链路本地地址，如 `fe80::1%eth0`)
 */
export function isIpv6Address(ip: string): boolean {
  if (!ip || typeof ip !== 'string') return false
  const clean = stripIpv6ZoneAndBrackets(ip)
  return clean.includes(':') && /^[0-9a-f:.]+$/.test(clean)
}

/**
 * Chrome/Safari 出于隐私会把局域网 host 候选混淆为 mDNS 名 (`<uuid>.local`)，
 * getStats() 里也只会看到该主机名而非 IP。
 */
export function isMdnsCandidateHostname(host: string): boolean {
  if (!host || typeof host !== 'string') return false
  return /\.local$/i.test(host.trim())
}

/**
 * 判断一个 stats/候选里的地址字段是否“不可用”（空、被浏览器打码、或 mDNS 名）。
 */
function isUnusableAddress(addr: string): boolean {
  if (!addr) return true
  const clean = addr.trim()
  if (!clean) return true
  if (clean === '0.0.0.0' || clean === '::' || clean === '[::]') return true
  if (isMdnsCandidateHostname(clean)) return true
  return false
}

/**
 * 检查 IPv4 地址是否为私有局域网/保留地址 (RFC 1918 / 环回 / 链路本地)
 */
export function isPrivateIpv4Address(ip: string): boolean {
  if (!ip || typeof ip !== 'string') return false
  const clean = ip.trim()
  return (
    clean.startsWith('10.') ||
    clean.startsWith('192.168.') ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(clean) ||
    clean.startsWith('127.') ||
    clean.startsWith('169.254.')
  )
}

/**
 * RFC 8445 candidate 属性结构：
 *   candidate:foundation component protocol priority connection-address port typ <type> [ext...]
 * 统一在此解析，避免各处重复用魔法下标 (parts[3]/parts[4]) 取值。
 */
export interface ParsedIceCandidate {
  hasPrefix: boolean
  parts: string[]
  foundation: string
  component: number
  protocol: string
  priority: string
  address: string
  port: string
  type: string
}

export function parseIceCandidate(candidateStr: string): ParsedIceCandidate | null {
  if (!candidateStr || typeof candidateStr !== 'string') return null
  const trimmed = candidateStr.trim()
  const hasPrefix = trimmed.startsWith('candidate:')
  const cleanStr = hasPrefix ? trimmed.slice('candidate:'.length).trim() : trimmed
  const parts = cleanStr.split(/\s+/)
  // foundation component protocol priority address port typ <type> => 至少 8 段才是完整候选
  if (parts.length < 8) return null

  const typeIndex = parts.indexOf('typ')
  const typeToken = typeIndex !== -1 ? parts[typeIndex + 1] : undefined
  const type = typeToken ? typeToken.toLowerCase() : ''

  return {
    hasPrefix,
    parts,
    foundation: parts[0] || '',
    component: parseInt(parts[1] || '1', 10) || 1,
    protocol: (parts[2] || '').toLowerCase(),
    priority: parts[3] || '',
    address: stripIpv6ZoneAndBrackets(parts[4] || ''),
    port: parts[5] || '',
    type
  }
}

/**
 * 根据 RFC 8445 计算重写 candidate 优先级，实现 IPv6 打洞优先：
 * priority = (2^24)*(type-preference) + (2^8)*(local-preference) + (256 - component)
 *
 * 重要约束：**只重写 UDP 候选**。
 * RFC 6544 (TCP Candidates with ICE) 要求 TCP 候选必须被降权；旧实现把
 * `typ host tcptype active` 的 IPv6 TCP 候选也拉到与 IPv6 UDP host 完全相同的
 * 2130706431，会让 ICE 在 pair priority 打平时可能提名一条 TCP 链路
 * （DataChannel 退化为 TCP，队头阻塞、时延剧增，甚至因端口被过滤直接失败）。
 */
export function optimizeCandidatePriority(candidateStr: string): string {
  if (!candidateStr || typeof candidateStr !== 'string') return candidateStr
  try {
    const parsed = parseIceCandidate(candidateStr)
    if (!parsed) return candidateStr

    // TCP / TLS 候选保持浏览器原生（已按 RFC 6544 降权）的优先级，绝不提权
    if (parsed.protocol !== 'udp') return candidateStr
    if (!parsed.address || !isGlobalIpv6Address(parsed.address)) return candidateStr

    let typePref = 0
    if (parsed.type === 'host') typePref = 126
    else if (parsed.type === 'prflx') typePref = 110
    else if (parsed.type === 'srflx') typePref = 100
    else if (parsed.type === 'relay') typePref = 0

    if (typePref <= 0) return candidateStr

    const boostedPriority = typePref * 16777216 + 65535 * 256 + (256 - parsed.component)
    const parts = [...parsed.parts]
    parts[3] = String(boostedPriority)
    const joined = parts.join(' ')
    return parsed.hasPrefix ? `candidate:${joined}` : joined
  } catch (err) {
    console.warn('[WebRTC] optimizeCandidatePriority parsing anomaly, keeping original candidate:', err)
  }

  return candidateStr
}

/**
 * 调整 SDP 内所有 a=candidate: 行的优先级，确保发出的 Offer/Answer 中的 IPv6 具备最高优先级
 */
export function optimizeSdpCandidates(sdp: string): string {
  if (!sdp || typeof sdp !== 'string') return sdp
  try {
    return sdp
      .split(/\r\n|\n/)
      .map((line) => {
        if (line.startsWith('a=candidate:')) {
          const optimized = optimizeCandidatePriority(line.slice(2))
          return `a=${optimized}`
        }
        return line
      })
      .join('\r\n')
  } catch (err) {
    console.warn('[WebRTC] SDP candidate priority rewriting failed, falling back to original SDP:', err)
    return sdp
  }
}

/**
 * 对收集或接收到的 ICE 候选列表排序，确保 IPv6 候选优先被加入和探测。
 *
 * 注意：排序依据的是候选**明文**里的 `candidate` 字段。调用方必须先解密再排序，
 * 否则密文载荷 ({ciphertext,iv,tag}) 上取不到 candidate 字段，排序会整体退化为 no-op。
 * 同时把 TCP 候选压到同族最后（RFC 6544），避免 TCP 抢在 UDP 之前被 add。
 */
export function sortCandidatesPreferIpv6<T extends { candidate?: string }>(candidates: T[]): T[] {
  return [...candidates].sort((a, b) => {
    return scoreCandidate(b?.candidate || '') - scoreCandidate(a?.candidate || '')
  })
}

function scoreCandidate(c: string): number {
  const parsed = parseIceCandidate(c)
  if (!parsed) return 0

  let familyScore: number
  if (isGlobalIpv6Address(parsed.address)) {
    if (parsed.type === 'host') familyScore = 100
    else if (parsed.type === 'srflx') familyScore = 90
    else familyScore = 80
  } else if (isIpv6Address(parsed.address)) {
    familyScore = 70
  } else if (parsed.type === 'host') {
    familyScore = 50
  } else if (parsed.type === 'srflx') {
    familyScore = 40
  } else if (parsed.type === 'relay') {
    familyScore = 10
  } else {
    familyScore = 20
  }

  // 协议是首要排序键：RFC 6544 要求 TCP 候选整体劣后于 UDP，
  // 因此任何 TCP 候选都排在所有 UDP 候选之后，避免 TCP 抢占 IPv6 UDP 直连。
  const protocolPenalty = parsed.protocol === 'udp' ? 0 : 1000
  return familyScore - protocolPenalty
}

/**
 * 根据 active candidate pair 分类实际连接传输链路类型。
 *
 * 修复点：
 *  1. 地址缺失 / 被浏览器打码 (0.0.0.0、::) 时返回 'unknown'，
 *     而不是谎报成 'nat_p2p'（旧实现空串也会一路落到 nat_p2p）。
 *  2. 识别 Chrome/Safari 的 mDNS 混淆主机名 (`<uuid>.local`)：
 *     两侧都是 host 候选且都是 .local 名时，这就是同局域网直连，应报 'lan_p2p'。
 *  3. 地址统一做 zone-id / 方括号归一化后再判定。
 */
export function classifyCandidatePair(
  localCandType: string,
  remoteCandType: string,
  localIp: string,
  remoteIp: string
): TransportType {
  const isRelay = localCandType === 'relay' || remoteCandType === 'relay'
  if (isRelay) return 'relay'

  const localRaw = (localIp || '').trim()
  const remoteRaw = (remoteIp || '').trim()
  const local = stripIpv6ZoneAndBrackets(localRaw)
  const remote = stripIpv6ZoneAndBrackets(remoteRaw)
  const bothHost = localCandType === 'host' && remoteCandType === 'host'

  // 任一侧地址不可用时不要臆断链路类型
  const localUsable = !isUnusableAddress(localRaw)
  const remoteUsable = !isUnusableAddress(remoteRaw)
  if (!localUsable || !remoteUsable) {
    // mDNS 双 host 是明确可判定的局域网直连，属于例外
    if (bothHost && isMdnsCandidateHostname(localRaw) && isMdnsCandidateHostname(remoteRaw)) {
      return 'lan_p2p'
    }
    // 仅剩一侧可判定为公网 IPv6 时仍可确认是 IPv6 直连
    if (isGlobalIpv6Address(local) || isGlobalIpv6Address(remote)) return 'ipv6_p2p'
    return 'unknown'
  }

  const hasGlobalIpv6 = isGlobalIpv6Address(local) || isGlobalIpv6Address(remote)
  if (hasGlobalIpv6) {
    return 'ipv6_p2p'
  }

  const isLocalLan = isPrivateIpv4Address(local) && isPrivateIpv4Address(remote) && bothHost
  if (isLocalLan) {
    return 'lan_p2p'
  }

  if (isIpv6Address(local) || isIpv6Address(remote)) {
    return 'ipv6_p2p'
  }

  return 'nat_p2p'
}
