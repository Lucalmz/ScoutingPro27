import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OfflineSyncModal from '../components/common/OfflineSyncModal.vue'
import * as api from '../services/api'
import { useCustomFieldsStore } from '../stores/customFields'
import { useEventStore } from '../stores/events'
import { usePitScoutStore } from '../stores/pitScout'
import { useRecordStore } from '../stores/records'
import { useScheduleStore } from '../stores/schedule'
import { useToastStore } from '../stores/toast'
import { useUserStore } from '../stores/user'
import * as crdt from '../services/crdt'
import * as offlineSync from '../utils/offlineSync'
import * as photoStorage from '../services/photoStorage'
import * as isMobileMod from '../composables/useIsMobile'
import type { PitScoutingRecord, ScoutingEvent, ScoutingRecord } from '../types'

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key}:${JSON.stringify(params)}` : key
    })
  }
})

vi.mock('../services/api', async () => {
  const actual = await vi.importActual<any>('../services/api')
  return {
    ...actual,
    syncRecords: vi.fn().mockResolvedValue(undefined),
    markRecordsSynced: vi.fn().mockResolvedValue(undefined),
    syncExternalEvent: vi.fn().mockImplementation((ev: ScoutingEvent) => Promise.resolve(ev))
  }
})

function makeRecord(overrides: Partial<ScoutingRecord> = {}): ScoutingRecord {
  return {
    id: 'rec-1',
    eventId: 'evt-uuid-1',
    scoutId: 'scout-1',
    scoutName: 'ScoutOne',
    matchNumber: 1,
    teamNumber: 27570,
    autoScore: 10,
    teleopScore: 20,
    endgameScore: 5,
    totalScore: 35,
    notes: '',
    rawData: '{}',
    syncStatus: 'SYNCED',
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:05:00.000Z',
    isBroken: false,
    version: 1,
    ...overrides
  }
}

describe('OfflineSyncModal.vue (CRDT-native without hostSeq)', () => {
  const wrappers: VueWrapper<any>[] = []
  const track = <T extends VueWrapper<any>>(w: T): T => {
    wrappers.push(w)
    return w
  }
  const testEvent: ScoutingEvent = {
    id: 'evt-uuid-1',
    name: 'Championship',
    inviteCode: 'CHAMP1',
    hostId: 'host-1',
    ftcEventCode: 'CNCMPLB'
  }

  beforeEach(async () => {
    setActivePinia(createPinia())
    localStorage.clear()
    await crdt.resetCrdtRegistryForTesting()
    vi.clearAllMocks()
    vi.mocked(api.syncRecords).mockResolvedValue(undefined as any)
    vi.mocked(api.markRecordsSynced).mockResolvedValue(undefined as any)
    vi.mocked(api.syncExternalEvent).mockImplementation((ev: ScoutingEvent) => Promise.resolve(ev))
  })

  afterEach(async () => {
    while (wrappers.length) wrappers.pop()!.unmount()
    await crdt.resetCrdtRegistryForTesting()
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('Host export omits fromSeq input, generates CRDT filename without _v0_to_v, and exports crdtSnapshot without hostSeq', async () => {
    vi.spyOn(photoStorage, 'isDesktopHost').mockReturnValue(true)
    vi.spyOn(isMobileMod, 'isMobileDevice').mockReturnValue(false)
    const downloadSpy = vi.spyOn(offlineSync, 'triggerFileDownload').mockImplementation(() => {})

    const userStore = useUserStore()
    const eventStore = useEventStore()
    const recordStore = useRecordStore()

    userStore.user = { id: 'host-1', username: 'HostAdmin', token: 'jwt-host' }
    eventStore.events = [testEvent]
    eventStore.currentEvent = testEvent
    recordStore.records = [
      makeRecord({ id: 'rec-1', scoutId: 'scout-1' }),
      makeRecord({ id: 'rec-2', scoutId: 'scout-2', matchNumber: 2 })
    ]

    const handle = crdt.getOrCreateEventCrdt('evt-uuid-1', {
      deviceId: 'dev-host-1',
      enableHttp: false,
      enableIndexedDb: false
    })
    crdt.writeScoutingRecordToCrdt(handle.store, recordStore.records[0]!)

    const wrapper = track(mount(OfflineSyncModal, {
      props: { visible: true, eventId: 'evt-uuid-1' }
    }))

    // No legacy hostFromSeq number input
    expect(wrapper.find('input[type="number"]').exists()).toBe(false)

    // Filename uses count-based CRDT format, never _v0_to_v
    const previewName = wrapper.find('.filename-box code').text()
    expect(previewName).toContain('_HOST_to_ALL_r2_')
    expect(previewName).not.toContain('_v0_to_v')

    // Click export button
    const exportBtn = wrapper.findAll('.btn-action.primary')[0]!
    expect((exportBtn.element as HTMLButtonElement).disabled).toBe(false)
    await exportBtn.trigger('click')

    expect(downloadSpy).toHaveBeenCalledTimes(1)
    const [fileName, rawContent] = downloadSpy.mock.calls[0]!
    expect(fileName).toContain('_HOST_to_ALL_r2_')
    const pkg = JSON.parse(rawContent)
    expect(pkg.syncRange.fromHostSeq).toBeUndefined()
    expect(pkg.syncRange.toHostSeq).toBeUndefined()
    expect(pkg.syncRange.hasCrdtSnapshot).toBe(true)
    expect(pkg.payload.crdtSnapshot).toBeDefined()
    expect(pkg.payload.records.every((r: any) => r.hostSeq === undefined)).toBe(true)
  })

  it('Client exports PENDING records without hostSeq and marks HOST_BROADCAST records SYNCED on import even without hostSeq', async () => {
    vi.spyOn(photoStorage, 'isDesktopHost').mockReturnValue(false)
    vi.spyOn(isMobileMod, 'isMobileDevice').mockReturnValue(true)
    const downloadSpy = vi.spyOn(offlineSync, 'triggerFileDownload').mockImplementation(() => {})

    const userStore = useUserStore()
    const eventStore = useEventStore()
    const recordStore = useRecordStore()

    userStore.user = { id: 'scout-1', username: 'Alice', token: 'jwt-alice' }
    eventStore.events = [testEvent]
    eventStore.currentEvent = testEvent
    recordStore.records = [
      makeRecord({ id: 'rec-pending-mine', scoutId: 'scout-1', syncStatus: 'PENDING' })
    ]

    const wrapper = track(mount(OfflineSyncModal, {
      props: { visible: true, eventId: 'evt-uuid-1' }
    }))

    // Client exports own pending records without hostSeq
    const exportBtn = wrapper.find('.btn-action.primary')
    await exportBtn.trigger('click')
    expect(downloadSpy).toHaveBeenCalledTimes(1)
    const exportedPkg = JSON.parse(downloadSpy.mock.calls[0]![1])
    expect(exportedPkg.packetType).toBe('CLIENT_PUSH')
    expect(exportedPkg.syncRange.fromHostSeq).toBeUndefined()
    expect(exportedPkg.payload.records).toHaveLength(1)
    expect(exportedPkg.payload.records[0].hostSeq).toBeUndefined()

    // Now test importing a HOST_BROADCAST .info package that has NO hostSeq
    const hostPkgJson = offlineSync.createSyncPackage({
      packetType: 'HOST_BROADCAST',
      eventId: 'evt-uuid-1',
      eventName: 'CNCMPLB',
      sender: { userId: 'host-1', username: 'HostAdmin', role: 'HOST' },
      target: { recipientType: 'ALL_SCOUTS' },
      records: [
        makeRecord({
          id: 'rec-pending-mine',
          scoutId: 'scout-1',
          syncStatus: 'SYNCED'
        })
      ]
    })

    // Switch to import tab and use real file input + Apply button in DOM
    const tabs = wrapper.findAll('.tab-btn')
    await tabs[1]!.trigger('click')
    const file = new File([hostPkgJson], 'host_broadcast.info', { type: 'application/json' })
    const fileInput = wrapper.find('input[type="file"][accept=".info,.event,.json"]')
    expect(fileInput.exists()).toBe(true)
    Object.defineProperty(fileInput.element, 'files', {
      value: [file],
      configurable: true
    })
    await fileInput.trigger('change')

    await vi.waitFor(() => {
      expect(wrapper.find('.preview-card').exists()).toBe(true)
      expect(wrapper.find('.matched-file-name').text()).toBe('host_broadcast.info')
    }, { timeout: 1000 })

    const applyBtn = wrapper.find('.apply-btn')
    expect(applyBtn.exists()).toBe(true)
    await applyBtn.trigger('click')

    await vi.waitFor(() => {
      expect(recordStore.records.find((r) => r.id === 'rec-pending-mine')?.syncStatus).toBe('SYNCED')
    }, { timeout: 1000 })
  })

  it('roundtrips real Client export (containing prior Host & teammate CRDT rows) into Host OfflineSyncModal without false-rejecting CRDT or dropping DB sync', async () => {
    const downloadSpy = vi.spyOn(offlineSync, 'triggerFileDownload').mockImplementation(() => {})
    const syncRecordsMock = vi.mocked(api.syncRecords)
    syncRecordsMock.mockClear()

    // 1. Client has prior synced Host/teammate rows + schedules/customFields AND Alice's own PENDING record + Pit edit
    vi.spyOn(photoStorage, 'isDesktopHost').mockReturnValue(false)
    vi.spyOn(isMobileMod, 'isMobileDevice').mockReturnValue(true)

    const userStore = useUserStore()
    const eventStore = useEventStore()
    const recordStore = useRecordStore()
    userStore.user = { id: 'scout-alice', username: 'Alice', token: 'jwt-alice' }
    eventStore.events = [testEvent]
    eventStore.currentEvent = testEvent

    const alicePending = makeRecord({ id: 'rec-alice-1', scoutId: 'scout-alice', scoutName: 'Alice', syncStatus: 'PENDING' })
    const bobSynced = makeRecord({ id: 'rec-bob-1', scoutId: 'scout-bob', scoutName: 'Bob', matchNumber: 3, syncStatus: 'SYNCED' })
    recordStore.records = [alicePending, bobSynced]

    const clientHandle = crdt.getOrCreateEventCrdt('evt-uuid-1', {
      deviceId: 'dev-alice-1',
      enableHttp: false,
      enableIndexedDb: false
    })
    crdt.writeScoutingRecordToCrdt(clientHandle.store, alicePending)
    crdt.writeScoutingRecordToCrdt(clientHandle.store, bobSynced)
    crdt.writeMemberIdentityToCrdt(clientHandle.store, {
      eventId: 'evt-uuid-1',
      userId: 'host-1',
      deviceId: 'dev-host-1',
      signingPubKeyHex: 'pub-host-1',
      trustedAt: 100
    })
    crdt.writeScheduleToCrdt(clientHandle.store, {
      id: 'sched-client-stale',
      eventId: 'evt-uuid-1',
      matchNumber: 9,
      tournamentLevel: 'QUALIFICATION',
      red1: 111,
      red2: 222,
      blue1: 333,
      blue2: 444
    })
    crdt.writeCustomFieldToCrdt(clientHandle.store, {
      id: 'cf-client-stale',
      eventId: 'evt-uuid-1',
      target: 'MATCH',
      phase: 'teleop',
      name: 'ClientStaleField',
      fieldKey: 'client_stale',
      fieldType: 'number',
      required: false,
      orderSeq: 1,
      isActive: true
    })
    const alicePit: PitScoutingRecord = {
      id: 'evt-uuid-1_pit_27570',
      eventId: 'evt-uuid-1',
      teamNumber: 27570,
      scoutId: 'scout-alice',
      scoutName: 'Alice',
      robotName: 'AlicePitBot',
      drivetrainType: 'swerve',
      weightLbs: 30.5,
      ballCompatibility: 'universal',
      launcherType: 'Flywheel',
      flowerMechanism: 'Lift',
      hasColorSensor: false,
      hasDescoreMech: false,
      hasApriltagVision: false,
      odometryType: 'none',
      claimedAutoStrategy: '',
      claimedAutoScore: 15,
      claimedTeleopCycles: 4,
      claimedTeleopScore: 30,
      claimedTeleopPark: false,
      claimedFlowerNectars: 0,
      claimedFlowerBottomBonus: 0,
      claimedFlowerPollens: 0,
      claimedGardenBalls: 0,
      claimedEndgameScore: 0,
      claimedTotalScore: 45,
      photoKeys: [],
      version: 1,
      isDeleted: false,
      syncStatus: 'PENDING'
    }
    crdt.writePitRecordToCrdt(clientHandle.store, alicePit)

    const clientWrapper = track(mount(OfflineSyncModal, {
      props: { visible: true, eventId: 'evt-uuid-1' }
    }))
    await clientWrapper.find('.btn-action.primary').trigger('click')
    expect(downloadSpy).toHaveBeenCalledTimes(1)
    const exportedContent = downloadSpy.mock.calls[0]![1]
    clientWrapper.unmount()

    // 2. Switch to fresh Host Pinia + live hydrateAndBindEventCrdt
    await crdt.resetCrdtRegistryForTesting()
    setActivePinia(createPinia())
    localStorage.clear()
    vi.spyOn(photoStorage, 'isDesktopHost').mockReturnValue(true)
    vi.spyOn(isMobileMod, 'isMobileDevice').mockReturnValue(false)

    const hostUserStore = useUserStore()
    const hostEventStore = useEventStore()
    const hostRecordStore = useRecordStore()
    const hostPitStore = usePitScoutStore()
    const hostScheduleStore = useScheduleStore()
    const hostCustomFieldsStore = useCustomFieldsStore()
    const hostToastStore = useToastStore()
    const toastSpy = vi.spyOn(hostToastStore, 'showToast')

    hostUserStore.user = { id: 'host-1', username: 'HostAdmin', token: 'jwt-host' }
    hostEventStore.events = [testEvent]
    hostEventStore.currentEvent = testEvent

    const hostSession = await crdt.hydrateAndBindEventCrdt({
      eventId: 'evt-uuid-1',
      deviceId: 'dev-host-1',
      enableHttp: false,
      enableIndexedDb: false,
      stores: {
        pitStore: hostPitStore,
        scheduleStore: hostScheduleStore,
        customFieldsStore: hostCustomFieldsStore,
        recordStore: hostRecordStore
      }
    })
    crdt.writeScheduleToCrdt(hostSession.handle.store, {
      id: 'sched-host-only',
      eventId: 'evt-uuid-1',
      matchNumber: 1,
      tournamentLevel: 'QUALIFICATION',
      red1: 27570,
      red2: 118,
      blue1: 254,
      blue2: 1678
    })
    hostScheduleStore.syncFromCrdt('evt-uuid-1')

    const hostWrapper = track(mount(OfflineSyncModal, {
      props: { visible: true, eventId: 'evt-uuid-1' }
    }))
    const tabs = hostWrapper.findAll('.tab-btn')
    await tabs[1]!.trigger('click')

    const infoFile = new File([exportedContent], 'alice_to_host.info', { type: 'application/json' })
    const fileInput = hostWrapper.find('input[type="file"][accept=".info,.event,.json"]')
    Object.defineProperty(fileInput.element, 'files', { value: [infoFile], configurable: true })
    await fileInput.trigger('change')

    await vi.waitFor(() => {
      expect(hostWrapper.find('.preview-card').exists()).toBe(true)
    }, { timeout: 1000 })

    await hostWrapper.find('.apply-btn').trigger('click')

    await vi.waitFor(() => {
      expect(syncRecordsMock).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: 'rec-alice-1' })])
      )
      expect(hostRecordStore.records.find((r) => r.id === 'rec-alice-1')).toBeDefined()
      expect(hostPitStore.records.find((p) => p.teamNumber === 27570)?.robotName).toBe('AlicePitBot')
    }, { timeout: 1500 })

    expect(toastSpy).toHaveBeenCalledWith('offline_sync.pill_sync_success', 'success', expect.anything())
    expect(toastSpy).not.toHaveBeenCalledWith('offline_sync.pill_sync_partial', expect.anything(), expect.anything())
    // Host schedules & customFields remain untouched by Client package
    expect(hostScheduleStore.schedules.map((s) => s.matchNumber)).toEqual([1])
    expect(hostCustomFieldsStore.getFields('evt-uuid-1')).toEqual([])

    hostWrapper.unmount()
    hostSession.unbind()
  })

  it('exports tombstones with incremented version for both Host and Client', async () => {
    const recordStore = useRecordStore()
    const userStore = useUserStore()
    const eventStore = useEventStore()

    eventStore.events = [testEvent]
    eventStore.currentEvent = testEvent

    recordStore.records.push(
      makeRecord({ id: 'rec-active-1', matchNumber: 1, teamNumber: 27570, totalScore: 100, version: 1, isDeleted: false, syncStatus: 'SYNCED' }),
      makeRecord({ id: 'rec-tombstone-1', matchNumber: 2, teamNumber: 12345, totalScore: 80, version: 2, isDeleted: true, syncStatus: 'PENDING' })
    )

    const downloadSpy = vi.spyOn(offlineSync, 'triggerFileDownload').mockImplementation(() => {})

    vi.spyOn(photoStorage, 'isDesktopHost').mockReturnValue(true)
    vi.spyOn(isMobileMod, 'isMobileDevice').mockReturnValue(false)
    userStore.user = { id: 'host-1', username: 'HostOne', token: 'tok' }

    const hostWrapper = track(mount(OfflineSyncModal, {
      props: { visible: true, eventId: testEvent.id }
    }))
    try {
      await hostWrapper.findAll('.btn-action.primary')[0]!.trigger('click')
      expect(downloadSpy).toHaveBeenCalledTimes(1)
      const hostPkg = JSON.parse(downloadSpy.mock.calls[0]![1])
      expect(hostPkg.packetType).toBe('HOST_BROADCAST')
      expect(hostPkg.payload.records).toHaveLength(2)
      expect(hostPkg.payload.records.find((r: any) => r.id === 'rec-tombstone-1')?.isDeleted).toBe(true)
    } finally {
      hostWrapper.unmount()
    }

    downloadSpy.mockClear()
    vi.spyOn(photoStorage, 'isDesktopHost').mockReturnValue(false)
    vi.spyOn(isMobileMod, 'isMobileDevice').mockReturnValue(true)
    userStore.user = { id: 'scout-1', username: 'ScoutOne', token: 'tok' }

    const clientWrapper = track(mount(OfflineSyncModal, {
      props: { visible: true, eventId: testEvent.id }
    }))
    try {
      await clientWrapper.find('.btn-action.primary').trigger('click')
      expect(downloadSpy).toHaveBeenCalledTimes(1)
      const clientPkg = JSON.parse(downloadSpy.mock.calls[0]![1])
      expect(clientPkg.packetType).toBe('CLIENT_PUSH')
      expect(clientPkg.payload.records).toHaveLength(1)
      expect(clientPkg.payload.records[0].id).toBe('rec-tombstone-1')
      expect(clientPkg.payload.records[0].isDeleted).toBe(true)
      expect(clientPkg.payload.records[0].version).toBe(2)
    } finally {
      clientWrapper.unmount()
    }
  })
})
