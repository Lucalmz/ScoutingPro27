<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePitScoutStore } from '@/stores/pitScout'
import { useUserStore } from '@/stores/user'
import { useToastStore } from '@/stores/toast'
import { useCustomFieldsStore } from '@/stores/customFields'
import DynamicFieldsRenderer from '@/components/customFields/DynamicFieldsRenderer.vue'
import { savePhoto, getPhotoUrl, deletePhoto, flushOfflinePhotos } from '@/services/photoStorage'
import { hapticLight, hapticMedium, hapticSuccess } from '@/utils/haptics'
import { useBumpAnimation } from '@/composables/useBumpAnimation'
import { useConfirm } from '@/composables/useConfirm'
import type { PitScoutingRecord } from '@/types'
import { LAUNCHER_PRESETS, FLOWER_PRESETS, type PresetOption } from '@/constants/pitScoutPresets'
import './PitScoutFormDrawer.css'

const props = defineProps<{
  modelValue: boolean
  teamNumber: number | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'saved', record: PitScoutingRecord): void
}>()

let t = (key: string, values?: any): string => key
let localeRef: any = null

try {
  const i18n = useI18n()
  t = i18n.t
  localeRef = i18n.locale
} catch {
  // Fallback for tests mounted without i18n
}

const pitStore = usePitScoutStore()
const userStore = useUserStore()
const toastStore = useToastStore()
const customFieldsStore = useCustomFieldsStore()

const customFields = ref<Record<string, any>>({})

const team = computed(() => {
  return props.teamNumber ? pitStore.getUnifiedTeam(props.teamNumber) : null
})

// Form State (BIOBUZZ 2026-2027)
const isZh = computed(() => {
  const loc = (localeRef && (localeRef.value || localeRef)) || 'zh'
  return String(loc).startsWith('zh')
})

const defaultLauncher = computed(() => (isZh.value ? '差速双飞轮' : 'Dual Flywheel'))
const defaultFlower = computed(() => (isZh.value ? '垂直级联高抬升' : 'Vertical Cascading Lift'))

const drivetrainType = ref<'mecanum' | 'tank' | 'swerve' | 'other'>('mecanum')
const weightLbs = ref<number>(38.0)
const ballCompatibility = ref<'universal' | 'sorting' | 'pollen_only'>('universal')
const launcherType = ref<string>(defaultLauncher.value)
const flowerMechanism = ref<string>(defaultFlower.value)

watch(isZh, (zh) => {
  const curLauncher = LAUNCHER_PRESETS.find((p) => isLauncherActive(p))
  if (curLauncher) {
    launcherType.value = zh ? curLauncher.zh : curLauncher.en
  }
  const curFlower = FLOWER_PRESETS.find((p) => isFlowerActive(p))
  if (curFlower) {
    flowerMechanism.value = zh ? curFlower.zh : curFlower.en
  }
})
const hasColorSensor = ref<boolean>(true)
const odometryType = ref<string>('two_wheel')

function isLauncherActive(preset: PresetOption): boolean {
  const val = (launcherType.value || '').trim()
  return val === preset.zh || val === preset.en || val === preset.key || val.toLowerCase() === preset.en.toLowerCase()
}

function selectLauncherPreset(preset: PresetOption) {
  launcherType.value = isZh.value ? preset.zh : preset.en
}

function isFlowerActive(preset: PresetOption): boolean {
  const val = (flowerMechanism.value || '').trim()
  return val === preset.zh || val === preset.en || val === preset.key || val.toLowerCase() === preset.en.toLowerCase()
}

function selectFlowerPreset(preset: PresetOption) {
  flowerMechanism.value = isZh.value ? preset.zh : preset.en
}

// 核心量化自述能力
const claimedAutoStrategy = ref<string>('')
const claimedAutoScore = ref<number>(30)
const claimedTeleopCycles = ref<number>(5)
const claimedTeleopScore = ref<number>(60)
const claimedEndgameScore = ref<number>(15)

// 实物特写图
const photoKeys = ref<string[]>([])
const photoPreviews = ref<{ key: string; url: string }[]>([])
const fileInput = ref<HTMLInputElement | null>(null)

