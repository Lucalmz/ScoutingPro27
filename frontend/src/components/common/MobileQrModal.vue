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
              <span>{{ t('qr_modal.channel_cloud') }}</span>
            </button>
            <button
              type="button"
              class="channel-pill-item"
              :class="{ active: qrChannelMode === 'lan' }"
              @click="qrChannelMode = 'lan'"
            >
              <span class="material-icons pill-icon">wifi_tethering</span>
              <span>{{ t('qr_modal.channel_lan') }}</span>
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
              <span>{{ copied ? t('qr_modal.copied') : t('qr_modal.cloud_copy_link') }}</span>
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
                <span>{{ isEditingCloudUrl ? t('common.cancel') : t('qr_modal.cloud_url_config_btn') }}</span>
              </button>
            </div>
            <div v-if="isEditingCloudUrl" class="cloud-url-editor">
              <input
                v-model="cloudUrlInput"
                type="text"
                class="cloud-url-input"
                :placeholder="t('qr_modal.cloud_url_placeholder')"
              />
              <button type="button" class="btn-save-cloud-url" @click="saveCloudUrl">
                <span class="material-icons">check</span>
                <span>{{ t('common.save') }}</span>
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
  background: color-mix(in srgb, var(--g-950) 86%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  overflow-y: auto;
  box-sizing: border-box;
}

.qr-modal-dialog {
  background: var(--popover);
  border: 1px solid var(--border-strong);
  border-radius: 18px;
  width: 100%;
  max-width: 440px;
  box-shadow: var(--shadow-3);
  display: flex;
  flex-direction: column;
  color: var(--foreground);
  font-family: inherit;
  overflow: hidden;
  animation: modalPop var(--motion-duration-moderate) var(--motion-ease-out);
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
  border-bottom: 1px solid var(--border);
  background: var(--surface-recessed);
}

.title-with-icon {
  display: flex;
  align-items: center;
  gap: 8px;
}

.header-icon {
  font-size: 22px;
  color: var(--primary);
}

.qr-modal-header h3 {
  margin: 0;
  font-family: var(--font-sans);
  font-size: 17px;
  font-weight: 700;
  color: var(--foreground);
  letter-spacing: -0.01em;
}

.close-btn {
  background: transparent;
  border: none;
  color: var(--muted-foreground);
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out), color var(--motion-duration-fast) var(--motion-ease-out);
}

.close-btn:hover {
  background: var(--surface-hover);
  color: var(--foreground);
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
  color: var(--muted-foreground);
  text-align: center;
}

.channel-pill-bar {
  display: flex;
  background: var(--surface-recessed);
  border: 1px solid var(--border);
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
  color: var(--muted-foreground);
  cursor: pointer;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out), border-color var(--motion-duration-fast) var(--motion-ease-out), color var(--motion-duration-fast) var(--motion-ease-out);
}

.channel-pill-item:hover {
  color: var(--foreground);
  background: var(--surface-hover);
}

.channel-pill-item.active {
  background: var(--status-success-bg);
  color: var(--primary);
  border-color: var(--status-success-border);
}

.pill-icon {
  font-size: 16px;
}

/* 邀请码高亮大磁贴 */
.code-badge-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: linear-gradient(135deg, rgba(var(--primary-rgb), 0.1), color-mix(in srgb, var(--g-950) 65%, transparent));
  border: 1px solid var(--status-success-border);
  border-radius: 12px;
  padding: 12px 16px;
  cursor: pointer;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out), border-color var(--motion-duration-fast) var(--motion-ease-out);
}

.code-badge-bar:hover {
  background: linear-gradient(135deg, rgba(var(--primary-rgb), 0.16), color-mix(in srgb, var(--g-950) 75%, transparent));
  border-color: var(--primary);
}

.code-badge-left {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.code-label {
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted-foreground);
}

.code-value {
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
  font-size: 26px;
  font-weight: 900;
  color: var(--primary);
  letter-spacing: 2px;
}

.btn-copy-code-mini {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 10px;
  color: var(--foreground);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out), border-color var(--motion-duration-fast) var(--motion-ease-out), color var(--motion-duration-fast) var(--motion-ease-out);
}

.btn-copy-code-mini:hover {
  background: var(--status-success-bg);
  color: var(--primary);
  border-color: var(--primary);
}

.btn-copy-code-mini.is-copied {
  background: var(--primary);
  color: var(--on-primary);
  border-color: var(--primary);
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
  background: var(--g-50);
  border-radius: 12px;
  padding: 16px;
  box-shadow: var(--shadow-2);
  border: 1px solid var(--border);
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
  color: var(--g-900);
}

/* 链接输入框与复制 */
.url-copy-box {
  display: flex;
  gap: 8px;
  background: var(--input);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 4px 4px 4px 12px;
  align-items: center;
}

.url-input {
  flex: 1;
  background: transparent;
  border: none;
  color: var(--foreground);
  font-family: var(--font-mono);
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
  background: var(--primary);
  color: var(--on-primary);
  border: none;
  border-radius: 7px;
  padding: 8px 14px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out), transform var(--motion-duration-fast) var(--motion-ease-out);
}

.btn-copy:hover {
  background: var(--s-300);
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
  border-top: 1px dashed var(--border);
}

.cloud-url-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.cloud-url-title {
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 600;
  color: var(--muted-foreground);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.btn-edit-cloud-url {
  display: flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: none;
  color: var(--muted-foreground);
  font-size: 11px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out), color var(--motion-duration-fast) var(--motion-ease-out);
}

.btn-edit-cloud-url:hover {
  background: var(--surface-hover);
  color: var(--foreground);
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
  background: var(--input);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 10px;
  color: var(--foreground);
  font-size: 12px;
  outline: none;
  transition: border-color var(--motion-duration-fast) var(--motion-ease-out), box-shadow var(--motion-duration-fast) var(--motion-ease-out);
}

.cloud-url-input:focus {
  border-color: var(--ring);
  box-shadow: var(--focus-ring-sm);
}

.btn-save-cloud-url {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--primary);
  border: none;
  border-radius: 6px;
  padding: 6px 12px;
  color: var(--on-primary);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out), transform var(--motion-duration-fast) var(--motion-ease-out);
}

.btn-save-cloud-url:hover {
  background: var(--s-300);
}

.btn-save-cloud-url .material-icons {
  font-size: 14px;
}

.cloud-url-hint {
  margin: 0;
  font-size: 11px;
  color: var(--muted-foreground);
  line-height: 1.4;
}
</style>
