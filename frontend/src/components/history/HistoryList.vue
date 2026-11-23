<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { ScoutingRecord } from '@/types'
import { useRecordStore } from '@/stores/records'
import { useUserStore } from '@/stores/user'
import { useConnectionStore } from '@/stores/connection'
import { useEventStore } from '@/stores/events'
import { useToastStore } from '@/stores/toast'
import { hapticLight, hapticSuccess, hapticWarning } from '@/utils/haptics'
import { getRecordTournamentLevel, sortRecordsChronologically } from '@/utils/tournament'
import { parseScoutRawData } from '@/utils/analytics/rankings'
import { calcMatchPredictCycleTime } from '@/utils/analytics/predictCycleTime'
import {
  getExistingEventCrdt,
  signScoutingRecordWithDeviceKey,
  withLocalCrdtWrite,
  writeScoutingRecordToCrdt
} from '@/services/crdt'

const { t } = useI18n()
const recordStore = useRecordStore()
const userStore = useUserStore()
const connStore = useConnectionStore()
const eventStore = useEventStore()
const toastStore = useToastStore()

const props = defineProps<{
  records: ScoutingRecord[]
  loading: boolean
}>()

const emit = defineEmits<{
  (e: 'editRecord', record: ScoutingRecord): void
}>()

const route = useRoute()
const highlightMatch = computed(() => Number(route.query.highlightMatch))
const highlightTeam = computed(() => Number(route.query.highlightTeam))
const highlightLevel = computed(() => route.query.highlightLevel ? String(route.query.highlightLevel).toUpperCase() : null)

function isConflictHighlighted(rec: ScoutingRecord) {
  if (highlightMatch.value !== rec.matchNumber || highlightTeam.value !== rec.teamNumber) return false
  if (highlightLevel.value) {
    return getRecordTournamentLevel(rec) === highlightLevel.value
  }
  return true
}

const sortedRecords = computed(() => sortRecordsChronologically(props.records))

const hasScrolled = ref(false)

// Reset scroll flag if the URL highlight targets change
watch([highlightMatch, highlightTeam, highlightLevel], () => {
  hasScrolled.value = false
})

watch([highlightMatch, highlightTeam, highlightLevel, () => sortedRecords.value], async ([m, t]) => {
  if (m && t && !hasScrolled.value && sortedRecords.value.length > 0) {
    await nextTick()
    const targetRec = sortedRecords.value.find(r => 
      r.matchNumber === m && 
      r.teamNumber === t && 
      (!highlightLevel.value || getRecordTournamentLevel(r) === highlightLevel.value)
    )
    if (targetRec) {
      const el = document.getElementById('history-card-' + targetRec.id)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        hasScrolled.value = true
      }
    }
  }
}, { immediate: true })

function isRecordSynced(rec: ScoutingRecord): boolean {
  return rec.syncStatus === 'SYNCED'
}

function syncIcon(rec: ScoutingRecord): string {
  return isRecordSynced(rec) ? 'check_circle' : 'hourglass_empty'
}

function syncTooltip(rec: ScoutingRecord): string {
  return isRecordSynced(rec)
    ? t('history.sync_synced')
    : t('history.sync_pending')
}

function canEditRecord(rec: ScoutingRecord): boolean {
  // 1. Host 账户：拥有最高管理权限，可以更改任何一个人的记录（无论是否已同步）
  if (eventStore.isHost) return true

  // 获取当前登录用户 ID（优先 store，备选 localStorage）
  const currentUserId = userStore.userId || (() => {
    try {
      const cached = localStorage.getItem('scoutingpro-user')
      return cached ? (JSON.parse(cached)?.id || '') : ''
    } catch {
      return ''
    }
  })()

  // 2. 如果存在当前用户 ID，且记录明确属于其他人，普通 Scout 绝不允许编辑（包括冲突记录）！
  if (currentUserId && rec.scoutId && rec.scoutId !== currentUserId) {
    return false
  }

  // 3. 普通 Scout 账户只能编辑属于自己的记录（无论是否已同步或是否冲突）
  if (currentUserId && rec.scoutId === currentUserId) return true

  // 4. 无用户态环境（如未设用户状态的轻量单测）：尚未权威同步的记录或冲突记录允许编辑
  if (!currentUserId) {
    if (!isRecordSynced(rec)) return true
    if (rec.isConflict) return true
  }

  return false
}

function startEdit(record: ScoutingRecord) {
  if (!canEditRecord(record)) return
  emit('editRecord', record)
}

function canShowResync(rec: ScoutingRecord): boolean {
  return (!eventStore.isHost || connStore.isStandbyHost) && !isRecordSynced(rec) && rec.scoutId === userStore.userId
}

