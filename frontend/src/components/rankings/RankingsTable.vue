<script setup lang="ts">
import { ref, computed, defineComponent, toRef, h, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RankingRow, CustomFieldDefinition } from '@/types'
import { useEventStore } from '@/stores/events'
import { useRecordStore } from '@/stores/records'
import { useCustomFieldsStore } from '@/stores/customFields'
import { useToastStore } from '@/stores/toast'
import { useRouter } from 'vue-router'
import { transitionState } from '@/utils/transitionState'
import { useTween } from '@/composables/useTween'
import { useNavigationStore } from '@/stores/navigation'
import { hapticLight, hapticSelection } from '@/utils/haptics'
import { useConfirm } from '@/composables/useConfirm'

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
const customFieldsStore = useCustomFieldsStore()
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
const availableCustomFields = computed<CustomFieldDefinition[]>(() => {
  const eventId = eventStore.currentEvent?.id
  if (!eventId) return []
  return customFieldsStore.getActiveFields(eventId, 'MATCH').filter(
    f => f.fieldType === 'number' || f.fieldType === 'level' || f.fieldType === 'boolean'
  )
})

const showCustomColsDropdown = ref(false)
const selectedCustomKeys = ref<string[]>(loadCustomColKeys())

function loadCustomColKeys(): string[] {
  try {
    const raw = localStorage.getItem('scoutingpro_rankings_custom_cols')
    if (raw) return JSON.parse(raw)
  } catch {}
  return []
}

function saveCustomColKeys(keys: string[]) {
  try {
    localStorage.setItem('scoutingpro_rankings_custom_cols', JSON.stringify(keys))
  } catch {}
}

function toggleCustomCol(key: string) {
  hapticLight()
  const idx = selectedCustomKeys.value.indexOf(key)
  if (idx !== -1) {
    selectedCustomKeys.value.splice(idx, 1)
  } else {
    selectedCustomKeys.value.push(key)
  }
  saveCustomColKeys(selectedCustomKeys.value)
}

function selectAllCustomCols() {
  hapticLight()
  selectedCustomKeys.value = availableCustomFields.value.map(f => f.fieldKey)
  saveCustomColKeys(selectedCustomKeys.value)
}

function clearAllCustomCols() {
  hapticLight()
  selectedCustomKeys.value = []
  saveCustomColKeys([])
}

const visibleCustomFields = computed(() => {
  return availableCustomFields.value.filter(f => selectedCustomKeys.value.includes(f.fieldKey))
})

function parseCustomFields(record: { customFields?: Record<string, any>; rawData?: string } | null | undefined): Record<string, any> {
  if (!record) return {}
  if (record.customFields && Object.keys(record.customFields).length > 0) {
    return record.customFields
  }
  if (record.rawData) {
    try {
      const parsed = typeof record.rawData === 'string' ? JSON.parse(record.rawData) : record.rawData
      return parsed.customFields || {}
    } catch {
      return {}
    }
  }
  return {}
}

interface TeamCustomStat {
  value: number
  display: string
  count: number
}

const teamCustomStats = computed(() => {
  const map = new Map<number, Record<string, TeamCustomStat>>()
  const eventId = eventStore.currentEvent?.id
  const records = recordStore.activeRecords.filter(r => !eventId || r.eventId === eventId)
  const fields = availableCustomFields.value
  if (fields.length === 0) return map

  const teamRecords = new Map<number, typeof records>()
  for (const r of records) {
    if (!teamRecords.has(r.teamNumber)) {
      teamRecords.set(r.teamNumber, [])
    }
    teamRecords.get(r.teamNumber)!.push(r)
  }

  for (const [teamNum, recs] of teamRecords.entries()) {
    const stats: Record<string, TeamCustomStat> = {}

    for (const f of fields) {
      if (f.fieldType === 'number' || f.fieldType === 'level') {
        let sum = 0
        let count = 0
        for (const r of recs) {
          const cf = parseCustomFields(r)
          const val = cf[f.fieldKey]
          if (val !== undefined && val !== null && val !== '') {
            const num = Number(val)
            if (!isNaN(num)) {
              sum += num
              count++
            }
          }
        }
        if (count > 0) {
          const avg = sum / count
          stats[f.fieldKey] = {
            value: avg,
            display: avg.toFixed(1),
            count
          }
        }
      } else if (f.fieldType === 'boolean') {
        let trueCount = 0
        let count = 0
        for (const r of recs) {
          const cf = parseCustomFields(r)
          const val = cf[f.fieldKey]
          if (val !== undefined && val !== null) {
            count++
            if (val === true || val === 'true' || val === 1) {
              trueCount++
            }
          }
        }
        if (count > 0) {
          const rate = (trueCount / count) * 100
          stats[f.fieldKey] = {
            value: rate,
            display: `${rate.toFixed(0)}%`,
            count
          }
        }
      }
    }
    map.set(teamNum, stats)
  }
  return map
})

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
</script>

