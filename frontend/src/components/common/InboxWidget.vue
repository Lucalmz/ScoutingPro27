<script setup lang="ts">
import { ref, computed } from 'vue'
import { useInboxStore } from '@/stores/inbox'
import { useUserStore } from '@/stores/user'
import { useRouter, useRoute } from 'vue-router'
import type { SystemMessage } from '@/types'

const inboxStore = useInboxStore()
const userStore = useUserStore()
const router = useRouter()
const route = useRoute()
const isOpen = ref(false)

/** Visibility controlled internally — parent renders this component unconditionally */
const shouldShow = computed(() => userStore.isLoggedIn && route.name !== 'login')

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
  <div class="inbox-widget" v-show="shouldShow" :class="{ 'is-open': isOpen }">
    <div class="inbox-morph-container" @click="!isOpen && toggleOpen()">
      <!-- FAB Content (visible when closed) -->
      <transition name="fade">
        <div v-if="!isOpen" class="inbox-btn-content">
          <span class="material-icons" style="font-size: 26px;">inbox</span>
          <span v-if="inboxStore.unreadCount > 0" class="badge">{{ inboxStore.unreadCount }}</span>
        </div>
      </transition>

      <!-- Dropdown Content (visible when open) -->
      <transition name="fade-delay">
        <div v-if="isOpen" class="inbox-dropdown-content">
          <div class="inbox-header" @click.stop="toggleOpen" style="cursor: pointer; display: flex; justify-content: space-between; align-items: center;">
            <h3>Inbox</h3>
            <span class="material-icons close-btn" style="font-size: 20px;">close</span>
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
  box-shadow: var(--glow-primary);
  border: 1px solid transparent;
  overflow: hidden;
  transition: width 0.4s cubic-bezier(0.25, 1, 0.5, 1), 
              height 0.4s cubic-bezier(0.25, 1, 0.5, 1), 
              border-radius 0.4s cubic-bezier(0.25, 1, 0.5, 1),
              background 0.4s cubic-bezier(0.25, 1, 0.5, 1),
              border-color 0.4s cubic-bezier(0.25, 1, 0.5, 1),
              box-shadow 0.4s cubic-bezier(0.25, 1, 0.5, 1);
  cursor: pointer;
  display: flex;
  flex-direction: column;
}

.inbox-widget.is-open .inbox-morph-container {
  width: 320px;
  height: 400px;
  border-radius: 14px;
  background: var(--card, #0a0a0a);
  border-color: var(--border, #262626);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.8), 0 0 15px rgba(57, 255, 20, 0.1);
  cursor: default;
}

.inbox-btn-content {
  width: 56px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--primary-foreground, #000000);
  position: absolute;
  top: 0;
  left: 0;
}

.badge {
  position: absolute;
  top: 0;
  right: 0;
  background: var(--destructive, #ef4444);
  color: #ffffff;
  font-size: 11px;
  font-weight: 700;
  border-radius: 10px;
  padding: 1px 5px;
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
  transition: opacity 0.25s ease;
}

.fade-delay-enter-active {
  transition-delay: 0.2s;
}
.fade-delay-leave-active {
  transition-duration: 0.15s;
}

.fade-enter-from, .fade-leave-to,
.fade-delay-enter-from, .fade-delay-leave-to {
  opacity: 0;
}

.inbox-header {
  padding: 12px 16px;
  background: var(--popover, #111111);
  border-bottom: 1px solid var(--border, #262626);
}

.inbox-header h3 {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
  font-family: 'Orbitron', sans-serif;
  color: var(--foreground, #f1f5f9);
}

.close-btn {
  color: var(--muted-foreground, #a3a3a3);
  transition: color 0.15s;
}

.close-btn:hover {
  color: var(--primary, #39ff14);
}

.inbox-list {
  flex: 1;
  overflow-y: auto;
  padding: 0;
}

.empty {
  padding: 2rem;
  text-align: center;
  color: var(--muted-foreground, #a3a3a3);
  font-size: 0.9rem;
}

.inbox-item {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border, #262626);
  background: var(--popover, #111111);
  transition: background 0.15s;
}

.inbox-item.clickable {
  cursor: pointer;
}

.inbox-item.clickable:hover {
  background: rgba(57, 255, 20, 0.08);
}

.inbox-item.unread {
  background: rgba(57, 255, 20, 0.05);
  border-left: 3px solid var(--primary, #39ff14);
}

.inbox-item-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.inbox-item-header h4 {
  margin: 0;
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--foreground, #f1f5f9);
}

.time {
  font-size: 0.75rem;
  color: var(--muted-foreground, #a3a3a3);
}

.inbox-item p {
  margin: 0 0 6px 0;
  font-size: 0.82rem;
  color: var(--muted-foreground, #a3a3a3);
  line-height: 1.4;
}

.mark-read {
  background: none;
  border: none;
  color: var(--primary, #39ff14);
  cursor: pointer;
  font-size: 0.78rem;
  font-weight: 600;
  padding: 0;
}
.mark-read:hover {
  text-decoration: underline;
}
</style>
