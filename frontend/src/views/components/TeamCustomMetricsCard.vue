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
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px;">
      <h3 style="margin: 0; display: flex; align-items: center; gap: 6px;">
        <span class="material-icons" style="font-size: 18px; color: var(--primary);">tune</span>
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
          <span class="metric-phase-tag">
            {{ metric.definition.target === 'TEAM' ? 'TEAM' : (t(`custom_fields.badge_phase_${metric.definition.phase}`) || metric.definition.phase) }}
          </span>
        </div>

        <!-- Formula metric display (MATCH / TEAM) -->
        <div v-if="metric.fieldType === 'formula'" class="metric-stat-row">
          <div v-if="metric.error" class="stat-col full formula-error-box">
            <span class="formula-error-badge">
              <span class="material-icons" style="font-size: 14px;">warning</span>
              {{ metric.error === 'CIRCULAR_DEPENDENCY' ? t('custom_fields.formula_cycle_error') : t('custom_fields.formula_eval_error') }}
            </span>
            <span class="stat-detail">{{ metric.error }}</span>
          </div>
          <template v-else>
            <div class="stat-col">
              <span class="stat-label">{{ metric.definition.aggregationMode ? t(`custom_fields.agg_${metric.definition.aggregationMode}`) : t('custom_fields.formula_value_label') }}</span>
              <span class="stat-value highlight" :class="metric.tier ? `tier-val-${metric.tier}` : ''">
                {{ metric.aggregatedDisplay ?? '-' }}
              </span>
              <span v-if="metric.definition.unit && metric.definition.displayFormat !== 'percent'" class="stat-unit">{{ metric.definition.unit }}</span>
            </div>
            <div v-if="metric.max !== null && metric.max !== undefined" class="stat-col">
              <span class="stat-label">{{ t('custom_fields.max_metric') }}</span>
              <span class="stat-value">{{ metric.max.toFixed(1) }}</span>
            </div>
            <div class="stat-col">
              <span class="stat-label">{{ t('custom_fields.renderer.matches_label') }}</span>
              <span class="stat-value count">{{ metric.totalCount ?? 0 }}</span>
            </div>
          </template>
        </div>

        <!-- Number / Level / Timer metric display -->
        <div v-else-if="metric.fieldType === 'number' || metric.fieldType === 'level' || metric.fieldType === 'timer'" class="metric-stat-row">
          <div class="stat-col">
            <span class="stat-label">{{ metric.aggregationMode && metric.aggregationMode !== 'avg' ? t(`custom_fields.agg_${metric.aggregationMode}`) : t('custom_fields.avg_metric') }}</span>
            <span class="stat-value highlight" :class="metric.tier ? `tier-val-${metric.tier}` : ''">
              {{ metric.aggregatedDisplay ?? (metric.avg !== null && metric.avg !== undefined ? metric.avg.toFixed(1) : '-') }}
            </span>
            <span v-if="metric.definition.unit || metric.fieldType === 'timer'" class="stat-unit">{{ metric.definition.unit || 's' }}</span>
          </div>
          <div class="stat-col">
            <span class="stat-label">{{ t('custom_fields.max_metric') }}</span>
            <span class="stat-value">{{ metric.max !== null && metric.max !== undefined ? (metric.fieldType === 'timer' ? metric.max.toFixed(1) : metric.max) : '-' }}</span>
            <span v-if="metric.definition.unit || metric.fieldType === 'timer'" class="stat-unit">{{ metric.definition.unit || 's' }}</span>
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
          <div v-if="metric.aggregatedDisplay" class="weighted-select-summary">
            <span class="stat-label">{{ t('custom_fields.weighted_score_label') }}:</span>
            <span class="stat-value highlight" :class="metric.tier ? `tier-val-${metric.tier}` : ''">{{ metric.aggregatedDisplay }}</span>
          </div>
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
  border-color: var(--border);
  background: var(--card);
}

.metrics-count-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--g-750);
  color: var(--muted-foreground);
  border: 1px solid var(--border);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  flex-shrink: 0;
}

.custom-metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}

.metric-box {
  background: var(--surface-recessed);
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
  background: var(--g-750);
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
  background: var(--g-900);
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid var(--border-subtle);
}

.stat-col.full {
  flex: 1 1 100%;
}

.stat-label {
  font-size: 10px;
  color: var(--muted-foreground);
}

.stat-value {
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
  font-size: 15px;
  font-weight: 700;
  color: var(--foreground);
}

.stat-value.highlight {
  color: var(--primary);
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
  font-family: var(--font-numeric);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--primary);
}

.rate-progress-track {
  height: 6px;
  background: var(--g-750);
  border-radius: 3px;
  overflow: hidden;
}

.rate-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--status-info), var(--primary));
  border-radius: 3px;
  transition: width var(--motion-duration-normal) var(--motion-ease-out);
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

.dist-label-badge.color-blue { background: var(--status-info-bg); color: var(--status-info); border-color: var(--status-info-border); }
.dist-label-badge.color-green { background: var(--status-success-bg); color: var(--status-success); border-color: var(--status-success-border); }
.dist-label-badge.color-orange { background: var(--status-warning-bg); color: var(--status-warning); border-color: var(--status-warning-border); }
.dist-label-badge.color-red { background: var(--status-error-bg); color: var(--status-error); border-color: var(--status-error-border); }
.dist-label-badge.color-purple { background: var(--status-ai-bg); color: var(--status-ai); border-color: var(--status-ai-border); }
.dist-label-badge.color-gray { background: var(--g-850); color: var(--g-300); border-color: var(--g-700); }

.dist-count {
  color: var(--muted-foreground);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
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
  background: var(--surface-recessed);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 11px;
}

.metric-text-bubble .match-badge {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--primary);
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

.formula-error-box {
  border-color: var(--status-error-border);
  background: var(--status-error-bg);
}

.formula-error-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 700;
  color: var(--status-error);
}

.weighted-select-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--g-900);
  border: 1px solid var(--border-subtle);
  margin-bottom: 4px;
}

.tier-val-high {
  color: var(--status-success) !important;
}

.tier-val-mid {
  color: var(--status-warning) !important;
}

.tier-val-low {
  color: var(--status-error) !important;
}
</style>
