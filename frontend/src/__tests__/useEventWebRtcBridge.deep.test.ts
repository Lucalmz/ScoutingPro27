import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEventWebRtcBridge } from '@/views/useEventWebRtcBridge'
import { useConnectionStore } from '@/stores/connection'
import { useEventStore } from '@/stores/events'
import { useUserStore } from '@/stores/user'
import { useRecordStore } from '@/stores/records'
import { useScheduleStore } from '@/stores/schedule'
import { usePitScoutStore } from '@/stores/pitScout'
import { useCustomFieldsStore } from '@/stores/customFields'
import { useToastStore } from '@/stores/toast'
import { useInboxStore } from '@/stores/inbox'
import * as api from '@/services/api'
import * as photoStorage from '@/services/photoStorage'
import * as mobilePhotoCache from '@/services/mobilePhotoCache'
import * as isMobileComposable from '@/composables/useIsMobile'
import * as crdtMod from '@/services/crdt'
import type { ScoutingEvent, ScoutingRecord } from '@/types'

const { webrtcFactoryHook, crdtHubHook } = vi.hoisted(() => ({
  webrtcFactoryHook: { fn: null as null | ((cb: any) => any) },
  crdtHubHook: { fn: null as null | ((cfg: any) => any) }
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

vi.mock('@/services/crdt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/crdt')>()
  return {
    ...actual,
    createWebRtcCrdtSynchronizerHub: vi.fn((cfg: any) =>
      crdtHubHook.fn ? crdtHubHook.fn(cfg) : actual.createWebRtcCrdtSynchronizerHub(cfg)
    )
  }
})

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>()
  return {
    ...actual,
    addEventMember: vi.fn().mockResolvedValue({ success: true }),
    syncExternalEvent: vi.fn(),
    syncPitRecordsBatch: vi.fn().mockResolvedValue({ success: true }),
    migrateScoutRecords: vi.fn().mockResolvedValue({ success: true }),
    syncRecords: vi.fn().mockResolvedValue({ success: true })
  }
})

function makeRecord(overrides: Partial<ScoutingRecord> = {}): ScoutingRecord {
  return {
    id: 'rec-1',
    eventId: 'evt-1',
    scoutId: 'u-1',
    scoutName: 'Alice',
    matchNumber: 1,
    teamNumber: 27570,
    autoScore: 10,
    teleopScore: 20,
    endgameScore: 5,
    totalScore: 35,
    notes: '',
    rawData: '{}',
    syncStatus: 'PENDING',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    isBroken: false,
    version: 1,
    ...overrides
  }
}

