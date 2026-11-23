<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AiContextConfig, AiContextSections } from '@/types'
import { isZhLocale } from '@/components/ai/constants'
import { AI_PERSONAS } from '@/components/ai/personas'

defineProps<{
  activePersonaId: string
  contextConfig: AiContextConfig
  myTeamInput: string
  contextBadgeLabel: string
}>()

const emit = defineEmits<{
  'update:myTeamInput': [value: string]
  'change-persona': [personaId: string]
  'toggle-context': []
  'toggle-section': [section: keyof AiContextSections]
  'remove-focus-team': [teamNum: number]
  'clear-focus-match': []
}>()

const { t, locale } = useI18n()
const isZh = computed(() => isZhLocale(locale.value))
const showContextDetails = ref(false)

function onPersonaSelectChange(e: Event) {
  emit('change-persona', (e.target as HTMLSelectElement).value)
}

function onMyTeamFieldInput(e: Event) {
  emit('update:myTeamInput', (e.target as HTMLInputElement).value)
}
</script>

<template>
  <div class="context-ribbon">
    <div class="ribbon-top">
      <select
        class="persona-select"
        :value="activePersonaId"
        :title="t('ai.persona_select_title')"
        @change="onPersonaSelectChange"
      >
        <option v-for="p in AI_PERSONAS" :key="p.id" :value="p.id">
          {{ isZh ? p.nameZh : p.nameEn }}
        </option>
      </select>

      <button
        type="button"
        class="ctx-toggle-pill"
        :class="{ active: contextConfig.enabled }"
        :title="t('ai.include_data_label')"
        @click="emit('toggle-context')"
      >
        <span class="material-icons">analytics</span>
        <span>{{ contextConfig.enabled ? t('ai.ctx_on') : t('ai.ctx_off') }}</span>
      </button>

      <label class="my-team-box" :title="t('ai.my_team_hint')">
        <span>#</span>
        <input
          :value="myTeamInput"
          type="text"
          inputmode="numeric"
          :placeholder="t('ai.my_team_placeholder')"
          @input="onMyTeamFieldInput"
        />
      </label>

      <span class="token-meter" :title="t('ai.token_meter_hint')">{{ contextBadgeLabel }}</span>

      <button
        type="button"
        class="btn-ctx-expand"
        :title="t('ai.ctx_sections_toggle')"
        @click="showContextDetails = !showContextDetails"
      >
        <span class="material-icons">{{ showContextDetails ? 'expand_less' : 'tune' }}</span>
      </button>
    </div>

    <div v-if="contextConfig.focusTeams.length > 0 || contextConfig.focusMatch" class="focus-chips-bar">
      <span v-if="contextConfig.focusMatch" class="focus-chip">
        {{ (contextConfig.focusMatch.tournamentLevel || '').toUpperCase() === 'PLAYOFF' ? 'P' : 'Q'
        }}{{ contextConfig.focusMatch.matchNumber }}
        <button type="button" @click="emit('clear-focus-match')">×</button>
      </span>
      <span v-for="ft in contextConfig.focusTeams" :key="ft" class="focus-chip">
        #{{ ft }}
        <button type="button" @click="emit('remove-focus-team', ft)">×</button>
      </span>
    </div>

    <div v-if="showContextDetails" class="section-toggles-bar">
      <button
        v-for="sec in (['rankings', 'schedule', 'pit', 'matches', 'tags'] as const)"
        :key="sec"
        type="button"
        class="sec-pill"
        :class="{ active: contextConfig.sections[sec] }"
        @click="emit('toggle-section', sec)"
      >
        {{ t(`ai.ctx_sec_${sec}`) }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.context-ribbon {
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--surface);
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
}

.ribbon-top {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.persona-select {
  padding: 4px 8px;
  border-radius: 7px;
  background: var(--input);
  border: 1px solid var(--border);
  color: var(--foreground);
  font-size: 11.5px;
  font-weight: 600;
  max-width: 150px;
}

.ctx-toggle-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface-recessed);
  color: var(--muted-foreground);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

.ctx-toggle-pill.active {
  border-color: var(--status-info-border);
  background: var(--status-info-bg);
  color: var(--status-info);
}

.ctx-toggle-pill .material-icons {
  font-size: 13px;
}

.my-team-box {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 6px;
  border-radius: 7px;
  background: var(--input);
  border: 1px solid var(--border);
  font-size: 11px;
  color: var(--muted-foreground);
}

.my-team-box input {
  width: 54px;
  background: transparent;
  border: none;
  color: var(--foreground);
  font-family: var(--font-numeric);
  font-size: 11.5px;
  font-weight: 700;
  outline: none;
}

.token-meter {
  margin-left: auto;
  font-size: 10.5px;
  font-family: var(--font-numeric);
  color: var(--muted-foreground);
  white-space: nowrap;
}

.btn-ctx-expand {
  background: transparent;
  border: none;
  color: var(--muted-foreground);
  padding: 2px;
  cursor: pointer;
  display: inline-flex;
}

.btn-ctx-expand .material-icons {
  font-size: 16px;
}

.focus-chips-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
}

.focus-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--status-ai-bg);
  border: 1px solid var(--status-ai-border);
  color: var(--status-ai);
  font-size: 11px;
  font-weight: 700;
}

.focus-chip button {
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  padding: 0 2px;
  font-size: 12px;
  line-height: 1;
}

.section-toggles-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding-top: 2px;
}

.sec-pill {
  padding: 2px 8px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface-recessed);
  color: var(--muted-foreground);
  font-size: 11px;
  cursor: pointer;
}

.sec-pill.active {
  border-color: var(--primary);
  color: var(--primary);
  background: var(--status-success-bg);
}
</style>
