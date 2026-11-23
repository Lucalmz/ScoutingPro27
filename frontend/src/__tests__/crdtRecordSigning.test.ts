import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { resetClockRegistryForTesting, CalibratedMonotonicClock } from '@/services/clock'
import {
  buildMemberIdentityCanonicalPayload,
  buildRecordCanonicalPayload,
  countersignPendingMemberIdentities,
  createWebRtcCrdtSynchronizerHub,
  hydrateAndBindEventCrdt,
  readMemberIdentitiesFromCrdt,
  readScoutingRecordsFromCrdt,
  registerLocalMemberIdentity,
  resetCrdtRegistryForTesting,
  sanitizeIncomingCrdtSyncBody,
  signScoutingRecordWithDeviceKey,
  verifyScoutingRecordSignature,
  writeMemberIdentityToCrdt,
  writeScoutingRecordToCrdt,
  type CrdtHttpTransport,
  type WebRtcCrdtSynchronizerHub
} from '@/services/crdt'
import { createStandaloneCrdtStore } from '@/services/crdt/webrtcCrdtSynchronizer'
import { useCustomFieldsStore } from '@/stores/customFields'
import { useEventStore } from '@/stores/events'
import { usePitScoutStore } from '@/stores/pitScout'
import { useRecordStore } from '@/stores/records'
import { useScheduleStore } from '@/stores/schedule'
import { clearBeforeLogoutHooksForTesting, useUserStore } from '@/stores/user'
import {
  exportEcdhPublicKey,
  exportEcdsaPublicKey,
  generateEcdhKeyPair,
  generateEcdsaKeyPair,
  signDataEcdsa,
  verifyDataEcdsa
} from '@/utils/crypto'
import * as identityStore from '@/utils/identityStore'
import type { DeviceIdentity } from '@/utils/identityStore'
import type { ScoutingRecord, WebRtcCrdtSyncChunk, WebRtcCrdtSyncMsg } from '@/types'

vi.mock('@/services/api', async () => {
  const actual = await vi.importActual<typeof import('@/services/api')>('@/services/api')
  return {
    ...actual,
    listRecords: vi.fn().mockResolvedValue([]),
    saveRecord: vi.fn().mockResolvedValue(undefined),
    syncRecords: vi.fn().mockResolvedValue(undefined),
    markRecordsSynced: vi.fn().mockResolvedValue(undefined),
    isStaticCloudHost: vi.fn(() => false),
    savePitRecord: vi.fn().mockResolvedValue({ success: true }),
    syncPitRecordsBatch: vi.fn().mockResolvedValue({ success: true }),
    saveScheduleBatch: vi.fn().mockResolvedValue({ count: 0 }),
    saveScoutAssignments: vi.fn().mockResolvedValue({ count: 0 }),
    clearEventSchedule: vi.fn().mockResolvedValue({ success: true }),
    addTeamTag: vi.fn(),
    deleteTeamTag: vi.fn(),
    createCustomField: vi.fn(),
    updateCustomField: vi.fn(),
    deleteCustomField: vi.fn()
  }
})

async function makeVirtualIdentity(deviceId: string): Promise<DeviceIdentity> {
  const ecdh = await generateEcdhKeyPair()
  const ecdsa = await generateEcdsaKeyPair()
  return {
    deviceId,
    keyPair: ecdh,
    publicKeyHex: await exportEcdhPublicKey(ecdh.publicKey),
    signingKeyPair: ecdsa,
    signingPubKey: await exportEcdsaPublicKey(ecdsa.publicKey),
    createdAt: Date.now()
  }
}

function makeRecord(overrides: Partial<ScoutingRecord> = {}): ScoutingRecord {
  return {
    id: 'rec-default',
    eventId: 'evt-uuid-1',
    scoutId: 'scout-1',
    scoutName: 'Client1',
    matchNumber: 1,
    teamNumber: 27570,
    autoScore: 20,
    teleopScore: 50,
    endgameScore: 15,
    totalScore: 85,
    notes: 'clean auto',
    rawData: JSON.stringify({ allianceColor: 'red', tournamentLevel: 'QUALIFICATION' }),
    syncStatus: 'PENDING',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
    isDeleted: false,
    ...overrides
  }
}

interface SecurityRejectReport {
  senderPeerId: string
  rejectedRecords: Array<{ recordId: string; scoutId?: string; reason: string }>
  rejectedIdentities: Array<{ rowId: string; userId?: string; reason: string }>
}

interface TestPeerNode {
  peerId: string
  userId: string
  isHostMode: boolean
  eventId: string
  eventHostId: string
  identity: DeviceIdentity
  clock: CalibratedMonotonicClock
  store: ReturnType<typeof createStandaloneCrdtStore>
  hub: WebRtcCrdtSynchronizerHub
  rejects: SecurityRejectReport[]
  settledPeers: string[]
  wireLog: Array<{ to: string; msg: WebRtcCrdtSyncMsg | WebRtcCrdtSyncChunk }>
}

