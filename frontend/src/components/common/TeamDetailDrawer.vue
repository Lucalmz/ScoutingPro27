<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useRecordStore } from '@/stores/records'
import { useNavigationStore } from '@/stores/navigation'
import TagPicker from '@/components/common/TagPicker.vue'
import type { RankingRow, ScoutingRecord } from '@/types'
import { sortRecordsChronologically, getMatchLevelPrefix } from '@/utils/tournament'

const props = defineProps<{
  /** 当前展示的队伍编号，null 表示关闭状态 */
  teamNumber: number | null
  eventId: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const router = useRouter()
const { t } = useI18n()
const recordStore = useRecordStore()
const navStore = useNavigationStore()

// ── 抽屉可见性 ──
const isVisible = computed(() => props.teamNumber !== null)

// ── 数据加载（含 AbortController 防竞态，V24）──
let currentFetchId = 0
let abortCtrl: AbortController | null = null

const isLoading = ref(false)
const rankInfo = ref<RankingRow | null>(null)
const teamMatches = ref<ScoutingRecord[]>([])

async function fetchTeamData(teamNum: number) {
  // 每次调用时递增 ID，丢弃过期响应（V24）
  const myId = ++currentFetchId
  abortCtrl?.abort()
  abortCtrl = new AbortController()

  isLoading.value = true
  rankInfo.value = null
  teamMatches.value = []

  try {
    // 模拟异步（数据来自 Pinia store，但仍用 microtask 保证 ID 检查正确性）
    await Promise.resolve()

    // 如果该请求已过期（用户又点了另一支队伍），直接丢弃
    if (myId !== currentFetchId) return

    // 从 recordStore 读取数据（响应式，同步即可）
    rankInfo.value = recordStore.rankings.find(r => r.teamNumber === teamNum) ?? null
    teamMatches.value = sortRecordsChronologically(
      recordStore.activeRecords.filter(r => (!props.eventId || r.eventId === props.eventId) && r.teamNumber === teamNum)
    )
  } finally {
    if (myId === currentFetchId) {
      isLoading.value = false
    }
  }
}

// watch teamNumber，切换时重新拉取（V6：常驻 DOM，不 unmount）
watch(
  () => props.teamNumber,
  (tn) => {
    if (tn !== null) fetchTeamData(tn)
  },
  { immediate: true }
)

onUnmounted(() => {
  abortCtrl?.abort()
})

// ── 数据格式化 ──
const teamRankDisplay = computed(() => {
  if (props.teamNumber === null) return '-'
  const idx = recordStore.rankings.findIndex(r => r.teamNumber === props.teamNumber)
  return idx >= 0 ? `#${idx + 1}` : '-'
})

function trendIconName(trend: RankingRow['trend']): string {
  const map: Record<string, string> = { up: 'trending_up', down: 'trending_down', stable: 'trending_flat', new: 'fiber_new' }
  return map[trend] ?? 'trending_flat'
}

function goFullDetail() {
  if (props.teamNumber === null) return
  const tabContent = document.querySelector('.tab-content') as HTMLElement | null
  const chatMessages = document.querySelector('.chat-messages') as HTMLElement | null
  navStore.saveEventPosition({
    eventId: props.eventId,
    fromTab: 'ai',
    contentScrollTop: tabContent ? tabContent.scrollTop : window.scrollY,
    contentScrollLeft: tabContent ? tabContent.scrollLeft : window.scrollX,
    aiChatScrollTop: chatMessages ? chatMessages.scrollTop : null,
    teamNumber: props.teamNumber
  })
  emit('close')
  router.push(`/event/${props.eventId}/team/${props.teamNumber}`)
}

// 全局 ESC 键监听
function onGlobalKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && isVisible.value) {
    emit('close')
  }
}

watch(isVisible, (visible) => {
  if (visible) {
    window.addEventListener('keydown', onGlobalKeyDown)
  } else {
    window.removeEventListener('keydown', onGlobalKeyDown)
  }
}, { immediate: true })

onUnmounted(() => {
  abortCtrl?.abort()
  window.removeEventListener('keydown', onGlobalKeyDown)
})
</script>

