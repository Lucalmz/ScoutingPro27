<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRouter, onBeforeRouteLeave } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useRecordStore } from '@/stores/records'
import { useConnectionStore } from '@/stores/connection'
import { useToastStore } from '@/stores/toast'
import TagPicker from '@/components/common/TagPicker.vue'
import ConnectionStatus from '@/components/common/ConnectionStatus.vue'
import { usePitScoutStore } from '@/stores/pitScout'
import { useCustomFieldsStore } from '@/stores/customFields'
import PitScoutFormDrawer from '@/components/pit/PitScoutFormDrawer.vue'
import type { ScoutingRecord, CustomFieldDefinition } from '@/types'
import { sortRecordsChronologically, getMatchLevelPrefix } from '@/utils/tournament'

const props = defineProps<{
  eventId: string
  teamNumber: string
}>()

const router = useRouter()
const { t, te } = useI18n()
const recordStore = useRecordStore()
const pitStore = usePitScoutStore()
const customFieldsStore = useCustomFieldsStore()
const toastStore = useToastStore()
const isPitDrawerOpen = ref(false)

function formatDrivetrain(dt?: string) {
  if (!dt) return '-'
  const key = 'pit_scout.drivetrain.' + dt
  return te(key) ? t(key) : dt
}

function formatBallCompat(bc?: string) {
  if (!bc) return '-'
  const key = 'pit_scout.ball_compatibility.' + bc
  return te(key) ? t(key) : bc
}

function formatOdometry(odo?: string) {
  if (!odo) return '-'
  const key = 'pit_scout.odometry.' + odo
  return te(key) ? t(key) : odo
}

const teamNumVal = computed(() => parseInt(props.teamNumber))
const unifiedTeam = computed(() => isNaN(teamNumVal.value) ? undefined : pitStore.getUnifiedTeam(teamNumVal.value))

const detailBragLabel = computed(() => {
  const b = unifiedTeam.value?.bragInfo
  if (!b) return '-'
  const tierText = t(`pit_scout.brag_tiers.${b.tier}`) || b.label
  let str = `${b.overallRatio}x ${tierText}`
  return str
})

const teamMatches = computed<ScoutingRecord[]>(() => {
  return sortRecordsChronologically(
    recordStore.activeRecords.filter(r => (!props.eventId || r.eventId === props.eventId) && r.teamNumber === parseInt(props.teamNumber))
  )
})

const editingMatchId = ref<string | null>(null)
const editCommentText = ref('')
const isSaving = ref(false)

function startEditComment(match: ScoutingRecord) {
  editingMatchId.value = match.id
  editCommentText.value = match.notes || ''
}

function cancelEditComment() {
  editingMatchId.value = null
  editCommentText.value = ''
}

function handleBack() {
  router.push(`/event/${props.eventId}`)
}

function onGlobalKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    handleBack()
  }
}

function parseCustomFields(record: { customFields?: Record<string, any>; rawData?: string } | null | undefined): Record<string, any> {
  if (!record) return {}
  if (record.customFields && Object.keys(record.customFields).length > 0) {
    return record.customFields
  }
  if (record.rawData) {
    try {
      const parsed = typeof record.rawData === 'string' ? JSON.parse(record.rawData) : record.rawData
      return parsed.customFields || {}
    } catch {
      return {}
    }
  }
  return {}
}

interface CustomMetricSummary {
  definition: CustomFieldDefinition
  fieldType: string
  avg?: number | null
  max?: number | null
  rate?: number | null
  trueCount?: number
  totalCount?: number
  distribution?: { label: string; count: number; percentage: number; color?: string }[]
  textEntries?: { matchNumber: number; text: string }[]
}

const activeMatchFields = computed(() => {
  return props.eventId ? customFieldsStore.getActiveFields(props.eventId, 'MATCH') : []
})

const activePitFields = computed(() => {
  return props.eventId ? customFieldsStore.getActiveFields(props.eventId, 'PIT') : []
})

