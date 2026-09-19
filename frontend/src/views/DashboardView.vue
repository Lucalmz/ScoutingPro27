<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useUserStore } from '@/stores/user'
import { useEventStore } from '@/stores/events'
import { parseEventPackage } from '@/utils/offlineSync'
import { useToastStore } from '@/stores/toast'
import { useInboxStore } from '@/stores/inbox'
import { useConfirm } from '@/composables/useConfirm'
import { isDesktopHost } from '@/services/photoStorage'
import { useIsMobile } from '@/composables/useIsMobile'
import { hapticLight } from '@/utils/haptics'
import { transitionState } from '@/utils/transitionState'
import RenameModal from '@/components/common/RenameModal.vue'
import QrScannerModal from '@/components/common/QrScannerModal.vue'
import MobileQrModal from '@/components/common/MobileQrModal.vue'

const { t } = useI18n()
const toastStore = useToastStore()
const router = useRouter()
const userStore = useUserStore()
const eventStore = useEventStore()
const inboxStore = useInboxStore()
const { showConfirm } = useConfirm()
const { isMobile } = useIsMobile()
const isMobileClient = computed(() => isMobile.value && !isDesktopHost())

const showCreateModal = ref(false)
const showJoinModal = ref(false)
const showRenameModal = ref(false)
const showQrScannerModal = ref(false)
const showEventQrModal = ref(false)
const selectedQrInviteCode = ref('')
const eventFileInputRef = ref<HTMLInputElement | null>(null)
const newEventName = ref('')
const inviteCode = ref('')
const creating = ref(false)
const joining = ref(false)
const enteringEventId = ref<string | null>(null)

function openCardQr(evt: { inviteCode: string }) {
  selectedQrInviteCode.value = evt.inviteCode
  showEventQrModal.value = true
}

async function handleQrScanned(code: string) {
  if (!code) return
  inviteCode.value = code
  showJoinModal.value = false
  await handleJoin()
}

async function onEventFileSelected(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    const pkg = parseEventPackage(await file.text())
    let targetEvent = pkg.event
    try {
      const synced = await eventStore.syncExternal(pkg.event)
      if (synced) {
        targetEvent = synced
      } else {
        const existing = eventStore.events.find((ev) => ev.id === pkg.event.id)
        if (!existing) eventStore.events.push(pkg.event)
        else Object.assign(existing, pkg.event)
      }
    } catch {
      const existing = eventStore.events.find((ev) => ev.id === pkg.event.id)
      if (!existing) eventStore.events.push(pkg.event)
      else Object.assign(existing, pkg.event)
    }
    toastStore.showToast(t('offline_sync.import_success_event'), 'info')
    enterEvent(targetEvent)
  } catch (err: any) {
    toastStore.showError(err, t('offline_sync.import_failed'))
  } finally {
    if (eventFileInputRef.value) eventFileInputRef.value.value = ''
  }
}

async function handleDeleteEvent(evt: { id: string; name?: string; inviteCode?: string }) {
  const name = evt.name || evt.inviteCode || 'Event'
  const confirmed = await showConfirm({
    title: t('dashboard.delete_event_title') || '删除比赛',
    message: t('dashboard.delete_event_confirm', { name }) || `确定从本地移除比赛 "${name}" 吗？`,
    type: 'danger',
    confirmText: t('common.delete') || '删除'
  })
  if (confirmed) {
    await eventStore.deleteEvent(evt.id)
    toastStore.showToast(t('dashboard.event_deleted_toast') || '已从本地移除比赛', 'info')
  }
}

async function handleClearAllCache() {
  const confirmed = await showConfirm({
    title: t('dashboard.clear_cache_title') || '清空离线缓存',
    message:
      t('dashboard.clear_cache_confirm') ||
      '此操作将清空本地保存的所有赛事、打分暂存及离线缓存。确定要清空吗？',
    type: 'danger',
    confirmText: t('dashboard.clear_cache_confirm_btn') || '确认清空'
  })
  if (confirmed) {
    eventStore.clearAllLocalCache()
    toastStore.showToast(t('dashboard.cache_cleared_toast') || '本地离线缓存已全部清空', 'success')
  }
}

