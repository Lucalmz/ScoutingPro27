<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useConnectionStore } from '@/stores/connection'
import { useEventStore } from '@/stores/events'
import { useI18n } from 'vue-i18n'

const router = useRouter()
const conn = useConnectionStore()
const eventStore = useEventStore()
const { t } = useI18n()

const isHost = computed(() => Boolean(eventStore.isHost || (conn.rtcService as any)?.isHostMode?.()))
const remainingSeconds = ref(60)
const isTimedOut = ref(false)
const isRetrying = ref(false)
let timer: any = null

const pending = computed(() => conn.pendingSas)
const queueCount = computed(() => conn.pendingSasQueue.length)
const isOpen = computed(() => conn.isSasModalOpen && Boolean(conn.pendingSas))

function startTimer() {
  if (timer) clearInterval(timer)
  timer = setInterval(() => {
    if (remainingSeconds.value > 0) {
      remainingSeconds.value--
    } else {
      clearInterval(timer)
      timer = null
      isTimedOut.value = true
    }
  }, 1000)
}

watch(pending, (newVal) => {
  if (newVal) {
    remainingSeconds.value = 60
    isTimedOut.value = false
    startTimer()
  } else {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    isTimedOut.value = false
  }
}, { immediate: true })

onUnmounted(() => {
  if (timer) clearInterval(timer)
})

function handleConfirm() {
  conn.confirmSas(pending.value?.peerId)
}

function handleReject() {
  conn.rejectSas(pending.value?.peerId, 'User manually rejected SAS security code')
}

async function handleRetry() {
  isRetrying.value = true
  try {
    remainingSeconds.value = 60
    isTimedOut.value = false
    startTimer()
    await conn.retrySas(pending.value?.peerId)
  } finally {
    isRetrying.value = false
  }
}

function handleDismiss() {
  conn.closeSasModal()
}

function handleLeaveEvent() {
  conn.rejectSas(pending.value?.peerId, 'User chose to leave event during SAS verification')
  conn.disconnect()
  router.push('/')
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="isOpen && pending"
        class="sas-modal-overlay"
        @click.self="handleDismiss"
        @keydown.esc="handleDismiss"
        tabindex="-1"
      >
        <div class="sas-modal-card">
          <div class="sas-modal-header">
            <span class="material-icons header-icon">verified_user</span>
            <div class="header-title-box">
              <h3>
                {{ isHost ? t('connection.sas_modal_host_title', '节点接入安全核验 (SAS)') : t('connection.sas_modal_title', '端到端通信安全核验 (SAS)') }}
              </h3>
              <span v-if="queueCount > 1" class="queue-badge">
                {{ t('connection.sas_queue_hint', { current: 1, total: queueCount }) }}
              </span>
            </div>
            <button class="btn-close-sas" @click="handleDismiss" :title="t('common.close', '关闭')">
              <span class="material-icons">close</span>
            </button>
          </div>

          <div class="sas-modal-body">
            <div class="sas-warning-box">
              <span class="material-icons warning-icon">shield</span>
              <p>
                {{ isHost ? t('connection.sas_modal_host_desc', '检测到新设备请求接入赛事。为防范公网中间人攻击，核验完成前已拦截该节点数据传输。') : t('connection.sas_modal_desc', '为防范公网中间人攻击与会话劫持，在核验完成前，所有业务数据与侦察记录传输已强制挂起拦截。') }}
              </p>
            </div>

            <div class="sas-peer-info">
              <span class="peer-label">
                {{ isHost ? t('connection.sas_peer_host_label', '接入设备用户') : t('connection.sas_peer_label', '对端用户') }}:
              </span>
              <span class="peer-value">{{ pending.username }} ({{ pending.peerId }})</span>
            </div>

            <div class="sas-code-container">
              <div class="sas-code-label">
                {{ t('connection.sas_code_prompt') }}
              </div>
              <div class="sas-code-display">{{ pending.fingerprint }}</div>

              <div v-if="isTimedOut" class="sas-timeout-banner">
                <span class="material-icons timeout-banner-icon">hourglass_empty</span>
                <div class="timeout-banner-content">
                  <div class="timeout-banner-title">
                    {{ t('connection.sas_timed_out_title') }}
                  </div>
                  <div class="timeout-banner-desc">
                    {{ isHost ? t('connection.sas_timed_out_host_desc') : t('connection.sas_timed_out_client_desc') }}
                  </div>
                </div>
              </div>
              <div v-else class="sas-countdown">
                {{ t('connection.sas_countdown') }}: <strong>{{ remainingSeconds }}s</strong>
              </div>
            </div>
          </div>

          <div class="sas-modal-footer">
            <template v-if="isHost">
              <button class="btn btn-secondary" @click="handleDismiss">
                <span class="material-icons">close</span>
                {{ t('common.dismiss', '忽略') }}
              </button>
              <button v-if="isTimedOut" class="btn btn-warning" :disabled="isRetrying" @click="handleRetry">
                <span class="material-icons">refresh</span>
                {{ t('connection.sas_btn_retry', '重新发起核验') }}
              </button>
              <button class="btn btn-danger" @click="handleReject">
                <span class="material-icons">block</span>
                {{ t('connection.sas_btn_reject_device', '拒绝接入') }}
              </button>
              <button class="btn btn-success" @click="handleConfirm">
                <span class="material-icons">check</span>
                {{ t('connection.sas_btn_confirm_device', '确认一致（允许接入）') }}
              </button>
            </template>
            <template v-else>
              <button class="btn btn-secondary" @click="handleLeaveEvent">
                <span class="material-icons">exit_to_app</span>
                {{ t('connection.sas_btn_leave', '离开赛事') }}
              </button>
              <button v-if="isTimedOut" class="btn btn-warning" :disabled="isRetrying" @click="handleRetry">
                <span class="material-icons">refresh</span>
                {{ t('connection.sas_btn_retry', '重新发起核验') }}
              </button>
              <button class="btn btn-danger" @click="handleReject">
                <span class="material-icons">link_off</span>
                {{ t('connection.sas_btn_reject', '不一致（立即断开）') }}
              </button>
              <button class="btn btn-success" @click="handleConfirm">
                <span class="material-icons">check</span>
                {{ t('connection.sas_btn_confirm', '确认一致') }}
              </button>
            </template>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
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
  z-index: 100000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  overflow-y: auto;
}

