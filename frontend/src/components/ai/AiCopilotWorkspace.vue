<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter, useRoute } from 'vue-router'
import { createDefaultContextConfig, useAiStore } from '@/stores/ai'
import { useRecordStore } from '@/stores/records'
import { useEventStore } from '@/stores/events'
import { usePitScoutStore } from '@/stores/pitScout'
import { useScheduleStore } from '@/stores/schedule'
import { useCustomFieldsStore } from '@/stores/customFields'
import { useUserStore } from '@/stores/user'
import { useNavigationStore, type EventTab } from '@/stores/navigation'
import { useConfirm } from '@/composables/useConfirm'
import type { AiContextSections, AiChatMessage } from '@/types'
import { AI_LAYOUT, DEFAULT_DOCK_WIDTH, isZhLocale } from '@/components/ai/constants'
import { PROTOCOL_META } from '@/components/ai/presets'
import {
  DEFAULT_PERSONA_ID,
  assembleSystemPrompt,
  generateFollowUpSuggestions,
  type StarterCardItem
} from '@/components/ai/personas'
import { buildContextPreviewStats } from '@/components/ai/contextBuilder'
import {
  buildTurboEditableEntitySnapshot,
  buildTurboSystemPromptSection,
  stripTurboActionBlocks
} from '@/components/ai/turboAgent'
import { exportThreadToMarkdown } from '@/components/ai/exportThread'
import { buildTeamRegex } from '@/components/ai/teamMatcher'
import { calculateBragIndex } from '@/utils/bragIndex'
import AiThreadSidebar from './AiThreadSidebar.vue'
import AiEmptyState from './AiEmptyState.vue'
import AiMessageItem from './AiMessageItem.vue'
import AiChatComposer, { type KnownTeamOption } from './AiChatComposer.vue'
import AiModelQuickSwitcher from './workspace/AiModelQuickSwitcher.vue'
import AiContextRibbon from './workspace/AiContextRibbon.vue'
import AiTeamHoverCard, { type TeamHoverPreview } from './workspace/AiTeamHoverCard.vue'
import AiVoiceCallOverlay from './voice/AiVoiceCallOverlay.vue'
import { useAiVoiceSession } from './voice/useAiVoiceSession'

const props = withDefaults(
  defineProps<{
    eventId: string
    mode?: 'dock' | 'mobile'
  }>(),
  {
    mode: 'dock'
  }
)

const { t, locale } = useI18n()
const isZh = computed(() => isZhLocale(locale.value))
const router = useRouter()
const route = useRoute()
const aiStore = useAiStore()
const recordStore = useRecordStore()
const eventStore = useEventStore()
const pitStore = usePitScoutStore()
const scheduleStore = useScheduleStore()
const customFieldsStore = useCustomFieldsStore()
const userStore = useUserStore()
const navStore = useNavigationStore()
const { showConfirm } = useConfirm()

// Container width measurement for responsive @container thread sidebar docking
const workspaceRef = ref<HTMLElement | null>(null)
const containerWidth = ref(
  props.mode === 'mobile' ? AI_LAYOUT.DEFAULT_MOBILE_WIDTH : DEFAULT_DOCK_WIDTH
)
let resizeObserver: ResizeObserver | null = null

const isWideContainer = computed(() => containerWidth.value >= AI_LAYOUT.SIDEBAR_DOCK_BREAKPOINT)
const showSidebar = computed(() => isWideContainer.value || aiStore.threadSidebarOpen)

// UI Popovers & Controls
const scrollRef = ref<HTMLElement | null>(null)
const showScrollBottomBtn = ref(false)
const hoverPreview = ref<TeamHoverPreview | null>(null)

// Current Event Derived State
const threads = computed(() => aiStore.getThreadsForEvent(props.eventId))
const activeThread = computed(() => aiStore.getActiveThread(props.eventId))
const messages = computed<AiChatMessage[]>(() => activeThread.value?.messages || [])
const isStreaming = computed(() => aiStore.isThreadStreaming(activeThread.value?.id))
const activePersonaId = computed(() => activeThread.value?.personaId || DEFAULT_PERSONA_ID)

