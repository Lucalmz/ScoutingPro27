<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import QRCode from 'qrcode'
import { useToastStore } from '@/stores/toast'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  modelValue: boolean
  inviteCode: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()

const toastStore = useToastStore()
const { t } = useI18n()

const loading = ref(false)
const networkInfo = ref<{ primaryIp: string; allIps: string[]; port: number } | null>(null)
const selectedIp = ref('')
const qrCanvasRef = ref<HTMLCanvasElement | null>(null)
const copied = ref(false)

const joinUrl = computed(() => {
  const ip = selectedIp.value || networkInfo.value?.primaryIp || '127.0.0.1'
  const port = networkInfo.value?.port || (typeof window !== 'undefined' ? window.location.port || '8080' : '8080')
  return `http://${ip}:${port}/#/?join=${props.inviteCode}`
})

async function fetchNetworkInfo() {
  loading.value = true
  try {
    const res = await fetch('/api/system/network-info')
    if (res.ok) {
      const data = await res.json()
      networkInfo.value = data
      selectedIp.value = data.primaryIp || (data.allIps && data.allIps[0]) || '127.0.0.1'
    }
  } catch (e) {
    console.warn('[MobileQrModal] Failed to fetch network info:', e)
  } finally {
    loading.value = false
    await nextTick()
    renderQrCode()
  }
}

async function renderQrCode() {
  if (!qrCanvasRef.value || !joinUrl.value) return
  try {
    await QRCode.toCanvas(qrCanvasRef.value, joinUrl.value, {
      width: 200,
      margin: 2,
      color: {
        dark: '#111827',
        light: '#ffffff'
      }
    })
  } catch (err) {
    console.error('[MobileQrModal] QR render failed:', err)
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      fetchNetworkInfo()
    }
  }
)

watch(selectedIp, async () => {
  await nextTick()
  renderQrCode()
})

