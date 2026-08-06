<script setup lang="ts">
import { ref } from 'vue'
import { useInboxStore } from '@/stores/inbox'

const inboxStore = useInboxStore()
const isOpen = ref(false)

function toggleOpen() {
  isOpen.value = !isOpen.value
}

function handleMarkRead(id: string) {
  inboxStore.markRead(id)
}
</script>

<template>
  <div class="inbox-widget">
    <button class="inbox-btn" @click="toggleOpen">
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-inbox"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"></polyline><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path></svg>
      <span v-if="inboxStore.unreadCount > 0" class="badge">{{ inboxStore.unreadCount }}</span>
    </button>
    <div v-if="isOpen" class="inbox-dropdown">
      <div class="inbox-header">
        <h3>Inbox</h3>
      </div>
      <div class="inbox-list">
        <div v-if="inboxStore.messages.length === 0" class="empty">No messages</div>
        <div v-for="msg in inboxStore.messages" :key="msg.id" class="inbox-item" :class="{ unread: !msg.read }">
          <div class="inbox-item-header">
            <h4>{{ msg.title }}</h4>
            <span class="time">{{ new Date(msg.timestamp).toLocaleTimeString() }}</span>
          </div>
          <p>{{ msg.body }}</p>
          <button v-if="!msg.read" @click="handleMarkRead(msg.id)" class="mark-read">Mark Read</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.inbox-widget {
  position: fixed;
  bottom: 2rem;
  right: 2rem;
  z-index: 1000;
}

.inbox-btn {
  background: var(--color-primary, #007bff);
  color: white;
  border: none;
  border-radius: 50%;
  width: 56px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 4px 6px rgba(0,0,0,0.1);
  position: relative;
}

.badge {
  position: absolute;
  top: 0;
  right: 0;
  background: red;
  color: white;
  font-size: 12px;
  border-radius: 10px;
  padding: 2px 6px;
  transform: translate(25%, -25%);
}

.inbox-dropdown {
  position: absolute;
  bottom: 70px;
  right: 0;
  width: 320px;
  max-height: 400px;
  background: white;
  border-radius: 8px;
  box-shadow: 0 10px 25px rgba(0,0,0,0.2);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.inbox-header {
  padding: 1rem;
  background: #f8f9fa;
  border-bottom: 1px solid #eee;
}

.inbox-header h3 {
  margin: 0;
  font-size: 1.1rem;
  color: #333;
}

.inbox-list {
  flex: 1;
  overflow-y: auto;
  padding: 0;
}

.empty {
  padding: 2rem;
  text-align: center;
  color: #888;
}

.inbox-item {
  padding: 1rem;
  border-bottom: 1px solid #eee;
  background: #fff;
}

.inbox-item.unread {
  background: #f0f7ff;
}

.inbox-item-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
}

.inbox-item-header h4 {
  margin: 0;
  font-size: 1rem;
  color: #333;
}

.time {
  font-size: 0.8rem;
  color: #888;
}

.inbox-item p {
  margin: 0 0 0.5rem 0;
  font-size: 0.9rem;
  color: #555;
}

.mark-read {
  background: none;
  border: none;
  color: var(--color-primary, #007bff);
  cursor: pointer;
  font-size: 0.8rem;
  padding: 0;
}
.mark-read:hover {
  text-decoration: underline;
}
</style>
