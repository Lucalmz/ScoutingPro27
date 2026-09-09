<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePitScoutStore } from '@/stores/pitScout'
import { useUserStore } from '@/stores/user'
import { useToastStore } from '@/stores/toast'
import { savePhoto, getPhotoUrl, deletePhoto, flushOfflinePhotos } from '@/services/photoStorage'
import type { PitScoutingRecord } from '@/types'
import './PitScoutFormDrawer.css'

const props = defineProps<{
  modelValue: boolean
  teamNumber: number | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'saved', record: PitScoutingRecord): void
}>()

const { t } = useI18n()
const pitStore = usePitScoutStore()
const userStore = useUserStore()
const toastStore = useToastStore()

const team = computed(() => {
  return props.teamNumber ? pitStore.getUnifiedTeam(props.teamNumber) : null
})

// Form State
const drivetrainType = ref<'mecanum' | 'tank' | 'swerve' | 'other'>('mecanum')
const weightLbs = ref<number>(38.0)
const sizingPassed = ref<boolean>(true)
const mechanismType = ref<string>('slide_claw')
const hangType = ref<string>('winch')
const odometryType = ref<string>('two_wheel')

const claimedAutoScore = ref<number>(60)
const claimedAutoPieces = ref<number>(2)
const claimedAutoHangLevel = ref<number>(0)
const claimedTeleopScore = ref<number>(80)
const claimedTeleopCycleSec = ref<number>(8.0)
const claimedEndgameHangLevel = ref<number>(2)
const claimedEndgameTimeSec = ref<number>(4.0)

// 实物特写图
const photoKeys = ref<string[]>([])
const photoPreviews = ref<{ key: string; url: string }[]>([])
const fileInput = ref<HTMLInputElement | null>(null)

// 自动计算汇总自述总分
const calculatedTotalScore = computed(() => {
  let hangScore = 0
  if (claimedEndgameHangLevel.value === 1) hangScore = 5
  if (claimedEndgameHangLevel.value === 2) hangScore = 15
  if (claimedEndgameHangLevel.value === 3) hangScore = 30
  return claimedAutoScore.value + claimedTeleopScore.value + hangScore
})

// 加载已有数据
async function reloadFormData(num: number | null) {
  if (!num) return
  const existing = pitStore.getUnifiedTeam(num)?.pitRecord
  if (existing) {
    drivetrainType.value = existing.drivetrainType || 'mecanum'
    weightLbs.value = existing.weightLbs || 0
    sizingPassed.value = existing.sizingPassed ?? true
    mechanismType.value = existing.mechanismType || 'slide_claw'
    hangType.value = existing.hangType || 'winch'
    odometryType.value = existing.odometryType || 'two_wheel'

    claimedAutoScore.value = existing.claimedAutoScore || 0
    claimedAutoPieces.value = existing.claimedAutoPieces || 0
    claimedAutoHangLevel.value = existing.claimedAutoHangLevel || 0
    claimedTeleopScore.value = existing.claimedTeleopScore || 0
    claimedTeleopCycleSec.value = existing.claimedTeleopCycleSec || 0
    claimedEndgameHangLevel.value = existing.claimedEndgameHangLevel || 0
    claimedEndgameTimeSec.value = existing.claimedEndgameTimeSec || 0

    photoKeys.value = existing.photoKeys ? [...existing.photoKeys] : []
  } else {
    // 默认初始值
    drivetrainType.value = 'mecanum'
    weightLbs.value = 38.0
    sizingPassed.value = true
    mechanismType.value = 'slide_claw'
    hangType.value = 'winch'
    odometryType.value = 'two_wheel'

    claimedAutoScore.value = 60
    claimedAutoPieces.value = 2
    claimedAutoHangLevel.value = 0
    claimedTeleopScore.value = 80
    claimedTeleopCycleSec.value = 8.0
    claimedEndgameHangLevel.value = 2
    claimedEndgameTimeSec.value = 4.0
    photoKeys.value = []
  }

  // 加载图片预览
  photoPreviews.value = []
  for (const key of photoKeys.value) {
    const url = await getPhotoUrl(key, pitStore.currentEventId || '')
    if (url) photoPreviews.value.push({ key, url })
  }
  initialSnapshot = takeSnapshot()
}

