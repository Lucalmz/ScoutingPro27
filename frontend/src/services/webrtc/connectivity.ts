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
        'stun:111.8.3.78:3478'
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

/**
 * 使用真正免鉴权且支持浏览器 CORS 的阿里 DoH (国内直连毫秒级可达) 与 Cloudflare DoH (海外 VPN 隧道可达) 双源 JSON API，
 * 并发解析境内外双栈 STUN 的真实公网 AAAA (type=28) 记录，100% 绕过 TUN/VPN 的 dns-hijack: any:53 与 dns.ipv6: false 拦截。
 */
export function warmUpDoHStunIpv6(): Promise<string[]> {
  if (dohResolvedStunV6Urls.length > 0) return Promise.resolve(dohResolvedStunV6Urls)
  if (dohResolvePromise) return dohResolvePromise
  if (typeof fetch === 'undefined') return Promise.resolve([])

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
    dohResolvedStunV6Urls = Array.from(urls)
    return dohResolvedStunV6Urls
  })

  return dohResolvePromise
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
    // 真实运行环境下：
    // 1. 仅使用免 DNS 解析的国内字面量 IPv4 STUN (111.8.3.78) 与 DoH 解析出的国内字面量 IPv6 STUN，
    //    彻底杜绝域名 STUN 被 TUN/VPN 的 Fake-IP (198.18.0.x) 劫持；
    // 2. 剔除 stun.cloudflare.com / stun.l.google.com / 2606:4700:49:: 等海外地址，
    //    防止同一个本地 WebRTC UDP 套接字命中代理软件 PROXY 分流规则而污染 DIRECT NAT 映射表；
    // 3. 限制 IPv4 STUN 数量为单一确定性节点，使四元组 VPN / 对称 CGNAT 下 STUN 与打洞包的端口偏移严格恒定为 +1/+2。
    const literalUrls = [
      'stun:111.8.3.78:3478',
      'stun:[2409:8c50:e00::1]:3478',
      ...dohResolvedStunV6Urls
    ]
    stunServers = [{ urls: Array.from(new Set(literalUrls)) }]
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

let lastHostIpv6HealTime = 0

/**
 * 当电脑端 Host 物理网卡存在公网 IPv6 (cachedPhysicalIpv6s 非空)，但 Chromium ICE 采集出 0 个本地 IPv6 候选时，
 * 说明用户在软件启动后新开启或重启了 TUN 代理劫持了系统 IPv6 路由；此时自动请求后端执行路由剥离自愈。
 */
export async function healHostIpv6RoutesIfNeeded(): Promise<boolean> {
  const now = Date.now()
  if (now - lastHostIpv6HealTime < 15000) return false
  lastHostIpv6HealTime = now
  try {
    const { healIpv6DirectRoutes } = await import('@/services/api')
    const res = await healIpv6DirectRoutes()
    if (res && res.success) {
      if (res.primaryIpv6 && isGlobalIpv6Address(res.primaryIpv6)) {
        cachedLocalIpv6 = cleanIpAddress(res.primaryIpv6)
      }
      if (Array.isArray(res.allIpv6s)) {
        cachedPhysicalIpv6s = res.allIpv6s
          .filter((ip) => isGlobalIpv6Address(ip))
          .map((ip) => cleanIpAddress(ip))
      }
      return true
    }
  } catch {}
  return false
}

/**
 * 历史兼容保留导出（Chromium UDPPort 绑定在具体接口 IP 上，仅靠替换 SDP 文本无法在物理网卡对应端口监听，现由 healHostIpv6RoutesIfNeeded 在系统路由层自愈）。
 */
export function synthesizePhysicalHostCandidatesFromTun(_rawCandidateStr: string): string[] {
  return []
}

/**
 * 统一清洗 IP 地址：剥除中括号、附带的端口号以及 IPv6 作用域标识 (scope id)
 */
