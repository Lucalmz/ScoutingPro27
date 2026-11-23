<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { createDefaultContextConfig, useAiStore } from '@/stores/ai'
import { useRecordStore } from '@/stores/records'
import { useEventStore } from '@/stores/events'
import { usePitScoutStore } from '@/stores/pitScout'
import { useScheduleStore } from '@/stores/schedule'
import { useCustomFieldsStore } from '@/stores/customFields'
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
import { exportThreadToMarkdown } from '@/components/ai/exportThread'
import { buildTeamRegex } from '@/components/ai/teamMatcher'
import { calculateBragIndex } from '@/utils/bragIndex'
import TeamDetailDrawer from '@/components/common/TeamDetailDrawer.vue'
import AiThreadSidebar from './AiThreadSidebar.vue'
import AiEmptyState from './AiEmptyState.vue'
import AiMessageItem from './AiMessageItem.vue'
import AiChatComposer, { type KnownTeamOption } from './AiChatComposer.vue'
import AiModelQuickSwitcher from './workspace/AiModelQuickSwitcher.vue'
import AiContextRibbon from './workspace/AiContextRibbon.vue'
import AiTeamHoverCard, { type TeamHoverPreview } from './workspace/AiTeamHoverCard.vue'

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
const aiStore = useAiStore()
const recordStore = useRecordStore()
const eventStore = useEventStore()
const pitStore = usePitScoutStore()
const scheduleStore = useScheduleStore()
const customFieldsStore = useCustomFieldsStore()
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
const drawerTeamNumber = ref<number | null>(null)
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
  props.eventId ? customFieldsStore.getActiveFields(props.eventId, 'MATCH') : []
)

// Unified team roster whitelist for Team Chip highlighting & @ autocomplete
const knownTeamsMap = computed<Map<number, string>>(() => {
  const map = new Map<number, string>()
  for (const ot of pitStore.officialTeams) {
    if (ot.teamNumber > 0) map.set(ot.teamNumber, ot.nameFull || '')
  }
  for (const r of recordStore.rankings) {
    if (r.teamNumber > 0 && !map.has(r.teamNumber)) map.set(r.teamNumber, '')
  }
  for (const p of pitStore.activeRecords) {
    if (p.teamNumber > 0 && !map.has(p.teamNumber)) map.set(p.teamNumber, '')
  }
  for (const s of scheduleStore.schedules) {
    for (const num of [s.red1, s.red2, s.blue1, s.blue2]) {
      if (num > 0 && !map.has(num)) map.set(num, '')
    }
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
    event: eventStore.currentEvent,
    rankings: recordStore.rankings,
    records: recordStore.records,
    bannedTeams: recordStore.bannedTeams,
    tags: recordStore.teamTags,
    pitRecords: pitStore.records,
    schedules: scheduleStore.schedules,
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
  if (!msg || !msg.content) return []
  return generateFollowUpSuggestions(
    msg.content,
    knownTeamSet.value,
    aiStore.getMyTeamNumber(props.eventId),
    locale.value
  )
})

function buildEffectiveSystemPrompt(): string {
  const dataContext = contextConfig.value.enabled ? contextStats.value.text : ''
  return assembleSystemPrompt({
    personaId: activePersonaId.value,
    profileSystemPrompt: aiStore.activeProfile?.systemPrompt,
    dataContext,
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

async function handleSend(rawText: string) {
  const clean = rawText.trim()
  if (!clean) return
  if (aiStore.profiles.length === 0) {
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

function handleTeamHover(payload: { teamNumber: number; anchorRect: DOMRect }) {
  const tn = payload.teamNumber
  const rankIdx = recordStore.rankings.findIndex(r => r.teamNumber === tn)
  const row = rankIdx >= 0 ? recordStore.rankings[rankIdx] : undefined
  const pitRec = pitStore.getUnifiedTeam(tn)?.pitRecord
  const teamRecs = recordStore.activeRecords.filter(r => r.teamNumber === tn)
  const brag = calculateBragIndex(pitRec, teamRecs)
  const teamTags = recordStore.teamTags.filter(tg => tg.teamNumber === tn).map(tg => tg.tag).slice(0, 4)

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
    if (aiStore.profiles.length === 0) {
      await aiStore.fetchProfiles()
    }
    await nextTick()
    await handleSend(pending.prompt)
  },
  { immediate: true }
)

watch(
  () => props.eventId,
  async newEvtId => {
    if (newEvtId) {
      await aiStore.loadEventThreads(newEvtId)
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

  if (aiStore.profiles.length === 0) {
    await aiStore.fetchProfiles()
  }
  if (props.eventId) {
    await aiStore.loadEventThreads(props.eventId)
  }
  scrollToBottom(true)
})

onUnmounted(() => {
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

      <div class="messages-column">
        <div ref="scrollRef" class="messages-scroll" @scroll="handleScroll">
          <AiEmptyState
            v-if="messages.length === 0"
            :is-configured="aiStore.canSendWithActiveProfile"
            :rankings="recordStore.rankings"
            :schedules="scheduleStore.schedules"
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
            @team-click="num => (drawerTeamNumber = num)"
            @team-hover="handleTeamHover"
            @team-leave="hoverPreview = null"
            @regenerate="handleRegenerate"
            @edit-resend="handleEditResend"
            @delete-message="id => aiStore.deleteThreadMessage(eventId, id)"
            @send-follow-up="prompt => handleSend(prompt)"
          />
        </div>

        <button
          v-if="showScrollBottomBtn"
          type="button"
          class="btn-scroll-bottom"
          :title="t('ai.scroll_to_bottom')"
          @click="scrollToBottom(true)"
        >
          <span class="material-icons">arrow_downward</span>
        </button>
      </div>
    </div>

    <AiChatComposer
      v-model="draftText"
      :is-streaming="isStreaming"
      :known-teams="knownTeamOptions"
      :active-profile-label="activeProfileLabel"
      @send="handleSend"
      @stop="aiStore.stopStreaming(activeThread?.id)"
      @add-focus-team="addFocusTeam"
    />

    <AiTeamHoverCard v-if="hoverPreview" :preview="hoverPreview" />

    <TeamDetailDrawer
      :team-number="drawerTeamNumber"
      :event-id="eventId"
      @close="drawerTeamNumber = null"
    />
  </section>
</template>

<style scoped src="./AiCopilotWorkspace.css"></style>
