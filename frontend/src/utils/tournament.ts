import type { ScoutingRecord } from '@/types'

/**
 * Extracts and normalizes tournamentLevel from a ScoutingRecord's rawData.
 * Defaults to 'QUALIFICATION' if not present or corrupted.
 */
export function getRecordTournamentLevel(r: ScoutingRecord): string {
  try {
    if ((r as any)?.tournamentLevel) {
      return String((r as any).tournamentLevel).toUpperCase()
    }
    if (!r.rawData) return 'QUALIFICATION'
    const parsed = typeof r.rawData === 'string' ? JSON.parse(r.rawData) : r.rawData
    return (parsed.tournamentLevel || 'QUALIFICATION').toUpperCase()
  } catch {
    return 'QUALIFICATION'
  }
}

/**
 * Returns numeric sorting priority for tournament levels:
 * QUALIFICATION (1) -> PLAYOFF (2) -> OTHER (3)
 */
export function getTournamentLevelOrder(lvl?: string): number {
  const l = (lvl || 'QUALIFICATION').toUpperCase()
  if (l === 'QUALIFICATION') return 1
  if (l === 'PLAYOFF') return 2
  return 3
}

/**
 * Sorts scouting records chronologically by tournament level progression
 * (QUALIFICATION matches first, then PLAYOFF matches) and matchNumber ascending.
 */
export function sortRecordsChronologically(records: ScoutingRecord[]): ScoutingRecord[] {
  return records.slice().sort((a, b) => {
    const diffLevel = getTournamentLevelOrder(getRecordTournamentLevel(a)) - getTournamentLevelOrder(getRecordTournamentLevel(b))
    if (diffLevel !== 0) return diffLevel
    return a.matchNumber - b.matchNumber
  })
}

/**
 * Returns match level prefix: 'Q' for qualification, 'P' for playoff.
 */
export function getMatchLevelPrefix(recordOrLevel?: ScoutingRecord | string): 'Q' | 'P' {
  const level = typeof recordOrLevel === 'string'
    ? recordOrLevel
    : (recordOrLevel ? getRecordTournamentLevel(recordOrLevel) : 'QUALIFICATION')
  return (level || 'QUALIFICATION').toUpperCase() === 'PLAYOFF' ? 'P' : 'Q'
}

/**
 * Checks if a scout assignment task has been completed by an active record.
 * Matches (scoutId, matchNumber, teamNumber, tournamentLevel).
 * If options.matchAnyScout is true, checks whether the assigned team in the match & level
 * has been covered by any active record (e.g. teammate covering the assignment).
 */
export function isAssignmentCompleted(
  task: { matchNumber: number; teamNumber: number; tournamentLevel?: string },
  scoutId: string,
  records: ScoutingRecord[],
  options?: { matchAnyScout?: boolean }
): boolean {
  const taskLevel = (task.tournamentLevel || 'QUALIFICATION').toUpperCase()
  const matchAnyScout = options?.matchAnyScout ?? false
  return records.some((r) => {
    if (r.isDeleted) return false
    if (!matchAnyScout && r.scoutId !== scoutId) {
      return false
    }
    if (Number(r.matchNumber) !== Number(task.matchNumber) || Number(r.teamNumber) !== Number(task.teamNumber)) {
      return false
    }
    const recLevel = getRecordTournamentLevel(r)
    return recLevel === taskLevel
  })
}
