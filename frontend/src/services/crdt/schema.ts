import type { Cell, MergeableStore } from 'tinybase'
import type {
  BallCompatibility,
  CustomFieldDefinition,
  CustomFieldOption,
  CustomFieldPhase,
  CustomFieldTarget,
  CustomFieldType,
  MatchScheduleItem,
  PitScoutingRecord,
  ScoutAssignment,
  ScoutingRecord,
  StationType,
  TeamTagItem
} from '@/types'

export const CRDT_TABLES = {
  PIT_RECORDS: 'pit_records',
  PIT_PHOTO_KEYS: 'pit_photo_keys',
  TEAM_TAGS: 'team_tags',
  CUSTOM_FIELDS: 'custom_fields',
  SCHEDULES: 'schedules',
  ASSIGNMENTS: 'assignments',
  MEMBER_IDENTITIES: 'member_identities',
  SCOUTING_RECORDS: 'scouting_records'
} as const

export type CrdtTableId = (typeof CRDT_TABLES)[keyof typeof CRDT_TABLES]

export interface MemberIdentityEntry {
  eventId?: string
  userId: string
  deviceId: string
  signingPubKeyHex: string
  trustedAt: number
  hostPubKey?: string
  hostSig?: string
}

// ============================================================
// Deterministic Row IDs & Tag Normalization
// ============================================================

export function normalizeTagName(raw?: string | null): string {
  if (!raw) return ''
  const trimmed = raw.trim()
  if (/^[A-Za-z0-9 _#-]+$/.test(trimmed)) {
    return trimmed.toLowerCase()
  }
  return trimmed
}

export function pitRowId(teamNumber: number): string {
  return String(Number(teamNumber))
}

export function pitPhotoKeyRowId(teamNumber: number, photoKey: string): string {
  return `${Number(teamNumber)}::${photoKey}`
}

export function teamTagRowId(teamNumber: number, tag: string): string {
  return `${Number(teamNumber)}::${normalizeTagName(tag)}`
}

export function customFieldRowId(fieldId: string): string {
  return fieldId
}

export function scheduleRowId(matchNumber: number, tournamentLevel = 'QUALIFICATION'): string {
  const level = (tournamentLevel || 'QUALIFICATION').trim().toUpperCase() || 'QUALIFICATION'
  return `${level}_${Number(matchNumber)}`
}

export function assignmentRowId(
  matchNumber: number,
  station: StationType | string,
  tournamentLevel = 'QUALIFICATION'
): string {
  const level = (tournamentLevel || 'QUALIFICATION').trim().toUpperCase() || 'QUALIFICATION'
  return `${level}_${Number(matchNumber)}_${station}`
}

export function memberIdentityRowId(userId: string, deviceId: string): string {
  return `${userId}::${deviceId}`
}

export function scoutingRecordRowId(recordId: string): string {
  return recordId
}

// ============================================================
// Diff-On-Write Primitive (preserves sibling HLC timestamps!)
// ============================================================

export function setChangedCells(
  store: MergeableStore,
  tableId: string,
  rowId: string,
  cells: Record<string, Cell | undefined>
): boolean {
  let mutated = false
  store.transaction(() => {
    for (const [cellId, nextVal] of Object.entries(cells)) {
      if (nextVal === undefined) continue
      if (typeof nextVal === 'number' && !Number.isFinite(nextVal)) continue
      const prev = store.getCell(tableId, rowId, cellId)
      if (prev !== nextVal) {
        store.setCell(tableId, rowId, cellId, nextVal)
        mutated = true
      }
    }
  })
  return mutated
}

// ============================================================
// Fractional Indexing for Custom Field Ordering
// ============================================================

const ORDER_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

export function orderKeyFromSeq(orderSeq: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(orderSeq) ? orderSeq : 0))
  return `V${String(safe).padStart(6, '0')}`
}

/**
 * Generates a lexicographically strictly between key in ASCII base-62 order.
 */
