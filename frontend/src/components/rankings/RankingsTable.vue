<script setup lang="ts">
import { ref, computed, defineComponent, toRef, h, nextTick, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RankingRow, BragInfo } from '@/types'
import { useEventStore } from '@/stores/events'
import { useRecordStore } from '@/stores/records'
import { usePitScoutStore } from '@/stores/pitScout'
import { useToastStore } from '@/stores/toast'
import { useRouter, useRoute } from 'vue-router'
import { transitionState } from '@/utils/transitionState'
import { useTween } from '@/composables/useTween'
import { useNavigationStore } from '@/stores/navigation'
import { useAiStore } from '@/stores/ai'
import { hapticLight } from '@/utils/haptics'
import { useConfirm } from '@/composables/useConfirm'
import { calculateBragIndex } from '@/utils/bragIndex'
import RankingsTableToolbar from './RankingsTableToolbar.vue'
import { useRankingsCustomColumns } from './useRankingsCustomColumns'

// Inline component for animated numbers
const AnimatedNumber = defineComponent({
  props: { value: { type: Number, default: 0 } },
  setup(props) {
    const valRef = computed(() => Number.isFinite(props.value) ? props.value : 0)
    const tweened = useTween(valRef, 800)
    return () => h('span', tweened.value.toFixed(1))
  }
})

const { t, te, locale } = useI18n()
const eventStore = useEventStore()
const recordStore = useRecordStore()
const pitStore = usePitScoutStore()
const toastStore = useToastStore()
const router = useRouter()
const route = useRoute()
const navStore = useNavigationStore()
const aiStore = useAiStore()

async function askAiForTeam(teamNumber: number) {
  const evtId = eventStore.currentEvent?.id || (route.params.eventId as string) || ''
  if (!evtId) return
  await aiStore.openCopilotForTeam(evtId, teamNumber, undefined, locale.value)
  if (typeof window !== 'undefined' && window.innerWidth <= 768) {
    router.replace({ query: { ...route.query, tab: 'ai' } })
  }
}

const props = defineProps<{
  rankings: RankingRow[]
  loading: boolean
}>()

type SortKey = keyof RankingRow | string
const sortKey = ref<SortKey>('advancementPoints')
const sortDir = ref<'asc' | 'desc'>('desc')

// 标签筛选
const selectedTagFilter = ref<string | null>(null)

const activeEventId = computed<string>(() =>
  eventStore.currentEvent?.id || recordStore.currentEventId || (route.params.eventId as string) || ''
)

const scopedTeamTags = computed(() => {
  const eid = activeEventId.value
  return eid ? recordStore.teamTags.filter(t => !t.eventId || t.eventId === eid) : recordStore.teamTags
})

watch(activeEventId, () => {
  selectedTagFilter.value = null
})

const availableFilterTags = computed<string[]>(() => {
  const all = scopedTeamTags.value.map(t => t.tag)
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
} = useRankingsCustomColumns(toRef(props, 'rankings'))

function setSort(key: SortKey) {
  hapticLight()
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    sortDir.value = (key === 'predictCycleTime' || key === 'teleopCycleTime' || key === 'autoCycleTime' || key === 'cycleVariance') ? 'asc' : 'desc'
  }
}