const draftText = computed({
  get: () => aiStore.draftPromptByEvent[props.eventId] || '',
  set: (v: string) => {
    aiStore.draftPromptByEvent = { ...aiStore.draftPromptByEvent, [props.eventId]: v }
  }
})

const myTeamInput = computed({
  get: () => {
    const num = aiStore.getMyTeamNumber(props.eventId)
    return num ? String(num) : ''
  },
  set: (val: string) => {
    const parsed = parseInt(val.replace(/\D+/g, ''), 10)
    aiStore.setMyTeamNumber(props.eventId, !isNaN(parsed) && parsed > 0 ? parsed : null)
  }
})

const contextConfig = computed(() => activeThread.value?.contextConfig || createDefaultContextConfig())

const activeCustomFields = computed(() =>
  props.eventId ? customFieldsStore.getFields(props.eventId).filter(f => f.isActive) : []
)

const scopedEvent = computed(() => {
  if (!props.eventId) return eventStore.currentEvent
  return (
    eventStore.events.find(e => e.id === props.eventId) ||
    (eventStore.currentEvent?.id === props.eventId ? eventStore.currentEvent : null)
  )
})

const scopedRecords = computed(() => {
  if (!props.eventId) return recordStore.records
  return recordStore.records.filter(r => r.eventId === props.eventId)
})

const scopedActiveRecords = computed(() => scopedRecords.value.filter(r => !r.isDeleted))

const scopedTags = computed(() => recordStore.getTagsForEvent(props.eventId))

const scopedPitRecords = computed(() => {
  if (!props.eventId) return pitStore.records
  return pitStore.records.filter(p => !p.eventId || p.eventId === props.eventId)
})

const scopedActivePitRecords = computed(() => scopedPitRecords.value.filter(p => !p.isDeleted))

const scopedOfficialTeams = computed(() => {
  if (!props.eventId) return pitStore.officialTeams
  return pitStore.officialTeams.filter(ot => !ot.eventId || ot.eventId === props.eventId)
})

const scopedSchedules = computed(() => {
  if (!props.eventId) return scheduleStore.schedules
  return scheduleStore.schedules.filter(s => !s.eventId || s.eventId === props.eventId)
})

const scopedAssignments = computed(() => {
  if (!props.eventId) return scheduleStore.assignments
  const out: typeof scheduleStore.assignments = {}
  for (const [k, a] of Object.entries(scheduleStore.assignments)) {
    if (!a.eventId || a.eventId === props.eventId) {
      out[k] = a
    }
  }
  return out
})

const scopedRankings = computed(() => {
  if (!props.eventId || !recordStore.currentEventId || recordStore.currentEventId === props.eventId) {
    return recordStore.rankings
  }
  return []
})

const scopedBannedTeams = computed(() => {
  if (!props.eventId || !recordStore.currentEventId || recordStore.currentEventId === props.eventId) {
    return recordStore.bannedTeams
  }
  return []
})

// Unified team roster whitelist for Team Chip highlighting & @ autocomplete
const knownTeamsMap = computed<Map<number, string>>(() => {
  const map = new Map<number, string>()
  for (const ot of scopedOfficialTeams.value) {
    if (ot.teamNumber > 0) map.set(ot.teamNumber, ot.nameFull || '')
  }
  for (const r of scopedRankings.value) {
    if (r.teamNumber > 0 && !map.has(r.teamNumber)) map.set(r.teamNumber, '')
  }
  for (const rec of scopedActiveRecords.value) {
    if (rec.teamNumber > 0 && !map.has(rec.teamNumber)) map.set(rec.teamNumber, '')
  }
  for (const p of scopedActivePitRecords.value) {
    if (p.teamNumber > 0 && !map.has(p.teamNumber)) map.set(p.teamNumber, p.robotName || '')
  }
  for (const tg of scopedTags.value) {
    if (tg.teamNumber > 0 && !map.has(tg.teamNumber)) map.set(tg.teamNumber, '')
  }
  for (const banned of scopedBannedTeams.value) {
    if (banned > 0 && !map.has(banned)) map.set(banned, '')
  }
  for (const s of scopedSchedules.value) {
    for (const num of [s.red1, s.red2, s.blue1, s.blue2]) {
      if (num > 0 && !map.has(num)) map.set(num, '')
    }
  }
  const myTeam = aiStore.getMyTeamNumber(props.eventId)
  if (myTeam && myTeam > 0 && !map.has(myTeam)) {
    map.set(myTeam, '')
  }
  for (const ft of contextConfig.value.focusTeams) {
    if (ft > 0 && !map.has(ft)) map.set(ft, '')
  }
  return map
})

