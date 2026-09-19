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

const statusColor = computed(() => {
  if (connStore.isCongested) return '#f59e0b'
  switch (connStore.status) {
    case 'connected':
      return '#39ff14'
    case 'connecting':
      return '#facc15'
    case 'offline':
    case 'long_offline':
    default:
      return '#ef4444'
  }
})

const statusLabel = computed(() => {
  if (connStore.isCongested) return t('connection.congested') || 'Congested'
  switch (connStore.status) {
    case 'connected':
      return t('connection.connected') || 'Connected'
    case 'connecting':
      return t('connection.connecting') || 'Connecting'
    case 'offline':
    case 'long_offline':
    default:
      return t('connection.offline') || 'Offline'
  }
})

const transportIcon = computed(() => {
  if (!connStore.isConnected) {
    return connStore.status === 'connecting' ? 'sync' : 'link_off'
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
      <span class="status-indicator-dot" :style="{ backgroundColor: statusColor }"></span>
      <span class="pill-title">{{ inviteCode || 'SP27' }}</span>
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
              <span class="status-indicator-dot" :style="{ backgroundColor: statusColor }"></span>
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
              <span class="hud-value" :style="{ color: statusColor }">{{ statusLabel }} (WebRTC P2P)</span>
            </div>
            <div class="hud-item hud-transport-item">
              <span class="hud-label">{{ t('connection.transport_type', '连接类型') }}</span>
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
  height: 28px;
  padding: 0 12px 0 10px;
  background: rgba(18, 22, 34, 0.85);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 9999px;
  color: var(--foreground, #ffffff);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
  transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  user-select: none;
  -webkit-user-select: none;
}

.status-pill:active,
.status-pill.is-active {
  transform: scale(0.96);
  border-color: rgba(57, 255, 20, 0.45);
  box-shadow: 0 0 12px rgba(57, 255, 20, 0.3);
}

.status-indicator-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  box-shadow: 0 0 6px currentColor;
  animation: pill-pulse 2.4s ease-in-out infinite;
}

@keyframes pill-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.65; transform: scale(0.9); }
}

.pill-title {
  font-family: var(--font-mono, monospace);
  letter-spacing: 0.5px;
}

.pill-arrow {
  font-size: 14px;
  color: var(--text-muted, #9ca3af);
  transition: transform 0.25s ease;
  margin-left: -2px;
}

.pill-arrow.is-open {
  transform: rotate(180deg);
}

/* HUD Modal / Dropdown */
.hud-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  z-index: 1000;
}

.hud-popover {
  position: fixed;
  top: max(48px, calc(env(safe-area-inset-top, 8px) + 38px));
  left: 50%;
  transform: translateX(-50%);
  width: min(340px, 92vw);
  background: #161b22;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 16px;
  padding: 16px 18px;
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.5), 0 0 20px rgba(57, 255, 20, 0.12);
  z-index: 1001;
  color: var(--foreground, #ffffff);
}

.hud-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
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
  color: #9ca3af;
  cursor: pointer;
  padding: 4px;
  display: flex;
  border-radius: 6px;
}

.btn-close-hud:hover {
  color: #ffffff;
  background: rgba(255, 255, 255, 0.1);
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
  color: #8b949e;
}

.hud-value {
  font-weight: 500;
}

.hud-transport {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.hud-transport-icon {
  font-size: 16px;
  color: var(--primary, #39ff14);
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
  color: #8b949e;
  font-family: var(--font-mono, monospace);
  margin-left: 2px;
}

.hud-code {
  font-family: monospace;
  background: rgba(255, 255, 255, 0.06);
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #39ff14;
}

/* Transitions */
.hud-fade-enter-active,
.hud-fade-leave-active {
  transition: opacity 0.2s ease;
}
.hud-fade-enter-from,
.hud-fade-leave-to {
  opacity: 0;
}

.hud-pop-enter-active {
  transition: transform 0.24s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.24s ease;
}
.hud-pop-leave-active {
  transition: transform 0.18s ease-in, opacity 0.18s ease;
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
