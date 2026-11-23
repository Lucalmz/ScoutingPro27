<script setup lang="ts">
import AiCopilotWorkspace from './AiCopilotWorkspace.vue'

defineProps<{
  eventId: string
}>()
</script>

<template>
  <div class="ai-chat-view-mobile-wrap">
    <AiCopilotWorkspace :event-id="eventId" mode="mobile" />
  </div>
</template>

<style scoped>
.ai-chat-view-mobile-wrap {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
}
</style>