const knownTeamSet = computed(() => new Set(Array.from(knownTeamsMap.value.keys()).map(String)))
const knownTeamOptions = computed<KnownTeamOption[]>(() =>
  Array.from(knownTeamsMap.value.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([teamNumber, name]) => ({ teamNumber, name }))
)

const cachedTeamRegex = ref<RegExp | null>(null)
watch(
  knownTeamSet,
  set => {
    cachedTeamRegex.value = buildTeamRegex(set)
  },
  { immediate: true }
)

// Context Snapshot & Token Stats
const contextStats = computed(() => {
  if (!contextConfig.value.enabled) {
    return {
      text: '',
      estimatedTokens: 0,
      chars: 0,
      activeRecordsCount: 0,
      trackedTeamsCount: 0,
      pitCount: 0,
      scheduleCount: 0,
      focusTeamsCount: 0,
      truncatedMatchesCount: 0
    }
  }
  return buildContextPreviewStats({
    event: scopedEvent.value,
    rankings: scopedRankings.value,
    records: scopedRecords.value,
    bannedTeams: scopedBannedTeams.value,
    tags: scopedTags.value,
    pitRecords: scopedPitRecords.value,
    schedules: scopedSchedules.value,
    customFields: activeCustomFields.value,
    myTeamNumber: aiStore.getMyTeamNumber(props.eventId),
    focusTeams: contextConfig.value.focusTeams,
    focusMatch: contextConfig.value.focusMatch,
    sections: contextConfig.value.sections
  })
})

const contextBadgeLabel = computed(() => {
  if (!contextConfig.value.enabled) return t('ai.ctx_disabled')
  const tok = contextStats.value.estimatedTokens
  const tokStr = tok >= 1000 ? `${(tok / 1000).toFixed(1)}k` : String(tok)
  return `~${tokStr} tok · ${contextStats.value.trackedTeamsCount}T/${contextStats.value.activeRecordsCount}M`
})

const latestAssistantMessageId = computed(() => {
  for (let i = messages.value.length - 1; i >= 0; i--) {
    if (messages.value[i]!.role === 'assistant') return messages.value[i]!.id
  }
  return null
})

const latestFollowUpSuggestions = computed(() => {
  if (!latestAssistantMessageId.value || isStreaming.value) return []
  const msg = messages.value.find(m => m.id === latestAssistantMessageId.value)
  if (!msg) return []
  const cleanContent = stripTurboActionBlocks(msg.content || '').displayContent
  if (!cleanContent) return []
  return generateFollowUpSuggestions(
    cleanContent,
    knownTeamSet.value,
    aiStore.getMyTeamNumber(props.eventId),
    locale.value
  )
})

function buildEffectiveSystemPrompt(opts?: { forVoice?: boolean }): string {
  const baseDataContext = contextConfig.value.enabled ? contextStats.value.text : ''
  let fullDataContext = baseDataContext

  if (aiStore.aiMode === 'turbo' && !opts?.forVoice) {
    const turboInstructions = buildTurboSystemPromptSection({
      username: userStore.username || 'User',
      userId: userStore.userId || '',
      isHost: eventStore.isHost,
      locale: locale.value
    })
    const entitySnapshot = buildTurboEditableEntitySnapshot({
      userId: userStore.userId || '',
      records: scopedRecords.value,
      customFields: customFieldsStore.getFields(props.eventId),
      schedules: scopedSchedules.value,
      assignments: scopedAssignments.value,
      tags: scopedTags.value,
      bannedTeams: scopedBannedTeams.value
    })
    fullDataContext = [baseDataContext, turboInstructions, entitySnapshot]
      .filter(s => Boolean(s && s.trim()))
      .join('\n\n')
  }

  return assembleSystemPrompt({
    personaId: activePersonaId.value,
    profileSystemPrompt: aiStore.activeProfile?.systemPrompt,
    dataContext: fullDataContext,
    locale: locale.value
  })
}