const teamMatchCustomMetrics = computed<CustomMetricSummary[]>(() => {
  const fields = activeMatchFields.value
  if (!fields || fields.length === 0) return []

  const matches = teamMatches.value
  const result: CustomMetricSummary[] = []

  for (const field of fields) {
    if (field.fieldType === 'number' || field.fieldType === 'level') {
      const values: number[] = []
      for (const m of matches) {
        const cf = parseCustomFields(m)
        const val = cf[field.fieldKey]
        if (val !== undefined && val !== null && val !== '') {
          const num = Number(val)
          if (!isNaN(num)) {
            values.push(num)
          }
        }
      }
      if (values.length > 0) {
        const sum = values.reduce((a, b) => a + b, 0)
        result.push({
          definition: field,
          fieldType: field.fieldType,
          avg: sum / values.length,
          max: Math.max(...values),
          totalCount: values.length
        })
      }
    } else if (field.fieldType === 'boolean') {
      let trueCount = 0
      let totalCount = 0
      for (const m of matches) {
        const cf = parseCustomFields(m)
        const val = cf[field.fieldKey]
        if (val !== undefined && val !== null) {
          totalCount++
          if (val === true || val === 'true' || val === 1) {
            trueCount++
          }
        }
      }
      if (totalCount > 0) {
        result.push({
          definition: field,
          fieldType: 'boolean',
          rate: (trueCount / totalCount) * 100,
          trueCount,
          totalCount
        })
      }
    } else if (field.fieldType === 'select' || field.fieldType === 'multi_select') {
      const optionMap: Record<string, number> = {}
      let totalEvals = 0
      for (const m of matches) {
        const cf = parseCustomFields(m)
        const val = cf[field.fieldKey]
        if (val !== undefined && val !== null && val !== '') {
          if (Array.isArray(val)) {
            for (const item of val) {
              if (item) {
                optionMap[item] = (optionMap[item] || 0) + 1
                totalEvals++
              }
            }
          } else {
            optionMap[val] = (optionMap[val] || 0) + 1
            totalEvals++
          }
        }
      }
      if (totalEvals > 0) {
        const dist = (field.options || []).map(opt => {
          const count = optionMap[opt.value] || optionMap[opt.label] || 0
          return {
            label: opt.label,
            count,
            percentage: totalEvals > 0 ? (count / totalEvals) * 100 : 0,
            color: opt.color || 'blue'
          }
        }).filter(d => d.count > 0)

        for (const [k, count] of Object.entries(optionMap)) {
          if (!dist.some(d => d.label === k)) {
            dist.push({
              label: k,
              count,
              percentage: (count / totalEvals) * 100,
              color: 'gray'
            })
          }
        }

        result.push({
          definition: field,
          fieldType: field.fieldType,
          distribution: dist,
          totalCount: totalEvals
        })
      }
    } else if (field.fieldType === 'text') {
      const textEntries: { matchNumber: number; text: string }[] = []
      for (const m of matches) {
        const cf = parseCustomFields(m)
        const val = cf[field.fieldKey]
        if (typeof val === 'string' && val.trim().length > 0) {
          textEntries.push({ matchNumber: m.matchNumber, text: val.trim() })
        }
      }
      if (textEntries.length > 0) {
        result.push({
          definition: field,
          fieldType: 'text',
          textEntries,
          totalCount: textEntries.length
        })
      }
    }
  }

  return result
})

const teamPitCustomSpecs = computed(() => {
  const fields = activePitFields.value
  if (!fields || fields.length === 0 || !unifiedTeam.value?.pitRecord) return []
  const cf = parseCustomFields(unifiedTeam.value.pitRecord)
  const list: { field: CustomFieldDefinition; displayValue: string }[] = []

  for (const f of fields) {
    const val = cf[f.fieldKey]
    if (val !== undefined && val !== null && val !== '') {
      let displayValue = String(val)
      if (f.fieldType === 'boolean') {
        displayValue = (val === true || val === 'true') ? t('custom_fields.renderer.bool_yes') : t('custom_fields.renderer.bool_no')
      } else if (f.fieldType === 'level') {
        displayValue = `${val} ${t('custom_fields.renderer.level_unit')}`
      } else if (f.fieldType === 'select') {
        const opt = f.options?.find(o => o.value === val || o.label === val)
        displayValue = opt ? opt.label : String(val)
      } else if (f.fieldType === 'multi_select' && Array.isArray(val)) {
        displayValue = val.map(v => {
          const opt = f.options?.find(o => o.value === v || o.label === v)
          return opt ? opt.label : v
        }).join(', ')
      }
      if (f.unit && f.fieldType === 'number') {
        displayValue += ` ${f.unit}`
      }
      list.push({ field: f, displayValue })
    }
  }
  return list
})

