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

const isOverlayDock = computed(
  () => aiStore.isDockOpen && (!isWideDesktop.value || aiStore.isDockExpanded)
)

const showBackdrop = isOverlayDock

const spacerStyle = computed(() => ({
  '--ai-dock-width': `${aiStore.dockWidth}px`
}))

const dockStyle = computed(() => ({
  '--ai-dock-width': `${aiStore.dockWidth}px`
}))

function syncRootRightOffset() {
  if (typeof document === 'undefined') return
  const shouldOffset = aiStore.isDockOpen && isWideDesktop.value && !aiStore.isDockExpanded
  const offset = shouldOffset ? `${aiStore.dockWidth}px` : '0px'
  document.documentElement.style.setProperty('--ai-dock-right-offset', offset)
  if (isOverlayDock.value) {
    document.documentElement.dataset.aiDockOverlay = 'true'
  } else {
    delete document.documentElement.dataset.aiDockOverlay
  }
}

watch(
  [() => aiStore.isDockOpen, () => aiStore.dockWidth, () => aiStore.isDockExpanded, isWideDesktop, isOverlayDock],
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
    delete document.documentElement.dataset.aiDockOverlay
  }
})
</script>

<template>
  <!-- Wide-desktop layout spacer: smoothly reserves/releases flex width while the fixed dock animates -->
  <div
    v-if="isWideDesktop"
    class="ai-dock-spacer"
    :class="{ 'is-open': aiStore.isDockOpen, 'is-dragging': isDragging }"
    :style="spacerStyle"
    aria-hidden="true"
  ></div>

  <Transition name="ai-dock-backdrop">
    <div
      v-if="showBackdrop"
      class="dock-overlay-backdrop"
      @click="aiStore.isDockExpanded ? aiStore.setDockExpanded(false) : aiStore.setDockOpen(false)"
    ></div>
  </Transition>

  <Transition name="ai-dock-slide">
    <aside
      v-if="aiStore.isDockOpen"
      class="ai-copilot-dock"
      :class="{
        'is-expanded': aiStore.isDockExpanded,
        'is-narrow-overlay': !isWideDesktop,
        'is-dragging': isDragging
      }"
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
  </Transition>
</template>

<style scoped src="./AiCopilotDock.css"></style>
