import mqtt from 'mqtt'
import type { WebRtcMessage, ScoutingRecord, ConnectionStatus, WebRtcDirectMessage } from '@/types'
import { useInboxStore } from '@/stores/inbox'
import { syncRecords, verifyToken } from '@/services/api'
import { DataChannelSender } from '@/services/dataChannelSender'
import { safeJsonParse } from '@/utils/json'
import {
  deriveHmacKey,
  signSignalingPayload,
  verifySignalingPayload,
  generateNonce,
  generateEcdhKeyPair,
  exportEcdhPublicKey,
  importEcdhPublicKey,
  deriveSharedAesKey,
  encryptSignalingData,
  decryptSignalingData,
  NonceLruCache
} from '@/utils/crypto'

// ---------- Configuration & Connectivity Probe ----------

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
          try { ws.close() } catch {}
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

const STUN_SERVERS: RTCConfiguration = {
  iceServers: [
    {
      urls: "stun:stun.relay.metered.ca:80",
    },
    {
      urls: "turn:global.relay.metered.ca:80",
      username: "ac2f17ce5be760e70209a1da",
      credential: "hnCbsBr54qxItqgo",
    },
    {
      urls: "turn:global.relay.metered.ca:80?transport=tcp",
      username: "ac2f17ce5be760e70209a1da",
      credential: "hnCbsBr54qxItqgo",
    },
    {
      urls: "turn:global.relay.metered.ca:443",
      username: "ac2f17ce5be760e70209a1da",
      credential: "hnCbsBr54qxItqgo",
    },
    {
      urls: "turns:global.relay.metered.ca:443?transport=tcp",
      username: "ac2f17ce5be760e70209a1da",
      credential: "hnCbsBr54qxItqgo",
    }
  ]
}

/**
 * MQTT-based signaling channel for WebRTC SDP/ICE exchange.
 * Enhanced with:
 * 1. Hard boundary isolation (strictly drops business types on MQTT)
 * 2. Full-payload HMAC-SHA256 signature verification & Nonce/Timestamp replay check
 */
class SignalingChannel {
  private client: mqtt.MqttClient | null = null
  private topic: string = ''
  private clientId: string
  private messageCallback: ((data: unknown) => void) | null = null
  private hmacKey: CryptoKey | null = null
  private nonceCache: NonceLruCache = new NonceLruCache(5000, 30000)

