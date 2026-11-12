<script setup lang="ts">
import { ref, computed, toRef, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useScheduleStore } from '@/stores/schedule'
import { useRecordStore } from '@/stores/records'
import { usePitScoutStore } from '@/stores/pitScout'
import { useToastStore } from '@/stores/toast'
import WhiteboardFieldCanvas from './WhiteboardFieldCanvas.vue'
import WhiteboardSidebar from './WhiteboardSidebar.vue'
import {
  useTacticalWhiteboard,
  WHITEBOARD_COLORS,
  STATION_LIST,
  type WhiteboardTool,
  type WhiteboardPhase
} from './useTacticalWhiteboard'
import type { StationType } from '@/types'

const props = defineProps<{
  eventId: string
  initialMatch?: { matchNumber: number; tournamentLevel?: string } | null
}>()

const { t } = useI18n()
const scheduleStore = useScheduleStore()
const recordStore = useRecordStore()
const pitStore = usePitScoutStore()
const toastStore = useToastStore()

const eventIdRef = toRef(props, 'eventId')
const initialMatchRef = toRef(props, 'initialMatch')
const schedulesRef = computed(() => scheduleStore.sortedSchedules)
const officialMatchesRef = computed(() => recordStore.officialMatches)

const wb = useTacticalWhiteboard({
  eventId: eventIdRef,
  schedules: schedulesRef,
  officialMatches: officialMatchesRef,
  initialMatch: initialMatchRef
})

const canvasCompRef = ref<InstanceType<typeof WhiteboardFieldCanvas> | null>(null)
const showCustomTeamsEditor = ref(false)
const customTeamInputs = ref({
  red1: '',
  red2: '',
  blue1: '',
  blue2: ''
})

function openCustomTeamsEditor() {
  const cur = wb.currentTeams.value
  customTeamInputs.value = {
    red1: cur.red1 > 0 ? String(cur.red1) : '',
    red2: cur.red2 > 0 ? String(cur.red2) : '',
    blue1: cur.blue1 > 0 ? String(cur.blue1) : '',
    blue2: cur.blue2 > 0 ? String(cur.blue2) : ''
  }
  showCustomTeamsEditor.value = !showCustomTeamsEditor.value
}

function applyCustomTeams() {
  wb.setCustomMatchTeams({
    red1: parseInt(customTeamInputs.value.red1, 10) || 0,
    red2: parseInt(customTeamInputs.value.red2, 10) || 0,
    blue1: parseInt(customTeamInputs.value.blue1, 10) || 0,
    blue2: parseInt(customTeamInputs.value.blue2, 10) || 0
  })
  showCustomTeamsEditor.value = false
}

const toolsList = computed<Array<{ key: WhiteboardTool; icon: string; label: string }>>(() => [
  { key: 'select', icon: 'open_with', label: t('whiteboard.tool_select') },
  { key: 'pen', icon: 'gesture', label: t('whiteboard.tool_pen') },
  { key: 'arrow', icon: 'trending_flat', label: t('whiteboard.tool_arrow') },
  { key: 'dashed-arrow', icon: 'Multiple_stop', label: t('whiteboard.tool_dashed_arrow') },
  { key: 'line', icon: 'horizontal_rule', label: t('whiteboard.tool_line') },
  { key: 'rect', icon: 'crop_din', label: t('whiteboard.tool_rect') },
  { key: 'circle', icon: 'radio_button_unchecked', label: t('whiteboard.tool_circle') },
  { key: 'text', icon: 'title', label: t('whiteboard.tool_text') },
  { key: 'eraser', icon: 'ink_eraser', label: t('whiteboard.tool_eraser') }
])

const phasesList = computed<Array<{ key: WhiteboardPhase; label: string; count: number }>>(() => [
  {
    key: 'auto',
    label: t('whiteboard.phase_auto'),
    count: wb.currentPlan.value.phases.auto.strokes.length
  },
  {
    key: 'teleop',
    label: t('whiteboard.phase_teleop'),
    count: wb.currentPlan.value.phases.teleop.strokes.length
  },
  {
    key: 'endgame',
    label: t('whiteboard.phase_endgame'),
    count: wb.currentPlan.value.phases.endgame.strokes.length
  }
])

