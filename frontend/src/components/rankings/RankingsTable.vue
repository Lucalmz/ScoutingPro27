<script setup lang="ts">
import { ref, computed, defineComponent, toRef, h, nextTick, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RankingRow } from '@/types'
import { useEventStore } from '@/stores/events'
import { useRecordStore } from '@/stores/records'
import { useToastStore } from '@/stores/toast'
import { useRouter } from 'vue-router'
import { transitionState } from '@/utils/transitionState'
import { useTween } from '@/composables/useTween'
import { useNavigationStore } from '@/stores/navigation'
import { hapticLight } from '@/utils/haptics'
import { useConfirm } from '@/composables/useConfirm'
import RankingsTableToolbar from './RankingsTableToolbar.vue'
import { useRankingsCustomColumns } from './useRankingsCustomColumns'

// Inline component for animated numbers
const AnimatedNumber = defineComponent({
  props: { value: { type: Number, required: true } },
  setup(props) {
    const valRef = toRef(props, 'value')
    const tweened = useTween(valRef, 800)
    return () => h('span', tweened.value.toFixed(1))
  }
})

const { t } = useI18n()
const eventStore = useEventStore()
const recordStore = useRecordStore()
const toastStore = useToastStore()
const router = useRouter()
const navStore = useNavigationStore()

const props = defineProps<{
  rankings: RankingRow[]
  loading: boolean
}>()

type SortKey = keyof RankingRow | string
const sortKey = ref<SortKey>('avgRating')
const sortDir = ref<'asc' | 'desc'>('desc')

// 标签筛选
const selectedTagFilter = ref<string | null>(null)

const availableFilterTags = computed<string[]>(() => {
  const all = recordStore.teamTags.map(t => t.tag)
  return Array.from(new Set(all))
})

function formatTagLabel(tagKey?: string | null): string {
  return tagKey || ''
}

// 自定义列配置与聚合
const {
  availableCustomFields,
  showCustomColsDropdown,
  selectedCustomKeys,
  visibleCustomFields,
  teamCustomStats,
  toggleCustomCol,
  selectAllCustomCols,
  clearAllCustomCols
} = useRankingsCustomColumns()

function setSort(key: SortKey) {
  hapticLight()
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    sortDir.value = 'desc'
  }
}

const filteredRankings = computed<RankingRow[]>(() => {
  let arr = [...props.rankings]
  if (selectedTagFilter.value) {
    const matchingTeams = new Set(
      recordStore.teamTags
        .filter(t => t.tag === selectedTagFilter.value)
        .map(t => t.teamNumber)
    )
    arr = arr.filter(r => matchingTeams.has(r.teamNumber))
  }
  return arr
})

const sorted = computed<RankingRow[]>(() => {
  const arr = [...filteredRankings.value]
  arr.sort((a, b) => {
    if (String(sortKey.value).startsWith('cf_')) {
      const fieldKey = String(sortKey.value).substring(3)
      const aStat = teamCustomStats.value.get(a.teamNumber)?.[fieldKey]
      const bStat = teamCustomStats.value.get(b.teamNumber)?.[fieldKey]
      const aHas = aStat !== undefined
      const bHas = bStat !== undefined
      if (!aHas && !bHas) return 0
      if (!aHas) return 1
      if (!bHas) return -1
      return sortDir.value === 'asc' ? aStat.value - bStat.value : bStat.value - aStat.value
    }
    const av = a[sortKey.value as keyof RankingRow]
    const bv = b[sortKey.value as keyof RankingRow]
    if (typeof av === 'number' && typeof bv === 'number') {
      return sortDir.value === 'asc' ? av - bv : bv - av
    }
    return 0
  })
  return arr
})

const maxMetrics = computed(() => {
  const rows = props.rankings
  if (!rows || rows.length === 0) {
    return { auto: 100, tele: 100, end: 50, rating: 200 }
  }
  return {
    auto: Math.max(10, ...rows.map(r => r.avgAutoScore || 0)),
    tele: Math.max(10, ...rows.map(r => r.avgTeleopScore || 0)),
    end: Math.max(10, ...rows.map(r => r.avgEndgameScore || 0)),
    rating: Math.max(20, ...rows.map(r => r.avgRating || 0)),
  }
})

function barPct(val: number, maxVal: number): string {
  if (!val || val <= 0 || !maxVal) return '0%'
  return `${Math.min(100, Math.round((val / maxVal) * 100))}%`
}

function sortIndicator(key: SortKey): string {
  if (sortKey.value !== key) return ''
  return sortDir.value === 'asc' ? 'arrow_drop_up' : 'arrow_drop_down'
}

