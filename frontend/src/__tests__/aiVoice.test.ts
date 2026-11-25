import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref, nextTick } from 'vue'
import { i18n } from '@/i18n'
import type { AiChatMessage, AiChatThread, AiProviderProfile } from '@/types'
import { useUserStore } from '@/stores/user'
import { useAiStore } from '@/stores/ai'
import {
  resolveVoiceCapability,
  findBestSttHelperProfiles,
  stripMarkdownForSpeech
} from '@/components/ai/voice/voiceCatalog'
import {
  downsampleFloat32ToInt16,
  int16ToBase64,
  base64ToInt16,
  encodeWavBase64,
  StreamingSpeechSynthesizer
} from '@/components/ai/voice/audioEngine'
import { useAiVoiceSession } from '@/components/ai/voice/useAiVoiceSession'
import AiChatComposer from '@/components/ai/AiChatComposer.vue'
import AiVoiceCallOverlay from '@/components/ai/voice/AiVoiceCallOverlay.vue'
import AiMessageItem from '@/components/ai/AiMessageItem.vue'

function makeProfile(overrides: Partial<AiProviderProfile>): AiProviderProfile {
  return {
    id: 'prof-1',
    name: 'Test Profile',
    presetId: 'custom',
    protocol: 'OPENAI',
    apiKeyEncrypted: 'sk****************1234',
    hasApiKey: true,
    baseUrl: 'https://api.openai.com/v1',
    modelName: 'gpt-4o',
    customModels: [],
    systemPrompt: '',
    temperature: 0.4,
    maxTokens: 4096,
    enableThinking: true,
    thinkingBudget: 4096,
    anthropicVersion: '2023-06-01',
    maxContextMsgs: 16,
    proxyHost: '',
    proxyPort: null,
    isActive: true,
    ...overrides
  }
}