<template>
  <div class="rankings-panel">
    <div v-if="loading" class="loading-msg">{{ t('rankings.loading') }}</div>
    <div v-else-if="rankings.length === 0" class="empty-state">
      <p>{{ t('rankings.no_data') }}</p>
    </div>
    <div v-else class="table-wrapper">
      <div class="table-toolbar">
        <!-- 战术标签筛选栏 -->
        <div v-if="availableFilterTags.length > 0" class="tag-filter-bar">
          <span class="filter-title">{{ t('tags.filter_by_tag') }}:</span>
          <button
            class="filter-chip"
            :class="{ active: selectedTagFilter === null }"
            @click="selectedTagFilter = null; hapticSelection()"
          >
            {{ t('tags.all') }}
          </button>
          <button
            v-for="tagKey in availableFilterTags"
            :key="tagKey"
            class="filter-chip"
            :class="{ active: selectedTagFilter === tagKey }"
            @click="selectedTagFilter = (selectedTagFilter === tagKey ? null : tagKey); hapticSelection()"
          >
            {{ formatTagLabel(tagKey) }}
          </button>
        </div>

        <!-- 自定义列下拉选择器 -->
        <div v-if="availableCustomFields.length > 0" class="custom-cols-picker-wrapper">
          <button
            type="button"
            class="btn-custom-cols"
            :class="{ 'has-selected': visibleCustomFields.length > 0 }"
            @click="showCustomColsDropdown = !showCustomColsDropdown; hapticLight()"
          >
            <span class="material-icons" style="font-size: 16px;">view_column</span>
            <span>{{ t('custom_fields.rankings_custom_cols_btn') }}</span>
            <span v-if="visibleCustomFields.length > 0" class="badge-col-count">({{ visibleCustomFields.length }})</span>
            <span class="material-icons" style="font-size: 16px;">{{ showCustomColsDropdown ? 'expand_less' : 'expand_more' }}</span>
          </button>

          <div v-if="showCustomColsDropdown" class="cols-dropdown-card">
            <div class="dropdown-header">
              <span class="dropdown-title">{{ t('custom_fields.rankings_custom_cols_title') }}</span>
              <div class="header-links">
                <button type="button" class="btn-link" @click="selectAllCustomCols">{{ t('custom_fields.select_all') }}</button>
                <span class="sep">/</span>
                <button type="button" class="btn-link" @click="clearAllCustomCols">{{ t('custom_fields.clear_all') }}</button>
              </div>
            </div>
            <div class="dropdown-options">
              <label
                v-for="f in availableCustomFields"
                :key="f.fieldKey"
                class="col-option-row"
              >
                <input
                  type="checkbox"
                  :checked="selectedCustomKeys.includes(f.fieldKey)"
                  @change="toggleCustomCol(f.fieldKey)"
                />
                <span class="opt-name">{{ f.name }}</span>
                <span class="opt-tag">{{ f.fieldType === 'boolean' ? '%' : (f.unit || t('custom_fields.renderer.numeric_unit')) }}</span>
              </label>
            </div>
          </div>
        </div>
      </div>

      <table>
        <thead>
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
        <transition-group tag="tbody" name="list" appear>
          <tr 
            v-for="(row, index) in sorted" 
            :key="row.teamNumber" 
            :data-index="index"
            :data-team-row="row.teamNumber"
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
            <td><AnimatedNumber :value="row.avgTipsPerMatch ?? 0" /></td>
            <td><AnimatedNumber :value="row.maxScore" /></td>
            <td class="total-cell"><AnimatedNumber :value="row.avgRating" /></td>
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
</template>

<style scoped>
/* FLIP Animations */
.list-move,
.list-enter-active,
.list-leave-active {
  transition: all var(--motion-duration-normal) var(--motion-ease-out);
}

.list-leave-active {
  position: absolute;
}

.list-enter-from,
.list-leave-to {
  opacity: 0;
  transform: translateX(20px);
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
}

thead th:first-child {
  position: sticky;
  left: 0;
  z-index: 3;
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

tbody tr:hover td {
  background: rgba(255, 255, 255, 0.04);
}

tbody tr:hover td:first-child {
  background: #111111;
}

.team-cell {
  font-weight: 700;
  color: var(--foreground);
  min-width: 130px;
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

/* ── 表格工具栏与自定义列选择器 ── */
.table-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.table-toolbar .tag-filter-bar {
  margin-bottom: 0;
  flex: 1;
}

.custom-cols-picker-wrapper {
  position: relative;
  display: inline-block;
}

.btn-custom-cols {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--card);
  border: 1px solid var(--border);
  color: var(--muted-foreground);
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-custom-cols:hover {
  border-color: var(--primary);
  color: var(--foreground);
}

.btn-custom-cols.has-selected {
  border-color: rgba(57, 255, 20, 0.4);
  color: var(--primary, #39ff14);
}

.badge-col-count {
  font-weight: 700;
  color: var(--primary, #39ff14);
}

.cols-dropdown-card {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 100;
  width: 260px;
  background: var(--card, #121212);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dropdown-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}

.dropdown-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--muted-foreground);
  text-transform: uppercase;
}

.header-links {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
}

.header-links .sep {
  color: var(--muted-foreground);
}

.btn-link {
  background: none;
  border: none;
  color: var(--primary, #39ff14);
  padding: 0;
  font-size: 11px;
  cursor: pointer;
}

.btn-link:hover {
  text-decoration: underline;
}

.dropdown-options {
  max-height: 200px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.col-option-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  transition: background 0.15s ease;
}

.col-option-row:hover {
  background: rgba(255, 255, 255, 0.05);
}

.col-option-row input[type="checkbox"] {
  accent-color: var(--primary, #39ff14);
}

.col-option-row .opt-name {
  flex: 1;
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.col-option-row .opt-tag {
  font-size: 10px;
  color: var(--muted-foreground);
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 4px;
  border-radius: 3px;
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
  .tag-filter-bar {
    padding: 8px 10px;
    gap: 4px;
  }
  .filter-chip {
    padding: 4px 8px;
    font-size: 0.7rem;
  }
}
</style>

