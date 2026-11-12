/**
 * IP 地址清洗与协议族/地址类型识别纯函数工具集
 */

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
    // 若为 IPv4:port 形式（含点号且仅含单个冒号加端口数字，如 1.2.3.4:8080）
    if (clean.includes('.') && /^[^:]+:\d+$/.test(clean)) {
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
