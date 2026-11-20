<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRouter, onBeforeRouteLeave } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useRecordStore } from '@/stores/records'
import { useConnectionStore } from '@/stores/connection'
import { useEventStore } from '@/stores/events'
import { useUserStore } from '@/stores/user'
import { useToastStore } from '@/stores/toast'
import { syncRecords } from '@/services/api'
import TagPicker from '@/components/common/TagPicker.vue'
import ConnectionStatus from '@/components/common/ConnectionStatus.vue'
import { usePitScoutStore } from '@/stores/pitScout'
import { useCustomFieldsStore } from '@/stores/customFields'
import PitScoutFormDrawer from '@/components/pit/PitScoutFormDrawer.vue'
import type { ScoutingRecord } from '@/types'
import { sortRecordsChronologically, getMatchLevelPrefix } from '@/utils/tournament'
import { parseScoutRawData } from '@/utils/analytics/rankings'
import { calcMatchPredictCycleTime, aggregateTeamPredictCycleStats } from '@/utils/analytics/predictCycleTime'
import TeamPitProfileCard from './components/TeamPitProfileCard.vue'
import TeamCustomMetricsCard from './components/TeamCustomMetricsCard.vue'
import {
  computeTeamMatchCustomMetrics,
  computeTeamPitCustomSpecs,
  buildMatchCustomBadges
} from './composables/useTeamCustomMetrics'

const props = defineProps<{
  eventId: string
  teamNumber: string
}>()

const router = useRouter()
const { t } = useI18n()
const recordStore = useRecordStore()
const pitStore = usePitScoutStore()
const customFieldsStore = useCustomFieldsStore()
const eventStore = useEventStore()
const userStore = useUserStore()
const connStore = useConnectionStore()
const toastStore = useToastStore()
const isPitDrawerOpen = ref(false)

const teamNumVal = computed(() => parseInt(props.teamNumber))
const unifiedTeam = computed(() => isNaN(teamNumVal.value) ? undefined : pitStore.getUnifiedTeam(teamNumVal.value))

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

const activeMatchFields = computed(() => {
  return props.eventId ? customFieldsStore.getActiveFields(props.eventId, 'MATCH') : []
})

const activePitFields = computed(() => {
  return props.eventId ? customFieldsStore.getActiveFields(props.eventId, 'PIT') : []
})

const teamMatchCustomMetrics = computed(() => {
  return computeTeamMatchCustomMetrics(activeMatchFields.value, teamMatches.value)
})

const teamPitCustomSpecs = computed(() => {
  return computeTeamPitCustomSpecs(activePitFields.value, unifiedTeam.value?.pitRecord, t)
})

function getMatchCustomBadges(match: ScoutingRecord) {
  return buildMatchCustomBadges(activeMatchFields.value, match, t)
}

const teamPredictStats = computed(() => {
  return aggregateTeamPredictCycleStats(
    teamMatches.value.map(match => {
      const parsed = parseScoutRawData(match.rawData)
      return {
        teleopCycles: parsed.teleopCycles,
        teleopCycleTimestamps: parsed.teleopCycleTimestamps,
        isBroken: match.isBroken
      }
    })
  )
})

