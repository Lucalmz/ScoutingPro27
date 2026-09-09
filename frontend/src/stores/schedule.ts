import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { MatchScheduleItem, ScoutAssignment, StationType, OfficialMatch } from '@/types'
import {
  fetchEventSchedule,
  saveScheduleBatch,
  clearEventSchedule,
  saveScoutAssignments
} from '@/services/api'
import { useConnectionStore } from './connection'
import { getTournamentLevelOrder } from '@/utils/tournament'

/**
 * Deduplicate and normalize schedule items by numeric matchNumber
 */
export function deduplicateSchedules(list: MatchScheduleItem[]): MatchScheduleItem[] {
  if (!Array.isArray(list)) return []
  const map = new Map<string, MatchScheduleItem>()
  for (const item of list) {
    if (!item) continue
    const num = Number(item.matchNumber)
    if (isNaN(num) || num <= 0) continue

    const level = (item.tournamentLevel || 'QUALIFICATION').toUpperCase()
    const key = `${level}_${num}`

    const normalized: MatchScheduleItem = {
      ...item,
      matchNumber: num,
      tournamentLevel: item.tournamentLevel || 'QUALIFICATION',
      red1: Number(item.red1) || 0,
      red2: Number(item.red2) || 0,
      blue1: Number(item.blue1) || 0,
      blue2: Number(item.blue2) || 0
    }

    const existing = map.get(key)
    map.set(key, existing ? {
      ...existing,
      ...normalized,
      scoreRedFinal: normalized.scoreRedFinal ?? existing.scoreRedFinal,
      scoreBlueFinal: normalized.scoreBlueFinal ?? existing.scoreBlueFinal,
      red1: normalized.red1 || existing.red1,
      red2: normalized.red2 || existing.red2,
      blue1: normalized.blue1 || existing.blue1,
      blue2: normalized.blue2 || existing.blue2
    } : normalized)
  }
  return Array.from(map.values()).sort((a, b) => {
    const diffLevel = getTournamentLevelOrder(a.tournamentLevel) - getTournamentLevelOrder(b.tournamentLevel)
    if (diffLevel !== 0) return diffLevel
    return a.matchNumber - b.matchNumber
  })
}

