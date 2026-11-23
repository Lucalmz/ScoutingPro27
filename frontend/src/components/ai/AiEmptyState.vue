<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { MatchScheduleItem, RankingRow } from '@/types'
import { buildStarterCards, type StarterCardItem } from '@/components/ai/personas'

const props = defineProps<{
  isConfigured: boolean
  rankings: RankingRow[]
  schedules: MatchScheduleItem[]
  myTeamNumber?: number | null
}>()

const emit = defineEmits<{
  openSettings: []
  pickStarter: [card: StarterCardItem]
}>()

const { t, locale } = useI18n()
const isZh = computed(() => (locale.value || 'zh').toLowerCase().startsWith('zh'))

const starterCards = computed(() =>
  buildStarterCards({
    rankings: props.rankings,
    schedule: props.schedules,
    myTeamNumber: props.myTeamNumber
  })
)
</script>

<template>
  <div class="ai-empty-state">
    <!-- Unconfigured Onboarding -->
    <div v-if="!isConfigured" class="onboarding-card">
      <div class="empty-hero-badge">
        <span class="material-icons">auto_awesome</span>
        <span>{{ t('ai.hero_badge_copilot') }}</span>
      </div>
      <h3>{{ t('ai.onboarding_title') }}</h3>
      <p class="empty-desc">{{ t('ai.onboarding_desc') }}</p>
      <ol class="onboarding-steps">
        <li>{{ t('ai.onboarding_step1') }}</li>
        <li>{{ t('ai.onboarding_step2') }}</li>
        <li>{{ t('ai.onboarding_step3') }}</li>
      </ol>
      <button type="button" class="btn-setup-now" @click="emit('openSettings')">
        <span class="material-icons">settings</span>
        <span>{{ t('ai.onboarding_cta') }}</span>
      </button>
    </div>

    <!-- Configured Tactical Launchpad -->
    <div v-else class="launchpad-wrap">
      <div class="launchpad-header">
        <div class="empty-hero-badge">
          <span class="material-icons">auto_awesome</span>
          <span>{{ t('ai.hero_badge_biobuzz') }}</span>
        </div>
        <h3>{{ t('ai.launchpad_title') }}</h3>
        <p class="empty-desc">{{ t('ai.launchpad_desc') }}</p>
      </div>

      <div class="starter-grid">
        <button
          v-for="card in starterCards"
          :key="card.id"
          type="button"
          class="starter-card"
          @click="emit('pickStarter', card)"
        >
          <span class="material-icons starter-icon">{{ card.icon }}</span>
          <div class="starter-body">
            <div class="starter-title">{{ isZh ? card.titleZh : card.titleEn }}</div>
            <div class="starter-sub">{{ isZh ? card.descZh : card.descEn }}</div>
          </div>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-empty-state {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 100%;
  padding: 12px 4px;
}

.onboarding-card,
.launchpad-wrap {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.onboarding-card {
  background: color-mix(in srgb, var(--status-ai-bg) 45%, var(--surface));
  border: 1px solid var(--status-ai-border);
  border-radius: 14px;
  padding: 18px;
}

.empty-hero-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--status-ai-bg);
  color: var(--status-ai);
  border: 1px solid var(--status-ai-border);
  font-size: 11px;
  font-weight: 700;
}

.empty-hero-badge .material-icons {
  font-size: 14px;
}

h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--g-50);
}

.empty-desc {
  margin: 0;
  font-size: 12.5px;
  color: var(--muted-foreground);
  line-height: 1.5;
}

.onboarding-steps {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12.5px;
  color: var(--g-200);
}

.btn-setup-now {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 16px;
  border-radius: 8px;
  background: var(--primary);
  color: var(--primary-foreground);
  border: none;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}

.starter-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}

@container ai-dock (min-width: 520px) {
  .starter-grid {
    grid-template-columns: 1fr 1fr;
  }
}

.starter-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  text-align: left;
  padding: 11px 12px;
  border-radius: 10px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--foreground);
  cursor: pointer;
  transition: border-color 0.15s ease, background-color 0.15s ease, transform 0.15s ease;
}

.starter-card:hover {
  border-color: var(--status-ai);
  background: color-mix(in srgb, var(--status-ai-bg) 55%, var(--surface));
  transform: translateY(-1px);
}

.starter-icon {
  font-size: 18px;
  color: var(--status-ai);
  margin-top: 1px;
  flex-shrink: 0;
}

.starter-body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.starter-title {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--g-50);
}

.starter-sub {
  font-size: 11.5px;
  color: var(--muted-foreground);
  line-height: 1.4;
}
</style>
