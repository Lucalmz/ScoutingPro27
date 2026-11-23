import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import {
  listRecords,
  saveRecord,
  syncRecords,
  markRecordsSynced,
  isStaticCloudHost,
  fetchBannedTeams as apiFetchBannedTeams,
  banTeam as apiBanTeam,
  unbanTeam as apiUnbanTeam,
  fetchEventTags as apiFetchEventTags,
  addTeamTag as apiAddTeamTag,
  deleteTeamTag as apiDeleteTeamTag
} from '@/services/api'
import { fetchEventMatches, fetchEventAdvancement } from '@/services/ftcApi'
import { useInboxStore } from '@/stores/inbox'
import { useToastStore } from '@/stores/toast'
import type { ScoutingRecord, RankingRow, OfficialMatch, TeamTagItem, AdvancementDetail } from '@/types'
import { calculateScoutReliability, calculateRankings } from '@/utils/analytics/rankings'
import { buildAdvancementMap } from '@/utils/analytics/advancement'
import { calculateMatchDiscrepancies, type MatchDiscrepancy } from '@/utils/analytics/audit'
import { i18n } from '@/i18n'
import {
  getExistingEventCrdt,
  isCrdtTransportActive,
  normalizeTagName,
  readScoutingRecordsFromCrdt,
  readTeamTagsFromCrdt,
  setTeamTagActive,
  signScoutingRecordWithDeviceKey,
  teamTagRowId,
  withLocalCrdtWrite,
  writeScoutingRecordToCrdt,
  writeTeamTagToCrdt
} from '@/services/crdt'

function loadFromStorage<T>(key: string, defaultVal: T): T {
  try {
    const item = localStorage.getItem(key)
    return item ? JSON.parse(item) : defaultVal
  } catch (e) {
    console.error(`Failed to parse ${key} from localStorage`, e)
    return defaultVal
  }
}
import { getRecordTournamentLevel, getTournamentLevelOrder } from '@/utils/tournament'
export { getRecordTournamentLevel, getTournamentLevelOrder }

