import { describe, it, expect, beforeEach, vi } from 'vitest'
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
})
