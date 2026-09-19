<script setup lang="ts">
import { ref, watch, onUnmounted, nextTick } from 'vue'
import jsQR from 'jsqr'
import { useToastStore } from '@/stores/toast'
import { useI18n } from 'vue-i18n'
import { hapticSuccess, hapticWarning, hapticLight } from '@/utils/haptics'

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'scan', inviteCode: string, rawData?: string): void
}>()

const toastStore = useToastStore()
const { t } = useI18n()

const videoRef = ref<HTMLVideoElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)

const isScanning = ref(false)
const hasCamera = ref(true)
const cameraError = ref<string | null>(null)
const torchSupported = ref(false)
const torchOn = ref(false)

let mediaStream: MediaStream | null = null
let scanAnimId: number | null = null
let videoTrack: MediaStreamTrack | null = null

function extractInviteCode(raw: string): string {
  if (!raw) return ''
  const trimmed = raw.trim()
  
  // 1. Try URL search params (?join=CODE or ?code=CODE)
  try {
    const url = new URL(trimmed, window.location.href)
    const joinParam = url.searchParams.get('join') || url.searchParams.get('code')
    const brokerParam = url.searchParams.get('b') || url.searchParams.get('broker')
    if (brokerParam && typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem('sp27-active-broker', brokerParam)
    }
    if (joinParam) return joinParam.trim().toUpperCase()

    // Also check hash param e.g. #/?join=CODE
    if (url.hash.includes('join=')) {
      const hashQuery = url.hash.split('?')[1]
      if (hashQuery) {
        const hashParams = new URLSearchParams(hashQuery)
        const hashBroker = hashParams.get('b') || hashParams.get('broker')
        if (hashBroker && typeof sessionStorage !== 'undefined') {
          sessionStorage.setItem('sp27-active-broker', hashBroker)
        }
        const code = hashParams.get('join') || hashParams.get('code')
        if (code) return code.trim().toUpperCase()
      }
    }
  } catch {}

  // 2. Direct query regex match: join=XXXXXX or code=XXXXXX
  const match = trimmed.match(/[?&#](?:join|code)=([a-zA-Z0-9_-]{4,10})/i)
  if (match && match[1]) {
    return match[1].toUpperCase()
  }

  // 3. Raw short invite code (e.g. 6 alphanumeric chars like 2A9B8F)
  if (/^[a-zA-Z0-9]{4,10}$/.test(trimmed)) {
    return trimmed.toUpperCase()
  }

  return trimmed
}

async function startCamera() {
  cameraError.value = null
  hasCamera.value = true
  torchSupported.value = false
  torchOn.value = false

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    hasCamera.value = false
    cameraError.value = t('qr_scanner.camera_not_supported')
    return
  }

  try {
    // Request environment facing camera (back camera on mobile)
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    })

    mediaStream = stream
    const [track] = stream.getVideoTracks()
    videoTrack = track || null

    if (track) {
      // Check if torch/flashlight is supported
      try {
        const capabilities = (track as any).getCapabilities?.() || {}
        if (capabilities.torch) {
          torchSupported.value = true
        }
      } catch {}
    }

    await nextTick()
    if (videoRef.value) {
      try {
        videoRef.value.srcObject = stream
      } catch {
        // In happy-dom / jsdom test environments, mock MediaStream might not pass strict type check
      }
      if (typeof videoRef.value.play === 'function') {
        await videoRef.value.play().catch(() => {})
      }
      isScanning.value = true
      startScanLoop()
    }
  } catch (err: any) {
    console.warn('[QrScannerModal] Camera access error:', err)
    hasCamera.value = false
    cameraError.value = t('qr_scanner.camera_denied')
  }
}

function stopCamera() {
  isScanning.value = false
  if (scanAnimId !== null) {
    cancelAnimationFrame(scanAnimId)
    scanAnimId = null
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop())
    mediaStream = null
  }
  videoTrack = null
  torchOn.value = false
}

async function toggleTorch() {
  if (!videoTrack || !torchSupported.value) return
  hapticLight()
  try {
    torchOn.value = !torchOn.value
    await (videoTrack as any).applyConstraints({
      advanced: [{ torch: torchOn.value }]
    })
  } catch (e) {
    console.warn('[QrScannerModal] Failed to toggle torch:', e)
  }
}

function startScanLoop() {
  if (!isScanning.value) return

  const video = videoRef.value
  const canvas = canvasRef.value || document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  if (video && video.readyState >= video.HAVE_CURRENT_DATA && ctx) {
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (vw > 0 && vh > 0) {
      // Keep canvas resolution balanced for fast decoding
      const maxDim = 640
      let cw = vw
      let ch = vh
      if (cw > maxDim || ch > maxDim) {
        if (cw > ch) {
          ch = Math.round((ch * maxDim) / cw)
          cw = maxDim
        } else {
          cw = Math.round((cw * maxDim) / ch)
          cw = maxDim
        }
      }

      canvas.width = cw
      canvas.height = ch
      ctx.drawImage(video, 0, 0, cw, ch)

      try {
        const imgData = ctx.getImageData(0, 0, cw, ch)
        const qr = jsQR(imgData.data, imgData.width, imgData.height, {
          inversionAttempts: 'dontInvert'
        })

        if (qr && qr.data) {
          handleDetectedCode(qr.data)
          return
        }
      } catch (scanErr) {
        console.warn('[QrScannerModal] Decoding error:', scanErr)
      }
    }
  }

  scanAnimId = requestAnimationFrame(startScanLoop)
}

