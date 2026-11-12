<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useInboxStore } from '@/stores/inbox'
import { useConnectionStore } from '@/stores/connection'
import { useToastStore } from '@/stores/toast'

const props = defineProps<{
  visible: boolean
  targetScoutId: string
  targetScoutName?: string
  isOnline?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'sent', payload: { targetId: string; body: string }): void
}>()

const { t } = useI18n()
const inboxStore = useInboxStore()
const connStore = useConnectionStore()
const toastStore = useToastStore()

const messageBody = ref('')
const isSending = ref(false)
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const modalOverlayRef = ref<HTMLDivElement | null>(null)

watch(
  () => props.visible,
  (val) => {
    if (val) {
      messageBody.value = ''
      nextTick(() => textareaRef.value?.focus())
    }
  },
  { immediate: true }
)

function handleClose() {
  if (isSending.value) return
  emit('update:visible', false)
}

function handleOverlayClick(event: MouseEvent) {
  if (event.target === modalOverlayRef.value) {
    handleClose()
  }
}

function onGlobalKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.visible) {
    handleClose()
  }
}

onMounted(() => {
  if (typeof window !== 'undefined') window.addEventListener('keydown', onGlobalKeyDown)
})

onUnmounted(() => {
  if (typeof window !== 'undefined') window.removeEventListener('keydown', onGlobalKeyDown)
})

