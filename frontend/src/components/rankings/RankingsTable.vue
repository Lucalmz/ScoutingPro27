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
const sortKey = ref<SortKey>('totalScore')
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
</script>

<template>
  <div class="rankings-panel">
    <div v-if="loading" class="loading-msg">{{ t('rankings.loading') }}</div>
    <div v-else-if="rankings.length === 0" class="empty-state">
      <p>{{ t('rankings.no_data') }}</p>
    </div>
    <div v-else class="table-wrapper">
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
            <th @click="setSort('totalScore')" class="sortable">
              {{ t('rankings.total') }}<span class="material-icons" style="font-size: 18px; vertical-align: middle;">{{ sortIndicator('totalScore') }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in sorted" :key="row.teamNumber">
            <td class="team-cell">{{ row.teamNumber }}</td>
            <td>{{ row.matchCount }}</td>
            <td>{{ row.avgAutoScore.toFixed(1) }}</td>
            <td>{{ row.avgTeleopScore.toFixed(1) }}</td>
            <td>{{ row.avgEndgameScore.toFixed(1) }}</td>
            <td>{{ row.maxScore }}</td>
            <td class="total-cell">{{ row.totalScore }}</td>
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

tbody tr:hover {
  background: var(--card);
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

