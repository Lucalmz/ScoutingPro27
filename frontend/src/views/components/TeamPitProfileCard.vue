<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CustomFieldDefinition, UnifiedTeamItem } from '@/types'

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

const detailBragLabel = computed(() => {
  const b = props.unifiedTeam?.bragInfo
  if (!b) return '-'
  const tierText = t(`pit_scout.brag_tiers.${b.tier}`) || b.label
  return `${b.overallRatio}x ${tierText}`
})
</script>

<template>
  <div class="team-tags-card pit-profile-card">
    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
      <h3 style="margin: 0; display: flex; align-items: center; gap: 6px;">
        <span class="material-icons" style="font-size: 18px; color: var(--primary, #39ff14);">precision_manufacturing</span>
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
        <span v-if="unifiedTeam.pitRecord.weightLbs" class="spec-badge">{{ t('pit_scout.detail_card.spec_weight', { val: unifiedTeam.pitRecord.weightLbs }) }}</span>
        <span v-if="unifiedTeam.pitRecord.ballCompatibility" class="spec-badge">{{ t('pit_scout.detail_card.spec_ball_compat', { val: formatBallCompat(unifiedTeam.pitRecord.ballCompatibility) }) }}</span>
        <span v-if="unifiedTeam.pitRecord.launcherType" class="spec-badge">{{ t('pit_scout.detail_card.spec_launcher', { val: unifiedTeam.pitRecord.launcherType }) }}</span>
        <span v-if="unifiedTeam.pitRecord.flowerMechanism" class="spec-badge">{{ t('pit_scout.detail_card.spec_flower', { val: unifiedTeam.pitRecord.flowerMechanism }) }}</span>
        <span v-if="unifiedTeam.pitRecord.hasColorSensor" class="spec-badge">{{ t('pit_scout.detail_card.spec_color_sensor', { val: t('pit_scout.detail_card.equipped') }) }}</span>
        <span class="spec-badge">{{ t('pit_scout.detail_card.spec_odometry', { val: formatOdometry(unifiedTeam.pitRecord.odometryType) }) }}</span>
        <span
          v-for="item in teamPitCustomSpecs"
          :key="item.field.fieldKey"
          class="spec-badge custom-spec-badge"
        >
          {{ item.field.name }}: {{ item.displayValue }}
        </span>
      </div>

      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; background: rgba(255, 255, 255, 0.02); border: 1px solid var(--border); border-radius: 8px; padding: 10px;">
        <div style="display: flex; flex-direction: column; gap: 2px;">
          <span style="font-size: 11px; color: var(--muted-foreground);">{{ t('pit_scout.detail_card.claimed_calc_total') }}</span>
          <span style="font-size: 16px; font-weight: 700; color: var(--primary);">{{ unifiedTeam.pitRecord.claimedTotalScore }}</span>
          <span style="font-size: 10px; color: var(--muted-foreground);">{{ t('pit_scout.detail_card.claimed_auto_teleop', { auto: unifiedTeam.pitRecord.claimedAutoScore, teleop: unifiedTeam.pitRecord.claimedTeleopScore, cycles: unifiedTeam.pitRecord.claimedTeleopCycles || 0 }) }}</span>
        </div>
        <div style="display: flex; flex-direction: column; gap: 2px;">
          <span style="font-size: 11px; color: var(--muted-foreground);">{{ t('pit_scout.detail_card.actual_max_total') }}</span>
          <span style="font-size: 16px; font-weight: 700; color: var(--foreground);">{{ unifiedTeam.maxTotalScore ?? '-' }}</span>
          <span style="font-size: 10px; color: var(--muted-foreground);">{{ t('pit_scout.detail_card.actual_avg', { avg: unifiedTeam.avgTotalScore ?? '-' }) }}</span>
        </div>
        <div style="display: flex; flex-direction: column; gap: 2px;">
          <span style="font-size: 11px; color: var(--muted-foreground);">{{ t('pit_scout.detail_card.brag_rating') }}</span>
          <span v-if="unifiedTeam.bragInfo" style="font-size: 12px; font-weight: 700;">
            {{ detailBragLabel }}
          </span>
          <span v-else style="font-size: 12px; color: var(--muted-foreground);">-</span>
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

.spec-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 6px;
  background: #080807;
  color: var(--foreground, #f0efe9);
  border: 1px solid var(--border, #262624);
}

.custom-spec-badge {
  border-color: rgba(57, 255, 20, 0.25);
  background: rgba(57, 255, 20, 0.05);
  color: var(--primary, #39ff14);
}

.user-tag-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px 14px;
  border-radius: 8px;
  background: #1c1c1a;
  border: 1px solid #353532;
  color: var(--primary, #39ff14);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: all var(--motion-duration-fast) var(--motion-ease-out);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
}

.user-tag-btn:hover {
  background: rgba(57, 255, 20, 0.12);
  border-color: var(--primary, #39ff14);
  color: var(--primary, #39ff14);
  box-shadow: 0 0 14px rgba(57, 255, 20, 0.25);
}
</style>
