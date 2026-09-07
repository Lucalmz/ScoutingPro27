<script setup lang="ts">
import { ref, watch, computed, onUnmounted } from 'vue'
import { useConnectionStore } from '@/stores/connection'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const connStore = useConnectionStore()

const promptData = computed(() => connStore.takeoverPrompt)
const remainingSeconds = ref(15)
let timer: any = null

watch(promptData, (data) => {
  if (data) {
    remainingSeconds.value = data.timeoutSeconds || 15
    if (timer) clearInterval(timer)
    timer = setInterval(() => {
      remainingSeconds.value--
      if (remainingSeconds.value <= 0) {
        clearInterval(timer)
        timer = null
        connStore.clearTakeoverPrompt()
      }
    }, 1000)
  } else {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }
}, { immediate: true })

onUnmounted(() => {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
})

function handleDecision(permit: boolean) {
  if (promptData.value) {
    connStore.respondTakeoverDecision(promptData.value.requesterUsername, permit)
  }
}
</script>

<template>
  <Transition name="modal">
    <div v-if="promptData" class="modal-overlay">
      <div class="modal-card">
        <div class="modal-header">
          <div class="header-icon">
            <span class="icon">devices</span>
          </div>
          <div class="header-text">
            <h3 class="modal-title">{{ t('takeover.title') }}</h3>
            <div class="countdown-badge">
              <span class="pulse-dot"></span>
              <span>{{ t('takeover.timeout_desc', { seconds: remainingSeconds }) }}</span>
            </div>
          </div>
        </div>

        <p class="modal-desc">
          {{ t('takeover.description', { name: promptData.requesterUsername }) }}
        </p>

        <div class="modal-actions">
          <button class="btn btn-secondary" @click="handleDecision(false)">
            {{ t('takeover.btn_reject') }}
          </button>
          <button class="btn btn-primary" @click="handleDecision(true)">
            {{ t('takeover.btn_permit') }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.75);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  padding: 1.5rem;
}

.modal-card {
  background: var(--card, #0a0a0a);
  border: 1px solid var(--border, #262626);
  border-radius: 12px;
  max-width: 480px;
  width: 100%;
  padding: 1.75rem;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.8), 0 0 24px rgba(57, 255, 20, 0.08);
  color: var(--foreground, #f1f5f9);
}

.modal-header {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.header-icon {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  background: rgba(57, 255, 20, 0.12);
  border: 1px solid rgba(57, 255, 20, 0.35);
  color: var(--primary, #39ff14);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
}

.header-text {
  flex: 1;
}

.modal-title {
  font-family: 'Orbitron', 'ZCOOLQingKeHuangYou', sans-serif;
  font-size: 1.2rem;
  font-weight: 700;
  color: var(--foreground, #f1f5f9);
  margin: 0 0 0.25rem 0;
}

.countdown-badge {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.75rem;
  color: var(--text-muted, #a3a3a3);
}

.pulse-dot {
  width: 6px;
  height: 6px;
  background: var(--destructive, #ef4444);
  border-radius: 50%;
  animation: pulse 1s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.8); }
}

.modal-desc {
  font-size: 0.95rem;
  color: var(--muted-foreground, #a3a3a3);
  line-height: 1.5;
  margin-bottom: 1rem;
}

.warning-box {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: 8px;
  padding: 0.75rem 1rem;
  margin-bottom: 1.5rem;
  color: #fbbf24;
}

.warning-box .icon {
  font-size: 18px;
  margin-top: 2px;
}

.warning-box p {
  margin: 0;
  font-size: 0.825rem;
  line-height: 1.45;
}

.button-row {
  display: flex;
  gap: 0.75rem;
}

.btn {
  flex: 1;
  padding: 0.65rem 1rem;
  border-radius: 6px;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  border: none;
  transition: all 0.2s;
}

.btn-deny {
  background: var(--muted, #1a1a1a);
  border: 1px solid var(--border, #262626);
  color: var(--foreground, #f1f5f9);
}

.btn-deny:hover {
  background: var(--surface-hover, #141414);
}

.btn-permit {
  background: var(--primary, #39ff14);
  color: var(--primary-foreground, #000000);
  box-shadow: var(--glow-primary);
}

.btn-permit:hover {
  filter: brightness(1.1);
  box-shadow: var(--glow-primary-hover);
}

.icon {
  font-family: 'Material Icons', sans-serif;
}
</style>