const filteredRankings = computed<RankingRow[]>(() => {
  let arr = [...props.rankings]
  if (selectedTagFilter.value) {
    const matchingTeams = new Set(
      scopedTeamTags.value
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
      const aHas = aStat !== undefined && Number.isFinite(aStat.value)
      const bHas = bStat !== undefined && Number.isFinite(bStat.value)
      if (!aHas && !bHas) return 0
      if (!aHas) return 1
      if (!bHas) return -1
      return sortDir.value === 'asc' ? aStat!.value - bStat!.value : bStat!.value - aStat!.value
    }
    if (sortKey.value === 'advancementPoints') {
      const aPts = a.advancementPoints ?? 0
      const bPts = b.advancementPoints ?? 0
      if (aPts !== bPts) {
        return sortDir.value === 'asc' ? aPts - bPts : bPts - aPts
      }
      // Official Table 4-2 tiebreakers: advancementRank, then avgRating, then teamNumber
      const aRank = a.advancementRank ?? 9999
      const bRank = b.advancementRank ?? 9999
      if (aRank !== bRank) {
        return sortDir.value === 'asc' ? bRank - aRank : aRank - bRank
      }
      if ((a.avgRating ?? 0) !== (b.avgRating ?? 0)) {
        return sortDir.value === 'asc' ? (a.avgRating ?? 0) - (b.avgRating ?? 0) : (b.avgRating ?? 0) - (a.avgRating ?? 0)
      }
      return sortDir.value === 'asc' ? b.teamNumber - a.teamNumber : a.teamNumber - b.teamNumber
    }
    const av = a[sortKey.value as keyof RankingRow]
    const bv = b[sortKey.value as keyof RankingRow]
    const aValid = typeof av === 'number' && Number.isFinite(av)
    const bValid = typeof bv === 'number' && Number.isFinite(bv)
    if (!aValid && !bValid) return 0
    if (!aValid) return 1
    if (!bValid) return -1
    return sortDir.value === 'asc' ? av - bv : bv - av
  })
  return arr
})

const bragInfoMap = computed(() => {
  const map = new Map<number, BragInfo | null>()
  const eventId = eventStore.currentEvent?.id
  for (const row of props.rankings) {
    const pitRec = pitStore.getUnifiedTeam(row.teamNumber)?.pitRecord
    const teamMatches = recordStore.activeRecords.filter(
      r => r.teamNumber === row.teamNumber && (!eventId || r.eventId === eventId)
    )
    map.set(row.teamNumber, calculateBragIndex(pitRec, teamMatches) ?? null)
  }
  return map
})

function formatBragText(brag: BragInfo | null | undefined): string {
  if (!brag) return '-'
  if (brag.label) return brag.label
  if (brag.labelKey && te(brag.labelKey)) return t(brag.labelKey)
  return brag.tier
}

function getBragTooltip(brag: BragInfo | null | undefined): string {
  if (!brag) return ''
  const parts: string[] = []
  if (Array.isArray(brag.statusKeys) && brag.statusKeys.length > 0) {
    for (const key of brag.statusKeys) {
      parts.push(te(key) ? t(key) : key)
    }
  } else {
    if (brag.flowerVerified) parts.push(t('pit_scout.flower_verified'))
    else if (brag.flowerPending) parts.push(t('pit_scout.flower_pending_verify'))
    if (brag.parkVerified) parts.push(t('pit_scout.park_verified'))
    else if (brag.parkPending) parts.push(t('pit_scout.park_pending'))
  }
  return parts.join(' · ')
}

function formatAdvancementStatus(status?: string, row?: RankingRow): string {
  if (!status) return ''
  switch (status.toUpperCase()) {
    case 'ADVANCING':
      return row?.advancementRolledDown
        ? t('rankings.advancement_status_rolled_down')
        : t('rankings.advancement_status_advancing')
    case 'ALREADY_ADVANCING':
      return t('rankings.advancement_status_already_advancing')
    case 'DECLINED':
      return t('rankings.advancement_status_declined')
    case 'INELIGIBLE':
      return t('rankings.advancement_status_ineligible')
    case 'BUBBLE':
      return t('rankings.advancement_status_bubble')
    case 'COMPETING':
      return t('rankings.advancement_status_competing')
    default:
      return status
  }
}

