import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMergeableStore, getHlcFunctions } from 'tinybase'
import {
  CalibratedMonotonicClock,
  resetClockRegistryForTesting
} from '@/services/clock'
import {
  CRDT_MAX_FRAME_BYTES,
  CRDT_TABLES,
  createCrdtPersistenceController,
  createWebRtcCrdtSynchronizerHub,
  encodeCrdtSyncFrames,
  getActivePhotoKeysForTeam,
  getExistingEventCrdt,
  getOrCreateEventCrdt,
  isCrdtTransportActive,
  measureUtf8Bytes,
  migrateEventCrdtId,
  readCustomFieldsFromCrdt,
  readPitRecordsFromCrdt,
  readTeamTagsFromCrdt,
  resetCrdtRegistryForTesting,
  scanMergeableContent,
  scanSyncMessageBody,
  setCrdtTransportActive,
  setPitPhotoKeyActive,
  setTeamTagActive,
  writeCustomFieldToCrdt,
  writePitRecordToCrdt,
  writeTeamTagToCrdt,
  type CrdtHttpTransport
} from '@/services/crdt'
import { clearBeforeLogoutHooksForTesting, useUserStore } from '@/stores/user'
import '@/stores/connection'
import '@/stores/records'
import '@/stores/events'
import '@/stores/inbox'
import '@/stores/pitScout'
import '@/stores/schedule'
import type { PitScoutingRecord, TeamTagItem, WebRtcCrdtSyncChunk, WebRtcCrdtSyncMsg } from '@/types'

const TEN_YEARS_MS = 10 * 365 * 24 * 3600 * 1000

function makePitRecord(overrides: Partial<PitScoutingRecord> = {}): PitScoutingRecord {
  return {
    id: 'evt-1_pit_27570',
    eventId: 'evt-1',
    teamNumber: 27570,
    scoutId: 'scout-1',
    scoutName: 'Alice',
    robotName: 'Polaris',
    drivetrainType: 'swerve',
    weightLbs: 28,
    chassisSize: '16"',
    ballCompatibility: 'universal',
    launcherType: 'Flywheel',
    flowerMechanism: 'Elevator',
    hasColorSensor: true,
    hasDescoreMech: false,
    hasApriltagVision: true,
    odometryType: 'pinpoint',
    claimedAutoStrategy: '2-ball close',
    claimedAutoScore: 30,
    claimedTeleopCycles: 8,
    claimedTeleopScore: 80,
    claimedTeleopPark: true,
    claimedFlowerNectars: 2,
    claimedFlowerBottomBonus: 1,
    claimedFlowerPollens: 2,
    claimedGardenBalls: 3,
    claimedEndgameScore: 20,
    claimedTotalScore: 130,
    photoKeys: [],
    version: 1,
    isDeleted: false,
    ...overrides
  }
}

function makeTag(overrides: Partial<TeamTagItem> = {}): TeamTagItem {
  return {
    id: 'evt-1_tag_27570_fast_cycle',
    eventId: 'evt-1',
    teamNumber: 27570,
    tag: 'fast_cycle',
    color: 'blue',
    isPreset: false,
    createdBy: 'Alice',
    ...overrides
  }
}

