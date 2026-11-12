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
  background: rgba(8, 8, 7, 0.84);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  padding: 1.5rem;
}

.modal-card {
  position: relative;
  background: var(--card, #141413);
  border: 1px solid var(--border, #262624);
  border-top: 3px solid var(--primary, #39ff14);
  border-radius: 14px;
  max-width: 480px;
  width: 100%;
  padding: 1.75rem;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.85), 0 0 28px rgba(57, 255, 20, 0.08);
  color: var(--foreground, #f0efe9);
  max-height: 90vh;
  overflow-y: auto;
  box-sizing: border-box;
}

.modal-header {
  display: flex;
  align-items: flex-start;
  gap: 0.85rem;
  margin-bottom: 1rem;
  padding-bottom: 0.85rem;
  border-bottom: 1px solid #262624;
}

.header-icon {
  width: 42px;
  height: 42px;
  border-radius: 10px;
  background: #080807;
  border: 1px solid rgba(57, 255, 20, 0.4);
  color: var(--primary, #39ff14);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  flex-shrink: 0;
}

.header-text {
  flex: 1;
}

.modal-title {
  font-family: 'Orbitron', 'ZCOOLQingKeHuangYou', sans-serif;
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--foreground, #f0efe9);
  margin: 0 0 0.35rem 0;
  letter-spacing: 0.03em;
}

.countdown-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.75rem;
  font-family: 'JetBrains Mono', monospace;
  color: #f0efe9;
  background: #080807;
  border: 1px solid #262624;
  padding: 2px 8px;
  border-radius: 999px;
}

.pulse-dot {
  width: 6px;
  height: 6px;
  background: var(--destructive, #ef4444);
  border-radius: 50%;
  box-shadow: 0 0 8px rgba(239, 68, 68, 0.7);
  animation: pulse 1s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.8); }
}

.modal-desc {
  font-size: 0.92rem;
  color: var(--muted-foreground, #9e9d95);
  background: #080807;
  border: 1px solid #222220;
  border-radius: 10px;
  padding: 0.85rem 1rem;
  line-height: 1.55;
  margin-bottom: 1.25rem;
}

.warning-box {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  background: #19140c;
  border: 1px solid rgba(245, 158, 11, 0.35);
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

.modal-actions,
.button-row {
  display: flex;
  gap: 0.75rem;
  margin-top: 1.25rem;
}

.btn {
  flex: 1;
  min-height: 42px;
  padding: 0.65rem 1rem;
  border-radius: 8px;
  font-size: 0.9rem;
  font-weight: 700;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.16s ease;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.btn-secondary,
.btn-deny {
  background: #1c1c1a;
  border: 1px solid #353532;
  color: var(--foreground, #f0efe9);
}

.btn-secondary:hover,
.btn-deny:hover {
  background: #262624;
  border-color: #4a4a46;
}

.btn-primary,
.btn-permit {
  background: var(--primary, #39ff14);
  color: #080807;
  border-color: var(--primary, #39ff14);
  box-shadow: 0 0 16px rgba(57, 255, 20, 0.25);
}

.btn-primary:hover,
.btn-permit:hover {
  filter: brightness(1.08);
  box-shadow: 0 0 22px rgba(57, 255, 20, 0.4);
}

.icon {
  font-family: 'Material Icons', sans-serif;
}

@media (max-width: 480px) {
  .modal-overlay {
    padding: 0.75rem;
  }
  .modal-card {
    padding: 1.25rem 1rem;
    max-height: 94vh;
  }
  .modal-actions,
  .button-row {
    flex-direction: column;
    gap: 0.5rem;
  }
  .btn {
    width: 100%;
  }
}
</style>
