// ============================================================
// WebRTC P2P service — data-channel based sync
// ============================================================

import mqtt from 'mqtt'
import type { WebRtcMessage, ScoutingRecord, ConnectionStatus } from '@/types'

// ---------- Configuration ----------

const STUN_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
}

/**
 * MQTT-based signaling channel for WebRTC SDP/ICE exchange.
 * Uses HiveMQ's free public broker — works over the internet.
 */
class SignalingChannel {
  private client: mqtt.MqttClient | null = null
  private topic: string
  private clientId: string
  private messageCallback: ((data: unknown) => void) | null = null

  constructor(private room: string) {
    this.topic = `scoutingpro27/signal/${room}`
    this.clientId = `sp27-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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
      connectTimeout: 5000,
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

    this.client.on('message', (_topic: string, payload: Uint8Array) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload))
        // 忽略自己发的消息
        if (msg.sender === this.clientId) return
        // 如果指定了 target 且不是自己，忽略
        if (msg.target && msg.target !== this.clientId) return
        
        // 校验载荷结构：必须包含 offer/answer/candidate 之一
        if (!msg.offer && !msg.answer && !msg.candidate) return
        this.messageCallback?.(msg)
      } catch {
        // ignore malformed
      }
    })
  }

  send(data: unknown, target?: string): void {
    if (this.client && this.client.connected) {
      const envelope: Record<string, unknown> = { ...(data as Record<string, unknown>), sender: this.clientId }
      if (target) {
        envelope.target = target
      }
      this.client.publish(this.topic, JSON.stringify(envelope))
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
  onRecordsReceived: (records: ScoutingRecord[], senderId?: string) => void
  onAckReceived: (recordIds: string[]) => void
  onRequestSync: (lastSyncTime: string, senderId?: string) => void
}

export function createWebRtcService(callbacks: WebRtcCallbacks) {
  let isHostMode = false
  let signaling: SignalingChannel | null = null
  let status: ConnectionStatus = 'offline'
  let currentInviteCode = ''

  // Client mode state
  let clientPc: RTCPeerConnection | null = null
  let clientDc: RTCDataChannel | null = null
  let clientPendingCandidates: RTCIceCandidateInit[] = []

  // Host mode state
  const clients = new Map<string, { pc: RTCPeerConnection, dc?: RTCDataChannel, pendingCandidates: RTCIceCandidateInit[] }>()
  const preOfferCandidates = new Map<string, RTCIceCandidateInit[]>()
  const hostQueues = new Map<string, Promise<void>>()

  function enqueueHostTask(sender: string, task: () => Promise<void>) {
    const q = hostQueues.get(sender) || Promise.resolve()
    const nextQ = q.then(task).catch(console.error)
    hostQueues.set(sender, nextQ)
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
      if (c.pc.connectionState === 'connected') active++
    })
    if (active > 0) {
      setStatus('connected')
    } else if (signaling) {
      setStatus('waiting')
    } else {
      setStatus('offline')
    }
  }

  // --- send a JSON message over the data channel ---
  function sendMessage(msg: WebRtcMessage, targetId?: string) {
    const payload = JSON.stringify(msg)
    if (isHostMode) {
      if (targetId) {
        const c = clients.get(targetId)
        if (c && c.dc && c.dc.readyState === 'open') {
          c.dc.send(payload)
        }
      } else {
        clients.forEach(c => {
          if (c.dc && c.dc.readyState === 'open') {
            c.dc.send(payload)
          }
        })
      }
    } else {
      if (clientDc && clientDc.readyState === 'open') {
        clientDc.send(payload)
      }
    }
  }

  // --- handle incoming data-channel messages ---
  function handleChannelMessage(ev: MessageEvent, senderId?: string) {
    let msg: WebRtcMessage
    try {
      msg = JSON.parse(ev.data) as WebRtcMessage
    } catch {
      return
    }

    if (isHostMode && msg.authCode !== currentInviteCode) {
      return
    }

    switch (msg.type) {
      case 'REQUEST_SYNC':
        callbacks.onRequestSync(msg.lastSyncTime || '', senderId)
        break
      case 'SYNC_DATA':
        callbacks.onRecordsReceived(msg.records, senderId)
        // Auto-ack
        sendMessage({
          type: 'ACK_SYNC',
          recordIds: msg.records.map((r) => r.id),
          authCode: currentInviteCode
        }, senderId)
        if (isHostMode) {
          clients.forEach((c, id) => {
            if (id !== senderId && c.dc && c.dc.readyState === 'open') {
              c.dc.send(JSON.stringify({ ...msg, authCode: currentInviteCode }))
            }
          })
        }
        break
      case 'ACK_SYNC':
        callbacks.onAckReceived(msg.recordIds)
        break
    }
  }

  // --- build peer connection + data channel ---
  function createPeerConnection(targetSender?: string): RTCPeerConnection {
    const peer = new RTCPeerConnection(STUN_SERVERS)

    peer.onicecandidate = (ev) => {
      if (ev.candidate && signaling) {
        signaling.send({ candidate: ev.candidate }, targetSender)
      }
    }

    peer.onconnectionstatechange = () => {
      if (isHostMode) {
        if (['disconnected', 'failed', 'closed'].includes(peer.connectionState) && targetSender) {
          peer.close()
          clients.delete(targetSender)
        }
        updateHostStatus()
      } else {
        switch (peer.connectionState) {
          case 'connected':
            setStatus('connected')
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

    return peer
  }

  // =====================================================
  // Host: create a room & wait for a client offer
  // =====================================================
  async function host(inviteCode: string): Promise<void> {
    isHostMode = true
    currentInviteCode = inviteCode
    setStatus('connecting')
    signaling = new SignalingChannel(inviteCode)

    signaling.connect({
      onConnect: () => {
        updateHostStatus()
      },
      onError: () => {
        updateHostStatus()
      },
      onMessage: (data: any) => {
        const sender = data.sender
        if (!sender) return

        if (data.offer) {
          enqueueHostTask(sender, async () => {
            let clientData = clients.get(sender)
            if (!clientData) {
              const pc = createPeerConnection(sender)
              
              pc.ondatachannel = (ev) => {
                const dc = ev.channel
                dc.onmessage = (e) => handleChannelMessage(e, sender)
                dc.onopen = () => updateHostStatus()
                dc.onclose = () => updateHostStatus()
                
                const client = clients.get(sender)
                if (client) {
                  client.dc = dc
                }
              }

              clientData = { pc, pendingCandidates: [] }
              const cached = preOfferCandidates.get(sender) || []
              clientData.pendingCandidates.push(...cached)
              preOfferCandidates.delete(sender)
              clients.set(sender, clientData)
            }

            const pc = clientData.pc
            setStatus('connecting')
            await pc.setRemoteDescription(new RTCSessionDescription(data.offer))
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            signaling!.send({ answer }, sender)
            
            for (const c of clientData.pendingCandidates) {
              await pc.addIceCandidate(new RTCIceCandidate(c))
            }
            clientData.pendingCandidates = []
          })
        } else if (data.candidate) {
          enqueueHostTask(sender, async () => {
            const clientData = clients.get(sender)
            if (!clientData) {
              const cached = preOfferCandidates.get(sender) || []
              cached.push(data.candidate)
              preOfferCandidates.set(sender, cached)
              return
            }
            if (clientData && clientData.pc) {
              try {
                await clientData.pc.addIceCandidate(new RTCIceCandidate(data.candidate))
              } catch {
                clientData.pendingCandidates.push(data.candidate)
              }
            }
          })
        }
      }
    })
  }

  // =====================================================
  // Client: join a room & send an offer to the host
  // =====================================================
  async function join(inviteCode: string): Promise<void> {
    isHostMode = false
    currentInviteCode = inviteCode
    setStatus('connecting')
    signaling = new SignalingChannel(inviteCode)
    
    clientPendingCandidates = []
    clientPc = createPeerConnection()

    clientDc = clientPc.createDataChannel('scoutingpro-data')
    clientDc.onmessage = (e) => handleChannelMessage(e)
    clientDc.onopen = () => setStatus('connected')
    clientDc.onclose = () => setStatus('offline')

    signaling.connect({
      onConnect: async () => {
        if (!clientPc) return
        const offer = await clientPc.createOffer()
        await clientPc.setLocalDescription(offer)
        signaling!.send({ offer })
      },
      onError: () => {
        if (status !== 'connected' && (!clientPc || clientPc.connectionState !== 'connected')) {
          setStatus('offline')
        }
      },
      onMessage: async (data: any) => {
        if (data.answer && clientPc) {
          await clientPc.setRemoteDescription(new RTCSessionDescription(data.answer))
          for (const c of clientPendingCandidates) {
            await clientPc.addIceCandidate(new RTCIceCandidate(c))
          }
          clientPendingCandidates = []
        } else if (data.candidate && clientPc) {
          try {
            await clientPc.addIceCandidate(new RTCIceCandidate(data.candidate))
          } catch {
            clientPendingCandidates.push(data.candidate)
          }
        }
      }
    })
  }

  // --- request a sync from the connected peer ---
  function requestSync(lastSyncTime: string, authCode?: string) {
    sendMessage({ type: 'REQUEST_SYNC', lastSyncTime, authCode: authCode || currentInviteCode })
  }

  // --- push records to the connected peer ---
  function pushRecords(records: ScoutingRecord[], targetId?: string) {
    sendMessage({ type: 'SYNC_DATA', records, authCode: currentInviteCode }, targetId)
  }

  // --- acknowledge received records ---
  function ackRecords(recordIds: string[], targetId?: string) {
    sendMessage({ type: 'ACK_SYNC', recordIds, authCode: currentInviteCode }, targetId)
  }

  // --- tear down ---
  function disconnect() {
    if (isHostMode) {
      clients.forEach(c => {
        c.dc?.close()
        c.pc.close()
      })
      clients.clear()
      hostQueues.clear()
    } else {
      clientDc?.close()
      clientPc?.close()
      clientDc = null
      clientPc = null
    }

    signaling?.close()
    signaling = null
    setStatus('offline')
  }

  return {
    host,
    join,
    requestSync,
    pushRecords,
    ackRecords,
    disconnect,
    getStatus: () => status,
    getDataChannel: () => isHostMode ? (clients.values().next().value?.dc || null) : clientDc,
  }
}

export type WebRtcService = ReturnType<typeof createWebRtcService>