export const useScheduleStore = defineStore('schedule', () => {
  const currentEventId = ref<string | null>(null)
  const schedules = ref<MatchScheduleItem[]>([])
  // key: `${matchNumber}_${station}`
  const assignments = ref<Record<string, ScoutAssignment>>({})
  const loading = ref(false)
  const error = ref<string | null>(null)

  // 划选集合与划选状态 (Mouse drag / wheel selection)
  const selectedMatches = ref<Set<string | number>>(new Set())
  const isDraggingSelection = ref(false)
  const dragAnchorMatch = ref<number | null>(null)
  const dragTargetMatch = ref<number | null>(null)
  const dragLevel = ref<string>('QUALIFICATION')

  const sortedSchedules = computed(() => {
    return deduplicateSchedules(schedules.value)
  })

  const selectedCount = computed(() => selectedMatches.value.size)

  function getMatchSelectionKey(matchNumber: number | string, tournamentLevel?: string): string {
    const level = (tournamentLevel || 'QUALIFICATION').toUpperCase()
    return `${level}_${Number(matchNumber)}`
  }

  function isMatchSelected(matchNumber: number | string, tournamentLevel?: string): boolean {
    const num = Number(matchNumber)
    const key = getMatchSelectionKey(matchNumber, tournamentLevel)
    return selectedMatches.value.has(key) || selectedMatches.value.has(num) || selectedMatches.value.has(String(num))
  }

  function getAssignmentKey(matchNumber: number, station: StationType, tournamentLevel?: string): string {
    const level = (tournamentLevel || 'QUALIFICATION').toUpperCase()
    return `${level}_${Number(matchNumber)}_${station}`
  }

  function getStationAssignment(matchNumber: number, station: StationType, tournamentLevel?: string): ScoutAssignment | undefined {
    const targetLevel = (tournamentLevel || 'QUALIFICATION').toUpperCase()
    const direct = assignments.value[getAssignmentKey(Number(matchNumber), station, targetLevel)]
    if (direct) return direct

    if (targetLevel === 'QUALIFICATION') {
      const legacy = assignments.value[`${Number(matchNumber)}_${station}`]
      if (legacy) return legacy
    }

    return Object.values(assignments.value).find(
      (a) => Number(a.matchNumber) === Number(matchNumber) &&
             a.station === station &&
             (!a.tournamentLevel || a.tournamentLevel.toUpperCase() === targetLevel)
    )
  }

  /**
   * 当前 Scout 用户被指派的所有任务
   */
  const myAssignments = computed(() => {
    return (scoutId: string) => {
      if (!scoutId) return []
      const list: Array<{
        matchNumber: number
        station: StationType
        teamNumber: number
        assignment: ScoutAssignment
        schedule?: MatchScheduleItem
      }> = []

      const schedMap = new Map<string, MatchScheduleItem>()
      for (const s of schedules.value) {
        const lvl = (s.tournamentLevel || 'QUALIFICATION').toUpperCase()
        schedMap.set(`${lvl}_${s.matchNumber}`, s)
        if (lvl === 'QUALIFICATION') {
          schedMap.set(`QUALIFICATION_${s.matchNumber}`, s)
        }
      }

      for (const a of Object.values(assignments.value)) {
        if (a.scoutId === scoutId) {
          const lvl = (a.tournamentLevel || 'QUALIFICATION').toUpperCase()
          list.push({
            matchNumber: a.matchNumber,
            station: a.station,
            teamNumber: a.teamNumber,
            assignment: a,
            schedule: schedMap.get(`${lvl}_${a.matchNumber}`) || schedMap.get(`QUALIFICATION_${a.matchNumber}`)
          })
        }
      }

      return list.sort((a, b) => {
        const diffLevel = getTournamentLevelOrder(a.assignment.tournamentLevel) - getTournamentLevelOrder(b.assignment.tournamentLevel)
        if (diffLevel !== 0) return diffLevel
        return Number(a.matchNumber) - Number(b.matchNumber)
      })
    }
  })

  // --- 本地持久化缓存 ---
  function saveToLocalStorage(eventId: string) {
    try {
      localStorage.setItem(`scoutingpro27_schedule_${eventId}`, JSON.stringify(schedules.value))
      localStorage.setItem(`scoutingpro27_assignments_${eventId}`, JSON.stringify(assignments.value))
    } catch (e) {
      console.warn('[ScheduleStore] Failed to save to localStorage:', e)
    }
  }

  function loadFromLocalStorage(eventId: string): boolean {
    try {
      const rawSched = localStorage.getItem(`scoutingpro27_schedule_${eventId}`)
      const rawAssign = localStorage.getItem(`scoutingpro27_assignments_${eventId}`)
      let hasData = false
      if (rawSched) {
        schedules.value = deduplicateSchedules(JSON.parse(rawSched))
        hasData = true
      }
      if (rawAssign) {
        assignments.value = JSON.parse(rawAssign)
        hasData = true
      }
      return hasData
    } catch (e) {
      console.warn('[ScheduleStore] Failed to load from localStorage:', e)
      return false
    }
  }

  // --- 加载赛程与排班 ---
  async function loadSchedule(eventId: string) {
    currentEventId.value = eventId
    loading.value = true
    error.value = null

    // 先读本地缓存秒级上屏
    loadFromLocalStorage(eventId)

    try {
      const res = await fetchEventSchedule(eventId)
      if (res && res.schedules) {
        if (res.schedules.length > 0 || schedules.value.length === 0) {
          schedules.value = deduplicateSchedules(res.schedules)
        }
      }
      if (res && res.assignments) {
        if (res.assignments.length > 0 || Object.keys(assignments.value).length === 0) {
          const assignMap: Record<string, ScoutAssignment> = {}
          for (const a of res.assignments) {
            assignMap[getAssignmentKey(a.matchNumber, a.station, a.tournamentLevel)] = a
          }
          assignments.value = assignMap
        }
      }
      saveToLocalStorage(eventId)
    } catch (e: any) {
      // 离线环境静默降级到已加载的本地数据
      console.warn('[ScheduleStore] Remote fetch schedule failed, using local cache:', e.message)
    } finally {
      loading.value = false
    }
  }

  // --- 批量导入赛程 ---
  async function importSchedules(
    eventId: string,
    items: MatchScheduleItem[],
    replace = true,
    broadcast = true
  ): Promise<{ success: boolean; count: number }> {
    currentEventId.value = eventId
    loading.value = true
    try {
      const cleanItems = deduplicateSchedules(items)
      if (replace) {
        schedules.value = cleanItems
        // 自动初始化所有工位留空
        const newAssignments: Record<string, ScoutAssignment> = {}
        for (const item of cleanItems) {
          initStationAssignments(eventId, item, newAssignments)
        }
        assignments.value = newAssignments
      } else {
        schedules.value = deduplicateSchedules([...schedules.value, ...cleanItems])
        for (const item of cleanItems) {
          initStationAssignments(eventId, item, assignments.value)
        }
      }

      saveToLocalStorage(eventId)

      // 保存到后端 DB
      try {
        await saveScheduleBatch(eventId, cleanItems, replace)
      } catch (e) {
        console.error('[ScheduleStore] Backend saveScheduleBatch failed:', e)
        throw e
      }

      if (broadcast) {
        broadcastScheduleSync()
      }

      return { success: true, count: cleanItems.length }
    } finally {
      loading.value = false
    }
  }

  function initStationAssignments(eventId: string, item: MatchScheduleItem, targetMap: Record<string, ScoutAssignment>) {
    const stations: Array<{ station: StationType; teamNumber: number }> = [
      { station: 'red1', teamNumber: item.red1 },
      { station: 'red2', teamNumber: item.red2 },
      { station: 'blue1', teamNumber: item.blue1 },
      { station: 'blue2', teamNumber: item.blue2 }
    ]
    for (const st of stations) {
      const key = getAssignmentKey(item.matchNumber, st.station, item.tournamentLevel)
      if (!targetMap[key]) {
        targetMap[key] = {
          id: `${eventId}_${item.tournamentLevel || 'QUALIFICATION'}_${item.matchNumber}_${st.station}`,
          eventId,
          matchNumber: item.matchNumber,
          tournamentLevel: item.tournamentLevel || 'QUALIFICATION',
          station: st.station,
          teamNumber: st.teamNumber,
          scoutId: null,
          scoutName: null
        }
      } else {
        // 更新队号
        targetMap[key].teamNumber = st.teamNumber
      }
    }
  }

  // --- 从 FTC 官方比赛数据一键导入 ---
  async function importFromFtcOfficial(eventId: string, officialMatches: OfficialMatch[], replace = true) {
    if (!officialMatches || officialMatches.length === 0) {
      throw new Error('没有可用的官方比赛数据')
    }

    const items: MatchScheduleItem[] = []
    for (const m of officialMatches) {
      if (!m.matchNum || !m.teams || m.teams.length < 2) continue

      const redTeams = m.teams.filter((t) => (t.alliance || '').toLowerCase().startsWith('red'))
      const blueTeams = m.teams.filter((t) => (t.alliance || '').toLowerCase().startsWith('blue'))

      const red1 = redTeams[0]?.teamNumber || 0
      const red2 = redTeams[1]?.teamNumber || 0
      const blue1 = blueTeams[0]?.teamNumber || 0
      const blue2 = blueTeams[1]?.teamNumber || 0

      if (red1 === 0 && blue1 === 0) continue

      const scoreRed = m.scores?.red ? ((m.scores.red as any).finalScore ?? m.scores.red.totalPointsNp) : null
      const scoreBlue = m.scores?.blue ? ((m.scores.blue as any).finalScore ?? m.scores.blue.totalPointsNp) : null

      const level = (m.tournamentLevel || 'QUALIFICATION').toUpperCase()
      const id = level === 'PLAYOFF' ? `${eventId}_PLAYOFF_M${m.matchNum}` : `${eventId}_M${m.matchNum}`
      items.push({
        id,
        eventId,
        matchNumber: m.matchNum,
        tournamentLevel: level,
        red1,
        red2,
        blue1,
        blue2,
        scoreRedFinal: scoreRed,
        scoreBlueFinal: scoreBlue
      })
    }

    if (items.length === 0) {
      throw new Error('未能从官方数据中解析出有效的红蓝对阵队伍')
    }

    return await importSchedules(eventId, items, replace, true)
  }

  // --- 解析 CSV / 文本赛程 ---
  function parseCsvSchedule(eventId: string, rawText: string): MatchScheduleItem[] {
    if (!rawText || !rawText.trim()) return []

    const lines = rawText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)

    const items: MatchScheduleItem[] = []

    for (const line of lines) {
      const [p0, p1, p2, p3, p4] = line.split(/[,\t;]+/).map((p) => p.trim())
      if (!p0 || !p1 || !p2 || !p3 || !p4) continue

      // 跳过表头 (如 Match, Red1, Red2, Blue1, Blue2 或 场次, 红1...)
      const firstStr = p0.toLowerCase()
      if (firstStr.includes('match') || firstStr.includes('场次') || firstStr.includes('qual') || firstStr.includes('playoff')) {
        const pureMatchNum = parseInt(p0.replace(/[^0-9]/g, ''), 10)
        if (isNaN(pureMatchNum)) continue
      }

      const matchNum = parseInt(p0.replace(/[^0-9]/g, ''), 10)
      const red1 = parseInt(p1.replace(/[^0-9]/g, ''), 10)
      const red2 = parseInt(p2.replace(/[^0-9]/g, ''), 10)
      const blue1 = parseInt(p3.replace(/[^0-9]/g, ''), 10)
      const blue2 = parseInt(p4.replace(/[^0-9]/g, ''), 10)

      if (isNaN(matchNum) || matchNum <= 0) continue
      if (isNaN(red1) || isNaN(red2) || isNaN(blue1) || isNaN(blue2)) continue

      const level = (/^p\d+/i.test(p0) || firstStr.includes('playoff')) ? 'PLAYOFF' : 'QUALIFICATION'
      const id = level === 'PLAYOFF' ? `${eventId}_PLAYOFF_M${matchNum}` : `${eventId}_M${matchNum}`

      items.push({
        id,
        eventId,
        matchNumber: matchNum,
        tournamentLevel: level,
        red1,
        red2,
        blue1,
        blue2,
        scoreRedFinal: null,
        scoreBlueFinal: null
      })
    }

    return items
  }

  // --- 单工位排班（永远支持留空） ---
  async function assignStation(
    eventId: string,
    matchNumber: number,
    station: StationType,
    scoutId: string | null,
    scoutName: string | null,
    broadcast = true,
    tournamentLevel = 'QUALIFICATION'
  ) {
    const key = getAssignmentKey(matchNumber, station, tournamentLevel)
    const existing = assignments.value[key]

    // 获取当前队号
    const sched = schedules.value.find(
      (s) => s.matchNumber === matchNumber && (!tournamentLevel || (s.tournamentLevel || 'QUALIFICATION').toUpperCase() === tournamentLevel.toUpperCase())
    )
    let teamNumber = 0
    if (sched) {
      if (station === 'red1') teamNumber = sched.red1
      else if (station === 'red2') teamNumber = sched.red2
      else if (station === 'blue1') teamNumber = sched.blue1
      else if (station === 'blue2') teamNumber = sched.blue2
    } else if (existing) {
      teamNumber = existing.teamNumber
    }

    const updated: ScoutAssignment = {
      id: existing?.id || `${eventId}_${tournamentLevel || 'QUALIFICATION'}_${matchNumber}_${station}`,
      eventId,
      matchNumber,
      tournamentLevel: tournamentLevel || existing?.tournamentLevel || 'QUALIFICATION',
      station,
      teamNumber,
      scoutId: scoutId || null,
      scoutName: scoutName || null,
      updatedAt: new Date().toISOString()
    }

    assignments.value[key] = updated
    saveToLocalStorage(eventId)

    // 保存到后端
    try {
      await saveScoutAssignments(eventId, [updated])
    } catch (e) {
      console.warn('[ScheduleStore] saveScoutAssignments failed (offline fallback):', e)
    }

    if (broadcast) {
      broadcastAssignmentUpdate(updated)
    }
  }

  // --- 批量对选中的比赛排班 (支持留空) ---
  async function batchAssignSelected(
    eventId: string,
    stationTarget: StationType | 'all',
    scoutId: string | null,
    scoutName: string | null,
    tournamentLevel = 'QUALIFICATION'
  ) {
    if (selectedMatches.value.size === 0) return

    const selectedItems = Array.from(selectedMatches.value)
    const updates: ScoutAssignment[] = []

    for (const item of selectedItems) {
      let itemLevel = tournamentLevel
      let matchNumber: number

      if (typeof item === 'string' && item.includes('_')) {
        const parts = item.split('_')
        itemLevel = parts[0] || tournamentLevel
        matchNumber = Number(parts[1])
      } else {
        matchNumber = Number(item)
      }

      if (isNaN(matchNumber)) continue

      const sched = schedules.value.find(
        (s) => Number(s.matchNumber) === matchNumber && (!itemLevel || (s.tournamentLevel || 'QUALIFICATION').toUpperCase() === itemLevel.toUpperCase())
      )
      if (!sched) continue

      const targetStations: StationType[] =
        stationTarget === 'all'
          ? ['red1', 'red2', 'blue1', 'blue2']
          : [stationTarget]

      for (const st of targetStations) {
        let teamNumber = 0
        if (st === 'red1') teamNumber = sched.red1
        else if (st === 'red2') teamNumber = sched.red2
        else if (st === 'blue1') teamNumber = sched.blue1
        else if (st === 'blue2') teamNumber = sched.blue2

        const targetLevel = sched.tournamentLevel || itemLevel || 'QUALIFICATION'
        const key = getAssignmentKey(matchNumber, st, targetLevel)
        const updated: ScoutAssignment = {
          id: assignments.value[key]?.id || `${eventId}_${targetLevel}_${matchNumber}_${st}`,
          eventId,
          matchNumber,
          tournamentLevel: targetLevel,
          station: st,
          teamNumber,
          scoutId: scoutId || null, // null 表示留空
          scoutName: scoutName || null,
          updatedAt: new Date().toISOString()
        }
        assignments.value[key] = updated
        updates.push(updated)
      }
    }

    saveToLocalStorage(eventId)

    try {
      await saveScoutAssignments(eventId, updates)
    } catch (e) {
      console.warn('[ScheduleStore] batch saveScoutAssignments failed:', e)
    }

    broadcastScheduleSync()
  }

  // --- 清空赛程 ---
  async function clearSchedule(eventId: string) {
    schedules.value = []
    assignments.value = {}
    selectedMatches.value.clear()
    saveToLocalStorage(eventId)

    try {
      await clearEventSchedule(eventId)
    } catch (e) {
      console.warn('[ScheduleStore] clearEventSchedule failed:', e)
    }

    broadcastScheduleSync()
  }

  // --- 划选逻辑 (Selection Helpers: Mouse Drag & Wheel) ---
  function toggleMatchSelection(matchNumber: number | string, tournamentLevel?: string) {
    const num = Number(matchNumber)
    const key = getMatchSelectionKey(matchNumber, tournamentLevel)
    if (selectedMatches.value.has(key)) {
      selectedMatches.value.delete(key)
    } else if (selectedMatches.value.has(num)) {
      selectedMatches.value.delete(num)
    } else if (selectedMatches.value.has(String(num))) {
      selectedMatches.value.delete(String(num))
    } else {
      if (tournamentLevel) {
        selectedMatches.value.add(key)
      } else {
        selectedMatches.value.add(num)
      }
    }
  }

  function startDragSelection(matchNumber: number | string, tournamentLevel?: string) {
    const num = Number(matchNumber)
    const lvl = (tournamentLevel || 'QUALIFICATION').toUpperCase()
    isDraggingSelection.value = true
    dragAnchorMatch.value = num
    dragTargetMatch.value = num
    dragLevel.value = lvl
    selectedMatches.value.add(getMatchSelectionKey(num, lvl))
  }

  function dragSelectMatch(matchNumber: number | string, tournamentLevel?: string) {
    const num = Number(matchNumber)
    const lvl = (tournamentLevel || dragLevel.value || 'QUALIFICATION').toUpperCase()
    if (!isDraggingSelection.value || dragAnchorMatch.value === null) return
    dragTargetMatch.value = num
    const min = Math.min(dragAnchorMatch.value, num)
    const max = Math.max(dragAnchorMatch.value, num)
    for (let m = min; m <= max; m++) {
      if (schedules.value.some((s) => Number(s.matchNumber) === m && (s.tournamentLevel || 'QUALIFICATION').toUpperCase() === lvl)) {
        selectedMatches.value.add(getMatchSelectionKey(m, lvl))
      }
    }
  }

  function endDragSelection() {
    isDraggingSelection.value = false
    dragAnchorMatch.value = null
    dragTargetMatch.value = null
  }

  function selectAllMatches() {
    for (const s of schedules.value) {
      const lvl = (s.tournamentLevel || 'QUALIFICATION').toUpperCase()
      selectedMatches.value.add(getMatchSelectionKey(s.matchNumber, lvl))
    }
  }

  function clearSelection() {
    selectedMatches.value.clear()
    isDraggingSelection.value = false
    dragAnchorMatch.value = null
    dragTargetMatch.value = null
  }

  // --- WebRTC 直连隧道广播 ---
  function broadcastScheduleSync() {
    const connStore = useConnectionStore()
    if (connStore.rtcService) {
      connStore.rtcService.sendMessage({
        type: 'SCHEDULE_FULL_SYNC',
        schedules: schedules.value,
        assignments: Object.values(assignments.value)
      })
    }
  }

  function broadcastAssignmentUpdate(assignment: ScoutAssignment) {
    const connStore = useConnectionStore()
    if (connStore.rtcService) {
      connStore.rtcService.sendMessage({
        type: 'ASSIGNMENT_UPDATE',
        assignment
      })
    }
  }

  // --- 接收对端 WebRTC 同步 ---
  function applyScheduleFullSync(incomingSchedules: MatchScheduleItem[], incomingAssignments: ScoutAssignment[]) {
    if (incomingSchedules) {
      schedules.value = deduplicateSchedules(incomingSchedules)
    }
    if (incomingAssignments) {
      const assignMap: Record<string, ScoutAssignment> = {}
      for (const a of incomingAssignments) {
        assignMap[getAssignmentKey(Number(a.matchNumber), a.station, a.tournamentLevel)] = a
      }
      assignments.value = assignMap
    }
    if (currentEventId.value) {
      saveToLocalStorage(currentEventId.value)
    }
  }

  function applyAssignmentUpdate(incomingAssignment: ScoutAssignment) {
    if (!incomingAssignment) return
    const key = getAssignmentKey(incomingAssignment.matchNumber, incomingAssignment.station, incomingAssignment.tournamentLevel)
    assignments.value[key] = incomingAssignment
    if (currentEventId.value) {
      saveToLocalStorage(currentEventId.value)
    }
  }

  function migrateScoutId(oldScoutId: string, newScoutId: string, newScoutName?: string) {
    let changed = false
    for (const key of Object.keys(assignments.value)) {
      const a = assignments.value[key]
      if (a && a.scoutId === oldScoutId) {
        a.scoutId = newScoutId
        if (newScoutName) a.scoutName = newScoutName
        changed = true
      }
    }
    if (changed && currentEventId.value) {
      saveToLocalStorage(currentEventId.value)
    }
  }

  return {
    currentEventId,
    schedules,
    assignments,
    loading,
    error,
    selectedMatches,
    isDraggingSelection,
    sortedSchedules,
    selectedCount,
    isMatchSelected,
    getAssignmentKey,
    getStationAssignment,
    myAssignments,
    loadSchedule,
    importSchedules,
    importFromFtcOfficial,
    parseCsvSchedule,
    assignStation,
    batchAssignSelected,
    clearSchedule,
    toggleMatchSelection,
    startDragSelection,
    dragSelectMatch,
    endDragSelection,
    selectAllMatches,
    clearSelection,
    broadcastScheduleSync,
    broadcastAssignmentUpdate,
    applyScheduleFullSync,
    applyAssignmentUpdate,
    migrateScoutId
  }
})