async function retrySyncRecord(record: ScoutingRecord) {
  hapticLight()
  record.syncStatus = 'PENDING'
  if (!connStore.isConnected) {
    hapticWarning()
    toastStore.showToast(t('history.resync_offline_queued'), 'warning')
    return
  }

  if (!record.authorSig || !record.authorPubKey) {
    await signScoutingRecordWithDeviceKey(record)
  }
  if (!record.authorSig || !record.authorPubKey) {
    hapticWarning()
    toastStore.showToast(t('history.resync_offline_queued'), 'warning')
    return
  }

  const crdtHandle = record.eventId ? getExistingEventCrdt(record.eventId) : undefined
  if (record.eventId && crdtHandle) {
    withLocalCrdtWrite(record.eventId, () => {
      writeScoutingRecordToCrdt(crdtHandle.store, record)
    })
  }

  const synced = await connStore.triggerCrdtSync('host')
  if (synced) {
    await recordStore.markSynced([record.id])
    hapticSuccess()
    toastStore.showToast(t('history.resync_triggered'), 'info')
  } else {
    hapticWarning()
    toastStore.showToast(t('history.resync_offline_queued'), 'warning')
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString()
}

function getScoutDisplayName(rec: ScoutingRecord): string {
  if (rec.scoutName && rec.scoutName.trim()) {
    return rec.scoutName.trim()
  }
  if (rec.scoutId && rec.scoutId === userStore.userId && userStore.username) {
    return userStore.username
  }
  const peer = connStore.connectedScouts?.find(s => s.id === rec.scoutId)
  if (peer && peer.name) {
    return peer.name
  }
  return t('history.anonymous_scout')
}

function getMatchSummaryMeta(rec: ScoutingRecord) {
  const parsed = parseScoutRawData(rec.rawData)
  const e = parsed.endgame
  const predictCycleSec =
    parsed.predictCycleTimeSec ??
    calcMatchPredictCycleTime(parsed.teleopCycles, parsed.teleopCycleTimestamps)
  const hasBiobuzzDetails =
    e.teleopPark ||
    e.flowerNectars > 0 ||
    e.flowerBottomBonusCount > 0 ||
    e.flowerPollens > 0 ||
    e.gardenBalls > 0 ||
    e.flowerDescore ||
    e.g410EarlyFlowerFoul ||
    predictCycleSec !== null
  return {
    endgame: e,
    predictCycleSec,
    hasBiobuzzDetails
  }
}

const highlightTop = ref(0)
const highlightHeight = ref(0)
const highlightVisible = ref(false)

function onCardEnter(e: MouseEvent) {
  const target = e.currentTarget as HTMLElement
  if (target) {
    highlightTop.value = target.offsetTop
    highlightHeight.value = target.offsetHeight
    highlightVisible.value = true
  }
}

function onListLeave() {
  highlightVisible.value = false
}

const highlightStyle = computed(() => ({
  top: `${highlightTop.value}px`,
  height: `${highlightHeight.value}px`,
  opacity: highlightVisible.value ? 1 : 0
}))

// Staggered Entrance Handlers
function beforeEnter(el: Element) {
  const htmlEl = el as HTMLElement
  htmlEl.style.opacity = '0'
  htmlEl.style.transform = 'translateY(20px)'
}

function enter(el: Element, done: () => void) {
  const htmlEl = el as HTMLElement
  const index = parseInt(htmlEl.dataset.index || '0', 10)
  const delay = Math.min(index, 10) * 40

  requestAnimationFrame(() => {
    setTimeout(() => {
      htmlEl.style.setProperty('transition', 'all var(--motion-duration-normal) var(--motion-ease-out)', 'important')
      htmlEl.style.opacity = '1'
      htmlEl.style.transform = 'translateY(0)'

      setTimeout(() => {
        htmlEl.style.removeProperty('transition')
        htmlEl.style.removeProperty('opacity')
        htmlEl.style.removeProperty('transform')
        done()
      }, 360)
    }, delay)
  })
}
</script>

<template>
  <div class="history-panel">
    <div v-if="loading" class="loading-msg">{{ t('history.loading') }}</div>
    <div v-else-if="sortedRecords.length === 0" class="empty-state">
      <p>{{ t('history.no_data') }}</p>
    </div>
    <transition-group 
      v-else 
      class="history-list" 
      tag="div" 
      appear 
      :css="false"
      @before-enter="beforeEnter" 
      @enter="enter" 
      @before-appear="beforeEnter"
      @appear="enter"
      style="position: relative;" 
      @mouseleave="onListLeave"
    >
      <div class="hover-highlight" :style="highlightStyle" key="highlight-bg"></div>
      <div
        v-for="(rec, index) in sortedRecords"
        :key="rec.id"
        :data-index="index"
        :data-scout-id="rec.scoutId"
        :id="'history-card-' + rec.id"
        class="history-card"
        :class="{ 
          'highlight-conflict': isConflictHighlighted(rec),
          'is-conflict-card': rec.isConflict
        }"
        @mouseenter="onCardEnter"
      >
        <div class="card-main">
          <div class="card-info">
            <span class="card-teams">
              {{ t('history.match') }} #{{ (getRecordTournamentLevel(rec) === 'PLAYOFF' ? 'P' : 'Q') }}{{ rec.matchNumber }} | {{ t('history.team') }} #{{ rec.teamNumber }}
            </span>
            <div class="card-meta">
              <span class="card-date">{{ formatDate(rec.createdAt) }}</span>
              <span v-if="rec.scoutId || rec.scoutName" class="card-scout-id" :title="getScoutDisplayName(rec)">
                <span class="material-icons scout-meta-icon">person</span>
                <span class="scout-meta-name">{{ getScoutDisplayName(rec) }}</span>
              </span>
            </div>
          </div>
          <div class="card-right">
            <span
              v-if="recordStore.scoutReliability[rec.scoutId] === 'low'"
              class="material-icons"
              style="font-size: 18px; color: var(--status-error); margin-right: 4px;"
              title="Low Reliability: High deviation from official scores"
            >warning</span>
            <span class="card-score">{{ rec.totalScore }} {{ t('history.pts') }}</span>
            <span
              class="sync-badge material-icons"
              :class="{ 'is-synced': isRecordSynced(rec), 'is-pending': !isRecordSynced(rec) }"
              style="font-size: 18px; vertical-align: bottom;"
              :title="syncTooltip(rec)"
            >{{ syncIcon(rec) }}</span>
          </div>
        </div>

        <div v-if="rec.isConflict" class="conflict-badge">
          <span class="material-icons">error_outline</span> {{ t('toast.conflict_badge') }}
        </div>

        <!-- Quick detail -->
        <div class="card-detail">
          <span>{{ t('history.auto') }}: {{ rec.autoScore }} {{ t('history.pts') }}</span>
          <span>{{ t('history.teleop') }}: {{ rec.teleopScore }} {{ t('history.pts') }}</span>
          <span>{{ t('history.endgame') }}: {{ rec.endgameScore }} {{ t('history.pts') }}</span>
        </div>

        <div v-if="getMatchSummaryMeta(rec).hasBiobuzzDetails" class="card-biobuzz-pills">
          <span v-if="getMatchSummaryMeta(rec).endgame.flowerNectars > 0" class="biobuzz-pill">
            N {{ getMatchSummaryMeta(rec).endgame.flowerNectars }}
            <template v-if="getMatchSummaryMeta(rec).endgame.flowerBottomBonusCount > 0">
              (B{{ getMatchSummaryMeta(rec).endgame.flowerBottomBonusCount }})
            </template>
          </span>
          <span v-if="getMatchSummaryMeta(rec).endgame.flowerPollens > 0" class="biobuzz-pill">
            P {{ getMatchSummaryMeta(rec).endgame.flowerPollens }}
          </span>
          <span v-if="getMatchSummaryMeta(rec).endgame.gardenBalls > 0" class="biobuzz-pill">
            G {{ getMatchSummaryMeta(rec).endgame.gardenBalls }}
          </span>
          <span v-if="getMatchSummaryMeta(rec).endgame.teleopPark" class="biobuzz-pill is-park">
            Park +5
          </span>
          <span v-if="getMatchSummaryMeta(rec).endgame.flowerDescore" class="biobuzz-pill is-descore">
            Descore
          </span>
          <span v-if="getMatchSummaryMeta(rec).endgame.g410EarlyFlowerFoul" class="biobuzz-pill is-foul">
            G410
          </span>
          <span v-if="getMatchSummaryMeta(rec).predictCycleSec !== null" class="biobuzz-pill is-cycle">
            {{ t('scouting.predict_cycle_time') }}: {{ getMatchSummaryMeta(rec).predictCycleSec }}s
          </span>
        </div>

        <!-- Edit & Resync buttons -->
        <div v-if="canEditRecord(rec) || canShowResync(rec)" class="card-actions">
          <button
            v-if="canEditRecord(rec)"
            class="btn-edit"
            :class="{ 'btn-edit-conflict': rec.isConflict }"
            @click="startEdit(rec)"
          >
            <span class="material-icons" style="font-size: 16px; margin-right: 4px;">edit</span> {{ t('history.btn_edit') }}
          </button>

          <button
            v-if="canShowResync(rec)"
            type="button"
            class="btn-resync"
            @click="retrySyncRecord(rec)"
            :title="connStore.isConnected ? t('history.btn_resync') : t('history.resync_offline_queued')"
          >
            <span class="material-icons" style="font-size: 16px; margin-right: 4px;">sync</span> {{ t('history.btn_resync') }}
          </button>
        </div>
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
.history-panel {
  max-width: 640px;
  margin: 0 auto;
}

