<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ScoutingEvent, StationType, MatchScheduleItem, ScoutAssignment } from '@/types'
import { useScheduleStore } from '@/stores/schedule'
import { useRecordStore } from '@/stores/records'
import { useConnectionStore } from '@/stores/connection'
import { useUserStore } from '@/stores/user'
import { useToastStore } from '@/stores/toast'
import ScheduleImportModal from './ScheduleImportModal.vue'
import ScheduleAuditModal from './ScheduleAuditModal.vue'
import PitStatusIndicator from '@/components/pit/PitStatusIndicator.vue'

const props = defineProps<{
  event: ScoutingEvent | null
  isHost: boolean
}>()

const emit = defineEmits<{
  (e: 'startScouting', task: { matchNumber: number; teamNumber: number; allianceColor: 'red' | 'blue' }): void
}>()

const { t } = useI18n()
const scheduleStore = useScheduleStore()
const recordStore = useRecordStore()
const connStore = useConnectionStore()
const userStore = useUserStore()
const toastStore = useToastStore()

const showImportModal = ref(false)
const showAuditModal = ref(false)
const auditFocusMatch = ref<number | null>(null)
const filterMode = ref<'all' | 'mine' | 'pending' | 'discrepancy'>('all')
const searchQuery = ref('')

function getMatchDiscrepancy(matchNumber: number) {
  return recordStore.matchDiscrepancies.find((d) => d.matchNumber === matchNumber)
}

function openAuditModal(focusMatch?: number) {
  auditFocusMatch.value = focusMatch || null
  showAuditModal.value = true
}

