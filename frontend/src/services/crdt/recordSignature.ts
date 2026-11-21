import type { MergeableStore } from 'tinybase'
import type { ScoutingRecord, WebRtcCrdtSyncMsg } from '@/types'
import { hasSubtleCrypto, signDataEcdsa, verifyDataEcdsa } from '@/utils/crypto'
import { getOrCreateDeviceIdentity } from '@/utils/identityStore'
import { setCrdtDeviceId } from './crdtStore'
import {
  CRDT_TABLES,
  memberIdentityRowId,
  readMemberIdentitiesFromCrdt,
  writeMemberIdentityToCrdt,
  type MemberIdentityEntry
} from './schema'

const MSG_RESPONSE = 0
const MSG_CONTENT_DIFF = 3

export interface CanonicalRecordInput {
  id?: string
  eventId?: string
  scoutId?: string
  matchNumber?: number
  teamNumber?: number
  autoScore?: number
  teleopScore?: number
  endgameScore?: number
  totalScore?: number
  notes?: string
  rawData?: string
  rawDataJson?: string
  isBroken?: boolean
  isDeleted?: boolean
}

export function buildRecordCanonicalPayload(rec: CanonicalRecordInput): string {
  const raw =
    typeof rec.rawData === 'string' && rec.rawData
      ? rec.rawData
      : typeof rec.rawDataJson === 'string' && rec.rawDataJson
      ? rec.rawDataJson
      : '{}'
  return JSON.stringify([
    'SP27_REC_V1',
    rec.id || '',
    rec.eventId || '',
    rec.scoutId || '',
    Number(rec.matchNumber || 0),
    Number(rec.teamNumber || 0),
    Number(rec.autoScore || 0),
    Number(rec.teleopScore || 0),
    Number(rec.endgameScore || 0),
    Number(rec.totalScore || 0),
    rec.notes ?? '',
    raw,
    Boolean(rec.isBroken),
    Boolean(rec.isDeleted)
  ])
}

export function buildMemberIdentityCanonicalPayload(entry: {
  eventId?: string
  userId: string
  deviceId: string
  signingPubKeyHex: string
}): string {
  return JSON.stringify([
    'SP27_ID_V1',
    entry.eventId || '',
    entry.userId,
    entry.deviceId,
    entry.signingPubKeyHex
  ])
}

export async function signScoutingRecordWithDeviceKey(
  record: ScoutingRecord
): Promise<{ signed: boolean; authorPubKey?: string; authorSig?: string }> {
  if (!hasSubtleCrypto()) {
    return { signed: false }
  }
  try {
    const identity = await getOrCreateDeviceIdentity()
    if (!identity.signingKeyPair?.privateKey || !identity.signingPubKey) {
      return { signed: false }
    }
    const payload = buildRecordCanonicalPayload(record)
    const authorSig = await signDataEcdsa(identity.signingKeyPair.privateKey, payload)
    record.authorPubKey = identity.signingPubKey
    record.authorSig = authorSig
    return { signed: true, authorPubKey: identity.signingPubKey, authorSig }
  } catch {
    return { signed: false }
  }
}

export async function verifyScoutingRecordSignature(record: CanonicalRecordInput & {
  authorPubKey?: string
  authorSig?: string
}): Promise<boolean> {
  if (!record.authorPubKey || !record.authorSig || !hasSubtleCrypto()) {
    return false
  }
  const payload = buildRecordCanonicalPayload(record)
  return await verifyDataEcdsa(record.authorPubKey, payload, record.authorSig)
}

