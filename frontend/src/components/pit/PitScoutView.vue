<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePitScoutStore } from '@/stores/pitScout'
import { useEventStore } from '@/stores/events'
import { useToastStore } from '@/stores/toast'
import TeamRosterCard from './TeamRosterCard.vue'
import PitScoutFormDrawer from './PitScoutFormDrawer.vue'
import './PitScoutView.css'

const props = defineProps<{
  eventId: string
}>()

const { t } = useI18n()
const pitStore = usePitScoutStore()
const eventStore = useEventStore()
const toastStore = useToastStore()

const drawerOpen = ref(false)
const selectedTeamNumber = ref<number | null>(null)
const isSyncingRoster = ref(false)

onMounted(() => {
  if (props.eventId) {
    pitStore.fetchPitData(props.eventId)
  }
})

const canSyncOfficial = computed(() => {
  return Boolean(
    eventStore.currentEvent?.ftcYear &&
    eventStore.currentEvent?.ftcEventCode
  )
})

async function handleSyncOfficialRoster() {
  if (!canSyncOfficial.value) {
    toastStore.showError(t('pit_scout.sync_unconfigured'))
    return
  }

  isSyncingRoster.value = true
  try {
    await pitStore.syncFtcRoster(
      eventStore.currentEvent!.ftcYear!,
      eventStore.currentEvent!.ftcEventCode!
    )
    toastStore.showToast(t('pit_scout.sync_success', { count: pitStore.officialTeams.length }), 'success')
  } catch (err: any) {
    toastStore.showError((t('pit_scout.sync_failed')) + (err.message || ''))
  } finally {
    isSyncingRoster.value = false
  }
}

function handleSelectTeam(teamNumber: number) {
  selectedTeamNumber.value = teamNumber
  drawerOpen.value = true
}
</script>

<template>
  <div class="pit-scout-view">
    <!-- 顶部数据看板条 -->
    <div class="pit-header-banner">
      <div class="banner-left">
        <h2 class="banner-title">{{ t('pit_scout.title') }}</h2>
        <div class="progress-pill">
          <span>{{ t('pit_scout.recorded_stat', { recorded: pitStore.stats.recorded, total: pitStore.stats.total }) }}</span>
          <span v-if="pitStore.stats.total > 0">({{ pitStore.stats.percentage }}%)</span>
        </div>
      </div>

      <div class="banner-actions">
        <button
          v-if="canSyncOfficial"
          class="btn-sync"
          type="button"
          :disabled="isSyncingRoster"
          @click="handleSyncOfficialRoster"
        >
          <span class="material-icons" :class="{ spinning: isSyncingRoster }">sync</span>
          <span>{{ isSyncingRoster ? t('pit_scout.syncing') : t('pit_scout.sync_official') }}</span>
        </button>
      </div>
    </div>

    <!-- 筛选过滤与检索工具栏 -->
    <div class="pit-toolbar">
      <div class="search-box">
        <input
          v-model="pitStore.searchQuery"
          type="text"
          class="search-input"
          :placeholder="t('pit_scout.search_placeholder')"
        />
      </div>

      <div class="filter-controls">
        <!-- 录入状态过滤 -->
        <select v-model="pitStore.filterRecordStatus" class="filter-select">
          <option value="all">{{ t('pit_scout.filter_all_status') }}</option>
          <option value="recorded">{{ t('pit_scout.filter_recorded') }}</option>
          <option value="unrecorded">{{ t('pit_scout.filter_unrecorded') }}</option>
        </select>

        <!-- 底盘构型过滤 -->
        <select v-model="pitStore.filterDrivetrain" class="filter-select">
          <option value="all">{{ t('pit_scout.filter_all_drivetrain') }}</option>
          <option value="mecanum">{{ t('pit_scout.drivetrain.mecanum') }}</option>
          <option value="tank">{{ t('pit_scout.drivetrain.tank') }}</option>
          <option value="swerve">{{ t('pit_scout.drivetrain.swerve') }}</option>
          <option value="other">{{ t('pit_scout.drivetrain.other') }}</option>
        </select>

        <!-- 排序方式 (包含吹牛指数排序) -->
        <select v-model="pitStore.sortBy" class="filter-select">
          <option value="teamNumber">{{ t('pit_scout.sort_team_number') }}</option>
          <option value="bragAsc">{{ t('pit_scout.sort_brag_asc') }}</option>
          <option value="bragDesc">{{ t('pit_scout.sort_brag_desc') }}</option>
          <option value="scoreDesc">{{ t('pit_scout.sort_score_desc') }}</option>
        </select>
      </div>
    </div>

    <!-- 统一战队卡片网格 -->
    <div v-if="pitStore.unifiedTeamList.length > 0" class="roster-grid">
      <TeamRosterCard
        v-for="(team, idx) in pitStore.unifiedTeamList"
        :key="team.teamNumber"
        :team="team"
        :card-index="idx"
        @select="handleSelectTeam"
      />
    </div>

    <!-- 空状态 -->
    <div v-else class="empty-state">
      <p class="empty-title">{{ t('pit_scout.empty_title') }}</p>
      <p class="empty-desc">
        {{
          canSyncOfficial
            ? t('pit_scout.empty_desc_sync')
            : t('pit_scout.empty_desc_nosync')
        }}
      </p>
    </div>

    <!-- 走访录入抽屉 -->
    <PitScoutFormDrawer
      v-model="drawerOpen"
      :team-number="selectedTeamNumber"
    />
  </div>
</template>
