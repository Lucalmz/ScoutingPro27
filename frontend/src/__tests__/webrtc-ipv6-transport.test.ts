import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createWebRtcService,
  isGlobalIpv6Address,
  isIpv6Address,
  isMdnsCandidateHostname,
  optimizeCandidatePriority,
  sortCandidatesPreferIpv6,
  classifyCandidatePair,
  parseIceCandidate
} from '../services/webrtc'
import { normalizePendingCandidates } from '../services/webrtc/sdpUtil'
import mqtt from 'mqtt'

vi.mock('mqtt', () => ({ default: { connect: vi.fn() } }))

vi.mock('../services/api', () => ({
  syncRecords: vi.fn().mockResolvedValue(undefined),
  createWebRtcTicket: vi.fn().mockResolvedValue({ ticket: 'ticket_x', expiresIn: 180 }),
  verifyWebRtcTicket: vi.fn().mockResolvedValue({ valid: true, userId: 'u1', username: 'U1' }),
  verifyToken: vi.fn().mockResolvedValue({ valid: false })
}))

// ============================================================================
// 1) ICE 传输策略：中继兜底必须是「可恢复的一次性降级」
// ============================================================================
describe('IPv6/P2P transport policy recovery (relay fallback must not latch)', () => {
  let mockMqttClient: any
  let createdConfigs: any[]
  let createdPcs: any[]
  let published: any[]

  const makeCallbacks = () => ({
    onStatusChange: vi.fn(),
    onRecordsReceived: async (r: any[]) => r,
    onAckReceived: vi.fn(),
    onRequestSync: vi.fn(),
    onIceStalled: vi.fn()
  })

  beforeEach(() => {
    vi.useFakeTimers()
    ;(globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ = true
    createdConfigs = []
    createdPcs = []
    published = []

    mockMqttClient = {
      on: vi.fn(),
      subscribe: vi.fn(),
      publish: vi.fn((_t: string, payload: string) => published.push(JSON.parse(payload))),
      connected: true,
      unsubscribe: vi.fn(),
      end: vi.fn()
    }
    vi.mocked(mqtt.connect).mockReturnValue(mockMqttClient)

    global.RTCPeerConnection = vi.fn().mockImplementation((config: any) => {
      createdConfigs.push(config)
      const pc: any = {
        createDataChannel: vi.fn().mockReturnValue({
          send: vi.fn(), readyState: 'connecting', close: vi.fn(),
          onopen: null, onclose: null, onmessage: null, onerror: null
        }),
        createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'offer-sdp' }),
        createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'answer-sdp' }),
        setLocalDescription: vi.fn().mockResolvedValue(undefined),
        setRemoteDescription: vi.fn().mockResolvedValue(undefined),
        addIceCandidate: vi.fn().mockResolvedValue(undefined),
        restartIce: vi.fn(),
        close: vi.fn(),
        getStats: vi.fn().mockResolvedValue(new Map()),
        connectionState: 'new',
        iceConnectionState: 'new',
        iceGatheringState: 'complete',
        localDescription: null,
        remoteDescription: null,
        onicecandidate: null,
        oniceconnectionstatechange: null,
        onconnectionstatechange: null,
        ondatachannel: null,
        onicegatheringstatechange: null
      }
      createdPcs.push(pc)
      return pc
    }) as any
    global.RTCSessionDescription = vi.fn().mockImplementation((init) => init) as any
    global.RTCIceCandidate = vi.fn().mockImplementation((init) => init) as any
  })

  afterEach(() => {
    vi.useRealTimers()
    ;(globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ = false
    vi.clearAllMocks()
  })

  const fireMqttConnect = async () => {
    const onConnect = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'connect')?.[1]
    onConnect?.()
    await vi.advanceTimersByTimeAsync(0)
  }

  /** 把指定 PC 的 ICE 卡在 checking，跑满看门狗预算直到触发中继兜底 */
  const stallUntilRelayFallback = async (pc: any) => {
    pc.iceConnectionState = 'checking'
    await pc.oniceconnectionstatechange?.()
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(5600)
    }
  }

  it('starts P2P-first with iceTransportPolicy:"all"', async () => {
    const svc = createWebRtcService(makeCallbacks() as any)
    await svc.join('EVENT-1', 'Alice', 'u1')
    await fireMqttConnect()

    expect(createdConfigs.length).toBeGreaterThan(0)
    expect(createdConfigs[0].iceTransportPolicy).toBe('all')
    svc.disconnect()
  })

  it('engages relay-only ONCE when ICE stalls, then returns to P2P-first on reconnect', async () => {
    const svc = createWebRtcService(makeCallbacks() as any)
    await svc.join('EVENT-1', 'Alice', 'u1')
    await fireMqttConnect()

    expect(createdConfigs[0].iceTransportPolicy).toBe('all')

    await stallUntilRelayFallback(createdPcs[0])

    // 兜底确实生效：新建了一条 relay-only 链路
    const relayPc = createdConfigs.find((c) => c.iceTransportPolicy === 'relay')
    expect(relayPc).toBeDefined()
    // 兜底不应污染候选池：relay-only 时禁用 iceCandidatePoolSize
    expect(relayPc!.iceCandidatePoolSize).toBe(0)

    // 网络恢复后显式重连 —— 必须回到 P2P 优先，重新尝试 IPv6/局域网直连
    createdConfigs = []
    createdPcs = []
    await svc.reconnectNow()
    await fireMqttConnect()
    await vi.advanceTimersByTimeAsync(0)

    expect(createdConfigs.length).toBeGreaterThan(0)
    expect(createdConfigs[createdConfigs.length - 1].iceTransportPolicy).toBe('all')
    svc.disconnect()
  })

  it('does not carry the relay latch into a brand new join()', async () => {
    const svc = createWebRtcService(makeCallbacks() as any)
    await svc.join('EVENT-1', 'Alice', 'u1')
    await fireMqttConnect()
    await stallUntilRelayFallback(createdPcs[0])
    expect(createdConfigs.some((c) => c.iceTransportPolicy === 'relay')).toBe(true)

    createdConfigs = []
    createdPcs = []
    await svc.join('EVENT-2', 'Alice', 'u1')
    await fireMqttConnect()
    await vi.advanceTimersByTimeAsync(0)

    expect(createdConfigs[createdConfigs.length - 1].iceTransportPolicy).toBe('all')
    svc.disconnect()
  })

  it('clears the relay latch once the DataChannel actually opens', async () => {
    const svc = createWebRtcService(makeCallbacks() as any)
    await svc.join('EVENT-1', 'Alice', 'u1')
    await fireMqttConnect()
    await stallUntilRelayFallback(createdPcs[0])

    const relayCfgIdx = createdConfigs.findIndex((c) => c.iceTransportPolicy === 'relay')
    expect(relayCfgIdx).toBeGreaterThanOrEqual(0)

    // 模拟中继链路成功打开 DataChannel
    const relayPcInstance = createdPcs[relayCfgIdx]
    const dc = relayPcInstance.createDataChannel.mock.results[0].value
    dc.readyState = 'open'
    dc.onopen?.()
    await vi.advanceTimersByTimeAsync(0)

    // 后续任何原因触发的重建都必须重新是 P2P 优先
    createdConfigs = []
    await svc.reconnectNow()
    await fireMqttConnect()
    await vi.advanceTimersByTimeAsync(0)
    expect(createdConfigs[createdConfigs.length - 1].iceTransportPolicy).toBe('all')
    svc.disconnect()
  })

  it('ICE restart offer carries deviceId so Host TOFU binding is preserved', async () => {
    const svc = createWebRtcService(makeCallbacks() as any)
    await svc.join('EVENT-1', 'Alice', 'u1')
    await fireMqttConnect()

    published = []
    const pc = createdPcs[0]
    pc.iceConnectionState = 'checking'
    await pc.oniceconnectionstatechange?.()
    await vi.advanceTimersByTimeAsync(5600) // 第一次 restartIce

    const restartOffer = published.find((p) => p.offer)
    expect(restartOffer).toBeDefined()
    expect(restartOffer.deviceId).toBeTruthy()
    expect(restartOffer.username).toBe('Alice')
    expect(restartOffer.userId).toBe('u1')
    svc.disconnect()
  })

  it('does not burn restartIce attempts while ICE is still gathering candidates', async () => {
    const svc = createWebRtcService(makeCallbacks() as any)
    await svc.join('EVENT-1', 'Alice', 'u1')
    await fireMqttConnect()

    const pc = createdPcs[0]
    pc.iceGatheringState = 'gathering' // TURN 分配 / IPv6 STUN 反射仍在进行
    pc.iceConnectionState = 'checking'
    await pc.oniceconnectionstatechange?.()
    await vi.advanceTimersByTimeAsync(5600)

    published = []
    // 收集未完成时不应发起 restartIce 重协商
    expect(pc.restartIce).not.toHaveBeenCalled()
    expect(published.find((p) => p.offer)).toBeUndefined()
    svc.disconnect()
  })
})

