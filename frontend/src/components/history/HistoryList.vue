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
  // 在 Host 端，只要状态为 SYNCED 即为权威落库
  if (eventStore.isHost) return rec.syncStatus === 'SYNCED'
  // 在 Client 端，必须同时满足 SYNCED 且获得 Host 分配的权威序号 hostSeq
  return rec.syncStatus === 'SYNCED' && Boolean(rec.hostSeq)
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
  // 2. 普通 Scout 账户：每个用户可以更改属于自己的记录（无论是否已同步）
  if (userStore.userId && rec.scoutId === userStore.userId) return true
  // 3. 尚未权威同步/落库的记录（本地待确认记录）：允许编辑修正
  if (!isRecordSynced(rec)) return true
  // 4. 冲突记录：发生冲突时允许发起纠错编辑
  if (rec.isConflict) return true
  return false
}

function startEdit(record: ScoutingRecord) {
  if (!canEditRecord(record)) return
  emit('editRecord', record)
}

function retrySyncRecord(record: ScoutingRecord) {
  hapticLight()
  record.syncStatus = 'PENDING'
  if (connStore.isConnected) {
    connStore.pushRecords([record])
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
              style="font-size: 18px; color: #ef4444; margin-right: 4px;"
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

        <!-- Edit & Resync buttons -->
        <div v-if="canEditRecord(rec) || (!isRecordSynced(rec) && rec.scoutId === userStore.userId)" class="card-actions">
          <button
            v-if="canEditRecord(rec)"
            class="btn-edit"
            :class="{ 'btn-edit-conflict': rec.isConflict }"
            @click="startEdit(rec)"
          >
            <span class="material-icons" style="font-size: 16px; margin-right: 4px;">edit</span> {{ t('history.btn_edit') }}
          </button>

          <button
            v-if="!eventStore.isHost && (!rec.hostSeq || rec.syncStatus === 'PENDING') && rec.scoutId === userStore.userId"
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
  background: rgba(128, 128, 128, 0.1);
  backdrop-filter: brightness(1.1);
  pointer-events: none;
  transition: top var(--motion-duration-moderate) var(--motion-ease-out), height var(--motion-duration-moderate) var(--motion-ease-out), opacity var(--motion-duration-fast) ease;
  z-index: 10;
  border-radius: 14px;
}



.history-card.highlight-conflict,
.history-card.is-conflict-card {
  border-color: #ef4444 !important;
  box-shadow: 0 0 12px rgba(239, 68, 68, 0.4);
  animation: pulse-conflict 2.5s infinite ease-in-out;
  background-color: rgba(239, 68, 68, 0.05);
}

@keyframes pulse-conflict {
  0%, 100% { opacity: 1; border-color: rgba(239, 68, 68, 0.95); }
  50% { opacity: 0.85; border-color: rgba(239, 68, 68, 0.4); }
}

.conflict-badge {
  color: #ef4444;
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
  background: #ef4444 !important;
  color: white !important;
}

.btn-edit-conflict:hover {
  background: #dc2626 !important;
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
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  padding: 1px 6px;
  border-radius: 4px;
}

.scout-meta-icon {
  font-size: 13px;
  color: var(--primary, #39ff14);
}

.scout-meta-text {
  font-family: var(--font-mono, monospace);
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
  border: none;
}

.btn-edit {
  background: var(--border);
  color: var(--muted-foreground);
}

.btn-edit:hover {
  background: var(--input);
}

.btn-save {
  background: var(--primary);
  color: var(--primary-foreground);
}

.btn-save:hover {
  background: var(--primary);
}

.btn-cancel {
  background: var(--border);
  color: var(--muted-foreground);
}

.sync-badge.is-synced {
  color: #39ff14;
}

.sync-badge.is-pending {
  color: #f59e0b;
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
  border: 1px solid rgba(245, 158, 11, 0.4);
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
  transition: all 0.2s ease;
}

.btn-resync:hover {
  background: rgba(245, 158, 11, 0.25);
  border-color: #f59e0b;
}

.btn-resync:active {
  transform: scale(0.97);
}
</style>

