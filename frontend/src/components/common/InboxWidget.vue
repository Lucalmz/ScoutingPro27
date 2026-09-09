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

const isOpen = computed({
  get: () => inboxStore.isOpen,
  set: (val: boolean) => inboxStore.setOpen(val)
})

/** Visibility controlled internally — parent renders this component unconditionally */
const shouldShow = computed(() => userStore.isLoggedIn && route.name !== 'login')

function toggleOpen() {
  inboxStore.toggleOpen()
}

function handleMarkRead(id: string) {
  inboxStore.markRead(id)
}

function handleDelete(id: string) {
  inboxStore.deleteMessage(id)
}

function handleMarkAllRead() {
  inboxStore.markAllRead()
}

function handleClearAll() {
  inboxStore.clearAllMessages()
}

function handleMessageClick(msg: SystemMessage) {
  if (msg.type === 'conflict' && msg.conflictMatchNumber && msg.conflictTeamNumber) {
    const eventId = route.params.eventId
    if (eventId) {
      const levelQuery = msg.conflictTournamentLevel ? `&highlightLevel=${msg.conflictTournamentLevel}` : ''
      router.push(`/event/${eventId}?tab=history&highlightMatch=${msg.conflictMatchNumber}&highlightTeam=${msg.conflictTeamNumber}${levelQuery}`)
      inboxStore.setOpen(false)
    } else {
      alert('Please enter the event first to view the conflict.')
    }
  }
}
</script>

<template>
  <div class="inbox-widget" v-show="shouldShow" :class="{ 'is-open': isOpen }">
    <!-- Backdrop overlay on mobile/desktop when open to dismiss by tapping outside -->
    <transition name="fade">
      <div v-if="isOpen" class="inbox-backdrop" @click.stop="toggleOpen"></div>
    </transition>

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
          <div class="inbox-header" style="display: flex; justify-content: space-between; align-items: center;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <h3 style="margin: 0;">Inbox</h3>
              <span v-if="inboxStore.messages.length > 0" class="inbox-actions" style="display: flex; gap: 6px;">
                <button type="button" class="action-btn" title="Mark all read" @click.stop="handleMarkAllRead" style="font-size: 11px; padding: 2px 6px; cursor: pointer; border-radius: 4px; border: 1px solid #444; background: #222; color: #aaa;">Mark all read</button>
                <button type="button" class="action-btn" title="Clear all" @click.stop="handleClearAll" style="font-size: 11px; padding: 2px 6px; cursor: pointer; border-radius: 4px; border: 1px solid #444; background: #222; color: #e57373;">Clear</button>
              </span>
            </div>
            <span class="material-icons close-btn" style="font-size: 20px; cursor: pointer;" @click.stop="toggleOpen">close</span>
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
              <div class="item-actions" style="display: flex; gap: 8px; align-items: center; margin-top: 6px;">
                <button v-if="!msg.read" type="button" @click.stop="handleMarkRead(msg.id)" class="mark-read">Mark Read</button>
                <button type="button" @click.stop="handleDelete(msg.id)" class="delete-msg-btn" style="background: none; border: none; color: #888; cursor: pointer; font-size: 11px; padding: 0;">Delete</button>
              </div>
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
}

@media (max-width: 768px) {
  .inbox-widget {
    bottom: calc(56px + env(safe-area-inset-bottom, 0px) + 16px);
    right: 16px;
  }
}

.inbox-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  z-index: 999;
}

@media (min-width: 769px) {
  .inbox-backdrop {
    display: none;
  }
}

.inbox-morph-container {
  position: absolute;
  bottom: 0;
  right: 0;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: var(--primary, #39ff14);
  box-shadow: 0 4px 14px rgba(57, 255, 20, 0.45);
  overflow: hidden;
  transition: width 0.5s cubic-bezier(0.25, 1, 0.5, 1), 
              height 0.5s cubic-bezier(0.25, 1, 0.5, 1), 
              border-radius 0.5s cubic-bezier(0.25, 1, 0.5, 1),
              box-shadow 0.5s cubic-bezier(0.25, 1, 0.5, 1);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  view-transition-name: inbox-widget;
  z-index: 1000;
}

.inbox-widget.is-open .inbox-morph-container {
  width: 340px;
  height: 420px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 120px);
  border-radius: 16px;
  background: white;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
  cursor: default;
  animation: bg-morph-open 0.8s cubic-bezier(0.25, 1, 0.5, 1) forwards;
}

.inbox-widget:not(.is-open) .inbox-morph-container {
  animation: bg-morph-close 0.8s cubic-bezier(0.25, 1, 0.5, 1) forwards;
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
  background: #ef4444;
  color: #ffffff;
  font-size: 11px;
  font-weight: 700;
  border-radius: 10px;
  padding: 1px 5px;
  transform: translate(-10%, 10%);
}

.inbox-dropdown-content {
  width: 100%;
  height: 100%;
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
  transition-delay: 0.3s;
}
.fade-delay-leave-active {
  transition-duration: 0.2s;
}

.fade-enter-from, .fade-leave-to,
.fade-delay-enter-from, .fade-delay-leave-to {
  opacity: 0;
}

.inbox-header {
  padding: 1rem;
  background: #f8f9fa;
  border-bottom: 1px solid #eee;
}

.inbox-header h3 {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 700;
  color: #333333;
}

.close-btn {
  color: #666666;
  transition: color 0.15s;
}

.close-btn:hover {
  color: #000000;
}

.inbox-list {
  flex: 1;
  overflow-y: auto;
  padding: 0;
}

.empty {
  padding: 2rem;
  text-align: center;
  color: #888888;
  font-size: 0.9rem;
}

.inbox-item {
  padding: 1rem;
  border-bottom: 1px solid #eee;
  background: #ffffff;
  transition: background 0.15s;
}

.inbox-item.clickable {
  cursor: pointer;
}

.inbox-item.clickable:hover {
  background: #f9f9f9;
}

.inbox-item.unread {
  background: #f0f7ff;
  border-left: 3px solid var(--primary, #39ff14);
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
  font-weight: 600;
  color: #333333;
}

.time {
  font-size: 0.8rem;
  color: #888888;
}

.inbox-item p {
  margin: 0 0 0.5rem 0;
  font-size: 0.9rem;
  color: #555555;
  line-height: 1.4;
}

.mark-read {
  background: none;
  border: none;
  color: #007bff;
  cursor: pointer;
  font-size: 0.8rem;
  font-weight: 600;
  padding: 0;
}
.mark-read:hover {
  text-decoration: underline;
}
</style>
