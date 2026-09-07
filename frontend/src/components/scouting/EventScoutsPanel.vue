<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ScoutingEvent } from '@/types'
import { useEventStore } from '@/stores/events'
import { useRecordStore } from '@/stores/records'
import { useConnectionStore } from '@/stores/connection'
import { useInboxStore } from '@/stores/inbox'
import { useToastStore } from '@/stores/toast'
import { updateEventFtcConfig, fetchEventMembers, type EventMemberItem } from '@/services/api'
import { downloadCSV } from '@/utils/csvExport'
import OfflineSyncModal from '@/components/common/OfflineSyncModal.vue'

const props = defineProps<{
  event: ScoutingEvent | null
}>()

const { t } = useI18n()
const eventStore = useEventStore()
const recordStore = useRecordStore()
const connStore = useConnectionStore()
const inboxStore = useInboxStore()
const toastStore = useToastStore()

const showOfflineSyncModal = ref(false)

// --- Database Event Members & Real-time Auto-Refresh ---
const dbMembers = ref<EventMemberItem[]>([])
const isLoadingMembers = ref(false)
let pollTimer: any = null

async function refreshMembers() {
  if (!props.event?.id) return
  try {
    isLoadingMembers.value = true
    const list = await fetchEventMembers(props.event.id)
    dbMembers.value = list || []
  } catch (err) {
    console.warn('[EventScoutsPanel] Failed to fetch members:', err)
  } finally {
    isLoadingMembers.value = false
  }
}

onMounted(() => {
  refreshMembers()
  pollTimer = setInterval(refreshMembers, 4000)
  window.addEventListener('focus', refreshMembers)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
  window.removeEventListener('focus', refreshMembers)
})

watch(
  () => props.event?.id,
  () => {
    refreshMembers()
  }
)

// --- FTC Config Settings ---
const settingsYear = ref(props.event?.ftcYear ?? 2025)
const settingsCode = ref(props.event?.ftcEventCode ?? '')
const isSavingSettings = ref(false)

watch(
  () => [props.event?.ftcYear, props.event?.ftcEventCode],
  ([newYear, newCode]) => {
    if (newYear) settingsYear.value = Number(newYear)
    if (newCode !== undefined && newCode !== null) settingsCode.value = String(newCode)
  },
  { immediate: true }
)

