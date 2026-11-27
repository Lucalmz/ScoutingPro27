import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount, VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { nextTick } from 'vue'
import { i18n } from '@/i18n'
import { useUserStore } from '@/stores/user'
import { useEventStore } from '@/stores/events'
import { useRecordStore } from '@/stores/records'
import { usePitScoutStore } from '@/stores/pitScout'
import { useScheduleStore } from '@/stores/schedule'
import { useCustomFieldsStore } from '@/stores/customFields'
import { useNavigationStore } from '@/stores/navigation'
import { useAiStore } from '@/stores/ai'
import {
  executeTurboActions,
  extractTurboActionsFromContent,
  stripTurboActionBlocks
} from '@/components/ai/turboAgent'
import AiCopilotDock from '@/components/ai/AiCopilotDock.vue'
import AiCopilotWorkspace from '@/components/ai/AiCopilotWorkspace.vue'

function makeSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    }
  })
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }
  })
}

describe('Turbo Mode Agent, Permissions, Focus Overlay & Team Click Navigation', () => {
  const wrappers: VueWrapper[] = []
  const track = (w: VueWrapper) => {
    wrappers.push(w)
    return w
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    sessionStorage.clear()
    delete document.documentElement.dataset.aiDockOverlay
    i18n.global.locale.value = 'en'
  })

  afterEach(() => {
    while (wrappers.length > 0) {
      wrappers.pop()!.unmount()
    }
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    localStorage.clear()
    sessionStorage.clear()
    delete document.documentElement.dataset.aiDockOverlay
  })

  it('extracts and strips sp27-action blocks including streaming unclosed fences', () => {
    const content = [
      'Updated #27570 tag.',
      '',
      '```sp27-action',
      '{"actions":[{"type":"add_tag","teamNumber":27570,"tag":"fast-cycle","color":"green"}]}',
      '```'
    ].join('\n')

    const parsed = extractTurboActionsFromContent(content)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ type: 'add_tag', teamNumber: 27570, tag: 'fast-cycle' })

    const stripped = stripTurboActionBlocks(content)
    expect(stripped.displayContent).toBe('Updated #27570 tag.')
    expect(stripped.hasPendingBlock).toBe(false)

    const streaming = 'Preparing changes...\n\n```sp27-action\n{"actions":[{"type":"add_'
    const streamingStripped = stripTurboActionBlocks(streaming)
    expect(streamingStripped.displayContent).toBe('Preparing changes...')
    expect(streamingStripped.hasPendingBlock).toBe(true)
  })

  it('does NOT execute sp27-action blocks in Ask mode, and executes them in Turbo mode', async () => {
    const userStore = useUserStore()
    userStore.$patch({ user: { id: 'u-scout-1', username: 'alice', token: 'jwt-1' } })

    const eventStore = useEventStore()
    eventStore.setCurrentEvent({
      id: 'evt-turbo',
      name: 'Regionals',
      inviteCode: 'ABC123',
      hostId: 'u-scout-1'
    })

    const recordStore = useRecordStore()
    const aiStore = useAiStore()

    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/users/u-scout-1/ai-profiles') {
        return new Response(
          JSON.stringify([
            {
              id: 'p-1',
              name: 'Test AI',
              protocol: 'OPENAI',
              baseUrl: 'https://api.openai.com/v1',
              modelName: 'gpt-4o',
              hasApiKey: true,
              isActive: true
            }
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (url === '/api/events/evt-turbo/ai-threads' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            id: 'th-1',
            eventId: 'evt-turbo',
            title: 'Chat',
            personaId: 'strategist',
            pinned: false,
            messages: []
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (url === '/api/ai/chat/stream') {
        const sseText =
          'Tagging #27570.\n\n```sp27-action\n{"actions":[{"type":"add_tag","teamNumber":27570,"tag":"turbo-verified","color":"green"}]}\n```'
        return makeSseResponse([`data: ${JSON.stringify({ text: sseText })}\n\ndata: [DONE]\n\n`])
      }
      if (url === '/api/events/evt-turbo/teams/27570/tags' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body || '{}'))
        return new Response(
          JSON.stringify({
            id: 'tag-1',
            eventId: 'evt-turbo',
            teamNumber: 27570,
            tag: body.tag,
            color: body.color || 'green',
            isPreset: false,
            createdBy: 'u-scout-1'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    await aiStore.fetchProfiles()
    await aiStore.createThread('evt-turbo')

    // 1. Ask mode: must ignore sp27-action blocks
    aiStore.setAiMode('ask')
    await aiStore.sendChatMessage({
      eventId: 'evt-turbo',
      prompt: 'Tag 27570',
      effectiveSystemPrompt: 'sys'
    })
    expect(recordStore.teamTags).toHaveLength(0)
    expect(aiStore.getActiveThread('evt-turbo')?.messages.at(-1)?.turboActions).toBeUndefined()

    // 2. Turbo mode: executes action as user 'alice'
    aiStore.setAiMode('turbo')
    await aiStore.sendChatMessage({
      eventId: 'evt-turbo',
      prompt: 'Tag 27570',
      effectiveSystemPrompt: 'sys'
    })
    expect(recordStore.teamTags).toHaveLength(1)
    expect(recordStore.teamTags[0]?.tag).toBe('turbo-verified')
    const asstMsg = aiStore.getActiveThread('evt-turbo')?.messages.at(-1)
    expect(asstMsg?.aiMode).toBe('turbo')
    expect(asstMsg?.turboActions).toHaveLength(1)
    expect(asstMsg?.turboActions?.[0]?.status).toBe('success')
    expect(asstMsg?.turboActions?.[0]?.actedAsUsername).toBe('alice')
  })

  it('executes match/pit/tag/ban/schedule/custom-field mutations with strict Host & owner permissions', async () => {
    const userStore = useUserStore()
    userStore.$patch({ user: { id: 'u-member', username: 'bob', token: 'jwt-bob' } })

    const recordStore = useRecordStore()
    const pitStore = usePitScoutStore()
    const scheduleStore = useScheduleStore()
    const customFieldsStore = useCustomFieldsStore()
    const aiStore = useAiStore()

    pitStore.currentEventId = 'evt-perm'
    scheduleStore.schedules = [
      {
        id: 'sch-5',
        eventId: 'evt-perm',
        matchNumber: 5,
        tournamentLevel: 'QUALIFICATION',
        red1: 27570,
        red2: 19600,
        blue1: 24068,
        blue2: 11111
      }
    ]
    recordStore.records.push({
      id: 'rec-other',
      eventId: 'evt-perm',
      scoutId: 'u-other',
      scoutName: 'other_scout',
      matchNumber: 3,
      teamNumber: 19600,
      autoScore: 10,
      teleopScore: 20,
      endgameScore: 5,
      totalScore: 35,
      notes: 'Other record',
      rawData: JSON.stringify({ tournamentLevel: 'QUALIFICATION', allianceColor: 'red' }),
      syncStatus: 'SYNCED',
      createdAt: '2026-11-26T00:00:00Z',
      updatedAt: '2026-11-26T00:00:00Z',
      isBroken: false,
      version: 1
    })

    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/custom-fields') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body || '{}'))
        return new Response(
          JSON.stringify({
            id: 'cf-1',
            eventId: 'evt-perm',
            target: body.target,
            phase: body.phase || 'overall',
            name: body.name,
            fieldKey: body.fieldKey,
            fieldType: body.fieldType,
            formulaExpr: body.formulaExpr || null,
            required: false,
            orderSeq: 1,
            isActive: true
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    // Non-Host member actions: create own match record + pit record + set_my_team succeed;
    // editing other's record, banning team, assigning scout, and creating custom field are denied.
    const memberResults = await executeTurboActions({
      eventId: 'evt-perm',
      userId: 'u-member',
      username: 'bob',
      isHost: false,
      locale: 'en',
      actions: [
        {
          type: 'create_match_record',
          matchNumber: 5,
          teamNumber: 27570,
          autoLeave: true,
          autoBalls: 2,
          autoPark: true, // 3 + 6 + 5 = 14
          teleopCycles: [4, 3], // 7 * 2 = 14
          teleopPark: true, // 5
          flowerNectars: 2, // 4
          flowerBottomBonusCount: 1, // 5 -> endgame = 14, total = 42
          notes: 'Strong cycle'
        },
        {
          type: 'upsert_pit_record',
          teamNumber: 27570,
          patch: {
            drivetrainType: 'swerve',
            claimedAutoScore: 14,
            claimedTeleopScore: 20,
            claimedTeleopPark: true,
            claimedFlowerNectars: 2,
            claimedFlowerBottomBonus: 1
          }
        },
        { type: 'set_my_team', teamNumber: 27570 },
        { type: 'update_match_record', recordId: 'rec-other', patch: { notes: 'Hijack' } },
        { type: 'ban_team', teamNumber: 19600 },
        { type: 'assign_scout', matchNumber: 5, station: 'red1', scoutName: 'bob' },
        { type: 'create_custom_field', name: 'Cycle Efficiency', target: 'TEAM', fieldType: 'formula', formulaExpr: 'match.avgRating / 10' }
      ]
    })

    expect(memberResults[0]?.status).toBe('success')
    expect(memberResults[1]?.status).toBe('success')
    expect(memberResults[2]?.status).toBe('success')
    expect(memberResults[3]?.status).toBe('error')
    expect(memberResults[4]?.status).toBe('error')
    expect(memberResults[5]?.status).toBe('error')
    expect(memberResults[6]?.status).toBe('error')

    const bobRec = recordStore.activeRecords.find(r => r.teamNumber === 27570 && r.matchNumber === 5)
    expect(bobRec).toBeDefined()
    expect(bobRec?.scoutId).toBe('u-member')
    expect(bobRec?.scoutName).toBe('bob')
    expect(bobRec?.autoScore).toBe(14)
    expect(bobRec?.teleopScore).toBe(14)
    expect(bobRec?.endgameScore).toBe(14)
    expect(bobRec?.totalScore).toBe(42)

    const pitRec = pitStore.activeRecords.find(p => p.teamNumber === 27570)
    expect(pitRec?.drivetrainType).toBe('swerve')
    expect(pitRec?.claimedEndgameScore).toBe(14)
    expect(pitRec?.claimedTotalScore).toBe(48)
    expect(aiStore.getMyTeamNumber('evt-perm')).toBe(27570)
    // Other scout's record remained untouched
    expect(recordStore.activeRecords.find(r => r.id === 'rec-other')?.notes).toBe('Other record')

    // Host actions: ban, assign_scout, valid custom formula, and reject invalid formula
    const hostResults = await executeTurboActions({
      eventId: 'evt-perm',
      userId: 'u-host',
      username: 'captain',
      isHost: true,
      locale: 'en',
      actions: [
        { type: 'ban_team', teamNumber: 19600 },
        { type: 'assign_scout', matchNumber: 5, station: 'red1', scoutName: 'self' },
        { type: 'create_custom_field', name: 'Eff', target: 'TEAM', fieldType: 'formula', fieldKey: 'eff_score', formulaExpr: 'match.avgRating * 1.1' },
        { type: 'create_custom_field', name: 'Bad', target: 'TEAM', fieldType: 'formula', fieldKey: 'bad_f', formulaExpr: 'window.alert(1)' }
      ]
    })

    expect(hostResults[0]?.status).toBe('success')
    expect(hostResults[1]?.status).toBe('success')
    expect(hostResults[2]?.status).toBe('success')
    expect(hostResults[3]?.status).toBe('error')
    expect(recordStore.bannedTeams).toContain(19600)
    expect(scheduleStore.getStationAssignment(5, 'red1', 'QUALIFICATION')?.scoutId).toBe('u-host')
    expect(customFieldsStore.getFields('evt-perm', 'TEAM').some(f => f.fieldKey === 'eff_score')).toBe(true)
    expect(customFieldsStore.getFields('evt-perm', 'TEAM').some(f => f.fieldKey === 'bad_f')).toBe(false)
  })

  it('marks html[data-ai-dock-overlay=true] in focus/expanded mode so Inbox FAB does not cover Send button', async () => {
    const origInnerWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true, writable: true })

    try {
      const aiStore = useAiStore()
      aiStore.setDockOpen(true)
      aiStore.setDockExpanded(false)

      const wrapper = track(
        mount(AiCopilotDock, {
          props: { eventId: 'evt-dock' },
          global: {
            plugins: [i18n],
            stubs: { AiCopilotWorkspace: true }
          }
        })
      )

      await nextTick()
      expect(document.documentElement.dataset.aiDockOverlay).toBeUndefined()

      aiStore.setDockExpanded(true)
      await nextTick()
      expect(document.documentElement.dataset.aiDockOverlay).toBe('true')

      aiStore.setDockExpanded(false)
      await nextTick()
      expect(document.documentElement.dataset.aiDockOverlay).toBeUndefined()

      // Narrow desktop (< 1120px) also activates overlay drawer mode
      Object.defineProperty(window, 'innerWidth', { value: 960, configurable: true, writable: true })
      window.dispatchEvent(new Event('resize'))
      await nextTick()
      expect(document.documentElement.dataset.aiDockOverlay).toBe('true')

      wrapper.unmount()
      expect(document.documentElement.dataset.aiDockOverlay).toBeUndefined()
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: origInnerWidth, configurable: true, writable: true })
    }
  })

  it('navigates directly to /event/:eventId/team/:teamNumber when clicking a team chip in AI reply', async () => {
    const userStore = useUserStore()
    userStore.$patch({ user: { id: 'u-1', username: 'alice', token: 'jwt-1' } })

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === '/api/users/u-1/ai-profiles') {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url === '/api/events/evt-nav/ai-threads') {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/event/:eventId', name: 'event', component: { template: '<div />' } },
        { path: '/event/:eventId/team/:teamNumber', name: 'team-detail', component: { template: '<div />' } }
      ]
    })
    await router.push('/event/evt-nav?tab=rankings')
    await router.isReady()
    const pushSpy = vi.spyOn(router, 'push')

    const aiStore = useAiStore()
    const navStore = useNavigationStore()
    aiStore.threadsByEvent['evt-nav'] = [
      {
        id: 'th-nav',
        eventId: 'evt-nav',
        title: 'Nav Test',
        personaId: 'strategist',
        pinned: false,
        messageCount: 1,
        lastMessagePreview: 'Team #27570'
      }
    ]
    aiStore.activeThreadIdByEvent['evt-nav'] = 'th-nav'
    aiStore.threadDetailsById['th-nav'] = {
      id: 'th-nav',
      eventId: 'evt-nav',
      title: 'Nav Test',
      personaId: 'strategist',
      pinned: false,
      contextConfig: {
        enabled: true,
        sections: { rankings: true, schedule: true, pit: true, matches: true, tags: true },
        focusTeams: [],
        focusMatch: null
      },
      messages: [
        {
          id: 'm-1',
          role: 'assistant',
          content: 'Recommend partnering with #27570 in playoffs.'
        }
      ]
    }

    const wrapper = track(
      mount(AiCopilotWorkspace, {
        props: { eventId: 'evt-nav', mode: 'dock' },
        global: {
          plugins: [i18n, router]
        }
      })
    )

    await nextTick()
    const chip = wrapper.find('[data-team="27570"]')
    expect(chip.exists()).toBe(true)
    await chip.trigger('click')

    expect(pushSpy).toHaveBeenCalledWith('/event/evt-nav/team/27570')
    expect(navStore.getEventPosition('evt-nav')?.teamNumber).toBe(27570)
  })

  it('strips both multiline and single-line sp27-action fences without leaving raw JSON', async () => {
    const { stripTurboActionBlocks } = await import('@/components/ai/turboAgent')
    const { exportThreadToMarkdown } = await import('@/components/ai/exportThread')

    const singleLine = 'Before.\n```sp27-action {"actions":[{"type":"ban_team","teamNumber":111}]}```\nAfter.'
    const res = stripTurboActionBlocks(singleLine)
    expect(res.hasPendingBlock).toBe(false)
    expect(res.displayContent).toBe('Before.\n\nAfter.')

    let exportedContent = ''
    const origCreateObjectURL = URL.createObjectURL
    const origRevoke = URL.revokeObjectURL
    URL.createObjectURL = vi.fn((blob: Blob) => {
      void blob.text().then(t => {
        exportedContent = t
      })
      return 'blob:test'
    }) as any
    URL.revokeObjectURL = vi.fn()
    try {
      exportThreadToMarkdown({
        eventName: 'Regional',
        labels: { event: 'Event', persona: 'Persona', time: 'Time', reasoning: 'Reasoning', roleYou: 'You', roleCopilot: 'Copilot' },
        thread: {
          id: 'th-exp',
          eventId: 'evt-1',
          title: 'Export Test',
          personaId: 'strategist',
          pinned: false,
          contextConfig: { enabled: true, sections: { rankings: true, schedule: true, pit: true, matches: true, tags: true }, focusTeams: [], focusMatch: null },
          messages: [
            {
              id: 'a1',
              role: 'assistant',
              content: 'Prose reply.\n```sp27-action\n{"actions":[{"type":"add_tag","teamNumber":27570,"tag":"fast"}]}\n```',
              turboActions: [{ id: 'act1', type: 'add_tag', status: 'success', summary: 'Added tag fast to #27570' }]
            }
          ]
        }
      })
      await new Promise(r => setTimeout(r, 10))
      expect(exportedContent).toContain('Prose reply.')
      expect(exportedContent).toContain('Added tag fast to #27570')
      expect(exportedContent).not.toContain('sp27-action')
    } finally {
      URL.createObjectURL = origCreateObjectURL
      URL.revokeObjectURL = origRevoke
    }
  })
})