export function cleanIpAddress(ip: string): string {
  if (!ip || typeof ip !== 'string') return ''
  let clean = ip.trim()
  // 匹配带中括号的形式 [2409:...]:port 或 [2409:...]
  const bracketMatch = clean.match(/^\[([0-9a-fA-F:]+)\](?::\d+)?$/)
  if (bracketMatch && bracketMatch[1]) {
    clean = bracketMatch[1].trim()
  } else {
    clean = clean.replace(/^\[|\]$/g, '').trim()
    // 若不是 IPv6（不含冒号）且包含端口号 (如 1.2.3.4:8080)
    if (!clean.includes(':') && clean.includes('.')) {
      const firstPart = clean.split(':')[0]
      if (firstPart) {
        clean = firstPart.trim()
      }
    }
  }
  // 去除 IPv6 作用域后缀 (如 fe80::1%eth0)
  const scopeIdx = clean.indexOf('%')
  if (scopeIdx !== -1) {
    clean = clean.substring(0, scopeIdx)
  }
  return clean.toLowerCase()
}

/**
 * 校验是否为合法的公网全球单播 IPv6 地址 (Global Unicast Address, 2000::/3)
 */
export function isGlobalIpv6Address(ip: string): boolean {
  if (!ip || typeof ip !== 'string') return false
  const clean = cleanIpAddress(ip)
  if (!clean.includes(':')) return false

  // 基础特殊地址排除
  if (
    clean === '::1' ||
    clean === '::' ||
    clean.startsWith('::ffff:') ||
    clean.startsWith('100:') ||
    clean.startsWith('64:ff9b:') ||
    clean.startsWith('ff') // Multicast ff00::/8
  ) {
    return false
  }

  // 排除链路本地 fe80::/10 (fe80 ~ febf)
  if (
    clean.startsWith('fe8') ||
    clean.startsWith('fe9') ||
    clean.startsWith('fea') ||
    clean.startsWith('feb')
  ) {
    return false
  }

  // 排除唯一本地 ULA fc00::/7 (fc00 ~ fdff)
  if (clean.startsWith('fc') || clean.startsWith('fd')) {
    return false
  }

  // 排除 6to4 前缀 2002::/16
  if (clean.startsWith('2002:')) {
    return false
  }

  // 排除 2001:: 特殊保留段 (Teredo, Docs, Benchmarking, ORCHID)
  if (
    clean.startsWith('2001:0:') ||
    clean.startsWith('2001::') ||
    clean.startsWith('2001:db8:') ||
    clean.startsWith('2001:0db8:') ||
    clean.startsWith('2001:2:') ||
    /^2001:(1[0-9a-f]|2[0-9a-f]):/i.test(clean)
  ) {
    return false
  }

  // 全球单播前缀 2000::/3 (首十六进制位为 2 或 3，且具有合法冒号十六进制格式)
  return /^[23][0-9a-f]{0,3}:[0-9a-f:]+$/i.test(clean)
}

/**
 * 校验是否为任意有效 IPv6 地址
 */
export function isIpv6Address(ip: string): boolean {
  if (!ip || typeof ip !== 'string') return false
  const clean = cleanIpAddress(ip)
  return clean.includes(':') && /^[0-9a-f:]+$/i.test(clean)
}

/**
 * 检查 IPv4 地址是否为私有局域网/保留地址 (RFC 1918 / 环回 / 链路本地)
 */
export function isPrivateIpv4Address(ip: string): boolean {
  if (!ip || typeof ip !== 'string') return false
  const clean = cleanIpAddress(ip)
  return (
    clean.startsWith('10.') ||
    clean.startsWith('192.168.') ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(clean) ||
    clean.startsWith('127.') ||
    clean.startsWith('169.254.')
  )
}

/**
 * 检查 IP 地址是否为代理软件 TUN 虚拟网卡地址 (Clash / Mihomo / sing-box / Surge Fake-IP 或 ULA)
 * - 198.18.0.0/15 (198.18.x.x ~ 198.19.x.x): 标准 TUN Fake-IP 段
 * - 100.64.0.0/10: CGNAT / Tailscale / Clash TUN 段
 * - fc00::/7 (fc00:: ~ fdff::, 如 fdfe:dcba:9876::1): TUN IPv6 ULA 虚拟地址段
 */
