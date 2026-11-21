import { ref, computed, watch, type Ref } from 'vue'
import type { Router } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { useEventStore } from '@/stores/events'
import { useRecordStore } from '@/stores/records'
import { useConnectionStore } from '@/stores/connection'
import { useInboxStore } from '@/stores/inbox'
import { useToastStore } from '@/stores/toast'
import { useScheduleStore } from '@/stores/schedule'
import { usePitScoutStore } from '@/stores/pitScout'
import { useCustomFieldsStore } from '@/stores/customFields'
import {
  createWebRtcService,
  saveEpochWitnessRecord,
  isPlaceholderEventId,
  type WebRtcCallbacks,
  type EventEpochWitnessRecord
} from '@/services/webrtc'
import { migrateClockAnchor } from '@/services/clock'
import {
  buildRecordCanonicalPayload,
  countersignPendingMemberIdentities,
  createWebRtcCrdtSynchronizerHub,
  disposeEventCrdt,
  extractMaxHlcPtFromSnapshot,
  getExistingEventCrdt,
  hydrateAndBindEventCrdt,
  isCrdtTransportActive,
  migrateEventCrdtId,
  readAssignmentsFromCrdt,
  readPitRecordsFromCrdt,
  readSchedulesFromCrdt,
  readScoutingRecordsFromCrdt,
  readTeamTagsFromCrdt,
  sanitizeIncomingCrdtSyncBody,
  setCrdtTransportActive,
  writeMemberIdentityToCrdt,
  writePitRecordToCrdt,
  writeScoutingRecordToCrdt,
  type EventCrdtHandle,
  type WebRtcCrdtSynchronizerHub
} from '@/services/crdt'
import { syncRecords, syncPitRecordsBatch, savePitRecord, addEventMember } from '@/services/api'
import { saveKnownScout } from '@/services/scoutStorage'
import { flushOfflinePhotos, isDesktopHost } from '@/services/photoStorage'
import { isMobileDevice } from '@/composables/useIsMobile'
import type { ScoutingRecord, ScoutingEvent } from '@/types'

export interface EventWebRtcBridgeOptions {
  eventId: Ref<string>
  event: Ref<ScoutingEvent | null>
  router: Router
  t: (key: string, values?: Record<string, any>) => string
}

