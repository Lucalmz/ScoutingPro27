<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ScoutingEvent, ConnectionTransportInfo, CustomTurnConfig } from '@/types'
import { useEventStore } from '@/stores/events'
import { useRecordStore } from '@/stores/records'
import { useConnectionStore } from '@/stores/connection'
import { useInboxStore } from '@/stores/inbox'
import { useToastStore } from '@/stores/toast'
import { updateEventFtcConfig, updateEventTurnConfig, fetchEventMembers, removeEventMember, type EventMemberItem } from '@/services/api'
import { getKnownScouts, removeKnownScout } from '@/services/scoutStorage'
import { downloadCSV } from '@/utils/csvExport'
import { sortRecordsChronologically, getRecordTournamentLevel } from '@/utils/tournament'
import { parseScoutRawData } from '@/utils/analytics/rankings'
import { calcMatchPredictCycleTime } from '@/utils/analytics/predictCycleTime'
import OfflineSyncModal from '@/components/common/OfflineSyncModal.vue'
import CustomFieldsManagerModal from '@/components/customFields/CustomFieldsManagerModal.vue'
import SendMessageModal from './SendMessageModal.vue'
import { useCustomFieldsStore } from '@/stores/customFields'
import { useConfirm } from '@/composables/useConfirm'

const props = defineProps<{
  event: ScoutingEvent | null
}>()

const { t, locale } = useI18n()
const isZh = computed(() => (locale?.value || '').startsWith('zh'))
const eventStore = useEventStore()
const recordStore = useRecordStore()
const connStore = useConnectionStore()
const inboxStore = useInboxStore()
const toastStore = useToastStore()
const customFieldsStore = useCustomFieldsStore()
const { showConfirm } = useConfirm()

const showOfflineSyncModal = ref(false)
const showCustomFieldsModal = ref(false)
const showSendMessageModal = ref(false)
const messageTargetScout = ref<{ id: string; name?: string; isOnline?: boolean } | null>(null)

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
const settingsYear = ref(props.event?.ftcYear ?? 2026)
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
    toastStore.showToast(t('event.ftc_code_required') || '请输入有效的 FTC 比赛代码 (例如: USUTSAS1)', 'error')
    return
  }

  isSavingSettings.value = true
  try {
    const year = Number(settingsYear.value) || 2026
    await updateEventFtcConfig(props.event.id, year, code)
    
    // Update store state
    eventStore.updateFtcConfig(props.event.id, year, code)
    
    // Re-fetch records/matches
    await recordStore.fetchRecords(props.event.id, year, code)
    
    toastStore.showToast(t('event.bind_success') || 'FTC 官方赛事代码绑定成功！', 'info')
  } catch (e: any) {
    toastStore.showError(e, t('event.bind_failed') || '绑定设置失败')
  } finally {
    isSavingSettings.value = false
  }
}

// --- Custom TURN Server Settings (Host Only) ---
const turnUrlsInput = ref('')
const turnUsername = ref('')
const turnCredential = ref('')
const showTurnCredential = ref(false)
const isSavingTurn = ref(false)

const hasActiveCustomTurn = computed(() =>
  Boolean(
    props.event?.hasCustomTurn ||
      (props.event?.customTurnConfig?.urls && props.event.customTurnConfig.urls.length > 0)
  )
)

watch(
  () => [props.event?.customTurnConfig, props.event?.hasCustomTurn] as const,
  ([cfg, hasCustom]) => {
    const typedCfg = cfg as CustomTurnConfig | null | undefined
    const active = Boolean(hasCustom || (typedCfg?.urls && typedCfg.urls.length > 0))
    if (active) {
      turnUrlsInput.value = Array.isArray(typedCfg?.urls) ? typedCfg.urls.join('\n') : ''
      turnUsername.value = typedCfg?.username ?? ''
      turnCredential.value = typedCfg?.credential ? typedCfg.credential : '********'
    } else {
      turnUrlsInput.value = ''
      turnUsername.value = ''
      turnCredential.value = ''
    }
  },
  { immediate: true, deep: true }
)

function broadcastUpdatedEventMetadata() {
  if (eventStore.currentEvent && connStore.rtcService) {
    connStore.rtcService.setEventMetadata?.(eventStore.currentEvent)
    connStore.rtcService.sendMessage?.({
      type: 'EVENT_METADATA',
      event: eventStore.currentEvent
    })
  }
}