function createStarBusHarness(withIdentity: <T>(id: DeviceIdentity, fn: () => Promise<T> | T) => Promise<T>) {
  const nodes = new Map<string, TestPeerNode>()
  const boundUsersByHostPeer = new Map<string, string>()
  let activeHost: TestPeerNode | null = null
  let pendingWireDeliveries = 0
  let activeSanitizeCount = 0
  let activeCountersignCount = 0

  function registerNode(params: {
    peerId: string
    userId: string
    isHostMode: boolean
    eventId: string
    eventHostId: string
    identity: DeviceIdentity
    store?: ReturnType<typeof createStandaloneCrdtStore>
  }): TestPeerNode {
    const clock = new CalibratedMonotonicClock(`node_${params.peerId}`)
    const store = params.store ?? createStandaloneCrdtStore(params.identity.deviceId, () => clock.now(), 300)
    const rejects: SecurityRejectReport[] = []
    const settledPeers: string[] = []
    const wireLog: Array<{ to: string; msg: WebRtcCrdtSyncMsg | WebRtcCrdtSyncChunk }> = []

    const hub = createWebRtcCrdtSynchronizerHub({
      eventId: params.eventId,
      store,
      clientId: params.identity.deviceId,
      getNowMs: () => clock.now(),
      sendToPeer: (targetPeerId, msg) => {
        wireLog.push({ to: targetPeerId, msg })
        const target = targetPeerId === 'host' ? activeHost : nodes.get(targetPeerId)
        if (!target) return
        const inboundSenderId = params.isHostMode ? 'host' : params.peerId
        pendingWireDeliveries++
        queueMicrotask(() => {
          try {
            target.hub.handleIncomingMessage(inboundSenderId, msg)
          } finally {
            pendingWireDeliveries--
          }
        })
      },
      sanitizeIncomingMessage: (senderPeerId, msg, pullContext) => {
        activeSanitizeCount++
        return withIdentity(params.identity, async () => {
          try {
            const boundSenderUserId = params.isHostMode
              ? boundUsersByHostPeer.get(senderPeerId) ?? nodes.get(senderPeerId)?.userId
              : params.eventHostId
            const res = await sanitizeIncomingCrdtSyncBody({
              store,
              eventId: params.eventId,
              eventHostId: params.eventHostId,
              isHostMode: params.isHostMode,
              senderPeerId,
              boundSenderUserId,
              localDeviceId: params.identity.deviceId,
              pullContext,
              message: msg.message,
              body: msg.body
            })
            if (res.rejectedRecords.length > 0 || res.rejectedIdentities.length > 0) {
              rejects.push({
                senderPeerId,
                rejectedRecords: res.rejectedRecords,
                rejectedIdentities: res.rejectedIdentities
              })
            }
            return { ...msg, body: res.msgBody }
          } finally {
            activeSanitizeCount--
          }
        })
      },
      onPeerSyncSettled: (peerId) => {
        settledPeers.push(peerId)
        if (params.isHostMode) {
          activeCountersignCount++
          void withIdentity(params.identity, () =>
            countersignPendingMemberIdentities({
              store,
              eventId: params.eventId,
              eventHostId: params.eventHostId,
              currentUserId: params.userId
            })
          ).finally(() => {
            activeCountersignCount--
          })
        }
      }
    })

    const node: TestPeerNode = {
      ...params,
      clock,
      store,
      hub,
      rejects,
      settledPeers,
      wireLog
    }
    nodes.set(params.peerId, node)
    return node
  }

  async function connectHostAndClient(host: TestPeerNode, client: TestPeerNode): Promise<void> {
    activeHost = host
    boundUsersByHostPeer.set(client.peerId, client.userId)
    await Promise.all([
      host.hub.attachPeer(client.peerId, { awaitInitialSync: true }),
      client.hub.attachPeer('host', { awaitInitialSync: true })
    ])
    await flushSyncCycles()
  }

  async function flushSyncCycles(_rounds = 8): Promise<void> {
    await vi.waitFor(async () => {
      await flushPromises()
      expect(pendingWireDeliveries).toBe(0)
      expect(activeSanitizeCount).toBe(0)
      expect(activeCountersignCount).toBe(0)
    })
    await flushPromises()
    await vi.waitFor(async () => {
      await flushPromises()
      expect(pendingWireDeliveries).toBe(0)
      expect(activeSanitizeCount).toBe(0)
      expect(activeCountersignCount).toBe(0)
    })
  }

  async function destroyAll(): Promise<void> {
    await Promise.allSettled(Array.from(nodes.values()).map((n) => n.hub.destroy()))
    nodes.clear()
  }

  return { registerNode, connectHostAndClient, flushSyncCycles, destroyAll }
}

