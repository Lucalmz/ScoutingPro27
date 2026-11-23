<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAiStore } from '@/stores/ai'
import { AI_LAYOUT, DEFAULT_DOCK_WIDTH } from '@/components/ai/constants'
import AiCopilotWorkspace from './AiCopilotWorkspace.vue'

const props = defineProps<{
  eventId: string
}>()

const { t } = useI18n()
const aiStore = useAiStore()
const isDragging = ref(false)
const viewportWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1440)

const isWideDesktop = computed(() => viewportWidth.value >= AI_LAYOUT.WIDE_DESKTOP_BREAKPOINT)

const showBackdrop = computed(
  () => aiStore.isDockOpen && (!isWideDesktop.value || aiStore.isDockExpanded)
)

const dockStyle = computed(() => {
  if (aiStore.isDockExpanded || !isWideDesktop.value) {
    return {}
  }
  return {
    '--ai-dock-width': `${aiStore.dockWidth}px`
  }
})

function syncRootRightOffset() {
  if (typeof document === 'undefined') return
  const shouldOffset = aiStore.isDockOpen && isWideDesktop.value && !aiStore.isDockExpanded
  const offset = shouldOffset ? `${aiStore.dockWidth}px` : '0px'
  document.documentElement.style.setProperty('--ai-dock-right-offset', offset)
}

watch(
  [() => aiStore.isDockOpen, () => aiStore.dockWidth, () => aiStore.isDockExpanded, isWideDesktop],
  () => {
    syncRootRightOffset()
  },
  { immediate: true }
)

function onWindowResize() {
  viewportWidth.value = window.innerWidth
}

let dragStartX = 0
let dragStartWidth = DEFAULT_DOCK_WIDTH

function onSplitterPointerDown(e: PointerEvent) {
  if (!isWideDesktop.value || aiStore.isDockExpanded) return
  e.preventDefault()
  isDragging.value = true
  dragStartX = e.clientX
  dragStartWidth = aiStore.dockWidth
  window.addEventListener('pointermove', onWindowPointerMove)
  window.addEventListener('pointerup', onWindowPointerUp)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

function onWindowPointerMove(e: PointerEvent) {
  if (!isDragging.value) return
  const delta = dragStartX - e.clientX
  aiStore.setDockWidth(dragStartWidth + delta)
}

function onWindowPointerUp() {
  isDragging.value = false
  window.removeEventListener('pointermove', onWindowPointerMove)
  window.removeEventListener('pointerup', onWindowPointerUp)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}

onMounted(() => {
  window.addEventListener('resize', onWindowResize)
  syncRootRightOffset()
})

onUnmounted(() => {
  window.removeEventListener('resize', onWindowResize)
  onWindowPointerUp()
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--ai-dock-right-offset', '0px')
  }
})
</script>

<template>
  <template v-if="aiStore.isDockOpen">
    <div v-if="showBackdrop" class="dock-overlay-backdrop" @click="aiStore.isDockExpanded ? aiStore.setDockExpanded(false) : aiStore.setDockOpen(false)"></div>

    <aside
      class="ai-copilot-dock"
      :class="{ 'is-expanded': aiStore.isDockExpanded }"
      :style="dockStyle"
    >
      <div
        v-if="isWideDesktop && !aiStore.isDockExpanded"
        class="dock-splitter"
        :class="{ dragging: isDragging }"
        :title="t('ai.dock_resize_hint')"
        @pointerdown="onSplitterPointerDown"
        @dblclick="aiStore.resetDockWidth()"
      ></div>
      <div class="dock-inner">
        <AiCopilotWorkspace :event-id="eventId" mode="dock" />
      </div>
    </aside>
  </template>
</template>

<style scoped src="./AiCopilotDock.css"></style>
