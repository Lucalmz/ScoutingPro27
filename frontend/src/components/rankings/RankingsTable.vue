<script setup lang="ts">
import { ref, computed, defineComponent, toRef, h, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RankingRow } from '@/types'
import { useEventStore } from '@/stores/events'
import { useRecordStore } from '@/stores/records'
import { useToastStore } from '@/stores/toast'
import { useRouter } from 'vue-router'
import { transitionState } from '@/utils/transitionState'
import { useTween } from '@/composables/useTween'

// Inline component for animated numbers
const AnimatedNumber = defineComponent({
  props: { value: { type: Number, required: true } },
  setup(props) {
    const valRef = toRef(props, 'value')
    const tweened = useTween(valRef, 800)
    return () => h('span', tweened.value.toFixed(1))
  }
})

const { t, te } = useI18n()
const eventStore = useEventStore()
const recordStore = useRecordStore()
const toastStore = useToastStore()
const router = useRouter()

const props = defineProps<{
  rankings: RankingRow[]
  loading: boolean
}>()

type SortKey = keyof RankingRow
const sortKey = ref<SortKey>('avgRating')
const sortDir = ref<'asc' | 'desc'>('desc')

// 标签筛选
const selectedTagFilter = ref<string | null>(null)

const availableFilterTags = computed<string[]>(() => {
  const all = recordStore.teamTags.map(t => t.tag)
  return Array.from(new Set(all))
})

function formatTagLabel(tagKey?: string | null): string {
  if (!tagKey) return ''
  if (tagKey.startsWith('preset.')) {
    const i18nKey = `tags.${tagKey}`
    return te(i18nKey) ? t(i18nKey) : tagKey.replace(/^preset\./, '')
  }
  return tagKey
}

function setSort(key: SortKey) {
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
    const av = a[sortKey.value]
    const bv = b[sortKey.value]
    if (typeof av === 'number' && typeof bv === 'number') {
      return sortDir.value === 'asc' ? av - bv : bv - av
    }
    return 0
  })
  return arr
})

function sortIndicator(key: SortKey): string {
  if (sortKey.value !== key) return ''
  return sortDir.value === 'asc' ? 'arrow_drop_up' : 'arrow_drop_down'
}

const highlightTop = ref(0)
const highlightHeight = ref(0)
const highlightVisible = ref(false)

function onRowEnter(e: MouseEvent) {
  const target = e.currentTarget as HTMLElement
  const wrapper = target.closest('.table-wrapper') as HTMLElement
  if (wrapper && target) {
    const wrapperRect = wrapper.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    highlightTop.value = targetRect.top - wrapperRect.top + wrapper.scrollTop
    highlightHeight.value = targetRect.height
    highlightVisible.value = true
  }
}

function onTableLeave() {
  highlightVisible.value = false
}

const highlightStyle = computed(() => ({
  top: `${highlightTop.value}px`,
  height: `${highlightHeight.value}px`,
  opacity: highlightVisible.value ? 1 : 0
}))

async function banTeam(teamNumber: number) {
  if (!confirm(`Are you sure you want to ban team ${teamNumber}? Scouters will be warned not to record them.`)) {
    return
  }
  try {
    if (eventStore.currentEvent?.id) {
      await recordStore.banTeam(eventStore.currentEvent.id, teamNumber)
      toastStore.showToast(`Team ${teamNumber} has been banned`, 'success')
    }
  } catch (e: any) {
    toastStore.showToast(e.message || 'Failed to ban team', 'error')
  }
}

function viewTeamDetails(teamNumber: number) {
  if (eventStore.currentEvent?.id) {
    transitionState.startSharedTransition(`team-card-${teamNumber}`)
    nextTick(() => {
      router.push(`/event/${eventStore.currentEvent!.id}/team/${teamNumber}`)
    })
  }
}
</script>