export function generateOrderKeyBetween(prevKey: string | null | undefined, nextKey: string | null | undefined): string {
  const a = prevKey && prevKey.length > 0 ? prevKey : ''
  const b = nextKey && nextKey.length > 0 ? nextKey : ''
  if (a && b && a >= b) {
    return `${a}V`
  }

  let prefix = ''
  const maxLen = Math.max(a.length, b.length) + 4
  for (let i = 0; i < maxLen; i++) {
    const minIdx = i < a.length ? Math.max(0, ORDER_ALPHABET.indexOf(a[i]!)) : 0
    const maxIdx = i < b.length ? ORDER_ALPHABET.indexOf(b[i]!) : ORDER_ALPHABET.length

    if (b && maxIdx < 0) {
      return `${prefix}V`
    }
    const upper = b ? maxIdx : ORDER_ALPHABET.length
    if (upper - minIdx > 1) {
      const mid = Math.floor((minIdx + upper) / 2)
      return prefix + ORDER_ALPHABET[mid]!
    }
    prefix += ORDER_ALPHABET[minIdx]!
  }
  return `${prefix}V`
}

// ============================================================
// LWW-Element-Set Operations (NEVER call delRow() on set tables!)
// ============================================================

export function setPitPhotoKeyActive(
  store: MergeableStore,
  teamNumber: number,
  photoKey: string,
  active: boolean,
  addedBy = ''
): string {
  const cleanKey = (photoKey || '').trim()
  if (!cleanKey || !teamNumber) return ''
  const rowId = pitPhotoKeyRowId(teamNumber, cleanKey)
  setChangedCells(store, CRDT_TABLES.PIT_PHOTO_KEYS, rowId, {
    teamNumber: Number(teamNumber),
    photoKey: cleanKey,
    active: Boolean(active),
    addedBy
  })
  return rowId
}

export function getActivePhotoKeysForTeam(store: MergeableStore, teamNumber: number): string[] {
  const table = store.getTable(CRDT_TABLES.PIT_PHOTO_KEYS)
  const keys: string[] = []
  for (const row of Object.values(table)) {
    if (Number(row.teamNumber) === Number(teamNumber) && row.active === true && typeof row.photoKey === 'string') {
      const key = row.photoKey.trim()
      if (key) keys.push(key)
    }
  }
  return keys.sort()
}

export function writeTeamTagToCrdt(store: MergeableStore, tag: TeamTagItem, active = true): string {
  const normalized = normalizeTagName(tag.tag)
  if (!normalized || !tag.teamNumber) return ''
  const rowId = teamTagRowId(tag.teamNumber, normalized)
  setChangedCells(store, CRDT_TABLES.TEAM_TAGS, rowId, {
    id: tag.id || `${tag.eventId || 'evt'}_tag_${tag.teamNumber}_${normalized}`,
    eventId: tag.eventId || '',
    teamNumber: Number(tag.teamNumber),
    tag: normalized,
    color: tag.color || 'blue',
    isPreset: Boolean(tag.isPreset),
    active: Boolean(active),
    createdBy: tag.createdBy || ''
  })
  return rowId
}

export function setTeamTagActive(
  store: MergeableStore,
  eventId: string,
  tag: TeamTagItem,
  active: boolean
): string {
  return writeTeamTagToCrdt(store, { ...tag, eventId: tag.eventId || eventId }, active)
}

export function readTeamTagsFromCrdt(store: MergeableStore, eventId?: string): TeamTagItem[] {
  const table = store.getTable(CRDT_TABLES.TEAM_TAGS)
  const out: TeamTagItem[] = []
  for (const row of Object.values(table)) {
    if (row.active !== true) continue
    const rowEventId = typeof row.eventId === 'string' ? row.eventId : ''
    if (eventId && rowEventId && rowEventId !== eventId) continue
    const teamNumber = Number(row.teamNumber || 0)
    const tag = typeof row.tag === 'string' ? row.tag : ''
    if (!teamNumber || !tag) continue
    out.push({
      id: typeof row.id === 'string' && row.id ? row.id : `${rowEventId || eventId || 'evt'}_tag_${teamNumber}_${tag}`,
      eventId: rowEventId || eventId || '',
      teamNumber,
      tag,
      color: (typeof row.color === 'string' && row.color ? row.color : 'blue') as TeamTagItem['color'],
      isPreset: row.isPreset === true,
      createdBy: typeof row.createdBy === 'string' && row.createdBy ? row.createdBy : undefined
    })
  }
  return out
}

// ============================================================
// Pit Scouting Record Codec
// ============================================================