function getMatchBiobuzzMeta(match: ScoutingRecord) {
  const parsed = parseScoutRawData(match.rawData)
  const predictCycleSec =
    parsed.predictCycleTimeSec ??
    calcMatchPredictCycleTime(parsed.teleopCycles, parsed.teleopCycleTimestamps)
  return {
    teleopCyclesCount: parsed.teleopCycles.length,
    endgame: parsed.endgame,
    predictCycleSec
  }
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
      if (recordsToPush && recordsToPush.length > 0) {
        const deduplicatedRecords = Array.from(new Map(recordsToPush.map((r) => [r.id, r])).values())
        if (eventStore.isHost && !connStore.isStandbyHost) {
          for (const r of deduplicatedRecords) {
            r.hostSeq = undefined
          }
          connStore.stampHostSeq(deduplicatedRecords)
          try {
            await syncRecords(deduplicatedRecords)
          } catch (e) {
            console.error('[TeamDetailView] Failed to sync stamped records to DB:', e)
          }
          connStore.pushIfNeeded(deduplicatedRecords)
        } else {
          // 非主机客户端：只推送属于自己的记录！绝不越权推送其他人被 reassessConflicts 影响的记录
          const myOnlyRecords = deduplicatedRecords.filter((r) => r.scoutId === userStore.userId)
          if (myOnlyRecords.length > 0) {
            connStore.pushIfNeeded(myOnlyRecords)
          }
        }
      }
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
        <button class="btn-back" @click="handleBack" :aria-label="t('team_detail.back')" :title="t('team_detail.back')">
          <span class="material-icons">arrow_back</span>
          <span class="btn-back-text">{{ t('team_detail.back') }}</span>
        </button>
        <div class="header-title">
          <h1>{{ t('team_detail.title', { team: teamNumber }) }}</h1>
        </div>
        <div class="header-right">
          <ConnectionStatus />
          <button class="btn-close" @click="handleBack" :aria-label="t('team_drawer.close')" :title="t('team_drawer.close')">
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
        <TeamPitProfileCard
          :unified-team="unifiedTeam"
          :team-pit-custom-specs="teamPitCustomSpecs"
          @open-pit-drawer="isPitDrawerOpen = true"
        />

        <!-- 自定义指标表现卡片 -->
        <TeamCustomMetricsCard :metrics="teamMatchCustomMetrics" />

        <div v-if="teamMatches.length === 0" class="empty-state">
          <p>{{ t('team_detail.no_records') }}</p>
        </div>

        <div v-else class="matches-list">
          <div class="team-predict-banner">
            <span class="predict-banner-label">
              <span class="material-icons" style="font-size: 16px; color: var(--status-info);">speed</span>
              {{ t('rankings.predict_cycle_time') }}:
            </span>
            <strong v-if="teamPredictStats.predictCycleTime !== null" class="predict-banner-val">
              {{ t('rankings.predict_cycle_time_unit', { sec: teamPredictStats.predictCycleTime }) }}
              <span class="predict-banner-sub">
                ({{ t('rankings.predict_cycle_spread', { sec: teamPredictStats.predictCycleSpread ?? 0 }) }} · {{ t('rankings.estimated_max_cycles_unit', { cycles: teamPredictStats.estimatedMaxCycles ?? 0 }) }} · {{ t('rankings.predict_cycle_matches_count', { count: teamPredictStats.predictCycleMatches }) }})
              </span>
            </strong>
            <span v-else class="predict-banner-sub">{{ t('rankings.predict_cycle_insufficient') }}</span>
          </div>

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

            <!-- BIOBUZZ Endgame & Cycle Breakdown Badges -->
            <div
              v-if="
                getMatchBiobuzzMeta(match).endgame.flowerNectars > 0 ||
                getMatchBiobuzzMeta(match).endgame.flowerPollens > 0 ||
                getMatchBiobuzzMeta(match).endgame.gardenBalls > 0 ||
                getMatchBiobuzzMeta(match).endgame.teleopPark ||
                getMatchBiobuzzMeta(match).endgame.flowerDescore ||
                getMatchBiobuzzMeta(match).endgame.g410EarlyFlowerFoul ||
                getMatchBiobuzzMeta(match).predictCycleSec !== null ||
                getMatchBiobuzzMeta(match).teleopCyclesCount > 0
              "
              class="match-custom-badges-row"
            >
              <span v-if="getMatchBiobuzzMeta(match).endgame.flowerNectars > 0" class="match-cf-badge cf-color-purple">
                <span class="cf-name">Nectar:</span>
                <span class="cf-val">{{ getMatchBiobuzzMeta(match).endgame.flowerNectars }}</span>
              </span>
              <span v-if="getMatchBiobuzzMeta(match).endgame.flowerBottomBonusCount > 0" class="match-cf-badge cf-color-green">
                <span class="cf-name">Bottom Bonus:</span>
                <span class="cf-val">{{ getMatchBiobuzzMeta(match).endgame.flowerBottomBonusCount }}</span>
              </span>
              <span v-if="getMatchBiobuzzMeta(match).endgame.flowerPollens > 0" class="match-cf-badge cf-color-orange">
                <span class="cf-name">Pollen:</span>
                <span class="cf-val">{{ getMatchBiobuzzMeta(match).endgame.flowerPollens }}</span>
              </span>
              <span v-if="getMatchBiobuzzMeta(match).endgame.gardenBalls > 0" class="match-cf-badge cf-color-green">
                <span class="cf-name">Garden:</span>
                <span class="cf-val">{{ getMatchBiobuzzMeta(match).endgame.gardenBalls }}</span>
              </span>
              <span v-if="getMatchBiobuzzMeta(match).endgame.teleopPark" class="match-cf-badge cf-color-blue">
                <span class="cf-val">Park +5</span>
              </span>
              <span v-if="getMatchBiobuzzMeta(match).endgame.flowerDescore" class="match-cf-badge cf-color-purple">
                <span class="cf-val">Descore</span>
              </span>
              <span v-if="getMatchBiobuzzMeta(match).endgame.g410EarlyFlowerFoul" class="match-cf-badge cf-color-orange">
                <span class="cf-val">G410 Foul</span>
              </span>
              <span v-if="getMatchBiobuzzMeta(match).predictCycleSec !== null" class="match-cf-badge cf-color-blue">
                <span class="cf-name">{{ t('scouting.predict_cycle_time') }}:</span>
                <span class="cf-val">{{ getMatchBiobuzzMeta(match).predictCycleSec }}s</span>
              </span>
              <span v-else-if="getMatchBiobuzzMeta(match).teleopCyclesCount > 0" class="match-cf-badge">
                <span class="cf-name">{{ t('scouting.predict_cycle_time') }}:</span>
                <span class="cf-val">{{ t('rankings.predict_cycle_insufficient_short') }}</span>
              </span>
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
  background: color-mix(in srgb, var(--g-950) 65%, transparent);
  backdrop-filter: blur(4px);
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
  background: var(--popover);
  border: 1px solid var(--border-strong);
  border-bottom: none;
  display: flex;
  flex-direction: column;
  view-transition-name: modal-sheet;
  box-shadow: var(--shadow-3);
}