function buildBriefContextLabel(): string | undefined {
  if (!contextConfig.value.enabled) return undefined
  if (contextConfig.value.focusTeams.length > 0) {
    return contextConfig.value.focusTeams.map(n => `#${n}`).join(',')
  }
  return `${contextStats.value.trackedTeamsCount}T`
}

const voiceSession = useAiVoiceSession({
  eventId: () => props.eventId,
  activeThread,
  buildEffectiveSystemPrompt: () => buildEffectiveSystemPrompt({ forVoice: true }),
  buildBriefContextLabel
})

const voiceTooltip = computed(() => {
  if (voiceSession.engine.value === 'gemini-live') return t('ai.voice.tooltip_gemini')
  if (voiceSession.engine.value === 'openai-realtime') return t('ai.voice.tooltip_openai')
  return t('ai.voice.tooltip_turn')
})

function handleStartOrFocusVoice() {
  if (voiceSession.isActive.value) {
    voiceSession.isMinimized.value = false
    return
  }
  void voiceSession.startSession()
}

async function handleSend(rawText: string) {
  const clean = rawText.trim()
  if (!clean) return
  if (needsProfileRefresh()) {
    await aiStore.fetchProfiles()
  }
  if (!aiStore.activeProfile) {
    aiStore.openSettingsModal()
    return
  }
  draftText.value = ''
  scrollToBottom(true)
  await aiStore.sendChatMessage({
    eventId: props.eventId,
    prompt: clean,
    effectiveSystemPrompt: buildEffectiveSystemPrompt(),
    contextSummary: buildBriefContextLabel(),
    errorPrefix: t('ai.error_prefix')
  })
  scrollToBottom(false)
}

async function handleStarterClick(card: StarterCardItem) {
  const thread = await aiStore.ensureActiveThread(props.eventId)
  if (thread && (card.focusTeams?.length || card.focusMatch)) {
    aiStore.updateThreadContextConfig(props.eventId, {
      enabled: true,
      focusTeams: card.focusTeams || [],
      focusMatch: card.focusMatch ?? null
    })
  }
  await nextTick()
  const prompt = isZh.value ? card.promptZh : card.promptEn
  await handleSend(prompt)
}

async function handleRegenerate(messageId: string) {
  await aiStore.regenerateAssistantMessage({
    eventId: props.eventId,
    messageId,
    effectiveSystemPrompt: buildEffectiveSystemPrompt(),
    contextSummary: buildBriefContextLabel(),
    errorPrefix: t('ai.error_prefix')
  })
}

async function handleEditResend(payload: { messageId: string; newContent: string }) {
  await aiStore.editAndResendUserMessage({
    eventId: props.eventId,
    messageId: payload.messageId,
    newContent: payload.newContent,
    effectiveSystemPrompt: buildEffectiveSystemPrompt(),
    contextSummary: buildBriefContextLabel(),
    errorPrefix: t('ai.error_prefix')
  })
}

function toggleSection(sec: keyof AiContextSections) {
  const cur = contextConfig.value.sections[sec]
  if (!activeThread.value) {
    void aiStore.ensureActiveThread(props.eventId).then(() => {
      aiStore.updateThreadContextConfig(props.eventId, { sections: { [sec]: !cur } as any })
    })
    return
  }
  aiStore.updateThreadContextConfig(props.eventId, { sections: { [sec]: !cur } as any })
}

function toggleContextEnabled() {
  const next = !contextConfig.value.enabled
  if (!activeThread.value) {
    void aiStore.ensureActiveThread(props.eventId).then(() => {
      aiStore.updateThreadContextConfig(props.eventId, { enabled: next })
    })
    return
  }
  aiStore.updateThreadContextConfig(props.eventId, { enabled: next })
}

function addFocusTeam(teamNum: number) {
  if (!teamNum || isNaN(teamNum)) return
  const existing = contextConfig.value.focusTeams
  if (existing.includes(teamNum)) return
  const next = [...existing, teamNum]
  if (!activeThread.value) {
    void aiStore.ensureActiveThread(props.eventId).then(() => {
      aiStore.updateThreadContextConfig(props.eventId, { focusTeams: next })
    })
    return
  }
  aiStore.updateThreadContextConfig(props.eventId, { focusTeams: next })
}

