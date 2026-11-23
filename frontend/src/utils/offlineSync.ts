import type { ScoutingEvent, ScoutingRecord, TeamTagItem } from '@/types'
import { scanMergeableContent, verifyScoutingRecordSignature } from '@/services/crdt'
import { hasSubtleCrypto } from '@/utils/crypto'

export interface EventPackageFile {
  format: 'SCOUTING_PRO_27_EVENT'
  version: 1
  exportedAt: string
  exportedBy: {
    userId: string
    username: string
    role: 'HOST' | 'SCOUT'
  }
  event: ScoutingEvent
  schedule?: import('@/types').MatchScheduleItem[]
  assignments?: import('@/types').ScoutAssignment[]
}

export type SyncPacketType = 'CLIENT_PUSH' | 'HOST_BROADCAST'

export interface SyncPackageFile {
  format: 'SCOUTING_PRO_27_SYNC'
  version: 1
  packetType: SyncPacketType
  eventId: string
  eventName: string
  sender: {
    userId: string
    username: string
    role: 'HOST' | 'SCOUT'
  }
  target: {
    recipientType: 'HOST' | 'ALL_SCOUTS' | 'SCOUT'
    targetUserId?: string
    targetUsername?: string
  }
  syncRange: {
    recordCount: number
    hasCrdtSnapshot?: boolean
  }
  exportedAt: string
  payload: {
    records: ScoutingRecord[]
    teamTags?: TeamTagItem[]
    hostSessionId?: string
    crdtSnapshot?: unknown
  }
}

/**
 * 清洗字符串用于安全文件名（仅保留字母数字下划线减号）
 */
export function sanitizeFileSegment(str: string): string {
  if (!str) return 'unknown'
  const cleaned = str.trim().replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_').replace(/_+/g, '_')
  return cleaned.slice(0, 30) || 'unnamed'
}

/**
 * 格式化时间戳为 YYYYMMDD 或 YYYYMMDD_HHmm
 */