function getAdvancementTooltip(row: RankingRow): string {
  const b = row.advancementBreakdown
  const parts: string[] = []
  if (b) {
    parts.push(
      t('rankings.advancement_breakdown_tooltip', {
        qual: b.qualPoints,
        alliance: b.alliancePoints,
        playoff: b.playoffPoints,
        award: b.awardPoints
      })
    )
  } else {
    parts.push(`${t('rankings.advancement_points')}: ${row.advancementPoints ?? 0}`)
  }

  if (row.advancementRolledDown) {
    parts.push(t('rankings.advancement_rolled_down_note', { slot: row.advancementSlot ?? row.advancementRank ?? '-' }))
  } else if (row.advancementStatus === 'ALREADY_ADVANCING') {
    parts.push(t('rankings.advancement_already_advancing_note'))
  } else if (row.advancementStatus === 'DECLINED') {
    parts.push(t('rankings.advancement_declined_note'))
  } else if (row.advancementStatus === 'INELIGIBLE') {
    parts.push(t('rankings.advancement_ineligible_note'))
  }
  return parts.join(' · ')
}

function formatNpOprConfidence(conf?: RankingRow['spNpOprConfidence']): string {
  if (!conf) return ''
  return t(`rankings.np_opr_conf_${conf}`)
}

