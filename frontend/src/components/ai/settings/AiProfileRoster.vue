<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { AiProtocol, AiProviderProfile } from '@/types'
import { PROTOCOL_META } from '@/components/ai/presets'

defineProps<{
  profiles: AiProviderProfile[]
  editingProfileId: string
  isCreatingNew: boolean
  activeProtocol: AiProtocol
}>()

const emit = defineEmits<{
  select: [profile: AiProviderProfile]
  create: [protocol: AiProtocol]
  delete: [profileId: string]
}>()

const { t } = useI18n()
</script>

<template>
  <aside class="profiles-sidebar">
    <div class="profiles-sidebar-header">
      <span>{{ t('ai.saved_profiles') }}</span>
      <button type="button" class="btn-new-profile" @click="emit('create', activeProtocol)">
        <span class="material-icons">add</span>
        <span>{{ t('ai.new_profile') }}</span>
      </button>
    </div>

    <div class="profiles-list">
      <div v-if="profiles.length === 0" class="profiles-empty">
        {{ t('ai.no_profiles_hint') }}
      </div>
      <div
        v-for="p in profiles"
        :key="p.id"
        class="profile-item"
        :class="{ active: !isCreatingNew && editingProfileId === p.id, current: p.isActive }"
        @click="emit('select', p)"
      >
        <div class="profile-item-top">
          <span class="proto-tag" :class="`proto-${p.protocol.toLowerCase()}`">{{ PROTOCOL_META[p.protocol].badge }}</span>
          <span class="profile-item-name">{{ p.name }}</span>
          <span v-if="p.isActive" class="active-dot" :title="t('ai.active_profile_badge')"></span>
        </div>
        <div class="profile-item-bottom">
          <span class="profile-item-model">{{ p.modelName || t('ai.model_unset') }}</span>
          <button
            type="button"
            class="btn-delete-profile"
            :title="t('ai.delete_profile')"
            @click.stop="emit('delete', p.id)"
          >
            <span class="material-icons">delete_outline</span>
          </button>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.profiles-sidebar {
  width: 230px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  background: var(--surface-recessed);
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.profiles-sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 12px 10px;
  border-bottom: 1px solid var(--border-subtle);
  font-size: 12px;
  font-weight: 700;
  color: var(--muted-foreground);
}

.btn-new-profile {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 4px 8px;
  font-size: 11px;
  font-weight: 600;
  background: var(--status-ai-bg);
  color: var(--status-ai);
  border: 1px solid var(--status-ai-border);
  border-radius: 6px;
  cursor: pointer;
}

.btn-new-profile .material-icons {
  font-size: 14px;
}

.profiles-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.profiles-empty {
  font-size: 12px;
  color: var(--muted-foreground);
  padding: 12px 8px;
  line-height: 1.5;
}

.profile-item {
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--border-subtle);
  background: var(--surface);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.profile-item:hover {
  border-color: var(--border-strong);
  background: var(--surface-hover);
}

.profile-item.active {
  border-color: var(--status-ai);
  background: color-mix(in srgb, var(--status-ai-bg) 70%, var(--surface));
}

.profile-item-top {
  display: flex;
  align-items: center;
  gap: 6px;
}

.profile-item-name {
  font-size: 12px;
  font-weight: 700;
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.active-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--primary);
  flex-shrink: 0;
}

.profile-item-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
}

.profile-item-model {
  font-size: 11px;
  color: var(--muted-foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.btn-delete-profile {
  background: transparent;
  border: none;
  color: var(--muted-foreground);
  padding: 2px;
  border-radius: 4px;
  cursor: pointer;
  display: inline-flex;
  opacity: 0.65;
}

.btn-delete-profile:hover {
  color: var(--status-error);
  opacity: 1;
}

.btn-delete-profile .material-icons {
  font-size: 14px;
}

.proto-tag {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 999px;
  flex-shrink: 0;
}

.proto-openai {
  background: rgba(57, 255, 20, 0.12);
  color: var(--s-300);
  border: 1px solid var(--s-700);
}

.proto-gemini {
  background: var(--status-info-bg);
  color: var(--status-info);
  border: 1px solid var(--status-info-border);
}

.proto-anthropic {
  background: var(--status-ai-bg);
  color: var(--status-ai);
  border: 1px solid var(--status-ai-border);
}

@media (max-width: 768px) {
  .profiles-sidebar {
    width: 100%;
    max-height: 140px;
    border-right: none;
    border-bottom: 1px solid var(--border);
  }

  .profiles-list {
    flex-direction: row;
    overflow-x: auto;
    overflow-y: hidden;
  }

  .profile-item {
    min-width: 160px;
  }
}
</style>
