<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { ScoutingRecord } from '@/types'
import { useRecordStore } from '@/stores/records'

const { t } = useI18n()
const recordStore = useRecordStore()

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

function isConflictHighlighted(rec: ScoutingRecord) {
  return highlightMatch.value === rec.matchNumber && highlightTeam.value === rec.teamNumber
}

const hasScrolled = ref(false)

// Reset scroll flag if the URL highlight targets change
watch([highlightMatch, highlightTeam], () => {
  hasScrolled.value = false
})

watch([highlightMatch, highlightTeam, () => props.records], async ([m, t]) => {
  if (m && t && !hasScrolled.value && props.records.length > 0) {
    await nextTick()
    const targetRec = props.records.find(r => r.matchNumber === m && r.teamNumber === t)
    if (targetRec) {
      const el = document.getElementById('history-card-' + targetRec.id)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        hasScrolled.value = true
      }
    }
  }
}, { immediate: true })

function syncIcon(status: string): string {
  return status === 'SYNCED' ? 'check_circle' : 'hourglass_empty'
}

function syncTooltip(status: string): string {
  return status === 'SYNCED'
    ? t('history.sync_synced')
    : t('history.sync_pending')
}

function startEdit(record: ScoutingRecord) {
  if (record.syncStatus === 'SYNCED' && !record.isConflict) return // can't edit synced unless conflicted
  emit('editRecord', record)
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString()
}

const highlightTop = ref(0)
const highlightHeight = ref(0)
const highlightVisible = ref(false)

function onCardEnter(e: MouseEvent) {
  const target = e.currentTarget as HTMLElement
  const wrapper = target.closest('.history-list') as HTMLElement
  if (wrapper && target) {
    const wrapperRect = wrapper.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    highlightTop.value = targetRect.top - wrapperRect.top + wrapper.scrollTop
    highlightHeight.value = targetRect.height
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
  
  // Force browser to paint the initial opacity: 0 state before animating
  // eslint-disable-next-line no-unused-expressions
  htmlEl.offsetHeight
  
  const index = parseInt(htmlEl.dataset.index || '0', 10)
  const delay = Math.min(index, 10) * 50
  
  setTimeout(() => {
    htmlEl.style.setProperty('transition', 'all 0.4s cubic-bezier(0.25, 1, 0.5, 1)', 'important')
    htmlEl.style.opacity = '1'
    htmlEl.style.transform = 'translateY(0)'
    
    // Clean up inline !important transition after animation so :active feedback is restored
    setTimeout(() => {
      htmlEl.style.removeProperty('transition')
      done()
    }, 400)
  }, delay)
}
</script>

<template>
  <div class="history-panel">
    <div v-if="loading" class="loading-msg">{{ t('history.loading') }}</div>
    <div v-else-if="records.length === 0" class="empty-state">
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
        v-for="(rec, index) in records"
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
              {{ t('history.match') }} #{{ rec.matchNumber }} | {{ t('history.team') }} #{{ rec.teamNumber }}
            </span>
            <span class="card-date">{{ formatDate(rec.createdAt) }}</span>
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
              style="font-size: 18px; vertical-align: bottom;"
              :title="syncTooltip(rec.syncStatus)"
            >{{ syncIcon(rec.syncStatus) }}</span>
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

        <!-- Edit button for PENDING records or conflicted records -->
        <div v-if="rec.syncStatus === 'PENDING' || rec.isConflict" class="card-actions">
          <button
            class="btn-edit"
            :class="{ 'btn-edit-conflict': rec.isConflict }"
            @click="startEdit(rec)"
          >
            <span class="material-icons" style="font-size: 16px; margin-right: 4px;">edit</span> {{ t('history.btn_edit') }}
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
  transition: top 0.25s cubic-bezier(0.25, 1, 0.5, 1), height 0.25s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.2s ease;
  z-index: 10;
  border-radius: 14px;
}



.history-card.highlight-conflict,
.history-card.is-conflict-card {
  border-color: #ef4444 !important;
  box-shadow: 0 0 15px rgba(239, 68, 68, 0.4);
  animation: pulse-conflict 2s infinite;
  background-color: rgba(239, 68, 68, 0.05);
}

@keyframes pulse-conflict {
  0% { box-shadow: 0 0 10px rgba(239, 68, 68, 0.3); }
  50% { box-shadow: 0 0 20px rgba(239, 68, 68, 0.7); }
  100% { box-shadow: 0 0 10px rgba(239, 68, 68, 0.3); }
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
</style>

