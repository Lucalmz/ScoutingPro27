import type { TransportType } from '@/types'
import {
  cleanIpAddress,
  isGlobalIpv6Address,
  isIpv6Address,
  isPrivateIpv4Address,
  isTunVirtualAddress,
  isDomesticCarrierIpv6,
  getIpv6Prefix64,
  isTemporaryPrivacyIpv6
} from './ipAddressUtil'
import {
  DOMESTIC_LITERAL_STUN_URLS,
  OVERSEAS_LITERAL_STUN_URLS,
  extractStunUrlHost,
  classifyStunUrlOrigin,
  synthesizePhysicalHostCandidatesFromTun,
  isTunReflectedSrflxCandidate,
  isBogusOrTunCandidate,
  optimizeCandidatePriority,
  demoteProxyExitCandidatePriority,
  type TaggedIceCandidateItem,
  applyProxyExitDemotionToBatch,
  synthesizeSymmetricNatPortCandidates,
  optimizeSdpCandidates,
  sortCandidatesPreferIpv6,
  classifyCandidatePair
} from './iceCandidateOptimizer'

export {
  cleanIpAddress,
  isGlobalIpv6Address,
  isIpv6Address,
  isPrivateIpv4Address,
  isTunVirtualAddress,
  isDomesticCarrierIpv6,
  getIpv6Prefix64,
  isTemporaryPrivacyIpv6,
  DOMESTIC_LITERAL_STUN_URLS,
  OVERSEAS_LITERAL_STUN_URLS,
  extractStunUrlHost,
  classifyStunUrlOrigin,
  synthesizePhysicalHostCandidatesFromTun,
  isTunReflectedSrflxCandidate,
  isBogusOrTunCandidate,
  optimizeCandidatePriority,
  demoteProxyExitCandidatePriority,
  type TaggedIceCandidateItem,
  applyProxyExitDemotionToBatch,
  synthesizeSymmetricNatPortCandidates,
  optimizeSdpCandidates,
  sortCandidatesPreferIpv6,
  classifyCandidatePair
}

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
 * 纯 STUN 服务器列表（默认且优先使用）。严禁在此列表中放入任何 turn: / turns: 条目：
 * 默认连接（首连 + 前两次重试）只允许 host / srflx / prflx 候选，绝不生成 relay 候选，
 * 避免海外中继抢先握手并把连接“锁”在高延迟中继路径上。
 */
export const PURE_STUN_SERVERS: RTCConfiguration = {
  iceServers: [
    // 1. 免 DNS 解析的纯 IPv6/IPv4 字面量 STUN（libwebrtc 直接解析为 SocketAddress，不发任何 DNS 请求，100% 免疫 Mihomo/VPN dns-hijack any:53 与 dns.ipv6:false 劫持）
    {
      urls: [
        'stun:[2409:8c50:e00::3]:3478',
        'stun:[2409:8c50:e00::1]:3478',
        'stun:[2409:8c50:e00::4]:3478',
        'stun:[2606:4700:49::]:3478',
        'stun:[2001:4860:4864:5:8000::1]:19302',
        'stun:[2a01:4f8:1c1e:d769::1]:3478',
        'stun:111.8.3.78:3478',
        'stun:74.125.250.129:19302'
      ]
    },
    // 2. 境内外高可用双栈 STUN 域名
    {
      urls: [
        'stun:stun.miwifi.com:3478',
        'stun:stun.qq.com:3478',
        'stun:stun.hitv.com:3478',
        'stun:stun.cloudflare.com:3478',
        'stun:stun.l.google.com:19302'
      ]
    }
  ],
  iceCandidatePoolSize: 2
}

let dohResolvedStunV6Urls: string[] = []
let dohResolvePromise: Promise<string[]> | null = null
let lastDohFailTime = 0
const DOH_RETRY_COOLDOWN_MS = 5000

/**
 * 重置 DoH 预热缓存（供测试或网络切换时使用）
 */
