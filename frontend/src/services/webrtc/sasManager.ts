import type { WebRtcMessage } from '@/types'
import { savePeerTrustRecord } from '@/utils/identityStore'
import type { SasState, WebRtcCallbacks } from './types'

export class SasSecurityManager {
  clientSasState: SasState = 'VERIFIED'
  readonly clientSasStates = new Map<string, SasState>()

  clientPendingOutgoing: { msg: WebRtcMessage; targetId?: string }[] = []
  clientPendingIncoming: { ev: MessageEvent; senderId?: string }[] = []
  readonly hostPendingOutgoing = new Map<string, { msg: WebRtcMessage; targetId?: string }[]>()
  readonly hostPendingIncoming = new Map<string, { ev: MessageEvent; senderId?: string }[]>()

  readonly sasTimeoutTimers = new Map<string, any>()

  clientSharedAesKey: CryptoKey | null = null
  readonly clientSharedKeys = new Map<string, CryptoKey>() // Host: sender -> AES key
  readonly clientEcdhPubHexes = new Map<string, string>() // Host: sender -> client's ECDH pub hex
  readonly clientFingerprints = new Map<string, string>() // Host: sender -> SAS fingerprint
  readonly clientVerifiedIdentities = new Map<string, { userId: string; username: string; ecdhPublicKey?: string }>()
  readonly clientDeviceIds = new Map<string, string>() // Host: sender -> deviceId

  clientHostEcdhPubHex = ''
  clientHostDeviceId = ''
  clientHostUserId = ''
  clientHostUsername = ''
  clientSecurityFingerprint = ''

  confirmSas(
    peerId: string,
    isHostMode: boolean,
    currentInviteCode: string,
    callbacks: WebRtcCallbacks,
    sendMessage: (msg: WebRtcMessage, targetId?: string) => Promise<void>,
    handleChannelMessage: (ev: MessageEvent, senderId?: string) => Promise<void>
  ): void {
    const timer = this.sasTimeoutTimers.get(peerId)
    if (timer) {
      clearTimeout(timer)
      this.sasTimeoutTimers.delete(peerId)
    }

    if (isHostMode) {
      const sas = this.clientFingerprints.get(peerId)
      const pubHex = this.clientEcdhPubHexes.get(peerId)
      const identity = this.clientVerifiedIdentities.get(peerId)
      const effectiveUserId = identity?.userId || peerId
      const effectiveUsername = identity?.username || peerId
      const devId = this.clientDeviceIds.get(peerId) || (pubHex ? `dev_pub_${pubHex.slice(0, 16)}` : 'device_default')
      if (pubHex && sas) {
        try {
          localStorage.setItem(`scoutingpro_verified_sas_${currentInviteCode}_${pubHex}`, sas)
          localStorage.setItem(`scoutingpro_verified_sas_${currentInviteCode}_${effectiveUserId}_${pubHex}`, sas)
        } catch {}
        savePeerTrustRecord({
          eventId: currentInviteCode || 'default_event',
          userId: effectiveUserId,
          username: effectiveUsername,
          deviceId: devId,
          publicKeyHex: pubHex,
          firstSeenAt: Date.now(),
          lastSeenAt: Date.now(),
          trustedAt: Date.now(),
          trustLevel: 'MANUAL_VERIFIED'
        }).catch((err) => console.warn('[confirmSas] Failed to save trust record in IndexedDB:', err))
      }
      this.clientSasStates.set(peerId, 'VERIFIED')
      console.log(`[WebRTC Host Security] SAS confirmed for peer ${peerId}. Flushing gated queues.`)
      callbacks.onSasVerified?.(peerId)
      callbacks.onClientConnected?.(effectiveUserId, effectiveUsername)

      // Flush outgoing
      const pendingOut = this.hostPendingOutgoing.get(peerId) || []
      this.hostPendingOutgoing.delete(peerId)
      for (const item of pendingOut) {
        sendMessage(item.msg, item.targetId)
      }

      // Flush incoming
      const pendingIn = this.hostPendingIncoming.get(peerId) || []
      this.hostPendingIncoming.delete(peerId)
      for (const item of pendingIn) {
        handleChannelMessage(item.ev, item.senderId)
      }
    } else {
      if (this.clientHostEcdhPubHex && this.clientSecurityFingerprint) {
        try {
          localStorage.setItem(
            `scoutingpro_verified_sas_${currentInviteCode}_${this.clientHostEcdhPubHex}`,
            this.clientSecurityFingerprint
          )
        } catch {}
        const devId = this.clientHostDeviceId || `host_dev_${this.clientHostEcdhPubHex.slice(0, 16)}`
        const effectiveHostUserId = this.clientHostUserId || ''
        const effectiveHostUsername = this.clientHostUsername || 'Host'
        if (effectiveHostUserId) {
          savePeerTrustRecord({
            eventId: currentInviteCode || 'default_event',
            userId: effectiveHostUserId,
            username: effectiveHostUsername,
            deviceId: devId,
            publicKeyHex: this.clientHostEcdhPubHex,
            firstSeenAt: Date.now(),
            lastSeenAt: Date.now(),
            trustedAt: Date.now(),
            trustLevel: 'MANUAL_VERIFIED'
          }).catch((err) => console.warn('[confirmSas] Failed to save trust record in IndexedDB:', err))
        }
      }
      this.clientSasState = 'VERIFIED'
      console.log(`[WebRTC Client Security] SAS confirmed for host. Flushing gated queues.`)
      callbacks.onSasVerified?.('host')

      // Flush outgoing
      const pendingOut = [...this.clientPendingOutgoing]
      this.clientPendingOutgoing = []
      for (const item of pendingOut) {
        sendMessage(item.msg, item.targetId)
      }

      // Flush incoming
      const pendingIn = [...this.clientPendingIncoming]
      this.clientPendingIncoming = []
      for (const item of pendingIn) {
        handleChannelMessage(item.ev, item.senderId)
      }
    }
  }

