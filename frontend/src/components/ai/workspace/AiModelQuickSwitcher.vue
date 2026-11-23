<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AiProviderProfile } from '@/types'
import { PROTOCOL_META } from '@/components/ai/presets'

defineProps<{
  profiles: AiProviderProfile[]
  activeProfile: AiProviderProfile | null
}>()

const emit = defineEmits<{
  'activate-profile': [profileId: string]
  'switch-model': [profileId: string, model: string]
  'open-settings': []
}>()

const { t } = useI18n()
const open = ref(false)

function onDocClickClose(e: MouseEvent) {
  const target = e.target as HTMLElement | null
  if (!target?.closest('.model-switcher-anchor')) {
    open.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', onDocClickClose)
})

onUnmounted(() => {
  document.removeEventListener('click', onDocClickClose)
})
</script>

<template>
  <div class="model-switcher-anchor">
    <button
      type="button"
      class="model-switcher-pill"
      :title="t('ai.quick_switch_model')"
      @click.stop="open = !open"
    >
      <span class="pill-proto-badge">
        {{ activeProfile ? PROTOCOL_META[activeProfile.protocol].badge : 'AI' }}
      </span>
      <span class="pill-model-text">
        {{ activeProfile ? (activeProfile.modelName || activeProfile.name) : t('ai.setup_model') }}
      </span>
      <span class="material-icons" style="font-size: 15px;">expand_more</span>
    </button>

    <div v-if="open" class="model-quick-popover">
      <div class="quick-sec-title">{{ t('ai.saved_profiles') }}</div>
      <div v-if="profiles.length > 0" class="quick-profile-list">
        <button
          v-for="p in profiles"
          :key="p.id"
          type="button"
          class="quick-profile-btn"
          :class="{ active: p.id === activeProfile?.id }"
          @click="emit('activate-profile', p.id)"
        >
          <span class="pill-proto-badge">{{ PROTOCOL_META[p.protocol].badge }}</span>
          <span class="qp-name">{{ p.name }}</span>
          <span class="qp-model">{{ p.modelName }}</span>
        </button>
      </div>

      <template v-if="activeProfile && activeProfile.customModels.length > 0">
        <div class="quick-sec-title">{{ t('ai.quick_models_in_profile') }}</div>
        <div class="quick-models-grid">
          <button
            v-for="cm in activeProfile.customModels"
            :key="cm"
            type="button"
            class="quick-model-chip"
            :class="{ active: activeProfile.modelName === cm }"
            @click="emit('switch-model', activeProfile.id, cm); open = false"
          >
            {{ cm }}
          </button>
        </div>
      </template>

      <button
        type="button"
        class="quick-manage-btn"
        @click="open = false; emit('open-settings')"
      >
        <span class="material-icons" style="font-size: 15px;">tune</span>
        <span>{{ t('ai.manage_profiles') }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.model-switcher-anchor {
  position: relative;
  min-width: 0;
}

.model-switcher-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 4px 8px;
  border-radius: 8px;
  background: var(--surface-recessed);
  border: 1px solid var(--border);
  color: var(--foreground);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.model-switcher-pill:hover {
  border-color: var(--status-ai);
}

.pill-proto-badge {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--status-ai-bg);
  color: var(--status-ai);
  border: 1px solid var(--status-ai-border);
  flex-shrink: 0;
}

.pill-model-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--font-mono);
  font-size: 11.5px;
}

.model-quick-popover {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  width: min(310px, 82vw);
  max-height: 360px;
  overflow-y: auto;
  background: var(--popover);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  box-shadow: var(--shadow-3);
  padding: 8px;
  z-index: 60;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.quick-sec-title {
  font-size: 10.5px;
  font-weight: 700;
  color: var(--muted-foreground);
  text-transform: uppercase;
  padding: 2px 4px;
}

.quick-profile-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.quick-profile-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 7px;
  border: 1px solid transparent;
  background: var(--surface-recessed);
  color: var(--foreground);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.quick-profile-btn:hover {
  border-color: var(--border-strong);
}

.quick-profile-btn.active {
  border-color: var(--status-ai);
  background: var(--status-ai-bg);
}

.qp-name {
  font-weight: 700;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.qp-model {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted-foreground);
}

.quick-models-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.quick-model-chip {
  padding: 4px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface-recessed);
  color: var(--foreground);
  font-size: 11px;
  cursor: pointer;
}

.quick-model-chip.active {
  border-color: var(--primary);
  background: var(--status-success-bg);
  color: var(--primary);
  font-weight: 700;
}

.quick-manage-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px 10px;
  border-radius: 7px;
  background: var(--surface-elevated);
  border: 1px solid var(--border);
  color: var(--foreground);
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
}
</style>
