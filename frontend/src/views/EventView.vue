<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, watch, computed } from 'vue'
import { useRoute, useRouter, onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { useEventStore } from '@/stores/events'
import { useRecordStore } from '@/stores/records'
import { useConnectionStore } from '@/stores/connection'
import { useNavigationStore, type EventTab } from '@/stores/navigation'
import { useInboxStore } from '@/stores/inbox'
import { usePitScoutStore } from '@/stores/pitScout'
import { useScheduleStore } from '@/stores/schedule'
import { flushOfflinePhotos, isDesktopHost } from '@/services/photoStorage'
import { useI18n } from 'vue-i18n'
import type { ScoutingRecord } from '@/types'
import ConnectionStatus from '@/components/common/ConnectionStatus.vue'
import ScoutingForm from '@/components/scouting/ScoutingForm.vue'
import PitScoutView from '@/components/pit/PitScoutView.vue'
import RankingsTable from '@/components/rankings/RankingsTable.vue'
import HistoryList from '@/components/history/HistoryList.vue'
import AiChatView from '@/components/ai/AiChatView.vue'
import AiCopilotDock from '@/components/ai/AiCopilotDock.vue'
import AiSettingsModal from '@/components/ai/AiSettingsModal.vue'
import { useAiStore } from '@/stores/ai'
import EventScoutsPanel from '@/components/scouting/EventScoutsPanel.vue'
import ScheduleManager from '@/components/schedule/ScheduleManager.vue'
import TacticalWhiteboardView from '@/components/whiteboard/TacticalWhiteboardView.vue'
import SasVerificationModal from '@/components/common/SasVerificationModal.vue'
import SessionConflictModal from '@/components/common/SessionConflictModal.vue'
import TakeoverPromptModal from '@/components/common/TakeoverPromptModal.vue'
import RenameModal from '@/components/common/RenameModal.vue'
import OfflineSyncModal from '@/components/common/OfflineSyncModal.vue'
import MobileQrModal from '@/components/common/MobileQrModal.vue'
import MobileBottomNav from '@/components/common/MobileBottomNav.vue'
import MobileStatusPill from '@/components/common/MobileStatusPill.vue'
import MobilePhaseWizardForm from '@/components/scouting/mobile/MobilePhaseWizardForm.vue'
import { useIsMobile, isMobileDevice } from '@/composables/useIsMobile'
import { useUserProfileTransition } from '@/composables/useUserProfileTransition'
import { hasDesktopTitleBar } from '@/utils/desktopShell'
import { transitionState } from '@/utils/transitionState'
import { useToastStore } from '@/stores/toast'
import { useEventWebRtcBridge } from './useEventWebRtcBridge'
import { useEventTransitions } from './useEventTransitions'

const { isMobile } = useIsMobile()
const inDesktopShell = hasDesktopTitleBar()

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const eventStore = useEventStore()
const recordStore = useRecordStore()
const toastStore = useToastStore()

const activeScoutTask = ref<{ matchNumber: number; teamNumber: number; allianceColor: 'red' | 'blue'; tournamentLevel?: string } | null>(null)
const activeWhiteboardMatch = ref<{ matchNumber: number; tournamentLevel?: string } | null>(null)

function handleStartScouting(task: { matchNumber: number; teamNumber: number; allianceColor: 'red' | 'blue'; tournamentLevel?: string }) {
  activeScoutTask.value = task
  switchTab('scout')
}

function handleOpenWhiteboard(match: { matchNumber: number; tournamentLevel?: string }) {
  activeWhiteboardMatch.value = match
  switchTab('whiteboard')
}
const connStore = useConnectionStore()
const navStore = useNavigationStore()
const inboxStore = useInboxStore()
const pitStore = usePitScoutStore()
const scheduleStore = useScheduleStore()
const aiStore = useAiStore()
const { t } = useI18n()

const showRenameModal = ref(false)
const showOfflineSyncModal = ref(false)
const showMobileQrModal = ref(false)
const { openProfileModal } = useUserProfileTransition()
function handleOpenRenameModal(e?: MouseEvent) {
  const triggerEl = (e?.currentTarget as HTMLElement | null) ?? null
  openProfileModal((val) => {
    showRenameModal.value = val
  }, triggerEl)
}

// Entrance animation and layout refs
const headerRef = ref<HTMLElement | null>(null)
const tabBarRef = ref<HTMLElement | null>(null)
const contentRef = ref<HTMLElement | null>(null)

const eventId = computed(() => (route.params.eventId as string) || '')

// Compute event synchronously from currentEvent or loaded events for smooth view-transitions
const event = computed(() => {
  if (eventStore.currentEvent?.id === eventId.value) {
    return eventStore.currentEvent
  }
  return eventStore.events.find((e) => e.id === eventId.value) || null
})

const isHost = computed(() => {
  return eventStore.isHost
})

const state = reactive({
  loading: true,
  error: null as Error | null
})

const {
  initEventCrdt,
  disposeEventCrdtSession,
  setupWebRTC,
  cleanupWebRTC,
  handleBeforeUnload
} = useEventWebRtcBridge({
  eventId,
  event,
  router,
  t
})

const {
  activeTab,
  tabs,
  switchTab,
  restorePosition,
  saveLeavePosition
} = useEventTransitions({
  route,
  router,
  eventId,
  contentRef,
  isMobile,
  t
})

const workspaceRef = ref<HTMLElement | null>(null)

function syncWorkspaceTopOffset() {
  if (typeof document === 'undefined' || !workspaceRef.value) return
  const topPx = Math.max(0, Math.round(workspaceRef.value.getBoundingClientRect().top))
  document.documentElement.style.setProperty('--ai-dock-top-offset', `${topPx}px`)
}

function handleCopilotHotkeys(e: KeyboardEvent) {
  if (isMobile.value) return
  if (e.altKey && (e.key === 'i' || e.key === 'I')) {
    e.preventDefault()
    aiStore.toggleDock()
  }
}

function handleAiBeforeUnload() {
  void aiStore.flushPendingSaves(undefined, true)
  handleBeforeUnload()
}

onMounted(async () => {
  if (!userStore.isLoggedIn) {
    router.replace('/')
    return
  }

  eventStore.restoreFromCache()
  try {
    state.loading = true
    let evt = eventStore.events.find((e) => e.id === eventId.value)
    if (!evt && eventStore.currentEvent?.id === eventId.value) {
      evt = eventStore.currentEvent
    }
    if (!evt) {
      await eventStore.fetchEvents(userStore.userId)
      evt = eventStore.events.find((e) => e.id === eventId.value)
    }
    if (!evt && /^(evt-|ext_)/i.test(eventId.value)) {
      const code = eventId.value.replace(/^(evt-|ext_)/i, '')
      evt = {
        id: eventId.value,
        name: `Event ${code.toUpperCase()}`,
        inviteCode: code.toUpperCase(),
        hostId: 'remote-host'
      }
      eventStore.events.push(evt)
    }

    if (evt) {
      eventStore.setCurrentEvent(evt)
    } else {
      router.replace('/dashboard')
      return
    }
  } catch (e: any) {
    state.error = e
  } finally {
    state.loading = false
  }

  // Load records, tags, schedule and pit data
  const evt = event.value
  if (evt) {
    await Promise.all([
      recordStore.fetchRecords(eventId.value, evt.ftcYear, evt.ftcEventCode),
      recordStore.fetchTags(eventId.value),
      scheduleStore.loadSchedule(eventId.value),
      pitStore.fetchPitData(eventId.value)
    ])
  }

  await initEventCrdt()

  const savedPos = navStore.getEventPosition(eventId.value)
  if (savedPos) {
    restorePosition(savedPos)
  } else if (route.query.tab) {
    const tabQuery = route.query.tab as string
    if (['scout', 'pit', 'schedule', 'whiteboard', 'rankings', 'history', 'scouts', 'ai'].includes(tabQuery)) {
      if (tabQuery === 'ai' && !isMobile.value) {
        aiStore.setDockOpen(true)
        activeTab.value = 'rankings'
      } else {
        activeTab.value = tabQuery as EventTab
      }
    }
  }

  // Set up WebRTC
  setupWebRTC()

  if (evt) {
    pitStore.flushPendingPitRecords(evt.id)
    flushOfflinePhotos(evt.id)
  }

  window.addEventListener('beforeunload', handleAiBeforeUnload)
  window.addEventListener('keydown', handleCopilotHotkeys)
  window.addEventListener('resize', syncWorkspaceTopOffset)
  syncWorkspaceTopOffset()
  void aiStore.fetchProfiles()
})

let navigatingToTeamDetail = false

onUnmounted(() => {
  window.removeEventListener('beforeunload', handleAiBeforeUnload)
  window.removeEventListener('keydown', handleCopilotHotkeys)
  window.removeEventListener('resize', syncWorkspaceTopOffset)
  document.documentElement.style.setProperty('--ai-dock-right-offset', '0px')
  void aiStore.flushPendingSaves()
  if (!navigatingToTeamDetail) {
    cleanupWebRTC()
    void disposeEventCrdtSession()
  }
})

watch(
  () => route.query,
  (newQuery) => {
    if (newQuery.tab && ['scout', 'pit', 'schedule', 'whiteboard', 'rankings', 'history', 'scouts', 'ai'].includes(newQuery.tab as string)) {
      if (newQuery.tab === 'ai' && !isMobile.value) {
        aiStore.setDockOpen(true)
      } else {
        activeTab.value = newQuery.tab as EventTab
      }
    }
  }
)

watch(
  [() => connStore.isCongested, () => connStore.isStandbyHost],
  () => {
    setTimeout(syncWorkspaceTopOffset, 0)
  }
)

onBeforeRouteLeave((to) => {
  if (to.name === 'team-detail' && to.params.eventId === eventId.value) {
    navigatingToTeamDetail = true
    saveLeavePosition(to.params.teamNumber ? Number(to.params.teamNumber) : null)
  } else {
    navigatingToTeamDetail = false
    cleanupWebRTC()
    void disposeEventCrdtSession()
    if (to.name !== 'team-detail') {
      eventStore.setCurrentEvent(null)
    }
  }
})

onBeforeRouteUpdate((to, from) => {
  if (to.params.eventId !== from.params.eventId) {
    const fromIdUpper = typeof from.params.eventId === 'string' ? from.params.eventId.trim().toUpperCase() : ''
    const codeUpper = eventStore.currentEvent?.inviteCode?.trim().toUpperCase() || ''
    const isPlaceholderPromotion = Boolean(
      eventStore.currentEvent &&
      eventStore.currentEvent.id === to.params.eventId &&
      fromIdUpper &&
      codeUpper &&
      (fromIdUpper === `EVT-${codeUpper}` || fromIdUpper === `EXT_${codeUpper}`)
    )
    if (isPlaceholderPromotion) {
      console.log('[EventView] Skipping WebRTC cleanup during placeholder promotion')
      return
    }
    cleanupWebRTC()
    void disposeEventCrdtSession()
    eventStore.setCurrentEvent(null)
  }
})

const editingRecord = ref<any | null>(null)

function handleEditRecord(record: any) {
  editingRecord.value = record
  activeTab.value = 'scout'
}

async function goBack() {
  cleanupWebRTC()
  await disposeEventCrdtSession()
  eventStore.setCurrentEvent(null)
  if (event.value) {
    transitionState.startSharedTransition(`event-card-${event.value.id}`)
  }
  router.push('/dashboard')
}

async function onRecordSubmitted(recordOrRecords: ScoutingRecord | ScoutingRecord[]) {
  const records = Array.isArray(recordOrRecords) ? recordOrRecords : [recordOrRecords]

  for (const rec of records) {
    await recordStore.addRecord(rec)
  }

  editingRecord.value = null // clear edit state after submit
}

async function handleTakeoverHost() {
  if (isMobile.value || isMobileDevice() || !isDesktopHost()) return
  try {
    await connStore.takeoverHost()
  } catch (e: any) {
    console.error('[EventView] Failed to takeover host:', e)
    toastStore.showError(e?.message || t('event.takeover_failed'))
  }
}
</script>

<template>
  <div class="event-view">
    <!-- Mobile Floating Status Pill (Zero Topbar Mode) -->
    <MobileStatusPill
      v-if="isMobile"
      :event-name="event?.name"
      :invite-code="event?.inviteCode"
    />

    <!-- Header -->
    <header ref="headerRef" class="topbar" :style="{ viewTransitionName: 'event-topbar' }">
      <div class="topbar-left">
        <button class="btn-back" @click="goBack" style="display: flex; align-items: center; gap: 4px;">
          <span class="material-icons" style="font-size: 18px;">arrow_back</span>{{ t('event.back') }}
        </button>
        <img v-if="!inDesktopShell" src="/logo_60.png" srcset="/logo_30.png 1x, /logo_60.png 2x" alt="SP27" class="event-brand-logo" />
        <div class="event-title">
          <span class="event-name" :style="{ viewTransitionName: 'event-card-title' }">{{ event?.name ?? t('event.event') }}</span>
          <div class="event-meta-row" v-if="event">
            <span class="event-code">
              {{ t('event.code') }}: <strong>{{ event.inviteCode }}</strong>
              <button
                type="button"
                class="btn-inline-qr"
                @click="showMobileQrModal = true"
                :title="t('event.mobile_qr_title')"
              >
                <span class="material-icons" style="font-size: 15px; vertical-align: middle;">qr_code_2</span>
              </button>
              - {{ eventStore.isHost ? t('event.host') : t('event.client') }}
            </span>
            <span v-if="event.ftcEventCode" class="badge-ftc-bound" :title="t('event.ftc_bound_desc', { count: recordStore.officialMatches.length })">
              <span class="material-icons ftc-badge-icon">verified</span>
              FTC: <strong>{{ event.ftcEventCode }}</strong> ({{ event.ftcYear || 2026 }})
            </span>
            <span v-else-if="eventStore.isHost" class="badge-ftc-unbound" :title="t('event.ftc_unbound')">
              <span class="material-icons ftc-badge-icon">link_off</span>
              FTC: {{ t('event.ftc_unbound') }}
            </span>
          </div>
        </div>
      </div>
      <div class="topbar-right" :style="{ viewTransitionName: 'event-status' }">
        <button
          class="topbar-btn inbox-topbar-btn"
          @click="inboxStore.toggleOpen()"
          :title="t('inbox.title')"
        >
          <span class="material-icons" style="font-size: 18px; margin-right: 4px;">inbox</span>
          <span class="topbar-btn-text">{{ t('inbox.title') }}</span>
          <span v-if="inboxStore.unreadCount > 0" class="topbar-unread-badge">{{ inboxStore.unreadCount }}</span>
        </button>
        <button
          v-if="isHost"
          class="topbar-btn host-qr-btn"
          @click="showMobileQrModal = true"
          :title="t('event.mobile_qr_title')"
        >
          <span class="material-icons" style="font-size: 18px; margin-right: 4px;">qr_code_2</span>
          <span class="topbar-btn-text">{{ t('event.mobile_qr_btn') }}</span>
        </button>
        <button
          class="topbar-btn offline-sync-btn"
          @click="showOfflineSyncModal = true"
          :title="t('offline_sync.title')"
        >
          <span class="material-icons" style="font-size: 18px; margin-right: 4px;">usb</span>
          <span class="topbar-btn-text">{{ t('offline_sync.open_modal') }}</span>
        </button>
        <button
          class="user-tag-btn user-profile-btn"
          :class="{ 'is-profile-open': showRenameModal }"
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

        <!-- JetBrains-style Copilot & Config Capsule -->
        <div class="copilot-topbar-group" :class="{ active: aiStore.isDockOpen }">
          <button
            type="button"
            class="copilot-topbar-btn"
            @click="aiStore.toggleDock()"
            :title="`${t('ai.copilot_btn')} (Alt+I)`"
          >
            <span class="material-icons" style="font-size: 17px;">auto_awesome</span>
            <span class="topbar-btn-text">{{ t('ai.copilot_btn') }}</span>
            <span v-if="!aiStore.isDockOpen && aiStore.isAnyStreaming" class="copilot-stream-dot"></span>
          </button>
          <button
            type="button"
            class="copilot-settings-btn"
            @click="aiStore.openSettingsModal()"
            :title="t('ai.config_title')"
          >
            <span class="material-icons" style="font-size: 16px;">settings</span>
          </button>
        </div>

        <ConnectionStatus />
      </div>
    </header>

    <!-- Network Congestion Banner -->
    <div v-if="connStore.isCongested" class="congestion-banner">
      <span class="material-icons banner-icon">warning</span>
      <span>{{ t('connection.congested_banner') }}</span>
    </div>

    <!-- Standby Host Banner (Desktop only) -->
    <div v-if="!isMobile && connStore.isStandbyHost" class="standby-host-banner">
      <div class="standby-banner-left">
        <span class="material-icons standby-icon">sensors</span>
        <span class="standby-text">
          {{ t('event.standby_banner_desc') }}
        </span>
      </div>
      <button class="btn-takeover-host" :disabled="connStore.isTakingOver" @click="handleTakeoverHost">
        <span class="material-icons" style="font-size: 16px; margin-right: 4px;">offline_bolt</span>
        {{ connStore.isTakingOver ? t('event.taking_over') : t('event.takeover_as_host') }}
      </button>
    </div>

    <!-- Workspace Split: Left Main Stage + Right Persistent AI Copilot Dock -->
    <div ref="workspaceRef" class="event-workspace">
      <div class="event-main-stage">
        <!-- Tab Bar -->
        <nav ref="tabBarRef" class="tab-bar" :style="{ '--indicator-width': 100 / tabs.length + '%', viewTransitionName: 'event-tabs' }">
          <div 
            class="tab-indicator"
            :style="{ transform: `translateX(${tabs.findIndex((t) => t.key === activeTab) * 100}%)` }"
          ></div>
          <button
            v-for="tab in tabs"
            :key="tab.key"
            :data-tab="tab.key"
            class="tab-btn"
            :class="{ active: activeTab === tab.key }"
            @click="switchTab(tab.key)"
          >
            {{ tab.label }}
          </button>
        </nav>

        <!-- Tab Content -->
        <main ref="contentRef" class="tab-content" :style="{ viewTransitionName: 'event-content' }">
          <Transition 
            name="tab-brush" 
            mode="out-in"
          >
            <template v-if="activeTab === 'scout'">
              <MobilePhaseWizardForm
                v-if="isMobile"
                :event-id="eventId"
                :scout-id="userStore.userId"
                :scout-name="userStore.username"
                :edit-record="editingRecord"
                :assigned-task="activeScoutTask"
                @submit="onRecordSubmitted"
                @cancelEdit="editingRecord = null"
              />
              <ScoutingForm
                v-else
                :event-id="eventId"
                :scout-id="userStore.userId"
                :scout-name="userStore.username"
                :edit-record="editingRecord"
                :assigned-task="activeScoutTask"
                @submit="onRecordSubmitted"
                @cancelEdit="editingRecord = null"
              />
            </template>
            <PitScoutView
              v-else-if="activeTab === 'pit'"
              :event-id="eventId"
            />
            <ScheduleManager
              v-else-if="activeTab === 'schedule'"
              :event="event"
              :is-host="isHost"
              @startScouting="handleStartScouting"
              @openWhiteboard="handleOpenWhiteboard"
            />
            <TacticalWhiteboardView
              v-else-if="activeTab === 'whiteboard'"
              :event-id="eventId"
              :initial-match="activeWhiteboardMatch"
            />
            <RankingsTable
              v-else-if="activeTab === 'rankings'"
              :rankings="recordStore.rankings"
              :loading="recordStore.loading"
            />
            <HistoryList
              v-else-if="activeTab === 'history'"
              :records="eventStore.isHost ? recordStore.activeRecords : recordStore.myRecords(userStore.userId)"
              :loading="recordStore.loading"
              @editRecord="handleEditRecord"
            />
            <AiChatView v-else-if="activeTab === 'ai'" :event-id="route.params.eventId as string" />
            <EventScoutsPanel v-else-if="activeTab === 'scouts'" :event="event" />
          </Transition>
        </main>
      </div>

      <AiCopilotDock v-if="!isMobile && eventId" :event-id="eventId" />
    </div>

    <AiSettingsModal />
    <SasVerificationModal />
    <SessionConflictModal />
    <TakeoverPromptModal />
    <RenameModal v-model:visible="showRenameModal" :event-id="event?.id" />
    <OfflineSyncModal v-model:visible="showOfflineSyncModal" :event-id="event?.id" />
    <MobileQrModal
      v-if="event"
      v-model="showMobileQrModal"
      :invite-code="event.inviteCode"
    />
    <MobileBottomNav
      :active-tab="activeTab"
      :is-host="isHost"
      @update:active-tab="switchTab"
      @open-rename="handleOpenRenameModal"
      @open-qr="showMobileQrModal = true"
      @open-offline-sync="showOfflineSyncModal = true"
      @exit-event="goBack"
    />
  </div>
</template>

<style scoped src="./EventView.css"></style>
