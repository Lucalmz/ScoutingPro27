<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { UnifiedTeamItem } from '@/types'
import { getPhotoUrl } from '@/services/photoStorage'
import PitStatusIndicator from './PitStatusIndicator.vue'

const props = defineProps<{
  team: UnifiedTeamItem
}>()

const emit = defineEmits<{
  (e: 'select', teamNumber: number): void
}>()

const { t } = useI18n()
const photoUrl = ref<string | null>(null)

async function loadPhoto() {
  const keys = props.team.pitRecord?.photoKeys
  const eventId = props.team.pitRecord?.eventId || ''
  if (keys && keys.length > 0 && keys[0]) {
    photoUrl.value = await getPhotoUrl(keys[0], eventId)
  } else {
    photoUrl.value = null
  }
}

onMounted(loadPhoto)
watch(() => props.team.pitRecord?.photoKeys, loadPhoto, { deep: true })

const drivetrainText = computed(() => {
  const dt = props.team.pitRecord?.drivetrainType
  if (!dt) return ''
  return t(`pit_scout.drivetrain.${dt}`) || dt
})

const hangText = computed(() => {
  const ht = props.team.pitRecord?.hangType
  if (!ht) return ''
  return t(`pit_scout.hang.${ht}`) || ht
})

const bragLabel = computed(() => {
  const b = props.team.bragInfo
  if (!b) return ''
  const tierText = t(`pit_scout.brag_tiers.${b.tier}`) || b.label
  let str = `${b.overallRatio}x ${tierText}`
  if (b.hangVerified) str += ` (${t('pit_scout.hang_verified')})`
  else if (b.hangPardoned) str += ` (${t('pit_scout.hang_pardoned')})`
  return str
})
</script>