function handleDetectedCode(rawData: string) {
  const code = extractInviteCode(rawData)
  if (code) {
    hapticSuccess()
    toastStore.showToast(t('qr_scanner.scan_success'), 'success')
    stopCamera()
    emit('scan', code, rawData)
    emit('update:modelValue', false)
  } else {
    hapticWarning()
    toastStore.showToast(t('qr_scanner.no_code_found'), 'warning')
  }
}

async function onFileSelected(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return

  try {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.src = url
    await new Promise((resolve, reject) => {
      img.onload = resolve
      img.onerror = reject
    })
    URL.revokeObjectURL(url)

    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Canvas 2D context unavailable')

    ctx.drawImage(img, 0, 0)
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const qr = jsQR(imgData.data, imgData.width, imgData.height)

    if (qr && qr.data) {
      handleDetectedCode(qr.data)
    } else {
      toastStore.showToast(t('qr_scanner.no_qr_found'), 'warning')
    }
  } catch (err: any) {
    console.error('[QrScannerModal] Image scan failed:', err)
    toastStore.showToast(t('qr_scanner.image_read_failed'), 'error')
  } finally {
    if (fileInputRef.value) fileInputRef.value.value = ''
  }
}

function close() {
  stopCamera()
  emit('update:modelValue', false)
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      nextTick(() => {
        startCamera()
      })
    } else {
      stopCamera()
    }
  },
  { immediate: true }
)

onUnmounted(() => {
  stopCamera()
})
</script>

<template>
  <Teleport to="body">
    <div v-if="modelValue" class="scanner-modal-backdrop" @click.self="close">
      <div class="scanner-modal-dialog" role="dialog" aria-modal="true">
        <!-- 头部 -->
        <div class="scanner-header">
          <div class="scanner-title-group">
            <span class="material-icons scanner-header-icon">qr_code_scanner</span>
            <h3>{{ t('qr_scanner.title') }}</h3>
          </div>
          <div class="scanner-header-actions">
            <button
              v-if="torchSupported"
              type="button"
              class="btn-torch"
              :class="{ 'is-active': torchOn }"
              @click="toggleTorch"
              :title="torchOn ? t('qr_scanner.torch_off') : t('qr_scanner.torch_on')"
            >
              <span class="material-icons">{{ torchOn ? 'flashlight_on' : 'flashlight_off' }}</span>
            </button>
            <button type="button" class="close-btn" @click="close" :aria-label="t('common.close')">
              <span class="material-icons">close</span>
            </button>
          </div>
        </div>

        <!-- 取景器主体 -->
        <div class="scanner-body">
          <div v-if="hasCamera" class="viewfinder-container">
            <video ref="videoRef" class="scanner-video" playsinline muted autoplay></video>

            <!-- 扫描框与激光线 -->
            <div class="scanner-overlay-frame">
              <div class="corner-border corner-tl"></div>
              <div class="corner-border corner-tr"></div>
              <div class="corner-border corner-bl"></div>
              <div class="corner-border corner-br"></div>
              <div class="laser-scan-line"></div>
            </div>

            <span class="scanner-instruction-pill">
              {{ t('qr_scanner.hint') }}
            </span>
          </div>

          <!-- 摄像头权限被拒 / 不可用时的备选提示与相册上传 -->
          <div v-else class="camera-denied-box">
            <span class="material-icons error-camera-icon">videocam_off</span>
            <h4>{{ t('qr_scanner.camera_unavailable_title') }}</h4>
            <p>{{ cameraError }}</p>
            <button type="button" class="btn-primary-album" @click="fileInputRef?.click()">
              <span class="material-icons">photo_library</span>
              <span>{{ t('qr_scanner.upload_photo') }}</span>
            </button>
          </div>
        </div>

        <!-- 底部相册图片选择 -->
        <div class="scanner-footer">
          <input
            ref="fileInputRef"
            type="file"
            accept="image/*"
            style="display: none;"
            @change="onFileSelected"
          />
          <button type="button" class="btn-upload-album" @click="fileInputRef?.click()">
            <span class="material-icons">photo_library</span>
            <span>{{ t('qr_scanner.upload_photo') }}</span>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.scanner-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.85);
  backdrop-filter: blur(10px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  box-sizing: border-box;
}

