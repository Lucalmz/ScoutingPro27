import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEventWebRtcBridge } from '@/views/useEventWebRtcBridge'
import { useConnectionStore } from '@/stores/connection'
import { useEventStore } from '@/stores/events'
import { useUserStore } from '@/stores/user'
import * as api from '@/services/api'
import * as scoutStorage from '@/services/scoutStorage'

const { webrtcFactoryHook } = vi.hoisted(() => ({
  webrtcFactoryHook: { fn: null as null | ((cb: any) => any) }
}))

vi.mock('@/services/webrtc', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/services/webrtc')>()
  return {
    ...mod,
    createWebRtcService: vi.fn((cb: any) =>
      webrtcFactoryHook.fn ? webrtcFactoryHook.fn(cb) : mod.createWebRtcService(cb)
    )
  }
})

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>()
  return {
    ...actual,
    addEventMember: vi.fn().mockResolvedValue({ success: true })
  }
})

describe('useEventWebRtcBridge', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    localStorage.clear()
    sessionStorage.clear()
    webrtcFactoryHook.fn = null
    const webrtcMod = await import('@/services/webrtc')
    const actualWebrtc = await vi.importActual<typeof import('@/services/webrtc')>('@/services/webrtc')
    vi.mocked(webrtcMod.createWebRtcService).mockImplementation((cb: any) =>
      webrtcFactoryHook.fn ? webrtcFactoryHook.fn(cb) : actualWebrtc.createWebRtcService(cb)
    )
    vi.mocked(api.addEventMember).mockReset().mockResolvedValue({ success: true } as any)
  })

  afterEach(() => {
    try {
      useConnectionStore().rtcService?.disconnect?.()
    } catch {
      // ignore mock without disconnect
    }
    localStorage.clear()
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('preserves waiting/host_online status without flashing connecting when returning from details', async () => {
    const eventStore = useEventStore()
    const connStore = useConnectionStore()
    const userStore = useUserStore()

    userStore.user = { id: 'host-1', username: 'HostUser', token: 'valid-token' }
    eventStore.setCurrentEvent({
      id: 'evt-123',
      name: 'Championship 2026',
      inviteCode: 'TEST26',
      hostId: 'host-1'
    })

    const mockRtc: any = {
      host: vi.fn(),
      join: vi.fn(),
      disconnect: vi.fn(),
      updateCallbacks: vi.fn(),
      getStatus: () => 'waiting'
    }

    connStore.setRtcService(mockRtc)
    connStore.setStatus('waiting')

    const { setupWebRTC } = useEventWebRtcBridge({
      eventId: ref('evt-123'),
      event: ref(eventStore.currentEvent),
      router: { replace: vi.fn() } as any,
      t: (k: string) => k
    })

    await setupWebRTC()

    expect(connStore.status).toBe('waiting')
    expect(mockRtc.updateCallbacks).toHaveBeenCalled()
    expect(mockRtc.host).not.toHaveBeenCalled()
  })

  it('preserves connected status without flashing connecting when returning from details', async () => {
    const eventStore = useEventStore()
    const connStore = useConnectionStore()
    const userStore = useUserStore()

    userStore.user = { id: 'scout-1', username: 'ScoutUser', token: 'valid-token' }
    eventStore.setCurrentEvent({
      id: 'evt-123',
      name: 'Championship 2026',
      inviteCode: 'TEST26',
      hostId: 'host-1'
    })

    const mockRtc: any = {
      host: vi.fn(),
      join: vi.fn(),
      disconnect: vi.fn(),
      updateCallbacks: vi.fn(),
      getStatus: () => 'connected'
    }

    connStore.setRtcService(mockRtc)
    connStore.setStatus('connected')

    const { setupWebRTC } = useEventWebRtcBridge({
      eventId: ref('evt-123'),
      event: ref(eventStore.currentEvent),
      router: { replace: vi.fn() } as any,
      t: (k: string) => k
    })

    await setupWebRTC()

    expect(connStore.status).toBe('connected')
    expect(mockRtc.updateCallbacks).toHaveBeenCalled()
    expect(mockRtc.join).not.toHaveBeenCalled()
  })

  it('tears down old WebRTC service when navigating to a different event', async () => {
    const eventStore = useEventStore()
    const connStore = useConnectionStore()
    const userStore = useUserStore()

    userStore.user = { id: 'host-1', username: 'HostUser', token: 'valid-token' }
    eventStore.setCurrentEvent({
      id: 'evt-456',
      name: 'Event 456',
      inviteCode: 'NEW456',
      hostId: 'host-1'
    })

    const mockOldRtc: any = {
      host: vi.fn(),
      join: vi.fn(),
      disconnect: vi.fn(),
      updateCallbacks: vi.fn(),
      getStatus: () => 'waiting'
    }

    connStore.setRtcService(mockOldRtc)
    connStore.setStatus('waiting')

    const mockNewRtc: any = {
      host: vi.fn(async () => {}),
      join: vi.fn(async () => {}),
      disconnect: vi.fn(),
      updateCallbacks: vi.fn(),
      setEventMetadata: vi.fn(),
      getStatus: () => 'connecting'
    }
    webrtcFactoryHook.fn = () => mockNewRtc

    const { setupWebRTC } = useEventWebRtcBridge({
      eventId: ref('evt-789'),
      event: ref(eventStore.currentEvent),
      router: { replace: vi.fn() } as any,
      t: (k: string) => k
    })

    await setupWebRTC()

    expect(mockOldRtc.disconnect).toHaveBeenCalled()
    expect(mockOldRtc.updateCallbacks).not.toHaveBeenCalled()
  })

  it('cleanupWebRTC resets connStore status to offline and clears service', () => {
    const eventStore = useEventStore()
    const connStore = useConnectionStore()

    const mockRtc: any = {
      disconnect: vi.fn()
    }
    connStore.setRtcService(mockRtc)
    connStore.setStatus('connected')

    const { cleanupWebRTC } = useEventWebRtcBridge({
      eventId: ref('evt-123'),
      event: ref(eventStore.currentEvent),
      router: { replace: vi.fn() } as any,
      t: (k: string) => k
    })

    cleanupWebRTC()

    expect(mockRtc.disconnect).toHaveBeenCalled()
    expect(connStore.rtcService).toBeNull()
    expect(connStore.status).toBe('offline')
  })

  it('does not tear down or restart WebRTC when a fenced Standby host receives epoch_witness updates', async () => {
    const { createWebRtcService } = await import('@/services/webrtc')
    vi.mocked(createWebRtcService).mockClear()

    const eventStore = useEventStore()
    const connStore = useConnectionStore()
    const userStore = useUserStore()

    userStore.user = { id: 'host-1', username: 'HostUser', token: 'valid-token' }
    const evt = {
      id: 'evt-auth-1',
      name: 'Epoch Fencing Event',
      inviteCode: 'EP01',
      hostId: 'host-1'
    }
    eventStore.setCurrentEvent(evt)

    let capturedCallbacks: any = null
    let hostModeFlag = true
    let standbyFlag = false
    const mockRtc: any = {
      host: vi.fn(async () => {}),
      join: vi.fn(async () => {}),
      disconnect: vi.fn(),
      updateCallbacks: vi.fn(),
      setEventMetadata: vi.fn(),
      getStatus: () => 'connecting',
      isHostMode: () => hostModeFlag,
      isStandbyHost: () => standbyFlag,
      getHostEpoch: () => 2
    }
    webrtcFactoryHook.fn = (cb) => {
      capturedCallbacks = cb
      return mockRtc
    }

    const { setupWebRTC } = useEventWebRtcBridge({
      eventId: ref('evt-auth-1'),
      event: ref(evt),
      router: {
        replace: vi.fn(async () => {}),
        currentRoute: ref({ params: { eventId: 'evt-auth-1' }, query: {} })
      } as any,
      t: (k: string) => k
    })

    await setupWebRTC()
    expect(vi.mocked(createWebRtcService)).toHaveBeenCalledTimes(1)
    expect(mockRtc.host).toHaveBeenCalledTimes(1)
    expect(capturedCallbacks).toBeTruthy()

    hostModeFlag = false
    standbyFlag = true
    connStore.setStatus('connecting')
    capturedCallbacks.onHostStandby?.({ hostSessionId: 'host-b', hostDeviceId: 'dev-b' })

    const witnessPayload = {
      inviteCode: 'EP01',
      authoritativeEventId: 'evt-auth-1',
      eventName: 'Epoch Fencing Event',
      hostUserId: 'host-1',
      highestSeenEpoch: 2,
      activeHostSessionId: 'host-b',
      activeHostDeviceId: 'dev-b',
      updatedAt: Date.now()
    }
    capturedCallbacks.onEpochWitnessUpdated?.(witnessPayload)
    await capturedCallbacks.onWitnessMetadataDiscovered?.(witnessPayload)

    expect(mockRtc.disconnect).not.toHaveBeenCalled()
    expect(vi.mocked(createWebRtcService)).toHaveBeenCalledTimes(1)
    expect(connStore.isStandbyHost).toBe(true)
  })

  describe('onClientConnected member persistence & deduplication', () => {
    it('deduplicates addEventMember per userId in host mode and rolls back on failure for retry', async () => {
      const eventStore = useEventStore()
      const connStore = useConnectionStore()
      const userStore = useUserStore()
      const saveKnownScoutSpy = vi.spyOn(scoutStorage, 'saveKnownScout')

      userStore.user = { id: 'host-1', username: 'HostUser', token: 'valid-token' }
      const evt = {
        id: 'evt-members-1',
        name: 'Members Event',
        inviteCode: 'MEM001',
        hostId: 'host-1'
      }
      eventStore.setCurrentEvent(evt)

      let capturedCallbacks: any = null
      const mockRtc: any = {
        host: vi.fn(async () => {}),
        join: vi.fn(async () => {}),
        disconnect: vi.fn(),
        updateCallbacks: vi.fn(),
        setEventMetadata: vi.fn(),
        getStatus: () => 'waiting',
        isHostMode: () => true,
        isStandbyHost: () => false,
        getScoutTransportInfo: () => null,
        sendMessage: vi.fn(async () => {})
      }
      webrtcFactoryHook.fn = (cb) => {
        capturedCallbacks = cb
        return mockRtc
      }

      const { setupWebRTC } = useEventWebRtcBridge({
        eventId: ref('evt-members-1'),
        event: ref(evt),
        router: {
          replace: vi.fn(async () => {}),
          currentRoute: ref({ params: { eventId: 'evt-members-1' }, query: {} })
        } as any,
        t: (k: string) => k
      })

      await setupWebRTC()
      expect(capturedCallbacks?.onClientConnected).toBeTypeOf('function')

      // 1. Alice connects twice -> addEventMember called only once
      capturedCallbacks.onClientConnected('scout-alice', 'Alice')
      capturedCallbacks.onClientConnected('scout-alice', 'Alice')
      await flushPromises()

      expect(saveKnownScoutSpy).toHaveBeenCalledTimes(2)
      expect(connStore.connectedScouts.find((s) => s.id === 'scout-alice')).toBeDefined()
      expect(api.addEventMember).toHaveBeenCalledTimes(1)
      expect(api.addEventMember).toHaveBeenCalledWith('evt-members-1', 'scout-alice', 'Alice')

      // 2. Bob fails first persistence -> rolled back from syncedMemberIds so retry succeeds
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.mocked(api.addEventMember)
        .mockRejectedValueOnce(new Error('network blip'))
        .mockResolvedValueOnce({ success: true } as any)

      capturedCallbacks.onClientConnected('scout-bob', 'Bob')
      await flushPromises()
      expect(warnSpy).toHaveBeenCalled()
      expect(api.addEventMember).toHaveBeenCalledTimes(2)

      capturedCallbacks.onClientConnected('scout-bob', 'Bob')
      await flushPromises()
      expect(api.addEventMember).toHaveBeenCalledTimes(3)
      expect(api.addEventMember).toHaveBeenLastCalledWith('evt-members-1', 'scout-bob', 'Bob')

      // Reconnecting Bob once persisted is deduplicated
      capturedCallbacks.onClientConnected('scout-bob', 'Bob')
      await flushPromises()
      expect(api.addEventMember).toHaveBeenCalledTimes(3)
    })

    it('does not call addEventMember on non-host client while still saving known scout locally', async () => {
      const eventStore = useEventStore()
      const connStore = useConnectionStore()
      const userStore = useUserStore()
      const saveKnownScoutSpy = vi.spyOn(scoutStorage, 'saveKnownScout')

      userStore.user = { id: 'client-self', username: 'ClientUser', token: 'valid-token' }
      const evt = {
        id: 'evt-members-2',
        name: 'Client Event',
        inviteCode: 'CLI002',
        hostId: 'host-other'
      }
      eventStore.setCurrentEvent(evt)

      let capturedCallbacks: any = null
      const mockRtc: any = {
        host: vi.fn(async () => {}),
        join: vi.fn(async () => {}),
        disconnect: vi.fn(),
        updateCallbacks: vi.fn(),
        setEventMetadata: vi.fn(),
        getStatus: () => 'connected',
        isHostMode: () => false,
        isStandbyHost: () => false,
        getScoutTransportInfo: () => null,
        sendMessage: vi.fn(async () => {})
      }
      webrtcFactoryHook.fn = (cb) => {
        capturedCallbacks = cb
        return mockRtc
      }

      const { setupWebRTC } = useEventWebRtcBridge({
        eventId: ref('evt-members-2'),
        event: ref(evt),
        router: {
          replace: vi.fn(async () => {}),
          currentRoute: ref({ params: { eventId: 'evt-members-2' }, query: {} })
        } as any,
        t: (k: string) => k
      })

      await setupWebRTC()
      expect(eventStore.isHost).toBe(false)

      capturedCallbacks.onClientConnected('scout-peer', 'PeerOne')
      await flushPromises()

      // Positive precondition: local handler ran and persisted to local storage
      expect(connStore.connectedScouts.find((s) => s.id === 'scout-peer')).toBeDefined()
      expect(saveKnownScoutSpy).toHaveBeenCalledWith(
        'evt-members-2',
        expect.objectContaining({ id: 'scout-peer', name: 'PeerOne' })
      )
      expect(api.addEventMember).not.toHaveBeenCalled()
    })
  })
})