async function saveTurnSettings() {
  if (!props.event) return
  const urls = turnUrlsInput.value
    .split(/[\n,]+/)
    .map(u => u.trim())
    .filter(Boolean)

  if (urls.length === 0 || !urls.every(u => /^turns?:/i.test(u))) {
    toastStore.showToast(t('event.turn_invalid_url'), 'error')
    return
  }

  const username = turnUsername.value.trim()
  if (!username) {
    toastStore.showToast(t('event.turn_username_required'), 'error')
    return
  }

  const credential = turnCredential.value.trim()
  if (!credential && !hasActiveCustomTurn.value) {
    toastStore.showToast(t('event.turn_credential_required'), 'error')
    return
  }

  isSavingTurn.value = true
  try {
    const res = await updateEventTurnConfig(props.event.id, {
      urls,
      username,
      credential
    })
    eventStore.updateTurnConfig(props.event.id, res.customTurnConfig ?? null)
    broadcastUpdatedEventMetadata()
    toastStore.showToast(t('event.turn_save_success'), 'success')
  } catch (e: any) {
    toastStore.showError(e, t('event.turn_save_failed'))
  } finally {
    isSavingTurn.value = false
  }
}

async function resetTurnSettings() {
  if (!props.event) return
  isSavingTurn.value = true
  try {
    await updateEventTurnConfig(props.event.id, null)
    eventStore.updateTurnConfig(props.event.id, null)
    turnUrlsInput.value = ''
    turnUsername.value = ''
    turnCredential.value = ''
    showTurnCredential.value = false
    broadcastUpdatedEventMetadata()
    toastStore.showToast(t('event.turn_reset_success'), 'info')
  } catch (e: any) {
    toastStore.showError(e, t('event.turn_save_failed'))
  } finally {
    isSavingTurn.value = false
  }
}

// --- Data Export ---
function exportRankingsCSV() {
  const activeCustomFields = props.event?.id
    ? customFieldsStore.getActiveFields(props.event.id, 'MATCH').filter(f => f.fieldType === 'number' || f.fieldType === 'level' || f.fieldType === 'boolean')
    : []
  const customHeaders = activeCustomFields.map(f =>
    f.fieldType === 'boolean'
      ? (isZh.value ? `自定义: ${f.name} 发生率(%)` : `Custom: ${f.name} Rate (%)`)
      : (isZh.value ? `自定义: 场均${f.name}` : `Custom: Avg ${f.name}`)
  )
  const headers = isZh.value
    ? [
        '晋级分', '队伍', '场数', '抛锚场次', '场均Auto', '场均Teleop', '场均Endgame', '最高分', '平均评分', '趋势',
        'TeleOp停泊率(%)', '机动RP均分', '场均Nectars', '场均底层Bonus', '场均Pollens', '场均Garden',
        '拆台率(%)', 'G410犯规率(%)', 'Predict Cycle Time (s)', '合格采样本场数', '估算最大Cycle',
        ...customHeaders
      ]
    : [
        'Adv. Pts', 'Team', 'Matches', 'Breakdown Count', 'Avg Auto', 'Avg Teleop', 'Avg Endgame', 'Max Score', 'Avg Rating', 'Trend',
        'TeleOp Park (%)', 'Avg Mobility RP Pts', 'Avg Nectars', 'Avg Bottom Bonus', 'Avg Pollens', 'Avg Garden',
        'Descore (%)', 'G410 Foul (%)', 'Predict Cycle Time (s)', 'Predict Cycle Matches', 'Est. Max Cycles',
        ...customHeaders
      ]
  const rows = recordStore.rankings.map(r => {
    const teamRecs = recordStore.activeRecords.filter(
      rec => (!props.event?.id || rec.eventId === props.event.id) && rec.teamNumber === r.teamNumber && !rec.isBroken
    )
    const customCells = activeCustomFields.map(f => {
      if (teamRecs.length === 0) return '-'
      if (f.fieldType === 'boolean') {
        let count = 0
        let total = 0
        for (const rec of teamRecs) {
          try {
            const raw = typeof rec.rawData === 'string' ? JSON.parse(rec.rawData) : (rec.rawData || {})
            const val = (rec as any).customFields?.[f.fieldKey] ?? raw.customFields?.[f.fieldKey]
            if (val !== undefined && val !== null) {
              total++
              if (val === true || val === 'true' || val === 1) count++
            }
          } catch {}
        }
        return total > 0 ? ((count / total) * 100).toFixed(1) + '%' : '-'
      } else {
        let sum = 0
        let count = 0
        for (const rec of teamRecs) {
          try {
            const raw = typeof rec.rawData === 'string' ? JSON.parse(rec.rawData) : (rec.rawData || {})
            const val = (rec as any).customFields?.[f.fieldKey] ?? raw.customFields?.[f.fieldKey]
            if (val !== undefined && val !== null && val !== '') {
              const num = Number(val)
              if (!isNaN(num)) {
                sum += num
                count++
              }
            }
          } catch {}
        }
        return count > 0 ? (sum / count).toFixed(1) : '-'
      }
    })
    return [
      r.advancementPoints ?? 0,
      r.teamNumber,
      r.matchCount,
      r.brokenCount,
      r.avgAutoScore,
      r.avgTeleopScore,
      r.avgEndgameScore,
      r.maxScore,
      r.avgRating,
      r.trend,
      Math.round((r.teleopParkRate ?? 0) * 1000) / 10,
      r.avgMobilityRpPts ?? 0,
      r.avgFlowerNectars ?? 0,
      r.avgFlowerBottomBonus ?? 0,
      r.avgFlowerPollens ?? 0,
      r.avgGardenBalls ?? 0,
      Math.round((r.descoreRate ?? 0) * 1000) / 10,
      Math.round((r.g410FoulRate ?? 0) * 1000) / 10,
      r.predictCycleTime ?? '',
      r.predictCycleMatches ?? 0,
      r.estimatedMaxCycles ?? '',
      ...customCells
    ]
  })
  const eventName = props.event?.name ? props.event.name.replace(/[^a-z0-9]/gi, '_') : 'event'
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  downloadCSV(`${eventName}_rankings_${timestamp}.csv`, headers, rows)
}

