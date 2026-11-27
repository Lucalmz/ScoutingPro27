<script setup lang="ts">
import { useI18n } from 'vue-i18n'

export interface TeamHoverPreview {
  teamNumber: number
  left: number
  top: number
  rankIdx?: number
  avgRating?: number
  predictCycle?: number | null
  bragLabel?: string
  tags: string[]
}

defineProps<{
  preview: TeamHoverPreview
}>()

const { t } = useI18n()
</script>

<template>
  <div
    class="team-hover-card"
    :style="{ left: `${preview.left}px`, top: `${preview.top}px` }"
  >
    <div class="thc-head">
      <span>#{{ preview.teamNumber }}</span>
      <span v-if="preview.rankIdx">{{ t('ai.hover_seed', { rank: preview.rankIdx }) }}</span>
    </div>
    <div class="thc-stats">
      <span>{{ t('team_drawer.avg_score') }}: {{ preview.avgRating ?? '-' }}</span>
      <span>{{ t('ai.hover_cycle') }}{{ preview.predictCycle != null ? `${preview.predictCycle.toFixed(1)}s` : '-' }}</span>
      <span style="grid-column: 1 / -1;">{{ t('ai.hover_brag') }}{{ preview.bragLabel ?? 'N/A' }}</span>
    </div>
    <div v-if="preview.tags.length > 0" class="thc-tags">
      <span v-for="tg in preview.tags" :key="tg" class="thc-tag">{{ tg }}</span>
    </div>
    <div class="thc-hint">{{ t('ai.hover_click_detail') }}</div>
  </div>
</template>

<style scoped>
.team-hover-card {
  position: fixed;
  z-index: 1200;
  width: 240px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--popover);
  border: 1px solid var(--status-ai-border);
  box-shadow: var(--shadow-3);
  pointer-events: none;
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
}

.thc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 700;
  color: var(--status-ai);
  font-family: var(--font-numeric);
}

.thc-stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 8px;
  font-size: 11px;
  color: var(--g-200);
}

.thc-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.thc-tag {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--surface-recessed);
  border: 1px solid var(--border-subtle);
  color: var(--muted-foreground);
}

.thc-hint {
  font-size: 10.5px;
  color: var(--status-ai);
  opacity: 0.9;
  padding-top: 2px;
  border-top: 1px solid var(--border-subtle);
}
</style>