.sheet-drag-handle {
  width: 40px;
  height: 4px;
  border-radius: 2px;
  background: var(--g-600);
  margin: 10px auto 4px;
  cursor: pointer;
  flex-shrink: 0;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out);
}

.sheet-drag-handle:hover {
  background: var(--primary);
}

.app-header {
  min-height: 56px;
  height: auto;
  background: var(--g-900);
  border-bottom: 1px solid var(--g-750);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 16px;
  position: sticky;
  top: 0;
  z-index: 100;
  flex-shrink: 0;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.btn-close {
  background: transparent;
  border: none;
  color: var(--muted-foreground);
  width: 36px;
  height: 36px;
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out),
              color var(--motion-duration-fast) var(--motion-ease-out);
}

.btn-close:hover {
  background: var(--surface-hover);
  color: var(--foreground);
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
  flex-shrink: 0;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out),
              color var(--motion-duration-fast) var(--motion-ease-out);
}

.btn-back:hover {
  background: var(--surface-hover);
  color: var(--foreground);
}

.header-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-align: center;
}

.header-title h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--g-50);
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
  background: var(--border);
  border-radius: 3px;
}

.content-area::-webkit-scrollbar-thumb:hover {
  background: var(--g-500);
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
  transition: border-color var(--motion-duration-fast) var(--motion-ease-out);
}

.match-card.is-broken {
  border-color: var(--status-error-border);
  background: color-mix(in srgb, var(--status-error-bg) 35%, var(--card));
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
  font-variant-numeric: tabular-nums;
  color: var(--foreground);
}

.broken-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--status-error-bg);
  border: 1px solid var(--status-error-border);
  color: var(--status-error);
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
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
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
  background: var(--s-300);
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
  .app-header {
    min-height: 52px;
    height: auto;
    gap: 6px;
    padding: 8px 10px;
  }
  .btn-back {
    padding: 6px;
    width: 32px;
    height: 32px;
    justify-content: center;
  }
  .btn-back-text {
    display: none;
  }
  .btn-close {
    width: 32px;
    height: 32px;
  }
  .header-title {
    text-align: left;
  }
  .header-title h1 {
    font-size: 14px;
    line-height: 1.25;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .header-right {
    gap: 6px;
  }
  .header-right :deep(.status-container) {
    gap: 4px;
  }
  .header-right :deep(.connection-status) {
    padding: 4px 7px;
    gap: 4px;
    font-size: 11px;
  }
  .header-right :deep(.status-icon) {
    font-size: 14px;
  }
  .header-right :deep(.reconnect-btn) {
    padding: 4px 7px;
    font-size: 11px;
  }
  .score-grid {
    grid-template-columns: repeat(2, 1fr);
  }
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
  background: var(--surface-recessed);
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

.match-cf-badge.cf-color-green { border-color: var(--status-success-border); background: var(--status-success-bg); }
.match-cf-badge.cf-color-green .cf-val { color: var(--status-success); }

.match-cf-badge.cf-color-blue { border-color: var(--status-info-border); background: var(--status-info-bg); }
.match-cf-badge.cf-color-blue .cf-val { color: var(--status-info); }

.match-cf-badge.cf-color-purple { border-color: var(--status-ai-border); background: var(--status-ai-bg); }
.match-cf-badge.cf-color-purple .cf-val { color: var(--status-ai); }

.match-cf-badge.cf-color-orange { border-color: var(--status-warning-border); background: var(--status-warning-bg); }
.match-cf-badge.cf-color-orange .cf-val { color: var(--status-warning); }

.match-cf-badge.cf-color-red { border-color: var(--status-error-border); background: var(--status-error-bg); }
.match-cf-badge.cf-color-red .cf-val { color: var(--status-error); }

.team-predict-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px;
  margin-bottom: 12px;
  border-radius: 10px;
  background: var(--status-info-bg);
  border: 1px solid var(--status-info-border);
  font-size: 13px;
}

.predict-banner-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--foreground);
  font-weight: 600;
}

.predict-banner-val {
  color: var(--status-info);
  font-variant-numeric: tabular-nums;
}

.predict-banner-sub {
  font-weight: 500;
  font-size: 12px;
  color: var(--muted-foreground);
  margin-left: 4px;
}
</style>
