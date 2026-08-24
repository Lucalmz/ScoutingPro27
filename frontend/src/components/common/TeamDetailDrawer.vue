<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useRecordStore } from '@/stores/records'
import TagPicker from '@/components/common/TagPicker.vue'
import type { RankingRow, ScoutingRecord } from '@/types'

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
    teamMatches.value = recordStore.records
      .filter(r => r.teamNumber === teamNum && !r.isDeleted)
      .sort((a, b) => a.matchNumber - b.matchNumber)
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
  <!-- V6/V8：v-show 常驻 DOM；遮罩层用于移动端点击关闭 -->
  <Teleport to="body">
    <div
      v-show="isVisible"
      class="drawer-overlay"
      @click.self="emit('close')"
      aria-modal="true"
      role="dialog"
      :aria-label="teamNumber ? t('team_drawer.title', { team: teamNumber }) : ''"
    >
      <div class="team-drawer" :class="{ visible: isVisible }">
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
                <span class="match-num">{{ t('team_drawer.match_num', { n: match.matchNumber }) }}</span>
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
  </Teleport>
</template>

<style scoped>
/* ── Overlay（移动端全屏，桌面端右侧抽屉，V8）── */
.drawer-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  pointer-events: none;
}

.drawer-overlay.visible,
.drawer-overlay:has(.team-drawer.visible) {
  pointer-events: auto;
}