function getMatchCustomBadges(match: ScoutingRecord) {
  const fields = activeMatchFields.value
  if (!fields || fields.length === 0) return []
  const cf = parseCustomFields(match)
  const badges: { key: string; name: string; value: string; type: string; color?: string }[] = []

  for (const f of fields) {
    const val = cf[f.fieldKey]
    if (val !== undefined && val !== null && val !== '') {
      let displayValue = String(val)
      let color = 'gray'
      if (f.fieldType === 'boolean') {
        const isTrue = val === true || val === 'true' || val === 1
        displayValue = isTrue ? '✓' : '✕'
        color = isTrue ? 'green' : 'gray'
      } else if (f.fieldType === 'level') {
        displayValue = `${val} ${t('custom_fields.renderer.level_unit')}`
        color = val >= 4 ? 'green' : val >= 2 ? 'blue' : 'orange'
      } else if (f.fieldType === 'number') {
        displayValue = `${val}${f.unit ? ' ' + f.unit : ''}`
        color = 'blue'
      } else if (f.fieldType === 'select') {
        const opt = f.options?.find(o => o.value === val || o.label === val)
        displayValue = opt ? opt.label : String(val)
        color = opt?.color || 'blue'
      } else if (f.fieldType === 'multi_select' && Array.isArray(val)) {
        const labels = val.map(v => {
          const opt = f.options?.find(o => o.value === v || o.label === v)
          return opt ? opt.label : v
        })
        displayValue = labels.join(', ')
        color = 'purple'
      } else if (f.fieldType === 'text') {
        displayValue = String(val)
        color = 'gray'
      }
      badges.push({
        key: f.fieldKey,
        name: f.name,
        value: displayValue,
        type: f.fieldType,
        color
      })
    }
  }
  return badges
}

function loadEventData(eventId: string) {
  if (!eventId) return
  recordStore.currentEventId = eventId
  pitStore.currentEventId = eventId
  if (recordStore.records.length === 0 || !recordStore.records.some(r => r.eventId === eventId)) {
    recordStore.fetchRecords(eventId)
  }
  if (pitStore.records.length === 0 || !pitStore.records.some(r => r.eventId === eventId)) {
    pitStore.fetchPitData(eventId)
  }
  customFieldsStore.fetchFields(eventId)
}

onMounted(() => {
  window.addEventListener('keydown', onGlobalKeyDown)
  if (props.eventId) {
    loadEventData(props.eventId)
  }
})

watch(
  () => props.eventId,
  (newId) => {
    if (newId) {
      loadEventData(newId)
    }
  }
)

onUnmounted(() => {
  window.removeEventListener('keydown', onGlobalKeyDown)
})

onBeforeRouteLeave((to) => {
  // 仅在完全离开赛事页面时（如返回主面板、登出或跨赛事切换）切断长连接
  if ((to.name !== 'event' && to.name !== 'team-detail') || to.params.eventId !== props.eventId) {
    const connStore = useConnectionStore()
    connStore.rtcService?.disconnect()
    connStore.setRtcService(null)
    connStore.clearConnectedScouts()
    connStore.setStatus('offline')
  }
})

async function saveComment(match: ScoutingRecord) {
  isSaving.value = true
  try {
    const updatedRecord = { ...match, notes: editCommentText.value, updatedAt: new Date().toISOString() }
    const { success, recordsToPush } = await recordStore.updateRecord(updatedRecord)
    if (success) {
      import('@/stores/connection').then(({ useConnectionStore }) => {
        useConnectionStore().pushIfNeeded(recordsToPush)
      })
      editingMatchId.value = null
    }
  } catch (e: any) {
    toastStore.showError(e, t('team_detail.save_failed'))
  } finally {
    isSaving.value = false
  }
}
</script>

