<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { useEventStore } from '@/stores/events'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const router = useRouter()
const userStore = useUserStore()
const eventStore = useEventStore()

const showCreateModal = ref(false)
const showJoinModal = ref(false)
const newEventName = ref('')
const inviteCode = ref('')
const creating = ref(false)
const joining = ref(false)
const enteringEventId = ref<string | null>(null)

onMounted(async () => {
  if (!userStore.isLoggedIn) {
    router.replace('/')
    return
  }
  await eventStore.fetchEvents(userStore.userId)
})

async function handleCreate() {
  if (!newEventName.value.trim() || creating.value) return
  creating.value = true
  const evt = await eventStore.create(newEventName.value.trim())
  creating.value = false
  if (evt) {
    showCreateModal.value = false
    newEventName.value = ''
    router.push(`/event/${evt.id}`)
  }
}

async function handleJoin() {
  if (!inviteCode.value.trim()) return
  joining.value = true
  const evt = await eventStore.join(
    inviteCode.value.trim().toUpperCase(),
    'Joined Event',
  )
  joining.value = false
  if (evt) {
    showJoinModal.value = false
    inviteCode.value = ''
    router.push(`/event/${evt.id}`)
  }
}

import { transitionState } from '@/utils/transitionState'
import { nextTick } from 'vue'

function beforeEnter(el: Element) {
  if (transitionState.sharedElementId) return
  const htmlEl = el as HTMLElement
  htmlEl.style.opacity = '0'
  htmlEl.style.transform = 'translateY(20px)'
}

function enter(el: Element, done: () => void) {
  if (transitionState.sharedElementId) {
    done()
    return
  }
  const htmlEl = el as HTMLElement
  
  // Force browser to paint the initial opacity: 0 state before animating
  // eslint-disable-next-line no-unused-expressions
  htmlEl.offsetHeight
  
  const index = parseInt(htmlEl.dataset.index || '0', 10)
  const delay = Math.min(index, 15) * 40
  
  setTimeout(() => {
    htmlEl.style.setProperty('transition', 'all 0.4s cubic-bezier(0.25, 1, 0.5, 1)', 'important')
    htmlEl.style.opacity = '1'
    htmlEl.style.transform = 'translateY(0)'
    
    // Clean up inline !important transition after animation so :active feedback is restored
    setTimeout(() => {
      htmlEl.style.removeProperty('transition')
      done()
    }, 400)
  }, delay)
}

function enterEvent(evt: { id: string }) {
  enteringEventId.value = evt.id
  transitionState.startSharedTransition(`event-card-${evt.id}`)
  
  nextTick(() => {
    // Navigate immediately after the DOM has the inline style
    router.push(`/event/${evt.id}`)
  })
}

function handleLogout() {
  userStore.logout()
  router.replace('/')
}

function onCardMouseMove(e: MouseEvent) {
  const card = e.currentTarget as HTMLElement
  const rect = card.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  
  card.style.setProperty('--mouse-x', `${x}px`)
  card.style.setProperty('--mouse-y', `${y}px`)
}
</script>