// ============================================================================
// 2) 候选优先级重写：TCP 候选不得被提权 (RFC 6544)
// ============================================================================
describe('candidate priority rewriting', () => {
  it('boosts global-unicast IPv6 UDP candidates', () => {
    const out = optimizeCandidatePriority(
      'candidate:3565074726 1 udp 2122260223 2408:8207:7852:1200:1c95:2bff:fe3a:8f2c 55123 typ host generation 0 network-id 4'
    )
    expect(out).toBe(
      'candidate:3565074726 1 udp 2130706431 2408:8207:7852:1200:1c95:2bff:fe3a:8f2c 55123 typ host generation 0 network-id 4'
    )
  })

  it('never boosts TCP candidates above UDP (RFC 6544 deprioritisation)', () => {
    const tcpActive = 'candidate:1234 1 tcp 1518348799 2408:8207::1 9 typ host tcptype active generation 0 network-id 4'
    const tcpPassive = 'candidate:1235 1 tcp 1015022591 240e:398::1 50001 typ host tcptype passive generation 0'
    expect(optimizeCandidatePriority(tcpActive)).toBe(tcpActive)
    expect(optimizeCandidatePriority(tcpPassive)).toBe(tcpPassive)

    // 同族内 UDP 必须严格高于 TCP
    const udp = optimizeCandidatePriority('candidate:1 1 udp 2122260223 2408:8207::1 50000 typ host generation 0')
    const udpPriority = Number(udp.split(/\s+/)[3])
    const tcpPriority = Number(tcpActive.split(/\s+/)[3])
    expect(udpPriority).toBeGreaterThan(tcpPriority)
  })

  it('leaves IPv4, link-local and malformed candidates untouched', () => {
    const v4 = 'candidate:1003 1 udp 2122260223 192.168.1.100 54323 typ host generation 0'
    const ll = 'candidate:1004 1 udp 2122260223 fe80::1 54324 typ host generation 0'
    expect(optimizeCandidatePriority(v4)).toBe(v4)
    expect(optimizeCandidatePriority(ll)).toBe(ll)
    expect(optimizeCandidatePriority('')).toBe('')
    expect(optimizeCandidatePriority('candidate:invalid')).toBe('candidate:invalid')
    expect(optimizeCandidatePriority(null as any)).toBe(null)
  })

  it('is idempotent', () => {
    const c = 'candidate:5 1 udp 2122260223 2400:3200::1 50000 typ host generation 0 network-id 2 network-cost 10'
    const once = optimizeCandidatePriority(c)
    expect(optimizeCandidatePriority(once)).toBe(once)
  })

  it('parses candidate fields by name rather than magic indices', () => {
    const p = parseIceCandidate('candidate:9 1 udp 2122260223 2408::1 50000 typ srflx raddr :: rport 0')
    expect(p).toMatchObject({
      hasPrefix: true,
      component: 1,
      protocol: 'udp',
      address: '2408::1',
      port: '50000',
      type: 'srflx'
    })
    expect(parseIceCandidate('garbage')).toBeNull()
  })
})

