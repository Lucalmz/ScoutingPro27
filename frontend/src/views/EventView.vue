<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, watch, computed, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { useEventStore } from '@/stores/events'
import { useRecordStore } from '@/stores/records'
import { useConnectionStore } from '@/stores/connection'
import { useInboxStore } from '@/stores/inbox'
import { createWebRtcService } from '@/services/webrtc'
import { useI18n } from 'vue-i18n'
import type { ScoutingRecord, ScoutingEvent } from '@/types'
import ConnectionStatus from '@/components/common/ConnectionStatus.vue'
import ScoutingForm from '@/components/scouting/ScoutingForm.vue'
import RankingsTable from '@/components/rankings/RankingsTable.vue'
import HistoryList from '@/components/history/HistoryList.vue'
import AiChatView from '@/components/ai/AiChatView.vue'
import { updateEventFtcConfig, syncRecords } from '@/services/api'
import { transitionState } from '@/utils/transitionState'
import { downloadCSV } from '@/utils/csvExport'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const eventStore = useEventStore()
const recordStore = useRecordStore()
const connStore = useConnectionStore()
const inboxStore = useInboxStore()
const { t } = useI18n()

// Entrance animation refs
const headerRef = ref<HTMLElement | null>(null)
const tabBarRef = ref<HTMLElement | null>(null)
const contentRef = ref<HTMLElement | null>(null)

const activeTab = ref<'scout' | 'rankings' | 'history' | 'scouts' | 'ai'>('scout')
const tabs = computed(() => {
  const baseTabs: Array<{ key: 'scout' | 'rankings' | 'history' | 'scouts' | 'ai', label: string }> = [
    { key: 'scout' as const, label: t('event.tab_scout') },
    { key: 'rankings' as const, label: t('event.tab_rankings') },
    { key: 'history' as const, label: t('event.tab_history') },
    { key: 'ai' as const, label: 'Chat with AI' },
  ]
  if (eventStore.isHost) {
    baseTabs.push({ key: 'scouts' as const, label: 'Scouts' })
  }
  return baseTabs
})

const eventId = computed(() => route.params.eventId as string)

// Compute the event synchronously from either currentEvent or the loaded events list
// This guarantees that the header text renders correctly on frame 0, which is critical 
// for the View Transitions shared element morph to capture the correct snapshot.
const event = computed(() => {
  if (eventStore.currentEvent?.id === eventId.value) {
    return eventStore.currentEvent
  }
  return eventStore.events.find((e) => e.id === eventId.value) || null
})

const state = reactive({
  loading: true,
  error: null as Error | null
})

// Client 端：持久化最后一次从 Host 收到的最大 hostSeq，用于重连后增量请求
// 按 eventId 分筒，避免不同赛事之间混淆
const lastHostSeqKey = computed(() => `sp27_lastHostSeq_${eventId.value}`)
const lastHostSeq = ref<number>(0)
watch(lastHostSeq, v => localStorage.setItem(lastHostSeqKey.value, String(v)))

function advanceLastHostSeq(incomingRecords: ScoutingRecord[]) {
  const validSeqs = incomingRecords
    .map(r => r.hostSeq)
    .filter((s): s is number => typeof s === 'number' && Number.isFinite(s) && s > 0)
  if (validSeqs.length > 0) {
    const maxIncoming = Math.max(...validSeqs)
    if (maxIncoming > lastHostSeq.value) {
      lastHostSeq.value = maxIncoming
    }
  }
}

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

  // Load records
  const evt = event.value
  if (evt) {
    await recordStore.fetchRecords(eventId.value, evt.ftcYear, evt.ftcEventCode)
  }

  // 计算数据库和内存中已持久化记录的最大 hostSeq
  const dbMaxSeq = recordStore.records.reduce((m, r) => Math.max(m, r.hostSeq || 0), 0)

  // Host：从已持久化记录的最大 hostSeq 恢复计数器，保证重启后单调递增
  if (eventStore.isHost) {
    connStore.initHostSeq(dbMaxSeq)
  } else {
    // Client：多层兜底初始化 lastHostSeq，防止本地缓存缺失导致游标归零
    const localStored = parseInt(localStorage.getItem(lastHostSeqKey.value) ?? '0') || 0
    lastHostSeq.value = Math.max(dbMaxSeq, localStored)
  }

  if (route.query.tab === 'history') {
    activeTab.value = 'history'
  }

  // Set up WebRTC
  setupWebRTC()
  
  if (eventStore.isHost) {
    window.addEventListener('beforeunload', handleBeforeUnload)
  }
})

onUnmounted(() => {
  if (eventStore.isHost) {
    window.removeEventListener('beforeunload', handleBeforeUnload)
  }
  connStore.rtcService?.disconnect()
  connStore.setRtcService(null)
})

function handleBeforeUnload() {
  if (eventStore.isHost) {
    connStore.rtcService?.disconnect()
  }
}

