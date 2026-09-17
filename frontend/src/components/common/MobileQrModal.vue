<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import QRCode from 'qrcode'
import { useToastStore } from '@/stores/toast'
import { useI18n } from 'vue-i18n'
import { hapticLight, hapticSuccess } from '@/utils/haptics'
import { getNetworkInfo } from '@/services/api'

const props = defineProps<{
  modelValue: boolean
  inviteCode: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()

const toastStore = useToastStore()
const { t } = useI18n()

const cloudBaseUrl = ref(
  typeof localStorage !== 'undefined'
    ? localStorage.getItem('sp27-cloud-pwa-url') || 'https://lucalmz.github.io/ScoutingPro27'
    : 'https://lucalmz.github.io/ScoutingPro27'
)
const isEditingCloudUrl = ref(false)
const cloudUrlInput = ref(cloudBaseUrl.value)
const qrChannelMode = ref<'cloud' | 'lan'>('cloud')
const networkInfo = ref<{ primaryIp: string; joinBaseUrl: string } | null>(null)

onMounted(async () => {
  networkInfo.value = await getNetworkInfo()
})

function saveCloudUrl() {
  let val = cloudUrlInput.value.trim()
  if (!val) {
    val = 'https://lucalmz.github.io/ScoutingPro27'
  }
  val = val.replace(/\/+$/, '').replace(/\/#.*$/, '')
  cloudBaseUrl.value = val
  cloudUrlInput.value = val
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('sp27-cloud-pwa-url', val)
  }
  isEditingCloudUrl.value = false
  toastStore.showToast(t('qr_modal.cloud_url_saved'), 'success')
  renderQrCode()
}

const qrCanvasRef = ref<HTMLCanvasElement | null>(null)
const copied = ref(false)
const copiedCode = ref(false)

const joinUrl = computed(() => {
  if (qrChannelMode.value === 'lan' && networkInfo.value?.joinBaseUrl) {
    return `${networkInfo.value.joinBaseUrl}/#/?join=${props.inviteCode}&b=lan`
  }
  const base = cloudBaseUrl.value.replace(/\/+$/, '').replace(/\/#.*$/, '')
  return `${base}/#/?join=${props.inviteCode}&b=emqx`
})

async function renderQrCode() {
  if (!qrCanvasRef.value || !joinUrl.value) return
  try {
    await QRCode.toCanvas(qrCanvasRef.value, joinUrl.value, {
      width: 210,
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
  async (open) => {
    if (open) {
      await nextTick()
      renderQrCode()
    }
  },
  { immediate: true }
)

watch([cloudBaseUrl, qrChannelMode, () => props.inviteCode], async () => {
  await nextTick()
  renderQrCode()
})

async function copyUrl() {
  if (!joinUrl.value) return
  hapticLight()
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

async function copyInviteCode() {
  if (!props.inviteCode) return
  hapticSuccess()
  try {
    await navigator.clipboard.writeText(props.inviteCode)
    copiedCode.value = true
    toastStore.showToast(t('qr_modal.code_copied'), 'success')
    setTimeout(() => {
      copiedCode.value = false
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
      <div class="qr-modal-dialog" role="dialog" aria-modal="true">
        <!-- 头部 -->
        <div class="qr-modal-header">
          <div class="title-with-icon">
            <span class="material-icons header-icon">qr_code_2</span>
            <h3>{{ t('qr_modal.title') }}</h3>
          </div>
          <button class="close-btn" @click="close" :aria-label="t('common.close', 'Close')">
            <span class="material-icons">close</span>
          </button>
        </div>

        <!-- 主体 -->
        <div class="qr-modal-body">
          <p class="subtitle">
            {{ t('qr_modal.subtitle_simple') }}
          </p>

          <!-- 赛场离线热点 / 公网云端 信道一键切换 -->
          <div v-if="networkInfo?.joinBaseUrl" class="channel-pill-bar">
            <button
              type="button"
              class="channel-pill-item"
              :class="{ active: qrChannelMode === 'cloud' }"
              @click="qrChannelMode = 'cloud'"
            >
              <span class="material-icons pill-icon">cloud</span>
              <span>{{ t('qr_modal.channel_cloud', '公网云端') }}</span>
            </button>
            <button
              type="button"
              class="channel-pill-item"
              :class="{ active: qrChannelMode === 'lan' }"
              @click="qrChannelMode = 'lan'"
            >
              <span class="material-icons pill-icon">wifi_tethering</span>
              <span>{{ t('qr_modal.channel_lan', '赛场内网/热点 (纯离线)') }}</span>
            </button>
          </div>

          <!-- 邀请码高亮大磁贴 -->
          <div class="code-badge-bar" @click="copyInviteCode" :title="t('qr_modal.click_copy_code')">
            <div class="code-badge-left">
              <span class="code-label">{{ t('qr_modal.invite_code_label') }}</span>
              <span class="code-value">{{ inviteCode }}</span>
            </div>
            <button type="button" class="btn-copy-code-mini" :class="{ 'is-copied': copiedCode }">
              <span class="material-icons">{{ copiedCode ? 'check' : 'content_copy' }}</span>
              <span>{{ copiedCode ? t('qr_modal.copied') : t('qr_modal.copy_code_btn') }}</span>
            </button>
          </div>

          <!-- 二维码展示卡片 -->
          <div class="qr-canvas-container">
            <canvas ref="qrCanvasRef"></canvas>
            <div class="qr-scan-tip">
              <span class="material-icons" style="font-size: 16px;">photo_camera</span>
              <span>{{ t('qr_modal.scan_hint_simple') }}</span>
            </div>
          </div>

          <!-- 访问链接一键复制 -->
          <div class="url-copy-box">
            <input readonly :value="joinUrl" class="url-input" />
            <button class="btn-copy" @click="copyUrl">
              <span class="material-icons">{{ copied ? 'check' : 'content_copy' }}</span>
              {{ copied ? t('qr_modal.copied') : t('qr_modal.cloud_copy_link') }}
            </button>
          </div>

          <!-- 自定义部署地址（轻量折叠） -->
          <div class="cloud-url-config-row">
            <div class="cloud-url-header">
              <span class="cloud-url-title">{{ t('qr_modal.cloud_url_label') }}</span>
              <button
                type="button"
                class="btn-edit-cloud-url"
                @click="isEditingCloudUrl = !isEditingCloudUrl"
              >
                <span class="material-icons">{{ isEditingCloudUrl ? 'close' : 'settings' }}</span>
                <span>{{ isEditingCloudUrl ? t('common.cancel', '取消') : t('qr_modal.cloud_url_config_btn') }}</span>
              </button>
            </div>
            <div v-if="isEditingCloudUrl" class="cloud-url-editor">
              <input
                v-model="cloudUrlInput"
                type="text"
                class="cloud-url-input"
                placeholder="https://your-team.github.io/ScoutingPro27"
              />
              <button type="button" class="btn-save-cloud-url" @click="saveCloudUrl">
                <span class="material-icons">check</span>
                <span>{{ t('common.save', '保存') }}</span>
              </button>
            </div>
            <p v-if="isEditingCloudUrl" class="cloud-url-hint">
              {{ t('qr_modal.cloud_url_hint') }}
            </p>
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
  background: rgba(0, 0, 0, 0.75);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  overflow-y: auto;
  box-sizing: border-box;
}

.qr-modal-dialog {
  background: #181c24;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 16px;
  width: 100%;
  max-width: 440px;
  box-shadow: 0 20px 48px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05);
  display: flex;
  flex-direction: column;
  color: #e5e7eb;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  overflow: hidden;
  animation: modalPop 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes modalPop {
  from {
    opacity: 0;
    transform: scale(0.94) translateY(8px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

.qr-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.02);
}

.title-with-icon {
  display: flex;
  align-items: center;
  gap: 8px;
}

.header-icon {
  font-size: 22px;
  color: #39ff14;
}

.qr-modal-header h3 {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
  color: #f3f4f6;
  letter-spacing: -0.01em;
}

.close-btn {
  background: transparent;
  border: none;
  color: #9ca3af;
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}

.close-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
}

.qr-modal-body {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.subtitle {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: #9ca3af;
  text-align: center;
}

.channel-pill-bar {
  display: flex;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  padding: 4px;
  gap: 4px;
}

.channel-pill-item {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 10px;
  font-size: 12px;
  font-weight: 500;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: #9ca3af;
  cursor: pointer;
  transition: all 0.2s ease;
}

.channel-pill-item:hover {
  color: #e5e7eb;
}

.channel-pill-item.active {
  background: rgba(59, 130, 246, 0.2);
  color: #60a5fa;
  border-color: rgba(59, 130, 246, 0.35);
}

.pill-icon {
  font-size: 16px;
}

/* 邀请码大磁贴 */
.code-badge-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: linear-gradient(135deg, rgba(57, 255, 20, 0.08), rgba(16, 185, 129, 0.04));
  border: 1px solid rgba(57, 255, 20, 0.25);
  border-radius: 12px;
  padding: 12px 16px;
  cursor: pointer;
  transition: all 0.2s;
}

.code-badge-bar:hover {
  background: linear-gradient(135deg, rgba(57, 255, 20, 0.14), rgba(16, 185, 129, 0.08));
  border-color: rgba(57, 255, 20, 0.45);
}

.code-badge-left {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.code-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #9ca3af;
}

.code-value {
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  font-size: 26px;
  font-weight: 900;
  color: #39ff14;
  letter-spacing: 2px;
}

.btn-copy-code-mini {
  display: flex;
  align-items: center;
  gap: 4px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 8px;
  padding: 6px 10px;
  color: #d1d5db;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.btn-copy-code-mini:hover {
  background: rgba(57, 255, 20, 0.15);
  color: #ffffff;
  border-color: rgba(57, 255, 20, 0.3);
}

.btn-copy-code-mini.is-copied {
  background: #10b981;
  color: #ffffff;
  border-color: #10b981;
}

.btn-copy-code-mini .material-icons {
  font-size: 15px;
}

/* 二维码容器 */
.qr-canvas-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: #ffffff;
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  margin: 0 auto;
}

.qr-canvas-container canvas {
  border-radius: 6px;
  display: block;
}

.qr-scan-tip {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  font-size: 12px;
  font-weight: 600;
  color: #4b5563;
}

/* 链接输入框与复制 */
.url-copy-box {
  display: flex;
  gap: 8px;
  background: #11141a;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  padding: 4px 4px 4px 12px;
  align-items: center;
}

.url-input {
  flex: 1;
  background: transparent;
  border: none;
  color: #93c5fd;
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  font-size: 12px;
  outline: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.btn-copy {
  display: flex;
  align-items: center;
  gap: 4px;
  background: #2563eb;
  border: none;
  border-radius: 7px;
  padding: 8px 14px;
  color: #ffffff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s;
}

.btn-copy:hover {
  background: #1d4ed8;
}

.btn-copy .material-icons {
  font-size: 16px;
}

/* 云端地址配置 */
.cloud-url-config-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 4px;
  border-top: 1px dashed rgba(255, 255, 255, 0.08);
}

.cloud-url-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.cloud-url-title {
  font-size: 11px;
  font-weight: 600;
  color: #6b7280;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.btn-edit-cloud-url {
  display: flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: none;
  color: #9ca3af;
  font-size: 11px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  transition: all 0.15s;
}

.btn-edit-cloud-url:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #e5e7eb;
}

.btn-edit-cloud-url .material-icons {
  font-size: 13px;
}

.cloud-url-editor {
  display: flex;
  gap: 6px;
}

.cloud-url-input {
  flex: 1;
  background: #0f1217;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  padding: 6px 10px;
  color: #f3f4f6;
  font-size: 12px;
  outline: none;
}

.cloud-url-input:focus {
  border-color: #3b82f6;
}

.btn-save-cloud-url {
  display: flex;
  align-items: center;
  gap: 4px;
  background: #10b981;
  border: none;
  border-radius: 6px;
  padding: 6px 12px;
  color: #ffffff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.btn-save-cloud-url:hover {
  background: #059669;
}

.btn-save-cloud-url .material-icons {
  font-size: 14px;
}

.cloud-url-hint {
  margin: 0;
  font-size: 11px;
  color: #6b7280;
  line-height: 1.4;
}
</style>