export async function registerLocalMemberIdentity(params: {
  store: MergeableStore
  eventId: string
  userId?: string
  eventHostId?: string
}): Promise<void> {
  const { store, eventId, userId, eventHostId } = params
  if (!eventId || !userId) return
  try {
    const identity = await getOrCreateDeviceIdentity()
    if (identity.deviceId) {
      setCrdtDeviceId(identity.deviceId)
    }
    if (!identity.signingPubKey) return

    const existingRow = store.getRow(
      CRDT_TABLES.MEMBER_IDENTITIES,
      memberIdentityRowId(userId, identity.deviceId)
    )

    if (eventHostId && userId === eventHostId && identity.signingKeyPair?.privateKey && hasSubtleCrypto()) {
      const payload = buildMemberIdentityCanonicalPayload({
        eventId,
        userId,
        deviceId: identity.deviceId,
        signingPubKeyHex: identity.signingPubKey
      })
      const hostSig = await signDataEcdsa(identity.signingKeyPair.privateKey, payload)
      writeMemberIdentityToCrdt(store, {
        eventId,
        userId,
        deviceId: identity.deviceId,
        signingPubKeyHex: identity.signingPubKey,
        trustedAt: Number(existingRow?.trustedAt || Date.now()),
        hostPubKey: identity.signingPubKey,
        hostSig
      })
      return
    }

    writeMemberIdentityToCrdt(store, {
      eventId,
      userId,
      deviceId: identity.deviceId,
      signingPubKeyHex: identity.signingPubKey,
      trustedAt: Number(existingRow?.trustedAt || Date.now()),
      hostPubKey: typeof existingRow?.hostPubKey === 'string' && existingRow.hostPubKey ? existingRow.hostPubKey : undefined,
      hostSig: typeof existingRow?.hostSig === 'string' && existingRow.hostSig ? existingRow.hostSig : undefined
    })
  } catch {
    // Ignore when WebCrypto/IDB is unavailable in stripped unit contexts
  }
}

export async function countersignPendingMemberIdentities(params: {
  store: MergeableStore
  eventId: string
  eventHostId?: string
  currentUserId?: string
}): Promise<number> {
  const { store, eventId, eventHostId, currentUserId } = params
  if (!eventId || !eventHostId || !currentUserId || currentUserId !== eventHostId || !hasSubtleCrypto()) {
    return 0
  }
  try {
    const identity = await getOrCreateDeviceIdentity()
    if (!identity.signingKeyPair?.privateKey || !identity.signingPubKey) {
      return 0
    }
    const entries = readMemberIdentitiesFromCrdt(store, eventId)
    let signedCount = 0
    for (const entry of entries) {
      let alreadyValid = false
      if (entry.hostPubKey && entry.hostSig) {
        const payload = buildMemberIdentityCanonicalPayload({
          eventId: entry.eventId || eventId,
          userId: entry.userId,
          deviceId: entry.deviceId,
          signingPubKeyHex: entry.signingPubKeyHex
        })
        alreadyValid = await verifyDataEcdsa(entry.hostPubKey, payload, entry.hostSig)
      }
      if (alreadyValid) continue

      const nextPayload = buildMemberIdentityCanonicalPayload({
        eventId: entry.eventId || eventId,
        userId: entry.userId,
        deviceId: entry.deviceId,
        signingPubKeyHex: entry.signingPubKeyHex
      })
      const hostSig = await signDataEcdsa(identity.signingKeyPair.privateKey, nextPayload)
      writeMemberIdentityToCrdt(store, {
        ...entry,
        eventId: entry.eventId || eventId,
        hostPubKey: identity.signingPubKey,
        hostSig
      })
      signedCount++
    }
    return signedCount
  } catch {
    return 0
  }
}

export interface RejectedRecordNotice {
  recordId: string
  scoutId?: string
  reason: string
}

export interface RejectedIdentityNotice {
  rowId: string
  userId?: string
  reason: string
}

export interface CrdtPullTrustContext {
  bindings: Map<string, Set<string>>
  knownHostKeys: Set<string>
}

export interface SanitizeCrdtSyncParams {
  store: MergeableStore
  eventId: string
  eventHostId?: string
  isHostMode: boolean
  senderPeerId: string
  boundSenderUserId?: string
  localDeviceId?: string
  pullContext?: CrdtPullTrustContext
  message: number
  body: unknown
}