function formatMatchOptionLabel(m: {
  matchNumber: number
  tournamentLevel?: string
  red1: number
  red2: number
  blue1: number
  blue2: number
}): string {
  const prefix = (m.tournamentLevel || '').toUpperCase() === 'PLAYOFF' ? 'P' : 'Q'
  return `${prefix}${m.matchNumber} — R(${m.red1 || '?'}, ${m.red2 || '?'}) vs B(${m.blue1 || '?'}, ${m.blue2 || '?'})`
}

const currentMatchLabel = computed(() => {
  if (wb.selectedMatchKey.value === 'CUSTOM') {
    return 'CUSTOM'
  }
  return wb.selectedMatchKey.value
})

function handleSyncRobotsFromPrev() {
  const ok = wb.syncRobotsFromPreviousPhase()
  if (ok) {
    toastStore.showToast(t('whiteboard.robots_synced_toast'), 'info')
  }
}

function handleExportPng() {
  const url = canvasCompRef.value?.exportAsPng()
  if (url) {
    toastStore.showToast(t('whiteboard.export_success'), 'success')
  }
}

function handleStationQuickClick(st: StationType) {
  wb.selectStationForDetail(st, true)
  wb.pulseHighlightStation(st)
}

function onKeyDown(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {
    return
  }
  if (e.key === 'Escape' && wb.isFullscreen.value) {
    wb.isFullscreen.value = false
    return
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    if (e.shiftKey) {
      e.preventDefault()
      wb.redo()
    } else {
      e.preventDefault()
      wb.undo()
    }
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
    e.preventDefault()
    wb.redo()
  }
}

watch(
  () => wb.selectedMatchKey.value,
  (key) => {
    if (key === 'CUSTOM' && Object.values(wb.currentTeams.value).every((n) => n === 0)) {
      showCustomTeamsEditor.value = true
    }
  }
)

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
})
</script>