<template>
  <div class="dashboard">
    <header class="topbar">
      <div class="topbar-left">
        <span class="brand" style="display: flex; align-items: center; gap: 8px;"><span class="material-icons">explore</span> ScoutingPro 27</span>
      </div>
      <div class="topbar-right">
        <span class="user-tag" style="display: flex; align-items: center;"><span class="material-icons" style="font-size: 18px; margin-right: 4px;">account_circle</span> {{ userStore.username }}</span>
        <button class="btn-logout" @click="handleLogout">{{ t('dashboard.logout') }}</button>
      </div>
    </header>

    <main class="main-content">
      <h2>{{ t('dashboard.welcome') }}</h2>

      <div class="action-buttons">
        <button class="action-btn primary" @click="showCreateModal = true">
          {{ t('dashboard.create_event') }}
        </button>
        <button class="action-btn secondary" @click="showJoinModal = true">
          {{ t('dashboard.join_event') }}
        </button>
      </div>

      <!-- Event List -->
      <div v-if="eventStore.loading && eventStore.events.length === 0" class="loading-msg">Loading events...</div>
      <p v-else-if="eventStore.error && eventStore.events.length === 0" class="error-msg">{{ eventStore.error }}</p>
      <div v-else-if="eventStore.events.length === 0" class="empty-state">
        <p>{{ t('dashboard.no_events') }}</p>
      </div>
      <transition-group 
        v-else 
        class="event-list"
        tag="div"
        appear
        :css="false"
        @before-enter="beforeEnter"
        @enter="enter"
        @before-appear="beforeEnter"
        @appear="enter"
      >
        <div
          v-for="(evt, index) in eventStore.events"
          :key="evt.id"
          :data-index="index"
          class="event-card"
          :class="{ 'slide-out-right': enteringEventId === evt.id }"
          @click="enterEvent(evt)"
          @mousemove="onCardMouseMove"
        >
          <div class="event-info">
            <span class="event-name" :style="{ viewTransitionName: transitionState.sharedElementId === `event-card-${evt.id}` ? 'event-card-title' : 'none' }">{{ evt.name }}</span>
            <span class="event-meta">
              {{ t('event.code') }}: <strong>{{ evt.inviteCode }}</strong>
              - {{ evt.hostId === userStore.userId ? t('event.host') : t('event.client') }}
              <span v-if="evt.ftcEventCode" style="margin-left: 8px; color: var(--primary); font-weight: 500;">
                • FTC: {{ evt.ftcEventCode }}
              </span>
            </span>
          </div>
          <span class="event-arrow material-icons" style="font-size: 20px;">arrow_forward</span>
        </div>
      </transition-group>
    </main>

    <!-- Create Event Modal -->
    <Transition name="modal">
      <div v-if="showCreateModal" class="modal-overlay" @click.self="showCreateModal = false">
        <div class="modal-card">
          <h3>{{ t('dashboard.modal_create_title') }}</h3>
          <label>{{ t('dashboard.modal_create_name') }}</label>
          <input
            v-model="newEventName"
            type="text"
            :placeholder="t('dashboard.modal_create_placeholder')"
            :disabled="creating"
            @keyup.enter="handleCreate"
          />
          <div class="modal-actions">
            <button class="btn-cancel" @click="showCreateModal = false">{{ t('dashboard.btn_cancel') }}</button>
            <button class="btn-confirm" :disabled="creating || !newEventName.trim()" @click="handleCreate">
              {{ creating ? t('dashboard.btn_creating') : t('dashboard.btn_create') }}
            </button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- Join Event Modal -->
    <Transition name="modal">
      <div v-if="showJoinModal" class="modal-overlay" @click.self="showJoinModal = false">
        <div class="modal-card">
          <h3>{{ t('dashboard.modal_join_title') }}</h3>
          <label>{{ t('dashboard.modal_join_code') }}</label>
          <input
            v-model="inviteCode"
            type="text"
            :placeholder="t('dashboard.modal_join_placeholder')"
            :disabled="joining"
            @keyup.enter="handleJoin"
            style="text-transform: uppercase;"
          />
          <div class="modal-actions">
            <button class="btn-cancel" @click="showJoinModal = false">{{ t('dashboard.btn_cancel') }}</button>
            <button class="btn-confirm" :disabled="joining || !inviteCode.trim()" @click="handleJoin">
              {{ joining ? t('dashboard.btn_joining') : t('dashboard.btn_join') }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.dashboard {
  min-height: 100vh;
  background: var(--background);
  color: var(--foreground);
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 24px;
  background: var(--card);
  border-bottom: 1px solid var(--border);
}

.brand {
  font-weight: 700;
  font-size: 18px;
}

.user-tag {
  color: var(--muted-foreground);
  margin-right: 12px;
}

.btn-logout {
  background: transparent;
  border: 1px solid var(--input);
  color: var(--muted-foreground);
  padding: 6px 14px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
}

.btn-logout:hover {
  background: var(--border);
}

.main-content {
  max-width: 720px;
  margin: 0 auto;
  padding: 32px 24px;
}

h2 {
  font-size: 22px;
  margin: 0 0 20px;
}

.action-buttons {
  display: flex;
  gap: 12px;
  margin-bottom: 28px;
}

.action-btn {
  flex: 1;
  padding: 14px;
  border-radius: 12px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  border: none;
  transition: background 0.2s;
}

.action-btn.primary {
  background: var(--primary);
  color: var(--primary-foreground);
}

.action-btn.primary:hover {
  background: var(--primary);
}

.action-btn.secondary {
  background: var(--border);
  color: var(--foreground);
}

.action-btn.secondary:hover {
  background: var(--input);
}

.event-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.event-card {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px 20px;
  cursor: pointer;
  transition: border-color 0.25s ease, transform 0.4s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.4s;
}

.event-card:hover {
  border-color: rgba(57, 255, 20, 0.4);
}

.event-card::before {
  content: '';
  position: absolute;
  inset: -1px;
  border-radius: 12px;
  padding: 1px;
  background: radial-gradient(
    160px circle at var(--mouse-x, -999px) var(--mouse-y, -999px),
    #ffffff 0%,
    rgba(255, 255, 255, 0.7) 20%,
    rgba(57, 255, 20, 0.5) 50%,
    transparent 80%
  );
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask-composite: exclude;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.3s ease;
}

.event-card:hover::before {
  opacity: 1;
}

.event-card.slide-out-right {
  transform: translateX(150px);
  opacity: 0;
}

.event-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.event-name {
  font-weight: 600;
  font-size: 16px;
}

.event-info h3 {
  margin: 0 0 4px 0;
  font-size: 1.1rem;
  color: var(--color-text-primary, #333);
}

.event-name {
  display: inline-block;
  font-size: 1.1rem;
  font-weight: bold;
  color: var(--foreground);
  margin-bottom: 4px;
  width: fit-content;
}

.event-meta {
  font-size: 13px;
  color: var(--muted-foreground);
}

.event-arrow {
  font-size: 20px;
  color: var(--muted-foreground);
}

.loading-msg,
.error-msg,
.empty-state {
  text-align: center;
  padding: 40px;
  color: var(--muted-foreground);
}

.error-msg {
  color: var(--status-error);
}

/* Modal */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.modal-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 28px;
  width: 100%;
  max-width: 400px;
}

.modal-card h3 {
  margin: 0 0 16px;
  font-size: 18px;
}

.modal-card label {
  display: block;
  font-size: 13px;
  color: var(--muted-foreground);
  margin-bottom: 4px;
}

.modal-card input {
  width: 100%;
  padding: 10px 14px;
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--foreground);
  font-size: 16px;
  outline: none;
  box-sizing: border-box;
}

.modal-card input:focus {
  border-color: var(--primary);
}

.hint {
  font-size: 12px;
  color: var(--muted-foreground);
  margin: 6px 0 0;
}

.modal-actions {
  display: flex;
  gap: 10px;
  margin-top: 20px;
  justify-content: flex-end;
}

.btn-cancel,
.btn-confirm {
  padding: 10px 20px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  border: none;
}

.btn-cancel {
  background: var(--border);
  color: var(--muted-foreground);
}

.btn-cancel:hover {
  background: var(--input);
}

.btn-confirm {
  background: var(--primary);
  color: var(--primary-foreground);
}

.btn-confirm:hover:not(:disabled) {
  background: var(--primary);
}

.btn-confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>

