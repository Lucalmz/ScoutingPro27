import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import * as api from '../services/api'
import * as mobilePhotoCache from '../services/mobilePhotoCache'
import { handleChannelPhotoMessage, isChannelPhotoMessageType } from '../services/webrtc/channelPhotoHandler'
import { createMessageDispatcher, getLocalAuthToken } from '../services/webrtc/messageDispatcher'
import { OfflineMessageManager } from '../services/webrtc/offlineQueue'
import { SasSecurityManager } from '../services/webrtc/sasManager'
import { createChannelMessageHandler, type ChannelMessageHandlerContext } from '../services/webrtc/channelMessageHandler'
import { handleChannelIdentityAndTakeoverMessage } from '../services/webrtc/channelIdentityHandler'
import type { ClientEntry, WebRtcCallbacks } from '../services/webrtc/types'
import { DataChannelSender } from '../services/dataChannelSender'
import type { ScoutingRecord } from '@/types'

vi.mock('@/services/api', async () => {
  const actual = await vi.importActual<any>('@/services/api')
  return {
    ...actual,
    uploadPitPhoto: vi.fn().mockResolvedValue({ success: true, key: 'k1', url: '/api/events/e1/pit/photos/k1' })
  }
})

vi.mock('@/services/mobilePhotoCache', async () => {
  const actual = await vi.importActual<any>('@/services/mobilePhotoCache')
  return {
    ...actual,
    markMobilePhotoSynced: vi.fn().mockResolvedValue(undefined)
  }
})

function makeMockDc(readyState: RTCDataChannelState = 'open'): RTCDataChannel & { sent: string[]; close: ReturnType<typeof vi.fn> } {
  const sent: string[] = []
  return {
    label: 'scoutingpro-data',
    readyState,
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    send: vi.fn((data: string) => sent.push(data)),
    close: vi.fn(),
    sent
  } as any
}

function makeStatefulMockDc(readyState: RTCDataChannelState = 'open'): RTCDataChannel & {
  bufferedAmount: number
  sent: string[]
  close: ReturnType<typeof vi.fn>
  _triggerEvent: (event: string) => void
} {
  const sent: string[] = []
  const listeners: Record<string, Function[]> = {}
  const dc: any = {
    label: 'scoutingpro-data',
    readyState,
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    send: vi.fn((data: string) => {
      sent.push(data)
      dc.bufferedAmount += data.length
    }),
    addEventListener: vi.fn((event: string, cb: Function) => {
      listeners[event] = listeners[event] || []
      listeners[event].push(cb)
    }),
    removeEventListener: vi.fn((event: string, cb: Function) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((fn) => fn !== cb)
      }
    }),
    close: vi.fn(),
    sent,
    _triggerEvent: (event: string) => {
      if (listeners[event]) {
        listeners[event].slice().forEach((cb) => cb())
      }
    }
  }
  return dc
}

function makeMockPc(): RTCPeerConnection {
  return {
    close: vi.fn(),
    connectionState: 'connected',
    iceConnectionState: 'connected',
    onconnectionstatechange: null,
    oniceconnectionstatechange: null
  } as any
}