const { showConfirm } = useConfirm()

async function banTeam(teamNumber: number) {
  const ok = await showConfirm({
    title: t('confirm_dialog.title'),
    message: `Are you sure you want to ban team ${teamNumber}? Scouters will be warned not to record them.`,
    type: 'warning'
  })
  if (!ok) {
    return
  }
  try {
    if (eventStore.currentEvent?.id) {
      await recordStore.banTeam(eventStore.currentEvent.id, teamNumber)
      toastStore.showToast(`Team ${teamNumber} has been banned`, 'success')
    }
  } catch (e: any) {
    toastStore.showError(e, 'Failed to ban team')
  }
}

async function unbanTeam(teamNumber: number) {
  const ok = await showConfirm({
    title: t('confirm_dialog.title'),
    message: `Are you sure you want to unban team ${teamNumber}?`,
    type: 'info'
  })
  if (!ok) {
    return
  }
  try {
    if (eventStore.currentEvent?.id) {
      await recordStore.unbanTeam(eventStore.currentEvent.id, teamNumber)
      toastStore.showToast(`Team ${teamNumber} has been unbanned`, 'success')
    }
  } catch (e: any) {
    toastStore.showError(e, 'Failed to unban team')
  }
}

function viewTeamDetails(teamNumber: number) {
  hapticLight()
  if (eventStore.currentEvent?.id) {
    const tabContent = document.querySelector('.tab-content') as HTMLElement | null
    const tableWrapper = document.querySelector('.table-wrapper') as HTMLElement | null
    navStore.saveEventPosition({
      eventId: eventStore.currentEvent.id,
      fromTab: 'rankings',
      contentScrollTop: tabContent ? tabContent.scrollTop : window.scrollY,
      contentScrollLeft: tabContent ? tabContent.scrollLeft : window.scrollX,
      tableScrollLeft: tableWrapper ? tableWrapper.scrollLeft : 0,
      teamNumber: teamNumber
    })
    transitionState.startSharedTransition(`team-card-${teamNumber}`)
    nextTick(() => {
      router.push(`/event/${eventStore.currentEvent!.id}/team/${teamNumber}`)
    })
  }
}

const highlightTop = ref(0)
const highlightHeight = ref(0)
const highlightVisible = ref(false)

function onRowEnter(e: MouseEvent) {
  const target = e.currentTarget as HTMLElement
  if (target) {
    highlightTop.value = target.offsetTop
    highlightHeight.value = target.offsetHeight
    highlightVisible.value = true
  }
}

function onCardEnter(e: MouseEvent) {
  onRowEnter(e)
}

function onListLeave() {
  highlightVisible.value = false
}

const highlightStyle = computed(() => ({
  top: `${highlightTop.value}px`,
  height: `${highlightHeight.value}px`,
  opacity: highlightVisible.value ? 1 : 0
}))