function onLocateMatchFromAudit(matchNumber: number) {
  scheduleStore.clearSelection()
  scheduleStore.toggleMatchSelection(matchNumber)
  const rowEl = document.querySelector(`[data-match-num="${matchNumber}"]`)
  if (rowEl) {
    rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}

// 批量排班目标工位
const bulkStationTarget = ref<StationType | 'all'>('all')

// 划选（长按拖动与滚轮划选）状态与点击选择
const isMouseDown = ref(false)
let dragMoved = false
let dragStartMatch: number | null = null

function onRowMouseDown(matchNumber: number, e: MouseEvent) {
  if (!props.isHost) return
  const target = e.target as HTMLElement
  if (target.closest('select') || target.closest('button') || target.closest('input')) {
    return
  }
  if (e.button !== 0) return // 仅左键

  isMouseDown.value = true
  dragMoved = false
  dragStartMatch = matchNumber
}

function onRowMouseEnter(matchNumber: number) {
  if (isMouseDown.value && props.isHost) {
    if (!dragMoved && dragStartMatch !== null) {
      dragMoved = true
      scheduleStore.startDragSelection(dragStartMatch)
    }
    scheduleStore.dragSelectMatch(matchNumber)
  }
}

function onTableWheel(e: WheelEvent) {
  if (isMouseDown.value && props.isHost) {
    const el = document.elementFromPoint(e.clientX, e.clientY)
    const rowEl = el?.closest('[data-match-num]')
    if (rowEl) {
      const mNum = parseInt(rowEl.getAttribute('data-match-num') || '', 10)
      if (!isNaN(mNum)) {
        if (!dragMoved && dragStartMatch !== null) {
          dragMoved = true
          scheduleStore.startDragSelection(dragStartMatch)
        }
        scheduleStore.dragSelectMatch(mNum)
      }
    }
  }
}

function onWindowMouseUp() {
  if (isMouseDown.value) {
    isMouseDown.value = false
    if (dragMoved) {
      scheduleStore.endDragSelection()
    }
    dragMoved = false
    dragStartMatch = null
  }
}

function onRowClick(matchNumber: number, e: MouseEvent) {
  if (!props.isHost) return
  const target = e.target as HTMLElement
  if (target.closest('select') || target.closest('button') || target.closest('input')) {
    return
  }
  if (dragMoved) return
  scheduleStore.toggleMatchSelection(matchNumber)
}

onMounted(() => {
  window.addEventListener('mouseup', onWindowMouseUp)
  if (props.event?.id) {
    scheduleStore.loadSchedule(props.event.id)
  }
})

onUnmounted(() => {
  window.removeEventListener('mouseup', onWindowMouseUp)
})

// 可用 Scout 列表（整合在线 Scout、历史 Scout 及当前用户）
const availableScouts = computed(() => {
  const map = new Map<string, string>()
  if (userStore.userId) {
    map.set(userStore.userId, userStore.username)
  }
  for (const s of connStore.connectedScouts) {
    map.set(s.id, s.name)
  }
  for (const r of recordStore.activeRecords) {
    if (r.scoutId && r.scoutName) {
      map.set(r.scoutId, r.scoutName)
    }
  }
  // 赛程中已被排过的 Scout
  for (const a of Object.values(scheduleStore.assignments)) {
    if (a.scoutId && a.scoutName) {
      map.set(a.scoutId, a.scoutName)
    }
  }
  return Array.from(map.entries()).map(([id, name]) => ({ id, name }))
})

// 过滤后的赛程列表
const displayedSchedules = computed(() => {
  let list = scheduleStore.sortedSchedules

  if (searchQuery.value.trim()) {
    const q = searchQuery.value.trim().toLowerCase()
    list = list.filter((s) => {
      const matchStr = `q${s.matchNumber} ${s.matchNumber}`
      const teamsStr = `${s.red1} ${s.red2} ${s.blue1} ${s.blue2}`
      return matchStr.includes(q) || teamsStr.includes(q)
    })
  }

  if (filterMode.value === 'mine') {
    const myId = userStore.userId
    list = list.filter((s) => {
      const a1 = scheduleStore.getStationAssignment(s.matchNumber, 'red1')
      const a2 = scheduleStore.getStationAssignment(s.matchNumber, 'red2')
      const a3 = scheduleStore.getStationAssignment(s.matchNumber, 'blue1')
      const a4 = scheduleStore.getStationAssignment(s.matchNumber, 'blue2')
      return (
        a1?.scoutId === myId ||
        a2?.scoutId === myId ||
        a3?.scoutId === myId ||
        a4?.scoutId === myId
      )
    })
  } else if (filterMode.value === 'pending') {
    list = list.filter((s) => {
      // 检查是否有工位尚未录入
      const hasUnscouted = ['red1', 'red2', 'blue1', 'blue2'].some((st) => {
        const teamNum = getTeamNumber(s, st as StationType)
        return !isTeamScouted(s.matchNumber, teamNum)
      })
      return hasUnscouted
    })
  } else if (filterMode.value === 'discrepancy') {
    list = list.filter((s) => Boolean(getMatchDiscrepancy(s.matchNumber)?.hasWarning))
  }

  return list
})

function getTeamNumber(sched: MatchScheduleItem, station: StationType): number {
  return (sched as any)[station] || 0
}

function isTeamScouted(matchNumber: number, teamNumber: number): boolean {
  return !teamNumber ? false : recordStore.activeRecords.some((r) => r.matchNumber === matchNumber && r.teamNumber === teamNumber)
}

function isTeamScoutedByMe(matchNumber: number, teamNumber: number): boolean {
  return !teamNumber || !userStore.userId ? false : recordStore.activeRecords.some((r) => r.matchNumber === matchNumber && r.teamNumber === teamNumber && r.scoutId === userStore.userId)
}

function getOfficialScore(matchNumber: number): { red: number; blue: number } | null {
  const m = recordStore.officialMatches.find((om) => om.matchNum === matchNumber)
  return m && m.scores ? { red: m.scores.red.totalPointsNp, blue: m.scores.blue.totalPointsNp } : null
}

// 单工位排班选择（永远支持留空）
function handleStationScoutChange(sched: MatchScheduleItem, station: StationType, e: Event) {
  if (!props.event?.id) return
  const select = e.target as HTMLSelectElement
  const scoutId = select.value || null
  const scout = availableScouts.value.find((s) => s.id === scoutId)
  const scoutName = scout ? scout.name : null

  scheduleStore.assignStation(
    props.event.id,
    sched.matchNumber,
    station,
    scoutId,
    scoutName,
    true
  )
}

// 批量指派给某个 Scout
async function handleBatchAssign(scoutId: string | null, scoutName: string | null) {
  if (!props.event?.id || scheduleStore.selectedCount === 0) return
  await scheduleStore.batchAssignSelected(
    props.event.id,
    bulkStationTarget.value,
    scoutId,
    scoutName
  )
  toastStore.showToast(
    scoutId
      ? t('schedule.batch_assign_success', { count: scheduleStore.selectedCount, scout: scoutName }) || `已将 ${scheduleStore.selectedCount} 场比赛分配给 ${scoutName}`
      : t('schedule.batch_unassign_success', { count: scheduleStore.selectedCount }) || `已将 ${scheduleStore.selectedCount} 场比赛设为留空`,
    'success'
  )
}

// 跳转到表单去打分
function handleGoToScout(matchNumber: number, teamNumber: number, alliance: 'red' | 'blue') {
  emit('startScouting', { matchNumber, teamNumber, allianceColor: alliance })
}

// 清空赛程确认
async function handleClearSchedule() {
  if (!props.event?.id) return
  if (confirm(t('schedule.clear_confirm') || '确定清空当前赛事的全部赛程与排班数据吗？此操作不可逆。')) {
    await scheduleStore.clearSchedule(props.event.id)
    toastStore.showToast(t('schedule.clear_success') || '赛程已清空', 'info')
  }
}
</script>

<template>
  <div class="schedule-manager" @wheel="onTableWheel">
    <!-- 顶部控制条 -->
    <div class="schedule-toolbar">
      <div class="toolbar-left">
        <!-- 搜索与筛选 -->
        <div class="search-box">
          <span class="material-icons search-icon">search</span>
          <input
            v-model="searchQuery"
            type="text"
            :placeholder="t('schedule.search_placeholder')"
            class="search-input"
          />
        </div>

        <div class="filter-pills">
          <button
            class="pill-btn"
            :class="{ active: filterMode === 'all' }"
            @click="filterMode = 'all'"
          >
            {{ t('schedule.filter_all') }} ({{ scheduleStore.schedules.length }})
          </button>
          <button
            class="pill-btn"
            :class="{ active: filterMode === 'mine' }"
            @click="filterMode = 'mine'"
          >
            <span class="material-icons pill-icon">person</span>
            {{ t('schedule.filter_mine') }} ({{ scheduleStore.myAssignments(userStore.userId).length }})
          </button>
          <button
            class="pill-btn"
            :class="{ active: filterMode === 'pending' }"
            @click="filterMode = 'pending'"
          >
            <span class="material-icons pill-icon">pending_actions</span>
            {{ t('schedule.filter_pending') }}
          </button>
          <button
            v-if="recordStore.matchDiscrepancies.some((d) => d.hasWarning)"
            class="pill-btn warning-pill"
            :class="{ active: filterMode === 'discrepancy' }"
            @click="filterMode = filterMode === 'discrepancy' ? 'all' : 'discrepancy'"
            :title="t('schedule.filter_discrepancy_title')"
          >
            <span class="material-icons pill-icon text-warning">warning</span>
            {{ t('schedule.filter_discrepancy') }} ({{ recordStore.matchDiscrepancies.filter((d) => d.hasWarning).length }})
          </button>
        </div>
      </div>

      <div class="toolbar-right">
        <!-- 差额对账总结按钮 (Host 与 Scout 均可查阅) -->
        <button
          v-if="recordStore.matchDiscrepancies.some((d) => d.hasWarning)"
          class="btn-tool audit-btn"
          @click="openAuditModal()"
          :title="t('schedule.btn_audit_modal_title')"
        >
          <span class="material-icons">fact_check</span>
          <span>{{ t('schedule.btn_audit_top5') }}</span>
        </button>

        <!-- Host 专属操作 -->
        <template v-if="isHost">
          <button class="btn-tool primary" @click="showImportModal = true">
            <span class="material-icons">cloud_download</span>
            <span>{{ t('schedule.btn_import_schedule') }}</span>
          </button>
          <button
            v-if="scheduleStore.schedules.length > 0"
            class="btn-tool danger"
            @click="handleClearSchedule"
            :title="t('schedule.btn_clear_schedule')"
          >
            <span class="material-icons">delete_sweep</span>
          </button>
        </template>
      </div>
    </div>

    <!-- 划选操作浮动栏 (Bulk Action Bar) -->
    <Transition name="slide-down">
      <div v-if="isHost && scheduleStore.selectedCount > 0" class="bulk-action-bar">
        <div class="bulk-info">
          <span class="material-icons check-icon">check_circle</span>
          <span class="selected-text">{{ t('schedule.selected_count', { count: scheduleStore.selectedCount }) }}</span>
        </div>

        <div class="bulk-controls">
          <!-- 工位目标选择 -->
          <div class="station-target-group">
            <span class="target-label">{{ t('schedule.bulk_target_label') }}:</span>
            <select v-model="bulkStationTarget" class="bulk-select">
              <option value="all">{{ t('schedule.target_all_stations') }}</option>
              <option value="red1">{{ t('schedule.col_red1') }}</option>
              <option value="red2">{{ t('schedule.col_red2') }}</option>
              <option value="blue1">{{ t('schedule.col_blue1') }}</option>
              <option value="blue2">{{ t('schedule.col_blue2') }}</option>
            </select>
          </div>

          <!-- 快速指定 Scout 按钮列表 -->
          <div class="scout-chip-list">
            <button
              v-for="scout in availableScouts"
              :key="scout.id"
              class="scout-assign-chip"
              @click="handleBatchAssign(scout.id, scout.name)"
            >
              <span class="material-icons chip-icon">account_circle</span>
              <span>{{ scout.name }}</span>
            </button>

            <!-- 永远支持留空 -->
            <button
              class="scout-assign-chip unassign-chip"
              @click="handleBatchAssign(null, null)"
              :title="t('schedule.btn_set_unassigned')"
            >
              <span class="material-icons chip-icon">block</span>
              <span>{{ t('schedule.btn_set_unassigned') }}</span>
            </button>
          </div>

          <div class="bulk-utility-group">
            <button class="btn-text" @click="scheduleStore.selectAllMatches">{{ t('schedule.btn_select_all') }}</button>
            <button class="btn-text" @click="scheduleStore.clearSelection">{{ t('schedule.btn_clear_selection') }}</button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 赛程列表为空时的占位 -->
    <div v-if="scheduleStore.schedules.length === 0" class="empty-schedule-card">
      <span class="material-icons empty-icon">calendar_month</span>
      <h3>{{ t('schedule.empty_title') }}</h3>
      <p>{{ isHost ? t('schedule.empty_host_hint') : t('schedule.empty_scout_hint') }}</p>
      <button v-if="isHost" class="btn-empty-import" @click="showImportModal = true">
        <span class="material-icons">add</span>
        <span>{{ t('schedule.btn_import_now') }}</span>
      </button>
    </div>

    <!-- 赛程表格视图 -->
    <div v-else class="schedule-table-container">
      <div class="table-gesture-hint" v-if="isHost">
        <span class="material-icons">mouse</span>
        <span>{{ t('schedule.drag_wheel_hint') }}</span>
      </div>

      <table class="schedule-table">
        <thead>
          <tr>
            <th class="th-match">{{ t('schedule.col_match') }}</th>
            <th class="th-alliance red-hdr">{{ t('schedule.red_alliance') }}</th>
            <th class="th-alliance blue-hdr">{{ t('schedule.blue_alliance') }}</th>
            <th class="th-score">{{ t('schedule.col_official_score') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="sched in displayedSchedules"
            :key="sched.matchNumber"
            :data-match-num="sched.matchNumber"
            class="match-row"
            :class="{ selected: scheduleStore.isMatchSelected(sched.matchNumber) }"
            @mousedown="onRowMouseDown(sched.matchNumber, $event)"
            @mouseenter="onRowMouseEnter(sched.matchNumber)"
            @click="onRowClick(sched.matchNumber, $event)"
          >
            <!-- 场次标识 -->
            <td class="td-match">
              <div class="match-badge">Q{{ sched.matchNumber }}</div>
            </td>

            <!-- 红方联盟 -->
            <td class="td-alliance red-zone">
              <div class="station-grid">
                <div
                  v-for="st in ([{ station: 'red1' as const, team: sched.red1, label: 'R1' }, { station: 'red2' as const, team: sched.red2, label: 'R2' }])"
                  :key="st.station"
                  class="station-card red"
                  :class="{
                    'scouted': isTeamScouted(sched.matchNumber, st.team),
                    'assigned-to-me': scheduleStore.getStationAssignment(sched.matchNumber, st.station)?.scoutId === userStore.userId
                  }"
                >
                  <div class="station-top">
                    <span class="station-badge">{{ st.label }}</span>
                    <span class="team-number">#{{ st.team }}</span>
                    <PitStatusIndicator :team-number="st.team" size="sm" />
                    <span v-if="isTeamScouted(sched.matchNumber, st.team)" class="scouted-icon" :title="t('schedule.scouted')">✓</span>
                  </div>

                  <!-- Host 下拉排班 (支持留空) -->
                  <div v-if="isHost" class="assignment-control" @mousedown.stop>
                    <select
                      class="scout-select"
                      :value="scheduleStore.getStationAssignment(sched.matchNumber, st.station)?.scoutId || ''"
                      @change="handleStationScoutChange(sched, st.station, $event)"
                    >
                      <option value="">{{ t('schedule.unassigned') }}</option>
                      <option v-for="s in availableScouts" :key="s.id" :value="s.id">
                        {{ s.name }}
                      </option>
                    </select>
                  </div>

                  <!-- Scout 只读与跳转打分 -->
                  <div v-else class="scout-view-box">
                    <span class="scout-name-tag">
                      {{ scheduleStore.getStationAssignment(sched.matchNumber, st.station)?.scoutName || t('schedule.unassigned') }}
                    </span>
                    <button
                      v-if="scheduleStore.getStationAssignment(sched.matchNumber, st.station)?.scoutId === userStore.userId"
                      class="btn-go-scout red"
                      @click.stop="handleGoToScout(sched.matchNumber, st.team, 'red')"
                    >
                      {{ isTeamScoutedByMe(sched.matchNumber, st.team) ? t('schedule.btn_scouted_again') : t('schedule.btn_go_scout') }}
                    </button>
                  </div>
                </div>
              </div>
            </td>

            <!-- 蓝方联盟 -->
            <td class="td-alliance blue-zone">
              <div class="station-grid">
                <div
                  v-for="st in ([{ station: 'blue1' as const, team: sched.blue1, label: 'B1' }, { station: 'blue2' as const, team: sched.blue2, label: 'B2' }])"
                  :key="st.station"
                  class="station-card blue"
                  :class="{
                    'scouted': isTeamScouted(sched.matchNumber, st.team),
                    'assigned-to-me': scheduleStore.getStationAssignment(sched.matchNumber, st.station)?.scoutId === userStore.userId
                  }"
                >
                  <div class="station-top">
                    <span class="station-badge">{{ st.label }}</span>
                    <span class="team-number">#{{ st.team }}</span>
                    <PitStatusIndicator :team-number="st.team" size="sm" />
                    <span v-if="isTeamScouted(sched.matchNumber, st.team)" class="scouted-icon" :title="t('schedule.scouted')">✓</span>
                  </div>

                  <div v-if="isHost" class="assignment-control" @mousedown.stop>
                    <select
                      class="scout-select"
                      :value="scheduleStore.getStationAssignment(sched.matchNumber, st.station)?.scoutId || ''"
                      @change="handleStationScoutChange(sched, st.station, $event)"
                    >
                      <option value="">{{ t('schedule.unassigned') }}</option>
                      <option v-for="s in availableScouts" :key="s.id" :value="s.id">
                        {{ s.name }}
                      </option>
                    </select>
                  </div>

                  <div v-else class="scout-view-box">
                    <span class="scout-name-tag">
                      {{ scheduleStore.getStationAssignment(sched.matchNumber, st.station)?.scoutName || t('schedule.unassigned') }}
                    </span>
                    <button
                      v-if="scheduleStore.getStationAssignment(sched.matchNumber, st.station)?.scoutId === userStore.userId"
                      class="btn-go-scout blue"
                      @click.stop="handleGoToScout(sched.matchNumber, st.team, 'blue')"
                    >
                      {{ isTeamScoutedByMe(sched.matchNumber, st.team) ? t('schedule.btn_scouted_again') : t('schedule.btn_go_scout') }}
                    </button>
                  </div>
                </div>
              </div>
            </td>

            <!-- 官方比分展示与对账差额告警 -->
            <td class="td-score">
              <div v-if="getOfficialScore(sched.matchNumber)" class="official-score-box">
                <span class="score-num red">{{ getOfficialScore(sched.matchNumber)!.red }}</span>
                <span class="score-split">:</span>
                <span class="score-num blue">{{ getOfficialScore(sched.matchNumber)!.blue }}</span>
              </div>
              <span v-else class="score-pending">—</span>

              <!-- 差额异常告警胶囊 -->
              <div
                v-if="getMatchDiscrepancy(sched.matchNumber)?.hasWarning"
                class="discrepancy-pill"
                :class="{ 'rank-top5': getMatchDiscrepancy(sched.matchNumber)?.isTop5 }"
                :title="getMatchDiscrepancy(sched.matchNumber)?.summaryMessage || t('schedule.discrepancy_warning_tooltip')"
                @click.stop="openAuditModal(sched.matchNumber)"
              >
                <span class="material-icons warning-mini-icon">warning</span>
                <span class="diff-tag">
                  {{ getMatchDiscrepancy(sched.matchNumber)?.rank && getMatchDiscrepancy(sched.matchNumber)!.rank! <= 5 ? `Top${getMatchDiscrepancy(sched.matchNumber)!.rank} ` : '' }}±{{ getMatchDiscrepancy(sched.matchNumber)!.maxDiff }}
                </span>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 导入弹窗 -->
    <ScheduleImportModal
      v-model:visible="showImportModal"
      :event="event"
      @imported="scheduleStore.loadSchedule(event?.id || '')"
    />

    <!-- 差额前5对账总结弹窗 -->
    <ScheduleAuditModal
      v-model:visible="showAuditModal"
      :focus-match-number="auditFocusMatch"
      @selectMatch="onLocateMatchFromAudit"
    />
  </div>
</template>

<style scoped src="./ScheduleManager.css"></style>

