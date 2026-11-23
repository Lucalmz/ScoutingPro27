import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createChannelMessageHandler } from '@/services/webrtc/channelMessageHandler'
import { createMessageDispatcher } from '@/services/webrtc/messageDispatcher'
import { useConnectionStore } from '@/stores/connection'
import { useUserStore } from '@/stores/user'
import {
  cleanIpAddress,
  isGlobalIpv6Address,
  isIpv6Address,
  isPrivateIpv4Address,
  isTunVirtualAddress,
  isDomesticCarrierIpv6,
  getIpv6Prefix64,
  isTemporaryPrivacyIpv6
} from '@/services/webrtc/ipAddressUtil'
import { OfflineMessageManager } from '@/services/webrtc/offlineQueue'
import { toSessionDescription, toIceCandidate } from '@/services/webrtc/sdpUtil'
import { evaluateAndApplyClientTrust } from '@/services/webrtc/clientTrustHelper'
import { PeerConnectionManager } from '@/services/webrtc/peerManager'
import type { WebRtcDirectMessage } from '@/types'

describe('WebRTC Decoupled Submodules Unit Suite', () => {
  describe('ipAddressUtil', () => {
    it('cleans bracketed IPv6, ports, and scope IDs accurately', () => {
      expect(cleanIpAddress('[2409:8c50:e00::1]:3478')).toBe('2409:8c50:e00::1')
      expect(cleanIpAddress('fe80::1ff:fe23:4567%eth0')).toBe('fe80::1ff:fe23:4567')
      expect(cleanIpAddress('192.168.1.10:8080')).toBe('192.168.1.10')
      expect(cleanIpAddress('')).toBe('')
    })

    it('distinguishes Global Unicast IPv6 from loopback, link-local, ULA, and reserved ranges', () => {
      expect(isGlobalIpv6Address('240e:390:e22:aa70:1234:5678:9abc:def0')).toBe(true)
      expect(isGlobalIpv6Address('2409:8c50:e00::1')).toBe(true)
      expect(isGlobalIpv6Address('::1')).toBe(false)
      expect(isGlobalIpv6Address('fe80::1')).toBe(false)
      expect(isGlobalIpv6Address('fdfe:dcba:9876::1')).toBe(false)
      expect(isGlobalIpv6Address('2001:db8::1')).toBe(false)
      expect(isGlobalIpv6Address('192.168.1.1')).toBe(false)
      expect(isIpv6Address('fe80::1')).toBe(true)
    })

    it('detects private IPv4 and proxy TUN virtual addresses', () => {
      expect(isPrivateIpv4Address('192.168.31.50')).toBe(true)
      expect(isPrivateIpv4Address('10.0.0.1')).toBe(true)
      expect(isPrivateIpv4Address('172.20.5.1')).toBe(true)
      expect(isPrivateIpv4Address('111.8.3.78')).toBe(false)

      expect(isTunVirtualAddress('198.18.0.1')).toBe(true)
      expect(isTunVirtualAddress('28.0.0.1')).toBe(true)
      expect(isTunVirtualAddress('28.255.1.10')).toBe(true)
      expect(isTunVirtualAddress('100.64.0.5')).toBe(true)
      expect(isTunVirtualAddress('172.19.0.1')).toBe(true)
      expect(isTunVirtualAddress('fdfe:dcba:9876::1')).toBe(true)
      expect(isTunVirtualAddress('240e:390:e22:aa70::1')).toBe(false)
    })

    it('identifies domestic carrier IPv6, /64 prefixes, and temporary privacy addresses', () => {
      const eui64Ip = '2408:8207:1234:5678:a2b3:ccff:fe11:2233'
      const tempIp = '2409:8900:1234:5678:9988:7766:5544:3322'

      expect(isDomesticCarrierIpv6(eui64Ip)).toBe(true)
      expect(isDomesticCarrierIpv6('2606:4700:49::1')).toBe(false)
      expect(getIpv6Prefix64(eui64Ip)).toBe('2408:8207:1234:5678')

      expect(isTemporaryPrivacyIpv6(eui64Ip)).toBe(false)
      expect(isTemporaryPrivacyIpv6(tempIp)).toBe(true)
    })
  })

  describe('OfflineMessageManager', () => {
    it('enqueues, flushes, caps per-target queue length, and expires old messages', () => {
      const mgr = new OfflineMessageManager()
      const makeMsg = (id: string): WebRtcDirectMessage => ({
        id,
        senderId: 'host',
        senderName: 'Host',
        targetId: 'peer-1',
        content: `hello ${id}`,
        timestamp: new Date().toISOString()
      })

      for (let i = 0; i < 55; i++) {
        mgr.enqueue('peer-1', makeMsg(`m-${i}`))
      }

      const flushed = mgr.flush('peer-1')
      // Capped at MAX_OFFLINE_PER_TARGET = 50, keeping the newest 50 (m-5 .. m-54)
      expect(flushed).toHaveLength(50)
      expect(flushed[0]!.message.id).toBe('m-5')
      expect(flushed[49]!.message.id).toBe('m-54')

      // Subsequent flush should be empty
      expect(mgr.flush('peer-1')).toHaveLength(0)
    })
  })

  describe('sdpUtil', () => {
    it('converts plain init objects into RTCSessionDescriptionInit and RTCIceCandidateInit safely', () => {
      const sdp = toSessionDescription({ type: 'offer', sdp: 'v=0\r\n' })
      expect(sdp.type).toBe('offer')
      expect(sdp.sdp).toBe('v=0\r\n')

      const ice = toIceCandidate({ candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 50000 typ host', sdpMid: '0' })
      expect(ice.candidate).toContain('typ host')
    })
  })

  describe('clientTrustHelper', () => {
    beforeEach(() => {
      localStorage.clear()
    })

    it('auto-approves TOFU first-seen host public key and flushes pending queues', async () => {
      const sentMessages: Array<{ msg: any; targetId?: string }> = []
      const handledMessages: Array<{ ev: any; senderId: string }> = []
      const verifiedPeers: string[] = []

      const mockCtx: any = {
        sas: {
          clientSasState: 'IDLE',
          clientSecurityFingerprint: '',
          clientHostEcdhPubHex: '',
          clientHostDeviceId: '',
          clientHostUsername: '',
          clientHostUserId: '',
          clientPendingOutgoing: [{ msg: { type: 'PING' }, targetId: 'host' }],
          clientPendingIncoming: [{ ev: { data: '{}' }, senderId: 'host' }],
          sasTimeoutTimers: new Map()
        },
        getLocalEcdhPubHex: () => '04aa11bb22cc33dd44ee55ff6677889900aabbccddeeff001122334455667788',
        getCurrentInviteCode: () => 'EVT2026',
        sendMessage: (msg: any, targetId?: string) => sentMessages.push({ msg, targetId }),
        handleChannelMessage: (ev: any, senderId: string) => handledMessages.push({ ev, senderId }),
        callbacks: {
          onSasVerified: (peerId: string) => verifiedPeers.push(peerId),
          onSasVerificationRequired: vi.fn()
        }
      }

      await evaluateAndApplyClientTrust(
        mockCtx,
        '04ffeeddccbbaa99887766554433221100ffeeddccbbaa998877665544332211',
        'host_dev_001',
        'LeadScout',
        'u-host-1'
      )

      expect(mockCtx.sas.clientSasState).toBe('VERIFIED')
      expect(mockCtx.sas.clientSecurityFingerprint).toBeTruthy()
      expect(sentMessages).toHaveLength(1)
      expect(handledMessages).toHaveLength(1)
      expect(verifiedPeers).toEqual(['host'])
    })
  })

  describe('PeerConnectionManager timer cleanup', () => {
    it('cancels delayed 1200ms and 3000ms updateTransportInfo timers on peer.close()', async () => {
      vi.useFakeTimers()
      const origRtcpc = global.RTCPeerConnection
      const getStatsMock = vi.fn().mockResolvedValue(new Map())
      const closeMock = vi.fn()
      let createdPeer: any = null

      global.RTCPeerConnection = vi.fn().mockImplementation(() => {
        createdPeer = {
          connectionState: 'new',
          iceConnectionState: 'new',
          iceGatheringState: 'new',
          getStats: getStatsMock,
          close: closeMock,
          onicecandidate: null,
          oniceconnectionstatechange: null,
          onconnectionstatechange: null,
          ondatachannel: null
        }
        return createdPeer
      }) as any

      try {
        const mgr = new PeerConnectionManager({
          getSignaling: () => null,
          isHostMode: () => false,
          callbacks: {
            onStatusChange: vi.fn(),
            onRecordsReceived: vi.fn(),
            onAckReceived: vi.fn(),
            onRequestSync: vi.fn()
          },
          setStatus: vi.fn(),
          getClientSharedAesKey: () => null,
          getClientSharedKey: () => null,
          getClientFingerprint: () => undefined,
          getClientSecurityFingerprint: () => ''
        })

        const peer = mgr.createPeerConnection(false)
        ;(peer as any).iceConnectionState = 'connected'
        peer.oniceconnectionstatechange?.({} as any)

        // Initial immediate getStats probe runs synchronously once; close immediately before 1200ms/3000ms
        expect(getStatsMock).toHaveBeenCalledTimes(1)
        peer.close()
        expect(closeMock).toHaveBeenCalledTimes(1)

        await vi.advanceTimersByTimeAsync(5000)
        // Must NOT fire delayed 1200ms / 3000ms updateTransportInfo probes after peer.close()
        expect(getStatsMock).toHaveBeenCalledTimes(1)
      } finally {
        global.RTCPeerConnection = origRtcpc
        vi.useRealTimers()
      }
    })
  })

  describe('Account Conflict, Quarantine & Takeover Messaging', () => {
    beforeEach(() => {
      setActivePinia(createPinia())
      vi.clearAllMocks()
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('triggers onTakeoverSuccess and clears session conflict when TAKEOVER_SUCCESS is received', async () => {
      const connStore = useConnectionStore()
      connStore.setSessionConflict({
        conflictingUsername: 'Alice',
        conflictingUserId: 'alice_1',
        conflictType: 'SAME_USER'
      })
      expect(connStore.sessionConflict).not.toBeNull()

      const onTakeoverSuccess = vi.fn(() => {
        connStore.clearSessionConflict()
      })

      const handler = createChannelMessageHandler({
        isHostMode: () => false,
        currentInviteCode: () => 'ABC123',
        getHostSessionId: () => 'h1',
        getCurrentHostSessionId: () => 'h1',
        setCurrentHostSessionId: () => {},
        callbacks: {
          onStatusChange: vi.fn(),
          onRecordsReceived: vi.fn(),
          onAckReceived: vi.fn(),
          onRequestSync: vi.fn(),
          onTakeoverSuccess
        },
        clients: new Map(),
        stagedClients: new Map(),
        scoutIdToClientIds: new Map(),
        clientIdToScoutId: new Map(),
        clientIdToScoutName: new Map(),
        pendingTakeovers: new Map(),
        takeoverCooldowns: new Map(),
        offlineMessages: {} as any,
        sendMessage: vi.fn(),
        promoteTakeover: vi.fn(),
        enqueueHostTask: vi.fn(),
        cleanupPeerResources: vi.fn(),
        closeClient: vi.fn(),
        setStatus: vi.fn()
      })

      await handler({ data: JSON.stringify({ type: 'TAKEOVER_SUCCESS', authCode: 'ABC123' }) } as MessageEvent, 'host')

      expect(onTakeoverSuccess).toHaveBeenCalled()
      expect(connStore.sessionConflict).toBeNull()
    })

    it('uses real eventId UUID rather than 6-char inviteCode when processing MERGE_ACCOUNT_REQUEST', async () => {
      const api = await import('@/services/api')
      const loginSpy = vi.spyOn(api, 'login').mockResolvedValueOnce({
        id: 'target_id_123',
        username: 'TargetAlice',
        token: 'valid_token'
      })
      const onIdentityMigration = vi.fn().mockResolvedValue(undefined)
      const sendMessage = vi.fn()
      const realEventUuid = '550e8400-e29b-41d4-a716-446655440000'
      const sixCharInviteCode = 'K9X2B4'

      const handler = createChannelMessageHandler({
        isHostMode: () => true,
        currentInviteCode: () => sixCharInviteCode,
        getCurrentEventId: () => realEventUuid,
        getHostSessionId: () => 'h1',
        getCurrentHostSessionId: () => 'h1',
        setCurrentHostSessionId: () => {},
        callbacks: {
          onStatusChange: vi.fn(),
          onRecordsReceived: vi.fn(),
          onAckReceived: vi.fn(),
          onRequestSync: vi.fn(),
          onIdentityMigration
        },
        clients: new Map(),
        stagedClients: new Map(),
        scoutIdToClientIds: new Map(),
        clientIdToScoutId: new Map(),
        clientIdToScoutName: new Map(),
        pendingTakeovers: new Map(),
        takeoverCooldowns: new Map(),
        offlineMessages: {} as any,
        sendMessage,
        promoteTakeover: vi.fn(),
        enqueueHostTask: async (_id, task) => { await task() },
        cleanupPeerResources: vi.fn(),
        closeClient: vi.fn(),
        setStatus: vi.fn()
      })

      await handler({
        data: JSON.stringify({
          type: 'MERGE_ACCOUNT_REQUEST',
          requestId: 'req-1',
          targetUsername: 'TargetAlice',
          targetPassword: 'password123',
          sourceUserId: 'source_id_456',
          sourceUsername: 'SourceAlice'
        })
      } as MessageEvent, 'client_1')

      expect(loginSpy).toHaveBeenCalledWith({ username: 'TargetAlice', password: 'password123' })
      expect(onIdentityMigration).toHaveBeenCalledTimes(1)
      expect(onIdentityMigration).toHaveBeenCalledWith(
        realEventUuid,
        'source_id_456',
        'target_id_123',
        'TargetAlice'
      )
      expect(onIdentityMigration).not.toHaveBeenCalledWith(
        sixCharInviteCode,
        expect.anything(),
        expect.anything(),
        expect.anything()
      )
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'MERGE_ACCOUNT_RESPONSE',
          requestId: 'req-1',
          success: true,
          newId: 'target_id_123',
          newUsername: 'TargetAlice',
          token: 'valid_token'
        }),
        'client_1'
      )
    })

    it('trims password and handles self-merge properly without deleting mapping in MERGE_ACCOUNT_REQUEST', async () => {
      const api = await import('@/services/api')
      const loginSpy = vi.spyOn(api, 'login').mockResolvedValue({
        id: 'target_id_123',
        username: 'TargetAlice',
        token: 'valid_token'
      })

      const scoutIdToClientIds = new Map<string, Set<string>>()
      scoutIdToClientIds.set('target_id_123', new Set(['client_1']))
      const sendMessage = vi.fn()

      const handler = createChannelMessageHandler({
        isHostMode: () => true,
        currentInviteCode: () => 'K9X2B4',
        getCurrentEventId: () => 'uuid-event-1',
        getHostSessionId: () => 'h1',
        getCurrentHostSessionId: () => 'h1',
        setCurrentHostSessionId: () => {},
        callbacks: {},
        clients: new Map([
          ['client_1', { pc: {} as any, dc: { readyState: 'open' } as any }]
        ]),
        stagedClients: new Map(),
        scoutIdToClientIds,
        clientIdToScoutId: new Map(),
        clientIdToScoutName: new Map(),
        pendingTakeovers: new Map(),
        takeoverCooldowns: new Map(),
        offlineMessages: {} as any,
        sendMessage,
        promoteTakeover: vi.fn(),
        enqueueHostTask: async (_id, task) => { await task() },
        cleanupPeerResources: vi.fn(),
        closeClient: vi.fn(),
        setStatus: vi.fn()
      })

      await handler({
        data: JSON.stringify({
          type: 'MERGE_ACCOUNT_REQUEST',
          requestId: 'req-trim-1',
          targetUsername: ' TargetAlice ',
          targetPassword: ' password123 \n ',
          sourceUserId: 'target_id_123',
          sourceUsername: 'TargetAlice'
        })
      } as MessageEvent, 'client_1')

      expect(loginSpy).toHaveBeenCalledWith({
        username: 'TargetAlice',
        password: 'password123'
      })

      expect(scoutIdToClientIds.get('target_id_123')).toBeDefined()
      expect(scoutIdToClientIds.get('target_id_123')?.has('client_1')).toBe(true)

      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'MERGE_ACCOUNT_RESPONSE',
          requestId: 'req-trim-1',
          success: true,
          newId: 'target_id_123'
        }),
        'client_1'
      )
    })

    it('Host messageDispatcher sends SESSION_CONFLICT to stagedClients before promotion', async () => {
      const mockDc = {
        readyState: 'open',
        send: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 0
      } as any

      const stagedClients = new Map()
      stagedClients.set('staged_client_phone', {
        pc: {} as any,
        dc: mockDc,
        pendingCandidates: []
      })

      const dispatcher = createMessageDispatcher({
        isHostMode: () => true,
        getCurrentInviteCode: () => 'ABC123',
        getHostSessionId: () => 'host-sess',
        clients: new Map(),
        stagedClients,
        scoutIdToClientIds: new Map(),
        offlineMessages: {} as any,
        sas: {
          clientSasStates: new Map(),
          hostPendingOutgoing: new Map()
        } as any,
        getClientDc: () => null,
        getClientSender: () => null,
        setClientSender: () => {},
        setStatus: () => {},
        getLocalUserId: () => 'host-user',
        setLocalUserId: () => {},
        getLocalUserName: () => 'Host',
        setLocalUserName: () => {},
      })

      await dispatcher.sendMessage(
        {
          type: 'SESSION_CONFLICT',
          conflictingUsername: 'Alice',
          conflictingUserId: 'alice_1',
          conflictType: 'SAME_USER'
        },
        'staged_client_phone'
      )

      expect(mockDc.send).toHaveBeenCalledTimes(1)
      expect(mockDc.send).toHaveBeenCalledWith(expect.stringContaining('"type":"SESSION_CONFLICT"'))
    })

    it('strictly quarantines conflicting client: suppresses sync requests and SYNC_DATA, frees peer on merge', async () => {
      const userStore = useUserStore()
      userStore.user = {
        id: 'host_alice_uuid',
        username: 'Alice',
        token: 'host_token'
      }

      const onRequestSync = vi.fn()
      const onRequestScheduleSync = vi.fn()
      const onRequestPitSync = vi.fn()
      const onRequestTagsSync = vi.fn()
      const onRequestCustomFieldsSync = vi.fn()
      const onRecordsReceived = vi.fn().mockResolvedValue([])
      const onCrdtSyncMessage = vi.fn()
      const sendMessage = vi.fn()

      const handler = createChannelMessageHandler({
        isHostMode: () => true,
        currentInviteCode: () => 'ROOM99',
        getCurrentEventId: () => 'evt-uuid-1',
        getHostSessionId: () => 'host-sess-1',
        getCurrentHostSessionId: () => 'host-sess-1',
        setCurrentHostSessionId: () => {},
        callbacks: {
          onRequestSync,
          onRequestScheduleSync,
          onRequestPitSync,
          onRequestTagsSync,
          onRequestCustomFieldsSync,
          onRecordsReceived,
          onCrdtSyncMessage
        },
        clients: new Map([
          ['client_conflict', { pc: {} as any, dc: { readyState: 'open', send: vi.fn() } as any }],
          ['client_normal', { pc: {} as any, dc: { readyState: 'open', send: vi.fn() } as any }]
        ]),
        stagedClients: new Map(),
        scoutIdToClientIds: new Map(),
        clientIdToScoutId: new Map(),
        clientIdToScoutName: new Map(),
        pendingTakeovers: new Map(),
        takeoverCooldowns: new Map(),
        offlineMessages: { flush: vi.fn().mockReturnValue([]) } as any,
        sendMessage,
        promoteTakeover: vi.fn(),
        enqueueHostTask: async (_id, task) => { await task() },
        cleanupPeerResources: vi.fn(),
        closeClient: vi.fn(),
        setStatus: vi.fn()
      })

      await handler({
        data: JSON.stringify({
          type: 'REQUEST_SYNC',
          senderUserId: 'bob_uuid',
          senderUserName: 'Bob',
          authCode: 'ROOM99'
        })
      } as MessageEvent, 'client_normal')

      expect(handler.isQuarantinedPeer('client_normal')).toBe(false)
      expect(onRequestSync).toHaveBeenCalledWith(0, 'client_normal')
      onRequestSync.mockClear()

      await handler({
        data: JSON.stringify({
          type: 'REQUEST_SYNC',
          senderUserId: 'phone_alice_diff_uuid',
          senderUserName: 'Alice',
          authCode: 'ROOM99'
        })
      } as MessageEvent, 'client_conflict')

      expect(handler.isQuarantinedPeer('client_conflict')).toBe(true)
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'SESSION_CONFLICT',
          conflictType: 'DUPLICATE_NAME',
          conflictingUsername: 'Alice',
          conflictingUserId: 'host_alice_uuid'
        }),
        'client_conflict'
      )
      expect(onRequestSync).not.toHaveBeenCalled()

      await handler({ data: JSON.stringify({ type: 'REQUEST_SCHEDULE_SYNC', authCode: 'ROOM99' }) } as MessageEvent, 'client_conflict')
      expect(onRequestScheduleSync).not.toHaveBeenCalled()

      await handler({ data: JSON.stringify({ type: 'REQUEST_PIT_SYNC', authCode: 'ROOM99' }) } as MessageEvent, 'client_conflict')
      expect(onRequestPitSync).not.toHaveBeenCalled()

      await handler({ data: JSON.stringify({ type: 'REQUEST_TAGS_SYNC', authCode: 'ROOM99' }) } as MessageEvent, 'client_conflict')
      expect(onRequestTagsSync).not.toHaveBeenCalled()

      await handler({ data: JSON.stringify({ type: 'REQUEST_CUSTOM_FIELDS_SYNC', authCode: 'ROOM99' }) } as MessageEvent, 'client_conflict')
      expect(onRequestCustomFieldsSync).not.toHaveBeenCalled()

      await handler({
        data: JSON.stringify({
          type: 'SYNC_DATA',
          records: [{ id: 'rec-1', eventId: 'evt-uuid-1', scoutId: 'phone_alice_diff_uuid' }],
          authCode: 'ROOM99'
        })
      } as MessageEvent, 'client_conflict')
      expect(onRecordsReceived).not.toHaveBeenCalled()

      await handler({
        data: JSON.stringify({
          type: 'CRDT_SYNC_MSG',
          fromClientId: 'client_conflict',
          toClientId: 'host',
          requestId: null,
          message: 1,
          body: [],
          authCode: 'ROOM99'
        })
      } as MessageEvent, 'client_conflict')
      expect(onCrdtSyncMessage).not.toHaveBeenCalled()

      await handler({ data: JSON.stringify({ type: 'REQUEST_SCHEDULE_SYNC', authCode: 'ROOM99' }) } as MessageEvent, 'client_normal')
      expect(onRequestScheduleSync).toHaveBeenCalledWith('client_normal')

      const api = await import('@/services/api')
      vi.spyOn(api, 'login').mockResolvedValueOnce({
        id: 'host_alice_uuid',
        username: 'Alice',
        token: 'merged_token'
      })

      await handler({
        data: JSON.stringify({
          type: 'MERGE_ACCOUNT_REQUEST',
          requestId: 'req-merge-ok',
          targetUsername: 'Alice',
          targetPassword: 'correct_password',
          sourceUserId: 'phone_alice_diff_uuid',
          sourceUsername: 'Alice',
          authCode: 'ROOM99'
        })
      } as MessageEvent, 'client_conflict')

      expect(handler.isQuarantinedPeer('client_conflict')).toBe(false)

      await handler({ data: JSON.stringify({ type: 'REQUEST_SCHEDULE_SYNC', authCode: 'ROOM99' }) } as MessageEvent, 'client_conflict')
      expect(onRequestScheduleSync).toHaveBeenCalledWith('client_conflict')
    })

    it('Host sends PIT_SCOUT_ACK on PIT_SCOUT_BATCH_SYNC and Client dispatches PIT_SCOUT_ACK to onPitScoutAckReceived', async () => {
      const sentMessages: Array<{ msg: any; targetId?: string }> = []
      const hostCtx: any = {
        isHostMode: () => true,
        currentInviteCode: () => 'K9X2B4',
        callbacks: {
          onPitScoutBatchSyncReceived: vi.fn()
        },
        clients: new Map(),
        sendMessage: vi.fn().mockImplementation((msg, targetId) => {
          sentMessages.push({ msg, targetId })
        })
      }

      const hostHandler = createChannelMessageHandler(hostCtx)
      const batchMsg = {
        type: 'PIT_SCOUT_BATCH_SYNC',
        records: [
          { teamNumber: 27570, drivetrain: 'Mecanum' },
          { teamNumber: 12345, drivetrain: 'Tank' }
        ]
      }
      await hostHandler({ data: JSON.stringify(batchMsg) } as MessageEvent, 'client-sender-1')

      expect(hostCtx.callbacks.onPitScoutBatchSyncReceived).toHaveBeenCalledWith(batchMsg.records, 'client-sender-1')
      const ack = sentMessages.find((s) => s.msg.type === 'PIT_SCOUT_ACK')
      expect(ack).toBeDefined()
      expect(ack?.targetId).toBe('client-sender-1')
      expect(ack?.msg.teamNumbers).toEqual([27570, 12345])

      const onPitScoutAckReceived = vi.fn()
      const clientHandler = createChannelMessageHandler({
        isHostMode: () => false,
        currentInviteCode: () => 'K9X2B4',
        callbacks: { onPitScoutAckReceived },
        clients: new Map(),
        sendMessage: vi.fn()
      } as any)

      await clientHandler({ data: JSON.stringify({ type: 'PIT_SCOUT_ACK', teamNumbers: [27570, 12345] }) } as MessageEvent, 'host-sender')
      expect(onPitScoutAckReceived).toHaveBeenCalledTimes(1)
      expect(onPitScoutAckReceived).toHaveBeenCalledWith([27570, 12345])
    })
  })
})