export interface SanitizeCrdtSyncResult {
  msgBody: unknown
  rejectedRecords: RejectedRecordNotice[]
  rejectedIdentities: RejectedIdentityNotice[]
  acceptedPeerIdentities: MemberIdentityEntry[]
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v))
}

function extractIncomingCells(rowStamp: unknown): Record<string, unknown> | null {
  if (!Array.isArray(rowStamp) || !isPlainObject(rowStamp[0])) return null
  const out: Record<string, unknown> = {}
  for (const [cellId, cellStamp] of Object.entries(rowStamp[0])) {
    if (Array.isArray(cellStamp) && cellStamp.length >= 1) {
      out[cellId] = cellStamp[0]
    }
  }
  return out
}

function resolveTablesMapTarget(
  message: number,
  body: unknown
): { tablesStamp: unknown[]; variant: 'diff' | 'responseTuple' | 'responseDirect' } | null {
  if (message === MSG_CONTENT_DIFF && Array.isArray(body) && Array.isArray(body[0]) && isPlainObject(body[0][0])) {
    return { tablesStamp: body[0], variant: 'diff' }
  }
  if (message === MSG_RESPONSE && Array.isArray(body)) {
    if (body.length >= 1 && Array.isArray(body[0]) && isPlainObject(body[0][0])) {
      return { tablesStamp: body[0], variant: 'responseTuple' }
    }
    if (body.length >= 1 && isPlainObject(body[0])) {
      return { tablesStamp: body, variant: 'responseDirect' }
    }
  }
  return null
}

function addBinding(map: Map<string, Set<string>>, userId: string, pubKey: string): void {
  if (!userId || !pubKey) return
  let set = map.get(userId)
  if (!set) {
    set = new Set<string>()
    map.set(userId, set)
  }
  set.add(pubKey)
}

/**
 * Inspects inbound TinyBase CRDT sync payloads BEFORE Store merge:
 * 1. Authenticates `member_identities` bindings (host-signed anchors or host-verified direct peers).
 * 2. Verifies EVERY `scouting_records` row's ECDSA `authorSig` AND confirms `authorPubKey` is bound
 *    either to `record.scoutId` (including teammate disaster-relief relays) or to `eventHostId`.
 * Strips any unverified or forged rows from the cloned payload before `MergeableStore` touches them.
 */