async function copyUrl() {
  try {
    await navigator.clipboard.writeText(joinUrl.value)
    copied.value = true
    toastStore.showToast(t('qr_modal.copied'), 'success')
    setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch (e) {
    toastStore.showError(t('qr_modal.copy_failed'))
  }
}

function close() {
  emit('update:modelValue', false)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="modelValue" class="qr-modal-backdrop" @click.self="close">
      <div class="qr-modal-dialog">
        <!-- 头部 -->
        <div class="qr-modal-header">
          <div class="title-with-icon">
            <span class="material-icons header-icon">phone_android</span>
            <h3>{{ t('qr_modal.title') }}</h3>
          </div>
          <button class="close-btn" @click="close" :aria-label="t('common.close', 'Close')">
            <span class="material-icons">close</span>
          </button>
        </div>

        <!-- 主体 -->
        <div class="qr-modal-body">
          <p class="subtitle">
            {{ t('qr_modal.subtitle') }}
          </p>

          <!-- 邀请码高亮框 -->
          <div class="code-badge-bar">
            <span class="code-label">{{ t('qr_modal.invite_code_label') }}</span>
            <span class="code-value">{{ inviteCode }}</span>
          </div>

          <!-- 二维码展示区 -->
          <div class="qr-canvas-container">
            <div v-if="loading" class="qr-loading-placeholder">
              <span class="material-icons spinning">refresh</span>
              <span>{{ t('qr_modal.detecting_ip') }}</span>
            </div>
            <canvas ref="qrCanvasRef" :style="{ display: loading ? 'none' : 'block' }"></canvas>
          </div>

          <!-- 多网卡 IP 切换下拉框与刷新 -->
          <div class="nic-selector-row">
            <label for="nic-select">{{ t('qr_modal.select_ip') }}</label>
            <div class="nic-controls">
              <select id="nic-select" v-model="selectedIp">
                <option v-for="ip in (networkInfo?.allIps || [selectedIp])" :key="ip" :value="ip">
                  {{ ip }} {{ ip === networkInfo?.primaryIp ? t('qr_modal.recommended') : '' }}
                </option>
              </select>
              <button class="btn-refresh" :disabled="loading" @click="fetchNetworkInfo" :title="t('qr_modal.refresh_network')">
                <span class="material-icons" :class="{ spinning: loading }">refresh</span>
                <span>{{ loading ? t('qr_modal.refreshing') : t('qr_modal.refresh_network') }}</span>
              </button>
            </div>
          </div>

          <!-- 链接一键复制 -->
          <div class="url-copy-box">
            <input readonly :value="joinUrl" class="url-input" />
            <button class="btn-copy" @click="copyUrl">
              <span class="material-icons">{{ copied ? 'check' : 'content_copy' }}</span>
              {{ copied ? t('qr_modal.copied') : t('qr_modal.copy_url') }}
            </button>
          </div>

          <!-- 现场排障小贴士 -->
          <div class="troubleshoot-tips">
            <span class="material-icons tip-icon">lightbulb</span>
            <div class="tip-content">
              <strong>{{ t('qr_modal.troubleshoot_title') }}</strong>{{ t('qr_modal.troubleshoot_desc') }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.qr-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.qr-modal-dialog {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 16px;
  width: 100%;
  max-width: 440px;
  box-shadow: 0 25px 50px rgba(0, 0, 0, 0.5);
  overflow: hidden;
  animation: modal-scale-in 0.34s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes modal-scale-in {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.qr-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}

.title-with-icon {
  display: flex;
  align-items: center;
  gap: 8px;
}

.header-icon {
  color: var(--primary);
  font-size: 22px;
}

.qr-modal-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--foreground);
}

.close-btn {
  background: transparent;
  border: none;
  color: var(--muted-foreground);
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
  border-radius: 6px;
}

.close-btn:hover {
  background: var(--muted);
  color: var(--foreground);
}

.qr-modal-body {
  padding: 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.subtitle {
  margin: 0 0 16px;
  font-size: 13px;
  color: var(--muted-foreground);
  line-height: 1.5;
}

.code-badge-bar {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  background: rgba(59, 130, 246, 0.1);
  border: 1px dashed var(--primary);
  border-radius: 8px;
  padding: 6px 14px;
  margin-bottom: 16px;
}

.code-label {
  font-size: 12px;
  color: var(--muted-foreground);
}

.code-value {
  font-size: 16px;
  font-weight: 700;
  color: var(--primary);
  letter-spacing: 1px;
}

.qr-canvas-container {
  background: #ffffff;
  padding: 12px;
  border-radius: 12px;
  border: 1px solid var(--border);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 224px;
  min-height: 224px;
}

.qr-loading-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: #6b7280;
  font-size: 12px;
}

.nic-selector-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
  font-size: 12px;
  color: var(--muted-foreground);
  width: 100%;
  text-align: left;
}

.nic-controls {
  display: flex;
  gap: 8px;
  width: 100%;
}

.nic-controls select {
  flex: 1;
  background: var(--background);
  color: var(--foreground);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 12px;
}

.btn-refresh {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--card);
  color: var(--foreground);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.2s;
}

.btn-refresh:hover:not(:disabled) {
  background: var(--accent);
}

.btn-refresh:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-refresh .material-icons {
  font-size: 15px;
}

.url-copy-box {
  display: flex;
  gap: 8px;
  width: 100%;
  margin-bottom: 14px;
}

.url-input {
  flex: 1;
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--muted-foreground);
  font-family: monospace;
}

.btn-copy {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--primary);
  color: #ffffff;
  border: none;
  border-radius: 8px;
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: opacity 0.2s;
}

.btn-copy:hover {
  opacity: 0.9;
}

.troubleshoot-tips {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 11px;
  color: var(--muted-foreground);
  text-align: left;
  line-height: 1.5;
}

.tip-icon {
  color: #f59e0b;
  font-size: 16px;
  flex-shrink: 0;
  margin-top: 1px;
}
</style>