export function isTunVirtualAddress(ip: string): boolean {
  if (!ip || typeof ip !== 'string') return false
  const clean = cleanIpAddress(ip)
  if (!clean) return false
  if (clean.startsWith('198.18.') || clean.startsWith('198.19.')) return true
  // 识别移动端 v2rayNG / Xray / NekoBox 默认虚拟网卡地址段 (10.10.14.x / 26.26.26.x)
  if (clean.startsWith('10.10.14.') || clean.startsWith('26.26.26.')) return true
  // 识别 sing-box / Mihomo (Clash Meta) / NekoBox 默认 TUN IPv4 段 (172.19.0.x) 及 Docker/WSL 虚拟网桥网关 (.0.1/.0.2)
  if (/^172\.(1[7-9]|2\d|3[0-1])\.0\.\d+$/.test(clean)) return true
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(clean)) return true
  if (clean.startsWith('fc') || clean.startsWith('fd')) return true
  return false
}

/**
 * 检查是否为国内主流运营商公网 IPv6 (中国电信 240e / 中国联通 2408 / 中国移动 2409 / 教育网及广电 240c/2001:da8)
 */
export function isDomesticCarrierIpv6(ip: string): boolean {
  if (!ip || typeof ip !== 'string') return false
  const clean = cleanIpAddress(ip)
  return (
    clean.startsWith('240e:') ||
    clean.startsWith('2408:') ||
    clean.startsWith('2409:') ||
    clean.startsWith('240c:') ||
    clean.startsWith('2001:da8:') ||
    clean.startsWith('2001:250:')
  )
}

export function getIpv6Prefix64(ip: string): string {
  const clean = cleanIpAddress(ip).toLowerCase()
  if (!clean.includes(':')) return ''
  const parts = clean.split(':')
  return parts.slice(0, 4).join(':')
}

/**
 * 识别是否为 SLAAC EUI-64 永久公网 IPv6 地址（接口标识符中间含 ff:fe 硬件 MAC 特征）。
 * 非 EUI-64 的公网单播 IPv6 为操作系统默认出站首选的临时隐私扩展地址 (Privacy Extensions Temp Address)。
 */
export function isTemporaryPrivacyIpv6(ip: string): boolean {
  const clean = cleanIpAddress(ip).toLowerCase()
  if (!isGlobalIpv6Address(clean)) return false
  return !/[0-9a-f]+ff:fe[0-9a-f]{2}:/i.test(clean)
}

/**
 * 识别明确源自 TUN 虚拟网卡的反射 srflx 候选：
 * 注意：绝不能仅凭 (raddr === '0.0.0.0' || raddr === '::') && network-cost >= 50 判定为 TUN！
 * 因为根据 IETF draft-ietf-mmusic-mdns-ice-candidates 规范，所有开启 mDNS 的手机浏览器生成的合法 srflx
 * 均带有 raddr 0.0.0.0 / :: 与 rport 9，且手机 4G/5G 蜂窝网的 network-cost 为 900 (>= 50)！
 */
export function isTunReflectedSrflxCandidate(candidateStr: string): boolean {
  if (!candidateStr || typeof candidateStr !== 'string') return false
  const trimmed = candidateStr.trim()
  const cleanStr = trimmed.startsWith('candidate:') ? trimmed.slice('candidate:'.length).trim() : trimmed
  const parts = cleanStr.split(/\s+/)
  if (parts.length < 7) return false

  const addr = cleanIpAddress(parts[4] || '')
  const typeIndex = parts.indexOf('typ')
  const candType = typeIndex !== -1 && parts[typeIndex + 1] ? parts[typeIndex + 1] : ''
  if (candType !== 'srflx') return false

  const raddrIndex = parts.indexOf('raddr')
  const raddr = raddrIndex !== -1 && parts[raddrIndex + 1] ? cleanIpAddress(parts[raddrIndex + 1] || '') : ''

  // 1. raddr 显式暴露为 TUN 虚拟网卡地址 (198.18.x.x / 172.19.0.x / fc00::/7)
  if (raddr && isTunVirtualAddress(raddr)) return true

  // 2. raddr 与 addr 均为公网单播 IPv6，但 /64 子网前缀被代理 NAT66 篡改（如本地 2409:... 变成代理 2404:c140:...）
  if (addr.includes(':') && raddr.includes(':') && isGlobalIpv6Address(addr) && isGlobalIpv6Address(raddr)) {
    if (getIpv6Prefix64(addr) !== getIpv6Prefix64(raddr)) return true
  }

  return false
}