export async function sanitizeIncomingCrdtSyncBody(
  params: SanitizeCrdtSyncParams
): Promise<SanitizeCrdtSyncResult> {
  const {
    store,
    eventId,
    eventHostId,
    isHostMode,
    boundSenderUserId,
    localDeviceId,
    pullContext,
    message,
    body
  } = params

  const target = resolveTablesMapTarget(message, body)
  if (!target) {
    return { msgBody: body, rejectedRecords: [], rejectedIdentities: [], acceptedPeerIdentities: [] }
  }

  const rawTablesMap = target.tablesStamp[0] as Record<string, unknown>
  const idTableStampRaw = rawTablesMap[CRDT_TABLES.MEMBER_IDENTITIES]
  const recTableStampRaw = rawTablesMap[CRDT_TABLES.SCOUTING_RECORDS]
  const hasIdRows = Array.isArray(idTableStampRaw) && isPlainObject(idTableStampRaw[0]) && Object.keys(idTableStampRaw[0]).length > 0
  const hasRecRows = Array.isArray(recTableStampRaw) && isPlainObject(recTableStampRaw[0]) && Object.keys(recTableStampRaw[0]).length > 0

  if (!hasIdRows && !hasRecRows) {
    return { msgBody: body, rejectedRecords: [], rejectedIdentities: [], acceptedPeerIdentities: [] }
  }

  // Deep-clone only when we have member_identities or scouting_records rows to validate
  const clonedBody = JSON.parse(JSON.stringify(body))
  const clonedTarget = resolveTablesMapTarget(message, clonedBody)!
  const clonedTablesMap = clonedTarget.tablesStamp[0] as Record<string, unknown>
  let mutatedTables = false

  const localEntries = readMemberIdentitiesFromCrdt(store, eventId)
  const effectiveBindings = new Map<string, Set<string>>()
  const knownHostPubKeys = new Set<string>()
  const localKnownPairs = new Set<string>()

  for (const entry of localEntries) {
    addBinding(effectiveBindings, entry.userId, entry.signingPubKeyHex)
    localKnownPairs.add(`${entry.userId}::${entry.signingPubKeyHex}`)
    if (eventHostId && entry.userId === eventHostId) {
      knownHostPubKeys.add(entry.signingPubKeyHex)
    }
    if (entry.hostPubKey && entry.hostSig) {
      knownHostPubKeys.add(entry.hostPubKey)
    }
  }
  if (pullContext) {
    for (const hostKey of pullContext.knownHostKeys) {
      knownHostPubKeys.add(hostKey)
    }
    for (const [uid, pubKeys] of pullContext.bindings.entries()) {
      for (const pubKey of pubKeys) {
        addBinding(effectiveBindings, uid, pubKey)
      }
    }
  }

  // Determine whether local node is in cold-recovery state (no peer-originated member anchors or scouting records stored yet)
  const hasExternalPeerAnchors = localEntries.some((e) => !localDeviceId || e.deviceId !== localDeviceId)
  const hasExistingRecords = Object.keys(store.getTable(CRDT_TABLES.SCOUTING_RECORDS)).length > 0
  const isEmptyStoreForRecovery = !hasExternalPeerAnchors && !hasExistingRecords

  const rejectedIdentities: RejectedIdentityNotice[] = []
  const acceptedPeerIdentities: MemberIdentityEntry[] = []
  const acceptedPeerRowIds: string[] = []

  // Step A: Sanitize `member_identities`
  const idTableStamp = clonedTarget.tablesStamp[0]
    ? (clonedTablesMap[CRDT_TABLES.MEMBER_IDENTITIES] as unknown[] | undefined)
    : undefined
  let idRowsMap: Record<string, unknown> | undefined
  let idTableMutated = false
  if (Array.isArray(idTableStamp) && isPlainObject(idTableStamp[0])) {
    idRowsMap = idTableStamp[0] as Record<string, unknown>
    const parsedIncomingEntries = new Map<string, MemberIdentityEntry>()

    for (const [rowId, rowStamp] of Object.entries(idRowsMap)) {
      const existingRow = store.getRow(CRDT_TABLES.MEMBER_IDENTITIES, rowId)
      const incomingCells = extractIncomingCells(rowStamp) ?? {}
      const merged = { ...existingRow, ...incomingCells }
      const entry: MemberIdentityEntry = {
        eventId: typeof merged.eventId === 'string' && merged.eventId ? merged.eventId : eventId,
        userId: typeof merged.userId === 'string' ? merged.userId : '',
        deviceId: typeof merged.deviceId === 'string' ? merged.deviceId : '',
        signingPubKeyHex: typeof merged.signingPubKeyHex === 'string' ? merged.signingPubKeyHex : '',
        trustedAt: Number(merged.trustedAt || 0),
        hostPubKey: typeof merged.hostPubKey === 'string' && merged.hostPubKey ? merged.hostPubKey : undefined,
        hostSig: typeof merged.hostSig === 'string' && merged.hostSig ? merged.hostSig : undefined
      }
      parsedIncomingEntries.set(rowId, entry)

      // Cold-start recovery anchor bootstrap (e.g. empty HostC receiving HostA/HostB anchor from Client1):
      // Allow self-signed Host keys (`userId === eventHostId`) ONLY when local store has no prior external peer anchors.
      if (
        isEmptyStoreForRecovery &&
        eventHostId &&
        entry.userId === eventHostId &&
        entry.signingPubKeyHex &&
        entry.hostPubKey === entry.signingPubKeyHex &&
        entry.hostSig &&
        hasSubtleCrypto()
      ) {
        const selfPayload = buildMemberIdentityCanonicalPayload({
          eventId: entry.eventId || eventId,
          userId: entry.userId,
          deviceId: entry.deviceId,
          signingPubKeyHex: entry.signingPubKeyHex
        })
        if (await verifyDataEcdsa(entry.hostPubKey, selfPayload, entry.hostSig)) {
          knownHostPubKeys.add(entry.hostPubKey)
          pullContext?.knownHostKeys.add(entry.hostPubKey)
        }
      }
    }

    for (const [rowId, entry] of parsedIncomingEntries.entries()) {
      let accepted = false
      let reason = 'unverified_identity_binding'

      if (!entry.userId || !entry.deviceId || !entry.signingPubKeyHex) {
        reason = 'malformed_identity_entry'
      } else if (
        entry.hostPubKey &&
        entry.hostSig &&
        (knownHostPubKeys.has(entry.hostPubKey) || (!isHostMode && boundSenderUserId === eventHostId))
      ) {
        const payload = buildMemberIdentityCanonicalPayload({
          eventId: entry.eventId || eventId,
          userId: entry.userId,
          deviceId: entry.deviceId,
          signingPubKeyHex: entry.signingPubKeyHex
        })
        if (await verifyDataEcdsa(entry.hostPubKey, payload, entry.hostSig)) {
          accepted = true
          if (eventHostId && entry.userId === eventHostId) {
            knownHostPubKeys.add(entry.signingPubKeyHex)
            pullContext?.knownHostKeys.add(entry.signingPubKeyHex)
          }
        } else {
          reason = 'invalid_host_signature'
        }
      } else if (isHostMode && boundSenderUserId && entry.userId === boundSenderUserId) {
        // Peer submitting its own key over an authenticated DataChannel -> Host accepts & countersigns before merge
        accepted = true
        acceptedPeerIdentities.push(entry)
        acceptedPeerRowIds.push(rowId)
      } else if (!isHostMode && boundSenderUserId && eventHostId && boundSenderUserId === eventHostId && entry.userId === eventHostId) {
        accepted = true
        knownHostPubKeys.add(entry.signingPubKeyHex)
        pullContext?.knownHostKeys.add(entry.signingPubKeyHex)
      } else if (localKnownPairs.has(`${entry.userId}::${entry.signingPubKeyHex}`)) {
        accepted = true
      }

      if (accepted) {
        addBinding(effectiveBindings, entry.userId, entry.signingPubKeyHex)
        if (pullContext) {
          addBinding(pullContext.bindings, entry.userId, entry.signingPubKeyHex)
        }
      } else if (idRowsMap) {
        delete idRowsMap[rowId]
        idTableMutated = true
        mutatedTables = true
        rejectedIdentities.push({ rowId, userId: entry.userId, reason })
      }
    }

    if (idTableMutated) {
      clonedTablesMap[CRDT_TABLES.MEMBER_IDENTITIES] = idTableStamp.slice(0, 2)
    }
  }

  // Step B: Sanitize `scouting_records`
  const rejectedRecords: RejectedRecordNotice[] = []
  const recTableStamp = clonedTablesMap[CRDT_TABLES.SCOUTING_RECORDS] as unknown[] | undefined
  if (Array.isArray(recTableStamp) && isPlainObject(recTableStamp[0]) && hasSubtleCrypto()) {
    const recRowsMap = recTableStamp[0] as Record<string, unknown>
    let recTableMutated = false

    for (const [rowId, rowStamp] of Object.entries(recRowsMap)) {
      const existingRow = store.getRow(CRDT_TABLES.SCOUTING_RECORDS, rowId)
      const incomingCells = extractIncomingCells(rowStamp) ?? {}
      const merged = { ...existingRow, ...incomingCells } as CanonicalRecordInput & {
        scoutId?: string
        authorPubKey?: string
        authorSig?: string
      }

      const scoutId = typeof merged.scoutId === 'string' ? merged.scoutId : ''
      const authorPubKey = typeof merged.authorPubKey === 'string' ? merged.authorPubKey : ''
      const authorSig = typeof merged.authorSig === 'string' ? merged.authorSig : ''

      let rejectReason: string | null = null
      if (!authorPubKey || !authorSig) {
        rejectReason = 'missing_author_signature'
      } else {
        const sigValid = await verifyScoutingRecordSignature(merged)
        if (!sigValid) {
          rejectReason = 'invalid_author_signature'
        } else {
          const scoutKeys = effectiveBindings.get(scoutId)
          const hostKeys = eventHostId ? effectiveBindings.get(eventHostId) : undefined
          const isBoundToScout = Boolean(scoutKeys?.has(authorPubKey))
          const isBoundToHost = Boolean(hostKeys?.has(authorPubKey))
          if (!isBoundToScout && !isBoundToHost) {
            rejectReason = 'unbound_author_pubkey'
          }
        }
      }

      if (rejectReason) {
        delete recRowsMap[rowId]
        recTableMutated = true
        mutatedTables = true
        rejectedRecords.push({
          recordId: rowId,
          scoutId,
          reason: rejectReason
        })
      }
    }

    if (recTableMutated) {
      clonedTablesMap[CRDT_TABLES.SCOUTING_RECORDS] = recTableStamp.slice(0, 2)
    }
  }

  // Step C: On Host, countersign accepted unsigned peer identities & persist BEFORE MergeableStore merges this payload.
  // Stripping the un-countersigned rows from the cloned inbound payload guarantees Host emits the complete countersigned
  // `member_identities` delta to all attached peers strictly before fanning out this peer's `scouting_records`.
  if (isHostMode && acceptedPeerIdentities.length > 0 && hasSubtleCrypto()) {
    try {
      const identity = await getOrCreateDeviceIdentity()
      if (identity.signingKeyPair?.privateKey && identity.signingPubKey) {
        const signedEntries: MemberIdentityEntry[] = []
        for (const entry of acceptedPeerIdentities) {
          if (!entry.userId || !entry.deviceId || !entry.signingPubKeyHex) continue
          const payload = buildMemberIdentityCanonicalPayload({
            eventId: entry.eventId || eventId,
            userId: entry.userId,
            deviceId: entry.deviceId,
            signingPubKeyHex: entry.signingPubKeyHex
          })
          const hostSig = await signDataEcdsa(identity.signingKeyPair.privateKey, payload)
          signedEntries.push({
            ...entry,
            eventId: entry.eventId || eventId,
            hostPubKey: identity.signingPubKey,
            hostSig
          })
        }
        if (signedEntries.length > 0) {
          store.transaction(() => {
            for (const signed of signedEntries) {
              writeMemberIdentityToCrdt(store, signed)
            }
          })
          if (idRowsMap && idTableStamp) {
            for (const rId of acceptedPeerRowIds) {
              delete idRowsMap[rId]
            }
            idTableMutated = true
            clonedTablesMap[CRDT_TABLES.MEMBER_IDENTITIES] = idTableStamp.slice(0, 2)
            mutatedTables = true
          }
        }
      }
    } catch {
      // Leave un-stripped on transient signing failure so post-settle countersign can retry
    }
  }

  if (mutatedTables) {
    if (clonedTarget.tablesStamp.length > 2) {
      clonedTarget.tablesStamp.length = 2
    }
    return {
      msgBody: clonedBody,
      rejectedRecords,
      rejectedIdentities,
      acceptedPeerIdentities
    }
  }

  return {
    msgBody: body,
    rejectedRecords,
    rejectedIdentities,
    acceptedPeerIdentities
  }
}
