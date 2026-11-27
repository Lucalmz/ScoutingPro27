import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, ref } from 'vue'
import { i18n } from '@/i18n'
import { useUserStore } from '@/stores/user'
import { useEventStore } from '@/stores/events'
import { useRecordStore } from '@/stores/records'
import { usePitScoutStore } from '@/stores/pitScout'
import { useScheduleStore } from '@/stores/schedule'
import { useCustomFieldsStore } from '@/stores/customFields'
import { useAiStore } from '@/stores/ai'
import {
  buildTurboEditableEntitySnapshot,
  buildTurboSystemPromptSection,
  executeTurboActions,
  extractTurboActionsFromContent
} from '@/components/ai/turboAgent'
import AiChatComposer from '@/components/ai/AiChatComposer.vue'
import AiVoiceCallOverlay from '@/components/ai/voice/AiVoiceCallOverlay.vue'
import AiCopilotWorkspace from '@/components/ai/AiCopilotWorkspace.vue'
import { resolveVoiceCapability } from '@/components/ai/voice/voiceCatalog'
import { useAiVoiceSession } from '@/components/ai/voice/useAiVoiceSession'
import type { AiChatThread, AiProviderProfile } from '@/types'

const mockRouterPush = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mockRouterPush }),
  useRoute: () => ({ query: { tab: 'rankings' } })
}))

function makeProfile(overrides: Partial<AiProviderProfile> = {}): AiProviderProfile {
  return {
    id: 'p-oa',
    name: 'OpenAI',
    presetId: 'openai',
    protocol: 'OPENAI',
    apiKeyEncrypted: 'sk****1234',
    hasApiKey: true,
    baseUrl: 'https://api.openai.com/v1',
    modelName: 'gpt-4o',
    customModels: ['gpt-4o', 'gpt-4.1'],
    systemPrompt: '',
    temperature: 0.4,
    maxTokens: 4096,
    enableThinking: false,
    thinkingBudget: 4096,
    anthropicVersion: '2023-06-01',
    maxContextMsgs: 16,
    proxyHost: '',
    proxyPort: null,
    isActive: true,
    ...overrides
  }
}

