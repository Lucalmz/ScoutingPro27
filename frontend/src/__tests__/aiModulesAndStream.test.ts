import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { useUserStore } from '@/stores/user'
import { useEventStore } from '@/stores/events'
import { useAiStore } from '@/stores/ai'
import { streamAiChat } from '@/components/ai/useAiChatStream'
import { exportThreadToMarkdown } from '@/components/ai/exportThread'
import {
  DEFAULT_PERSONA_ID,
  LEGACY_GENERIC_PROMPT,
  assembleSystemPrompt,
  buildStarterCards,
  generateFollowUpSuggestions,
  getPersonaById
} from '@/components/ai/personas'
import { findPresetByBaseUrl, getPresetById } from '@/components/ai/keyMatcher'
import { normalizeContextConfig } from '@/stores/aiModules/aiThreads'
import type { AiChatThread, MatchScheduleItem, RankingRow } from '@/types'

function makeSseResponse(chunks: string[], contentType = 'text/event-stream; charset=utf-8'): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(c))
      }
      controller.close()
    }
  })
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': contentType }
  })
}

describe('AI Store Profiles, Threads, Streaming, Export, Personas & KeyMatcher', () => {
  const originalLocale = i18n.global.locale.value

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    i18n.global.locale.value = 'en'
    const userStore = useUserStore()
    userStore.$patch({
      user: { id: 'u-1', username: 'captain', token: 'jwt-1' }
    })
  })

  afterEach(() => {
    i18n.global.locale.value = originalLocale
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('handles aiProfiles saveProfile masked key stripping, ERR_KEY_LOST preservation, quickSwitchModel, deleteProfile & probes', async () => {
    const aiStore = useAiStore()
    const postPayloads: any[] = []

    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/users/u-1/ai-profiles' && (!init?.method || init.method === 'GET')) {
        return new Response(
          JSON.stringify([
            {
              id: 'p-1',
              name: 'OpenAI',
              protocol: 'OPENAI',
              apiKeyEncrypted: 'sk****************1234',
              hasApiKey: true,
              baseUrl: 'https://api.openai.com/v1',
              modelName: 'gpt-4o',
              customModels: ['gpt-4o', 'gpt-4.1'],
              isActive: true
            },
            {
              id: 'p-lost',
              name: 'Lost Key',
              protocol: 'GEMINI',
              apiKeyEncrypted: 'ERR_KEY_LOST',
              hasApiKey: false,
              baseUrl: '',
              modelName: 'gemini-flash-latest',
              isActive: false
            }
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (url === '/api/users/u-1/ai-profiles' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body || '{}'))
        postPayloads.push(body)
        if (body.id === 'p-lost') {
          return new Response(JSON.stringify({ error: 'Saved API key could not be decrypted' }), { status: 400 })
        }
        return new Response(JSON.stringify({ ...body, id: body.id || 'p-new', isActive: true }), { status: 200 })
      }
      if (url === '/api/users/u-1/ai-profiles/p-1' && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      }
      if (url === '/api/ai/models' || url === '/api/ai/test-connection') {
        return new Response(JSON.stringify({ success: true, models: ['gpt-4o'] }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await aiStore.fetchProfiles()
    expect(aiStore.profiles).toHaveLength(2)

    // Saving profile with masked key strips apiKeyEncrypted so backend keeps encrypted key
    const saveMasked = await aiStore.saveProfile({
      id: 'p-1',
      protocol: 'OPENAI',
      apiKeyEncrypted: 'sk****************1234',
      proxyPort: '' as unknown as null
    })
    expect(saveMasked.ok).toBe(true)
    expect(postPayloads[0]).not.toHaveProperty('apiKeyEncrypted')
    expect(postPayloads[0].proxyPort).toBeNull()

    // Saving profile with ERR_KEY_LOST keeps ERR_KEY_LOST sentinel and surfaces backend 400 error
    const saveLost = await aiStore.saveProfile({
      id: 'p-lost',
      protocol: 'GEMINI',
      apiKeyEncrypted: 'ERR_KEY_LOST'
    })
    expect(saveLost.ok).toBe(false)
    expect(saveLost.error).toContain('could not be decrypted')
    expect(postPayloads[1].apiKeyEncrypted).toBe('ERR_KEY_LOST')

    // quickSwitchModel guards missing profile & empty model, succeeds on valid
    expect(await aiStore.quickSwitchModel('missing', 'gpt-4.1')).toBe(false)
    expect(await aiStore.quickSwitchModel('p-1', '   ')).toBe(false)
    expect(await aiStore.quickSwitchModel('p-1', ' gpt-4.1 ')).toBe(true)
    expect(postPayloads[2].modelName).toBe('gpt-4.1')

    // testConnection supports legacy positional args & strips masked key
    const probeRes = await aiStore.testConnection('OPENAI', 'sk****9999', '127.0.0.1', 7890, 'https://api.openai.com/v1')
    expect(probeRes.success).toBe(true)
    const modelsRes = await aiStore.fetchModels({ profileId: 'p-1', protocol: 'OPENAI', apiKey: 'sk-real-key-123456' })
    expect(modelsRes.models).toEqual(['gpt-4o'])

    // deleteProfile calls DELETE & refreshes profiles
    expect(await aiStore.deleteProfile('p-1')).toBe(true)

    // Probe error formatting when backend returns plain text 500
    fetchMock.mockResolvedValueOnce(new Response('Upstream gateway down', { status: 500 }))
    const errProbe = await aiStore.testConnection({ protocol: 'OPENAI' })
    expect(errProbe.success).toBe(false)
    expect(errProbe.error).toBe('Upstream gateway down')

    // Legacy settings bridge
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([{ provider: 'OPENAI', apiKeyEncrypted: '****', modelName: 'gpt-4o' }]), { status: 200 })
    )
    await aiStore.fetchSettings()
    expect(aiStore.getSettingsForProvider('OPENAI')?.modelName).toBe('gpt-4o')

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
    expect(await aiStore.saveSettings({ provider: 'OPENAI', apiKeyEncrypted: '****', modelName: 'gpt-4o' })).toBe(true)
  })

  it('handles aiThreads normalizeContextConfig, selectThread, rename rollback, clearThreadMessages & migratePlaceholderEvent', async () => {
    const aiStore = useAiStore()
    const normalized = normalizeContextConfig({
      enabled: true,
      sections: { rankings: false } as any,
      focusTeams: [27570, 27570, -1, NaN, 19600],
      focusMatch: { matchNumber: 8, tournamentLevel: 'PLAYOFF' }
    })
    expect(normalized.sections).toEqual({ rankings: false, schedule: true, pit: true, matches: true, tags: true })
    expect(normalized.focusTeams).toEqual([27570, 19600])
    expect(normalized.focusMatch).toEqual({ matchNumber: 8, tournamentLevel: 'PLAYOFF' })
    expect(normalizeContextConfig(null).focusTeams).toEqual([])

    let failPut = false
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/events/evt-1/ai-threads' && (!init?.method || init.method === 'GET')) {
        return new Response(
          JSON.stringify([
            { id: 't1', eventId: 'evt-1', title: 'First', personaId: 'strategist', pinned: false, messageCount: 1, lastMessagePreview: 'Hi' },
            { id: 't2', eventId: 'evt-1', title: 'Second', personaId: 'match_coach', pinned: false, messageCount: 0, lastMessagePreview: '' }
          ]),
          { status: 200 }
        )
      }
      if (url === '/api/events/evt-1/ai-threads/t1' && (!init?.method || init.method === 'GET')) {
        return new Response(
          JSON.stringify({ id: 't1', eventId: 'evt-1', title: 'First', personaId: 'strategist', pinned: false, messages: [{ id: 'm1', role: 'user', content: 'Hi' }] }),
          { status: 200 }
        )
      }
      if (url === '/api/events/evt-1/ai-threads/t2' && (!init?.method || init.method === 'GET')) {
        return new Response(
          JSON.stringify({ id: 't2', eventId: 'evt-1', title: 'Second', personaId: 'match_coach', pinned: false, messages: [] }),
          { status: 200 }
        )
      }
      if (url.includes('/ai-threads/') && init?.method === 'PUT') {
        if (failPut) return new Response('Server error', { status: 500 })
        return new Response(JSON.stringify({ id: url.split('/').pop() }), { status: 200 })
      }
      if (url === '/api/events/uuid-real/ai-threads') {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url === '/api/events/evt-1/ai-chat') {
        return new Response(JSON.stringify([{ role: 'user', content: 'legacy' }]), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await aiStore.loadEventThreads('evt-1')
    expect(aiStore.getActiveThread('evt-1')?.id).toBe('t1')

    // Dirty t1 flushed before selecting t2
    aiStore.updateThreadContextConfig('evt-1', { focusTeams: [27570] })
    const t2 = await aiStore.selectThread('evt-1', 't2')
    expect(t2?.id).toBe('t2')
    expect(fetchMock.mock.calls.some(c => c[0] === '/api/events/evt-1/ai-threads/t1' && c[1]?.method === 'PUT')).toBe(true)

    // Rename rollback on PUT failure
    failPut = true
    await aiStore.renameThread('evt-1', 't1', 'Should Rollback')
    expect(aiStore.threadDetailsById['t1']?.title).toBe('First')
    failPut = false

    // Delete message & clearThreadMessages
    await aiStore.selectThread('evt-1', 't1')
    aiStore.deleteThreadMessage('evt-1', 'm1')
    expect(aiStore.getActiveThread('evt-1')?.messages).toHaveLength(0)

    aiStore.getActiveThread('evt-1')!.messages.push({ id: 'm2', role: 'user', content: 'Temp' })
    await aiStore.clearThreadMessages('evt-1')
    expect(aiStore.getActiveThread('evt-1')?.messages).toHaveLength(0)

    // Placeholder event migration carries draftPromptByEvent & pendingAutoSendByEvent
    const aiMod = await import('@/stores/ai')
    void aiMod
    aiStore.draftPromptByEvent['evt-OLD'] = 'Draft note'
    aiStore.pendingAutoSendByEvent['evt-OLD'] = { prompt: 'Auto prompt' }
    const evtStore = useEventStore()
    evtStore.setCurrentEvent({ id: 'evt-OLD', name: 'Placeholder', inviteCode: 'CODE1', hostId: 'external_host' })
    evtStore.setCurrentEvent({ id: 'uuid-real', name: 'Real', inviteCode: 'CODE1', hostId: 'u-host' })
    expect(aiStore.draftPromptByEvent['uuid-real']).toBe('Draft note')
    expect(aiStore.draftPromptByEvent['evt-OLD']).toBeUndefined()
    expect(aiStore.pendingAutoSendByEvent['uuid-real']?.prompt).toBe('Auto prompt')

    // Legacy chat endpoints
    expect(await aiStore.fetchChatHistory('evt-1')).toEqual([{ role: 'user', content: 'legacy' }])
    expect(await aiStore.saveChatHistory('evt-1', [])).toBe(true)
  })

  it('handles SSE malformed JSON, snake_case usage, stream error, abort cancellation & non-SSE preflight failure', async () => {
    const deltas: any[] = []
    let streamErr = ''
    let preflightErr = ''

    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce(
          makeSseResponse([
            ': heartbeat\n\n',
            'data: {broken-json\n\n',
            'data: {"text":"Hello "}\n\n',
            'data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
            'data: {"error":"Rate limited"}\n\n'
          ])
        )
        .mockResolvedValueOnce(new Response('<html>Not Found</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }))
    )

    const res1 = await streamAiChat(
      {
        token: 'tok',
        profileId: 'p1',
        provider: 'OPENAI',
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal
      },
      {
        onDelta: d => deltas.push(d),
        onStreamError: m => {
          streamErr = m
        }
      }
    )

    expect(res1.preflightFailed).toBe(false)
    expect(res1.hadText).toBe(true)
    expect(res1.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15, thoughtsTokens: undefined })
    expect(res1.error).toBe('Rate limited')
    expect(streamErr).toBe('Rate limited')
    expect(deltas.some(d => d.text === 'Hello ')).toBe(true)

    // Non-SSE content type triggers preflight error
    const res2 = await streamAiChat(
      {
        token: 'tok',
        profileId: 'p1',
        provider: 'OPENAI',
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal
      },
      {
        onDelta: () => {},
        onPreflightError: m => {
          preflightErr = m
        }
      }
    )
    expect(res2.preflightFailed).toBe(true)
    expect(preflightErr).toContain('Not Found')

    // AbortError marks cancelled: true
    const ctrl = new AbortController()
    const abortErr = new DOMException('Aborted', 'AbortError')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(abortErr))
    ctrl.abort()
    const res3 = await streamAiChat(
      {
        token: 'tok',
        profileId: 'p1',
        provider: 'OPENAI',
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        signal: ctrl.signal
      },
      { onDelta: () => {} }
    )
    expect(res3.cancelled).toBe(true)
    expect(res3.preflightFailed).toBe(false)
  })

  it('supports aiStreaming single-concurrency, stopStreaming, openCopilotForTeam/Match & exportThreadToMarkdown', async () => {
    const aiStore = useAiStore()
    let resolveStream!: (r: Response) => void
    const pendingStream = new Promise<Response>(r => {
      resolveStream = r
    })

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/users/u-1/ai-profiles') {
          return new Response(
            JSON.stringify([
              { id: 'p1', name: 'P1', protocol: 'OPENAI', baseUrl: 'https://api.openai.com/v1', hasApiKey: true, isActive: true }
            ]),
            { status: 200 }
          )
        }
        if (url === '/api/events/evt-s/ai-threads' && init?.method === 'POST') {
          return new Response(
            JSON.stringify({ id: 'th-s', eventId: 'evt-s', title: 'New Tactical Chat', personaId: 'strategist', pinned: false, messages: [] }),
            { status: 200 }
          )
        }
        if (url === '/api/events/evt-s/ai-threads' && (!init?.method || init.method === 'GET')) {
          return new Response(JSON.stringify([]), { status: 200 })
        }
        if (url === '/api/ai/chat/stream') {
          return await pendingStream
        }
        return new Response(JSON.stringify({ id: 'th-s' }), { status: 200 })
      })
    )

    // Without active profile, openCopilotForTeam stores draft instead of pendingAutoSend
    await aiStore.openCopilotForTeam('evt-s', 27570, undefined, 'en')
    expect(aiStore.isDockOpen).toBe(true)
    expect(aiStore.draftPromptByEvent['evt-s']).toContain('#27570')
    expect(aiStore.pendingAutoSendByEvent['evt-s']).toBeUndefined()

    // With active profile, openCopilotForMatch sets match_coach persona & pendingAutoSend
    await aiStore.fetchProfiles()
    const sched: MatchScheduleItem = {
      id: 'm-12',
      eventId: 'evt-s',
      matchNumber: 12,
      tournamentLevel: 'PLAYOFF',
      red1: 27570,
      red2: 19600,
      blue1: 24068,
      blue2: 11111
    }
    await aiStore.openCopilotForMatch('evt-s', sched, undefined, 'en')
    expect(aiStore.getActiveThread('evt-s')?.personaId).toBe('match_coach')
    expect(aiStore.pendingAutoSendByEvent['evt-s']?.focusTeams).toEqual([27570, 19600, 24068, 11111])
    aiStore.clearPendingAutoSend('evt-s')
    expect(aiStore.pendingAutoSendByEvent['evt-s']).toBeUndefined()

    // Concurrent send on same thread is rejected while streaming, stopStreaming aborts it
    const pSend1 = aiStore.sendChatMessage({
      eventId: 'evt-s',
      prompt: 'First prompt',
      effectiveSystemPrompt: 'sys'
    })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(aiStore.isAnyStreaming).toBe(true)

    const pSend2 = await aiStore.sendChatMessage({
      eventId: 'evt-s',
      prompt: 'Concurrent prompt',
      effectiveSystemPrompt: 'sys'
    })
    expect(pSend2).toBe(false)

    aiStore.stopStreaming('th-s')
    resolveStream(makeSseResponse(['data: {"text":"ignored"}\n\ndata: [DONE]\n\n']))
    await pSend1
    expect(aiStore.isAnyStreaming).toBe(false)

    // exportThreadToMarkdown strips sp27-action, includes reasoning & turboActions, and revokes object URL
    let capturedBlobText = ''
    const createUrlSpy = vi.spyOn(URL, 'createObjectURL').mockImplementation((b: any) => {
      void b.text?.().then((t: string) => {
        capturedBlobText = t
      })
      return 'blob:mock-md'
    })
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const exportThread: AiChatThread = {
      id: 'th-exp',
      eventId: 'evt-s',
      title: 'Alliance Brief / Q12!',
      personaId: 'strategist',
      pinned: false,
      messages: [
        { id: 'u1', role: 'user', content: 'Analyze #27570' },
        {
          id: 'a1',
          role: 'assistant',
          modelName: 'gpt-4o',
          reasoning: 'Thinking steps',
          content: 'Tag added.\n\n```sp27-action\n{"actions":[{"type":"add_tag"}]}\n```',
          turboActions: [{ id: 'ta1', type: 'add_tag', status: 'success', summary: 'Added tag', detail: 'green' }]
        }
      ],
      contextConfig: normalizeContextConfig()
    }
    exportThreadToMarkdown({
      thread: exportThread,
      eventName: 'Regionals',
      labels: { event: 'Event', persona: 'Persona', time: 'Time', reasoning: 'Reasoning', roleYou: 'You', roleCopilot: 'Copilot' }
    })
    await Promise.resolve()
    expect(createUrlSpy).toHaveBeenCalled()
    expect(clickSpy).toHaveBeenCalled()
    expect(revokeSpy).toHaveBeenCalledWith('blob:mock-md')
    expect(capturedBlobText).toContain('Tag added.')
    expect(capturedBlobText).not.toContain('sp27-action')
    expect(capturedBlobText).toContain('<details><summary>Reasoning</summary>')
    expect(capturedBlobText).toContain('[success] Added tag — green')
  })

  it('covers personas prompt assembly, starter cards, follow-ups & keyMatcher vendor presets', () => {
    expect(getPersonaById('unknown').id).toBe(DEFAULT_PERSONA_ID)

    const customWithNote = assembleSystemPrompt({
      personaId: 'custom',
      profileSystemPrompt: 'Only bullet points.',
      dataContext: 'DATA',
      locale: 'en'
    })
    expect(customWithNote).toBe('Only bullet points.\n\nDATA')

    const customFallback = assembleSystemPrompt({
      personaId: 'custom',
      profileSystemPrompt: '',
      locale: 'zh'
    })
    expect(customFallback).toContain('BIOBUZZ')

    const nonCustomWithLegacyPrompt = assembleSystemPrompt({
      personaId: 'brag_auditor',
      profileSystemPrompt: LEGACY_GENERIC_PROMPT,
      locale: 'en'
    })
    expect(nonCustomWithLegacyPrompt).not.toContain(LEGACY_GENERIC_PROMPT)

    const nonCustomWithAddendum = assembleSystemPrompt({
      personaId: 'concise_brief',
      profileSystemPrompt: 'Prefer short replies',
      locale: 'zh'
    })
    expect(nonCustomWithAddendum).toContain('【用户档案附加要求】')

    const rankings: RankingRow[] = [
      { teamNumber: 27570, matchCount: 3, avgAutoScore: 12, avgTeleopScore: 24, avgEndgameScore: 8, avgRating: 44, maxScore: 50, brokenCount: 0, trend: 'up' },
      { teamNumber: 19600, matchCount: 3, avgAutoScore: 10, avgTeleopScore: 20, avgEndgameScore: 6, avgRating: 36, maxScore: 42, brokenCount: 0, trend: 'stable' }
    ]
    const cards = buildStarterCards({
      rankings,
      schedule: [{ id: 's1', eventId: 'e1', matchNumber: 4, tournamentLevel: 'PLAYOFF', red1: 27570, red2: 19600, blue1: 1111, blue2: 2222 }],
      myTeamNumber: 27570
    })
    expect(cards).toHaveLength(4)
    expect(cards[0]!.focusTeams).toEqual([27570])
    expect(cards[2]!.titleEn).toContain('P4')

    const fallbackCards = buildStarterCards({ rankings: [], schedule: [], myTeamNumber: null })
    expect(fallbackCards[2]!.id).toBe('starter-match')

    const followUps = generateFollowUpSuggestions(
      'Compare #27570 and #19600 with #99999.',
      new Set(['27570', '19600']),
      12345,
      'en'
    )
    expect(followUps).toHaveLength(3)
    expect(followUps[0]!.label).toContain('#27570 & #19600')
    expect(followUps[2]!.label).toContain('#12345')

    expect(findPresetByBaseUrl('https://api.siliconflow.cn/v1', 'OPENAI').id).toBe('siliconflow')
    expect(findPresetByBaseUrl('https://api.moonshot.cn/v1', 'OPENAI').id).toBe('moonshot')
    expect(findPresetByBaseUrl('https://open.bigmodel.cn/api/paas/v4', 'OPENAI').id).toBe('zhipu')
    expect(findPresetByBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1', 'OPENAI').id).toBe('dashscope')
    expect(findPresetByBaseUrl('https://ark.cn-beijing.volces.com/api/v3', 'OPENAI').id).toBe('ark')
    expect(findPresetByBaseUrl('https://openrouter.ai/api/v1', 'OPENAI').id).toBe('openrouter')
    expect(findPresetByBaseUrl('https://api.groq.com/openai/v1', 'OPENAI').id).toBe('groq')
    expect(findPresetByBaseUrl('https://api.mistral.ai/v1', 'OPENAI').id).toBe('mistral')
    expect(findPresetByBaseUrl('https://api.minimaxi.com/anthropic', 'ANTHROPIC').id).toBe('anthropic-minimax')
    expect(findPresetByBaseUrl('https://dashscope.aliyuncs.com/apps/anthropic', 'ANTHROPIC').id).toBe('anthropic-dashscope')
    expect(getPresetById('nonexistent-id').id).toBeTruthy()
  })

  it('prevents cross-user & post-logout resurrection races in fetchProfiles, loadEventThreads & fetchThreadDetail (BUG #2)', async () => {
    const userStore = useUserStore()
    const aiStore = useAiStore()

    let resolveProfiles!: (r: Response) => void
    let resolveThreads!: (r: Response) => void
    let resolveDetail!: (r: Response) => void

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/users/u-1/ai-profiles') {
          return await new Promise<Response>(r => {
            resolveProfiles = r
          })
        }
        if (url === '/api/events/evt-race/ai-threads' && (!init?.method || init.method === 'GET')) {
          return await new Promise<Response>(r => {
            resolveThreads = r
          })
        }
        if (url === '/api/events/evt-race/ai-threads/th-race-1' && (!init?.method || init.method === 'GET')) {
          return await new Promise<Response>(r => {
            resolveDetail = r
          })
        }
        if (url === '/api/events/evt-race/ai-threads/th-race-1' && init?.method === 'DELETE') {
          return new Response(JSON.stringify({ success: true }), { status: 200 })
        }
        return new Response('{}', { status: 200 })
      })
    )

    // 1. Positive precondition: fetchProfiles works normally when user stays logged in
    const pNormal = aiStore.fetchProfiles()
    resolveProfiles(
      new Response(
        JSON.stringify([{ id: 'p-u1', userId: 'u-1', name: 'U1 Profile', protocol: 'OPENAI', hasApiKey: true, isActive: true }]),
        { status: 200 }
      )
    )
    await pNormal
    expect(aiStore.profiles).toHaveLength(1)
    expect(localStorage.getItem('sp27_ai_active_profile_id')).toBe('p-u1')

    // 2. Race: fetchProfiles in-flight while user switches/logs out -> stale response MUST NOT repopulate profiles or localStorage
    const pStaleProfiles = aiStore.fetchProfiles()
    userStore.$patch({ user: { id: 'u-2', username: 'other', token: 'jwt-2' } })
    expect(aiStore.profiles).toEqual([])
    expect(localStorage.getItem('sp27_ai_active_profile_id')).toBeNull()

    resolveProfiles(
      new Response(
        JSON.stringify([{ id: 'p-u1', userId: 'u-1', name: 'Stale U1', protocol: 'OPENAI', hasApiKey: true, isActive: true }]),
        { status: 200 }
      )
    )
    await pStaleProfiles
    expect(aiStore.profiles).toEqual([])
    expect(localStorage.getItem('sp27_ai_active_profile_id')).toBeNull()

    // 3. Race: loadEventThreads in-flight when user logs out -> stale summaries must not pollute threadsByEvent
    userStore.$patch({ user: { id: 'u-1', username: 'captain', token: 'jwt-1' } })
    const pStaleThreads = aiStore.loadEventThreads('evt-race')
    userStore.$patch({ user: null })
    resolveThreads(
      new Response(
        JSON.stringify([{ id: 'th-old', eventId: 'evt-race', title: 'Old', personaId: 'strategist', pinned: false, messageCount: 0, lastMessagePreview: '' }]),
        { status: 200 }
      )
    )
    await pStaleThreads
    expect(aiStore.threadsByEvent['evt-race']).toBeUndefined()

    // 4. Race: fetchThreadDetail in-flight when deleteThread runs -> deleted thread MUST NOT resurrect into threadDetailsById
    userStore.$patch({ user: { id: 'u-1', username: 'captain', token: 'jwt-1' } })
    const pThreadsOk = aiStore.loadEventThreads('evt-race')
    resolveThreads(
      new Response(
        JSON.stringify([{ id: 'th-race-1', eventId: 'evt-race', title: 'Race', personaId: 'strategist', pinned: false, messageCount: 0, lastMessagePreview: '' }]),
        { status: 200 }
      )
    )
    await Promise.resolve()
    await Promise.resolve()
    // loadEventThreads automatically kicked off fetchThreadDetail('evt-race', 'th-race-1')
    const delOk = await aiStore.deleteThread('evt-race', 'th-race-1')
    expect(delOk).toBe(true)

    resolveDetail(
      new Response(
        JSON.stringify({ id: 'th-race-1', eventId: 'evt-race', title: 'Race', personaId: 'strategist', pinned: false, messages: [] }),
        { status: 200 }
      )
    )
    await pThreadsOk
    expect(aiStore.threadDetailsById['th-race-1']).toBeUndefined()
  })
})