export function useEventWebRtcBridge({
  eventId,
  event,
  router,
  t
}: EventWebRtcBridgeOptions) {
  const userStore = useUserStore()
  const eventStore = useEventStore()
  const recordStore = useRecordStore()
  const connStore = useConnectionStore()
  const inboxStore = useInboxStore()
  const scheduleStore = useScheduleStore()
  const pitStore = usePitScoutStore()
  const customFieldsStore = useCustomFieldsStore()
  const toastStore = useToastStore()

  // Client 端：持久化最后一次从 Host 收到的最大 hostSeq，用于重连后增量请求
  // 按 eventId 分筒，避免不同赛事之间混淆
  const lastHostSeqKey = computed(() => `sp27_lastHostSeq_${eventId.value}`)
  const lastHostSeq = ref<number>(0)
  watch(lastHostSeq, (v) => localStorage.setItem(lastHostSeqKey.value, String(v)))
  const lastConnectedHostSessionId = ref<string>('')
  const wasActiveHostBeforeDemotion = ref<boolean>(false)
  const syncedMemberIds = new Set<string>()
  let lastSyncPipelineTriggeredAt = 0
  let isPromotingToHost = false
  let rtcStartedAsHost = false

  let activeCrdtEventId = ''
  let crdtUnbind: (() => void) | null = null
  let crdtHub: WebRtcCrdtSynchronizerHub | null = null
  const openCrdtPeers = new Set<string>()

  function createHubForHandle(handle: EventCrdtHandle): WebRtcCrdtSynchronizerHub {
    return createWebRtcCrdtSynchronizerHub({
      eventId: handle.eventId,
      store: handle.store,
      clientId: handle.deviceId,
      getNowMs: () => handle.clock.now(),
      getAuthCode: () => event.value?.inviteCode || eventStore.currentEvent?.inviteCode,
      sendToPeer: (peerId, msg) => {
        const rtc = connStore.rtcService
        if (!rtc) return
        void rtc.sendMessage(msg, rtc.isHostMode() ? peerId : undefined)
      },
      onFutureClockSkew: (senderPeerId, scan) => {
        console.warn('[CRDT:ClockGuard] Future HLC skew detected:', {
          senderPeerId,
          maxSkewMs: scan.maxSkewMs,
          maxIncomingPt: scan.maxIncomingPt
        })
        if (typeof window !== 'undefined') {
          const win = window as any
          const list = Array.isArray(win.__LAST_CRDT_FUTURE_SKEW__) ? win.__LAST_CRDT_FUTURE_SKEW__ : []
          list.push({
            ts: Date.now(),
            eventId: handle.eventId,
            senderPeerId,
            maxSkewMs: scan.maxSkewMs,
            maxIncomingPt: scan.maxIncomingPt
          })
          if (list.length > 50) {
            list.splice(0, list.length - 50)
          }
          win.__LAST_CRDT_FUTURE_SKEW__ = list
        }
        const rtc = connStore.rtcService
        if (rtc?.isHostMode()) {
          void rtc.sendForceClockResync?.(senderPeerId, 'future_hlc_skew')
        }
      },
      sanitizeIncomingMessage: async (senderPeerId, msg, pullContext) => {
        const rtc = connStore.rtcService
        const isHost = Boolean(rtc?.isHostMode?.())
        const evt = event.value || eventStore.currentEvent
        const eventHostId = evt?.hostId || undefined
        const boundSenderUserId = isHost
          ? rtc?.getPeerUserId?.(senderPeerId)
          : (rtc?.getPeerUserId?.(senderPeerId) || eventHostId)
        const res = await sanitizeIncomingCrdtSyncBody({
          store: handle.store,
          eventId: handle.eventId,
          eventHostId,
          isHostMode: isHost,
          senderPeerId,
          boundSenderUserId,
          localDeviceId: handle.deviceId,
          pullContext,
          message: msg.message,
          body: msg.body
        })
        if (res.rejectedRecords.length > 0 || res.rejectedIdentities.length > 0) {
          console.warn(
            '[CRDT:Security] Rejected inbound CRDT rows:',
            JSON.stringify({
              senderPeerId,
              rejectedRecords: res.rejectedRecords,
              rejectedIdentities: res.rejectedIdentities
            })
          )
          if (typeof window !== 'undefined') {
            const win = window as any
            const list = Array.isArray(win.__LAST_CRDT_SECURITY_REJECTS__)
              ? win.__LAST_CRDT_SECURITY_REJECTS__
              : []
            list.push({
              ts: Date.now(),
              eventId: handle.eventId,
              senderPeerId,
              rejectedRecords: res.rejectedRecords,
              rejectedIdentities: res.rejectedIdentities
            })
            if (list.length > 50) {
              list.splice(0, list.length - 50)
            }
            win.__LAST_CRDT_SECURITY_REJECTS__ = list
          }
        }
        return { ...msg, body: res.msgBody }
      },
      onPeerSyncSettled: (_peerId) => {
        const rtc = connStore.rtcService
        if (rtc?.isHostMode?.()) {
          void countersignPendingMemberIdentities({
            store: handle.store,
            eventId: handle.eventId,
            eventHostId: (event.value || eventStore.currentEvent)?.hostId,
            currentUserId: userStore.userId
          })
          return
        }
        const pendingIds = recordStore.records
          .filter((r) => r.eventId === handle.eventId && r.syncStatus === 'PENDING')
          .map((r) => r.id)
        if (pendingIds.length > 0) {
          void recordStore.markSynced(pendingIds)
        }
      }
    })
  }

  async function initEventCrdt(targetEventId?: string): Promise<EventCrdtHandle | undefined> {
    const evt = event.value || eventStore.currentEvent
    const eid = (targetEventId || evt?.id || eventId.value || '').trim()
    if (!eid) return undefined

    if (activeCrdtEventId === eid && crdtHub) {
      return getExistingEventCrdt(eid)
    }

    if (activeCrdtEventId && activeCrdtEventId !== eid) {
      crdtUnbind?.()
      crdtUnbind = null
      if (crdtHub) {
        await crdtHub.destroy()
        crdtHub = null
      }
    }

    const session = await hydrateAndBindEventCrdt({
      eventId: eid,
      inviteCode: evt?.inviteCode,
      userId: userStore.userId,
      eventHostId: evt?.hostId,
      getHostEpoch: () => connStore.rtcService?.getHostEpoch?.() || 1,
      isDesktopHost: isDesktopHost() && !isMobileDevice(),
      stores: { pitStore, scheduleStore, customFieldsStore, recordStore }
    })
    activeCrdtEventId = eid
    crdtUnbind = session.unbind
    if (crdtHub) {
      await crdtHub.destroy()
    }
    crdtHub = createHubForHandle(session.handle)
    publishE2eBridge()
    return session.handle
  }

  function publishE2eBridge(): void {
    if (typeof window === 'undefined') return
    ;(window as any).__sp27E2eBridge = {
      getEventId: () => activeCrdtEventId || eventId.value,
      getHostEpoch: () => connStore.rtcService?.getHostEpoch?.() || 0,
      isHostMode: () => Boolean(connStore.rtcService?.isHostMode?.()),
      isStandbyHost: () => Boolean(connStore.isStandbyHost),
      getConnectionStatus: () => connStore.status,
      getClockNow: () => getExistingEventCrdt(activeCrdtEventId || eventId.value)?.clock.now() || 0,
      getMaxHlcPt: () => {
        const h = getExistingEventCrdt(activeCrdtEventId || eventId.value)
        return h ? extractMaxHlcPtFromSnapshot(h.store.getMergeableContent()) : 0
      },
      getCrdtSnapshot: () => getExistingEventCrdt(activeCrdtEventId || eventId.value)?.store.getMergeableContent() || null,
      flushCrdtNow: async () => await getExistingEventCrdt(activeCrdtEventId || eventId.value)?.flushNow(),
      getNormalizedState: async () => {
        const eid = activeCrdtEventId || eventId.value
        const h = getExistingEventCrdt(eid)
        if (!h) return null
        return {
          scoutingRecords: readScoutingRecordsFromCrdt(h.store, eid)
            .map((r) => ({
              id: r.id,
              eventId: r.eventId,
              scoutId: r.scoutId,
              matchNumber: r.matchNumber,
              teamNumber: r.teamNumber,
              autoScore: r.autoScore,
              teleopScore: r.teleopScore,
              endgameScore: r.endgameScore,
              totalScore: r.totalScore,
              notes: r.notes,
              isDeleted: Boolean(r.isDeleted),
              authorPubKey: r.authorPubKey || ''
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
          pitRecords: readPitRecordsFromCrdt(h.store, eid)
            .map((p) => ({
              teamNumber: p.teamNumber,
              robotName: p.robotName || '',
              weightLbs: p.weightLbs || 0,
              launcherType: p.launcherType || '',
              photoKeys: [...(p.photoKeys || [])].sort(),
              isDeleted: Boolean(p.isDeleted)
            }))
            .sort((a, b) => a.teamNumber - b.teamNumber),
          teamTags: readTeamTagsFromCrdt(h.store, eid)
            .map((tg) => ({ teamNumber: tg.teamNumber, tag: tg.tag }))
            .sort((a, b) => a.teamNumber - b.teamNumber || a.tag.localeCompare(b.tag)),
          schedules: readSchedulesFromCrdt(h.store, eid)
            .map((s) => ({
              matchNumber: s.matchNumber,
              tournamentLevel: s.tournamentLevel || 'QUALIFICATION',
              red1: s.red1,
              red2: s.red2,
              blue1: s.blue1,
              blue2: s.blue2
            }))
            .sort((a, b) => a.tournamentLevel.localeCompare(b.tournamentLevel) || a.matchNumber - b.matchNumber),
          assignments: Object.values(readAssignmentsFromCrdt(h.store, eid))
            .map((a) => ({
              matchNumber: a.matchNumber,
              tournamentLevel: a.tournamentLevel || 'QUALIFICATION',
              station: a.station,
              teamNumber: a.teamNumber,
              scoutId: a.scoutId || null,
              scoutName: a.scoutName || null
            }))
            .sort(
              (a, b) =>
                a.tournamentLevel.localeCompare(b.tournamentLevel) ||
                a.matchNumber - b.matchNumber ||
                a.station.localeCompare(b.station)
            ),
          conflicts: Array.from(recordStore.conflictCoords).sort()
        }
      },
      updatePitFields: async (teamNumber: number, patch: Record<string, any>) => {
        const eid = activeCrdtEventId || eventId.value
        pitStore.currentEventId = eid
        const existing = pitStore.records.find((r) => r.teamNumber === Number(teamNumber))
        const base: import('@/types').PitScoutingRecord = {
          id: existing?.id || `${eid}_pit_${teamNumber}`,
          eventId: eid,
          teamNumber: Number(teamNumber),
          scoutId: userStore.userId || existing?.scoutId || '',
          scoutName: userStore.username || existing?.scoutName || '',
          robotName: existing?.robotName ?? '',
          drivetrainType: existing?.drivetrainType || 'mecanum',
          weightLbs: existing?.weightLbs ?? 0,
          chassisSize: existing?.chassisSize ?? '',
          ballCompatibility: existing?.ballCompatibility || 'universal',
          launcherType: existing?.launcherType ?? '',
          flowerMechanism: existing?.flowerMechanism ?? '',
          hasColorSensor: Boolean(existing?.hasColorSensor),
          hasDescoreMech: Boolean(existing?.hasDescoreMech),
          hasApriltagVision: Boolean(existing?.hasApriltagVision),
          odometryType: existing?.odometryType || 'none',
          claimedAutoStrategy: existing?.claimedAutoStrategy ?? '',
          claimedAutoScore: existing?.claimedAutoScore ?? 0,
          claimedTeleopCycles: existing?.claimedTeleopCycles ?? 0,
          claimedTeleopScore: existing?.claimedTeleopScore ?? 0,
          claimedTeleopPark: Boolean(existing?.claimedTeleopPark),
          claimedFlowerNectars: existing?.claimedFlowerNectars ?? 0,
          claimedFlowerBottomBonus: existing?.claimedFlowerBottomBonus ?? 0,
          claimedFlowerPollens: existing?.claimedFlowerPollens ?? 0,
          claimedGardenBalls: existing?.claimedGardenBalls ?? 0,
          claimedEndgameScore: existing?.claimedEndgameScore ?? 0,
          claimedTotalScore: existing?.claimedTotalScore ?? 0,
          photoKeys: existing?.photoKeys ? [...existing.photoKeys] : [],
          version: existing?.version ?? 1,
          isDeleted: Boolean(existing?.isDeleted)
        }
        await pitStore.saveRecord({ ...base, ...patch, eventId: eid, teamNumber: Number(teamNumber) })
      },
      addTag: async (teamNumber: number, tag: string, color = 'blue') =>
        await recordStore.addTag(activeCrdtEventId || eventId.value, Number(teamNumber), tag, color, false),
      removeTag: async (teamNumber: number, tag: string) =>
        await recordStore.removeTag(activeCrdtEventId || eventId.value, Number(teamNumber), tag),
      assignMatchScout: async (
        matchNumber: number,
        station: import('@/types').StationType,
        teamNumber: number,
        scoutId: string,
        scoutName: string
      ) => {
        const eid = activeCrdtEventId || eventId.value
        scheduleStore.currentEventId = eid
        if (!scheduleStore.schedules.some((s) => s.matchNumber === Number(matchNumber))) {
          await scheduleStore
            .importSchedules(
              eid,
              [
                {
                  id: `${eid}_M${matchNumber}`,
                  eventId: eid,
                  matchNumber: Number(matchNumber),
                  tournamentLevel: 'QUALIFICATION',
                  red1: station === 'red1' ? Number(teamNumber) : 0,
                  red2: station === 'red2' ? Number(teamNumber) : 0,
                  blue1: station === 'blue1' ? Number(teamNumber) : 0,
                  blue2: station === 'blue2' ? Number(teamNumber) : 0,
                  scoreRedFinal: null,
                  scoreBlueFinal: null
                }
              ],
              false,
              true
            )
            .catch(() => {})
        }
        await scheduleStore.assignStation(eid, Number(matchNumber), station, scoutId, scoutName, true, 'QUALIFICATION')
      },
      exportOfflineSyncPackage: async () => {
        const { createSyncPackage } = await import('@/utils/offlineSync')
        const evt = event.value || eventStore.currentEvent
        const eid = activeCrdtEventId || eventId.value
        const h = getExistingEventCrdt(eid)
        return createSyncPackage({
          packetType: eventStore.isHost ? 'HOST_BROADCAST' : 'CLIENT_PUSH',
          eventId: eid,
          eventName: evt?.ftcEventCode || evt?.name || eid,
          sender: {
            userId: userStore.userId,
            username: userStore.username,
            role: eventStore.isHost ? 'HOST' : 'SCOUT'
          },
          target: {
            recipientType: eventStore.isHost ? 'ALL_SCOUTS' : 'HOST'
          },
          records: recordStore.records.filter((r) => r.eventId === eid),
          teamTags: recordStore.teamTags.filter((tg) => tg.eventId === eid),
          fromHostSeq: 0,
          toHostSeq: 0,
          crdtSnapshot: h?.store.getMergeableContent()
        })
      },
      importOfflineSyncPackage: async (rawText: string, fileName = 'sync.info') => {
        const { scanFilesAndFolders, executeBatchSyncImport } = await import('@/utils/offlineSync')
        const { getOrCreateEventCrdt } = await import('@/services/crdt')
        const eid = activeCrdtEventId || eventId.value
        const file = new File([rawText], fileName, { type: 'application/json' })
        const scanResult = await scanFilesAndFolders([file], eid)
        return await executeBatchSyncImport({
          scanResult,
          targetEventId: eid,
          isHost: Boolean(eventStore.isHost && !connStore.isStandbyHost),
          events: eventStore.events,
          bulkSync: recordStore.bulkSync,
          persistRecordsToDb: async (recs) => {
            if (!eventStore.isHost || connStore.isStandbyHost) return
            await syncRecords(recs)
          },
          markSynced: recordStore.markSynced,
          applyTagsFullSync: recordStore.applyTagsFullSync,
          applyScheduleFullSync: scheduleStore.applyScheduleFullSync,
          syncExternalEvent: eventStore.syncExternal,
          applyCrdtSnapshot: (snap) => getOrCreateEventCrdt(eid).persistence.applyMergeableSnapshot(snap, true)
        })
      },
      sendPoisonedFutureHlcFrame: async (futureYears = 10) => {
        const rtc = connStore.rtcService
        if (!rtc) throw new Error('No active WebRTC service')
        const { createMergeableStore } = await import('tinybase')
        const eid = activeCrdtEventId || eventId.value
        const h = getExistingEventCrdt(eid)
        const evt = event.value || eventStore.currentEvent
        const futureMs = (h ? h.clock.now() : Date.now()) + Number(futureYears) * 365 * 24 * 3600 * 1000
        const poisonStore = createMergeableStore('poison-peer', () => futureMs, 300)
        writePitRecordToCrdt(
          poisonStore,
          {
            id: `${eid}_pit_99999`,
            eventId: eid,
            teamNumber: 99999,
            scoutId: userStore.userId || 'poison',
            scoutName: 'Poison',
            robotName: 'Poisoned2036',
            drivetrainType: 'mecanum',
            weightLbs: 99,
            ballCompatibility: 'universal',
            launcherType: 'None',
            flowerMechanism: 'None',
            hasColorSensor: false,
            hasDescoreMech: false,
            hasApriltagVision: false,
            odometryType: 'none',
            claimedAutoStrategy: '',
            claimedAutoScore: 0,
            claimedTeleopCycles: 0,
            claimedTeleopScore: 0,
            claimedTeleopPark: false,
            claimedFlowerNectars: 0,
            claimedFlowerBottomBonus: 0,
            claimedFlowerPollens: 0,
            claimedGardenBalls: 0,
            claimedEndgameScore: 0,
            claimedTotalScore: 0,
            photoKeys: [],
            version: 1,
            isDeleted: false
          },
          { syncPhotoKeys: false }
        )
        const snap = poisonStore.getMergeableContent()
        await rtc.sendMessage({
          type: 'CRDT_SYNC_MSG',
          eventId: eid,
          fromClientId: 'poison-peer',
          toClientId: 'host',
          requestId: null,
          message: 3,
          body: [snap[0], snap[1], 1],
          authCode: evt?.inviteCode
        })
      },
      sendForgedRecordAttacks: async (targetScoutId: string, legitRecordOverride?: ScoutingRecord) => {
        const rtc = connStore.rtcService
        if (!rtc) throw new Error('No active WebRTC service')
        const { createMergeableStore } = await import('tinybase')
        const { generateEcdsaKeyPair, exportEcdsaPublicKey, signDataEcdsa } = await import('@/utils/crypto')
        const eid = activeCrdtEventId || eventId.value
        const h = getExistingEventCrdt(eid)
        if (!h) throw new Error('CRDT handle missing for forged attack test')
        const legitRecord =
          legitRecordOverride ||
          readScoutingRecordsFromCrdt(h.store, eid).find((r) => r.scoutId === targetScoutId && Boolean(r.authorSig))
        if (!legitRecord) {
          throw new Error(`No signed record found in local CRDT for scout ${targetScoutId}`)
        }
        const evt = event.value || eventStore.currentEvent
        const now = h.clock.now() + 250

        // Attack 1: Tamper totalScore while keeping legitRecord's original ECDSA signature
        const tamperStore = createMergeableStore('e2e-tamper', () => now, 300)
        writeScoutingRecordToCrdt(tamperStore, {
          ...legitRecord,
          id: 'rec-attack-tampered',
          eventId: eid,
          totalScore: 9999
        })
        const snap1 = tamperStore.getMergeableContent()
        await rtc.sendMessage({
          type: 'CRDT_SYNC_MSG',
          eventId: eid,
          fromClientId: 'e2e-tamper',
          toClientId: 'host',
          requestId: null,
          message: 3,
          body: [snap1[0], snap1[1], 1],
          authCode: evt?.inviteCode
        })

        // Attack 2: Generate a rogue ECDSA keypair, claim scoutId=targetScoutId and self-sign
        const rogueKp = await generateEcdsaKeyPair()
        const roguePubHex = await exportEcdsaPublicKey(rogueKp.publicKey)
        const forgedRec: ScoutingRecord = {
          ...legitRecord,
          id: 'rec-attack-rogue',
          eventId: eid,
          scoutId: targetScoutId,
          matchNumber: 88,
          teamNumber: 8888,
          totalScore: 8888,
          authorPubKey: roguePubHex,
          authorSig: ''
        }
        forgedRec.authorSig = await signDataEcdsa(rogueKp.privateKey, buildRecordCanonicalPayload(forgedRec))

        const rogueStore = createMergeableStore('e2e-rogue', () => now + 50, 300)
        writeMemberIdentityToCrdt(rogueStore, {
          eventId: eid,
          userId: targetScoutId,
          deviceId: 'dev_rogue_e2e',
          signingPubKeyHex: roguePubHex,
          trustedAt: now
        })
        writeScoutingRecordToCrdt(rogueStore, forgedRec)
        const snap2 = rogueStore.getMergeableContent()
        await rtc.sendMessage({
          type: 'CRDT_SYNC_MSG',
          eventId: eid,
          fromClientId: 'e2e-rogue',
          toClientId: 'host',
          requestId: null,
          message: 3,
          body: [snap2[0], snap2[1], 1],
          authCode: evt?.inviteCode
        })
      }
    }
  }

  async function migrateBridgeCrdtId(oldId: string, newId: string, inviteCode?: string): Promise<void> {
    if (!oldId || !newId || oldId === newId) return
    const wasOpen = Array.from(openCrdtPeers)
    crdtUnbind?.()
    crdtUnbind = null
    if (crdtHub) {
      await crdtHub.destroy()
      crdtHub = null
    }
    await migrateEventCrdtId(oldId, newId, { inviteCode })
    const curEvt = event.value || eventStore.currentEvent
    const session = await hydrateAndBindEventCrdt({
      eventId: newId,
      inviteCode,
      userId: userStore.userId,
      eventHostId: curEvt?.hostId,
      getHostEpoch: () => connStore.rtcService?.getHostEpoch?.() || 1,
      isDesktopHost: isDesktopHost() && !isMobileDevice(),
      stores: { pitStore, scheduleStore, customFieldsStore, recordStore }
    })
    await recordStore.reSignEventAuthorRecords?.(newId)
    activeCrdtEventId = newId
    crdtUnbind = session.unbind
    crdtHub = createHubForHandle(session.handle)
    publishE2eBridge()
    if (wasOpen.length > 0) {
      setCrdtTransportActive(newId, true)
      for (const peerId of wasOpen) {
        void crdtHub.attachPeer(peerId, { awaitInitialSync: false })
      }
    }
  }

  async function disposeEventCrdtSession(): Promise<void> {
    const eid = activeCrdtEventId || eventId.value
    openCrdtPeers.clear()
    crdtUnbind?.()
    crdtUnbind = null
    if (crdtHub) {
      await crdtHub.destroy()
      crdtHub = null
    }
    if (eid) {
      setCrdtTransportActive(eid, false)
      if (isDesktopHost() && !isMobileDevice()) {
        await getExistingEventCrdt(eid)?.flushNow().catch(() => {})
      }
      await disposeEventCrdt(eid)
    }
    activeCrdtEventId = ''
    if (typeof window !== 'undefined') {
      delete (window as any).__sp27E2eBridge
    }
  }

  async function migrateEventScopedState(oldId: string, newId: string, inviteCode?: string): Promise<void> {
    recordStore.migrateEventId(oldId, newId)
    pitStore.migrateEventId(oldId, newId)
    scheduleStore.migrateEventId(oldId, newId)
    customFieldsStore.migrateEventId?.(oldId, newId)
    migrateClockAnchor(oldId, newId)
    if (inviteCode) {
      migrateClockAnchor(inviteCode, newId)
    }
    await migrateBridgeCrdtId(oldId, newId, inviteCode)
  }

  async function promoteWitnessMetadataIfNeeded(witness: EventEpochWitnessRecord) {
    if (!witness || !witness.authoritativeEventId || isPlaceholderEventId(witness.authoritativeEventId)) {
      return
    }
    const curEvt = event.value || eventStore.currentEvent
    const curId = (router.currentRoute.value.params.eventId as string) || curEvt?.id || eventId.value
    const upperCode = (witness.inviteCode || curEvt?.inviteCode || '').trim().toUpperCase()
    if (!upperCode || (curEvt?.inviteCode && curEvt.inviteCode.trim().toUpperCase() !== upperCode)) {
      return
    }
    const canUpgradeClientToHost = (targetHostId?: string): boolean => {
      const rtc = connStore.rtcService
      if (!rtc || isPromotingToHost || rtcStartedAsHost) return false
      const isStandby = Boolean(
        connStore.isStandbyHost ||
        (typeof rtc.isStandbyHost === 'function' && rtc.isStandbyHost())
      )
      if (isStandby) return false
      return Boolean(
        isDesktopHost() &&
          !isMobileDevice() &&
          targetHostId &&
          targetHostId === userStore.userId &&
          !rtc.isHostMode() &&
          connStore.status !== 'connected'
      )
    }

    const alreadyAuthoritative = !isPlaceholderEventId(curId) && curId === witness.authoritativeEventId
    const needsHostModeUpgrade = canUpgradeClientToHost(witness.hostUserId)
    if (alreadyAuthoritative && !needsHostModeUpgrade) {
      return
    }

    let actualEvent: ScoutingEvent =
      alreadyAuthoritative && curEvt && curEvt.hostId === witness.hostUserId
        ? curEvt
        : {
            id: witness.authoritativeEventId,
            name: witness.eventName || curEvt?.name || `Event ${upperCode}`,
            inviteCode: upperCode,
            hostId: witness.hostUserId || curEvt?.hostId || 'external_host',
            ftcYear: witness.ftcYear ?? curEvt?.ftcYear,
            ftcEventCode: witness.ftcEventCode ?? curEvt?.ftcEventCode
          }

    if (!alreadyAuthoritative || curEvt?.hostId !== actualEvent.hostId) {
      try {
        const { syncExternalEvent } = await import('@/services/api')
        const synced = await syncExternalEvent(actualEvent)
        if (synced && synced.id) {
          actualEvent = synced
        }
      } catch {}

      eventStore.migratePlaceholder(curId, actualEvent)
      connStore.rtcService?.setEventMetadata(actualEvent)
      if (curId && actualEvent.id && curId !== actualEvent.id) {
        await migrateEventScopedState(curId, actualEvent.id, upperCode)
        await router.replace({
          path: `/event/${actualEvent.id}`,
          query: router.currentRoute.value.query
        })
      }
    }

    if (canUpgradeClientToHost(actualEvent.hostId)) {
      isPromotingToHost = true
      try {
        cleanupWebRTC()
        await setupWebRTC()
      } finally {
        isPromotingToHost = false
      }
    }
  }

  function advanceLastHostSeq(incomingRecords: ScoutingRecord[]) {
    const validSeqs = incomingRecords
      .map((r) => r.hostSeq)
      .filter((s): s is number => typeof s === 'number' && Number.isFinite(s) && s > 0)
    if (validSeqs.length > 0) {
      const maxIncoming = validSeqs.reduce((max, s) => Math.max(max, s), 0)
      if (maxIncoming > lastHostSeq.value) {
        lastHostSeq.value = maxIncoming
      }
    }
  }

  function initHostSeqCounter() {
    // 计算数据库和内存中已持久化记录的最大 hostSeq（限定当前赛事）
    const dbMaxSeq = recordStore.records
      .filter((r) => r.eventId === eventId.value)
      .reduce((m, r) => Math.max(m, r.hostSeq || 0), 0)

    // Host：从已持久化记录的最大 hostSeq 恢复计数器，保证重启后单调递增
    if (eventStore.isHost) {
      connStore.initHostSeq(dbMaxSeq)
    } else {
      // Client：多层兜底初始化 lastHostSeq，防止本地缓存缺失导致游标归零
      const localStored = parseInt(localStorage.getItem(lastHostSeqKey.value) ?? '0') || 0
      lastHostSeq.value = Math.max(dbMaxSeq, localStored)
    }
  }

  async function setupWebRTC() {
    if (!userStore.isLoggedIn || !userStore.user?.token) {
      router.replace('/')
      return
    }
    const evt = event.value || eventStore.currentEvent
    if (!evt) return

    if (!crdtHub && evt.id) {
      const existingHandle = getExistingEventCrdt(evt.id)
      if (existingHandle) {
        activeCrdtEventId = evt.id
        crdtHub = createHubForHandle(existingHandle)
      }
    }

    const rtcCallbacks: WebRtcCallbacks = {
      getCurrentUser: () => ({ userId: userStore.userId, username: userStore.username }),
      getMaxKnownHlcPt: () => {
        const h = getExistingEventCrdt(activeCrdtEventId || eventId.value)
        return h ? extractMaxHlcPtFromSnapshot(h.store.getMergeableContent()) : 0
      },
      onCrdtSyncMessage: (senderPeerId, msg) => {
        openCrdtPeers.add(senderPeerId)
        if (!crdtHub) return
        setCrdtTransportActive(activeCrdtEventId || eventId.value, true)
        if (!crdtHub.getAttachedPeers().includes(senderPeerId)) {
          void crdtHub.attachPeer(senderPeerId, { awaitInitialSync: false })
        }
        crdtHub.handleIncomingMessage(senderPeerId, msg)
      },
      onPeerDataChannelOpen: (peerId) => {
        openCrdtPeers.add(peerId)
        if (!crdtHub) return
        setCrdtTransportActive(activeCrdtEventId || eventId.value, true)
        void crdtHub.attachPeer(peerId, { awaitInitialSync: false })
      },
      onPeerDataChannelClose: (peerId) => {
        openCrdtPeers.delete(peerId)
        if (openCrdtPeers.size === 0 && (activeCrdtEventId || eventId.value)) {
          setCrdtTransportActive(activeCrdtEventId || eventId.value, false)
        }
        void crdtHub?.detachPeer(peerId)
      },
      onStatusChange: (s) => connStore.setStatus(s),

      // 返回真正被接受的记录，Host 端用此打 hostSeq + 广播
      onRecordsReceived: async (records: ScoutingRecord[], senderId?: string): Promise<ScoutingRecord[]> => {
        const accepted = await recordStore.bulkSync(records)
        if (!eventStore.isHost || connStore.isStandbyHost) {
          advanceLastHostSeq(records)
        }
        if (accepted.length > 0) {
          const first = accepted[0]
          if (accepted.length === 1 && first) {
            toastStore.showToast(
              t('webrtc.single_record_received', {
                team: first.teamNumber,
                match: first.matchNumber
              }),
              'info'
            )
          } else {
            toastStore.showToast(
              t('webrtc.batch_records_received', {
                count: accepted.length
              }),
              'info'
            )
          }
        }
        return accepted
      },

      // Host 回传的 ACK 内含 stamped 记录，Client 用此更新本地 hostSeq + lastHostSeq
      onAckReceived: (ids: string[], stampedRecords?: ScoutingRecord[], rejectedRecordIds?: string[]) => {
        const rejectedSet = new Set(rejectedRecordIds || [])
        const acceptedIds = ids.filter((id) => !rejectedSet.has(id))
        if (acceptedIds.length > 0) {
          recordStore.markSynced(acceptedIds)
        }
        if (stampedRecords && stampedRecords.length > 0 && (!eventStore.isHost || connStore.isStandbyHost)) {
          for (const stamped of stampedRecords) {
            const local = recordStore.records.find((r) => r.id === stamped.id)
            if (local && stamped.hostSeq) {
              local.hostSeq = stamped.hostSeq
            }
          }
          advanceLastHostSeq(stampedRecords)
          syncRecords(stampedRecords).catch((err) => {
            console.warn('[EventView] Failed to persist ack stamped records to local DB:', err)
          })
        }
      },

      // Host 收到增量请求，根据 sinceVersion 过滤记录（严格限定当前赛事）
      onRequestSync: (sinceVersion: number, senderId?: string) => {
        if (isCrdtTransportActive(activeCrdtEventId || eventId.value)) {
          return
        }
        const eventRecords = recordStore.records.filter((r) => r.eventId === eventId.value)
        const recordsToSync =
          sinceVersion > 0
            ? eventRecords.filter((r) => (r.hostSeq || 0) > sinceVersion)
            : eventRecords // sinceVersion=0 → 全量同步当前赛事记录
        if (recordsToSync.length > 0) {
          connStore.pushRecords(recordsToSync, senderId)
        }
      },

      onTagUpdateReceived: (tag, action, eventIdVal) => {
        const curId = eventStore.currentEvent?.id
        const isMatch =
          eventIdVal === curId ||
          (Boolean(curId) &&
            Boolean(eventIdVal) &&
            (curId!.startsWith('evt-') ||
              curId!.startsWith('EXT_') ||
              eventIdVal.startsWith('evt-') ||
              eventIdVal.startsWith('EXT_')))
        if (isMatch) {
          recordStore.applyTagUpdate(tag, action)
        }
      },

      onRequestTagsSync: (senderId) => {
        if (eventStore.currentEvent?.id && connStore.rtcService) {
          connStore.rtcService.sendTagsFullSync(recordStore.teamTags, eventStore.currentEvent.id, senderId)
        }
      },

      onTagsFullSyncReceived: (tags, eventIdVal) => {
        const curId = eventStore.currentEvent?.id
        const isMatch =
          eventIdVal === curId ||
          (Boolean(curId) &&
            Boolean(eventIdVal) &&
            (curId!.startsWith('evt-') ||
              curId!.startsWith('EXT_') ||
              eventIdVal.startsWith('evt-') ||
              eventIdVal.startsWith('EXT_')))
        if (isMatch) {
          recordStore.applyTagsFullSync(tags)
        }
      },

      onRequestScheduleSync: async (senderId) => {
        try {
          if (eventStore.isHost && connStore.rtcService) {
            const allSchedules = scheduleStore.schedules
            const allAssignments = Object.values(scheduleStore.assignments)
            const CHUNK_SIZE = 20
            if (allSchedules.length <= CHUNK_SIZE) {
              await connStore.rtcService.sendMessage(
                {
                  type: 'SCHEDULE_FULL_SYNC',
                  schedules: allSchedules,
                  assignments: allAssignments
                },
                senderId
              )
            } else {
              const totalBatches = Math.ceil(allSchedules.length / CHUNK_SIZE)
              const syncId = `sched-${Date.now()}`
              const allMatchNums = new Set(allSchedules.map((s) => Number(s.matchNumber)))
              for (let i = 0; i < totalBatches; i++) {
                const batchSchedules = allSchedules.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
                const batchMatchNums = new Set(batchSchedules.map((s) => Number(s.matchNumber)))
                const batchAssignments =
                  i === totalBatches - 1
                    ? allAssignments.filter(
                        (a) => batchMatchNums.has(Number(a.matchNumber)) || !allMatchNums.has(Number(a.matchNumber))
                      )
                    : allAssignments.filter((a) => batchMatchNums.has(Number(a.matchNumber)))

                await connStore.rtcService.sendMessage(
                  {
                    type: 'SCHEDULE_BATCH_SYNC',
                    batchIndex: i,
                    totalBatches,
                    schedules: batchSchedules,
                    assignments: batchAssignments,
                    syncId
                  },
                  senderId
                )
              }
            }
          }
        } catch (err) {
          console.warn('[EventView] Failed to respond to onRequestScheduleSync:', err)
        }
      },

      onScheduleFullSyncReceived: (incomingSchedules, incomingAssignments) => {
        scheduleStore.applyScheduleFullSync(incomingSchedules, incomingAssignments)
      },

      onScheduleBatchSyncReceived: (incomingSchedules, incomingAssignments, batchIndex, totalBatches) => {
        scheduleStore.applyScheduleBatchSync(incomingSchedules, incomingAssignments, batchIndex, totalBatches)
      },

      onAssignmentUpdateReceived: (incomingAssignment) => {
        scheduleStore.applyAssignmentUpdate(incomingAssignment)
      },

      onPitScoutUpdateReceived: (incomingRecord) => {
        pitStore.applyRemoteUpdate(incomingRecord)
      },

      onPitScoutBatchSyncReceived: (incomingRecords) => {
        pitStore.applyFullSync(incomingRecords)
        if (eventStore.isHost && eventStore.currentEvent?.id) {
          syncPitRecordsBatch(eventStore.currentEvent.id, incomingRecords).catch((e) => {
            console.warn('[Host] Failed to persist remote pit batch to DB:', e)
          })
        }
      },

      onPitScoutAckReceived: (teamNumbers) => {
        pitStore.markSynced(teamNumbers)
      },

      onPitScoutFullSyncReceived: (incomingRecords) => {
        pitStore.applyFullSync(incomingRecords)
      },

      onRequestPitSync: async (senderId) => {
        try {
          if (eventStore.isHost && connStore.rtcService) {
            const allRecords = pitStore.records
            const CHUNK_SIZE = 15
            if (allRecords.length <= CHUNK_SIZE) {
              await connStore.rtcService.sendMessage(
                {
                  type: 'PIT_SCOUT_FULL_SYNC',
                  records: allRecords
                },
                senderId
              )
            } else {
              for (let i = 0; i < allRecords.length; i += CHUNK_SIZE) {
                const chunk = allRecords.slice(i, i + CHUNK_SIZE)
                await connStore.rtcService.sendMessage(
                  {
                    type: 'PIT_SCOUT_BATCH_SYNC',
                    records: chunk
                  },
                  senderId
                )
              }
            }
          }
        } catch (err) {
          console.warn('[EventView] Failed to respond to onRequestPitSync:', err)
        }
      },

      onOfficialRosterSyncReceived: (incomingTeams) => {
        pitStore.applyOfficialRosterSync(incomingTeams)
      },

      onRequestCustomFieldsSync: (senderId) => {
        try {
          if (eventStore.isHost && connStore.rtcService && eventStore.currentEvent?.id) {
            connStore.rtcService.sendMessage(
              {
                type: 'CUSTOM_FIELDS_FULL_SYNC',
                eventId: eventStore.currentEvent.id,
                fields: customFieldsStore.getFields(eventStore.currentEvent.id)
              },
              senderId
            ).catch((err: any) => {
              console.warn('[EventView] Failed to send custom fields full sync:', err)
            })
          }
        } catch (err) {
          console.warn('[EventView] Failed to respond to onRequestCustomFieldsSync:', err)
        }
      },

      onCustomFieldsFullSyncReceived: (incomingFields, eventIdVal) => {
        const targetId = eventIdVal || eventStore.currentEvent?.id
        if (targetId) {
          customFieldsStore.applyFullSync(targetId, incomingFields)
        }
      },

      onCustomFieldUpdateReceived: (field, action, eventIdVal) => {
        const targetId = eventIdVal || eventStore.currentEvent?.id
        if (targetId) {
          customFieldsStore.applyRemoteUpdate(targetId, field, action)
        }
      },

      onClientConnected: (userId: string, userName: string) => {
        const initialTransport = connStore.rtcService?.getScoutTransportInfo?.(userId) ?? null
        connStore.addConnectedScout(userId, userName, initialTransport)
        if (connStore.rtcService) {
          inboxStore.flushOutbox(connStore.rtcService, userId)
        }
        const currentEventId = eventStore.currentEvent?.id || eventId.value
        if (currentEventId && userId) {
          saveKnownScout(currentEventId, { id: userId, name: userName, lastSeen: Date.now() })
          if (!syncedMemberIds.has(userId) && eventStore.isHost) {
            syncedMemberIds.add(userId)
            addEventMember(currentEventId, userId, userName).catch((err) => {
              console.warn(`[WebRTC Bridge] Failed to persist member ${userId} to backend:`, err)
              syncedMemberIds.delete(userId)
            })
          }
        }
      },

      onSessionConflict: (
        conflictingUsername: string,
        conflictingUserId: string,
        rejected?: boolean,
        conflictType?: 'SAME_USER' | 'DUPLICATE_NAME',
        suggestedName?: string
      ) => {
        connStore.setSessionConflict({
          conflictingUsername,
          conflictingUserId,
          rejected,
          conflictType,
          suggestedName
        })
      },

      onTakeoverPrompt: (requesterUsername: string, timeoutSeconds: number) => {
        connStore.setTakeoverPrompt({ requesterUsername, timeoutSeconds })
      },

      onTakeoverSuccess: () => {
        connStore.clearSessionConflict()
        toastStore.showToast(t('conflict.takeover_success') || '会话接管成功！', 'success')
      },

      isConflictActive: () => Boolean(connStore.sessionConflict),

      onSessionKicked: (reason: string) => {
        connStore.setIsKicked({ reason })
        connStore.setStatus('offline')
        const msg = reason === 'TAKEOVER_TIMEOUT' ? t('kicked.timeout_msg') : t('kicked.permit_msg')
        toastStore.showError(msg)
      },

      onIdentityMigration: async (eventIdVal: string, oldScoutId: string, newScoutId: string, newScoutName: string) => {
        recordStore.migrateScoutId(oldScoutId, newScoutId, newScoutName)
        scheduleStore.migrateScoutId(oldScoutId, newScoutId, newScoutName)
        pitStore.migrateScoutId(oldScoutId, newScoutId, newScoutName)
        if (eventStore.isHost) {
          try {
            const { migrateScoutRecords } = await import('@/services/api')
            await migrateScoutRecords(eventIdVal, oldScoutId, newScoutId, newScoutName)
          } catch (e) {
            console.warn('[Host] Failed to migrate scout records in DB:', e)
          }
        }
      },

      onEventMetadataReceived: async (eventMeta: ScoutingEvent) => {
        if (!eventMeta || !eventMeta.id) {
          console.warn('[EventView] Received invalid empty event metadata:', eventMeta)
          return
        }
        let actualEvent = eventMeta
        try {
          const { syncExternalEvent } = await import('@/services/api')
          const synced = await syncExternalEvent(eventMeta)
          if (synced && typeof synced === 'object' && !Array.isArray(synced) && synced.id) {
            actualEvent = synced
          }
        } catch (e) {
          console.warn('[EventView] Failed to sync external event metadata:', e)
        }

        const currentRouteEventId = router.currentRoute.value.params.eventId as string
        const upperRouteId = (currentRouteEventId || '').trim().toUpperCase()
        const upperInviteCode = (actualEvent.inviteCode || '').trim().toUpperCase()

        if (upperInviteCode && actualEvent.id && !isPlaceholderEventId(actualEvent.id)) {
          saveEpochWitnessRecord({
            inviteCode: upperInviteCode,
            authoritativeEventId: actualEvent.id,
            eventName: actualEvent.name || '',
            hostUserId: actualEvent.hostId || '',
            ftcYear: actualEvent.ftcYear,
            ftcEventCode: actualEvent.ftcEventCode
          })
        }
        connStore.rtcService?.setEventMetadata(actualEvent)

        const isEphemeralPlaceholder = Boolean(
          upperRouteId &&
          upperInviteCode &&
          (
            (!isDesktopHost() && upperRouteId === `EVT-${upperInviteCode}`) ||
            upperRouteId === `EXT_${upperInviteCode}`
          )
        )

        if (isEphemeralPlaceholder && currentRouteEventId) {
          eventStore.migratePlaceholder(currentRouteEventId, actualEvent)
        } else {
          eventStore.setCurrentEvent(actualEvent)
          const existingIdx = eventStore.events.findIndex((e) => e.id === actualEvent.id)
          if (existingIdx >= 0) {
            eventStore.events[existingIdx] = actualEvent
          } else {
            eventStore.events.push(actualEvent)
          }
        }

        // 核心修复：当以临时占位 ID (如手机端 evt-CODE 或跨机端 ext_CODE) 访问且收到了 Host 下发的权威元数据时，升迁临时 ID 并重推待同步数据
        if (actualEvent.id && isEphemeralPlaceholder && actualEvent.id !== currentRouteEventId) {
          console.log(`[EventView] Migrating temporary event ID "${currentRouteEventId}" to authoritative UUID "${actualEvent.id}"`)
          await migrateEventScopedState(currentRouteEventId, actualEvent.id, upperInviteCode)
          try {
            const oldSeq = parseInt(localStorage.getItem(`sp27_lastHostSeq_${currentRouteEventId}`) ?? '0', 10) || 0
            const newSeq = parseInt(localStorage.getItem(`sp27_lastHostSeq_${actualEvent.id}`) ?? '0', 10) || 0
            const mergedSeq = Math.max(lastHostSeq.value, oldSeq, newSeq)
            if (mergedSeq > 0) {
              localStorage.setItem(`sp27_lastHostSeq_${actualEvent.id}`, String(mergedSeq))
              lastHostSeq.value = mergedSeq
            }
          } catch {}
          try {
            const { migrateMobilePhotosEventId } = await import('@/services/mobilePhotoCache')
            await migrateMobilePhotosEventId(currentRouteEventId, actualEvent.id)
          } catch {}
          await router.replace({
            path: `/event/${actualEvent.id}`,
            query: router.currentRoute.value.query
          })
          // 若刚在 2 秒内执行过首次连接同步流水线，仅需针对新权威 UUID 刷新自定义字段与标签，避免重复拉取全量比赛记录
          if (Date.now() - lastSyncPipelineTriggeredAt < 2000) {
            customFieldsStore.fetchFields(actualEvent.id).catch(() => {})
            connStore.rtcService?.requestTagsSync(actualEvent.id).catch(() => {})
          } else {
            void triggerClientSyncPipeline(false)
          }
        }
      },

      onClientDisconnected: (userId: string) => {
        connStore.removeConnectedScout(userId)
      },

      onScoutTransportInfoChanged: (userId: string, info) => {
        connStore.setScoutTransportInfo(userId, info)
      },

      onTransportInfoChanged: (info) => {
        connStore.setTransportInfo(info)
      },

      onSasVerificationRequired: (peer, fingerprint) => {
        // 次主机（Standby Host）为后台镜像，连接活跃主机时通过密码学基线信任静默放行，不弹窗中断
        if (connStore.isStandbyHost) {
          return
        }
        connStore.setPendingSas({
          peerId: peer.peerId,
          username: peer.username,
          ecdhPublicKey: peer.ecdhPublicKey,
          fingerprint
        })
      },

      onSasVerified: (peerId?: string) => {
        connStore.clearPendingSas(peerId)
        toastStore.showToast(t('connection.sas_verified_toast'), 'success')
      },

      onSasRejected: (peerId?: string, reason?: string) => {
        connStore.clearPendingSas(peerId)
        toastStore.showToast(t('event.sas_rejected_toast', { reason: reason || '' }), 'warning')
      },

      onIceStalled: (isStalled) => {
        connStore.setIsIceStalled(isStalled)
      },

      onHostStandby: (info) => {
        connStore.setStandbyHost(true, info)
        toastStore.showToast(t('event.standby_host_toast'), 'info')
      },

      onHostPromoted: () => {
        connStore.setStandbyHost(false)
        wasActiveHostBeforeDemotion.value = false
        const dbMaxSeq = recordStore.records
          .filter((r) => r.eventId === eventId.value)
          .reduce((m, r) => Math.max(m, r.hostSeq || 0), 0)
        connStore.initHostSeq(Math.max(dbMaxSeq, lastHostSeq.value))

        // 升迁为主机后，若 CRDT 传输未激活，按旧通道向所有 Peer 广播最新排班、标签与自定义字段基准包
        const promotedEvId = eventStore.currentEvent?.id || ''
        if (
          connStore.rtcService &&
          promotedEvId &&
          !isCrdtTransportActive(promotedEvId) &&
          connStore.rtcService.getDataChannel()?.readyState === 'open'
        ) {
          const evId = promotedEvId
          const allSchedules = scheduleStore.schedules
          const allAssignments = Object.values(scheduleStore.assignments)
          const CHUNK_SIZE = 20
          if (allSchedules.length <= CHUNK_SIZE) {
            connStore.rtcService.sendMessage({
              type: 'SCHEDULE_FULL_SYNC',
              schedules: allSchedules,
              assignments: allAssignments
            })
          } else {
            const totalBatches = Math.ceil(allSchedules.length / CHUNK_SIZE)
            const syncId = `sched-${Date.now()}`
            const allMatchNums = new Set(allSchedules.map((s) => Number(s.matchNumber)))
            for (let i = 0; i < totalBatches; i++) {
              const batchSchedules = allSchedules.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
              const batchMatchNums = new Set(batchSchedules.map((s) => Number(s.matchNumber)))
              const batchAssignments =
                i === totalBatches - 1
                  ? allAssignments.filter(
                      (a) => batchMatchNums.has(Number(a.matchNumber)) || !allMatchNums.has(Number(a.matchNumber))
                    )
                  : allAssignments.filter((a) => batchMatchNums.has(Number(a.matchNumber)))

              connStore.rtcService.sendMessage({
                type: 'SCHEDULE_BATCH_SYNC',
                batchIndex: i,
                totalBatches,
                schedules: batchSchedules,
                assignments: batchAssignments,
                syncId
              })
            }
          }
          connStore.rtcService.sendTagsFullSync(recordStore.teamTags, evId)
          connStore.rtcService.sendMessage({
            type: 'CUSTOM_FIELDS_FULL_SYNC',
            eventId: evId,
            fields: customFieldsStore.getFields(evId)
          })
        }
        toastStore.showToast(t('event.host_activated'), 'success')
      },

      onHostDemoted: (info?: { hostSessionId: string; hostDeviceId?: string }) => {
        connStore.setStandbyHost(true, info)
        wasActiveHostBeforeDemotion.value = true
        toastStore.showToast(t('event.demoted_to_standby'), 'warning')
      },

      onHostHandoffReceived: async (batch) => {
        console.log(`[EventView] Processing onHostHandoffReceived: ${batch.records?.length || 0} records`)
        if (Array.isArray(batch.schedules) && Array.isArray(batch.assignments)) {
          scheduleStore.applyScheduleFullSync(batch.schedules, batch.assignments)
        }
        if (Array.isArray(batch.pitRecords)) {
          pitStore.applyFullSync(batch.pitRecords)
        }
        if (Array.isArray(batch.teamTags) && batch.eventId) {
          recordStore.applyTagsFullSync(batch.teamTags)
        }
        if (Array.isArray(batch.customFields) && batch.eventId) {
          customFieldsStore.applyFullSync(batch.eventId, batch.customFields)
        }
        toastStore.showToast(t('event.handoff_received_toast'), 'success')
        return batch.records?.length || 0
      },

      onHostHandoffAck: (ack) => {
        console.log('[EventView] Host handoff acknowledged by active host:', ack)
      },

      onActiveHostLeft: () => {
        connStore.setTransportInfo(null)
        if (connStore.isStandbyHost) {
          connStore.setStatus('degraded')
          toastStore.showToast(t('event.host_exited_takeover_available'), 'warning', 7000)
        } else {
          connStore.setStatus('offline')
          toastStore.showToast(t('event.host_left'), 'info')
        }
      },

      onHostDisconnected: () => {
        connStore.setTransportInfo(null)
        connStore.setStatus('degraded')
      },

      onWitnessMetadataDiscovered: async (witness: EventEpochWitnessRecord) => {
        await promoteWitnessMetadataIfNeeded(witness)
      },

      onEpochWitnessUpdated: (witness: EventEpochWitnessRecord) => {
        void promoteWitnessMetadataIfNeeded(witness)
      }
    }

    const isSameEvent = eventStore.currentEvent?.id === eventId.value
    const isServiceAlive =
      Boolean(connStore.rtcService) &&
      isSameEvent &&
      connStore.status !== 'offline' &&
      connStore.status !== 'long_offline'

    // 若当前已有存活且处于活动连接态的 rtcService（如从队伍详情等同赛事子页面返回），保持长连接无需重建
    if (isServiceAlive && connStore.rtcService) {
      connStore.rtcService.updateCallbacks?.(rtcCallbacks)
      if (typeof window !== 'undefined') {
        ;(window as any).__sendDirectMessage = (targetId: string, title: string, body: string) => {
          return inboxStore.sendDirectMessage({ targetId, title, body }, connStore.rtcService!)
        }
      }
      publishE2eBridge()
      return
    }

    if (connStore.rtcService) {
      cleanupWebRTC()
    }

    const rtc = createWebRtcService(rtcCallbacks)
    connStore.setRtcService(rtc)
    if (typeof window !== 'undefined') {
      ;(window as any).__sendDirectMessage = (targetId: string, title: string, body: string) => {
        return inboxStore.sendDirectMessage({ targetId, title, body }, rtc)
      }
    }
    publishE2eBridge()

    try {
      const shouldHost = Boolean(
        isDesktopHost() &&
        !isMobileDevice() &&
        (
          eventStore.isHost ||
          evt.hostId === userStore.userId ||
          (connStore.rtcService && typeof connStore.rtcService.isHostMode === 'function' && connStore.rtcService.isHostMode())
        )
      )
      if (shouldHost) {
        rtcStartedAsHost = true
        await rtc.host(evt.inviteCode, evt, userStore.username, userStore.userId)
      } else {
        rtcStartedAsHost = false
        await rtc.join(evt.inviteCode, userStore.username, userStore.userId)
      }
    } catch {
      // WebRTC may not always succeed; app remains usable offline
      connStore.setStatus('offline')
    }
  }

  watch(
    () => connStore.status,
    async (status, oldStatus) => {
      const evt = eventStore.currentEvent
      console.log(`[EventView] connStore.status changed: ${oldStatus} -> ${status}`)

      if (status === 'connected' && evt) {
        if (connStore.rtcService) {
          inboxStore.flushOutbox(connStore.rtcService)
        }

        if (connStore.isStandbyHost && wasActiveHostBeforeDemotion.value) {
          if (isCrdtTransportActive(evt.id) || getExistingEventCrdt(evt.id)) {
            console.log('[EventView] Standby host reconnected to new host; CRDT synchronizer handles delta merge.')
            wasActiveHostBeforeDemotion.value = false
          } else {
            // 旧主控降级后连通新主控（仅兼容旧协议）：主动触发全量资产交接 (HOST_HANDOFF_BATCH)
            console.log('[EventView] Standby host reconnected to new host, initiating HOST_HANDOFF_BATCH...')
            const eventRecords = recordStore.records.filter((r) => r.eventId === evt.id)
            const maxDbSeq = eventRecords.reduce((m, r) => Math.max(m, r.hostSeq || 0), 0)
            const curCounter = connStore.rtcService?.getHostSeqCounter?.() || 0
            const outgoingMaxSeq = Math.max(maxDbSeq, curCounter, lastHostSeq.value)

            await connStore.rtcService?.sendHostHandoffBatch({
              eventId: evt.id,
              incomingMaxSeq: outgoingMaxSeq,
              hostEpoch: 0,
              records: eventRecords,
              schedules: scheduleStore.schedules,
              assignments: Object.values(scheduleStore.assignments),
              pitRecords: pitStore.records.filter((r) => r.eventId === evt.id),
              teamTags: recordStore.teamTags.filter((t) => t.eventId === evt.id),
              customFields: customFieldsStore.getFields(evt.id),
              senderUserId: userStore.userId
            })
            wasActiveHostBeforeDemotion.value = false
            toastStore.showToast(t('event.handoff_sent_toast'), 'info')
          }
        }

        if (!eventStore.isHost) {
          const curHostSessionId =
            connStore.rtcService?.getCurrentHostSessionId?.() ||
            connStore.standbyHostInfo?.hostSessionId ||
            ''
          const isHostTakeover = Boolean(
            lastConnectedHostSessionId.value &&
              curHostSessionId &&
              curHostSessionId !== lastConnectedHostSessionId.value
          )
          if (curHostSessionId) {
            lastConnectedHostSessionId.value = curHostSessionId
          }

          if (connStore.sessionConflict) {
            console.warn('[EventView] Connected but session conflict is active; suspending auto-sync pipeline until resolved.')
            return
          }

          await triggerClientSyncPipeline(isHostTakeover)
        } else {
          // Host 连通或恢复后，同样主动巡检照片队列
          flushOfflinePhotos(evt.id)
        }
      }
    }
  )

  async function triggerClientSyncPipeline(isHostTakeover = false) {
    const evt = eventStore.currentEvent
    if (!evt || eventStore.isHost) return
    if (connStore.sessionConflict) {
      console.warn('[EventView] Connected but session conflict is active; suspending auto-sync pipeline until resolved.')
      return
    }
    const now = Date.now()
    if (!isHostTakeover && now - lastSyncPipelineTriggeredAt < 1200) {
      return
    }
    lastSyncPipelineTriggeredAt = now

    // Client 连接／重连：按序发起同步流水线，避免并发数据风暴
    connStore.requestSync(
      isHostTakeover ? 0 : lastHostSeq.value,
      undefined,
      userStore.userId,
      userStore.username,
      userStore.token,
      { isHostTakeover, clientMaxSeq: lastHostSeq.value }
    )

    if (!isCrdtTransportActive(evt.id)) {
      // 核心自愈（仅兼容旧协议）：若发生主机切换，即使此前已标记为 SYNCED 也重推属于自己的记录，确保新主机不漏历史打分；常规重连推送 PENDING 及未获 Host 签发的未打号记录
      const myRecs = recordStore.records.filter(
        (r) =>
          r.eventId === evt.id &&
          r.scoutId === userStore.userId &&
          (isHostTakeover || r.syncStatus === 'PENDING' || !r.hostSeq)
      )
      if (myRecs.length > 0) {
        console.log(`[EventView] Auto self-healing: pushing ${myRecs.length} unconfirmed/pending records to host...`)
        await connStore.pushRecords(myRecs).catch((err) => {
          console.warn('[EventView] Failed to auto-push pending records:', err)
        })
      }
    }

    // 移动端重连核心自愈 1：主动出清离线期间录入的 Pit 展位记录
    try {
      await pitStore.flushPendingPitRecords(evt.id)
    } catch (e) {
      console.warn('[EventView] Failed to flush pending pit records:', e)
    }

    // 移动端重连核心自愈 2：主动出清离线照片队列，确保特写照片落盘到 Host
    flushOfflinePhotos(evt.id)

    // 顺序向 Host 请求最新的赛程与排班、展位侦察记录、以及战队标签
    // （当 CRDT 同步通道激活时由 TinyBase 增量协议接管，仅在旧连接兼容模式下发 Legacy REQUEST_* 包）
    if (connStore.rtcService) {
      if (isCrdtTransportActive(evt.id) && crdtHub) {
        void crdtHub.triggerFullSyncWithPeer('host')
      } else {
        try {
          await connStore.rtcService.sendMessage({
            type: 'REQUEST_SCHEDULE_SYNC'
          })
        } catch (e) {
          console.warn('[EventView] Failed to request schedule sync:', e)
        }
        try {
          await connStore.rtcService.sendMessage({
            type: 'REQUEST_PIT_SYNC'
          })
        } catch (e) {
          console.warn('[EventView] Failed to request pit sync:', e)
        }
        try {
          await connStore.rtcService.sendMessage({
            type: 'REQUEST_CUSTOM_FIELDS_SYNC',
            eventId: evt.id
          })
        } catch (e) {
          console.warn('[EventView] Failed to request custom fields sync:', e)
        }
        customFieldsStore.fetchFields(evt.id).catch((e: any) => {
          console.warn('[EventView] Failed to fetch custom fields:', e)
        })
        connStore.rtcService.requestTagsSync(evt.id).catch((e: any) => {
          console.warn('[EventView] Failed to request tags sync:', e)
        })
      }
    }
  }

  watch(
    () => connStore.sessionConflict,
    async (conflict, oldConflict) => {
      // 当冲突被解决（从存在冲突变为 null）且当前已连通时，唤醒此前暂停的同步流水线
      if (oldConflict && !conflict && connStore.status === 'connected' && !eventStore.isHost) {
        console.log('[EventView] Session conflict resolved, resuming auto-sync pipeline...')
        await triggerClientSyncPipeline(false)
      }
    }
  )

  function cleanupWebRTC() {
    rtcStartedAsHost = false
    openCrdtPeers.clear()
    const crdtEid = activeCrdtEventId || eventId.value
    if (crdtEid) {
      setCrdtTransportActive(crdtEid, false)
    }
    if (crdtHub) {
      void crdtHub.destroy()
      crdtHub = null
    }
    connStore.rtcService?.disconnect()
    connStore.setRtcService(null)
    connStore.clearConnectedScouts()
    connStore.setStandbyHost(false)
    wasActiveHostBeforeDemotion.value = false
    lastConnectedHostSessionId.value = ''
    connStore.setStatus('offline')
    syncedMemberIds.clear()
  }

  function handleBeforeUnload() {
    if (eventStore.isHost) {
      connStore.rtcService?.disconnect()
    }
  }

  return {
    lastHostSeq,
    advanceLastHostSeq,
    initHostSeqCounter,
    initEventCrdt,
    disposeEventCrdtSession,
    setupWebRTC,
    cleanupWebRTC,
    handleBeforeUnload
  }
}