function exportRecordsCSV() {
  const activeCustomFields = props.event?.id
    ? customFieldsStore.getActiveFields(props.event.id, 'MATCH')
    : []
  const customHeaders = activeCustomFields.map(f =>
    f.unit
      ? (isZh.value ? `自定义: ${f.name} (${f.unit})` : `Custom: ${f.name} (${f.unit})`)
      : (isZh.value ? `自定义: ${f.name}` : `Custom: ${f.name}`)
  )
  const headers = isZh.value
    ? [
        '记录ID', '级别', '场次', '队伍', '侦察员', 'Auto', 'Teleop', 'Endgame', '总分', '是否抛锚',
        'TeleOp停泊', 'Flower Nectars', 'Bottom Bonus', 'Flower Pollens', 'Garden', '底口拆台', 'G410早放花', 'Predict Cycle (s)',
        '记录时间', ...customHeaders
      ]
    : [
        'Record ID', 'Level', 'Match', 'Team', 'Scout', 'Auto', 'Teleop', 'Endgame', 'Total Score', 'Is Broken',
        'TeleOp Park', 'Flower Nectars', 'Bottom Bonus', 'Flower Pollens', 'Garden Balls', 'Flower Descore', 'G410 Foul', 'Predict Cycle (s)',
        'Created At', ...customHeaders
      ]
  const sorted = sortRecordsChronologically(recordStore.activeRecords)
  const rows = sorted.map(r => {
    let customObj: Record<string, any> = {}
    if (r.rawData) {
      try {
        const parsed = JSON.parse(r.rawData)
        customObj = parsed.customFields || {}
      } catch {}
    }
    const parsedRaw = parseScoutRawData(r.rawData)
    const predictSec =
      parsedRaw.predictCycleTimeSec ??
      calcMatchPredictCycleTime(parsedRaw.teleopCycles, parsedRaw.teleopCycleTimestamps)
    const customCells = activeCustomFields.map(f => {
      const val = customObj[f.fieldKey]
      if (val === undefined || val === null) return ''
      if (Array.isArray(val)) return val.join('; ')
      return String(val)
    })
    return [
      r.id,
      getRecordTournamentLevel(r),
      r.matchNumber,
      r.teamNumber,
      r.scoutName,
      r.autoScore,
      r.teleopScore,
      r.endgameScore,
      r.totalScore,
      r.isBroken ? 'Yes' : 'No',
      parsedRaw.endgame.teleopPark ? 'Yes' : 'No',
      parsedRaw.endgame.flowerNectars,
      parsedRaw.endgame.flowerBottomBonusCount,
      parsedRaw.endgame.flowerPollens,
      parsedRaw.endgame.gardenBalls,
      parsedRaw.endgame.flowerDescore ? 'Yes' : 'No',
      parsedRaw.endgame.g410EarlyFlowerFoul ? 'Yes' : 'No',
      predictSec ?? '',
      new Date(r.createdAt).toLocaleString(),
      ...customCells
    ]
  })
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
  transportInfo?: ConnectionTransportInfo | null
}

