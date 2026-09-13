<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRecordStore } from '@/stores/records'
import { useToastStore } from '@/stores/toast'
import { hapticLight, hapticWarning } from '@/utils/haptics'
import type { TeamTagItem } from '@/types'

const props = defineProps<{
  eventId: string
  teamNumber: number
  readonly?: boolean
}>()

const emit = defineEmits<{
  (e: 'tagAdded', tag: TeamTagItem): void
  (e: 'tagRemoved', tag: string): void
}>()

const { t, te } = useI18n()
const recordStore = useRecordStore()
const toastStore = useToastStore()

const COLOR_OPTIONS = [
  'green',
  'blue',
  'purple',
  'orange',
  'red',
  'yellow',
  'gray'
] as const

// 常用预设（BIOBUZZ 违规风控预设）
const PRESET_TAGS = [
  { tag: '#易超持', i18nKey: 'tags.preset.over_possession', color: 'orange' },
  { tag: '#控制对方大球', i18nKey: 'tags.preset.control_opponent_nectar', color: 'red' },
  { tag: '#提前塞大球进花', i18nKey: 'tags.preset.early_flower', color: 'red' },
  { tag: '#暴力冲撞别车', i18nKey: 'tags.preset.aggressive_defense', color: 'red' },
  { tag: '#人玩易违规', i18nKey: 'tags.preset.human_player_foul', color: 'orange' }
] as const

function getPresetLabel(preset: typeof PRESET_TAGS[number]): string {
  if (preset.i18nKey && te(preset.i18nKey)) {
    const val = t(preset.i18nKey)
    if (val && val !== preset.i18nKey) return val
  }
  return preset.tag
}

function isPresetActive(preset: typeof PRESET_TAGS[number]): boolean {
  const label = getPresetLabel(preset)
  return activeTagKeys.value.has(preset.tag) ||
         activeTagKeys.value.has(label) ||
         (preset.i18nKey ? activeTagKeys.value.has(preset.i18nKey) : false)
}

const isAdding = ref(false)
const inputTag = ref('')
const selectedColor = ref<typeof COLOR_OPTIONS[number]>('green')
const isSubmitting = ref(false)

// 当前队伍已有的标签
const currentTags = computed<TeamTagItem[]>(() => {
  return recordStore.getTagsForTeam(props.teamNumber)
})

// 已选标签名集合（用于防重）
const activeTagKeys = computed<Set<string>>(() => {
  return new Set(currentTags.value.map(t => t.tag))
})

// 历史/已有事件标签建议（自动补全，V14）
const tagSuggestions = computed<string[]>(() => {
  const allEventTags = recordStore.teamTags
    .map(t => t.tag)
    .filter(t => !t.startsWith('preset.'))
  const unique = Array.from(new Set(allEventTags))
  if (!inputTag.value.trim()) return unique.slice(0, 6)
  const q = inputTag.value.trim().toLowerCase()
  return unique.filter(t => t.toLowerCase().includes(q) && !activeTagKeys.value.has(t)).slice(0, 6)
})

function formatTagLabel(tag?: TeamTagItem | null): string {
  if (!tag || !tag.tag) return ''
  if (tag.isPreset || tag.tag.startsWith('preset.')) {
    const i18nKey = tag.tag.startsWith('preset.') ? `tags.${tag.tag}` : `tags.preset.${tag.tag}`
    if (te(i18nKey)) {
      const val = t(i18nKey)
      if (val !== i18nKey) return val
    }
  }
  const legacyMap: Record<string, string> = {
    '#易超持': 'tags.preset.over_possession',
    '#控制对方大球': 'tags.preset.control_opponent_nectar',
    '#提前塞大球进花': 'tags.preset.early_flower',
    '#暴力冲撞别车': 'tags.preset.aggressive_defense',
    '#人玩易违规': 'tags.preset.human_player_foul',
    '#OverPossession': 'tags.preset.over_possession',
    '#ControlOpponentNectar': 'tags.preset.control_opponent_nectar',
    '#EarlyFlower': 'tags.preset.early_flower',
    '#AggressiveDefense': 'tags.preset.aggressive_defense',
    '#HumanPlayerFoul': 'tags.preset.human_player_foul'
  }
  const mappedKey = legacyMap[tag.tag]
  if (mappedKey && te(mappedKey)) {
    const val = t(mappedKey)
    if (val !== mappedKey) return val
  }
  return tag.tag
}

