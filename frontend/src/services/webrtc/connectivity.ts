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

export const STUN_SERVERS: RTCConfiguration = {
  iceServers: [
    // 1. 国内主流高可用双栈 STUN（湖南广电/中国移动 HiTV，极速探测、支持 IPv4/IPv6 双栈，免受海外代理污染）
    {
      urls: [
        'stun:stun.hitv.com:3478',
        'stun:[2409:8c50:e00::1]:3478',
        'stun:[2409:8c50:e00::4]:3478',
        'stun:111.8.3.78:3478'
      ]
    },
    // 2. Cloudflare Anycast STUN（全球 Anycast、低延迟双栈）
    {
      urls: ['stun:stun.cloudflare.com:3478']
    },
    // 3. Google STUN（全球 Anycast 冗余节点）
    {
      urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']
    },
    // 4. 直连国际 IPv6 Anycast STUN（免 DNS 解析，彻底绕过国内 ISP DNS 缺失 AAAA 记录的问题）
    {
      urls: [
        'stun:[2606:4700:49::]:3478',
        'stun:[2001:4860:4864:5:8000::1]:19302'
      ]
    },
    // 5. Metered STUN
    {
      urls: 'stun:stun.relay.metered.ca:80'
    },
    // 4. TURN 备用中继（对称型 NAT 且无法通过 IPv6 直连时的兜底代理）
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
  ],
  iceCandidatePoolSize: 2
}

/**
 * 统一 ICE 配置构造器（单 PeerConnection 并行打洞策略）：
 * - 'all'：同一个 PeerConnection 内并行检查 LAN host / IPv6 (host、srflx、prflx) / IPv4 NAT srflx / TURN relay，
 *   由 ICE 按优先级自然择优，绝不为“升级/降级”而拆除重建连接（拆除重建是旧版逻辑自锁的根源）。
 * - 'relay'：仅在连续失败后的升级尝试中使用，绕过异常中间设备导致的错误提名路径。
 * 注意：浏览器默认对 host 候选做 mDNS 混淆（xxx.local），跨网段 IPv6 直连必须依赖 STUN 反射出的
 * 真实 IPv6 srflx / 对端 prflx 候选，因此 IPv6 场景同样不能省略 STUN。
 */
export function buildIceConfiguration(forceRelay = false): RTCConfiguration {
  return {
    ...STUN_SERVERS,
    iceTransportPolicy: forceRelay ? 'relay' : 'all'
  }
}

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
 * 根据重试序号（1 起）决定该次尝试是否走纯中继：
 * 第 1 次重试仍走 'all'（直连 + 中继并行），第 2/4/6 次升级为 'relay'，奇数次回到 'all'，
 * 避免旧版“8 秒强制 relay 后被锁死在中继”的问题，同时保证对称 NAT 场景最终能落到 TURN。
 */
export function shouldForceRelayForAttempt(attemptNumber: number): boolean {
  return attemptNumber >= 2 && attemptNumber % 2 === 0
}

let cachedLocalIpv6: string | null = null
let lastIpv6ProbeTime = 0

/**
 * 重置网卡 IPv6 缓存（供单元测试或网络切换时使用）
 */
export function resetLocalIpv6ProbeCache(): void {
  cachedLocalIpv6 = null
  lastIpv6ProbeTime = 0
}

/**
 * 优先从本机网卡探测公网全球单播 IPv6 (GUA, 2000::/3)
 * 1. 电脑端 Host：尝试直接调用 Java 后端系统接口，100% 准确读取物理网卡
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

  // 1. 电脑端 Host：尝试直接调用 Java 后端系统接口读取物理网卡 GUA IPv6
  try {
    const { getNetworkInfo } = await import('@/services/api')
    const net = await getNetworkInfo()
    if (net?.primaryIpv6 && isGlobalIpv6Address(net.primaryIpv6)) {
      cachedLocalIpv6 = cleanIpAddress(net.primaryIpv6)
      lastIpv6ProbeTime = now
      return cachedLocalIpv6
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
 * 根据 RFC 8445 计算重写 candidate 优先级，实现 LAN 优先 > IPv6 优先 > 公网 STUN > TURN 兜底：
 * priority = (2^24)*(type-preference) + (2^8)*(local-preference) + (256 - component)
 */