let initialSnapshot = ''
function takeSnapshot(): string {
  return JSON.stringify({
    drivetrainType: drivetrainType.value,
    weightLbs: weightLbs.value,
    sizingPassed: sizingPassed.value,
    mechanismType: mechanismType.value,
    hangType: hangType.value,
    odometryType: odometryType.value,
    claimedAutoScore: claimedAutoScore.value,
    claimedAutoPieces: claimedAutoPieces.value,
    claimedAutoHangLevel: claimedAutoHangLevel.value,
    claimedTeleopScore: claimedTeleopScore.value,
    claimedTeleopCycleSec: claimedTeleopCycleSec.value,
    claimedEndgameHangLevel: claimedEndgameHangLevel.value,
    claimedEndgameTimeSec: claimedEndgameTimeSec.value,
    photoKeys: photoKeys.value
  })
}

const isDirty = computed(() => {
  if (!props.modelValue || !initialSnapshot) return false
  return takeSnapshot() !== initialSnapshot
})

function requestClose() {
  if (isDirty.value) {
    if (!window.confirm(t('pit_scout.drawer.unsaved_confirm') || '您有未保存的侦查内容，确定要退出并丢弃更改吗？')) {
      return
    }
  }
  emit('update:modelValue', false)
}

watch(
  [() => props.teamNumber, () => props.modelValue],
  ([num, open]) => {
    if (open && num) {
      reloadFormData(num)
    }
  },
  { immediate: true }
)

// 步进器便捷函数
function adjust(refVal: any, delta: number, min = 0, max = 999) {
  const next = Number((refVal.value + delta).toFixed(1))
  if (next >= min && next <= max) {
    refVal.value = next
  }
}

// 拍照 / 选图压缩
async function handleFileSelected(e: Event) {
  const target = e.target as HTMLInputElement
  const files = target.files
  if (!files || files.length === 0) return

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    if (!file) continue
    const key = `pit_${props.teamNumber}_${Date.now()}_${i}`

    try {
      const dataUrl = await compressImageToWebP(file)
      await savePhoto(key, dataUrl, pitStore.currentEventId || '')
      photoKeys.value.push(key)
      photoPreviews.value.push({ key, url: dataUrl })
    } catch (err: any) {
      console.warn('[PitScout] Image compression failed:', err)
      toastStore.showToast(t('pit_scout.photo_save_failed') || '照片保存失败，请重试', 'error')
    }
  }
  target.value = ''
}

function removePhoto(key: string) {
  deletePhoto(key, pitStore.currentEventId || '')
  photoKeys.value = photoKeys.value.filter((k) => k !== key)
  photoPreviews.value = photoPreviews.value.filter((p) => p.key !== key)
}

function compressImageToWebP(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(objectUrl)
      const canvas = document.createElement('canvas')
      const MAX_DIM = 1280
      let width = img.width
      let height = img.height

      if (width > height) {
        if (width > MAX_DIM) {
          height = Math.round((height * MAX_DIM) / width)
          width = MAX_DIM
        }
      } else {
        if (height > MAX_DIM) {
          width = Math.round((width * MAX_DIM) / height)
          height = MAX_DIM
        }
      }

      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) return reject(new Error('No canvas context'))

      ctx.drawImage(img, 0, 0, width, height)
      const webpData = canvas.toDataURL('image/webp', 0.75)
      resolve(webpData)
    }
    img.onerror = (err) => {
      URL.revokeObjectURL(objectUrl)
      reject(err)
    }
    img.src = objectUrl
  })
}