<template>
  <div class="rankings-panel">
    <div v-if="loading" class="loading-msg">{{ t('rankings.loading') }}</div>
    <div v-else-if="rankings.length === 0" class="empty-state">
      <p>{{ t('rankings.no_data') }}</p>
    </div>
    <div v-else class="table-wrapper">
      <!-- 战术标签筛选栏 -->
      <div v-if="availableFilterTags.length > 0" class="tag-filter-bar">
        <span class="filter-title">{{ t('tags.filter_by_tag') }}:</span>
        <button
          class="filter-chip"
          :class="{ active: selectedTagFilter === null }"
          @click="selectedTagFilter = null"
        >
          {{ t('tags.all') }}
        </button>
        <button
          v-for="tagKey in availableFilterTags"
          :key="tagKey"
          class="filter-chip"
          :class="{ active: selectedTagFilter === tagKey }"
          @click="selectedTagFilter = (selectedTagFilter === tagKey ? null : tagKey)"
        >
          {{ formatTagLabel(tagKey) }}
        </button>
      </div>

      <table>
        <thead>
          <tr>
            <th @click="setSort('teamNumber')" class="sortable">
              {{ t('rankings.team') }}<span class="material-icons" style="font-size: 18px; vertical-align: middle;">{{ sortIndicator('teamNumber') }}</span>
            </th>
            <th @click="setSort('matchCount')" class="sortable">
              {{ t('rankings.matches') }}<span class="material-icons" style="font-size: 18px; vertical-align: middle;">{{ sortIndicator('matchCount') }}</span>
            </th>
            <th @click="setSort('brokenCount')" class="sortable">
              {{ t('rankings.breakdown') }}<span class="material-icons" style="font-size: 18px; vertical-align: middle;">{{ sortIndicator('brokenCount') }}</span>
            </th>
            <th @click="setSort('avgAutoScore')" class="sortable">
              {{ t('rankings.avg_auto') }}<span class="material-icons" style="font-size: 18px; vertical-align: middle;">{{ sortIndicator('avgAutoScore') }}</span>
            </th>
            <th @click="setSort('avgTeleopScore')" class="sortable">
              {{ t('rankings.avg_tele') }}<span class="material-icons" style="font-size: 18px; vertical-align: middle;">{{ sortIndicator('avgTeleopScore') }}</span>
            </th>
            <th @click="setSort('avgEndgameScore')" class="sortable">
              {{ t('rankings.avg_endgame') }}<span class="material-icons" style="font-size: 18px; vertical-align: middle;">{{ sortIndicator('avgEndgameScore') }}</span>
            </th>
            <th @click="setSort('maxScore')" class="sortable">
              {{ t('rankings.max') }}<span class="material-icons" style="font-size: 18px; vertical-align: middle;">{{ sortIndicator('maxScore') }}</span>
            </th>
            <th @click="setSort('avgRating')" class="sortable">
              {{ t('rankings.rating') }}<span class="material-icons" style="font-size: 18px; vertical-align: middle;">{{ sortIndicator('avgRating') }}</span>
            </th>
            <th>{{ t('rankings.trend') }}</th>
            <th>{{ t('rankings.details') }}</th>
            <th v-if="eventStore.isHost">{{ t('rankings.actions') }}</th>
          </tr>
        </thead>
        <transition-group tag="tbody" name="list" appear>
          <tr 
            v-for="(row, index) in sorted" 
            :key="row.teamNumber" 
            :data-index="index"
            @mouseenter="onRowEnter"
          >
            <td class="team-cell">
              <div 
                class="team-cell-content" 
                style="display: block; width: 100%;"
                :style="{ viewTransitionName: transitionState.sharedElementId === `team-card-${row.teamNumber}` ? `team-card-${row.teamNumber}` : 'none' }"
              >
                <div class="team-header-line">
                  <span class="team-num">{{ row.teamNumber }}</span>
                  <span v-if="recordStore.bannedTeams.includes(row.teamNumber)" class="banned-badge">BANNED</span>
                </div>
                <!-- 战术标签徽章 -->
                <div v-if="recordStore.getTagsForTeam(row.teamNumber).length > 0" class="row-tags-list">
                  <span
                    v-for="tItem in recordStore.getTagsForTeam(row.teamNumber).slice(0, 3)"
                    :key="tItem.id || tItem.tag"
                    class="row-tag-badge"
                    :class="`tag-${tItem.color || 'blue'}`"
                  >
                    {{ formatTagLabel(tItem.tag) }}
                  </span>
                  <span
                    v-if="recordStore.getTagsForTeam(row.teamNumber).length > 3"
                    class="row-tag-more"
                  >
                    +{{ recordStore.getTagsForTeam(row.teamNumber).length - 3 }}
                  </span>
                </div>
              </div>
            </td>
            <td>{{ row.matchCount }}</td>
            <td :class="{'high-breakdown': row.brokenCount > 0 && row.brokenCount / row.matchCount >= 0.5}">{{ row.brokenCount }} / {{ row.matchCount }}</td>
            <td><AnimatedNumber :value="row.avgAutoScore" /></td>
            <td><AnimatedNumber :value="row.avgTeleopScore" /></td>
            <td><AnimatedNumber :value="row.avgEndgameScore" /></td>
            <td><AnimatedNumber :value="row.maxScore" /></td>
            <td class="total-cell"><AnimatedNumber :value="row.avgRating" /></td>
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
                v-if="row.matchCount >= 3 && !recordStore.bannedTeams.includes(row.teamNumber)" 
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
</template>