export function optimizeCandidatePriority(candidateStr: string): string {
  if (!candidateStr || typeof candidateStr !== 'string') return candidateStr
  try {
    const trimmed = candidateStr.trim()
    const hasPrefix = trimmed.startsWith('candidate:')
    const cleanStr = hasPrefix ? trimmed.slice('candidate:'.length).trim() : trimmed
    const parts = cleanStr.split(/\s+/)
    if (parts.length < 7) {
      return candidateStr
    }

    const compStr = parts[1] || '1'
    const component = parseInt(compStr, 10) || 1
    const protocol = (parts[2] || '').toLowerCase()
    // TCP 候选（tcptype active/passive）保留浏览器原生优先级，避免被提升到与 UDP 同级后抢先提名高延迟 TCP 路径
    if (protocol && protocol !== 'udp') {
      return candidateStr
    }
    const address = parts[4] || ''
    const cleanAddr = cleanIpAddress(address)
    const typeIndex = parts.indexOf('typ')
    const candType = typeIndex !== -1 && parts[typeIndex + 1] ? parts[typeIndex + 1] : ''

    // 1. LAN 私有局域网 Host 候选（RFC 1918 私网 IPv4 或 mDNS .local）具备最高优先级，优先走本地网络零公网流量
    if (candType === 'host' && (isPrivateIpv4Address(cleanAddr) || cleanAddr.endsWith('.local'))) {
      const typePref = 126
      const localPref = 65535
      const boostedPriority = typePref * 16777216 + localPref * 256 + (256 - component)
      parts[3] = String(boostedPriority)
      return hasPrefix ? `candidate:${parts.join(' ')}` : parts.join(' ')
    }

    // 2. 公网全球单播 IPv6 候选（无需 NAT 打洞，跨网点对点直连）
    if (cleanAddr && isGlobalIpv6Address(cleanAddr)) {
      let typePref = 0
      if (candType === 'host') typePref = 120
      else if (candType === 'prflx') typePref = 110
      else if (candType === 'srflx') typePref = 100
      else if (candType === 'relay') typePref = 0

      if (typePref > 0) {
        const boostedPriority = typePref * 16777216 + 65535 * 256 + (256 - component)
        parts[3] = String(boostedPriority)
        return hasPrefix ? `candidate:${parts.join(' ')}` : parts.join(' ')
      }
    }

    // 3. 公网 IPv4 STUN / 对端反射穿透候选 (srflx / prflx)
    if (candType === 'srflx' || candType === 'prflx') {
      const typePref = candType === 'prflx' ? 85 : 90
      const localPref = 32768
      const boostedPriority = typePref * 16777216 + localPref * 256 + (256 - component)
      parts[3] = String(boostedPriority)
      return hasPrefix ? `candidate:${parts.join(' ')}` : parts.join(' ')
    }

    // 4. TURN Relay 中继候选（压制到最低，确保仅在对称 NAT 且 IPv6 无法直连时作为最终兜底）
    if (candType === 'relay') {
      const typePref = 0
      const localPref = 0
      const minPriority = typePref * 16777216 + localPref * 256 + (256 - component)
      parts[3] = String(minPriority)
      return hasPrefix ? `candidate:${parts.join(' ')}` : parts.join(' ')
    }
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
 * 对收集或接收到的 ICE 候选列表排序，优先保证：
 * 1. 局域网私有 IPv4 Host（最高：120 分，本地零公网流量直连）
 * 2. 公网全球单播 IPv6 Host（100 分）
 * 3. 公网全球单播 IPv6 STUN srflx（90 分）
 * 4. 其他有效 IPv6（80 分）
 * 5. 公网 IPv4 Host（70 分）
 * 6. 公网 IPv4 STUN srflx（50 分）
 * 7. 公网 IPv4 prflx（45 分）
 * 8. 其他候选（20 分）
 * 9. TURN Relay 中继（5 分，最低兜底）
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
      const address = parts[4] || ''
      const cleanAddr = cleanIpAddress(address)
      const typeIndex = parts.indexOf('typ')
      const candType = typeIndex !== -1 && parts[typeIndex + 1] ? parts[typeIndex + 1] : ''

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
      if (isIpv6Address(cleanAddr)) return 80
      // 3. 其他公网 Host 候选
      if (candType === 'host') return 70
      // 4. IPv4 STUN 穿透候选 (srflx / prflx)
      if (candType === 'srflx') return 50
      if (candType === 'prflx') return 45
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
