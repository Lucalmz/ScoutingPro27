// ============================================================
// WebRTC P2P service — data-channel based sync
// ============================================================

import mqtt from 'mqtt'
import type { WebRtcMessage, ScoutingRecord, ConnectionStatus, WebRtcDirectMessage } from '@/types'
import { useInboxStore } from '@/stores/inbox'

// ---------- Configuration ----------

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
 * Uses HiveMQ's free public broker — works over the internet.
 */
class SignalingChannel {
  private client: mqtt.MqttClient | null = null
  private topic: string = ''
  private clientId: string
  private messageCallback: ((data: unknown) => void) | null = null

  constructor(private room: string) {
    this.clientId = `sp27-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  async initTopic() {
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
        
        // 校验载荷结构：必须包含 offer/answer/candidate 或 特定指令
        if (!msg.offer && !msg.answer && !msg.candidate && msg.type !== 'host_hello' && msg.type !== 'HOST_LEAVING') return
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
  onClientConnected?: (userId: string, userName: string) => void
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
  let clientHostSenderId: string | undefined = undefined

  // Host mode state
  const clients = new Map<string, { pc: RTCPeerConnection, dc?: RTCDataChannel, pendingCandidates: RTCIceCandidateInit[] }>()
  const preOfferCandidates = new Map<string, RTCIceCandidateInit[]>()
  const hostQueues = new Map<string, Promise<void>>()
  const scoutIdToClientId = new Map<string, string>()
  const offlineMessages = new Map<string, WebRtcDirectMessage[]>()

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

  // --- send a JSON message over the data channel ---
  function sendMessage(msg: WebRtcMessage, targetId?: string) {
    console.log(`[WebRTC] Sending message ${msg.type} to ${targetId || 'all'}`);
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
      console.log(`[WebRTC] Received message ${msg.type} from ${senderId || 'unknown'}`);
    } catch {
      return
    }

    if (isHostMode && msg.authCode !== currentInviteCode) {
      return
    }

    switch (msg.type) {
      case 'REQUEST_SYNC':
        if (msg.senderUserId && senderId) {
          scoutIdToClientId.set(msg.senderUserId, senderId)
          if (msg.senderUserName) {
            callbacks.onClientConnected?.(msg.senderUserId, msg.senderUserName)
          }
          const pending = offlineMessages.get(msg.senderUserId)
          if (pending && pending.length > 0) {
            pending.forEach(m => sendMessage(m, senderId))
            offlineMessages.delete(msg.senderUserId)
          }
        }
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
      case 'DIRECT_MESSAGE':
        // As a host, direct messages are sent BY the host via sendDirectMessage,
        // but if a client sends one to the host, it will just show up in the host's inbox.
        // We do not relay DMs between clients currently.
        const inboxStore = useInboxStore()
        inboxStore.addMessage({
          title: msg.title,
          body: msg.body,
          type: 'direct'
        })
        break
    }
  }

  // --- build peer connection + data channel ---
  function createPeerConnection(targetSender?: string, onDisconnect?: () => void): RTCPeerConnection {
    const peer = new RTCPeerConnection(STUN_SERVERS)

    peer.onicecandidate = (ev) => {
      if (ev.candidate) {
        console.log(`[WebRTC] ICE Candidate: type=${ev.candidate.type}, protocol=${ev.candidate.protocol}, address=${ev.candidate.address}`);
        if (signaling) {
          const target = isHostMode ? targetSender : clientHostSenderId;
          signaling.send({ candidate: ev.candidate }, target)
        }
      } else {
        console.log(`[WebRTC] ICE Gathering Complete (null candidate)`);
      }
    }

    peer.onconnectionstatechange = () => {
      console.log(`[WebRTC] Connection state changed: ${peer.connectionState}`);
      if (isHostMode) {
        if (['disconnected', 'failed', 'closed'].includes(peer.connectionState) && targetSender) {
          peer.close()
          clients.delete(targetSender)
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

    let iceTimeout: NodeJS.Timeout | null = null

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
    currentInviteCode = inviteCode
    setStatus('connecting')
    signaling = new SignalingChannel(inviteCode)
    await signaling.initTopic()

    signaling.connect({
      onConnect: () => {
        updateHostStatus()
        signaling!.send({ type: 'host_hello' })
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
    
    let reconnectAttempts = 0
    let reconnectTimer: NodeJS.Timeout | null = null

    signaling = new SignalingChannel(inviteCode)
    await signaling.initTopic()
    
    function triggerClientReconnect() {
      if (status === 'long_offline') return;

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
      const delay = reconnectAttempts === 0 ? 1000 : Math.pow(2, reconnectAttempts) * 1000;
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
        if (status !== 'long_offline' && status !== 'offline') {
          triggerClientReconnect()
        }
      }

      try {
        const offer = await clientPc.createOffer()
        await clientPc.setLocalDescription(offer)
        signaling!.send({ offer })
      } catch (err) {
        console.error('Error creating offer:', err)
        triggerClientReconnect()
      }
    }

    signaling.connect({
      onConnect: async () => {
        await setupClientConnection()
      },
      onError: () => {
        if (status !== 'connected' && (!clientPc || clientPc.connectionState !== 'connected')) {
          setStatus('offline')
        }
      },
      onMessage: async (data: any) => {
        if (data.type === 'host_hello') {
          console.log('[WebRTC] Received host_hello, reconnecting immediately.');
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
            await clientPc.setRemoteDescription(new RTCSessionDescription(data.answer))
            for (const c of clientPendingCandidates) {
              await clientPc.addIceCandidate(new RTCIceCandidate(c))
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
  function requestSync(lastSyncTime: string, authCode?: string, senderUserId?: string, senderUserName?: string) {
    sendMessage({ type: 'REQUEST_SYNC', lastSyncTime, authCode: authCode || currentInviteCode, senderUserId, senderUserName })
  }

  // --- push records to the connected peer ---
  function pushRecords(records: ScoutingRecord[], targetId?: string) {
    sendMessage({ type: 'SYNC_DATA', records, authCode: currentInviteCode }, targetId)
  }

  // --- acknowledge received records ---
  function ackRecords(recordIds: string[], targetId?: string) {
    sendMessage({ type: 'ACK_SYNC', recordIds, authCode: currentInviteCode }, targetId)
  }

  // --- send a direct message ---
  function sendDirectMessage(payload: { targetId: string, title: string, body: string }) {
    const directMsg: WebRtcDirectMessage = {
      type: 'DIRECT_MESSAGE',
      targetId: payload.targetId,
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
          targetClient.dc.send(JSON.stringify(directMsg))
          sent = true
        }
      }
      
      if (!sent) {
        // Queue it for offline delivery
        const queue = offlineMessages.get(payload.targetId) || []
        queue.push(directMsg)
        offlineMessages.set(payload.targetId, queue)
      }
    } else {
      // Client sending
      sendMessage(directMsg)
    }
  }

  // --- tear down ---
  function disconnect() {
    if (isHostMode) {
      if (signaling) {
        signaling.send({ type: 'HOST_LEAVING' })
      }
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
    sendDirectMessage,
    disconnect,
    getStatus: () => status,
    getDataChannel: () => isHostMode ? (clients.values().next().value?.dc || null) : clientDc,
  }
}

export type WebRtcService = ReturnType<typeof createWebRtcService>
