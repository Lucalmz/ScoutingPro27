import { createLogger } from '@/utils/logger'
import type { ClientSessionContext } from './clientSession'
import type { VirtualDataChannel } from './virtualDataChannel'

const log = createLogger('WebRTC:Heartbeat')

/** DataChannel 心跳：连续丢失多少次判定为“降级”（仅 UI 提示，持续观察） */
const HEARTBEAT_DEGRADE_MISSES = 2
/** DataChannel 心跳：连续丢失多少次判定为 SCTP 僵死，触发重建（ICE consent 仍存活但通道卡死的兜底） */
const HEARTBEAT_REBUILD_MISSES = 8

export interface ClientHeartbeatDeps {
  ctx: ClientSessionContext
  getAttemptEpoch: () => number
  getActiveVirtualDc: () => VirtualDataChannel | null
  failAttempt: (epoch: number, reason: string) => void
}

/**
 * Client 侧 DataChannel 心跳与 RTT 测量管理器
 */
export function createClientHeartbeatManager(deps: ClientHeartbeatDeps) {
  const { ctx, getAttemptEpoch, getActiveVirtualDc, failAttempt } = deps
  const pendingPings = new Map<number, (ok: boolean) => void>()
  let dataChannelHeartbeatTimer: ReturnType<typeof setInterval> | null = null
  let consecutiveFailedPings = 0

  function abortPendingPings() {
    for (const [, resolve] of pendingPings.entries()) {
      resolve(false)
    }
    pendingPings.clear()
  }

  function handlePong(timestamp: number) {
    if (pendingPings.has(timestamp)) {
      const resolve = pendingPings.get(timestamp)
      pendingPings.delete(timestamp)
      const activeVirtualDc = getActiveVirtualDc()
      if (activeVirtualDc && ctx.getClientDc() === (activeVirtualDc as any) && ctx.peerMgr.currentTransportInfo) {
        const rtt = Math.max(1, Date.now() - timestamp)
        ctx.peerMgr.currentTransportInfo = {
          ...ctx.peerMgr.currentTransportInfo,
          rttMs: rtt,
          securityFingerprint: ctx.sas.clientSecurityFingerprint || ctx.peerMgr.currentTransportInfo.securityFingerprint
        }
        ;(ctx.callbacks.onTransportInfoChanged || ctx.callbacks.onTransportChange)?.(ctx.peerMgr.currentTransportInfo)
      }
      resolve?.(true)
    }
  }

  async function pingHost(timeoutMs = 800): Promise<boolean> {
    const dc = ctx.getClientDc()
    const pc = ctx.getClientPc()
    const isVirtualOpen = Boolean((dc as any)?.isVirtual && dc?.readyState === 'open')
    if (!dc || dc.readyState !== 'open' || (!isVirtualOpen && (!pc || pc.connectionState !== 'connected'))) {
      return false
    }
    const ts = Date.now()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingPings.delete(ts)
        resolve(false)
      }, timeoutMs)

      pendingPings.set(ts, (ok) => {
        clearTimeout(timer)
        resolve(ok)
      })

      try {
        ctx.sendMessage({ type: 'PING' as any, timestamp: ts })
      } catch {
        clearTimeout(timer)
        pendingPings.delete(ts)
        resolve(false)
      }
    })
  }

  function startDataChannelHeartbeat() {
    stopDataChannelHeartbeat()
    consecutiveFailedPings = 0
    const epoch = getAttemptEpoch()
    const intervalMs = (globalThis as any).__TEST_HEARTBEAT_INTERVAL_MS__ ?? 2000
    const defaultPingTimeoutMs = (globalThis as any).__TEST_PING_TIMEOUT_MS__

    dataChannelHeartbeatTimer = setInterval(async () => {
      if (epoch !== getAttemptEpoch()) {
        stopDataChannelHeartbeat()
        return
      }
      const dc = ctx.getClientDc()
      const pc = ctx.getClientPc()
      const isVirtualOpen = Boolean((dc as any)?.isVirtual && dc?.readyState === 'open')
      if (!dc || dc.readyState !== 'open' || (!isVirtualOpen && (!pc || pc.connectionState !== 'connected'))) {
        return
      }
      // VirtualDataChannel 走公共 MQTT Broker + 手机 VPN 时偶发 2~3s 抖动，放宽单次 Ping 超时至 3500ms
      const effectiveTimeoutMs = defaultPingTimeoutMs ?? (isVirtualOpen ? 3500 : 1200)
      const isAlive = await pingHost(effectiveTimeoutMs)
      if (epoch !== getAttemptEpoch()) return
      if (!isAlive) {
        consecutiveFailedPings++
        log.warn(`DataChannel heartbeat ping timeout (${consecutiveFailedPings} consecutive misses)`)
        if (consecutiveFailedPings === HEARTBEAT_DEGRADE_MISSES) {
          // 关键修复：仅标记 degraded 并触发 onHostDisconnected，绝不调用 onActiveHostLeft()！
          // 因为 onActiveHostLeft 会直接把 connStore.status 强行设为 'offline' 并弹出“主机离开房间”的错误提示，
          // 导致后续 PONG 到达时因状态分裂无法恢复（日志 18:10:59 假离线断联的元凶）。
          log.warn('Active host unresponsive via DataChannel heartbeat. Marking degraded and continuing to probe.')
          ctx.peerMgr.resetTransportInfo()
          ctx.setStatus('degraded')
          ctx.callbacks.onHostDisconnected?.()
        } else if (consecutiveFailedPings >= HEARTBEAT_REBUILD_MISSES) {
          log.warn('DataChannel heartbeat dead for an extended period (SCTP wedged). Forcing connection rebuild.')
          stopDataChannelHeartbeat()
          failAttempt(epoch, 'heartbeat_timeout')
        }
      } else {
        if (consecutiveFailedPings > 0 && ctx.getStatus() === 'degraded') {
          log.info('DataChannel heartbeat restored, updating status to connected.')
          ctx.setStatus('connected')
          const pc2 = ctx.getClientPc()
          if (pc2) void ctx.peerMgr.updateTransportInfo(pc2)
        }
        consecutiveFailedPings = 0
      }
    }, intervalMs)
  }

  function stopDataChannelHeartbeat() {
    if (dataChannelHeartbeatTimer) {
      clearInterval(dataChannelHeartbeatTimer)
      dataChannelHeartbeatTimer = null
    }
    consecutiveFailedPings = 0
  }

  return {
    handlePong,
    pingHost,
    startDataChannelHeartbeat,
    stopDataChannelHeartbeat,
    abortPendingPings
  }
}