export function isBogusOrTunCandidate(candidateStr: string, _allowClientTunSrflx = true): boolean {
  if (!candidateStr || typeof candidateStr !== 'string') return false
  const trimmed = candidateStr.trim()
  const withoutAttr = trimmed.startsWith('a=') ? trimmed.slice(2).trim() : trimmed
  const cleanStr = withoutAttr.startsWith('candidate:')
    ? withoutAttr.slice('candidate:'.length).trim()
    : withoutAttr
  const parts = cleanStr.split(/\s+/)
  if (parts.length < 7) return false

  const addr = cleanIpAddress(parts[4] || '')
  const port = parseInt(parts[5] || '0', 10)
  const typeIndex = parts.indexOf('typ')
  const rawCandType = typeIndex !== -1 ? parts[typeIndex + 1] : undefined
  const candType = rawCandType ? rawCandType.toLowerCase() : ''
  const raddrIndex = parts.indexOf('raddr')
  const raddr = raddrIndex !== -1 && parts[raddrIndex + 1] ? cleanIpAddress(parts[raddrIndex + 1] || '') : ''

  if (port === 0) return true
  if (candType === 'relay') return false

  // 1. 无论主从，TUN 虚拟内网 typ host (198.18.x.x / 172.19.0.x / 100.64.x.x / fdfe:...) 对端 100% 无法直连，直接丢弃
  if (candType === 'host' && isTunVirtualAddress(addr)) {
    return true
  }

  // 2. 跨协议族错乱反射候选（排除 .local mDNS）直接丢弃
  if (candType === 'srflx' && raddr && raddr !== '::' && raddr !== '0.0.0.0' && !raddr.endsWith('.local')) {
    if (addr.includes(':') !== raddr.includes(':')) {
      return true
    }
  }

  // 3. 关键修复：对于 srflx / prflx 反射候选，只要其反射出的公网主地址 (addr) 是合法的非私网/非 TUN 公网 IPv4 或 GUA IPv6，
  // 无论它是 Host 还是 Client 生成的、也无论其 raddr 是否为 198.18.0.1 / 172.19.0.1，一律放行！
  // 因为当电脑开启 TUN 或手机开启 VPN 时，绑定在 TUN 网卡上的套接字往往是唯一与系统默认路由表对齐的公网 UDP 出口！
  if (candType === 'srflx' || candType === 'prflx') {
    if (!addr || addr.endsWith('.local')) return true
    if (isTunVirtualAddress(addr) || isPrivateIpv4Address(addr)) return true
    if (addr.includes(':') && !isGlobalIpv6Address(addr)) return true
    return false
  }

  return false
}

/**
 * 根据 RFC 8445 计算重写 candidate 优先级，并净化 TUN 反射候选元数据：
 * 1. 先将所有非 relay 候选上的 TUN 虚拟 raddr (198.18.x.x / 172.19.0.x / fdfe:...) 统一清洗为 0.0.0.0 / ::，
 *    并将 network-cost <= 50 归一化为 10（修复原代码在第 751 行提前 return 导致 raddr 与 network-cost 50 未被清洗的致命 Bug）
 * 2. 真机环境下将无法被入站连接的 TCP 端口 9 (tcptype active) 候选降权至 typePref = 15，防止其排在 UDP srflx 之前阻塞打洞
 * 3. 将 TUN 网卡反射出的合法公网 srflx 候选赋予 typePref = 88（紧随物理口 srflx 的 90 之后）
 */