<style scoped>
/* FLIP Animations */
.list-move,
.list-enter-active,
.list-leave-active {
  transition: all 0.5s cubic-bezier(0.25, 1, 0.5, 1);
}

.list-leave-active {
  position: absolute;
}

.list-enter-from,
.list-leave-to {
  opacity: 0;
  transform: translateX(30px);
}

.rankings-panel {
  max-width: 800px;
  margin: 0 auto;
}

.loading-msg,
.empty-state {
  text-align: center;
  padding: 48px;
  color: var(--muted-foreground);
}

.table-wrapper {
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

thead th {
  background: var(--card);
  padding: 12px 16px;
  text-align: left;
  font-weight: 600;
  color: var(--muted-foreground);
  border-bottom: 2px solid var(--border);
  white-space: nowrap;
}

th.sortable {
  cursor: pointer;
  user-select: none;
}

th.sortable:hover {
  color: var(--foreground);
}

tbody td {
  padding: 12px 16px;
  border-bottom: 1px solid var(--card);
  color: var(--muted-foreground);
}

.hover-highlight {
  position: absolute;
  left: 0;
  right: 0;
  background: rgba(128, 128, 128, 0.1);
  backdrop-filter: brightness(1.1);
  pointer-events: none;
  transition: top 0.25s cubic-bezier(0.25, 1, 0.5, 1), height 0.25s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.2s ease;
  z-index: 10;
  border-radius: 6px;
}

.team-cell {
  font-weight: 700;
  color: var(--foreground);
}

.total-cell {
  font-weight: 700;
  color: var(--primary);
}

.high-breakdown {
  color: var(--status-error);
  font-weight: bold;
}

.ban-btn {
  background: var(--status-error);
  color: white;
  border: none;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  cursor: pointer;
  transition: opacity 0.2s;
}

.ban-btn:hover {
  opacity: 0.8;
}

/* ── 战术标签筛选栏 ── */
.tag-filter-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 10px 14px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 12px;
}

.filter-title {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--muted-foreground);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-right: 4px;
}

.filter-chip {
  padding: 3px 9px;
  border-radius: 12px;
  font-size: 0.75rem;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border);
  color: var(--muted-foreground);
  cursor: pointer;
  transition: all 0.15s ease;
}

.filter-chip:hover {
  border-color: var(--primary);
  color: var(--foreground);
}

.filter-chip.active {
  background: var(--primary);
  color: var(--primary-foreground);
  border-color: var(--primary);
  font-weight: 600;
}

/* ── 表格内队伍单元格标签展示 ── */
.team-header-line {
  display: flex;
  align-items: center;
  gap: 6px;
}

.row-tags-list {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 3px;
}

.row-tag-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 5px;
  border-radius: 8px;
  font-size: 0.68rem;
  font-weight: 500;
  border: 1px solid transparent;
  line-height: 1.2;
}

.row-tag-more {
  font-size: 0.65rem;
  color: var(--muted-foreground);
}

.tag-green  { background: rgba(57, 255, 20, 0.12); color: #39ff14; border-color: rgba(57, 255, 20, 0.35); }
.tag-blue   { background: rgba(56, 189, 248, 0.12); color: #38bdf8; border-color: rgba(56, 189, 248, 0.35); }
.tag-purple { background: rgba(192, 132, 252, 0.12); color: #c084fc; border-color: rgba(192, 132, 252, 0.35); }
.tag-orange { background: rgba(251, 146, 60, 0.12); color: #fb923c; border-color: rgba(251, 146, 60, 0.35); }
.tag-red    { background: rgba(248, 113, 113, 0.12); color: #f87171; border-color: rgba(248, 113, 113, 0.35); }
.tag-yellow { background: rgba(250, 204, 21, 0.12); color: #facc15; border-color: rgba(250, 204, 21, 0.35); }
.tag-gray   { background: rgba(156, 163, 175, 0.12); color: #9ca3af; border-color: rgba(156, 163, 175, 0.35); }

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
</style>

