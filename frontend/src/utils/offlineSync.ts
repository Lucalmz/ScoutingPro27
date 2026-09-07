import type { ScoutingEvent, ScoutingRecord, TeamTagItem } from '@/types'

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
    fromHostSeq: number
    toHostSeq: number
    recordCount: number
  }
  exportedAt: string
  payload: {
    records: ScoutingRecord[]
    teamTags?: TeamTagItem[]
    hostSessionId?: string
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
 * Host -> All:    [EventName]_HOST_to_ALL_v[From]_to_v[To]_[Timestamp].info
 * Host -> Scout:  [EventName]_HOST_to_[ScoutName]_v[From]_to_v[To]_[Timestamp].info
 */
export function generateSyncFileName(params: {
  eventName: string
  senderName: string
  isHost: boolean
  targetName?: string
  fromSeq?: number
  toSeq?: number
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
    const from = params.fromSeq ?? 0
    const to = params.toSeq ?? 0
    return `${eventBase}_HOST_to_${target}_v${from}_to_v${to}_${dateStr}.info`
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
  fromHostSeq?: number
  toHostSeq?: number
  hostSessionId?: string
}): string {
  const maxHostSeq = params.records.reduce((m, r) => Math.max(m, r.hostSeq ?? 0), 0)
  const fromSeq = params.fromHostSeq ?? 0
  const toSeq = params.toHostSeq ?? maxHostSeq

  const pkg: SyncPackageFile = {
    format: 'SCOUTING_PRO_27_SYNC',
    version: 1,
    packetType: params.packetType,
    eventId: params.eventId,
    eventName: params.eventName,
    sender: params.sender,
    target: params.target,
    syncRange: {
      fromHostSeq: fromSeq,
      toHostSeq: toSeq,
      recordCount: params.records.length
    },
    exportedAt: new Date().toISOString(),
    payload: {
      records: params.records,
      teamTags: params.teamTags,
      hostSessionId: params.hostSessionId
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

/**
 * 针对当前环境执行同步包业务安全核验
 */
export function validateSyncPackageSecurity(
  pkg: SyncPackageFile,
  currentEventId: string,
  isCurrentHost: boolean
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

  // 如果 Host 导入 Client 上传的包，必须核验每条记录的 scoutId 是否匹配发送方 userId
  if (isCurrentHost && pkg.packetType === 'CLIENT_PUSH') {
    const senderUserId = pkg.sender?.userId
    for (const r of pkg.payload.records) {
      if (!r || typeof r !== 'object' || !r.id) continue
      if (!senderUserId || r.scoutId !== senderUserId) {
        droppedRecordIds.push(r.id)
      } else {
        legitimateRecords.push(r)
      }
    }
  } else {
    // Client 导入 Host 广播包，或 Host 导入非伪造包
    for (const r of pkg.payload.records) {
      if (r && typeof r === 'object' && r.id) {
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
  bulkSync: (records: ScoutingRecord[]) => Promise<ScoutingRecord[]>
  stampHostSeq?: (records: ScoutingRecord[]) => void
  persistRecordsToDb?: (records: ScoutingRecord[]) => Promise<void>
  markSynced?: (ids: string[]) => void
  applyTagsFullSync?: (tags: TeamTagItem[]) => void
  applyScheduleFullSync?: (schedules: import('@/types').MatchScheduleItem[], assignments: import('@/types').ScoutAssignment[]) => void
}

export interface BatchImportExecutionResult {
  importedEventId?: string
  totalFiles: number
  totalAccepted: number
  totalDropped: number
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

    if (ctx.isHost) {
      const allLegitimateRecords: ScoutingRecord[] = []
      for (const item of matchedSyncFiles) {
        if (!item.syncPkg) continue
        const sec = validateSyncPackageSecurity(item.syncPkg, eventId, true)
        if (!sec.valid) {
          throw new Error(sec.error || '数据包安全核验失败')
        }
        totalDropped += sec.droppedRecordIds.length
        allLegitimateRecords.push(...sec.legitimateRecords)
      }

      const accepted = await ctx.bulkSync(allLegitimateRecords)
      totalAccepted = accepted.length
      if (accepted.length > 0) {
        if (ctx.stampHostSeq) ctx.stampHostSeq(accepted)
        if (ctx.persistRecordsToDb) {
          try {
            await ctx.persistRecordsToDb(accepted)
          } catch (e) {
            console.warn('[OfflineSync] Host failed to persist stamped records to DB:', e)
          }
        }
      }
    } else {
      const allLegitimateRecords: ScoutingRecord[] = []
      for (const item of matchedSyncFiles) {
        if (!item.syncPkg) continue
        const sec = validateSyncPackageSecurity(item.syncPkg, eventId, false)
        if (!sec.valid) {
          throw new Error(sec.error || '数据包安全核验失败')
        }
        allLegitimateRecords.push(...sec.legitimateRecords)
        if (item.syncPkg.payload.teamTags && item.syncPkg.payload.teamTags.length > 0) {
          if (ctx.applyTagsFullSync) ctx.applyTagsFullSync(item.syncPkg.payload.teamTags)
        }
      }

      const accepted = await ctx.bulkSync(allLegitimateRecords)
      totalAccepted = accepted.length

      const confirmedIds: string[] = []
      for (const stamped of allLegitimateRecords) {
        if (stamped.hostSeq && stamped.hostSeq > 0) {
          confirmedIds.push(stamped.id)
        }
      }
      if (confirmedIds.length > 0 && ctx.markSynced) {
        ctx.markSynced(confirmedIds)
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

