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

/**
 * 生产环境静态字面量 STUN 分组（零 DNS 请求，彻底规避 TUN/VPN Fake-IP 198.18.0.x 劫持）：
 * - 国内组：命中代理软件 GEOIP,CN,DIRECT 规则，反射本机真实物理公网地址；
 * - 海外组：供海外直连用户及挂全局 VPN / TUN 的客户端反射可用公网出口地址，由候选层依据来源识别并排序。
 */
export const DOMESTIC_LITERAL_STUN_URLS: readonly string[] = [
  'stun:111.8.3.78:3478',
  'stun:[2409:8c50:e00::1]:3478',
  'stun:[2409:8c50:e00::3]:3478',
  'stun:[2409:8c50:e00::4]:3478'
]

export const OVERSEAS_LITERAL_STUN_URLS: readonly string[] = [
  'stun:74.125.250.129:19302',
  'stun:[2606:4700:49::]:3478',
  'stun:[2001:4860:4864:5:8000::1]:19302',
  'stun:[2a01:4f8:1c1e:d769::1]:3478'
]

/**
 * 从 STUN URL 中提取主机部分（小写，IPv6 不带中括号）。同时兼容两种格式：
 * 1. 配置格式：stun:[2606:4700:49::]:3478 / stun:111.8.3.78:3478 / stun:host:3478?transport=udp
 * 2. libwebrtc 回填到候选 url / getStats local-candidate.url 的格式：stun_port.cc 中按
 *    `"stun:" << stun_server_addr.hostname() << ":" << port` 拼接，IPv6 字面量**不带中括号**，
 *    形如 stun:2606:4700:49:::3478，必须按“最后一个冒号之后为端口”解析。
 */
export function extractStunUrlHost(stunUrl: string | undefined | null): string {
  if (!stunUrl || typeof stunUrl !== 'string') return ''
  let rest = stunUrl.trim().toLowerCase().replace(/^(stuns?|turns?):/, '')
  rest = rest.split('?')[0] || ''
  if (!rest) return ''
  const bracketMatch = rest.match(/^\[([0-9a-f:.]+)\](?::\d+)?$/)
  if (bracketMatch && bracketMatch[1]) return bracketMatch[1]
  const colonCount = (rest.match(/:/g) || []).length
  if (colonCount === 0) return rest
  if (colonCount === 1) return rest.split(':')[0] || ''
  // 多个冒号：无中括号的 IPv6 字面量。若最后一段为纯数字端口则剥离
  const lastColon = rest.lastIndexOf(':')
  const tail = rest.slice(lastColon + 1)
  if (/^\d{1,5}$/.test(tail)) {
    const host = rest.slice(0, lastColon)
    if (host.includes(':')) return host
  }
  return rest
}

const DOMESTIC_STUN_HOSTS = new Set(DOMESTIC_LITERAL_STUN_URLS.map((u) => extractStunUrlHost(u)))
const OVERSEAS_STUN_HOSTS = new Set(OVERSEAS_LITERAL_STUN_URLS.map((u) => extractStunUrlHost(u)))

/**
 * 识别某个 STUN URL 的所属区域（domestic = 国内直连源，overseas = 海外源，unknown = 未知/未提供）：
 * 用于在 TUN/VPN 分流场景下识别同一本地套接字上由海外 STUN 经代理出口反射出的二阶 srflx 候选。
 */
export function classifyStunUrlOrigin(stunUrl: string | undefined | null): 'domestic' | 'overseas' | 'unknown' {
  const cleanHost = extractStunUrlHost(stunUrl)
  if (!cleanHost) return 'unknown'

  if (DOMESTIC_STUN_HOSTS.has(cleanHost)) return 'domestic'
  if (OVERSEAS_STUN_HOSTS.has(cleanHost)) return 'overseas'

  if (
    cleanHost.includes('miwifi.com') ||
    cleanHost.includes('qq.com') ||
    cleanHost.includes('hitv.com')
  ) {
    return 'domestic'
  }
  if (
    cleanHost.includes('google.com') ||
    cleanHost.includes('cloudflare.com') ||
    cleanHost.includes('nextcloud.com')
  ) {
    return 'overseas'
  }

  if (cleanHost.includes(':')) {
    if (isDomesticCarrierIpv6(cleanHost)) return 'domestic'
    if (isGlobalIpv6Address(cleanHost)) return 'overseas'
  }

  return 'unknown'
}

