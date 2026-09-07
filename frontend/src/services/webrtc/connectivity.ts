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
    // 1. Cloudflare Anycast STUN（中国大陆内外通用、极低延迟，支持 IPv4/IPv6 双栈）
    {
      urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53']
    },
    // 2. Google STUN（全球 Anycast 冗余节点）
    {
      urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']
    },
    // 3. Metered STUN
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
 * 校验是否为合法的公网全球单播 IPv6 地址 (Global Unicast Address, 2000::/3)
 */
export function isGlobalIpv6Address(ip: string): boolean {
  if (!ip || typeof ip !== 'string') return false
  const clean = ip.trim().toLowerCase()
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
  const clean = ip.trim().toLowerCase()
  return clean.includes(':') && /^[0-9a-f:]+$/i.test(clean)
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
 * 根据 RFC 8445 计算重写 candidate 优先级，实现 IPv6 打洞优先：
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
    const address = parts[4] || ''
    const typeIndex = parts.indexOf('typ')
    const candType = typeIndex !== -1 && parts[typeIndex + 1] ? parts[typeIndex + 1] : ''

    if (address && isGlobalIpv6Address(address)) {
      let typePref = 0
      if (candType === 'host') typePref = 126
      else if (candType === 'prflx') typePref = 110
      else if (candType === 'srflx') typePref = 100
      else if (candType === 'relay') typePref = 0

      if (typePref > 0) {
        const boostedPriority = typePref * 16777216 + 65535 * 256 + (256 - component)
        parts[3] = String(boostedPriority)
        return hasPrefix ? `candidate:${parts.join(' ')}` : parts.join(' ')
      }
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
 * 对收集或接收到的 ICE 候选列表排序，确保 IPv6 候选优先被加入和探测
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
      const typeIndex = parts.indexOf('typ')
      const candType = typeIndex !== -1 && parts[typeIndex + 1] ? parts[typeIndex + 1] : ''

      if (isGlobalIpv6Address(address)) {
        if (candType === 'host') return 100
        if (candType === 'srflx') return 90
        return 80
      }
      if (isIpv6Address(address)) return 70
      if (candType === 'host') return 50
      if (candType === 'srflx') return 40
      if (candType === 'relay') return 10
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

  const hasGlobalIpv6 = isGlobalIpv6Address(localIp) || isGlobalIpv6Address(remoteIp)
  if (hasGlobalIpv6) {
    return 'ipv6_p2p'
  }

  const isLocalLan =
    isPrivateIpv4Address(localIp) &&
    isPrivateIpv4Address(remoteIp) &&
    localCandType === 'host' &&
    remoteCandType === 'host'
  if (isLocalLan) {
    return 'lan_p2p'
  }

  if (isIpv6Address(localIp) || isIpv6Address(remoteIp)) {
    return 'ipv6_p2p'
  }

  return 'nat_p2p'
}