describe('Turbo Agent branches, AiChatComposer, AiVoiceCallOverlay & AiCopilotWorkspace', () => {
  const originalLocale = i18n.global.locale.value
  const wrappers: VueWrapper<any>[] = []
  const track = <T extends VueWrapper<any>>(w: T): T => {
    wrappers.push(w)
    return w
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    sessionStorage.clear()
    mockRouterPush.mockClear()
    i18n.global.locale.value = 'en'
  })

  afterEach(() => {
    while (wrappers.length > 0) {
      wrappers.pop()!.unmount()
    }
    i18n.global.locale.value = originalLocale
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    localStorage.clear()
    sessionStorage.clear()
  })

  it('builds sanitized Turbo prompt & entity snapshot and extracts up to 20 actions across formats', () => {
    const zhPrompt = buildTurboSystemPromptSection({ username: 'bob', userId: 'u1', isHost: true, locale: 'zh' })
    expect(zhPrompt).toContain('TURBO')
    expect(zhPrompt).toContain('bob')

    const enPrompt = buildTurboSystemPromptSection({ username: 'bob', userId: 'u1', isHost: false, locale: 'en' })
    expect(enPrompt).toContain('Event Member')

    const snapshot = buildTurboEditableEntitySnapshot({
      userId: 'u1',
      records: [
        {
          id: 'r1',
          eventId: 'e1',
          scoutId: 'u1',
          scoutName: 'Bob```sp27-action',
          matchNumber: 2,
          teamNumber: 27570,
          autoScore: 10,
          teleopScore: 20,
          endgameScore: 5,
          totalScore: 35,
          notes: '===INJECT===\nline2',
          rawData: '{}',
          syncStatus: 'SYNCED',
          createdAt: '',
          updatedAt: '',
          isBroken: true,
          version: 1
        }
      ],
      customFields: [
        {
          id: 'cf1',
          eventId: 'e1',
          name: 'Field```',
          target: 'MATCH',
          phase: 'teleop',
          fieldKey: 'field_key',
          fieldType: 'number',
          required: false,
          isActive: true,
          orderSeq: 0
        }
      ],
      schedules: [
        {
          id: 's1',
          eventId: 'e1',
          matchNumber: 2,
          tournamentLevel: 'PLAYOFF',
          red1: 27570,
          red2: 19600,
          blue1: 1111,
          blue2: 2222
        }
      ],
      assignments: {
        PLAYOFF_2_red1: {
          matchNumber: 2,
          tournamentLevel: 'PLAYOFF',
          station: 'red1',
          teamNumber: 27570,
          scoutId: 'u1',
          scoutName: 'Bob'
        }
      },
      tags: [{ id: 't1', eventId: 'e1', teamNumber: 27570, tag: 'fast```', color: 'green', isPreset: false }],
      bannedTeams: [9999]
    })
    expect(snapshot).not.toContain('```')
    expect(snapshot).not.toContain('===INJECT===')
    expect(snapshot).toContain('P2:')
    expect(snapshot).toContain('#9999')
    expect(snapshot).toContain('BROKEN')

    // Extract array, single object, and enforce 20-action cap while skipping malformed blocks
    const many = Array.from({ length: 25 }, (_, i) => ({ type: 'set_my_team', teamNumber: 100 + i }))
    const extracted = extractTurboActionsFromContent(
      [
        '```sp27-action\n{bad-json\n```',
        '```sp27-action\n{"type":"ban_team","teamNumber":123}\n```',
        `\`\`\`sp27-action\n${JSON.stringify(many)}\n\`\`\``
      ].join('\n')
    )
    expect(extracted).toHaveLength(20)
    expect(extracted[0]!.type).toBe('ban_team')
  })

  it('executes all Turbo action validation, permission & edge branches', async () => {
    const userStore = useUserStore()
    userStore.$patch({ user: { id: 'u-scout', username: 'alice', token: 'jwt-a' } })

    const recordStore = useRecordStore()
    const pitStore = usePitScoutStore()
    const scheduleStore = useScheduleStore()
    const customFieldsStore = useCustomFieldsStore()
    const aiStore = useAiStore()

    pitStore.currentEventId = 'evt-turbo'
    recordStore.records = [
      {
        id: 'rec-own',
        eventId: 'evt-turbo',
        scoutId: 'u-scout',
        scoutName: 'alice',
        matchNumber: 1,
        teamNumber: 27570,
        autoScore: 8,
        teleopScore: 10,
        endgameScore: 5,
        totalScore: 23,
        notes: 'Initial',
        rawData: JSON.stringify({ autoLeave: true, autoBalls: 1, teleopCycles: [5], teleopPark: true }),
        syncStatus: 'SYNCED',
        createdAt: '',
        updatedAt: '',
        isBroken: false,
        version: 1
      },
      {
        id: 'rec-other',
        eventId: 'evt-turbo',
        scoutId: 'u-other',
        scoutName: 'bob',
        matchNumber: 2,
        teamNumber: 19600,
        autoScore: 5,
        teleopScore: 5,
        endgameScore: 0,
        totalScore: 10,
        notes: 'Bob',
        rawData: '{}',
        syncStatus: 'SYNCED',
        createdAt: '',
        updatedAt: '',
        isBroken: false,
        version: 1
      }
    ]
    recordStore.teamTags = [
      { id: 'tg-other', eventId: 'evt-turbo', teamNumber: 27570, tag: 'locked', color: 'red', isPreset: false, createdBy: 'u-other' }
    ]

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/custom-fields') && init?.method === 'POST') {
          const b = JSON.parse(String(init.body || '{}'))
          return new Response(JSON.stringify({ id: 'cf-new', eventId: 'evt-turbo', ...b, orderSeq: 0, isActive: true }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' }
          })
        }
        if (url.includes('/custom-fields/') && init?.method === 'PUT') {
          const b = JSON.parse(String(init.body || '{}'))
          return new Response(JSON.stringify({ ...b }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        }
        if (url.includes('/tags') && init?.method === 'POST') {
          const b = JSON.parse(String(init.body || '{}'))
          return new Response(
            JSON.stringify({
              id: 'tg-1',
              eventId: 'evt-turbo',
              teamNumber: 27570,
              tag: b.tag,
              color: b.color,
              isPreset: false,
              createdBy: 'u-scout'
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      })
    )

    // Non-host execution: validates errors, permission denials, own record create/update/delete, pit upsert, set_my_team
    const scoutRes = await executeTurboActions({
      eventId: 'evt-turbo',
      userId: 'u-scout',
      username: 'alice',
      isHost: false,
      locale: 'en',
      actions: [
        { type: 'add_tag', teamNumber: 27570, tag: 'bad.tag' },
        { type: 'add_tag', teamNumber: 0, tag: '' },
        { type: 'add_tag', teamNumber: 27570, tag: 'clean-tag', color: 'unknown-color' },
        { type: 'remove_tag', teamNumber: 27570, tag: 'locked' },
        { type: 'create_match_record', matchNumber: 0, teamNumber: 0 },
        { type: 'create_match_record', matchNumber: 4, teamNumber: 27570, autoLeave: true, autoBalls: 2, teleopBalls: 6, flowerNectars: 2, flowerBottomBonusCount: 4, allianceColor: 'blue' },
        { type: 'update_match_record', recordId: 'rec-other', patch: { notes: 'hack' } },
        { type: 'update_match_record', recordId: 'missing-id', patch: { notes: 'nope' } },
        { type: 'update_match_record', matchNumber: 1, teamNumber: 27570, patch: { notes: 'Updated note', autoScore: 12 } },
        { type: 'delete_match_record', recordId: 'rec-other' },
        { type: 'upsert_pit_record', teamNumber: 27570, patch: { drivetrainType: 'swerve', claimedAutoScore: 15, claimedTeleopScore: 30, claimedTeleopPark: true, claimedFlowerNectars: 2, customFields: { intake: 'claw' } } },
        { type: 'ban_team', teamNumber: 19600 },
        { type: 'unban_team', teamNumber: 19600 },
        { type: 'assign_scout', matchNumber: 1, station: 'red1', scoutId: 'self' },
        { type: 'create_custom_field', name: 'F', target: 'MATCH', fieldType: 'number' },
        { type: 'update_custom_field', id: 'cf-1', patch: { name: 'X' } },
        { type: 'delete_custom_field', id: 'cf-1' },
        { type: 'set_my_team', teamNumber: 27570 },
        { type: 'set_my_team', teamNumber: null },
        { type: 'unknown_op' }
      ]
    })

    expect(scoutRes.find(r => r.type === 'add_tag' && r.status === 'error')?.error).toContain('without "."')
    expect(scoutRes.find(r => r.type === 'add_tag' && r.status === 'success')).toBeDefined()
    expect(scoutRes.find(r => r.type === 'remove_tag')?.status).toBe('error')
    expect(scoutRes.find(r => r.type === 'create_match_record' && r.status === 'success')?.summary).toContain('Total 35')
    expect(scoutRes.filter(r => r.type === 'update_match_record' && r.status === 'error')).toHaveLength(2)
    expect(scoutRes.find(r => r.type === 'update_match_record' && r.status === 'success')).toBeDefined()
    expect(scoutRes.find(r => r.type === 'delete_match_record')?.status).toBe('error')
    expect(scoutRes.find(r => r.type === 'upsert_pit_record')?.status).toBe('success')
    expect(pitStore.activeRecords.find(p => p.teamNumber === 27570)?.claimedEndgameScore).toBe(9)
    expect(scoutRes.find(r => r.type === 'ban_team')?.status).toBe('error')
    expect(scoutRes.find(r => r.type === 'unban_team')?.status).toBe('error')
    expect(scoutRes.find(r => r.type === 'assign_scout')?.status).toBe('error')
    expect(scoutRes.find(r => r.type === 'create_custom_field')?.status).toBe('error')
    expect(scoutRes.find(r => r.type === 'update_custom_field')?.status).toBe('error')
    expect(scoutRes.find(r => r.type === 'delete_custom_field')?.status).toBe('error')
    expect(aiStore.getMyTeamNumber('evt-turbo')).toBeNull()
    expect(scoutRes.find(r => r.type === 'unknown_op')?.status).toBe('error')

    // Host execution: ban/unban, assign_scout (self + unassign), create/update/delete custom_field with formula validation
    vi.spyOn(scheduleStore, 'assignStation').mockResolvedValue(undefined as any)
    vi.spyOn(customFieldsStore, 'deleteField').mockResolvedValue(undefined as any)

    const hostRes = await executeTurboActions({
      eventId: 'evt-turbo',
      userId: 'u-host',
      username: 'Host',
      isHost: true,
      locale: 'zh',
      actions: [
        { type: 'ban_team', teamNumber: 19600 },
        { type: 'unban_team', teamNumber: 19600 },
        { type: 'assign_scout', matchNumber: 5, station: 'red1', tournamentLevel: 'PLAYOFF', scoutName: 'bob' },
        { type: 'assign_scout', matchNumber: 5, station: 'red1', scoutName: null },
        { type: 'create_custom_field', name: 'Bad Formula', target: 'TEAM', fieldType: 'formula', formulaExpr: '' },
        { type: 'create_custom_field', name: 'Eff', target: 'MATCH', fieldType: 'formula', fieldKey: 'eff_score', formulaExpr: 'match.autoScore + match.teleopScore' },
        { type: 'update_custom_field', fieldKey: 'eff_score', patch: { name: 'Eff V2', formulaExpr: 'match.autoScore * 2' } },
        { type: 'delete_custom_field', fieldKey: 'eff_score' },
        { type: 'delete_match_record', recordId: 'rec-other' }
      ]
    })

    expect(hostRes[0]!.status).toBe('success')
    expect(hostRes[1]!.status).toBe('success')
    expect(hostRes[2]!.summary).toContain('P5 red1')
    expect(hostRes[3]!.summary).toContain('清空')
    expect(hostRes[4]!.status).toBe('error')
    expect(hostRes[5]!.status).toBe('success')
    expect(hostRes[6]!.status).toBe('success')
    expect(hostRes[7]!.status).toBe('success')
    expect(hostRes[8]!.status).toBe('success')
  })

  it('handles AiChatComposer @team and /slash keyboard navigation, IME guard, and mode/thinking emits', async () => {
    const composer = track(
      mount(AiChatComposer, {
        props: {
          modelValue: '@275',
          isStreaming: false,
          knownTeams: [
            { teamNumber: 27570, name: 'BEAR' },
            { teamNumber: 27001, name: 'Test' },
            { teamNumber: 19600, name: 'Other' }
          ],
          aiMode: 'ask',
          thinkingMode: 'off'
        },
        global: { plugins: [i18n] }
      })
    )

    expect(composer.find('.composer-popover').exists()).toBe(true)
    const popItems = composer.findAll('.popover-item')
    expect(popItems).toHaveLength(1)
    expect(popItems[0]!.text()).toContain('#27570')

    const textarea = composer.find('textarea')
    await textarea.trigger('keydown', { key: 'Enter' })
    expect(composer.emitted('update:modelValue')?.[0]).toEqual(['#27570 '])
    expect(composer.emitted('addFocusTeam')?.[0]).toEqual([27570])

    // Slash command popover + ArrowDown + Tab selection
    await composer.setProps({ modelValue: '/p' })
    await nextTick()
    expect(composer.find('.composer-popover').text()).toContain('/pick')
    await textarea.trigger('keydown', { key: 'Tab' })
    const slashVal = composer.emitted('update:modelValue')?.at(-1)?.[0] as string
    expect(slashVal.length).toBeGreaterThan(10)

    // IME composing blocks Enter send
    await composer.setProps({ modelValue: 'Hello team' })
    await textarea.trigger('compositionstart')
    await textarea.trigger('keydown', { key: 'Enter' })
    expect(composer.emitted('send')).toBeUndefined()

    await textarea.trigger('compositionend')
    await textarea.trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(composer.emitted('send')).toBeUndefined()

    await textarea.trigger('keydown', { key: 'Enter' })
    expect(composer.emitted('send')?.[0]).toEqual(['Hello team'])

    // Mode toggle & thinking select
    await composer.find('.mode-seg-btn.turbo').trigger('click')
    expect(composer.emitted('update:aiMode')?.[0]).toEqual(['turbo'])
    const select = composer.find('.thinking-select')
    await select.setValue('high')
    expect(composer.emitted('update:thinkingMode')?.[0]).toEqual(['high'])
  })

  it('handles AiVoiceCallOverlay settings drawer, custom model, global Space PTT, quickText & errors', async () => {
    const overlay = track(
      mount(AiVoiceCallOverlay, {
        props: {
          isActive: true,
          isMinimized: false,
          status: 'listening',
          engine: 'openai-realtime',
          capability: resolveVoiceCapability(makeProfile()),
          isNativeLive: true,
          inputMode: 'ptt',
          isMuted: false,
          isPttHolding: false,
          inputLevel: 0.4,
          outputLevel: 0,
          elapsedSeconds: 12,
          selectedModel: 'gpt-realtime',
          selectedVoice: 'alloy',
          sttHelperProfileId: '',
          sttHelpers: [makeProfile({ id: 'h-1', name: 'Helper' })],
          activeSttProfile: null,
          autoSpeakTurnVoice: true,
          forceOpenAiRealtime: false,
          canUseBrowserSpeechRec: true,
          liveUserTranscript: '',
          liveAssistantTranscript: '',
          lastCompletedTurn: { user: 'Hi', assistant: 'Hello' },
          errorMessage: 'Connection lost',
          goAwayWarning: 'Closing soon'
        },
        global: { plugins: [i18n] }
      })
    )

    expect(overlay.find('.voice-banner-warn').text()).toContain('Closing soon')
    expect(overlay.find('.voice-banner-error').text()).toContain('Connection lost')
    await overlay.find('.btn-retry-inline').trigger('click')
    expect(overlay.emitted('retry')).toHaveLength(1)

    // Open settings drawer and test model/custom model/voice change
    await overlay.findAll('.voice-hdr-btn')[0]!.trigger('click')
    expect(overlay.find('.voice-settings-panel').exists()).toBe(true)
    await overlay.find('#voice-model-select').setValue('__custom__')
    const customInput = overlay.find('.voice-custom-model-row input')
    expect(customInput.exists()).toBe(true)
    await customInput.setValue('gpt-realtime-custom')
    await overlay.find('.btn-voice-apply').trigger('click')
    expect(overlay.emitted('update:selectedModel')?.[0]).toEqual(['gpt-realtime-custom'])
    expect(overlay.emitted('applyAndReconnect')).toHaveLength(1)

    await overlay.find('#voice-speaker-select').setValue('coral')
    expect(overlay.emitted('update:selectedVoice')?.[0]).toEqual(['coral'])

    // Spacebar global PTT
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }))
    expect(overlay.emitted('beginPtt')).toHaveLength(1)
    await overlay.setProps({ isPttHolding: true })
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }))
    expect(overlay.emitted('endPtt')).toHaveLength(1)

    // Quick text submit
    const quickInput = overlay.find('.voice-text-inject input')
    await quickInput.setValue('Check #27570')
    await overlay.find('.voice-text-inject').trigger('submit')
    expect(overlay.emitted('sendText')?.[0]).toEqual(['Check #27570'])
  })

  it('wires AiCopilotWorkspace context ribbon, starter cards, team click navigation & clear/export actions', async () => {
    const userStore = useUserStore()
    userStore.$patch({ user: { id: 'u-w', username: 'coach', token: 'jwt-w' } })
    const eventStore = useEventStore()
    eventStore.setCurrentEvent({ id: 'evt-w', name: 'Worlds', inviteCode: 'WRLD', hostId: 'u-w' })
    const recordStore = useRecordStore()
    recordStore.records = [
      {
        id: 'rec-w-1',
        eventId: 'evt-w',
        scoutId: 'u-w',
        scoutName: 'coach',
        matchNumber: 1,
        teamNumber: 27570,
        autoScore: 15,
        teleopScore: 30,
        endgameScore: 10,
        totalScore: 55,
        notes: '',
        rawData: '{}',
        syncStatus: 'SYNCED',
        createdAt: '',
        updatedAt: '',
        isBroken: false,
        version: 1
      }
    ]

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/users/u-w/ai-profiles') {
          return new Response(JSON.stringify([makeProfile({ userId: 'u-w' })]), { status: 200 })
        }
        if (url === '/api/events/evt-w/ai-threads' && (!init?.method || init.method === 'GET')) {
          return new Response(
            JSON.stringify([{ id: 'th-w', eventId: 'evt-w', title: 'Chat', personaId: 'strategist', pinned: false, messageCount: 0, lastMessagePreview: '' }]),
            { status: 200 }
          )
        }
        if (url === '/api/events/evt-w/ai-threads/th-w' && (!init?.method || init.method === 'GET')) {
          return new Response(
            JSON.stringify({ id: 'th-w', eventId: 'evt-w', title: 'Chat', personaId: 'strategist', pinned: false, messages: [] }),
            { status: 200 }
          )
        }
        if (url === '/api/ai/chat/stream') {
          const enc = new TextEncoder()
          return new Response(
            new ReadableStream({
              start(ctrl) {
                ctrl.enqueue(enc.encode('data: {"text":"Pick #27570!"}\n\ndata: [DONE]\n\n'))
                ctrl.close()
              }
            }),
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
          )
        }
        return new Response(JSON.stringify({ id: 'th-w' }), { status: 200 })
      })
    )

    const ws = track(
      mount(AiCopilotWorkspace, {
        props: { eventId: 'evt-w', mode: 'dock' },
        global: { plugins: [i18n] }
      })
    )
    await flushPromises()

    const aiStore = useAiStore()
    expect(aiStore.activeProfile?.id).toBe('p-oa')
    expect(ws.find('.starter-card').exists()).toBe(true)

    // Update persona & myTeamInput via AiContextRibbon
    await ws.find('.persona-select').setValue('brag_auditor')
    expect(aiStore.getActiveThread('evt-w')?.personaId).toBe('brag_auditor')
    await ws.find('.my-team-box input').setValue('27570')
    expect(aiStore.getMyTeamNumber('evt-w')).toBe(27570)

    // Click starter card -> streams response -> renders team chip -> clicking team chip navigates
    await ws.findAll('.starter-card')[0]!.trigger('click')
    await flushPromises()

    const chip = ws.find('.team-chip[data-team="27570"]')
    expect(chip.exists()).toBe(true)
    await chip.trigger('click')
    expect(mockRouterPush).toHaveBeenCalledWith('/event/evt-w/team/27570')
  })

  it('prevents post-hangup TTS leak and stale STT/WebSpeech continuation when stopSession runs mid-flight (BUG #1)', async () => {
    const userStore = useUserStore()
    userStore.$patch({ user: { id: 'u-v-turn', username: 'coach', token: 'jwt-turn' } })

    const aiStore = useAiStore()
    const deepseekProfile = makeProfile({
      id: 'p-ds-turn',
      protocol: 'OPENAI',
      presetId: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      modelName: 'deepseek-chat'
    })
    const geminiSttHelper = makeProfile({
      id: 'p-gem-stt',
      protocol: 'GEMINI',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      modelName: 'gemini-flash-latest',
      isActive: false
    })
    aiStore.profiles = [deepseekProfile, geminiSttHelper]
    aiStore.activeProfileId = 'p-ds-turn'

    const thread: AiChatThread = {
      id: 'th-turn',
      eventId: 'evt-turn',
      title: 'Turn Voice',
      personaId: 'strategist',
      pinned: false,
      messages: [],
      contextConfig: {
        enabled: true,
        sections: { rankings: true, schedule: true, pit: true, matches: true, tags: true },
        focusTeams: [],
        focusMatch: null
      }
    }
    aiStore.threadsByEvent['evt-turn'] = [
      { id: thread.id, eventId: thread.eventId, title: thread.title, personaId: thread.personaId, pinned: false, messageCount: 0, lastMessagePreview: '' }
    ]
    aiStore.threadDetailsById[thread.id] = thread
    aiStore.activeThreadIdByEvent['evt-turn'] = thread.id

    const speakSpy = vi.fn()
    const cancelSpy = vi.fn()
    class FakeUtterance {
      text: string
      lang = ''
      rate = 1
      voice: any = null
      onend: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(t: string) {
        this.text = t
      }
    }
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => [{ lang: 'en-US', name: 'EN' }],
      speak: (u: FakeUtterance) => {
        speakSpy(u.text)
        u.onend?.()
      },
      cancel: cancelSpy
    })

    const audioRef: { cb: ((evt: any) => void) | null } = { cb: null }
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: vi.fn() }]
        })
      }
    })
    class FakeAudioCtx {
      sampleRate = 16000
      state = 'running'
      resume = vi.fn().mockResolvedValue(undefined)
      close = vi.fn().mockResolvedValue(undefined)
      createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() })
      createGain = () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() })
      createScriptProcessor = () => ({
        set onaudioprocess(fn: any) {
          audioRef.cb = fn
        },
        connect: vi.fn(),
        disconnect: vi.fn()
      })
    }
    vi.stubGlobal('AudioContext', FakeAudioCtx)

    const createDeferred = <T,>() => {
      let resolve!: (v: T) => void
      const promise = new Promise<T>(r => {
        resolve = r
      })
      return { promise, resolve }
    }
    let transcribeDef = createDeferred<Response>()
    let chatStreamDef = createDeferred<Response>()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url === '/api/ai/audio/transcribe') {
          transcribeDef = createDeferred<Response>()
          return await transcribeDef.promise
        }
        if (url === '/api/ai/chat/stream') {
          chatStreamDef = createDeferred<Response>()
          return await chatStreamDef.promise
        }
        return new Response(JSON.stringify({ id: 'th-turn' }), { status: 200 })
      })
    )

    const host = track(
      mount(
        {
          template: '<div></div>',
          setup() {
            return useAiVoiceSession({
              eventId: ref('evt-turn'),
              activeThread: ref(thread),
              buildEffectiveSystemPrompt: () => 'SYS',
              buildBriefContextLabel: () => '1T'
            })
          }
        },
        { global: { plugins: [i18n] } }
      )
    )
    const session = host.vm as any

    // 1. Positive precondition: active turn-voice call transcribes, streams reply, and speaks TTS
    await session.startSession()
    expect(session.isActive).toBe(true)
    expect(session.isNativeLive).toBe(false)
    await session.beginPtt()
    audioRef.cb?.({ inputBuffer: { getChannelData: () => new Float32Array(2048).fill(0.1) } })
    const pEndOk = session.endPtt()
    await flushPromises()
    transcribeDef.resolve(new Response(JSON.stringify({ text: 'Check 27570' }), { status: 200 }))
    await flushPromises()
    const enc = new TextEncoder()
    chatStreamDef.resolve(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode('data: {"text":"Team 27570 is strong."}\n\ndata: [DONE]\n\n'))
            c.close()
          }
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      )
    )
    await pEndOk
    expect(speakSpy).toHaveBeenCalledTimes(1)
    expect(session.status).toBe('listening')

    // 2. Hangup while /api/ai/audio/transcribe is in flight -> no submit, no TTS, status stays idle
    speakSpy.mockClear()
    await session.beginPtt()
    audioRef.cb?.({ inputBuffer: { getChannelData: () => new Float32Array(2048).fill(0.1) } })
    const pEndAbortedStt = session.endPtt()
    await flushPromises()
    session.stopSession()
    expect(session.isActive).toBe(false)
    expect(session.status).toBe('idle')

    transcribeDef.resolve(new Response(JSON.stringify({ text: 'Late transcript' }), { status: 200 }))
    await pEndAbortedStt
    await flushPromises()
    expect(session.status).toBe('idle')
    expect(speakSpy).not.toHaveBeenCalled()

    // 3. Hangup while sendChatMessage stream is in flight -> aborts stream, no TTS leak, status stays idle
    await session.startSession()
    const stopStreamSpy = vi.spyOn(aiStore, 'stopStreaming')
    const pSend = session.sendTextInCall('Quick question')
    await flushPromises()
    session.stopSession()
    expect(stopStreamSpy).toHaveBeenCalledWith('th-turn')

    chatStreamDef.resolve(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode('data: {"text":"Should not speak."}\n\ndata: [DONE]\n\n'))
            c.close()
          }
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      )
    )
    await pSend
    expect(speakSpy).not.toHaveBeenCalled()
    expect(session.status).toBe('idle')
  })
})