function removeFocusTeam(teamNum: number) {
  const next = contextConfig.value.focusTeams.filter(team => team !== teamNum)
  aiStore.updateThreadContextConfig(props.eventId, { focusTeams: next })
}

function clearFocusMatch() {
  aiStore.updateThreadContextConfig(props.eventId, { focusMatch: null })
}

function handlePersonaChange(val: string) {
  if (!activeThread.value) {
    void aiStore.createThread(props.eventId, { personaId: val })
  } else {
    aiStore.updateThreadPersona(props.eventId, val)
  }
}

function exportActiveThreadMarkdown() {
  const thr = activeThread.value
  if (!thr) return
  exportThreadToMarkdown({
    thread: thr,
    eventName: eventStore.currentEvent?.name || props.eventId,
    labels: {
      event: t('ai.export_event'),
      persona: t('ai.export_persona'),
      time: t('ai.export_time'),
      reasoning: t('ai.export_reasoning'),
      roleYou: t('ai.role_you'),
      roleCopilot: t('ai.role_copilot')
    }
  })
}

async function handleClearThread() {
  const ok = await showConfirm({
    title: t('confirm_dialog.title'),
    message: t('ai.clear_confirm'),
    type: 'danger',
    confirmText: t('confirm_dialog.danger_confirm'),
    cancelText: t('confirm_dialog.cancel')
  })
  if (ok) {
    await aiStore.clearThreadMessages(props.eventId)
  }
}

function handleTeamClick(teamNum: number) {
  if (!teamNum || isNaN(teamNum) || !props.eventId) return
  hoverPreview.value = null
  const tabContent = typeof document !== 'undefined'
    ? (document.querySelector('.tab-content') as HTMLElement | null)
    : null
  const queryTab = route?.query?.tab as EventTab | undefined
  const validTabs: EventTab[] = ['scout', 'pit', 'schedule', 'whiteboard', 'rankings', 'history', 'scouts', 'ai']
  const fromTab: EventTab =
    props.mode === 'mobile'
      ? 'ai'
      : queryTab && validTabs.includes(queryTab)
        ? queryTab
        : 'rankings'
  navStore.saveEventPosition({
    eventId: props.eventId,
    fromTab,
    contentScrollTop: tabContent ? tabContent.scrollTop : typeof window !== 'undefined' ? window.scrollY : 0,
    contentScrollLeft: tabContent ? tabContent.scrollLeft : typeof window !== 'undefined' ? window.scrollX : 0,
    aiChatScrollTop: scrollRef.value ? scrollRef.value.scrollTop : null,
    teamNumber: teamNum
  })
  void aiStore.flushPendingSaves()
  if (router) {
    void router.push(`/event/${props.eventId}/team/${teamNum}`)
  }
}

function handleTeamHover(payload: { teamNumber: number; anchorRect: DOMRect }) {
  const tn = payload.teamNumber
  const rankIdx = scopedRankings.value.findIndex(r => r.teamNumber === tn)
  const row = rankIdx >= 0 ? scopedRankings.value[rankIdx] : undefined
  const pitRec = scopedActivePitRecords.value.find(p => p.teamNumber === tn) || null
  const teamRecs = scopedActiveRecords.value.filter(r => r.teamNumber === tn)
  const brag = calculateBragIndex(pitRec, teamRecs)
  const teamTags = scopedTags.value.filter(tg => tg.teamNumber === tn).map(tg => tg.tag).slice(0, 4)

  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
  const left = Math.max(12, Math.min(vw - 260, payload.anchorRect.left))
  const top = Math.max(12, payload.anchorRect.top - 110)

  hoverPreview.value = {
    teamNumber: tn,
    left,
    top,
    rankIdx: rankIdx >= 0 ? rankIdx + 1 : undefined,
    avgRating: row?.avgRating,
    predictCycle: row?.predictCycleTime,
    bragLabel: brag ? `${brag.overallRatio}x (${brag.tier})` : undefined,
    tags: teamTags
  }
}