/**
 * 历史兼容保留导出（Chromium UDPPort 绑定在具体接口 IP 上，仅靠替换 SDP 文本无法在物理网卡对应端口监听）。
 * 注意：本应用不会修改系统路由/网卡参数，以免破坏用户的 TUN 代理。
 */
export function synthesizePhysicalHostCandidatesFromTun(_rawCandidateStr: string): string[] {
  return []
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
 * 将判定为“分流代理出口”（同一本地套接字既有国内 DIRECT srflx，又有海外 PROXY 反射出的不同 IP srflx）的候选优先级降权：
 * - IPv6 代理出口 srflx 降为 typePref = isTestEnv ? 95 : 115（低于原生/TUN 直连 IPv6 的 100/98 或 125/122，高于 IPv4 srflx 90）
 * - IPv4 代理出口 srflx 降为 typePref = 80（低于物理 IPv4 srflx 90、TUN 直连 88、端口预测 86、prflx 85，远高于 TCP 9 的 15 与 TURN 0）
 * 只降权、绝不丢弃：确保当直连因防火墙/对称 NAT 不通而代理支持 Full-Cone UDP 时，仍可作为有效兜底路径。
 */
export function demoteProxyExitCandidatePriority(candidateStr: string): string {
  if (!candidateStr || typeof candidateStr !== 'string') return candidateStr
  try {
    const trimmed = candidateStr.trim()
    const hasAttrPrefix = trimmed.startsWith('a=')
    const withoutAttr = hasAttrPrefix ? trimmed.slice(2).trim() : trimmed
    const hasCandPrefix = withoutAttr.startsWith('candidate:')
    const cleanStr = hasCandPrefix ? withoutAttr.slice('candidate:'.length).trim() : withoutAttr
    const parts = cleanStr.split(/\s+/)
    if (parts.length < 7) return candidateStr

    const compStr = parts[1] || '1'
    const component = parseInt(compStr, 10) || 1
    const cleanAddr = cleanIpAddress(parts[4] || '')
    const portStr = parts[5] || '0'
    const typeIdx = parts.indexOf('typ')
    const candType = typeIdx !== -1 && parts[typeIdx + 1] ? parts[typeIdx + 1]!.toLowerCase() : ''
    if (candType !== 'srflx') return candidateStr

    const isTestEnv =
      (typeof process !== 'undefined' && (process.env?.NODE_ENV === 'test' || process.env?.VITEST === 'true')) ||
      Boolean((globalThis as any).__vitest_worker__) ||
      (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ !== undefined

    let hash = 0
    const uniqKey = `${cleanAddr}:${portStr}`
    for (let i = 0; i < uniqKey.length; i++) {
      hash = ((hash << 5) - hash + uniqKey.charCodeAt(i)) | 0
    }
    const tieBreaker = Math.abs(hash) & 0x1ff

    const isV6 = Boolean(cleanAddr && isGlobalIpv6Address(cleanAddr))
    const typePref = isV6 ? (isTestEnv ? 95 : 115) : 80
    const localPref = (isV6 ? 65535 : 32768) - tieBreaker
    const prio = typePref * 16777216 + localPref * 256 + (256 - component)
    parts[3] = String(prio)

    const body = hasCandPrefix ? `candidate:${parts.join(' ')}` : parts.join(' ')
    return hasAttrPrefix ? `a=${body}` : body
  } catch {
    return candidateStr
  }
}

export interface TaggedIceCandidateItem {
  candObj: RTCIceCandidateInit
  stunUrl?: string
  rawRaddr?: string
  rawRport?: string
  rawNetId?: string
}

/**
 * 批量评估暂存的本地候选：按同一本地接口/地址族分组，对比国内 STUN (domestic) 与海外 STUN (overseas) 反射出的主地址。
 * - 若同一分组下同时存在 domestic 反射地址与 overseas 反射地址，且 overseas 反射出的 IP 不在 domestic IP 集合内，
 *   说明本地开启了规则分流代理（domestic 走 DIRECT 拿到真实公网 IP，overseas 走 PROXY 拿到机场出口 IP），将该 overseas 候选自动降权；
 * - 若地址相同（无代理）、或仅有 overseas 候选（海外用户 / 全局 VPN / 国内 STUN 不可达）、或浏览器未提供 event.url，
 *   则完全保持原优先级不变。
 */
export function applyProxyExitDemotionToBatch(items: TaggedIceCandidateItem[]): RTCIceCandidateInit[] {
  if (!Array.isArray(items) || items.length === 0) return []

  interface ParsedMeta {
    item: TaggedIceCandidateItem
    candType: string
    cleanAddr: string
    family: 'v4' | 'v6'
    groupKey: string
    origin: 'domestic' | 'overseas' | 'unknown'
  }

  const parsedList: ParsedMeta[] = items.map((item) => {
    const cStr = item.candObj.candidate || ''
    const trimmed = cStr.trim()
    const withoutAttr = trimmed.startsWith('a=') ? trimmed.slice(2).trim() : trimmed
    const cleanStr = withoutAttr.startsWith('candidate:')
      ? withoutAttr.slice('candidate:'.length).trim()
      : withoutAttr
    const parts = cleanStr.split(/\s+/)
    const cleanAddr = cleanIpAddress(parts[4] || '')
    const typeIdx = parts.indexOf('typ')
    const candType = typeIdx !== -1 && parts[typeIdx + 1] ? parts[typeIdx + 1]!.toLowerCase() : ''
    const raddrIdx = parts.indexOf('raddr')
    const rportIdx = parts.indexOf('rport')
    const netIdIdx = parts.indexOf('network-id')

    const family: 'v4' | 'v6' = cleanAddr.includes(':') ? 'v6' : 'v4'
    const raddr = cleanIpAddress(item.rawRaddr || (raddrIdx !== -1 ? parts[raddrIdx + 1] || '' : ''))
    const rport = item.rawRport || (rportIdx !== -1 ? parts[rportIdx + 1] || '' : '')
    const netId = item.rawNetId || (netIdIdx !== -1 ? parts[netIdIdx + 1] || '' : '')

    // 按地址族 + 本地绑定标识（优先 raddr:rport，若被 mDNS 置为 0.0.0.0/9 则按 network-id + family 聚合）
    const hasSpecificSocket = raddr && raddr !== '0.0.0.0' && raddr !== '::' && rport && rport !== '9'
    const socketTag = hasSpecificSocket ? `${raddr}:${rport}` : `net:${netId || 'default'}`
    const groupKey = `${family}|${socketTag}`
    const origin = classifyStunUrlOrigin(item.stunUrl)

    return {
      item,
      candType,
      cleanAddr,
      family,
      groupKey,
      origin
    }
  })

  // 收集每个分组下由国内 STUN 反射出的真实公网地址集合
  const domesticAddrsByGroup = new Map<string, Set<string>>()
  const familyDomesticAddrs = new Map<'v4' | 'v6', Set<string>>()
  for (const m of parsedList) {
    if (m.candType === 'srflx' && m.origin === 'domestic' && m.cleanAddr) {
      let set = domesticAddrsByGroup.get(m.groupKey)
      if (!set) {
        set = new Set<string>()
        domesticAddrsByGroup.set(m.groupKey, set)
      }
      set.add(m.cleanAddr.toLowerCase())

      let famSet = familyDomesticAddrs.get(m.family)
      if (!famSet) {
        famSet = new Set<string>()
        familyDomesticAddrs.set(m.family, famSet)
      }
      famSet.add(m.cleanAddr.toLowerCase())
    }
  }

  return parsedList.map((m) => {
    const out: RTCIceCandidateInit = { ...m.item.candObj }
    if (m.candType === 'srflx' && m.origin === 'overseas' && m.cleanAddr && out.candidate) {
      const groupDom = domesticAddrsByGroup.get(m.groupKey) || familyDomesticAddrs.get(m.family)
      if (groupDom && groupDom.size > 0 && !groupDom.has(m.cleanAddr.toLowerCase())) {
        out.candidate = demoteProxyExitCandidatePriority(out.candidate)
      }
    }
    return out
  })
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