export const useRecordStore = defineStore('records', () => {
  const records = ref<ScoutingRecord[]>(loadFromStorage('scoutingpro_records', []))
  const officialMatches = ref<OfficialMatch[]>(loadFromStorage('scoutingpro_officialMatches', []))
  const bannedTeams = ref<number[]>(loadFromStorage('scoutingpro_bannedTeams', []))
  const teamTags = ref<TeamTagItem[]>(loadFromStorage('scoutingpro_tags', []))
  const officialAdvancement = ref<AdvancementDetail[]>(loadFromStorage('scoutingpro_advancement', []))
  const currentEventId = ref<string | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  const advancementMap = computed(() => buildAdvancementMap(officialAdvancement.value))

  const currentRecords = computed(() => {
    if (!currentEventId.value) return records.value
    return records.value.filter(r => r.eventId === currentEventId.value)
  })

  function saveToStorage(key: string, val: any) {
    try {
      localStorage.setItem(key, JSON.stringify(val))
    } catch (e) {
      console.error(`Failed to save ${key} to localStorage (Quota exceeded?)`, e)
      error.value = 'Local storage quota exceeded. Please clear some space.'
      if (typeof window !== 'undefined') {
        try {
          useToastStore().showToast(i18n.global.t('toast.storage_quota_exceeded'), 'error')
        } catch {}
      }
    }
  }

  function flushStorage() {
    saveToStorage('scoutingpro_records', records.value)
    saveToStorage('scoutingpro_officialMatches', officialMatches.value)
    saveToStorage('scoutingpro_advancement', officialAdvancement.value)
    saveToStorage('scoutingpro_bannedTeams', bannedTeams.value)
    saveToStorage('scoutingpro_tags', teamTags.value)
  }

  // Debounced watch
  let saveTimeout: any = null
  watch([records, officialMatches, officialAdvancement, bannedTeams, teamTags], () => {
    if (saveTimeout) clearTimeout(saveTimeout)
    saveTimeout = setTimeout(() => {
      flushStorage()
      saveTimeout = null
    }, 500)
  }, { deep: true })

  window.addEventListener('beforeunload', () => {
    if (saveTimeout) {
      clearTimeout(saveTimeout)
      flushStorage()
    }
  })

  // Cross-tab sync
  window.addEventListener('storage', (e) => {
    if (e.key === 'scoutingpro_records' && e.newValue) {
      try {
        const parsed = JSON.parse(e.newValue)
        if (Array.isArray(parsed)) {
          bulkSync(parsed)
        }
      } catch {}
    } else if (e.key === 'scoutingpro_officialMatches' && e.newValue) {
      try { officialMatches.value = JSON.parse(e.newValue) } catch {}
    } else if (e.key === 'scoutingpro_advancement' && e.newValue) {
      try { officialAdvancement.value = JSON.parse(e.newValue) } catch {}
    } else if (e.key === 'scoutingpro_bannedTeams' && e.newValue) {
      try { bannedTeams.value = JSON.parse(e.newValue) } catch {}
    } else if (e.key === 'scoutingpro_tags' && e.newValue) {
      try { teamTags.value = JSON.parse(e.newValue) } catch {}
    }
  })


  const scoutReliability = computed<Record<string, 'low' | 'high'>>(() =>
    calculateScoutReliability(currentRecords.value, officialMatches.value)
  )

  // --- official score discrepancy audit ---
  const matchDiscrepancies = computed<MatchDiscrepancy[]>(() =>
    calculateMatchDiscrepancies(currentRecords.value, officialMatches.value)
  )

  const top5Discrepancies = computed<MatchDiscrepancy[]>(() =>
    matchDiscrepancies.value.slice(0, 5)
  )

  // --- computed rankings ---
  const rankings = computed<RankingRow[]>(() =>
    calculateRankings(currentRecords.value, officialMatches.value, scoutReliability.value, advancementMap.value)
  )

  // --- active (non-deleted) records ---
  const activeRecords = computed(() => currentRecords.value.filter((r) => !r.isDeleted))

  // --- records for the current user ---
  const myRecords = computed(() => {
    return (scoutId: string) => currentRecords.value.filter((r) => r.scoutId === scoutId && !r.isDeleted)
  })

  // --- pending records ---
  const pendingRecords = computed(() =>
    records.value.filter((r) => r.syncStatus === 'PENDING'),
  )

  function purgeExpiredTombstones() {
    const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000
    records.value = records.value.filter(r => {
      if (r.isDeleted && new Date(r.updatedAt).getTime() < fourteenDaysAgo) {
        return false
      }
      return true
    })
  }

  // --- fetch ---
  async function fetchRecords(eventId: string, ftcYear?: number, ftcEventCode?: string) {
    const isSwitchingEvent = currentEventId.value !== eventId
    loading.value = true
    error.value = null
    currentEventId.value = eventId
    if (isSwitchingEvent) {
      officialMatches.value = []
      officialAdvancement.value = []
      bannedTeams.value = []
    }
    try {
      const fetched = await listRecords(eventId)
      // 旧数据升迁：version 缺失的记录赋为 1，避免被 version=0 的传入覆盖
      const fetchedNormalized = fetched.map(r => ({ ...r, version: r.version || 1 }))

      // 3-way Guarded Merge：合并 local 缓存/内存记录与后端拉取到的记录，防止刷新页面时对端记录或未推送变更被清空
      const currentForEvent = records.value.filter(r => r.eventId === eventId)
      const currentMap = new Map<string, ScoutingRecord>(currentForEvent.map(r => [r.id, r]))
      const mergedMap = new Map<string, ScoutingRecord>()

      for (const f of fetchedNormalized) {
        const cur = currentMap.get(f.id)
        if (!cur) {
          mergedMap.set(f.id, f)
        } else {
          if (cur.syncStatus === 'PENDING' && (cur.version || 0) > (f.version || 0)) {
            mergedMap.set(f.id, cur)
          } else if ((f.version || 0) > (cur.version || 0)) {
            mergedMap.set(f.id, f)
          } else if ((f.version || 0) === (cur.version || 0)) {
            if (f.updatedAt && cur.updatedAt && new Date(f.updatedAt) >= new Date(cur.updatedAt)) {
              mergedMap.set(f.id, f)
            } else {
              mergedMap.set(f.id, cur)
            }
          } else {
            mergedMap.set(f.id, cur)
          }
        }
      }

      // 保留当前内存中已有但本地 DB 尚未返回的记录（如通过 CRDT 接收且含作者 ECDSA 签名的对端记录）
      const unpersistedToSync: ScoutingRecord[] = []
      for (const cur of currentMap.values()) {
        if (!mergedMap.has(cur.id)) {
          mergedMap.set(cur.id, cur)
          if (cur.authorPubKey && cur.authorSig) {
            unpersistedToSync.push(cur)
          }
        }
      }

      const otherEventsRecords = records.value.filter(r => r.eventId !== eventId)
      records.value = [...otherEventsRecords, ...Array.from(mergedMap.values())]

      purgeExpiredTombstones()

      if (unpersistedToSync.length > 0) {
        syncRecords(unpersistedToSync).catch(err => {
          console.warn('[fetchRecords] Failed to auto-persist cached stamped records:', err)
        })
      }
      if (ftcYear && ftcEventCode) {
        const [matches, adv] = await Promise.all([
          fetchEventMatches(ftcYear, ftcEventCode),
          fetchEventAdvancement(ftcYear, ftcEventCode).catch(() => [])
        ])
        officialMatches.value = matches
        officialAdvancement.value = adv
        flushStorage()
      } else {
        officialMatches.value = []
        officialAdvancement.value = []
        flushStorage()
      }
      bannedTeams.value = await apiFetchBannedTeams(eventId).catch(() => [])
    } catch (e: any) {
      error.value = e.message ?? 'Failed to load records'
    } finally {
      loading.value = false
    }
  }

  const notifiedConflictCoords = new Set<string>()

  const conflictCoords = computed<Set<string>>(() => {
    const map = new Map<string, Set<string>>()
    for (const r of records.value) {
      if (r.isDeleted) continue
      const key = `${r.eventId || ''}:${getRecordTournamentLevel(r)}:${r.matchNumber}:${r.teamNumber}`
      let scouts = map.get(key)
      if (!scouts) {
        scouts = new Set<string>()
        map.set(key, scouts)
      }
      scouts.add(r.scoutId || '')
    }
    const out = new Set<string>()
    for (const [k, scouts] of map.entries()) {
      if (scouts.size > 1) out.add(k)
    }
    return out
  })

  /**
   * Pure derived conflict evaluation: updates in-memory display `isConflict` flags without
   * mutating untouched records' `version`, `updatedAt`, `syncStatus`, or broadcasting them.
   * Returns newly conflicted coordinate keys not yet alerted in Inbox.
   */
  function refreshDerivedConflictsLocal(targetEventId?: string): string[] {
    const coordScouts = new Map<string, Set<string>>()
    for (const r of records.value) {
      if (r.isDeleted) continue
      if (targetEventId && r.eventId !== targetEventId) continue
      const key = `${r.eventId || ''}:${getRecordTournamentLevel(r)}:${r.matchNumber}:${r.teamNumber}`
      let set = coordScouts.get(key)
      if (!set) {
        set = new Set<string>()
        coordScouts.set(key, set)
      }
      set.add(r.scoutId || '')
    }

    const newlyConflicted = new Set<string>()
    for (const r of records.value) {
      if (targetEventId && r.eventId !== targetEventId) continue
      const key = `${r.eventId || ''}:${getRecordTournamentLevel(r)}:${r.matchNumber}:${r.teamNumber}`
      const isMultiScout = !r.isDeleted && (coordScouts.get(key)?.size ?? 0) > 1
      if (Boolean(r.isConflict) !== isMultiScout) {
        r.isConflict = isMultiScout
      }
      if (isMultiScout && !notifiedConflictCoords.has(key)) {
        notifiedConflictCoords.add(key)
        newlyConflicted.add(key)
      } else if (!isMultiScout && notifiedConflictCoords.has(key)) {
        notifiedConflictCoords.delete(key)
      }
    }
    return Array.from(newlyConflicted)
  }

  function emitInboxAlertsForConflictCoords(coordKeys: string[]): void {
    for (const key of coordKeys) {
      const parts = key.split(':')
      const evId = parts[0] || ''
      const level = parts[1] || 'QUALIFICATION'
      const matchStr = parts[2] || '0'
      const teamStr = parts[3] || '0'
      try {
        useInboxStore().addMessage({
          title: i18n.global.t('toast.conflict_detected_title', { match: matchStr, team: teamStr }),
          body: i18n.global.t('toast.conflict_detected_body'),
          type: 'conflict',
          conflictMatchNumber: Number(matchStr),
          conflictTeamNumber: Number(teamStr),
          conflictTournamentLevel: level,
          eventId: evId
        })
      } catch (e) {
        console.warn('[RecordStore] Failed to post conflict message to inbox:', e)
      }
    }
  }

  // --- save a new record locally ---
  async function addRecord(record: ScoutingRecord): Promise<{ success: boolean, recordsToPush: ScoutingRecord[] }> {
    const idx = records.value.findIndex(r => r.id === record.id)

    // 用户显式编辑永远更新时间戳和状态
    record.updatedAt = new Date().toISOString()
    record.syncStatus = 'PENDING'
    record.version = (record.version || 0) + 1  // 每次编辑递增版本号

    if (idx >= 0) {
      records.value[idx] = record
    } else {
      records.value.push(record)
    }

    refreshDerivedConflictsLocal(record.eventId)
    const recordsToPush: ScoutingRecord[] = [record]

    await signScoutingRecordWithDeviceKey(record)

    try {
      const [{ useEventStore }, { useConnectionStore }] = await Promise.all([
        import('@/stores/events'),
        import('@/stores/connection')
      ])
      const eventStore = useEventStore()
      const connStore = useConnectionStore()
      const isAuthoritativeHost = Boolean(eventStore.isHost && !connStore.isStandbyHost && !isStaticCloudHost())
      const crdtHandle = record.eventId ? getExistingEventCrdt(record.eventId) : undefined
      const crdtTransportOn = Boolean(record.eventId && isCrdtTransportActive(record.eventId))

      if (isAuthoritativeHost) {
        if (crdtHandle) {
          withLocalCrdtWrite(record.eventId, () => {
            writeScoutingRecordToCrdt(crdtHandle.store, record)
          })
        }
        await saveRecord(record)
        record.syncStatus = 'SYNCED'
      } else {
        // 非主机客户端（手机端/从机/静态托管）：CRDT 传输在线或 Host 落库后标记 SYNCED；离线严格保持 PENDING
        if (crdtHandle) {
          withLocalCrdtWrite(record.eventId, () => {
            writeScoutingRecordToCrdt(crdtHandle.store, record)
          })
        }
        record.syncStatus = crdtTransportOn ? 'SYNCED' : 'PENDING'
        if (!isStaticCloudHost()) {
          try {
            await saveRecord(record)
          } catch {
            // 离线环境静默忽略，由 WebRTC / CRDT 链路接管
          }
        }
      }
      flushStorage()
      return { success: true, recordsToPush }
    } catch (e: any) {
      error.value = e.message ?? 'Failed to save record'
      const crdtHandle = record.eventId ? getExistingEventCrdt(record.eventId) : undefined
      if (crdtHandle) {
        withLocalCrdtWrite(record.eventId, () => {
          writeScoutingRecordToCrdt(crdtHandle.store, record)
        })
      }
      flushStorage()
      // It's still successfully stored locally, will be synced via WebRTC / CRDT
      return { success: true, recordsToPush }
    }
  }

  // --- soft delete (tombstone) a record ---
  async function deleteRecord(recordId: string): Promise<{ success: boolean, recordsToPush: ScoutingRecord[] }> {
    const target = records.value.find(r => r.id === recordId)
    if (!target) return { success: false, recordsToPush: [] }

    target.isDeleted = true
    target.updatedAt = new Date().toISOString()
    target.version = (target.version || 0) + 1
    target.syncStatus = 'PENDING'

    await signScoutingRecordWithDeviceKey(target)
    refreshDerivedConflictsLocal(target.eventId)
    const recordsToPush = [target]

    try {
      const [{ useEventStore }, { useConnectionStore }] = await Promise.all([
        import('@/stores/events'),
        import('@/stores/connection')
      ])
      const eventStore = useEventStore()
      const connStore = useConnectionStore()
      const isAuthoritativeHost = Boolean(eventStore.isHost && !connStore.isStandbyHost && !isStaticCloudHost())
      const crdtHandle = target.eventId ? getExistingEventCrdt(target.eventId) : undefined
      const crdtTransportOn = Boolean(target.eventId && isCrdtTransportActive(target.eventId))

      if (crdtHandle) {
        withLocalCrdtWrite(target.eventId, () => {
          writeScoutingRecordToCrdt(crdtHandle.store, target)
        })
      }
      if (isAuthoritativeHost) {
        await saveRecord(target)
        target.syncStatus = 'SYNCED'
      } else {
        target.syncStatus = crdtTransportOn ? 'SYNCED' : 'PENDING'
        if (!isStaticCloudHost()) {
          saveRecord(target).catch(() => {})
        }
      }
    } catch (e) {
      console.warn('[RecordStore] Failed to sync deleted tombstone to backend:', e)
    }

    flushStorage()
    return { success: true, recordsToPush }
  }

  function syncRecordsFromCrdt(eventId: string) {
    if (!eventId) return
    const handle = getExistingEventCrdt(eventId)
    if (!handle) return
    const crdtRecs = readScoutingRecordsFromCrdt(handle.store, eventId)
    const transportActive = isCrdtTransportActive(eventId)
    const prevStatusById = new Map<string, ScoutingRecord['syncStatus']>()
    for (const r of records.value) {
      if (!r.eventId || r.eventId === eventId) {
        prevStatusById.set(r.id, r.syncStatus)
      }
    }

    const otherEvents = records.value.filter((r) => r.eventId && r.eventId !== eventId)
    const projected = crdtRecs.map((rec) => {
      if (!transportActive && prevStatusById.get(rec.id) === 'PENDING') {
        return { ...rec, syncStatus: 'PENDING' as const }
      }
      return rec
    })
    records.value = [...otherEvents, ...projected]

    const newCoords = refreshDerivedConflictsLocal(eventId)
    emitInboxAlertsForConflictCoords(newCoords)
    flushStorage()
  }

  // --- bulk upsert from peer sync ---
  async function bulkSync(incoming: ScoutingRecord[]): Promise<ScoutingRecord[]> {
    const acceptedRecords: ScoutingRecord[] = []
    const touchedEventIds = new Set<string>()

    for (const inc of incoming) {
      const idx = records.value.findIndex((r) => r.id === inc.id)
      let savedLocal: ScoutingRecord | null = null

      if (idx >= 0) {
        const local = records.value[idx]
        if (local) {
          const incV = inc.version || 0
          const localV = local.version || 0

          const shouldAccept = incV > localV ||
            (incV === localV && inc.updatedAt > local.updatedAt)

          if (shouldAccept) {
            records.value[idx] = inc
            savedLocal = records.value[idx] ?? null
          } else if (incV === localV && inc.updatedAt === local.updatedAt && inc.syncStatus === 'SYNCED' && local.syncStatus !== 'SYNCED') {
            local.syncStatus = 'SYNCED'
            savedLocal = local
          }
        }
      } else {
        records.value.push(inc)
        savedLocal = inc
      }

      if (savedLocal) {
        acceptedRecords.push(savedLocal)
        if (savedLocal.eventId) touchedEventIds.add(savedLocal.eventId)
      }
    }

    const newCoords = refreshDerivedConflictsLocal()
    emitInboxAlertsForConflictCoords(newCoords)

    for (const eid of touchedEventIds) {
      const crdtHandle = getExistingEventCrdt(eid)
      if (crdtHandle) {
        withLocalCrdtWrite(eid, () => {
          crdtHandle.store.transaction(() => {
            for (const rec of acceptedRecords) {
              if (rec.eventId === eid) {
                writeScoutingRecordToCrdt(crdtHandle.store, rec)
              }
            }
          })
        })
      }
    }

    // 非 Host 端（Client 本地独立模式）自存自己名下产生的新记录
    const [{ useEventStore }, { useUserStore }] = await Promise.all([
      import('@/stores/events'),
      import('@/stores/user')
    ])
    const eventStore = useEventStore()
    const userStore = useUserStore()
    if (!eventStore.isHost && userStore.userId) {
      const toSync = acceptedRecords.filter(r => r.scoutId === userStore.userId || Boolean(r.authorPubKey && r.authorSig))
      if (toSync.length > 0) {
        try {
          await syncRecords(toSync)
        } catch (e: any) {
          console.warn('[bulkSync] Failed to persist records locally:', e)
        }
      }
    }

    return acceptedRecords
  }

  // --- mark records as synced locally ---
  async function markSynced(ids: string[]) {
    let changed = false
    for (const id of ids) {
      const r = records.value.find((r) => r.id === id)
      if (r && r.syncStatus !== 'SYNCED') {
        r.syncStatus = 'SYNCED'
        changed = true
      }
    }
    if (changed) {
      flushStorage()
    }
    if (!isStaticCloudHost()) {
      try {
        await markRecordsSynced(ids)
      } catch {
        // 后端更新失败不影响前端
      }
    }
  }

  // --- update a pending record (local edit) ---
  async function updateRecord(record: ScoutingRecord): Promise<{ success: boolean, recordsToPush: ScoutingRecord[] }> {
    // Re-save via the same POST endpoint (upsert by id)
    return addRecord(record)
  }

  async function banTeam(eventId: string, teamNumber: number) {
    if (!bannedTeams.value.includes(teamNumber)) {
      bannedTeams.value.push(teamNumber)
    }
    await apiBanTeam(eventId, teamNumber)
  }

  async function unbanTeam(eventId: string, teamNumber: number) {
    bannedTeams.value = bannedTeams.value.filter((num) => num !== teamNumber)
    await apiUnbanTeam(eventId, teamNumber)
  }

  // --- Custom Team Tags ---
  function syncTagsFromCrdt(eventId: string) {
    if (!eventId) return
    const handle = getExistingEventCrdt(eventId)
    if (!handle) return
    const crdtTags = readTeamTagsFromCrdt(handle.store, eventId)
    const otherEventsTags = teamTags.value.filter((t) => t.eventId !== eventId)
    teamTags.value = [...otherEventsTags, ...crdtTags]
    flushStorage()
  }

  async function fetchTags(eventId: string) {
    try {
      const tags = await apiFetchEventTags(eventId)
      if (Array.isArray(tags)) {
        teamTags.value = tags
      }
    } catch (e: any) {
      console.warn('Failed to fetch event tags from backend (using local cached tags):', e)
    }
  }

  async function addTag(
    eventId: string,
    teamNumber: number,
    tag: string,
    color?: string,
    isPreset?: boolean
  ): Promise<{ success: boolean; tag?: TeamTagItem; error?: string }> {
    const crdtHandle = getExistingEventCrdt(eventId)
    let saved: TeamTagItem
    try {
      const apiSaved = await apiAddTeamTag(eventId, teamNumber, tag, color, isPreset)
      if (!apiSaved || typeof apiSaved !== 'object' || Array.isArray(apiSaved) || !apiSaved.tag) {
        throw new Error('Static/offline tag fallback')
      }
      saved = apiSaved
    } catch (e: any) {
      if (!crdtHandle) {
        console.error('Failed to add tag:', e)
        return { success: false, error: e.message || 'Failed to add tag' }
      }
      const norm = normalizeTagName(tag) || tag.trim()
      saved = {
        id: `${eventId}_tag_${teamNumber}_${norm}`,
        eventId,
        teamNumber,
        tag: norm,
        color: ((color || 'blue') as TeamTagItem['color']),
        isPreset: Boolean(isPreset)
      }
    }

    applyTagUpdate(saved, 'ADD')
    if (crdtHandle) {
      withLocalCrdtWrite(eventId, () => {
        writeTeamTagToCrdt(crdtHandle.store, { ...saved, eventId: saved.eventId || eventId }, true)
      })
    }
    if (!isCrdtTransportActive(eventId) && !crdtHandle) {
      import('@/stores/connection').then(({ useConnectionStore }) => {
        useConnectionStore().broadcastTagUpdate(saved, 'ADD')
      }).catch(() => {})
    }
    return { success: true, tag: saved }
  }

  async function removeTag(
    eventId: string,
    teamNumber: number,
    tag: string
  ): Promise<{ success: boolean; error?: string }> {
    const crdtHandle = getExistingEventCrdt(eventId)
    const tagItem: TeamTagItem = { id: '', eventId, teamNumber, tag, color: 'blue', isPreset: false }

    try {
      await apiDeleteTeamTag(eventId, teamNumber, tag)
    } catch (e: any) {
      if (!crdtHandle) {
        console.error('Failed to remove tag:', e)
        return { success: false, error: e.message || 'Failed to remove tag' }
      }
    }

    if (crdtHandle) {
      withLocalCrdtWrite(eventId, () => {
        setTeamTagActive(crdtHandle.store, eventId, tagItem, false)
      })
    }
    applyTagUpdate(tagItem, 'REMOVE')
    if (!isCrdtTransportActive(eventId) && !crdtHandle) {
      import('@/stores/connection').then(({ useConnectionStore }) => {
        useConnectionStore().broadcastTagUpdate(tagItem, 'REMOVE')
      }).catch(() => {})
    }
    return { success: true }
  }

  function normalizeTag(str?: string): string {
    if (!str) return ''
    if (/^[A-Za-z0-9 _#-]+$/.test(str)) {
      return str.toLowerCase()
    }
    return str
  }

  function applyTagUpdate(tag: TeamTagItem, action: 'ADD' | 'REMOVE') {
    const targetTag = normalizeTag(tag.tag)
    if (action === 'ADD') {
      const idx = teamTags.value.findIndex(
        t => t.eventId === tag.eventId && t.teamNumber === tag.teamNumber && normalizeTag(t.tag) === targetTag
      )
      if (idx >= 0) {
        teamTags.value[idx] = tag
      } else {
        teamTags.value.push(tag)
      }
    } else if (action === 'REMOVE') {
      teamTags.value = teamTags.value.filter(
        t => !(t.eventId === tag.eventId && t.teamNumber === tag.teamNumber && normalizeTag(t.tag) === targetTag)
      )
    }

    const eid = tag.eventId || currentEventId.value
    const crdtHandle = eid ? getExistingEventCrdt(eid) : undefined
    if (crdtHandle) {
      withLocalCrdtWrite(eid, () => {
        writeTeamTagToCrdt(crdtHandle.store, { ...tag, eventId: tag.eventId || eid || '' }, action === 'ADD')
      })
    }
  }

  function applyTagsFullSync(tags: TeamTagItem[], eventId?: string) {
    if (!Array.isArray(tags)) return
    const firstTag = tags[0]
    const targetEventId = eventId || (firstTag?.eventId ? firstTag.eventId : currentEventId.value)
    if (targetEventId) {
      const otherEventsTags = teamTags.value.filter(t => t.eventId !== targetEventId)
      teamTags.value = [...otherEventsTags, ...tags]
      const crdtHandle = getExistingEventCrdt(targetEventId)
      if (crdtHandle) {
        const keepRowIds = new Set(tags.map((t) => teamTagRowId(t.teamNumber, t.tag)))
        withLocalCrdtWrite(targetEventId, () => {
          crdtHandle.store.transaction(() => {
            const existing = readTeamTagsFromCrdt(crdtHandle.store, targetEventId)
            for (const oldTag of existing) {
              if (!keepRowIds.has(teamTagRowId(oldTag.teamNumber, oldTag.tag))) {
                setTeamTagActive(crdtHandle.store, targetEventId, oldTag, false)
              }
            }
            for (const inc of tags) {
              writeTeamTagToCrdt(crdtHandle.store, { ...inc, eventId: inc.eventId || targetEventId }, true)
            }
          })
        })
      }
    } else {
      teamTags.value = tags
    }
    flushStorage()
  }

  function migrateScoutId(oldId: string, newId: string, newScoutName: string) {
    if (!oldId) return
    const effectiveNewId = newId || oldId
    let changed = false
    const migratedRecords: ScoutingRecord[] = []
    records.value = records.value.map(r => {
      if (r.scoutId === oldId) {
        changed = true
        const updated: ScoutingRecord = {
          ...r,
          scoutId: effectiveNewId,
          scoutName: newScoutName || r.scoutName,
          version: (r.version || 1) + 1,
          updatedAt: new Date().toISOString(),
          syncStatus: 'PENDING'
        }
        migratedRecords.push(updated)
        return updated
      }
      return r
    })

    refreshDerivedConflictsLocal()
    if (changed) {
      flushStorage()
      void (async () => {
        for (const rec of migratedRecords) {
          await signScoutingRecordWithDeviceKey(rec)
          const crdtHandle = rec.eventId ? getExistingEventCrdt(rec.eventId) : undefined
          if (crdtHandle) {
            withLocalCrdtWrite(rec.eventId, () => {
              writeScoutingRecordToCrdt(crdtHandle.store, rec)
            })
          }
        }
        flushStorage()
      })()
    }
  }

  function migrateEventId(oldId: string, newId: string) {
    if (!oldId || !newId || oldId === newId) return
    currentEventId.value = newId
    let changed = false
    const migratedRecIds = new Set<string>()
    records.value = records.value.map((r) => {
      if (r.eventId === oldId) {
        changed = true
        migratedRecIds.add(r.id)
        return { ...r, eventId: newId }
      }
      return r
    })
    teamTags.value = teamTags.value.map((t) => {
      if (t.eventId === oldId) {
        changed = true
        return { ...t, eventId: newId }
      }
      return t
    })
    refreshDerivedConflictsLocal(newId)
    if (changed) {
      flushStorage()
      void reSignEventAuthorRecords(newId, migratedRecIds)
    }
  }

  async function reSignEventAuthorRecords(targetEventId: string, onlyIds?: Set<string>): Promise<void> {
    if (!targetEventId) return
    const { getOrCreateDeviceIdentity } = await import('@/utils/identityStore')
    let localPubKey: string | undefined
    try {
      const id = await getOrCreateDeviceIdentity()
      localPubKey = id.signingPubKey
    } catch {}

    const targetRecords = records.value.filter(
      (r) =>
        r.eventId === targetEventId &&
        (!onlyIds || onlyIds.has(r.id)) &&
        (!r.authorPubKey || (localPubKey && r.authorPubKey === localPubKey))
    )
    if (targetRecords.length === 0) return

    let anyUpdated = false
    for (const rec of targetRecords) {
      const res = await signScoutingRecordWithDeviceKey(rec)
      if (res.signed) {
        anyUpdated = true
      }
    }

    const crdtHandle = getExistingEventCrdt(targetEventId)
    if (anyUpdated && crdtHandle) {
      withLocalCrdtWrite(targetEventId, () => {
        crdtHandle.store.transaction(() => {
          for (const rec of targetRecords) {
            writeScoutingRecordToCrdt(crdtHandle.store, rec)
          }
        })
      })
    }
    if (anyUpdated) {
      flushStorage()
    }
  }

  function clearMemoryOnly() {
    records.value = []
    officialMatches.value = []
    bannedTeams.value = []
    teamTags.value = []
    notifiedConflictCoords.clear()
    currentEventId.value = null
    error.value = null
  }

  function clearRecords() {
    clearMemoryOnly()
    try {
      localStorage.removeItem('scoutingpro_records')
      localStorage.removeItem('scoutingpro_officialMatches')
      localStorage.removeItem('scoutingpro_bannedTeams')
      localStorage.removeItem('scoutingpro_tags')
    } catch {}
  }

  const getTagsForTeam = (teamNumber: number, eventId?: string): TeamTagItem[] => {
    const eid = eventId || currentEventId.value
    return teamTags.value.filter(t => t.teamNumber === teamNumber && (!eid || t.eventId === eid))
  }

  async function refreshAdvancement(season: number, eventCode: string) {
    if (!season || !eventCode) return
    try {
      const adv = await fetchEventAdvancement(season, eventCode)
      officialAdvancement.value = adv
      flushStorage()
    } catch (e) {
      console.warn('[refreshAdvancement] Failed to fetch advancement:', e)
    }
  }

  return {
    records,
    currentRecords,
    activeRecords,
    officialMatches,
    officialAdvancement,
    advancementMap,
    refreshAdvancement,
    bannedTeams,
    teamTags,
    currentEventId,
    scoutReliability,
    matchDiscrepancies,
    top5Discrepancies,
    loading,
    error,
    rankings,
    conflictCoords,
    pendingRecords,
    myRecords,
    fetchRecords,
    addRecord,
    deleteRecord,
    bulkSync,
    markSynced,
    updateRecord,
    refreshDerivedConflictsLocal,
    syncRecordsFromCrdt,
    reSignEventAuthorRecords,
    migrateScoutId,
    migrateEventId,
    banTeam,
    unbanTeam,
    fetchTags,
    addTag,
    removeTag,
    applyTagUpdate,
    applyTagsFullSync,
    syncTagsFromCrdt,
    getTagsForTeam,
    purgeExpiredTombstones,
    clearMemoryOnly,
    clearRecords
  }
})