export function writePitRecordToCrdt(
  store: MergeableStore,
  record: PitScoutingRecord,
  options?: { syncPhotoKeys?: boolean }
): string {
  if (!record || !record.teamNumber) return ''
  const teamNum = Number(record.teamNumber)
  const rowId = pitRowId(teamNum)

  let rawDataJson = typeof record.rawData === 'string' ? record.rawData : ''
  if (!rawDataJson && record.customFields && Object.keys(record.customFields).length > 0) {
    rawDataJson = JSON.stringify({ customFields: record.customFields })
  }

  store.transaction(() => {
    setChangedCells(store, CRDT_TABLES.PIT_RECORDS, rowId, {
      id: record.id || `${record.eventId || 'evt'}_pit_${teamNum}`,
      eventId: record.eventId || '',
      teamNumber: teamNum,
      scoutId: record.scoutId || '',
      scoutName: record.scoutName || '',
      robotName: record.robotName ?? '',
      drivetrainType: record.drivetrainType || 'mecanum',
      weightLbs: Number(record.weightLbs || 0),
      chassisSize: record.chassisSize ?? '',
      ballCompatibility: record.ballCompatibility || 'universal',
      launcherType: record.launcherType ?? '',
      flowerMechanism: record.flowerMechanism ?? '',
      hasColorSensor: Boolean(record.hasColorSensor),
      hasDescoreMech: Boolean(record.hasDescoreMech),
      hasApriltagVision: Boolean(record.hasApriltagVision),
      odometryType: record.odometryType || 'none',
      claimedAutoStrategy: record.claimedAutoStrategy ?? '',
      claimedAutoScore: Number(record.claimedAutoScore || 0),
      claimedTeleopCycles: Number(record.claimedTeleopCycles || 0),
      claimedTeleopScore: Number(record.claimedTeleopScore || 0),
      claimedTeleopPark: Boolean(record.claimedTeleopPark),
      claimedFlowerNectars: Number(record.claimedFlowerNectars || 0),
      claimedFlowerBottomBonus: Number(record.claimedFlowerBottomBonus || 0),
      claimedFlowerPollens: Number(record.claimedFlowerPollens || 0),
      claimedGardenBalls: Number(record.claimedGardenBalls || 0),
      claimedEndgameScore: Number(record.claimedEndgameScore || 0),
      claimedTotalScore: Number(record.claimedTotalScore || 0),
      rawDataJson,
      version: Math.max(1, Number(record.version || 1)),
      isDeleted: Boolean(record.isDeleted)
    })

    if (options?.syncPhotoKeys !== false && Array.isArray(record.photoKeys)) {
      const nextSet = new Set(record.photoKeys.map((k) => k.trim()).filter(Boolean))
      const existingActive = getActivePhotoKeysForTeam(store, teamNum)
      for (const existingKey of existingActive) {
        if (!nextSet.has(existingKey)) {
          setPitPhotoKeyActive(store, teamNum, existingKey, false, record.scoutId || '')
        }
      }
      for (const key of nextSet) {
        setPitPhotoKeyActive(store, teamNum, key, true, record.scoutId || '')
      }
    }
  })

  return rowId
}

