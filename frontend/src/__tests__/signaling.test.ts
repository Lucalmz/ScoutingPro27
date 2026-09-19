import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SignalingChannel, BUILTIN_BROKERS } from '../services/webrtc/signaling'
import mqtt from 'mqtt'

vi.mock('mqtt', () => ({
  default: {
    connect: vi.fn()
  }
}))

describe('SignalingChannel Multi-Broker & LAN WebSocket', () => {
  let mockMqttClient: any

  beforeEach(() => {
    (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ = true
    mockMqttClient = {
      on: vi.fn(),
      subscribe: vi.fn(),
      publish: vi.fn(),
      connected: true,
      unsubscribe: vi.fn(),
      end: vi.fn()
    }
    vi.mocked(mqtt.connect).mockReturnValue(mockMqttClient)
  })

  afterEach(() => {
    (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ = false
    vi.clearAllMocks()
  })

  it('uses default EMQX broker on standard connect', async () => {
    const channel = new SignalingChannel('test-room-1')
    await channel.initTopic()
    channel.connect({
      onMessage: vi.fn(),
      onConnect: vi.fn()
    })

    expect(mqtt.connect).toHaveBeenCalledWith(
      'wss://broker.emqx.io:8084/mqtt',
      expect.objectContaining({ connectTimeout: 4000 })
    )
    expect(channel.isLanMode()).toBe(false)
  })

  it('identifies and connects to Native LAN WebSocket endpoint', async () => {
    let wsInstance: any = null
    class MockWebSocket {
      static OPEN = 1
      static CONNECTING = 0
      static CLOSING = 2
      static CLOSED = 3

      readyState = 1
      onopen: any
      onmessage: any
      onerror: any
      onclose: any
      send = vi.fn()
      close = vi.fn()

      constructor(public url: string) {
        wsInstance = this
        setTimeout(() => this.onopen?.(), 10)
      }
    }

    const originalWs = global.WebSocket
    global.WebSocket = MockWebSocket as any

    try {
      const channel = new SignalingChannel('test-room-lan', 'ws://192.168.1.100:8080/ws/signal')
      await channel.initTopic()

      const onConnect = vi.fn()
      channel.connect({
        onMessage: vi.fn(),
        onConnect
      })

      expect(channel.isLanMode()).toBe(true)
      expect(wsInstance.url).toBe('ws://192.168.1.100:8080/ws/signal/test-room-lan')

      // Wait for connect
      await new Promise(r => setTimeout(r, 20))
      expect(onConnect).toHaveBeenCalled()

      // Send payload over LAN WS
      await channel.send({ type: 'host_hello', ecdhPublicKey: 'pub-test' })
      expect(wsInstance.send).toHaveBeenCalled()

      channel.close()
      expect(wsInstance.close).toHaveBeenCalled()
    } finally {
      global.WebSocket = originalWs
    }
  })

  it('supports custom broker override via parameter', async () => {
    const channel = new SignalingChannel('test-room-custom', 'wss://my-private-broker.com:8884/mqtt')
    await channel.initTopic()
    channel.connect({
      onMessage: vi.fn(),
      onConnect: vi.fn()
    })

    expect(mqtt.connect).toHaveBeenCalledWith(
      'wss://my-private-broker.com:8884/mqtt',
      expect.anything()
    )
  })

  it('correctly maps broker ID "emqx" to official EMQX WebSocket URL', async () => {
    const channel = new SignalingChannel('test-room-emqx', 'emqx')
    await channel.initTopic()
    channel.connect({
      onMessage: vi.fn(),
      onConnect: vi.fn()
    })

    expect(mqtt.connect).toHaveBeenCalledWith(
      'wss://broker.emqx.io:8084/mqtt',
      expect.anything()
    )
    expect(channel.isLanMode()).toBe(false)
  })

  it('resolveBrokerUrl maps broker IDs, lan shortcut, and fallbacks properly', async () => {
    const { resolveBrokerUrl } = await import('../services/webrtc/signaling')
    
    expect(resolveBrokerUrl('emqx')).toBe('wss://broker.emqx.io:8084/mqtt')
    expect(resolveBrokerUrl('EMQX')).toBe('wss://broker.emqx.io:8084/mqtt')
    expect(resolveBrokerUrl('fallback')).toBe('wss://broker.emqx.io:8084/mqtt')
    expect(resolveBrokerUrl(null)).toBe('wss://broker.emqx.io:8084/mqtt')
    expect(resolveBrokerUrl('')).toBe('wss://broker.emqx.io:8084/mqtt')
    expect(resolveBrokerUrl('wss://custom.io/mqtt')).toBe('wss://custom.io/mqtt')
    expect(resolveBrokerUrl('invalid-broker-string')).toBe('wss://broker.emqx.io:8084/mqtt')
  })
})