.loading-msg,
.empty-state {
  text-align: center;
  padding: 48px;
  color: var(--muted-foreground);
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.history-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px 20px;
}

.hover-highlight {
  position: absolute;
  left: -4px;
  right: -4px;
  background: color-mix(in srgb, var(--g-50) 4%, transparent);
  border: 1px solid var(--border-subtle);
  pointer-events: none;
  transition: top var(--motion-duration-moderate) var(--motion-ease-out), height var(--motion-duration-moderate) var(--motion-ease-out), opacity var(--motion-duration-fast) var(--motion-ease-out);
  z-index: 10;
  border-radius: 14px;
}



.history-card.highlight-conflict,
.history-card.is-conflict-card {
  border-color: var(--status-error) !important;
  animation: pulse-conflict 2.5s infinite ease-in-out;
  background-color: var(--status-error-bg);
}

@keyframes pulse-conflict {
  0%, 100% { opacity: 1; border-color: var(--status-error); }
  50% { opacity: 0.85; border-color: var(--status-error-border); }
}

.conflict-badge {
  color: var(--status-error);
  font-weight: 700;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 10px;
}

.conflict-badge .material-icons {
  font-size: 16px;
}

.btn-edit-conflict {
  background: var(--status-error) !important;
  color: var(--destructive-foreground) !important;
}