describe('channelPhotoHandler and messageDispatcher', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    localStorage.clear()
    vi.useRealTimers()
  })

  function makePhotoCtx(isHost = true, inviteCode = 'ROOM01', eventId = 'evt-auth-uuid') {
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const ctx: ChannelMessageHandlerContext = {
      isHostMode: () => isHost,
      currentInviteCode: () => inviteCode,
      getHostSessionId: () => 'host-sess-1',
      getCurrentHostSessionId: () => 'host-sess-1',
      setCurrentHostSessionId: vi.fn(),
      callbacks: {
        onStatusChange: vi.fn(),
        onRecordsReceived: vi.fn().mockResolvedValue([]),
        onAckReceived: vi.fn(),
        onRequestSync: vi.fn()
      },
      clients: new Map(),
      stagedClients: new Map(),
      scoutIdToClientIds: new Map(),
      clientIdToScoutId: new Map(),
      clientIdToScoutName: new Map(),
      pendingTakeovers: new Map(),
      takeoverCooldowns: new Map(),
      offlineMessages: new OfflineMessageManager(),
      sendMessage,
      promoteTakeover: vi.fn(),
      enqueueHostTask: async (_s, task) => task(),
      cleanupPeerResources: vi.fn(),
      closeClient: vi.fn(),
      setStatus: vi.fn(),
      getCurrentEventId: () => eventId
    }
    return { ctx, sendMessage }
  }

  describe('channelPhotoHandler', () => {

    it('recognizes photo message types and rejects unknown types', async () => {
      expect(isChannelPhotoMessageType('PIT_PHOTO_UPLOAD')).toBe(true)
      expect(isChannelPhotoMessageType('PIT_PHOTO_CHUNK')).toBe(true)
      expect(isChannelPhotoMessageType('PIT_PHOTO_ACK')).toBe(true)
      expect(isChannelPhotoMessageType('SYNC_DATA')).toBe(false)
      expect(isChannelPhotoMessageType(undefined)).toBe(false)

      const { ctx } = makePhotoCtx()
      expect(await handleChannelPhotoMessage(ctx, { type: 'OTHER' }, 'peer-1')).toBe(false)
    })

    it('handles PIT_PHOTO_UPLOAD success and failure ACKs on Host', async () => {
      const { ctx, sendMessage } = makePhotoCtx(true)
      await handleChannelPhotoMessage(
        ctx,
        { type: 'PIT_PHOTO_UPLOAD', eventId: 'evt-auth-uuid', key: 'pit_27570_1', dataUrl: 'data:image/webp;base64,AAA' },
        'peer-1'
      )
      expect(api.uploadPitPhoto).toHaveBeenCalledWith('evt-auth-uuid', 'pit_27570_1', 'data:image/webp;base64,AAA')
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'PIT_PHOTO_ACK', key: 'pit_27570_1', success: true }),
        'peer-1'
      )

      vi.mocked(api.uploadPitPhoto).mockRejectedValueOnce(new Error('Disk full'))
      await handleChannelPhotoMessage(
        ctx,
        { type: 'PIT_PHOTO_UPLOAD', eventId: 'evt-auth-uuid', key: 'pit_27570_2', dataUrl: 'data:image/webp;base64,BBB' },
        'peer-1'
      )
      expect(sendMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'PIT_PHOTO_ACK', key: 'pit_27570_2', success: false }),
        'peer-1'
      )
    })

    it('reassembles multi-chunk PIT_PHOTO_CHUNK out-of-order, normalizes placeholder eventId, and handles ACK on client', async () => {
      const { ctx, sendMessage } = makePhotoCtx(true, 'ROOM01', 'evt-auth-uuid')

      // Invalid chunks are safely ignored
      await handleChannelPhotoMessage(
        ctx,
        { type: 'PIT_PHOTO_CHUNK', transferId: 'bad', eventId: 'evt-1', key: 'k', chunkIndex: 0, totalChunks: 501, chunkData: 'a' },
        'peer-1'
      )
      expect(api.uploadPitPhoto).not.toHaveBeenCalled()

      // Deliver chunk 1 then chunk 0 with placeholder eventId `evt-ROOM01`
      await handleChannelPhotoMessage(
        ctx,
        { type: 'PIT_PHOTO_CHUNK', transferId: 'tr-1', eventId: 'evt-ROOM01', key: 'pit_1_a', chunkIndex: 1, totalChunks: 2, chunkData: 'PART2' },
        'peer-1'
      )
      expect(api.uploadPitPhoto).not.toHaveBeenCalled()

      await handleChannelPhotoMessage(
        ctx,
        { type: 'PIT_PHOTO_CHUNK', transferId: 'tr-1', eventId: 'evt-ROOM01', key: 'pit_1_a', chunkIndex: 0, totalChunks: 2, chunkData: 'PART1' },
        'peer-1'
      )
      expect(api.uploadPitPhoto).toHaveBeenCalledWith('evt-auth-uuid', 'pit_1_a', 'PART1PART2')
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'PIT_PHOTO_ACK', eventId: 'evt-auth-uuid', key: 'pit_1_a', success: true }),
        'peer-1'
      )

      // Client receives ACK -> marks photo synced
      const { ctx: clientCtx } = makePhotoCtx(false)
      await handleChannelPhotoMessage(
        clientCtx,
        { type: 'PIT_PHOTO_ACK', eventId: 'evt-auth-uuid', key: 'pit_1_a', success: true }
      )
      expect(mobilePhotoCache.markMobilePhotoSynced).toHaveBeenCalledWith('pit_1_a')
    })

    it('drops mismatched PIT_PHOTO_CHUNK frames without corrupting active buffer assembly', async () => {
      const { ctx } = makePhotoCtx(true, 'ROOM01', 'evt-auth-uuid')

      // Start a 2-chunk transfer for key k_orig
      await handleChannelPhotoMessage(
        ctx,
        { type: 'PIT_PHOTO_CHUNK', transferId: 'tr-mismatch', eventId: 'evt-auth-uuid', key: 'k_orig', chunkIndex: 0, totalChunks: 2, chunkData: 'HEAD_' },
        'peer-1'
      )

      // Mismatched totalChunks & out-of-bounds chunkIndex must be dropped
      await handleChannelPhotoMessage(
        ctx,
        { type: 'PIT_PHOTO_CHUNK', transferId: 'tr-mismatch', eventId: 'evt-auth-uuid', key: 'k_orig', chunkIndex: 4, totalChunks: 5, chunkData: 'BAD' },
        'peer-1'
      )
      // Mismatched key must also be dropped
      await handleChannelPhotoMessage(
        ctx,
        { type: 'PIT_PHOTO_CHUNK', transferId: 'tr-mismatch', eventId: 'evt-auth-uuid', key: 'k_other', chunkIndex: 1, totalChunks: 2, chunkData: 'BAD2' },
        'peer-1'
      )
      expect(api.uploadPitPhoto).not.toHaveBeenCalled()

      // Completing with valid chunk 1 assembles cleanly
      await handleChannelPhotoMessage(
        ctx,
        { type: 'PIT_PHOTO_CHUNK', transferId: 'tr-mismatch', eventId: 'evt-auth-uuid', key: 'k_orig', chunkIndex: 1, totalChunks: 2, chunkData: 'TAIL' },
        'peer-1'
      )
      expect(api.uploadPitPhoto).toHaveBeenCalledWith('evt-auth-uuid', 'k_orig', 'HEAD_TAIL')
    })
  })

  describe('messageDispatcher', () => {
    function makeDispatcher(isHost: boolean) {
      const clients = new Map<string, ClientEntry>()
      const stagedClients = new Map<string, ClientEntry>()
      const scoutIdToClientIds = new Map<string, Set<string>>()
      const clientIdToScoutId = new Map<string, string>()
      const clientIdToScoutName = new Map<string, string>()
      const offlineMessages = new OfflineMessageManager()
      const sas = new SasSecurityManager()
      let clientDc: RTCDataChannel | null = null
      let clientSender: any = null
      let localUserId: string | undefined = isHost ? 'host-u1' : 'scout-u1'
      let localUserName: string | undefined = isHost ? 'Host' : 'Scout'
      const setStatus = vi.fn()
      const onClientConnected = vi.fn()
      const onRequestSync = vi.fn()

      const dispatcher = createMessageDispatcher({
        isHostMode: () => isHost,
        getCurrentInviteCode: () => 'CODE01',
        getHostSessionId: () => 'host-sess-1',
        getCurrentEventMetadata: () => ({ id: 'evt-1', name: 'Event 1', inviteCode: 'CODE01', hostId: 'host-u1' }),
        clients,
        stagedClients,
        scoutIdToClientIds,
        clientIdToScoutId,
        clientIdToScoutName,
        offlineMessages,
        sas,
        getClientDc: () => clientDc,
        getClientSender: () => clientSender,
        setClientSender: (s) => { clientSender = s },
        setStatus,
        getLocalUserId: () => localUserId,
        setLocalUserId: (id) => { localUserId = id },
        getLocalUserName: () => localUserName,
        setLocalUserName: (n) => { localUserName = n },
        onClientConnected,
        onRequestSync
      })

      return {
        dispatcher,
        clients,
        stagedClients,
        scoutIdToClientIds,
        clientIdToScoutId,
        clientIdToScoutName,
        offlineMessages,
        sas,
        setClientDc: (dc: RTCDataChannel | null) => { clientDc = dc },
        getClientSender: () => clientSender as DataChannelSender | null,
        setClientSender: (s: DataChannelSender | null) => { clientSender = s },
        setStatus,
        onClientConnected,
        onRequestSync
      }
    }

    it('reads auth token from localStorage safely', () => {
      expect(getLocalAuthToken()).toBeUndefined()
      localStorage.setItem('scoutingpro-user', '{bad-json')
      expect(getLocalAuthToken()).toBeUndefined()
      localStorage.setItem('scoutingpro-user', JSON.stringify({ id: 'u1', token: 'tok-xyz' }))
      expect(getLocalAuthToken()).toBe('tok-xyz')
    })

    it('gates host/client messages by SAS state, supports drainingVirtualDc, and chunks pushRecords > 15', async () => {
      const host = makeDispatcher(true)
      const dc1 = makeMockDc('open')
      const dc2 = makeMockDc('closed')
      const drainingDc = makeMockDc('open')

      const pendingDc = makeMockDc('open')
      const rejectedDc = makeMockDc('open')
      host.clients.set('p1', { pc: makeMockPc(), dc: dc1, pendingCandidates: [] })
      host.clients.set('p2', { pc: makeMockPc(), dc: dc2, drainingVirtualDc: drainingDc, pendingCandidates: [] })
      host.clients.set('p-pending', { pc: makeMockPc(), dc: pendingDc, pendingCandidates: [] })
      host.clients.set('p-rejected', { pc: makeMockPc(), dc: rejectedDc, pendingCandidates: [] })

      host.sas.clientSasStates.set('p1', 'VERIFIED')
      host.sas.clientSasStates.set('p2', 'VERIFIED')
      host.sas.clientSasStates.set('p-pending', 'PENDING_VERIFICATION')
      host.sas.clientSasStates.set('p-rejected', 'REJECTED')

      // Broadcast 16 records -> chunked into 15 + 1; p-pending buffered, p-rejected dropped
      const recs: ScoutingRecord[] = Array.from({ length: 16 }, (_, i) => ({
        id: `r-${i}`,
        eventId: 'evt-1',
        scoutId: 's1',
        scoutName: 'S1',
        matchNumber: i + 1,
        teamNumber: 27570,
        autoScore: 1,
        teleopScore: 2,
        endgameScore: 3,
        totalScore: 6,
        notes: '',
        rawData: '{}',
        syncStatus: 'SYNCED',
        createdAt: '',
        updatedAt: '',
        isBroken: false,
        version: 1
      }))
      await host.dispatcher.pushRecords(recs)

      expect(dc1.sent).toHaveLength(2)
      expect(JSON.parse(dc1.sent[0]!).records).toHaveLength(15)
      expect(JSON.parse(dc1.sent[1]!).records).toHaveLength(1)
      expect(drainingDc.sent).toHaveLength(2)
      expect(host.sas.hostPendingOutgoing.get('p-pending')).toHaveLength(2)
      expect(rejectedDc.sent).toHaveLength(0)

      // Control message bypasses PENDING_VERIFICATION gate
      await host.dispatcher.sendMessage({ type: 'SESSION_CONFLICT', conflictingUsername: 'A', conflictingUserId: 'u1' }, 'p-pending')
      expect(pendingDc.sent).toHaveLength(1)

      // Client side SAS gating
      const client = makeDispatcher(false)
      const clientDc = makeMockDc('open')
      client.setClientDc(clientDc)
      client.sas.clientSasState = 'PENDING_VERIFICATION'
      await client.dispatcher.requestTagsSync('evt-1')
      expect(clientDc.sent).toHaveLength(0)
      expect(client.sas.clientPendingOutgoing).toHaveLength(1)

      client.sas.clientSasState = 'VERIFIED'
      client.dispatcher.requestSync(3, undefined, 'u-c1', 'ClientOne', 'tok-c1')
      expect(clientDc.sent).toHaveLength(1)
      expect(JSON.parse(clientDc.sent[0]!).sinceVersion).toBe(3)
    })

    it('promoteTakeover kicks old client, promotes staged client, sends metadata & takeover success, and triggers sync', async () => {
      const host = makeDispatcher(true)
      const oldDc = makeMockDc('open')
      const oldPc = makeMockPc()
      const newDc = makeMockDc('open')
      const newPc = makeMockPc()

      host.clients.set('old-cid', { pc: oldPc, dc: oldDc, pendingCandidates: [] })
      host.stagedClients.set('new-cid', { pc: newPc, dc: newDc, pendingCandidates: [] })
      host.scoutIdToClientIds.set('u1', new Set(['old-cid']))
      host.clientIdToScoutId.set('old-cid', 'u1')
      host.clientIdToScoutName.set('old-cid', 'Alice')

      host.dispatcher.promoteTakeover('u1', 'Alice', 'new-cid', 'old-cid', 'TAKEOVER_PERMITTED')
      await new Promise((r) => setTimeout(r, 0))

      expect(oldDc.sent.some((s) => JSON.parse(s).type === 'SESSION_KICKED')).toBe(true)
      expect(oldPc.close).toHaveBeenCalled()
      expect(host.clients.has('old-cid')).toBe(false)
      expect(host.stagedClients.has('new-cid')).toBe(false)
      expect(host.clients.get('new-cid')?.pc).toBe(newPc)
      expect(newDc.sent.map((s) => JSON.parse(s).type)).toEqual(['EVENT_METADATA', 'TAKEOVER_SUCCESS'])
      expect(host.onClientConnected).toHaveBeenCalledWith('u1', 'Alice')
      expect(host.onRequestSync).toHaveBeenCalledWith(0, 'new-cid')
    })

    it('enqueues offline direct messages when target is offline and dispatches takeover/tag/identity messages', async () => {
      const host = makeDispatcher(true)
      const delivered = await host.dispatcher.sendDirectMessage({
        targetId: 'offline-scout',
        title: 'Heads up',
        body: 'Check match 5'
      })
      expect(delivered).toBe(false)
      expect(host.offlineMessages.flush('offline-scout')).toHaveLength(1)

      const client = makeDispatcher(false)
      const clientDc = makeMockDc('open')
      client.setClientDc(clientDc)

      await client.dispatcher.requestTakeover('Alice', 'u-alice')
      await client.dispatcher.sendTakeoverDecision('Alice', true)
      await client.dispatcher.sendIdentityMigration('evt-1', 'old-1', 'new-1', 'Alice')
      await client.dispatcher.ackRecords(['r1'])
      await client.dispatcher.broadcastTagUpdate(
        { id: 't1', eventId: 'evt-1', teamNumber: 27570, tag: 'fast', color: 'green', isPreset: false },
        'ADD'
      )
      await client.dispatcher.sendTagsFullSync([], 'evt-1')

      const types = clientDc.sent.map((s) => JSON.parse(s).type)
      expect(types).toEqual([
        'TAKEOVER_REQUEST',
        'TAKEOVER_DECISION',
        'IDENTITY_MIGRATION',
        'ACK_SYNC',
        'TEAM_TAGS_UPDATE',
        'TAGS_FULL_SYNC'
      ])
    })

    it('enforces SAS gating on Host and Client sendDirectMessage without leaking to wire or offline queue', async () => {
      const host = makeDispatcher(true)
      const pendingDc = makeMockDc('open')
      const rejectedDc = makeMockDc('open')
      const verifiedDc = makeMockDc('open')

      host.clients.set('cid-pending', { pc: makeMockPc(), dc: pendingDc, pendingCandidates: [] })
      host.clients.set('cid-rejected', { pc: makeMockPc(), dc: rejectedDc, pendingCandidates: [] })
      host.clients.set('cid-verified', { pc: makeMockPc(), dc: verifiedDc, pendingCandidates: [] })
      host.scoutIdToClientIds.set('u-pending', new Set(['cid-pending']))
      host.scoutIdToClientIds.set('u-rejected', new Set(['cid-rejected']))
      host.scoutIdToClientIds.set('u-verified', new Set(['cid-verified']))

      host.sas.clientSasStates.set('cid-pending', 'PENDING_VERIFICATION')
      host.sas.clientSasStates.set('cid-rejected', 'REJECTED')
      host.sas.clientSasStates.set('cid-verified', 'VERIFIED')

      const pendingResult = await host.dispatcher.sendDirectMessage({
        targetId: 'u-pending',
        title: 'Secret',
        body: 'Hold until SAS'
      })
      expect(pendingResult).toBe(false)
      expect(pendingDc.sent).toHaveLength(0)
      expect(host.offlineMessages.flush('u-pending')).toHaveLength(0)
      expect(host.sas.hostPendingOutgoing.get('cid-pending')).toHaveLength(1)

      const rejectedResult = await host.dispatcher.sendDirectMessage({
        targetId: 'u-rejected',
        title: 'Secret',
        body: 'Must drop'
      })
      expect(rejectedResult).toBe(false)
      expect(rejectedDc.sent).toHaveLength(0)
      expect(host.offlineMessages.flush('u-rejected')).toHaveLength(0)
      expect(host.sas.hostPendingOutgoing.get('cid-rejected') ?? []).toHaveLength(0)

      const verifiedResult = await host.dispatcher.sendDirectMessage({
        targetId: 'u-verified',
        title: 'Hello',
        body: 'Cleared'
      })
      expect(verifiedResult).toBe(true)
      expect(verifiedDc.sent).toHaveLength(1)
      expect(JSON.parse(verifiedDc.sent[0]).type).toBe('DIRECT_MESSAGE')

      // Client side: PENDING_VERIFICATION buffers & returns false, REJECTED drops & returns false
      const client = makeDispatcher(false)
      const clientDc = makeMockDc('open')
      client.setClientDc(clientDc)

      client.sas.clientSasState = 'PENDING_VERIFICATION'
      expect(await client.dispatcher.sendDirectMessage({ targetId: 'host', title: 'C1', body: 'B1' })).toBe(false)
      expect(clientDc.sent).toHaveLength(0)
      expect(client.sas.clientPendingOutgoing).toHaveLength(1)

      client.sas.clientSasState = 'REJECTED'
      expect(await client.dispatcher.sendDirectMessage({ targetId: 'host', title: 'C2', body: 'B2' })).toBe(false)
      expect(clientDc.sent).toHaveLength(0)
      expect(client.sas.clientPendingOutgoing).toHaveLength(1)

      client.sas.clientSasState = 'VERIFIED'
      expect(await client.dispatcher.sendDirectMessage({ targetId: 'host', title: 'C3', body: 'B3' })).toBe(true)
      expect(clientDc.sent).toHaveLength(1)
    })

    it('routes Host broadcasts and DIRECT_MESSAGE forwards through SAS-gated sendMessage instead of enqueueSendQuiet', async () => {
      const { ctx, sendMessage } = makePhotoCtx(true, 'ROOM01', 'evt-1')
      const enqueueSpy1 = vi.fn()
      const enqueueSpy2 = vi.fn()
      ctx.clients.set('peer-1', { pc: makeMockPc(), dc: makeMockDc('open'), sender: { enqueueSendQuiet: enqueueSpy1 } as any, pendingCandidates: [] })
      ctx.clients.set('peer-2', { pc: makeMockPc(), dc: makeMockDc('open'), sender: { enqueueSendQuiet: enqueueSpy2 } as any, pendingCandidates: [] })
      ctx.clients.set('peer-rejected', { pc: makeMockPc(), dc: makeMockDc('open'), pendingCandidates: [] })
      ctx.scoutIdToClientIds.set('u-pending', new Set(['peer-2']))
      ctx.scoutIdToClientIds.set('u-rejected', new Set(['peer-rejected']))
      ctx.getPeerSasState = (peerId: string) => {
        if (peerId === 'peer-2') return 'PENDING_VERIFICATION'
        if (peerId === 'peer-rejected') return 'REJECTED'
        return 'VERIFIED'
      }
      ctx.callbacks.onTagUpdateReceived = vi.fn()
      ctx.callbacks.onCustomFieldUpdateReceived = vi.fn()
      ctx.callbacks.onAssignmentUpdateReceived = vi.fn()
      ctx.callbacks.onPitScoutUpdateReceived = vi.fn()
      ctx.callbacks.onPitScoutBatchSyncReceived = vi.fn()

      const handler = createChannelMessageHandler(ctx)
      const sendEv = (payload: unknown) => ({ data: JSON.stringify(payload) } as MessageEvent)

      await handler(
        sendEv({
          type: 'TEAM_TAGS_UPDATE',
          authCode: 'ROOM01',
          eventId: 'evt-1',
          action: 'ADD',
          tag: { id: 't1', eventId: 'evt-1', teamNumber: 27570, tag: 'fast', color: 'green', isPreset: false }
        }),
        'peer-1'
      )
      await handler(
        sendEv({
          type: 'CUSTOM_FIELD_UPDATE',
          authCode: 'ROOM01',
          action: 'ADD',
          field: { id: 'f1', eventId: 'evt-1', fieldKey: 'cycles', label: 'Cycles', fieldType: 'number', target: 'MATCH' }
        }),
        'peer-1'
      )
      await handler(
        sendEv({
          type: 'ASSIGNMENT_UPDATE',
          authCode: 'ROOM01',
          assignment: { id: 'a1', eventId: 'evt-1', matchNumber: 1, alliance: 'red', station: 1, scoutId: 'u2', scoutName: 'Bob' }
        }),
        'peer-1'
      )
      await handler(
        sendEv({
          type: 'PIT_SCOUT_UPDATE',
          authCode: 'ROOM01',
          record: { id: 'p1', eventId: 'evt-1', teamNumber: 27570, data: {}, updatedAt: 1 }
        }),
        'peer-1'
      )
      await handler(
        sendEv({
          type: 'PIT_SCOUT_BATCH_SYNC',
          authCode: 'ROOM01',
          records: [{ id: 'p2', eventId: 'evt-1', teamNumber: 12345, data: {}, updatedAt: 2 }]
        }),
        'peer-1'
      )

      await handleChannelIdentityAndTakeoverMessage(
        ctx,
        new Set(),
        { type: 'IDENTITY_MIGRATION', authCode: 'ROOM01', eventId: 'evt-1', oldScoutId: 'old-u', newScoutId: 'new-u', newScoutName: 'Alice' },
        'peer-1'
      )

      // No broadcast bypassed sendMessage via raw sender.enqueueSendQuiet
      expect(enqueueSpy1).not.toHaveBeenCalled()
      expect(enqueueSpy2).not.toHaveBeenCalled()

      const sentToPeer2 = sendMessage.mock.calls.filter((c: any[]) => c[1] === 'peer-2').map((c: any[]) => c[0].type)
      expect(sentToPeer2).toEqual([
        'TEAM_TAGS_UPDATE',
        'CUSTOM_FIELD_UPDATE',
        'ASSIGNMENT_UPDATE',
        'PIT_SCOUT_UPDATE',
        'PIT_SCOUT_BATCH_SYNC',
        'IDENTITY_MIGRATION'
      ])

      // Host DIRECT_MESSAGE forward: REJECTED drops & skips offlineMessages; PENDING_VERIFICATION routes via sendMessage & skips offlineMessages
      sendMessage.mockClear()
      await handler(
        sendEv({
          type: 'DIRECT_MESSAGE',
          authCode: 'ROOM01',
          messageId: 'dm-rej',
          senderId: 'u1',
          senderName: 'Alice',
          targetId: 'u-rejected',
          title: 'Secret',
          body: 'Do not forward'
        }),
        'peer-1'
      )
      expect(sendMessage).not.toHaveBeenCalled()
      expect(ctx.offlineMessages.flush('u-rejected')).toHaveLength(0)

      await handler(
        sendEv({
          type: 'DIRECT_MESSAGE',
          authCode: 'ROOM01',
          messageId: 'dm-pend',
          senderId: 'u1',
          senderName: 'Alice',
          targetId: 'u-pending',
          title: 'Hold',
          body: 'Buffer via sendMessage'
        }),
        'peer-1'
      )
      expect(sendMessage).toHaveBeenCalledTimes(1)
      expect(sendMessage.mock.calls[0][1]).toBe('peer-2')
      expect(ctx.offlineMessages.flush('u-pending')).toHaveLength(0)
    })

    it('reuses Host c.sender across 6 x 39 KiB CRDT_SYNC_CHUNK sends and drains strictly one-by-one without bursting', async () => {
      vi.useFakeTimers()
      const host = makeDispatcher(true)
      const dc = makeStatefulMockDc('open')
      host.clients.set('p1', { pc: makeMockPc(), dc, pendingCandidates: [] })
      host.sas.clientSasStates.set('p1', 'VERIFIED')

      const makeChunkMsg = (idx: number) => ({
        type: 'CRDT_SYNC_CHUNK' as const,
        eventId: 'evt-1',
        transferId: 'tx-1',
        chunkIndex: idx,
        totalChunks: 6,
        chunkData: 'x'.repeat(39300),
        authCode: 'CODE01'
      })

      const promises: Promise<void>[] = []
      let initialSender: DataChannelSender | undefined
      for (let i = 0; i < 6; i++) {
        promises.push(host.dispatcher.sendMessage(makeChunkMsg(i), 'p1'))
        const currentSender = host.clients.get('p1')?.sender
        expect(currentSender).toBeInstanceOf(DataChannelSender)
        if (i === 0) {
          initialSender = currentSender
        } else {
          expect(currentSender).toBe(initialSender)
        }
      }

      // Flush microtasks + 3ms pacing so chunk 0 sends (bufferedAmount > 39 KiB) and chunk 1 enters backpressure wait
      await vi.advanceTimersByTimeAsync(3)
      expect(dc.send).toHaveBeenCalledTimes(1)
      expect(dc.bufferedAmount).toBeGreaterThan(39000)
      expect(initialSender!.getQueueLength()).toBe(4) // chunk 1 waiting in safeSendInternal, chunks 2..5 in queue

      // Broadcast call must also preserve the exact same c.sender instance
      const broadcastPromise = host.dispatcher.sendMessage(makeChunkMsg(99))
      expect(host.clients.get('p1')?.sender).toBe(initialSender)
      expect(dc.send).toHaveBeenCalledTimes(1)

      // Drain chunks 1..5 and broadcast chunk strictly one-by-one via bufferedamountlow
      for (let expectedSent = 2; expectedSent <= 7; expectedSent++) {
        expect(dc.send).toHaveBeenCalledTimes(expectedSent - 1)
        dc.bufferedAmount = 0
        dc._triggerEvent('bufferedamountlow')
        await vi.advanceTimersByTimeAsync(3)
        expect(dc.send).toHaveBeenCalledTimes(expectedSent)
      }

      await Promise.all([...promises, broadcastPromise])
      expect(dc.sent.map((raw) => JSON.parse(raw).chunkIndex)).toEqual([0, 1, 2, 3, 4, 5, 99])
    })

    it('preempts queued CRDT_SYNC_CHUNK frames for PING, PONG, CLOCK_SYNC_REQ, and CLOCK_SYNC_RES on both Host and Client', async () => {
      vi.useFakeTimers()

      // --- Host side preemption ---
      const host = makeDispatcher(true)
      const hostDc = makeStatefulMockDc('open')
      host.clients.set('p1', { pc: makeMockPc(), dc: hostDc, pendingCandidates: [] })
      host.sas.clientSasStates.set('p1', 'VERIFIED')

      const makeHostChunk = (idx: number) => ({
        type: 'CRDT_SYNC_CHUNK' as const,
        eventId: 'evt-1',
        transferId: 'tx-h',
        chunkIndex: idx,
        totalChunks: 3,
        chunkData: 'h'.repeat(39000),
        authCode: 'CODE01'
      })

      const hChunk0 = host.dispatcher.sendMessage(makeHostChunk(0), 'p1')
      const hChunk1 = host.dispatcher.sendMessage(makeHostChunk(1), 'p1')
      const hChunk2 = host.dispatcher.sendMessage(makeHostChunk(2), 'p1')
      await vi.advanceTimersByTimeAsync(3)
      expect(hostDc.send).toHaveBeenCalledTimes(1) // chunk 0 sent; chunk 1 blocked on backpressure (~39 KiB)

      const hPing = host.dispatcher.sendMessage({ type: 'PING', timestamp: 1, authCode: 'CODE01' }, 'p1')
      const hPong = host.dispatcher.sendMessage({ type: 'PONG', timestamp: 1, authCode: 'CODE01' }, 'p1')
      const hClockReq = host.dispatcher.sendMessage({ type: 'CLOCK_SYNC_REQ', reqId: 'req-h-1', clientMonoM1: 100, authCode: 'CODE01' }, 'p1')
      const hClockRes = host.dispatcher.sendMessage({ type: 'CLOCK_SYNC_RES', reqId: 'req-h-1', clientMonoM1: 100, hostNow: 101, hostEpoch: 1, authCode: 'CODE01' }, 'p1')

      // Release chunk 1 -> bufferedAmount jumps back to ~39 KiB; high-priority control frames still preempt chunk 2!
      hostDc.bufferedAmount = 0
      hostDc._triggerEvent('bufferedamountlow')
      await vi.advanceTimersByTimeAsync(10)

      // Release chunk 2
      hostDc.bufferedAmount = 0
      hostDc._triggerEvent('bufferedamountlow')
      await vi.advanceTimersByTimeAsync(10)
      await Promise.all([hChunk0, hChunk1, hChunk2, hPing, hPong, hClockReq, hClockRes])

      expect(hostDc.sent.map((raw) => {
        const parsed = JSON.parse(raw)
        return parsed.type === 'CRDT_SYNC_CHUNK' ? `CHUNK_${parsed.chunkIndex}` : parsed.type
      })).toEqual(['CHUNK_0', 'CHUNK_1', 'PING', 'PONG', 'CLOCK_SYNC_REQ', 'CLOCK_SYNC_RES', 'CHUNK_2'])

      // --- Client side preemption ---
      const client = makeDispatcher(false)
      const clientDc = makeStatefulMockDc('open')
      client.setClientDc(clientDc)
      client.sas.clientSasState = 'VERIFIED'

      const makeClientChunk = (idx: number) => ({
        type: 'CRDT_SYNC_CHUNK' as const,
        eventId: 'evt-1',
        transferId: 'tx-c',
        chunkIndex: idx,
        totalChunks: 3,
        chunkData: 'c'.repeat(39000),
        authCode: 'CODE01'
      })

      const cChunk0 = client.dispatcher.sendMessage(makeClientChunk(0))
      const cChunk1 = client.dispatcher.sendMessage(makeClientChunk(1))
      const cChunk2 = client.dispatcher.sendMessage(makeClientChunk(2))
      await vi.advanceTimersByTimeAsync(3)
      expect(clientDc.send).toHaveBeenCalledTimes(1)

      const cPing = client.dispatcher.sendMessage({ type: 'PING', timestamp: 2, authCode: 'CODE01' })
      const cPong = client.dispatcher.sendMessage({ type: 'PONG', timestamp: 2, authCode: 'CODE01' })
      const cClockReq = client.dispatcher.sendMessage({ type: 'CLOCK_SYNC_REQ', reqId: 'req-c-1', clientMonoM1: 200, authCode: 'CODE01' })
      const cClockRes = client.dispatcher.sendMessage({ type: 'CLOCK_SYNC_RES', reqId: 'req-c-1', clientMonoM1: 200, hostNow: 201, hostEpoch: 1, authCode: 'CODE01' })

      clientDc.bufferedAmount = 0
      clientDc._triggerEvent('bufferedamountlow')
      await vi.advanceTimersByTimeAsync(10)

      clientDc.bufferedAmount = 0
      clientDc._triggerEvent('bufferedamountlow')
      await vi.advanceTimersByTimeAsync(10)
      await Promise.all([cChunk0, cChunk1, cChunk2, cPing, cPong, cClockReq, cClockRes])

      expect(clientDc.sent.map((raw) => {
        const parsed = JSON.parse(raw)
        return parsed.type === 'CRDT_SYNC_CHUNK' ? `CHUNK_${parsed.chunkIndex}` : parsed.type
      })).toEqual(['CHUNK_0', 'CHUNK_1', 'PING', 'PONG', 'CLOCK_SYNC_REQ', 'CLOCK_SYNC_RES', 'CHUNK_2'])
    })

    it('rebinds a new DataChannelSender when dc is swapped or existing sender is aborted on Host and Client', async () => {
      // --- Host side rebinding ---
      const host = makeDispatcher(true)
      const hostDc1 = makeMockDc('open')
      const hostDc2 = makeMockDc('open')
      const entry: ClientEntry = { pc: makeMockPc(), dc: hostDc1, pendingCandidates: [] }
      host.clients.set('p1', entry)
      host.sas.clientSasStates.set('p1', 'VERIFIED')

      await host.dispatcher.sendMessage({ type: 'PING', timestamp: 1, authCode: 'CODE01' }, 'p1')
      const sender1 = entry.sender!
      expect(sender1).toBeInstanceOf(DataChannelSender)
      expect(sender1.getChannel()).toBe(hostDc1)

      // Aborting sender1 forces replacement bound to hostDc1
      sender1.abort('manual abort')
      await host.dispatcher.sendMessage({ type: 'PING', timestamp: 2, authCode: 'CODE01' }, 'p1')
      const sender2 = entry.sender!
      expect(sender2).not.toBe(sender1)
      expect(sender2.isAborted()).toBe(false)
      expect(sender2.getChannel()).toBe(hostDc1)

      // Swapping entry.dc to hostDc2 forces replacement bound to hostDc2
      entry.dc = hostDc2
      await host.dispatcher.sendMessage({ type: 'PING', timestamp: 3, authCode: 'CODE01' }, 'p1')
      const sender3 = entry.sender!
      expect(sender3).not.toBe(sender2)
      expect(sender3.getChannel()).toBe(hostDc2)
      expect(hostDc2.sent).toHaveLength(1)

      // --- Client side rebinding ---
      const client = makeDispatcher(false)
      const clientDc1 = makeMockDc('open')
      const clientDc2 = makeMockDc('open')
      client.setClientDc(clientDc1)
      client.sas.clientSasState = 'VERIFIED'

      await client.dispatcher.sendMessage({ type: 'PING', timestamp: 10, authCode: 'CODE01' })
      const cSender1 = client.getClientSender()!
      expect(cSender1).toBeInstanceOf(DataChannelSender)
      expect(cSender1.getChannel()).toBe(clientDc1)

      cSender1.abort('client abort')
      await client.dispatcher.sendMessage({ type: 'PING', timestamp: 11, authCode: 'CODE01' })
      const cSender2 = client.getClientSender()!
      expect(cSender2).not.toBe(cSender1)
      expect(cSender2.isAborted()).toBe(false)
      expect(cSender2.getChannel()).toBe(clientDc1)

      client.setClientDc(clientDc2)
      await client.dispatcher.sendMessage({ type: 'PING', timestamp: 12, authCode: 'CODE01' })
      const cSender3 = client.getClientSender()!
      expect(cSender3).not.toBe(cSender2)
      expect(cSender3.getChannel()).toBe(clientDc2)
      expect(clientDc2.sent).toHaveLength(1)
    })
  })
})
