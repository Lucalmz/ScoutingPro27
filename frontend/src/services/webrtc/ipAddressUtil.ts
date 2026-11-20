/**
 * IP 地址清洗与协议族/地址类型识别纯函数工具集
 */

/**
 * 统一清洗 IP 地址：剥除中括号、附带的端口号以及 IPv6 作用域标识 (scope id)
 */
export function cleanIpAddress(ip: string): string {
  if (!ip || typeof ip !== 'string') return ''
  let clean = ip.trim()
  // 匹配带中括号的形式 [2409:...]:port、[fe80::1%eth0]:port、[ ::ffff:192.0.2.1 ]:port 及空括号 []:port / [   ]:port
  const bracketMatch = clean.match(/^\[([^\]]*)\](?::\d+)?$/)
  if (bracketMatch) {
    const inner = bracketMatch[1]?.trim() ?? ''
    if (!inner) return ''
    clean = inner
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
 * 将 IPv6 地址严格解析并展开为 8 个 16 位无符号整数组（0..0xffff）；
 * 畸形形式（如 ":::"、多个 "::"、无 "::" 时不足或超过 8 段、超长十六进制段）一律返回 null。
 */
function expandIpv6Hextets(ip: string): number[] | null {
  if (!ip || typeof ip !== 'string') return null
  const clean = cleanIpAddress(ip)
  if (!clean || !clean.includes(':')) return null
  if (clean.includes(':::')) return null

  const doubleColonParts = clean.split('::')
  if (doubleColonParts.length > 2) return null

  const parseSegmentList = (segStr: string, allowIpv4Tail: boolean): number[] | null => {
    if (segStr === '') return []
    const tokens = segStr.split(':')
    const out: number[] = []
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i]!
      if (!tok) return null
      if (tok.includes('.')) {
        if (!allowIpv4Tail || i !== tokens.length - 1) return null
        const octets = tok.split('.')
        if (octets.length !== 4) return null
        const nums: number[] = []
        for (const o of octets) {
          if (!/^\d{1,3}$/.test(o)) return null
          const n = parseInt(o, 10)
          if (n < 0 || n > 255) return null
          nums.push(n)
        }
        out.push((nums[0]! << 8) | nums[1]!)
        out.push((nums[2]! << 8) | nums[3]!)
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(tok)) return null
        out.push(parseInt(tok, 16))
      }
    }
    return out
  }

  if (doubleColonParts.length === 2) {
    const left = parseSegmentList(doubleColonParts[0]!, false)
    const right = parseSegmentList(doubleColonParts[1]!, true)
    if (!left || !right) return null
    const missing = 8 - (left.length + right.length)
    if (missing < 1) return null
    return [...left, ...Array<number>(missing).fill(0), ...right]
  }

  const all = parseSegmentList(clean, true)
  if (!all || all.length !== 8) return null
  return all
}

/**
 * 校验是否为合法的公网全球单播 IPv6 地址 (Global Unicast Address, 2000::/3)
 */
export function isGlobalIpv6Address(ip: string): boolean {
  const hextets = expandIpv6Hextets(ip)
  if (!hextets) return false

  const h0 = hextets[0]!
  const h1 = hextets[1]!

  // 全球单播前缀 2000::/3 (0x2000 ~ 0x3fff，自动排除 :: / ::1 / ::ffff: / fe80::/10 / fc00::/7 / ff00::/8)
  if (h0 < 0x2000 || h0 > 0x3fff) {
    return false
  }

  // 排除 6to4 前缀 2002::/16
  if (h0 === 0x2002) {
    return false
  }

  // 排除 2001:: 特殊保留段（按数值对比 hextets[1]，防前导零如 2001:0000::1 / 2001:0002::1 / 2001:0010::1 绕过）：
  // - 2001:0000::/32 (Teredo)
  // - 2001:0002::/32 (Benchmarking)
  // - 2001:0010::/28 ~ 2001:002f:: (ORCHID / ORCHIDv2)
  // - 2001:0db8::/32 (Documentation)
  if (h0 === 0x2001) {
    if (h1 === 0x0000 || h1 === 0x0002 || h1 === 0x0db8) {
      return false
    }
    if (h1 >= 0x0010 && h1 <= 0x002f) {
      return false
    }
  }

  return true
}

/**
 * 校验是否为任意有效 IPv6 地址
 */
export function isIpv6Address(ip: string): boolean {
  return expandIpv6Hextets(ip) !== null
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
 * - 28.0.0.0/8 (28.x.x.x): 部分 Clash / Surge / Shadowrocket 自定义 Fake-IP 虚拟段
 * - 100.64.0.0/10: CGNAT / Tailscale / Clash TUN 段
 * - fc00::/7 (fc00:: ~ fdff::, 如 fdfe:dcba:9876::1): TUN IPv6 ULA 虚拟地址段
 */
export function isTunVirtualAddress(ip: string): boolean {
  if (!ip || typeof ip !== 'string') return false
  const clean = cleanIpAddress(ip)
  if (!clean) return false

  const ipv4Parts = clean.split('.')
  if (ipv4Parts.length === 4 && ipv4Parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) {
    const a = Number(ipv4Parts[0])
    const b = Number(ipv4Parts[1])
    const c = Number(ipv4Parts[2])
    if (a === 198 && (b === 18 || b === 19)) return true
    if (a === 28) return true
    // 识别移动端 v2rayNG / Xray / NekoBox 默认虚拟网卡地址段 (10.10.14.x / 26.26.26.x)
    if ((a === 10 && b === 10 && c === 14) || (a === 26 && b === 26 && c === 26)) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    // 识别 Cloudflare WARP (172.16.0.x)、Docker 默认网桥 (172.17.0.0/16)、
    // sing-box / Mihomo / NekoBox 默认 TUN IPv4 段 (172.18..31.0.x) 及 WSL2 / Hyper-V /20 虚拟网桥段
    // （172.18..31 内第三八位组 >= 16 的完整 /20 区间，如 172.21.64.0/20 -> 172.21.64.x..172.21.79.x）；
    // 精准放行 iOS 个人热点 (172.20.10.x) 与蜂窝网络真实内网段 (10.61.x.x 等)
    if (a === 172) {
      if (b === 16 && c === 0) return true
      if (b === 17) return true
      if (b >= 18 && b <= 31 && (c === 0 || c >= 16)) return true
    }
    return false
  }

  const hextets = expandIpv6Hextets(clean)
  if (hextets && hextets[0]! >= 0xfc00 && hextets[0]! <= 0xfdff) return true
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

/**
 * 提取 IPv6 的 /64 前缀（前 4 个规范化十六进制 hextet）：
 * 先将含 "::" 的压缩 IPv6 完整展开为 8 个十六进制段，并去掉前导零，
 * 确保 "2409:8a00::1" 与 "2409:8a00:0000:0000:abcd::2" 得到一致的 "2409:8a00:0:0"。
 */
export function getIpv6Prefix64(ip: string): string {
  const hextets = expandIpv6Hextets(ip)
  if (!hextets) return ''
  return hextets
    .slice(0, 4)
    .map((h) => h.toString(16))
    .join(':')
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