// ============================================================================
// 3) IPv6 地址判定
// ============================================================================
describe('IPv6 address classification', () => {
  it('accepts real-world global unicast prefixes', () => {
    for (const ip of [
      '240e:398:3241:880:c0de::1',   // China Telecom
      '2408:8207:7852:12::1',        // China Unicom
      '2409:8a00:1000::1',           // China Mobile
      '2606:4700:49::1',             // Cloudflare
      '2001:4860:4860::8888',        // Google
      '2400:3200::1',                // AliDNS
      '2a03:2880::1'                 // Meta
    ]) {
      expect(isGlobalIpv6Address(ip), ip).toBe(true)
    }
  })

  it('rejects reserved / non-routable ranges', () => {
    for (const ip of [
      '::1', '::', '::ffff:192.0.2.1', '64:ff9b::192.0.2.128', '100::1',
      'ff02::1',
      'fe80::1ff:fe00:3a60', 'febf::1',
      'fc00::1', 'fd12:3456:789a::1',
      '2002:cb00:7100:1::1',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001::1',
      '2001:db8:85a3::8a2e:370:7334', '2001:0db8::1',
      '2001:2::1', '2001:10::1', '2001:1f::1', '2001:20::1', '2001:2f::1',
      '192.168.1.1', '4000::1', '1fff::1', ''
    ]) {
      expect(isGlobalIpv6Address(ip), ip).toBe(false)
    }
  })

  it('rejects addresses whose first hextet omits leading zeros (2::1 is 0002::1, not 2000::/3)', () => {
    // 旧实现的正则 /^[23][0-9a-f]{0,3}:/ 会把这些误判为全球单播
    for (const ip of ['2::1', '23::1', '234::1', '3::1', '3f::1']) {
      expect(isGlobalIpv6Address(ip), ip).toBe(false)
    }
  })

  it('recognises zone-scoped IPv6 addresses (RFC 6874)', () => {
    // 旧实现 /^[0-9a-f:]+$/ 会把带 zone-id 的地址判成“非 IPv6”
    expect(isIpv6Address('fe80::1%eth0')).toBe(true)
    expect(isIpv6Address('fe80::1%25wlan0')).toBe(true)
    expect(isIpv6Address('2408:8207::1%en0')).toBe(true)
    expect(isGlobalIpv6Address('2408:8207:7852:1200::1%eth0')).toBe(true)
    // 链路本地即使带 zone 也不是全球单播
    expect(isGlobalIpv6Address('fe80::1%eth0')).toBe(false)
    expect(isIpv6Address('192.168.1.1')).toBe(false)
  })

  it('handles bracketed addresses from stats reporting', () => {
    expect(isIpv6Address('[2408:8207::1]')).toBe(true)
    expect(isGlobalIpv6Address('[2408:8207::1]')).toBe(true)
  })

  it('detects mDNS-obfuscated host candidate names', () => {
    expect(isMdnsCandidateHostname('a1b2c3d4-e5f6-7890-abcd-ef1234567890.local')).toBe(true)
    expect(isMdnsCandidateHostname('192.168.1.5')).toBe(false)
    expect(isMdnsCandidateHostname('2408::1')).toBe(false)
  })
})