describe('CRDT ScoutingRecord ECDSA Signing, Relay Defense & Pure Derived Conflicts', () => {
  let activeIdentity!: DeviceIdentity
  let opMutex = Promise.resolve()

  function withIdentity<T>(id: DeviceIdentity, fn: () => Promise<T> | T): Promise<T> {
    const run = opMutex.then(() => {
      activeIdentity = id
      return fn()
    })
    opMutex = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  beforeEach(async () => {
    setActivePinia(createPinia())
    localStorage.clear()
    clearBeforeLogoutHooksForTesting()
    opMutex = Promise.resolve()
    activeIdentity = await makeVirtualIdentity('dev_default_test')
    vi.spyOn(identityStore, 'getOrCreateDeviceIdentity').mockImplementation(async () => activeIdentity)
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    await resetCrdtRegistryForTesting()
    resetClockRegistryForTesting()
    clearBeforeLogoutHooksForTesting()
    localStorage.clear()
  })

  it('1. Write-time ECDSA signing verifies intact records, rejects mutated fields, and signs tombstones', async () => {
    const idClient = await makeVirtualIdentity('dev_client_sign')
    const rec = makeRecord({ id: 'r-sign-1', scoutId: 'scout-1', totalScore: 85 })

    const signRes = await withIdentity(idClient, () => signScoutingRecordWithDeviceKey(rec))
    expect(signRes.signed).toBe(true)
    expect(rec.authorPubKey).toBe(idClient.signingPubKey)
    expect(rec.authorSig).toBeTruthy()

    expect(await verifyScoutingRecordSignature(rec)).toBe(true)

    // Field mutations invalidate ECDSA signature
    expect(await verifyScoutingRecordSignature({ ...rec, totalScore: 999 })).toBe(false)
    expect(await verifyScoutingRecordSignature({ ...rec, teamNumber: 8888 })).toBe(false)
    expect(await verifyScoutingRecordSignature({ ...rec, notes: 'tampered' })).toBe(false)
    expect(await verifyScoutingRecordSignature({ ...rec, isDeleted: true })).toBe(false)

    // Store deleteRecord produces a newly signed tombstone
    const userStore = useUserStore()
    userStore.user = { id: 'scout-1', username: 'Client1', token: 'tok-c1' }
    const recordStore = useRecordStore()
    const eventStore = useEventStore()
    eventStore.setCurrentEvent({ id: 'evt-uuid-1', name: 'Event 1', inviteCode: '111111', hostId: 'alice' })
    await withIdentity(idClient, () => recordStore.addRecord(makeRecord({ id: 'r-del-1', scoutId: 'scout-1' })))
    await withIdentity(idClient, () => recordStore.deleteRecord('r-del-1'))

    const deleted = recordStore.records.find((r) => r.id === 'r-del-1')!
    expect(deleted.isDeleted).toBe(true)
    expect(deleted.authorPubKey).toBe(idClient.signingPubKey)
    expect(await verifyScoutingRecordSignature(deleted)).toBe(true)
  })

  it('2. Backup Device B: AssistantBob offline Match 6 -> logout() -> LeadAlice takeover preserves & syncs signed record', async () => {
    const eventId = 'evt-uuid-backup'
    const hostId = 'alice'
    const idDeviceB = await makeVirtualIdentity('dev_backup_B')
    const idClient1 = await makeVirtualIdentity('dev_client_1')

    // Simulated Temp H2 #2 persistence on Device B across Bob -> logout() -> Alice
    let savedSnapshot: unknown = null
    let savedRevision = 0
    let savedEpoch = 1
    const h2TransportB: CrdtHttpTransport = {
      loadState: async () =>
        savedSnapshot
          ? { exists: true, eventId, hostEpoch: savedEpoch, snapshotRevision: savedRevision, snapshot: savedSnapshot }
          : null,
      saveState: async (_eid, payload) => {
        savedSnapshot = payload.snapshot
        savedEpoch = payload.hostEpoch
        savedRevision += 1
        return { saved: true, eventId, hostEpoch: savedEpoch, snapshotRevision: savedRevision }
      }
    }

    const userStore = useUserStore()
    const eventStore = useEventStore()
    const pitStore = usePitScoutStore()
    const scheduleStore = useScheduleStore()
    const customFieldsStore = useCustomFieldsStore()
    const recordStore = useRecordStore()

    // Phase A: AssistantBob logs in on Device B (offline/standby), enters event, writes Match 6 record
    userStore.user = { id: 'bob', username: 'AssistantBob', token: 'tok-bob' }
    eventStore.setCurrentEvent({ id: eventId, name: 'Backup Event', inviteCode: '27570B', hostId })
    const bobSession = await withIdentity(idDeviceB, () =>
      hydrateAndBindEventCrdt({
        eventId,
        userId: 'bob',
        eventHostId: hostId,
        isDesktopHost: false,
        getHostEpoch: () => 1,
        transport: h2TransportB,
        stores: { pitStore, scheduleStore, customFieldsStore, recordStore }
      })
    )

    const match6 = makeRecord({ id: 'rec-bob-m6', eventId, scoutId: 'bob', scoutName: 'AssistantBob', matchNumber: 6, totalScore: 112 })
    await withIdentity(idDeviceB, () => recordStore.addRecord(match6))
    await bobSession.handle.flushNow()
    expect(savedSnapshot).toBeTruthy()
    bobSession.unbind()

    // Bob clicks logout() -> Pinia & localStorage cleared, shared H2 retains Bob's CRDT state + Device B identity
    await userStore.logout()
    expect(recordStore.records).toHaveLength(0)

    // Phase B: LeadAlice logs in on SAME Device B as authoritative Host (Epoch 2)
    userStore.user = { id: hostId, username: 'LeadAlice', token: 'tok-alice' }
    eventStore.setCurrentEvent({ id: eventId, name: 'Backup Event', inviteCode: '27570B', hostId })
    const aliceSession = await withIdentity(idDeviceB, () =>
      hydrateAndBindEventCrdt({
        eventId,
        userId: hostId,
        eventHostId: hostId,
        isDesktopHost: true,
        getHostEpoch: () => 2,
        transport: h2TransportB,
        stores: { pitStore, scheduleStore, customFieldsStore, recordStore }
      })
    )

    const projectedM6 = recordStore.records.find((r) => r.id === 'rec-bob-m6')
    expect(projectedM6).toBeTruthy()
    expect(projectedM6?.totalScore).toBe(112)
    expect(projectedM6?.authorPubKey).toBe(idDeviceB.signingPubKey)

    const hostIdentities = readMemberIdentitiesFromCrdt(aliceSession.handle.store, eventId)
    const bobIdEntry = hostIdentities.find((e) => e.userId === 'bob' && e.deviceId === idDeviceB.deviceId)
    expect(bobIdEntry?.hostPubKey).toBe(idDeviceB.signingPubKey)
    expect(bobIdEntry?.hostSig).toBeTruthy()

    // Sync Device B Host -> Client1 over CRDT synchronizer hub
    const bus = createStarBusHarness(withIdentity)
    const hostBNode = bus.registerNode({
      peerId: 'hostB',
      userId: hostId,
      isHostMode: true,
      eventId,
      eventHostId: hostId,
      identity: idDeviceB,
      store: aliceSession.handle.store
    })
    const client1Node = bus.registerNode({
      peerId: 'client1',
      userId: 'scout-1',
      isHostMode: false,
      eventId,
      eventHostId: hostId,
      identity: idClient1
    })
    await withIdentity(idClient1, () =>
      registerLocalMemberIdentity({ store: client1Node.store, eventId, userId: 'scout-1', eventHostId: hostId })
    )

    await bus.connectHostAndClient(hostBNode, client1Node)

    const client1Records = readScoutingRecordsFromCrdt(client1Node.store, eventId)
    expect(client1Records.some((r) => r.id === 'rec-bob-m6' && r.totalScore === 112)).toBe(true)
    expect(client1Node.rejects).toHaveLength(0)

    aliceSession.unbind()
    await bus.destroyAll()
  })

  it('3. Host countersigns Client1 BEFORE fan-out so already-connected Client2 accepts Client1 record in one pass', async () => {
    const eventId = 'evt-uuid-order'
    const hostId = 'alice'
    const idHostA = await makeVirtualIdentity('dev_host_A')
    const idClient1 = await makeVirtualIdentity('dev_client_1')
    const idClient2 = await makeVirtualIdentity('dev_client_2')

    const bus = createStarBusHarness(withIdentity)
    const hostA = bus.registerNode({
      peerId: 'hostA',
      userId: hostId,
      isHostMode: true,
      eventId,
      eventHostId: hostId,
      identity: idHostA
    })
    const client2 = bus.registerNode({
      peerId: 'client2',
      userId: 'scout-2',
      isHostMode: false,
      eventId,
      eventHostId: hostId,
      identity: idClient2
    })
    const client1 = bus.registerNode({
      peerId: 'client1',
      userId: 'scout-1',
      isHostMode: false,
      eventId,
      eventHostId: hostId,
      identity: idClient1
    })

    await withIdentity(idHostA, () =>
      registerLocalMemberIdentity({ store: hostA.store, eventId, userId: hostId, eventHostId: hostId })
    )
    await withIdentity(idClient2, () =>
      registerLocalMemberIdentity({ store: client2.store, eventId, userId: 'scout-2', eventHostId: hostId })
    )
    await bus.connectHostAndClient(hostA, client2)

    // Client1 writes its unsigned identity + signed record offline BEFORE connecting to HostA
    await withIdentity(idClient1, () =>
      registerLocalMemberIdentity({ store: client1.store, eventId, userId: 'scout-1', eventHostId: hostId })
    )
    const c1Rec = makeRecord({ id: 'rec-c1-m3', eventId, scoutId: 'scout-1', matchNumber: 3, totalScore: 77 })
    await withIdentity(idClient1, () => signScoutingRecordWithDeviceKey(c1Rec))
    writeScoutingRecordToCrdt(client1.store, c1Rec)

    await bus.connectHostAndClient(hostA, client1)

    const c2Recs = readScoutingRecordsFromCrdt(client2.store, eventId)
    expect(c2Recs.some((r) => r.id === 'rec-c1-m3' && r.totalScore === 77)).toBe(true)

    const c2Ids = readMemberIdentitiesFromCrdt(client2.store, eventId)
    const c1AnchorOnC2 = c2Ids.find((e) => e.userId === 'scout-1' && e.deviceId === idClient1.deviceId)
    expect(c1AnchorOnC2?.hostPubKey).toBe(idHostA.signingPubKey)
    expect(c1AnchorOnC2?.hostSig).toBeTruthy()
    expect(client2.rejects).toHaveLength(0)

    await bus.destroyAll()
  })

  it('4. Step 9 Empty HostC accepts Client2 record relayed via Client1 while strictly rejecting tampered & unbound attacks', async () => {
    const eventId = 'evt-uuid-step9'
    const hostId = 'alice'
    const idHostA = await makeVirtualIdentity('dev_host_A_9')
    const idHostC = await makeVirtualIdentity('dev_host_C_9')
    const idClient1 = await makeVirtualIdentity('dev_client_1_9')
    const idClient2 = await makeVirtualIdentity('dev_client_2_9')

    const bus = createStarBusHarness(withIdentity)

    // Empty HostC initially has zero records and zero external peer anchors (host only has its own device anchor)
    const hostC = bus.registerNode({
      peerId: 'hostC',
      userId: hostId,
      isHostMode: true,
      eventId,
      eventHostId: hostId,
      identity: idHostC
    })
    await withIdentity(idHostC, () =>
      registerLocalMemberIdentity({ store: hostC.store, eventId, userId: hostId, eventHostId: hostId })
    )

    // Client1 holds HostA's anchor, Client2's HostA-countersigned identity, and Client2's signed historical record
    const client1 = bus.registerNode({
      peerId: 'client1',
      userId: 'scout-1',
      isHostMode: false,
      eventId,
      eventHostId: hostId,
      identity: idClient1
    })
    await withIdentity(idClient1, () =>
      registerLocalMemberIdentity({ store: client1.store, eventId, userId: 'scout-1', eventHostId: hostId })
    )

    const hostAPayload = buildMemberIdentityCanonicalPayload({
      eventId,
      userId: hostId,
      deviceId: idHostA.deviceId,
      signingPubKeyHex: idHostA.signingPubKey!
    })
    const hostASelfSig = await signDataEcdsa(idHostA.signingKeyPair!.privateKey, hostAPayload)
    writeMemberIdentityToCrdt(client1.store, {
      eventId,
      userId: hostId,
      deviceId: idHostA.deviceId,
      signingPubKeyHex: idHostA.signingPubKey!,
      trustedAt: Date.now(),
      hostPubKey: idHostA.signingPubKey!,
      hostSig: hostASelfSig
    })

    const c2IdPayload = buildMemberIdentityCanonicalPayload({
      eventId,
      userId: 'scout-2',
      deviceId: idClient2.deviceId,
      signingPubKeyHex: idClient2.signingPubKey!
    })
    const c2HostSig = await signDataEcdsa(idHostA.signingKeyPair!.privateKey, c2IdPayload)
    writeMemberIdentityToCrdt(client1.store, {
      eventId,
      userId: 'scout-2',
      deviceId: idClient2.deviceId,
      signingPubKeyHex: idClient2.signingPubKey!,
      trustedAt: Date.now(),
      hostPubKey: idHostA.signingPubKey!,
      hostSig: c2HostSig
    })

    const recByC2 = makeRecord({ id: 'rec-c2-relay', eventId, scoutId: 'scout-2', scoutName: 'Client2', matchNumber: 4, totalScore: 99 })
    await withIdentity(idClient2, () => signScoutingRecordWithDeviceKey(recByC2))
    writeScoutingRecordToCrdt(client1.store, recByC2)

    await bus.connectHostAndClient(hostC, client1)

    // Verify HostC recovered Client2's historical record via Client1 relay
    const recoveredOnC = readScoutingRecordsFromCrdt(hostC.store, eventId)
    expect(recoveredOnC.find((r) => r.id === 'rec-c2-relay')?.totalScore).toBe(99)
    expect(hostC.rejects).toHaveLength(0)

    // Build an isolated attacker store to generate genuine TinyBase ContentDiff payloads
    const now = Date.now()
    const attackerStore = createStandaloneCrdtStore('dev_attacker', () => now, 300)

    // Attack ①: Tamper totalScore on recByC2 while keeping Client2's original authorSig
    const tamperedRec: ScoutingRecord = { ...recByC2, id: 'rec-tampered-1', totalScore: 999 }
    writeScoutingRecordToCrdt(attackerStore, tamperedRec)
    const tamperedSnap = attackerStore.getMergeableContent()
    const resAttack1 = await withIdentity(idHostC, () =>
      sanitizeIncomingCrdtSyncBody({
        store: hostC.store,
        eventId,
        eventHostId: hostId,
        isHostMode: true,
        senderPeerId: 'client1',
        boundSenderUserId: 'scout-1',
        localDeviceId: idHostC.deviceId,
        message: 3,
        body: tamperedSnap
      })
    )
    expect(resAttack1.rejectedRecords).toHaveLength(1)
    expect(resAttack1.rejectedRecords[0]?.reason).toBe('invalid_author_signature')
    const tamperedContentDiff = [tamperedSnap[0], tamperedSnap[1], 1]
    // Feed through HostC hub -> tampered record must NEVER land in HostC store
    hostC.hub.handleIncomingMessage('client1', {
      type: 'CRDT_SYNC_MSG',
      eventId,
      fromClientId: 'dev_attacker',
      toClientId: idHostC.deviceId,
      requestId: null,
      message: 3,
      body: tamperedContentDiff
    })
    await bus.flushSyncCycles(4)
    expect(readScoutingRecordsFromCrdt(hostC.store, eventId).some((r) => r.id === 'rec-tampered-1')).toBe(false)
    expect(hostC.rejects.some((r) => r.rejectedRecords.some((rr) => rr.reason === 'invalid_author_signature'))).toBe(true)

    // Attack ②: Rogue ephemeral ECDSA keypair self-signing forged identity & forged record claiming scout-2 and eventHostId
    const rogueIdentity = await makeVirtualIdentity('dev_rogue_9')
    const rogueStore = createStandaloneCrdtStore('dev_rogue_9', () => Date.now(), 300)
    // Try spoofing scout-2 AND spoofing eventHostId self-anchor on non-empty HostC
    const rogueHostPayload = buildMemberIdentityCanonicalPayload({
      eventId,
      userId: hostId,
      deviceId: rogueIdentity.deviceId,
      signingPubKeyHex: rogueIdentity.signingPubKey!
    })
    const rogueHostSelfSig = await signDataEcdsa(rogueIdentity.signingKeyPair!.privateKey, rogueHostPayload)
    writeMemberIdentityToCrdt(rogueStore, {
      eventId,
      userId: hostId,
      deviceId: rogueIdentity.deviceId,
      signingPubKeyHex: rogueIdentity.signingPubKey!,
      trustedAt: Date.now(),
      hostPubKey: rogueIdentity.signingPubKey!,
      hostSig: rogueHostSelfSig
    })
    writeMemberIdentityToCrdt(rogueStore, {
      eventId,
      userId: 'scout-2',
      deviceId: rogueIdentity.deviceId,
      signingPubKeyHex: rogueIdentity.signingPubKey!,
      trustedAt: Date.now()
    })
    const forgedRec = makeRecord({ id: 'rec-forged-c2', eventId, scoutId: 'scout-2', matchNumber: 7, totalScore: 555 })
    await withIdentity(rogueIdentity, () => signScoutingRecordWithDeviceKey(forgedRec))
    writeScoutingRecordToCrdt(rogueStore, forgedRec)

    const rogueSnap = rogueStore.getMergeableContent()
    hostC.hub.handleIncomingMessage('client1', {
      type: 'CRDT_SYNC_MSG',
      eventId,
      fromClientId: 'dev_rogue_9',
      toClientId: idHostC.deviceId,
      requestId: null,
      message: 3,
      body: [rogueSnap[0], rogueSnap[1], 1]
    })
    await bus.flushSyncCycles(4)

    expect(readScoutingRecordsFromCrdt(hostC.store, eventId).some((r) => r.id === 'rec-forged-c2')).toBe(false)
    expect(
      readMemberIdentitiesFromCrdt(hostC.store, eventId).some((m) => m.signingPubKeyHex === rogueIdentity.signingPubKey)
    ).toBe(false)
    expect(
      hostC.rejects.some((r) => r.rejectedIdentities.length === 2 && r.rejectedRecords[0]?.reason === 'unbound_author_pubkey')
    ).toBe(true)

    await bus.destroyAll()
  })

  it('5. Legitimate Host edit of a scout record signed with Host key is accepted by peers via eventHostId trust', async () => {
    const eventId = 'evt-uuid-host-edit'
    const hostId = 'alice'
    const idHostA = await makeVirtualIdentity('dev_host_A_5')
    const idClient1 = await makeVirtualIdentity('dev_client_1_5')
    const idClient2 = await makeVirtualIdentity('dev_client_2_5')

    const bus = createStarBusHarness(withIdentity)
    const hostA = bus.registerNode({ peerId: 'hostA', userId: hostId, isHostMode: true, eventId, eventHostId: hostId, identity: idHostA })
    const client1 = bus.registerNode({ peerId: 'client1', userId: 'scout-1', isHostMode: false, eventId, eventHostId: hostId, identity: idClient1 })
    const client2 = bus.registerNode({ peerId: 'client2', userId: 'scout-2', isHostMode: false, eventId, eventHostId: hostId, identity: idClient2 })

    await withIdentity(idHostA, () => registerLocalMemberIdentity({ store: hostA.store, eventId, userId: hostId, eventHostId: hostId }))
    await withIdentity(idClient1, () => registerLocalMemberIdentity({ store: client1.store, eventId, userId: 'scout-1', eventHostId: hostId }))
    await withIdentity(idClient2, () => registerLocalMemberIdentity({ store: client2.store, eventId, userId: 'scout-2', eventHostId: hostId }))

    const c1Rec = makeRecord({ id: 'rec-edit-target', eventId, scoutId: 'scout-1', matchNumber: 2, totalScore: 50, notes: 'initial' })
    await withIdentity(idClient1, () => signScoutingRecordWithDeviceKey(c1Rec))
    writeScoutingRecordToCrdt(client1.store, c1Rec)

    await bus.connectHostAndClient(hostA, client1)
    await bus.connectHostAndClient(hostA, client2)

    // Now HostA legitimately edits Client1's record (e.g. score correction by lead scout), signing with HostA key
    const editedByHost: ScoutingRecord = {
      ...c1Rec,
      notes: 'verified by lead',
      totalScore: 85,
      version: 2,
      updatedAt: new Date(Date.now() + 10).toISOString()
    }
    await withIdentity(idHostA, () => signScoutingRecordWithDeviceKey(editedByHost))
    expect(editedByHost.authorPubKey).toBe(idHostA.signingPubKey)
    writeScoutingRecordToCrdt(hostA.store, editedByHost)

    await bus.flushSyncCycles(8)

    const c2Rec = readScoutingRecordsFromCrdt(client2.store, eventId).find((r) => r.id === 'rec-edit-target')
    expect(c2Rec?.totalScore).toBe(85)
    expect(c2Rec?.notes).toBe('verified by lead')
    expect(c2Rec?.authorPubKey).toBe(idHostA.signingPubKey)
    expect(client2.rejects).toHaveLength(0)

    await bus.destroyAll()
  })

  it('6. Pure derived isConflict sets & clears automatically without mutating peer record version', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'scout-1', username: 'Client1', token: 'tok-c1' }
    const store = useRecordStore()
    const eventStore = useEventStore()
    eventStore.setCurrentEvent({ id: 'evt-conf', name: 'Conf Event', inviteCode: 'CONF1', hostId: 'alice' })
    const id1 = await makeVirtualIdentity('dev_conf_1')

    const r1 = makeRecord({ id: 'rec-conf-1', eventId: 'evt-conf', scoutId: 'scout-1', matchNumber: 1, teamNumber: 9999, version: 1 })
    await withIdentity(id1, () => store.addRecord(r1))
    const r1AfterAdd = store.records.find((r) => r.id === 'rec-conf-1')
    expect(r1AfterAdd?.isConflict).toBeFalsy()
    const versionAfterAdd = r1AfterAdd?.version
    expect(versionAfterAdd).toBeGreaterThanOrEqual(1)

    // Scout 2 also reports Match 1 Team 9999
    const r2 = makeRecord({ id: 'rec-conf-2', eventId: 'evt-conf', scoutId: 'scout-2', matchNumber: 1, teamNumber: 9999, version: 1 })
    await store.bulkSync([r2])

    expect(store.records.find((r) => r.id === 'rec-conf-1')?.isConflict).toBe(true)
    expect(store.records.find((r) => r.id === 'rec-conf-1')?.version).toBe(versionAfterAdd)
    expect(store.records.find((r) => r.id === 'rec-conf-2')?.isConflict).toBe(true)

    // Scout 1 corrects its teamNumber to 8888 -> conflict disappears on BOTH records cleanly
    const r1Fixed: ScoutingRecord = { ...store.records.find((r) => r.id === 'rec-conf-1')!, teamNumber: 8888 }
    await withIdentity(id1, () => store.addRecord(r1Fixed))

    expect(store.records.find((r) => r.id === 'rec-conf-1')?.isConflict).toBe(false)
    expect(store.records.find((r) => r.id === 'rec-conf-2')?.isConflict).toBe(false)
    expect(store.conflictCoords.size).toBe(0)
  })

  it('7. Placeholder eventId migration re-signs offline authored records cleanly for authoritative Host acceptance', async () => {
    const oldId = 'evt-ABC123'
    const newId = 'real-uuid-1234'
    const hostId = 'alice'
    const idClient1 = await makeVirtualIdentity('dev_mig_client1')
    const idHostA = await makeVirtualIdentity('dev_mig_hostA')

    const userStore = useUserStore()
    userStore.user = { id: 'scout-1', username: 'Client1', token: 'tok-c1' }
    const store = useRecordStore()
    const eventStore = useEventStore()
    eventStore.setCurrentEvent({ id: oldId, name: 'Offline Placeholder', inviteCode: 'ABC123', hostId })

    const offlineRec = makeRecord({ id: 'rec-mig-1', eventId: oldId, scoutId: 'scout-1', matchNumber: 2, teamNumber: 27570, totalScore: 66 })
    await withIdentity(idClient1, () => store.addRecord(offlineRec))
    expect(await verifyScoutingRecordSignature(store.records.find((r) => r.id === 'rec-mig-1')!)).toBe(true)

    // Migrate placeholder evt-ABC123 -> real-uuid-1234 and explicitly await re-signing
    store.migrateEventId(oldId, newId)
    await withIdentity(idClient1, () => store.reSignEventAuthorRecords(newId))

    const migrated = store.records.find((r) => r.id === 'rec-mig-1')!
    expect(migrated.eventId).toBe(newId)
    expect(await verifyScoutingRecordSignature(migrated)).toBe(true)
    expect(await verifyDataEcdsa(migrated.authorPubKey!, buildRecordCanonicalPayload(migrated), migrated.authorSig!)).toBe(true)

    // Push migrated record over real CRDT synchronizer hub to authoritative HostA for real-uuid-1234
    const bus = createStarBusHarness(withIdentity)
    const hostA = bus.registerNode({ peerId: 'hostA', userId: hostId, isHostMode: true, eventId: newId, eventHostId: hostId, identity: idHostA })
    const client1 = bus.registerNode({ peerId: 'client1', userId: 'scout-1', isHostMode: false, eventId: newId, eventHostId: hostId, identity: idClient1 })

    await withIdentity(idHostA, () => registerLocalMemberIdentity({ store: hostA.store, eventId: newId, userId: hostId, eventHostId: hostId }))
    await withIdentity(idClient1, () => registerLocalMemberIdentity({ store: client1.store, eventId: newId, userId: 'scout-1', eventHostId: hostId }))
    writeScoutingRecordToCrdt(client1.store, migrated)

    await bus.connectHostAndClient(hostA, client1)

    const hostRecs = readScoutingRecordsFromCrdt(hostA.store, newId)
    expect(hostRecs.some((r) => r.id === 'rec-mig-1' && r.totalScore === 66 && r.eventId === newId)).toBe(true)
    expect(hostA.rejects).toHaveLength(0)

    await bus.destroyAll()
  })

  it('8. Warm multi-step pull: existing HostA & Client2 accept newly joining Client3 identity + record with zero rejections', async () => {
    const eventId = 'evt-uuid-warm'
    const hostId = 'alice'
    const idHostA = await makeVirtualIdentity('dev_host_A_8')
    const idClient2 = await makeVirtualIdentity('dev_client_2_8')
    const idClient3 = await makeVirtualIdentity('dev_client_3_8')

    const bus = createStarBusHarness(withIdentity)
    const hostA = bus.registerNode({ peerId: 'hostA', userId: hostId, isHostMode: true, eventId, eventHostId: hostId, identity: idHostA })
    const client2 = bus.registerNode({ peerId: 'client2', userId: 'scout-2', isHostMode: false, eventId, eventHostId: hostId, identity: idClient2 })

    await withIdentity(idHostA, () => registerLocalMemberIdentity({ store: hostA.store, eventId, userId: hostId, eventHostId: hostId }))
    await withIdentity(idClient2, () => registerLocalMemberIdentity({ store: client2.store, eventId, userId: 'scout-2', eventHostId: hostId }))

    const warmRec = makeRecord({ id: 'rec-warm-1', eventId, scoutId: 'scout-2', matchNumber: 1, totalScore: 40 })
    await withIdentity(idClient2, () => signScoutingRecordWithDeviceKey(warmRec))
    writeScoutingRecordToCrdt(client2.store, warmRec)

    await bus.connectHostAndClient(hostA, client2)
    expect(readScoutingRecordsFromCrdt(hostA.store, eventId).some((r) => r.id === 'rec-warm-1')).toBe(true)

    // Client3 authored a record offline while HostA & Client2 already have non-empty scouting_records
    const client3 = bus.registerNode({ peerId: 'client3', userId: 'scout-3', isHostMode: false, eventId, eventHostId: hostId, identity: idClient3 })
    await withIdentity(idClient3, () => registerLocalMemberIdentity({ store: client3.store, eventId, userId: 'scout-3', eventHostId: hostId }))
    const c3Rec = makeRecord({ id: 'rec-c3-warm', eventId, scoutId: 'scout-3', matchNumber: 5, totalScore: 105 })
    await withIdentity(idClient3, () => signScoutingRecordWithDeviceKey(c3Rec))
    writeScoutingRecordToCrdt(client3.store, c3Rec)

    await bus.connectHostAndClient(hostA, client3)

    expect(readScoutingRecordsFromCrdt(hostA.store, eventId).some((r) => r.id === 'rec-c3-warm' && r.totalScore === 105)).toBe(true)
    expect(readScoutingRecordsFromCrdt(client2.store, eventId).some((r) => r.id === 'rec-c3-warm' && r.totalScore === 105)).toBe(true)
    expect(readScoutingRecordsFromCrdt(client3.store, eventId).some((r) => r.id === 'rec-warm-1' && r.totalScore === 40)).toBe(true)
    expect(hostA.rejects).toHaveLength(0)
    expect(client2.rejects).toHaveLength(0)
    expect(client3.rejects).toHaveLength(0)

    await bus.destroyAll()
  })

  it('9. Bare-metal hydrateAndBindEventCrdt resolves persistent IDB deviceId first so cold HostC recovery accepts relayed anchors', async () => {
    await resetCrdtRegistryForTesting()
    localStorage.clear()

    const eventId = 'evt-uuid-cold-hostc'
    const hostId = 'alice'
    const idHostA = await makeVirtualIdentity('dev_host_A_9')
    const idHostC = await makeVirtualIdentity('dev_host_C_9')
    const idClient1 = await makeVirtualIdentity('dev_client_1_9')
    const idClient2 = await makeVirtualIdentity('dev_client_2_9')

    const userStore = useUserStore()
    const eventStore = useEventStore()
    const pitStore = usePitScoutStore()
    const scheduleStore = useScheduleStore()
    const customFieldsStore = useCustomFieldsStore()
    const recordStore = useRecordStore()

    userStore.user = { id: hostId, username: 'LeadAlice', token: 'tok-alice-c' }
    eventStore.setCurrentEvent({ id: eventId, name: 'Recovery Event', inviteCode: '27570C', hostId })

    // No explicit deviceId & empty localStorage -> must resolve idHostC.deviceId BEFORE creating handle
    const sessionC = await withIdentity(idHostC, () =>
      hydrateAndBindEventCrdt({
        eventId,
        userId: hostId,
        eventHostId: hostId,
        isDesktopHost: true,
        enableHttp: false,
        enableIndexedDb: false,
        getHostEpoch: () => 3,
        stores: { pitStore, scheduleStore, customFieldsStore, recordStore }
      })
    )
    expect(sessionC.handle.deviceId).toBe(idHostC.deviceId)

    // Client1 holds HostA's self-signed anchor, Client2's HostA-countersigned anchor, and Client2's signed Match 4 record
    const bus = createStarBusHarness(withIdentity)
    const client1Node = bus.registerNode({
      peerId: 'client1',
      userId: 'scout-1',
      isHostMode: false,
      eventId,
      eventHostId: hostId,
      identity: idClient1
    })
    await withIdentity(idClient1, () =>
      registerLocalMemberIdentity({ store: client1Node.store, eventId, userId: 'scout-1', eventHostId: hostId })
    )
    const hostAPayload = buildMemberIdentityCanonicalPayload({
      eventId,
      userId: hostId,
      deviceId: idHostA.deviceId,
      signingPubKeyHex: idHostA.signingPubKey!
    })
    const hostASig = await signDataEcdsa(idHostA.signingKeyPair!.privateKey, hostAPayload)
    writeMemberIdentityToCrdt(client1Node.store, {
      eventId,
      userId: hostId,
      deviceId: idHostA.deviceId,
      signingPubKeyHex: idHostA.signingPubKey!,
      trustedAt: Date.now() - 10000,
      hostPubKey: idHostA.signingPubKey!,
      hostSig: hostASig
    })
    const c2Payload = buildMemberIdentityCanonicalPayload({
      eventId,
      userId: 'scout-2',
      deviceId: idClient2.deviceId,
      signingPubKeyHex: idClient2.signingPubKey!
    })
    const c2HostSig = await signDataEcdsa(idHostA.signingKeyPair!.privateKey, c2Payload)
    writeMemberIdentityToCrdt(client1Node.store, {
      eventId,
      userId: 'scout-2',
      deviceId: idClient2.deviceId,
      signingPubKeyHex: idClient2.signingPubKey!,
      trustedAt: Date.now() - 9000,
      hostPubKey: idHostA.signingPubKey!,
      hostSig: c2HostSig
    })
    const m4 = makeRecord({ id: 'rec-c2-m4', eventId, scoutId: 'scout-2', matchNumber: 4, teamNumber: 2222, totalScore: 98 })
    await withIdentity(idClient2, () => signScoutingRecordWithDeviceKey(m4))
    writeScoutingRecordToCrdt(client1Node.store, m4)

    const hostCNode = bus.registerNode({
      peerId: 'hostC',
      userId: hostId,
      isHostMode: true,
      eventId,
      eventHostId: hostId,
      identity: { ...idHostC, deviceId: sessionC.handle.deviceId },
      store: sessionC.handle.store
    })

    await bus.connectHostAndClient(hostCNode, client1Node)

    const recoveredRecs = readScoutingRecordsFromCrdt(hostCNode.store, eventId)
    expect(recoveredRecs.some((r) => r.id === 'rec-c2-m4' && r.teamNumber === 2222 && r.totalScore === 98)).toBe(true)
    expect(hostCNode.rejects).toHaveLength(0)

    sessionC.unbind()
    await bus.destroyAll()
  })
})
