<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { UnifiedTeamItem } from '@/types'
import { getPhotoUrl } from '@/services/photoStorage'
import ImagePreviewModal from '@/components/common/ImagePreviewModal.vue'
import PitStatusIndicator from './PitStatusIndicator.vue'
import { LAUNCHER_PRESETS, FLOWER_PRESETS, CHASSIS_SIZE_PRESETS } from '@/constants/pitScoutPresets'

const props = defineProps<{
  team: UnifiedTeamItem
  cardIndex?: number
}>()

const emit = defineEmits<{
  (e: 'select', teamNumber: number): void
}>()

const { t, te } = useI18n()
const photoUrl = ref<string | null>(null)
const allPhotoUrls = ref<string[]>([])
const isPreviewOpen = ref(false)

async function loadPhoto() {
  const keys = props.team.pitRecord?.photoKeys
  const eventId = props.team.pitRecord?.eventId || ''
  if (keys && keys.length > 0) {
    const urls: string[] = []
    for (const key of keys) {
      const u = await getPhotoUrl(key, eventId)
      if (u) urls.push(u)
    }
    allPhotoUrls.value = urls
    photoUrl.value = urls[0] || null
  } else {
    allPhotoUrls.value = []
    photoUrl.value = null
  }
}

onMounted(loadPhoto)
watch(() => props.team.pitRecord?.photoKeys, loadPhoto, { deep: true })

function formatPresetLabel(
  raw: string | undefined,
  presets: readonly { key: string; zh: string; en: string }[],
  prefix: string
): string {
  if (!raw) return ''
  const trimmed = raw.trim()
  const lower = trimmed.toLowerCase()
  const preset = presets.find(
    (p) =>
      p.zh === trimmed ||
      p.en === trimmed ||
      p.key === trimmed ||
      p.en.toLowerCase() === lower ||
      p.key.toLowerCase() === lower
  )
  if (preset) {
    const key = `${prefix}.${preset.key}`
    return te(key) ? t(key) : trimmed
  }
  return trimmed
}

const drivetrainText = computed(() => {
  const dt = props.team.pitRecord?.drivetrainType
  if (!dt) return ''
  const key = `pit_scout.drivetrain.${dt}`
  return te(key) ? t(key) : dt
})

const chassisSizeText = computed(() =>
  formatPresetLabel(props.team.pitRecord?.chassisSize, CHASSIS_SIZE_PRESETS, 'pit_scout.chassis_size_presets')
)

const ballCompatibilityText = computed(() => {
  const bc = props.team.pitRecord?.ballCompatibility
  if (!bc) return ''
  const key = `pit_scout.ball_compatibility.${bc}`
  return te(key) ? t(key) : bc
})

const launcherText = computed(() =>
  formatPresetLabel(props.team.pitRecord?.launcherType, LAUNCHER_PRESETS, 'pit_scout.launcher_presets')
)

const flowerText = computed(() => {
  const raw = props.team.pitRecord?.flowerMechanism?.trim()
  if (!raw || raw.toLowerCase() === 'none' || raw === '无') return ''
  return formatPresetLabel(raw, FLOWER_PRESETS, 'pit_scout.flower_presets')
})

