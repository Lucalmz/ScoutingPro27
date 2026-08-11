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
import { updateEventFtcConfig } from '@/services/api'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const eventStore = useEventStore()
const recordStore = useRecordStore()
const connStore = useConnectionStore()
const { t } = useI18n()

const activeTab = ref<'scout' | 'rankings' | 'history' | 'scouts'>('scout')
const tabs = computed(() => {
  const baseTabs: Array<{ key: 'scout' | 'rankings' | 'history' | 'scouts', label: string }> = [
    { key: 'scout' as const, label: t('event.tab_scout') },
    { key: 'rankings' as const, label: t('event.tab_rankings') },
    { key: 'history' as const, label: t('event.tab_history') },
  ]
  if (eventStore.isHost) {
    baseTabs.push({ key: 'scouts' as const, label: 'Scouts' })
  }
  return baseTabs
})

const eventId = computed(() => route.params.eventId as string)
const event = computed(() => eventStore.currentEvent)

onMounted(async () => {
  if (!userStore.isLoggedIn) {
    router.replace('/')
    return
  }

  // Find event in store
  let evt = eventStore.events.find((e) => e.id === eventId.value)
  if (!evt) {
    await eventStore.fetchEvents(userStore.userId)
    evt = eventStore.events.find((e) => e.id === eventId.value)
    if (!evt) {
      router.replace('/dashboard')
      return
    }
  }

  eventStore.setCurrentEvent(evt)

  // Load records
  await recordStore.fetchRecords(eventId.value, evt.ftcYear, evt.ftcEventCode)

  if (route.query.tab === 'history') {
    activeTab.value = 'history'
  }

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
    },
    onClientConnected: (userId: string, userName: string) => {
      connStore.addConnectedScout(userId, userName)
    }
  })

  connStore.setRtcService(rtc)

  try {
    if (eventStore.isHost) {
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
  if (status === 'connected' && evt && !eventStore.isHost) {
    // Client connected, request sync for new records
    connStore.requestSync(new Date(0).toISOString(), undefined, userStore.userId, userStore.username)
    
    // Push ALL my records to the host to ensure the host has them
    // (in case they were submitted while WebRTC was disconnected)
    const myRecs = recordStore.myRecords(userStore.userId)
    if (myRecs.length > 0) {
      connStore.pushRecords(myRecs)
    }
  }
})

