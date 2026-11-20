<script setup lang="ts">
import { computed } from 'vue'
import { useConnectionStore } from '@/stores/connection'
import { useEventStore } from '@/stores/events'
import { useI18n } from 'vue-i18n'
import { hapticLight } from '@/utils/haptics'

const conn = useConnectionStore()
const eventStore = useEventStore()
const { t } = useI18n()

const isHost = computed(() => Boolean(eventStore.isHost && !conn.isStandbyHost))

async function handleReconnect() {
  hapticLight()
  await conn.reconnectNow()
}

const isVirtualTunnel = computed(() => {
  const info = conn.transportInfo
  if (!info || info.type !== 'relay') return false
  return Boolean(
    info.isVirtualTunnel ||
    info.protocol === 'wss/tls' ||
    info.localCandidateType === 'virtual' ||
    info.label === 'ECDH Tunnel (TLS)'
  )
})

const transportIcon = computed(() => {
  if (isVirtualTunnel.value) {
    return 'lock'
  }
  const type = conn.transportInfo?.type
  switch (type) {
    case 'ipv6_p2p':
      return 'public'
    case 'lan_p2p':
      return 'router'
    case 'nat_p2p':
      return 'alt_route'
    case 'relay':
      return 'sync_alt'
    default:
      return 'link'
  }
})

const transportLabel = computed(() => {
  const type = conn.transportInfo?.type
  if (!type) return ''
  if (isVirtualTunnel.value) {
    return t('connection.transport_virtual_tunnel')
  }
  switch (type) {
    case 'ipv6_p2p':
      return t('connection.transport_ipv6')
    case 'lan_p2p':
      return t('connection.transport_lan')
    case 'nat_p2p':
      return t('connection.transport_nat')
    case 'relay':
      return t('connection.transport_relay')
    default:
      return t('connection.transport_unknown')
  }
})

const transportTooltip = computed(() => {
  const info = conn.transportInfo
  if (!info) return ''
  const key = isVirtualTunnel.value ? 'transport_tooltip_virtual_tunnel'
    : info.type === 'ipv6_p2p' ? 'transport_tooltip_ipv6'
    : info.type === 'lan_p2p' ? 'transport_tooltip_lan'
    : info.type === 'nat_p2p' ? 'transport_tooltip_nat'
    : info.type === 'relay' ? 'transport_tooltip_relay'
    : 'transport_unknown'
  const baseDesc = t('connection.' + key)
  const details = `\n${info.localAddress} (${info.localCandidateType}) <-> ${info.remoteAddress} (${info.remoteCandidateType}) [${info.protocol}]`
  const rtt = info.rttMs !== null ? ` | RTT: ${info.rttMs}ms` : ''
  const fingerprint = info.securityFingerprint ? `\nSAS: ${info.securityFingerprint}` : ''
  return `${baseDesc}${details}${rtt}${fingerprint}`
})
</script>

<template>
  <div class="status-container">
    <div class="connection-status" :class="conn.status">
      <span class="material-icons status-icon">{{ conn.statusIcon }}</span>
      <span class="status-label">{{ t('connection.' + (conn.status === 'waiting' ? 'host_online' : conn.status)) }}</span>
    </div>

    <!-- Active Transport Badge (IPv6 / LAN / NAT / Relay) - 仅限从机/客户端 (1对1链路) 显示 -->
    <div
      v-if="!isHost && conn.isConnected && conn.transportInfo && conn.transportInfo.type !== 'unknown'"
      class="transport-badge"
      :class="[conn.transportInfo.type, { 'virtual-tunnel': isVirtualTunnel }]"
      :title="transportTooltip"
    >
      <span class="material-icons transport-icon">{{ transportIcon }}</span>
      <span class="transport-text">{{ transportLabel }}</span>
      <span v-if="conn.transportInfo.rttMs !== null" class="transport-rtt">
        {{ conn.transportInfo.rttMs }}ms
      </span>
    </div>

    <!-- SAS Security Fingerprint Badge - 仅限从机/客户端 (1对1链路) 显示 -->
    <div
      v-if="!isHost && conn.isConnected && conn.transportInfo?.securityFingerprint"
      class="fingerprint-badge"
      :title="t('connection.sas_tooltip', { code: conn.transportInfo.securityFingerprint })"
    >
      <span class="material-icons fingerprint-icon">verified_user</span>
      <span class="fingerprint-text">{{ conn.transportInfo.securityFingerprint }}</span>
    </div>

    <!-- ICE Checking Stall Notice -->
    <div
      v-if="conn.isIceStalled"
      class="ice-stall-badge"
      :title="t('connection.ice_stalled_tooltip')"
    >
      <span class="material-icons stall-icon spinning">sync</span>
      <span class="stall-text">{{ t('connection.ice_stalled') }}</span>
    </div>

    <!-- Long Offline Reconnect Button -->
    <button
      v-if="conn.isLongOffline || conn.isOffline"
      class="reconnect-btn"
      :disabled="conn.isReconnecting"
      @click="handleReconnect"
    >
      <span class="material-icons btn-icon" :class="{ spinning: conn.isReconnecting }">
        {{ conn.isReconnecting ? 'sync' : 'refresh' }}
      </span>
      <span>{{ t('connection.reconnect_now') }}</span>
    </button>

    <!-- Pending SAS Verification Alert Button -->
    <button
      v-if="conn.pendingSasQueue.length > 0 && !conn.isSasModalOpen"
      class="pending-sas-btn"
      :title="t('connection.sas_pending_badge_tooltip')"
      @click="conn.openSasModal"
    >
      <span class="material-icons pending-icon">shield</span>
      <span>{{ t('connection.sas_pending_badge', { count: conn.pendingSasQueue.length }) }}</span>
    </button>
  </div>
