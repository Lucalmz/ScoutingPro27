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
  background: color-mix(in srgb, var(--g-950) 84%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  padding: 1.5rem;
}

.modal-card {
  position: relative;
  background: var(--popover);
  border: 1px solid var(--border-strong);
  border-radius: 18px;
  max-width: 480px;
  width: 100%;
  padding: 1.75rem;
  box-shadow: var(--shadow-3);
  color: var(--foreground);
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
  border-bottom: 1px solid var(--border);
}

.header-icon {
  width: 42px;
  height: 42px;
  border-radius: 10px;
  background: var(--status-success-bg);
  border: 1px solid var(--status-success-border);
  color: var(--primary);
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
  font-family: var(--font-sans);
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--foreground);
  margin: 0 0 0.35rem 0;
  letter-spacing: -0.01em;
}

.countdown-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.75rem;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--foreground);
  background: var(--surface-recessed);
  border: 1px solid var(--border);
  padding: 2px 8px;
  border-radius: 999px;
}

.pulse-dot {
  width: 6px;
  height: 6px;
  background: var(--status-error);
  border-radius: 50%;
  animation: pulse 1s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.8); }
}

.modal-desc {
  font-size: 0.92rem;
  color: var(--muted-foreground);
  background: var(--surface-recessed);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  padding: 0.85rem 1rem;
  line-height: 1.55;
  margin-bottom: 1.25rem;
}

.warning-box {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  background: var(--status-warning-bg);
  border: 1px solid var(--status-warning-border);
  border-radius: 8px;
  padding: 0.75rem 1rem;
  margin-bottom: 1.5rem;
  color: var(--status-warning);
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
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out), border-color var(--motion-duration-fast) var(--motion-ease-out), color var(--motion-duration-fast) var(--motion-ease-out), transform var(--motion-duration-fast) var(--motion-ease-out);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.btn-secondary,
.btn-deny {
  background: var(--surface-elevated);
  border: 1px solid var(--border-strong);
  color: var(--foreground);
}

.btn-secondary:hover,
.btn-deny:hover {
  background: var(--surface-hover);
  border-color: var(--g-500);
}

.btn-primary,
.btn-permit {
  background: var(--primary);
  color: var(--on-primary);
  border-color: var(--primary);
}

.btn-primary:hover,
.btn-permit:hover {
  background: var(--s-300);
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