<template>
  <div class="team-detail-backdrop" @click.self="handleBack">
    <div class="team-detail-view">
      <div class="sheet-drag-handle" @click="handleBack" :title="t('team_drawer.close')"></div>
      <header class="app-header">
        <button class="btn-back" @click="handleBack">
          <span class="material-icons">arrow_back</span>
          {{ t('team_detail.back') }}
        </button>
        <div class="header-title">
          <h1>{{ t('team_detail.title', { team: teamNumber }) }}</h1>
        </div>
        <div class="header-right">
          <ConnectionStatus />
          <button class="btn-close" @click="handleBack" :title="t('team_drawer.close')">
            <span class="material-icons">close</span>
          </button>
        </div>
      </header>

      <main class="content-area">
      <!-- 战术标签卡片 -->
      <div class="team-tags-card">
        <h3>{{ t('tags.section_title') }}</h3>
        <TagPicker
          v-if="!isNaN(parseInt(teamNumber))"
          :event-id="eventId"
          :team-number="parseInt(teamNumber)"
        />
      </div>

      <!-- 展位侦察档案与吹牛指数对账卡片 -->
      <div class="team-tags-card pit-profile-card">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
          <h3 style="margin: 0; display: flex; align-items: center; gap: 6px;">
            <span class="material-icons" style="font-size: 18px; color: var(--primary, #39ff14);">precision_manufacturing</span>
            {{ t('pit_scout.detail_card.title') }}
          </h3>
          <button
            type="button"
            class="user-tag-btn"
            style="font-size: 12px; padding: 4px 12px;"
            @click="isPitDrawerOpen = true"
          >
            {{ unifiedTeam?.hasPitRecord ? t('pit_scout.detail_card.btn_edit') : t('pit_scout.detail_card.btn_add') }}
          </button>
        </div>

        <div v-if="unifiedTeam?.pitRecord" style="display: flex; flex-direction: column; gap: 12px;">
          <div style="display: flex; flex-wrap: wrap; gap: 6px;">
            <span class="spec-badge">{{ t('pit_scout.detail_card.spec_drivetrain', { val: formatDrivetrain(unifiedTeam.pitRecord.drivetrainType) }) }}</span>
            <span v-if="unifiedTeam.pitRecord.weightLbs" class="spec-badge">{{ t('pit_scout.detail_card.spec_weight', { val: unifiedTeam.pitRecord.weightLbs }) }}</span>
            <span v-if="unifiedTeam.pitRecord.ballCompatibility" class="spec-badge">{{ t('pit_scout.detail_card.spec_ball_compat', { val: formatBallCompat(unifiedTeam.pitRecord.ballCompatibility) }) }}</span>
            <span v-if="unifiedTeam.pitRecord.launcherType" class="spec-badge">{{ t('pit_scout.detail_card.spec_launcher', { val: unifiedTeam.pitRecord.launcherType }) }}</span>
            <span v-if="unifiedTeam.pitRecord.flowerMechanism" class="spec-badge">{{ t('pit_scout.detail_card.spec_flower', { val: unifiedTeam.pitRecord.flowerMechanism }) }}</span>
            <span v-if="unifiedTeam.pitRecord.hasColorSensor" class="spec-badge">{{ t('pit_scout.detail_card.spec_color_sensor', { val: t('pit_scout.detail_card.equipped') }) }}</span>
            <span class="spec-badge">{{ t('pit_scout.detail_card.spec_odometry', { val: formatOdometry(unifiedTeam.pitRecord.odometryType) }) }}</span>
            <span
              v-for="item in teamPitCustomSpecs"
              :key="item.field.fieldKey"
              class="spec-badge custom-spec-badge"
            >
              {{ item.field.name }}: {{ item.displayValue }}
            </span>
          </div>

          <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; background: rgba(255, 255, 255, 0.02); border: 1px solid var(--border); border-radius: 8px; padding: 10px;">
            <div style="display: flex; flex-direction: column; gap: 2px;">
              <span style="font-size: 11px; color: var(--muted-foreground);">{{ t('pit_scout.detail_card.claimed_calc_total') }}</span>
              <span style="font-size: 16px; font-weight: 700; color: var(--primary);">{{ unifiedTeam.pitRecord.claimedTotalScore }}</span>
              <span style="font-size: 10px; color: var(--muted-foreground);">{{ t('pit_scout.detail_card.claimed_auto_teleop', { auto: unifiedTeam.pitRecord.claimedAutoScore, teleop: unifiedTeam.pitRecord.claimedTeleopScore, cycles: unifiedTeam.pitRecord.claimedTeleopCycles || 0 }) }}</span>
            </div>
            <div style="display: flex; flex-direction: column; gap: 2px;">
              <span style="font-size: 11px; color: var(--muted-foreground);">{{ t('pit_scout.detail_card.actual_max_total') }}</span>
              <span style="font-size: 16px; font-weight: 700; color: var(--foreground);">{{ unifiedTeam.maxTotalScore ?? '-' }}</span>
              <span style="font-size: 10px; color: var(--muted-foreground);">{{ t('pit_scout.detail_card.actual_avg', { avg: unifiedTeam.avgTotalScore ?? '-' }) }}</span>
            </div>
            <div style="display: flex; flex-direction: column; gap: 2px;">
              <span style="font-size: 11px; color: var(--muted-foreground);">{{ t('pit_scout.detail_card.brag_rating') }}</span>
              <span v-if="unifiedTeam.bragInfo" style="font-size: 12px; font-weight: 700;">
                {{ detailBragLabel }}
              </span>
              <span v-else style="font-size: 12px; color: var(--muted-foreground);">-</span>
            </div>
          </div>
        </div>
        <div v-else style="font-size: 13px; color: var(--muted-foreground); padding: 8px 0;">
          {{ t('pit_scout.detail_card.no_pit_data') }}
        </div>
      </div>

      <!-- 自定义指标表现卡片 -->
      <div v-if="teamMatchCustomMetrics.length > 0" class="team-tags-card custom-metrics-card">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
          <h3 style="margin: 0; display: flex; align-items: center; gap: 6px;">
            <span class="material-icons" style="font-size: 18px; color: var(--primary, #39ff14);">tune</span>
            {{ t('custom_fields.team_metrics_title') }}
          </h3>
          <span class="metrics-count-badge">{{ t('custom_fields.renderer.metric_count', { count: teamMatchCustomMetrics.length }) }}</span>
        </div>

        <div class="custom-metrics-grid">
          <div
            v-for="metric in teamMatchCustomMetrics"
            :key="metric.definition.fieldKey"
            class="metric-box"
          >
            <div class="metric-header">
              <span class="metric-name">{{ metric.definition.name }}</span>
              <span class="metric-phase-tag">{{ t(`custom_fields.badge_phase_${metric.definition.phase}`) || metric.definition.phase }}</span>
            </div>

            <!-- Number / Level metric display -->
            <div v-if="metric.fieldType === 'number' || metric.fieldType === 'level'" class="metric-stat-row">
              <div class="stat-col">
                <span class="stat-label">{{ t('custom_fields.avg_metric') }}</span>
                <span class="stat-value highlight">{{ metric.avg !== null && metric.avg !== undefined ? metric.avg.toFixed(1) : '-' }}</span>
                <span v-if="metric.definition.unit" class="stat-unit">{{ metric.definition.unit }}</span>
              </div>
              <div class="stat-col">
                <span class="stat-label">{{ t('custom_fields.max_metric') }}</span>
                <span class="stat-value">{{ metric.max !== null && metric.max !== undefined ? metric.max : '-' }}</span>
                <span v-if="metric.definition.unit" class="stat-unit">{{ metric.definition.unit }}</span>
              </div>
              <div class="stat-col">
                <span class="stat-label">{{ t('custom_fields.renderer.matches_label') }}</span>
                <span class="stat-value count">{{ metric.totalCount }}</span>
              </div>
            </div>

            <!-- Boolean metric display -->
            <div v-else-if="metric.fieldType === 'boolean'" class="metric-stat-row">
              <div class="stat-col full">
                <div class="bool-rate-bar-wrapper">
                  <div class="bool-rate-label">
                    <span>{{ t('custom_fields.rate_occurrence') }}</span>
                    <span class="rate-num">{{ metric.rate?.toFixed(0) }}%</span>
                  </div>
                  <div class="rate-progress-track">
                    <div class="rate-progress-fill" :style="{ width: `${metric.rate || 0}%` }"></div>
                  </div>
                  <span class="stat-detail">{{ t('custom_fields.renderer.match_records_count', { recorded: metric.trueCount, total: metric.totalCount }) }}</span>
                </div>
              </div>
            </div>

            <!-- Select / Multi Select metric display -->
            <div v-else-if="metric.fieldType === 'select' || metric.fieldType === 'multi_select'" class="metric-distribution">
              <div
                v-for="opt in metric.distribution"
                :key="opt.label"
                class="dist-item"
              >
                <span class="dist-label-badge" :class="`color-${opt.color || 'blue'}`">{{ opt.label }}</span>
                <span class="dist-count">{{ t('custom_fields.renderer.times_count', { count: opt.count, percent: opt.percentage.toFixed(0) }) }}</span>
              </div>
            </div>

            <!-- Text metric display -->
            <div v-else-if="metric.fieldType === 'text'" class="metric-text-list">
              <div
                v-for="(entry, eIdx) in metric.textEntries?.slice(0, 3)"
                :key="eIdx"
                class="metric-text-bubble"
              >
                <span class="match-badge">#{{ entry.matchNumber }}</span>
                <span class="text-content">{{ entry.text }}</span>
              </div>
              <span v-if="(metric.textEntries?.length || 0) > 3" class="more-text-hint">
                {{ t('custom_fields.renderer.more_records', { count: (metric.textEntries?.length || 0) - 3 }) }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="teamMatches.length === 0" class="empty-state">
        <p>{{ t('team_detail.no_records') }}</p>
      </div>

      <div v-else class="matches-list">
        <div v-for="match in teamMatches" :key="match.id" class="match-card" :class="{ 'is-broken': match.isBroken }">
          <div class="match-header">
            <h3>{{ t('team_detail.match') }} #{{ getMatchLevelPrefix(match) }}{{ match.matchNumber }}</h3>
            <span v-if="match.isBroken" class="broken-badge">
              <span class="material-icons" style="font-size: 14px;">build</span>
              {{ t('team_detail.is_broken') }}
            </span>
          </div>

          <div class="score-grid">
            <div class="score-item">
              <span class="label">{{ t('history.auto') }}</span>
              <span class="value">{{ match.autoScore }}</span>
            </div>
            <div class="score-item">
              <span class="label">{{ t('history.teleop') }}</span>
              <span class="value">{{ match.teleopScore }}</span>
            </div>
            <div class="score-item">
              <span class="label">{{ t('history.endgame') }}</span>
              <span class="value">{{ match.endgameScore }}</span>
            </div>
            <div class="score-item total">
              <span class="label">{{ t('scouting.total_score') }}</span>
              <span class="value">{{ match.totalScore }}</span>
            </div>
          </div>

          <!-- 单场自定义字段徽章 -->
          <div v-if="getMatchCustomBadges(match).length > 0" class="match-custom-badges-row">
            <span
              v-for="badge in getMatchCustomBadges(match)"
              :key="badge.key"
              class="match-cf-badge"
              :class="`cf-color-${badge.color}`"
            >
              <span class="cf-name">{{ badge.name }}:</span>
              <span class="cf-val">{{ badge.value }}</span>
            </span>
          </div>

          <div class="comments-section">
            <div class="comments-label">
              <span class="material-icons" style="font-size: 16px;">chat_bubble_outline</span>
              {{ t('team_detail.comments') }}
              
              <button 
                v-if="editingMatchId !== match.id" 
                @click="startEditComment(match)" 
                class="btn-icon" 
                style="margin-left: auto;"
                title="Edit Evaluation"
              >
                <span class="material-icons" style="font-size: 16px;">edit</span>
              </button>
            </div>
            
            <div v-if="editingMatchId === match.id" class="edit-comment-area">
              <textarea 
                v-model="editCommentText" 
                class="edit-textarea" 
                rows="3" 
                :placeholder="t('team_detail.eval_placeholder')"
              ></textarea>
              <div class="edit-actions">
                <button @click="cancelEditComment" class="btn-cancel" :disabled="isSaving">{{ t('common.cancel') }}</button>
                <button @click="saveComment(match)" class="btn-save" :disabled="isSaving">{{ isSaving ? t('common.saving') : t('common.save') }}</button>
              </div>
            </div>
            <p v-else-if="match.notes" class="comments-text">{{ match.notes }}</p>
            <p v-else class="comments-text empty">{{ t('team_detail.no_evaluation') }}</p>
          </div>
        </div>
      </div>
    </main>
    </div>
    <PitScoutFormDrawer v-model="isPitDrawerOpen" :team-number="teamNumVal" />
  </div>
</template>

<style scoped>
.team-detail-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  z-index: 1000;
  display: flex;
  justify-content: center;
  align-items: flex-end;
}