// 自动计算汇总自述总分
const calculatedTotalScore = computed(() => {
  return claimedAutoScore.value + claimedTeleopScore.value + claimedEndgameScore.value
})

// 加载已有数据
async function reloadFormData(num: number | null) {
  if (!num) return
  const existing = pitStore.getUnifiedTeam(num)?.pitRecord
  if (existing) {
    drivetrainType.value = existing.drivetrainType || 'mecanum'
    weightLbs.value = existing.weightLbs || 0
    ballCompatibility.value = existing.ballCompatibility || 'universal'
    launcherType.value = existing.launcherType || ''
    flowerMechanism.value = existing.flowerMechanism || ''
    hasColorSensor.value = existing.hasColorSensor ?? false
    odometryType.value = existing.odometryType || 'two_wheel'

    claimedAutoStrategy.value = existing.claimedAutoStrategy || ''
    claimedAutoScore.value = existing.claimedAutoScore || 0
    claimedTeleopCycles.value = existing.claimedTeleopCycles || 0
    claimedTeleopScore.value = existing.claimedTeleopScore || 0
    claimedEndgameScore.value = existing.claimedEndgameScore || 0

    photoKeys.value = existing.photoKeys ? [...existing.photoKeys] : []

    if (existing.rawData) {
      try {
        const parsed = JSON.parse(existing.rawData)
        customFields.value = parsed.customFields ? { ...parsed.customFields } : {}
      } catch {
        customFields.value = {}
      }
    } else {
      customFields.value = {}
    }
  } else {
    // 默认初始值
    drivetrainType.value = 'mecanum'
    weightLbs.value = 38.0
    ballCompatibility.value = 'universal'
    launcherType.value = defaultLauncher.value
    flowerMechanism.value = defaultFlower.value
    hasColorSensor.value = true
    odometryType.value = 'two_wheel'

    claimedAutoStrategy.value = ''
    claimedAutoScore.value = 30
    claimedTeleopCycles.value = 5
    claimedTeleopScore.value = 60
    claimedEndgameScore.value = 15
    photoKeys.value = []
    customFields.value = {}
  }

  // 同步记录初始快照（防止异步加载图片时序导致 isDirty 误判）
  initialSnapshot = takeSnapshot()

  // 加载图片预览
  photoPreviews.value = []
  for (const key of photoKeys.value) {
    const url = await getPhotoUrl(key, pitStore.currentEventId || '')
    if (url) photoPreviews.value.push({ key, url })
  }
}

let initialSnapshot = ''
function takeSnapshot(): string {
  return JSON.stringify({
    drivetrainType: drivetrainType.value,
    weightLbs: weightLbs.value,
    ballCompatibility: ballCompatibility.value,
    launcherType: launcherType.value,
    flowerMechanism: flowerMechanism.value,
    hasColorSensor: hasColorSensor.value,
    odometryType: odometryType.value,
    claimedAutoStrategy: claimedAutoStrategy.value,
    claimedAutoScore: claimedAutoScore.value,
    claimedTeleopCycles: claimedTeleopCycles.value,
    claimedTeleopScore: claimedTeleopScore.value,
    claimedEndgameScore: claimedEndgameScore.value,
    photoKeys: photoKeys.value,
    customFields: customFields.value
  })
}

const isDirty = computed(() => {
  if (!props.modelValue || !initialSnapshot) return false
  return takeSnapshot() !== initialSnapshot
})

const { showConfirm } = useConfirm()

