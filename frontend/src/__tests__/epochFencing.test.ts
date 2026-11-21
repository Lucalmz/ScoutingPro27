import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import {
  getEpochStorageKey,
  getEpochWitnessRecord,
  getHighestSeenEpoch,
  saveEpochWitnessRecord,
  isPlaceholderEventId
} from '@/services/webrtc/epochStore'
import { SignalingChannel, type EpochBeaconPayload } from '@/services/webrtc/signaling'
import { createWebRtcService } from '@/services/webrtc'
import { resetClockRegistryForTesting } from '@/services/clock'
import { deriveHmacKey, signSignalingPayload } from '@/utils/crypto'

interface PublishedFrame {
  topic: string
  payload: string
  parsed: any
  options?: any
}

interface MockMqttInstance {
  handlers: Record<string, ((...args: any[]) => any)[]>
  published: PublishedFrame[]
  subscribed: string[]
  connected: boolean
  on: (ev: string, fn: (...args: any[]) => any) => MockMqttInstance
  subscribe: (topic: string, cb?: (err: any) => void) => void
  unsubscribe: () => void
  publish: (topic: string, msg: string | Uint8Array, opts?: any) => void
  removeAllListeners: () => void
  end: () => void
  emitMessage: (topic: string, data: any) => Promise<void>
}

const createdMqttClients: MockMqttInstance[] = []

function createMockMqttClient(): MockMqttInstance {
  const instance: MockMqttInstance = {
    handlers: {},
    published: [],
    subscribed: [],
    connected: true,
    on(ev, fn) {
      if (!this.handlers[ev]) this.handlers[ev] = []
      this.handlers[ev].push(fn)
      if (ev === 'connect') {
        fn()
      }
      return this
    },
    subscribe(topic, cb) {
      this.subscribed.push(topic)
      cb?.(null)
    },
    unsubscribe() {},
    publish(topic, msg, opts) {
      const payload = typeof msg === 'string' ? msg : new TextDecoder().decode(msg)
      let parsed: any = null
      try {
        parsed = JSON.parse(payload)
      } catch {}
      this.published.push({ topic, payload, parsed, options: opts })
    },
    removeAllListeners() {
      this.handlers = {}
    },
    end() {
      this.connected = false
    },
    async emitMessage(topic, data) {
      const listeners = this.handlers['message'] || []
      const bytes = new TextEncoder().encode(typeof data === 'string' ? data : JSON.stringify(data))
      for (const listener of listeners) {
        await listener(topic, bytes)
      }
    }
  }
  createdMqttClients.push(instance)
  return instance
}

vi.mock('mqtt', () => ({
  default: {
    connect: vi.fn().mockImplementation(() => createMockMqttClient())
  }
}))

vi.mock('@/services/api', async () => {
  const actual = await vi.importActual<any>('@/services/api')
  return {
    ...actual,
    createWebRtcTicket: vi.fn().mockResolvedValue({ ticket: 'test-ticket', expiresIn: 180 }),
    verifyToken: vi.fn().mockResolvedValue({ valid: true, userId: 'host_u1', username: 'HostUser' }),
    verifyWebRtcTicket: vi.fn().mockResolvedValue({ valid: true, userId: 'scout_u1', username: 'ScoutUser' })
  }
})