function getNpOprTooltip(row: RankingRow): string {
  if (row.spNpOpr === undefined || row.spNpOpr === null) return ''
  const rawStr = row.rawNpOpr !== null && row.rawNpOpr !== undefined ? row.rawNpOpr.toFixed(1) : '—'
  const autoStr = row.spNpOprAuto !== null && row.spNpOprAuto !== undefined ? row.spNpOprAuto.toFixed(1) : '—'
  const teleStr = row.spNpOprTeleop !== null && row.spNpOprTeleop !== undefined ? row.spNpOprTeleop.toFixed(1) : '—'
  const endStr = row.spNpOprEndgame !== null && row.spNpOprEndgame !== undefined ? row.spNpOprEndgame.toFixed(1) : '—'
  const deltaStr = row.spNpOprDelta !== null && row.spNpOprDelta !== undefined
    ? `${row.spNpOprDelta >= 0 ? '+' : ''}${row.spNpOprDelta.toFixed(1)}`
    : '—'
  const confStr = formatNpOprConfidence(row.spNpOprConfidence)
  const broken = row.spNpOprBrokenExcluded ?? 0
  return t('rankings.sp_np_opr_tooltip', {
    raw: rawStr,
    auto: autoStr,
    teleop: teleStr,
    endgame: endStr,
    delta: deltaStr,
    confidence: confStr,
    broken
  })
}

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
              <th @click="setSort('advancementPoints')" class="sortable advancement-col-th" :title="t('rankings.advancement_points_desc')">
                {{ t('rankings.advancement_points') }}<span class="material-icons sort-icon" :class="{ 'is-active': sortKey === 'advancementPoints', 'is-asc': sortKey === 'advancementPoints' && sortDir === 'asc' }">arrow_drop_down</span>
              </th>
              <th @click="setSort('teamNumber')" class="sortable team-col-th">
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
              <th @click="setSort('avgMobilityRpPts')" class="sortable" :title="t('rankings.avg_mobility_rp_pts_desc')">
                {{ t('rankings.avg_mobility_rp_pts') }}<span class="material-icons sort-icon" :class="{ 'is-active': sortKey === 'avgMobilityRpPts', 'is-asc': sortKey === 'avgMobilityRpPts' && sortDir === 'asc' }">arrow_drop_down</span>
              </th>
              <th @click="setSort('teleopParkRate')" class="sortable" :title="t('rankings.teleop_park_rate_desc')">
                {{ t('rankings.teleop_park_rate') }}<span class="material-icons sort-icon" :class="{ 'is-active': sortKey === 'teleopParkRate', 'is-asc': sortKey === 'teleopParkRate' && sortDir === 'asc' }">arrow_drop_down</span>
              </th>
              <th @click="setSort('avgFlowerNectars')" class="sortable">
                {{ t('rankings.avg_flower_nectars') }}<span class="material-icons sort-icon" :class="{ 'is-active': sortKey === 'avgFlowerNectars', 'is-asc': sortKey === 'avgFlowerNectars' && sortDir === 'asc' }">arrow_drop_down</span>
              </th>
              <th @click="setSort('autoCycleTime')" class="sortable" :title="t('rankings.auto_cycle_time_desc')">
                {{ t('rankings.auto_cycle_time') }}<span class="material-icons sort-icon" :class="{ 'is-active': sortKey === 'autoCycleTime', 'is-asc': sortKey === 'autoCycleTime' && sortDir === 'asc' }">arrow_drop_down</span>
              </th>
              <th @click="setSort('predictCycleTime')" class="sortable" :title="t('rankings.predict_cycle_time_desc')">
                {{ t('rankings.predict_cycle_time') }}<span class="material-icons sort-icon" :class="{ 'is-active': sortKey === 'predictCycleTime', 'is-asc': sortKey === 'predictCycleTime' && sortDir === 'asc' }">arrow_drop_down</span>
              </th>
              <th @click="setSort('minCycles')" class="sortable" :title="t('rankings.min_cycles_desc')">
                {{ t('rankings.min_cycles') }}<span class="material-icons sort-icon" :class="{ 'is-active': sortKey === 'minCycles', 'is-asc': sortKey === 'minCycles' && sortDir === 'asc' }">arrow_drop_down</span>
              </th>
              <th @click="setSort('cycleVariance')" class="sortable" :title="t('rankings.cycle_variance_desc')">
                {{ t('rankings.cycle_variance') }}<span class="material-icons sort-icon" :class="{ 'is-active': sortKey === 'cycleVariance', 'is-asc': sortKey === 'cycleVariance' && sortDir === 'asc' }">arrow_drop_down</span>
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
              <th @click="setSort('spNpOpr')" class="sortable" :title="t('rankings.sp_np_opr_desc')">
                {{ t('rankings.sp_np_opr') }}<span class="material-icons sort-icon" :class="{ 'is-active': sortKey === 'spNpOpr', 'is-asc': sortKey === 'spNpOpr' && sortDir === 'asc' }">arrow_drop_down</span>
              </th>
              <th :title="t('rankings.brag_index_desc')">
                {{ t('rankings.brag_index') }}
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
              <td class="advancement-cell" :title="getAdvancementTooltip(row)">
                <div class="advancement-cell-content">
                  <span class="advancement-score-val">{{ row.advancementPoints ?? 0 }}</span>
                  <span
                    v-if="row.advancementStatus && row.advancementStatus !== 'NONE'"
                    class="advancement-status-badge"
                    :class="[`status-${row.advancementStatus.toLowerCase()}`, { 'is-rolled-down': row.advancementRolledDown }]"
                  >
                    {{ formatAdvancementStatus(row.advancementStatus, row) }}
                  </span>
                </div>
              </td>
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
                  <AnimatedNumber :value="row.avgAutoScore ?? 0" />
                  <div class="telemetry-bar-track"><div class="telemetry-bar-fill bar-cyan" :style="{ width: barPct(row.avgAutoScore, maxMetrics.auto) }"></div></div>
                </div>
              </td>
              <td>
                <div class="telemetry-cell">
                  <AnimatedNumber :value="row.avgTeleopScore ?? 0" />
                  <div class="telemetry-bar-track"><div class="telemetry-bar-fill bar-green" :style="{ width: barPct(row.avgTeleopScore, maxMetrics.tele) }"></div></div>
                </div>
              </td>
              <td>
                <div class="telemetry-cell">
                  <AnimatedNumber :value="row.avgEndgameScore ?? 0" />
                  <div class="telemetry-bar-track"><div class="telemetry-bar-fill bar-amber" :style="{ width: barPct(row.avgEndgameScore, maxMetrics.end) }"></div></div>
                </div>
              </td>
              <td>
                <div class="telemetry-cell">
                  <AnimatedNumber :value="row.avgMobilityRpPts ?? 0" />
                  <div class="telemetry-bar-track"><div class="telemetry-bar-fill bar-cyan" :style="{ width: barPct(row.avgMobilityRpPts ?? 0, 13) }"></div></div>
                </div>
              </td>
              <td>{{ Math.round((row.teleopParkRate ?? 0) * 100) }}%</td>
              <td>
                <div class="flower-garden-cell">
                  <span class="fg-main">N:{{ row.avgFlowerNectars ?? 0 }} B:{{ row.avgFlowerBottomBonus ?? 0 }}</span>
                  <span class="fg-sub">P:{{ row.avgFlowerPollens ?? 0 }} G:{{ row.avgGardenBalls ?? 0 }}</span>
                  <span v-if="(row.g410FoulRate ?? 0) > 0" class="fg-foul-pill">G410 {{ Math.round((row.g410FoulRate ?? 0) * 100) }}%</span>
                </div>
              </td>
              <td>
                <div v-if="row.autoCycleTime !== null && row.autoCycleTime !== undefined" class="predict-cycle-cell">
                  <span class="predict-cycle-main">{{ t('rankings.predict_cycle_time_unit', { sec: row.autoCycleTime }) }}</span>
                  <span class="predict-cycle-sub">
                    {{ t('rankings.predict_cycle_matches_count', { count: row.autoCycleMatches ?? 0 }) }}
                  </span>
                </div>
                <span v-else class="empty-cell">-</span>
              </td>
              <td>
                <div v-if="row.predictCycleTime !== null && row.predictCycleTime !== undefined" class="predict-cycle-cell">
                  <span class="predict-cycle-main">{{ t('rankings.predict_cycle_time_unit', { sec: row.predictCycleTime }) }}</span>
                  <span class="predict-cycle-sub">
                    {{ t('rankings.predict_cycle_spread', { sec: row.predictCycleSpread ?? 0 }) }} · {{ t('rankings.estimated_max_cycles_unit', { cycles: row.estimatedMaxCycles ?? 0 }) }}
                  </span>
                  <span class="predict-cycle-sub">
                    {{ t('rankings.predict_cycle_matches_count', { count: row.predictCycleMatches ?? 0 }) }}
                  </span>
                </div>
                <span v-else class="empty-cell" :title="t('rankings.predict_cycle_insufficient')">
                  {{ t('rankings.predict_cycle_insufficient_short') }}
                </span>
              </td>
              <td>
                <span v-if="row.minCycles !== null && row.minCycles !== undefined">{{ row.minCycles }}</span>
                <span v-else class="empty-cell">-</span>
              </td>
              <td>
                <span v-if="row.cycleVariance !== null && row.cycleVariance !== undefined">{{ row.cycleVariance.toFixed(1) }}</span>
                <span v-else class="empty-cell">-</span>
              </td>
              <td><AnimatedNumber :value="row.avgTipsPerMatch ?? 0" /></td>
              <td><AnimatedNumber :value="row.maxScore ?? 0" /></td>
              <td class="total-cell">
                <div class="telemetry-cell">
                  <AnimatedNumber :value="row.avgRating ?? 0" />
                  <div class="telemetry-bar-track"><div class="telemetry-bar-fill bar-primary" :style="{ width: barPct(row.avgRating, maxMetrics.rating) }"></div></div>
                </div>
              </td>
              <td :title="getNpOprTooltip(row)">
                <div v-if="row.spNpOpr !== undefined && row.spNpOpr !== null" class="np-opr-cell">
                  <span class="np-opr-main">{{ row.spNpOpr.toFixed(1) }}</span>
                  <div class="np-opr-sub">
                    <span
                      v-if="row.spNpOprConfidence"
                      class="np-opr-conf-badge"
                      :class="`conf-${row.spNpOprConfidence}`"
                    >
                      {{ formatNpOprConfidence(row.spNpOprConfidence) }}
                    </span>
                    <span v-if="row.rawNpOpr !== null && row.rawNpOpr !== undefined" class="np-opr-raw">
                      {{ t('rankings.raw_short', { val: row.rawNpOpr.toFixed(1) }) }}
                    </span>
                  </div>
                </div>
                <span v-else class="empty-cell">-</span>
              </td>
              <td>
                <span
                  v-if="bragInfoMap.get(row.teamNumber)"
                  class="brag-tier-pill"
                  :class="`tier-${bragInfoMap.get(row.teamNumber)!.tier}`"
                  :title="getBragTooltip(bragInfoMap.get(row.teamNumber))"
                >
                  {{ formatBragText(bragInfoMap.get(row.teamNumber)) }}
                </span>
                <span v-else class="empty-cell">-</span>
              </td>
              <td
                v-for="f in visibleCustomFields"
                :key="f.fieldKey"
                class="custom-col-td"
                :title="teamCustomStats.get(row.teamNumber)?.[f.fieldKey]?.error || ''"
              >
                <span
                  v-if="teamCustomStats.get(row.teamNumber)?.[f.fieldKey]"
                  class="custom-col-val"
                  :class="[
                    teamCustomStats.get(row.teamNumber)?.[f.fieldKey]?.tier
                      ? `custom-tier-${teamCustomStats.get(row.teamNumber)?.[f.fieldKey]?.tier}`
                      : '',
                    teamCustomStats.get(row.teamNumber)?.[f.fieldKey]?.error ? 'custom-col-error' : ''
                  ]"
                >
                  {{ teamCustomStats.get(row.teamNumber)?.[f.fieldKey]?.display }}
                  <span v-if="f.unit && f.fieldType !== 'boolean' && f.displayFormat !== 'percent'" class="unit-text">{{ f.unit }}</span>
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
                <div class="detail-actions-cell">
                  <button class="details-btn" @click="viewTeamDetails(row.teamNumber)" :title="t('rankings.details')">
                    <span class="material-icons" style="font-size: 16px;">visibility</span>
                  </button>
                  <button
                    type="button"
                    class="details-btn ai-ask-btn"
                    @click.stop="askAiForTeam(row.teamNumber)"
                    :title="t('ai.ask_ai_about_team')"
                  >
                    <span class="material-icons" style="font-size: 16px;">auto_awesome</span>
                  </button>
                </div>
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
  background: color-mix(in srgb, var(--g-50) 4%, transparent);
  border: 1px solid color-mix(in srgb, var(--g-50) 8%, transparent);
  pointer-events: none;
  transition: top var(--motion-duration-moderate) var(--motion-ease-out), height var(--motion-duration-moderate) var(--motion-ease-out), opacity var(--motion-duration-fast) var(--motion-ease-out);
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

