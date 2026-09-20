<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    imageUrl?: string | null
    images?: string[]
    initialIndex?: number
    title?: string
  }>(),
  {
    imageUrl: null,
    images: () => [],
    initialIndex: 0,
    title: ''
  }
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()

const activeIndex = ref(props.initialIndex)

watch(
  () => props.initialIndex,
  (val) => {
    activeIndex.value = val
  }
)

watch(
  () => props.modelValue,
  (isOpen) => {
    if (isOpen) {
      activeIndex.value = props.initialIndex
    }
  }
)

const currentDisplayUrl = computed(() => {
  if (props.images && props.images.length > 0) {
    const idx = Math.max(0, Math.min(activeIndex.value, props.images.length - 1))
    return props.images[idx] || props.imageUrl || ''
  }
  return props.imageUrl || ''
})

const hasMultiple = computed(() => props.images && props.images.length > 1)

function close() {
  emit('update:modelValue', false)
}

function prev() {
  if (!props.images || props.images.length <= 1) return
  activeIndex.value = (activeIndex.value - 1 + props.images.length) % props.images.length
}

function next() {
  if (!props.images || props.images.length <= 1) return
  activeIndex.value = (activeIndex.value + 1) % props.images.length
}

function onKeyDown(e: KeyboardEvent) {
  if (!props.modelValue) return
  if (e.key === 'Escape') {
    close()
  } else if (e.key === 'ArrowLeft') {
    prev()
  } else if (e.key === 'ArrowRight') {
    next()
  }
}

function openOriginal() {
  const url = currentDisplayUrl.value
  if (!url || typeof window === 'undefined') return

  if (url.startsWith('data:')) {
    try {
      const parts = url.split(',')
      const mimeMatch = parts[0]?.match(/:(.*?);/)
      const mime = mimeMatch ? mimeMatch[1] : 'image/webp'
      const base64Data = parts[1] || ''
      const binaryStr = atob(base64Data)
      const len = binaryStr.length
      const bytes = new Uint8Array(len)
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryStr.charCodeAt(i)
      }
      const blob = new Blob([bytes], { type: mime })
      const blobUrl = URL.createObjectURL(blob)
      window.open(blobUrl, '_blank')
      setTimeout(() => {
        try {
          URL.revokeObjectURL(blobUrl)
        } catch {}
      }, 60000)
      return
    } catch (err) {
      console.warn('[ImagePreviewModal] Failed to convert dataUrl to blobUrl:', err)
    }
  }

  window.open(url, '_blank')
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', onKeyDown)
  }
})

onUnmounted(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('keydown', onKeyDown)
  }
})
</script>

<template>
  <Teleport to="body">
    <Transition name="preview-fade">
      <div
        v-if="modelValue && currentDisplayUrl"
        class="image-preview-overlay"
        @click.self="close"
        role="dialog"
        aria-modal="true"
      >
        <!-- 顶部操作栏 -->
        <div class="preview-header">
          <div class="header-left">
            <span v-if="title" class="preview-title">{{ title }}</span>
            <span v-if="hasMultiple" class="preview-counter">
              {{ activeIndex + 1 }} / {{ images.length }}
            </span>
          </div>
          <div class="header-actions">
            <button
              type="button"
              class="icon-btn"
              @click="openOriginal"
              title="查看原图"
              aria-label="查看原图"
            >
              <span class="material-icons">open_in_new</span>
            </button>
            <button
              type="button"
              class="icon-btn close-btn"
              @click="close"
              title="关闭"
              aria-label="关闭"
            >
              <span class="material-icons">close</span>
            </button>
          </div>
        </div>

        <!-- 主体图片展示区 -->
        <div class="preview-body" @click.self="close">
          <!-- 上一张按钮 -->
          <button
            v-if="hasMultiple"
            type="button"
            class="nav-btn prev-btn"
            @click.stop="prev"
            aria-label="上一张"
          >
            <span class="material-icons">chevron_left</span>
          </button>

          <!-- 图片主体 -->
          <div class="img-container">
            <img
              :src="currentDisplayUrl"
              :alt="title || 'Preview'"
              class="preview-image"
            />
          </div>

          <!-- 下一张按钮 -->
          <button
            v-if="hasMultiple"
            type="button"
            class="nav-btn next-btn"
            @click.stop="next"
            aria-label="下一张"
          >
            <span class="material-icons">chevron_right</span>
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.image-preview-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.88);
  backdrop-filter: blur(8px);
  z-index: 9999;
  display: flex;
  flex-direction: column;
  user-select: none;
}

.preview-header {
  height: 56px;
  padding: 0 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.7), transparent);
  color: #fff;
  z-index: 10;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.preview-title {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.2px;
  color: #f3f4f6;
  max-width: 60vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-counter {
  font-size: 13px;
  padding: 2px 8px;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 12px;
  color: #d1d5db;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.icon-btn {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: #fff;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s ease;
}

.icon-btn:hover {
  background: rgba(255, 255, 255, 0.25);
  transform: scale(1.05);
}

.icon-btn:active {
  transform: scale(0.95);
}

.close-btn:hover {
  background: rgba(239, 68, 68, 0.8);
  border-color: transparent;
}

.preview-body {
  flex: 1;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  overflow: hidden;
}

.img-container {
  max-width: 92vw;
  max-height: 86vh;
  display: flex;
  align-items: center;
  justify-content: center;
}

.preview-image {
  max-width: 92vw;
  max-height: 86vh;
  object-fit: contain;
  border-radius: 8px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.6);
  pointer-events: auto;
}

.nav-btn {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  background: rgba(0, 0, 0, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: #fff;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s ease;
  z-index: 10;
}

.nav-btn:hover {
  background: rgba(255, 255, 255, 0.2);
  transform: translateY(-50%) scale(1.1);
}

.prev-btn {
  left: 20px;
}

.next-btn {
  right: 20px;
}

/* 动效过渡 */
.preview-fade-enter-active,
.preview-fade-leave-active {
  transition: opacity 0.25s ease;
}

.preview-fade-enter-from,
.preview-fade-leave-to {
  opacity: 0;
}
</style>