watch(() => route.query, (newQuery) => {
  if (newQuery.tab === 'history') {
    activeTab.value = 'history'
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
  const allToPush: ScoutingRecord[] = []
  
  for (const rec of records) {
    const { success, recordsToPush } = await recordStore.addRecord(rec)
    if (success) anyOk = true
    if (recordsToPush && recordsToPush.length > 0) {
      allToPush.push(...recordsToPush)
    }
  }

  if (anyOk) {
    connStore.pushIfNeeded(allToPush)
  }
  editingRecord.value = null // clear edit state after submit
}

function goBack() {
  connStore.rtcService?.disconnect()
  connStore.setRtcService(null)
  connStore.clearConnectedScouts()
  eventStore.setCurrentEvent(null)
  router.push('/dashboard')
}

const uniqueScouts = computed(() => {
  const scouts = new Map<string, { id: string, name: string, recordCount: number }>()
  for (const r of recordStore.records) {
    if (!scouts.has(r.scoutId)) {
      scouts.set(r.scoutId, { id: r.scoutId, name: r.scoutName, recordCount: 0 })
    }
    scouts.get(r.scoutId)!.recordCount++
  }
  for (const s of connStore.connectedScouts) {
    if (!scouts.has(s.id)) {
      scouts.set(s.id, { id: s.id, name: s.name, recordCount: 0 })
    } else {
      scouts.get(s.id)!.name = s.name
    }
  }
  return Array.from(scouts.values())
})

function sendDirectMessage(scoutId: string) {
  if (connStore.rtcService?.sendDirectMessage) {
    const msg = prompt('Enter message to send:')
    if (msg) {
      connStore.rtcService.sendDirectMessage({ targetId: scoutId, title: 'Message from Host', body: msg })
    }
  } else {
    alert('Direct messaging not ready.')
  }
}

// --- FTC Config Settings ---
const settingsYear = ref(event.value?.ftcYear ?? 2025)
const settingsCode = ref(event.value?.ftcEventCode ?? '')
const isSavingSettings = ref(false)

async function saveEventSettings() {
  if (!event.value) return
  isSavingSettings.value = true
  try {
    await updateEventFtcConfig(event.value.id, settingsYear.value, settingsCode.value.trim())
    
    // Update local store
    event.value.ftcYear = settingsYear.value
    event.value.ftcEventCode = settingsCode.value.trim()
    
    // Re-fetch records/matches
    await recordStore.fetchRecords(event.value.id, event.value.ftcYear, event.value.ftcEventCode)
    
    alert('Settings saved and official matches synced successfully!')
  } catch (e: any) {
    alert('Failed to save settings: ' + (e.message || String(e)))
  } finally {
    isSavingSettings.value = false
  }
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
            - {{ eventStore.isHost ? t('event.host') : t('event.client') }}
          </span>
        </div>
      </div>
      <div class="topbar-right">
        <ConnectionStatus />
      </div>
    </header>

    <!-- Tab Bar -->
    <nav class="tab-bar" :style="{ '--indicator-width': 100 / tabs.length + '%' }">
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
          @cancelEdit="editingRecord = null"
        />
        <RankingsTable
          v-else-if="activeTab === 'rankings'"
          :rankings="recordStore.rankings"
          :loading="recordStore.loading"
        />
        <HistoryList
          v-else-if="activeTab === 'history'"
          :records="eventStore.isHost ? recordStore.records : recordStore.myRecords(userStore.userId)"
          :loading="recordStore.loading"
          @editRecord="handleEditRecord"
        />
        <div v-else-if="activeTab === 'scouts'">
          <div class="settings-panel">
            <h2>Event Settings</h2>
            <div class="settings-form">
              <div class="form-group">
                <label>FTC Season (Year)</label>
                <input type="number" v-model="settingsYear" :disabled="isSavingSettings" />
              </div>
              <div class="form-group">
                <label>Event Code</label>
                <input type="text" v-model="settingsCode" placeholder="e.g. CNCMPLB" :disabled="isSavingSettings" />
              </div>
              <button class="btn-primary" @click="saveEventSettings" :disabled="isSavingSettings">
                {{ isSavingSettings ? 'Saving...' : 'Save & Sync Official Data' }}
              </button>
            </div>
          </div>

          <h2>Scouts</h2>
          <ul class="scouts-list">
            <li v-for="s in uniqueScouts" :key="s.id" class="scout-item">
              <span class="scout-info">{{ s.name }} (Records: {{ s.recordCount }})</span>
              <button @click="sendDirectMessage(s.id)" class="btn-msg">Send Message</button>
            </li>
          </ul>
        </div>
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
  width: var(--indicator-width, 33.333%);
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

.scouts-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.scout-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 8px;
}

.scout-info {
  font-weight: 500;
}

.btn-msg {
  background: var(--primary);
  color: var(--primary-foreground);
  border: none;
  border-radius: 6px;
  padding: 6px 12px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
}

.btn-msg:hover {
  filter: brightness(1.1);
}

.settings-panel {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 24px;
}
.settings-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 12px;
}
.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.form-group label {
  font-size: 14px;
  font-weight: 500;
}
.form-group input {
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--input);
  color: var(--foreground);
}
.btn-primary {
  background: var(--primary);
  color: var(--primary-foreground);
  border: none;
  padding: 10px;
  border-radius: 6px;
  font-weight: 600;
  cursor: pointer;
  margin-top: 8px;
}
.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>

