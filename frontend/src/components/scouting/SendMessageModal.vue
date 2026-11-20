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
  background: color-mix(in srgb, var(--g-950) 76%, transparent);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  padding: 16px;
}
.send-msg-card {
  background: var(--popover);
  border: 1px solid var(--border-strong);
  border-radius: 18px;
  max-width: 480px;
  width: 100%;
  box-shadow: var(--shadow-3);
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
  background: var(--status-success-bg); border: 1px solid var(--status-success-border);
  display: flex; align-items: center; justify-content: center; color: var(--primary); flex-shrink: 0;
}
.header-titles { display: flex; flex-direction: column; gap: 4px; }
.send-msg-title { margin: 0; font-size: 17px; font-weight: 700; color: var(--foreground); }
.recipient-pill {
  display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px;
  background: var(--surface-hover); border: 1px solid var(--border); border-radius: 6px; font-size: 12px;
}
.recipient-label { color: var(--muted-foreground); }
.recipient-name { color: var(--foreground); font-weight: 600; }
.status-indicator-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.dot-online { background: var(--primary); box-shadow: var(--glow-online); }
.dot-offline { background: var(--g-500); }
.btn-close {
  background: transparent; border: none; color: var(--muted-foreground); cursor: pointer; padding: 6px; border-radius: 6px;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out), color var(--motion-duration-fast) var(--motion-ease-out);
}
.btn-close:hover:not(:disabled) { color: var(--foreground); background: var(--surface-hover); }
.send-msg-notice {
  display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 8px;
  background: var(--status-warning-bg); border: 1px solid var(--status-warning-border); color: var(--status-warning); font-size: 12px;
}
.send-msg-body, .textarea-container { display: flex; flex-direction: column; gap: 6px; }
.body-label { font-size: 13px; font-weight: 600; color: var(--foreground); }
.msg-textarea {
  width: 100%; box-sizing: border-box; background: var(--input);
  border: 1px solid var(--border); border-radius: 8px; color: var(--foreground);
  padding: 12px; font-size: 14px; font-family: inherit; resize: vertical; min-height: 100px; max-height: 220px; outline: none;
  transition: border-color var(--motion-duration-fast) var(--motion-ease-out), box-shadow var(--motion-duration-fast) var(--motion-ease-out);
}
.msg-textarea:focus { border-color: var(--primary); box-shadow: var(--focus-ring-sm); }
.msg-textarea:disabled { opacity: 0.6; cursor: not-allowed; }
.textarea-footer { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: var(--muted-foreground); }
.char-count { font-variant-numeric: tabular-nums; }
.char-near-limit { color: var(--status-warning); font-weight: 600; }
.send-msg-actions { display: flex; align-items: center; justify-content: flex-end; gap: 12px; }
.btn {
  display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out), border-color var(--motion-duration-fast) var(--motion-ease-out), color var(--motion-duration-fast) var(--motion-ease-out);
}
.btn-secondary { background: var(--g-800); border: 1px solid var(--border-strong); color: var(--foreground); }
.btn-secondary:hover:not(:disabled) { background: var(--g-750); border-color: var(--g-500); }
.btn-send-action { background: var(--primary); border: 1px solid var(--primary); color: var(--on-primary); font-weight: 700; }
.btn-send-action:hover:not(:disabled) { background: var(--s-400); border-color: var(--s-400); }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.spinning { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.msg-modal-fade-enter-active, .msg-modal-fade-leave-active { transition: opacity var(--motion-duration-normal) var(--motion-ease-out); }
.msg-modal-fade-enter-from, .msg-modal-fade-leave-to { opacity: 0; }
.msg-modal-fade-enter-active .send-msg-card, .msg-modal-fade-leave-active .send-msg-card { transition: transform var(--motion-duration-normal) var(--motion-ease-out), opacity var(--motion-duration-normal) var(--motion-ease-out); }
.msg-modal-fade-enter-from .send-msg-card, .msg-modal-fade-leave-to .send-msg-card { opacity: 0; transform: scale(0.96) translateY(6px); }
</style>