export function readPitRecordsFromCrdt(store: MergeableStore, eventId?: string): PitScoutingRecord[] {
  const table = store.getTable(CRDT_TABLES.PIT_RECORDS)
  const photoTable = store.getTable(CRDT_TABLES.PIT_PHOTO_KEYS)

  const photosByTeam = new Map<number, string[]>()
  for (const row of Object.values(photoTable)) {
    if (row.active !== true || typeof row.photoKey !== 'string') continue
    const t = Number(row.teamNumber || 0)
    const k = row.photoKey.trim()
    if (t > 0 && k) {
      const list = photosByTeam.get(t) ?? []
      list.push(k)
      photosByTeam.set(t, list)
    }
  }
  for (const list of photosByTeam.values()) {
    list.sort()
  }

  const out: PitScoutingRecord[] = []
  for (const row of Object.values(table)) {
    const teamNumber = Number(row.teamNumber || 0)
    if (!teamNumber) continue
    const rowEventId = typeof row.eventId === 'string' ? row.eventId : ''
    if (eventId && rowEventId && rowEventId !== eventId) continue

    const rawData = typeof row.rawDataJson === 'string' && row.rawDataJson ? row.rawDataJson : undefined
    let customFields: Record<string, any> | undefined
    if (rawData) {
      try {
        const parsed = JSON.parse(rawData)
        if (parsed && typeof parsed === 'object' && parsed.customFields) {
          customFields = parsed.customFields
        }
      } catch {}
    }

    out.push({
      id: typeof row.id === 'string' && row.id ? row.id : `${rowEventId || eventId || 'evt'}_pit_${teamNumber}`,
      eventId: rowEventId || eventId || '',
      teamNumber,
      scoutId: typeof row.scoutId === 'string' ? row.scoutId : '',
      scoutName: typeof row.scoutName === 'string' ? row.scoutName : '',
      robotName: typeof row.robotName === 'string' ? row.robotName : '',
      drivetrainType: (typeof row.drivetrainType === 'string' && row.drivetrainType ? row.drivetrainType : 'mecanum') as PitScoutingRecord['drivetrainType'],
      weightLbs: Number(row.weightLbs || 0),
      chassisSize: typeof row.chassisSize === 'string' ? row.chassisSize : '',
      ballCompatibility: (typeof row.ballCompatibility === 'string' && row.ballCompatibility ? row.ballCompatibility : 'universal') as BallCompatibility,
      launcherType: typeof row.launcherType === 'string' ? row.launcherType : '',
      flowerMechanism: typeof row.flowerMechanism === 'string' ? row.flowerMechanism : '',
      hasColorSensor: row.hasColorSensor === true,
      hasDescoreMech: row.hasDescoreMech === true,
      hasApriltagVision: row.hasApriltagVision === true,
      odometryType: typeof row.odometryType === 'string' && row.odometryType ? row.odometryType : 'none',
      claimedAutoStrategy: typeof row.claimedAutoStrategy === 'string' ? row.claimedAutoStrategy : '',
      claimedAutoScore: Number(row.claimedAutoScore || 0),
      claimedTeleopCycles: Number(row.claimedTeleopCycles || 0),
      claimedTeleopScore: Number(row.claimedTeleopScore || 0),
      claimedTeleopPark: row.claimedTeleopPark === true,
      claimedFlowerNectars: Number(row.claimedFlowerNectars || 0),
      claimedFlowerBottomBonus: Number(row.claimedFlowerBottomBonus || 0),
      claimedFlowerPollens: Number(row.claimedFlowerPollens || 0),
      claimedGardenBalls: Number(row.claimedGardenBalls || 0),
      claimedEndgameScore: Number(row.claimedEndgameScore || 0),
      claimedTotalScore: Number(row.claimedTotalScore || 0),
      photoKeys: photosByTeam.get(teamNumber) ?? [],
      rawData,
      customFields,
      version: Math.max(1, Number(row.version || 1)),
      isDeleted: row.isDeleted === true,
      syncStatus: 'SYNCED'
    })
  }
  return out
}

// ============================================================
// Custom Fields Codec
// ============================================================

export function writeCustomFieldToCrdt(
  store: MergeableStore,
  field: CustomFieldDefinition & { orderKey?: string },
  isDeleted = false
): string {
  if (!field || !field.id) return ''
  const rowId = customFieldRowId(field.id)
  const optionsJson =
    typeof field.optionsJson === 'string' && field.optionsJson
      ? field.optionsJson
      : Array.isArray(field.options) && field.options.length > 0
      ? JSON.stringify(field.options)
      : ''

  const existingOrderKey = store.getCell(CRDT_TABLES.CUSTOM_FIELDS, rowId, 'orderKey')
  const orderKey =
    field.orderKey ||
    (typeof existingOrderKey === 'string' && existingOrderKey ? existingOrderKey : orderKeyFromSeq(field.orderSeq || 0))

  setChangedCells(store, CRDT_TABLES.CUSTOM_FIELDS, rowId, {
    id: field.id,
    eventId: field.eventId || '',
    target: field.target || 'MATCH',
    phase: field.phase || 'overall',
    name: field.name || '',
    fieldKey: field.fieldKey || '',
    fieldType: field.fieldType || 'text',
    required: Boolean(field.required),
    defaultVal: field.defaultVal ?? '',
    optionsJson,
    minVal: typeof field.minVal === 'number' && Number.isFinite(field.minVal) ? field.minVal : '',
    maxVal: typeof field.maxVal === 'number' && Number.isFinite(field.maxVal) ? field.maxVal : '',
    stepVal: typeof field.stepVal === 'number' && Number.isFinite(field.stepVal) ? field.stepVal : '',
    unit: field.unit ?? '',
    orderSeq: Number(field.orderSeq || 0),
    orderKey,
    isActive: field.isActive !== false,
    isDeleted: Boolean(isDeleted)
  })
  return rowId
}