describe('CRDT Field-Level Merge, Star Sync, Chunking, HLC Guard & Persistence', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    clearBeforeLogoutHooksForTesting()
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    await resetCrdtRegistryForTesting()
    resetClockRegistryForTesting()
    clearBeforeLogoutHooksForTesting()
    localStorage.clear()
  })

  it('merges concurrent Pit edits on distinct fields without overwriting sibling fields via diff-on-write', () => {
    let clockMs = 1_700_000_000_000
    const storeA = createMergeableStore('device-a', () => clockMs, 300)
    const storeB = createMergeableStore('device-b', () => clockMs, 300)

    const baseline = makePitRecord({ weightLbs: 28, launcherType: 'Flywheel' })
    writePitRecordToCrdt(storeA, baseline)
    storeB.merge(storeA)

    // Device A edits weightLbs while offline; Device B edits sibling launcherType
    clockMs += 1_000
    writePitRecordToCrdt(storeA, makePitRecord({ weightLbs: 31.5, launcherType: 'Flywheel' }))
    writePitRecordToCrdt(storeB, makePitRecord({ weightLbs: 28, launcherType: 'Turret' }))

    storeA.merge(storeB)
    storeB.merge(storeA)

    const mergedA = readPitRecordsFromCrdt(storeA, 'evt-1')[0]!
    const mergedB = readPitRecordsFromCrdt(storeB, 'evt-1')[0]!
    expect(mergedA.weightLbs).toBe(31.5)
    expect(mergedA.launcherType).toBe('Turret')
    expect(mergedB.weightLbs).toBe(31.5)
    expect(mergedB.launcherType).toBe('Turret')
  })

  it('enforces LWW-Element-Set soft-delete tombstones against stale snapshot resurrection for pit_photo_keys & team_tags', () => {
    let clockMs = 1_700_000_000_000
    const storeLive = createMergeableStore('device-live', () => clockMs, 300)
    const stalePeer = createMergeableStore('device-stale', () => clockMs, 300)

    // Both nodes start with an active photo key and an active tag
    setPitPhotoKeyActive(storeLive, 27570, 'photo-front.jpg', true, 'scout-1')
    writeTeamTagToCrdt(storeLive, makeTag({ tag: 'Shooter' }), true)
    stalePeer.setMergeableContent(storeLive.getMergeableContent())

    expect(getActivePhotoKeysForTeam(stalePeer, 27570)).toEqual(['photo-front.jpg'])
    expect(readTeamTagsFromCrdt(stalePeer, 'evt-1').map((t) => t.tag)).toEqual(['shooter'])

    // Later, device-live writes active: false tombstones (never calling delRow)
    clockMs += 2_000
    setPitPhotoKeyActive(storeLive, 27570, 'photo-front.jpg', false, 'scout-1')
    setTeamTagActive(storeLive, 'evt-1', makeTag({ tag: 'Shooter' }), false)

    // Re-merge stale snapshot that still carries active: true
    storeLive.merge(stalePeer)
    stalePeer.merge(storeLive)

    expect(getActivePhotoKeysForTeam(storeLive, 27570)).toEqual([])
    expect(getActivePhotoKeysForTeam(stalePeer, 27570)).toEqual([])
    expect(readTeamTagsFromCrdt(storeLive, 'evt-1')).toEqual([])
    expect(readTeamTagsFromCrdt(stalePeer, 'evt-1')).toEqual([])

    // Verify underlying rows remain present as boolean tombstones (never delRow)
    expect(storeLive.getCell(CRDT_TABLES.PIT_PHOTO_KEYS, '27570::photo-front.jpg', 'active')).toBe(false)
    expect(storeLive.getCell(CRDT_TABLES.TEAM_TAGS, '27570::shooter', 'active')).toBe(false)
  })

  it('converges 3-node star topology (Client1 <-> Host <-> Client2) without infinite echo loops', async () => {
    let clockMs = 1_700_000_100_000
    const client1Store = createMergeableStore('c1', () => clockMs, 300)
    const hostStore = createMergeableStore('host', () => clockMs, 300)
    const client2Store = createMergeableStore('c2', () => clockMs, 300)

    // Offline writes prior to connecting
    writePitRecordToCrdt(client1Store, makePitRecord({ teamNumber: 1111, weightLbs: 29.5 }))
    writeTeamTagToCrdt(client2Store, makeTag({ teamNumber: 2222, tag: 'defense' }), true)

    let totalFramesDispatched = 0
    const hubs: Record<string, ReturnType<typeof createWebRtcCrdtSynchronizerHub>> = {}

    const routeFrame = (
      fromNode: string,
      targetNode: string,
      msg: WebRtcCrdtSyncMsg | WebRtcCrdtSyncChunk
    ) => {
      totalFramesDispatched++
      const cloned = JSON.parse(JSON.stringify(msg)) as WebRtcCrdtSyncMsg | WebRtcCrdtSyncChunk
      queueMicrotask(() => {
        hubs[targetNode]?.handleIncomingMessage(fromNode, cloned)
      })
    }

    hubs.host = createWebRtcCrdtSynchronizerHub({
      eventId: 'evt-1',
      store: hostStore,
      clientId: 'host',
      getNowMs: () => clockMs,
      sendToPeer: (peerId, msg) => routeFrame('host', peerId, msg)
    })
    hubs.client1 = createWebRtcCrdtSynchronizerHub({
      eventId: 'evt-1',
      store: client1Store,
      clientId: 'c1',
      getNowMs: () => clockMs,
      sendToPeer: (_peerId, msg) => routeFrame('client1', 'host', msg)
    })
    hubs.client2 = createWebRtcCrdtSynchronizerHub({
      eventId: 'evt-1',
      store: client2Store,
      clientId: 'c2',
      getNowMs: () => clockMs,
      sendToPeer: (_peerId, msg) => routeFrame('client2', 'host', msg)
    })

    await Promise.all([
      hubs.host.attachPeer('client1'),
      hubs.client1.attachPeer('host'),
      hubs.host.attachPeer('client2'),
      hubs.client2.attachPeer('host')
    ])

    await vi.waitFor(() => {
      expect(readPitRecordsFromCrdt(client2Store, 'evt-1')[0]?.weightLbs).toBe(29.5)
      expect(readTeamTagsFromCrdt(client1Store, 'evt-1').map((t) => t.tag)).toEqual(['defense'])
    })

    // Live incremental update on Client1 fans out through Host to Client2 with bounded frames
    const framesBeforeLiveEdit = totalFramesDispatched
    clockMs += 1_000
    writePitRecordToCrdt(client1Store, makePitRecord({ teamNumber: 1111, weightLbs: 32.0 }))
    await vi.waitFor(() => {
      expect(readPitRecordsFromCrdt(hostStore, 'evt-1')[0]?.weightLbs).toBe(32.0)
      expect(readPitRecordsFromCrdt(client2Store, 'evt-1')[0]?.weightLbs).toBe(32.0)
    })
    const framesDuringLiveEdit = totalFramesDispatched - framesBeforeLiveEdit
    // Verify strictly bounded delta fanout (must not ping-pong/echo indefinitely)
    expect(framesDuringLiveEdit).toBeGreaterThanOrEqual(2)
    expect(framesDuringLiveEdit).toBeLessThanOrEqual(12)

    await Promise.all([hubs.client1.destroy(), hubs.client2.destroy(), hubs.host.destroy()])
  })

  it('splits >100 KiB CRDT payloads into <= 48 KiB CRDT_SYNC_CHUNK frames and reassembles across Hub', async () => {
    const clockMs = 1_700_000_200_000
    const senderStore = createMergeableStore('chunk-sender', () => clockMs, 300)
    const receiverStore = createMergeableStore('chunk-receiver', () => clockMs, 300)

    const largeNotes = 'A'.repeat(110_000)
    writePitRecordToCrdt(
      senderStore,
      makePitRecord({
        teamNumber: 27570,
        claimedAutoStrategy: largeNotes
      })
    )

    const fullMsg: WebRtcCrdtSyncMsg = {
      type: 'CRDT_SYNC_MSG',
      eventId: 'evt-1',
      fromClientId: 'chunk-sender',
      toClientId: 'chunk-receiver',
      requestId: null,
      message: 3,
      body: senderStore.getMergeableContent()
    }

    const frames = encodeCrdtSyncFrames(fullMsg)
    expect(frames.length).toBeGreaterThanOrEqual(3)
    for (const frame of frames) {
      expect(frame.type).toBe('CRDT_SYNC_CHUNK')
      expect(measureUtf8Bytes(JSON.stringify(frame))).toBeLessThanOrEqual(CRDT_MAX_FRAME_BYTES)
    }

    const dispatchedChunkCount: number[] = []
    let senderHub!: ReturnType<typeof createWebRtcCrdtSynchronizerHub>
    let receiverHub!: ReturnType<typeof createWebRtcCrdtSynchronizerHub>

    senderHub = createWebRtcCrdtSynchronizerHub({
      eventId: 'evt-1',
      store: senderStore,
      clientId: 'chunk-sender',
      getNowMs: () => clockMs,
      sendToPeer: (_peerId, frame) => {
        if (frame.type === 'CRDT_SYNC_CHUNK') {
          dispatchedChunkCount.push(measureUtf8Bytes(JSON.stringify(frame)))
        }
        queueMicrotask(() => receiverHub.handleIncomingMessage('chunk-sender', frame))
      }
    })
    receiverHub = createWebRtcCrdtSynchronizerHub({
      eventId: 'evt-1',
      store: receiverStore,
      clientId: 'chunk-receiver',
      getNowMs: () => clockMs,
      sendToPeer: (_peerId, frame) => {
        queueMicrotask(() => senderHub.handleIncomingMessage('chunk-receiver', frame))
      }
    })

    await Promise.all([senderHub.attachPeer('chunk-receiver'), receiverHub.attachPeer('chunk-sender')])
    await vi.waitFor(() => {
      const received = readPitRecordsFromCrdt(receiverStore, 'evt-1')[0]
      expect(received?.claimedAutoStrategy).toBe(largeNotes)
    })

    expect(dispatchedChunkCount.length).toBeGreaterThanOrEqual(3)
    for (const bytes of dispatchedChunkCount) {
      expect(bytes).toBeLessThanOrEqual(CRDT_MAX_FRAME_BYTES)
    }

    await Promise.all([senderHub.destroy(), receiverHub.destroy()])
  })

  it('triggers pre-merge decodeHlc skew alarm on 2036 HLC without false positives on 16-char cell strings', async () => {
    const baseNow = 1_700_000_300_000
    let rogueNow = baseNow
    const hostStore = createMergeableStore('host', () => baseNow, 300)
    const rogueStore = createMergeableStore('rogue', () => rogueNow, 300)

    // Benign 16-char base64-alphabet string in a user cell must NOT trigger skew alert
    writePitRecordToCrdt(
      rogueStore,
      makePitRecord({
        teamNumber: 27570,
        robotName: 'zzzzzzzzzzzzzzzz'
      })
    )
    const benignScan = scanMergeableContent(rogueStore.getMergeableContent(), baseNow)
    expect(benignScan.hasFutureSkew).toBe(false)
    expect(benignScan.scannedStamps).toBeGreaterThan(0)

    const skewAlerts: number[] = []
    let hostHub!: ReturnType<typeof createWebRtcCrdtSynchronizerHub>
    let rogueHub!: ReturnType<typeof createWebRtcCrdtSynchronizerHub>

    hostHub = createWebRtcCrdtSynchronizerHub({
      eventId: 'evt-1',
      store: hostStore,
      clientId: 'host',
      getNowMs: () => baseNow,
      sendToPeer: (_peerId, frame) => {
        queueMicrotask(() => rogueHub.handleIncomingMessage('host', frame))
      },
      onFutureClockSkew: (_peerId, scan) => {
        skewAlerts.push(scan.maxSkewMs)
      }
    })
    rogueHub = createWebRtcCrdtSynchronizerHub({
      eventId: 'evt-1',
      store: rogueStore,
      clientId: 'rogue',
      getNowMs: () => baseNow,
      sendToPeer: (_peerId, frame) => {
        queueMicrotask(() => hostHub.handleIncomingMessage('rogue', frame))
      }
    })

    await Promise.all([hostHub.attachPeer('rogue'), rogueHub.attachPeer('host')])
    await vi.waitFor(() => {
      expect(readPitRecordsFromCrdt(hostStore, 'evt-1')[0]?.robotName).toBe('zzzzzzzzzzzzzzzz')
    })

    // Valid benign record synced cleanly with zero skew alerts
    expect(skewAlerts).toEqual([])

    // Now rogue jumps its system clock +10 years (2036) and edits launcherType
    rogueNow = baseNow + TEN_YEARS_MS
    rogueStore.setCell(CRDT_TABLES.PIT_RECORDS, '27570', 'launcherType', 'Poisoned2036')
    await vi.waitFor(() => {
      expect(skewAlerts.length).toBeGreaterThanOrEqual(1)
    })

    // Pre-merge guard caught the 2036 HLC and fired alert; TinyBase maxClockSkewSeconds=300 dropped the cell
    expect(skewAlerts[0]).toBeGreaterThan(TEN_YEARS_MS - 60_000)
    expect(hostStore.getCell(CRDT_TABLES.PIT_RECORDS, '27570', 'launcherType')).toBe('Flywheel')

    // Confirm host's subsequent HLC write stays clean near baseNow
    hostStore.setCell(CRDT_TABLES.PIT_RECORDS, '27570', 'chassisSize', '17"')
    const [, , , decodeHlc] = getHlcFunctions()
    const content = hostStore.getMergeableContent()
    const postWriteStamp = content[0][0].pit_records?.[0]?.['27570']?.[0]?.chassisSize?.[1]
    expect(postWriteStamp).toBeDefined()
    const [logicalTime] = decodeHlc(postWriteStamp!)
    expect(logicalTime).toBeLessThanOrEqual(baseNow + 10_000)

    // Direct scanSyncMessageBody sanity check for MSG_RESPONSE diff shape
    const msg3Scan = scanSyncMessageBody(3, [rogueStore.getMergeableContent()[0], rogueStore.getMergeableContent()[1]], baseNow)
    expect(msg3Scan.hasFutureSkew).toBe(true)

    await Promise.all([hostHub.destroy(), rogueHub.destroy()])
  })

  it('coalesces rapid edits via 1500ms debounce / 5000ms maxWait and handles retry & 409 revision sync', async () => {
    vi.useFakeTimers()
    try {
      let nowMs = 1_700_000_400_000
      const clock = new CalibratedMonotonicClock('evt-persist', {
        wallNow: () => nowMs,
        monoNow: () => nowMs,
        storage: localStorage
      })
      const store = createMergeableStore('persist-dev', () => clock.now(), 300)

      let failNextSave = false
      let returnStaleNextSave = false
      const saveCalls: Array<{
        hostEpoch: number
        snapshotRevision: number
        dirtyRows: Record<string, string[]>
      }> = []

      const transport: CrdtHttpTransport = {
        loadState: vi.fn(async () => ({
          exists: false,
          eventId: 'evt-persist',
          hostEpoch: 2,
          snapshotRevision: 5,
          snapshot: null
        })),
        saveState: vi.fn(async (_eventId, payload) => {
          saveCalls.push({
            hostEpoch: payload.hostEpoch,
            snapshotRevision: payload.snapshotRevision,
            dirtyRows: payload.dirtyRows
          })
          if (failNextSave) {
            throw new Error('ECONNRESET')
          }
          if (returnStaleNextSave) {
            returnStaleNextSave = false
            return {
              saved: false,
              stale: true,
              eventId: 'evt-persist',
              hostEpoch: 2,
              snapshotRevision: 12
            }
          }
          return {
            saved: true,
            eventId: 'evt-persist',
            hostEpoch: 2,
            snapshotRevision: payload.snapshotRevision
          }
        })
      }

      const ctrl = createCrdtPersistenceController({
        eventId: 'evt-persist',
        store,
        clock,
        getHostEpoch: () => 2,
        debounceMs: 1500,
        maxWaitMs: 5000,
        transport,
        enableHttp: true,
        enableIndexedDb: false
      })

      // 1. Hydrate picks up server revision=5
      const hydrated = await ctrl.hydrateFromH2()
      expect(hydrated.snapshotRevision).toBe(5)
      expect(ctrl.getSnapshotRevision()).toBe(5)

      // 2. Rapid burst of edits across 3 timestamps spaced < 1500ms -> should coalesce into 1 PUT at 1500ms
      writePitRecordToCrdt(store, makePitRecord({ eventId: 'evt-persist', teamNumber: 101 }))
      await vi.advanceTimersByTimeAsync(700)
      writePitRecordToCrdt(store, makePitRecord({ eventId: 'evt-persist', teamNumber: 202 }))
      await vi.advanceTimersByTimeAsync(700)
      writeTeamTagToCrdt(store, makeTag({ eventId: 'evt-persist', teamNumber: 101, tag: 'fast' }), true)
      expect(saveCalls).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(1500)
      expect(saveCalls).toHaveLength(1)
      expect(saveCalls[0]?.snapshotRevision).toBe(6)
      expect(saveCalls[0]?.hostEpoch).toBe(2)
      expect(saveCalls[0]?.dirtyRows[CRDT_TABLES.PIT_RECORDS]?.sort()).toEqual(['101', '202'])
      expect(saveCalls[0]?.dirtyRows[CRDT_TABLES.TEAM_TAGS]).toEqual(['101::fast'])

      // 3. Continuous high-frequency writes every 1000ms hit maxWait=5000ms
      writePitRecordToCrdt(store, makePitRecord({ eventId: 'evt-persist', teamNumber: 303, weightLbs: 1 }))
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(1000)
        writePitRecordToCrdt(store, makePitRecord({ eventId: 'evt-persist', teamNumber: 303, weightLbs: i + 2 }))
      }
      expect(saveCalls).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1000) // Reaches 5000ms maxWait
      expect(saveCalls).toHaveLength(2)
      expect(saveCalls[1]?.dirtyRows[CRDT_TABLES.PIT_RECORDS]).toEqual(['303'])

      // 4. HTTP error retains dirtyRows for subsequent retry
      failNextSave = true
      writePitRecordToCrdt(store, makePitRecord({ eventId: 'evt-persist', teamNumber: 404 }))
      await ctrl.flushNow()
      expect(ctrl.getPendingDirtyRows()[CRDT_TABLES.PIT_RECORDS]).toEqual(['404'])

      // 5. HTTP 409 stale response updates snapshotRevision to 12 and preserves dirtyRows
      failNextSave = false
      returnStaleNextSave = true
      await ctrl.flushNow()
      expect(ctrl.getSnapshotRevision()).toBe(12)
      expect(ctrl.getPendingDirtyRows()[CRDT_TABLES.PIT_RECORDS]).toEqual(['404'])

      // Subsequent flush succeeds using rev=13
      const okRes = await ctrl.flushNow()
      expect(okRes?.saved).toBe(true)
      expect(okRes?.snapshotRevision).toBe(13)
      expect(ctrl.getPendingDirtyRows()).toEqual({})

      await ctrl.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rewrites placeholder eventId cells in migrateEventCrdtId and flushes/disposes on userStore.logout()', async () => {
    const saveCalls: string[] = []
    const transport: CrdtHttpTransport = {
      loadState: vi.fn(async () => null),
      saveState: vi.fn(async (eventId) => {
        saveCalls.push(eventId)
        return {
          saved: true,
          eventId,
          hostEpoch: 1,
          snapshotRevision: 1
        }
      })
    }

    const userStore = useUserStore()
    userStore.user = { id: 'alice', username: 'LeadAlice', token: 'jwt-valid' }
    localStorage.setItem('scoutingpro-user', JSON.stringify(userStore.user))

    const placeholderHandle = getOrCreateEventCrdt('evt-27570', {
      inviteCode: '27570',
      deviceId: 'dev-b',
      transport,
      enableHttp: true,
      enableIndexedDb: false
    })
    writePitRecordToCrdt(placeholderHandle.store, makePitRecord({ eventId: 'evt-27570', teamNumber: 27570 }))
    writeTeamTagToCrdt(placeholderHandle.store, makeTag({ eventId: 'evt-27570', teamNumber: 27570, tag: 'clean' }), true)
    setCrdtTransportActive('evt-27570', true)

    const promotedHandle = await migrateEventCrdtId('evt-27570', 'uuid-real-event', {
      transport,
      enableHttp: true,
      enableIndexedDb: false
    })

    expect(getExistingEventCrdt('evt-27570')).toBeUndefined()
    expect(isCrdtTransportActive('evt-27570')).toBe(false)
    expect(isCrdtTransportActive('uuid-real-event')).toBe(true)

    // Promoted eventId cells allow authoritative filtering immediately
    const migratedPits = readPitRecordsFromCrdt(promotedHandle.store, 'uuid-real-event')
    const migratedTags = readTeamTagsFromCrdt(promotedHandle.store, 'uuid-real-event')
    expect(migratedPits).toHaveLength(1)
    expect(migratedPits[0]?.eventId).toBe('uuid-real-event')
    expect(migratedTags).toHaveLength(1)
    expect(migratedTags[0]?.eventId).toBe('uuid-real-event')

    // userStore.logout() invokes lazy beforeLogout hook while JWT is valid, then clears handle & transport
    await userStore.logout()
    expect(saveCalls).toContain('uuid-real-event')
    expect(getExistingEventCrdt('uuid-real-event')).toBeUndefined()
    expect(isCrdtTransportActive('uuid-real-event')).toBe(false)
  }, 20000)

  it('round-trips new custom field formula/config columns in CRDT and falls back safely on legacy rows', async () => {
    const handle = getOrCreateEventCrdt('evt-cf-v2', {
      inviteCode: 'CFV2',
      deviceId: 'dev-cf',
      enableHttp: false,
      enableIndexedDb: false
    })

    writeCustomFieldToCrdt(handle.store, {
      id: 'cf-v2-1',
      eventId: 'evt-cf-v2',
      target: 'TEAM',
      phase: 'overall',
      name: 'Power Index',
      fieldKey: 'power_index',
      fieldType: 'formula',
      required: false,
      description: 'Weighted OPR score',
      configJson: JSON.stringify({ decimalPlaces: 1 }),
      formulaExpr: 'ROUND(opr.np * 0.8, 1)',
      aggregationMode: 'avg',
      displayFormat: 'number',
      dependenciesJson: JSON.stringify(['opr.np']),
      orderSeq: 1,
      isActive: true
    })

    // Simulate legacy CRDT row missing the 6 new columns
    handle.store.setRow(CRDT_TABLES.CUSTOM_FIELDS, 'cf-legacy-1', {
      id: 'cf-legacy-1',
      eventId: 'evt-cf-v2',
      target: 'MATCH',
      phase: 'auto',
      name: 'Legacy Bool',
      fieldKey: 'legacy_bool',
      fieldType: 'boolean',
      required: false,
      orderSeq: 2,
      isActive: true,
      isDeleted: false
    })

    const fields = readCustomFieldsFromCrdt(handle.store, 'evt-cf-v2')
    const v2 = fields.find((f) => f.id === 'cf-v2-1')!
    const legacy = fields.find((f) => f.id === 'cf-legacy-1')!

    expect(v2.target).toBe('TEAM')
    expect(v2.fieldType).toBe('formula')
    expect(v2.description).toBe('Weighted OPR score')
    expect(v2.config?.decimalPlaces).toBe(1)
    expect(v2.formulaExpr).toBe('ROUND(opr.np * 0.8, 1)')
    expect(v2.dependenciesJson).toBe(JSON.stringify(['opr.np']))

    expect(legacy.aggregationMode).toBe('avg')
    expect(legacy.displayFormat).toBe('number')
    expect(legacy.description).toBeNull()
    expect(legacy.formulaExpr).toBeNull()
    expect(legacy.config).toBeUndefined()

    await handle.destroy()
  })

  it('recomputes BIOBUZZ structured endgame and componentSum total after concurrent Pit cell merges and dispatches auth-unauthorized on 401', async () => {
    let clockMs = 1_700_000_900_000
    const peerA = createMergeableStore('pit-peer-a', () => clockMs, 300)
    const peerB = createMergeableStore('pit-peer-b', () => clockMs, 300)

    const basePit = makePitRecord({
      eventId: 'evt-pit-norm',
      teamNumber: 27570,
      weightLbs: 30,
      claimedAutoScore: 10,
      claimedTeleopScore: 20,
      claimedTeleopPark: false,
      claimedFlowerNectars: 0,
      claimedFlowerBottomBonus: 0,
      claimedFlowerPollens: 0,
      claimedGardenBalls: 0,
      claimedEndgameScore: 0,
      claimedTotalScore: 30
    })
    writePitRecordToCrdt(peerA, basePit)
    peerB.merge(peerA)

    // Peer A offline-edits claimedAutoScore: 10 -> 28 (Peer A's local total becomes 48)
    clockMs += 1_000
    writePitRecordToCrdt(peerA, {
      ...basePit,
      claimedAutoScore: 28,
      claimedTotalScore: 48
    })

    // Peer B concurrently offline-edits endgame structure (with out-of-range bottomBonus=4 > nectars=2)
    clockMs += 1_000
    peerB.setCell(CRDT_TABLES.PIT_RECORDS, '27570', 'claimedTeleopPark', true)
    peerB.setCell(CRDT_TABLES.PIT_RECORDS, '27570', 'claimedFlowerNectars', 2)
    peerB.setCell(CRDT_TABLES.PIT_RECORDS, '27570', 'claimedFlowerBottomBonus', 4)
    peerB.setCell(CRDT_TABLES.PIT_RECORDS, '27570', 'claimedTotalScore', 49)
    peerB.setCell(CRDT_TABLES.PIT_RECORDS, '27570', 'weightLbs', -5)

    peerA.merge(peerB)
    const merged = readPitRecordsFromCrdt(peerA, 'evt-pit-norm')[0]!
    expect(merged.weightLbs).toBe(0)
    expect(merged.claimedAutoScore).toBe(28)
    expect(merged.claimedTeleopScore).toBe(20)
    expect(merged.claimedFlowerNectars).toBe(2)
    expect(merged.claimedFlowerBottomBonus).toBe(2)
    // 5 (park) + 2*2 (nectars) + 2*5 (bottomBonus) = 19
    expect(merged.claimedEndgameScore).toBe(19)
    // 28 + 20 + 19 = 67 (> stale 49)
    expect(merged.claimedTotalScore).toBe(67)

    // Verify crdtApi 401 handling clears scoutingpro-user and dispatches auth-unauthorized (unlike 500)
    const { fetchCrdtState, saveCrdtState } = await import('@/services/crdt/crdtApi')
    localStorage.setItem('scoutingpro-user', JSON.stringify({ id: 'u1', username: 'Scout', token: 'expired-jwt' }))
    let authEvents = 0
    const onUnauth = () => {
      authEvents += 1
    }
    window.addEventListener('auth-unauthorized', onUnauth)
    const origFetch = globalThis.fetch
    try {
      globalThis.fetch = vi.fn(async () => new Response('Server error', { status: 500 })) as any
      await expect(fetchCrdtState('evt-pit-norm')).rejects.toThrow('500')
      // Positive control: 500 does NOT log user out
      expect(localStorage.getItem('scoutingpro-user')).not.toBeNull()
      expect(authEvents).toBe(0)

      globalThis.fetch = vi.fn(async () => new Response('Invalid or expired token', { status: 401 })) as any
      await expect(fetchCrdtState('evt-pit-norm')).rejects.toThrow('401')
      expect(localStorage.getItem('scoutingpro-user')).toBeNull()
      expect(authEvents).toBe(1)

      localStorage.setItem('scoutingpro-user', JSON.stringify({ id: 'u1', username: 'Scout', token: 'expired-jwt-2' }))
      await expect(
        saveCrdtState('evt-pit-norm', {
          hostEpoch: 1,
          snapshotRevision: 1,
          snapshot: peerA.getMergeableContent(),
          dirtyRows: {}
        })
      ).rejects.toThrow()
      expect(localStorage.getItem('scoutingpro-user')).toBeNull()
      expect(authEvents).toBe(2)
    } finally {
      globalThis.fetch = origFetch
      window.removeEventListener('auth-unauthorized', onUnauth)
    }
  })
})
