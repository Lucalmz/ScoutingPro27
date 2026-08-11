<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RankingRow } from '@/types'
import { useEventStore } from '@/stores/events'
import { useRecordStore } from '@/stores/records'
import { useToastStore } from '@/stores/toast'

import { useRouter } from 'vue-router'

const { t } = useI18n()
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

function setSort(key: SortKey) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    sortDir.value = 'desc'
  }
}

const sorted = computed<RankingRow[]>(() => {
  const arr = [...props.rankings]
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
import { transitionState } from '@/utils/transitionState'
import { nextTick } from 'vue'

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
    <div v-else class="table-wrapper" style="position: relative;" @mouseleave="onTableLeave">
      <div class="hover-highlight" :style="highlightStyle"></div>
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
        <tbody>
          <tr 
            v-for="row in sorted" 
            :key="row.teamNumber" 
            @mouseenter="onRowEnter"
          >
            <td class="team-cell">
              <div 
                class="team-cell-content" 
                style="display: block; width: 100%;"
                :style="{ viewTransitionName: transitionState.sharedElementId === `team-card-${row.teamNumber}` ? `team-card-${row.teamNumber}` : 'none' }"
              >
                {{ row.teamNumber }}
                <span v-if="recordStore.bannedTeams.includes(row.teamNumber)" class="banned-badge">BANNED</span>
              </div>
            </td>
            <td>{{ row.matchCount }}</td>
            <td :class="{'high-breakdown': row.brokenCount > 0 && row.brokenCount / row.matchCount >= 0.5}">{{ row.brokenCount }} / {{ row.matchCount }}</td>
            <td>{{ row.avgAutoScore.toFixed(1) }}</td>
            <td>{{ row.avgTeleopScore.toFixed(1) }}</td>
            <td>{{ row.avgEndgameScore.toFixed(1) }}</td>
            <td>{{ row.maxScore }}</td>
            <td class="total-cell">{{ row.avgRating.toFixed(1) }}</td>
            <td class="trend-cell">
              <span v-if="row.trend === 'up'" style="color: var(--status-success); font-weight: bold;">↗</span>
              <span v-else-if="row.trend === 'down'" style="color: var(--status-error); font-weight: bold;">↘</span>
              <span v-else-if="row.trend === 'stable'" style="color: var(--muted-foreground);">➡</span>
              <span v-else style="color: var(--muted-foreground)">-</span>
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
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
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