watch([sortKey, sortDir, selectedTagFilter], () => {
  highlightVisible.value = false
})

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
  <div class="rankings-panel">
    <div v-if="loading" class="loading-msg">{{ t('rankings.loading') }}</div>
    <div v-else-if="rankings.length === 0" class="empty-state">
      <p>{{ t('rankings.no_data') }}</p>
    </div>
    <div v-else class="table-wrapper">
      <RankingsTableToolbar
        :available-filter-tags="availableFilterTags"
        v-model:selected-tag-filter="selectedTagFilter"
        :available-custom-fields="availableCustomFields"
        :visible-custom-fields="visibleCustomFields"
        :selected-custom-keys="selectedCustomKeys"
        v-model:show-custom-cols-dropdown="showCustomColsDropdown"
        @toggle-custom-col="toggleCustomCol"
        @select-all-custom-cols="selectAllCustomCols"
        @clear-all-custom-cols="clearAllCustomCols"
      />

      <div class="table-container" style="position: relative;" @mouseleave="onListLeave">
        <div class="hover-highlight" :style="highlightStyle" key="highlight-bg"></div>
        <table>
          <thead @mouseenter="onListLeave">
            <tr>
              <th @click="setSort('teamNumber')" class="sortable">
                {{ t('rankings.team') }}<span class="material-icons sort-icon" :class="{ 'is-active': sortKey === 'teamNumber', 'is-asc': sortKey === 'teamNumber' && sortDir === 'asc' }">arrow_drop_down</span>
              </th>
              <th @click="setSort('matchCount')" class="sortable">
                {{ t('rankings.matches') }}<span class="material-icons sort-icon" :class="{ 'is-active': sortKey === 'matchCount', 'is-asc': sortKey === 'matchCount' && sortDir === 'asc' }">arrow_drop_down</span>
              </th>
              <th @click="setSort('brokenCount')" class="sortable">
                {{ t('rankings.breakdown') }}<span class="material-icons sort-icon" :class="{ 'is-active': sortKey === 'brokenCount', 'is-asc': sortKey === 'brokenCount' && sortDir === 'asc' }">arrow_drop_down</span>
              </th>
              <th @click="setSort('avgAutoScore')" class="sortable">
                {{ t('rankings.avg_auto') }}<span class="material-icons sort-icon" :class="{ 'is-active': sortKey === 'avgAutoScore', 'is-asc': sortKey === 'avgAutoScore' && sortDir === 'asc' }">arrow_drop_down</span>
              </th>
              <th @click="setSort('avgTeleopScore')" class="sortable">
                {{ t('rankings.avg_tele') }}<span class="material-icons sort-icon" :class="{ 'is-active': sortKey === 'avgTeleopScore', 'is-asc': sortKey === 'avgTeleopScore' && sortDir === 'asc' }">arrow_drop_down</span>
              </th>
              <th @click="setSort('avgEndgameScore')" class="sortable">
                {{ t('rankings.avg_endgame') }}<span class="material-icons sort-icon" :class="{ 'is-active': sortKey === 'avgEndgameScore', 'is-asc': sortKey === 'avgEndgameScore' && sortDir === 'asc' }">arrow_drop_down</span>
              </th>
              <th @click="setSort('avgTipsPerMatch')" class="sortable" :title="t('rankings.avg_tips_desc')">
                {{ t('rankings.avg_tips') }}<span class="material-icons sort-icon" :class="{ 'is-active': sortKey === 'avgTipsPerMatch', 'is-asc': sortKey === 'avgTipsPerMatch' && sortDir === 'asc' }">arrow_drop_down</span>
              </th>
              <th @click="setSort('maxScore')" class="sortable">
                {{ t('rankings.max') }}<span class="material-icons sort-icon" :class="{ 'is-active': sortKey === 'maxScore', 'is-asc': sortKey === 'maxScore' && sortDir === 'asc' }">arrow_drop_down</span>
              </th>
              <th @click="setSort('avgRating')" class="sortable">
                {{ t('rankings.rating') }}<span class="material-icons sort-icon" :class="{ 'is-active': sortKey === 'avgRating', 'is-asc': sortKey === 'avgRating' && sortDir === 'asc' }">arrow_drop_down</span>
              </th>
              <th
                v-for="f in visibleCustomFields"
                :key="f.fieldKey"
                class="sortable custom-col-th"
                @click="setSort('cf_' + f.fieldKey)"
                :title="f.unit ? `${f.name} (${f.unit})` : f.name"
              >
                {{ f.name }}<span class="material-icons sort-icon" :class="{ 'is-active': sortKey === 'cf_' + f.fieldKey, 'is-asc': sortKey === 'cf_' + f.fieldKey && sortDir === 'asc' }">arrow_drop_down</span>
              </th>
              <th>{{ t('rankings.trend') }}</th>
              <th>{{ t('rankings.details') }}</th>
              <th v-if="eventStore.isHost">{{ t('rankings.actions') }}</th>
            </tr>
          </thead>
          <transition-group 
            tag="tbody" 
            appear 
            :css="false"
            @before-enter="beforeEnter" 
            @enter="enter" 
            @before-appear="beforeEnter"
            @appear="enter"
          >
            <tr 
              v-for="(row, index) in sorted" 
              :key="row.teamNumber" 
              :data-index="index"
              :data-team-row="row.teamNumber"
              class="ranking-row"
              @mouseenter="onRowEnter"
            >
              <td class="team-cell" @click="viewTeamDetails(row.teamNumber)" style="cursor: pointer;">
                <div 
                  class="team-cell-content" 
                  style="display: block; width: 100%;"
                  :style="{ viewTransitionName: transitionState.sharedElementId === `team-card-${row.teamNumber}` ? `team-card-${row.teamNumber}` : 'none' }"
                >
                  <div class="team-header-line">
                    <span
                      class="rank-index-badge"
                      :class="{
                        'rank-gold': index === 0,
                        'rank-silver': index === 1,
                        'rank-bronze': index === 2
                      }"
                    >{{ index + 1 }}</span>
                    <span class="team-num">{{ row.teamNumber }}</span>
                    <span v-if="recordStore.bannedTeams.includes(row.teamNumber)" class="banned-badge">{{ t('rankings.banned_badge') }}</span>
                  </div>
                </div>
              </td>
              <td>{{ row.matchCount }}</td>
              <td :class="{'high-breakdown': row.brokenCount > 0 && row.brokenCount / row.matchCount >= 0.5}">{{ row.brokenCount }} / {{ row.matchCount }}</td>
              <td>
                <div class="telemetry-cell">
                  <AnimatedNumber :value="row.avgAutoScore" />
                  <div class="telemetry-bar-track"><div class="telemetry-bar-fill bar-cyan" :style="{ width: barPct(row.avgAutoScore, maxMetrics.auto) }"></div></div>
                </div>
              </td>
              <td>
                <div class="telemetry-cell">
                  <AnimatedNumber :value="row.avgTeleopScore" />
                  <div class="telemetry-bar-track"><div class="telemetry-bar-fill bar-green" :style="{ width: barPct(row.avgTeleopScore, maxMetrics.tele) }"></div></div>
                </div>
              </td>
              <td>
                <div class="telemetry-cell">
                  <AnimatedNumber :value="row.avgEndgameScore" />
                  <div class="telemetry-bar-track"><div class="telemetry-bar-fill bar-amber" :style="{ width: barPct(row.avgEndgameScore, maxMetrics.end) }"></div></div>
                </div>
              </td>
              <td><AnimatedNumber :value="row.avgTipsPerMatch ?? 0" /></td>
              <td><AnimatedNumber :value="row.maxScore" /></td>
              <td class="total-cell">
                <div class="telemetry-cell">
                  <AnimatedNumber :value="row.avgRating" />
                  <div class="telemetry-bar-track"><div class="telemetry-bar-fill bar-primary" :style="{ width: barPct(row.avgRating, maxMetrics.rating) }"></div></div>
                </div>
              </td>
              <td
                v-for="f in visibleCustomFields"
                :key="f.fieldKey"
                class="custom-col-td"
              >
                <span v-if="teamCustomStats.get(row.teamNumber)?.[f.fieldKey]" class="custom-col-val">
                  {{ teamCustomStats.get(row.teamNumber)?.[f.fieldKey]?.display }}
                  <span v-if="f.unit && f.fieldType !== 'boolean'" class="unit-text">{{ f.unit }}</span>
                </span>
                <span v-else class="empty-cell">-</span>
              </td>
              <td class="trend-cell">
                <span v-if="row.trend === 'up'" class="material-icons" style="color: var(--status-success); font-size: 18px;" title="Trending Up">trending_up</span>
                <span v-else-if="row.trend === 'down'" class="material-icons" style="color: var(--status-error); font-size: 18px;" title="Trending Down">trending_down</span>
                <span v-else-if="row.trend === 'stable'" class="material-icons" style="color: var(--muted-foreground); font-size: 18px;" title="Stable">trending_flat</span>
                <span v-else class="material-icons" style="color: var(--status-warning); font-size: 18px;" title="New">fiber_new</span>
              </td>
              <td>
                <button class="details-btn" @click="viewTeamDetails(row.teamNumber)" :title="t('rankings.details')">
                  <span class="material-icons" style="font-size: 16px;">visibility</span>
                </button>
              </td>
              <td v-if="eventStore.isHost">
                <button 
                  v-if="recordStore.bannedTeams.includes(row.teamNumber)" 
                  class="unban-btn" 
                  @click="unbanTeam(row.teamNumber)"
                  :title="t('rankings.unban_team')"
                >
                  {{ t('rankings.unban_team') }}
                </button>
                <button 
                  v-else-if="row.matchCount >= 3" 
                  class="ban-btn" 
                  @click="banTeam(row.teamNumber)"
                  :title="t('rankings.ban_team')"
                >
                  {{ t('rankings.ban_team') }}
                </button>
              </td>
            </tr>
          </transition-group>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.table-container {
  position: relative;
  width: max-content;
  min-width: 100%;
}