</template>


<style scoped>
.status-container {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ice-stall-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.25rem 0.6rem;
  background: var(--status-warning-bg);
  border: 1px solid var(--status-warning-border);
  color: var(--status-warning);
  border-radius: 9999px;
  font-size: 0.8rem;
  font-weight: 500;
}

.stall-icon {
  font-size: 1rem;
}

.connection-status {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  background: var(--input);
  color: var(--muted-foreground);
  transition: background-color var(--motion-duration-normal) var(--motion-ease-out),
              border-color var(--motion-duration-normal) var(--motion-ease-out),
              color var(--motion-duration-normal) var(--motion-ease-out);
}

.status-icon {
  font-size: 16px;
}

.connection-status.connected {
  background: var(--card);
  color: var(--status-success);
  border: 1px solid var(--status-success-border);
}

.connection-status.connected .status-icon {
  animation: pulse-live 3.2s ease-in-out infinite;
}

@keyframes pulse-live {
  0%, 100% {
    transform: scale(1);
    opacity: 0.85;
  }
  50% {
    transform: scale(1.15);
    opacity: 1;
  }
}

.connection-status.connecting {
  background: var(--card);
  color: var(--status-warning);
}
.connection-status.connecting .status-icon {
  animation: spin 1.5s linear infinite;
}

.connection-status.offline {
  background: var(--card);
  color: var(--status-error);
}

.connection-status.long_offline {
  background: var(--card);
  color: var(--status-error);
  border: 1px solid var(--status-error-border);
}

.connection-status.degraded {
  background: var(--card);
  color: var(--status-warning);
  border: 1px solid var(--status-warning);
}

.connection-status.unstable {
  background: var(--card);
  color: var(--status-warning);
  border: 1px solid var(--status-warning-border);
}
.connection-status.unstable .status-icon {
  animation: pulse 1s infinite;
}

.connection-status.waiting {
  background: var(--card);
  color: var(--primary);
  border: 1px solid var(--status-success-border);
}
.connection-status.waiting .status-icon {
  animation: pulse 2s infinite;
}

.reconnect-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  background: var(--status-error-bg);
  color: var(--status-error);
  border: 1px solid var(--status-error-border);
  cursor: pointer;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out),
              border-color var(--motion-duration-fast) var(--motion-ease-out),
              color var(--motion-duration-fast) var(--motion-ease-out);
}

.reconnect-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--status-error) 22%, transparent);
  border-color: var(--status-error);
}

.reconnect-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-icon {
  font-size: 14px;
}

.pending-sas-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: var(--status-warning-bg);
  border: 1px solid var(--status-warning-border);
  color: var(--status-warning);
  font-size: 11px;
  font-weight: 600;
  padding: 3px 8px;
  border-radius: 6px;
  cursor: pointer;
  animation: pulsePending 2s infinite ease-in-out;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out),
              border-color var(--motion-duration-fast) var(--motion-ease-out),
              color var(--motion-duration-fast) var(--motion-ease-out);
}

.pending-sas-btn:hover {
  background: color-mix(in srgb, var(--status-warning) 24%, transparent);
  border-color: var(--status-warning);
  color: var(--g-50);
}

.pending-icon {
  font-size: 13px;
  color: var(--status-warning);
}

@keyframes pulsePending {
  0%, 100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--status-warning) 40%, transparent);
  }
  50% {
    box-shadow: 0 0 0 5px transparent;
  }
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  100% { transform: rotate(360deg); }
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.transport-badge {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: help;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out),
              border-color var(--motion-duration-fast) var(--motion-ease-out);
  user-select: none;
}

.transport-icon {
  font-size: 14px;
}

.transport-rtt {
  font-size: 11px;
  padding: 1px 4px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--g-950) 45%, transparent);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

/* IPv6 Direct: vibrant cyan/teal badge */
.transport-badge.ipv6_p2p {
  background: var(--status-info-bg);
  color: var(--status-info);
  border: 1px solid var(--status-info-border);
}

/* LAN: vibrant blue badge */
.transport-badge.lan_p2p {
  background: var(--blue-900);
  color: var(--blue-400);
  border: 1px solid var(--blue-700);
}

/* NAT hole-punch: green badge */
.transport-badge.nat_p2p {
  background: var(--status-success-bg);
  color: var(--status-success);
  border: 1px solid var(--status-success-border);
}

/* TURN Relay: amber badge */
.transport-badge.relay {
  background: var(--status-warning-bg);
  color: var(--status-warning);
  border: 1px solid var(--status-warning-border);
}

/* ECDH Virtual Tunnel (TLS, 0 TURN quota): teal badge */
.transport-badge.relay.virtual-tunnel {
  background: color-mix(in srgb, var(--status-info-bg) 70%, var(--status-success-bg));
  color: color-mix(in srgb, var(--status-info) 65%, var(--status-success));
  border: 1px solid color-mix(in srgb, var(--status-info-border) 65%, var(--status-success-border));
}

/* Security Fingerprint (SAS) Badge */
.fingerprint-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  background: var(--status-success-bg);
  color: var(--s-300);
  border: 1px solid var(--status-success-border);
  cursor: help;
  user-select: all;
  letter-spacing: 0.5px;
}

.fingerprint-icon {
  font-size: 13px;
}
</style>

