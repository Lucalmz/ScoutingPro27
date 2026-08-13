<script setup lang="ts">
import { ref, nextTick } from 'vue'
import { useInboxStore } from '@/stores/inbox'
import { useRouter, useRoute } from 'vue-router'
import type { SystemMessage } from '@/types'

const inboxStore = useInboxStore()
const router = useRouter()
const route = useRoute()
const isOpen = ref(false)

function toggleOpen() {
  isOpen.value = !isOpen.value
}

function handleMarkRead(id: string) {
  inboxStore.markRead(id)
}

function handleMessageClick(msg: SystemMessage) {
  if (msg.type === 'conflict' && msg.conflictMatchNumber && msg.conflictTeamNumber) {
    const eventId = route.params.eventId
    if (eventId) {
      router.push(`/event/${eventId}?tab=history&highlightMatch=${msg.conflictMatchNumber}&highlightTeam=${msg.conflictTeamNumber}`)
      isOpen.value = false
    } else {
      alert('Please enter the event first to view the conflict.')
    }
  }
}
</script>

<template>
  <div class="inbox-widget" :class="{ 'is-open': isOpen }">
    <div class="inbox-morph-container" @click="!isOpen && toggleOpen()">
      <!-- FAB Content (visible when closed) -->
      <transition name="fade">
        <div v-if="!isOpen" class="inbox-btn-content">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-inbox"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"></polyline><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path></svg>
          <span v-if="inboxStore.unreadCount > 0" class="badge">{{ inboxStore.unreadCount }}</span>
        </div>
      </transition>

      <!-- Dropdown Content (visible when open) -->
      <transition name="fade-delay">
        <div v-if="isOpen" class="inbox-dropdown-content">
          <div class="inbox-header" @click.stop="toggleOpen" style="cursor: pointer; display: flex; justify-content: space-between; align-items: center;">
            <h3>Inbox</h3>
            <span class="material-icons" style="color: #666; font-size: 20px;">close</span>
          </div>
          <div class="inbox-list">
            <div v-if="inboxStore.messages.length === 0" class="empty">No messages</div>
            <div 
              v-for="msg in inboxStore.messages" 
              :key="msg.id" 
              class="inbox-item" 
              :class="{ unread: !msg.read, clickable: msg.type === 'conflict' }"
              @click="handleMessageClick(msg)"
            >
              <div class="inbox-item-header">
                <h4>{{ msg.title }}</h4>
                <span class="time">{{ new Date(msg.timestamp).toLocaleTimeString() }}</span>
              </div>
              <p>{{ msg.body }}</p>
              <button v-if="!msg.read" @click.stop="handleMarkRead(msg.id)" class="mark-read">Mark Read</button>
            </div>
          </div>
        </div>
      </transition>
    </div>
  </div>
</template>

<style scoped>
.inbox-widget {
  position: fixed;
  bottom: 2rem;
  right: 2rem;
  z-index: 1000;
  view-transition-name: inbox-widget;
}

.inbox-morph-container {
  position: absolute;
  bottom: 0;
  right: 0;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: var(--primary, #39ff14);
  box-shadow: 0 4px 6px rgba(0,0,0,0.1);
  overflow: hidden;
  transition: width 0.6s cubic-bezier(0.25, 1, 0.5, 1), 
              height 0.6s cubic-bezier(0.25, 1, 0.5, 1), 
              border-radius 0.6s cubic-bezier(0.25, 1, 0.5, 1),
              box-shadow 0.6s cubic-bezier(0.25, 1, 0.5, 1);
  cursor: pointer;
  display: flex;
  flex-direction: column;
}

.inbox-widget.is-open .inbox-morph-container {
  width: 320px;
  height: 400px;
  border-radius: 16px;
  background: white;
  box-shadow: 0 10px 25px rgba(0,0,0,0.2);
  cursor: default;
  animation: bg-morph-open 0.6s cubic-bezier(0.25, 1, 0.5, 1) forwards;
}

.inbox-widget:not(.is-open) .inbox-morph-container {
  animation: bg-morph-close 0.6s cubic-bezier(0.25, 1, 0.5, 1) forwards;
}

@keyframes bg-morph-open {
  0% { background: var(--primary, #39ff14); }
  50% { background: #8eff73; }
  100% { background: white; }
}

@keyframes bg-morph-close {
  0% { background: white; }
  50% { background: #8eff73; }
  100% { background: var(--primary, #39ff14); }
}

.inbox-btn-content {
  width: 56px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #000000;
  position: absolute;
  top: 0;
  left: 0;
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
  transform: translate(-10%, 10%);
}

.inbox-dropdown-content {
  width: 320px;
  height: 400px;
  display: flex;
  flex-direction: column;
  position: absolute;
  top: 0;
  right: 0;
}

/* Crossfade transitions for content */
.fade-enter-active, .fade-leave-active,
.fade-delay-enter-active, .fade-delay-leave-active {
  transition: opacity 0.3s ease;
}

.fade-delay-enter-active {
  transition-delay: 0.3s; /* Wait for background morph to be mostly white before showing text */
}
.fade-delay-leave-active {
  transition-duration: 0.2s; /* Fade out text quickly when closing */
}

.fade-enter-from, .fade-leave-to,
.fade-delay-enter-from, .fade-delay-leave-to {
  opacity: 0;
}

.inbox-header {
  padding: 1rem;
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

.inbox-item.clickable {
  cursor: pointer;
  transition: background 0.15s;
}

.inbox-item.clickable:hover {
  background: #f9f9f9;
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
