import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type {
  PitScoutingRecord,
  OfficialTeamInfo,
  UnifiedTeamItem
} from '@/types'
import { calculateBragIndex } from '@/utils/bragIndex'
import {
  fetchPitRecords,
  savePitRecord as apiSavePitRecord,
  syncPitRecordsBatch,
  syncOfficialTeams,
  fetchFtcTeams
} from '@/services/api'
import { useScheduleStore } from './schedule'
import { useRecordStore } from './records'
import { useConnectionStore } from './connection'
import { useEventStore } from './events'

const STORAGE_PREFIX = 'sp27_pit_'

export const usePitScoutStore = defineStore('pitScout', () => {
  const currentEventId = ref<string | null>(null)
  const records = ref<PitScoutingRecord[]>([])
  const officialTeams = ref<OfficialTeamInfo[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  // 检索与筛选状态
  const searchQuery = ref('')
  const filterDrivetrain = ref<string>('all')
  const filterRecordStatus = ref<'all' | 'recorded' | 'unrecorded'>('all')
  const sortBy = ref<'teamNumber' | 'bragAsc' | 'bragDesc' | 'scoreDesc'>('teamNumber')

  // 本地缓存存取
  function loadFromLocalStorage(eventId: string) {
    try {
      const rawRecs = localStorage.getItem(`${STORAGE_PREFIX}records_${eventId}`)
      if (rawRecs) records.value = JSON.parse(rawRecs)

      const rawTeams = localStorage.getItem(`${STORAGE_PREFIX}teams_${eventId}`)
      if (rawTeams) officialTeams.value = JSON.parse(rawTeams)
    } catch {
      // 忽略本地反序列化错误
    }
  }

  function saveToLocalStorage(eventId: string) {
    try {
      localStorage.setItem(`${STORAGE_PREFIX}records_${eventId}`, JSON.stringify(records.value))
      localStorage.setItem(`${STORAGE_PREFIX}teams_${eventId}`, JSON.stringify(officialTeams.value))
    } catch (e) {
      console.warn('[PitScoutStore] Failed to save to localStorage:', e)
    }
  }

  const activeRecords = computed(() => records.value.filter((r) => !r.isDeleted))

  /**
   * 响应式核心：统一赛事战队池 (Unified Event Team Roster)
   * 并集去重 FTC 官方名录、赛程表各工位战队、比赛侦察战队、标签战队及 Pit 记录战队
   */
  const unifiedTeamList = computed<UnifiedTeamItem[]>(() => {
    const scheduleStore = useScheduleStore()
    const recordStore = useRecordStore()
    const targetEventId = currentEventId.value

    // 1. 汇集所有数据源的战队号并去重
    const teamNumberSet = new Set<number>()

    officialTeams.value.forEach((t) => {
      if ((!targetEventId || !t.eventId || t.eventId === targetEventId) && t.teamNumber > 0) teamNumberSet.add(t.teamNumber)
    })

    scheduleStore.schedules.forEach((s) => {
      if (!targetEventId || !s.eventId || s.eventId === targetEventId) {
        if (s.red1 > 0) teamNumberSet.add(s.red1)
        if (s.red2 > 0) teamNumberSet.add(s.red2)
        if (s.blue1 > 0) teamNumberSet.add(s.blue1)
        if (s.blue2 > 0) teamNumberSet.add(s.blue2)
      }
    })

    recordStore.activeRecords.forEach((r) => {
      if ((!targetEventId || r.eventId === targetEventId) && r.teamNumber > 0) teamNumberSet.add(r.teamNumber)
    })

    recordStore.teamTags.forEach((t) => {
      if ((!targetEventId || t.eventId === targetEventId) && t.teamNumber > 0) teamNumberSet.add(t.teamNumber)
    })

    activeRecords.value.forEach((p) => {
      if ((!targetEventId || p.eventId === targetEventId) && p.teamNumber > 0) teamNumberSet.add(p.teamNumber)
    })

    // 2. 为每支战队构建统一对象
    const allTeams: UnifiedTeamItem[] = Array.from(teamNumberSet).map((teamNumber) => {
      const official = officialTeams.value.find((t) => t.teamNumber === teamNumber && (!targetEventId || !t.eventId || t.eventId === targetEventId))
      const pitRec = activeRecords.value.find((p) => p.teamNumber === teamNumber && (!targetEventId || p.eventId === targetEventId)) || null
      const teamMatches = recordStore.activeRecords.filter((r) => r.teamNumber === teamNumber && (!targetEventId || r.eventId === targetEventId))
      const tags = recordStore.getTagsForTeam(teamNumber, targetEventId || undefined)

      const matchCount = teamMatches.length
      const avgTotalScore = matchCount > 0
        ? Number((teamMatches.reduce((s, r) => s + (r.totalScore || 0), 0) / matchCount).toFixed(1))
        : undefined
      const maxTotalScore = matchCount > 0
        ? Math.max(...teamMatches.map((r) => r.totalScore || 0))
        : undefined

      const bragInfo = calculateBragIndex(pitRec, teamMatches)

      return {
        teamNumber,
        name: official?.nameFull || (pitRec?.robotName ? `${pitRec.robotName} (${teamNumber})` : `Team ${teamNumber}`),
        robotName: official?.robotName || pitRec?.robotName,
        city: official?.city,
        country: official?.country,
        hasPitRecord: Boolean(pitRec),
        pitRecord: pitRec,
        bragInfo,
        matchCount,
        avgTotalScore,
        maxTotalScore,
        tags
      }
    })

    // 3. 多维筛选与排序
    let filtered = allTeams

    if (searchQuery.value.trim()) {
      const q = searchQuery.value.trim().toLowerCase()
      filtered = filtered.filter((t) =>
        String(t.teamNumber).includes(q) ||
        t.name.toLowerCase().includes(q) ||
        (t.robotName && t.robotName.toLowerCase().includes(q))
      )
    }

    if (filterDrivetrain.value !== 'all') {
      filtered = filtered.filter((t) => t.pitRecord?.drivetrainType === filterDrivetrain.value)
    }

    if (filterRecordStatus.value === 'recorded') {
      filtered = filtered.filter((t) => t.hasPitRecord)
    } else if (filterRecordStatus.value === 'unrecorded') {
      filtered = filtered.filter((t) => !t.hasPitRecord)
    }

    // 排序
    return filtered.sort((a, b) => {
      if (sortBy.value === 'teamNumber') {
        return a.teamNumber - b.teamNumber
      }
      if (sortBy.value === 'bragAsc') {
        const ratioA = a.bragInfo?.overallRatio ?? 999
        const ratioB = b.bragInfo?.overallRatio ?? 999
        return ratioA - ratioB
      }
      if (sortBy.value === 'bragDesc') {
        const ratioA = a.bragInfo?.overallRatio ?? 0
        const ratioB = b.bragInfo?.overallRatio ?? 0
        return ratioB - ratioA
      }
      if (sortBy.value === 'scoreDesc') {
        const scoreA = a.pitRecord?.claimedTotalScore ?? 0
        const scoreB = b.pitRecord?.claimedTotalScore ?? 0
        return scoreB - scoreA
      }
      return a.teamNumber - b.teamNumber
    })
  })

  const stats = computed(() => {
    const total = unifiedTeamList.value.length
    const recorded = unifiedTeamList.value.filter((t) => t.hasPitRecord).length
    return {
      total,
      recorded,
      percentage: total > 0 ? Math.round((recorded / total) * 100) : 0
    }
  })

  function getUnifiedTeam(teamNumber: number): UnifiedTeamItem | undefined {
    return unifiedTeamList.value.find((t) => t.teamNumber === teamNumber)
  }

  // --- API 与同步操作 ---

  async function fetchPitData(eventId: string) {
    currentEventId.value = eventId
    loading.value = true
    error.value = null
    loadFromLocalStorage(eventId)

    try {
      const res = await fetchPitRecords(eventId)
      if (res) {
        if (Array.isArray(res.records)) {
          // 3-way merge with local records
          const localMap = new Map(records.value.map((r) => [r.teamNumber, r]))
          for (const serverRec of res.records) {
            const local = localMap.get(serverRec.teamNumber)
            if (!local) {
              localMap.set(serverRec.teamNumber, serverRec)
            } else if (local.syncStatus === 'PENDING') {
              // 本地有离线编辑未提交：保留本地编辑，同时合并服务端照片 Key，防止离线照片丢失
              if (serverRec.photoKeys && serverRec.photoKeys.length > 0) {
                local.photoKeys = Array.from(new Set([...(local.photoKeys || []), ...serverRec.photoKeys]))
              }
              localMap.set(serverRec.teamNumber, local)
            } else if ((serverRec.version || 0) >= (local.version || 0)) {
              // 服务端版本更新或相同：采纳服务端数据，合并本地可能缓存的照片
              if (local.photoKeys && local.photoKeys.length > 0) {
                serverRec.photoKeys = Array.from(new Set([...(serverRec.photoKeys || []), ...local.photoKeys]))
              }
              localMap.set(serverRec.teamNumber, serverRec)
            } else {
              // 本地版本更高：保留本地并合并照片
              if (serverRec.photoKeys && serverRec.photoKeys.length > 0) {
                local.photoKeys = Array.from(new Set([...(local.photoKeys || []), ...serverRec.photoKeys]))
              }
              localMap.set(serverRec.teamNumber, local)
            }
          }
          records.value = Array.from(localMap.values())
        }

        if (Array.isArray(res.officialTeams)) {
          officialTeams.value = res.officialTeams
        }

        saveToLocalStorage(eventId)
      }
    } catch (e: any) {
      console.warn('[PitScoutStore] Failed to fetch pit data from backend:', e.message)
    } finally {
      loading.value = false
    }
  }

  const pendingPitRecords = computed(() => {
    return records.value.filter((r) => r.syncStatus === 'PENDING')
  })

  async function saveRecord(record: PitScoutingRecord) {
    if (!currentEventId.value) return

    record.eventId = currentEventId.value
    record.version = (record.version || 0) + 1
    record.updatedAt = new Date().toISOString()
    record.syncStatus = 'PENDING'

    const idx = records.value.findIndex((r) => r.teamNumber === record.teamNumber)
    if (idx >= 0) {
      records.value[idx] = record
    } else {
      records.value.push(record)
    }

    saveToLocalStorage(currentEventId.value)

    // 局域网 DataChannel 增量广播
    try {
      const connStore = useConnectionStore()
      if (connStore.rtcService) {
        connStore.rtcService.sendMessage({
          type: 'PIT_SCOUT_UPDATE',
          record
        })
      }
    } catch (e) {
      console.warn('[PitScoutStore] Failed to broadcast pit update:', e)
    }

    // 本地 / Host 后端落盘
    try {
      await apiSavePitRecord(currentEventId.value, record)
      record.syncStatus = 'SYNCED'
      saveToLocalStorage(currentEventId.value)
    } catch (e) {
      console.warn('[PitScoutStore] Saved locally, backend sync deferred:', e)
    }
  }

  async function flushPendingPitRecords(targetEventId?: string) {
    const eid = targetEventId || currentEventId.value
    if (!eid) return
    const pending = records.value.filter((r) => r.syncStatus === 'PENDING')
    if (pending.length === 0) return

    console.log(`[PitScoutStore] Flushing ${pending.length} pending pit records for event ${eid}...`)

    let httpSuccess = false
    try {
      await syncPitRecordsBatch(eid, pending)
      httpSuccess = true
      for (const rec of pending) {
        rec.syncStatus = 'SYNCED'
      }
      saveToLocalStorage(eid)
      console.log(`[PitScoutStore] Successfully flushed ${pending.length} pit records via HTTP API`)
    } catch (e) {
      console.warn('[PitScoutStore] HTTP batch flush deferred/failed:', e)
    }

    try {
      const connStore = useConnectionStore()
      if (connStore.rtcService && connStore.status === 'connected') {
        await connStore.rtcService.sendMessage({
          type: 'PIT_SCOUT_BATCH_SYNC',
          records: pending
        })
        if (!httpSuccess) {
          for (const rec of pending) {
            rec.syncStatus = 'SYNCED'
          }
          saveToLocalStorage(eid)
        }
        console.log(`[PitScoutStore] Successfully broadcasted ${pending.length} pit records via DataChannel`)
      }
    } catch (e) {
      console.warn('[PitScoutStore] WebRTC DataChannel batch broadcast failed:', e)
    }
  }

  function applyRemoteUpdate(record: PitScoutingRecord) {
    if (!record || !record.teamNumber) return

    const idx = records.value.findIndex((r) => r.teamNumber === record.teamNumber)
    if (idx >= 0) {
      const local = records.value[idx]
      if (local) {
        // 如果本地有正在等待同步的更改，且版本更高或相同，保留本地编辑，仅合并照片
        if (local.syncStatus === 'PENDING' && (local.version || 0) >= (record.version || 0)) {
          if (record.photoKeys && record.photoKeys.length > 0) {
            local.photoKeys = Array.from(new Set([...(local.photoKeys || []), ...record.photoKeys]))
            if (currentEventId.value) saveToLocalStorage(currentEventId.value)
          }
          return
        }

        const shouldAccept = (record.version || 0) > (local.version || 0) ||
          ((record.version || 0) === (local.version || 0) && (record.updatedAt || '') >= (local.updatedAt || ''))
        if (shouldAccept) {
          // 合并本地可能拍摄的照片 key，防止覆盖
          if (local.photoKeys && local.photoKeys.length > 0) {
            record.photoKeys = Array.from(new Set([...(record.photoKeys || []), ...local.photoKeys]))
          }
          record.syncStatus = 'SYNCED'
          records.value[idx] = record
        } else {
          // 拒绝已过时的旧版本更新，禁止污染本地与远程数据库
          return
        }
      }
    } else {
      record.syncStatus = 'SYNCED'
      records.value.push(record)
    }

    if (currentEventId.value) {
      saveToLocalStorage(currentEventId.value)

      // Host 端收到客户端推送时，自动批量落盘
      const eventStore = useEventStore()
      if (eventStore.isHost) {
        apiSavePitRecord(currentEventId.value, record).catch((err) => {
          console.warn('[PitScoutStore Host] Failed to persist incoming remote pit record:', err)
        })
      }
    }
  }

  function applyFullSync(incomingRecords: PitScoutingRecord[]) {
    if (!Array.isArray(incomingRecords)) return

    const map = new Map(records.value.map((r) => [r.teamNumber, r]))
    for (const inc of incomingRecords) {
      const cur = map.get(inc.teamNumber)
      if (!cur) {
        inc.syncStatus = 'SYNCED'
        map.set(inc.teamNumber, inc)
      } else {
        const curIsPending = cur.syncStatus === 'PENDING'
        const incV = inc.version || 0
        const curV = cur.version || 0
        const incTime = inc.updatedAt || ''
        const curTime = cur.updatedAt || ''

        if (curIsPending) {
          const shouldAccept = incV > curV || (incV === curV && incTime > curTime)
          if (shouldAccept) {
            if (cur.photoKeys && cur.photoKeys.length > 0) {
              inc.photoKeys = Array.from(new Set([...(inc.photoKeys || []), ...cur.photoKeys]))
            }
            inc.syncStatus = 'SYNCED'
            map.set(inc.teamNumber, inc)
          } else {
            if (inc.photoKeys && inc.photoKeys.length > 0) {
              cur.photoKeys = Array.from(new Set([...(cur.photoKeys || []), ...inc.photoKeys]))
            }
          }
        } else {
          const shouldAccept = incV > curV || (incV === curV && incTime >= curTime)
          if (shouldAccept) {
            if (cur.photoKeys && cur.photoKeys.length > 0) {
              inc.photoKeys = Array.from(new Set([...(inc.photoKeys || []), ...cur.photoKeys]))
            }
            inc.syncStatus = 'SYNCED'
            map.set(inc.teamNumber, inc)
          } else {
            if (inc.photoKeys && inc.photoKeys.length > 0) {
              cur.photoKeys = Array.from(new Set([...(cur.photoKeys || []), ...inc.photoKeys]))
            }
          }
        }
      }
    }
    records.value = Array.from(map.values())

    if (currentEventId.value) {
      saveToLocalStorage(currentEventId.value)
    }
  }

  async function syncFtcRoster(season: number, eventCode: string) {
    if (!currentEventId.value || !eventCode) return
    loading.value = true
    try {
      const fetched = await fetchFtcTeams(season, eventCode)
      if (Array.isArray(fetched) && fetched.length > 0) {
        officialTeams.value = fetched
        saveToLocalStorage(currentEventId.value)

        // 落盘到后端
        await syncOfficialTeams(currentEventId.value, fetched)

        // WebRTC 广播给同赛事房间内的其他侦察员
        const connStore = useConnectionStore()
        if (connStore.rtcService) {
          connStore.rtcService.sendMessage({
            type: 'OFFICIAL_ROSTER_SYNC',
            teams: fetched
          })
        }
      }
    } catch (e: any) {
      error.value = e.message || 'Failed to sync FTC official roster'
      throw e
    } finally {
      loading.value = false
    }
  }

  function applyOfficialRosterSync(teams: OfficialTeamInfo[]) {
    if (Array.isArray(teams) && teams.length > 0) {
      officialTeams.value = teams
      if (currentEventId.value) {
        saveToLocalStorage(currentEventId.value)
      }
    }
  }

  function migrateScoutId(oldScoutId: string, newScoutId: string, newScoutName?: string) {
    if (!oldScoutId) return
    const effectiveNewId = newScoutId || oldScoutId
    let changed = false
    records.value = records.value.map((r) => {
      if (r.scoutId === oldScoutId) {
        changed = true
        return {
          ...r,
          scoutId: effectiveNewId,
          scoutName: newScoutName || r.scoutName,
          version: (r.version || 1) + 1,
          updatedAt: new Date().toISOString(),
          syncStatus: 'PENDING' as const
        }
      }
      return r
    })
    if (changed && currentEventId.value) {
      saveToLocalStorage(currentEventId.value)
    }
  }

  return {
    currentEventId,
    records,
    officialTeams,
    loading,
    error,
    searchQuery,
    filterDrivetrain,
    filterRecordStatus,
    sortBy,
    activeRecords,
    unifiedTeamList,
    stats,
    getUnifiedTeam,
    fetchPitData,
    saveRecord,
    flushPendingPitRecords,
    pendingPitRecords,
    applyRemoteUpdate,
    applyFullSync,
    syncFtcRoster,
    applyOfficialRosterSync,
    migrateScoutId
  }
})