function isScoutVirtualTunnel(info?: ConnectionTransportInfo | null): boolean {
  if (!info || info.type !== 'relay') return false
  return Boolean(
    info.isVirtualTunnel ||
    info.protocol === 'wss/tls' ||
    info.localCandidateType === 'virtual' ||
    info.label === 'ECDH Tunnel (TLS)'
  )
}

function getScoutTransportIcon(info?: ConnectionTransportInfo | null): string {
  if (isScoutVirtualTunnel(info)) return 'lock'
  switch (info?.type) {
    case 'ipv6_p2p':
      return 'public'
    case 'lan_p2p':
      return 'router'
    case 'nat_p2p':
      return 'alt_route'
    case 'relay':
      return 'sync_alt'
    default:
      return 'link'
  }
}

function getScoutTransportLabel(info?: ConnectionTransportInfo | null): string {
  if (isScoutVirtualTunnel(info)) return t('connection.transport_virtual_tunnel')
  switch (info?.type) {
    case 'ipv6_p2p':
      return t('connection.transport_ipv6')
    case 'lan_p2p':
      return t('connection.transport_lan')
    case 'nat_p2p':
      return t('connection.transport_nat')
    case 'relay':
      return t('connection.transport_relay')
    default:
      return t('connection.transport_unknown')
  }
}

function getScoutTransportClass(info?: ConnectionTransportInfo | null): string {
  if (!info?.type || info.type === 'unknown') return 'unknown'
  return info.type
}