/* Dual sticky frozen columns on horizontal scrolling */
thead th.advancement-col-th,
tbody td.advancement-cell {
  position: sticky;
  left: 0;
  width: 136px;
  min-width: 136px;
  max-width: 136px;
  padding: 12px 8px;
  background: var(--card);
  box-sizing: border-box;
  overflow: hidden;
}

thead th.advancement-col-th {
  z-index: 12;
  text-overflow: ellipsis;
}

tbody td.advancement-cell {
  z-index: 4;
}

thead th.team-col-th,
tbody td.team-cell {
  position: sticky;
  left: 136px;
  min-width: 130px;
  background: var(--card);
  box-shadow: 2px 0 6px -2px color-mix(in srgb, var(--g-950) 65%, transparent);
  box-sizing: border-box;
}

thead th.team-col-th {
  z-index: 11;
}

tbody td.team-cell {
  z-index: 3;
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
  transition: transform var(--motion-duration-moderate) var(--motion-ease-out),
              opacity var(--motion-duration-fast) var(--motion-ease-out),
              color var(--motion-duration-fast) var(--motion-ease-out);
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
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out);
}



.advancement-cell {
  white-space: nowrap;
}

.advancement-cell-content {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
}

.advancement-score-val {
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
  font-size: 15px;
  font-weight: 700;
  color: var(--primary);
  min-width: 28px;
  text-align: right;
}