// ============================================================================
// 4) 链路类型分类
// ============================================================================
describe('transport classification', () => {
  it('classifies direct IPv6, LAN, NAT and relay correctly', () => {
    expect(classifyCandidatePair('host', 'host', '240e:398::1', '2408:8207::2')).toBe('ipv6_p2p')
    expect(classifyCandidatePair('srflx', 'host', '240e:398::1', '192.168.1.1')).toBe('ipv6_p2p')
    expect(classifyCandidatePair('host', 'host', '192.168.1.100', '192.168.1.101')).toBe('lan_p2p')
    expect(classifyCandidatePair('host', 'host', '10.0.0.2', '10.0.0.3')).toBe('lan_p2p')
    expect(classifyCandidatePair('srflx', 'srflx', '114.114.114.114', '223.5.5.5')).toBe('nat_p2p')
    expect(classifyCandidatePair('host', 'srflx', '192.168.1.100', '223.5.5.5')).toBe('nat_p2p')
    expect(classifyCandidatePair('relay', 'host', '162.159.207.1', '192.168.1.100')).toBe('relay')
    expect(classifyCandidatePair('host', 'relay', '240e:398::1', '162.159.207.1')).toBe('relay')
    // 文档前缀仍算 IPv6 直连（非全球单播但确为 IPv6 链路）
    expect(classifyCandidatePair('host', 'srflx', '2001:db8::1', '2001:db8::2')).toBe('ipv6_p2p')
  })

  it('returns "unknown" instead of lying "nat_p2p" when addresses are unavailable', () => {
    expect(classifyCandidatePair('host', 'host', '', '')).toBe('unknown')
    expect(classifyCandidatePair('srflx', 'srflx', '0.0.0.0', '0.0.0.0')).toBe('unknown')
    expect(classifyCandidatePair('host', 'host', '::', '::')).toBe('unknown')
  })

  it('recognises mDNS-obfuscated host pairs as LAN direct links', () => {
    expect(
      classifyCandidatePair(
        'host', 'host',
        'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.local',
        '11111111-2222-3333-4444-555555555555.local'
      )
    ).toBe('lan_p2p')
  })
})

