<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { CustomMetricSummary } from '../composables/useTeamCustomMetrics'

defineProps<{
  metrics: CustomMetricSummary[]
}>()

const { t } = useI18n()
</script>

<template>
  <div v-if="metrics.length > 0" class="team-tags-card custom-metrics-card">
    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
      <h3 style="margin: 0; display: flex; align-items: center; gap: 6px;">
        <span class="material-icons" style="font-size: 18px; color: var(--primary, #39ff14);">tune</span>
        {{ t('custom_fields.team_metrics_title') }}
      </h3>
      <span class="metrics-count-badge">{{ t('custom_fields.renderer.metric_count', { count: metrics.length }) }}</span>
    </div>

    <div class="custom-metrics-grid">
      <div
        v-for="metric in metrics"
        :key="metric.definition.fieldKey"
        class="metric-box"
      >
        <div class="metric-header">
          <span class="metric-name">{{ metric.definition.name }}</span>
          <span class="metric-phase-tag">{{ t(`custom_fields.badge_phase_${metric.definition.phase}`) || metric.definition.phase }}</span>
        </div>

        <!-- Number / Level metric display -->
        <div v-if="metric.fieldType === 'number' || metric.fieldType === 'level'" class="metric-stat-row">
          <div class="stat-col">
            <span class="stat-label">{{ t('custom_fields.avg_metric') }}</span>
            <span class="stat-value highlight">{{ metric.avg !== null && metric.avg !== undefined ? metric.avg.toFixed(1) : '-' }}</span>
            <span v-if="metric.definition.unit" class="stat-unit">{{ metric.definition.unit }}</span>
          </div>
          <div class="stat-col">
            <span class="stat-label">{{ t('custom_fields.max_metric') }}</span>
            <span class="stat-value">{{ metric.max !== null && metric.max !== undefined ? metric.max : '-' }}</span>
            <span v-if="metric.definition.unit" class="stat-unit">{{ metric.definition.unit }}</span>
          </div>
          <div class="stat-col">
            <span class="stat-label">{{ t('custom_fields.renderer.matches_label') }}</span>
            <span class="stat-value count">{{ metric.totalCount }}</span>
          </div>
        </div>

        <!-- Boolean metric display -->
        <div v-else-if="metric.fieldType === 'boolean'" class="metric-stat-row">
          <div class="stat-col full">
            <div class="bool-rate-bar-wrapper">
              <div class="bool-rate-label">
                <span>{{ t('custom_fields.rate_occurrence') }}</span>
                <span class="rate-num">{{ metric.rate?.toFixed(0) }}%</span>
              </div>
              <div class="rate-progress-track">
                <div class="rate-progress-fill" :style="{ width: `${metric.rate || 0}%` }"></div>
              </div>
              <span class="stat-detail">{{ t('custom_fields.renderer.match_records_count', { recorded: metric.trueCount, total: metric.totalCount }) }}</span>
            </div>
          </div>
        </div>

        <!-- Select / Multi Select metric display -->
        <div v-else-if="metric.fieldType === 'select' || metric.fieldType === 'multi_select'" class="metric-distribution">
          <div
            v-for="opt in metric.distribution"
            :key="opt.label"
            class="dist-item"
          >
            <span class="dist-label-badge" :class="`color-${opt.color || 'blue'}`">{{ opt.label }}</span>
            <span class="dist-count">{{ t('custom_fields.renderer.times_count', { count: opt.count, percent: opt.percentage.toFixed(0) }) }}</span>
          </div>
        </div>

        <!-- Text metric display -->
        <div v-else-if="metric.fieldType === 'text'" class="metric-text-list">
          <div
            v-for="(entry, eIdx) in metric.textEntries?.slice(0, 3)"
            :key="eIdx"
            class="metric-text-bubble"
          >
            <span class="match-badge">#{{ entry.matchNumber }}</span>
            <span class="text-content">{{ entry.text }}</span>
          </div>
          <span v-if="(metric.textEntries?.length || 0) > 3" class="more-text-hint">
            {{ t('custom_fields.renderer.more_records', { count: (metric.textEntries?.length || 0) - 3 }) }}
          </span>
        </div>
      </div>
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

.custom-metrics-card {
  border-color: rgba(57, 255, 20, 0.2);
  background: linear-gradient(180deg, rgba(57, 255, 20, 0.02) 0%, var(--card) 100%);
}

.metrics-count-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--muted-foreground);
  border: 1px solid var(--border);
}

.custom-metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}

.metric-box {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.metric-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.metric-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.metric-phase-tag {
  font-size: 10px;
  text-transform: uppercase;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--muted-foreground);
}

.metric-stat-row {
  display: flex;
  gap: 8px;
}

.stat-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: rgba(0, 0, 0, 0.2);
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.04);
}

.stat-col.full {
  flex: 1 1 100%;
}

.stat-label {
  font-size: 10px;
  color: var(--muted-foreground);
}

.stat-value {
  font-size: 15px;
  font-weight: 700;
  color: var(--foreground);
}

.stat-value.highlight {
  color: var(--primary, #39ff14);
}

.stat-value.count {
  font-size: 13px;
  color: var(--muted-foreground);
}

.stat-unit {
  font-size: 10px;
  color: var(--muted-foreground);
}

.bool-rate-bar-wrapper {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.bool-rate-label {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--muted-foreground);
}

.bool-rate-label .rate-num {
  font-weight: 700;
  color: var(--primary, #39ff14);
}

.rate-progress-track {
  height: 6px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 3px;
  overflow: hidden;
}

.rate-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #38bdf8, #39ff14);
  border-radius: 3px;
  transition: width 0.3s ease;
}

.stat-detail {
  font-size: 10px;
  color: var(--muted-foreground);
  margin-top: 2px;
}

.metric-distribution {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dist-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
}

.dist-label-badge {
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid transparent;
}

.dist-label-badge.color-blue { background: rgba(56, 189, 248, 0.15); color: #38bdf8; border-color: rgba(56, 189, 248, 0.3); }
.dist-label-badge.color-green { background: rgba(57, 255, 20, 0.15); color: #39ff14; border-color: rgba(57, 255, 20, 0.3); }
.dist-label-badge.color-orange { background: rgba(251, 146, 60, 0.15); color: #fb923c; border-color: rgba(251, 146, 60, 0.3); }
.dist-label-badge.color-red { background: rgba(248, 113, 113, 0.15); color: #f87171; border-color: rgba(248, 113, 113, 0.3); }
.dist-label-badge.color-purple { background: rgba(192, 132, 252, 0.15); color: #c084fc; border-color: rgba(192, 132, 252, 0.3); }
.dist-label-badge.color-gray { background: rgba(148, 163, 184, 0.15); color: #94a3b8; border-color: rgba(148, 163, 184, 0.3); }

.dist-count {
  color: var(--muted-foreground);
  font-size: 11px;
}

.metric-text-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.metric-text-bubble {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 11px;
}

.metric-text-bubble .match-badge {
  font-weight: 700;
  color: var(--primary, #39ff14);
  font-size: 10px;
}

.metric-text-bubble .text-content {
  color: var(--foreground);
  word-break: break-word;
}

.more-text-hint {
  font-size: 10px;
  color: var(--muted-foreground);
  font-style: italic;
}
</style>