  constructor(private room: string) {
    this.clientId = `sp27-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  async initTopic() {
    try {
      this.hmacKey = await deriveHmacKey(this.room)
    } catch (e) {
      console.warn('[Signaling] Failed to derive HMAC key:', e)
    }
    const encoder = new TextEncoder()
    const data = encoder.encode(this.room + "-scoutingpro27")
    const hashBuffer = await crypto.subtle.digest('SHA-256', data)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
    this.topic = `scoutingpro27/signal/${hashHex}`
  }

  connect(callbacks: {
    onMessage: (data: unknown) => void
    onConnect?: () => void
    onError?: (err?: Error) => void
  }): void {
    this.messageCallback = callbacks.onMessage
    this.client = mqtt.connect('wss://broker.emqx.io:8084/mqtt', {
      clientId: this.clientId,
      clean: true,
      connectTimeout: 4000,
    })

    this.client.on('connect', () => {
      this.client!.subscribe(this.topic)
      callbacks.onConnect?.()
    })

    this.client.on('error', (err) => {
      callbacks.onError?.(err)
    })
    
    this.client.on('offline', () => {
      callbacks.onError?.()
    })

    this.client.on('message', async (_topic: string, payload: Uint8Array) => {
      const decoded = new TextDecoder().decode(payload)
      const msg = safeJsonParse<any>(decoded)
      if (!msg) return

      // 硬隔离安全拦截：MQTT 信道严禁出现任何业务数据指令，防范旁路注入
      const BUSINESS_TYPES = ['SYNC_DATA', 'DIRECT_MESSAGE', 'REQUEST_SYNC', 'ACK_SYNC']
      if (BUSINESS_TYPES.includes(msg.type)) {
        console.warn(`[Security] Dropped illegal business payload '${msg.type}' over public MQTT signaling channel.`)
        return
      }

      // 忽略自己发的消息
      if (msg.sender === this.clientId) return
      // 如果指定了 target 且不是自己，忽略
      if (msg.target && msg.target !== this.clientId) return

      // 时间戳与 Nonce 防重放校验 (±30s)
      if (msg.timestamp && msg.nonce) {
        const fresh = this.nonceCache.verifyAndAdd(msg.nonce, msg.timestamp)
        if (!fresh) {
          console.warn('[Security] Dropped signaling message: invalid timestamp or replayed nonce.')
          return
        }
      }

      // 全载荷 HMAC-SHA256 签名校验
      if (this.hmacKey && msg.signature) {
        const valid = await verifySignalingPayload(this.hmacKey, msg, msg.signature)
        if (!valid) {
          console.warn('[Security] Dropped signaling message: invalid HMAC signature.')
          return
        }
      }

      // 校验合法信令白名单指令集
      const ALLOWED_SIGNAL_TYPES = ['offer', 'answer', 'candidate', 'host_hello', 'HOST_LEAVING', 'key_exchange']
      const hasAllowedType = msg.type && ALLOWED_SIGNAL_TYPES.includes(msg.type)
      const hasSdpPayload = msg.offer || msg.answer || msg.candidate || msg.encrypted
      if (!hasAllowedType && !hasSdpPayload) {
        console.warn(`[Security] Dropped unknown signaling message structure.`)
        return
      }

      this.messageCallback?.(msg)
    })
  }

  async send(data: unknown, target?: string): Promise<void> {
    if (this.client) {
      const envelope: Record<string, unknown> = {
        ...(data as Record<string, unknown>),
        sender: this.clientId,
        timestamp: Date.now(),
        nonce: generateNonce()
      }
      if (target) {
        envelope.target = target
      }
      if (this.hmacKey) {
        try {
          envelope.signature = await signSignalingPayload(this.hmacKey, envelope)
        } catch (e) {
          console.warn('[Signaling] Failed to sign payload:', e)
        }
      }
      if (this.client && typeof this.client.publish === 'function') {
        this.client.publish(this.topic, JSON.stringify(envelope))
      }
    }
  }

  close(): void {
    if (this.client) {
      this.client.unsubscribe(this.topic)
      this.client.end()
      this.client = null
    }
  }
}

// ---------- Public API ----------

export type WebRtcCallbacks = {
  onStatusChange: (status: ConnectionStatus) => void
  /** 返回真正被接受写入本地的记录，Host 用此打 hostSeq */
  onRecordsReceived: (records: ScoutingRecord[], senderId?: string) => Promise<ScoutingRecord[]>
  onAckReceived: (recordIds: string[], stampedRecords?: ScoutingRecord[], rejectedRecordIds?: string[]) => void
  /** sinceVersion: 0 或缺失表示全量请求；>0 表示增量请求 */
  onRequestSync: (sinceVersion: number, senderId?: string) => void
  onClientConnected?: (userId: string, userName: string) => void
}

export type WebRtcService = ReturnType<typeof createWebRtcService>

export function createWebRtcService(callbacks: WebRtcCallbacks) {
  let isHostMode = false
  let isExplicitlyClosed = false
  let signaling: SignalingChannel | null = null
  let status: ConnectionStatus = 'offline'
  let currentInviteCode = ''
  let hostSessionId = ''
  let currentHostSessionId = ''

  // Ephemeral ECDH Key Pair & Encryption State
  let localEcdhKeyPair: CryptoKeyPair | null = null
  let localEcdhPubHex = ''
  let clientSharedAesKey: CryptoKey | null = null
  const clientSharedKeys = new Map<string, CryptoKey>() // Host: sender -> AES key

  // Client mode state
  let clientPc: RTCPeerConnection | null = null
  let clientDc: RTCDataChannel | null = null
  let clientSender: DataChannelSender | null = null
  let clientPendingCandidates: RTCIceCandidateInit[] = []
  let clientHostSenderId: string | undefined = undefined

  // Host mode state
  const clients = new Map<string, {
    pc: RTCPeerConnection
    sessionId?: string
    dc?: RTCDataChannel
    sender?: DataChannelSender
    pendingCandidates: RTCIceCandidateInit[]
  }>()
  const stagedClients = new Map<string, {
    pc: RTCPeerConnection
    sessionId?: string
    dc?: RTCDataChannel
    sender?: DataChannelSender
    pendingCandidates: RTCIceCandidateInit[]
  }>()
  const preOfferCandidates = new Map<string, RTCIceCandidateInit[]>()
  const hostQueues = new Map<string, Promise<void>>()
  const scoutIdToClientId = new Map<string, string>()
  const clientIdToScoutId = new Map<string, string>()
  const offlineMessages = new Map<string, WebRtcDirectMessage[]>()

  let localUserId: string | undefined = undefined
  let localUserName: string | undefined = undefined

  // 记录切片大小（15条），防止 SCTP 缓冲区击穿与丢包
  const RECORD_CHUNK_SIZE = 15

  // 增量同步：Host 全局序列号计数器。重启前应先通过 initHostSeq 从已持久化记录的最大 hostSeq 恢复
  let hostSeqCounter = 0

  function enqueueHostTask(sender: string, task: () => Promise<void>): Promise<void> {
    const q = hostQueues.get(sender) || Promise.resolve()
    const nextQ = q.then(task).catch(console.error)
    hostQueues.set(sender, nextQ)
    return nextQ
  }

  function cleanupPeerResources(senderId: string) {
    clientSharedKeys.delete(senderId)
    hostQueues.delete(senderId)
    preOfferCandidates.delete(senderId)
  }

  // --- status helper ---
  function setStatus(s: ConnectionStatus) {
    status = s
    callbacks.onStatusChange(s)
  }

  function updateHostStatus() {
    if (!isHostMode) return
    let active = 0
    clients.forEach(c => {
      if (c.dc && c.dc.readyState === 'open') active++
    })
    if (active > 0) {
      setStatus('connected')
    } else if (signaling) {
      setStatus('waiting')
    } else {
      setStatus('offline')
    }
  }

  // --- send a JSON message over the data channel with queuing & backpressure ---
  function sendMessage(msg: WebRtcMessage, targetId?: string): Promise<void> {
    console.log(`[WebRTC] Sending message ${msg.type} to ${targetId || 'all'}`);
    const payload = JSON.stringify(msg)
    if (isHostMode) {
      if (targetId) {
        const c = clients.get(targetId)
        if (c && c.dc && c.dc.readyState === 'open') {
          if (!c.sender) c.sender = new DataChannelSender(c.dc)
          return c.sender.enqueueSend(payload)
        }
        return Promise.resolve()
      } else {
        const promises: Promise<void>[] = []
        clients.forEach(c => {
          if (c.dc && c.dc.readyState === 'open') {
            if (!c.sender) c.sender = new DataChannelSender(c.dc)
            promises.push(c.sender.enqueueSend(payload))
          }
        })
        return Promise.all(promises).then(() => {})
      }
    } else {
      if (clientDc && clientDc.readyState === 'open') {
        if (!clientSender) {
          clientSender = new DataChannelSender(clientDc, (isCongested) => {
            if (isCongested) setStatus('unstable')
          })
        }
        return clientSender.enqueueSend(payload)
      }
      return Promise.resolve()
    }
  }

  function getLocalAuthToken(): string | undefined {
    try {
      const userJson = localStorage.getItem('scoutingpro-user')
      if (userJson) {
        const user = JSON.parse(userJson)
        if (user && user.token) return user.token
      }
    } catch {}
    return undefined
  }

  // --- handle incoming data-channel messages ---
  async function handleChannelMessage(ev: MessageEvent, senderId?: string) {
    const msg = safeJsonParse<WebRtcMessage>(ev.data)
    if (!msg) {
      console.warn('[WebRTC] Ignored invalid or malformed data-channel message payload')
      return
    }

    if (msg.authCode && msg.authCode !== currentInviteCode) {
      console.warn('[WebRTC] Auth code mismatch, ignoring message')
      return
    }

    console.log(`[WebRTC] Received message ${msg.type} from ${senderId || 'unknown'}`)

    switch (msg.type) {
      case 'REQUEST_SYNC':
        if (isHostMode && senderId) {
          const tokenToVerify = msg.token
          if (tokenToVerify) {
            try {
              const auth = await verifyToken(tokenToVerify)
              if (auth && auth.valid && auth.userId) {
                // 密码学强校验绑定：以 JWT 解密提取出的 userId 为准，绝对禁止信任客户端在握手包中自报的 senderUserId
                const authenticatedUserId = auth.userId

                // 1. Anti-DoS 核心防御：如果当前 senderId 已绑定到其他用户的活跃会话，而本次握手解出的 authenticatedUserId 与之不符，
                // 说明是房间内另一合法成员企图冒充该 senderId 进行劫持/踢人 (DoS 攻击)，严禁晋升替换，立即销毁 staged 预备连接！
                const existingBoundScoutId = clientIdToScoutId.get(senderId)
                if (existingBoundScoutId && existingBoundScoutId !== authenticatedUserId) {
                  console.warn(`[WebRTC Host Security] Rejected staged session promotion for ${senderId}: authenticated identity "${authenticatedUserId}" does not match existing bound identity "${existingBoundScoutId}". Anti-DoS hijack prevented!`)
                  const staged = stagedClients.get(senderId)
                  if (staged) {
                    if (staged.dc) staged.dc.onclose = null
                    staged.pc.onconnectionstatechange = null
                    staged.pc.oniceconnectionstatechange = null
                    staged.dc?.close()
                    staged.pc.close()
                    stagedClients.delete(senderId)
                  }
                  return
                }

                // 2. 如果该用户之前绑定的不是当前的 senderId（例如换了客户端ID重连），销毁旧的 clientId 连接
                const oldClientId = scoutIdToClientId.get(authenticatedUserId)
                if (oldClientId && oldClientId !== senderId) {
                  const oldClient = clients.get(oldClientId)
                  if (oldClient) {
                    console.log(`[WebRTC Host Security] JWT authenticated for scout ${authenticatedUserId}: replacing old session ${oldClientId} with ${senderId}`)
                    if (oldClient.dc) oldClient.dc.onclose = null
                    oldClient.pc.onconnectionstatechange = null
                    oldClient.pc.oniceconnectionstatechange = null
                    oldClient.dc?.close()
                    oldClient.pc.close()
                    clients.delete(oldClientId)
                    clientIdToScoutId.delete(oldClientId)
                    cleanupPeerResources(oldClientId)
                  }
                }

                // 3. 如果存在相同 senderId 的 staged 会话，且身份比对一致，正式晋升并回收旧会话
                const staged = stagedClients.get(senderId)
                if (staged) {
                  const oldActive = clients.get(senderId)
                  if (oldActive && oldActive !== staged) {
                    console.log(`[WebRTC Host Security] JWT authenticated for scout ${authenticatedUserId}: promoting staged session and closing previous active session for ${senderId}`)
                    if (oldActive.dc) oldActive.dc.onclose = null
                    oldActive.pc.onconnectionstatechange = null
                    oldActive.pc.oniceconnectionstatechange = null
                    oldActive.dc?.close()
                    oldActive.pc.close()
                  }
                  clients.set(senderId, staged)
                  stagedClients.delete(senderId)
                }

                scoutIdToClientId.set(authenticatedUserId, senderId)
                clientIdToScoutId.set(senderId, authenticatedUserId)
                if (auth.username) {
                  callbacks.onClientConnected?.(authenticatedUserId, auth.username)
                }
                const pending = offlineMessages.get(authenticatedUserId)
                if (pending && pending.length > 0) {
                  pending.forEach(m => sendMessage(m, senderId))
                  offlineMessages.delete(authenticatedUserId)
                }
              } else {
                console.warn(`[WebRTC Host Security] Rejected REQUEST_SYNC from ${senderId}: invalid JWT token signature`)
                const staged = stagedClients.get(senderId)
                if (staged) {
                  if (staged.dc) staged.dc.onclose = null
                  staged.pc.close()
                  stagedClients.delete(senderId)
                }
                return
              }
            } catch (err) {
              console.warn(`[WebRTC Host Security] JWT verify exception from ${senderId}:`, err)
              const staged = stagedClients.get(senderId)
              if (staged) {
                if (staged.dc) staged.dc.onclose = null
                staged.pc.close()
                stagedClients.delete(senderId)
              }
              return
            }
          } else {
            console.warn(`[WebRTC Host Security] Rejected REQUEST_SYNC from ${senderId}: missing authentication token`)
            const staged = stagedClients.get(senderId)
            if (staged) {
              if (staged.dc) staged.dc.onclose = null
              staged.pc.close()
              stagedClients.delete(senderId)
            }
            return
          }
        }
        callbacks.onRequestSync(msg.sinceVersion ?? 0, senderId)
        break
      case 'SYNC_DATA': {
        if (msg.hostSessionId) {
          currentHostSessionId = msg.hostSessionId
        }

        if (isHostMode && senderId && !clientIdToScoutId.has(senderId)) {
          if (msg.token) {
            try {
              const auth = await verifyToken(msg.token)
              if (auth && auth.valid && auth.userId) {
                const existingBoundScoutId = clientIdToScoutId.get(senderId)
                if (existingBoundScoutId && existingBoundScoutId !== auth.userId) {
                  console.warn(`[WebRTC Host Security] Rejected SYNC_DATA identity bind for ${senderId}: authenticated identity "${auth.userId}" does not match existing bound identity "${existingBoundScoutId}". Anti-DoS hijack prevented!`)
                  const staged = stagedClients.get(senderId)
                  if (staged) {
                    if (staged.dc) staged.dc.onclose = null
                    staged.pc.onconnectionstatechange = null
                    staged.pc.oniceconnectionstatechange = null
                    staged.dc?.close()
                    staged.pc.close()
                    stagedClients.delete(senderId)
                  }
                  return
                }

                const staged = stagedClients.get(senderId)
                if (staged) {
                  const oldActive = clients.get(senderId)
                  if (oldActive && oldActive !== staged) {
                    if (oldActive.dc) oldActive.dc.onclose = null
                    oldActive.pc.onconnectionstatechange = null
                    oldActive.pc.oniceconnectionstatechange = null
                    oldActive.dc?.close()
                    oldActive.pc.close()
                  }
                  clients.set(senderId, staged)
                  stagedClients.delete(senderId)
                }

                scoutIdToClientId.set(auth.userId, senderId)
                clientIdToScoutId.set(senderId, auth.userId)
              }
            } catch (err) {
              console.warn(`[WebRTC Host Security] JWT verify exception on SYNC_DATA from ${senderId}:`, err)
            }
          }
        }

        if (isHostMode) {
          return enqueueHostTask(senderId || 'default', async () => {
            const expectedScoutId = senderId ? clientIdToScoutId.get(senderId) : undefined
            
            // 安全过滤：防伪造冒充。每一条同步的记录必须匹配该 DataChannel 经 JWT 验证绑定的权威 scoutId
            const legitimateRecords: ScoutingRecord[] = []
            const forgedRecordIds: string[] = []

            for (const r of msg.records) {
              if (!expectedScoutId || r.scoutId !== expectedScoutId) {
                console.error(`[WebRTC Host Security] Dropped forged record ${r.id}: claimed scoutId="${r.scoutId}" does not match peer authenticated scoutId="${expectedScoutId}"`)
                forgedRecordIds.push(r.id)
              } else {
                legitimateRecords.push(r)
              }
            }

            // 步骤 1：本地过滤并打上单调递增的 hostSeq
            const accepted = legitimateRecords.length > 0 ? await callbacks.onRecordsReceived(legitimateRecords, senderId) : []
            const stagedSeq = hostSeqCounter
            if (accepted.length > 0) {
              stampHostSeq(accepted)
            }

            // 步骤 2：持久化先于广播执行！确保落库成功后再通知外界
            if (accepted.length > 0) {
              try {
                await syncRecords(accepted)
              } catch (err) {
                console.error('[WebRTC Host] Failed to persist stamped records to DB:', err)
                // 回滚计数器与 hostSeq，避免虚高断号
                hostSeqCounter = stagedSeq
                for (const r of accepted) {
                  r.hostSeq = undefined
                }
                // 回传拒绝回执，提示客户端重试
                sendMessage({
                  type: 'ACK_SYNC',
                  recordIds: msg.records.map(r => r.id),
                  stampedRecords: [],
                  rejectedRecordIds: msg.records.map(r => r.id),
                  authCode: currentInviteCode,
                  hostSessionId
                }, senderId)
                return
              }
            }

            const rejectedRecordIds = [
              ...forgedRecordIds,
              ...legitimateRecords.filter(r => !accepted.some(a => a.id === r.id)).map(r => r.id)
            ]

            // 步骤 3：持久化成功，向原始推送者回传 ACK（含已打号记录及被拒记录 ID）
            sendMessage({
              type: 'ACK_SYNC',
              recordIds: msg.records.map(r => r.id),
              stampedRecords: accepted,
              rejectedRecordIds,
              authCode: currentInviteCode,
              hostSessionId
            }, senderId)

            // 步骤 4：唯有 Host 持久化成功后，才向房间内其他 Client 广播更新
            if (accepted.length > 0) {
              clients.forEach((c, cid) => {
                if (cid !== senderId && c.dc && c.dc.readyState === 'open') {
                  if (!c.sender) c.sender = new DataChannelSender(c.dc)
                  c.sender.enqueueSend(JSON.stringify({
                    type: 'SYNC_DATA',
                    records: accepted,
                    authCode: currentInviteCode,
                    hostSessionId
                  }))
                }
              })
            }
          })
        } else {
          // Client 收到 Host 下发的记录，写入本地
          await callbacks.onRecordsReceived(msg.records, senderId)
        }
        break
      }
      case 'ACK_SYNC':
        if (msg.hostSessionId) {
          currentHostSessionId = msg.hostSessionId
        }
        callbacks.onAckReceived(msg.recordIds, msg.stampedRecords, msg.rejectedRecordIds)
        break
      case 'DIRECT_MESSAGE':
        const inboxStore = useInboxStore()
        inboxStore.addMessage({
          title: msg.title,
          body: msg.body,
          type: 'direct',
          senderId: msg.senderId,
          senderName: msg.senderName,
          targetId: msg.targetId,
          targetName: msg.targetName,
          deliveryStatus: 'DELIVERED'
        })
        break
    }
  }

  // --- build peer connection + data channel ---
  function createPeerConnection(targetSender?: string, onDisconnect?: () => void): RTCPeerConnection {
    const peer = new RTCPeerConnection(STUN_SERVERS)

    peer.onicecandidate = async (ev) => {
      if (ev.candidate) {
        console.log(`[WebRTC] ICE Candidate: type=${ev.candidate.type}, protocol=${ev.candidate.protocol}, address=${ev.candidate.address}`);
        if (signaling) {
          const target = isHostMode ? targetSender : clientHostSenderId;
          let candPayload: any = ev.candidate;
          try {
            if (isHostMode && targetSender && clientSharedKeys.has(targetSender)) {
              candPayload = await encryptSignalingData(clientSharedKeys.get(targetSender)!, JSON.stringify(ev.candidate))
            } else if (!isHostMode && clientSharedAesKey) {
              candPayload = await encryptSignalingData(clientSharedAesKey, JSON.stringify(ev.candidate))
            }
          } catch (err) {
            console.warn('[WebRTC] Failed to encrypt candidate, sending plaintext fallback:', err)
          }
          signaling.send({ candidate: candPayload }, target)
        }
      } else {
        console.log(`[WebRTC] ICE Gathering Complete (null candidate)`);
      }
    }

    let iceTimeout: NodeJS.Timeout | null = null
    const origClose = peer.close.bind(peer)
    peer.close = () => {
      if (iceTimeout) {
        clearTimeout(iceTimeout)
        iceTimeout = null
      }
      origClose()
    }

    peer.onconnectionstatechange = () => {
      console.log(`[WebRTC] Connection state changed: ${peer.connectionState}`);
      if (['disconnected', 'failed', 'closed'].includes(peer.connectionState)) {
        if (iceTimeout) {
          clearTimeout(iceTimeout)
          iceTimeout = null
        }
      }
      if (isHostMode) {
        if (['disconnected', 'failed', 'closed'].includes(peer.connectionState) && targetSender) {
          peer.close()
          clients.delete(targetSender)
          cleanupPeerResources(targetSender)
        }
        updateHostStatus()
      } else {
        switch (peer.connectionState) {
          case 'connected':
            if (clientDc && clientDc.readyState === 'open') {
              setStatus('connected')
            }
            break
          case 'disconnected':
          case 'failed':
          case 'closed':
          case 'new':
            setStatus('offline')
            break
          default:
            setStatus('connecting')
        }
      }
    }

    peer.oniceconnectionstatechange = async () => {
      console.log(`[WebRTC] ICE Connection state: ${peer.iceConnectionState}`);
      
      if (peer.iceConnectionState === 'checking') {
         // do nothing
      } else if (peer.iceConnectionState === 'disconnected' || peer.iceConnectionState === 'failed') {
        setStatus('unstable') // Immediately inform UI
        if (!iceTimeout) {
          iceTimeout = setTimeout(() => {
            if (peer.iceConnectionState === 'disconnected' || peer.iceConnectionState === 'failed') {
              if (onDisconnect) {
                onDisconnect()
              } else {
                console.log('[WebRTC] Connection degraded (timeout)');
                setStatus('degraded')
              }
            }
          }, 15000); // 15s tolerance before full offline fallback logic
        }
      } else if (peer.iceConnectionState === 'connected' || peer.iceConnectionState === 'completed') {
        if (iceTimeout) {
          clearTimeout(iceTimeout);
          iceTimeout = null;
        }
        if (isHostMode) {
          updateHostStatus()
        } else {
          if (clientDc && clientDc.readyState === 'open') {
            setStatus('connected') // Recovered from unstable
          }
        }
        
        try {
          const stats = await peer.getStats();
          let activePair: any = null;
          stats.forEach(report => {
            if (report.type === 'candidate-pair' && report.state === 'succeeded') {
              activePair = report;
            }
          });
          if (activePair) {
            const local = stats.get(activePair.localCandidateId);
            const remote = stats.get(activePair.remoteCandidateId);
            console.log(`[WebRTC] Active Pair: Local(${local?.candidateType || 'unknown'}) <-> Remote(${remote?.candidateType || 'unknown'})`);
          }
        } catch(e) {}
      }
    }

    peer.onicegatheringstatechange = () => {
      console.log(`[WebRTC] ICE Gathering state: ${peer.iceGatheringState}`);
    }

    return peer
  }

  // =====================================================
  // Host: create a room & wait for a client offer
  // =====================================================
  async function host(inviteCode: string): Promise<void> {
    isHostMode = true
    isExplicitlyClosed = false
    currentInviteCode = inviteCode
    hostSessionId = `host-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setStatus('connecting')

    try {
      localEcdhKeyPair = await generateEcdhKeyPair()
      localEcdhPubHex = await exportEcdhPublicKey(localEcdhKeyPair.publicKey)
    } catch (e) {
      console.warn('[WebRTC Host] Ephemeral ECDH generation fallback:', e)
    }

    signaling = new SignalingChannel(inviteCode)
    await signaling.initTopic()

    signaling.connect({
      onConnect: () => {
        updateHostStatus()
        signaling!.send({ type: 'host_hello', hostSessionId, ecdhPublicKey: localEcdhPubHex })
      },
      onError: () => {
        updateHostStatus()
      },
      onMessage: (data: any) => {
        const sender = data.sender
        if (!sender) return

        if (data.offer) {
          enqueueHostTask(sender, async () => {
            const existing = clients.get(sender)
            const isExistingActive = existing && existing.pc && !['disconnected', 'failed', 'closed'].includes(existing.pc.connectionState)

            // 1. Session replacement cleanup:
            // 严禁在未经 JWT 验证前仅凭 MQTT 信令上的 sender/sessionId 就销毁活跃健康的旧会话，防范同房间 DoS 攻击。
            // 若旧连接已断开，立即清理；若旧连接依然健康活跃，创建 staged 预备连接，待新通道完成 JWT 认证后再二阶段替换。
            let clientData: {
              pc: RTCPeerConnection
              sessionId?: string
              dc?: RTCDataChannel
              sender?: DataChannelSender
              pendingCandidates: RTCIceCandidateInit[]
            }

            if (!isExistingActive) {
              if (existing) {
                if (existing.dc) existing.dc.onclose = null
                existing.pc.onconnectionstatechange = null
                existing.pc.oniceconnectionstatechange = null
                existing.dc?.close()
                existing.pc.close()
                clients.delete(sender)
              }
              const pc = createPeerConnection(sender)
              clientData = { pc, sessionId: data.clientSessionId, pendingCandidates: [] }
              clients.set(sender, clientData)
            } else {
              console.log(`[WebRTC Host Security] Staging candidate connection for active peer ${sender} pending JWT auth.`)
              const existingStaged = stagedClients.get(sender)
              if (existingStaged) {
                if (existingStaged.dc) existingStaged.dc.onclose = null
                existingStaged.pc.onconnectionstatechange = null
                existingStaged.pc.oniceconnectionstatechange = null
                existingStaged.dc?.close()
                existingStaged.pc.close()
              }
              const pc = createPeerConnection(sender)
              clientData = { pc, sessionId: data.clientSessionId, pendingCandidates: [] }
              stagedClients.set(sender, clientData)
            }

            // 2. Derive shared AES key from client's public key
            if (data.ecdhPublicKey && localEcdhKeyPair) {
              try {
                const clientPub = await importEcdhPublicKey(data.ecdhPublicKey)
                const sharedKey = await deriveSharedAesKey(localEcdhKeyPair.privateKey, clientPub)
                clientSharedKeys.set(sender, sharedKey)
              } catch (err) {
                console.warn('[WebRTC Host] Failed to derive shared AES key:', err)
              }
            }

            // 3. Decrypt offer if encrypted
            let offerData = data.offer
            if (data.offer && data.offer.ciphertext && clientSharedKeys.has(sender)) {
              try {
                const decryptedStr = await decryptSignalingData(clientSharedKeys.get(sender)!, data.offer)
                offerData = JSON.parse(decryptedStr)
              } catch (err) {
                console.warn('[WebRTC Host] Failed to decrypt offer SDP:', err)
                return
              }
            }

            const pc = clientData.pc
            pc.ondatachannel = (ev) => {
              const dc = ev.channel
              const targetHolder = stagedClients.get(sender) || clients.get(sender)
              const senderObj = new DataChannelSender(dc)
              dc.onmessage = (e) => handleChannelMessage(e, sender)
              dc.onopen = () => updateHostStatus()
              dc.onclose = () => updateHostStatus()
              
              if (targetHolder) {
                targetHolder.dc = dc
                targetHolder.sender = senderObj
              }
            }

            const cached = preOfferCandidates.get(sender) || []
            clientData.pendingCandidates.push(...cached)
            preOfferCandidates.delete(sender)

            await pc.setRemoteDescription(new RTCSessionDescription(offerData))
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)

            // Encrypt answer
            let answerPayload: any = answer
            if (clientSharedKeys.has(sender)) {
              try {
                answerPayload = await encryptSignalingData(clientSharedKeys.get(sender)!, JSON.stringify(answer))
              } catch (err) {
                console.warn('[WebRTC Host] Failed to encrypt answer, sending plaintext fallback:', err)
              }
            }

            signaling!.send({ answer: answerPayload, hostSessionId, ecdhPublicKey: localEcdhPubHex }, sender)
            
            for (const c of clientData.pendingCandidates) {
              try {
                await pc.addIceCandidate(new RTCIceCandidate(c))
              } catch (err) {
                console.warn('[WebRTC Host] Error adding pending ICE candidate:', err)
              }
            }
            clientData.pendingCandidates = []
          })
        } else if (data.candidate) {
          enqueueHostTask(sender, async () => {
            let candidateData = data.candidate
            if (data.candidate && data.candidate.ciphertext && clientSharedKeys.has(sender)) {
              try {
                const decStr = await decryptSignalingData(clientSharedKeys.get(sender)!, data.candidate)
                candidateData = JSON.parse(decStr)
              } catch (err) {
                console.warn('[WebRTC Host] Error decrypting candidate:', err)
                return
              }
            }

            const targetHolder = stagedClients.get(sender) || clients.get(sender)
            if (!targetHolder) {
              const cached = preOfferCandidates.get(sender) || []
              cached.push(candidateData)
              preOfferCandidates.set(sender, cached)
              return
            }
            if (targetHolder && targetHolder.pc) {
              try {
                await targetHolder.pc.addIceCandidate(new RTCIceCandidate(candidateData))
              } catch {
                targetHolder.pendingCandidates.push(candidateData)
              }
            }
          })
        }
      }
    })
  }

  // =====================================================
  // Client Reconnection & Self-Healing Logic
  // =====================================================
  let reconnectAttempts = 0
  let reconnectTimer: NodeJS.Timeout | null = null

  function triggerClientReconnect() {
    if (isExplicitlyClosed || status === 'long_offline' || status === 'offline') return;

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    if (reconnectAttempts >= 6) {
      console.log('[WebRTC] Max reconnect attempts reached. Moving to long_offline.');
      setStatus('long_offline');
      return;
    }

    // First retry is 1s, then 2s, 4s, 8s, 16s, 32s
    const delay = reconnectAttempts === 0 ? 1000 : Math.min(32000, Math.pow(2, reconnectAttempts) * 1000);
    reconnectAttempts++;

    console.log(`[WebRTC] Attempting to reconnect in ${delay}ms (Attempt ${reconnectAttempts}/6)...`);
    setStatus('connecting');

    reconnectTimer = setTimeout(async () => {
      await setupClientConnection();
    }, delay);
  }

  async function setupClientConnection() {
    clientPendingCandidates = []
    if (clientPc) {
      clientPc.close()
    }
    if (clientDc) {
      clientDc.close()
    }
    
    clientPc = createPeerConnection(undefined, triggerClientReconnect)

    clientDc = clientPc.createDataChannel('scoutingpro-data')
    clientSender = new DataChannelSender(clientDc, (isCongested) => {
      if (isCongested) setStatus('unstable')
    })
    clientDc.onmessage = (e) => handleChannelMessage(e)
    clientDc.onopen = () => {
      setStatus('connected')
      reconnectAttempts = 0
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
    }
    clientDc.onclose = () => {
      clientSender = null
      if (status !== 'long_offline' && status !== 'offline') {
        triggerClientReconnect()
      }
    }

    try {
      const offer = await clientPc.createOffer()
      await clientPc.setLocalDescription(offer)

      let offerPayload: any = offer
      if (clientSharedAesKey) {
        try {
          offerPayload = await encryptSignalingData(clientSharedAesKey, JSON.stringify(offer))
        } catch (err) {
          console.warn('[WebRTC Client] Failed to encrypt offer, sending plaintext fallback:', err)
        }
      }

      signaling!.send({
        offer: offerPayload,
        ecdhPublicKey: localEcdhPubHex,
        clientSessionId: `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        hostSessionId: currentHostSessionId
      })
    } catch (err) {
      console.error('Error creating offer:', err)
      triggerClientReconnect()
    }
  }

  async function handleClientSignalingMessage(data: any) {
    if (data.type === 'host_hello') {
      console.log('[WebRTC] Received host_hello, reconnecting immediately.');
      if (data.hostSessionId) {
        currentHostSessionId = data.hostSessionId
      }
      if (data.ecdhPublicKey && localEcdhKeyPair) {
        try {
          const hostPub = await importEcdhPublicKey(data.ecdhPublicKey)
          clientSharedAesKey = await deriveSharedAesKey(localEcdhKeyPair.privateKey, hostPub)
        } catch (e) {
          console.warn('[WebRTC Client] Failed to derive shared AES key from host_hello:', e)
        }
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectAttempts = 0; // Host is fresh, start clean
      clientHostSenderId = data.sender
      await setupClientConnection()
    } else if (data.type === 'HOST_LEAVING') {
      console.log('[WebRTC] Host explicitly left the room.');
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (clientPc) clientPc.close()
      if (clientDc) clientDc.close()
      setStatus('offline')
    } else if (data.answer && clientPc) {
      try {
        clientHostSenderId = data.sender
        if (data.hostSessionId) {
          currentHostSessionId = data.hostSessionId
        }

        if (data.ecdhPublicKey && !clientSharedAesKey && localEcdhKeyPair) {
          try {
            const hostPub = await importEcdhPublicKey(data.ecdhPublicKey)
            clientSharedAesKey = await deriveSharedAesKey(localEcdhKeyPair.privateKey, hostPub)
          } catch {}
        }

        let answerData = data.answer
        if (data.answer && data.answer.ciphertext && clientSharedAesKey) {
          try {
            const decStr = await decryptSignalingData(clientSharedAesKey, data.answer)
            answerData = JSON.parse(decStr)
          } catch (err) {
            console.warn('[WebRTC Client] Error decrypting answer SDP:', err)
          }
        }

        await clientPc.setRemoteDescription(new RTCSessionDescription(answerData))
        for (const c of clientPendingCandidates) {
          try {
            await clientPc.addIceCandidate(new RTCIceCandidate(c))
          } catch (candidateErr) {
            console.warn('[WebRTC Client] Failed to add pending candidate:', candidateErr)
          }
        }
        clientPendingCandidates = []
      } catch (err) {
        console.error('Error setting remote description:', err)
      }
    } else if (data.candidate && clientPc) {
      // Only process candidate if it comes from the host
      if (clientHostSenderId && data.sender !== clientHostSenderId) {
        return
      }

      let candidateData = data.candidate
      if (data.candidate && data.candidate.ciphertext && clientSharedAesKey) {
        try {
          const decStr = await decryptSignalingData(clientSharedAesKey, data.candidate)
          candidateData = JSON.parse(decStr)
        } catch (err) {
          console.warn('[WebRTC Client] Error decrypting candidate:', err)
        }
      }

      try {
        await clientPc.addIceCandidate(new RTCIceCandidate(candidateData))
      } catch {
        clientPendingCandidates.push(candidateData)
      }
    }
  }

  async function reconnectNow(): Promise<boolean> {
    if (isHostMode) {
      if (currentInviteCode) {
        await host(currentInviteCode)
        return true
      }
      return false
    }

    if (status === 'connected') return true

    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }

    // Reset backoff attempts on manual intervention
    reconnectAttempts = 0
    setStatus('connecting')

    if (!signaling) {
      signaling = new SignalingChannel(currentInviteCode)
      await signaling.initTopic()
      signaling.connect({
        onConnect: async () => {
          if (clientPc && clientPc.connectionState === 'connected' && clientDc && clientDc.readyState === 'open') {
            return
          }
          await setupClientConnection()
        },
        onError: () => {
          if (status !== 'connected' && (!clientPc || clientPc.connectionState !== 'connected')) {
            setStatus('offline')
          }
        },
        onMessage: async (data: any) => {
          await handleClientSignalingMessage(data)
        }
      })
    } else {
      await setupClientConnection()
    }
    return true
  }

  // DOM Event Listeners for Self-Healing
  const handleOnline = async () => {
    console.log('[WebRTC Self-Healing] Device came online, probing public connectivity...')
    const canReachPublic = await probePublicConnectivity(2500)
    if (canReachPublic) {
      console.log('[WebRTC Self-Healing] Public connectivity confirmed, reconnecting immediately.')
      await reconnectNow()
    } else {
      console.warn('[WebRTC Self-Healing] Public connectivity probe failed; remaining in offline state.')
    }
  }

  const handleVisibilityChange = async () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      if (status === 'long_offline' || status === 'offline' || status === 'unstable') {
        console.log('[WebRTC Self-Healing] App became visible and connection is inactive; checking connectivity...')
        const canReach = await probePublicConnectivity(2000)
        if (canReach) {
          await reconnectNow()
        }
      }
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('online', handleOnline)
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }

  // =====================================================
  // Client: join a room via invite code
  // =====================================================
  async function join(inviteCode: string): Promise<void> {
    isHostMode = false
    isExplicitlyClosed = false
    currentInviteCode = inviteCode
    setStatus('connecting')

    try {
      localEcdhKeyPair = await generateEcdhKeyPair()
      localEcdhPubHex = await exportEcdhPublicKey(localEcdhKeyPair.publicKey)
    } catch (e) {
      console.warn('[WebRTC Client] Ephemeral ECDH generation fallback:', e)
    }

    signaling = new SignalingChannel(inviteCode)
    await signaling.initTopic()

    signaling.connect({
      onConnect: async () => {
        await setupClientConnection()
      },
      onError: () => setStatus('offline'),
      onMessage: async (data: any) => {
        await handleClientSignalingMessage(data)
      }
    })
  }

  // --- request a sync from the connected peer ---
  function requestSync(sinceVersion: number, authCode?: string, senderUserId?: string, senderUserName?: string, token?: string) {
    if (senderUserId) localUserId = senderUserId
    if (senderUserName) localUserName = senderUserName
    const authToken = token || getLocalAuthToken()

    sendMessage({
      type: 'REQUEST_SYNC',
      lastSyncTime: '',  // 保留字段兼容旧版本协议
      sinceVersion,
      authCode: authCode || currentInviteCode,
      senderUserId,
      senderUserName,
      token: authToken,
      hostSessionId: isHostMode ? hostSessionId : undefined
    })
  }

  // --- push records to the connected peer (chunked by 15 records) ---
  function pushRecords(records: ScoutingRecord[], targetId?: string): Promise<void> {
    const authToken = isHostMode ? undefined : getLocalAuthToken()
    if (!records || records.length === 0) {
      return sendMessage({
        type: 'SYNC_DATA',
        records: [],
        authCode: currentInviteCode,
        senderUserId: isHostMode ? undefined : localUserId,
        senderUserName: isHostMode ? undefined : localUserName,
        token: authToken,
        hostSessionId: isHostMode ? hostSessionId : undefined
      }, targetId)
    }
    const promises: Promise<void>[] = []
    for (let i = 0; i < records.length; i += RECORD_CHUNK_SIZE) {
      const chunk = records.slice(i, i + RECORD_CHUNK_SIZE)
      promises.push(sendMessage({
        type: 'SYNC_DATA',
        records: chunk,
        authCode: currentInviteCode,
        senderUserId: isHostMode ? undefined : localUserId,
        senderUserName: isHostMode ? undefined : localUserName,
        token: authToken,
        hostSessionId: isHostMode ? hostSessionId : undefined
      }, targetId))
    }
    return Promise.all(promises).then(() => {})
  }

  // --- acknowledge received records ---
  function ackRecords(recordIds: string[], targetId?: string) {
    sendMessage({ type: 'ACK_SYNC', recordIds, authCode: currentInviteCode, hostSessionId: isHostMode ? hostSessionId : undefined }, targetId)
  }

  // --- send a direct message ---
  async function sendDirectMessage(payload: {
    targetId: string
    title: string
    body: string
    messageId?: string
    senderId?: string
    senderName?: string
    targetName?: string
  }): Promise<boolean> {
    const directMsg: WebRtcDirectMessage = {
      type: 'DIRECT_MESSAGE',
      messageId: payload.messageId || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `msg-${Date.now()}`),
      targetId: payload.targetId,
      targetName: payload.targetName,
      senderId: payload.senderId || localUserId,
      senderName: payload.senderName || localUserName,
      title: payload.title,
      body: payload.body,
      authCode: currentInviteCode
    }

    if (isHostMode) {
      const clientId = scoutIdToClientId.get(payload.targetId)
      let sent = false
      if (clientId) {
        const targetClient = clients.get(clientId)
        if (targetClient && targetClient.dc && targetClient.dc.readyState === 'open') {
          if (!targetClient.sender) targetClient.sender = new DataChannelSender(targetClient.dc)
          await targetClient.sender.enqueueSend(JSON.stringify(directMsg))
          sent = true
        }
      }
      
      if (!sent) {
        // Queue it for offline delivery
        const queue = offlineMessages.get(payload.targetId) || []
        queue.push(directMsg)
        offlineMessages.set(payload.targetId, queue)
      }
      return sent
    } else {
      // Client sending
      if (clientDc && clientDc.readyState === 'open') {
        await sendMessage(directMsg)
        return true
      }
      return false
    }
  }

  // --- tear down ---
  function disconnect() {
    isExplicitlyClosed = true
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', handleOnline)
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }

    if (isHostMode) {
      if (signaling) {
        signaling.send({ type: 'HOST_LEAVING' })
      }
      clients.forEach(c => {
        if (c.dc) c.dc.onclose = null
        c.pc.onconnectionstatechange = null
        c.pc.oniceconnectionstatechange = null
        c.dc?.close()
        c.pc.close()
      })
      clients.clear()

      stagedClients.forEach(c => {
        if (c.dc) c.dc.onclose = null
        c.pc.onconnectionstatechange = null
        c.pc.oniceconnectionstatechange = null
        c.dc?.close()
        c.pc.close()
      })
      stagedClients.clear()
      hostQueues.clear()
      clientSharedKeys.clear()
      preOfferCandidates.clear()
      offlineMessages.clear()
      scoutIdToClientId.clear()
      clientIdToScoutId.clear()
    } else {
      clientSender = null
      if (clientDc) clientDc.onclose = null
      if (clientPc) {
        clientPc.onconnectionstatechange = null
        clientPc.oniceconnectionstatechange = null
      }
      clientDc?.close()
      clientPc?.close()
      clientDc = null
      clientPc = null
    }

    signaling?.close()
    signaling = null
    setStatus('offline')
  }

  // --- Host 序列号管理 ---
  /** 重启后从记录最大 hostSeq 恢复计数器，保证单调递增 */
  function initHostSeq(maxSeq: number) {
    hostSeqCounter = maxSeq
  }

  /** 对记录数组打上 hostSeq（递增），返回同一数组供链式调用 */
  function stampHostSeq(records: ScoutingRecord[]): ScoutingRecord[] {
    for (const r of records) {
      r.hostSeq = ++hostSeqCounter
    }
    return records
  }

  return {
    host,
    join,
    requestSync,
    pushRecords,
    ackRecords,
    sendDirectMessage,
    reconnectNow,
    disconnect,
    initHostSeq,
    stampHostSeq,
    getStatus: () => status,
    getDataChannel: () => isHostMode ? (clients.values().next().value?.dc || null) : clientDc,
  }
}
