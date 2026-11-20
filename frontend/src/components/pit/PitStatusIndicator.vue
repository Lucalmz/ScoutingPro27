<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePitScoutStore } from '@/stores/pitScout'

const props = withDefaults(
  defineProps<{
    teamNumber: number
    size?: 'sm' | 'md'
    showLabel?: boolean
    showBrag?: boolean
    clickable?: boolean
  }>(),
  {
    size: 'sm',
    showLabel: false,
    showBrag: true,
    clickable: true
  }
)

const emit = defineEmits<{
  (e: 'click', teamNumber: number): void
}>()

let t = (k: string, _values?: any) => {
  if (k === 'pit_scout.status_recorded') return '已录入'
  if (k === 'pit_scout.status_unrecorded') return '未录入'
  return k
}
let te = (_k: string) => false
try {
  const i18n = useI18n()
  if (i18n && i18n.t) {
    t = i18n.t
    if (i18n.te) te = i18n.te
  }
} catch {}

const pitStore = usePitScoutStore()
const team = computed(() => pitStore.getUnifiedTeam(props.teamNumber))

const hasRecord = computed(() => Boolean(team.value?.hasPitRecord))
const bragInfo = computed(() => team.value?.bragInfo)

const titleText = computed(() => {
  if (!hasRecord.value) return t('pit_scout.status_tooltip_unrecorded')
  let str = t('pit_scout.status_tooltip_recorded')
  if (bragInfo.value && team.value?.matchCount) {
    if (bragInfo.value.tier === 'pending') {
      const pendingText =
        bragInfo.value.labelKey && te(bragInfo.value.labelKey)
          ? t(bragInfo.value.labelKey)
          : te('pit_scout.brag_tiers.pending')
            ? t('pit_scout.brag_tiers.pending')
            : bragInfo.value.label
      str += ` · ${pendingText}`
    } else {
      const tierKey = `pit_scout.brag_tiers.${bragInfo.value.tier}`
      const tierText = te(tierKey) ? t(tierKey) : bragInfo.value.tier
      const summary = te('pit_scout.brag_label_format')
        ? t('pit_scout.brag_label_format', { ratio: bragInfo.value.overallRatio, tier: tierText })
        : `${bragInfo.value.overallRatio}x ${tierText}`
      str += ` · ${summary}`
    }
    if (bragInfo.value.statusKeys && bragInfo.value.statusKeys.length > 0) {
      const statusTexts = bragInfo.value.statusKeys.map((k) => (te(k) ? t(k) : k))
      str += ` (${statusTexts.join(', ')})`
    }
  }
  return str
})

function handleClick(e: MouseEvent) {
  if (props.clickable) {
    e.stopPropagation()
    emit('click', props.teamNumber)
  }
}
</script>

<template>
  <div
    class="pit-status-indicator"
    :class="[
      `size-${size}`,
      hasRecord ? 'status-recorded' : 'status-unrecorded',
      clickable ? 'is-clickable' : ''
    ]"
    :title="titleText"
    @click="handleClick"
  >
    <span class="status-dot" />
    <span v-if="showLabel" class="status-text">
      {{ hasRecord ? t('pit_scout.status_recorded') : t('pit_scout.status_unrecorded') }}
    </span>
    <span
      v-if="hasRecord && showBrag && bragInfo && team?.matchCount && team.matchCount > 0"
      class="brag-badge"
      :class="`tier-${bragInfo.tier}`"
    >
      {{
        bragInfo.tier === 'pending'
          ? (bragInfo.labelKey && te(bragInfo.labelKey) ? t(bragInfo.labelKey) : bragInfo.label)
          : `${bragInfo.overallRatio}x`
      }}
    </span>
  </div>
</template>

<style scoped>
.pit-status-indicator {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-radius: 9999px;
  user-select: none;
  font-family: inherit;
  font-size: 11px;
  line-height: 1;
  transition: opacity var(--motion-duration-fast) var(--motion-ease-out),
              transform var(--motion-duration-fast) var(--motion-ease-out);
}

.pit-status-indicator.is-clickable {
  cursor: pointer;
}

.pit-status-indicator.is-clickable:hover {
  opacity: 0.85;
  transform: translateY(-1px);
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.size-md .status-dot {
  width: 8px;
  height: 8px;
}

/* 已录入状态 - 荧光绿 */
.status-recorded {
  color: var(--primary);
}

.status-recorded .status-dot {
  background-color: var(--primary);
  box-shadow: var(--glow-online);
}

/* 未录入状态 - 客观中性灰 */
.status-unrecorded {
  color: var(--muted-foreground);
}

.status-unrecorded .status-dot {
  background-color: var(--border-strong);
}

.status-text {
  font-weight: 500;
}

/* 吹牛指数微徽章 */
.brag-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
  border-radius: 9999px;
  font-size: 10px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.tier-realistic {
  background: var(--status-success-bg);
  color: var(--status-success);
  border: 1px solid var(--status-success-border);
}

.tier-optimistic {
  background: var(--status-warning-bg);
  color: var(--status-warning);
  border: 1px solid var(--status-warning-border);
}

.tier-overclaimed {
  background: color-mix(in srgb, var(--status-warning-bg) 50%, var(--status-error-bg));
  color: color-mix(in srgb, var(--status-warning) 55%, var(--status-error));
  border: 1px solid color-mix(in srgb, var(--status-warning-border) 50%, var(--status-error-border));
}

.tier-mythical {
  background: var(--status-error-bg);
  color: var(--status-error);
  border: 1px solid var(--status-error-border);
}

.tier-pending {
  background: var(--surface-elevated);
  color: var(--muted-foreground);
  border: 1px solid var(--border);
}
</style>