export function readCustomFieldsFromCrdt(store: MergeableStore, eventId?: string): CustomFieldDefinition[] {
  const table = store.getTable(CRDT_TABLES.CUSTOM_FIELDS)
  const items: Array<CustomFieldDefinition & { _orderKey: string }> = []

  for (const row of Object.values(table)) {
    if (row.isDeleted === true) continue
    const rowEventId = typeof row.eventId === 'string' ? row.eventId : ''
    if (eventId && rowEventId && rowEventId !== eventId) continue
    const id = typeof row.id === 'string' ? row.id : ''
    if (!id) continue

    const optionsJson = typeof row.optionsJson === 'string' && row.optionsJson ? row.optionsJson : null
    let options: CustomFieldOption[] | undefined
    if (optionsJson) {
      try {
        options = JSON.parse(optionsJson)
      } catch {
        options = []
      }
    }

    const orderSeq = Number(row.orderSeq || 0)
    const orderKey = typeof row.orderKey === 'string' && row.orderKey ? row.orderKey : orderKeyFromSeq(orderSeq)

    items.push({
      id,
      eventId: rowEventId || eventId || '',
      target: (typeof row.target === 'string' ? row.target : 'MATCH') as CustomFieldTarget,
      phase: (typeof row.phase === 'string' ? row.phase : 'overall') as CustomFieldPhase,
      name: typeof row.name === 'string' ? row.name : '',
      fieldKey: typeof row.fieldKey === 'string' ? row.fieldKey : '',
      fieldType: (typeof row.fieldType === 'string' ? row.fieldType : 'text') as CustomFieldType,
      required: row.required === true,
      defaultVal: typeof row.defaultVal === 'string' && row.defaultVal !== '' ? row.defaultVal : null,
      optionsJson,
      options,
      minVal: typeof row.minVal === 'number' ? row.minVal : null,
      maxVal: typeof row.maxVal === 'number' ? row.maxVal : null,
      stepVal: typeof row.stepVal === 'number' ? row.stepVal : null,
      unit: typeof row.unit === 'string' && row.unit !== '' ? row.unit : null,
      orderSeq,
      isActive: row.isActive !== false,
      _orderKey: orderKey
    })
  }

  items.sort((a, b) => a._orderKey.localeCompare(b._orderKey) || a.orderSeq - b.orderSeq || a.id.localeCompare(b.id))
  return items.map(({ _orderKey: _ignored, ...def }, idx) => ({
    ...def,
    orderSeq: def.orderSeq > 0 ? def.orderSeq : idx + 1
  }))
}

// ============================================================
// Schedules & Assignments Codecs
// ============================================================

export function writeScheduleToCrdt(
  store: MergeableStore,
  item: MatchScheduleItem,
  isDeleted = false
): string {
  if (!item || !item.matchNumber) return ''
  const level = (item.tournamentLevel || 'QUALIFICATION').trim().toUpperCase() || 'QUALIFICATION'
  const rowId = scheduleRowId(item.matchNumber, level)
  setChangedCells(store, CRDT_TABLES.SCHEDULES, rowId, {
    id: item.id || `${item.eventId || 'evt'}_${level}_M${item.matchNumber}`,
    eventId: item.eventId || '',
    matchNumber: Number(item.matchNumber),
    tournamentLevel: level,
    red1: Number(item.red1 || 0),
    red2: Number(item.red2 || 0),
    blue1: Number(item.blue1 || 0),
    blue2: Number(item.blue2 || 0),
    scoreRedFinal: typeof item.scoreRedFinal === 'number' && Number.isFinite(item.scoreRedFinal) ? item.scoreRedFinal : '',
    scoreBlueFinal: typeof item.scoreBlueFinal === 'number' && Number.isFinite(item.scoreBlueFinal) ? item.scoreBlueFinal : '',
    isDeleted: Boolean(isDeleted)
  })
  return rowId
}