.team-detail-view {
  height: 92vh;
  width: 100%;
  max-width: 840px;
  border-radius: 20px 20px 0 0;
  overflow: hidden;
  background: var(--card, #0a0a0a);
  border: 1px solid var(--border, #262626);
  border-bottom: none;
  display: flex;
  flex-direction: column;
  view-transition-name: modal-sheet;
  box-shadow: 0 -12px 40px rgba(0, 0, 0, 0.8), 0 0 24px rgba(57, 255, 20, 0.08);
}

.sheet-drag-handle {
  width: 40px;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.25);
  margin: 10px auto 4px;
  cursor: pointer;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out);
}

.sheet-drag-handle:hover {
  background: var(--primary, #39ff14);
}

.app-header {
  height: 56px;
  background: var(--card, #0a0a0a);
  border-bottom: 1px solid var(--border, #262626);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  position: sticky;
  top: 0;
  z-index: 100;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn-close {
  background: transparent;
  border: none;
  color: var(--muted-foreground, #a3a3a3);
  width: 36px;
  height: 36px;
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--motion-duration-fast) var(--motion-ease-out);
}

.btn-close:hover {
  background: var(--input, #1a1a1a);
  color: var(--foreground, #f1f5f9);
}

.btn-back {
  background: transparent;
  border: none;
  color: var(--muted-foreground);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px;
  border-radius: 8px;
  transition: all var(--motion-duration-fast) var(--motion-ease-out);
}

.btn-back:hover {
  background: var(--input);
  color: var(--foreground);
}

.header-title {
  flex: 1;
  text-align: center;
}

.header-title h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--primary);
}

.content-area {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 24px 16px 40px;
  max-width: 800px;
  width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
}

.content-area::-webkit-scrollbar {
  width: 6px;
}

.content-area::-webkit-scrollbar-track {
  background: transparent;
}

.content-area::-webkit-scrollbar-thumb {
  background: var(--border, #333);
  border-radius: 3px;
}

.content-area::-webkit-scrollbar-thumb:hover {
  background: var(--muted-foreground, #666);
}

.team-tags-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 20px;
}

.team-tags-card h3 {
  margin: 0 0 12px;
  font-size: 15px;
  font-weight: 600;
  color: var(--foreground);
}

.empty-state {
  text-align: center;
  padding: 48px;
  color: var(--muted-foreground);
}

.matches-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.match-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  transition: box-shadow 0.2s;
}

.match-card.is-broken {
  border-color: rgba(239, 68, 68, 0.3);
  background: rgba(239, 68, 68, 0.02);
}

.match-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 12px;
}

.match-header h3 {
  margin: 0;
  font-size: 16px;
  color: var(--foreground);
}

.broken-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--status-error);
  color: white;
  padding: 4px 8px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
}

.score-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}

