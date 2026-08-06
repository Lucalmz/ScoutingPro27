import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { listRecords, saveRecord, syncRecords, markRecordsSynced } from '@/services/api'
import type { ScoutingRecord, RankingRow } from '@/types'

export const useRecordStore = defineStore('records', () => {
  const records = ref<ScoutingRecord[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  // --- computed rankings ---
  const rankings = computed<RankingRow[]>(() => {
    const map = new Map<number, ScoutingRecord[]>()
    for (const r of records.value) {
      const arr = map.get(r.teamNumber) ?? []
      arr.push(r)
      map.set(r.teamNumber, arr)
    }

    const rows: RankingRow[] = []
    for (const [teamNumber, recs] of map) {
      const matchCount = recs.length
      const totalScore = recs.reduce((s, r) => s + r.totalScore, 0)
      const maxScore = Math.max(...recs.map((r) => r.totalScore))
      const avgAutoScore = recs.reduce((s, r) => s + r.autoScore, 0) / matchCount
      const avgTeleopScore = recs.reduce((s, r) => s + r.teleopScore, 0) / matchCount
      const avgEndgameScore = recs.reduce((s, r) => s + r.endgameScore, 0) / matchCount

      rows.push({
        teamNumber,
        matchCount,
        avgAutoScore: Math.round(avgAutoScore * 10) / 10,
        avgTeleopScore: Math.round(avgTeleopScore * 10) / 10,
        avgEndgameScore: Math.round(avgEndgameScore * 10) / 10,
        maxScore,
        totalScore,
      })
    }

    rows.sort((a, b) => b.totalScore - a.totalScore)
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
  async function fetchRecords(eventId: string) {
    loading.value = true
    error.value = null
    try {
      records.value = await listRecords(eventId)
    } catch (e: any) {
      error.value = e.message ?? 'Failed to load records'
    } finally {
      loading.value = false
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
      return true
    } catch (e: any) {
      error.value = e.message ?? 'Failed to save record'
      return false
    }
  }

  // --- bulk upsert from peer sync ---
  async function bulkSync(incoming: ScoutingRecord[]) {
    try {
      await syncRecords(incoming)
      // Merge into local state
      for (const inc of incoming) {
        const idx = records.value.findIndex((r) => r.id === inc.id)
        if (idx >= 0) {
          records.value[idx] = inc
        } else {
          records.value.push(inc)
        }
      }
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