.btn-edit-conflict:hover {
  background: color-mix(in srgb, var(--status-error) 85%, var(--g-950)) !important;
}

.history-card.editing {
  border-color: var(--primary);
}

.card-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.card-teams {
  font-weight: 600;
  font-size: 15px;
}

.card-date {
  font-size: 12px;
  color: var(--muted-foreground);
}

.card-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 2px;
}

.card-scout-id {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  color: var(--muted-foreground);
  background: var(--surface-elevated);
  border: 1px solid var(--border);
  padding: 1px 6px;
  border-radius: 4px;
}

.scout-meta-icon {
  font-size: 13px;
  color: var(--primary);
}

.scout-meta-text {
  font-family: var(--font-mono);
}

.scout-meta-name {
  color: var(--foreground);
  font-weight: 500;
  margin-left: 2px;
}

.card-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.card-score {
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
  font-size: 20px;
  font-weight: 800;
  color: var(--primary);
}

.sync-badge {
  font-size: 18px;
  cursor: default;
}

.card-detail {
  display: flex;
  gap: 16px;
  margin-top: 10px;
  font-size: 12px;
  color: var(--muted-foreground);
}

.card-actions {
  margin-top: 10px;
  display: flex;
  gap: 8px;
}

.btn-edit,
.btn-save,
.btn-cancel {
  padding: 6px 14px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out),
              border-color var(--motion-duration-fast) var(--motion-ease-out),
              color var(--motion-duration-fast) var(--motion-ease-out);
}

.btn-edit {
  background: var(--surface-elevated);
  border: 1px solid var(--border-strong);
  color: var(--foreground);
}

.btn-edit:hover {
  background: var(--surface-hover);
  border-color: var(--g-500);
}

.btn-save {
  background: var(--primary);
  color: var(--on-primary);
  font-weight: 700;
}

.btn-save:hover {
  background: var(--s-300);
}

.btn-cancel {
  background: var(--surface-elevated);
  border: 1px solid var(--border-strong);
  color: var(--muted-foreground);
}

.btn-cancel:hover {
  background: var(--surface-hover);
  color: var(--foreground);
}

.sync-badge.is-synced {
  color: var(--status-success);
}

.sync-badge.is-pending {
  color: var(--status-warning);
}

.btn-resync {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 14px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid var(--status-warning-border);
  background: var(--status-warning-bg);
  color: var(--status-warning);
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out),
              border-color var(--motion-duration-fast) var(--motion-ease-out),
              transform var(--motion-duration-fast) var(--motion-ease-out);
}

.btn-resync:hover {
  background: color-mix(in srgb, var(--status-warning) 22%, transparent);
  border-color: var(--status-warning);
}

.btn-resync:active {
  transform: scale(0.97);
}

.card-biobuzz-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.biobuzz-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  background: var(--surface-elevated);
  border: 1px solid var(--border);
  color: var(--foreground);
}

.biobuzz-pill.is-park {
  border-color: var(--status-info-border);
  color: var(--status-info);
}

.biobuzz-pill.is-cycle {
  border-color: var(--status-success-border);
  color: var(--status-success);
}

.biobuzz-pill.is-descore {
  border-color: var(--status-ai-border);
  color: var(--status-ai);
}

.biobuzz-pill.is-foul {
  border-color: var(--status-warning-border);
  background: var(--status-warning-bg);
  color: var(--status-warning);
}
</style>

