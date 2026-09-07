<script setup lang="ts">
import { computed } from 'vue'
import { useConnectionStore } from '@/stores/connection'
import { useI18n } from 'vue-i18n'
import SasVerificationModal from './SasVerificationModal.vue'

const conn = useConnectionStore()
const { t } = useI18n()

async function handleReconnect() {
  await conn.reconnectNow()
}

const transportIcon = computed(() => {
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
  const key = info.type === 'ipv6_p2p' ? 'transport_tooltip_ipv6'
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

    <!-- Active Transport Badge (IPv6 / LAN / NAT / Relay) -->
    <div
      v-if="conn.isConnected && conn.transportInfo && conn.transportInfo.type !== 'unknown'"
      class="transport-badge"
      :class="conn.transportInfo.type"
      :title="transportTooltip"
    >
      <span class="material-icons transport-icon">{{ transportIcon }}</span>
      <span class="transport-text">{{ transportLabel }}</span>
      <span v-if="conn.transportInfo.rttMs !== null" class="transport-rtt">
        {{ conn.transportInfo.rttMs }}ms
      </span>
    </div>

    <!-- SAS Security Fingerprint Badge -->
    <div
      v-if="conn.isConnected && conn.transportInfo?.securityFingerprint"
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
      :title="t('connection.ice_stalled_tooltip', '链路连接检测中，正在自动尝试重试或备用通道...')"
    >
      <span class="material-icons stall-icon spinning">sync</span>
      <span class="stall-text">{{ t('connection.ice_stalled', '线路探测中...') }}</span>
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

    <!-- SAS Verification Modal -->
    <SasVerificationModal />
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
  background: rgba(245, 158, 11, 0.18);
  border: 1px solid rgba(245, 158, 11, 0.4);
  color: #fbbf24;
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
  transition: all 0.3s ease;
}

.status-icon {
  font-size: 16px;
}

.connection-status.connected {
  background: var(--card);
  color: var(--status-success);
  box-shadow: 0 0 10px rgba(34, 197, 94, 0.4);
  border: 1px solid rgba(34, 197, 94, 0.3);
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
  color: #f97316;
  border: 1px solid rgba(249, 115, 22, 0.4);
  box-shadow: 0 0 8px rgba(249, 115, 22, 0.3);
}

.connection-status.degraded {
  background: var(--card);
  color: var(--status-warning);
  border: 1px solid var(--status-warning);
}

.connection-status.unstable {
  background: var(--card);
  color: var(--status-warning);
  box-shadow: 0 0 8px rgba(234, 179, 8, 0.4);
}
.connection-status.unstable .status-icon {
  animation: pulse 1s infinite;
}

.connection-status.waiting {
  background: var(--card);
  color: var(--primary);
  box-shadow: var(--glow-primary);
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
  background: rgba(249, 115, 22, 0.15);
  color: #f97316;
  border: 1px solid rgba(249, 115, 22, 0.35);
  cursor: pointer;
  transition: all 0.2s ease;
}

.reconnect-btn:hover:not(:disabled) {
  background: rgba(249, 115, 22, 0.25);
  border-color: #f97316;
}

.reconnect-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-icon {
  font-size: 14px;
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
  transition: all 0.2s ease;
  user-select: none;
}

.transport-icon {
  font-size: 14px;
}

.transport-rtt {
  font-size: 11px;
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.2);
  font-family: monospace;
}

/* IPv6 Direct: vibrant cyan/teal badge */
.transport-badge.ipv6_p2p {
  background: rgba(6, 182, 212, 0.15);
  color: #06b6d4;
  border: 1px solid rgba(6, 182, 212, 0.35);
  box-shadow: 0 0 8px rgba(6, 182, 212, 0.2);
}

/* LAN: vibrant blue badge */
.transport-badge.lan_p2p {
  background: rgba(59, 130, 246, 0.15);
  color: #3b82f6;
  border: 1px solid rgba(59, 130, 246, 0.35);
}

/* NAT hole-punch: green badge */
.transport-badge.nat_p2p {
  background: rgba(34, 197, 94, 0.15);
  color: #22c55e;
  border: 1px solid rgba(34, 197, 94, 0.35);
}

/* TURN Relay: amber badge */
.transport-badge.relay {
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
  border: 1px solid rgba(245, 158, 11, 0.35);
}

/* Security Fingerprint (SAS) Badge */
.fingerprint-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-weight: 600;
  background: rgba(16, 185, 129, 0.12);
  color: #10b981;
  border: 1px solid rgba(16, 185, 129, 0.3);
  cursor: help;
  user-select: all;
  letter-spacing: 0.5px;
}

.fingerprint-icon {
  font-size: 13px;
}
</style>

