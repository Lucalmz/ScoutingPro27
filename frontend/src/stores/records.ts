import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { listRecords, saveRecord, syncRecords, markRecordsSynced } from '@/services/api'
import { fetchEventMatches } from '@/services/graphql'
import { useInboxStore } from '@/stores/inbox'
import type { ScoutingRecord, RankingRow, OfficialMatch } from '@/types'

export const useRecordStore = defineStore('records', () => {
  const records = ref<ScoutingRecord[]>([])
  const officialMatches = ref<OfficialMatch[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

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
      
      const scoutTotal = data.scouts.reduce((sum, s) => sum + s.score, 0);
      const officialToCompare = data.officialTotal;
      const deviation = Math.abs(scoutTotal - officialToCompare) / (officialToCompare || 1);
      
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
      reliability[scoutId] = (stat.totalDeviation / stat.count > 0.20) ? 'low' : 'high'
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

      for (const r of sortedRecs) {
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
    } catch (e: any) {
      error.value = e.message ?? 'Failed to load records'
    } finally {
      loading.value = false
    }
  }

  function checkAndClearResolvedConflicts() {
    const inboxStore = useInboxStore()
    const conflicts = inboxStore.messages.filter(m => m.type === 'conflict' && !m.read)
    for (const msg of conflicts) {
      if (msg.conflictMatchNumber !== undefined && msg.conflictTeamNumber !== undefined) {
        const count = records.value.filter(r => r.matchNumber === msg.conflictMatchNumber && r.teamNumber === msg.conflictTeamNumber).length
        if (count <= 1) {
          inboxStore.markRead(msg.id)
        }
      }
    }
  }

  // --- save a new record locally ---
  async function addRecord(record: ScoutingRecord): Promise<boolean> {
    try {
      await saveRecord(record)
      const idx = records.value.findIndex(r => r.id === record.id)
      if (idx >= 0) {
        records.value[idx] = record
      } else {
        records.value.push(record)
      }
      checkAndClearResolvedConflicts()
      return true
    } catch (e: any) {
      error.value = e.message ?? 'Failed to save record'
      return false
    }
  }

  // --- bulk upsert from peer sync ---
  async function bulkSync(incoming: ScoutingRecord[]) {
    const inboxStore = useInboxStore()
    // Merge into local state first to ensure they aren't lost if sync fails
    for (const inc of incoming) {
      const conflictRecord = records.value.find(r => r.matchNumber === inc.matchNumber && r.teamNumber === inc.teamNumber && r.scoutId !== inc.scoutId)
      if (conflictRecord) {
        const conflictTitle = 'Sync Conflict'
        const conflictBody = `Submission conflict for Match ${inc.matchNumber}, Team ${inc.teamNumber}`
        if (!inboxStore.messages.some(m => m.title === conflictTitle && m.body === conflictBody && !m.read)) {
          inboxStore.addMessage({
            title: conflictTitle,
            body: conflictBody,
            type: 'conflict',
            conflictMatchNumber: inc.matchNumber,
            conflictTeamNumber: inc.teamNumber
          })
        }
      }

      const idx = records.value.findIndex((r) => r.id === inc.id)
      if (idx >= 0) {
        const local = records.value[idx]
        if (local && new Date(inc.updatedAt) > new Date(local.updatedAt)) {
          records.value[idx] = inc
        }
      } else {
        records.value.push(inc)
      }
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
  async function updateRecord(record: ScoutingRecord): Promise<boolean> {
    // Re-save via the same POST endpoint (upsert by id)
    return addRecord(record)
  }

  return {
    records,
    officialMatches,
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
  }
})