// Auto-scroll helpers
function isNearBottom(): boolean {
  const el = scrollRef.value
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < 90
}

function handleScroll() {
  showScrollBottomBtn.value = !isNearBottom()
  if (hoverPreview.value) {
    hoverPreview.value = null
  }
}

function scrollToBottom(force = false) {
  nextTick(() => {
    const el = scrollRef.value
    if (el && (force || isNearBottom())) {
      el.scrollTop = el.scrollHeight
      showScrollBottomBtn.value = false
    }
  })
}

watch(
  () => {
    const last = messages.value[messages.value.length - 1]
    return [messages.value.length, last?.content?.length || 0, last?.reasoning?.length || 0]
  },
  () => {
    if (isStreaming.value) {
      scrollToBottom(false)
    }
  }
)

watch(
  () => aiStore.pendingAutoSendByEvent[props.eventId],
  async pending => {
    if (!pending) return
    aiStore.clearPendingAutoSend(props.eventId)
    if (needsProfileRefresh()) {
      await aiStore.fetchProfiles()
    }
    await nextTick()
    await handleSend(pending.prompt)
  },
  { immediate: true }
)

async function syncCustomFieldsSilently(eventId: string) {
  if (!eventId) return
  try {
    await customFieldsStore.fetchFields(eventId)
  } catch {
    // Offline or transient network error: keep cached fields silently
  }
}

function needsProfileRefresh(): boolean {
  if (aiStore.profiles.length === 0) return true
  const uid = userStore.userId
  return Boolean(uid && aiStore.profiles.some(p => p.userId && p.userId !== uid))
}

watch(
  () => userStore.userId,
  async (newUid, oldUid) => {
    if (newUid && newUid !== oldUid) {
      await aiStore.fetchProfiles()
      if (props.eventId) {
        await aiStore.loadEventThreads(props.eventId)
      }
    }
  }
)

watch(
  () => props.eventId,
  async newEvtId => {
    hoverPreview.value = null
    if (voiceSession.isActive.value) {
      voiceSession.stopSession()
    }
    if (newEvtId) {
      await Promise.all([
        aiStore.loadEventThreads(newEvtId),
        syncCustomFieldsSilently(newEvtId)
      ])
    }
  }
)

onMounted(async () => {
  if (typeof ResizeObserver !== 'undefined' && workspaceRef.value) {
    resizeObserver = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect?.width
      if (w && w > 0) containerWidth.value = w
    })
    resizeObserver.observe(workspaceRef.value)
  }

  if (needsProfileRefresh()) {
    await aiStore.fetchProfiles()
  }
  if (props.eventId) {
    await Promise.all([
      aiStore.loadEventThreads(props.eventId),
      syncCustomFieldsSilently(props.eventId)
    ])
  }
  scrollToBottom(true)
})

onUnmounted(() => {
  voiceSession.stopSession()
  resizeObserver?.disconnect()
  void aiStore.flushPendingSaves()
})

const activeProfileLabel = computed(() => {
  const p = aiStore.activeProfile
  if (!p) return t('ai.unconfigured')
  return `${PROTOCOL_META[p.protocol].badge} · ${p.modelName || p.name}`
})
</script>