describe('useEventWebRtcBridge deep lifecycle, CRDT callbacks & sync pipelines', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    sessionStorage.clear()
    webrtcFactoryHook.fn = null
    crdtHubHook.fn = null
    vi.mocked(api.addEventMember).mockReset().mockResolvedValue({ success: true } as any)
    vi.mocked(api.syncPitRecordsBatch).mockReset().mockResolvedValue({ success: true } as any)
    vi.mocked(api.migrateScoutRecords).mockReset().mockResolvedValue({ success: true } as any)
  })

  afterEach(async () => {
    try {
      useConnectionStore().rtcService?.disconnect?.()
    } catch {}
    await crdtMod.disposeEventCrdt('evt-bridge-1').catch(() => {})
    await crdtMod.disposeEventCrdt('evt-bridge-2').catch(() => {})
    await crdtMod.disposeEventCrdt('uuid-real-evt').catch(() => {})
    delete (window as any).__sp27E2eBridge
    localStorage.clear()
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('redirects unauthenticated user in setupWebRTC and skips if currentEvent is null', async () => {
    const userStore = useUserStore()
    userStore.user = null
    const router = { replace: vi.fn(), currentRoute: ref({ params: {}, query: {} }) }

    const { setupWebRTC } = useEventWebRtcBridge({
      eventId: ref('evt-1'),
      event: ref(null),
      router: router as any,
      t: (k: string) => k
    })

    await setupWebRTC()
    expect(router.replace).toHaveBeenCalledWith('/')

    // Logged in but no event -> no rtcService created
    userStore.user = { id: 'u-1', username: 'Alice', token: 'tok' }
    await setupWebRTC()
    expect(useConnectionStore().rtcService).toBeNull()
  })

  it('initializes CRDT session, switches events cleanly, exposes E2E bridge in DEV, and disposes cleanly', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'host-1', username: 'HostUser', token: 'tok-1' }
    const evt1: ScoutingEvent = { id: 'evt-bridge-1', name: 'E1', inviteCode: 'BR01', hostId: 'host-1' }
    const evt2: ScoutingEvent = { id: 'evt-bridge-2', name: 'E2', inviteCode: 'BR02', hostId: 'host-1' }
    const eventStore = useEventStore()
    eventStore.setCurrentEvent(evt1)

    const eventIdRef = ref('evt-bridge-1')
    const eventRef = ref<ScoutingEvent | null>(evt1)
    const connStore = useConnectionStore()

    const mockHub = {
      triggerFullSyncWithPeer: vi.fn().mockResolvedValue(true),
      attachPeer: vi.fn().mockResolvedValue(undefined),
      detachPeer: vi.fn().mockResolvedValue(undefined),
      getAttachedPeers: vi.fn(() => []),
      handleIncomingMessage: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined)
    }
    crdtHubHook.fn = () => mockHub

    const bridge = useEventWebRtcBridge({
      eventId: eventIdRef,
      event: eventRef,
      router: { replace: vi.fn(), currentRoute: ref({ params: { eventId: 'evt-bridge-1' }, query: {} }) } as any,
      t: (k: string) => k
    })

    const h1 = await bridge.initEventCrdt()
    expect(h1?.eventId).toBe('evt-bridge-1')
    expect((window as any).__sp27E2eBridge?.getEventId()).toBe('evt-bridge-1')

    // Calling initEventCrdt again on same event reuses existing hub
    const h1Again = await bridge.initEventCrdt('evt-bridge-1')
    expect(h1Again?.eventId).toBe('evt-bridge-1')
    expect(mockHub.destroy).not.toHaveBeenCalled()

    // Trigger CRDT sync via connectionStore
    const synced = await connStore.triggerCrdtSync('peer-x')
    expect(synced).toBe(true)
    expect(mockHub.triggerFullSyncWithPeer).toHaveBeenCalledWith('peer-x')

    // Switching to another event destroys old hub before creating new one
    eventRef.value = evt2
    eventIdRef.value = 'evt-bridge-2'
    eventStore.setCurrentEvent(evt2)
    const h2 = await bridge.initEventCrdt('evt-bridge-2')
    expect(h2?.eventId).toBe('evt-bridge-2')
    expect(mockHub.destroy).toHaveBeenCalledTimes(1)

    await bridge.disposeEventCrdtSession()
    expect(mockHub.destroy).toHaveBeenCalledTimes(2)
    expect((window as any).__sp27E2eBridge).toBeUndefined()
  })

  it('routes CRDT hub callbacks (skew resync, sanitize rejects, peer sync settled) properly in host & client modes', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'host-1', username: 'Host', token: 'tok' }
    const evt: ScoutingEvent = { id: 'evt-bridge-1', name: 'E1', inviteCode: 'BR01', hostId: 'host-1' }
    const eventStore = useEventStore()
    eventStore.setCurrentEvent(evt)
    const recordStore = useRecordStore()
    const connStore = useConnectionStore()

    const sendMessageSpy = vi.fn().mockResolvedValue(undefined)
    const sendForceClockResyncSpy = vi.fn().mockResolvedValue(undefined)
    let isHostModeVal = true
    connStore.setRtcService({
      isHostMode: () => isHostModeVal,
      getHostEpoch: () => 3,
      getPeerUserId: (pid: string) => (pid === 'peer-1' ? 'u-peer-1' : undefined),
      sendMessage: sendMessageSpy,
      sendForceClockResync: sendForceClockResyncSpy,
      disconnect: vi.fn()
    } as any)

    let capturedHubCfg: any = null
    crdtHubHook.fn = (cfg: any) => {
      capturedHubCfg = cfg
      return {
        triggerFullSyncWithPeer: vi.fn().mockResolvedValue(true),
        attachPeer: vi.fn().mockResolvedValue(undefined),
        detachPeer: vi.fn().mockResolvedValue(undefined),
        getAttachedPeers: vi.fn(() => []),
        handleIncomingMessage: vi.fn(),
        destroy: vi.fn().mockResolvedValue(undefined)
      }
    }

    const { initEventCrdt } = useEventWebRtcBridge({
      eventId: ref('evt-bridge-1'),
      event: ref(evt),
      router: { replace: vi.fn(), currentRoute: ref({ params: { eventId: 'evt-bridge-1' }, query: {} }) } as any,
      t: (k: string) => k
    })
    await initEventCrdt()
    expect(capturedHubCfg).toBeTruthy()

    // sendToPeer uses peerId only when host
    capturedHubCfg.sendToPeer('peer-1', { type: 'CRDT_SYNC_MSG' })
    expect(sendMessageSpy).toHaveBeenCalledWith({ type: 'CRDT_SYNC_MSG' }, 'peer-1')

    // onFutureClockSkew in host mode triggers sendForceClockResync
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    capturedHubCfg.onFutureClockSkew('peer-1', { maxSkewMs: 999999, maxIncomingPt: 9999999 })
    expect(warnSpy).toHaveBeenCalled()
    expect(sendForceClockResyncSpy).toHaveBeenCalledWith('peer-1', 'future_hlc_skew')

    // onPeerSyncSettled in client mode marks pending records synced
    isHostModeVal = false
    recordStore.records = [
      makeRecord({ id: 'rec-pend', eventId: 'evt-bridge-1', syncStatus: 'PENDING' })
    ]
    const markSyncedSpy = vi.spyOn(recordStore, 'markSynced').mockResolvedValue(undefined as any)
    capturedHubCfg.onPeerSyncSettled('host')
    expect(markSyncedSpy).toHaveBeenCalledWith(['rec-pend'])
  })

  it('handles schedule/pit/custom-field sync, conflicts, SAS, standby/demote/host-left & client sync pipeline', async () => {
    vi.spyOn(photoStorage, 'isDesktopHost').mockReturnValue(true)
    vi.spyOn(isMobileComposable, 'isMobileDevice').mockReturnValue(false)
    vi.spyOn(photoStorage, 'flushOfflinePhotos').mockResolvedValue(undefined as any)

    const userStore = useUserStore()
    userStore.user = { id: 'host-1', username: 'Host', token: 'tok-host' }
    const evt: ScoutingEvent = { id: 'evt-bridge-1', name: 'E1', inviteCode: 'BR01', hostId: 'host-1' }
    const eventStore = useEventStore()
    eventStore.setCurrentEvent(evt)
    const connStore = useConnectionStore()
    const recordStore = useRecordStore()
    const scheduleStore = useScheduleStore()
    const pitStore = usePitScoutStore()
    const customFieldsStore = useCustomFieldsStore()
    const toastStore = useToastStore()
    const inboxStore = useInboxStore()

    const toastSpy = vi.spyOn(toastStore, 'showToast')
    const errorToastSpy = vi.spyOn(toastStore, 'showError')
    const flushOutboxSpy = vi.spyOn(inboxStore, 'flushOutbox').mockResolvedValue(undefined as any)
    const flushPendingPitSpy = vi.spyOn(pitStore, 'flushPendingPitRecords').mockResolvedValue(undefined as any)

    let capturedCb: any = null
    let hostMode = true
    const mockRtc: any = {
      host: vi.fn(async () => {}),
      join: vi.fn(async () => {}),
      disconnect: vi.fn(),
      updateCallbacks: vi.fn(),
      setEventMetadata: vi.fn(),
      requestSync: vi.fn(),
      sendTagsFullSync: vi.fn(),
      sendMessage: vi.fn(async () => {}),
      isHostMode: () => hostMode,
      isStandbyHost: () => false,
      getHostEpoch: () => 1
    }
    webrtcFactoryHook.fn = (cb) => {
      capturedCb = cb
      return mockRtc
    }
    const mockHub = {
      triggerFullSyncWithPeer: vi.fn().mockResolvedValue(true),
      attachPeer: vi.fn().mockResolvedValue(undefined),
      detachPeer: vi.fn().mockResolvedValue(undefined),
      getAttachedPeers: vi.fn(() => []),
      handleIncomingMessage: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined)
    }
    crdtHubHook.fn = () => mockHub

    const router = { replace: vi.fn(async () => {}), currentRoute: ref({ params: { eventId: 'evt-bridge-1' }, query: {} }) }
    const { initEventCrdt, setupWebRTC, handleBeforeUnload } = useEventWebRtcBridge({
      eventId: ref('evt-bridge-1'),
      event: ref(evt),
      router: router as any,
      t: (k: string, v?: any) => (v ? `${k}:${JSON.stringify(v)}` : k)
    })

    await initEventCrdt()
    await setupWebRTC()
    expect(mockRtc.host).toHaveBeenCalledTimes(1)

    // Peer DataChannel open/close & incoming CRDT message
    capturedCb.onPeerDataChannelOpen('peer-a')
    expect(crdtMod.isCrdtTransportActive('evt-bridge-1')).toBe(true)
    capturedCb.onCrdtSyncMessage('peer-a', { message: 1, body: {} })
    expect(mockHub.handleIncomingMessage).toHaveBeenCalledWith('peer-a', { message: 1, body: {} })
    capturedCb.onPeerDataChannelClose('peer-a')
    expect(crdtMod.isCrdtTransportActive('evt-bridge-1')).toBe(false)

    // Records received & Ack filtering rejectedRecordIds
    vi.spyOn(recordStore, 'bulkSync').mockResolvedValue([makeRecord({ teamNumber: 27570, matchNumber: 3 })])
    const accepted = await capturedCb.onRecordsReceived([makeRecord()])
    expect(accepted).toHaveLength(1)
    expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining('webrtc.single_record_received'), 'info')

    const markSpy = vi.spyOn(recordStore, 'markSynced').mockResolvedValue(undefined as any)
    capturedCb.onAckReceived(['r1', 'r2'], undefined, ['r2'])
    expect(markSpy).toHaveBeenCalledWith(['r1'])

    // Schedule batch sync (>20 matches -> SCHEDULE_BATCH_SYNC)
    scheduleStore.schedules = Array.from({ length: 25 }, (_, i) => ({
      id: `s-${i + 1}`,
      eventId: 'evt-bridge-1',
      matchNumber: i + 1,
      tournamentLevel: 'QUALIFICATION',
      red1: 100 + i,
      red2: 200 + i,
      blue1: 300 + i,
      blue2: 400 + i
    }))
    scheduleStore.assignments = {
      QUALIFICATION_1_red1: {
        eventId: 'evt-bridge-1',
        matchNumber: 1,
        tournamentLevel: 'QUALIFICATION',
        station: 'red1',
        teamNumber: 100,
        scoutId: 'u-1',
        scoutName: 'Alice'
      }
    }
    await capturedCb.onRequestScheduleSync('peer-a')
    const batchCalls = mockRtc.sendMessage.mock.calls.filter((c: any[]) => c[0]?.type === 'SCHEDULE_BATCH_SYNC')
    expect(batchCalls).toHaveLength(2)

    // Pit sync (>15 records -> PIT_SCOUT_BATCH_SYNC)
    pitStore.records = Array.from({ length: 16 }, (_, i) => ({
      id: `pit-${i}`,
      eventId: 'evt-bridge-1',
      teamNumber: 1000 + i,
      scoutId: 'u-1',
      scoutName: 'Alice',
      drivetrainType: 'mecanum',
      weightLbs: 30,
      ballCompatibility: 'universal',
      launcherType: '',
      flowerMechanism: '',
      hasColorSensor: false,
      hasDescoreMech: false,
      hasApriltagVision: false,
      odometryType: 'none',
      claimedAutoStrategy: '',
      claimedAutoScore: 0,
      claimedTeleopCycles: 0,
      claimedTeleopScore: 0,
      claimedEndgameScore: 0,
      claimedTotalScore: 0,
      photoKeys: [],
      version: 1
    }))
    await capturedCb.onRequestPitSync('peer-a')
    const pitBatches = mockRtc.sendMessage.mock.calls.filter((c: any[]) => c[0]?.type === 'PIT_SCOUT_BATCH_SYNC')
    expect(pitBatches).toHaveLength(2)

    // Pit batch received in host mode triggers syncPitRecordsBatch
    capturedCb.onPitScoutBatchSyncReceived(pitStore.records.slice(0, 2))
    expect(api.syncPitRecordsBatch).toHaveBeenCalledWith('evt-bridge-1', expect.any(Array))

    // Custom fields sync
    capturedCb.onRequestCustomFieldsSync('peer-a')
    expect(mockRtc.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'CUSTOM_FIELDS_FULL_SYNC', eventId: 'evt-bridge-1' }),
      'peer-a'
    )
    const applyCfSpy = vi.spyOn(customFieldsStore, 'applyFullSync')
    capturedCb.onCustomFieldsFullSyncReceived([], 'evt-bridge-1')
    expect(applyCfSpy).toHaveBeenCalledWith('evt-bridge-1', [])

    // SAS verification suppressed in standby mode, queued in normal mode
    capturedCb.onHostStandby({ hostSessionId: 'h2' })
    expect(connStore.isStandbyHost).toBe(true)
    capturedCb.onSasVerificationRequired({ peerId: 'p1', username: 'U', ecdhPublicKey: 'pk' }, '123456')
    expect(connStore.pendingSas).toBeNull()

    capturedCb.onHostPromoted()
    expect(connStore.isStandbyHost).toBe(false)
    capturedCb.onSasVerificationRequired({ peerId: 'p1', username: 'U', ecdhPublicKey: 'pk' }, '123456')
    expect(connStore.pendingSas?.fingerprint).toBe('123456')
    capturedCb.onSasVerified('p1')
    expect(connStore.pendingSas).toBeNull()

    // Session conflict suspends sync pipeline when connected (e.g. standby host), resumes when resolved
    hostMode = false
    capturedCb.onHostStandby({ hostSessionId: 'host-active' })
    capturedCb.onSessionConflict('Host', 'host-1', false, 'SAME_USER')
    await flushPromises()
    expect(capturedCb.isConflictActive()).toBe(true)
    capturedCb.onStatusChange('connected')
    await flushPromises()
    expect(flushOutboxSpy).toHaveBeenCalled()
    expect(flushPendingPitSpy).not.toHaveBeenCalled()

    // Resolving conflict resumes triggerClientSyncPipeline
    capturedCb.onTakeoverSuccess()
    await flushPromises()
    expect(flushPendingPitSpy).toHaveBeenCalledWith('evt-bridge-1')
    capturedCb.onHostPromoted()

    // BUG #3 anti-regression: lowercase ext_ placeholder event receives TAG_UPDATE & TAGS_FULL_SYNC from authoritative UUID
    const extEvent: ScoutingEvent = { id: 'ext_BR01', name: 'Ext', inviteCode: 'BR01', hostId: 'host-other' }
    eventStore.setCurrentEvent(extEvent)
    expect(recordStore.teamTags).toHaveLength(0)

    capturedCb.onTagUpdateReceived(
      { id: 'tag-ext-1', eventId: 'uuid-auth-br01', teamNumber: 27570, tag: 'fast-intake', color: 'green', isPreset: false },
      'ADD',
      'uuid-auth-br01'
    )
    expect(recordStore.teamTags.some(t => t.tag === 'fast-intake')).toBe(true)

    capturedCb.onTagsFullSyncReceived(
      [{ id: 'tag-ext-2', eventId: 'uuid-auth-br01', teamNumber: 19600, tag: 'swerve', color: 'blue', isPreset: false }],
      'uuid-auth-br01'
    )
    expect(recordStore.teamTags.some(t => t.tag === 'swerve')).toBe(true)

    // Negative control: unrelated non-placeholder eventId does NOT overwrite current event tags
    eventStore.setCurrentEvent({ id: 'uuid-auth-br01', name: 'Auth', inviteCode: 'BR01', hostId: 'host-other' })
    capturedCb.onTagUpdateReceived(
      { id: 'tag-alien', eventId: 'uuid-other-evt', teamNumber: 9999, tag: 'alien', color: 'red', isPreset: false },
      'ADD',
      'uuid-other-evt'
    )
    expect(recordStore.teamTags.some(t => t.tag === 'alien')).toBe(false)

    // Kicked & host left
    capturedCb.onSessionKicked('TAKEOVER_TIMEOUT')
    expect(connStore.status).toBe('offline')
    expect(errorToastSpy).toHaveBeenCalledWith('kicked.timeout_msg')

    capturedCb.onHostDemoted({ hostSessionId: 'h3' })
    expect(connStore.isStandbyHost).toBe(true)
    capturedCb.onActiveHostLeft()
    expect(connStore.status).toBe('degraded')

    // handleBeforeUnload disconnects in host mode
    vi.spyOn(photoStorage, 'isDesktopHost').mockReturnValue(true)
    eventStore.setCurrentEvent(evt)
    handleBeforeUnload()
    expect(mockRtc.disconnect).toHaveBeenCalled()
  })

  it('migrates placeholder evt-CODE to authoritative UUID on onEventMetadataReceived', async () => {
    vi.spyOn(photoStorage, 'isDesktopHost').mockReturnValue(false)
    vi.spyOn(isMobileComposable, 'isMobileDevice').mockReturnValue(true)
    vi.spyOn(mobilePhotoCache, 'migrateMobilePhotosEventId').mockResolvedValue(0 as any)

    const userStore = useUserStore()
    userStore.user = { id: 'scout-1', username: 'Scout', token: 'tok' }
    const placeholderEvt: ScoutingEvent = { id: 'evt-ABC123', name: 'Joining', inviteCode: 'ABC123', hostId: 'external_host' }
    const authEvt: ScoutingEvent = { id: 'uuid-real-evt', name: 'Real Event', inviteCode: 'ABC123', hostId: 'host-real' }

    const eventStore = useEventStore()
    eventStore.events = [placeholderEvt]
    eventStore.setCurrentEvent(placeholderEvt)

    vi.mocked(api.syncExternalEvent).mockResolvedValue(authEvt as any)

    let capturedCb: any = null
    const mockRtc: any = {
      host: vi.fn(async () => {}),
      join: vi.fn(async () => {}),
      disconnect: vi.fn(),
      updateCallbacks: vi.fn(),
      setEventMetadata: vi.fn(),
      requestSync: vi.fn(),
      sendMessage: vi.fn(async () => {}),
      isHostMode: () => false,
      isStandbyHost: () => false,
      getHostEpoch: () => 1
    }
    webrtcFactoryHook.fn = (cb) => {
      capturedCb = cb
      return mockRtc
    }

    const router = {
      replace: vi.fn(async () => {}),
      currentRoute: ref({ params: { eventId: 'evt-ABC123' }, query: { tab: 'scout' } })
    }

    const { initEventCrdt, setupWebRTC } = useEventWebRtcBridge({
      eventId: ref('evt-ABC123'),
      event: ref(placeholderEvt),
      router: router as any,
      t: (k: string) => k
    })

    await initEventCrdt('evt-ABC123')
    await setupWebRTC()
    expect(mockRtc.join).toHaveBeenCalledWith('ABC123', 'Scout', 'scout-1')

    await capturedCb.onEventMetadataReceived(authEvt)
    await flushPromises()

    expect(eventStore.currentEvent?.id).toBe('uuid-real-evt')
    expect(router.replace).toHaveBeenCalledWith({
      path: '/event/uuid-real-evt',
      query: { tab: 'scout' }
    })
  })

  it('skips redundant REQUEST_SYNC and full CRDT resync on transient degraded/unstable recovery while preserving real reconnect resync', async () => {
    vi.spyOn(photoStorage, 'isDesktopHost').mockReturnValue(false)
    vi.spyOn(isMobileComposable, 'isMobileDevice').mockReturnValue(true)

    const userStore = useUserStore()
    userStore.user = { id: 'scout-1', username: 'Scout', token: 'tok-scout' }
    const evt: ScoutingEvent = {
      id: 'evt-bridge-2',
      name: 'Transient Recovery Event',
      inviteCode: 'TRNS26',
      hostId: 'host-real'
    }

    const eventStore = useEventStore()
    eventStore.events = [evt]
    eventStore.setCurrentEvent(evt)

    const connStore = useConnectionStore()
    const pitStore = usePitScoutStore()
    const recordStore = useRecordStore()
    const flushPendingPitSpy = vi.spyOn(pitStore, 'flushPendingPitRecords').mockResolvedValue(undefined as any)
    const syncRecordsFromCrdtSpy = vi.spyOn(recordStore, 'syncRecordsFromCrdt')

    let capturedCb: any = null
    const mockRtc: any = {
      host: vi.fn(async () => {}),
      join: vi.fn(async () => {}),
      disconnect: vi.fn(),
      updateCallbacks: vi.fn(),
      setEventMetadata: vi.fn(),
      requestSync: vi.fn(),
      sendMessage: vi.fn(async () => {}),
      isHostMode: () => false,
      isStandbyHost: () => false,
      getHostEpoch: () => 1
    }
    webrtcFactoryHook.fn = (cb) => {
      capturedCb = cb
      return mockRtc
    }

    const mockHub = {
      triggerFullSyncWithPeer: vi.fn().mockResolvedValue(true),
      attachPeer: vi.fn().mockResolvedValue(undefined),
      detachPeer: vi.fn().mockResolvedValue(undefined),
      getAttachedPeers: vi.fn(() => []),
      handleIncomingMessage: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined)
    }
    crdtHubHook.fn = () => mockHub

    let nowMs = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs)

    const router = {
      replace: vi.fn(async () => {}),
      currentRoute: ref({ params: { eventId: 'evt-bridge-2' }, query: { tab: 'scout' } })
    }

    const { initEventCrdt, setupWebRTC, cleanupWebRTC } = useEventWebRtcBridge({
      eventId: ref('evt-bridge-2'),
      event: ref(evt),
      router: router as any,
      t: (k: string) => k
    })

    try {
      await initEventCrdt('evt-bridge-2')
      await setupWebRTC()
      expect(mockRtc.join).toHaveBeenCalledWith('TRNS26', 'Scout', 'scout-1')

      // 1. Baseline: open host DC + connected triggers initial full sync pipeline
      capturedCb.onPeerDataChannelOpen('host')
      capturedCb.onStatusChange('connected')
      await flushPromises()

      expect(mockRtc.requestSync).toHaveBeenCalledTimes(1)
      expect(mockHub.triggerFullSyncWithPeer).toHaveBeenCalledTimes(1)
      expect(mockHub.triggerFullSyncWithPeer).toHaveBeenCalledWith('host')
      expect(crdtMod.isCrdtTransportActive('evt-bridge-2')).toBe(true)
      expect(flushPendingPitSpy).toHaveBeenCalledTimes(1)

      // 2. Transient degraded -> connected on the same still-open DC (advance Date.now by >= 5000ms past 1200ms debounce)
      nowMs += 5000
      capturedCb.onStatusChange('degraded')
      await flushPromises()
      expect(connStore.status).toBe('degraded')
      expect(crdtMod.isCrdtTransportActive('evt-bridge-2')).toBe(false)

      nowMs += 5000
      capturedCb.onStatusChange('connected')
      await flushPromises()
      expect(connStore.status).toBe('connected')
      expect(crdtMod.isCrdtTransportActive('evt-bridge-2')).toBe(true)
      expect(flushPendingPitSpy).toHaveBeenCalledTimes(2)
      expect(syncRecordsFromCrdtSpy).toHaveBeenCalledWith('evt-bridge-2')
      expect(mockRtc.requestSync).toHaveBeenCalledTimes(1)
      expect(mockHub.triggerFullSyncWithPeer).toHaveBeenCalledTimes(1)

      // 3. Transient unstable -> connected on the same still-open DC
      nowMs += 5000
      capturedCb.onStatusChange('unstable')
      await flushPromises()
      expect(connStore.status).toBe('unstable')

      nowMs += 5000
      capturedCb.onStatusChange('connected')
      await flushPromises()
      expect(connStore.status).toBe('connected')
      expect(flushPendingPitSpy).toHaveBeenCalledTimes(3)
      expect(mockRtc.requestSync).toHaveBeenCalledTimes(1)
      expect(mockHub.triggerFullSyncWithPeer).toHaveBeenCalledTimes(1)

      // 4. Real DC close + reopen control: must trigger full resync again
      nowMs += 5000
      capturedCb.onStatusChange('degraded')
      capturedCb.onPeerDataChannelClose('host')
      await flushPromises()

      nowMs += 5000
      capturedCb.onPeerDataChannelOpen('host')
      capturedCb.onStatusChange('connected')
      await flushPromises()
      expect(mockRtc.requestSync).toHaveBeenCalledTimes(2)
      expect(mockHub.triggerFullSyncWithPeer).toHaveBeenCalledTimes(2)

      // 5. Offline disconnect + reopen control: must trigger full resync again
      nowMs += 5000
      capturedCb.onStatusChange('offline')
      await flushPromises()
      expect(crdtMod.isCrdtTransportActive('evt-bridge-2')).toBe(false)

      nowMs += 5000
      capturedCb.onPeerDataChannelOpen('host')
      capturedCb.onStatusChange('connected')
      await flushPromises()
      expect(mockRtc.requestSync).toHaveBeenCalledTimes(3)
      expect(mockHub.triggerFullSyncWithPeer).toHaveBeenCalledTimes(3)
    } finally {
      nowSpy.mockRestore()
      cleanupWebRTC()
    }
  })
})