async function setupWebRTC() {
  const evt = eventStore.currentEvent
  if (!evt) return

  const rtc = createWebRtcService({
    onStatusChange: (s) => connStore.setStatus(s),

    // 返回真正被接受的记录，Host 端用此打 hostSeq + 广播
    onRecordsReceived: async (records: ScoutingRecord[], senderId?: string): Promise<ScoutingRecord[]> => {
      const accepted = await recordStore.bulkSync(records)
      if (!eventStore.isHost) {
        advanceLastHostSeq(records)
      }
      return accepted
    },

    // Host 回传的 ACK 内含 stamped 记录，Client 用此更新本地 hostSeq + lastHostSeq
    onAckReceived: (ids: string[], stampedRecords?: ScoutingRecord[], rejectedRecordIds?: string[]) => {
      const rejectedSet = new Set(rejectedRecordIds || [])
      const acceptedIds = ids.filter(id => !rejectedSet.has(id))
      if (acceptedIds.length > 0) {
        recordStore.markSynced(acceptedIds)
      }
      if (stampedRecords && stampedRecords.length > 0 && !eventStore.isHost) {
        for (const stamped of stampedRecords) {
          const local = recordStore.records.find(r => r.id === stamped.id)
          if (local && stamped.hostSeq) {
            local.hostSeq = stamped.hostSeq
          }
        }
        advanceLastHostSeq(stampedRecords)
      }
    },

    // Host 收到增量请求，根据 sinceVersion 过滤记录
    onRequestSync: (sinceVersion: number, senderId?: string) => {
      const recordsToSync = sinceVersion > 0
        ? recordStore.records.filter(r => (r.hostSeq || 0) > sinceVersion)
        : recordStore.records  // sinceVersion=0 → 全量同步（首次连接）
      if (recordsToSync.length > 0) {
        connStore.pushRecords(recordsToSync, senderId)
      }
    },

    onClientConnected: (userId: string, userName: string) => {
      connStore.addConnectedScout(userId, userName)
      if (connStore.rtcService) {
        inboxStore.flushOutbox(connStore.rtcService, userId)
      }
    }
  })

  connStore.setRtcService(rtc)
  if (typeof window !== 'undefined') {
    ;(window as any).__sendDirectMessage = (targetId: string, title: string, body: string) => {
      return inboxStore.sendDirectMessage({ targetId, title, body }, rtc)
    }
  }

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

watch(() => connStore.status, (status, oldStatus) => {
  const evt = eventStore.currentEvent
  console.log(`[EventView] connStore.status changed: ${oldStatus} -> ${status}`)
  
  if (status === 'connected' && evt) {
    if (connStore.rtcService) {
      inboxStore.flushOutbox(connStore.rtcService)
    }

    if (!eventStore.isHost) {
      // Client 连接／重连：用 lastHostSeq 做增量请求（=0 时全量）
      connStore.requestSync(lastHostSeq.value, undefined, userStore.userId, userStore.username, userStore.token)
      
      // 只推送本地尚未同步到 Host 的记录
      const myRecs = recordStore.myRecords(userStore.userId).filter(r => r.syncStatus === 'PENDING')
      if (myRecs.length > 0) {
        connStore.pushRecords(myRecs)
      }
    }
  }
})

watch(() => route.query, (newQuery) => {
  if (newQuery.tab === 'history') {
    activeTab.value = 'history'
  }
})

const editingRecord = ref<any | null>(null)

const isViewTransitionSupported = 'startViewTransition' in document

function handleEditRecord(record: any) {
  editingRecord.value = record
  activeTab.value = 'scout'
}

let currentTabTransition: any = null

function switchTab(newTabKey: any) {
  if (activeTab.value === newTabKey) return
  
  if (!document.startViewTransition) {
    activeTab.value = newTabKey as any
    return
  }
  
  if (currentTabTransition) {
    currentTabTransition.skipTransition()
  }
  
  const currentIndex = tabs.value.findIndex(t => t.key === activeTab.value)
  const newIndex = tabs.value.findIndex(t => t.key === newTabKey)
  const direction = newIndex > currentIndex ? 'slide-left' : 'slide-right'
  
  document.documentElement.dataset.transitionType = 'tab-switch'
  document.documentElement.dataset.tabDirection = direction
  document.documentElement.removeAttribute('data-direction')
  
  try {
    currentTabTransition = document.startViewTransition(() => {
      activeTab.value = newTabKey as any
      return nextTick()
    })
    
    currentTabTransition.finished.finally(() => {
      currentTabTransition = null
      document.documentElement.removeAttribute('data-transition-type')
      document.documentElement.removeAttribute('data-tab-direction')
    })
  } catch (e) {
    activeTab.value = newTabKey as any
    document.documentElement.removeAttribute('data-transition-type')
    document.documentElement.removeAttribute('data-tab-direction')
  }
}

async function goBack() {


  connStore.rtcService?.disconnect()
  connStore.setRtcService(null)
  connStore.clearConnectedScouts()
  
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
    const deduplicatedRecords = Array.from(new Map(allToPush.map(r => [r.id, r])).values())
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

async function sendDirectMessage(scoutId: string, scoutName?: string) {
  if (connStore.rtcService) {
    const msg = prompt(`Enter message to send to ${scoutName || scoutId}:`)
    if (msg) {
      await inboxStore.sendDirectMessage(
        { targetId: scoutId, targetName: scoutName, title: 'Message from Host', body: msg },
        connStore.rtcService
      )
    }
  } else {
    alert('Direct messaging not ready.')
  }
}

// --- FTC Config Settings ---
const settingsYear = ref(event.value?.ftcYear ?? 2025)
const settingsCode = ref(event.value?.ftcEventCode ?? '')
const isSavingSettings = ref(false)

watch(event, (newVal) => {
  if (newVal) {
    if (newVal.ftcYear) settingsYear.value = newVal.ftcYear
    if (newVal.ftcEventCode) settingsCode.value = newVal.ftcEventCode
  }
}, { immediate: true })

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

// --- Data Export ---
function exportRankingsCSV() {
  const headers = ['Team', 'Matches', 'Breakdown Count', 'Avg Auto', 'Avg Teleop', 'Avg Endgame', 'Max Score', 'Avg Rating', 'Trend']
  const rows = recordStore.rankings.map(r => [
    r.teamNumber,
    r.matchCount,
    r.brokenCount,
    r.avgAutoScore,
    r.avgTeleopScore,
    r.avgEndgameScore,
    r.maxScore,
    r.avgRating,
    r.trend
  ])
  const eventName = event.value?.name ? event.value.name.replace(/[^a-z0-9]/gi, '_') : 'event'
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  downloadCSV(`${eventName}_rankings_${timestamp}.csv`, headers, rows)
}

function exportRecordsCSV() {
  const headers = ['Record ID', 'Match', 'Team', 'Scout', 'Auto', 'Teleop', 'Endgame', 'Total Score', 'Is Broken', 'Created At']
  const rows = recordStore.records.map(r => [
    r.id,
    r.matchNumber,
    r.teamNumber,
    r.scoutName,
    r.autoScore,
    r.teleopScore,
    r.endgameScore,
    r.totalScore,
    r.isBroken ? 'Yes' : 'No',
    new Date(r.createdAt).toLocaleString()
  ])
  const eventName = event.value?.name ? event.value.name.replace(/[^a-z0-9]/gi, '_') : 'event'
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  downloadCSV(`${eventName}_records_${timestamp}.csv`, headers, rows)
}
</script>

<template>
  <div class="event-view">
    <!-- Header -->
    <header ref="headerRef" class="topbar" :style="{ viewTransitionName: 'event-topbar' }">
      <div class="topbar-left">
        <button class="btn-back" @click="goBack" style="display: flex; align-items: center; gap: 4px;"><span class="material-icons" style="font-size: 18px;">arrow_back</span>{{ t('event.back') }}</button>
        <div class="event-title">
          <span class="event-name" :style="{ viewTransitionName: 'event-card-title' }">{{ event?.name ?? t('event.event') }}</span>
          <span v-if="event" class="event-code">
            {{ t('event.code') }}: <strong>{{ event.inviteCode }}</strong>
            - {{ eventStore.isHost ? t('event.host') : t('event.client') }}
          </span>
        </div>
      </div>
      <div class="topbar-right" :style="{ viewTransitionName: 'event-status' }">
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
        :style="{ transform: `translateX(${tabs.findIndex(t => t.key === activeTab) * 100}%)` }"
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
        name="fade" 
        :mode="isViewTransitionSupported ? undefined : 'out-in'"
        :css="!isViewTransitionSupported"
      >
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
        <AiChatView v-else-if="activeTab === 'ai'" :event-id="route.params.eventId as string" />
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

          <div class="settings-panel">
            <h2>Data Export</h2>
            <div class="settings-form" style="flex-direction: row; gap: 16px;">
              <button class="btn-primary" @click="exportRankingsCSV" style="margin-top: 0;">
                <span class="material-icons" style="font-size: 18px; vertical-align: text-bottom; margin-right: 4px;">download</span>
                Export Rankings CSV
              </button>
              <button class="btn-primary" @click="exportRecordsCSV" style="margin-top: 0; background: var(--border); color: var(--foreground);">
                <span class="material-icons" style="font-size: 18px; vertical-align: text-bottom; margin-right: 4px;">download</span>
                Export All Records CSV
              </button>
            </div>
          </div>

          <h2>Scouts</h2>
          <ul class="scouts-list">
            <li v-for="s in uniqueScouts" :key="s.id" class="scout-item">
              <span class="scout-info">{{ s.name }} (Records: {{ s.recordCount }})</span>
              <button @click="sendDirectMessage(s.id, s.name)" class="btn-msg">Send Message</button>
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
  display: inline-block;
  font-size: 1.2rem;
  font-weight: 700;
  width: fit-content;
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

.congestion-banner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px 16px;
  background: rgba(234, 179, 8, 0.15);
  color: #eab308;
  border-bottom: 1px solid rgba(234, 179, 8, 0.3);
  font-size: 13px;
  font-weight: 500;
}

.banner-icon {
  font-size: 16px;
}
</style>