.hover-highlight {
  position: absolute;
  left: 0;
  right: 0;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  pointer-events: none;
  transition: top var(--motion-duration-moderate) var(--motion-ease-out), height var(--motion-duration-moderate) var(--motion-ease-out), opacity var(--motion-duration-fast) ease;
  z-index: 5;
  border-radius: 6px;
}

.rankings-panel {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
}

.loading-msg,
.empty-state {
  text-align: center;
  padding: 48px;
  color: var(--muted-foreground);
}

.table-wrapper {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  width: 100%;
  box-sizing: border-box;
}

table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 14px;
  min-width: 760px;
}

thead th {
  background: var(--card);
  padding: 12px 16px;
  text-align: left;
  font-weight: 600;
  color: var(--muted-foreground);
  border-bottom: 2px solid var(--border);
  white-space: nowrap;
  position: relative;
  z-index: 6;
}

thead th:first-child {
  position: sticky;
  left: 0;
  z-index: 12;
  background: var(--card);
  box-shadow: 2px 0 6px -2px rgba(0, 0, 0, 0.4);
}

th.sortable {
  cursor: pointer;
  user-select: none;
}

th.sortable:hover {
  color: var(--foreground);
}

.sort-icon {
  font-size: 18px;
  vertical-align: middle;
  display: inline-block;
  opacity: 0.25;
  transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease, color 0.2s ease;
}