.score-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  background: var(--background);
  padding: 12px 8px;
  border-radius: 8px;
  border: 1px solid var(--border);
}

.score-item .label {
  font-size: 12px;
  color: var(--muted-foreground);
  margin-bottom: 4px;
}

.score-item .value {
  font-size: 18px;
  font-weight: 700;
  color: var(--foreground);
}

.score-item.total .value {
  color: var(--primary);
}

.comments-section {
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}

.comments-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--muted-foreground);
  margin-bottom: 8px;
}

.comments-text {
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--foreground);
  white-space: pre-wrap;
}

.comments-text.empty {
  color: var(--muted-foreground);
  font-style: italic;
}

.btn-icon {
  background: transparent;
  border: none;
  color: var(--muted-foreground);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.btn-icon:hover {
  background: var(--input);
  color: var(--primary);
}

.edit-comment-area {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.edit-textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--input);
  color: var(--foreground);
  font-size: 14px;
  resize: vertical;
}

.edit-textarea:focus {
  outline: none;
  border-color: var(--primary);
}

.edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.btn-save {
  background: var(--primary);
  color: var(--primary-foreground);
  border: none;
  padding: 6px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
}

.btn-save:hover:not(:disabled) {
  filter: brightness(1.1);
}

.btn-cancel {
  background: transparent;
  color: var(--muted-foreground);
  border: 1px solid var(--border);
  padding: 6px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
}

