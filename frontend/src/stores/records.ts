import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { listRecords, saveRecord, syncRecords, markRecordsSynced, fetchBannedTeams as apiFetchBannedTeams, banTeam as apiBanTeam } from '@/services/api'
import { fetchEventMatches } from '@/services/graphql'
import { useInboxStore } from '@/stores/inbox'
import { useToastStore } from '@/stores/toast'
import type { ScoutingRecord, RankingRow, OfficialMatch } from '@/types'

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
  const loading = ref(false)
  const error = ref<string | null>(null)

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
  }

  // Debounced watch
  let saveTimeout: any = null
  watch([records, officialMatches, bannedTeams], () => {
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
    }
  })


  const scoutReliability = computed<Record<string, 'low'|'high'>>(() => {
    const matchAlliances: Record<string, { officialTotal: number, scouts: { scoutId: string, score: number }[] }> = {}
    
    const uniqueRecords = new Map<string, ScoutingRecord>()
    for (const record of records.value) {
      const key = `${record.matchNumber}-${record.teamNumber}`
      const existing = uniqueRecords.get(key)
      if (!existing || new Date(record.updatedAt) > new Date(existing.updatedAt)) {
        uniqueRecords.set(key, record)
      }
    }

    for (const record of uniqueRecords.values()) {
      const match = officialMatches.value.find(m => m.matchNum === record.matchNumber)
      if (!match || !match.scores) continue;
      
      const team = match.teams.find(t => t.teamNumber === record.teamNumber)
      if (!team) continue;
      
      const alliance = team.alliance.toLowerCase() as 'red' | 'blue'
      const allianceScores = match.scores[alliance]
      if (!allianceScores) continue;
      
      const matchKey = `${record.matchNumber}-${alliance}`;
      if (!matchAlliances[matchKey]) {
        matchAlliances[matchKey] = { officialTotal: allianceScores.totalPointsNp, scouts: [] };
      }
      matchAlliances[matchKey].scouts.push({ scoutId: record.scoutId, score: record.totalScore });
    }

    const scoutStats: Record<string, { totalDeviation: number, count: number }> = {}
    
    for (const data of Object.values(matchAlliances)) {
      if (data.scouts.length < 2) continue; // single record or no records, skip
      
      const officialToCompare = data.officialTotal;
      if (officialToCompare <= 0) continue; // Skip matches with 0 official score to prevent huge deviation

      const scoutTotal = data.scouts.reduce((sum, s) => sum + s.score, 0);
      const deviation = Math.abs(scoutTotal - officialToCompare) / officialToCompare;
      
      for (const s of data.scouts) {
        let stat = scoutStats[s.scoutId];
        if (!stat) {
          stat = { totalDeviation: 0, count: 0 };
          scoutStats[s.scoutId] = stat;
        }
        stat.totalDeviation += deviation;
        stat.count++;
      }
    }

    const reliability: Record<string, 'low'|'high'> = {}
    for (const [scoutId, stat] of Object.entries(scoutStats)) {
      reliability[scoutId] = (stat.totalDeviation / stat.count > 0.30) ? 'low' : 'high'
    }
    return reliability
  })

  // --- computed rankings ---
  const rankings = computed<RankingRow[]>(() => {
    const map = new Map<number, ScoutingRecord[]>()
    for (const r of records.value) {
      let teamRecs = map.get(r.teamNumber)
      if (!teamRecs) {
        teamRecs = []
        map.set(r.teamNumber, teamRecs)
      }
      teamRecs.push(r)
    }

    const rows: RankingRow[] = []
    for (const [teamNumber, teamRecs] of map) {
      // Sort records by matchNumber ascending to find the true progression
      const sortedRecs = teamRecs.sort((a, b) => a.matchNumber - b.matchNumber)
      const matchCount = sortedRecs.length
      
      let weightSum = 0;
      let totalWeightedAuto = 0;
      let totalWeightedTeleop = 0;
      let totalWeightedEndgame = 0;
      let totalWeightedScore = 0;
      let realMaxScore = 0;
      let totalRealScoreForTrend: number[] = [];
      let brokenCount = 0;

      for (const r of sortedRecs) {
        if (r.isBroken) {
          brokenCount++;
          continue; // Ignore broken matches in calculations
        }

        const weight = scoutReliability.value[r.scoutId] === 'low' ? 0.5 : 1.0;
        weightSum += weight;

        let realTotalScore = r.totalScore;
        const match = officialMatches.value.find(m => m.matchNum === r.matchNumber);
        if (match && match.scores) {
          const teamInfo = match.teams.find(t => t.teamNumber === r.teamNumber);
          if (teamInfo) {
            const alliance = teamInfo.alliance.toLowerCase() as 'red' | 'blue';
            const allianceScores = match.scores[alliance];
            if (allianceScores) {
              realTotalScore = r.totalScore - (allianceScores.penaltyPointsCommitted / 2);
            }
          }
        }
        
        totalWeightedAuto += r.autoScore * weight;
        totalWeightedTeleop += r.teleopScore * weight;
        totalWeightedEndgame += r.endgameScore * weight;
        totalWeightedScore += realTotalScore * weight;
        totalRealScoreForTrend.push(realTotalScore);
        
        if (realTotalScore > realMaxScore) {
          realMaxScore = realTotalScore;
        }
      }

      const effectiveWeight = weightSum || 1;
      const avgAutoScore = totalWeightedAuto / effectiveWeight;
      const avgTeleopScore = totalWeightedTeleop / effectiveWeight;
      const avgEndgameScore = totalWeightedEndgame / effectiveWeight;
      const avgRating = totalWeightedScore / effectiveWeight;

      let trend: 'up' | 'down' | 'stable' | 'new' = 'new'
      if (matchCount > 1) {
        const lastMatchScore = totalRealScoreForTrend[matchCount - 1]!
        const previousMatches = totalRealScoreForTrend.slice(0, matchCount - 1)
        const previousAvg = previousMatches.reduce((s, r) => s + r, 0) / previousMatches.length
        
        if (lastMatchScore > previousAvg * 1.15) {
          trend = 'up'
        } else if (lastMatchScore < previousAvg * 0.85) {
          trend = 'down'
        } else {
          trend = 'stable'
        }
      } else if (matchCount === 1) {
        trend = 'new'
      }

      rows.push({
        teamNumber,
        matchCount,
        avgAutoScore: Math.round(avgAutoScore * 10) / 10,
        avgTeleopScore: Math.round(avgTeleopScore * 10) / 10,
        avgEndgameScore: Math.round(avgEndgameScore * 10) / 10,
        maxScore: realMaxScore,
        avgRating: Math.round(avgRating * 10) / 10,
        brokenCount,
        trend
      })
    }

    rows.sort((a, b) => b.avgRating - a.avgRating)
    return rows
  })

  // --- records for the current user ---
  const myRecords = computed(() => {
    return (scoutId: string) => records.value.filter((r) => r.scoutId === scoutId)
  })

  // --- pending records ---
  const pendingRecords = computed(() =>
    records.value.filter((r) => r.syncStatus === 'PENDING'),
  )

  // --- fetch ---
  async function fetchRecords(eventId: string, ftcYear?: number, ftcEventCode?: string) {
    loading.value = true
    error.value = null
    try {
      records.value = await listRecords(eventId)
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
    const coordsRecords = records.value.filter(r => r.matchNumber === matchNumber && r.teamNumber === teamNumber)
    const uniqueScouts = new Set(coordsRecords.map(r => r.scoutId))
    const updatedRecords: ScoutingRecord[] = []
    
    if (uniqueScouts.size <= 1) {
      for (const r of coordsRecords) {
        if (r.isConflict) {
          r.isConflict = false
          const nowMs = Date.now()
          const localMs = new Date(r.updatedAt).getTime()
          r.updatedAt = new Date(nowMs <= localMs ? localMs + 1 : nowMs).toISOString()
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

    // Users explicit edits ALWAYS update the timestamp and status
    record.updatedAt = new Date().toISOString()
    record.syncStatus = 'PENDING'

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
      await saveRecord(record)
      record.syncStatus = 'SYNCED'
      return { success: true, recordsToPush }
    } catch (e: any) {
      error.value = e.message ?? 'Failed to save record'
      // It's still successfully stored locally, will be synced via WebRTC
      return { success: true, recordsToPush }
    }
  }

  // --- bulk upsert from peer sync ---
  async function bulkSync(incoming: ScoutingRecord[]) {
    const recordsToBroadcast: ScoutingRecord[] = []
    
    for (const inc of incoming) {
      const idx = records.value.findIndex((r) => r.id === inc.id)
      let savedLocal: ScoutingRecord | null = null

      if (idx >= 0) {
        const local = records.value[idx]
        if (local && new Date(inc.updatedAt) > new Date(local.updatedAt)) {
          records.value[idx] = inc
          savedLocal = records.value[idx]
        }
      } else {
        records.value.push(inc)
        savedLocal = inc
      }

      if (savedLocal) {
        // Detect conflict
        const conflictRecords = records.value.filter(r => r.matchNumber === savedLocal!.matchNumber && r.teamNumber === savedLocal!.teamNumber && r.scoutId !== savedLocal!.scoutId)
        if (conflictRecords.length > 0) {
          const allConflicting = [savedLocal, ...conflictRecords]
          let flipped = false
          for (const r of allConflicting) {
            if (!r.isConflict) {
              r.isConflict = true
              const nowMs = Date.now()
              const localMs = new Date(r.updatedAt).getTime()
              r.updatedAt = new Date(nowMs <= localMs ? localMs + 1 : nowMs).toISOString()
              r.syncStatus = 'PENDING'
              recordsToBroadcast.push(r)
              flipped = true
            }
          }
        }
      }
    }

    if (recordsToBroadcast.length > 0) {
      import('@/stores/connection').then(({ useConnectionStore }) => {
        const connStore = useConnectionStore()
        if (connStore.isConnected) {
          connStore.pushRecords(recordsToBroadcast)
        }
      })
    }

    try {
      await syncRecords(incoming)
    } catch (e: any) {
      error.value = e.message ?? 'Failed to sync records'
    }
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

  return {
    records,
    officialMatches,
    bannedTeams,
    scoutReliability,
    loading,
    error,
    rankings,
    pendingRecords,
    myRecords,
    fetchRecords,
    addRecord,
    bulkSync,
    markSynced,
    updateRecord,
    banTeam,
  }
})