const bragLabel = computed(() => {
  const b = props.team.bragInfo
  if (!b) return ''
  if (b.tier === 'pending') {
    if (b.labelKey && te(b.labelKey)) return t(b.labelKey)
    return te('pit_scout.brag_tiers.pending') ? t('pit_scout.brag_tiers.pending') : b.label
  }
  const tierKey = `pit_scout.brag_tiers.${b.tier}`
  const tierText = te(tierKey) ? t(tierKey) : b.tier
  if (te('pit_scout.brag_label_format')) {
    return t('pit_scout.brag_label_format', { ratio: b.overallRatio, tier: tierText })
  }
  return `${b.overallRatio}x ${tierText}`
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
      <span v-if="chassisSizeText" class="pill pill-chassis">
        <span class="material-icons pill-icon">straighten</span>
        {{ chassisSizeText }}
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
      <span v-if="flowerText" class="pill pill-flower">
        <span class="material-icons pill-icon">local_florist</span>
        {{ flowerText }}
      </span>
      <span v-if="team.pitRecord.hasDescoreMech" class="pill pill-feature">
        <span class="material-icons pill-icon">layers_clear</span>
        {{ t('pit_scout.descore_capable') }}
      </span>
      <span v-if="team.pitRecord.hasApriltagVision" class="pill pill-feature">
        <span class="material-icons pill-icon">qr_code_scanner</span>
        {{ t('pit_scout.apriltag_vision') }}
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
          {{ t('pit_scout.claimed_pts_unit', { pts: team.pitRecord.claimedAutoScore || 0 }) }}
        </span>
      </div>
      <div class="quant-item">
        <span class="quant-label">{{ t('pit_scout.claimed_teleop_cycles') }}</span>
        <span class="quant-value">
          {{ t('pit_scout.claimed_cycles_unit', { cycles: team.pitRecord.claimedTeleopCycles || 0 }) }}
        </span>
      </div>
      <div class="quant-item">
        <span class="quant-label">{{ t('pit_scout.claimed_endgame') }}</span>
        <span class="quant-value">
          {{ t('pit_scout.claimed_pts_unit', { pts: team.pitRecord.claimedEndgameScore || 0 }) }}
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
      <div v-if="team.bragInfo" class="reconcile-badges">
        <span v-if="team.bragInfo.flowerVerified" class="verify-pill is-verified">
          {{ t('pit_scout.flower_verified') }}
        </span>
        <span v-else-if="team.bragInfo.flowerPending" class="verify-pill is-pending">
          {{ t('pit_scout.flower_pending_verify') }}
        </span>
        <span v-if="team.bragInfo.parkVerified" class="verify-pill is-verified">
          {{ t('pit_scout.park_verified') }}
        </span>
        <span v-else-if="team.bragInfo.parkPending" class="verify-pill is-pending">
          {{ t('pit_scout.park_pending') }}
        </span>
        <div class="brag-tier-pill" :class="`tier-${team.bragInfo.tier}`">
          <span class="material-icons brag-icon" v-if="team.bragInfo.tier === 'realistic'">verified</span>
          <span class="material-icons brag-icon" v-else-if="team.bragInfo.tier === 'optimistic'">trending_up</span>
          <span class="material-icons brag-icon" v-else-if="team.bragInfo.tier === 'overclaimed'">warning</span>
          <span class="material-icons brag-icon" v-else-if="team.bragInfo.tier === 'mythical'">local_fire_department</span>
          <span>{{ bragLabel }}</span>
        </div>
      </div>
    </div>

    <!-- 照片预览图 (若有) -->
    <div
      v-if="photoUrl"
      class="card-thumbnail"
      @click.stop="isPreviewOpen = true"
      :title="t('pit_scout.view_robot_photo')"
    >
      <img :src="photoUrl" alt="Robot Photo" loading="lazy" />
      <div class="thumbnail-overlay">
        <span class="material-icons zoom-icon">zoom_in</span>
        <span v-if="allPhotoUrls.length > 1" class="photo-count-badge">{{ t('pit_scout.photo_count_badge', { count: allPhotoUrls.length }) }}</span>
      </div>
    </div>

    <!-- 底部操作提示 -->
    <div class="card-footer">
      <button class="action-btn" type="button">
        {{ team.hasPitRecord ? t('pit_scout.btn_view_edit') : t('pit_scout.btn_add_record') }}
      </button>
    </div>

    <!-- 全屏大图查看弹窗 -->
    <ImagePreviewModal
      v-model="isPreviewOpen"
      :images="allPhotoUrls"
      :image-url="photoUrl"
      :title="team.teamNumber ? t('pit_scout.robot_photo_title', { teamNumber: team.teamNumber, teamName: team.name ? team.name + ' ' : '' }) : ''"
    />
  </div>
</template>

<style scoped>
.team-roster-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  cursor: pointer;
  transition: background-color var(--motion-duration-moderate) var(--motion-ease-out),
              border-color var(--motion-duration-moderate) var(--motion-ease-out),
              transform var(--motion-duration-moderate) var(--motion-ease-out),
              box-shadow var(--motion-duration-moderate) var(--motion-ease-out);
  position: relative;
  animation: card-cascade-in var(--motion-duration-moderate) var(--motion-ease-out) both;
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
  background: var(--surface-elevated);
  border-color: var(--primary);
  transform: translateY(-2px);
  box-shadow: var(--shadow-2);
}

.team-roster-card.is-scouted {
  border-left: 3px solid var(--primary);
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
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
  font-size: 18px;
  font-weight: 800;
  color: var(--foreground);
  letter-spacing: -0.02em;
}

.team-name {
  font-size: 14px;
  color: var(--muted-foreground);
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
  background: var(--status-info-bg);
  border: 1px solid var(--status-info-border);
  color: var(--status-info);
  font-size: 11px;
  font-weight: 700;
  width: fit-content;
}

.card-subtitle {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--muted-foreground);
}