export function formatDateTag(d: Date = new Date(), includeTime = true): string {
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  if (!includeTime) return `${yyyy}${mm}${dd}`
  const hh = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${yyyy}${mm}${dd}_${hh}${min}`
}

/**
 * 自动生成赛事配置文件名: [EventName]_[InviteCode]_[Date].event
 */
export function generateEventFileName(event: ScoutingEvent, exportedAt: Date = new Date()): string {
  const nameBase = sanitizeFileSegment(event.ftcEventCode || event.name || 'EVENT')
  const codeBase = sanitizeFileSegment(event.inviteCode || 'CODE')
  const dateStr = formatDateTag(exportedAt, false)
  return `${nameBase}_${codeBase}_${dateStr}.event`
}

/**
 * 自动生成增量数据包文件名:
 * Client -> Host: [EventName]_[ScoutName]_to_HOST_r[Count]_[Timestamp].info
 * Host -> All:    [EventName]_HOST_to_ALL_r[Count]_[Timestamp].info
 * Host -> Scout:  [EventName]_HOST_to_[ScoutName]_r[Count]_[Timestamp].info
 */
export function generateSyncFileName(params: {
  eventName: string
  senderName: string
  isHost: boolean
  targetName?: string
  recordCount: number
  exportedAt?: Date
}): string {
  const eventBase = sanitizeFileSegment(params.eventName || 'EVENT')
  const dateStr = formatDateTag(params.exportedAt || new Date(), true)

  if (!params.isHost) {
    const scoutBase = sanitizeFileSegment(params.senderName || 'Scout')
    return `${eventBase}_${scoutBase}_to_HOST_r${params.recordCount}_${dateStr}.info`
  } else {
    const target = params.targetName && params.targetName !== 'ALL'
      ? sanitizeFileSegment(params.targetName)
      : 'ALL'
    return `${eventBase}_HOST_to_${target}_r${params.recordCount}_${dateStr}.info`
  }
}

/**
 * 触发浏览器文件下载
 */
export function triggerFileDownload(filename: string, content: string, mimeType = 'application/json'): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * 创建赛事配置包 JSON
 */
export function createEventPackage(
  event: ScoutingEvent,
  exportedBy: { userId: string; username: string; role: 'HOST' | 'SCOUT' },
  schedule?: import('@/types').MatchScheduleItem[],
  assignments?: import('@/types').ScoutAssignment[]
): string {
  const pkg: EventPackageFile = {
    format: 'SCOUTING_PRO_27_EVENT',
    version: 1,
    exportedAt: new Date().toISOString(),
    exportedBy,
    event,
    schedule,
    assignments
  }
  return JSON.stringify(pkg, null, 2)
}

/**
 * 创建增量同步数据包 JSON
 */
export function createSyncPackage(params: {
  packetType: SyncPacketType
  eventId: string
  eventName: string
  sender: { userId: string; username: string; role: 'HOST' | 'SCOUT' }
  target: { recipientType: 'HOST' | 'ALL_SCOUTS' | 'SCOUT'; targetUserId?: string; targetUsername?: string }
  records: ScoutingRecord[]
  teamTags?: TeamTagItem[]
  hostSessionId?: string
  crdtSnapshot?: unknown
}): string {
  const pkg: SyncPackageFile = {
    format: 'SCOUTING_PRO_27_SYNC',
    version: 1,
    packetType: params.packetType,
    eventId: params.eventId,
    eventName: params.eventName,
    sender: params.sender,
    target: params.target,
    syncRange: {
      recordCount: params.records.length,
      ...(params.crdtSnapshot !== undefined ? { hasCrdtSnapshot: true } : {})
    },
    exportedAt: new Date().toISOString(),
    payload: {
      records: params.records,
      teamTags: params.teamTags,
      hostSessionId: params.hostSessionId,
      ...(params.crdtSnapshot !== undefined ? { crdtSnapshot: params.crdtSnapshot } : {})
    }
  }
  return JSON.stringify(pkg, null, 2)
}

/**
 * 解析并校验 .event 文件
 */
export function parseEventPackage(rawJson: string): EventPackageFile {
  let parsed: any
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    throw new Error('文件不是有效的 JSON 格式')
  }

  if (parsed.format !== 'SCOUTING_PRO_27_EVENT') {
    throw new Error('无效的赛事包文件格式 (缺少 SCOUTING_PRO_27_EVENT 标识)')
  }
  if (!parsed.event || !parsed.event.id || !parsed.event.name || !parsed.event.inviteCode) {
    throw new Error('赛事包损坏：缺少关键赛事信息 (id, name, inviteCode)')
  }
  return parsed as EventPackageFile
}

/**
 * 解析并校验 .info 文件
 */
export function parseSyncPackage(rawJson: string): SyncPackageFile {
  let parsed: any
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    throw new Error('文件不是有效的 JSON 格式')
  }

  if (parsed.format !== 'SCOUTING_PRO_27_SYNC') {
    throw new Error('无效的同步包文件格式 (缺少 SCOUTING_PRO_27_SYNC 标识)')
  }
  if (!parsed.eventId || !parsed.payload || !Array.isArray(parsed.payload.records)) {
    throw new Error('同步包损坏：缺少 eventId 或 records 列表')
  }
  return parsed as SyncPackageFile
}

const CLIENT_ALLOWED_CRDT_TABLES = new Set([
  'scouting_records',
  'member_identities',
  'pit_records',
  'pit_photo_keys',
  'team_tags'
])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v))
}

function extractCellPrimitive(cellsObj: Record<string, unknown>, cellKey: string): unknown {
  const cellTuple = cellsObj[cellKey]
  return Array.isArray(cellTuple) ? cellTuple[0] : undefined
}

function matchesExpectedEventCell(cellsObj: Record<string, unknown>, eventId?: string): boolean {
  if (!eventId) return true
  const rawEventId = extractCellPrimitive(cellsObj, 'eventId')
  if (typeof rawEventId !== 'string' || rawEventId === '') return true
  return rawEventId === eventId
}

/**
 * 过滤客户端导出快照：仅保留客户端允许同步的 5 张表、当前赛事行及发送者本人的记录与身份，
 * 剔除 Host 专属管理表（custom_fields/schedules/assignments）及队友记录，防止 Host 误拒合法客户端包。
 */
export function buildClientExportCrdtSnapshot(
  snapshot: unknown,
  senderUserId: string,
  eventId?: string
): unknown | undefined {
  if (!senderUserId || !Array.isArray(snapshot) || snapshot.length !== 2) return undefined
  const tablesStamp = snapshot[0]
  if (!Array.isArray(tablesStamp) || !isPlainObject(tablesStamp[0])) return undefined

  const rawTablesObj = tablesStamp[0] as Record<string, unknown>
  const filteredTablesObj: Record<string, unknown> = {}
  let hasAnyRow = false

  for (const [tableName, tableTuple] of Object.entries(rawTablesObj)) {
    if (!CLIENT_ALLOWED_CRDT_TABLES.has(tableName)) continue
    if (!Array.isArray(tableTuple) || !isPlainObject(tableTuple[0])) continue

    const rawRowsObj = tableTuple[0] as Record<string, unknown>
    const filteredRowsObj: Record<string, unknown> = {}

    for (const [rowId, rowTuple] of Object.entries(rawRowsObj)) {
      if (!Array.isArray(rowTuple) || !isPlainObject(rowTuple[0])) continue
      const cellsObj = rowTuple[0] as Record<string, unknown>
      if (!matchesExpectedEventCell(cellsObj, eventId)) continue

      if (tableName === 'scouting_records') {
        if (extractCellPrimitive(cellsObj, 'scoutId') !== senderUserId) continue
      } else if (tableName === 'member_identities') {
        if (extractCellPrimitive(cellsObj, 'userId') !== senderUserId) continue
      }

      filteredRowsObj[rowId] = rowTuple.slice(0, 2)
    }

    if (Object.keys(filteredRowsObj).length > 0) {
      filteredTablesObj[tableName] = [filteredRowsObj, '']
      hasAnyRow = true
    }
  }

  if (!hasAnyRow) return undefined
  return [
    [filteredTablesObj, ''],
    [{}, '']
  ]
}

function findUnauthorizedClientCrdtRows(
  snapshot: unknown,
  senderUserId: string | undefined,
  currentEventId: string,
  existingRecordOwners?: ReadonlyMap<string, string>
): string[] {
  if (snapshot === undefined || snapshot === null) return []
  if (
    !Array.isArray(snapshot) ||
    snapshot.length !== 2 ||
    !Array.isArray(snapshot[0]) ||
    !Array.isArray(snapshot[1]) ||
    !isPlainObject(snapshot[0][0]) ||
    !isPlainObject(snapshot[1][0])
  ) {
    return ['__malformed_crdt_snapshot__']
  }

  const unauthorized: string[] = []
  const tablesStamp = snapshot[0] as unknown[]
  const valuesStamp = snapshot[1] as unknown[]
  const tablesObj = tablesStamp[0] as Record<string, unknown>
  const valuesObj = valuesStamp[0] as Record<string, unknown>

  if (Object.keys(valuesObj).length > 0 || (typeof valuesStamp[1] === 'string' && valuesStamp[1].length > 0)) {
    unauthorized.push('__forbidden_crdt_values__')
  }

  if (Object.keys(tablesObj).length === 0 && typeof tablesStamp[1] === 'string' && tablesStamp[1].length > 0) {
    unauthorized.push('__malformed_crdt_snapshot__')
  }

  for (const [tableName, tableTuple] of Object.entries(tablesObj)) {
    if (!CLIENT_ALLOWED_CRDT_TABLES.has(tableName)) {
      unauthorized.push(`__forbidden_table__:${tableName}`)
      continue
    }
    if (!Array.isArray(tableTuple) || !isPlainObject(tableTuple[0])) {
      unauthorized.push(`__malformed_table__:${tableName}`)
      continue
    }
    const rowsObj = tableTuple[0] as Record<string, unknown>
    if (Object.keys(rowsObj).length === 0 && typeof tableTuple[1] === 'string' && tableTuple[1].length > 0) {
      unauthorized.push(`__table_tombstone__:${tableName}`)
      continue
    }

    for (const [rowId, rowTuple] of Object.entries(rowsObj)) {
      if (!Array.isArray(rowTuple) || !isPlainObject(rowTuple[0])) {
        unauthorized.push(`${tableName}:${rowId}`)
        continue
      }
      const cellsObj = rowTuple[0] as Record<string, unknown>
      if (!matchesExpectedEventCell(cellsObj, currentEventId)) {
        unauthorized.push(`${tableName}:${rowId}`)
        continue
      }

      if (tableName === 'scouting_records') {
        const ownerVal = extractCellPrimitive(cellsObj, 'scoutId')
        if (!senderUserId || typeof ownerVal !== 'string' || ownerVal !== senderUserId) {
          unauthorized.push(rowId)
          continue
        }
        if (existingRecordOwners?.has(rowId) && existingRecordOwners.get(rowId) !== senderUserId) {
          unauthorized.push(rowId)
          continue
        }
      } else if (tableName === 'member_identities') {
        const ownerVal = extractCellPrimitive(cellsObj, 'userId')
        if (!senderUserId || typeof ownerVal !== 'string' || ownerVal !== senderUserId) {
          unauthorized.push(rowId)
          continue
        }
      }
    }
  }

  return unauthorized
}

function findMalformedOrCrossEventCrdtRows(snapshot: unknown, currentEventId: string): string[] {
  if (snapshot === undefined || snapshot === null) return []
  if (
    !Array.isArray(snapshot) ||
    snapshot.length !== 2 ||
    !Array.isArray(snapshot[0]) ||
    !Array.isArray(snapshot[1]) ||
    !isPlainObject(snapshot[0][0]) ||
    !isPlainObject(snapshot[1][0])
  ) {
    return ['__malformed_crdt_snapshot__']
  }

  const invalid: string[] = []
  const tablesObj = snapshot[0][0] as Record<string, unknown>
  for (const [tableName, tableTuple] of Object.entries(tablesObj)) {
    if (!Array.isArray(tableTuple) || !isPlainObject(tableTuple[0])) {
      invalid.push(`__malformed_table__:${tableName}`)
      continue
    }
    const rowsObj = tableTuple[0] as Record<string, unknown>
    for (const [rowId, rowTuple] of Object.entries(rowsObj)) {
      if (!Array.isArray(rowTuple) || !isPlainObject(rowTuple[0])) {
        invalid.push(`${tableName}:${rowId}`)
        continue
      }
      const cellsObj = rowTuple[0] as Record<string, unknown>
      if (!matchesExpectedEventCell(cellsObj, currentEventId)) {
        invalid.push(`${tableName}:${rowId}`)
      }
    }
  }
  return invalid
}

export interface SyncSecurityOptions {
  expectedHostUserId?: string
  existingRecordOwners?: ReadonlyMap<string, string>
}

/**
 * 针对当前环境执行同步包业务安全核验
 */
export function validateSyncPackageSecurity(
  pkg: SyncPackageFile,
  currentEventId: string,
  isCurrentHost: boolean,
  options?: SyncSecurityOptions
): {
  valid: boolean
  error?: string
  legitimateRecords: ScoutingRecord[]
  droppedRecordIds: string[]
} {
  if (pkg.eventId !== currentEventId) {
    return {
      valid: false,
      error: `赛事不匹配：该包属于赛事 [${pkg.eventName || pkg.eventId}]，当前处于 [${currentEventId}]`,
      legitimateRecords: [],
      droppedRecordIds: []
    }
  }

  const legitimateRecords: ScoutingRecord[] = []
  const droppedRecordIds: string[] = []
  const pushDropped = (id: string) => {
    if (!droppedRecordIds.includes(id)) {
      droppedRecordIds.push(id)
    }
  }

  const isTrustedHostBroadcastOnHost =
    isCurrentHost &&
    pkg.packetType === 'HOST_BROADCAST' &&
    pkg.sender?.role === 'HOST' &&
    Boolean(options?.expectedHostUserId && pkg.sender?.userId === options.expectedHostUserId)

  // Host 导入 Client 上传包或未通过预期 Host 身份核验的包：严格校验记录归属、防篡改已有记录及 CRDT 快照越权
  if (isCurrentHost && !isTrustedHostBroadcastOnHost) {
    const senderUserId = pkg.sender?.userId
    for (const r of pkg.payload.records) {
      if (!r || typeof r !== 'object' || !r.id) continue
      const crossEventMismatch = Boolean(r.eventId && r.eventId !== currentEventId)
      const ownerHijack = Boolean(
        options?.existingRecordOwners?.has(r.id) && options.existingRecordOwners.get(r.id) !== senderUserId
      )
      if (!senderUserId || r.scoutId !== senderUserId || crossEventMismatch || ownerHijack) {
        pushDropped(r.id)
      } else {
        legitimateRecords.push(r)
      }
    }
    const unauthorizedCrdtIds = findUnauthorizedClientCrdtRows(
      pkg.payload?.crdtSnapshot,
      senderUserId,
      currentEventId,
      options?.existingRecordOwners
    )
    for (const badId of unauthorizedCrdtIds) {
      pushDropped(badId)
    }
  } else if (isTrustedHostBroadcastOnHost) {
    for (const r of pkg.payload.records) {
      if (!r || typeof r !== 'object' || !r.id) continue
      if (r.eventId && r.eventId !== currentEventId) {
        pushDropped(r.id)
      } else {
        legitimateRecords.push(r)
      }
    }
    for (const badId of findMalformedOrCrossEventCrdtRows(pkg.payload?.crdtSnapshot, currentEventId)) {
      pushDropped(badId)
    }
  } else {
    // Client 导入 Host 广播包
    for (const r of pkg.payload.records) {
      if (!r || typeof r !== 'object' || !r.id) continue
      if (r.eventId && r.eventId !== currentEventId) {
        pushDropped(r.id)
      } else {
        legitimateRecords.push(r)
      }
    }
  }

  return {
    valid: true,
    legitimateRecords,
    droppedRecordIds
  }
}

export interface ScannedSyncFile {
  file: File
  type: 'EVENT' | 'SYNC'
  eventPkg?: EventPackageFile
  syncPkg?: SyncPackageFile
  scoutName?: string
  recordCount: number
}

export interface BatchScanResult {
  totalScannedFiles: number
  ignoredFiles: number
  matchedEventFiles: ScannedSyncFile[]
  matchedSyncFiles: ScannedSyncFile[]
  totalRecords: number
  totalTags: number
}

/**
 * 批量扫描文件或文件夹列表，智能筛选出属于当前赛事的 .info 与 .event 包，自动过滤其他无关文件
 */
export async function scanFilesAndFolders(
  files: File[],
  currentEventId?: string
): Promise<BatchScanResult> {
  const result: BatchScanResult = {
    totalScannedFiles: files.length,
    ignoredFiles: 0,
    matchedEventFiles: [],
    matchedSyncFiles: [],
    totalRecords: 0,
    totalTags: 0
  }

  for (const file of files) {
    const lowerName = file.name.toLowerCase()
    // 快速跳过非数据包格式（图片、视频、压缩包等）
    if (
      lowerName.endsWith('.png') ||
      lowerName.endsWith('.jpg') ||
      lowerName.endsWith('.jpeg') ||
      lowerName.endsWith('.gif') ||
      lowerName.endsWith('.pdf') ||
      lowerName.endsWith('.zip') ||
      lowerName.endsWith('.exe') ||
      lowerName.endsWith('.mp4') ||
      lowerName.endsWith('.csv')
    ) {
      result.ignoredFiles++
      continue
    }

    try {
      const text = await file.text()
      if (text.includes('SCOUTING_PRO_27_EVENT')) {
        const eventPkg = parseEventPackage(text)
        result.matchedEventFiles.push({
          file,
          type: 'EVENT',
          eventPkg,
          recordCount: 0
        })
      } else if (text.includes('SCOUTING_PRO_27_SYNC')) {
        const syncPkg = parseSyncPackage(text)
        // 若指定了当前赛事，仅匹配本赛事的同步包
        if (currentEventId && syncPkg.eventId !== currentEventId) {
          result.ignoredFiles++
          continue
        }
        const recordCount = syncPkg.payload?.records?.length || 0
        const tagCount = syncPkg.payload?.teamTags?.length || 0
        result.matchedSyncFiles.push({
          file,
          type: 'SYNC',
          syncPkg,
          scoutName: syncPkg.sender?.username,
          recordCount
        })
        result.totalRecords += recordCount
        result.totalTags += tagCount
      } else {
        result.ignoredFiles++
      }
    } catch {
      result.ignoredFiles++
    }
  }

  return result
}

/**
 * 递归从 DataTransfer 中提取所有文件（支持拖拽文件夹及多文件）
 */
export async function extractFilesFromDataTransfer(dataTransfer: DataTransfer): Promise<File[]> {
  const files: File[] = []
  const items = dataTransfer.items

  const firstItem = items && items.length > 0 ? items[0] : undefined
  if (firstItem && typeof firstItem.webkitGetAsEntry === 'function') {
    const queue: any[] = []
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const entry = it?.webkitGetAsEntry?.()
      if (entry) queue.push(entry)
    }

    const readEntry = async (entry: any): Promise<void> => {
      if (entry.isFile) {
        await new Promise<void>((resolve) => {
          entry.file(
            (file: File) => {
              files.push(file)
              resolve()
            },
            () => resolve()
          )
        })
      } else if (entry.isDirectory) {
        const reader = entry.createReader()
        const readBatch = async (): Promise<any[]> => {
          return new Promise<any[]>((resolve) => {
            reader.readEntries((results: any[]) => resolve(results || []), () => resolve([]))
          })
        }
        let batch: any[]
        do {
          batch = await readBatch()
          for (const child of batch) {
            await readEntry(child)
          }
        } while (batch.length > 0)
      }
    }

    for (const root of queue) {
      await readEntry(root)
    }
  }

  // 降级使用 dataTransfer.files
  if (files.length === 0 && dataTransfer.files && dataTransfer.files.length > 0) {
    for (let i = 0; i < dataTransfer.files.length; i++) {
      const f = dataTransfer.files[i]
      if (f) files.push(f)
    }
  }

  return files
}

export interface BatchImportContext {
  scanResult: BatchScanResult
  targetEventId: string
  isHost: boolean
  events: ScoutingEvent[]
  expectedHostUserId?: string
  existingRecordOwners?: ReadonlyMap<string, string>
  bulkSync: (records: ScoutingRecord[]) => Promise<ScoutingRecord[]>
  persistRecordsToDb?: (records: ScoutingRecord[]) => Promise<void>
  markSynced?: (ids: string[]) => void
  applyTagsFullSync?: (tags: TeamTagItem[]) => void
  applyScheduleFullSync?: (schedules: import('@/types').MatchScheduleItem[], assignments: import('@/types').ScoutAssignment[]) => void
  syncExternalEvent?: (event: ScoutingEvent) => Promise<ScoutingEvent | null | void>
  applyCrdtSnapshot?: (snapshot: unknown, eventId?: string) => boolean
}

export interface BatchImportExecutionResult {
  importedEventId?: string
  totalFiles: number
  totalAccepted: number
  totalDropped: number
}

function maybeApplyIncomingCrdtSnapshot(
  syncPkg: SyncPackageFile,
  applyCrdtSnapshot?: (snapshot: unknown, eventId?: string) => boolean,
  eventId?: string
): void {
  const snapshot = syncPkg.payload?.crdtSnapshot
  if (snapshot === undefined || !applyCrdtSnapshot) return
  const scan = scanMergeableContent(snapshot, Date.now())
  if (scan.hasFutureSkew) {
    console.warn(
      '[OfflineSync] Incoming CRDT snapshot contains future-skewed HLC cells (>300s); TinyBase will drop offending cells'
    )
  }
  applyCrdtSnapshot(snapshot, eventId)
}

/**
 * 批量执行离线数据包导入核心逻辑（解耦 UI 状态与存储层）
 */
export async function executeBatchSyncImport(ctx: BatchImportContext): Promise<BatchImportExecutionResult> {
  const { matchedEventFiles, matchedSyncFiles } = ctx.scanResult
  let importedEventId: string | undefined

  // 1. 导入赛事配置 (.event)
  for (const item of matchedEventFiles) {
    if (item.eventPkg) {
      const evt = item.eventPkg.event
      const existing = ctx.events.find((e) => e.id === evt.id)
      if (!existing) {
        ctx.events.push(evt)
      } else {
        Object.assign(existing, evt)
      }
      if (ctx.syncExternalEvent) {
        try {
          await ctx.syncExternalEvent(evt)
        } catch (e) {
          console.warn('[OfflineSync] Failed to sync external event to backend:', e)
        }
      }
      importedEventId = evt.id
      if (item.eventPkg.schedule && ctx.applyScheduleFullSync) {
        ctx.applyScheduleFullSync(item.eventPkg.schedule, item.eventPkg.assignments || [])
      }
    }
  }

  // 2. 导入增量同步包 (.info)
  let totalAccepted = 0
  let totalDropped = 0

  if (matchedSyncFiles.length > 0) {
    const firstSync = matchedSyncFiles[0]
    const eventId = ctx.targetEventId || firstSync?.syncPkg?.eventId || ''
    const subtleAvailable = hasSubtleCrypto()

    if (ctx.isHost) {
      const allLegitimateRecords: ScoutingRecord[] = []
      const crdtSnapshotsToApply: SyncPackageFile[] = []

      for (const item of matchedSyncFiles) {
        if (!item.syncPkg) continue
        const sec = validateSyncPackageSecurity(item.syncPkg, eventId, true, {
          expectedHostUserId: ctx.expectedHostUserId,
          existingRecordOwners: ctx.existingRecordOwners
        })
        if (!sec.valid) {
          throw new Error(sec.error || '数据包安全核验失败')
        }

        const verifiedRecords: ScoutingRecord[] = []
        const droppedSet = new Set(sec.droppedRecordIds)

        for (const r of sec.legitimateRecords) {
          if (subtleAvailable) {
            const requiresSigForOtherScoutOnHostBroadcast =
              item.syncPkg.packetType === 'HOST_BROADCAST' &&
              Boolean(ctx.expectedHostUserId && r.scoutId !== ctx.expectedHostUserId)

            if (requiresSigForOtherScoutOnHostBroadcast) {
              if (!r.authorPubKey || !r.authorSig || !(await verifyScoutingRecordSignature(r))) {
                droppedSet.add(r.id)
                continue
              }
            } else if (r.authorPubKey || r.authorSig) {
              if (!(await verifyScoutingRecordSignature(r))) {
                droppedSet.add(r.id)
                continue
              }
            }
          }
          verifiedRecords.push(r)
        }

        if (droppedSet.size === 0) {
          crdtSnapshotsToApply.push(item.syncPkg)
        }
        totalDropped += droppedSet.size
        allLegitimateRecords.push(...verifiedRecords)
      }

      const accepted = await ctx.bulkSync(allLegitimateRecords)
      totalAccepted = accepted.length
      if (accepted.length > 0 && ctx.persistRecordsToDb) {
        try {
          await ctx.persistRecordsToDb(accepted)
        } catch (e) {
          console.warn('[OfflineSync] Host failed to persist imported records to DB:', e)
        }
      }

      for (const syncPkg of crdtSnapshotsToApply) {
        maybeApplyIncomingCrdtSnapshot(syncPkg, ctx.applyCrdtSnapshot, eventId)
      }
    } else {
      const allLegitimateRecords: ScoutingRecord[] = []
      const hostConfirmedIds: string[] = []
      const crdtSnapshotsToApply: SyncPackageFile[] = []

      for (const item of matchedSyncFiles) {
        if (!item.syncPkg) continue
        const sec = validateSyncPackageSecurity(item.syncPkg, eventId, false)
        if (!sec.valid) {
          throw new Error(sec.error || '数据包安全核验失败')
        }
        totalDropped += sec.droppedRecordIds.length
        allLegitimateRecords.push(...sec.legitimateRecords)
        if (item.syncPkg.packetType === 'HOST_BROADCAST') {
          for (const rec of sec.legitimateRecords) {
            hostConfirmedIds.push(rec.id)
          }
        }
        if (item.syncPkg.payload.teamTags && item.syncPkg.payload.teamTags.length > 0) {
          if (ctx.applyTagsFullSync) ctx.applyTagsFullSync(item.syncPkg.payload.teamTags)
        }
        if (sec.droppedRecordIds.length === 0) {
          crdtSnapshotsToApply.push(item.syncPkg)
        }
      }

      const accepted = await ctx.bulkSync(allLegitimateRecords)
      totalAccepted = accepted.length

      if (hostConfirmedIds.length > 0 && ctx.markSynced) {
        ctx.markSynced(hostConfirmedIds)
      }

      for (const syncPkg of crdtSnapshotsToApply) {
        maybeApplyIncomingCrdtSnapshot(syncPkg, ctx.applyCrdtSnapshot, eventId)
      }
    }
  }

  return {
    importedEventId,
    totalFiles: matchedEventFiles.length + matchedSyncFiles.length,
    totalAccepted,
    totalDropped
  }
}