.btn-cancel:hover:not(:disabled) {
  background: var(--card);
  color: var(--foreground);
}

@media (max-width: 600px) {
  .score-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

.spec-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--color-bg-subtle, #1f2937);
  color: var(--color-text-secondary, #d1d5db);
  border: 1px solid var(--color-border, #374151);
}

.pit-custom-specs-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}

.custom-spec-badge {
  border-color: rgba(57, 255, 20, 0.25);
  background: rgba(57, 255, 20, 0.05);
  color: var(--primary, #39ff14);
}

.custom-metrics-card {
  border-color: rgba(57, 255, 20, 0.2);
  background: linear-gradient(180deg, rgba(57, 255, 20, 0.02) 0%, var(--card) 100%);
}

.metrics-count-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--muted-foreground);
  border: 1px solid var(--border);
}

.custom-metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}

.metric-box {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.metric-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.metric-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.metric-phase-tag {
  font-size: 10px;
  text-transform: uppercase;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--muted-foreground);
}

.metric-stat-row {
  display: flex;
  gap: 8px;
}

.stat-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: rgba(0, 0, 0, 0.2);
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.04);
}

.stat-col.full {
  flex: 1 1 100%;
}

.stat-label {
  font-size: 10px;
  color: var(--muted-foreground);
}

