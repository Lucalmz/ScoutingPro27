import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { useUserStore } from '@/stores/user'
import { useEventStore } from '@/stores/events'
import {
  useAiStore,
  MIN_DOCK_WIDTH,
  MAX_DOCK_WIDTH,
  DEFAULT_DOCK_WIDTH,
  clampDockWidth
} from '@/stores/ai'
import { streamAiChat } from '@/components/ai/useAiChatStream'

function makeSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
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

describe('aiStore & streamAiChat Copilot v2', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    const userStore = useUserStore()
    userStore.$patch({
      user: { id: 'u-store-1', username: 'captain', token: 'jwt-abc' }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('clamps and persists JetBrains dock width strictly within 360..680px', () => {
    expect(clampDockWidth(150)).toBe(MIN_DOCK_WIDTH)
    expect(clampDockWidth(999)).toBe(MAX_DOCK_WIDTH)
    expect(clampDockWidth(NaN)).toBe(DEFAULT_DOCK_WIDTH)
    expect(clampDockWidth(512.4)).toBe(512)

    const aiStore = useAiStore()
    aiStore.setDockWidth(800)
    expect(aiStore.dockWidth).toBe(MAX_DOCK_WIDTH)
    expect(localStorage.getItem('sp27_ai_dock_width')).toBe(String(MAX_DOCK_WIDTH))

    aiStore.setDockWidth(100)
    expect(aiStore.dockWidth).toBe(MIN_DOCK_WIDTH)
  })

  it('computes canSendWithActiveProfile accurately for remote keyed vs local loopback profiles', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: 'p-remote-nokey',
            name: 'Remote No Key',
            protocol: 'OPENAI',
            baseUrl: 'https://api.openai.com/v1',
            hasApiKey: false,
            isActive: true
          },
          {
            id: 'p-ollama',
            name: 'Ollama Local',
            protocol: 'OPENAI',
            baseUrl: 'http://127.0.0.1:11434/v1',
            hasApiKey: false,
            isActive: false
          }
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    const aiStore = useAiStore()
    await aiStore.fetchProfiles()
    expect(aiStore.activeProfile?.id).toBe('p-remote-nokey')
    expect(aiStore.canSendWithActiveProfile).toBe(false)

    // Activate Ollama profile -> valid even without API key
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const activated = await aiStore.activateProfile('p-ollama')
    expect(activated).toBe(true)
    expect(aiStore.activeProfile?.id).toBe('p-ollama')
    expect(aiStore.canSendWithActiveProfile).toBe(true)
  })

  it('splits SSE reasoning, text, and usage across split UTF-8 frames and flushes debounced thread saves', async () => {
    const received = {
      reasoning: '',
      text: '',
      usage: undefined as any,
      reasoningDurationMs: undefined as number | undefined
    }

    const fetchMock = vi.fn().mockResolvedValue(
      makeSseResponse([
        'data: {"reasoning":"Plan ',
        'step 1"}\n\ndata: {"text":"Choose #27570"}\n\n',
        'data: {"usage":{"promptTokens":88,"completionTokens":21,"totalTokens":109}}\n\ndata: [DONE]\n\n'
      ])
    )
    vi.stubGlobal('fetch', fetchMock)

    const ctrl = new AbortController()
    const streamRes = await streamAiChat(
      {
        token: 'jwt-abc',
        profileId: 'p1',
        provider: 'GEMINI',
        modelName: 'gemini-flash-latest',
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        signal: ctrl.signal
      },
      {
        onDelta(d) {
          if (d.reasoning) received.reasoning += d.reasoning
          if (d.text) received.text += d.text
          if (d.usage) received.usage = d.usage
          if (d.reasoningDurationMs !== undefined) {
            received.reasoningDurationMs = d.reasoningDurationMs
          }
        }
      }
    )

    expect(streamRes.preflightFailed).toBe(false)
    expect(streamRes.hadReasoning).toBe(true)
    expect(streamRes.hadText).toBe(true)
    expect(received.reasoning).toBe('Plan step 1')
    expect(received.text).toBe('Choose #27570')
    expect(received.usage?.totalTokens).toBe(109)
    expect(received.reasoningDurationMs).toBeGreaterThanOrEqual(100)

    // Thread creation + debounced save flush
    const aiStore = useAiStore()
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/events/evt-1/ai-threads' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            id: 'th-1',
            eventId: 'evt-1',
            title: 'New Tactical Chat',
            personaId: 'alliance_strategist',
            pinned: false,
            messages: []
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (url === '/api/events/evt-1/ai-threads/th-1' && init?.method === 'PUT') {
        return new Response(JSON.stringify({ id: 'th-1' }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })

    const created = await aiStore.createThread('evt-1', { title: 'Test Strategy' })
    expect(created?.id).toBe('th-1')

    await aiStore.togglePinThread('evt-1', 'th-1')
    expect(aiStore.getActiveThread('evt-1')?.pinned).toBe(true)

    aiStore.updateThreadPersona('evt-1', 'pit_scouting_auditor')
    await aiStore.flushPendingSaves('th-1')

    const putCalls = fetchMock.mock.calls.filter(
      c => c[0] === '/api/events/evt-1/ai-threads/th-1' && c[1]?.method === 'PUT'
    )
    expect(putCalls.length).toBeGreaterThanOrEqual(2)
    const lastPutBody = JSON.parse(String(putCalls[putCalls.length - 1]![1].body))
    expect(lastPutBody.personaId).toBe('pit_scouting_auditor')
  })

  it('rolls back optimistic user prompt on preflight JSON error into draftPromptByEvent', async () => {
    const aiStore = useAiStore()
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/users/u-store-1/ai-profiles') {
        return new Response(
          JSON.stringify([
            {
              id: 'p-valid',
              name: 'Valid Profile',
              protocol: 'OPENAI',
              baseUrl: 'https://api.openai.com/v1',
              hasApiKey: true,
              isActive: true
            }
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (url === '/api/events/evt-2/ai-threads' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            id: 'th-err',
            eventId: 'evt-2',
            title: 'New Tactical Chat',
            personaId: 'alliance_strategist',
            pinned: false,
            messages: []
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (url === '/api/ai/chat/stream') {
        return new Response(JSON.stringify({ error: 'Invalid API key' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await aiStore.fetchProfiles()
    await aiStore.createThread('evt-2')
    const ok = await aiStore.sendChatMessage({
      eventId: 'evt-2',
      prompt: 'Analyze Q7',
      effectiveSystemPrompt: 'Sys prompt'
    })

    expect(ok).toBe(false)
    expect(aiStore.getActiveThread('evt-2')?.messages.length).toBe(0)
    expect(aiStore.draftPromptByEvent['evt-2']).toBe('Analyze Q7')
  })

  it('defaults thinkingMode to off, persists mode switches, and forwards per-request thinking parameters to /api/ai/chat/stream', async () => {
    const aiStore = useAiStore()
    expect(aiStore.thinkingMode).toBe('off')
    expect(aiStore.aiMode).toBe('ask')

    aiStore.setThinkingMode('high')
    aiStore.setAiMode('turbo')
    expect(localStorage.getItem('sp27_ai_thinking_mode')).toBe('high')
    expect(localStorage.getItem('sp27_ai_mode')).toBe('turbo')

    const capturedBodies: any[] = []
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/users/u-store-1/ai-profiles') {
        return new Response(
          JSON.stringify([
            {
              id: 'p-gem',
              name: 'Gemini Flash',
              protocol: 'GEMINI',
              baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
              modelName: 'gemini-flash-latest',
              hasApiKey: true,
              enableThinking: false,
              thinkingBudget: 4096,
              isActive: true
            }
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (url === '/api/events/evt-3/ai-threads' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            id: 'th-think',
            eventId: 'evt-3',
            title: 'New Tactical Chat',
            personaId: 'strategist',
            pinned: false,
            messages: []
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (url === '/api/ai/chat/stream') {
        capturedBodies.push(JSON.parse(String(init?.body || '{}')))
        return makeSseResponse(['data: {"text":"Done"}\n\ndata: [DONE]\n\n'])
      }
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await aiStore.fetchProfiles()
    await aiStore.createThread('evt-3')

    // Send in 'high' thinking mode
    await aiStore.sendChatMessage({
      eventId: 'evt-3',
      prompt: 'Deep analysis',
      effectiveSystemPrompt: 'sys'
    })
    expect(capturedBodies[0]).toMatchObject({
      enableThinking: true,
      thinkingBudget: 8192,
      reasoningEffort: 'high'
    })

    // Switch back to 'off' -> disables thinking explicitly
    aiStore.setThinkingMode('off')
    await aiStore.sendChatMessage({
      eventId: 'evt-3',
      prompt: 'Quick question',
      effectiveSystemPrompt: 'sys'
    })
    expect(capturedBodies[1]).toMatchObject({
      enableThinking: false,
      thinkingBudget: 0,
      reasoningEffort: 'none'
    })
  })

  it('isolates AI state on logout & user switch, flushes pending saves before token clear, and clears activeThreadIdByEvent on empty list', async () => {
    const userStore = useUserStore()
    localStorage.setItem('scoutingpro-user', JSON.stringify({ id: 'u-store-1', username: 'captain', token: 'jwt-abc' }))
    const aiStore = useAiStore()

    const putTokens: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/users/u-store-1/ai-profiles') {
          return new Response(
            JSON.stringify([
              { id: 'p-1', name: 'Default', protocol: 'OPENAI', baseUrl: 'https://api.openai.com/v1', hasApiKey: true, isActive: true }
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        if (url === '/api/events/evt-iso/ai-threads' && init?.method === 'POST') {
          return new Response(
            JSON.stringify({ id: 'th-iso', eventId: 'evt-iso', title: 'Iso', personaId: 'strategist', pinned: false, messages: [] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        if (url === '/api/events/evt-iso/ai-threads/th-iso' && init?.method === 'PUT') {
          const headers = new Headers(init.headers)
          putTokens.push(headers.get('Authorization') || '')
          return new Response(JSON.stringify({ id: 'th-iso' }), { status: 200 })
        }
        if (url === '/api/events/evt-empty/ai-threads') {
          return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        return new Response('{}', { status: 200 })
      })
    )

    await aiStore.fetchProfiles()
    expect(localStorage.getItem('sp27_ai_active_profile_id')).toBe('p-1')

    await aiStore.createThread('evt-iso')
    aiStore.draftPromptByEvent['evt-iso'] = 'Secret draft'
    aiStore.pendingAutoSendByEvent['evt-iso'] = { prompt: 'Secret auto' }
    aiStore.updateThreadPersona('evt-iso', 'match_coach')

    // Logout must flush pending save BEFORE clearing token, then wipe all AI state
    await userStore.logout()
    expect(putTokens).toContain('Bearer jwt-abc')
    expect(aiStore.profiles).toEqual([])
    expect(aiStore.settingsList).toEqual([])
    expect(aiStore.threadsByEvent).toEqual({})
    expect(aiStore.threadDetailsById).toEqual({})
    expect(aiStore.activeThreadIdByEvent).toEqual({})
    expect(aiStore.draftPromptByEvent).toEqual({})
    expect(aiStore.pendingAutoSendByEvent).toEqual({})
    expect(localStorage.getItem('sp27_ai_active_profile_id')).toBeNull()

    // Re-login as user 2, verify loadEventThreads([]) deletes stale activeThreadIdByEvent
    userStore.$patch({ user: { id: 'u-store-2', username: 'scout2', token: 'jwt-2' } })
    aiStore.activeThreadIdByEvent['evt-empty'] = 'stale-thread-id'
    await aiStore.loadEventThreads('evt-empty')
    expect(aiStore.activeThreadIdByEvent['evt-empty']).toBeUndefined()

    // Direct user switch also resets AI state synchronously
    aiStore.draftPromptByEvent['evt-empty'] = 'User 2 draft'
    userStore.$patch({ user: { id: 'u-store-3', username: 'scout3', token: 'jwt-3' } })
    expect(aiStore.draftPromptByEvent).toEqual({})
  })

  it('handles x-refreshed-token, 401 unauthorized event, and static cloud host short-circuit', async () => {
    const userStore = useUserStore()
    localStorage.setItem('scoutingpro-user', JSON.stringify({ id: 'u-store-1', username: 'captain', token: 'jwt-old' }))
    const aiStore = useAiStore()

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response('[]', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'x-refreshed-token': 'jwt-refreshed'
        }
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    await aiStore.fetchProfiles()
    expect(JSON.parse(localStorage.getItem('scoutingpro-user') || '{}').token).toBe('jwt-refreshed')
    expect(userStore.token).toBe('jwt-refreshed')

    const onUnauthorized = vi.fn()
    window.addEventListener('auth-unauthorized', onUnauthorized)
    fetchMock.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
    await aiStore.fetchProfiles()
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('scoutingpro-user')).toBeNull()
    window.removeEventListener('auth-unauthorized', onUnauthorized)

    // Static cloud host short-circuits without calling fetch
    const origLocation = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...origLocation, hostname: 'demo.github.io' }
    })
    try {
      const callsBefore = fetchMock.mock.calls.length
      const list = await aiStore.loadEventThreads('evt-static')
      expect(list).toEqual([])
      expect(fetchMock.mock.calls.length).toBe(callsBefore)
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: origLocation })
    }
  })

  it('enforces 64KB keepalive cap, aborts in-flight PUT on deleteThread, prevents resurrection, and sorts pinned+updatedAt', async () => {
    const aiStore = useAiStore()
    const putKeepalives: boolean[] = []
    let capturedAbortSignal: AbortSignal | undefined
    let resolveInFlightPut!: (r: Response) => void

    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/events/evt-k/ai-threads' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ id: 'th-k', eventId: 'evt-k', title: 'K', personaId: 'strategist', pinned: false, messages: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (url === '/api/events/evt-k/ai-threads/th-k' && init?.method === 'PUT') {
        putKeepalives.push(Boolean(init.keepalive))
        capturedAbortSignal = init.signal ?? undefined
        return await new Promise<Response>(r => {
          resolveInFlightPut = r
        })
      }
      if (url === '/api/events/evt-k/ai-threads/th-k' && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const thread = (await aiStore.createThread('evt-k'))!
    // Small payload with keepalive = true -> keepalive: true
    aiStore.scheduleSaveThread(thread)
    const p1 = aiStore.flushPendingSaves(thread.id, true)
    expect(putKeepalives[0]).toBe(true)
    resolveInFlightPut(new Response(JSON.stringify({ id: 'th-k' }), { status: 200 }))
    await p1

    // >64KB payload with keepalive = true -> keepalive: false
    thread.messages = [{ id: 'm-big', role: 'user', content: 'A'.repeat(65000) }]
    aiStore.scheduleSaveThread(thread)
    const p2 = aiStore.flushPendingSaves(thread.id, true)
    expect(putKeepalives[1]).toBe(false)

    // Deleting thread while PUT is in-flight aborts PUT and blocks resurrection
    const delOk = await aiStore.deleteThread('evt-k', 'th-k')
    expect(delOk).toBe(true)
    expect(capturedAbortSignal?.aborted).toBe(true)
    resolveInFlightPut(new Response(JSON.stringify({ id: 'th-k' }), { status: 200 }))
    await p2
    expect(aiStore.threadDetailsById['th-k']).toBeUndefined()
    aiStore.scheduleSaveThread(thread)
    await aiStore.flushPendingSaves(thread.id)
    expect(aiStore.threadDetailsById['th-k']).toBeUndefined()

    // Secondary sort: pinned DESC, updatedAt DESC
    aiStore.threadsByEvent['evt-sort'] = [
      { id: 't-old', eventId: 'evt-sort', title: 'Old', personaId: 'strategist', pinned: false, messageCount: 0, lastMessagePreview: '', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 't-new', eventId: 'evt-sort', title: 'New', personaId: 'strategist', pinned: false, messageCount: 0, lastMessagePreview: '', updatedAt: '2026-01-02T00:00:00.000Z' },
      { id: 't-pin', eventId: 'evt-sort', title: 'Pin', personaId: 'strategist', pinned: true, messageCount: 0, lastMessagePreview: '', updatedAt: '2025-12-01T00:00:00.000Z' }
    ]
    const tOld = {
      id: 't-old',
      eventId: 'evt-sort',
      title: 'Old Updated',
      personaId: 'strategist',
      pinned: false,
      messages: [],
      contextConfig: { enabled: true, sections: { rankings: true, schedule: true, pit: true, matches: true, tags: true }, focusTeams: [], focusMatch: null }
    }
    aiStore.threadDetailsById['t-old'] = tOld
    aiStore.scheduleSaveThread(tOld)
    expect(aiStore.threadsByEvent['evt-sort']!.map(t => t.id)).toEqual(['t-pin', 't-old', 't-new'])
    await aiStore.flushPendingSaves('t-old')
  })

  it('losslessly restores messages on regenerate/edit preflight error and honors profile enableThinking & custom thinkingBudget', async () => {
    const aiStore = useAiStore()
    const capturedBodies: any[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/users/u-store-1/ai-profiles') {
          return new Response(
            JSON.stringify([
              {
                id: 'p-think',
                name: 'Thinker',
                protocol: 'GEMINI',
                baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
                hasApiKey: true,
                enableThinking: true,
                thinkingBudget: 6000,
                isActive: true
              },
              {
                id: 'p-default',
                name: 'Default',
                protocol: 'OPENAI',
                baseUrl: 'https://api.openai.com/v1',
                hasApiKey: true,
                isActive: false
              }
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        if (url === '/api/events/evt-rb/ai-threads' && init?.method === 'POST') {
          return new Response(
            JSON.stringify({ id: 'th-rb', eventId: 'evt-rb', title: 'RB', personaId: 'strategist', pinned: false, messages: [] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        if (url === '/api/ai/chat/stream') {
          capturedBodies.push(JSON.parse(String(init?.body || '{}')))
          return new Response(JSON.stringify({ error: 'Network down' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          })
        }
        return new Response(JSON.stringify({ id: 'th-rb' }), { status: 200 })
      })
    )

    await aiStore.fetchProfiles()
    // Default enableThinking when omitted must be false
    expect(aiStore.profiles[1]?.enableThinking).toBe(false)
    // Active profile had enableThinking: true & thinkingBudget: 6000 -> auto-synced to 'medium'
    expect(aiStore.thinkingMode).toBe('medium')

    const thread = (await aiStore.createThread('evt-rb'))!
    thread.messages = [
      { id: 'u1', role: 'user', content: 'First Q' },
      { id: 'a1', role: 'assistant', content: 'First A' },
      { id: 'u2', role: 'user', content: 'Second Q' }
    ]

    const regenOk = await aiStore.regenerateAssistantMessage({
      eventId: 'evt-rb',
      messageId: 'a1',
      effectiveSystemPrompt: 'sys'
    })
    expect(regenOk).toBe(false)
    expect(capturedBodies[0]).toMatchObject({ enableThinking: true, thinkingBudget: 6000, reasoningEffort: 'medium' })
    expect(thread.messages.map(m => m.id)).toEqual(['u1', 'a1', 'u2'])

    const editOk = await aiStore.editAndResendUserMessage({
      eventId: 'evt-rb',
      messageId: 'u1',
      newContent: 'Edited First Q',
      effectiveSystemPrompt: 'sys'
    })
    expect(editOk).toBe(false)
    expect(thread.messages.map(m => m.content)).toEqual(['First Q', 'First A', 'u2' === 'u2' ? 'Second Q' : ''])
  })

  it('strips sp27-action from persisted content and sidebar preview, keeps action-only replies free of no_content_returned, and flags malformed empty blocks', async () => {
    const userStore = useUserStore()
    userStore.$patch({ user: { id: 'u-turbo-1', username: 'captain', token: 'jwt-t' } })
    const eventStore = useEventStore()
    eventStore.$patch({
      events: [{ id: 'evt-t', name: 'Turbo Event', inviteCode: 'TRBO', hostId: 'u-turbo-1' }],
      currentEvent: { id: 'evt-t', name: 'Turbo Event', inviteCode: 'TRBO', hostId: 'u-turbo-1' }
    })
    const aiStore = useAiStore()

    let streamIndex = 0
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url === '/api/users/u-turbo-1/ai-profiles') {
          return new Response(
            JSON.stringify([
              { id: 'p-t', name: 'Default', protocol: 'OPENAI', baseUrl: 'https://api.openai.com/v1', hasApiKey: true, isActive: true }
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        if (url === '/api/events/evt-t/ai-threads') {
          return new Response(
            JSON.stringify({ id: 'th-t', eventId: 'evt-t', title: 'Turbo', personaId: 'strategist', pinned: false, messages: [] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        if (url === '/api/ai/chat/stream') {
          streamIndex++
          if (streamIndex === 1) {
            return makeSseResponse([
              'data: {"text":"```sp27-action\\n{\\"actions\\":[{\\"type\\":\\"set_my_team\\",\\"teamNumber\\":27570}]}\\n```"}\n\n',
              'data: [DONE]\n\n'
            ])
          }
          return makeSseResponse([
            'data: {"text":"```sp27-action\\n{broken-unclosed"}\n\n',
            'data: [DONE]\n\n'
          ])
        }
        return new Response(JSON.stringify({ id: 'th-t' }), { status: 200 })
      })
    )

    await aiStore.fetchProfiles()
    await aiStore.createThread('evt-t')

    // 1. Valid action-only reply: executes action, strips raw sp27-action, does NOT write no_content_returned, preview uses [Turbo] summary
    await aiStore.sendChatMessage({
      eventId: 'evt-t',
      prompt: 'Set my team 27570',
      effectiveSystemPrompt: 'sys',
      aiMode: 'turbo'
    })
    const thread = aiStore.threadDetailsById['th-t']!
    const msg1 = thread.messages.find(m => m.role === 'assistant')!
    expect(msg1.turboActions?.length).toBe(1)
    expect(msg1.content).toBe('')
    expect(aiStore.threadsByEvent['evt-t']?.[0]?.lastMessagePreview).toContain('[Turbo]')
    expect(aiStore.threadsByEvent['evt-t']?.[0]?.lastMessagePreview).not.toContain('sp27-action')

    // 2. Malformed unclosed sp27-action with no parsed actions: falls back to no_content_returned instead of blank bubble
    await aiStore.sendChatMessage({
      eventId: 'evt-t',
      prompt: 'Broken block',
      effectiveSystemPrompt: 'sys',
      aiMode: 'turbo'
    })
    const asstMsgs = thread.messages.filter(m => m.role === 'assistant')
    expect(asstMsgs[1]?.content).toBe(i18n.global.t('ai.no_content_returned'))
  })
})
