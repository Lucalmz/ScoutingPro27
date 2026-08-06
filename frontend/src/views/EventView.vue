<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { useEventStore } from '@/stores/events'
import { useRecordStore } from '@/stores/records'
import { useConnectionStore } from '@/stores/connection'
import { createWebRtcService } from '@/services/webrtc'
import { useI18n } from 'vue-i18n'
import type { ScoutingRecord, ScoutingEvent } from '@/types'
import ConnectionStatus from '@/components/common/ConnectionStatus.vue'
import ScoutingForm from '@/components/scouting/ScoutingForm.vue'
import RankingsTable from '@/components/rankings/RankingsTable.vue'
import HistoryList from '@/components/history/HistoryList.vue'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const eventStore = useEventStore()
const recordStore = useRecordStore()
const connStore = useConnectionStore()
const { t } = useI18n()

const activeTab = ref<'scout' | 'rankings' | 'history'>('scout')
const tabs = computed(() => [
  { key: 'scout' as const, label: t('event.tab_scout') },
  { key: 'rankings' as const, label: t('event.tab_rankings') },
  { key: 'history' as const, label: t('event.tab_history') },
])

const eventId = computed(() => route.params.eventId as string)
const event = computed(() => eventStore.currentEvent)

onMounted(async () => {
  if (!userStore.isLoggedIn) {
    router.replace('/')
    return
  }

  // Find event in store
  const evt = eventStore.events.find((e) => e.id === eventId.value)
  if (evt) {
    eventStore.setCurrentEvent(evt)
  } else if (eventId.value === 'joined') {
    // Joined via invite - current event already set
  } else {
    router.replace('/dashboard')
    return
  }

  // Load records
  await recordStore.fetchRecords(eventId.value)

  // Set up WebRTC
  setupWebRTC()
})

onUnmounted(() => {
  connStore.rtcService?.disconnect()
  connStore.setRtcService(null)
})

async function setupWebRTC() {
  const evt = eventStore.currentEvent
  if (!evt) return

  const rtc = createWebRtcService({
    onStatusChange: (s) => connStore.setStatus(s),
    onRecordsReceived: async (records: ScoutingRecord[], senderId?: string) => {
      await recordStore.bulkSync(records)
    },
    onAckReceived: (ids: string[]) => {
      recordStore.markSynced(ids)
    },
    onRequestSync: (lastSyncTime: string, senderId?: string) => {
      // The peer requested sync, send all records we have
      const recordsToSync = recordStore.records
      if (recordsToSync.length > 0) {
        connStore.pushRecords(recordsToSync, senderId)
      }
    }
  })

  connStore.setRtcService(rtc)

  try {
    if (evt.isHost) {
      await rtc.host(evt.inviteCode)
    } else {
      await rtc.join(evt.inviteCode)
    }
  } catch {
    // WebRTC may not always succeed; app remains usable offline
    connStore.setStatus('offline')
  }
}

watch(() => connStore.status, (status) => {
  const evt = eventStore.currentEvent
  if (status === 'connected' && evt && !evt.isHost) {
    // Client connected, request sync for new records
    connStore.requestSync(new Date(0).toISOString())
  }
})

const editingRecord = ref<ScoutingRecord | null>(null)

function handleEditRecord(record: ScoutingRecord) {
  editingRecord.value = record
  activeTab.value = 'scout'
}

async function onRecordSubmitted(recordOrRecords: ScoutingRecord | ScoutingRecord[]) {
  const records = Array.isArray(recordOrRecords) ? recordOrRecords : [recordOrRecords]
  
  let anyOk = false
  for (const rec of records) {
    const ok = await recordStore.addRecord(rec)
    if (ok) anyOk = true
  }

  if (anyOk && connStore.isConnected) {
    connStore.pushRecords(records)
  }
  editingRecord.value = null // clear edit state after submit
}

function goBack() {
  connStore.rtcService?.disconnect()
  connStore.setRtcService(null)
  eventStore.setCurrentEvent(null)
  router.push('/dashboard')
}
</script>

<template>
  <div class="event-view">
    <!-- Header -->
    <header class="topbar">
      <div class="topbar-left">
        <button class="btn-back" @click="goBack" style="display: flex; align-items: center; gap: 4px;"><span class="material-icons" style="font-size: 18px;">arrow_back</span>{{ t('event.back') }}</button>
        <div class="event-title">
          <span class="event-name">{{ event?.name ?? t('event.event') }}</span>
          <span v-if="event" class="event-code">
            {{ t('event.code') }}: <strong>{{ event.inviteCode }}</strong>
            - {{ event.isHost ? t('event.host') : t('event.client') }}
          </span>
        </div>
      </div>
      <div class="topbar-right">
        <ConnectionStatus />
      </div>
    </header>

    <!-- Tab Bar -->
    <nav class="tab-bar">
      <div 
        class="tab-indicator"
        :style="{ transform: `translateX(${tabs.findIndex(t => t.key === activeTab) * 100}%)` }"
      ></div>
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab-btn"
        :class="{ active: activeTab === tab.key }"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
      </button>
    </nav>

    <!-- Tab Content -->
    <main class="tab-content">
      <Transition name="fade" mode="out-in">
        <ScoutingForm
          v-if="activeTab === 'scout'"
          :event-id="eventId"
          :scout-id="userStore.userId"
          :scout-name="userStore.username"
          :edit-record="editingRecord"
          @submit="onRecordSubmitted"
        />
        <RankingsTable
          v-else-if="activeTab === 'rankings'"
          :rankings="recordStore.rankings"
          :loading="recordStore.loading"
        />
        <HistoryList
          v-else-if="activeTab === 'history'"
          :records="recordStore.myRecords(userStore.userId)"
          :loading="recordStore.loading"
          @editRecord="handleEditRecord"
        />
      </Transition>
    </main>
  </div>
</template>

<style scoped>
.event-view {
  min-height: 100vh;
  background: var(--background);
  color: var(--foreground);
  display: flex;
  flex-direction: column;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 24px;
  background: var(--card);
  border-bottom: 1px solid var(--border);
}

.topbar-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.btn-back {
  background: var(--border);
  border: none;
  color: var(--muted-foreground);
  padding: 8px 14px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
}

.btn-back:hover {
  background: var(--input);
}

.event-title {
  display: flex;
  flex-direction: column;
}

.event-name {
  font-weight: 700;
  font-size: 16px;
}

.event-code {
  font-size: 12px;
  color: var(--muted-foreground);
}

/* Tab Bar */
.tab-bar {
  display: flex;
  background: var(--card);
  border-bottom: 2px solid var(--border);
  position: relative;
}

.tab-indicator {
  position: absolute;
  bottom: -2px;
  left: 0;
  width: 33.333%;
  height: 3px;
  background: var(--primary);
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  z-index: 1;
}

.tab-btn {
  flex: 1;
  padding: 14px 0;
  background: none;
  border: none;
  color: var(--muted-foreground);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  z-index: 2;
  transition: color 0.15s;
}

.tab-btn:hover {
  color: var(--foreground);
}

.tab-btn.active {
  color: var(--primary);
}

/* Tab Content */
.tab-content {
  flex: 1;
  padding: 24px;
  overflow-y: auto;
}
</style>

