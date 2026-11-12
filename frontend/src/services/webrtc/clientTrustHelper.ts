import { computeSecurityFingerprint } from '@/utils/crypto'
import { evaluatePeerKeyTrust, savePeerTrustRecord } from '@/utils/identityStore'
import { createLogger } from '@/utils/logger'
import type { ClientSessionContext } from './clientSession'

const log = createLogger('WebRTC:ClientTrust')

/**
 * 评估并应用从机对主机 (Host) 的 ECDH 公钥信任与 TOFU / SAS 状态机
 */
export async function evaluateAndApplyClientTrust(
  ctx: ClientSessionContext,
  hostPubKey: string,
  hostDeviceId?: string,
  hostUsername?: string,
  hostUserId?: string
): Promise<void> {
  const sas = ctx.sas
  const previousHostPubHex = sas.clientHostEcdhPubHex
  if (sas.clientSasState === 'PENDING_VERIFICATION' && previousHostPubHex === hostPubKey) {
    return
  }

  const localEcdhPubHex = ctx.getLocalEcdhPubHex()
  const currentInviteCode = ctx.getCurrentInviteCode()
  if (!localEcdhPubHex || !currentInviteCode) return

  // 确定性 Host 设备 ID：若信令未显式提供，依据公钥指纹前缀唯一绑定，支持主备多机并存
  const effectiveHostDeviceId = hostDeviceId || `host_dev_${hostPubKey.slice(0, 16)}`
  sas.clientHostDeviceId = effectiveHostDeviceId
  sas.clientSecurityFingerprint = await computeSecurityFingerprint(localEcdhPubHex, hostPubKey, currentInviteCode)
  log.info(`Computed SAS Fingerprint for Host: ${sas.clientSecurityFingerprint} (Device: ${effectiveHostDeviceId})`)

  const effectiveHostUserId = hostUserId || sas.clientHostUserId || ''
  const effectiveHostUsername =
    hostUsername || sas.clientHostUsername || (effectiveHostUserId ? `User ${effectiveHostUserId.slice(0, 8)}` : 'Host')
  if (effectiveHostUserId) sas.clientHostUserId = effectiveHostUserId
  if (effectiveHostUsername) sas.clientHostUsername = effectiveHostUsername

  const isFlapping = Boolean(
    previousHostPubHex &&
    previousHostPubHex !== hostPubKey &&
    sas.clientSasState === 'VERIFIED'
  )

  sas.clientHostEcdhPubHex = hostPubKey

  // 检查本地 localStorage 显式核验记录（赛事 + 公钥）
  let isLocallyApproved = false
  try {
    const storedSas = localStorage.getItem(`scoutingpro_verified_sas_${currentInviteCode}_${hostPubKey}`)
    if (storedSas && storedSas === sas.clientSecurityFingerprint) {
      isLocallyApproved = true
    }
  } catch {}

  const trustEval = await evaluatePeerKeyTrust({
    eventId: currentInviteCode || 'default_event',
    userId: effectiveHostUserId,
    username: effectiveHostUsername,
    deviceId: sas.clientHostDeviceId,
    publicKeyHex: hostPubKey,
    isInSessionFlapping: isFlapping
  })

  if (trustEval.status === 'TRUSTED_MATCH' || trustEval.status === 'TOFU_FIRST_SEEN' || isLocallyApproved) {
    log.info(
      `Establishing baseline trust for Host device ${sas.clientHostDeviceId} (${effectiveHostUsername}). Auto-approving SAS. Status: ${trustEval.status} (localApproved: ${isLocallyApproved})`
    )
    if (trustEval.status === 'TOFU_FIRST_SEEN' || isLocallyApproved) {
      await savePeerTrustRecord({
        eventId: currentInviteCode || 'default_event',
        userId: effectiveHostUserId,
        username: effectiveHostUsername,
        deviceId: sas.clientHostDeviceId,
        publicKeyHex: hostPubKey,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        trustedAt: Date.now(),
        trustLevel: isLocallyApproved ? 'MANUAL_VERIFIED' : 'TOFU_TRUSTED'
      })
    }
    sas.clientSasState = 'VERIFIED'
    const pendingOut = [...sas.clientPendingOutgoing]
    sas.clientPendingOutgoing = []
    for (const item of pendingOut) {
      ctx.sendMessage(item.msg, item.targetId)
    }
    const pendingIn = [...sas.clientPendingIncoming]
    sas.clientPendingIncoming = []
    for (const item of pendingIn) {
      ctx.handleChannelMessage(item.ev, item.senderId)
    }
    ctx.callbacks.onSasVerified?.('host')
  } else if (trustEval.status === 'KEY_ROTATION_ALERT') {
    // 当已建立信任的设备公钥发生变动时，挂起通信并弹出安全核验，由用户核对安全码后决定同意还是拒绝
    log.warn(`Security Notice [${trustEval.level}]: ${trustEval.message}. Gating client verification.`)
    sas.clientSasState = 'PENDING_VERIFICATION'
    if (sas.sasTimeoutTimers.has('host')) {
      clearTimeout(sas.sasTimeoutTimers.get('host'))
      sas.sasTimeoutTimers.delete('host')
    }

    ctx.callbacks.onSasVerificationRequired?.(
      {
        peerId: 'host',
        username: effectiveHostUsername,
        ecdhPublicKey: hostPubKey
      },
      sas.clientSecurityFingerprint
    )
  }
}
