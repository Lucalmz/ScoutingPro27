<script setup lang="ts">
import { computed, ref, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConfirm } from '@/composables/useConfirm'
import type { AiThreadSummary } from '@/types'

const props = defineProps<{
  threads: AiThreadSummary[]
  activeThreadId: string
  streamingByThread: Record<string, any>
  docked?: boolean
}>()

const emit = defineEmits<{
  select: [threadId: string]
  create: []
  rename: [payload: { threadId: string; title: string }]
  togglePin: [threadId: string]
  delete: [threadId: string]
  exportActive: []
  close: []
}>()

const { t } = useI18n()
const { showConfirm } = useConfirm()

const searchQuery = ref('')
const renamingId = ref<string | null>(null)
const renameDraft = ref('')
const renameInputRef = ref<HTMLInputElement[] | null>(null)

const filteredThreads = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return props.threads
  return props.threads.filter(
    tr =>
      tr.title.toLowerCase().includes(q) ||
      (tr.lastMessagePreview || '').toLowerCase().includes(q)
  )
})

function startRename(tr: AiThreadSummary) {
  renamingId.value = tr.id
  renameDraft.value = tr.title
  nextTick(() => {
    renameInputRef.value?.[0]?.focus()
    renameInputRef.value?.[0]?.select()
  })
}

function commitRename(threadId: string) {
  if (renamingId.value !== threadId) return
  const clean = renameDraft.value.trim()
  renamingId.value = null
  if (clean) {
    emit('rename', { threadId, title: clean })
  }
}

async function confirmDelete(tr: AiThreadSummary) {
  const ok = await showConfirm({
    title: t('confirm_dialog.title'),
    message: t('ai.delete_thread_confirm', { title: tr.title }),
    type: 'danger',
    confirmText: t('confirm_dialog.danger_confirm'),
    cancelText: t('confirm_dialog.cancel')
  })
  if (ok) {
    emit('delete', tr.id)
  }
}
</script>

<template>
  <aside class="thread-sidebar" :class="{ docked }">
    <div class="sidebar-top">
      <button type="button" class="btn-new-thread" @click="emit('create')">
        <span class="material-icons">add_comment</span>
        <span>{{ t('ai.new_thread') }}</span>
      </button>
      <button v-if="!docked" type="button" class="btn-close-sidebar" @click="emit('close')" :aria-label="t('team_drawer.close')">
        <span class="material-icons">close</span>
      </button>
    </div>

    <div class="sidebar-search">
      <span class="material-icons search-icon">search</span>
      <input
        v-model="searchQuery"
        type="text"
        :placeholder="t('ai.search_threads')"
      />
    </div>

    <div class="threads-scroll">
      <div v-if="filteredThreads.length === 0" class="threads-empty">
        {{ t('ai.no_threads_match') }}
      </div>
      <div
        v-for="tr in filteredThreads"
        :key="tr.id"
        class="thread-row"
        :class="{ active: tr.id === activeThreadId }"
        @click="emit('select', tr.id)"
      >
        <div v-if="renamingId === tr.id" class="rename-row" @click.stop>
          <input
            ref="renameInputRef"
            v-model="renameDraft"
            type="text"
            @keydown.enter.prevent="commitRename(tr.id)"
            @keydown.esc="renamingId = null"
            @blur="commitRename(tr.id)"
          />
        </div>
        <template v-else>
          <div class="thread-row-main">
            <span v-if="tr.pinned" class="material-icons pin-indicator">push_pin</span>
            <span v-if="streamingByThread[tr.id]" class="streaming-dot"></span>
            <span class="thread-title">{{ tr.title }}</span>
            <span class="thread-count">{{ tr.messageCount }}</span>
          </div>
          <div v-if="tr.lastMessagePreview" class="thread-preview">
            {{ tr.lastMessagePreview }}
          </div>
          <div class="thread-hover-actions" @click.stop>
            <button type="button" class="btn-thr-act" @click="emit('togglePin', tr.id)" :title="tr.pinned ? t('ai.unpin_thread') : t('ai.pin_thread')">
              <span class="material-icons">{{ tr.pinned ? 'keep_off' : 'push_pin' }}</span>
            </button>
            <button type="button" class="btn-thr-act" @click="startRename(tr)" :title="t('ai.rename_thread')">
              <span class="material-icons">edit</span>
            </button>
            <button type="button" class="btn-thr-act danger" @click="confirmDelete(tr)" :title="t('ai.delete_thread')">
              <span class="material-icons">delete_outline</span>
            </button>
          </div>
        </template>
      </div>
    </div>

    <div class="sidebar-bottom">
      <button type="button" class="btn-export-md" @click="emit('exportActive')" :disabled="!activeThreadId">
        <span class="material-icons">download</span>
        <span>{{ t('ai.export_markdown') }}</span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.thread-sidebar {
  width: 248px;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--surface-recessed);
  border-right: 1px solid var(--border);
  flex-shrink: 0;
  min-height: 0;
}