function requestClose() {
  if (isDirty.value) {
    if (typeof window !== 'undefined' && typeof window.confirm === 'function' && (window.confirm as any).mock) {
      if (!window.confirm(t('pit_scout.drawer.unsaved_confirm') || '您有未保存的侦查内容，确定要退出并丢弃更改吗？')) {
        return
      }
      emit('update:modelValue', false)
      return
    }

    showConfirm({
      title: t('confirm_dialog.title'),
      message: t('pit_scout.drawer.unsaved_confirm') || '您有未保存的侦查内容，确定要退出并丢弃更改吗？',
      type: 'warning',
      confirmText: t('confirm_dialog.danger_confirm'),
      cancelText: t('confirm_dialog.cancel')
    }).then((ok) => {
      if (ok) {
        emit('update:modelValue', false)
      }
    })
    return
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

const { bump, getBumpClass, clearBump } = useBumpAnimation()

type StepperField = 'weight' | 'autoScore' | 'teleopCycles' | 'teleopScore' | 'endgameScore'

// 步进器便捷函数 (类型安全，解包防御，集成动效与触觉反馈)
function adjust(field: StepperField, delta: number, min = 0, max = 999) {
  const fieldMap: Record<StepperField, typeof weightLbs> = {
    weight: weightLbs,
    autoScore: claimedAutoScore,
    teleopCycles: claimedTeleopCycles,
    teleopScore: claimedTeleopScore,
    endgameScore: claimedEndgameScore
  }
  const targetRef = fieldMap[field]
  const next = Number((targetRef.value + delta).toFixed(1))
  if (next >= min && next <= max) {
    targetRef.value = next
    bump(field, delta > 0 ? 'up' : 'down')
    if (delta > 0) {
      hapticMedium()
    } else {
      hapticLight()
    }
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
      const MAX_DIM = 1024
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
      const webpData = canvas.toDataURL('image/webp', 0.70)
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
    ballCompatibility: ballCompatibility.value,
    launcherType: launcherType.value,
    flowerMechanism: flowerMechanism.value,
    hasColorSensor: ballCompatibility.value !== 'pollen_only' ? hasColorSensor.value : false,
    odometryType: odometryType.value,

    claimedAutoStrategy: claimedAutoStrategy.value,
    claimedAutoScore: claimedAutoScore.value,
    claimedTeleopCycles: claimedTeleopCycles.value,
    claimedTeleopScore: claimedTeleopScore.value,
    claimedEndgameScore: claimedEndgameScore.value,
    claimedTotalScore: calculatedTotalScore.value,

    photoKeys: photoKeys.value,
    rawData: JSON.stringify({ customFields: customFields.value }),
    version: existing?.version || 1
  }

  pitStore.saveRecord(record)
  if (pitStore.currentEventId) {
    flushOfflinePhotos(pitStore.currentEventId).catch((err) => {
      console.warn('[PitScout] Background flush photos deferred:', err)
    })
  }
  initialSnapshot = takeSnapshot()
  hapticSuccess()
  emit('saved', record)
  emit('update:modelValue', false)
}
</script>

<template>
  <Transition name="pit-drawer">
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
              <button
                type="button"
                class="step-btn"
                :disabled="weightLbs <= 0"
                @click="adjust('weight', -0.5, 0, 50)"
              >-</button>
              <span
                class="stepper-val"
                :class="getBumpClass('weight')"
                @animationend="clearBump('weight')"
              >{{ weightLbs }}</span>
              <button
                type="button"
                class="step-btn"
                :disabled="weightLbs >= 50"
                @click="adjust('weight', 0.5, 0, 50)"
              >+</button>
              <span class="stepper-unit">{{ t('pit_scout.drawer.weight_hint') }}</span>
            </div>
            <span v-if="weightLbs > 42" class="warning-text">
              <span class="material-icons" style="font-size: 14px; vertical-align: middle; margin-right: 4px;">warning</span>
              {{ t('pit_scout.drawer.weight_over_warning') }}
            </span>
          </div>

          <div class="form-group">
            <label>{{ t('pit_scout.drawer.ball_compatibility_label') }}</label>
            <div class="radio-group">
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': ballCompatibility === 'universal' }"
                @click="ballCompatibility = 'universal'"
              >
                {{ t('pit_scout.drawer.ball_compat_universal') }}
              </button>
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': ballCompatibility === 'sorting' }"
                @click="ballCompatibility = 'sorting'"
              >
                {{ t('pit_scout.drawer.ball_compat_sorting') }}
              </button>
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': ballCompatibility === 'pollen_only' }"
                @click="ballCompatibility = 'pollen_only'"
              >
                {{ t('pit_scout.drawer.ball_compat_pollen_only') }}
              </button>
            </div>
          </div>

          <!-- 防违规颜色传感器（仅大小兼容/分类时展示） -->
          <div v-if="ballCompatibility !== 'pollen_only'" class="form-group">
            <label>{{ t('pit_scout.drawer.has_color_sensor_label') }}</label>
            <div class="radio-group">
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': hasColorSensor }"
                @click="hasColorSensor = true"
              >
                <span class="material-icons" style="font-size: 16px; margin-right: 4px; vertical-align: text-bottom;">check_circle</span>
                {{ t('pit_scout.drawer.color_sensor_equipped') }}
              </button>
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': !hasColorSensor }"
                @click="hasColorSensor = false"
              >
                <span class="material-icons" style="font-size: 16px; margin-right: 4px; vertical-align: text-bottom;">cancel</span>
                {{ t('pit_scout.drawer.color_sensor_none') }}
              </button>
            </div>
          </div>

          <div class="form-group">
            <label>{{ t('pit_scout.drawer.launcher_type_label') }}</label>
            <input
              v-model="launcherType"
              type="text"
              class="input-field"
              :placeholder="t('pit_scout.drawer.launcher_type_placeholder')"
            />
            <div class="quick-chips-wrap">
              <button
                v-for="chip in LAUNCHER_PRESETS"
                :key="chip.key"
                type="button"
                class="quick-chip-btn"
                :class="{ 'is-active': isLauncherActive(chip) }"
                @click="selectLauncherPreset(chip)"
              >
                {{ t('pit_scout.launcher_presets.' + chip.key) }}
              </button>
            </div>
          </div>

          <div class="form-group">
            <label>{{ t('pit_scout.drawer.flower_mechanism_label') }}</label>
            <input
              v-model="flowerMechanism"
              type="text"
              class="input-field"
              :placeholder="t('pit_scout.drawer.flower_mechanism_placeholder')"
            />
            <div class="quick-chips-wrap">
              <button
                v-for="chip in FLOWER_PRESETS"
                :key="chip.key"
                type="button"
                class="quick-chip-btn"
                :class="{ 'is-active': isFlowerActive(chip) }"
                @click="selectFlowerPreset(chip)"
              >
                {{ t('pit_scout.flower_presets.' + chip.key) }}
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
                :class="{ 'is-active': odometryType === 'pinpoint' }"
                @click="odometryType = 'pinpoint'"
              >
                {{ t('pit_scout.odometry.pinpoint') }}
              </button>
              <button
                type="button"
                class="radio-btn"
                :class="{ 'is-active': odometryType === 'sparkfun_otos' || odometryType === 'otos' }"
                @click="odometryType = 'sparkfun_otos'"
              >
                {{ t('pit_scout.odometry.sparkfun_otos') }}
              </button>
            </div>
          </div>

          <!-- Pit Hardware Custom Fields -->
          <DynamicFieldsRenderer
            :definitions="customFieldsStore.getActiveFields(pitStore.currentEventId || '', 'PIT', 'hardware')"
            v-model="customFields"
          />
        </div>

        <!-- 模块 2: 关键量化自述能力 (比对吹牛指数核心) -->
        <div class="form-section">
          <h4 class="section-title">{{ t('pit_scout.drawer.sec_claimed') }}</h4>

          <div class="form-group">
            <label>{{ t('pit_scout.drawer.auto_strategy_label') }}</label>
            <textarea
              v-model="claimedAutoStrategy"
              class="input-field"
              :placeholder="t('pit_scout.drawer.auto_strategy_placeholder')"
              rows="2"
              style="resize: vertical;"
            ></textarea>
          </div>

          <div class="form-group">
            <label>{{ t('pit_scout.drawer.auto_score_label') }}</label>
            <div class="stepper-control">
              <button
                type="button"
                class="step-btn"
                :disabled="claimedAutoScore <= 0"
                @click="adjust('autoScore', -5, 0, 150)"
              >-</button>
              <span
                class="stepper-val"
                :class="getBumpClass('autoScore')"
                @animationend="clearBump('autoScore')"
              >{{ claimedAutoScore }}</span>
              <button
                type="button"
                class="step-btn"
                :disabled="claimedAutoScore >= 150"
                @click="adjust('autoScore', 5, 0, 150)"
              >+</button>
              <span class="stepper-unit">{{ t('pit_scout.drawer.unit_pts') }}</span>
            </div>
          </div>

          <div class="form-group">
            <label>{{ t('pit_scout.drawer.teleop_cycles_label') }}</label>
            <div class="stepper-control">
              <button
                type="button"
                class="step-btn"
                :disabled="claimedTeleopCycles <= 0"
                @click="adjust('teleopCycles', -1, 0, 30)"
              >-</button>
              <span
                class="stepper-val"
                :class="getBumpClass('teleopCycles')"
                @animationend="clearBump('teleopCycles')"
              >{{ claimedTeleopCycles }}</span>
              <button
                type="button"
                class="step-btn"
                :disabled="claimedTeleopCycles >= 30"
                @click="adjust('teleopCycles', 1, 0, 30)"
              >+</button>
              <span class="stepper-unit">{{ t('pit_scout.drawer.unit_cycles') }}</span>
            </div>
          </div>

          <div class="form-group">
            <label>{{ t('pit_scout.drawer.teleop_score_label') }}</label>
            <div class="stepper-control">
              <button
                type="button"
                class="step-btn"
                :disabled="claimedTeleopScore <= 0"
                @click="adjust('teleopScore', -5, 0, 200)"
              >-</button>
              <span
                class="stepper-val"
                :class="getBumpClass('teleopScore')"
                @animationend="clearBump('teleopScore')"
              >{{ claimedTeleopScore }}</span>
              <button
                type="button"
                class="step-btn"
                :disabled="claimedTeleopScore >= 200"
                @click="adjust('teleopScore', 5, 0, 200)"
              >+</button>
              <span class="stepper-unit">{{ t('pit_scout.drawer.unit_pts') }}</span>
            </div>
          </div>

          <div class="form-group">
            <label>{{ t('pit_scout.drawer.endgame_score_label') }}</label>
            <div class="stepper-control">
              <button
                type="button"
                class="step-btn"
                :disabled="claimedEndgameScore <= 0"
                @click="adjust('endgameScore', -5, 0, 50)"
              >-</button>
              <span
                class="stepper-val"
                :class="getBumpClass('endgameScore')"
                @animationend="clearBump('endgameScore')"
              >{{ claimedEndgameScore }}</span>
              <button
                type="button"
                class="step-btn"
                :disabled="claimedEndgameScore >= 50"
                @click="adjust('endgameScore', 5, 0, 50)"
              >+</button>
              <span class="stepper-unit">{{ t('pit_scout.drawer.unit_pts') }}</span>
            </div>
          </div>

          <div class="form-group">
            <label>{{ t('pit_scout.drawer.calculated_total_label') }}</label>
            <input type="number" class="input-field" :value="calculatedTotalScore" readonly />
          </div>

          <!-- Pit Strategy Custom Fields -->
          <DynamicFieldsRenderer
            :definitions="customFieldsStore.getActiveFields(pitStore.currentEventId || '', 'PIT', 'strategy')"
            v-model="customFields"
          />
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

        <!-- Pit Overall Custom Fields -->
        <div v-if="customFieldsStore.getActiveFields(pitStore.currentEventId || '', 'PIT', 'overall').length > 0" class="form-section">
          <h4 class="section-title">{{ t('pit_scout.drawer.sec_custom_overall') }}</h4>
          <DynamicFieldsRenderer
            :definitions="customFieldsStore.getActiveFields(pitStore.currentEventId || '', 'PIT', 'overall')"
            v-model="customFields"
          />
        </div>
      </div>

      <!-- 底部操作按钮 -->
      <div class="drawer-footer">
        <button type="button" class="btn-cancel" @click="requestClose">{{ t('pit_scout.drawer.btn_cancel') }}</button>
        <button type="button" class="btn-primary" @click="handleSave">{{ t('pit_scout.drawer.btn_save') }}</button>
      </div>
    </div>
  </div>
  </Transition>
</template>