.advancement-status-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 9.5px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 0.2px;
  white-space: nowrap;
}

.advancement-status-badge.status-advancing {
  background: var(--status-success-bg);
  border: 1px solid var(--status-success-border);
  color: var(--status-success);
}

.advancement-status-badge.status-advancing.is-rolled-down {
  background: color-mix(in srgb, var(--status-success-bg) 60%, var(--status-info-bg));
  border: 1px solid color-mix(in srgb, var(--status-success) 45%, var(--status-info));
  color: var(--s-200);
}

.advancement-status-badge.status-already_advancing {
  background: var(--status-info-bg);
  border: 1px solid var(--status-info-border);
  color: var(--status-info);
}

.advancement-status-badge.status-declined,
.advancement-status-badge.status-ineligible {
  background: var(--status-error-bg);
  border: 1px solid var(--status-error-border);
  color: var(--status-error-text);
}

.advancement-status-badge.status-bubble {
  background: var(--status-warning-bg);
  border: 1px solid var(--status-warning-border);
  color: var(--status-warning);
}

.advancement-status-badge.status-competing {
  background: var(--surface-elevated);
  border: 1px solid var(--border);
  color: var(--muted-foreground);
}

.rank-index-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 20px;
  padding: 0 5px;
  border-radius: 5px;
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  font-weight: 800;
  background: var(--surface-recessed);
  border: 1px solid var(--border);
  color: var(--muted-foreground);
}