<template>
  <div class="team-roster-card" :class="{ 'is-scouted': team.hasPitRecord }" @click="emit('select', team.teamNumber)">
    <!-- 顶部状态栏 -->
    <div class="card-header">
      <div class="team-identity">
        <span class="team-number">#{{ team.teamNumber }}</span>
        <span class="team-name" :title="team.name">{{ team.name }}</span>
      </div>
      <PitStatusIndicator :team-number="team.teamNumber" :show-label="true" size="md" :clickable="false" />
    </div>

    <!-- 机器人名称与地点 -->
    <div v-if="team.robotName || team.city" class="card-subtitle">
      <span v-if="team.robotName" class="robot-name">🤖 {{ team.robotName }}</span>
      <span v-if="team.city" class="location">📍 {{ team.city }}</span>
    </div>

    <!-- 硬件指标标签条 -->
    <div v-if="team.pitRecord" class="hardware-pills">
      <span class="pill pill-drivetrain">
        {{ drivetrainText }}
      </span>
      <span v-if="team.pitRecord.weightLbs > 0" class="pill pill-weight">
        ⚖️ {{ team.pitRecord.weightLbs }} lbs
      </span>
      <span v-if="team.pitRecord.hangType && team.pitRecord.hangType !== 'none'" class="pill pill-hang">
        🧗 {{ hangText }}
      </span>
    </div>

    <!-- 核心量化自述对比条 -->
    <div v-if="team.pitRecord" class="quant-grid">
      <div class="quant-item">
        <span class="quant-label">{{ t('pit_scout.claimed_total') }}</span>
        <span class="quant-value highlight">{{ team.pitRecord.claimedTotalScore }}</span>
      </div>
      <div class="quant-item">
        <span class="quant-label">{{ t('pit_scout.claimed_auto') }}</span>
        <span class="quant-value">
          {{ t('pit_scout.claimed_score_pieces', { score: team.pitRecord.claimedAutoScore, pieces: team.pitRecord.claimedAutoPieces }) }}
        </span>
      </div>
      <div class="quant-item">
        <span class="quant-label">{{ t('pit_scout.claimed_hang') }}</span>
        <span class="quant-value">
          {{ team.pitRecord.claimedEndgameHangLevel > 0 ? t('pit_scout.hang_level', { level: team.pitRecord.claimedEndgameHangLevel }) : t('pit_scout.hang_none') }}
        </span>
      </div>
    </div>

    <!-- 赛场真实表现与吹牛指数对账 -->
    <div v-if="team.matchCount > 0" class="match-reconcile-bar">
      <div class="reconcile-scores">
        <span>{{ t('pit_scout.actual_matches', { count: team.matchCount }) }}</span>
        <span>{{ t('pit_scout.max_score', { score: team.maxTotalScore }) }}</span>
        <span>{{ t('pit_scout.avg_score', { score: team.avgTotalScore }) }}</span>
      </div>
      <div v-if="team.bragInfo" class="brag-tier-pill" :class="`tier-${team.bragInfo.tier}`">
        {{ bragLabel }}
      </div>
    </div>

    <!-- 照片预览图 (若有) -->
    <div v-if="photoUrl" class="card-thumbnail">
      <img :src="photoUrl" alt="Robot Photo" loading="lazy" />
    </div>

    <!-- 底部操作提示 -->
    <div class="card-footer">
      <button class="action-btn" type="button">
        {{ team.hasPitRecord ? t('pit_scout.btn_view_edit') : t('pit_scout.btn_add_record') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.team-roster-card {
  background: var(--card, #0a0a0a);
  border: 1px solid var(--border, #262626);
  border-radius: 12px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  position: relative;
}

.team-roster-card:hover {
  border-color: var(--primary, #39ff14);
  transform: translateY(-2px);
  box-shadow: 0 4px 16px rgba(57, 255, 20, 0.15);
}

.team-roster-card.is-scouted {
  border-left: 3px solid var(--primary, #39ff14);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.team-identity {
  display: flex;
  align-items: baseline;
  gap: 8px;
  overflow: hidden;
}

.team-number {
  font-size: 18px;
  font-weight: 800;
  color: var(--foreground, #ededed);
  letter-spacing: -0.02em;
}

.team-name {
  font-size: 14px;
  color: var(--muted-foreground, #888888);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 180px;
}

.card-subtitle {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--muted-foreground, #888888);
}

.hardware-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.pill {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border, #262626);
  color: var(--foreground, #ededed);
  font-weight: 500;
}

.pill-drivetrain {
  background: rgba(57, 255, 20, 0.1);
  border-color: rgba(57, 255, 20, 0.3);
  color: var(--primary, #39ff14);
}

.quant-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--border, #262626);
  border-radius: 8px;
  padding: 8px 12px;
}

.quant-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.quant-label {
  font-size: 10px;
  color: var(--muted-foreground, #888888);
}

.quant-value {
  font-size: 13px;
  font-weight: 600;
  color: var(--foreground, #ededed);
}

.quant-value.highlight {
  color: var(--primary, #39ff14);
  font-weight: 700;
}

.match-reconcile-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--border, #262626);
  font-size: 11px;
}

.reconcile-scores {
  display: flex;
  gap: 8px;
  color: var(--muted-foreground, #888888);
}

.brag-tier-pill {
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: 10px;
}

.tier-realistic { background: rgba(57, 255, 20, 0.15); color: #39ff14; border: 1px solid rgba(57, 255, 20, 0.3); }
.tier-optimistic { background: rgba(234, 179, 8, 0.15); color: #eab308; border: 1px solid rgba(234, 179, 8, 0.3); }
.tier-overclaimed { background: rgba(249, 115, 22, 0.15); color: #fb923c; border: 1px solid rgba(249, 115, 22, 0.3); }
.tier-mythical { background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3); }
.tier-pending { background: rgba(120, 120, 120, 0.15); color: #888888; border: 1px solid rgba(120, 120, 120, 0.3); }

.card-thumbnail {
  width: 100%;
  height: 120px;
  border-radius: 8px;
  overflow: hidden;
  background: #000;
  border: 1px solid var(--border, #262626);
}

.card-thumbnail img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.card-footer {
  margin-top: auto;
}

.action-btn {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid rgba(57, 255, 20, 0.3);
  border-radius: 8px;
  background: rgba(57, 255, 20, 0.08);
  color: var(--primary, #39ff14);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.team-roster-card:hover .action-btn {
  background: var(--primary, #39ff14);
  color: var(--primary-foreground, #000000);
}
</style>

