<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConnectionStore } from '@/stores/connection'
import { useToastStore } from '@/stores/toast'
import { hapticLight, hapticMedium } from '@/utils/haptics'

const props = defineProps<{
  eventName?: string
  inviteCode?: string
}>()

const { t } = useI18n()
const connStore = useConnectionStore()
const toastStore = useToastStore()

const showHud = ref(false)

const statusStateClass = computed<'is-connected' | 'is-warning' | 'is-error'>(() => {
  if (connStore.isCongested) return 'is-warning'
  switch (connStore.status) {
    case 'connected':
      return 'is-connected'
    case 'connecting':
    case 'waiting':
    case 'unstable':
    case 'degraded':
      return 'is-warning'
    case 'offline':
    case 'long_offline':
    default:
      return 'is-error'
  }
})

const statusLabel = computed(() => {
  if (connStore.isCongested) return t('connection.congested') || 'Congested'
  switch (connStore.status) {
    case 'connected':
      return t('connection.connected') || 'Connected'
    case 'connecting':
    case 'waiting':
    case 'unstable':
    case 'degraded':
      return t('connection.connecting') || 'Connecting'
    case 'offline':
    case 'long_offline':
    default:
      return t('connection.offline') || 'Offline'
  }
})

const isVirtualTunnel = computed(() => {
  const info = connStore.transportInfo
  if (!info || info.type !== 'relay') return false
  return Boolean(
    info.isVirtualTunnel ||
    info.protocol === 'wss/tls' ||
    info.localCandidateType === 'virtual' ||
    info.label === 'ECDH Tunnel (TLS)'
  )
})

const transportIcon = computed(() => {
  if (!connStore.isConnected) {
    return connStore.status === 'connecting' ? 'sync' : 'link_off'
  }
  if (isVirtualTunnel.value) {
    return 'lock'
  }
  const type = connStore.transportInfo?.type
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

const transportDisplayLabel = computed(() => {
  if (!connStore.isConnected) {
    if (connStore.status === 'connecting') {
      return t('connection.connecting') || '连接中...'
    }
    return t('connection.offline') || '已离线'
  }
  if (isVirtualTunnel.value) {
    return t('connection.transport_virtual_tunnel')
  }
  const type = connStore.transportInfo?.type
  if (!type || type === 'unknown') {
    return t('connection.transport_unknown') || 'P2P 通信'
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

function toggleHud() {
  hapticLight()
  showHud.value = !showHud.value
}
</script>

<template>
  <div class="mobile-status-pill-wrap">
    <!-- Floating Minimal Pill (Height 28px) -->
    <button
      type="button"
      class="status-pill"
      :class="{ 'is-active': showHud }"
      @click="toggleHud"
      :title="statusLabel"
    >
      <span class="status-indicator-dot" :class="statusStateClass"></span>
      <span class="pill-title">{{ inviteCode || 'SP27' }}</span>
      <span
        v-if="connStore.isConnected && connStore.transportInfo && connStore.transportInfo.type !== 'unknown'"
        class="pill-transport-badge"
        :class="[connStore.transportInfo.type, { 'virtual-tunnel': isVirtualTunnel }]"
      >
        <span class="material-icons pill-transport-icon">{{ transportIcon }}</span>
        <span class="pill-transport-text">{{ transportDisplayLabel }}</span>
        <span
          v-if="connStore.transportInfo.rttMs !== null && connStore.transportInfo.rttMs !== undefined"
          class="pill-transport-rtt"
        >
          {{ connStore.transportInfo.rttMs }}ms
        </span>
      </span>
      <span class="material-icons pill-arrow" :class="{ 'is-open': showHud }">expand_more</span>
    </button>

    <!-- Quick HUD Popover Dialog -->
    <Teleport to="body">
      <Transition name="hud-fade">
        <div v-if="showHud" class="hud-backdrop" @click="showHud = false" />
      </Transition>

      <Transition name="hud-pop">
        <div v-if="showHud" class="hud-popover" role="dialog" aria-modal="true">
          <div class="hud-header">
            <div class="hud-header-left">
              <span class="status-indicator-dot" :class="statusStateClass"></span>
              <span class="hud-title">{{ eventName || 'ScoutingPro 27' }}</span>
            </div>
            <button type="button" class="btn-close-hud" @click="showHud = false">
              <span class="material-icons" style="font-size: 18px;">close</span>
            </button>
          </div>

          <div class="hud-body">
            <div class="hud-item">
              <span class="hud-label">{{ t('event.code') }}</span>
              <span class="hud-value hud-code">{{ inviteCode }}</span>
            </div>
            <div class="hud-item">
              <span class="hud-label">{{ t('connection.status') }}</span>
              <span class="hud-value hud-status-value" :class="statusStateClass">{{ statusLabel }} (WebRTC P2P)</span>
            </div>
            <div class="hud-item hud-transport-item">
              <span class="hud-label">{{ t('connection.transport_type') }}</span>
              <span class="hud-value hud-transport">
                <span class="material-icons hud-transport-icon" :class="{ spinning: connStore.status === 'connecting' }">{{ transportIcon }}</span>
                <span class="hud-transport-label">{{ transportDisplayLabel }}</span>
                <span v-if="connStore.isConnected && connStore.transportInfo?.rttMs !== null && connStore.transportInfo?.rttMs !== undefined" class="hud-rtt">
                  ({{ connStore.transportInfo.rttMs }}ms)
                </span>
              </span>
            </div>
            <div class="hud-item">
              <span class="hud-label">{{ t('event.role') }}</span>
              <span class="hud-value">{{ t('event.client') }}</span>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.mobile-status-pill-wrap {
  position: fixed;
  top: max(8px, env(safe-area-inset-top, 8px));
  left: 50%;
  transform: translateX(-50%);
  z-index: 99;
  pointer-events: auto;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  max-width: calc(100vw - 24px);
  padding: 2px 10px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 9999px;
  color: var(--foreground);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: var(--shadow-2);
  transition: transform var(--motion-duration-moderate) var(--motion-ease-out), border-color var(--motion-duration-moderate) var(--motion-ease-out), background-color var(--motion-duration-moderate) var(--motion-ease-out);
  user-select: none;
  -webkit-user-select: none;
}

.pill-transport-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border-radius: 9999px;
  font-size: 10px;
  font-weight: 600;
  line-height: 1.3;
  white-space: nowrap;
}

.pill-transport-icon {
  font-size: 12px;
}

.pill-transport-rtt {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 10px;
  opacity: 0.9;
}

.pill-transport-badge.ipv6_p2p {
  background: var(--status-info-bg);
  color: var(--status-info);
  border: 1px solid var(--status-info-border);
}

.pill-transport-badge.lan_p2p {
  background: var(--blue-900);
  color: var(--blue-400);
  border: 1px solid var(--blue-700);
}

.pill-transport-badge.nat_p2p {
  background: var(--status-success-bg);
  color: var(--status-success);
  border: 1px solid var(--status-success-border);
}

.pill-transport-badge.relay {
  background: var(--status-warning-bg);
  color: var(--status-warning);
  border: 1px solid var(--status-warning-border);
}

.pill-transport-badge.relay.virtual-tunnel {
  background: color-mix(in srgb, var(--status-info-bg) 70%, var(--status-success-bg));
  color: color-mix(in srgb, var(--status-info) 65%, var(--status-success));
  border: 1px solid color-mix(in srgb, var(--status-info-border) 65%, var(--status-success-border));
}

.status-pill:active,
.status-pill.is-active {
  transform: scale(0.96);
  border-color: color-mix(in srgb, var(--primary) 45%, transparent);
}

.status-indicator-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  animation: pill-pulse 2.4s ease-in-out infinite;
}

.status-indicator-dot.is-connected {
  background-color: var(--status-success);
  box-shadow: var(--glow-online);
}

.status-indicator-dot.is-warning {
  background-color: var(--status-warning);
  box-shadow: none;
}

.status-indicator-dot.is-error {
  background-color: var(--status-error);
  box-shadow: none;
}

@keyframes pill-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.65; transform: scale(0.9); }
}

.pill-title {
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.5px;
}

.pill-arrow {
  font-size: 14px;
  color: var(--text-muted);
  transition: transform var(--motion-duration-moderate) var(--motion-ease-out);
  margin-left: -2px;
}

.pill-arrow.is-open {
  transform: rotate(180deg);
}

/* HUD Modal / Dropdown */
.hud-backdrop {
  position: fixed;
  inset: 0;
  background: color-mix(in srgb, var(--g-950) 72%, transparent);
  z-index: 1000;
}

.hud-popover {
  position: fixed;
  top: max(48px, calc(env(safe-area-inset-top, 8px) + 38px));
  left: 50%;
  transform: translateX(-50%);
  width: min(340px, 92vw);
  background: var(--popover);
  border: 1px solid var(--border-strong);
  border-radius: 14px;
  padding: 16px 18px;
  box-shadow: var(--shadow-3);
  z-index: 1001;
  color: var(--foreground);
}

.hud-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}