<template>
  <!-- V6/V8：常驻 DOM，Transition 保证进退场平滑 -->
  <Teleport to="body">
    <Transition name="drawer">
      <div
        v-show="isVisible"
        class="drawer-overlay"
        @click.self="emit('close')"
        aria-modal="true"
        role="dialog"
        :aria-label="teamNumber ? t('team_drawer.title', { team: teamNumber }) : ''"
      >
        <div class="team-drawer">
        <!-- 头部 -->
        <div class="drawer-header">
          <div class="drawer-title">
            <span class="material-icons">smart_toy</span>
            <span>{{ t('team_drawer.title', { team: teamNumber }) }}</span>
          </div>
          <div class="drawer-actions">
            <button class="btn-icon" @click="goFullDetail" :title="t('team_drawer.full_detail')">
              <span class="material-icons">open_in_full</span>
            </button>
            <button class="btn-icon" @click="emit('close')" :title="t('team_drawer.close')">
              <span class="material-icons">close</span>
            </button>
          </div>
        </div>

        <!-- 加载中 -->
        <div v-if="isLoading" class="drawer-loading">
          <span class="material-icons spinning">sync</span>
          {{ t('team_drawer.loading') }}
        </div>

        <!-- 无比赛数据兜底（仍可打战术标签进行 Pit Scouting）-->
        <div v-else-if="!rankInfo && !isLoading" class="drawer-empty">
          <span class="material-icons">info_outline</span>
          <p>{{ t('team_drawer.no_data') }}</p>
          <p class="drawer-hint">{{ t('team_drawer.no_data_hint') }}</p>
          <div class="tags-section" style="margin-top: 16px; text-align: left; width: 100%;">
            <h4 class="section-title">{{ t('tags.section_title') }}</h4>
            <TagPicker
              v-if="teamNumber !== null"
              :event-id="eventId"
              :team-number="teamNumber"
            />
          </div>
        </div>

        <!-- 主内容 -->
        <div v-else-if="rankInfo" class="drawer-body">
          <!-- 综合统计卡 -->
          <div class="stat-card">
            <div class="stat-row">
              <div class="stat-item">
                <span class="stat-label">{{ t('team_drawer.rank') }}</span>
                <span class="stat-value rank">{{ teamRankDisplay }}</span>
              </div>
              <div class="stat-item">
                <span class="stat-label">{{ t('team_drawer.avg_score') }}</span>
                <span class="stat-value">{{ rankInfo.avgRating }}</span>
              </div>
              <div class="stat-item">
                <span class="stat-label">{{ t('team_drawer.max_score') }}</span>
                <span class="stat-value">{{ rankInfo.maxScore }}</span>
              </div>
              <div class="stat-item">
                <span class="stat-label">{{ t('team_drawer.trend') }}</span>
                <span class="stat-value trend">
                  <span class="material-icons trend-icon" :class="rankInfo.trend">{{ trendIconName(rankInfo.trend) }}</span>
                </span>
              </div>
            </div>
            <div class="stat-row sub">
              <span class="stat-sub">{{ t('team_drawer.auto') }}: {{ rankInfo.avgAutoScore }}</span>
              <span class="stat-sub">{{ t('team_drawer.teleop') }}: {{ rankInfo.avgTeleopScore }}</span>
              <span class="stat-sub">{{ t('team_drawer.endgame') }}: {{ rankInfo.avgEndgameScore }}</span>
              <span v-if="rankInfo.brokenCount > 0" class="stat-sub broken">
                <span class="material-icons" style="font-size:12px">build</span>
                {{ t('team_drawer.broken_count', { n: rankInfo.brokenCount }) }}
              </span>
            </div>
          </div>

          <!-- 战术标签卡片 -->
          <div class="tags-section">
            <h4 class="section-title">{{ t('tags.section_title') }}</h4>
            <TagPicker
              v-if="teamNumber !== null"
              :event-id="eventId"
              :team-number="teamNumber"
            />
          </div>

          <!-- 历史场次列表 -->
          <div class="matches-section">
            <h4 class="section-title">{{ t('team_drawer.match_history', { count: teamMatches.length }) }}</h4>
            <div v-if="teamMatches.length === 0" class="no-matches">
              {{ t('team_drawer.no_matches') }}
            </div>
            <div
              v-for="match in teamMatches"
              :key="match.id"
              class="match-row"
              :class="{ 'is-broken': match.isBroken }"
            >
              <div class="match-row-header">
                <span class="match-num">{{ t('team_drawer.match_num', { n: `${getMatchLevelPrefix(match)}${match.matchNumber}` }) }}</span>
                <span v-if="match.isBroken" class="broken-tag">
                  <span class="material-icons" style="font-size:11px">build</span>
                  {{ t('team_drawer.broken') }}
                </span>
                <span class="match-total">{{ match.totalScore }}</span>
              </div>
              <div class="match-scores">
                <span>{{ t('team_drawer.auto') }}: {{ match.autoScore }}</span>
                <span>{{ t('team_drawer.teleop') }}: {{ match.teleopScore }}</span>
                <span>{{ t('team_drawer.endgame') }}: {{ match.endgameScore }}</span>
              </div>
              <p v-if="match.notes" class="match-notes">{{ match.notes }}</p>
            </div>
          </div>
        </div>

        <!-- 底部操作 -->
        <div class="drawer-footer">
          <button class="btn-full-detail" @click="goFullDetail">
            <span class="material-icons">open_in_full</span>
            {{ t('team_drawer.full_detail') }}
          </button>
        </div>
      </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped src="./TeamDetailDrawer.css"></style>