async function saveEventSettings() {
  if (!props.event) return
  const code = settingsCode.value.trim()
  if (!code) {
    toastStore.showToast('请输入有效的 FTC 比赛代码 (例如: CNCMPLB, AUCMP)', 'error')
    return
  }

  isSavingSettings.value = true
  try {
    const year = Number(settingsYear.value) || 2025
    await updateEventFtcConfig(props.event.id, year, code)
    
    // Update store state
    eventStore.updateFtcConfig(props.event.id, year, code)
    
    // Re-fetch records/matches
    await recordStore.fetchRecords(props.event.id, year, code)
    
    toastStore.showToast(t('event.bind_success') || 'FTC 官方赛事代码绑定成功！', 'info')
  } catch (e: any) {
    toastStore.showToast((t('event.bind_failed') || '绑定设置失败: ') + (e.message || String(e)), 'error')
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
  const eventName = props.event?.name ? props.event.name.replace(/[^a-z0-9]/gi, '_') : 'event'
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  downloadCSV(`${eventName}_rankings_${timestamp}.csv`, headers, rows)
}

function exportRecordsCSV() {
  const headers = ['Record ID', 'Match', 'Team', 'Scout', 'Auto', 'Teleop', 'Endgame', 'Total Score', 'Is Broken', 'Created At']
  const rows = recordStore.activeRecords.map(r => [
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
  const eventName = props.event?.name ? props.event.name.replace(/[^a-z0-9]/gi, '_') : 'event'
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  downloadCSV(`${eventName}_records_${timestamp}.csv`, headers, rows)
}

interface ScoutDisplayItem {
  id: string
  name: string
  role?: string
  recordCount: number
  isOnline: boolean
}

const uniqueScouts = computed(() => {
  const scouts = new Map<string, ScoutDisplayItem>()

  // 1. Registered database members
  for (const m of dbMembers.value) {
    scouts.set(m.id, {
      id: m.id,
      name: m.username || m.id,
      role: m.host ? 'host' : (m.role || 'scout'),
      recordCount: 0,
      isOnline: false
    })
  }

  // 2. Connected WebRTC peers
  for (const s of connStore.connectedScouts) {
    if (!scouts.has(s.id)) {
      scouts.set(s.id, {
        id: s.id,
        name: s.name || s.id,
        recordCount: 0,
        isOnline: true
      })
    } else {
      const item = scouts.get(s.id)!
      if (s.name) item.name = s.name
      item.isOnline = true
    }
  }

  // 3. Submitted scout records
  for (const r of recordStore.activeRecords) {
    if (!scouts.has(r.scoutId)) {
      scouts.set(r.scoutId, {
        id: r.scoutId,
        name: r.scoutName || r.scoutId,
        recordCount: 0,
        isOnline: false
      })
    }
    scouts.get(r.scoutId)!.recordCount++
  }

  return Array.from(scouts.values())
})

async function sendDirectMessage(scoutId: string, scoutName?: string) {
  if (connStore.rtcService) {
    const promptText = t('event.msg_prompt', { name: scoutName || scoutId })
    const msg = prompt(promptText)
    if (msg) {
      await inboxStore.sendDirectMessage(
        { targetId: scoutId, targetName: scoutName, title: 'Message from Host', body: msg },
        connStore.rtcService
      )
    }
  } else {
    alert(t('event.msg_not_ready'))
  }
}
</script>

<template>
  <div class="event-scouts-panel">
    <div class="settings-panel">
      <h2>{{ t('event.tab_scouts') }}</h2>

      <!-- FTC Bound Status Banner -->
      <div v-if="event?.ftcEventCode" class="ftc-bound-status-card">
        <span class="material-icons status-icon">check_circle</span>
        <div class="status-content">
          <div class="status-title">{{ t('event.ftc_bound_title', { code: event.ftcEventCode, year: event.ftcYear || 2025 }) }}</div>
          <div class="status-subtitle">{{ t('event.ftc_bound_desc', { count: recordStore.officialMatches.length }) }}</div>
        </div>
      </div>

      <div class="settings-form">
        <div class="form-group">
          <label>FTC Season (Year)</label>
          <input type="number" v-model="settingsYear" :disabled="isSavingSettings" />
        </div>
        <div class="form-group">
          <label>Event Code (FTC 比赛代码)</label>
          <input type="text" v-model="settingsCode" placeholder="例如: CNCMPLB, AUCMP" :disabled="isSavingSettings" />
          <small class="form-hint">{{ t('event.ftc_binding_hint') }}</small>
        </div>
        <button class="btn-primary" @click="saveEventSettings" :disabled="isSavingSettings" style="display: flex; align-items: center; justify-content: center; gap: 6px;">
          <span class="material-icons" style="font-size: 18px;">{{ event?.ftcEventCode ? 'sync' : 'link' }}</span>
          {{ isSavingSettings ? 'Saving...' : (event?.ftcEventCode ? t('event.btn_update_sync') : t('event.btn_bind_sync')) }}
        </button>
      </div>
    </div>

    <div class="settings-panel">
      <h2>{{ t('event.export_section') }}</h2>
      <div class="settings-form" style="flex-direction: row; gap: 16px; flex-wrap: wrap;">
        <button class="btn-primary" @click="exportRankingsCSV" style="margin-top: 0;">
          <span class="material-icons" style="font-size: 18px; vertical-align: text-bottom; margin-right: 4px;">download</span>
          {{ t('event.export_rankings') }}
        </button>
        <button class="btn-primary" @click="exportRecordsCSV" style="margin-top: 0; background: var(--border); color: var(--foreground);">
          <span class="material-icons" style="font-size: 18px; vertical-align: text-bottom; margin-right: 4px;">download</span>
          {{ t('event.export_records') }}
        </button>
        <button class="btn-primary" @click="showOfflineSyncModal = true" style="margin-top: 0; background: rgba(57, 255, 20, 0.12); border: 1px solid var(--primary); color: var(--primary);">
          <span class="material-icons" style="font-size: 18px; vertical-align: text-bottom; margin-right: 4px;">usb</span>
          {{ t('offline_sync.title') }}
        </button>
      </div>
    </div>

    <div class="scouts-header-bar">
      <h2>{{ t('event.scouts_title') }} ({{ uniqueScouts.length }})</h2>
      <button class="btn-refresh-scouts" @click="refreshMembers" :disabled="isLoadingMembers">
        <span class="material-icons" :class="{ 'spinning': isLoadingMembers }">refresh</span>
        <span>{{ t('event.scouts_refresh') }}</span>
      </button>
    </div>

    <ul class="scouts-list">
      <li v-for="s in uniqueScouts" :key="s.id" class="scout-item">
        <div class="scout-left">
          <span
            class="status-dot"
            :class="s.isOnline ? 'dot-online' : 'dot-offline'"
            :title="s.isOnline ? t('event.status_online') : t('event.status_offline')"
          />
          <span class="scout-name">{{ s.name }}</span>
          <span v-if="s.role === 'host'" class="badge-role">{{ t('event.role_host') }}</span>
          <span class="scout-record-count">
            {{ t('event.scouts_records_count', { count: s.recordCount }) }}
          </span>
        </div>
        <button @click="sendDirectMessage(s.id, s.name)" class="btn-msg">
          <span class="material-icons" style="font-size: 16px; vertical-align: middle; margin-right: 4px;">mail</span>
          {{ t('event.send_message') }}
        </button>
      </li>
    </ul>

    <OfflineSyncModal v-model:visible="showOfflineSyncModal" :event-id="event?.id" />
  </div>
</template>

<style scoped>
.scouts-header-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.btn-refresh-scouts {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--foreground);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-refresh-scouts:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
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
  padding: 12px 16px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  margin-bottom: 8px;
  transition: border-color 0.2s ease;
}

.scout-item:hover {
  border-color: var(--primary);
}

.scout-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.dot-online {
  background: var(--primary, #39ff14);
  box-shadow: 0 0 6px rgba(57, 255, 20, 0.6);
}

.dot-offline {
  background: var(--muted-foreground, #666);
}

.scout-name {
  font-weight: 600;
  font-size: 14px;
}

.badge-role {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 9999px;
  background: rgba(57, 255, 20, 0.15);
  color: var(--primary, #39ff14);
  border: 1px solid rgba(57, 255, 20, 0.3);
  font-weight: 600;
}

.scout-record-count {
  font-size: 12px;
  color: var(--muted-foreground);
}

.btn-msg {
  background: rgba(57, 255, 20, 0.12);
  color: var(--primary, #39ff14);
  border: 1px solid rgba(57, 255, 20, 0.3);
  border-radius: 8px;
  padding: 6px 14px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  transition: all 0.2s ease;
}

.btn-msg:hover {
  background: var(--primary);
  color: var(--primary-foreground, #000);
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

.ftc-bound-status-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 8px;
  background: rgba(34, 197, 94, 0.1);
  border: 1px solid rgba(34, 197, 94, 0.3);
  margin-top: 10px;
  margin-bottom: 12px;
}

.status-icon {
  font-size: 22px;
  color: #22c55e;
  flex-shrink: 0;
  margin-top: 1px;
}

.status-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.status-title {
  font-size: 14px;
  font-weight: 600;
  color: #22c55e;
}

.status-subtitle {
  font-size: 12px;
  color: var(--foreground);
  opacity: 0.85;
}

.form-hint {
  font-size: 12px;
  color: var(--muted-foreground);
  margin-top: 2px;
}
</style>