onMounted(async () => {
  if (!userStore.isLoggedIn) {
    router.replace('/')
    return
  }
  if (router.currentRoute?.value?.query?.join || router.currentRoute?.value?.query?.code) {
    router.replace({ path: '/dashboard', query: {} })
  }
  eventStore.restoreFromCache()
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
  const index = parseInt(htmlEl.dataset.index || '0', 10)
  const delay = Math.min(index, 15) * 40

  requestAnimationFrame(() => {
    setTimeout(() => {
      htmlEl.style.setProperty('transition', 'all var(--motion-duration-normal) var(--motion-ease-out)', 'important')
      htmlEl.style.opacity = '1'
      htmlEl.style.transform = 'translateY(0)'

      setTimeout(() => {
        htmlEl.style.removeProperty('transition')
        htmlEl.style.removeProperty('opacity')
        htmlEl.style.removeProperty('transform')
        done()
      }, 360)
    }, delay)
  })
}

function enterEvent(evt: { id: string }) {
  hapticLight()
  enteringEventId.value = evt.id
  transitionState.startSharedTransition(`event-card-${evt.id}`)

  const fullEvt = eventStore.events.find((e) => e.id === evt.id)
  if (fullEvt) {
    eventStore.setCurrentEvent(fullEvt)
  }

  nextTick(() => {
    // Navigate immediately after the DOM has the inline style
    router.push(`/event/${evt.id}`)
  })
}

function handleLogout() {
  userStore.logout()
  router.replace('/')
}

let mouseMoveRaf: number | null = null
function onCardMouseMove(e: MouseEvent) {
  const card = e.currentTarget as HTMLElement
  const clientX = e.clientX
  const clientY = e.clientY

  if (mouseMoveRaf !== null) return
  mouseMoveRaf = requestAnimationFrame(() => {
    mouseMoveRaf = null
    const rect = card.getBoundingClientRect()
    card.style.setProperty('--mouse-x', `${clientX - rect.left}px`)
    card.style.setProperty('--mouse-y', `${clientY - rect.top}px`)
  })
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
          <img src="/logo_60.png" srcset="/logo_30.png 1x, /logo_60.png 2x" alt="SP27" class="brand-logo" />
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
          v-if="!isDesktopHost()"
          class="topbar-btn clear-cache-btn"
          @click="handleClearAllCache"
          :title="t('dashboard.clear_cache_title')"
        >
          <span class="material-icons" style="font-size: 16px; margin-right: 4px;">cleaning_services</span>
          <span class="topbar-btn-text">{{ t('dashboard.clear_cache_btn') }}</span>
        </button>
        <button class="btn-logout" @click="handleLogout">{{ t('dashboard.logout') }}</button>
      </div>
    </header>

    <main class="main-content">
      <h2>{{ t('dashboard.welcome') }} {{ userStore.username }}</h2>

      <div class="action-buttons">
        <button v-if="isDesktopHost()" class="action-btn primary" @click="showCreateModal = true">
          {{ t('dashboard.create_event') }}
        </button>
        <button class="action-btn" :class="{ primary: !isDesktopHost(), secondary: isDesktopHost() }" @click="showJoinModal = true">
          {{ t('dashboard.join_event') }}
        </button>
        <button class="action-btn scan-btn" :class="{ primary: !isDesktopHost(), secondary: isDesktopHost() }" @click="showQrScannerModal = true">
          <span class="material-icons" style="font-size: 18px; margin-right: 4px; vertical-align: text-bottom;">qr_code_scanner</span>
          {{ t('dashboard.scan_to_join') }}
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
        <p v-if="!isDesktopHost()" class="mobile-tip">
          {{ t('dashboard.mobile_no_events_tip') }}
        </p>
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
              <button
                type="button"
                class="btn-card-qr"
                @click.stop="openCardQr(evt)"
                :title="t('dashboard.view_qr_code')"
              >
                <span class="material-icons" style="font-size: 15px; vertical-align: middle;">qr_code_2</span>
              </button>
              <button
                type="button"
                class="btn-card-delete"
                @click.stop="handleDeleteEvent(evt)"
                :title="t('dashboard.delete_event_title')"
              >
                <span class="material-icons" style="font-size: 15px; vertical-align: middle;">delete_outline</span>
              </button>
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
          <div class="join-input-group">
            <input
              v-model="inviteCode"
              type="text"
              :placeholder="t('dashboard.modal_join_placeholder')"
              :disabled="joining"
              @keyup.enter="handleJoin"
              style="text-transform: uppercase;"
            />
            <button type="button" class="btn-scan-input" @click="showQrScannerModal = true" :title="t('dashboard.scan_qr_btn')">
              <span class="material-icons">qr_code_scanner</span>
            </button>
          </div>
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
    <RenameModal v-model:visible="showRenameModal" />

    <!-- QR Scanner Modal -->
    <QrScannerModal v-model="showQrScannerModal" @scan="handleQrScanned" />

    <!-- Provide Event QR Modal for Mobile to Scan -->
    <MobileQrModal v-model="showEventQrModal" :invite-code="selectedQrInviteCode" />
  </div>
</template>

<style scoped src="./DashboardView.css"></style>