async function handleSend() {
  const content = messageBody.value.trim()
  if (!content) {
    toastStore.showToast(t('event.msg_empty_warning') || '请输入私信内容', 'warning')
    return
  }

  isSending.value = true
  try {
    const hasRtc = !!connStore.rtcService
    await inboxStore.sendDirectMessage(
      {
        targetId: props.targetScoutId,
        targetName: props.targetScoutName,
        title: 'Message from Host',
        body: content
      },
      connStore.rtcService || undefined
    )

    if (hasRtc) {
      toastStore.showToast(t('event.msg_sent_success') || '私信已成功发送', 'success')
    } else {
      toastStore.showToast(t('event.msg_queued_toast') || '未连接至通信中继，私信已存入离线发件箱', 'info')
    }

    messageBody.value = ''
    emit('update:visible', false)
    emit('sent', { targetId: props.targetScoutId, body: content })
  } catch (err: any) {
    console.error('[SendMessageModal] Failed to send direct message:', err)
    toastStore.showToast(err.message || '发送失败', 'error')
  } finally {
    isSending.value = false
  }
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="msg-modal-fade">
      <div
        v-if="visible"
        ref="modalOverlayRef"
        class="send-msg-overlay"
        @click="handleOverlayClick"
        role="dialog"
        aria-modal="true"
        aria-labelledby="send-msg-modal-title"
      >
        <div class="send-msg-card" role="document">
          <div class="send-msg-header">
            <div class="header-left">
              <div class="header-icon">
                <span class="material-icons">mail</span>
              </div>
              <div class="header-titles">
                <h3 id="send-msg-modal-title" class="send-msg-title">
                  {{ t('event.msg_modal_title') || '发送私信' }}
                </h3>
                <div class="recipient-pill">
                  <span class="recipient-label">{{ t('event.msg_recipient_label') || '收件人' }}:</span>
                  <span class="recipient-name">{{ targetScoutName || targetScoutId }}</span>
                  <span
                    class="status-indicator-dot"
                    :class="isOnline ? 'dot-online' : 'dot-offline'"
                    :title="isOnline ? (t('event.status_online') || '在线') : (t('event.status_offline') || '离线')"
                  />
                </div>
              </div>
            </div>
            <button
              type="button"
              class="btn-close"
              :disabled="isSending"
              @click="handleClose"
              aria-label="Close"
            >
              <span class="material-icons">close</span>
            </button>
          </div>

          <div v-if="!connStore.rtcService" class="send-msg-notice">
            <span class="material-icons notice-icon">wifi_off</span>
            <span class="notice-text">
              {{ t('event.msg_queued_notice') || '实时通讯未建立，消息将存入离线发件箱并在连接后自动送达。' }}
            </span>
          </div>

          <div class="send-msg-body">
            <label for="direct-msg-content" class="body-label">
              {{ t('event.msg_content_label') || '私信内容' }}
            </label>
            <div class="textarea-container">
              <textarea
                id="direct-msg-content"
                ref="textareaRef"
                v-model="messageBody"
                class="msg-textarea"
                :placeholder="t('event.msg_input_placeholder') || '请输入私信内容...（按 Enter 发送，Shift + Enter 换行）'"
                maxlength="500"
                :disabled="isSending"
                rows="4"
                @keydown="handleKeyDown"
              ></textarea>
              <div class="textarea-footer">
                <span class="tip-shortcut">{{ t('event.msg_shortcut_tip') || 'Enter 发送，Shift+Enter 换行' }}</span>
                <span class="char-count" :class="{ 'char-near-limit': messageBody.length >= 450 }">
                  {{ messageBody.length }} / 500
                </span>
              </div>
            </div>
          </div>

          <div class="send-msg-actions">
            <button
              type="button"
              class="btn btn-secondary"
              :disabled="isSending"
              @click="handleClose"
            >
              {{ t('common.cancel') || '取消' }}
            </button>
            <button
              type="button"
              class="btn btn-primary btn-send-action"
              :disabled="isSending || !messageBody.trim()"
              @click="handleSend"
            >
              <span v-if="isSending" class="material-icons spinning" style="font-size: 16px;">sync</span>
              <span v-else class="material-icons" style="font-size: 16px;">send</span>
              <span>{{ isSending ? (t('event.msg_sending') || '发送中...') : (t('event.msg_send_btn') || '发送') }}</span>
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.send-msg-overlay {
  position: fixed;
  inset: 0;
  background: rgba(8, 8, 7, 0.86);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  padding: 16px;
}
.send-msg-card {
  background: var(--card, #141413);
  border: 1px solid var(--border, #262624);
  border-top: 2px solid var(--primary, #39ff14);
  border-radius: 14px;
  max-width: 480px;
  width: 100%;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.8), 0 0 30px rgba(57, 255, 20, 0.05);
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  box-sizing: border-box;
}
.send-msg-header, .header-left { display: flex; align-items: center; gap: 12px; }
.send-msg-header { justify-content: space-between; align-items: flex-start; }
.header-icon {
  width: 40px; height: 40px; border-radius: 10px;
  background: rgba(57, 255, 20, 0.1); border: 1px solid rgba(57, 255, 20, 0.25);
  display: flex; align-items: center; justify-content: center; color: var(--primary, #39ff14); flex-shrink: 0;
}
.header-titles { display: flex; flex-direction: column; gap: 4px; }
.send-msg-title { margin: 0; font-size: 17px; font-weight: 700; color: var(--foreground, #f3f3f3); }
.recipient-pill {
  display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px;
  background: rgba(255, 255, 255, 0.05); border: 1px solid var(--border, #262624); border-radius: 6px; font-size: 12px;
}
.recipient-label { color: var(--muted, #8e8e8e); }
.recipient-name { color: var(--foreground, #f3f3f3); font-weight: 600; }
.status-indicator-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.dot-online { background: #39ff14; box-shadow: 0 0 6px #39ff14; }
.dot-offline { background: #666; }
.btn-close {
  background: transparent; border: none; color: var(--muted, #8e8e8e); cursor: pointer; padding: 6px; border-radius: 6px;
}
.btn-close:hover:not(:disabled) { color: #fff; background: rgba(255, 255, 255, 0.08); }
.send-msg-notice {
  display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 8px;
  background: rgba(255, 170, 0, 0.1); border: 1px solid rgba(255, 170, 0, 0.3); color: #ffaa00; font-size: 12px;
}
.send-msg-body, .textarea-container { display: flex; flex-direction: column; gap: 6px; }
.body-label { font-size: 13px; font-weight: 600; color: var(--foreground, #e6e6e6); }
.msg-textarea {
  width: 100%; box-sizing: border-box; background: var(--background, #080807);
  border: 1px solid var(--border, #262624); border-radius: 8px; color: var(--foreground, #e6e6e6);
  padding: 12px; font-size: 14px; font-family: inherit; resize: vertical; min-height: 100px; max-height: 220px; outline: none;
}
.msg-textarea:focus { border-color: var(--primary, #39ff14); box-shadow: 0 0 0 2px rgba(57, 255, 20, 0.15); }
.msg-textarea:disabled { opacity: 0.6; cursor: not-allowed; }
.textarea-footer { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: var(--muted, #8e8e8e); }
.char-near-limit { color: #ffaa00; font-weight: 600; }
.send-msg-actions { display: flex; align-items: center; justify-content: flex-end; gap: 12px; }
.btn {
  display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer;
}
.btn-secondary { background: transparent; border: 1px solid var(--border, #262624); color: var(--foreground, #e6e6e6); }
.btn-send-action { background: var(--primary, #39ff14); border: 1px solid var(--primary, #39ff14); color: #000; font-weight: 700; }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.spinning { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.msg-modal-fade-enter-active, .msg-modal-fade-leave-active { transition: opacity 0.2s ease; }
.msg-modal-fade-enter-from, .msg-modal-fade-leave-to { opacity: 0; }
.msg-modal-fade-enter-active .send-msg-card, .msg-modal-fade-leave-active .send-msg-card { transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease; }
.msg-modal-fade-enter-from .send-msg-card, .msg-modal-fade-leave-to .send-msg-card { opacity: 0; transform: scale(0.96) translateY(6px); }
</style>
