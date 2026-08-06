<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RankingRow } from '@/types'

const { t } = useI18n()

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
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in sorted" :key="row.teamNumber" @mouseenter="onRowEnter">
            <td class="team-cell">{{ row.teamNumber }}</td>
            <td>{{ row.matchCount }}</td>
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
</style>