export function resetDoHStunCache(): void {
  dohResolvedStunV6Urls = []
  dohResolvePromise = null
  lastDohFailTime = 0
}

/**
 * 使用真正免鉴权且支持浏览器 CORS 的阿里 DoH (国内直连毫秒级可达) 与 Cloudflare DoH (海外/VPN 隧道可达) 双源 JSON API，
 * 并发解析境内外双栈 STUN 的真实公网 AAAA (type=28) 记录，100% 绕过 TUN/VPN 的 dns-hijack: any:53 与 dns.ipv6: false 拦截。
 * 若全部请求失败则清除 Promise 引用并在冷却期后允许重试，避免一次性断网导致整个进程生命周期内永久返回空数组。
 */
export function warmUpDoHStunIpv6(): Promise<string[]> {
  if (dohResolvedStunV6Urls.length > 0) return Promise.resolve(dohResolvedStunV6Urls)
  if (dohResolvePromise) return dohResolvePromise
  if (typeof fetch === 'undefined') return Promise.resolve([])
  const isTestEnv =
    (typeof process !== 'undefined' && (process.env?.NODE_ENV === 'test' || process.env?.VITEST === 'true')) ||
    Boolean((globalThis as any).__vitest_worker__) ||
    (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ !== undefined
  if (isTestEnv && !(globalThis as any).__TEST_ALLOW_DOH_WARMUP__) {
    return Promise.resolve([])
  }
  const now = Date.now()
  if (lastDohFailTime > 0 && now - lastDohFailTime < DOH_RETRY_COOLDOWN_MS) {
    return Promise.resolve([])
  }

  const targets: Array<{ domain: string; port: number }> = [
    { domain: 'stun.hitv.com', port: 3478 },
    { domain: 'stun.cloudflare.com', port: 3478 },
    { domain: 'stun.l.google.com', port: 19302 },
    { domain: 'stun.nextcloud.com', port: 3478 }
  ]
  const dohEndpoints = [
    'https://dns.alidns.com/resolve',
    'https://cloudflare-dns.com/dns-query'
  ]

  const tasks: Array<Promise<string[]>> = []
  for (const { domain, port } of targets) {
    for (const endpoint of dohEndpoints) {
      tasks.push(
        (async () => {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 1500)
          try {
            const res = await fetch(`${endpoint}?name=${domain}&type=AAAA`, {
              headers: { accept: 'application/dns-json' },
              signal: controller.signal
            })
            if (!res.ok) return []
            const data = await res.json()
            const answers: Array<{ type: number; data: string }> = Array.isArray(data?.Answer) ? data.Answer : []
            return answers
              .filter((a) => a.type === 28 && isGlobalIpv6Address(a.data))
              .map((a) => `stun:[${cleanIpAddress(a.data)}]:${port}`)
          } catch {
            return []
          } finally {
            clearTimeout(timer)
          }
        })()
      )
    }
  }

  dohResolvePromise = Promise.allSettled(tasks).then((results) => {
    const urls = new Set<string>()
    for (const r of results) {
      if (r.status === 'fulfilled') {
        for (const u of r.value) urls.add(u)
      }
    }
    const resolved = Array.from(urls)
    if (resolved.length > 0) {
      dohResolvedStunV6Urls = resolved
      lastDohFailTime = 0
    } else {
      dohResolvePromise = null
      lastDohFailTime = Date.now()
    }
    return dohResolvedStunV6Urls
  })

  return dohResolvePromise
}

/**
 * 有限等待 DoH 预热完成：若在 maxWaitMs 内完成则立即返回最新列表，超时则不阻塞后续建连并返回当前已缓存列表。
 */