export function readSchedulesFromCrdt(store: MergeableStore, eventId?: string): MatchScheduleItem[] {
  const table = store.getTable(CRDT_TABLES.SCHEDULES)
  const out: MatchScheduleItem[] = []
  for (const row of Object.values(table)) {
    if (row.isDeleted === true) continue
    const rowEventId = typeof row.eventId === 'string' ? row.eventId : ''
    if (eventId && rowEventId && rowEventId !== eventId) continue
    const matchNumber = Number(row.matchNumber || 0)
    if (!matchNumber) continue
    const level = typeof row.tournamentLevel === 'string' && row.tournamentLevel ? row.tournamentLevel : 'QUALIFICATION'
    out.push({
      id: typeof row.id === 'string' && row.id ? row.id : `${rowEventId || eventId || 'evt'}_${level}_M${matchNumber}`,
      eventId: rowEventId || eventId || '',
      matchNumber,
      tournamentLevel: level,
      red1: Number(row.red1 || 0),
      red2: Number(row.red2 || 0),
      blue1: Number(row.blue1 || 0),
      blue2: Number(row.blue2 || 0),
      scoreRedFinal: typeof row.scoreRedFinal === 'number' ? row.scoreRedFinal : null,
      scoreBlueFinal: typeof row.scoreBlueFinal === 'number' ? row.scoreBlueFinal : null
    })
  }
  return out
}

export function writeAssignmentToCrdt(
  store: MergeableStore,
  assignment: ScoutAssignment,
  isDeleted = false
): string {
  if (!assignment || !assignment.matchNumber || !assignment.station) return ''
  const level = (assignment.tournamentLevel || 'QUALIFICATION').trim().toUpperCase() || 'QUALIFICATION'
  const rowId = assignmentRowId(assignment.matchNumber, assignment.station, level)
  setChangedCells(store, CRDT_TABLES.ASSIGNMENTS, rowId, {
    id: assignment.id || `${assignment.eventId || 'evt'}_${level}_${assignment.matchNumber}_${assignment.station}`,
    eventId: assignment.eventId || '',
    matchNumber: Number(assignment.matchNumber),
    tournamentLevel: level,
    station: assignment.station,
    teamNumber: Number(assignment.teamNumber || 0),
    scoutId: assignment.scoutId ?? '',
    scoutName: assignment.scoutName ?? '',
    isDeleted: Boolean(isDeleted)
  })
  return rowId
}

export function readAssignmentsFromCrdt(
  store: MergeableStore,
  eventId?: string
): Record<string, ScoutAssignment> {
  const table = store.getTable(CRDT_TABLES.ASSIGNMENTS)
  const out: Record<string, ScoutAssignment> = {}
  for (const row of Object.values(table)) {
    if (row.isDeleted === true) continue
    const rowEventId = typeof row.eventId === 'string' ? row.eventId : ''
    if (eventId && rowEventId && rowEventId !== eventId) continue
    const matchNumber = Number(row.matchNumber || 0)
    const station = typeof row.station === 'string' ? row.station : ''
    if (!matchNumber || !station) continue
    const level = (typeof row.tournamentLevel === 'string' && row.tournamentLevel ? row.tournamentLevel : 'QUALIFICATION').toUpperCase()
    const key = assignmentRowId(matchNumber, station, level)
    out[key] = {
      id: typeof row.id === 'string' && row.id ? row.id : `${rowEventId || eventId || 'evt'}_${level}_${matchNumber}_${station}`,
      eventId: rowEventId || eventId || '',
      matchNumber,
      tournamentLevel: level,
      station: station as StationType,
      teamNumber: Number(row.teamNumber || 0),
      scoutId: typeof row.scoutId === 'string' && row.scoutId !== '' ? row.scoutId : null,
      scoutName: typeof row.scoutName === 'string' && row.scoutName !== '' ? row.scoutName : null
    }
  }
  return out
}

// ============================================================
// Member Identities Codec (Trusted ECDSA Anchors)
// ============================================================

export function writeMemberIdentityToCrdt(store: MergeableStore, entry: MemberIdentityEntry): string {
  if (!entry.userId || !entry.deviceId || !entry.signingPubKeyHex) return ''
  const rowId = memberIdentityRowId(entry.userId, entry.deviceId)
  setChangedCells(store, CRDT_TABLES.MEMBER_IDENTITIES, rowId, {
    eventId: entry.eventId ?? '',
    userId: entry.userId,
    deviceId: entry.deviceId,
    signingPubKeyHex: entry.signingPubKeyHex,
    trustedAt: Number(entry.trustedAt || Date.now()),
    hostPubKey: entry.hostPubKey ?? '',
    hostSig: entry.hostSig ?? ''
  })
  return rowId
}

