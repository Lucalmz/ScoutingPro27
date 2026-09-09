<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useUserStore } from '@/stores/user'
import { useEventStore } from '@/stores/events'
import { parseEventPackage } from '@/utils/offlineSync'
import { useToastStore } from '@/stores/toast'
import { useInboxStore } from '@/stores/inbox'
import { isDesktopHost } from '@/services/photoStorage'
import RenameModal from '@/components/common/RenameModal.vue'
import AccountMergeModal from '@/components/common/AccountMergeModal.vue'

const { t } = useI18n()
const toastStore = useToastStore()
const router = useRouter()
const userStore = useUserStore()
const eventStore = useEventStore()
const inboxStore = useInboxStore()

const showCreateModal = ref(false)
const showJoinModal = ref(false)
const showRenameModal = ref(false)
const showMergeModal = ref(false)
const eventFileInputRef = ref<HTMLInputElement | null>(null)
const newEventName = ref('')
const inviteCode = ref('')
const creating = ref(false)
const joining = ref(false)
const enteringEventId = ref<string | null>(null)

async function onAccountMerged(newUsername: string) {
  toastStore.showToast(`账号已成功合并至 ${newUsername}，正在刷新赛事...`, 'success')
  if (userStore.userId) {
    await eventStore.fetchEvents(userStore.userId)
  }
}

async function onEventFileSelected(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    const pkg = parseEventPackage(await file.text())
    const existing = eventStore.events.find((ev) => ev.id === pkg.event.id)
    if (!existing) eventStore.events.push(pkg.event)
    else Object.assign(existing, pkg.event)
    toastStore.showToast(t('offline_sync.import_success_event'), 'info')
    enterEvent(pkg.event)
  } catch (err: any) {
    toastStore.showToast(t('offline_sync.import_failed') + (err.message || ''), 'error')
  } finally {
    if (eventFileInputRef.value) eventFileInputRef.value.value = ''
  }
}

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
    htmlEl.style.setProperty('transition', 'all var(--motion-duration-normal) var(--motion-ease-out)', 'important')
    htmlEl.style.opacity = '1'
    htmlEl.style.transform = 'translateY(0)'
    
    // Clean up inline !important transition after animation so :active feedback is restored
    setTimeout(() => {
      htmlEl.style.removeProperty('transition')
      done()
    }, 360)
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
function handleOpenRenameModal() {
  if (typeof document !== 'undefined' && 'startViewTransition' in document) {
    document.documentElement.dataset.transitionType = 'user-profile'
    const vt = document.startViewTransition(async () => {
      showRenameModal.value = true
      await nextTick()
    })
    vt.finished.finally(() => {
      document.documentElement.removeAttribute('data-transition-type')
    })
  } else {
    showRenameModal.value = true
  }
}
</script>

<template>
  <div class="dashboard">
    <header class="topbar">
      <div class="topbar-left">
        <span class="brand" style="display: flex; align-items: center; gap: 10px;">
          <img src="/logo_transparent.png" alt="SP27" class="brand-logo" />
          <span>ScoutingPro 27</span>
        </span>
      </div>
      <div class="topbar-right">
        <button
          class="topbar-btn inbox-topbar-btn"
          @click="inboxStore.toggleOpen()"
          title="Inbox"
        >
          <span class="material-icons" style="font-size: 18px; margin-right: 4px;">inbox</span>
          <span class="topbar-btn-text">Inbox</span>
          <span v-if="inboxStore.unreadCount > 0" class="topbar-unread-badge">{{ inboxStore.unreadCount }}</span>
        </button>
        <button
          class="user-tag-btn user-profile-btn"
          @click="handleOpenRenameModal"
          :title="t('user.edit_nickname')"
          :style="{ viewTransitionName: !showRenameModal ? 'user-profile-box' : 'none' }"
        >
          <span class="material-icons" style="font-size: 18px; margin-right: 4px;">account_circle</span>
          <span
            class="username-text"
            :style="{ viewTransitionName: !showRenameModal ? 'user-profile-text' : 'none' }"
          >{{ userStore.username }}</span>
          <span class="material-icons edit-icon" style="font-size: 14px; margin-left: 4px;">edit</span>
        </button>
        <button
          class="topbar-btn account-merge-btn"
          @click="showMergeModal = true"
          :title="t('user.merge_account')"
        >
          <span class="material-icons" style="font-size: 18px; margin-right: 4px;">merge_type</span>
          <span class="topbar-btn-text">{{ t('user.merge_account') }}</span>
        </button>
        <button class="btn-logout" @click="handleLogout">{{ t('dashboard.logout') }}</button>
      </div>
    </header>

    <main class="main-content">
      <h2>{{ t('dashboard.welcome') }}</h2>

      <div class="action-buttons">
        <button v-if="isDesktopHost()" class="action-btn primary" @click="showCreateModal = true">
          {{ t('dashboard.create_event') }}
        </button>
        <button class="action-btn" :class="{ primary: !isDesktopHost(), secondary: isDesktopHost() }" @click="showJoinModal = true">
          {{ t('dashboard.join_event') }}
        </button>
        <button v-if="isDesktopHost()" class="action-btn secondary" @click="eventFileInputRef?.click()">
          <span class="material-icons" style="font-size: 18px; margin-right: 4px; vertical-align: text-bottom;">file_download</span>
          {{ t('offline_sync.import_event_btn') }}
        </button>
        <input
          ref="eventFileInputRef"
          type="file"
          accept=".event,.json"
          style="display: none;"
          @change="onEventFileSelected"
        />
      </div>

      <!-- Event List -->
      <div v-if="eventStore.loading && eventStore.events.length === 0" class="loading-msg">{{ t('dashboard.loading') }}</div>
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

    <!-- Rename User Modal -->
    <RenameModal v-model:visible="showRenameModal" @open-merge="showMergeModal = true" />

    <!-- Merge Account Modal -->
    <AccountMergeModal v-model:visible="showMergeModal" @merged="onAccountMerged" />
  </div>
</template>

<style scoped src="./DashboardView.css"></style>

