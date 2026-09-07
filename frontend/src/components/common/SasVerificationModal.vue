<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue'
import { useConnectionStore } from '@/stores/connection'
import { useI18n } from 'vue-i18n'

const conn = useConnectionStore()
const { t } = useI18n()

const remainingSeconds = ref(60)
let timer: any = null

const pending = computed(() => conn.pendingSas)

watch(pending, (newVal) => {
  if (newVal) {
    remainingSeconds.value = 60
    if (timer) clearInterval(timer)
    timer = setInterval(() => {
      if (remainingSeconds.value > 0) {
        remainingSeconds.value--
      } else {
        clearInterval(timer)
        timer = null
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
  if (timer) clearInterval(timer)
})

function handleConfirm() {
  conn.confirmSas()
}

function handleReject() {
  conn.rejectSas(undefined, 'User manually rejected SAS security code')
}
</script>

<template>
  <Transition name="modal">
    <div v-if="pending" class="sas-modal-overlay">
      <div class="sas-modal-card">
      <div class="sas-modal-header">
        <span class="material-icons header-icon">verified_user</span>
        <h3>{{ t('connection.sas_modal_title', '端到端通信安全核验 (SAS)') }}</h3>
      </div>

      <div class="sas-modal-body">
        <div class="sas-warning-box">
          <span class="material-icons warning-icon">shield</span>
          <p>
            {{ t('connection.sas_modal_desc', '为防范公网中间人攻击与会话劫持，在核验完成前，所有业务数据与侦察记录传输已强制挂起拦截。') }}
          </p>
        </div>

        <div class="sas-peer-info">
          <span class="peer-label">{{ t('connection.sas_peer_label', '对端用户') }}:</span>
          <span class="peer-value">{{ pending.username }} ({{ pending.peerId }})</span>
        </div>

        <div class="sas-code-container">
          <div class="sas-code-label">{{ t('connection.sas_code_prompt', '请当面或通过语音核对以下 6 位安全码是否完全一致') }}</div>
          <div class="sas-code-display">{{ pending.fingerprint }}</div>
          <div class="sas-countdown">
            {{ t('connection.sas_countdown', '超时自动断开') }}: <strong>{{ remainingSeconds }}s</strong>
          </div>
        </div>
      </div>

      <div class="sas-modal-footer">
        <button class="btn btn-danger" @click="handleReject">
          <span class="material-icons">close</span>
          {{ t('connection.sas_btn_reject', '不一致（立即断开）') }}
        </button>
        <button class="btn btn-success" @click="handleConfirm">
          <span class="material-icons">check</span>
          {{ t('connection.sas_btn_confirm', '确认一致') }}
        </button>
      </div>
    </div>
    </div>
  </Transition>
</template>

<style scoped>
.sas-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.75);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}

.sas-modal-card {
  background: var(--card, #0a0a0a);
  color: var(--foreground, #f1f5f9);
  border-radius: 12px;
  border: 1px solid var(--border, #262626);
  box-shadow: 0 20px 30px rgba(0, 0, 0, 0.8), 0 0 24px rgba(57, 255, 20, 0.08);
  width: 100%;
  max-width: 480px;
  overflow: hidden;
}

.sas-modal-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 1.25rem;
  background: var(--input, #111111);
  border-bottom: 1px solid var(--border, #262626);
}

.sas-modal-header h3 {
  margin: 0;
  font-family: 'Orbitron', 'ZCOOLQingKeHuangYou', sans-serif;
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--foreground, #f1f5f9);
}

.header-icon {
  color: var(--primary, #39ff14);
  font-size: 1.5rem;
}

.sas-modal-body {
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.sas-warning-box {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  background: rgba(245, 158, 11, 0.12);
  border: 1px solid rgba(245, 158, 11, 0.3);
  padding: 0.75rem 1rem;
  border-radius: 8px;
}

.sas-warning-box p {
  margin: 0;
  font-size: 0.85rem;
  line-height: 1.4;
  color: #fbbf24;
}

.warning-icon {
  color: #f59e0b;
  font-size: 1.25rem;
  flex-shrink: 0;
  margin-top: 0.1rem;
}

.sas-peer-info {
  font-size: 0.9rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.peer-label {
  color: var(--text-muted, #a3a3a3);
}

.peer-value {
  font-weight: 600;
  color: #f1f5f9;
}

.sas-code-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: var(--background, #000000);
  border: 1px solid var(--border, #262626);
  padding: 1.25rem;
  border-radius: 10px;
  gap: 0.5rem;
}

.sas-code-label {
  font-size: 0.8rem;
  color: var(--text-muted, #a3a3a3);
  text-align: center;
}

.sas-code-display {
  font-family: 'Orbitron', Consolas, Monaco, monospace;
  font-size: 2.2rem;
  font-weight: 700;
  letter-spacing: 0.4rem;
  color: var(--primary, #39ff14);
  text-shadow: var(--glow-primary);
  padding: 0.5rem 1rem;
  background: rgba(57, 255, 20, 0.08);
  border-radius: 8px;
  border: 1px dashed rgba(57, 255, 20, 0.4);
}

.sas-countdown {
  font-size: 0.8rem;
  color: var(--text-muted, #a3a3a3);
}

.sas-countdown strong {
  color: var(--destructive, #ef4444);
}

.sas-modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  padding: 1rem 1.25rem;
  background: var(--input, #111111);
  border-top: 1px solid var(--border, #262626);
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.55rem 1rem;
  font-size: 0.9rem;
  font-weight: 600;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-danger {
  background: var(--destructive, #ef4444);
  color: white;
}

.btn-danger:hover {
  background: #dc2626;
}

.btn-success {
  background: var(--primary, #39ff14);
  color: var(--primary-foreground, #000000);
  box-shadow: var(--glow-primary);
}

.btn-success:hover {
  filter: brightness(1.1);
  box-shadow: var(--glow-primary-hover);
}
</style>