.stat-value {
  font-size: 15px;
  font-weight: 700;
  color: var(--foreground);
}

.stat-value.highlight {
  color: var(--primary, #39ff14);
}

.stat-value.count {
  font-size: 13px;
  color: var(--muted-foreground);
}

.stat-unit {
  font-size: 10px;
  color: var(--muted-foreground);
}

.bool-rate-bar-wrapper {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.bool-rate-label {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--muted-foreground);
}

.bool-rate-label .rate-num {
  font-weight: 700;
  color: var(--primary, #39ff14);
}

.rate-progress-track {
  height: 6px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 3px;
  overflow: hidden;
}

.rate-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #38bdf8, #39ff14);
  border-radius: 3px;
  transition: width 0.3s ease;
}

.stat-detail {
  font-size: 10px;
  color: var(--muted-foreground);
  margin-top: 2px;
}

.metric-distribution {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dist-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
}

.dist-label-badge {
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid transparent;
}

.dist-label-badge.color-blue { background: rgba(56, 189, 248, 0.15); color: #38bdf8; border-color: rgba(56, 189, 248, 0.3); }
.dist-label-badge.color-green { background: rgba(57, 255, 20, 0.15); color: #39ff14; border-color: rgba(57, 255, 20, 0.3); }
.dist-label-badge.color-orange { background: rgba(251, 146, 60, 0.15); color: #fb923c; border-color: rgba(251, 146, 60, 0.3); }
.dist-label-badge.color-red { background: rgba(248, 113, 113, 0.15); color: #f87171; border-color: rgba(248, 113, 113, 0.3); }
.dist-label-badge.color-purple { background: rgba(192, 132, 252, 0.15); color: #c084fc; border-color: rgba(192, 132, 252, 0.3); }
.dist-label-badge.color-gray { background: rgba(148, 163, 184, 0.15); color: #94a3b8; border-color: rgba(148, 163, 184, 0.3); }

.dist-count {
  color: var(--muted-foreground);
  font-size: 11px;
}

.metric-text-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.metric-text-bubble {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 11px;
}

.metric-text-bubble .match-badge {
  font-weight: 700;
  color: var(--primary, #39ff14);
  font-size: 10px;
}

.metric-text-bubble .text-content {
  color: var(--foreground);
  word-break: break-word;
}

.more-text-hint {
  font-size: 10px;
  color: var(--muted-foreground);
  font-style: italic;
}

/* Match history custom badges */
.match-custom-badges-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px dashed var(--border);
}

.match-cf-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border);
}

.match-cf-badge .cf-name {
  color: var(--muted-foreground);
  font-size: 11px;
}

.match-cf-badge .cf-val {
  font-weight: 600;
  color: var(--foreground);
}

.match-cf-badge.cf-color-green { border-color: rgba(57, 255, 20, 0.3); background: rgba(57, 255, 20, 0.08); }
.match-cf-badge.cf-color-green .cf-val { color: #39ff14; }

.match-cf-badge.cf-color-blue { border-color: rgba(56, 189, 248, 0.3); background: rgba(56, 189, 248, 0.08); }
.match-cf-badge.cf-color-blue .cf-val { color: #38bdf8; }

.match-cf-badge.cf-color-purple { border-color: rgba(192, 132, 252, 0.3); background: rgba(192, 132, 252, 0.08); }
.match-cf-badge.cf-color-purple .cf-val { color: #c084fc; }

.match-cf-badge.cf-color-orange { border-color: rgba(251, 146, 60, 0.3); background: rgba(251, 146, 60, 0.08); }
.match-cf-badge.cf-color-orange .cf-val { color: #fb923c; }

.match-cf-badge.cf-color-red { border-color: rgba(248, 113, 113, 0.3); background: rgba(248, 113, 113, 0.08); }
.match-cf-badge.cf-color-red .cf-val { color: #f87171; }
</style>