<template>
  <div
    class="wb-root"
    :class="{ 'is-fullscreen': wb.isFullscreen.value }"
    data-testid="tactical-whiteboard-view"
  >
    <!-- 顶部第 1 栏：场次选择器、队号过滤、四队快览胶囊与窗口控制 -->
    <header class="wb-topbar toolbar">
      <div class="wb-match-controls">
        <button
          type="button"
          class="wb-icon-btn"
          :disabled="wb.filteredMatches.value.length === 0"
          :title="t('whiteboard.prev_match')"
          :aria-label="t('whiteboard.prev_match')"
          data-testid="wb-prev-match"
          @click="wb.stepMatch(-1)"
        >
          <span class="material-icons" aria-hidden="true">chevron_left</span>
        </button>

        <select
          class="wb-match-select"
          data-testid="wb-match-select"
          :aria-label="t('whiteboard.match_selector_label')"
          :value="wb.selectedMatchKey.value"
          @change="wb.selectMatch(($event.target as HTMLSelectElement).value)"
        >
          <option
            v-for="m in wb.filteredMatches.value"
            :key="`${(m.tournamentLevel || 'QUALIFICATION').toUpperCase()}_${m.matchNumber}`"
            :value="`${(m.tournamentLevel || 'QUALIFICATION').toUpperCase()}_${m.matchNumber}`"
          >
            {{ formatMatchOptionLabel(m) }}
          </option>
          <option value="CUSTOM">{{ t('whiteboard.custom_match_option') }}</option>
        </select>

        <button
          type="button"
          class="wb-icon-btn"
          :disabled="wb.filteredMatches.value.length === 0"
          :title="t('whiteboard.next_match')"
          :aria-label="t('whiteboard.next_match')"
          data-testid="wb-next-match"
          @click="wb.stepMatch(1)"
        >
          <span class="material-icons" aria-hidden="true">chevron_right</span>
        </button>

        <!-- 按队号筛选场次 -->
        <div class="wb-filter-box">
          <span class="material-icons wb-filter-icon" aria-hidden="true">search</span>
          <input
            v-model="wb.filterTeamQuery.value"
            type="text"
            inputmode="numeric"
            class="wb-filter-input"
            data-testid="wb-team-filter-input"
            :placeholder="t('whiteboard.filter_team_placeholder')"
          />
          <button
            v-if="wb.filterTeamQuery.value"
            type="button"
            class="wb-clear-filter-btn"
            :aria-label="t('whiteboard.clear_filter')"
            @click="wb.filterTeamQuery.value = ''"
          >
            <span class="material-icons" aria-hidden="true" style="font-size: 14px;">close</span>
          </button>
        </div>

        <!-- 手动配置四队按钮 -->
        <button
          type="button"
          class="wb-btn-secondary"
          data-testid="wb-edit-teams-btn"
          @click="openCustomTeamsEditor"
        >
          <span class="material-icons" aria-hidden="true" style="font-size: 16px;">groups</span>
          <span>{{ t('whiteboard.edit_teams_btn') }}</span>
        </button>
      </div>

      <!-- 中部：红蓝四队一键直达胶囊条（点击即在侧边栏打开该队详情并切换画笔色） -->
      <div class="wb-four-teams-strip" data-testid="wb-four-teams-strip">
        <button
          v-for="st in STATION_LIST"
          :key="st"
          type="button"
          :data-testid="`wb-strip-${st}`"
          class="wb-strip-pill"
          :class="[st, { active: wb.selectedStation.value === st }]"
          :title="t('whiteboard.view_team_detail')"
          @click="handleStationQuickClick(st)"
        >
          <span class="strip-st">{{ st.toUpperCase().replace('RED', 'R').replace('BLUE', 'B') }}</span>
          <strong class="strip-num">
            {{ wb.currentTeams.value[st] > 0 ? `#${wb.currentTeams.value[st]}` : 'TBD' }}
          </strong>
        </button>
      </div>

      <!-- 右侧：阶段切换与窗口操作 -->
      <div class="wb-window-actions">
        <div class="wb-phase-tabs" role="tablist">
          <button
            v-for="ph in phasesList"
            :key="ph.key"
            type="button"
            role="tab"
            :data-testid="`wb-phase-${ph.key}`"
            :aria-selected="wb.activePhase.value === ph.key"
            class="wb-phase-btn"
            :class="{ active: wb.activePhase.value === ph.key }"
            @click="wb.activePhase.value = ph.key"
          >
            <span>{{ ph.label }}</span>
            <span v-if="ph.count > 0" class="wb-phase-count">{{ ph.count }}</span>
          </button>
        </div>

        <button
          type="button"
          class="wb-icon-btn"
          :class="{ active: wb.showSidebar.value }"
          :title="t('whiteboard.btn_toggle_sidebar')"
          :aria-label="t('whiteboard.btn_toggle_sidebar')"
          data-testid="wb-toggle-sidebar"
          @click="wb.showSidebar.value = !wb.showSidebar.value"
        >
          <span class="material-icons" aria-hidden="true">view_sidebar</span>
        </button>

        <button
          type="button"
          class="wb-icon-btn"
          :class="{ active: wb.isFullscreen.value }"
          :title="wb.isFullscreen.value ? t('whiteboard.btn_exit_fullscreen') : t('whiteboard.btn_fullscreen')"
          :aria-label="wb.isFullscreen.value ? t('whiteboard.btn_exit_fullscreen') : t('whiteboard.btn_fullscreen')"
          data-testid="wb-toggle-fullscreen"
          @click="wb.isFullscreen.value = !wb.isFullscreen.value"
        >
          <span class="material-icons" aria-hidden="true">
            {{ wb.isFullscreen.value ? 'fullscreen_exit' : 'fullscreen' }}
          </span>
        </button>
      </div>
    </header>

    <!-- 可展开：手动配置四支队伍输入栏 -->
    <div v-if="showCustomTeamsEditor" class="wb-custom-teams-bar" data-testid="wb-custom-teams-editor">
      <span class="wb-custom-title">{{ t('whiteboard.custom_teams_title') }}:</span>
      <div class="wb-custom-inputs">
        <label class="wb-st-input red">
          <span>R1</span>
          <input
            v-model="customTeamInputs.red1"
            type="number"
            list="wb-roster-datalist"
            placeholder="Team #"
            data-testid="wb-input-red1"
          />
        </label>
        <label class="wb-st-input red">
          <span>R2</span>
          <input
            v-model="customTeamInputs.red2"
            type="number"
            list="wb-roster-datalist"
            placeholder="Team #"
            data-testid="wb-input-red2"
          />
        </label>
        <label class="wb-st-input blue">
          <span>B1</span>
          <input
            v-model="customTeamInputs.blue1"
            type="number"
            list="wb-roster-datalist"
            placeholder="Team #"
            data-testid="wb-input-blue1"
          />
        </label>
        <label class="wb-st-input blue">
          <span>B2</span>
          <input
            v-model="customTeamInputs.blue2"
            type="number"
            list="wb-roster-datalist"
            placeholder="Team #"
            data-testid="wb-input-blue2"
          />
        </label>
        <datalist id="wb-roster-datalist">
          <option v-for="rt in pitStore.allRosterTeams" :key="rt.teamNumber" :value="rt.teamNumber">
            #{{ rt.teamNumber }} {{ rt.name }}
          </option>
        </datalist>
        <button
          type="button"
          class="wb-btn-primary"
          data-testid="wb-apply-custom-teams"
          @click="applyCustomTeams"
        >
          {{ t('whiteboard.apply_teams') }}
        </button>
      </div>
    </div>

    <!-- 顶部第 2 栏：画笔、几何图形、橡皮擦、颜色、粗细与场地变换工具栏 -->
    <div class="wb-drawing-toolbar toolbar">
      <!-- 绘图工具组 -->
      <div class="wb-tool-group" role="toolbar" :aria-label="t('whiteboard.title')">
        <button
          v-for="tl in toolsList"
          :key="tl.key"
          type="button"
          :data-testid="`wb-tool-${tl.key}`"
          class="wb-tool-btn"
          :class="{ active: wb.activeTool.value === tl.key }"
          :title="tl.label"
          :aria-label="tl.label"
          @click="wb.activeTool.value = tl.key"
        >
          <span class="material-icons" aria-hidden="true">{{ tl.icon }}</span>
          <span class="tool-lbl">{{ tl.label }}</span>
        </button>
      </div>

      <!-- 颜色预设组 -->
      <div class="wb-color-group">
        <button
          v-for="c in WHITEBOARD_COLORS"
          :key="c.id"
          type="button"
          :data-testid="`wb-color-${c.id}`"
          class="wb-color-swatch"
          :class="{ active: wb.activeColor.value === c.hex }"
          :style="{ '--swatch-color': c.hex }"
          :title="t(c.labelKey)"
          :aria-label="t(c.labelKey)"
          @click="wb.activeColor.value = c.hex"
        ></button>
      </div>

      <!-- 线宽选择 -->
      <div class="wb-width-group">
        <button
          v-for="w in ([{ val: 3, lbl: t('whiteboard.stroke_size_sm') }, { val: 5, lbl: t('whiteboard.stroke_size_md') }, { val: 8, lbl: t('whiteboard.stroke_size_lg') }])"
          :key="w.val"
          type="button"
          class="wb-width-btn"
          :class="{ active: wb.activeStrokeWidth.value === w.val }"
          @click="wb.activeStrokeWidth.value = w.val"
        >
          {{ w.lbl }}
        </button>
      </div>

      <!-- 撤销 / 重做 / 清空 / 机位与场地控制 -->
      <div class="wb-action-group">
        <button
          type="button"
          class="wb-icon-btn"
          data-testid="wb-btn-undo"
          :disabled="!wb.canUndo.value"
          :title="t('whiteboard.btn_undo')"
          :aria-label="t('whiteboard.btn_undo')"
          @click="wb.undo()"
        >
          <span class="material-icons" aria-hidden="true">undo</span>
        </button>
        <button
          type="button"
          class="wb-icon-btn"
          data-testid="wb-btn-redo"
          :disabled="!wb.canRedo.value"
          :title="t('whiteboard.btn_redo')"
          :aria-label="t('whiteboard.btn_redo')"
          @click="wb.redo()"
        >
          <span class="material-icons" aria-hidden="true">redo</span>
        </button>
        <button
          type="button"
          class="wb-icon-btn"
          data-testid="wb-btn-clear"
          :disabled="wb.currentPhaseBoard.value.strokes.length === 0"
          :title="t('whiteboard.btn_clear_phase')"
          :aria-label="t('whiteboard.btn_clear_phase')"
          @click="wb.clearCurrentPhaseStrokes()"
        >
          <span class="material-icons" aria-hidden="true">delete_sweep</span>
        </button>

        <span class="wb-divider"></span>

        <button
          v-if="wb.activePhase.value !== 'auto'"
          type="button"
          class="wb-icon-btn"
          data-testid="wb-btn-sync-robots"
          :title="t('whiteboard.btn_sync_from_auto')"
          :aria-label="t('whiteboard.btn_sync_from_auto')"
          @click="handleSyncRobotsFromPrev"
        >
          <span class="material-icons" aria-hidden="true">move_down</span>
        </button>
        <button
          type="button"
          class="wb-icon-btn"
          data-testid="wb-btn-reset-robots"
          :title="t('whiteboard.btn_reset_robots')"
          :aria-label="t('whiteboard.btn_reset_robots')"
          @click="wb.resetCurrentPhaseRobots()"
        >
          <span class="material-icons" aria-hidden="true">restart_alt</span>
        </button>
        <button
          type="button"
          class="wb-icon-btn"
          data-testid="wb-btn-rotate-field"
          :title="t('whiteboard.btn_rotate_field')"
          :aria-label="t('whiteboard.btn_rotate_field')"
          @click="wb.rotateField()"
        >
          <span class="material-icons" aria-hidden="true">rotate_90_degrees_cw</span>
        </button>
        <button
          type="button"
          class="wb-icon-btn"
          data-testid="wb-btn-flip-field"
          :class="{ active: wb.fieldFlipH.value }"
          :title="t('whiteboard.btn_flip_field')"
          :aria-label="t('whiteboard.btn_flip_field')"
          @click="wb.toggleFlipField()"
        >
          <span class="material-icons" aria-hidden="true">flip</span>
        </button>
        <button
          type="button"
          class="wb-icon-btn"
          data-testid="wb-btn-toggle-grid"
          :class="{ active: wb.showGridCoords.value }"
          :title="t('whiteboard.btn_toggle_grid')"
          :aria-label="t('whiteboard.btn_toggle_grid')"
          @click="wb.showGridCoords.value = !wb.showGridCoords.value"
        >
          <span class="material-icons" aria-hidden="true">grid_on</span>
        </button>
        <button
          type="button"
          class="wb-icon-btn"
          data-testid="wb-btn-export-png"
          :title="t('whiteboard.btn_export_png')"
          :aria-label="t('whiteboard.btn_export_png')"
          @click="handleExportPng"
        >
          <span class="material-icons" aria-hidden="true">download</span>
        </button>
      </div>
    </div>

    <!-- 主工作区：左侧 FTC 战术场地画布 + 右侧四队情报侧栏 -->
    <div class="wb-workspace">
      <WhiteboardFieldCanvas
        ref="canvasCompRef"
        :phase="wb.activePhase.value"
        :tool="wb.activeTool.value"
        :color="wb.activeColor.value"
        :stroke-width="wb.activeStrokeWidth.value"
        :rotation="wb.fieldRotation.value"
        :flip-h="wb.fieldFlipH.value"
        :show-grid-coords="wb.showGridCoords.value"
        :strokes="wb.currentPhaseBoard.value.strokes"
        :robots="wb.currentPhaseBoard.value.robots"
        :selected-station="wb.selectedStation.value"
        :highlighted-station="wb.highlightedStation.value"
        :match-label="currentMatchLabel"
        @add-stroke="wb.addStroke"
        @erase-at="wb.eraseStrokesAt"
        @move-robot="(p) => wb.moveRobotToken(p.station, p.x, p.y)"
        @rotate-robot="wb.rotateRobotToken"
        @select-station="(st) => wb.selectStationForDetail(st, true)"
      />

      <WhiteboardSidebar
        v-if="wb.showSidebar.value"
        :event-id="eventId"
        :mode="wb.sidebarMode.value"
        :selected-station="wb.selectedStation.value"
        :robots="wb.currentPhaseBoard.value.robots"
        :tactical-notes="wb.currentPlan.value.tacticalNotes"
        @update:mode="(m) => (wb.sidebarMode.value = m)"
        @select-station="(st, openDetail) => wb.selectStationForDetail(st, openDetail)"
        @locate-station="wb.pulseHighlightStation"
        @rotate-station="wb.rotateRobotToken"
        @update-role="(p) => wb.setRobotRole(p.station, p.role)"
        @update-notes="wb.updateTacticalNotes"
      />
    </div>
  </div>