function handleSave() {
  if (!props.teamNumber) return

  const existing = pitStore.getUnifiedTeam(props.teamNumber)?.pitRecord

  const record: PitScoutingRecord = {
    id: existing?.id || `pit_${props.teamNumber}_${Date.now()}`,
    eventId: pitStore.currentEventId || '',
    teamNumber: props.teamNumber,
    scoutId: userStore.userId || 'scout',
    scoutName: userStore.username || 'Scout',
    robotName: team.value?.robotName,

    drivetrainType: drivetrainType.value,
    weightLbs: weightLbs.value,
    sizingPassed: sizingPassed.value,
    mechanismType: mechanismType.value,
    hangType: hangType.value,
    odometryType: odometryType.value,

    claimedAutoScore: claimedAutoScore.value,
    claimedAutoPieces: claimedAutoPieces.value,
    claimedAutoHangLevel: claimedAutoHangLevel.value,
    claimedTeleopScore: claimedTeleopScore.value,
    claimedTeleopCycleSec: claimedTeleopCycleSec.value,
    claimedEndgameHangLevel: claimedEndgameHangLevel.value,
    claimedEndgameTimeSec: claimedEndgameTimeSec.value,
    claimedTotalScore: calculatedTotalScore.value,

    photoKeys: photoKeys.value,
    version: existing?.version || 1
  }

  pitStore.saveRecord(record)
  if (pitStore.currentEventId) {
    flushOfflinePhotos(pitStore.currentEventId).catch((err) => {
      console.warn('[PitScout] Background flush photos deferred:', err)
    })
  }
  initialSnapshot = takeSnapshot()
  emit('saved', record)
  emit('update:modelValue', false)
}
</script>

