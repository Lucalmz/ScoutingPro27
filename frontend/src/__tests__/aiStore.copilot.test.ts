import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useUserStore } from '@/stores/user'
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
})