// ============================================================================
// 5) 待处理候选队列：必须先解密再排序
// ============================================================================
describe('pending candidate queue normalisation', () => {
  const IPV6_HOST = 'candidate:4 1 udp 2122260223 240e:398::1 50003 typ host'
  const IPV4_HOST = 'candidate:1 1 udp 2122260223 192.168.1.10 50000 typ host'
  const IPV6_TCP = 'candidate:7 1 tcp 1518348799 240e:398::1 9 typ host tcptype active'

  it('sortCandidatesPreferIpv6 puts global IPv6 UDP first and TCP last in family', () => {
    const sorted = sortCandidatesPreferIpv6([
      { candidate: IPV4_HOST },
      { candidate: IPV6_TCP },
      { candidate: IPV6_HOST }
    ])
    expect(sorted[0].candidate).toBe(IPV6_HOST)
    expect(sorted[1].candidate).toBe(IPV4_HOST)
    expect(sorted[2].candidate).toBe(IPV6_TCP)
  })

  it('sortCandidatesPreferIpv6 is a no-op on ciphertext payloads (why call sites must decrypt first)', () => {
    const encrypted = [
      { ciphertext: 'aaa', iv: '1', tag: 'x' },
      { ciphertext: 'bbb', iv: '2', tag: 'y' }
    ] as any[]
    expect(sortCandidatesPreferIpv6(encrypted)).toEqual(encrypted)
  })

  it('normalizePendingCandidates decrypts BEFORE ordering so IPv6 really goes first', async () => {
    // 队列顺序故意把 IPv4 放前面，且全部是密文
    const queue = [
      { ciphertext: 'enc-ipv4' },
      { ciphertext: 'enc-ipv6-tcp' },
      { ciphertext: 'enc-ipv6' }
    ] as any[]
    const table: Record<string, any> = {
      'enc-ipv4': { candidate: IPV4_HOST, sdpMid: '0', sdpMLineIndex: 0 },
      'enc-ipv6-tcp': { candidate: IPV6_TCP, sdpMid: '0', sdpMLineIndex: 0 },
      'enc-ipv6': { candidate: IPV6_HOST, sdpMid: '0', sdpMLineIndex: 0 }
    }

    const ordered = await normalizePendingCandidates(queue, async (p: any) => table[p.ciphertext])

    // 解密后才排序：全球单播 IPv6 UDP host 排第一；TCP 候选（即便也是 IPv6）排最后。
    // 注意 normalizePendingCandidates 同时会对 IPv6 候选做优先级提权，故用地址/协议断言。
    const describe = (c: any) => {
      const parts: string[] = c.candidate.split(/\s+/)
      return { address: parts[4], protocol: parts[2], type: parts[parts.indexOf('typ') + 1] }
    }
    expect(ordered.map(describe)).toEqual([
      { address: '240e:398::1', protocol: 'udp', type: 'host' },
      { address: '192.168.1.10', protocol: 'udp', type: 'host' },
      { address: '240e:398::1', protocol: 'tcp', type: 'host' }
    ])
    // IPv6 UDP host 候选确实被提权到 RFC 8445 的最高档
    expect(ordered[0].candidate).toContain('2130706431')
  })

  it('normalizePendingCandidates drops undecryptable entries instead of feeding garbage to addIceCandidate', async () => {
    const queue = [{ ciphertext: 'broken' }, { ciphertext: 'good' }] as any[]
    const ordered = await normalizePendingCandidates(queue, async (p: any) => {
      if (p.ciphertext === 'broken') throw new Error('bad tag')
      return { candidate: IPV6_HOST }
    })
    expect(ordered).toHaveLength(1)
    expect(ordered[0].candidate).toContain('240e:398::1')
  })

  it('normalizePendingCandidates applies the IPv6 priority boost to decrypted candidates', async () => {
    const ordered = await normalizePendingCandidates(
      [{ ciphertext: 'c' }] as any[],
      async () => ({ candidate: IPV6_HOST })
    )
    expect(ordered[0].candidate).toContain('2130706431')
  })

  it('normalizePendingCandidates tolerates plaintext queues and empty input', async () => {
    expect(await normalizePendingCandidates([])).toEqual([])
    const ordered = await normalizePendingCandidates([{ candidate: IPV6_HOST }] as any[])
    expect(ordered[0].candidate).toContain('2130706431')
  })
})