.rank-index-badge.rank-gold {
  background: var(--status-warning-bg);
  border-color: var(--status-warning);
  color: var(--status-warning);
}

.rank-index-badge.rank-silver {
  background: var(--surface-elevated);
  border-color: var(--g-400);
  color: var(--g-100);
}

.rank-index-badge.rank-bronze {
  background: color-mix(in srgb, var(--status-warning-bg) 75%, var(--status-error-bg));
  border-color: color-mix(in srgb, var(--status-warning) 60%, var(--red-500));
  color: color-mix(in srgb, var(--status-warning) 65%, var(--red-400));
}

.telemetry-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 58px;
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
}

.telemetry-bar-track {
  width: 100%;
  max-width: 68px;
  height: 3px;
  background: var(--surface-recessed);
  border-radius: 2px;
  overflow: hidden;
}

.telemetry-bar-fill {
  height: 100%;
  border-radius: 2px;
  transition: width var(--motion-duration-slow) var(--motion-ease-out);
}

.telemetry-bar-fill.bar-cyan { background: var(--phase-auto); }
.telemetry-bar-fill.bar-green { background: var(--phase-teleop); }
.telemetry-bar-fill.bar-amber { background: var(--phase-endgame); }
.telemetry-bar-fill.bar-primary { background: var(--primary); }

.team-cell {
  font-weight: 700;
  color: var(--foreground);
  min-width: 145px;
}

.team-num {
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
}

.total-cell {
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
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
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out),
              border-color var(--motion-duration-fast) var(--motion-ease-out),
              color var(--motion-duration-fast) var(--motion-ease-out);
}

.details-btn:hover {
  background: var(--primary);
  color: var(--primary-foreground);
}

.banned-badge {
  background: var(--status-error);
  color: var(--destructive-foreground);
  font-size: 10px;
  padding: 2px 4px;
  border-radius: 4px;
  margin-left: 8px;
  vertical-align: middle;
}

.ban-btn {
  background: var(--status-error-bg);
  color: var(--status-error);
  border: 1px solid var(--status-error);
  border-radius: 4px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out),
              color var(--motion-duration-fast) var(--motion-ease-out);
}