  rejectSas(
    peerId: string,
    reason: string,
    isHostMode: boolean,
    callbacks: WebRtcCallbacks,
    onRejectHostPeer: (peerId: string) => void,
    onRejectClientConnection: () => void
  ): void {
    const timer = this.sasTimeoutTimers.get(peerId)
    if (timer) {
      clearTimeout(timer)
      this.sasTimeoutTimers.delete(peerId)
    }

    console.warn(`[WebRTC Security] SAS rejected for peer ${peerId}: ${reason}. Terminating connection immediately.`)
    if (isHostMode) {
      this.clientSasStates.set(peerId, 'REJECTED')
      this.hostPendingOutgoing.delete(peerId)
      this.hostPendingIncoming.delete(peerId)
      callbacks.onSasRejected?.(peerId, reason)

      onRejectHostPeer(peerId)
      this.cleanupPeerResources(peerId)
    } else {
      this.clientSasState = 'REJECTED'
      this.clientPendingOutgoing = []
      this.clientPendingIncoming = []
      callbacks.onSasRejected?.('host', reason)

      onRejectClientConnection()
    }
  }

  cleanupPeerResources(senderId: string): void {
    const timer = this.sasTimeoutTimers.get(senderId)
    if (timer) {
      clearTimeout(timer)
      this.sasTimeoutTimers.delete(senderId)
    }
    this.hostPendingOutgoing.delete(senderId)
    this.hostPendingIncoming.delete(senderId)
    this.clientSharedKeys.delete(senderId)
    this.clientEcdhPubHexes.delete(senderId)
    this.clientFingerprints.delete(senderId)
    this.clientVerifiedIdentities.delete(senderId)
    this.clientDeviceIds.delete(senderId)
  }

  clear(): void {
    this.sasTimeoutTimers.forEach((timer) => clearTimeout(timer))
    this.sasTimeoutTimers.clear()
    this.clientSasState = 'VERIFIED'
    this.clientSasStates.clear()
    this.clientPendingOutgoing = []
    this.clientPendingIncoming = []
    this.hostPendingOutgoing.clear()
    this.hostPendingIncoming.clear()
    this.clientSharedAesKey = null
    this.clientSharedKeys.clear()
    this.clientEcdhPubHexes.clear()
    this.clientFingerprints.clear()
    this.clientVerifiedIdentities.clear()
    this.clientDeviceIds.clear()
    this.clientHostEcdhPubHex = ''
    this.clientHostDeviceId = ''
    this.clientSecurityFingerprint = ''
  }
}