.hud-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.hud-title {
  font-weight: 700;
  font-size: 14px;
}

.btn-close-hud {
  background: transparent;
  border: none;
  color: var(--muted-foreground);
  cursor: pointer;
  padding: 4px;
  display: flex;
  border-radius: 6px;
}

.btn-close-hud:hover {
  color: var(--foreground);
  background: var(--surface-hover);
}

.hud-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 12px;
  font-size: 13px;
}

.hud-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.hud-label {
  color: var(--muted-foreground);
}

.hud-value {
  font-weight: 500;
}

.hud-status-value.is-connected {
  color: var(--status-success);
}

.hud-status-value.is-warning {
  color: var(--status-warning);
}

.hud-status-value.is-error {
  color: var(--status-error);
}

.hud-transport {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.hud-transport-icon {
  font-size: 16px;
  color: var(--primary);
}

.hud-transport-icon.spinning {
  animation: hud-spin 1.5s linear infinite;
}

@keyframes hud-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.hud-rtt {
  font-size: 11px;
  color: var(--muted-foreground);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  margin-left: 2px;
}

.hud-code {
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
  background: var(--surface-recessed);
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid var(--border);
  color: var(--primary);
}

/* Transitions */
.hud-fade-enter-active,
.hud-fade-leave-active {
  transition: opacity var(--motion-duration-fast) var(--motion-ease-out);
}
.hud-fade-enter-from,
.hud-fade-leave-to {
  opacity: 0;
}

.hud-pop-enter-active {
  transition: transform var(--motion-duration-moderate) var(--motion-ease-out), opacity var(--motion-duration-moderate) var(--motion-ease-out);
}
.hud-pop-leave-active {
  transition: transform var(--motion-duration-fast) var(--motion-ease-in), opacity var(--motion-duration-fast) var(--motion-ease-in);
}
.hud-pop-enter-from {
  opacity: 0;
  transform: translate(-50%, -10px) scale(0.95);
}
.hud-pop-leave-to {
  opacity: 0;
  transform: translate(-50%, -8px) scale(0.95);
}
</style>