.hardware-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 9999px;
  background: var(--surface-elevated);
  border: 1px solid var(--border);
  color: var(--foreground);
  font-weight: 500;
}

.pill-icon {
  font-size: 13px;
  opacity: 0.85;
}

.pill-drivetrain {
  background: var(--status-success-bg);
  border-color: var(--status-success-border);
  color: var(--primary);
}

.pill-feature {
  background: var(--status-info-bg);
  border-color: var(--status-info-border);
  color: var(--status-info);
}

.quant-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px 12px;
  background: var(--surface-recessed);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
}

.quant-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.quant-label {
  font-size: 10px;
  color: var(--muted-foreground);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.quant-value {
  font-size: 13px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--foreground);
}

.quant-value.highlight {
  color: var(--primary);
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
  font-weight: 800;
}

.match-reconcile-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 7px 10px;
  border-radius: 8px;
  background: var(--surface-recessed);
  border: 1px solid var(--border);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.reconcile-scores {
  display: flex;
  gap: 8px;
  color: var(--muted-foreground);
}

.reconcile-badges {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
}

.verify-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 9999px;
  font-size: 10px;
  font-weight: 600;
}

.verify-pill.is-verified {
  background: var(--status-success-bg);
  color: var(--status-success);
  border: 1px solid var(--status-success-border);
}

.verify-pill.is-pending {
  background: var(--status-warning-bg);
  color: var(--status-warning);
  border: 1px solid var(--status-warning-border);
}

.brag-tier-pill {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: 10px;
}

.brag-icon {
  font-size: 12px;
}

.tier-realistic { background: var(--status-success-bg); color: var(--status-success); border: 1px solid var(--status-success-border); }
.tier-optimistic { background: var(--status-warning-bg); color: var(--status-warning); border: 1px solid var(--status-warning-border); }
.tier-overclaimed { background: color-mix(in srgb, var(--status-warning-bg) 50%, var(--status-error-bg)); color: color-mix(in srgb, var(--status-warning) 55%, var(--status-error)); border: 1px solid color-mix(in srgb, var(--status-warning-border) 50%, var(--status-error-border)); }
.tier-mythical { background: var(--status-error-bg); color: var(--status-error); border: 1px solid var(--status-error-border); }
.tier-pending { background: var(--surface-elevated); color: var(--muted-foreground); border: 1px solid var(--border); }

.card-thumbnail {
  width: 100%;
  height: 120px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--surface-recessed);
  border: 1px solid var(--border);
  position: relative;
  cursor: zoom-in;
}

.card-thumbnail img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform var(--motion-duration-fast) var(--motion-ease-out);
}

.card-thumbnail:hover img {
  transform: scale(1.04);
}

.thumbnail-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: color-mix(in srgb, var(--g-950) 35%, transparent);
  opacity: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity var(--motion-duration-fast) var(--motion-ease-out);
  pointer-events: none;
}

.card-thumbnail:hover .thumbnail-overlay {
  opacity: 1;
}

.zoom-icon {
  font-size: 28px;
  color: var(--g-50);
  filter: drop-shadow(0 2px 4px color-mix(in srgb, var(--g-950) 80%, transparent));
}

.photo-count-badge {
  position: absolute;
  bottom: 6px;
  right: 6px;
  background: color-mix(in srgb, var(--g-950) 70%, transparent);
  color: var(--g-50);
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--g-50) 20%, transparent);
}

.card-footer {
  margin-top: auto;
}

.action-btn {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--status-success-border);
  border-radius: 8px;
  background: var(--status-success-bg);
  color: var(--primary);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out),
              border-color var(--motion-duration-fast) var(--motion-ease-out),
              color var(--motion-duration-fast) var(--motion-ease-out);
}

.team-roster-card:hover .action-btn {
  background: var(--primary);
  color: var(--primary-foreground);
}
</style>