describe('AI Voice Catalog, Audio Engine, Components & Session', () => {
  const wrappers: VueWrapper[] = []
  const track = (w: VueWrapper) => {
    wrappers.push(w)
    return w
  }
  const originalLocale = i18n.global.locale.value

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
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
  })

  it('resolves Gemini Live, OpenAI Realtime, and Turn-Voice capabilities & STT helpers accurately', () => {
    const geminiChat = makeProfile({
      id: 'p-gem',
      protocol: 'GEMINI',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      modelName: 'gemini-flash-latest'
    })
    const gemCap = resolveVoiceCapability(geminiChat)
    expect(gemCap.tier).toBe('native-live')
    expect(gemCap.engine).toBe('gemini-live')
    expect(gemCap.defaultModel).toBe('gemini-3.8-live')

    const geminiThinking = makeProfile({
      id: 'p-gem-t',
      protocol: 'GEMINI',
      modelName: 'gemini-3.8-live-extended-thinking'
    })
    expect(resolveVoiceCapability(geminiThinking).defaultModel).toBe('gemini-3.8-live-extended-thinking')

    const openai = makeProfile({
      id: 'p-oa',
      protocol: 'OPENAI',
      presetId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      modelName: 'gpt-4o'
    })
    const oaCap = resolveVoiceCapability(openai)
    expect(oaCap.tier).toBe('native-live')
    expect(oaCap.engine).toBe('openai-realtime')
    expect(oaCap.defaultModel).toBe('gpt-realtime')

    const deepseek = makeProfile({
      id: 'p-ds',
      protocol: 'OPENAI',
      presetId: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      modelName: 'deepseek-chat'
    })
    const dsTurnCap = resolveVoiceCapability(deepseek, false)
    expect(dsTurnCap.tier).toBe('turn-voice')
    expect(dsTurnCap.engine).toBe('turn-voice')
    expect(dsTurnCap.canForceOpenAiRealtime).toBe(true)

    const dsForcedCap = resolveVoiceCapability(deepseek, true)
    expect(dsForcedCap.tier).toBe('native-live')
    expect(dsForcedCap.engine).toBe('openai-realtime')

    const claude = makeProfile({
      id: 'p-ant',
      protocol: 'ANTHROPIC',
      presetId: 'anthropic-official',
      baseUrl: 'https://api.anthropic.com',
      modelName: 'claude-sonnet-4-20250514'
    })
    const antCap = resolveVoiceCapability(claude)
    expect(antCap.tier).toBe('turn-voice')
    expect(antCap.directSttSupported).toBe(false)

    const groq = makeProfile({
      id: 'p-groq',
      protocol: 'OPENAI',
      presetId: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      isActive: false
    })
    const helpers = findBestSttHelperProfiles([claude, deepseek, groq, geminiChat])
    expect(helpers.map(p => p.id)).toEqual(['p-gem', 'p-groq', 'p-ds'])
  })

  it('strips Markdown syntax cleanly for spoken output and streams speech synthesis sentences', () => {
    const md = [
      '### Strategy for #27570',
      '',
      'Pick **Team 27570** — see [details](https://example.com).',
      '',
      '| Team | Auto |',
      '| --- | --- |',
      '| 27570 | 32 |',
      '',
      '```ts',
      'const x = 1',
      '```'
    ].join('\n')

    const clean = stripMarkdownForSpeech(md)
    expect(clean).not.toContain('```')
    expect(clean).not.toContain('https://')
    expect(clean).not.toContain('---')
    expect(clean).toContain('Strategy for 27570')
    expect(clean).toContain('Pick Team 27570')
    expect(clean).toContain('details')

    const spoken: string[] = []
    const cancelSpy = vi.fn()
    class FakeUtterance {
      text: string
      lang = ''
      rate = 1
      voice: any = null
      onend: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(text: string) {
        this.text = text
      }
    }
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => [{ lang: 'en-US', name: 'EN' }],
      speak: (u: FakeUtterance) => {
        spoken.push(u.text)
        u.onend?.()
      },
      cancel: cancelSpy
    })

    const synth = new StreamingSpeechSynthesizer({ locale: 'en' })
    synth.pushDelta('First sentence')
    expect(spoken).toEqual([])
    synth.pushDelta('. Second ')
    expect(spoken).toEqual(['First sentence.'])
    synth.pushDelta('sentence')
    synth.flush()
    expect(spoken).toEqual(['First sentence.', 'Second sentence'])

    synth.stop()
    expect(cancelSpy).toHaveBeenCalledTimes(1)
  })

  it('downsamples PCM16, converts Base64 roundtrip, and encodes valid WAV headers', () => {
    const input = new Float32Array(480)
    for (let i = 0; i < input.length; i++) {
      input[i] = Math.sin((i / 480) * Math.PI * 2) * 0.5
    }
    const downsampled = downsampleFloat32ToInt16(input, 48000, 16000)
    expect(downsampled.length).toBe(160)

    const b64 = int16ToBase64(downsampled)
    const decoded = base64ToInt16(b64)
    expect(Array.from(decoded)).toEqual(Array.from(downsampled))

    const wavB64 = encodeWavBase64([downsampled], 16000)
    const bin = atob(wavB64)
    expect(bin.slice(0, 4)).toBe('RIFF')
    expect(bin.slice(8, 12)).toBe('WAVE')
    expect(bin.slice(12, 16)).toBe('fmt ')
    expect(bin.slice(36, 40)).toBe('data')
    expect(bin.length).toBe(44 + downsampled.length * 2)
  })

  it('renders voice launch button in AiChatComposer and handles voice stage & mini-bar transitions', async () => {
    const composer = track(
      mount(AiChatComposer, {
        props: {
          modelValue: '',
          isStreaming: false,
          knownTeams: [],
          voiceSupported: true,
          voiceActive: false
        },
        global: { plugins: [i18n] }
      })
    )

    const voiceBtn = composer.find('.btn-voice-launch')
    expect(voiceBtn.exists()).toBe(true)
    expect(voiceBtn.text()).toContain('Voice')
    await voiceBtn.trigger('click')
    expect(composer.emitted('startVoice')).toHaveLength(1)

    await composer.setProps({ voiceActive: true })
    expect(voiceBtn.text()).toContain('Live')

    await composer.setProps({ voiceSupported: false })
    expect(composer.find('.btn-send-stop').exists()).toBe(true)
    expect(composer.find('.btn-voice-launch').exists()).toBe(false)

    // Voice Call Overlay expanded -> PTT -> Minimized
    const overlay = track(
      mount(AiVoiceCallOverlay, {
        props: {
          isActive: true,
          isMinimized: false,
          status: 'listening',
          engine: 'gemini-live',
          capability: resolveVoiceCapability(makeProfile({ protocol: 'GEMINI' })),
          isNativeLive: true,
          inputMode: 'ptt',
          isMuted: false,
          isPttHolding: false,
          inputLevel: 0.2,
          outputLevel: 0,
          elapsedSeconds: 65,
          selectedModel: 'gemini-3.8-live',
          selectedVoice: 'Kore',
          sttHelperProfileId: '',
          sttHelpers: [],
          activeSttProfile: null,
          autoSpeakTurnVoice: true,
          forceOpenAiRealtime: false,
          canUseBrowserSpeechRec: false,
          liveUserTranscript: 'Analyze #27570',
          liveAssistantTranscript: 'Team 27570 leads TeleOp cycles.',
          lastCompletedTurn: null,
          errorMessage: null,
          goAwayWarning: null
        },
        global: { plugins: [i18n] }
      })
    )

    expect(overlay.find('.voice-stage-overlay').exists()).toBe(true)
    expect(overlay.find('.voice-engine-badge').text()).toContain('Gemini Live')
    expect(overlay.find('.voice-timer').text()).toBe('01:05')
    expect(overlay.find('.voice-captions-box').text()).toContain('Analyze #27570')

    const pttBtn = overlay.find('.btn-ptt-hold')
    expect(pttBtn.exists()).toBe(true)
    await pttBtn.trigger('pointerdown')
    expect(overlay.emitted('beginPtt')).toHaveLength(1)

    await overlay.setProps({ isMinimized: true })
    expect(overlay.find('.voice-stage-overlay').exists()).toBe(false)
    expect(overlay.find('.voice-mini-bar').exists()).toBe(true)
    expect(overlay.find('.voice-mini-bar').text()).toContain('Team 27570 leads TeleOp cycles.')
  })

  it('displays voice badge and toggles Read Aloud on assistant messages in AiMessageItem', async () => {
    const spoken: string[] = []
    const cancelSpy = vi.fn()
    class FakeUtterance {
      text: string
      lang = ''
      rate = 1
      voice: any = null
      onend: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(text: string) {
        this.text = text
      }
    }
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => [{ lang: 'en-US', name: 'EN' }],
      speak: (u: FakeUtterance) => {
        spoken.push(u.text)
      },
      cancel: cancelSpy
    })

    const voiceMsg: AiChatMessage = {
      id: 'm-voice-1',
      role: 'assistant',
      content: 'Pick **#27570** for strong Swarm RP.',
      viaVoice: true,
      modelName: 'gemini-3.8-live'
    }

    const wrapper = track(
      mount(AiMessageItem, {
        props: {
          message: voiceMsg,
          isStreaming: false,
          isLatestAssistant: true,
          knownTeamRegex: /\b(27570)\b/g
        },
        global: { plugins: [i18n] }
      })
    )

    expect(wrapper.find('.msg-role-bar').exists()).toBe(true)
    expect(wrapper.find('.msg-voice-pill').exists()).toBe(true)
    expect(wrapper.find('.msg-voice-pill').text()).toContain('Voice')

    const readBtn = wrapper.find('button[aria-label="Read aloud"]')
    expect(readBtn.exists()).toBe(true)
    await readBtn.trigger('click')
    expect(spoken).toEqual(['Pick 27570 for strong Swarm RP.'])
    expect(wrapper.find('button[aria-label="Stop reading"]').exists()).toBe(true)

    await wrapper.find('button[aria-label="Stop reading"]').trigger('click')
    expect(cancelSpy).toHaveBeenCalled()

    await wrapper.setProps({
      message: { ...voiceMsg, viaVoice: false }
    })
    expect(wrapper.find('.msg-role-bar').exists()).toBe(true)
    expect(wrapper.find('.msg-voice-pill').exists()).toBe(false)
  })

  it('connects useAiVoiceSession to /ws/ai/voice, handles transcripts, and commits turns into active thread', async () => {
    const userStore = useUserStore()
    userStore.$patch({
      user: { id: 'u-v-1', username: 'coach', token: 'jwt-voice-1' }
    })

    const aiStore = useAiStore()
    const geminiProfile = makeProfile({
      id: 'prof-gem-live',
      name: 'Gemini Official',
      protocol: 'GEMINI',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      modelName: 'gemini-flash-latest'
    })

    const thread: AiChatThread = {
      id: 'th-voice-1',
      eventId: 'evt-voice-1',
      title: 'New Tactical Chat',
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

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url === '/api/users/u-v-1/ai-profiles') {
          return new Response(JSON.stringify([geminiProfile]), { status: 200 })
        }
        if (url.includes('/ai-threads')) {
          return new Response(JSON.stringify(thread), { status: 200 })
        }
        return new Response('{}', { status: 200 })
      })
    )

    await aiStore.fetchProfiles()
    aiStore.threadsByEvent['evt-voice-1'] = [
      {
        id: thread.id,
        eventId: thread.eventId,
        title: thread.title,
        personaId: thread.personaId,
        pinned: false,
        messageCount: 0,
        lastMessagePreview: ''
      }
    ]
    aiStore.threadDetailsById[thread.id] = thread
    aiStore.activeThreadIdByEvent['evt-voice-1'] = thread.id

    const sentFrames: any[] = []
    let createdSocket: FakeWebSocket | null = null
    class FakeWebSocket {
      static OPEN = 1
      readyState = 1
      onopen: (() => void) | null = null
      onmessage: ((evt: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: ((evt: { code: number; reason: string }) => void) | null = null
      constructor(_url: string) {
        createdSocket = this
      }
      send(raw: string) {
        sentFrames.push(JSON.parse(raw))
      }
      close() {
        this.readyState = 3
      }
    }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: vi.fn() }]
        })
      }
    })
    class FakeAudioContext {
      sampleRate = 16000
      state = 'running'
      currentTime = 0
      resume = vi.fn().mockResolvedValue(undefined)
      close = vi.fn().mockResolvedValue(undefined)
      createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() })
      createGain = () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() })
      createScriptProcessor = () => ({ onaudioprocess: null, connect: vi.fn(), disconnect: vi.fn() })
      createBuffer = () => ({ duration: 0.05, copyToChannel: vi.fn() })
      createBufferSource = () => ({
        buffer: null,
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        disconnect: vi.fn(),
        onended: null
      })
    }
    vi.stubGlobal('AudioContext', FakeAudioContext)

    const HostComp = {
      template: '<div></div>',
      setup() {
        return useAiVoiceSession({
          eventId: ref('evt-voice-1'),
          activeThread: ref(thread),
          buildEffectiveSystemPrompt: () => 'SYS_PROMPT',
          buildBriefContextLabel: () => '12T'
        })
      }
    }

    const host = track(mount(HostComp, { global: { plugins: [i18n] } }))
    const session = host.vm as any

    await session.startSession()
    expect(session.isActive).toBe(true)
    expect(createdSocket).not.toBeNull()

    createdSocket!.onopen?.()
    expect(sentFrames[0]).toMatchObject({
      type: 'start',
      token: 'jwt-voice-1',
      profileId: 'prof-gem-live',
      model: 'gemini-3.8-live',
      voice: 'Kore'
    })
    expect(sentFrames[0].systemPrompt).toContain('SYS_PROMPT')

    await createdSocket!.onmessage?.({
      data: JSON.stringify({
        type: 'ready',
        engine: 'gemini-live',
        model: 'gemini-3.8-live',
        inputSampleRate: 16000,
        outputSampleRate: 24000
      })
    })
    expect(session.status).toBe('listening')

    await createdSocket!.onmessage?.({
      data: JSON.stringify({ type: 'transcript', role: 'user', text: 'Who pairs best with 27570?', interim: false })
    })
    await createdSocket!.onmessage?.({
      data: JSON.stringify({ type: 'transcript', role: 'assistant', text: 'Team 12345 fits best.', interim: false })
    })
    await createdSocket!.onmessage?.({
      data: JSON.stringify({ type: 'turn_complete', turnComplete: true })
    })
    await createdSocket!.onmessage?.({
      data: JSON.stringify({
        type: 'usage',
        usage: { promptTokens: 120, completionTokens: 45, totalTokens: 165 }
      })
    })
    await nextTick()

    expect(thread.messages).toHaveLength(2)
    expect(thread.messages[0]).toMatchObject({
      role: 'user',
      content: 'Who pairs best with 27570?',
      viaVoice: true
    })
    expect(thread.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'Team 12345 fits best.',
      viaVoice: true,
      contextSummary: '12T',
      usage: { promptTokens: 120, completionTokens: 45, totalTokens: 165 }
    })

    // Second turn: usage frame arrives BEFORE turn_complete
    await createdSocket!.onmessage?.({
      data: JSON.stringify({ type: 'transcript', role: 'user', text: 'What about endgame?', interim: false })
    })
    await createdSocket!.onmessage?.({
      data: JSON.stringify({ type: 'transcript', role: 'assistant', text: 'Strong flower nectars.', interim: false })
    })
    await createdSocket!.onmessage?.({
      data: JSON.stringify({
        type: 'usage',
        usage: { promptTokens: 140, completionTokens: 30, totalTokens: 182, thoughtsTokens: 12 }
      })
    })
    await createdSocket!.onmessage?.({
      data: JSON.stringify({ type: 'turn_complete', turnComplete: true })
    })
    await nextTick()

    expect(thread.messages).toHaveLength(4)
    expect(thread.messages[3]).toMatchObject({
      role: 'assistant',
      content: 'Strong flower nectars.',
      viaVoice: true,
      usage: { promptTokens: 140, completionTokens: 30, totalTokens: 182, thoughtsTokens: 12 }
    })

    session.stopSession()
    expect(session.isActive).toBe(false)
    expect(sentFrames.some(f => f.type === 'stop')).toBe(true)
  })
})