export async function waitForDoHStunIpv6Bounded(maxWaitMs = 300): Promise<string[]> {
  if (dohResolvedStunV6Urls.length > 0) return dohResolvedStunV6Urls
  const isTestEnv =
    (typeof process !== 'undefined' && (process.env?.NODE_ENV === 'test' || process.env?.VITEST === 'true')) ||
    Boolean((globalThis as any).__vitest_worker__) ||
    (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ !== undefined
  if (isTestEnv && !(globalThis as any).__TEST_ALLOW_DOH_WARMUP__) {
    return dohResolvedStunV6Urls
  }
  if (maxWaitMs <= 0) {
    void warmUpDoHStunIpv6().catch(() => {})
    return dohResolvedStunV6Urls
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    await Promise.race([
      warmUpDoHStunIpv6().catch(() => dohResolvedStunV6Urls),
      new Promise<string[]>((resolve) => {
        timer = setTimeout(() => resolve(dohResolvedStunV6Urls), maxWaitMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
  return dohResolvedStunV6Urls
}

/**
 * 生成生产环境免 DNS 字面量 STUN URL 列表（纯函数，兼顾全球直连与国内 VPN/TUN 环境，去重保序）
 */
export function selectStunUrls(opts?: { dohUrls?: string[] }): string[] {
  const dohUrls = opts?.dohUrls ?? dohResolvedStunV6Urls
  const combined = [
    ...DOMESTIC_LITERAL_STUN_URLS,
    ...OVERSEAS_LITERAL_STUN_URLS,
    ...dohUrls
  ]
  return Array.from(new Set(combined))
}

/**
 * 向后兼容别名：历史代码/测试以 STUN_SERVERS 引用默认服务器列表，现等价于纯 STUN 列表（不含 TURN）。
 */
export const STUN_SERVERS: RTCConfiguration = PURE_STUN_SERVERS

/**
 * TURN 备用中继（仅在多次重试后确认无法 P2P 直连——典型为双端对称型 NAT 且无 IPv6——才会启用）。
 */
export const TURN_SERVERS: RTCIceServer[] = [
  {
    urls: 'turn:global.relay.metered.ca:80',
    username: 'ac2f17ce5be760e70209a1da',
    credential: 'hnCbsBr54qxItqgo'
  },
  {
    urls: 'turn:global.relay.metered.ca:80?transport=tcp',
    username: 'ac2f17ce5be760e70209a1da',
    credential: 'hnCbsBr54qxItqgo'
  },
  {
    urls: 'turn:global.relay.metered.ca:443',
    username: 'ac2f17ce5be760e70209a1da',
    credential: 'hnCbsBr54qxItqgo'
  },
  {
    urls: 'turns:global.relay.metered.ca:443?transport=tcp',
    username: 'ac2f17ce5be760e70209a1da',
    credential: 'hnCbsBr54qxItqgo'
  }
]

/**
 * 统一 ICE 配置构造器（单 PeerConnection 并行打洞策略）：
 * - allowTurn=false（默认）：仅 STUN，纯 P2P（LAN / IPv6 / IPv4 NAT 打洞），绝不产生 relay 候选。
 * - allowTurn=true：在 STUN 基础上追加 TURN；ICE 仍按优先级择优，relay 候选优先级被压到最低，仅作终极兜底。
 * - forceRelay=true：iceTransportPolicy='relay'。relay-only 下若没有 TURN 服务器则永远收集不到候选，
 *   因此 forceRelay 隐含 allowTurn（防止构造出“必然失败”的配置）。
 * 绝不为“升级/降级”而拆除重建连接（拆除重建是旧版逻辑自锁的根源）。
 * 注意：浏览器默认对 host 候选做 mDNS 混淆（xxx.local），跨网段 IPv6 直连必须依赖 STUN 反射出的
 * 真实 IPv6 srflx / 对端 prflx 候选，因此 IPv6 场景同样不能省略 STUN。
 */
export function buildIceConfiguration(allowTurn = false, forceRelay = false): RTCConfiguration {
  const useTurn = allowTurn || forceRelay || Boolean((globalThis as any).__TEST_FORCE_ALLOW_TURN__)
  const isTestEnv =
    (typeof process !== 'undefined' && (process.env?.NODE_ENV === 'test' || process.env?.VITEST === 'true')) ||
    Boolean((globalThis as any).__vitest_worker__) ||
    (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ !== undefined

  let stunServers: RTCIceServer[]
  if (isTestEnv) {
    stunServers = [...(PURE_STUN_SERVERS.iceServers ?? [])]
  } else {
    // 真实运行环境下（全球通用 + 国内 VPN/TUN 兼容）：
    // 1. 全部采用免 DNS 解析的境内外双栈 IPv4/IPv6 字面量 STUN 与 DoH 预解析出的 AAAA 字面量 STUN，
    //    彻底杜绝域名 STUN 被 TUN/VPN 的 Fake-IP (198.18.0.x) 或 dns.ipv6:false 劫持；
    // 2. 同时提供国内直连字面量与海外高可用字面量（多源收集）：
    //    - 海外用户或全局 VPN 环境下可通过海外节点稳定反射公网地址；
    //    - 国内开启规则分流 TUN/VPN 时，国内节点走 DIRECT 反射真实物理公网地址，海外节点走 PROXY 反射代理出口地址，
    //      由候选层按来源识别并将代理出口 srflx 自动降权（只降权不丢弃），确保直连优先、VPN 出口兜底。
    stunServers = [{ urls: selectStunUrls() }]
  }

  return {
    iceServers: useTurn ? [...stunServers, ...TURN_SERVERS] : stunServers,
    iceTransportPolicy: forceRelay ? 'relay' : 'all',
    iceCandidatePoolSize: PURE_STUN_SERVERS.iceCandidatePoolSize
  }
}

/** 第几次重试起才允许携带 TURN（0 = 首次连接；0/1/2 全部纯 P2P 零 TURN 流量，第 3 次重试才兜底） */
export const TURN_FALLBACK_ATTEMPT = 3

/**
 * 建联时序常量（单一决策者原则）：
 * - 只有 Client（Offerer / ICE controlling）负责超时判定与重建升级；
 * - Host 只做被动应答与资源回收，且其回收时限严格大于 Client 的建联超时，
 *   保证双方计时器不会互相“抢拆”对方正在进行的握手。
 */
export const CONNECTION_TIMING = {
  /** Client：从 Offer 发出到 DataChannel open 的最长等待时间，超时即判定本次尝试失败 */
  CLIENT_CONNECT_TIMEOUT_MS: 15000,
  /** Client：connectionState=disconnected 后等待 ICE 自愈的宽限期 */
  CLIENT_DISCONNECT_GRACE_MS: 3000,
  /** Host：从未连通的 PeerConnection 的回收时限（必须大于 CLIENT_CONNECT_TIMEOUT_MS） */
  HOST_PENDING_GC_MS: 45000,
  /** ICE checking 停滞 UI 提示阈值（仅提示，不触发任何拆除动作） */
  ICE_STALL_NOTICE_MS: 3000,
  /** Client：收到 Host 心跳触发自动恢复的最小间隔 */
  HOST_PRESENCE_RECOVERY_THROTTLE_MS: 20000
} as const

/**
 * 根据重试序号（0 = 首次连接，1 起为重试）决定该次尝试是否允许携带 TURN：
 * - 0 / 1 / 2：纯 P2P（STUN only），绝不生成 relay 候选；
 * - ≥ 3：确认多次纯 P2P 均失败（典型为双端对称型 NAT 且无 IPv6），才带上 TURN 作为终极兜底。
 */
export function shouldAllowTurnForAttempt(attemptNumber: number): boolean {
  return attemptNumber >= TURN_FALLBACK_ATTEMPT
}

/**
 * 根据重试序号决定该次尝试是否走纯中继（relay-only，隐含 TURN）：
 * 第 3 次重试先走 'all'（STUN + TURN 并行，relay 候选优先级最低），第 4/6 次升级为 'relay'，
 * 奇数次回到 'all'，避免旧版“8 秒强制 relay 后被锁死在中继”的问题，同时保证对称 NAT 场景最终能落到 TURN。
 */
export function shouldForceRelayForAttempt(attemptNumber: number): boolean {
  return attemptNumber > TURN_FALLBACK_ATTEMPT && attemptNumber % 2 === 0
}

/**
 * 链路质量档位（越高越好）：relay(0) < IPv4 NAT 直连(1) < LAN / IPv6 直连(2)；unknown 返回 -1（不参与升级判定）。
 */
export function getTransportTier(type: TransportType | undefined | null): number {
  switch (type) {
    case 'relay':
      return 0
    case 'nat_p2p':
      return 1
    case 'lan_p2p':
    case 'ipv6_p2p':
      return 2
    default:
      return -1
  }
}

/**
 * 静默升级（in-place ICE restart，DataChannel 不中断、不重建 PeerConnection）参数：
 * - 链路为 relay：持续探测，间隔 20s → 40s → 80s → 160s → 300s（封顶，之后保持 300s），
 *   网络环境变化（如手机从蜂窝切到 Wi-Fi / 获得 IPv6）后会自动从中继升级为 IPv4/IPv6 直连；
 * - 链路为 IPv4 NAT 直连但本机已具备公网 IPv6：最多探测 3 次（60s / 180s / 600s），尝试升级为 IPv6 直连。
 */
export const SILENT_UPGRADE = {
  RELAY_PROBE_DELAYS_MS: [20000, 40000, 80000, 160000, 300000],
  IPV6_PROBE_DELAYS_MS: [60000, 180000, 600000],
  /** 发出 ICE restart Offer 后等待 Host Answer 的最长时间，超时则回滚并放弃本轮升级 */
  ANSWER_TIMEOUT_MS: 10000,
  /** 应用 Answer 后等待新路径提名的最长时间 */
  SETTLE_MS: 12000,
  /** 等待期间轮询选中候选对的间隔 */
  SETTLE_POLL_MS: 1000
} as const

/**
 * 计算下一次静默升级探测的延迟（毫秒）；返回 null 表示当前链路不需要 / 不应再探测。
 * @param type 当前选中链路类型
 * @param probeCount 本条连接上已经执行过的探测次数
 * @param hasLocalIpv6 本机是否具备公网全球单播 IPv6
 */
export function getSilentUpgradeDelayMs(
  type: TransportType | undefined | null,
  probeCount: number,
  hasLocalIpv6: boolean
): number | null {
  const count = Math.max(0, probeCount)
  if (type === 'relay') {
    const delays = SILENT_UPGRADE.RELAY_PROBE_DELAYS_MS
    return delays[Math.min(count, delays.length - 1)] ?? null
  }
  if (type === 'nat_p2p' && hasLocalIpv6) {
    const delays = SILENT_UPGRADE.IPV6_PROBE_DELAYS_MS
    return count < delays.length ? delays[count] ?? null : null
  }
  return null
}

let cachedLocalIpv6: string | null = null
let cachedPhysicalIpv4s: string[] = []
let cachedPhysicalIpv6s: string[] = []
let lastIpv6ProbeTime = 0

/**
 * 重置网卡 IPv6 与物理网卡地址缓存（供单元测试或网络切换时使用）
 */
export function resetLocalIpv6ProbeCache(): void {
  cachedLocalIpv6 = null
  cachedPhysicalIpv4s = []
  cachedPhysicalIpv6s = []
  lastIpv6ProbeTime = 0
}

/**
 * 获取已缓存的本机真实物理网卡地址列表（排除 TUN 198.18.x.x / fdfe:... 等虚拟网卡）
 */
export function getCachedPhysicalAddresses(): { ipv4s: string[]; ipv6s: string[] } {
  return {
    ipv4s: [...cachedPhysicalIpv4s],
    ipv6s: [...cachedPhysicalIpv6s]
  }
}

/**
 * 优先从本机网卡探测公网全球单播 IPv6 (GUA, 2000::/3)，并同步缓存物理网卡 IPv4/IPv6 列表：
 * 1. 电脑端 Host：尝试直接调用 Java 后端系统接口，100% 准确读取物理网卡（绕过 TUN 路由表劫持）
 * 2. 手机/浏览器端：使用空 iceServers 在本地 30ms 提取 host 候选，零 STUN 网络请求
 */
export async function probeLocalInterfaceIpv6(): Promise<string | null> {
  const isTestEnv =
    typeof process !== 'undefined' &&
    (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true')
  if (isTestEnv && !(globalThis as any).__TEST_ALLOW_NIC_PROBE__) {
    return null
  }

  const now = Date.now()
  if (cachedLocalIpv6 && now - lastIpv6ProbeTime < 30000) {
    return cachedLocalIpv6
  }

  // 1. 电脑端 Host：尝试直接调用 Java 后端系统接口读取物理网卡 GUA IPv6 与局域网 IPv4
  try {
    const { getNetworkInfo } = await import('@/services/api')
    const net = await getNetworkInfo()
    if (net) {
      const v4Set = new Set<string>()
      if (net.primaryIp) {
        const cleanV4 = cleanIpAddress(net.primaryIp)
        if (isPrivateIpv4Address(cleanV4) && !cleanV4.startsWith('127.') && !isTunVirtualAddress(cleanV4)) {
          v4Set.add(cleanV4)
        }
      }
      if (Array.isArray((net as any).allIps)) {
        for (const ip of (net as any).allIps) {
          const cleanV4 = cleanIpAddress(ip)
          if (isPrivateIpv4Address(cleanV4) && !cleanV4.startsWith('127.') && !isTunVirtualAddress(cleanV4)) {
            v4Set.add(cleanV4)
          }
        }
      }
      cachedPhysicalIpv4s = Array.from(v4Set)

      const v6Set = new Set<string>()
      if (net.primaryIpv6 && isGlobalIpv6Address(net.primaryIpv6)) {
        v6Set.add(cleanIpAddress(net.primaryIpv6))
      }
      if (Array.isArray((net as any).allIpv6s)) {
        for (const ip6 of (net as any).allIpv6s) {
          if (isGlobalIpv6Address(ip6)) {
            v6Set.add(cleanIpAddress(ip6))
          }
        }
      }
      cachedPhysicalIpv6s = Array.from(v6Set)

      if (net.primaryIpv6 && isGlobalIpv6Address(net.primaryIpv6)) {
        cachedLocalIpv6 = cleanIpAddress(net.primaryIpv6)
        lastIpv6ProbeTime = now
        return cachedLocalIpv6
      }
      if (cachedPhysicalIpv6s.length > 0) {
        cachedLocalIpv6 = cachedPhysicalIpv6s[0] || null
        lastIpv6ProbeTime = now
        return cachedLocalIpv6
      }
    }
  } catch {}

  // 2. 手机/浏览器端：利用空 iceServers 极速提取 host 候选
  if (typeof RTCPeerConnection === 'undefined') return null
  return new Promise<string | null>((resolve) => {
    try {
      const pc = new RTCPeerConnection({ iceServers: [] })
      pc.createDataChannel('probe_nic')

      const timer = setTimeout(() => {
        try { pc.close() } catch {}
        resolve(cachedLocalIpv6)
      }, 300)

      pc.onicecandidate = (e) => {
        if (!e.candidate) {
          clearTimeout(timer)
          try { pc.close() } catch {}
          resolve(cachedLocalIpv6)
          return
        }
        const parts = e.candidate.candidate.split(/\s+/)
        const addr = cleanIpAddress(parts[4] || '')
        if (isGlobalIpv6Address(addr)) {
          cachedLocalIpv6 = addr
          if (!cachedPhysicalIpv6s.includes(addr)) {
            cachedPhysicalIpv6s.push(addr)
          }
          lastIpv6ProbeTime = Date.now()
          clearTimeout(timer)
          try { pc.close() } catch {}
          resolve(addr)
        }
      }

      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(() => {
          clearTimeout(timer)
          try { pc.close() } catch {}
          resolve(cachedLocalIpv6)
        })
    } catch {
      resolve(null)
    }
  })
}