async function handleAddCustomTag() {
  if (props.readonly || isSubmitting.value) return

  let raw = inputTag.value.trim()
  if (!raw) return

  // 长度校验（V15）
  if (raw.length > 30) {
    toastStore.showToast(t('tags.too_long'), 'error')
    return
  }

  // 归一化（V26）
  if (/^[A-Za-z0-9 _#-]+$/.test(raw)) {
    raw = raw.toLowerCase()
  }

  // 禁止输入预设标签前缀（V27）
  if (raw.includes('.')) {
    toastStore.showToast(t('tags.no_dot_allowed'), 'error')
    return
  }

  // 字符白名单（V15）
  if (!/^[\p{L}\p{N} _#-]+$/u.test(raw)) {
    toastStore.showToast(t('tags.invalid_chars'), 'error')
    return
  }

  // 重复校验
  if (activeTagKeys.value.has(raw)) {
    toastStore.showToast(t('tags.duplicate_tag'), 'error')
    return
  }

  // 上限检查（V14）
  if (currentTags.value.length >= 15) {
    toastStore.showToast(t('tags.max_limit_reached'), 'error')
    return
  }

  isSubmitting.value = true
  try {
    const res = await recordStore.addTag(props.eventId, props.teamNumber, raw, selectedColor.value, false)
    if (res.success && res.tag) {
      hapticLight()
      emit('tagAdded', res.tag)
      inputTag.value = ''
      isAdding.value = false
    } else {
      hapticWarning()
      toastStore.showToast(res.error || t('tags.add_failed'), 'error')
    }
  } finally {
    isSubmitting.value = false
  }
}

async function handleRemoveTag(tagKey: string) {
  if (props.readonly || isSubmitting.value) return
  isSubmitting.value = true
  try {
    const res = await recordStore.removeTag(props.eventId, props.teamNumber, tagKey)
    if (res.success) {
      hapticLight()
      emit('tagRemoved', tagKey)
    } else {
      hapticWarning()
      toastStore.showToast(res.error || t('tags.remove_failed'), 'error')
    }
  } finally {
    isSubmitting.value = false
  }
}

function selectSuggestion(suggestion: string) {
  inputTag.value = suggestion
}

async function handleAddPresetTag(preset: typeof PRESET_TAGS[number]) {
  if (props.readonly || isSubmitting.value) return
  if (isPresetActive(preset)) return

  // 上限检查（V14）
  if (currentTags.value.length >= 15) {
    toastStore.showToast(t('tags.max_limit_reached'), 'error')
    return
  }

  isSubmitting.value = true
  try {
    const res = await recordStore.addTag(props.eventId, props.teamNumber, preset.tag, preset.color, false)
    if (res.success && res.tag) {
      hapticLight()
      emit('tagAdded', res.tag)
    } else {
      hapticWarning()
      toastStore.showToast(res.error || t('tags.add_failed'), 'error')
    }
  } finally {
    isSubmitting.value = false
  }
}
</script>

<template>
  <div class="tag-picker-container">
    <!-- 当前已附带标签列表 -->
    <TransitionGroup name="tag-badge" tag="div" class="tags-list">
      <span
        v-for="tag in currentTags"
        :key="tag.id || tag.tag"
        class="tag-badge"
        :class="[`tag-${tag.color || 'blue'}`, { 'is-preset': tag.isPreset }]"
      >
        <span class="tag-text">{{ formatTagLabel(tag) }}</span>
        <button
          v-if="!readonly"
          class="btn-tag-remove"
          :disabled="isSubmitting"
          @click.stop="handleRemoveTag(tag.tag)"
          :title="t('tags.remove')"
          aria-label="Remove tag"
        >
          ×
        </button>
      </span>

      <!-- 添加标签按钮 / 展开面板 -->
      <button
        key="btn-add"
        v-if="!readonly && !isAdding"
        class="btn-add-tag"
        :disabled="isSubmitting || currentTags.length >= 15"
        @click="isAdding = true"
      >
        <span class="material-icons" style="font-size: 14px">add</span>
        {{ t('tags.add_tag') }}
      </button>
    </TransitionGroup>

    <!-- 添加标签交互面板 -->
    <Transition name="tab-fade">
      <div v-if="!readonly && isAdding" class="tag-edit-panel">
        <!-- 常用预设（BIOBUZZ 赛季违规与风控预设） -->
        <div class="presets-section">
          <span class="edit-label">{{ t('tags.presets') }}:</span>
          <div class="preset-chips-row">
            <button
              v-for="preset in PRESET_TAGS"
              :key="preset.tag"
              type="button"
              class="preset-chip"
              :class="[`tag-${preset.color}`, { 'is-active': isPresetActive(preset) }]"
              :disabled="isPresetActive(preset) || isSubmitting"
              @click="handleAddPresetTag(preset)"
            >
              {{ getPresetLabel(preset) }}
            </button>
          </div>
        </div>

        <div class="custom-input-section">
          <span class="edit-label">{{ t('tags.custom_tag') }}:</span>
          <div class="input-row">
            <input
              v-model="inputTag"
              type="text"
              class="tag-input"
              maxlength="30"
              :placeholder="t('tags.input_placeholder')"
              @keydown.enter.prevent="handleAddCustomTag"
            />

            <!-- 颜色选择器 -->
            <div class="color-picker">
              <button
                v-for="col in COLOR_OPTIONS"
                :key="col"
                type="button"
                class="color-dot"
                :class="[`bg-${col}`, { selected: selectedColor === col }]"
                @click="selectedColor = col"
                :title="col"
              />
            </div>

            <button
              type="button"
              class="btn-confirm-add"
              :disabled="!inputTag.trim() || isSubmitting"
              @click="handleAddCustomTag"
            >
              {{ t('tags.confirm') }}
            </button>
            <button
              type="button"
              class="btn-cancel-add"
              @click="isAdding = false"
            >
              {{ t('tags.cancel') }}
            </button>
          </div>

          <!-- 历史补全建议（V14）-->
          <div v-if="tagSuggestions.length > 0" class="suggestions-row">
            <span class="sugg-label">{{ t('tags.suggestions') }}:</span>
            <button
              v-for="sugg in tagSuggestions"
              :key="sugg"
              type="button"
              class="sugg-chip"
              @click="selectSuggestion(sugg)"
            >
              {{ sugg }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.tag-picker-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tags-list {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

/* 标签 Badge 基础 */
.tag-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 0.78rem;
  font-weight: 600;
  border: 1px solid transparent;
  transition: all 0.15s ease;
}

.btn-tag-remove {
  background: none;
  border: none;
  color: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  padding: 0 0 0 2px;
  opacity: 0.65;
  transition: opacity 0.15s;
}

.btn-tag-remove:hover {
  opacity: 1;
}

/* 色系（统一暗色赛博霓虹规范） */
.tag-green  { background: rgba(57, 255, 20, 0.12); color: #39ff14; border-color: rgba(57, 255, 20, 0.35); }
.tag-blue   { background: rgba(56, 189, 248, 0.12); color: #38bdf8; border-color: rgba(56, 189, 248, 0.35); }
.tag-purple { background: rgba(192, 132, 252, 0.12); color: #c084fc; border-color: rgba(192, 132, 252, 0.35); }
.tag-orange { background: rgba(251, 146, 60, 0.12); color: #fb923c; border-color: rgba(251, 146, 60, 0.35); }
.tag-red    { background: rgba(248, 113, 113, 0.12); color: #f87171; border-color: rgba(248, 113, 113, 0.35); }
.tag-yellow { background: rgba(250, 204, 21, 0.12); color: #facc15; border-color: rgba(250, 204, 21, 0.35); }
.tag-gray   { background: rgba(156, 163, 175, 0.12); color: #9ca3af; border-color: rgba(156, 163, 175, 0.35); }

/* 添加标签按钮 */
.btn-add-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px dashed var(--border);
  color: var(--muted-foreground);
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 0.75rem;
  cursor: pointer;
  transition: all 0.15s;
}

.btn-add-tag:hover:not(:disabled) {
  border-color: var(--primary);
  color: var(--primary);
  background: rgba(57, 255, 20, 0.06);
}

.btn-add-tag:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 编辑展开面板 */
.tag-edit-panel {
  background: var(--popover);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

.edit-label {
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--muted-foreground);
  letter-spacing: 0.04em;
}

.presets-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.preset-chips-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.preset-chip {
  display: inline-flex;
  align-items: center;
  padding: 3px 9px;
  border-radius: 12px;
  font-size: 0.76rem;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.15s ease;
}

.preset-chip:hover:not(:disabled) {
  transform: translateY(-1px);
  filter: brightness(1.2);
}

.preset-chip:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.preset-chip.is-active {
  opacity: 0.4;
  cursor: default;
  text-decoration: line-through;
}

.custom-input-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.input-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.tag-input {
  flex: 1;
  min-width: 130px;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--input);
  color: var(--foreground);
  font-size: 0.82rem;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.tag-input:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 1px var(--primary);
}

.color-picker {
  display: flex;
  align-items: center;
  gap: 5px;
}

.color-dot {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  padding: 0;
  transition: transform 0.15s, border-color 0.15s, box-shadow 0.15s;
}

.color-dot.selected {
  transform: scale(1.25);
  border-color: #ffffff;
  box-shadow: 0 0 6px rgba(255, 255, 255, 0.5);
}

.bg-green  { background: #39ff14; }
.bg-blue   { background: #38bdf8; }
.bg-purple { background: #c084fc; }
.bg-orange { background: #fb923c; }
.bg-red    { background: #f87171; }
.bg-yellow { background: #facc15; }
.bg-gray   { background: #9ca3af; }

.btn-confirm-add {
  padding: 5px 12px;
  border-radius: 6px;
  background: var(--primary);
  color: var(--primary-foreground);
  border: none;
  font-size: 0.78rem;
  font-weight: 700;
  cursor: pointer;
  box-shadow: var(--glow-primary);
  transition: all 0.15s;
}

.btn-confirm-add:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  box-shadow: none;
}

.btn-confirm-add:hover:not(:disabled) {
  box-shadow: var(--glow-primary-hover);
  transform: translateY(-1px);
}

.btn-cancel-add {
  padding: 5px 10px;
  border-radius: 6px;
  background: transparent;
  color: var(--muted-foreground);
  border: 1px solid var(--border);
  font-size: 0.78rem;
  cursor: pointer;
  transition: all 0.15s;
}

.btn-cancel-add:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--foreground);
}

.suggestions-row {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
  font-size: 0.72rem;
  margin-top: 4px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.sugg-label {
  color: var(--muted-foreground);
}

.sugg-chip {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border);
  color: var(--foreground);
  border-radius: 6px;
  padding: 2px 7px;
  font-size: 0.72rem;
  cursor: pointer;
  transition: all 0.15s;
}

.sugg-chip:hover {
  color: var(--primary);
  border-color: var(--primary);
  background: rgba(57, 255, 20, 0.08);
}
</style>
