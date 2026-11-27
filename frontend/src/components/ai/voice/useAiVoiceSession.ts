import { computed, onUnmounted, ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAiStore } from '@/stores/ai'
import { useUserStore } from '@/stores/user'
import { useToastStore } from '@/stores/toast'
import type { AiChatMessage, AiChatThread, AiProviderProfile, AiTokenUsage } from '@/types'
import { aiFetch, DEFAULT_THREAD_TITLES, isZhLocale } from '@/components/ai/constants'
import { stripTurboActionBlocks } from '@/components/ai/turboAgent'
import {
  PcmAudioCapture,
  PcmAudioPlayer,
  StreamingSpeechSynthesizer,
  encodeWavBase64,
  int16ToBase64
} from './audioEngine'
import {
  GEMINI_LIVE_MODELS,
  GEMINI_VOICES,
  OPENAI_REALTIME_MODELS,
  OPENAI_VOICES,
  findBestSttHelperProfiles,
  loadVoicePrefs,
  resolveVoiceCapability,
  saveVoicePrefs,
  type VoiceInputMode,
  type VoicePreferences
} from './voiceCatalog'

export type VoiceSessionStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'recording'
  | 'transcribing'
  | 'error'

interface BrowserSpeechRecognitionResultEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>
}

interface BrowserSpeechRecognition {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((evt: BrowserSpeechRecognitionResultEvent) => void) | null
  onerror: ((evt: { error?: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

export interface UseAiVoiceSessionOptions {
  eventId: Ref<string> | (() => string)
  activeThread: Ref<AiChatThread | null>
  buildEffectiveSystemPrompt: (opts?: { forVoice?: boolean }) => string
  buildBriefContextLabel: () => string | undefined
}

function getSpeechRecognitionCtor(): (new () => BrowserSpeechRecognition) | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: new () => BrowserSpeechRecognition
    webkitSpeechRecognition?: new () => BrowserSpeechRecognition
  }
  return w.SpeechRecognition || w.webkitSpeechRecognition || null
}

function buildVoiceWsUrl(): string {
  if (typeof window === 'undefined') return 'ws://localhost:8080/ws/ai/voice'
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/ws/ai/voice`
}

export function useAiVoiceSession(options: UseAiVoiceSessionOptions) {
  const { t, locale } = useI18n()
  const aiStore = useAiStore()
  const userStore = useUserStore()
  const toastStore = useToastStore()

  const getEventId = () => (typeof options.eventId === 'function' ? options.eventId() : options.eventId.value)

  const prefs = ref<VoicePreferences>(loadVoicePrefs())
  const isActive = ref(false)
  const isMinimized = ref(false)
  const status = ref<VoiceSessionStatus>('idle')
  const isMuted = ref(false)
  const isPttHolding = ref(false)
  const inputLevel = ref(0)
  const outputLevel = ref(0)
  const elapsedSeconds = ref(0)
  const errorMessage = ref<string | null>(null)
  const goAwayWarning = ref<string | null>(null)

  const userFinalText = ref('')
  const userInterimText = ref('')
  const assistantText = ref('')
  const lastCompletedTurn = ref<{ user: string; assistant: string } | null>(null)
  const liveUserTranscript = computed(() => `${userFinalText.value}${userInterimText.value}`.trim())
  const liveAssistantTranscript = computed(() =>
    stripTurboActionBlocks(assistantText.value).displayContent
  )

  const activeProfile = computed(() => aiStore.activeProfile)
  const forceOpenAiRealtime = computed(() => {
    const id = activeProfile.value?.id
    return id ? Boolean(prefs.value.forceOpenAiRealtimeByProfile[id]) : false
  })
  const capability = computed(() => resolveVoiceCapability(activeProfile.value, forceOpenAiRealtime.value))
  const engine = computed(() => capability.value.engine)
  const isNativeLive = computed(() => capability.value.tier === 'native-live')

  const inputMode = computed<VoiceInputMode>({
    get: () => prefs.value.inputMode,
    set: mode => {
      prefs.value = { ...prefs.value, inputMode: mode }
      saveVoicePrefs(prefs.value)
      if (isActive.value && isNativeLive.value) {
        if (capture) {
          if (mode === 'ptt' && !isPttHolding.value) {
            capture.setMuted(true)
          } else if (mode === 'vad') {
            capture.setMuted(isMuted.value)
          }
        }
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'mode', inputMode: mode }))
        }
      }
    }
  })

  const selectedModel = computed<string>({
    get: () => {
      if (engine.value === 'gemini-live') {
        return prefs.value.geminiModel || capability.value.defaultModel || GEMINI_LIVE_MODELS[0]!.id
      }
      if (engine.value === 'openai-realtime') {
        return prefs.value.openaiModel || capability.value.defaultModel || OPENAI_REALTIME_MODELS[0]!.id
      }
      return activeProfile.value?.modelName || ''
    },
    set: val => {
      const clean = val.trim()
      if (!clean) return
      if (engine.value === 'gemini-live') {
        prefs.value = { ...prefs.value, geminiModel: clean }
      } else if (engine.value === 'openai-realtime') {
        prefs.value = { ...prefs.value, openaiModel: clean }
      }
      saveVoicePrefs(prefs.value)
    }
  })

  const selectedVoice = computed<string>({
    get: () => {
      if (engine.value === 'gemini-live') {
        return prefs.value.geminiVoice || GEMINI_VOICES[0]!.id
      }
      if (engine.value === 'openai-realtime') {
        return prefs.value.openaiVoice || OPENAI_VOICES[0]!.id
      }
      return ''
    },
    set: val => {
      if (engine.value === 'gemini-live') {
        prefs.value = { ...prefs.value, geminiVoice: val }
      } else if (engine.value === 'openai-realtime') {
        prefs.value = { ...prefs.value, openaiVoice: val }
      }
      saveVoicePrefs(prefs.value)
    }
  })

  const sttHelpers = computed<AiProviderProfile[]>(() => findBestSttHelperProfiles(aiStore.profiles))
  const sttHelperProfileId = computed<string>({
    get: () => prefs.value.sttHelperProfileId,
    set: val => {
      prefs.value = { ...prefs.value, sttHelperProfileId: val }
      saveVoicePrefs(prefs.value)
    }
  })

  const activeSttProfile = computed<AiProviderProfile | null>(() => {
    const choice = prefs.value.sttHelperProfileId
    if (choice === 'browser') return null
    if (choice) {
      const found = sttHelpers.value.find(p => p.id === choice)
      if (found) return found
    }
    if (activeProfile.value && capability.value.directSttSupported) {
      return activeProfile.value
    }
    return sttHelpers.value[0] || null
  })

  const autoSpeakTurnVoice = computed<boolean>({
    get: () => prefs.value.autoSpeakTurnVoice,
    set: val => {
      prefs.value = { ...prefs.value, autoSpeakTurnVoice: val }
      saveVoicePrefs(prefs.value)
      if (!val) {
        tts.stop()
      }
    }
  })

  const canUseBrowserSpeechRec = Boolean(getSpeechRecognitionCtor())

  // Internal runtime resources
  let ws: WebSocket | null = null
  let capture: PcmAudioCapture | null = null
  let player: PcmAudioPlayer | null = null
  const tts = new StreamingSpeechSynthesizer({
    locale: locale.value,
    onSpeakingChange: speaking => {
      if (!isActive.value || isNativeLive.value) return
      if (speaking) {
        status.value = 'speaking'
      } else if (status.value === 'speaking') {
        status.value = 'listening'
      }
    }
  })
  let speechRec: BrowserSpeechRecognition | null = null
  let turnPcmChunks: Int16Array[] = []
  let callTimer: ReturnType<typeof setInterval> | null = null
  let activeTurnCommitted = false
  let pendingTurnUsage: AiTokenUsage | undefined = undefined
  let lastCommittedAssistantMsgId: string | null = null
  let sessionToken = 0
  let stopWatchTurnStream: (() => void) | null = null

  function parseVoiceUsage(raw: any): AiTokenUsage | undefined {
    if (!raw || typeof raw !== 'object') return undefined
    const usage: AiTokenUsage = {}
    if (typeof raw.promptTokens === 'number' && Number.isFinite(raw.promptTokens)) {
      usage.promptTokens = raw.promptTokens
    }
    if (typeof raw.completionTokens === 'number' && Number.isFinite(raw.completionTokens)) {
      usage.completionTokens = raw.completionTokens
    }
    if (typeof raw.totalTokens === 'number' && Number.isFinite(raw.totalTokens)) {
      usage.totalTokens = raw.totalTokens
    }
    if (typeof raw.thoughtsTokens === 'number' && Number.isFinite(raw.thoughtsTokens)) {
      usage.thoughtsTokens = raw.thoughtsTokens
    }
    return Object.keys(usage).length > 0 ? usage : undefined
  }

  watch(locale, newLoc => {
    tts.setLocale(newLoc)
  })

  function buildVoiceSystemPrompt(): string {
    const base = options.buildEffectiveSystemPrompt({ forVoice: isNativeLive.value })
    const isZh = isZhLocale(locale.value)
    const addendum = isZh
      ? '【语音直接对话模式指令】你正在与侦察员/教练进行实时语音通话。请用自然、口语化、简洁直白的语言直接回答重点（避免输出冗长 Markdown 表格或大量符号），队号直接报数字，必要时简短确认关键战术数字。'
      : '[Live Voice Conversation Mode] You are in a live voice call with an FTC coach/scouter. Speak concisely and conversationally with direct tactical takeaways; avoid reading long Markdown tables or raw syntax aloud.'
    return base ? `${base}\n\n${addendum}` : addendum
  }

  function autoTitleIfNeeded(thread: AiChatThread, firstUserText: string) {
    const isDefaultTitle =
      !thread.title.trim() ||
      DEFAULT_THREAD_TITLES.includes(thread.title as (typeof DEFAULT_THREAD_TITLES)[number])
    if (thread.messages.filter(m => m.role === 'user').length <= 1 && isDefaultTitle) {
      const cleaned = firstUserText.replace(/\s+/g, ' ').trim()
      thread.title = cleaned.length > 36 ? `${cleaned.slice(0, 36)}...` : cleaned
    }
  }

  function commitActiveTurnToThread(force = false) {
    if (activeTurnCommitted && !force) return
    const uText = `${userFinalText.value}${userInterimText.value}`.trim()
    const aText = stripTurboActionBlocks(assistantText.value).displayContent
    if (!uText && !aText) return

    const thread = options.activeThread.value
    if (thread) {
      const nowIso = new Date().toISOString()
      if (uText) {
        const userMsg: AiChatMessage = {
          id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          role: 'user',
          content: uText,
          createdAt: nowIso,
          viaVoice: true
        }
        thread.messages.push(userMsg)
        autoTitleIfNeeded(thread, uText)
      }
      if (aText) {
        const asstMsg: AiChatMessage = {
          id: `asst_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          role: 'assistant',
          content: aText,
          createdAt: nowIso,
          modelName: selectedModel.value || activeProfile.value?.modelName,
          profileName: activeProfile.value?.name,
          contextSummary: options.buildBriefContextLabel(),
          ...(pendingTurnUsage ? { usage: pendingTurnUsage } : {}),
          viaVoice: true
        }
        thread.messages.push(asstMsg)
        lastCommittedAssistantMsgId = asstMsg.id
      } else {
        lastCommittedAssistantMsgId = null
      }
      thread.updatedAt = nowIso
      aiStore.scheduleSaveThread(thread)
    }

    lastCompletedTurn.value = { user: uText, assistant: aText }
    userFinalText.value = ''
    userInterimText.value = ''
    assistantText.value = ''
    pendingTurnUsage = undefined
    activeTurnCommitted = true
  }

  function resetTurnBuffers() {
    userFinalText.value = ''
    userInterimText.value = ''
    assistantText.value = ''
    pendingTurnUsage = undefined
    lastCommittedAssistantMsgId = null
    activeTurnCommitted = false
  }

  function cleanupTransportResources() {
    if (stopWatchTurnStream) {
      stopWatchTurnStream()
      stopWatchTurnStream = null
    }
    if (callTimer) {
      clearInterval(callTimer)
      callTimer = null
    }
    if (ws) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'stop' }))
        }
        ws.close()
      } catch {}
      ws = null
    }
    if (capture) {
      capture.stop()
      capture = null
    }
    if (player) {
      player.close()
      player = null
    }
    if (speechRec) {
      try {
        speechRec.abort()
      } catch {}
      speechRec = null
    }
    tts.stop()
    turnPcmChunks = []
    inputLevel.value = 0
    outputLevel.value = 0
  }

  async function startSession(): Promise<void> {
    if (aiStore.profiles.length === 0) {
      await aiStore.fetchProfiles()
    }
    const profile = aiStore.activeProfile
    if (!profile || !aiStore.canSendWithActiveProfile) {
      aiStore.openSettingsModal()
      return
    }
    if (!userStore.token) {
      toastStore.showError(t('ai.err_not_logged_in'))
      return
    }
    const evtId = getEventId()
    if (!evtId) return
    const thread = await aiStore.ensureActiveThread(evtId)
    if (!thread) return

    if (isActive.value) {
      stopSession()
    }

    const mySession = ++sessionToken
    errorMessage.value = null
    goAwayWarning.value = null
    lastCompletedTurn.value = null
    resetTurnBuffers()
    elapsedSeconds.value = 0
    isMuted.value = false
    isPttHolding.value = false
    isActive.value = true

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      status.value = 'error'
      errorMessage.value = t('ai.voice.err_mic_https')
      return
    }

    callTimer = setInterval(() => {
      elapsedSeconds.value += 1
    }, 1000)

    if (capability.value.tier === 'native-live') {
      await startNativeLiveSession(profile, thread, mySession)
    } else {
      startTurnVoiceSession()
    }
  }

  async function startNativeLiveSession(
    profile: AiProviderProfile,
    thread: AiChatThread,
    mySession: number
  ): Promise<void> {
    status.value = 'connecting'

    const localPlayer = new PcmAudioPlayer({
      onLevel: lvl => {
        outputLevel.value = lvl
      },
      onPlayingChange: playing => {
        if (!isActive.value || mySession !== sessionToken) return
        if (playing) {
          status.value = 'speaking'
        } else if (status.value === 'speaking') {
          status.value = 'listening'
        }
      }
    })
    player = localPlayer
    try {
      await localPlayer.warmup()
    } catch {}
    if (mySession !== sessionToken || !isActive.value) {
      localPlayer.close()
      if (player === localPlayer) player = null
      return
    }

    const socket = new WebSocket(buildVoiceWsUrl())
    ws = socket

    socket.onopen = () => {
      if (mySession !== sessionToken || !isActive.value) {
        socket.close()
        return
      }
      const recentHistory = thread.messages
        .filter(m => !m.error && m.content.trim().length > 0)
        .slice(-12)
        .map(m => ({ role: m.role, content: m.content }))

      socket.send(
        JSON.stringify({
          type: 'start',
          token: userStore.token,
          profileId: profile.id,
          provider: profile.protocol,
          model: selectedModel.value,
          voice: selectedVoice.value,
          inputMode: inputMode.value,
          systemPrompt: buildVoiceSystemPrompt(),
          history: recentHistory
        })
      )
    }

    socket.onmessage = async evt => {
      if (mySession !== sessionToken || !isActive.value) return
      let msg: any
      try {
        msg = JSON.parse(String(evt.data))
      } catch {
        return
      }

      switch (msg.type) {
        case 'ready': {
          const targetRate = Number(msg.inputSampleRate) || (engine.value === 'openai-realtime' ? 24000 : 16000)
          const localCapture = new PcmAudioCapture({
            targetSampleRate: targetRate,
            onLevel: lvl => {
              inputLevel.value = lvl
            },
            onChunk: pcm => {
              if (ws === socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'audio', data: int16ToBase64(pcm) }))
              }
            }
          })
          capture = localCapture
          try {
            await localCapture.start()
            if (mySession !== sessionToken || !isActive.value) {
              localCapture.stop()
              return
            }
            if (inputMode.value === 'ptt' && !isPttHolding.value) {
              localCapture.setMuted(true)
            } else {
              localCapture.setMuted(isMuted.value)
            }
            status.value = 'listening'
          } catch (err: any) {
            const code = err?.message === 'MEDIA_DEVICES_UNAVAILABLE'
              ? t('ai.voice.err_mic_https')
              : err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError'
                ? t('ai.voice.err_mic_denied')
                : err?.message || t('ai.voice.err_mic_generic')
            errorMessage.value = code
            status.value = 'error'
            cleanupTransportResources()
          }
          break
        }

        case 'audio': {
          if (msg.data) {
            localPlayer.enqueue(String(msg.data), Number(msg.sampleRate) || 24000)
          }
          break
        }

        case 'transcript': {
          const text = typeof msg.text === 'string' ? msg.text : ''
          if (!text) break
          if (msg.role === 'user') {
            if (assistantText.value.trim().length > 0 && !activeTurnCommitted) {
              commitActiveTurnToThread()
            }
            activeTurnCommitted = false
            if (msg.interim) {
              userInterimText.value = text
            } else if (msg.replace) {
              userFinalText.value = text
              userInterimText.value = ''
            } else {
              userInterimText.value = ''
              userFinalText.value += text
            }
          } else if (msg.role === 'assistant') {
            activeTurnCommitted = false
            assistantText.value += text
          }
          break
        }

        case 'interrupted': {
          localPlayer.interrupt()
          if (userFinalText.value.trim() || assistantText.value.trim()) {
            commitActiveTurnToThread()
          }
          if (isActive.value) {
            status.value = 'listening'
          }
          break
        }

        case 'status': {
          if (msg.interactionStatus === 'IN_PROGRESS') {
            status.value = 'thinking'
          } else if (msg.interactionStatus === 'IDLE') {
            commitActiveTurnToThread()
            if (status.value !== 'speaking') {
              status.value = 'listening'
            }
          }
          break
        }

        case 'turn_complete': {
          const interactionStatus = msg.interactionStatus
          if (!interactionStatus || interactionStatus === 'IDLE') {
            commitActiveTurnToThread()
            if (status.value === 'thinking') {
              status.value = 'listening'
            }
          }
          break
        }

        case 'usage': {
          const parsedUsage = parseVoiceUsage(msg.usage ?? msg)
          if (!parsedUsage) break
          if (!activeTurnCommitted) {
            pendingTurnUsage = parsedUsage
          } else {
            const thread = options.activeThread.value
            if (thread) {
              const targetMsg =
                (lastCommittedAssistantMsgId
                  ? thread.messages.find(m => m.id === lastCommittedAssistantMsgId)
                  : undefined) ||
                [...thread.messages].reverse().find(m => m.role === 'assistant' && m.viaVoice)
              if (targetMsg) {
                targetMsg.usage = parsedUsage
                thread.updatedAt = new Date().toISOString()
                aiStore.scheduleSaveThread(thread)
              }
            }
          }
          break
        }

        case 'go_away': {
          goAwayWarning.value = t('ai.voice.go_away_notice', { time: msg.timeLeft || '' })
          break
        }

        case 'error': {
          const errText = String(msg.message || msg.code || t('ai.err_connect_failed'))
          errorMessage.value = errText
          status.value = 'error'
          toastStore.showError(errText)
          cleanupTransportResources()
          break
        }
      }
    }

    socket.onerror = () => {
      if (mySession !== sessionToken || !isActive.value) return
      if (status.value !== 'error') {
        errorMessage.value = t('ai.voice.err_ws_failed')
        status.value = 'error'
        cleanupTransportResources()
      }
    }

    socket.onclose = evt => {
      if (mySession !== sessionToken) return
      if (isActive.value && status.value !== 'error') {
        if (evt.code !== 1000 && evt.code !== 1001) {
          errorMessage.value = evt.reason || t('ai.voice.err_ws_closed', { code: evt.code })
          status.value = 'error'
          cleanupTransportResources()
        } else {
          stopSession()
        }
      }
    }
  }

  function startTurnVoiceSession(): void {
    // Turn-based mode uses PTT / click-to-talk (since DeepSeek/Claude/Ollama do not have server VAD)
    prefs.value = { ...prefs.value, inputMode: 'ptt' }
    saveVoicePrefs(prefs.value)
    status.value = 'listening'
  }

  async function beginPtt(): Promise<void> {
    if (!isActive.value || isPttHolding.value) return
    errorMessage.value = null

    if (isNativeLive.value) {
      if (status.value === 'speaking') {
        interrupt()
      }
      isPttHolding.value = true
      capture?.setMuted(false)
      status.value = 'recording'
      return
    }

    // Turn-based voice recording
    interrupt()
    isPttHolding.value = true
    status.value = 'recording'
    turnPcmChunks = []

    const sttProfile = activeSttProfile.value
    if (sttProfile) {
      const localCapture = new PcmAudioCapture({
        targetSampleRate: 16000,
        onLevel: lvl => {
          inputLevel.value = lvl
        },
        onChunk: pcm => {
          turnPcmChunks.push(pcm)
        }
      })
      capture = localCapture
      try {
        await localCapture.start()
      } catch (err: any) {
        isPttHolding.value = false
        localCapture.stop()
        capture = null
        status.value = 'error'
        errorMessage.value =
          err?.message === 'MEDIA_DEVICES_UNAVAILABLE'
            ? t('ai.voice.err_mic_https')
            : err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError'
              ? t('ai.voice.err_mic_denied')
              : err?.message || t('ai.voice.err_mic_generic')
      }
      return
    }

    // Browser Web Speech Recognition fallback when no backend STT profile exists
    const RecCtor = getSpeechRecognitionCtor()
    if (!RecCtor) {
      isPttHolding.value = false
      status.value = 'error'
      errorMessage.value = t('ai.voice.err_no_stt_available')
      return
    }
    try {
      const rec = new RecCtor()
      rec.lang = isZhLocale(locale.value) ? 'zh-CN' : 'en-US'
      rec.interimResults = true
      rec.continuous = true
      userFinalText.value = ''
      userInterimText.value = ''
      rec.onresult = evt => {
        let finalStr = ''
        let interimStr = ''
        for (let i = 0; i < evt.results.length; i++) {
          const r = evt.results[i]!
          const txt = r[0]?.transcript || ''
          if (r.isFinal) finalStr += txt
          else interimStr += txt
        }
        userFinalText.value = finalStr
        userInterimText.value = interimStr
      }
      rec.onerror = evt => {
        if (evt.error === 'network') {
          errorMessage.value = t('ai.voice.err_webspeech_network')
        } else if (evt.error === 'not-allowed') {
          errorMessage.value = t('ai.voice.err_mic_denied')
        } else if (evt.error !== 'no-speech' && evt.error !== 'aborted') {
          errorMessage.value = evt.error || t('ai.voice.err_mic_generic')
        }
        if (errorMessage.value) {
          status.value = 'error'
        }
      }
      speechRec = rec
      rec.start()
    } catch (err: any) {
      isPttHolding.value = false
      status.value = 'error'
      errorMessage.value = err?.message || t('ai.voice.err_no_stt_available')
    }
  }

  async function endPtt(): Promise<void> {
    if (!isActive.value || !isPttHolding.value) return
    isPttHolding.value = false

    if (isNativeLive.value) {
      capture?.setMuted(true)
      inputLevel.value = 0
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'audio_end', commit: true }))
      }
      status.value = 'thinking'
      return
    }

    const sttProfile = activeSttProfile.value
    if (sttProfile && capture) {
      const mySession = sessionToken
      capture.stop()
      capture = null
      const chunks = turnPcmChunks
      turnPcmChunks = []
      const totalSamples = chunks.reduce((acc, c) => acc + c.length, 0)
      if (totalSamples < 1600) {
        status.value = 'listening'
        return
      }
      status.value = 'transcribing'
      try {
        const wavBase64 = encodeWavBase64(chunks, 16000)
        const res = await aiFetch('/api/ai/audio/transcribe', {
          method: 'POST',
          token: userStore.token,
          onRefreshedToken: newToken => {
            if (userStore.user) {
              userStore.user = { ...userStore.user, token: newToken }
            }
          },
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            profileId: sttProfile.id,
            provider: sttProfile.protocol,
            audioBase64: wavBase64,
            mimeType: 'audio/wav',
            language: isZhLocale(locale.value) ? 'zh' : 'en'
          })
        })
        if (!isActive.value || mySession !== sessionToken) return
        const data = await res.json().catch(() => ({}))
        if (!isActive.value || mySession !== sessionToken) return
        if (!res.ok) {
          throw new Error(data.error || `HTTP ${res.status}`)
        }
        const recognized = typeof data.text === 'string' ? data.text.trim() : ''
        if (!recognized) {
          status.value = 'listening'
          return
        }
        await submitTurnVoicePrompt(recognized)
      } catch (err: any) {
        if (!isActive.value || mySession !== sessionToken) return
        errorMessage.value = err?.message || t('ai.voice.err_transcribe_failed')
        status.value = 'error'
      }
      return
    }

    if (speechRec) {
      const mySession = sessionToken
      const rec = speechRec
      speechRec = null
      try {
        rec.stop()
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 250))
      const text = `${userFinalText.value}${userInterimText.value}`.trim()
      userFinalText.value = ''
      userInterimText.value = ''
      if (!isActive.value || mySession !== sessionToken) return
      if (text) {
        await submitTurnVoicePrompt(text)
      } else if (status.value !== 'error') {
        status.value = 'listening'
      }
    }
  }

  async function submitTurnVoicePrompt(prompt: string): Promise<void> {
    const evtId = getEventId()
    const clean = prompt.trim()
    if (!evtId || !clean || !isActive.value) return
    const mySession = sessionToken

    const thread = await aiStore.ensureActiveThread(evtId)
    if (!thread || !isActive.value || mySession !== sessionToken) return

    userFinalText.value = clean
    userInterimText.value = ''
    assistantText.value = ''
    status.value = 'thinking'

    let lastCleanLen = 0
    if (stopWatchTurnStream) {
      stopWatchTurnStream()
      stopWatchTurnStream = null
    }
    const priorMsgIds = new Set(thread.messages.map(m => m.id))

    stopWatchTurnStream = watch(
      () => {
        const streamingId = aiStore.getStreamingMessageId(thread.id)
        if (!streamingId) return ''
        const msg = thread.messages.find(m => m.id === streamingId)
        return msg?.content || ''
      },
      newContent => {
        if (!isActive.value || mySession !== sessionToken || isNativeLive.value) return
        assistantText.value = newContent
        const rawClean = stripTurboActionBlocks(newContent).displayContent
        const safeClean = rawClean.replace(/`{1,3}[a-z0-9-]*$/i, '')
        if (safeClean.length > lastCleanLen) {
          const delta = safeClean.slice(lastCleanLen)
          lastCleanLen = safeClean.length
          if (autoSpeakTurnVoice.value) {
            tts.pushDelta(delta)
          }
        }
      }
    )

    const ok = await aiStore.sendChatMessage({
      eventId: evtId,
      prompt: clean,
      effectiveSystemPrompt: buildVoiceSystemPrompt(),
      contextSummary: options.buildBriefContextLabel(),
      errorPrefix: t('ai.error_prefix')
    })

    if (stopWatchTurnStream) {
      stopWatchTurnStream()
      stopWatchTurnStream = null
    }

    for (const msg of thread.messages) {
      if (!priorMsgIds.has(msg.id)) {
        msg.viaVoice = true
      }
    }
    aiStore.scheduleSaveThread(thread)

    if (!isActive.value || mySession !== sessionToken) {
      userFinalText.value = ''
      assistantText.value = ''
      return
    }

    const finalClean = stripTurboActionBlocks(assistantText.value).displayContent
    if (autoSpeakTurnVoice.value && ok) {
      if (finalClean.length > lastCleanLen) {
        tts.pushDelta(finalClean.slice(lastCleanLen))
      }
      tts.flush()
    }
    lastCompletedTurn.value = { user: clean, assistant: finalClean }
    userFinalText.value = ''
    assistantText.value = ''
    const currentStatus = (): VoiceSessionStatus => status.value
    if (isActive.value && mySession === sessionToken && currentStatus() !== 'speaking') {
      status.value = 'listening'
    }
  }

  function toggleMute(): void {
    const next = !isMuted.value
    isMuted.value = next
    if (capture && (inputMode.value === 'vad' || isPttHolding.value)) {
      capture.setMuted(next)
    }
    if (next && isNativeLive.value && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'audio_end', commit: false }))
    }
  }

  function interrupt(): void {
    player?.interrupt()
    tts.stop()
    if (isNativeLive.value && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'interrupt' }))
    } else if (!isNativeLive.value) {
      aiStore.stopStreaming(options.activeThread.value?.id)
    }
    if (isActive.value && status.value === 'speaking') {
      status.value = 'listening'
    }
  }

  async function sendTextInCall(rawText: string): Promise<void> {
    const clean = rawText.trim()
    if (!clean || !isActive.value) return
    if (isNativeLive.value && ws && ws.readyState === WebSocket.OPEN) {
      if (assistantText.value.trim()) {
        commitActiveTurnToThread()
      }
      activeTurnCommitted = false
      userFinalText.value = clean
      userInterimText.value = ''
      ws.send(JSON.stringify({ type: 'text', text: clean }))
      status.value = 'thinking'
      return
    }
    await submitTurnVoicePrompt(clean)
  }

  function setForceOpenAiRealtime(enabled: boolean): void {
    const id = activeProfile.value?.id
    if (!id) return
    prefs.value = {
      ...prefs.value,
      forceOpenAiRealtimeByProfile: {
        ...prefs.value.forceOpenAiRealtimeByProfile,
        [id]: enabled
      }
    }
    saveVoicePrefs(prefs.value)
  }

  async function applySettingsAndReconnect(): Promise<void> {
    if (!isActive.value) return
    commitActiveTurnToThread()
    cleanupTransportResources()
    isActive.value = false
    await startSession()
  }

  function stopSession(): void {
    sessionToken += 1
    if (isActive.value && isNativeLive.value) {
      commitActiveTurnToThread()
    } else if (isActive.value && !isNativeLive.value) {
      aiStore.stopStreaming(options.activeThread.value?.id)
    }
    cleanupTransportResources()
    const thread = options.activeThread.value
    if (thread) {
      void aiStore.flushPendingSaves(thread.id)
    }
    isActive.value = false
    isMinimized.value = false
    isMuted.value = false
    isPttHolding.value = false
    status.value = 'idle'
    errorMessage.value = null
    goAwayWarning.value = null
  }

  onUnmounted(() => {
    stopSession()
  })

  return {
    isActive,
    isMinimized,
    status,
    engine,
    capability,
    isNativeLive,
    inputMode,
    isMuted,
    isPttHolding,
    inputLevel,
    outputLevel,
    elapsedSeconds,
    selectedModel,
    selectedVoice,
    sttHelperProfileId,
    sttHelpers,
    activeSttProfile,
    autoSpeakTurnVoice,
    forceOpenAiRealtime,
    canUseBrowserSpeechRec,
    liveUserTranscript,
    liveAssistantTranscript,
    lastCompletedTurn,
    errorMessage,
    goAwayWarning,
    startSession,
    stopSession,
    toggleMute,
    beginPtt,
    endPtt,
    interrupt,
    sendTextInCall,
    setForceOpenAiRealtime,
    applySettingsAndReconnect
  }
}