.sort-icon.is-active {
  opacity: 1;
  color: var(--primary);
}

.sort-icon.is-asc {
  transform: rotate(180deg);
}

tbody td {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  color: var(--muted-foreground);
  background: var(--card);
  transition: background-color 0.15s ease;
}

tbody td:first-child {
  position: sticky;
  left: 0;
  z-index: 2;
  background: var(--card);
  box-shadow: 2px 0 6px -2px rgba(0, 0, 0, 0.4);
}

.rank-index-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 20px;
  padding: 0 5px;
  border-radius: 5px;
  font-family: 'Orbitron', sans-serif;
  font-size: 11px;
  font-weight: 800;
  background: var(--surface-recessed, #080807);
  border: 1px solid var(--border, #262624);
  color: var(--muted-foreground);
}

.rank-index-badge.rank-gold {
  background: #231c07;
  border-color: #eab308;
  color: #facc15;
  box-shadow: 0 0 10px rgba(234, 179, 8, 0.28);
}

.rank-index-badge.rank-silver {
  background: #181b20;
  border-color: #94a3b8;
  color: #e2e8f0;
}

.rank-index-badge.rank-bronze {
  background: #221409;
  border-color: #f97316;
  color: #fb923c;
}

.telemetry-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 58px;
}

.telemetry-bar-track {
  width: 100%;
  max-width: 68px;
  height: 3px;
  background: var(--surface-recessed, #080807);
  border-radius: 2px;
  overflow: hidden;
}

.telemetry-bar-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.45s var(--motion-ease-out);
}

.telemetry-bar-fill.bar-cyan { background: #38bdf8; }
.telemetry-bar-fill.bar-green { background: #22c55e; }
.telemetry-bar-fill.bar-amber { background: #f59e0b; }
.telemetry-bar-fill.bar-primary { background: var(--primary, #39ff14); box-shadow: 0 0 6px rgba(57, 255, 20, 0.6); }

.team-cell {
  font-weight: 700;
  color: var(--foreground);
  min-width: 145px;
}

.total-cell {
  font-weight: 700;
  color: var(--primary);
}

.high-breakdown {
  color: var(--status-error);
  font-weight: bold;
}

/* Custom column header & cell */
th.custom-col-th {
  color: var(--foreground);
}

td.custom-col-td {
  font-variant-numeric: tabular-nums;
}

.custom-col-val {
  font-weight: 600;
  color: var(--foreground);
}

.custom-col-val .unit-text {
  font-size: 10px;
  font-weight: 400;
  color: var(--muted-foreground);
  margin-left: 2px;
}

.empty-cell {
  color: var(--muted-foreground);
}

/* ── 表格内队伍单元格标签展示 ── */
.team-header-line {
  display: flex;
  align-items: center;
  gap: 6px;
}

.details-btn {
  background: var(--card);
  color: var(--primary);
  border: 1px solid var(--primary);
  border-radius: 4px;
  padding: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s;
}

.details-btn:hover {
  background: var(--primary);
  color: var(--primary-foreground);
}

.banned-badge {
  background: var(--status-error);
  color: white;
  font-size: 10px;
  padding: 2px 4px;
  border-radius: 4px;
  margin-left: 8px;
  vertical-align: middle;
}

.ban-btn {
  background: rgba(239, 68, 68, 0.12);
  color: var(--status-error);
  border: 1px solid var(--status-error);
  border-radius: 4px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.ban-btn:hover {
  background: var(--status-error);
  color: white;
}

.unban-btn {
  background: rgba(57, 255, 20, 0.12);
  color: var(--primary);
  border: 1px solid var(--primary);
  border-radius: 4px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.unban-btn:hover {
  background: var(--primary);
  color: var(--primary-foreground);
}

@media (max-width: 680px) {
  table {
    font-size: 13px;
  }
  thead th, tbody td {
    padding: 10px 12px;
  }
}
</style>