.scanner-modal-dialog {
  background: var(--card, #0a0a0a);
  border: 1px solid var(--border, #262626);
  border-radius: 20px;
  width: 100%;
  max-width: 400px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.9), 0 0 0 1px rgba(255, 255, 255, 0.05);
  animation: scannerPop 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  color: var(--foreground, #f1f5f9);
}

@keyframes scannerPop {
  from {
    opacity: 0;
    transform: scale(0.92) translateY(12px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

.scanner-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  background: rgba(255, 255, 255, 0.02);
  border-bottom: 1px solid var(--border, #262626);
}

.scanner-title-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.scanner-header-icon {
  font-size: 22px;
  color: var(--primary, #39ff14);
  text-shadow: 0 0 8px rgba(57, 255, 20, 0.5);
}

.scanner-header h3 {
  margin: 0;
  font-family: 'Orbitron', 'ZCOOLQingKeHuangYou', sans-serif;
  font-size: 16px;
  font-weight: 700;
  color: var(--foreground, #f1f5f9);
  letter-spacing: 0.04em;
}

.scanner-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn-torch {
  background: var(--muted, #1a1a1a);
  border: 1px solid var(--border, #262626);
  border-radius: 8px;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted-foreground, #a3a3a3);
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-torch.is-active {
  background: var(--status-warning, #fcd34d);
  color: #000000;
  border-color: var(--status-warning, #fcd34d);
  box-shadow: 0 0 10px rgba(252, 211, 77, 0.4);
}

.btn-torch .material-icons {
  font-size: 18px;
}

.close-btn {
  background: transparent;
  border: none;
  color: var(--muted-foreground, #a3a3a3);
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
}

.close-btn:hover {
  background: var(--muted, #1a1a1a);
  color: var(--foreground, #f1f5f9);
}

.scanner-body {
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 1;
  max-height: 380px;
  background: #000000;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}

.viewfinder-container {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.scanner-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* 取景框与角标 */
.scanner-overlay-frame {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 220px;
  height: 220px;
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.65);
  border-radius: 16px;
  pointer-events: none;
}

.corner-border {
  position: absolute;
  width: 20px;
  height: 20px;
  border-color: var(--primary, #39ff14);
  border-style: solid;
}

.corner-tl {
  top: 0;
  left: 0;
  border-width: 3px 0 0 3px;
  border-top-left-radius: 12px;
}

.corner-tr {
  top: 0;
  right: 0;
  border-width: 3px 3px 0 0;
  border-top-right-radius: 12px;
}

.corner-bl {
  bottom: 0;
  left: 0;
  border-width: 0 0 3px 3px;
  border-bottom-left-radius: 12px;
}

.corner-br {
  bottom: 0;
  right: 0;
  border-width: 0 3px 3px 0;
  border-bottom-right-radius: 12px;
}

/* 激光扫描动画 */
.laser-scan-line {
  position: absolute;
  left: 4px;
  right: 4px;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--primary, #39ff14), transparent);
  box-shadow: 0 0 8px var(--primary, #39ff14);
  animation: laserScan 2.4s cubic-bezier(0.4, 0, 0.2, 1) infinite alternate;
}

@keyframes laserScan {
  0% {
    top: 8px;
    opacity: 0.3;
  }
  50% {
    opacity: 1;
  }
  100% {
    top: calc(100% - 10px);
    opacity: 0.3;
  }
}

.scanner-instruction-pill {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.8);
  border: 1px solid var(--border, #262626);
  color: var(--foreground, #f1f5f9);
  padding: 6px 14px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  pointer-events: none;
  backdrop-filter: blur(6px);
}

/* 摄像头不可用卡片 */
.camera-denied-box {
  padding: 32px 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 12px;
}

.error-camera-icon {
  font-size: 48px;
  color: var(--status-warning, #fcd34d);
}

.camera-denied-box h4 {
  margin: 0;
  font-family: 'Orbitron', 'ZCOOLQingKeHuangYou', sans-serif;
  font-size: 16px;
  font-weight: 700;
  color: var(--foreground, #f1f5f9);
}

.camera-denied-box p {
  margin: 0;
  font-size: 13px;
  color: var(--muted-foreground, #a3a3a3);
  line-height: 1.5;
}

.btn-primary-album {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--primary, #39ff14);
  color: var(--primary-foreground, #000000);
  border: none;
  border-radius: 10px;
  padding: 10px 18px;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-primary-album:hover {
  background: #2cd40e;
  box-shadow: var(--glow-primary);
}

.scanner-footer {
  padding: 12px 18px;
  background: rgba(255, 255, 255, 0.02);
  border-top: 1px solid var(--border, #262626);
  display: flex;
  justify-content: center;
}

.btn-upload-album {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--muted, #1a1a1a);
  border: 1px solid var(--border, #262626);
  border-radius: 10px;
  padding: 8px 16px;
  color: var(--foreground, #f1f5f9);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-upload-album:hover {
  background: rgba(57, 255, 20, 0.12);
  color: var(--primary, #39ff14);
  border-color: var(--primary, #39ff14);
  box-shadow: 0 0 10px rgba(57, 255, 20, 0.2);
}

.btn-upload-album .material-icons {
  font-size: 17px;
  color: var(--primary, #39ff14);
}
</style>
