<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, watch, computed, nextTick } from 'vue'
import { useRoute, useRouter, onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { useEventStore } from '@/stores/events'
import { useRecordStore } from '@/stores/records'
import { useConnectionStore } from '@/stores/connection'
import { useNavigationStore, type EventTab } from '@/stores/navigation'
import { useI18n } from 'vue-i18n'
import type { ScoutingRecord } from '@/types'
import ConnectionStatus from '@/components/common/ConnectionStatus.vue'
import ScoutingForm from '@/components/scouting/ScoutingForm.vue'
import PitScoutView from '@/components/pit/PitScoutView.vue'
import RankingsTable from '@/components/rankings/RankingsTable.vue'
import HistoryList from '@/components/history/HistoryList.vue'
import AiChatView from '@/components/ai/AiChatView.vue'
import EventScoutsPanel from '@/components/scouting/EventScoutsPanel.vue'
import ScheduleManager from '@/components/schedule/ScheduleManager.vue'
import SessionConflictModal from '@/components/common/SessionConflictModal.vue'
import TakeoverPromptModal from '@/components/common/TakeoverPromptModal.vue'
import RenameModal from '@/components/common/RenameModal.vue'
import OfflineSyncModal from '@/components/common/OfflineSyncModal.vue'
import MobileQrModal from '@/components/common/MobileQrModal.vue'
import MobileBottomNav from '@/components/common/MobileBottomNav.vue'
import { syncRecords } from '@/services/api'
import { transitionState } from '@/utils/transitionState'
import { useEventWebRtcBridge } from './useEventWebRtcBridge'
import { useEventTransitions } from './useEventTransitions'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const eventStore = useEventStore()
const recordStore = useRecordStore()

const activeScoutTask = ref<{ matchNumber: number; teamNumber: number; allianceColor: 'red' | 'blue' } | null>(null)

function handleStartScouting(task: { matchNumber: number; teamNumber: number; allianceColor: 'red' | 'blue' }) {
  activeScoutTask.value = task
  switchTab('scout')
}
const connStore = useConnectionStore()
const navStore = useNavigationStore()
const { t } = useI18n()

const showRenameModal = ref(false)
const showOfflineSyncModal = ref(false)
const showMobileQrModal = ref(false)
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
  return Boolean(event.value?.hostId && userStore.userId && event.value.hostId === userStore.userId) || eventStore.isHost
})

const state = reactive({
  loading: true,
  error: null as Error | null
})

const {
  initHostSeqCounter,
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
  t
})