<template>
  <div v-if="modelValue" class="drawer-overlay" @click.self="requestClose">
    <div class="drawer-panel">
      <!-- 头部 -->
      <div class="drawer-header">
        <div class="header-title-box">
          <h3 class="drawer-title">{{ t('pit_scout.drawer.title', { teamNumber }) }}</h3>
          <span v-if="team" class="team-name-badge">{{ team.name }}</span>
        </div>
        <button class="close-btn" type="button" @click="requestClose">×</button>
      </div>

      <!-- 表单主体 -->
      <div class="drawer-body">
        <!-- 模块 1: 核心硬件构型 -->
        <div class="form-section">
          <h4 class="section-title">{{ t('pit_scout.drawer.sec_hardware') }}</h4>

          <div class="form-group">
            <label>{{ t('pit_scout.drawer.drivetrain_label') }}</label>
            <div class="radio-group">
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': drivetrainType === 'mecanum' }"
                @click="drivetrainType = 'mecanum'"
              >
                {{ t('pit_scout.drivetrain.mecanum') }}
              </button>
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': drivetrainType === 'tank' }"
                @click="drivetrainType = 'tank'"
              >
                {{ t('pit_scout.drivetrain.tank') }}
              </button>
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': drivetrainType === 'swerve' }"
                @click="drivetrainType = 'swerve'"
              >
                {{ t('pit_scout.drivetrain.swerve') }}
              </button>
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': drivetrainType === 'other' }"
                @click="drivetrainType = 'other'"
              >
                {{ t('pit_scout.drivetrain.other') }}
              </button>
            </div>
          </div>

          <div class="form-group">
            <label>{{ t('pit_scout.drawer.weight_label') }}</label>
            <div class="stepper-control">
              <button type="button" class="step-btn" @click="adjust(weightLbs, -0.5, 0, 50)">-</button>
              <span class="stepper-val">{{ weightLbs }}</span>
              <button type="button" class="step-btn" @click="adjust(weightLbs, 0.5, 0, 50)">+</button>
              <span class="stepper-unit">{{ t('pit_scout.drawer.weight_hint') }}</span>
            </div>
            <span v-if="weightLbs > 42" class="warning-text">
              <span class="material-icons" style="font-size: 14px; vertical-align: middle; margin-right: 4px;">warning</span>
              {{ t('pit_scout.drawer.weight_over_warning') }}
            </span>
          </div>

          <div class="form-group">
            <label>{{ t('pit_scout.drawer.sizing_label') }}</label>
            <div class="radio-group">
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': sizingPassed }"
                @click="sizingPassed = true"
              >
                <span class="material-icons" style="font-size: 16px; margin-right: 4px; vertical-align: text-bottom;">check_circle</span>
                {{ t('pit_scout.drawer.sizing_passed') }}
              </button>
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': !sizingPassed }"
                @click="sizingPassed = false"
              >
                <span class="material-icons" style="font-size: 16px; margin-right: 4px; vertical-align: text-bottom;">cancel</span>
                {{ t('pit_scout.drawer.sizing_failed') }}
              </button>
            </div>
          </div>

          <div class="form-group">
            <label>{{ t('pit_scout.drawer.mechanism_label') }}</label>
            <div class="radio-group">
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': mechanismType === 'slide_claw' }"
                @click="mechanismType = 'slide_claw'"
              >
                {{ t('pit_scout.mechanism.slide_claw') }}
              </button>
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': mechanismType === 'slide_roller' }"
                @click="mechanismType = 'slide_roller'"
              >
                {{ t('pit_scout.mechanism.slide_roller') }}
              </button>
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': mechanismType === 'linkage_arm' }"
                @click="mechanismType = 'linkage_arm'"
              >
                {{ t('pit_scout.mechanism.linkage_arm') }}
              </button>
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': mechanismType === 'other' }"
                @click="mechanismType = 'other'"
              >
                {{ t('pit_scout.mechanism.other') }}
              </button>
            </div>
          </div>

          <div class="form-group">
            <label>{{ t('pit_scout.drawer.hang_label') }}</label>
            <div class="radio-group">
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': hangType === 'winch' }"
                @click="hangType = 'winch'"
              >
                {{ t('pit_scout.hang.winch') }}
              </button>
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': hangType === 'slide' }"
                @click="hangType = 'slide'"
              >
                {{ t('pit_scout.hang.slide') }}
              </button>
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': hangType === 'passive' }"
                @click="hangType = 'passive'"
              >
                {{ t('pit_scout.hang.passive') }}
              </button>
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': hangType === 'none' }"
                @click="hangType = 'none'"
              >
                {{ t('pit_scout.hang.none') }}
              </button>
            </div>
          </div>

          <div class="form-group">
            <label>{{ t('pit_scout.drawer.odometry_label') }}</label>
            <div class="radio-group">
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': odometryType === 'none' }"
                @click="odometryType = 'none'"
              >
                {{ t('pit_scout.odometry.none') }}
              </button>
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': odometryType === 'two_wheel' }"
                @click="odometryType = 'two_wheel'"
              >
                {{ t('pit_scout.odometry.two_wheel') }}
              </button>
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': odometryType === 'three_wheel' }"
                @click="odometryType = 'three_wheel'"
              >
                {{ t('pit_scout.odometry.three_wheel') }}
              </button>
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': odometryType === 'pinpoint_otos' }"
                @click="odometryType = 'pinpoint_otos'"
              >
                {{ t('pit_scout.odometry.pinpoint_otos') }}
              </button>
            </div>
          </div>
        </div>

        <!-- 模块 2: 关键量化自述能力 (比对吹牛指数核心) -->
        <div class="form-section">
          <h4 class="section-title">{{ t('pit_scout.drawer.sec_claimed') }}</h4>

          <div class="form-group">
            <label>{{ t('pit_scout.drawer.auto_score_label') }}</label>
            <div class="stepper-control">
              <button type="button" class="step-btn" @click="adjust(claimedAutoScore, -5, 0, 150)">-</button>
              <span class="stepper-val">{{ claimedAutoScore }}</span>
              <button type="button" class="step-btn" @click="adjust(claimedAutoScore, 5, 0, 150)">+</button>
              <span class="stepper-unit">{{ t('pit_scout.drawer.unit_pts') }}</span>
            </div>
          </div>

          <div class="form-group">
            <label>{{ t('pit_scout.drawer.auto_pieces_label') }}</label>
            <div class="stepper-control">
              <button type="button" class="step-btn" @click="adjust(claimedAutoPieces, -1, 0, 8)">-</button>
              <span class="stepper-val">{{ claimedAutoPieces }}</span>
              <button type="button" class="step-btn" @click="adjust(claimedAutoPieces, 1, 0, 8)">+</button>
              <span class="stepper-unit">{{ t('pit_scout.drawer.unit_pieces') }}</span>
            </div>
          </div>

          <div class="form-group">
            <label>{{ t('pit_scout.drawer.auto_hang_label') }}</label>
            <div class="radio-group">
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': claimedAutoHangLevel === 0 }"
                @click="claimedAutoHangLevel = 0"
              >
                0 - {{ t('pit_scout.hang_none') }}
              </button>
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': claimedAutoHangLevel === 1 }"
                @click="claimedAutoHangLevel = 1"
              >
                {{ t('pit_scout.drawer.auto_hang_low') }}
              </button>
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': claimedAutoHangLevel === 2 }"
                @click="claimedAutoHangLevel = 2"
              >
                {{ t('pit_scout.drawer.auto_hang_high') }}
              </button>
            </div>
          </div>

          <div class="form-group">
            <label>{{ t('pit_scout.drawer.teleop_score_label') }}</label>
            <div class="stepper-control">
              <button type="button" class="step-btn" @click="adjust(claimedTeleopScore, -5, 0, 200)">-</button>
              <span class="stepper-val">{{ claimedTeleopScore }}</span>
              <button type="button" class="step-btn" @click="adjust(claimedTeleopScore, 5, 0, 200)">+</button>
              <span class="stepper-unit">{{ t('pit_scout.drawer.unit_pts') }}</span>
            </div>
          </div>

          <div class="form-group">
            <label>{{ t('pit_scout.drawer.teleop_cycle_label') }}</label>
            <div class="stepper-control">
              <button type="button" class="step-btn" @click="adjust(claimedTeleopCycleSec, -0.5, 2, 30)">-</button>
              <span class="stepper-val">{{ claimedTeleopCycleSec }}</span>
              <button type="button" class="step-btn" @click="adjust(claimedTeleopCycleSec, 0.5, 2, 30)">+</button>
              <span class="stepper-unit">{{ t('pit_scout.drawer.teleop_cycle_unit') }}</span>
            </div>
          </div>

          <div class="form-group">
            <label>{{ t('pit_scout.drawer.endgame_hang_label') }}</label>
            <div class="radio-group">
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': claimedEndgameHangLevel === 0 }"
                @click="claimedEndgameHangLevel = 0"
              >
                0 - {{ t('pit_scout.hang_none') }}
              </button>
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': claimedEndgameHangLevel === 1 }"
                @click="claimedEndgameHangLevel = 1"
              >
                Level 1
              </button>
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': claimedEndgameHangLevel === 2 }"
                @click="claimedEndgameHangLevel = 2"
              >
                Level 2
              </button>
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': claimedEndgameHangLevel === 3 }"
                @click="claimedEndgameHangLevel = 3"
              >
                {{ t('pit_scout.drawer.endgame_hang_l3') }}
              </button>
            </div>
          </div>

          <div class="form-group">
            <label>{{ t('pit_scout.drawer.endgame_time_label') }}</label>
            <div class="stepper-control">
              <button type="button" class="step-btn" @click="adjust(claimedEndgameTimeSec, -0.5, 1, 20)">-</button>
              <span class="stepper-val">{{ claimedEndgameTimeSec }}</span>
              <button type="button" class="step-btn" @click="adjust(claimedEndgameTimeSec, 0.5, 1, 20)">+</button>
              <span class="stepper-unit">{{ t('pit_scout.drawer.unit_sec') }}</span>
            </div>
          </div>

          <div class="form-group">
            <label>{{ t('pit_scout.drawer.calculated_total_label') }}</label>
            <input type="number" class="input-field" :value="calculatedTotalScore" readonly />
          </div>
        </div>

        <!-- 模块 3: 机器人定妆特写图 (IndexedDB) -->
        <div class="form-section">
          <h4 class="section-title">{{ t('pit_scout.drawer.sec_photos') }}</h4>
          <div class="photos-grid">
            <div v-for="p in photoPreviews" :key="p.key" class="photo-item">
              <img :src="p.url" alt="Preview" />
              <button type="button" class="photo-del-btn" @click="removePhoto(p.key)">×</button>
            </div>
            <label class="photo-upload-box">
              <span>{{ t('pit_scout.drawer.btn_upload_photo') }}</span>
              <input
                ref="fileInput"
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                class="file-hidden"
                @change="handleFileSelected"
              />
            </label>
          </div>
        </div>
      </div>

      <!-- 底部操作按钮 -->
      <div class="drawer-footer">
        <button type="button" class="btn-cancel" @click="requestClose">{{ t('pit_scout.drawer.btn_cancel') }}</button>
        <button type="button" class="btn-primary" @click="handleSave">{{ t('pit_scout.drawer.btn_save') }}</button>
      </div>
    </div>
  </div>
</template>