.thread-sidebar:not(.docked) {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  z-index: 30;
  box-shadow: var(--shadow-2);
}

.thread-sidebar:not(.docked).ai-sidebar-slide-enter-active {
  transition:
    transform 260ms var(--motion-profile-ease-flight),
    opacity 200ms var(--motion-ease-out);
}

.thread-sidebar:not(.docked).ai-sidebar-slide-leave-active {
  transition:
    transform 200ms var(--motion-profile-ease-exit),
    opacity 160ms var(--motion-profile-ease-exit);
}

.thread-sidebar:not(.docked).ai-sidebar-slide-enter-from,
.thread-sidebar:not(.docked).ai-sidebar-slide-leave-to {
  transform: translate3d(-100%, 0, 0);
  opacity: 0;
}

.thread-sidebar.docked.ai-sidebar-slide-enter-active {
  overflow: hidden;
  transition:
    width 280ms var(--motion-profile-ease-flight),
    opacity 220ms var(--motion-ease-out);
}

.thread-sidebar.docked.ai-sidebar-slide-leave-active {
  overflow: hidden;
  transition:
    width 220ms var(--motion-profile-ease-exit),
    opacity 160ms var(--motion-profile-ease-exit);
}

.thread-sidebar.docked.ai-sidebar-slide-enter-from,
.thread-sidebar.docked.ai-sidebar-slide-leave-to {
  width: 0;
  opacity: 0;
  border-right-color: transparent;
}

.sidebar-top {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px;
  border-bottom: 1px solid var(--border-subtle);
}

.btn-new-thread {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 10px;
  border-radius: 8px;
  background: var(--status-ai-bg);
  color: var(--status-ai);
  border: 1px solid var(--status-ai-border);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}

.btn-new-thread .material-icons {
  font-size: 16px;
}

.btn-close-sidebar {
  background: transparent;
  border: none;
  color: var(--muted-foreground);
  padding: 4px;
  cursor: pointer;
  display: inline-flex;
}

.sidebar-search {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 10px 4px;
  padding: 5px 8px;
  border-radius: 7px;
  background: var(--input);
  border: 1px solid var(--border);
}

.search-icon {
  font-size: 15px;
  color: var(--muted-foreground);
}

.sidebar-search input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  color: var(--foreground);
  font-size: 12px;
  outline: none;
}

.threads-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.threads-empty {
  padding: 16px 8px;
  font-size: 12px;
  color: var(--muted-foreground);
  text-align: center;
}

.thread-row {
  position: relative;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid transparent;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.thread-row:hover {
  background: var(--surface);
  border-color: var(--border-subtle);
}

.thread-row.active {
  background: color-mix(in srgb, var(--status-ai-bg) 55%, var(--surface));
  border-color: var(--status-ai-border);
}

.thread-row-main {
  display: flex;
  align-items: center;
  gap: 5px;
}

.pin-indicator {
  font-size: 13px;
  color: var(--primary);
  flex-shrink: 0;
}

.streaming-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--status-ai);
  flex-shrink: 0;
}

.thread-title {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.thread-count {
  font-size: 10px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

.thread-preview {
  font-size: 11px;
  color: var(--muted-foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.thread-hover-actions {
  display: none;
  gap: 2px;
  position: absolute;
  right: 6px;
  top: 6px;
  background: var(--surface-elevated);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 1px;
}

.thread-row:hover .thread-hover-actions {
  display: inline-flex;
}

.btn-thr-act {
  background: transparent;
  border: none;
  color: var(--muted-foreground);
  padding: 2px 4px;
  cursor: pointer;
  display: inline-flex;
  border-radius: 4px;
}

.btn-thr-act:hover {
  color: var(--foreground);
  background: var(--surface-hover);
}

.btn-thr-act.danger:hover {
  color: var(--status-error);
}

.btn-thr-act .material-icons {
  font-size: 13px;
}

.rename-row input {
  width: 100%;
  box-sizing: border-box;
  padding: 4px 6px;
  border-radius: 5px;
  border: 1px solid var(--status-ai);
  background: var(--input);
  color: var(--foreground);
  font-size: 12px;
}

.sidebar-bottom {
  padding: 10px;
  border-top: 1px solid var(--border-subtle);
}

.btn-export-md {
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 10px;
  border-radius: 8px;
  background: var(--surface-elevated);
  border: 1px solid var(--border);
  color: var(--foreground);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.btn-export-md:hover:not(:disabled) {
  border-color: var(--primary);
  color: var(--primary);
}

.btn-export-md:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-export-md .material-icons {
  font-size: 15px;
}
</style>