.ban-btn:hover {
  background: var(--status-error);
  color: var(--destructive-foreground);
}

.unban-btn {
  background: var(--status-success-bg);
  color: var(--primary);
  border: 1px solid var(--primary);
  border-radius: 4px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out),
              color var(--motion-duration-fast) var(--motion-ease-out);
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

.flower-garden-cell,
.predict-cycle-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  white-space: nowrap;
}

.fg-main,
.predict-cycle-main {
  font-weight: 700;
  color: var(--foreground);
  font-variant-numeric: tabular-nums;
}

.fg-sub,
.predict-cycle-sub {
  font-size: 11px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

.fg-foul-pill {
  display: inline-block;
  width: fit-content;
  font-size: 10px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--status-warning-bg);
  color: var(--status-warning);
  border: 1px solid var(--status-warning-border);
}

.brag-tier-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  border: 1px solid var(--border);
  background: var(--surface-elevated);
  color: var(--foreground);
}

.brag-tier-pill.tier-realistic,
.brag-tier-pill.tier-elite {
  border-color: var(--status-success-border);
  background: var(--status-success-bg);
  color: var(--status-success);
}

.brag-tier-pill.tier-honest {
  border-color: var(--status-info-border);
  background: var(--status-info-bg);
  color: var(--status-info);
}

.brag-tier-pill.tier-optimistic,
.brag-tier-pill.tier-optimist {
  border-color: var(--status-warning-border);
  background: var(--status-warning-bg);
  color: var(--status-warning);
}

.brag-tier-pill.tier-overclaimed {
  border-color: color-mix(in srgb, var(--status-warning-border) 50%, var(--status-error-border));
  background: color-mix(in srgb, var(--status-warning-bg) 50%, var(--status-error-bg));
  color: color-mix(in srgb, var(--status-warning) 55%, var(--status-error));
}

.brag-tier-pill.tier-mythical {
  border-color: var(--status-error-border);
  background: var(--status-error-bg);
  color: var(--status-error);
}

.brag-tier-pill.tier-pending {
  border-color: var(--border);
  background: var(--surface-elevated);
  color: var(--muted-foreground);
}

.detail-actions-cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.details-btn.ai-ask-btn {
  color: var(--status-ai);
  border-color: var(--status-ai-border);
  background: var(--status-ai-bg);
}

.details-btn.ai-ask-btn:hover {
  border-color: var(--status-ai);
  transform: translateY(-1px);
}

.np-opr-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  white-space: nowrap;
}

.np-opr-main {
  font-weight: 700;
  color: var(--foreground);
  font-variant-numeric: tabular-nums;
}

.np-opr-sub {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--muted-foreground);
}

.np-opr-conf-badge {
  padding: 1px 5px;
  border-radius: 4px;
  font-weight: 700;
  border: 1px solid var(--border);
}

.np-opr-conf-badge.conf-high {
  background: var(--status-success-bg);
  color: var(--status-success);
  border-color: var(--status-success-border);
}

.np-opr-conf-badge.conf-medium {
  background: var(--status-info-bg);
  color: var(--status-info);
  border-color: var(--status-info-border);
}

.np-opr-conf-badge.conf-low {
  background: var(--status-warning-bg);
  color: var(--status-warning);
  border-color: var(--status-warning-border);
}

.np-opr-conf-badge.conf-scout_only {
  background: var(--surface-elevated);
  color: var(--muted-foreground);
}

.custom-tier-high {
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--status-success-bg);
  color: var(--status-success);
  font-weight: 700;
}

.custom-tier-mid {
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--status-warning-bg);
  color: var(--status-warning);
  font-weight: 600;
}

.custom-tier-low {
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--status-error-bg);
  color: var(--status-error);
  font-weight: 600;
}

.custom-col-error {
  color: var(--status-error);
  font-weight: 700;
}
</style>
