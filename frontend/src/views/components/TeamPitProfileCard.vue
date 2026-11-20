<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CustomFieldDefinition, UnifiedTeamItem } from '@/types'
import { LAUNCHER_PRESETS, FLOWER_PRESETS, CHASSIS_SIZE_PRESETS } from '@/constants/pitScoutPresets'

const props = defineProps<{
  unifiedTeam?: UnifiedTeamItem
  teamPitCustomSpecs: { field: CustomFieldDefinition; displayValue: string }[]
}>()

const emit = defineEmits<{
  (e: 'openPitDrawer'): void
}>()

const { t, te } = useI18n()

function formatDrivetrain(dt?: string) {
  if (!dt) return '-'
  const key = 'pit_scout.drivetrain.' + dt
  return te(key) ? t(key) : dt
}

function formatBallCompat(bc?: string) {
  if (!bc) return '-'
  const key = 'pit_scout.ball_compatibility.' + bc
  return te(key) ? t(key) : bc
}

function formatOdometry(odo?: string) {
  if (!odo) return '-'
  const key = 'pit_scout.odometry.' + odo
  return te(key) ? t(key) : odo
}

function formatPresetSpec(
  raw: string | undefined,
  presets: readonly { key: string; zh: string; en: string }[],
  prefix: string
): string {
  if (!raw) return '-'
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

const detailBragLabel = computed(() => {
  const b = props.unifiedTeam?.bragInfo
  if (!b) return '-'
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
  <div class="team-tags-card pit-profile-card">
    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
      <h3 style="margin: 0; display: flex; align-items: center; gap: 6px;">
        <span class="material-icons" style="font-size: 18px; color: var(--primary);">precision_manufacturing</span>
        {{ t('pit_scout.detail_card.title') }}
      </h3>
      <button
        type="button"
        class="user-tag-btn btn-edit-pit"
        style="font-size: 12px; padding: 6px 14px;"
        @click="emit('openPitDrawer')"
      >
        <span class="material-icons" style="font-size: 15px;">edit_note</span>
        {{ unifiedTeam?.hasPitRecord ? t('pit_scout.detail_card.btn_edit') : t('pit_scout.detail_card.btn_add') }}
      </button>
    </div>

    <div v-if="unifiedTeam?.pitRecord" style="display: flex; flex-direction: column; gap: 12px;">
      <div style="display: flex; flex-wrap: wrap; gap: 6px;">
        <span class="spec-badge">{{ t('pit_scout.detail_card.spec_drivetrain', { val: formatDrivetrain(unifiedTeam.pitRecord.drivetrainType) }) }}</span>
        <span v-if="unifiedTeam.pitRecord.chassisSize" class="spec-badge">{{ t('pit_scout.detail_card.spec_chassis_size', { val: formatPresetSpec(unifiedTeam.pitRecord.chassisSize, CHASSIS_SIZE_PRESETS, 'pit_scout.chassis_size_presets') }) }}</span>
        <span v-if="unifiedTeam.pitRecord.weightLbs" class="spec-badge">{{ t('pit_scout.detail_card.spec_weight', { val: unifiedTeam.pitRecord.weightLbs }) }}</span>
        <span v-if="unifiedTeam.pitRecord.ballCompatibility" class="spec-badge">{{ t('pit_scout.detail_card.spec_ball_compat', { val: formatBallCompat(unifiedTeam.pitRecord.ballCompatibility) }) }}</span>
        <span v-if="unifiedTeam.pitRecord.launcherType" class="spec-badge">{{ t('pit_scout.detail_card.spec_launcher', { val: formatPresetSpec(unifiedTeam.pitRecord.launcherType, LAUNCHER_PRESETS, 'pit_scout.launcher_presets') }) }}</span>
        <span v-if="unifiedTeam.pitRecord.flowerMechanism" class="spec-badge">{{ t('pit_scout.detail_card.spec_flower', { val: formatPresetSpec(unifiedTeam.pitRecord.flowerMechanism, FLOWER_PRESETS, 'pit_scout.flower_presets') }) }}</span>
        <span v-if="unifiedTeam.pitRecord.hasColorSensor" class="spec-badge">{{ t('pit_scout.detail_card.spec_color_sensor', { val: t('pit_scout.detail_card.equipped') }) }}</span>
        <span v-if="unifiedTeam.pitRecord.hasDescoreMech" class="spec-badge">{{ t('pit_scout.detail_card.spec_descore_mech', { val: t('pit_scout.detail_card.equipped') }) }}</span>
        <span v-if="unifiedTeam.pitRecord.hasApriltagVision" class="spec-badge">{{ t('pit_scout.detail_card.spec_apriltag_vision', { val: t('pit_scout.detail_card.equipped') }) }}</span>
        <span class="spec-badge">{{ t('pit_scout.detail_card.spec_odometry', { val: formatOdometry(unifiedTeam.pitRecord.odometryType) }) }}</span>
        <span
          v-for="item in teamPitCustomSpecs"
          :key="item.field.fieldKey"
          class="spec-badge custom-spec-badge"
        >
          {{ item.field.name }}: {{ item.displayValue }}
        </span>
      </div>

      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; background: var(--surface-recessed); border: 1px solid var(--border); border-radius: 8px; padding: 10px;">
        <div style="display: flex; flex-direction: column; gap: 2px;">
          <span style="font-size: 11px; color: var(--muted-foreground);">{{ t('pit_scout.detail_card.claimed_calc_total') }}</span>
          <span class="pit-score-val" style="font-size: 16px; font-weight: 700; color: var(--primary);">{{ unifiedTeam.pitRecord.claimedTotalScore }}</span>
          <span style="font-size: 10px; color: var(--muted-foreground);">{{ t('pit_scout.detail_card.claimed_auto_teleop_endgame', { auto: unifiedTeam.pitRecord.claimedAutoScore, teleop: unifiedTeam.pitRecord.claimedTeleopScore, cycles: unifiedTeam.pitRecord.claimedTeleopCycles || 0, endgame: unifiedTeam.pitRecord.claimedEndgameScore || 0 }) }}</span>
        </div>
        <div style="display: flex; flex-direction: column; gap: 2px;">
          <span style="font-size: 11px; color: var(--muted-foreground);">{{ t('pit_scout.detail_card.actual_max_total') }}</span>
          <span class="pit-score-val" style="font-size: 16px; font-weight: 700; color: var(--foreground);">{{ unifiedTeam.maxTotalScore ?? '-' }}</span>
          <span style="font-size: 10px; color: var(--muted-foreground);">{{ t('pit_scout.detail_card.actual_avg', { avg: unifiedTeam.avgTotalScore ?? '-' }) }}</span>
        </div>
        <div style="display: flex; flex-direction: column; gap: 4px;">
          <span style="font-size: 11px; color: var(--muted-foreground);">{{ t('pit_scout.detail_card.brag_rating') }}</span>
          <span v-if="unifiedTeam.bragInfo" style="font-size: 12px; font-weight: 700;">
            {{ detailBragLabel }}
          </span>
          <span v-else style="font-size: 12px; color: var(--muted-foreground);">-</span>
          <div v-if="unifiedTeam.bragInfo" class="detail-verify-row">
            <span v-if="unifiedTeam.bragInfo.flowerVerified" class="verify-pill is-verified">
              {{ t('pit_scout.flower_verified') }}
            </span>
            <span v-else-if="unifiedTeam.bragInfo.flowerPending" class="verify-pill is-pending">
              {{ t('pit_scout.flower_pending_verify') }}
            </span>
            <span v-if="unifiedTeam.bragInfo.parkVerified" class="verify-pill is-verified">
              {{ t('pit_scout.park_verified') }}
            </span>
            <span v-else-if="unifiedTeam.bragInfo.parkPending" class="verify-pill is-pending">
              {{ t('pit_scout.park_pending') }}
            </span>
          </div>
        </div>
      </div>
    </div>
    <div v-else style="font-size: 13px; color: var(--muted-foreground); padding: 8px 0;">
      {{ t('pit_scout.detail_card.no_pit_data') }}
    </div>
  </div>
</template>

<style scoped>
.team-tags-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 20px;
}

.team-tags-card h3 {
  margin: 0 0 12px;
  font-size: 15px;
  font-weight: 600;
  color: var(--foreground);
}

.pit-score-val {
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
}

.spec-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 6px;
  background: var(--surface-recessed);
  color: var(--foreground);
  border: 1px solid var(--border);
}

.custom-spec-badge {
  border-color: var(--status-success-border);
  background: var(--status-success-bg);
  color: var(--s-200);
}

.detail-verify-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.verify-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
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

.user-tag-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px 14px;
  border-radius: 8px;
  background: var(--surface-elevated);
  border: 1px solid var(--border-strong);
  color: var(--primary);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out),
              border-color var(--motion-duration-fast) var(--motion-ease-out),
              color var(--motion-duration-fast) var(--motion-ease-out);
  box-shadow: var(--shadow-1);
}

.user-tag-btn:hover {
  background: var(--status-success-bg);
  border-color: var(--primary);
  color: var(--primary);
  box-shadow: var(--shadow-1);
}
</style>
