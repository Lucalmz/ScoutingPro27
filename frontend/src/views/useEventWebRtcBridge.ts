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
import { createWebRtcService, type WebRtcCallbacks } from '@/services/webrtc'
import { syncRecords, syncPitRecordsBatch, savePitRecord } from '@/services/api'
import { flushOfflinePhotos } from '@/services/photoStorage'
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
  const toastStore = useToastStore()

  // Client 端：持久化最后一次从 Host 收到的最大 hostSeq，用于重连后增量请求
  // 按 eventId 分筒，避免不同赛事之间混淆
  const lastHostSeqKey = computed(() => `sp27_lastHostSeq_${eventId.value}`)
  const lastHostSeq = ref<number>(0)
  watch(lastHostSeq, (v) => localStorage.setItem(lastHostSeqKey.value, String(v)))

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
    const evt = eventStore.currentEvent
    if (!evt) return

    const rtcCallbacks: WebRtcCallbacks = {
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
        try {
          const { syncExternalEvent } = await import('@/services/api')
          const synced = await syncExternalEvent(eventMeta)
          if (synced) {
            eventStore.currentEvent = synced
          }
        } catch (e) {
          console.warn('[EventView] Failed to sync external event metadata:', e)
        }
      },

      onTransportInfoChanged: (info) => {
        connStore.setTransportInfo(info)
      },

      onSasVerificationRequired: (peer, fingerprint) => {
        connStore.setPendingSas({
          peerId: peer.peerId,
          username: peer.username,
          ecdhPublicKey: peer.ecdhPublicKey,
          fingerprint
        })
      },

      onSasVerified: () => {
        connStore.clearPendingSas()
      },

      onSasRejected: (peerId, reason) => {
        connStore.clearPendingSas()
        toastStore.showError(`检测到安全码不匹配或已切断连接: ${reason || ''}`)
      },

      onIceStalled: (isStalled) => {
        connStore.setIsIceStalled(isStalled)
      },

      onHostStandby: (info) => {
        connStore.setStandbyHost(true, info)
        toastStore.showToast('检测到当前赛事已有活跃主机，本机已自动进入【备用监控模式】', 'info')
      },

      onHostPromoted: () => {
        connStore.setStandbyHost(false)
        const dbMaxSeq = recordStore.records
          .filter((r) => r.eventId === eventId.value)
          .reduce((m, r) => Math.max(m, r.hostSeq || 0), 0)
        connStore.initHostSeq(Math.max(dbMaxSeq, lastHostSeq.value))
        toastStore.showToast('本机已成功激活/接管为主机 (Active Host)', 'success')
      },

      onHostDemoted: (info?: { hostSessionId: string; hostDeviceId?: string }) => {
        connStore.setStandbyHost(true, info)
        toastStore.showToast('收到其他设备接管通知，本机已平滑退位为【备用监控端】', 'warning')
      },

      onActiveHostLeft: () => {
        if (connStore.isStandbyHost) {
          toastStore.showToast('主控设备已退出，本机作为备用端可立即一键接管为主机', 'warning', 7000)
        } else {
          toastStore.showToast('赛事主控设备已退出房间', 'info')
        }
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
      if (eventStore.isHost) {
        await rtc.host(evt.inviteCode, evt)
      } else {
        await rtc.join(evt.inviteCode)
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

        if (!eventStore.isHost) {
          // Client 连接／重连：用 lastHostSeq 做增量请求（=0 时全量）
          connStore.requestSync(
            lastHostSeq.value,
            undefined,
            userStore.userId,
            userStore.username,
            userStore.token
          )

          // 只推送本地尚未同步到 Host 的记录
          const myRecs = recordStore.myRecords(userStore.userId).filter((r) => r.syncStatus === 'PENDING')
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
            connStore.rtcService.requestTagsSync(evt.id).catch((e) => {
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
