<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { MobileTeamScoutData } from './useMobileWizardForm'

defineProps<{
  matchNumber: string
  allianceColor: 'none' | 'red' | 'blue'
  team: MobileTeamScoutData
  autoScore: number
  teleopScore: number
  endgameScore: number
  totalScore: number
  teleopBallsTotal: number
  submitStatus: 'none' | 'success' | 'error'
  submitErrorMsg: string
}>()

const { t } = useI18n()
</script>

<template>
  <section class="step-pane step-summary">
    <div class="pane-header">
      <h2 class="pane-title">{{ t('scouting.total_score') }}</h2>
      <span class="pane-subtitle">{{ t('wizard.summary_sub') }}</span>
    </div>

    <!-- Grand Score Card -->
    <div class="summary-hero-card" :class="`alliance-${allianceColor}`">
      <div class="summary-hero-top">
        <span class="summary-match-badge">Match #{{ matchNumber }}</span>
        <span class="summary-alliance-badge" :class="allianceColor">
          <span class="alliance-dot mini" :class="allianceColor"></span>
          <span>{{ allianceColor === 'red' ? t('scouting.red') : t('scouting.blue') }}</span>
        </span>
        <span class="summary-team-badge">Team #{{ team.teamNumber }}</span>
      </div>

      <div class="summary-total-row">
        <div class="total-label-col">
          <span class="total-label-text">{{ t('wizard.total_predicted') }}</span>
          <span class="total-label-sub">{{ t('wizard.predicted_sub') }}</span>
        </div>
        <div class="total-score-val">{{ totalScore }}</div>
      </div>

      <div class="summary-breakdown-grid">
        <div class="breakdown-col">
          <span class="breakdown-label">{{ t('wizard.auto_stage') }}</span>
          <span class="breakdown-val">{{ autoScore }} {{ t('wizard.pts_unit') }}</span>
          <span class="breakdown-sub">{{ t('wizard.auto_summary_sub', { balls: team.autoBalls, leave: team.autoLeave ? '✓' : '✕' }) }}</span>
        </div>
        <div class="breakdown-col">
          <span class="breakdown-label">{{ t('wizard.teleop_stage') }}</span>
          <span class="breakdown-val">{{ teleopScore }} {{ t('wizard.pts_unit') }}</span>
          <span class="breakdown-sub">{{ t('wizard.teleop_summary_sub', { balls: teleopBallsTotal, cycles: team.teleopCycles.length }) }}</span>
        </div>
        <div class="breakdown-col">
          <span class="breakdown-label">{{ t('wizard.endgame_stage') }}</span>
          <span class="breakdown-val">{{ endgameScore }} {{ t('wizard.pts_unit') }}</span>
          <span class="breakdown-sub">{{ t('wizard.endgame_summary_sub', { flower: team.flowerPlaced ? '✓' : '✕', park: team.teleopPark ? '✓' : '✕' }) }}</span>
        </div>
      </div>

      <div v-if="team.isBroken" class="broken-alert-banner">
        <span class="material-icons" style="font-size: 18px;">warning</span>
        <span>{{ t('wizard.broken_alert') }}</span>
      </div>

      <div v-if="team.notes" class="notes-preview-box">
        <span class="notes-preview-title">{{ t('wizard.notes_prefix') }}</span>
        <span>{{ team.notes }}</span>
      </div>
    </div>

    <!-- Error Feedback Banner -->
    <div v-if="submitStatus === 'error'" class="submit-error-banner">
      <span class="material-icons">error_outline</span>
      <span>{{ submitErrorMsg }}</span>
    </div>
  </section>
</template>

<style scoped>
.step-pane {
  display: flex;
  flex-direction: column;
  gap: 12px;
  animation: pane-fade 0.22s ease-out;
}

@keyframes pane-fade {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.pane-header {
  margin-bottom: 2px;
}

.pane-title {
  font-size: 1.1rem;
  font-weight: 800;
  color: var(--foreground, #f0efe9);
  margin: 0;
}

.pane-subtitle {
  font-size: 11px;
  color: var(--muted-foreground, #8e8d87);
}

.alliance-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
}

.alliance-dot.red {
  background: #ef4444;
  box-shadow: 0 0 8px #ef4444;
}

.alliance-dot.blue {
  background: #38bdf8;
  box-shadow: 0 0 8px #38bdf8;
}

.alliance-dot.mini {
  width: 6px;
  height: 6px;
  margin-right: 4px;
}

/* Summary Card */
.summary-hero-card {
  background: #141413;
  border: 1.5px solid #262624;
  border-radius: 14px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.summary-hero-card.alliance-red {
  border-color: #ef4444;
  border-top: 3px solid #f97316;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5), 0 0 18px rgba(239, 68, 68, 0.15);
}

.summary-hero-card.alliance-blue {
  border-color: #38bdf8;
  border-top: 3px solid #3b82f6;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5), 0 0 18px rgba(56, 189, 248, 0.15);
}

.summary-hero-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.summary-match-badge,
.summary-team-badge {
  font-family: 'Orbitron', monospace;
  font-size: 13px;
  font-weight: 700;
  color: var(--foreground, #f0efe9);
}

.summary-alliance-badge {
  font-size: 11px;
  font-weight: 800;
  padding: 2px 8px;
  border-radius: 6px;
}

.summary-alliance-badge.red {
  background: #1b1111;
  color: #f87171;
  border: 1px solid #ef4444;
}

.summary-alliance-badge.blue {
  background: #0f1622;
  color: #38bdf8;
  border: 1px solid #38bdf8;
}

.summary-total-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  background: #080807;
  border: 1px solid #262624;
  border-left: 3px solid #39ff14;
  border-radius: 10px;
}

.total-label-text {
  font-size: 14px;
  font-weight: 700;
  color: var(--foreground, #f0efe9);
  display: block;
}

.total-label-sub {
  font-size: 9px;
  color: var(--muted-foreground, #8e8d87);
  letter-spacing: 0.5px;
}

.total-score-val {
  font-size: 2.2rem;
  font-weight: 900;
  color: #39ff14;
  font-family: 'Orbitron', monospace;
  font-variant-numeric: tabular-nums;
}

.summary-breakdown-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 8px;
}

.breakdown-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 4px;
  background: #080807;
  border: 1px solid #262624;
  border-radius: 8px;
  text-align: center;
}

.breakdown-label {
  font-size: 10px;
  color: var(--muted-foreground, #8e8d87);
}

.breakdown-val {
  font-size: 14px;
  font-weight: 800;
  color: var(--foreground, #f0efe9);
  margin: 2px 0;
  font-variant-numeric: tabular-nums;
}

.breakdown-sub {
  font-size: 9px;
  color: var(--muted-foreground, #8e8d87);
}

.broken-alert-banner {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  background: #1b1111;
  border: 1px solid #ef4444;
  border-radius: 8px;
  color: #f87171;
  font-size: 12px;
  font-weight: 600;
}

.notes-preview-box {
  font-size: 12px;
  color: var(--foreground, #f0efe9);
  background: #080807;
  border: 1px solid #262624;
  padding: 8px 10px;
  border-radius: 8px;
}

.notes-preview-title {
  color: var(--muted-foreground, #8e8d87);
  font-weight: 600;
}

.submit-error-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: #1b1111;
  border: 1px solid #ef4444;
  border-radius: 10px;
  color: #ffffff;
  font-size: 13px;
  font-weight: 600;
}
</style>