export function readMemberIdentitiesFromCrdt(store: MergeableStore, eventId?: string): MemberIdentityEntry[] {
  const table = store.getTable(CRDT_TABLES.MEMBER_IDENTITIES)
  const out: MemberIdentityEntry[] = []
  for (const row of Object.values(table)) {
    const rowEventId = typeof row.eventId === 'string' ? row.eventId : ''
    if (eventId && rowEventId && rowEventId !== eventId) continue
    const userId = typeof row.userId === 'string' ? row.userId : ''
    const deviceId = typeof row.deviceId === 'string' ? row.deviceId : ''
    const signingPubKeyHex = typeof row.signingPubKeyHex === 'string' ? row.signingPubKeyHex : ''
    if (!userId || !deviceId || !signingPubKeyHex) continue
    out.push({
      eventId: rowEventId || eventId || undefined,
      userId,
      deviceId,
      signingPubKeyHex,
      trustedAt: Number(row.trustedAt || 0),
      hostPubKey: typeof row.hostPubKey === 'string' && row.hostPubKey ? row.hostPubKey : undefined,
      hostSig: typeof row.hostSig === 'string' && row.hostSig ? row.hostSig : undefined
    })
  }
  return out
}

// ============================================================
// Match Scouting Records Codec (CRDT + Author ECDSA Signature)
// ============================================================

export function writeScoutingRecordToCrdt(store: MergeableStore, record: ScoutingRecord): string {
  if (!record || !record.id) return ''
  const rowId = scoutingRecordRowId(record.id)
  setChangedCells(store, CRDT_TABLES.SCOUTING_RECORDS, rowId, {
    id: record.id,
    eventId: record.eventId || '',
    scoutId: record.scoutId || '',
    scoutName: record.scoutName || '',
    matchNumber: Number(record.matchNumber || 0),
    teamNumber: Number(record.teamNumber || 0),
    autoScore: Number(record.autoScore || 0),
    teleopScore: Number(record.teleopScore || 0),
    endgameScore: Number(record.endgameScore || 0),
    totalScore: Number(record.totalScore || 0),
    notes: record.notes ?? '',
    rawDataJson: typeof record.rawData === 'string' && record.rawData ? record.rawData : '{}',
    isBroken: Boolean(record.isBroken),
    version: Math.max(1, Number(record.version || 1)),
    isDeleted: Boolean(record.isDeleted),
    createdAt: record.createdAt || '',
    updatedAt: record.updatedAt || '',
    authorPubKey: record.authorPubKey ?? '',
    authorSig: record.authorSig ?? '',
    hostSig: record.hostSig ?? ''
  })
  return rowId
}

export function readScoutingRecordsFromCrdt(store: MergeableStore, eventId?: string): ScoutingRecord[] {
  const table = store.getTable(CRDT_TABLES.SCOUTING_RECORDS)
  const out: ScoutingRecord[] = []
  for (const [rowId, row] of Object.entries(table)) {
    const id = typeof row.id === 'string' && row.id ? row.id : rowId
    const rowEventId = typeof row.eventId === 'string' ? row.eventId : ''
    if (!id) continue
    if (eventId && rowEventId && rowEventId !== eventId) continue
    const matchNumber = Number(row.matchNumber || 0)
    const teamNumber = Number(row.teamNumber || 0)
    if (!matchNumber || !teamNumber) continue

    const authorPubKey = typeof row.authorPubKey === 'string' && row.authorPubKey ? row.authorPubKey : undefined
    const authorSig = typeof row.authorSig === 'string' && row.authorSig ? row.authorSig : undefined
    const hostSig = typeof row.hostSig === 'string' && row.hostSig ? row.hostSig : undefined

    out.push({
      id,
      eventId: rowEventId || eventId || '',
      scoutId: typeof row.scoutId === 'string' ? row.scoutId : '',
      scoutName: typeof row.scoutName === 'string' ? row.scoutName : '',
      matchNumber,
      teamNumber,
      autoScore: Number(row.autoScore || 0),
      teleopScore: Number(row.teleopScore || 0),
      endgameScore: Number(row.endgameScore || 0),
      totalScore: Number(row.totalScore || 0),
      notes: typeof row.notes === 'string' ? row.notes : '',
      rawData: typeof row.rawDataJson === 'string' && row.rawDataJson ? row.rawDataJson : '{}',
      syncStatus: 'SYNCED',
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '',
      isBroken: row.isBroken === true,
      isDeleted: row.isDeleted === true,
      version: Math.max(1, Number(row.version || 1)),
      ...(authorPubKey ? { authorPubKey } : {}),
      ...(authorSig ? { authorSig } : {}),
      ...(hostSig ? { hostSig } : {})
    })
  }
  return out
}