describe('Per-Event Epoch Store, Retained Epoch Beacon & Fencing Control Plane', () => {
  beforeEach(() => {
    localStorage.clear()
    resetClockRegistryForTesting()
    createdMqttClients.length = 0
    setActivePinia(createPinia())
    ;(globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ = true
    ;(globalThis as any).__TEST_PROBE_MS__ = 35
    vi.clearAllMocks()

    global.RTCPeerConnection = vi.fn().mockImplementation(() => ({
      createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'fake-sdp' }),
      createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'fake-sdp' }),
      setLocalDescription: vi.fn().mockResolvedValue(undefined),
      setRemoteDescription: vi.fn().mockResolvedValue(undefined),
      addIceCandidate: vi.fn().mockResolvedValue(undefined),
      createDataChannel: vi.fn().mockReturnValue({
        send: vi.fn(),
        close: vi.fn(),
        readyState: 'open',
        onopen: null,
        onclose: null,
        onmessage: null
      }),
      close: vi.fn(),
      connectionState: 'connected',
      iceConnectionState: 'connected',
      onicecandidate: null,
      ondatachannel: null,
      onconnectionstatechange: null,
      oniceconnectionstatechange: null
    })) as any
  })

  afterEach(() => {
    delete (globalThis as any).__TEST_PROBE_MS__
    delete (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__
    resetClockRegistryForTesting()
  })

  it('isolates epoch persistence per invite code, keeps epoch monotonic, and prevents placeholder overwrites', () => {
    saveEpochWitnessRecord({
      inviteCode: 'evta01',
      authoritativeEventId: 'uuid-event-a',
      eventName: 'Event Alpha',
      hostUserId: 'alice-id',
      highestSeenEpoch: 3,
      activeHostSessionId: 'host-a-3',
      activeHostDeviceId: 'dev_a3'
    })

    saveEpochWitnessRecord({
      inviteCode: 'EVTB02',
      authoritativeEventId: 'uuid-event-b',
      eventName: 'Event Beta',
      hostUserId: 'bob-id',
      highestSeenEpoch: 1
    })

    // Attempt regression & placeholder overwrite on EVTA01
    expect(isPlaceholderEventId('evt-EVTA01')).toBe(true)
    expect(isPlaceholderEventId('ext_EVTA01')).toBe(true)
    expect(isPlaceholderEventId('uuid-event-a')).toBe(false)

    saveEpochWitnessRecord({
      inviteCode: 'EVTA01',
      authoritativeEventId: 'ext_EVTA01',
      hostUserId: 'external_host',
      highestSeenEpoch: 1,
      activeHostSessionId: 'stale-sess-1',
      activeHostDeviceId: 'dev_stale'
    })

    const recA = getEpochWitnessRecord('EVTA01')
    const recB = getEpochWitnessRecord('EVTB02')
    expect(localStorage.getItem(getEpochStorageKey('EVTA01'))).toBeTruthy()
    expect(localStorage.getItem(getEpochStorageKey('EVTB02'))).toBeTruthy()
    expect(recA?.highestSeenEpoch).toBe(3)
    expect(recA?.authoritativeEventId).toBe('uuid-event-a')
    expect(recA?.hostUserId).toBe('alice-id')
    expect(recA?.activeHostSessionId).toBe('host-a-3')
    expect(recB?.highestSeenEpoch).toBe(1)
    expect(getHighestSeenEpoch('EVTA01')).toBe(3)
    expect(getHighestSeenEpoch('EVTB02')).toBe(1)
  })

  it('accepts 2-hour-old valid HMAC retained epoch_beacon, drops tampered beacons, and blocks CRDT payloads on MQTT signaling', async () => {
    delete (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__

    const channel = new SignalingChannel('FENCE01')
    await channel.initTopic()
    const hmacKey = await deriveHmacKey('FENCE01')
    expect(hmacKey).toBeTruthy()

    const receivedBeacons: EpochBeaconPayload[] = []
    const receivedMessages: any[] = []

    channel.connect({
      onEpochBeacon: (b) => {
        receivedBeacons.push(b)
      },
      onMessage: (m) => {
        receivedMessages.push(m)
      }
    })

    const mqttInst = createdMqttClients[createdMqttClients.length - 1]!
    const beaconTopic = channel.getBeaconTopic()
    expect(mqttInst.subscribed).toContain(beaconTopic)

    // 1. Retained epoch_beacon published 2 hours ago (> 15-min NonceLruCache TTL) with valid HMAC
    const twoHoursAgoBeacon: EpochBeaconPayload = {
      type: 'epoch_beacon',
      inviteCode: 'FENCE01',
      hostEpoch: 4,
      hostSessionId: 'host-4-sess',
      hostDeviceId: 'dev_host4',
      hostUserId: 'alice-id',
      authoritativeEventId: 'uuid-fence-01',
      eventName: 'Regional',
      publishedAt: Date.now() - 2 * 3600 * 1000,
      sender: 'remote_host_mqtt_id'
    }
    twoHoursAgoBeacon.signature = await signSignalingPayload(
      hmacKey!,
      twoHoursAgoBeacon as unknown as Record<string, any>
    )

    await mqttInst.emitMessage(beaconTopic, twoHoursAgoBeacon)
    expect(receivedBeacons).toHaveLength(1)
    expect(receivedBeacons[0]!.hostEpoch).toBe(4)
    expect(channel.getLastReceivedBeacon()?.authoritativeEventId).toBe('uuid-fence-01')

    // 2. Tampered epoch_beacon (altered hostEpoch with invalid signature) MUST be dropped
    await mqttInst.emitMessage(beaconTopic, {
      ...twoHoursAgoBeacon,
      hostEpoch: 99
    })
    expect(receivedBeacons).toHaveLength(1)

    // 3. Business payloads CRDT_SYNC_MSG / CRDT_SYNC_CHUNK MUST be dropped on main MQTT topic
    const mainTopic = beaconTopic.replace(/\/epoch-beacon$/, '')
    const crdtMsg: any = {
      type: 'CRDT_SYNC_MSG',
      sender: 'peer_x',
      timestamp: Date.now(),
      nonce: 'n-crdt-1',
      fromClientId: 'dev_x',
      message: 1,
      body: {}
    }
    crdtMsg.signature = await signSignalingPayload(hmacKey!, crdtMsg)
    await mqttInst.emitMessage(mainTopic, crdtMsg)

    const crdtChunk: any = {
      type: 'CRDT_SYNC_CHUNK',
      sender: 'peer_x',
      timestamp: Date.now(),
      nonce: 'n-crdt-2',
      chunkId: 'chk-1'
    }
    crdtChunk.signature = await signSignalingPayload(hmacKey!, crdtChunk)
    await mqttInst.emitMessage(mainTopic, crdtChunk)

    expect(receivedMessages).toHaveLength(0)

    channel.close()
  })

  it('demotes stale Epoch=1 Host when fenced by Epoch=2 epoch_superseded or retained epoch_beacon', async () => {
    const onHostDemoted = vi.fn()
    const onHostPromoted = vi.fn()

    const serviceA = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onHostPromoted,
      onHostDemoted
    })

    await serviceA.host('ROOM-A', { id: 'uuid-a', name: 'Event A', inviteCode: 'ROOM-A', hostId: 'alice' }, 'Alice', 'alice')
    await new Promise((r) => setTimeout(r, 80))

    expect(onHostPromoted).toHaveBeenCalled()
    expect(serviceA.getHostEpoch()).toBe(1)
    expect(serviceA.isStandbyHost()).toBe(false)
    expect(serviceA.isHostMode()).toBe(true)

    const mqttA = createdMqttClients[createdMqttClients.length - 1]!

    // Receive EPOCH_SUPERSEDED with Epoch=2 from Host B
    await mqttA.emitMessage('scoutingpro27/signal/main', {
      type: 'epoch_superseded',
      sender: 'peer_host_b',
      currentEpoch: 2,
      activeHostSessionId: 'host-b-epoch2',
      activeHostDeviceId: 'dev_host_b'
    })

    expect(serviceA.isStandbyHost()).toBe(true)
    expect(serviceA.isHostMode()).toBe(false)
    expect(serviceA.getHostEpoch()).toBe(2)
    expect(getHighestSeenEpoch('ROOM-A')).toBe(2)
    expect(onHostDemoted).toHaveBeenCalledWith({
      hostSessionId: 'host-b-epoch2',
      hostDeviceId: 'dev_host_b'
    })

    serviceA.disconnect()

    // Also verify active Host yields upon receiving retained epoch_beacon with Epoch=3
    const onHostDemoted2 = vi.fn()
    const serviceA2 = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onHostDemoted: onHostDemoted2
    })
    await serviceA2.host('ROOM-BEACON', undefined, 'Alice', 'alice')
    await new Promise((r) => setTimeout(r, 80))
    expect(serviceA2.getHostEpoch()).toBe(1)

    const mqttA2 = createdMqttClients[createdMqttClients.length - 1]!
    const beaconSub = mqttA2.subscribed.find((t) => t.endsWith('/epoch-beacon'))!
    await mqttA2.emitMessage(beaconSub, {
      type: 'epoch_beacon',
      inviteCode: 'ROOM-BEACON',
      hostEpoch: 3,
      hostSessionId: 'host-remote-3',
      hostDeviceId: 'dev_remote_3',
      hostUserId: 'alice',
      authoritativeEventId: 'uuid-beacon',
      eventName: 'Beacon Event',
      publishedAt: Date.now(),
      sender: 'remote_beacon_sender'
    })

    expect(serviceA2.isStandbyHost()).toBe(true)
    expect(serviceA2.getHostEpoch()).toBe(3)
    expect(onHostDemoted2).toHaveBeenCalledWith({
      hostSessionId: 'host-remote-3',
      hostDeviceId: 'dev_remote_3'
    })

    serviceA2.disconnect()
  })

  it('resolves same-epoch split-brain (Epoch=2 vs Epoch=2) by bumping winner to Epoch=3 and publishing retained beacon', async () => {
    // Prior device recorded Epoch=1 so this device promotes directly to Epoch=2
    saveEpochWitnessRecord({
      inviteCode: 'ROOM-TIE',
      authoritativeEventId: 'uuid-tie',
      eventName: 'Tie Event',
      hostUserId: 'alice',
      highestSeenEpoch: 1,
      activeHostSessionId: 'host-prev-1',
      activeHostDeviceId: 'dev_previous_machine'
    })

    const serviceWinner = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    })
    await serviceWinner.host('ROOM-TIE', { id: 'uuid-tie', name: 'Tie Event', inviteCode: 'ROOM-TIE', hostId: 'alice' }, 'Alice', 'alice')
    await new Promise((r) => setTimeout(r, 80))

    expect(serviceWinner.isStandbyHost()).toBe(false)
    expect(serviceWinner.getHostEpoch()).toBe(2)

    const mqttWin = createdMqttClients[createdMqttClients.length - 1]!
    mqttWin.published.length = 0

    // Colliding host with same Epoch=2 and lexicographically larger session ID ('zzz-...' > 'host-...') loses tie-break
    await mqttWin.emitMessage('scoutingpro27/signal/main', {
      type: 'host_heartbeat',
      sender: 'peer_loser_2',
      hostSessionId: 'zzz-host-losing-session',
      deviceId: 'dev_loser_2',
      hostEpoch: 2,
      timestamp: Date.now()
    })

    expect(serviceWinner.isStandbyHost()).toBe(false)
    expect(serviceWinner.getHostEpoch()).toBe(3)
    expect(getHighestSeenEpoch('ROOM-TIE')).toBe(3)

    const supersededSent = mqttWin.published.find((f) => f.parsed?.type === 'epoch_superseded')
    expect(supersededSent?.parsed?.currentEpoch).toBe(3)

    const beaconSent = mqttWin.published.find(
      (f) => f.topic.endsWith('/epoch-beacon') && f.parsed?.type === 'epoch_beacon' && f.parsed?.hostEpoch === 3
    )
    expect(beaconSent).toBeDefined()
    expect(beaconSent?.options).toMatchObject({ retain: true, qos: 1 })

    serviceWinner.disconnect()
  })

  it('discovers epoch_witness replies on host_discovery, promotes to maxSeen+1, aligns Host clock, and publishes retained beacon', async () => {
    const onWitnessMetadataDiscovered = vi.fn()
    const service = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onWitnessMetadataDiscovered
    })

    await service.host('ROOM-DISC', undefined, 'Alice', 'alice')
    await new Promise((r) => setTimeout(r, 10))

    const mqttCli = createdMqttClients[createdMqttClients.length - 1]!
    const sentDiscovery = mqttCli.published.some((f) => f.parsed?.type === 'host_discovery')
    expect(sentDiscovery).toBe(true)

    const witnessTime1 = Date.now() + 180_000 // +3 min offline advance
    const witnessTime2 = Date.now() + 184_000

    await mqttCli.emitMessage('scoutingpro27/signal/main', {
      type: 'epoch_witness',
      sender: 'peer_phone_1',
      inviteCode: 'ROOM-DISC',
      highestEpoch: 2,
      authoritativeEventId: 'uuid-disc-real',
      eventName: 'Discovered Regional',
      hostUserId: 'alice',
      activeHostSessionId: 'old-dead-host-2',
      activeHostDeviceId: 'dev_dead_laptop',
      maxKnownHlcPt: witnessTime1
    })
    await mqttCli.emitMessage('scoutingpro27/signal/main', {
      type: 'epoch_witness',
      sender: 'peer_phone_2',
      inviteCode: 'ROOM-DISC',
      highestEpoch: 2,
      authoritativeEventId: 'uuid-disc-real',
      eventName: 'Discovered Regional',
      hostUserId: 'alice',
      activeHostSessionId: 'old-dead-host-2',
      activeHostDeviceId: 'dev_dead_laptop',
      maxKnownHlcPt: witnessTime2
    })

    await new Promise((r) => setTimeout(r, 60))

    expect(service.isStandbyHost()).toBe(false)
    expect(service.getHostEpoch()).toBe(3)
    expect(onWitnessMetadataDiscovered).toHaveBeenCalledWith(
      expect.objectContaining({
        authoritativeEventId: 'uuid-disc-real',
        hostUserId: 'alice',
        highestSeenEpoch: 2
      })
    )
    expect(service.getCalibratedClock().now()).toBeGreaterThanOrEqual(witnessTime1 + 1)

    const beaconSent = mqttCli.published.find((f) => f.topic.endsWith('/epoch-beacon') && f.parsed?.hostEpoch === 3)
    expect(beaconSent).toBeDefined()

    service.disconnect()
  })

  it('Client rejects stale Epoch=1 host_hello/host_heartbeat when highestSeenEpoch=2 and replies with epoch_superseded', async () => {
    saveEpochWitnessRecord({
      inviteCode: 'ROOM-FENCE',
      authoritativeEventId: 'uuid-fence',
      eventName: 'Fence Event',
      hostUserId: 'alice',
      highestSeenEpoch: 2,
      activeHostSessionId: 'host-epoch-2',
      activeHostDeviceId: 'dev_host_2'
    })

    const client = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    })

    await client.join('ROOM-FENCE', 'ScoutSam', 'sam-id')
    // Let initial join() setupClientConnection settle before testing zombie host isolation
    await new Promise((r) => setTimeout(r, 30))
    const mqttClient = createdMqttClients[createdMqttClients.length - 1]!
    mqttClient.published.length = 0

    // Zombie Host A (Epoch=1) wakes up and sends host_hello + host_heartbeat
    await mqttClient.emitMessage('scoutingpro27/signal/main', {
      type: 'host_hello',
      sender: 'zombie_host_a',
      hostSessionId: 'zombie-sess-1',
      deviceId: 'dev_zombie',
      hostEpoch: 1
    })
    await mqttClient.emitMessage('scoutingpro27/signal/main', {
      type: 'host_heartbeat',
      sender: 'zombie_host_a',
      hostSessionId: 'zombie-sess-1',
      deviceId: 'dev_zombie',
      hostEpoch: 1,
      timestamp: Date.now()
    })
    await new Promise((r) => setTimeout(r, 20))

    expect(client.getCurrentHostSessionId()).not.toBe('zombie-sess-1')

    const superseded = mqttClient.published.filter((f) => f.parsed?.type === 'epoch_superseded')
    expect(superseded.length).toBeGreaterThanOrEqual(1)
    expect(superseded[0]?.parsed?.currentEpoch).toBe(2)
    expect(superseded[0]?.parsed?.target).toBe('zombie_host_a')

    // Must not start WebRTC Offer toward zombie host
    const sentOffer = mqttClient.published.some((f) => Boolean(f.parsed?.offer))
    expect(sentOffer).toBe(false)

    client.disconnect()
  })
})