.sas-modal-card {
  background: var(--card, #0a0a0a);
  color: var(--foreground, #f1f5f9);
  border-radius: 12px;
  border: 1px solid var(--border, #262626);
  box-shadow: 0 20px 30px rgba(0, 0, 0, 0.8), 0 0 24px rgba(57, 255, 20, 0.08);
  width: 100%;
  max-width: 480px;
  overflow-y: auto;
  max-height: 90vh;
  box-sizing: border-box;
}

.sas-modal-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 1.25rem;
  background: var(--input, #111111);
  border-bottom: 1px solid var(--border, #262626);
}

.btn-close-sas {
  margin-left: auto;
  background: transparent;
  border: none;
  color: var(--text-muted, #8b949e);
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.btn-close-sas:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
}

.header-title-box {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.queue-badge {
  font-size: 0.75rem;
  font-weight: 600;
  background: rgba(57, 255, 20, 0.12);
  border: 1px solid rgba(57, 255, 20, 0.3);
  color: var(--primary, #39ff14);
  padding: 2px 8px;
  border-radius: 9999px;
  letter-spacing: 0.02em;
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
  flex-wrap: wrap;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  padding: 0.55rem 1rem;
  font-size: 0.9rem;
  font-weight: 600;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-secondary {
  background: rgba(255, 255, 255, 0.1);
  color: #c9d1d9;
  border: 1px solid rgba(255, 255, 255, 0.15);
}

.btn-secondary:hover {
  background: rgba(255, 255, 255, 0.18);
  color: #ffffff;
}

.btn-danger {
  background: var(--destructive, #ef4444);
  color: white;
}

.btn-danger:hover {
  background: #dc2626;
}

.btn-warning {
  background: #f59e0b;
  color: #000000;
  font-weight: 700;
}

.btn-warning:hover:not(:disabled) {
  background: #d97706;
  color: #ffffff;
}

.btn-warning:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.sas-timeout-banner {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  background: rgba(245, 158, 11, 0.12);
  border: 1px solid rgba(245, 158, 11, 0.35);
  border-radius: 8px;
  padding: 0.65rem 0.85rem;
  margin-top: 0.35rem;
  text-align: left;
  width: 100%;
  box-sizing: border-box;
}

.timeout-banner-icon {
  color: #f59e0b;
  font-size: 1.3rem;
  flex-shrink: 0;
  margin-top: 0.1rem;
}

.timeout-banner-content {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.timeout-banner-title {
  font-size: 0.85rem;
  font-weight: 700;
  color: #fbbf24;
}

.timeout-banner-desc {
  font-size: 0.78rem;
  line-height: 1.4;
  color: #cbd5e1;
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

@media (max-width: 480px) {
  .sas-modal-overlay {
    padding: 0.75rem;
  }
  .sas-modal-card {
    max-height: 94vh;
  }
  .sas-modal-footer {
    flex-direction: column-reverse;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
  }
  .sas-modal-footer .btn {
    width: 100%;
  }
  .sas-code-display {
    font-size: 1.75rem;
    letter-spacing: 0.25rem;
    padding: 0.4rem 0.75rem;
  }
}
</style>
