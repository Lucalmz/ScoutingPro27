<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { UnifiedTeamItem } from '@/types'
import { getPhotoUrl } from '@/services/photoStorage'
import PitStatusIndicator from './PitStatusIndicator.vue'
import { LAUNCHER_PRESETS } from '@/constants/pitScoutPresets'

const props = defineProps<{
  team: UnifiedTeamItem
  cardIndex?: number
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

const ballCompatibilityText = computed(() => {
  const bc = props.team.pitRecord?.ballCompatibility
  if (!bc) return ''
  return t(`pit_scout.ball_compatibility.${bc}`) || bc
})

const launcherText = computed(() => {
  const raw = props.team.pitRecord?.launcherType
  if (!raw) return ''
  const preset = LAUNCHER_PRESETS.find(
    (p) => p.zh === raw || p.en === raw || p.key === raw || p.en.toLowerCase() === raw.toLowerCase()
  )
  if (preset) {
    return t(`pit_scout.launcher_presets.${preset.key}`)
  }
  return raw
})

const bragLabel = computed(() => {
  const b = props.team.bragInfo
  if (!b) return ''
  const tierText = t(`pit_scout.brag_tiers.${b.tier}`) || b.label
  let str = `${b.overallRatio}x ${tierText}`
  return str
})
</script>

<template>
  <div
    class="team-roster-card"
    :class="{ 'is-scouted': team.hasPitRecord }"
    :style="{ '--card-index': cardIndex ?? 0 }"
    @click="emit('select', team.teamNumber)"
  >
    <!-- 顶部状态栏 -->
    <div class="card-header">
      <div class="team-identity">
        <span class="team-number">#{{ team.teamNumber }}</span>
        <span class="team-name" :title="team.name">{{ team.name }}</span>
      </div>
      <PitStatusIndicator :team-number="team.teamNumber" :show-label="true" size="md" :clickable="false" />
    </div>

    <!-- 来自正赛自动发现的高亮标识 -->
    <div v-if="!team.hasPitRecord && team.matchCount > 0" class="match-discovery-badge">
      <span class="material-icons" style="font-size: 13px;">visibility</span>
      <span>{{ t('pit_scout.discovered_from_match', { count: team.matchCount }) }}</span>
    </div>

    <!-- 机器人名称与地点 -->
    <div v-if="team.robotName || team.city" class="card-subtitle">
      <span v-if="team.robotName" class="robot-name">
        <span class="material-icons card-info-icon">smart_toy</span>
        {{ team.robotName }}
      </span>
      <span v-if="team.city" class="location">
        <span class="material-icons card-info-icon">location_on</span>
        {{ team.city }}
      </span>
    </div>

    <!-- 硬件指标标签条 -->
    <div v-if="team.pitRecord" class="hardware-pills">
      <span class="pill pill-drivetrain">
        {{ drivetrainText }}
      </span>
      <span v-if="team.pitRecord.weightLbs > 0" class="pill pill-weight">
        <span class="material-icons pill-icon">scale</span>
        {{ team.pitRecord.weightLbs }} lbs
      </span>
      <span v-if="team.pitRecord.ballCompatibility" class="pill pill-compat">
        <span class="material-icons pill-icon">sports_baseball</span>
        {{ ballCompatibilityText }}
      </span>
      <span v-if="launcherText" class="pill pill-launcher">
        <span class="material-icons pill-icon">rocket_launch</span>
        {{ launcherText }}
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
          {{ team.pitRecord.claimedAutoScore }} {{ t('pit_scout.drawer.unit_pts') }}
        </span>
      </div>
      <div class="quant-item">
        <span class="quant-label">{{ t('pit_scout.claimed_teleop_cycles') }}</span>
        <span class="quant-value">
          {{ t('pit_scout.claimed_cycles_unit', { cycles: team.pitRecord.claimedTeleopCycles || 0 }) }}
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
        <span class="material-icons brag-icon" v-if="team.bragInfo.tier === 'realistic'">verified</span>
        <span class="material-icons brag-icon" v-else-if="team.bragInfo.tier === 'optimistic'">trending_up</span>
        <span class="material-icons brag-icon" v-else-if="team.bragInfo.tier === 'overclaimed'">warning</span>
        <span class="material-icons brag-icon" v-else-if="team.bragInfo.tier === 'mythical'">local_fire_department</span>
        <span>{{ bragLabel }}</span>
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
  animation: card-cascade-in var(--motion-duration-moderate, 0.4s) var(--motion-ease-out, ease-out) both;
  animation-delay: min(calc(var(--card-index, 0) * 30ms), 240ms);
}

@media (prefers-reduced-motion: reduce) {
  .team-roster-card {
    animation: none !important;
  }
}

@keyframes card-cascade-in {
  from {
    opacity: 0;
    transform: translateY(14px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.card-info-icon {
  font-size: 13px;
  vertical-align: middle;
  margin-right: 3px;
  opacity: 0.85;
}

.pill-icon {
  font-size: 13px;
  vertical-align: text-bottom;
  margin-right: 3px;
}

.brag-icon {
  font-size: 12px;
  vertical-align: text-bottom;
  margin-right: 3px;
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

.match-discovery-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: 6px;
  background: rgba(59, 130, 246, 0.15);
  border: 1px solid rgba(59, 130, 246, 0.35);
  color: #60a5fa;
  font-size: 11px;
  font-weight: 700;
  width: fit-content;
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
  display: inline-flex;
  align-items: center;
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