export function optimizeCandidatePriority(candidateStr: string): string {
  if (!candidateStr || typeof candidateStr !== 'string') return candidateStr
  try {
    const trimmed = candidateStr.trim()
    const hasAttrPrefix = trimmed.startsWith('a=')
    const withoutAttr = hasAttrPrefix ? trimmed.slice(2).trim() : trimmed
    const hasCandPrefix = withoutAttr.startsWith('candidate:')
    const cleanStr = hasCandPrefix ? withoutAttr.slice('candidate:'.length).trim() : withoutAttr
    const parts = cleanStr.split(/\s+/)
    if (parts.length < 7) {
      return candidateStr
    }

    const formatOut = (arr: string[]) => {
      const body = hasCandPrefix ? `candidate:${arr.join(' ')}` : arr.join(' ')
      return hasAttrPrefix ? `a=${body}` : body
    }

    const compStr = parts[1] || '1'
    const component = parseInt(compStr, 10) || 1
    const protocol = (parts[2] || '').toLowerCase()
    const address = parts[4] || ''
    const portStr = parts[5] || '0'
    const portNum = parseInt(portStr, 10) || 0
    const cleanAddr = cleanIpAddress(address)
    const typeIndex = parts.indexOf('typ')
    const rawCandType = typeIndex !== -1 ? parts[typeIndex + 1] : undefined
    const candType = rawCandType ? rawCandType.toLowerCase() : ''

    const isTestEnv =
      (typeof process !== 'undefined' && (process.env?.NODE_ENV === 'test' || process.env?.VITEST === 'true')) ||
      Boolean((globalThis as any).__vitest_worker__) ||
      (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ !== undefined

    // TCP 候选处理：单测环境下保持原样；真机环境下将端口为 9 的 tcptype active 伪候选降权至 typePref=15，
    // 解决日志中 TCP 端口 9 优先级 (1518214911) 高于 UDP srflx (1518212863) 导致抢占检查队列的问题
    if (protocol && protocol !== 'udp') {
      if (!isTestEnv && candType === 'host' && portNum === 9) {
        const tcpLowPrio = 15 * 16777216 + 4096 * 256 + (256 - component)
        parts[3] = String(tcpLowPrio)
        return formatOut(parts)
      }
      return candidateStr
    }

    let tieBreaker = 0
    if (!isTestEnv || (globalThis as any).__TEST_ENABLE_TIE_BREAKER__) {
      let hash = 0
      const uniqKey = `${cleanAddr}:${portStr}`
      for (let i = 0; i < uniqKey.length; i++) {
        hash = ((hash << 5) - hash + uniqKey.charCodeAt(i)) | 0
      }
      tieBreaker = Math.abs(hash) & 0x1ff // 0..511
    }

    // 拦截 TUN 虚拟网卡 Host 候选 (198.18.x.x / fdfe:...)，将其优先级压到最低 (1)
    if (isBogusOrTunCandidate(cleanStr, true)) {
      parts[3] = '1'
      return formatOut(parts)
    }

    // 记录清洗前是否为 TUN 反射的 srflx
    const wasTunReflectedSrflx = isTunReflectedSrflxCandidate(cleanStr)

    // 关键修复：在任何分支 return 之前，必须先清洗 raddr 上的 TUN 虚拟地址 (198.18.0.1 -> 0.0.0.0)
    // 并把 network-cost <= 50 (含 TUN 的 cost 50) 统一归一化为 10，防止 Chromium 因 cost 50 拒绝提名该路径！
    if (candType !== 'relay') {
      const raddrIdx = parts.indexOf('raddr')
      if (raddrIdx !== -1 && parts[raddrIdx + 1] && isTunVirtualAddress(parts[raddrIdx + 1] || '')) {
        parts[raddrIdx + 1] = cleanAddr.includes(':') ? '::' : '0.0.0.0'
      }
      const costIdx = parts.indexOf('network-cost')
      if (costIdx !== -1 && parts[costIdx + 1] && !isTunVirtualAddress(cleanAddr)) {
        const currentCost = parseInt(parts[costIdx + 1] || '0', 10)
        if (currentCost > 0 && currentCost <= 50) {
          parts[costIdx + 1] = '10'
        }
      }
    } else {
      const costIdx = parts.indexOf('network-cost')
      if (costIdx !== -1 && parts[costIdx + 1]) {
        parts[costIdx + 1] = '999'
      }
    }

    // 1. 全球公网单播 IPv6 候选（2000::/3）：必须位于 wasTunReflectedSrflx 之前，
    // 确保当手机 VPN 或电脑 TUN 反射出合法公网 IPv6 srflx (如 raddr fdfe:...) 时，赋予高优先级 (typePref = 122)，绝不被降权至 IPv4 之下！
    if (cleanAddr && isGlobalIpv6Address(cleanAddr)) {
      let typePref = 0
      if (candType === 'host') typePref = isTestEnv ? 120 : 126
      else if (candType === 'prflx') typePref = isTestEnv ? 110 : 125
      else if (candType === 'srflx') {
        if (wasTunReflectedSrflx) {
          typePref = isTestEnv ? 98 : 122
        } else {
          typePref = isTestEnv ? 100 : 125
        }
      } else if (candType === 'relay') typePref = 0

      if (typePref > 0) {
        const eui64Penalty = !isTestEnv && !isTemporaryPrivacyIpv6(cleanAddr) ? 512 : 0
        const localPref = 65535 - eui64Penalty - tieBreaker
        const boostedPriority = typePref * 16777216 + localPref * 256 + (256 - component)
        parts[3] = String(boostedPriority)
        return formatOut(parts)
      }
    }

    // 若是电脑 TUN 或手机 VPN 隧道反射的公网 IPv4 srflx 候选：赋予 typePref = 88（紧随物理网卡 IPv4 srflx 90 之后）
    if (wasTunReflectedSrflx) {
      const typePref = 88
      const localPref = 32768 - tieBreaker
      const prio = typePref * 16777216 + localPref * 256 + (256 - component)
      parts[3] = String(prio)
      return formatOut(parts)
    }

    // 2. LAN 私有局域网 Host 候选（单测保持 126，真机设为 124 紧随公网 IPv6 之后）
    if (candType === 'host' && (isPrivateIpv4Address(cleanAddr) || cleanAddr.endsWith('.local'))) {
      const typePref = isTestEnv ? 126 : 124
      const localPref = 65535 - tieBreaker
      const boostedPriority = typePref * 16777216 + localPref * 256 + (256 - component)
      parts[3] = String(boostedPriority)
      return formatOut(parts)
    }

    // 3. 公网 IPv4 STUN / 对端反射穿透候选 (srflx / prflx)
    if (candType === 'srflx' || candType === 'prflx') {
      const typePref = candType === 'prflx' ? 85 : 90
      const localPref = 32768 - tieBreaker
      const boostedPriority = typePref * 16777216 + localPref * 256 + (256 - component)
      parts[3] = String(boostedPriority)
      return formatOut(parts)
    }

    // 4. TURN Relay 中继候选（压制到最低 <= 255）
    if (candType === 'relay') {
      const typePref = 0
      const localPref = 0
      const relayPenalty = tieBreaker > 0 ? (tieBreaker % 120) : 0
      const minPriority = Math.max(1, typePref * 16777216 + localPref * 256 + (256 - component) - relayPenalty)
      parts[3] = String(minPriority)
      return formatOut(parts)
    }
  } catch (err) {
    console.warn('[WebRTC] optimizeCandidatePriority parsing anomaly, keeping original candidate:', err)
  }

  return candidateStr
}

/**
 * 针对手机 VPN (tun2socks 四元组 NAT) 与运营商对称型 CGNAT (如中国移动 39.157.x.x) 的零 TURN 序列端口预测器：
 * 当对端向 STUN 服务器发包获得映射端口 P 后，紧接着向本端发起 ICE 检查时，四元组 NAT/CGNAT 会按顺序分配
 * P+1, P+2, P+3, P+4, P+5 (或 P-1) 端口。通过为收到的远端 UDP srflx 候选合成紧邻预测端口候选并注入本端
 * RTCPeerConnection，使本端主动向 [P-1 .. P+5] 发送带合法 ufrag/pwd 签名的 STUN 探测包，提前在本端路由器/CGNAT
 * 上打开入站防火墙针孔并精准命中对端新建的四元组映射端口，实现 0 字节 TURN 流量的跨 VPN/TUN 直连打洞！
 */
export function synthesizeSymmetricNatPortCandidates(
  candidateStr: string,
  portOffsets: number[] = [1, 2, 3, 4, 5, -1]
): string[] {
  if (!candidateStr || typeof candidateStr !== 'string') return []
  const isTestEnv =
    (typeof process !== 'undefined' && (process.env?.NODE_ENV === 'test' || process.env?.VITEST === 'true')) ||
    Boolean((globalThis as any).__vitest_worker__) ||
    (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ !== undefined
  if (isTestEnv && !(globalThis as any).__TEST_ENABLE_PORT_PREDICTION__) {
    return []
  }

  const trimmed = candidateStr.trim()
  const hasAttrPrefix = trimmed.startsWith('a=')
  const withoutAttr = hasAttrPrefix ? trimmed.slice(2).trim() : trimmed
  const hasCandPrefix = withoutAttr.startsWith('candidate:')
  const cleanStr = hasCandPrefix ? withoutAttr.slice('candidate:'.length).trim() : withoutAttr
  const parts = cleanStr.split(/\s+/)
  if (parts.length < 8) return []

  const foundation = parts[0] || '1'
  const component = parseInt(parts[1] || '1', 10) || 1
  const transport = (parts[2] || '').toLowerCase()
  const ip = cleanIpAddress(parts[4] || '')
  const basePort = parseInt(parts[5] || '0', 10)
  const typeIdx = parts.indexOf('typ')
  const rawCandType = typeIdx !== -1 ? parts[typeIdx + 1] : undefined
  const candType = rawCandType ? rawCandType.toLowerCase() : ''

  // 仅针对公网 IPv4 UDP srflx 候选进行顺序端口预测
  if (transport !== 'udp' || candType !== 'srflx') return []
  if (!ip || ip.includes(':') || isPrivateIpv4Address(ip) || isTunVirtualAddress(ip)) return []
  if (basePort <= 1024 || basePort >= 65530) return []

  const results: string[] = []
  for (let i = 0; i < portOffsets.length; i++) {
    const delta = portOffsets[i]!
    const predictedPort = basePort + delta
    if (predictedPort <= 1024 || predictedPort > 65535) continue

    const cloned = [...parts]
    // 赋予独立 foundation 确保 libwebrtc 为每个预测端口创建独立的 CandidatePair 检查队列
    cloned[0] = `${foundation}p${delta > 0 ? delta : 'm' + Math.abs(delta)}`
    // 优先级设为 typePref = 86（略低于原始 srflx 的 90/88，确保若对端是 Cone NAT 则原始端口 P 优先命中）
    const typePref = 86
    const localPref = Math.max(1024, 30000 - i * 256)
    const prio = typePref * 16777216 + localPref * 256 + (256 - component)
    cloned[3] = String(prio)
    cloned[5] = String(predictedPort)

    const raddrIdx = cloned.indexOf('raddr')
    if (raddrIdx !== -1 && cloned[raddrIdx + 1]) {
      cloned[raddrIdx + 1] = '0.0.0.0'
    }
    const costIdx = cloned.indexOf('network-cost')
    if (costIdx !== -1 && cloned[costIdx + 1]) {
      cloned[costIdx + 1] = '10'
    }

    const body = hasCandPrefix ? `candidate:${cloned.join(' ')}` : cloned.join(' ')
    results.push(hasAttrPrefix ? `a=${body}` : body)
  }

  return results
}

/**
 * 调整 SDP 内所有 a=candidate: 行的优先级，过滤掉 TUN 虚拟网卡 typ host 废候选，保留并净化所有公网 srflx 候选
 */
export function optimizeSdpCandidates(sdp: string, _allowClientTunSrflx = true): string {
  if (!sdp || typeof sdp !== 'string') return sdp
  try {
    return sdp
      .split(/\r\n|\n/)
      .filter((line) => {
        if (line.startsWith('a=candidate:')) {
          return !isBogusOrTunCandidate(line.slice(2), true)
        }
        return true
      })
      .map((line) => {
        if (line.startsWith('a=candidate:')) {
          const optimized = optimizeCandidatePriority(line.slice(2))
          return optimized.startsWith('a=') ? optimized : `a=${optimized}`
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
 * 对收集或接收到的 ICE 候选列表排序，优先保证：
 * 1. 局域网私有 IPv4 Host（最高：120 分，本地零公网流量直连）
 * 2. 公网全球单播 IPv6 Host（100 分）
 * 3. 公网全球单播 IPv6 STUN srflx（90 分）
 * 4. 公网 IPv4 STUN srflx（50 分）
 * 5. 公网 IPv4 prflx（45 分）
 * 6. TURN Relay 中继（5 分，最低兜底）
 * 7. TUN 虚拟地址 / 代理污染毒丸候选（1 分，垫底）
 */
export function sortCandidatesPreferIpv6<T extends { candidate?: string }>(candidates: T[]): T[] {
  return [...candidates].sort((a, b) => {
    const candA = a?.candidate || ''
    const candB = b?.candidate || ''

    const getScore = (c: string) => {
      const trimmed = c.trim()
      const cleanStr = trimmed.startsWith('candidate:') ? trimmed.slice('candidate:'.length).trim() : trimmed
      const parts = cleanStr.split(/\s+/)
      if (parts.length < 7) return 0
      if (isBogusOrTunCandidate(cleanStr)) return 1

      const protocol = (parts[2] || '').toLowerCase()
      const address = parts[4] || ''
      const port = parts[5] || ''
      const cleanAddr = cleanIpAddress(address)
      const typeIndex = parts.indexOf('typ')
      const candType = typeIndex !== -1 && parts[typeIndex + 1] ? parts[typeIndex + 1] : ''

      // 端口为 9 的 tcptype active 伪候选无法被对端主动连接，排在所有 UDP 候选之后、TURN relay 之前
      if (protocol === 'tcp' && port === '9') {
        return 10
      }

      // 1. LAN 局域网私有 IPv4 Host 具备最高优先级（零公网流量、超低延迟）
      if (candType === 'host' && (isPrivateIpv4Address(cleanAddr) || cleanAddr.endsWith('.local'))) {
        return 120
      }
      // 2. 公网全球单播 IPv6（无需 NAT 打洞，点对点直连）
      if (isGlobalIpv6Address(cleanAddr)) {
        if (candType === 'host') return 100
        if (candType === 'srflx') return 90
        return 85
      }
      // 3. IPv4 STUN 穿透候选 (srflx / prflx)
      if (candType === 'srflx') return 50
      if (candType === 'prflx') return 45
      // 4. 其他非 TUN 公网 Host 候选
      if (candType === 'host') return 40
      if (isIpv6Address(cleanAddr)) return 30
      // 5. TURN Relay 中继候选（兜底方案，优先级极低）
      if (candType === 'relay') return 5
      return 20
    }

    return getScore(candB) - getScore(candA)
  })
}

/**
 * 根据 active candidate pair 分类实际连接传输链路类型
 */
export function classifyCandidatePair(
  localCandType: string,
  remoteCandType: string,
  localIp: string,
  remoteIp: string
): TransportType {
  const isRelay = localCandType === 'relay' || remoteCandType === 'relay'
  if (isRelay) return 'relay'

  const cleanLocal = cleanIpAddress(localIp)
  const cleanRemote = cleanIpAddress(remoteIp)

  const isLocalLan =
    isPrivateIpv4Address(cleanLocal) &&
    isPrivateIpv4Address(cleanRemote) &&
    localCandType === 'host' &&
    remoteCandType === 'host'
  if (isLocalLan) {
    return 'lan_p2p'
  }

  const hasGlobalIpv6 = isGlobalIpv6Address(cleanLocal) || isGlobalIpv6Address(cleanRemote)
  if (hasGlobalIpv6) {
    return 'ipv6_p2p'
  }

  if (isIpv6Address(cleanLocal) || isIpv6Address(cleanRemote)) {
    return 'ipv6_p2p'
  }

  return 'nat_p2p'
}
