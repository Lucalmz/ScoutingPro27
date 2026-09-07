import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import {
  listRecords,
  saveRecord,
  syncRecords,
  markRecordsSynced,
  fetchBannedTeams as apiFetchBannedTeams,
  banTeam as apiBanTeam,
  fetchEventTags as apiFetchEventTags,
  addTeamTag as apiAddTeamTag,
  deleteTeamTag as apiDeleteTeamTag
} from '@/services/api'
import { fetchEventMatches } from '@/services/ftcApi'
import { useInboxStore } from '@/stores/inbox'
import { useToastStore } from '@/stores/toast'
import type { ScoutingRecord, RankingRow, OfficialMatch, TeamTagItem } from '@/types'
import { calculateScoutReliability, calculateRankings } from '@/utils/analytics/rankings'
import { calculateMatchDiscrepancies, type MatchDiscrepancy } from '@/utils/analytics/audit'

function loadFromStorage<T>(key: string, defaultVal: T): T {
  try {
    const item = localStorage.getItem(key)
    return item ? JSON.parse(item) : defaultVal
  } catch (e) {
    console.error(`Failed to parse ${key} from localStorage`, e)
    return defaultVal
  }
}

export const useRecordStore = defineStore('records', () => {
  const records = ref<ScoutingRecord[]>(loadFromStorage('scoutingpro_records', []))
  const officialMatches = ref<OfficialMatch[]>(loadFromStorage('scoutingpro_officialMatches', []))
  const bannedTeams = ref<number[]>(loadFromStorage('scoutingpro_bannedTeams', []))
  const teamTags = ref<TeamTagItem[]>(loadFromStorage('scoutingpro_tags', []))
  const currentEventId = ref<string | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

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
      useToastStore().showToast('本地存储空间不足，数据可能丢失！', 'error')
    }
  }

  function flushStorage() {
    saveToStorage('scoutingpro_records', records.value)
    saveToStorage('scoutingpro_officialMatches', officialMatches.value)
    saveToStorage('scoutingpro_bannedTeams', bannedTeams.value)
    saveToStorage('scoutingpro_tags', teamTags.value)
  }

  // Debounced watch
  let saveTimeout: any = null
  watch([records, officialMatches, bannedTeams, teamTags], () => {
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
      try { records.value = JSON.parse(e.newValue) } catch {}
    } else if (e.key === 'scoutingpro_officialMatches' && e.newValue) {
      try { officialMatches.value = JSON.parse(e.newValue) } catch {}
    } else if (e.key === 'scoutingpro_bannedTeams' && e.newValue) {
      try { bannedTeams.value = JSON.parse(e.newValue) } catch {}
    } else if (e.key === 'scoutingpro_tags' && e.newValue) {
      try { teamTags.value = JSON.parse(e.newValue) } catch {}
    }
  })


  const scoutReliability = computed<Record<string, 'low' | 'high'>>(() =>
    calculateScoutReliability(records.value, officialMatches.value)
  )

  // --- official score discrepancy audit ---
  const matchDiscrepancies = computed<MatchDiscrepancy[]>(() =>
    calculateMatchDiscrepancies(records.value, officialMatches.value)
  )

  const top5Discrepancies = computed<MatchDiscrepancy[]>(() =>
    matchDiscrepancies.value.slice(0, 5)
  )

  // --- computed rankings ---
  const rankings = computed<RankingRow[]>(() =>
    calculateRankings(currentRecords.value, officialMatches.value, scoutReliability.value)
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
    currentEventId.value = eventId
    loading.value = true
    error.value = null
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
          } else if ((f.hostSeq ?? 0) > (cur.hostSeq ?? 0)) {
            mergedMap.set(f.id, f)
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

      // 保留当前内存中已有但本地 DB 尚未返回的记录（如通过 WebRTC 接收且已打 hostSeq 的对端记录）
      const unpersistedToSync: ScoutingRecord[] = []
      for (const cur of currentMap.values()) {
        if (!mergedMap.has(cur.id)) {
          mergedMap.set(cur.id, cur)
          if ((cur.hostSeq ?? 0) > 0) {
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
        officialMatches.value = await fetchEventMatches(ftcYear, ftcEventCode)
      } else {
        officialMatches.value = []
      }
      bannedTeams.value = await apiFetchBannedTeams(eventId).catch(() => [])
    } catch (e: any) {
      error.value = e.message ?? 'Failed to load records'
    } finally {
      loading.value = false
    }
  }

  function reassessConflicts(matchNumber: number, teamNumber: number): ScoutingRecord[] {
    const coordsRecords = currentRecords.value.filter(r => !r.isDeleted && r.matchNumber === matchNumber && r.teamNumber === teamNumber)
    const uniqueScouts = new Set(coordsRecords.map(r => r.scoutId))
    const updatedRecords: ScoutingRecord[] = []
    
    if (uniqueScouts.size <= 1) {
      for (const r of coordsRecords) {
        if (r.isConflict) {
          r.isConflict = false
          r.updatedAt = new Date().toISOString()
          r.version = (r.version || 0) + 1  // 冲突状态变更也要递增 version
          r.syncStatus = 'PENDING'
          updatedRecords.push(r)
        }
      }
    }
    return updatedRecords
  }

  // --- save a new record locally ---
  async function addRecord(record: ScoutingRecord): Promise<{ success: boolean, recordsToPush: ScoutingRecord[] }> {
    const idx = records.value.findIndex(r => r.id === record.id)
    const oldMatch = idx >= 0 ? records.value[idx]?.matchNumber ?? null : null
    const oldTeam = idx >= 0 ? records.value[idx]?.teamNumber ?? null : null

    // 用户显式编辑永远更新时间戳和状态
    record.updatedAt = new Date().toISOString()
    record.syncStatus = 'PENDING'
    record.version = (record.version || 0) + 1  // 每次编辑递增版本号

    if (idx >= 0) {
      records.value[idx] = record
    } else {
      records.value.push(record)
    }

    const recordsToPush: ScoutingRecord[] = [record]

    if (oldMatch !== null && oldTeam !== null && (oldMatch !== record.matchNumber || oldTeam !== record.teamNumber)) {
      recordsToPush.push(...reassessConflicts(oldMatch, oldTeam))
    }
    recordsToPush.push(...reassessConflicts(record.matchNumber, record.teamNumber))

    try {
      const [{ useUserStore }, { useEventStore }] = await Promise.all([
        import('@/stores/user'),
        import('@/stores/events')
      ])
      const userStore = useUserStore()
      const eventStore = useEventStore()
      if (record.scoutId === userStore.userId || eventStore.isHost || !userStore.userId) {
        await saveRecord(record)
        record.syncStatus = 'SYNCED'
      }
      return { success: true, recordsToPush }
    } catch (e: any) {
      error.value = e.message ?? 'Failed to save record'
      // It's still successfully stored locally, will be synced via WebRTC
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

    const recordsToPush: ScoutingRecord[] = [target]
    try {
      await saveRecord(target)
      target.syncStatus = 'SYNCED'
    } catch {
      // Keep pending for P2P sync
    }
    return { success: true, recordsToPush }
  }

  // --- bulk upsert from peer sync ---
  // 返回真正受影响（写入本地/冲突变更）的全部记录，供 Host 统一打 hostSeq、落库并广播
  async function bulkSync(incoming: ScoutingRecord[]): Promise<ScoutingRecord[]> {
    const recordsToBroadcast: ScoutingRecord[] = []
    const acceptedRecords: ScoutingRecord[] = []  // 真正写入本地的记录
    // 跟踪所有需要冲突重评的坐标
    const coordsToReassess = new Set<string>()
    
    for (const inc of incoming) {
      const idx = records.value.findIndex((r) => r.id === inc.id)
      let savedLocal: ScoutingRecord | null = null

      if (idx >= 0) {
        const local = records.value[idx]
        if (local) {
          const incV = inc.version || 0
          const localV = local.version || 0
          // LWW： version 大的胜出；相等时以 updatedAt 比较
          const shouldAccept = incV > localV ||
            (incV === localV && inc.updatedAt > local.updatedAt)
          if (shouldAccept) {
            // 追踪覆写前的旧坐标（冲突可能在旧坐标处消失）
            coordsToReassess.add(`${local.matchNumber}:${local.teamNumber}`)
            records.value[idx] = inc
            savedLocal = records.value[idx]
          }
        }
      } else {
        records.value.push(inc)
        savedLocal = inc
      }

      if (savedLocal) {
        acceptedRecords.push(savedLocal)
        // 追踪新坐标
        coordsToReassess.add(`${savedLocal.matchNumber}:${savedLocal.teamNumber}`)
        
        // 冲突检测 (非删除记录才检测冲突)
        if (!savedLocal.isDeleted) {
          const conflictRecords = records.value.filter(r =>
            !r.isDeleted &&
            r.matchNumber === savedLocal!.matchNumber &&
            r.teamNumber === savedLocal!.teamNumber &&
            r.scoutId !== savedLocal!.scoutId
          )
          if (conflictRecords.length > 0) {
            const allConflicting = [savedLocal, ...conflictRecords]
            for (const r of allConflicting) {
              if (!r.isConflict) {
                r.isConflict = true
                r.updatedAt = new Date().toISOString()
                r.version = (r.version || 0) + 1  // 冲突状态变更也要递增 version
                r.syncStatus = 'PENDING'
                recordsToBroadcast.push(r)
              }
            }
          }
        }
      }
    }

    // 重评所有受影响坐标，清除已不成立的冲突标志
    for (const key of coordsToReassess) {
      const [matchStr, teamStr] = key.split(':')
      const cleared = reassessConflicts(Number(matchStr), Number(teamStr))
      recordsToBroadcast.push(...cleared)
    }

    // 合并并去重所有受影响的记录（新进记录 + 冲突被改动的既有记录）
    const allModifiedMap = new Map<string, ScoutingRecord>()
    for (const r of acceptedRecords) allModifiedMap.set(r.id, r)
    for (const r of recordsToBroadcast) allModifiedMap.set(r.id, r)
    const allModified = Array.from(allModifiedMap.values())

    // 非 Host 端（Client 本地独立模式）自存自己名下产生的新记录
    const [{ useEventStore }, { useUserStore }] = await Promise.all([
      import('@/stores/events'),
      import('@/stores/user')
    ])
    const eventStore = useEventStore()
    const userStore = useUserStore()
    if (!eventStore.isHost && userStore.userId) {
      const toSync = allModified.filter(r => r.scoutId === userStore.userId || ((r.hostSeq ?? 0) > 0))
      if (toSync.length > 0) {
        try {
          await syncRecords(toSync)
        } catch (e: any) {
          console.warn('[bulkSync] Failed to persist records locally:', e)
        }
      }
    }

    return allModified
  }

  // --- mark records as synced locally ---
  async function markSynced(ids: string[]) {
    for (const id of ids) {
      const r = records.value.find((r) => r.id === id)
      if (r) r.syncStatus = 'SYNCED'
    }
    try {
      await markRecordsSynced(ids)
    } catch {
      // 后端更新失败不影响前端
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

  // --- Custom Team Tags ---
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
    try {
      const saved = await apiAddTeamTag(eventId, teamNumber, tag, color, isPreset)
      applyTagUpdate(saved, 'ADD')
      import('@/stores/connection').then(({ useConnectionStore }) => {
        useConnectionStore().broadcastTagUpdate(saved, 'ADD')
      }).catch(() => {})
      return { success: true, tag: saved }
    } catch (e: any) {
      console.error('Failed to add tag:', e)
      return { success: false, error: e.message || 'Failed to add tag' }
    }
  }

  async function removeTag(
    eventId: string,
    teamNumber: number,
    tag: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await apiDeleteTeamTag(eventId, teamNumber, tag)
      const tagItem: TeamTagItem = { id: '', eventId, teamNumber, tag, color: 'blue', isPreset: false }
      applyTagUpdate(tagItem, 'REMOVE')
      import('@/stores/connection').then(({ useConnectionStore }) => {
        useConnectionStore().broadcastTagUpdate(tagItem, 'REMOVE')
      }).catch(() => {})
      return { success: true }
    } catch (e: any) {
      console.error('Failed to remove tag:', e)
      return { success: false, error: e.message || 'Failed to remove tag' }
    }
  }

  function applyTagUpdate(tag: TeamTagItem, action: 'ADD' | 'REMOVE') {
    if (action === 'ADD') {
      const idx = teamTags.value.findIndex(
        t => t.eventId === tag.eventId && t.teamNumber === tag.teamNumber && t.tag === tag.tag
      )
      if (idx >= 0) {
        teamTags.value[idx] = tag
      } else {
        teamTags.value.push(tag)
      }
    } else if (action === 'REMOVE') {
      teamTags.value = teamTags.value.filter(
        t => !(t.eventId === tag.eventId && t.teamNumber === tag.teamNumber && t.tag === tag.tag)
      )
    }
  }

  function applyTagsFullSync(tags: TeamTagItem[]) {
    if (Array.isArray(tags)) {
      teamTags.value = tags
    }
  }

  function migrateScoutId(oldId: string, newId: string, newScoutName: string) {
    if (!oldId) return
    const effectiveNewId = newId || oldId
    let changed = false
    records.value = records.value.map(r => {
      if (r.scoutId === oldId) {
        changed = true
        return {
          ...r,
          scoutId: effectiveNewId,
          scoutName: newScoutName || r.scoutName,
          version: (r.version || 1) + 1,
          updatedAt: new Date().toISOString(),
          syncStatus: 'PENDING'
        }
      }
      return r
    })
    if (changed) {
      flushStorage()
    }
  }

  const getTagsForTeam = (teamNumber: number): TeamTagItem[] => {
    return teamTags.value.filter(t => t.teamNumber === teamNumber)
  }

  return {
    records,
    activeRecords,
    officialMatches,
    bannedTeams,
    teamTags,
    currentEventId,
    scoutReliability,
    matchDiscrepancies,
    top5Discrepancies,
    loading,
    error,
    rankings,
    pendingRecords,
    myRecords,
    fetchRecords,
    addRecord,
    deleteRecord,
    bulkSync,
    markSynced,
    updateRecord,
    migrateScoutId,
    banTeam,
    fetchTags,
    addTag,
    removeTag,
    applyTagUpdate,
    applyTagsFullSync,
    getTagsForTeam,
    purgeExpiredTombstones,
  }
})