</template>

<style scoped>
.wb-root {
  --target-size: 28px;
  container: whiteboard-workspace / inline-size;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: calc(100vh - 150px);
  color: var(--foreground, #f0efe9);
}

@media (pointer: coarse) {
  .wb-root {
    --target-size: 40px;
  }
}

.wb-root.is-fullscreen {
  position: fixed;
  inset: 0;
  z-index: 1500;
  background: #0a0b0a;
  padding: 12px;
  padding-bottom: max(12px, env(safe-area-inset-bottom, 0px));
  min-height: 100vh;
  overflow-y: auto;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
}

:where(.toolbar > :not(button, input, select, textarea, a, [role="button"], label)) {
  min-inline-size: 0;
}

.wb-topbar {
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  background: var(--card, #141413);
  border: 1px solid var(--border, #262624);
  border-radius: 12px;
  padding: 8px 10px;
}

.wb-match-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.wb-match-select {
  min-block-size: var(--target-size);
  background: #0e0f0e;
  color: var(--foreground, #f0efe9);
  border: 1px solid #2b2c29;
  border-radius: 8px;
  padding: 4px 10px;
  font-size: 13px;
  font-weight: 700;
}

.wb-filter-box {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.wb-filter-icon {
  position: absolute;
  left: 7px;
  font-size: 15px;
  color: var(--muted-foreground, #8e8d87);
  pointer-events: none;
}

.wb-filter-input {
  min-block-size: var(--target-size);
  width: 155px;
  padding: 4px 24px 4px 26px;
  background: #0e0f0e;
  color: var(--foreground, #f0efe9);
  border: 1px solid #2b2c29;
  border-radius: 8px;
  font-size: 12px;
}

.wb-clear-filter-btn {
  position: absolute;
  right: 4px;
  background: none;
  border: none;
  color: var(--muted-foreground, #8e8d87);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
}

.wb-four-teams-strip {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.wb-strip-pill {
  min-block-size: var(--target-size);
  padding: 4px 9px;
  border-radius: 8px;
  border: 1px solid #2b2c29;
  background: #161715;
  color: var(--foreground, #f0efe9);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.14s ease;
}

.wb-strip-pill.red1,
.wb-strip-pill.red2 {
  border-left: 3px solid #ef4444;
}

.wb-strip-pill.blue1,
.wb-strip-pill.blue2 {
  border-left: 3px solid #3b82f6;
}

.wb-strip-pill.active {
  border-color: var(--primary, #39ff14);
  background: rgba(57, 255, 20, 0.12);
}

.strip-st {
  font-size: 10px;
  font-weight: 800;
  color: var(--muted-foreground, #8e8d87);
}

.strip-num {
  font-variant-numeric: tabular-nums;
}

.wb-window-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.wb-phase-tabs {
  display: inline-flex;
  background: #0e0f0e;
  padding: 3px;
  border-radius: 9px;
  gap: 3px;
}

.wb-phase-btn {
  min-block-size: var(--target-size);
  padding: 4px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted-foreground, #8e8d87);
  font-size: 12px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
}

.wb-phase-btn.active {
  background: var(--card, #1d1e1c);
  color: var(--primary, #39ff14);
}

.wb-phase-count {
  font-size: 10px;
  padding: 0 5px;
  border-radius: 999px;
  background: rgba(57, 255, 20, 0.18);
  color: var(--primary, #39ff14);
}

.wb-custom-teams-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px;
  background: #171816;
  border: 1px solid var(--primary, #39ff14);
  border-radius: 10px;
}

.wb-custom-title {
  font-size: 12px;
  font-weight: 700;
}

.wb-custom-inputs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.wb-st-input {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 800;
}

.wb-st-input.red span {
  color: #f87171;
}

.wb-st-input.blue span {
  color: #60a5fa;
}

.wb-st-input input {
  width: 86px;
  padding: 4px 7px;
  background: #0e0f0e;
  color: var(--foreground, #f0efe9);
  border: 1px solid #2b2c29;
  border-radius: 6px;
  font-size: 12px;
}

.wb-drawing-toolbar {
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  background: var(--card, #141413);
  border: 1px solid var(--border, #262624);
  border-radius: 12px;
  padding: 6px 10px;
}

.wb-tool-group {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}

.wb-tool-btn {
  min-block-size: var(--target-size);
  padding: 4px 8px;
  border-radius: 7px;
  border: 1px solid transparent;
  background: #1a1b19;
  color: #b5b4ae;
  font-size: 12px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  transition: all 0.12s ease;
}

.wb-tool-btn .material-icons {
  font-size: 17px;
}

.wb-tool-btn.active {
  background: rgba(57, 255, 20, 0.14);
  color: var(--primary, #39ff14);
  border-color: rgba(57, 255, 20, 0.5);
}

.wb-color-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.wb-color-swatch {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--swatch-color);
  border: 2px solid rgba(255, 255, 255, 0.2);
  cursor: pointer;
  transition: transform 0.12s ease;
}

.wb-color-swatch.active {
  transform: scale(1.22);
  border-color: #ffffff;
  box-shadow: 0 0 0 2px var(--swatch-color);
}

.wb-width-group {
  display: inline-flex;
  background: #0e0f0e;
  padding: 2px;
  border-radius: 7px;
  gap: 2px;
}

.wb-width-btn {
  min-block-size: 24px;
  padding: 2px 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--muted-foreground, #8e8d87);
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
}

.wb-width-btn.active {
  background: #232421;
  color: var(--foreground, #f0efe9);
}

.wb-action-group {
  display: flex;
  align-items: center;
  gap: 4px;
}

.wb-divider {
  width: 1px;
  height: 20px;
  background: #2a2b28;
  margin: 0 2px;
}

.wb-icon-btn {
  min-inline-size: var(--target-size);
  min-block-size: var(--target-size);
  border-radius: 7px;
  border: 1px solid #2a2b28;
  background: #181917;
  color: #c8c7c0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.wb-icon-btn:disabled {
  opacity: 0.38;
  cursor: not-allowed;
}

.wb-icon-btn.active {
  border-color: var(--primary, #39ff14);
  color: var(--primary, #39ff14);
}

.wb-btn-secondary {
  min-block-size: var(--target-size);
  padding: 4px 9px;
  border-radius: 8px;
  border: 1px solid #2e302c;
  background: #1a1b19;
  color: var(--foreground, #f0efe9);
  font-size: 12px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}

.wb-btn-primary {
  min-block-size: var(--target-size);
  padding: 4px 12px;
  border-radius: 8px;
  border: none;
  background: var(--primary, #39ff14);
  color: #080807;
  font-size: 12px;
  font-weight: 800;
  cursor: pointer;
}

.wb-workspace {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

@container whiteboard-workspace (inline-size > 56rem) {
  .wb-workspace {
    flex-direction: row;
    align-items: stretch;
  }
}

@container whiteboard-workspace (inline-size < 46rem) {
  .tool-lbl {
    display: none;
  }
  .wb-sidebar {
    width: 100%;
  }
}
</style>