// ============================================================================
// 6) ICE 候选定向投递 + TURN 兜底配置
// ============================================================================
describe('candidate targeting and TURN fallback configuration', () => {
  let mockMqttClient: any
  let createdPcs: any[]
  let published: any[]

  beforeEach(() => {
    vi.useFakeTimers()
    ;(globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ = true
    createdPcs = []
    published = []
    mockMqttClient = {
      on: vi.fn(),
      subscribe: vi.fn(),
      publish: vi.fn((_t: string, payload: string) => published.push(JSON.parse(payload))),
      connected: true,
      unsubscribe: vi.fn(),
      end: vi.fn()
    }
    vi.mocked(mqtt.connect).mockReturnValue(mockMqttClient)

    global.RTCPeerConnection = vi.fn().mockImplementation(() => {
      const pc: any = {
        createDataChannel: vi.fn().mockReturnValue({
          send: vi.fn(), readyState: 'connecting', close: vi.fn(),
          onopen: null, onclose: null, onmessage: null, onerror: null
        }),
        createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'offer-sdp' }),
        createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'answer-sdp' }),
        setLocalDescription: vi.fn().mockResolvedValue(undefined),
        setRemoteDescription: vi.fn().mockResolvedValue(undefined),
        addIceCandidate: vi.fn().mockResolvedValue(undefined),
        restartIce: vi.fn(),
        close: vi.fn(),
        getStats: vi.fn().mockResolvedValue(new Map()),
        connectionState: 'new',
        iceConnectionState: 'new',
        iceGatheringState: 'complete',
        onicecandidate: null,
        oniceconnectionstatechange: null,
        onconnectionstatechange: null,
        ondatachannel: null,
        onicegatheringstatechange: null
      }
      createdPcs.push(pc)
      return pc
    }) as any
    global.RTCSessionDescription = vi.fn().mockImplementation((init) => init) as any
    global.RTCIceCandidate = vi.fn().mockImplementation((init) => init) as any
  })

  afterEach(() => {
    vi.useRealTimers()
    ;(globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ = false
    vi.clearAllMocks()
  })

  const makeCallbacks = () => ({
    onStatusChange: vi.fn(),
    onRecordsReceived: async (r: any[]) => r,
    onAckReceived: vi.fn(),
    onRequestSync: vi.fn()
  })

  it('targets ICE candidates at the live Host senderId even when the PC predates host_hello', async () => {
    // 本用例只验证信令投递目标，不需要假定时器；
    // signaling.send() 内部会走 WebCrypto HMAC 签名（真实异步 I/O），
    // 在 fake timers 下无法可靠地被 advanceTimersByTimeAsync 冲刷。
    vi.useRealTimers()
    const flush = () => new Promise((r) => setTimeout(r, 5))

    const svc = createWebRtcService(makeCallbacks() as any)
    await svc.join('EVENT-1', 'Alice', 'u1')

    // 客户端在收到 host_hello 之前就建好了 PeerConnection
    const onConnect = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'connect')?.[1]
    onConnect?.()
    await flush()
    const pc = createdPcs[0]
    expect(pc).toBeDefined()

    // Host 上线并告知自己的 signaling clientId
    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]
    await onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'host-signaling-id-1',
      type: 'host_hello',
      hostSessionId: 'host-session-1',
      deviceId: 'dev_host',
      timestamp: Date.now(),
      nonce: 'n1'
    })))
    await flush()

    // 此刻才收集到一个 IPv6 host 候选
    published.length = 0
    await pc.onicecandidate({
      candidate: {
        candidate: 'candidate:1 1 udp 2122260223 2408:8207:7852:1200::1 55123 typ host generation 0',
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: 'ufrag',
        type: 'host',
        protocol: 'udp',
        address: '2408:8207:7852:1200::1',
        toJSON: () => ({
          candidate: 'candidate:1 1 udp 2122260223 2408:8207:7852:1200::1 55123 typ host generation 0',
          sdpMid: '0',
          sdpMLineIndex: 0,
          usernameFragment: 'ufrag'
        })
      }
    })
    // signaling.send 内部会走 HMAC 签名（异步且未被 await），需多刷一拍
    await flush()

    const candMsg = published.find((p) => p.candidate)
    expect(candMsg).toBeDefined()
    // 修复前：target 为 undefined => 候选被广播到整个房间，而不是定向发给 Host
    expect(candMsg.target).toBe('host-signaling-id-1')
    svc.disconnect()
  })

  it('keeps a usable TURN relay fallback in the ICE configuration', async () => {
    const { STUN_SERVERS } = await import('../services/webrtc/connectivity')
    const servers = STUN_SERVERS.iceServers || []
    const turnServers = servers.filter((s) => String(s.urls).startsWith('turn'))
    expect(turnServers.length).toBeGreaterThanOrEqual(4)
    for (const t of turnServers) {
      expect(t.username).toBeTruthy()
      expect(t.credential).toBeTruthy()
    }
    // 必须同时具备 UDP / TCP / TLS 三种中继传输，否则严苛网络下兜底也会失败
    const urls = turnServers.map((t) => String(t.urls)).join(' ')
    expect(urls).toContain('transport=tcp')
    expect(urls).toContain('turns:')
  })
})