/* 桌面端：右侧抽屉 */
.team-drawer {
  position: fixed;
  top: 0;
  right: 0;
  height: 100%;
  width: 380px;
  max-width: 100vw;
  background: var(--card, #0a0a0a);
  border-left: 1px solid var(--border, #262626);
  display: flex;
  flex-direction: column;
  transform: translateX(100%);
  transition: transform 0.28s cubic-bezier(0.4, 0, 0.2, 1);
  pointer-events: auto;
  box-shadow: -6px 0 30px rgba(0, 0, 0, 0.8), -1px 0 10px rgba(57, 255, 20, 0.05);
}

.team-drawer.visible {
  transform: translateX(0);
}

/* 移动端：底部 Sheet（V8）*/
@media (max-width: 768px) {
  .drawer-overlay {
    background: rgba(0, 0, 0, 0.6);
    pointer-events: none;
    backdrop-filter: blur(2px);
  }
  .drawer-overlay:has(.team-drawer.visible) {
    pointer-events: auto;
    background: rgba(0, 0, 0, 0.6);
  }

  .team-drawer {
    top: auto;
    bottom: 0;
    left: 0;
    right: 0;
    width: 100%;
    height: 78vh;
    border-left: none;
    border-top: 1px solid var(--border, #262626);
    border-radius: 16px 16px 0 0;
    transform: translateY(100%);
    box-shadow: 0 -8px 30px rgba(0, 0, 0, 0.8), 0 -1px 10px rgba(57, 255, 20, 0.05);
  }

  .team-drawer.visible {
    transform: translateY(0);
  }
}

/* ── Header ── */
.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  background: var(--popover, #111111);
  border-bottom: 1px solid var(--border, #262626);
  flex-shrink: 0;
}

.drawer-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 1rem;
  font-weight: 700;
  color: var(--foreground, #f1f5f9);
  font-family: 'Orbitron', 'ZCOOLQingKeHuangYou', sans-serif;
  letter-spacing: 0.03em;
}

.drawer-title .material-icons {
  color: var(--primary, #39ff14);
  filter: drop-shadow(0 0 6px rgba(57, 255, 20, 0.4));
}

.drawer-actions {
  display: flex;
  gap: 4px;
}

.btn-icon {
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--muted-foreground, #a3a3a3);
  padding: 6px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease-in-out;
}

.btn-icon:hover {
  background: rgba(57, 255, 20, 0.1);
  color: var(--primary, #39ff14);
}

/* ── Loading & Empty ── */
.drawer-loading,
.drawer-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--muted-foreground, #a3a3a3);
  font-size: 0.9rem;
  padding: 24px;
  text-align: center;
}

.drawer-loading .material-icons,
.drawer-empty .material-icons {
  color: var(--primary, #39ff14);
}

.drawer-hint {
  font-size: 0.78rem;
  opacity: 0.7;
  margin: 0;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}

/* ── Body ── */
.drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* ── Stat Card ── */
.stat-card {
  background: var(--popover, #111111);
  border: 1px solid var(--border, #262626);
  border-radius: 10px;
  padding: 12px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.stat-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.stat-row.sub {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
  gap: 10px;
}

.stat-item {
  flex: 1;
  min-width: 60px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.stat-label {
  font-size: 0.7rem;
  color: var(--muted-foreground, #a3a3a3);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.stat-value {
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--foreground, #f1f5f9);
  font-family: 'Orbitron', monospace;
}

.stat-value.rank {
  color: var(--primary, #39ff14);
  text-shadow: 0 0 10px rgba(57, 255, 20, 0.3);
}

.stat-value.trend {
  display: flex;
  align-items: center;
  justify-content: center;
}

.trend-icon {
  font-size: 1.25rem;
}

.trend-icon.up {
  color: var(--status-success, #39ff14);
}

.trend-icon.down {
  color: var(--destructive, #ef4444);
}

.trend-icon.stable {
  color: var(--muted-foreground, #a3a3a3);
}

.trend-icon.new {
  color: var(--status-warning, #fcd34d);
}

.stat-sub {
  font-size: 0.75rem;
  color: var(--muted-foreground, #a3a3a3);
  display: flex;
  align-items: center;
  gap: 2px;
}

.stat-sub.broken {
  color: var(--destructive, #ef4444);
}

/* ── Matches ── */
.section-title {
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--foreground, #f1f5f9);
  font-family: 'Orbitron', 'ZCOOLQingKeHuangYou', sans-serif;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin: 0 0 8px;
}

.match-row {
  background: var(--popover, #111111);
  border: 1px solid var(--border, #262626);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 6px;
  transition: border-color 0.15s;
}

.match-row:hover {
  border-color: rgba(57, 255, 20, 0.3);
}

.match-row.is-broken {
  border-color: rgba(239, 68, 68, 0.5);
  background: rgba(239, 68, 68, 0.05);
}

.match-row-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.match-num {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--foreground, #f1f5f9);
  flex: 1;
}

.broken-tag {
  font-size: 0.72rem;
  color: var(--destructive, #ef4444);
  display: flex;
  align-items: center;
  gap: 2px;
}

.match-total {
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--primary, #39ff14);
  font-family: 'Orbitron', monospace;
}

.match-scores {
  display: flex;
  gap: 10px;
  font-size: 0.75rem;
  color: var(--muted-foreground, #a3a3a3);
}

.match-notes {
  margin: 6px 0 0;
  font-size: 0.78rem;
  color: var(--foreground, #f1f5f9);
  border-top: 1px solid var(--border, #262626);
  padding-top: 6px;
  line-height: 1.4;
}

.no-matches {
  font-size: 0.82rem;
  color: var(--muted-foreground, #a3a3a3);
  text-align: center;
  padding: 12px 0;
}

/* ── Footer ── */
.drawer-footer {
  padding: 12px 16px;
  background: var(--popover, #111111);
  border-top: 1px solid var(--border, #262626);
  flex-shrink: 0;
}

.btn-full-detail {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px;
  background: var(--primary, #39ff14);
  color: var(--primary-foreground, #000000);
  border: none;
  border-radius: 8px;
  font-size: 0.88rem;
  font-weight: 700;
  cursor: pointer;
  box-shadow: var(--glow-primary);
  transition: all 0.15s ease-in-out;
}

.btn-full-detail:hover {
  background: #32e012;
  box-shadow: var(--glow-primary-hover);
  transform: translateY(-1px);
}
</style>