function getScoutTransportTooltip(info?: ConnectionTransportInfo | null): string {
  if (!info) return t('connection.transport_unknown')
  const key = isScoutVirtualTunnel(info) ? 'transport_tooltip_virtual_tunnel'
    : info.type === 'ipv6_p2p' ? 'transport_tooltip_ipv6'
    : info.type === 'lan_p2p' ? 'transport_tooltip_lan'
    : info.type === 'nat_p2p' ? 'transport_tooltip_nat'
    : info.type === 'relay' ? 'transport_tooltip_relay'
    : 'transport_unknown'
  const baseDesc = t('connection.' + key)
  const details = `\n${info.localAddress} (${info.localCandidateType}) <-> ${info.remoteAddress} (${info.remoteCandidateType}) [${info.protocol}]`
  const rtt = info.rttMs !== null && info.rttMs !== undefined ? ` | RTT: ${info.rttMs}ms` : ''
  return `${baseDesc}${details}${rtt}`
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

  // 2. Local storage known scouts fallback (for offline / PWA / persistent view)
  if (props.event?.id) {
    for (const k of getKnownScouts(props.event.id)) {
      if (!scouts.has(k.id)) {
        scouts.set(k.id, {
          id: k.id,
          name: k.name || k.id,
          role: 'scout',
          recordCount: 0,
          isOnline: false
        })
      }
    }
  }

  // 3. Connected WebRTC peers
  for (const s of connStore.connectedScouts) {
    const resolvedTransport =
      s.transportInfo ??
      connStore.scoutTransports?.[s.id] ??
      connStore.rtcService?.getScoutTransportInfo?.(s.id) ??
      null
    if (!scouts.has(s.id)) {
      scouts.set(s.id, {
        id: s.id,
        name: s.name || s.id,
        recordCount: 0,
        isOnline: true,
        transportInfo: resolvedTransport
      })
    } else {
      const item = scouts.get(s.id)!
      if (s.name) item.name = s.name
      item.isOnline = true
      item.transportInfo = resolvedTransport
    }
  }

  // 4. Submitted scout records
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

async function handleRemoveMember(scoutId: string, scoutName: string) {
  if (!props.event?.id) return
  const ok = await showConfirm({
    title: t('event.remove_scout_title') || t('event.remove_scout') || '移除成员',
    message: t('event.remove_scout_confirm', { name: scoutName }),
    type: 'danger',
    confirmText: t('event.btn_remove_confirm') || (isZh.value ? '确认移除' : 'Remove'),
    cancelText: t('common.cancel') || (isZh.value ? '取消' : 'Cancel')
  })
  if (!ok) return

  try {
    removeKnownScout(props.event.id, scoutId)
    await removeEventMember(props.event.id, scoutId)
    await refreshMembers()
    toastStore.showToast(t('event.scout_removed_success'), 'success')
  } catch (err: any) {
    console.warn('[EventScoutsPanel] Failed to remove member via backend:', err)
    removeKnownScout(props.event.id, scoutId)
    await refreshMembers()
    toastStore.showToast(t('event.scout_removed_local'), 'info')
  }
}

function sendDirectMessage(scoutId: string, scoutName?: string, isOnline?: boolean) {
  messageTargetScout.value = {
    id: scoutId,
    name: scoutName,
    isOnline: isOnline ?? connStore.connectedScouts.some(s => s.id === scoutId)
  }
  showSendMessageModal.value = true
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
          <div class="status-title">{{ t('event.ftc_bound_title', { code: event.ftcEventCode, year: event.ftcYear || 2026 }) }}</div>
          <div class="status-subtitle">{{ t('event.ftc_bound_desc', { count: recordStore.officialMatches.length }) }}</div>
        </div>
      </div>

      <div class="settings-form">
        <div class="form-group">
          <label>{{ t('event.ftc_season_year') }}</label>
          <input type="number" v-model="settingsYear" :disabled="isSavingSettings" />
        </div>
        <div class="form-group">
          <label>{{ t('event.ftc_event_code_label') }}</label>
          <input type="text" v-model="settingsCode" :placeholder="t('event.ftc_event_code_placeholder')" :disabled="isSavingSettings" />
          <small class="form-hint">{{ t('event.ftc_binding_hint') }}</small>
        </div>
        <button class="btn-primary" @click="saveEventSettings" :disabled="isSavingSettings" style="display: flex; align-items: center; justify-content: center; gap: 6px;">
          <span class="material-icons" style="font-size: 18px;">{{ event?.ftcEventCode ? 'sync' : 'link' }}</span>
          {{ isSavingSettings ? t('common.saving') : (event?.ftcEventCode ? t('event.btn_update_sync') : t('event.btn_bind_sync')) }}
        </button>
      </div>
    </div>

    <div v-if="eventStore.isHost" class="settings-panel" data-testid="custom-turn-panel">
      <h2>{{ t('event.turn_section_title') }}</h2>

      <div v-if="hasActiveCustomTurn" class="ftc-bound-status-card" data-testid="turn-status-banner">
        <span class="material-icons status-icon">check_circle</span>
        <div class="status-content">
          <div class="status-title">{{ t('event.turn_status_custom') }}</div>
        </div>
      </div>
      <div v-else class="turn-default-status-card" data-testid="turn-status-banner">
        <span class="material-icons turn-default-icon">dns</span>
        <div class="status-content">
          <div class="status-subtitle">{{ t('event.turn_status_default') }}</div>
        </div>
      </div>

      <div class="settings-form">
        <div class="form-group">
          <label>{{ t('event.turn_urls_label') }}</label>
          <textarea
            v-model="turnUrlsInput"
            rows="2"
            :placeholder="t('event.turn_urls_placeholder')"
            :disabled="isSavingTurn"
            data-testid="turn-urls-input"
          />
          <small class="form-hint">{{ t('event.turn_urls_hint') }}</small>
        </div>

        <div class="form-group">
          <label>{{ t('event.turn_username_label') }}</label>
          <input
            type="text"
            v-model="turnUsername"
            :placeholder="t('event.turn_username_placeholder')"
            :disabled="isSavingTurn"
            data-testid="turn-username-input"
          />
        </div>

        <div class="form-group">
          <label>{{ t('event.turn_credential_label') }}</label>
          <div class="password-input-row">
            <input
              :type="showTurnCredential ? 'text' : 'password'"
              v-model="turnCredential"
              :placeholder="t('event.turn_credential_placeholder')"
              :disabled="isSavingTurn"
              data-testid="turn-credential-input"
            />
            <button
              type="button"
              class="btn-toggle-secret"
              @click="showTurnCredential = !showTurnCredential"
              :disabled="isSavingTurn"
            >
              <span class="material-icons" style="font-size: 18px;">
                {{ showTurnCredential ? 'visibility_off' : 'visibility' }}
              </span>
            </button>
          </div>
          <small v-if="hasActiveCustomTurn" class="form-hint">{{ t('event.turn_credential_hint_saved') }}</small>
        </div>

        <div class="turn-actions-row">
          <button
            class="btn-primary"
            @click="saveTurnSettings"
            :disabled="isSavingTurn"
            data-testid="turn-save-btn"
            style="display: flex; align-items: center; justify-content: center; gap: 6px; margin-top: 0; flex: 1;"
          >
            <span class="material-icons" style="font-size: 18px;">save</span>
            {{ isSavingTurn ? t('common.saving') : t('event.turn_btn_save') }}
          </button>
          <button
            class="btn-secondary-outline"
            @click="resetTurnSettings"
            :disabled="isSavingTurn || !hasActiveCustomTurn"
            data-testid="turn-reset-btn"
          >
            <span class="material-icons" style="font-size: 18px;">restart_alt</span>
            {{ t('event.turn_btn_reset_default') }}
          </button>
        </div>
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
        <button class="btn-primary" @click="showOfflineSyncModal = true" style="margin-top: 0; background: var(--status-success-bg); border: 1px solid var(--status-success-border); color: var(--primary);">
          <span class="material-icons" style="font-size: 18px; vertical-align: text-bottom; margin-right: 4px;">usb</span>
          {{ t('offline_sync.title') }}
        </button>
      </div>
    </div>

    <div class="settings-panel">
      <h2>{{ t('custom_fields.panel_title') }}</h2>
      <div class="settings-form" style="flex-direction: row; gap: 16px; flex-wrap: wrap;">
        <button
          class="btn-primary"
          @click="showCustomFieldsModal = true"
          style="margin-top: 0; background: var(--status-success-bg); border: 1px solid var(--status-success-border); color: var(--primary);"
        >
          <span class="material-icons" style="font-size: 18px; vertical-align: text-bottom; margin-right: 4px;">tune</span>
          {{ t('custom_fields.btn_manage') }}
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
          <span
            v-if="s.isOnline && s.role !== 'host'"
            class="scout-transport-pill"
            :class="[getScoutTransportClass(s.transportInfo), { 'virtual-tunnel': isScoutVirtualTunnel(s.transportInfo) }]"
            :title="getScoutTransportTooltip(s.transportInfo)"
          >
            <span class="material-icons scout-transport-icon">{{ getScoutTransportIcon(s.transportInfo) }}</span>
            <span class="scout-transport-label">{{ getScoutTransportLabel(s.transportInfo) }}</span>
            <span
              v-if="s.transportInfo?.rttMs !== null && s.transportInfo?.rttMs !== undefined"
              class="scout-transport-rtt"
            >
              {{ s.transportInfo.rttMs }}ms
            </span>
          </span>
          <span class="scout-record-count">
            {{ t('event.scouts_records_count', { count: s.recordCount }) }}
          </span>
        </div>
        <div class="scout-actions">
          <button @click="sendDirectMessage(s.id, s.name, s.isOnline)" class="btn-msg">
            <span class="material-icons" style="font-size: 16px; vertical-align: middle; margin-right: 4px;">mail</span>
            {{ t('event.send_message') }}
          </button>
          <button
            v-if="eventStore.isHost && s.role !== 'host'"
            @click="handleRemoveMember(s.id, s.name)"
            class="btn-remove-scout"
            :title="t('event.remove_scout')"
          >
            <span class="material-icons" style="font-size: 16px; vertical-align: middle;">delete_outline</span>
          </button>
        </div>
      </li>
    </ul>

    <OfflineSyncModal v-model:visible="showOfflineSyncModal" :event-id="event?.id" />
    <CustomFieldsManagerModal v-model:visible="showCustomFieldsModal" :event-id="event?.id || ''" />
    <SendMessageModal
      v-model:visible="showSendMessageModal"
      :target-scout-id="messageTargetScout?.id || ''"
      :target-scout-name="messageTargetScout?.name"
      :is-online="messageTargetScout?.isOnline"
    />
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
  transition: border-color var(--motion-duration-fast) var(--motion-ease-out), color var(--motion-duration-fast) var(--motion-ease-out);
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
  transition: border-color var(--motion-duration-fast) var(--motion-ease-out);
}

.scout-item:hover {
  border-color: var(--primary);
}

.scout-left {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.scout-transport-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 600;
  cursor: help;
  user-select: none;
  background: var(--g-800);
  color: var(--g-200);
  border: 1px solid var(--border-strong);
}

.scout-transport-icon {
  font-size: 13px;
}

.scout-transport-rtt {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 10px;
  padding: 0 4px;
  border-radius: 4px;
  background: var(--surface-recessed);
}

.scout-transport-pill.ipv6_p2p {
  background: var(--status-info-bg);
  color: var(--status-info);
  border-color: var(--status-info-border);
}

.scout-transport-pill.lan_p2p {
  background: var(--status-info-bg);
  color: var(--status-info);
  border-color: var(--status-info-border);
}

.scout-transport-pill.nat_p2p {
  background: var(--status-success-bg);
  color: var(--s-400);
  border-color: var(--status-success-border);
}

.scout-transport-pill.relay {
  background: var(--status-warning-bg);
  color: var(--status-warning);
  border-color: var(--status-warning-border);
}

.scout-transport-pill.relay.virtual-tunnel {
  background: var(--status-ai-bg);
  color: var(--status-ai);
  border-color: var(--status-ai-border);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.dot-online {
  background: var(--primary);
  box-shadow: var(--glow-online);
}

.dot-offline {
  background: var(--g-500);
}

.scout-name {
  font-weight: 600;
  font-size: 14px;
}

.badge-role {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 9999px;
  background: var(--status-success-bg);
  color: var(--primary);
  border: 1px solid var(--status-success-border);
  font-weight: 600;
}

.scout-record-count {
  font-size: 12px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

.btn-msg {
  background: var(--status-success-bg);
  color: var(--primary);
  border: 1px solid var(--status-success-border);
  border-radius: 8px;
  padding: 6px 14px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out), color var(--motion-duration-fast) var(--motion-ease-out);
}

.btn-msg:hover {
  background: var(--primary);
  color: var(--on-primary);
}

.scout-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn-remove-scout {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 6px 8px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--muted-foreground);
  cursor: pointer;
  transition: border-color var(--motion-duration-fast) var(--motion-ease-out), color var(--motion-duration-fast) var(--motion-ease-out), background-color var(--motion-duration-fast) var(--motion-ease-out);
}

.btn-remove-scout:hover {
  border-color: var(--status-error-border);
  color: var(--status-error);
  background: var(--status-error-bg);
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
.form-group input,
.form-group textarea {
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--input);
  color: var(--foreground);
  font-family: inherit;
}
.password-input-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.password-input-row input {
  flex: 1;
}
.btn-toggle-secret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 8px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--muted-foreground);
  cursor: pointer;
}
.btn-toggle-secret:hover:not(:disabled) {
  border-color: var(--primary);
  color: var(--primary);
}
.turn-actions-row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.btn-secondary-outline {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 14px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--foreground);
  font-weight: 600;
  cursor: pointer;
}
.btn-secondary-outline:hover:not(:disabled) {
  border-color: var(--primary);
  color: var(--primary);
}
.btn-secondary-outline:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.turn-default-status-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 16px;
  border-radius: 8px;
  background: var(--surface-recessed);
  border: 1px solid var(--border);
  margin-top: 10px;
  margin-bottom: 12px;
}
.turn-default-icon {
  font-size: 20px;
  color: var(--muted-foreground);
  flex-shrink: 0;
  margin-top: 1px;
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
  background: var(--status-success-bg);
  border: 1px solid var(--status-success-border);
  margin-top: 10px;
  margin-bottom: 12px;
}

.status-icon {
  font-size: 22px;
  color: var(--primary);
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
  color: var(--primary);
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
