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
import { createWebRtcService, type WebRtcCallbacks } from '@/services/webrtc'
import { syncRecords, syncPitRecordsBatch, savePitRecord } from '@/services/api'
import { flushOfflinePhotos, isDesktopHost } from '@/services/photoStorage'
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

    const rtcCallbacks: WebRtcCallbacks = {
      getCurrentUser: () => ({ userId: userStore.userId, username: userStore.username }),
      onStatusChange: (s) => connStore.setStatus(s),

      // 返回真正被接受的记录，Host 端用此打 hostSeq + 广播
      onRecordsReceived: async (records: ScoutingRecord[], senderId?: string): Promise<ScoutingRecord[]> => {
        const accepted = await recordStore.bulkSync(records)
        if (!eventStore.isHost || connStore.isStandbyHost) {
          advanceLastHostSeq(records)
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
        if (eventIdVal === eventStore.currentEvent?.id) {
          recordStore.applyTagUpdate(tag, action)
        }
      },

      onRequestTagsSync: (senderId) => {
        if (eventStore.currentEvent?.id && connStore.rtcService) {
          connStore.rtcService.sendTagsFullSync(recordStore.teamTags, eventStore.currentEvent.id, senderId)
        }
      },

      onTagsFullSyncReceived: (tags, eventIdVal) => {
        if (eventIdVal === eventStore.currentEvent?.id) {
          recordStore.applyTagsFullSync(tags)
        }
      },

      onRequestScheduleSync: (senderId) => {
        if (eventStore.isHost && connStore.rtcService) {
          connStore.rtcService.sendMessage(
            {
              type: 'SCHEDULE_FULL_SYNC',
              schedules: scheduleStore.schedules,
              assignments: Object.values(scheduleStore.assignments)
            },
            senderId
          )
        }
      },

      onScheduleFullSyncReceived: (incomingSchedules, incomingAssignments) => {
        scheduleStore.applyScheduleFullSync(incomingSchedules, incomingAssignments)
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

      onRequestPitSync: (senderId) => {
        if (eventStore.isHost && connStore.rtcService) {
          connStore.rtcService.sendMessage(
            {
              type: 'PIT_SCOUT_FULL_SYNC',
              records: pitStore.records
            },
            senderId
          )
        }
      },

      onOfficialRosterSyncReceived: (incomingTeams) => {
        pitStore.applyOfficialRosterSync(incomingTeams)
      },

      onRequestCustomFieldsSync: (senderId) => {
        if (eventStore.isHost && connStore.rtcService && eventStore.currentEvent?.id) {
          connStore.rtcService.sendMessage(
            {
              type: 'CUSTOM_FIELDS_FULL_SYNC',
              eventId: eventStore.currentEvent.id,
              fields: customFieldsStore.getFields(eventStore.currentEvent.id)
            },
            senderId
          )
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
        connStore.addConnectedScout(userId, userName)
        if (connStore.rtcService) {
          inboxStore.flushOutbox(connStore.rtcService, userId)
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
        const isEphemeralPlaceholder = Boolean(
          !isDesktopHost() &&
          currentRouteEventId &&
          actualEvent.inviteCode &&
          currentRouteEventId.toUpperCase() === `EVT-${actualEvent.inviteCode.toUpperCase()}`
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

        // 核心修复 Bug 2：仅当手机端以临时占位 ID (如 evt-INVITECODE) 访问且收到了 Host 下发的权威元数据时，才升迁临时 ID
        if (actualEvent.id && isEphemeralPlaceholder && actualEvent.id !== currentRouteEventId) {
          console.log(`[EventView] Migrating temporary mobile event ID "${currentRouteEventId}" to authoritative UUID "${actualEvent.id}"`)
          recordStore.migrateEventId(currentRouteEventId, actualEvent.id)
          pitStore.migrateEventId(currentRouteEventId, actualEvent.id)
          scheduleStore.migrateEventId(currentRouteEventId, actualEvent.id)
          router.replace({
            path: `/event/${actualEvent.id}`,
            query: router.currentRoute.value.query
          })
        }
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

        // 升迁为主机后，主动向所有 Peer 广播最新排班、标签与自定义字段基准包
        if (connStore.rtcService && eventStore.currentEvent?.id) {
          const evId = eventStore.currentEvent.id
          connStore.rtcService.sendMessage({
            type: 'SCHEDULE_FULL_SYNC',
            schedules: scheduleStore.schedules,
            assignments: Object.values(scheduleStore.assignments)
          })
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

    try {
      const shouldHost = Boolean(
        eventStore.isHost ||
        (isDesktopHost() && evt.hostId === userStore.userId) ||
        (connStore.rtcService && typeof connStore.rtcService.isHostMode === 'function' && connStore.rtcService.isHostMode())
      )
      if (shouldHost) {
        await rtc.host(evt.inviteCode, evt, userStore.username, userStore.userId)
      } else {
        await rtc.join(evt.inviteCode, userStore.username, userStore.userId)
      }
    } catch {
      // WebRTC may not always succeed; app remains usable offline
      connStore.setStatus('offline')
    }
  }

  watch(
    () => connStore.status,
    (status, oldStatus) => {
      const evt = eventStore.currentEvent
      console.log(`[EventView] connStore.status changed: ${oldStatus} -> ${status}`)

      if (status === 'connected' && evt) {
        if (connStore.rtcService) {
          inboxStore.flushOutbox(connStore.rtcService)
        }

        if (connStore.isStandbyHost && wasActiveHostBeforeDemotion.value) {
          // 旧主控降级后连通新主控：主动触发全量资产交接 (HOST_HANDOFF_BATCH)
          console.log('[EventView] Standby host reconnected to new host, initiating HOST_HANDOFF_BATCH...')
          const eventRecords = recordStore.records.filter((r) => r.eventId === evt.id)
          const maxDbSeq = eventRecords.reduce((m, r) => Math.max(m, r.hostSeq || 0), 0)
          const curCounter = connStore.rtcService?.getHostSeqCounter?.() || 0
          const outgoingMaxSeq = Math.max(maxDbSeq, curCounter, lastHostSeq.value)

          connStore.rtcService?.sendHostHandoffBatch({
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

          // Client 连接／重连：若为主机接管则以 sinceVersion=0 全量对齐最新基线；否则按 lastHostSeq 增量对齐
          connStore.requestSync(
            isHostTakeover ? 0 : lastHostSeq.value,
            undefined,
            userStore.userId,
            userStore.username,
            userStore.token,
            { isHostTakeover, clientMaxSeq: lastHostSeq.value }
          )

          // 核心自愈：若发生主机切换，即使此前已标记为 SYNCED 也重推属于自己的记录，确保新主机不漏历史打分；常规重连只推 PENDING
          const myRecs = recordStore.records.filter(
            (r) =>
              r.eventId === evt.id &&
              r.scoutId === userStore.userId &&
              (isHostTakeover || r.syncStatus === 'PENDING')
          )
          if (myRecs.length > 0) {
            connStore.pushRecords(myRecs)
          }

          // 移动端重连核心自愈 1：主动出清离线期间录入的 Pit 展位记录
          pitStore.flushPendingPitRecords(evt.id)

          // 移动端重连核心自愈 2：主动出清离线照片队列，确保特写照片落盘到 Host
          flushOfflinePhotos(evt.id)

          // 向 Host 请求最新的赛程与排班、展位侦察记录、以及战队标签
          if (connStore.rtcService) {
            connStore.rtcService.sendMessage({
              type: 'REQUEST_SCHEDULE_SYNC'
            })
            connStore.rtcService.sendMessage({
              type: 'REQUEST_PIT_SYNC'
            })
            connStore.rtcService.sendMessage({
              type: 'REQUEST_CUSTOM_FIELDS_SYNC',
              eventId: evt.id
            })
            customFieldsStore.fetchFields(evt.id).catch((e: any) => {
              console.warn('[EventView] Failed to fetch custom fields:', e)
            })
            connStore.rtcService.requestTagsSync(evt.id).catch((e: any) => {
              console.warn('[EventView] Failed to request tags sync:', e)
            })
          }
        } else {
          // Host 连通或恢复后，同样主动巡检照片队列
          flushOfflinePhotos(evt.id)
        }
      }
    }
  )

  function cleanupWebRTC() {
    connStore.rtcService?.disconnect()
    connStore.setRtcService(null)
    connStore.clearConnectedScouts()
    connStore.setStandbyHost(false)
    wasActiveHostBeforeDemotion.value = false
    lastConnectedHostSessionId.value = ''
    connStore.setStatus('offline')
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
    setupWebRTC,
    cleanupWebRTC,
    handleBeforeUnload
  }
}
