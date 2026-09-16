<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConnectionStore } from '@/stores/connection'
import { useToastStore } from '@/stores/toast'
import { hapticLight, hapticMedium } from '@/utils/haptics'

const props = defineProps<{
  eventName?: string
  inviteCode?: string
  isHost?: boolean
}>()

const emit = defineEmits<{
  (e: 'takeoverHost'): void
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

function toggleHud() {
  hapticLight()
  showHud.value = !showHud.value
}

function handleTakeover() {
  hapticMedium()
  showHud.value = false
  emit('takeoverHost')
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
      <span v-if="connStore.isStandbyHost" class="pill-standby-badge">Standby</span>
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
            <div class="hud-item">
              <span class="hud-label">{{ t('event.role') }}</span>
              <span class="hud-value">{{ isHost ? t('event.host') : t('event.client') }}</span>
            </div>

            <!-- Standby Takeover Prompt in HUD -->
            <div v-if="connStore.isStandbyHost" class="hud-standby-card">
              <div class="hud-standby-info">
                <span class="material-icons" style="font-size: 18px; color: #f59e0b;">sensors</span>
                <span>{{ t('event.standby_banner_desc') }}</span>
              </div>
              <button type="button" class="btn-hud-takeover" @click="handleTakeover">
                <span class="material-icons" style="font-size: 16px; margin-right: 4px;">offline_bolt</span>
                {{ t('event.takeover_as_host') }}
              </button>
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

.pill-standby-badge {
  font-size: 9px;
  padding: 1px 5px;
  background: rgba(245, 158, 11, 0.2);
  border: 1px solid rgba(245, 158, 11, 0.4);
  color: #f59e0b;
  border-radius: 4px;
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

.hud-code {
  font-family: monospace;
  background: rgba(255, 255, 255, 0.06);
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #39ff14;
}

.hud-standby-card {
  margin-top: 6px;
  padding: 10px;
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.hud-standby-info {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #f59e0b;
}

.btn-hud-takeover {
  background: #f59e0b;
  color: #000000;
  border: none;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
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