onMounted(async () => {
  if (!userStore.isLoggedIn) {
    router.replace('/')
    return
  }

  try {
    state.loading = true
    let evt = eventStore.events.find((e) => e.id === eventId.value)
    if (!evt) {
      await eventStore.fetchEvents(userStore.userId)
      evt = eventStore.events.find((e) => e.id === eventId.value)
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

  // Load records and tags
  const evt = event.value
  if (evt) {
    await Promise.all([
      recordStore.fetchRecords(eventId.value, evt.ftcYear, evt.ftcEventCode),
      recordStore.fetchTags(eventId.value)
    ])
  }

  initHostSeqCounter()

  const savedPos = navStore.getEventPosition(eventId.value)
  if (savedPos) {
    restorePosition(savedPos)
  } else if (route.query.tab) {
    const tabQuery = route.query.tab as string
    if (['scout', 'pit', 'schedule', 'rankings', 'history', 'scouts', 'ai'].includes(tabQuery)) {
      activeTab.value = tabQuery as EventTab
    }
  }

  // Set up WebRTC
  setupWebRTC()

  if (eventStore.isHost) {
    window.addEventListener('beforeunload', handleBeforeUnload)
  }
})

let navigatingToTeamDetail = false

onUnmounted(() => {
  if (eventStore.isHost) {
    window.removeEventListener('beforeunload', handleBeforeUnload)
  }
  if (!navigatingToTeamDetail) {
    cleanupWebRTC()
  }
})

watch(
  () => route.query,
  (newQuery) => {
    if (newQuery.tab && ['scout', 'pit', 'schedule', 'rankings', 'history', 'scouts', 'ai'].includes(newQuery.tab as string)) {
      activeTab.value = newQuery.tab as EventTab
    }
  }
)

onBeforeRouteLeave((to) => {
  if (to.name === 'team-detail' && to.params.eventId === eventId.value) {
    navigatingToTeamDetail = true
    saveLeavePosition(to.params.teamNumber ? Number(to.params.teamNumber) : null)
  } else {
    navigatingToTeamDetail = false
    cleanupWebRTC()
  }
})

onBeforeRouteUpdate((to, from) => {
  if (to.params.eventId !== from.params.eventId) {
    cleanupWebRTC()
  }
})

const editingRecord = ref<any | null>(null)
const isViewTransitionSupported = typeof document !== 'undefined' && 'startViewTransition' in document

function handleEditRecord(record: any) {
  editingRecord.value = record
  activeTab.value = 'scout'
}

async function goBack() {
  cleanupWebRTC()
  if (event.value) {
    transitionState.startSharedTransition(`event-card-${event.value.id}`)
  }
  router.push('/dashboard')
}

async function onRecordSubmitted(recordOrRecords: ScoutingRecord | ScoutingRecord[]) {
  const records = Array.isArray(recordOrRecords) ? recordOrRecords : [recordOrRecords]

  let anyOk = false
  const allToPush: ScoutingRecord[] = []

  for (const rec of records) {
    const { success, recordsToPush } = await recordStore.addRecord(rec)
    if (success) anyOk = true
    if (recordsToPush && recordsToPush.length > 0) {
      allToPush.push(...recordsToPush)
    }
  }

  if (anyOk && allToPush.length > 0) {
    // 按 id 严格去重，避免重复引用导致同一条记录多次自增 hostSeq
    const deduplicatedRecords = Array.from(new Map(allToPush.map((r) => [r.id, r])).values())
    // Host 本地写入也要打 hostSeq 并持久化落库，确保重启后单调递增及 Client 重连能增量同步
    if (eventStore.isHost) {
      connStore.stampHostSeq(deduplicatedRecords)
      try {
        await syncRecords(deduplicatedRecords)
      } catch (e) {
        console.error('[EventView] Failed to sync stamped records to DB:', e)
      }
    }
    connStore.pushIfNeeded(deduplicatedRecords)
  }
  editingRecord.value = null // clear edit state after submit
}
</script>

<template>
  <div class="event-view">
    <!-- Header -->
    <header ref="headerRef" class="topbar" :style="{ viewTransitionName: 'event-topbar' }">
      <div class="topbar-left">
        <button class="btn-back" @click="goBack" style="display: flex; align-items: center; gap: 4px;">
          <span class="material-icons" style="font-size: 18px;">arrow_back</span>{{ t('event.back') }}
        </button>
        <div class="event-title">
          <span class="event-name" :style="{ viewTransitionName: 'event-card-title' }">{{ event?.name ?? t('event.event') }}</span>
          <div class="event-meta-row" v-if="event">
            <span class="event-code">
              {{ t('event.code') }}: <strong>{{ event.inviteCode }}</strong>
              - {{ eventStore.isHost ? t('event.host') : t('event.client') }}
            </span>
            <span v-if="event.ftcEventCode" class="badge-ftc-bound" :title="t('event.ftc_bound_desc', { count: recordStore.officialMatches.length })">
              <span class="material-icons ftc-badge-icon">verified</span>
              FTC: <strong>{{ event.ftcEventCode }}</strong> ({{ event.ftcYear || 2025 }})
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
          v-if="eventStore.isHost"
          class="user-tag-btn host-qr-btn"
          @click="showMobileQrModal = true"
          :title="t('event.mobile_qr_title')"
        >
          <span class="material-icons" style="font-size: 18px; margin-right: 4px;">qr_code_2</span>
          <span class="username-text">{{ t('event.mobile_qr_btn') }}</span>
        </button>
        <button
          class="user-tag-btn"
          @click="showOfflineSyncModal = true"
          :title="t('offline_sync.title')"
        >
          <span class="material-icons" style="font-size: 18px; margin-right: 4px;">usb</span>
          <span class="username-text">{{ t('offline_sync.open_modal') }}</span>
        </button>
        <button
          class="user-tag-btn"
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
        <ConnectionStatus />
      </div>
    </header>

    <!-- Network Congestion Banner -->
    <div v-if="connStore.isCongested" class="congestion-banner">
      <span class="material-icons banner-icon">warning</span>
      <span>{{ t('connection.congested_banner') }}</span>
    </div>

    <!-- Tab Bar -->
    <nav ref="tabBarRef" class="tab-bar" :style="{ '--indicator-width': 100 / tabs.length + '%', viewTransitionName: 'event-tabs' }">
      <div 
        class="tab-indicator"
        :style="{ transform: `translateX(${tabs.findIndex((t) => t.key === activeTab) * 100}%)` }"
      ></div>
      <button
        v-for="tab in tabs"
        :key="tab.key"
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
        :mode="isViewTransitionSupported ? undefined : 'out-in'"
        :css="!isViewTransitionSupported"
      >
        <ScoutingForm
          v-if="activeTab === 'scout'"
          :event-id="eventId"
          :scout-id="userStore.userId"
          :scout-name="userStore.username"
          :edit-record="editingRecord"
          :assigned-task="activeScoutTask"
          @submit="onRecordSubmitted"
          @cancelEdit="editingRecord = null"
        />
        <PitScoutView
          v-else-if="activeTab === 'pit'"
          :event-id="eventId"
        />
        <ScheduleManager
          v-else-if="activeTab === 'schedule'"
          :event="event"
          :is-host="isHost"
          @startScouting="handleStartScouting"
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

    <SessionConflictModal />
    <TakeoverPromptModal />
    <RenameModal v-model:visible="showRenameModal" :event-id="event?.id" />
    <OfflineSyncModal v-model:visible="showOfflineSyncModal" :event-id="event?.id" />
    <MobileQrModal
      v-if="eventStore.isHost && event"
      v-model="showMobileQrModal"
      :invite-code="event.inviteCode"
    />
    <MobileBottomNav :active-tab="activeTab" @update:active-tab="switchTab" />
  </div>
</template>

<style scoped src="./EventView.css"></style>