<template>
  <section ref="workspaceRef" class="copilot-workspace" :class="{ 'mobile-mode': mode === 'mobile' }">
    <!-- Top Workspace Toolbar -->
    <header class="workspace-header">
      <div class="hdr-left">
        <button
          v-if="!isWideContainer"
          type="button"
          class="hdr-icon-btn"
          :class="{ active: aiStore.threadSidebarOpen }"
          :title="t('ai.toggle_threads')"
          @click="aiStore.threadSidebarOpen = !aiStore.threadSidebarOpen"
        >
          <span class="material-icons">forum</span>
        </button>

        <AiModelQuickSwitcher
          :profiles="aiStore.profiles"
          :active-profile="aiStore.activeProfile"
          @activate-profile="id => aiStore.activateProfile(id)"
          @switch-model="(id, model) => aiStore.quickSwitchModel(id, model)"
          @open-settings="aiStore.openSettingsModal()"
        />
      </div>

      <div class="hdr-right">
        <button
          type="button"
          class="hdr-icon-btn"
          :title="t('ai.new_thread')"
          @click="aiStore.createThread(eventId)"
        >
          <span class="material-icons">add_comment</span>
        </button>
        <button
          type="button"
          class="hdr-icon-btn"
          :disabled="!activeThread || messages.length === 0"
          :title="t('ai.export_markdown')"
          @click="exportActiveThreadMarkdown"
        >
          <span class="material-icons">download</span>
        </button>
        <button
          v-if="mode === 'dock'"
          type="button"
          class="hdr-icon-btn"
          :class="{ active: aiStore.isDockExpanded }"
          :title="aiStore.isDockExpanded ? t('ai.collapse_focus') : t('ai.expand_focus')"
          @click="aiStore.setDockExpanded(!aiStore.isDockExpanded)"
        >
          <span class="material-icons">{{ aiStore.isDockExpanded ? 'close_fullscreen' : 'open_in_full' }}</span>
        </button>
        <button
          type="button"
          class="hdr-icon-btn"
          :title="t('ai.tab_settings')"
          @click="aiStore.openSettingsModal()"
        >
          <span class="material-icons">settings</span>
        </button>
        <button
          v-if="messages.length > 0"
          type="button"
          class="hdr-icon-btn"
          :title="t('ai.btn_clear')"
          @click="handleClearThread"
        >
          <span class="material-icons">delete_sweep</span>
        </button>
        <button
          v-if="mode === 'dock'"
          type="button"
          class="hdr-icon-btn"
          :title="t('team_drawer.close')"
          @click="aiStore.setDockOpen(false)"
        >
          <span class="material-icons">close</span>
        </button>
      </div>
    </header>

    <AiContextRibbon
      v-model:my-team-input="myTeamInput"
      :active-persona-id="activePersonaId"
      :context-config="contextConfig"
      :context-badge-label="contextBadgeLabel"
      @change-persona="handlePersonaChange"
      @toggle-context="toggleContextEnabled"
      @toggle-section="toggleSection"
      @remove-focus-team="removeFocusTeam"
      @clear-focus-match="clearFocusMatch"
    />

    <!-- Main Body: Sidebar + Message Timeline -->
    <div class="workspace-body">
      <Transition name="ai-sidebar-slide">
        <AiThreadSidebar
          v-if="showSidebar"
          :threads="threads"
          :active-thread-id="activeThread?.id || ''"
          :streaming-by-thread="aiStore.streamingByThread"
          :docked="isWideContainer"
          @select="id => { aiStore.selectThread(eventId, id); aiStore.threadSidebarOpen = false }"
          @create="aiStore.createThread(eventId)"
          @rename="payload => aiStore.renameThread(eventId, payload.threadId, payload.title)"
          @toggle-pin="id => aiStore.togglePinThread(eventId, id)"
          @delete="id => aiStore.deleteThread(eventId, id)"
          @export-active="exportActiveThreadMarkdown"
          @close="aiStore.threadSidebarOpen = false"
        />
      </Transition>

      <div class="messages-column">
        <div ref="scrollRef" class="messages-scroll" @scroll="handleScroll">
          <AiEmptyState
            v-if="messages.length === 0"
            :is-configured="aiStore.canSendWithActiveProfile"
            :rankings="scopedRankings"
            :schedules="scopedSchedules"
            :my-team-number="aiStore.getMyTeamNumber(eventId)"
            @open-settings="aiStore.openSettingsModal()"
            @pick-starter="handleStarterClick"
          />

          <AiMessageItem
            v-for="msg in messages"
            :key="msg.id"
            :message="msg"
            :is-streaming="Boolean(activeThread && aiStore.getStreamingMessageId(activeThread.id) === msg.id)"
            :is-latest-assistant="msg.id === latestAssistantMessageId"
            :known-team-regex="cachedTeamRegex"
            :follow-up-suggestions="msg.id === latestAssistantMessageId ? latestFollowUpSuggestions : undefined"
            @team-click="handleTeamClick"
            @team-hover="handleTeamHover"
            @team-leave="hoverPreview = null"
            @regenerate="handleRegenerate"
            @edit-resend="handleEditResend"
            @delete-message="id => aiStore.deleteThreadMessage(eventId, id)"
            @send-follow-up="prompt => handleSend(prompt)"
          />
        </div>

        <Transition name="ai-pop">
          <button
            v-if="showScrollBottomBtn"
            type="button"
            class="btn-scroll-bottom"
            :title="t('ai.scroll_to_bottom')"
            @click="scrollToBottom(true)"
          >
            <span class="material-icons">arrow_downward</span>
          </button>
        </Transition>
      </div>
    </div>

    <AiVoiceCallOverlay
      :is-active="voiceSession.isActive.value"
      :is-minimized="voiceSession.isMinimized.value"
      :status="voiceSession.status.value"
      :engine="voiceSession.engine.value"
      :capability="voiceSession.capability.value"
      :is-native-live="voiceSession.isNativeLive.value"
      :input-mode="voiceSession.inputMode.value"
      :is-muted="voiceSession.isMuted.value"
      :is-ptt-holding="voiceSession.isPttHolding.value"
      :input-level="voiceSession.inputLevel.value"
      :output-level="voiceSession.outputLevel.value"
      :elapsed-seconds="voiceSession.elapsedSeconds.value"
      :selected-model="voiceSession.selectedModel.value"
      :selected-voice="voiceSession.selectedVoice.value"
      :stt-helper-profile-id="voiceSession.sttHelperProfileId.value"
      :stt-helpers="voiceSession.sttHelpers.value"
      :active-stt-profile="voiceSession.activeSttProfile.value"
      :auto-speak-turn-voice="voiceSession.autoSpeakTurnVoice.value"
      :force-open-ai-realtime="voiceSession.forceOpenAiRealtime.value"
      :can-use-browser-speech-rec="voiceSession.canUseBrowserSpeechRec"
      :live-user-transcript="voiceSession.liveUserTranscript.value"
      :live-assistant-transcript="voiceSession.liveAssistantTranscript.value"
      :last-completed-turn="voiceSession.lastCompletedTurn.value"
      :error-message="voiceSession.errorMessage.value"
      :go-away-warning="voiceSession.goAwayWarning.value"
      @update:is-minimized="v => (voiceSession.isMinimized.value = v)"
      @update:input-mode="v => (voiceSession.inputMode.value = v)"
      @update:selected-model="v => (voiceSession.selectedModel.value = v)"
      @update:selected-voice="v => (voiceSession.selectedVoice.value = v)"
      @update:stt-helper-profile-id="v => (voiceSession.sttHelperProfileId.value = v)"
      @update:auto-speak-turn-voice="v => (voiceSession.autoSpeakTurnVoice.value = v)"
      @toggle-force-realtime="v => voiceSession.setForceOpenAiRealtime(v)"
      @apply-and-reconnect="voiceSession.applySettingsAndReconnect()"
      @retry="voiceSession.startSession()"
      @stop="voiceSession.stopSession()"
      @toggle-mute="voiceSession.toggleMute()"
      @begin-ptt="voiceSession.beginPtt()"
      @end-ptt="voiceSession.endPtt()"
      @interrupt="voiceSession.interrupt()"
      @send-text="txt => voiceSession.sendTextInCall(txt)"
    />

    <AiChatComposer
      v-model="draftText"
      :is-streaming="isStreaming"
      :known-teams="knownTeamOptions"
      :active-profile-label="activeProfileLabel"
      :ai-mode="aiStore.aiMode"
      :thinking-mode="aiStore.thinkingMode"
      :voice-supported="true"
      :voice-active="voiceSession.isActive.value"
      :voice-tooltip="voiceTooltip"
      @update:ai-mode="aiStore.setAiMode"
      @update:thinking-mode="aiStore.setThinkingMode"
      @send="handleSend"
      @stop="aiStore.stopStreaming(activeThread?.id)"
      @add-focus-team="addFocusTeam"
      @start-voice="handleStartOrFocusVoice"
    />

    <Transition name="ai-pop">
      <AiTeamHoverCard v-if="hoverPreview" :preview="hoverPreview" />
    </Transition>
  </section>
</template>

<style scoped src="./AiCopilotWorkspace.css"></style>
