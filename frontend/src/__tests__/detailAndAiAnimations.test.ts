import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { i18n } from '@/i18n'
import router from '@/router'
import App from '@/App.vue'
import EventView from '@/views/EventView.vue'
import TeamDetailView from '@/views/TeamDetailView.vue'
import AiCopilotDock from '@/components/ai/AiCopilotDock.vue'
import AiCopilotWorkspace from '@/components/ai/AiCopilotWorkspace.vue'
import AiVoiceCallOverlay from '@/components/ai/voice/AiVoiceCallOverlay.vue'
import { resolveVoiceCapability } from '@/components/ai/voice/voiceCatalog'
import { useAiStore } from '@/stores/ai'
import { useUserStore } from '@/stores/user'
import { useEventStore } from '@/stores/events'
import { DEFAULT_DOCK_WIDTH } from '@/components/ai/constants'

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>()
  return {
    ...actual,
    listEvents: vi.fn().mockResolvedValue([]),
    listRecords: vi.fn().mockResolvedValue([]),
    fetchPitRecords: vi.fn().mockResolvedValue({ records: [], officialTeams: [] }),
    fetchEventTags: vi.fn().mockResolvedValue([]),
    fetchFtcMatches: vi.fn().mockResolvedValue([]),
    fetchFtcRankings: vi.fn().mockResolvedValue([]),
    fetchFtcAdvancement: vi.fn().mockResolvedValue([]),
    apiFetchBannedTeams: vi.fn().mockResolvedValue([]),
    fetchEventSchedule: vi.fn().mockResolvedValue([]),
    fetchEventAssignments: vi.fn().mockResolvedValue([]),
    fetchCustomFields: vi.fn().mockResolvedValue([])
  }
})

vi.mock('@/services/crdt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/crdt')>()
  return {
    ...actual,
    hydrateAndBindEventCrdt: vi.fn(async () => ({
      handle: {
        eventId: 'evt-anim-1',
        deviceId: 'dev-1',
        clock: { now: () => Date.now() },
        store: {
          getMergeableContent: () => [{}, {}, 0],
          getTable: () => ({})
        },
        flushNow: vi.fn().mockResolvedValue(undefined)
      },
      unbind: vi.fn()
    })),
    disposeEventCrdt: vi.fn().mockResolvedValue(undefined),
    getExistingEventCrdt: vi.fn().mockReturnValue(undefined)
  }
})

vi.mock('@/services/webrtc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/webrtc')>()
  return {
    ...actual,
    createWebRtcService: vi.fn(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      isHostMode: () => false,
      getHostEpoch: () => 1,
      setEventMetadata: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      getPeerUserId: vi.fn().mockReturnValue(undefined)
    }))
  }
})

describe('TeamDetailView Live Backdrop & AI Copilot Animations', () => {
  const wrappers: VueWrapper<any>[] = []
  const track = <T extends VueWrapper<any>>(w: T): T => {
    wrappers.push(w)
    return w
  }
  const originalLocale = i18n.global.locale.value
  const origStartViewTransition = (document as any).startViewTransition

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    sessionStorage.clear()
    i18n.global.locale.value = 'en'
    document.documentElement.removeAttribute('data-direction')
    document.documentElement.removeAttribute('data-transition-type')
    document.documentElement.removeAttribute('data-to-type')
    document.documentElement.removeAttribute('data-from-type')
    document.documentElement.style.removeProperty('--ai-dock-right-offset')
    delete document.documentElement.dataset.aiDockOverlay
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })))
  })

  afterEach(() => {
    while (wrappers.length > 0) {
      wrappers.pop()!.unmount()
    }
    i18n.global.locale.value = originalLocale
    ;(document as any).startViewTransition = origStartViewTransition
    document.documentElement.removeAttribute('data-direction')
    document.documentElement.removeAttribute('data-transition-type')
    document.documentElement.removeAttribute('data-to-type')
    document.documentElement.removeAttribute('data-from-type')
    document.documentElement.style.removeProperty('--ai-dock-right-offset')
    delete document.documentElement.dataset.aiDockOverlay
    vi.unstubAllGlobals()
    localStorage.clear()
    sessionStorage.clear()
  })

  it('nests team-detail under event and skips ViewTransition for same-event detail enter/leave while preserving dashboard->event ViewTransition', async () => {
    localStorage.setItem('scoutingpro-user', JSON.stringify({ id: 'u-1', username: 'alice', token: 'tok-1' }))

    const resolved = router.resolve('/event/evt-1/team/27570')
    expect(resolved.name).toBe('team-detail')
    expect(resolved.matched.map(m => m.name)).toEqual(['event', 'team-detail'])

    const startVtSpy = vi.fn((cb: () => Promise<void> | void) => {
      const done = Promise.resolve(cb())
      return {
        ready: done,
        updateCallbackDone: done,
        finished: done,
        skipTransition: vi.fn()
      }
    })
    ;(document as any).startViewTransition = startVtSpy

    await router.push('/dashboard')
    await router.isReady()
    await new Promise(r => setTimeout(r, 30))
    await flushPromises()
    startVtSpy.mockClear()

    // Cross-page navigation dashboard -> event SHOULD trigger ViewTransition
    await router.push('/event/evt-1')
    await new Promise(r => setTimeout(r, 30))
    await flushPromises()
    expect(startVtSpy).toHaveBeenCalledTimes(1)
    expect(document.documentElement.hasAttribute('data-to-type')).toBe(false)

    // Same-event navigation event -> team-detail MUST NOT trigger ViewTransition
    startVtSpy.mockClear()
    await router.push('/event/evt-1/team/27570')
    await flushPromises()
    expect(startVtSpy).not.toHaveBeenCalled()
    expect(document.documentElement.hasAttribute('data-to-type')).toBe(false)
    expect(document.documentElement.hasAttribute('data-direction')).toBe(false)

    // Same-event navigation team-detail -> event MUST NOT trigger ViewTransition
    await router.push('/event/evt-1')
    await flushPromises()
    expect(startVtSpy).not.toHaveBeenCalled()
    expect(document.documentElement.hasAttribute('data-from-type')).toBe(false)
  })

  it('keeps EventView mounted and toggles .is-detail-open when entering and exiting TeamDetailView', async () => {
    localStorage.setItem('scoutingpro-user', JSON.stringify({ id: 'u-1', username: 'alice', token: 'tok-1' }))
    const userStore = useUserStore()
    userStore.$patch({ user: { id: 'u-1', username: 'alice', token: 'tok-1' } })
    const eventStore = useEventStore()
    eventStore.$patch({
      events: [{ id: 'evt-anim-1', name: 'Anim Event', inviteCode: 'ANIM01', hostId: 'u-1' }],
      currentEvent: { id: 'evt-anim-1', name: 'Anim Event', inviteCode: 'ANIM01', hostId: 'u-1' }
    })

    const testRouter = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'login', component: { template: '<div>login</div>' } },
        {
          path: '/event/:eventId',
          name: 'event',
          component: EventView,
          props: true,
          children: [
            {
              path: 'team/:teamNumber',
              name: 'team-detail',
              component: TeamDetailView,
              props: true
            }
          ]
        }
      ]
    })

    await testRouter.push('/event/evt-anim-1')
    await testRouter.isReady()

    const appWrapper = track(
      mount(App, {
        global: {
          plugins: [testRouter, i18n]
        }
      })
    )
    await flushPromises()

    const eventEl = appWrapper.find('.event-view').element
    const shell = appWrapper.find('.event-stage-shell')
    expect(shell.exists()).toBe(true)
    expect(shell.classes()).not.toContain('is-detail-open')
    expect(appWrapper.find('.team-detail-backdrop').exists()).toBe(false)

    // Navigate into TeamDetailView: EventView stays mounted, shell gets .is-detail-open, sheet renders inside backdrop
    await testRouter.push('/event/evt-anim-1/team/27570')
    await flushPromises()
    await nextTick()

    expect(appWrapper.find('.event-view').element).toBe(eventEl)
    expect(appWrapper.find('.event-stage-shell').classes()).toContain('is-detail-open')
    expect(appWrapper.find('.event-stage-shell').attributes('aria-hidden')).toBe('true')
    expect(appWrapper.find('.team-detail-backdrop').exists()).toBe(true)
    expect(appWrapper.find('.team-detail-view').exists()).toBe(true)

    // Close TeamDetailView via close button: returns to /event/evt-anim-1 and removes .is-detail-open
    await appWrapper.find('.team-detail-view .btn-close').trigger('click')
    await flushPromises()
    await nextTick()

    expect(testRouter.currentRoute.value.name).toBe('event')
    expect(appWrapper.find('.event-view').element).toBe(eventEl)
    expect(appWrapper.find('.event-stage-shell').classes()).not.toContain('is-detail-open')
  })

  it('animates AiCopilotDock open/close (slide) and expand/collapse (inflate/shrink) with wide & narrow desktop modes', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 })

    const aiStore = useAiStore()
    aiStore.setDockOpen(false)
    aiStore.setDockExpanded(false)

    const wrapper = track(
      mount(AiCopilotDock, {
        props: { eventId: 'evt-dock-1' },
        global: {
          plugins: [i18n],
          stubs: {
            AiCopilotWorkspace: { template: '<div class="stub-workspace" />' }
          }
        }
      })
    )

    // Closed: spacer exists on wide desktop without .is-open, dock and backdrop hidden, right offset 0px
    expect(wrapper.find('.ai-dock-spacer').exists()).toBe(true)
    expect(wrapper.find('.ai-dock-spacer').classes()).not.toContain('is-open')
    expect(wrapper.find('.ai-copilot-dock').exists()).toBe(false)
    expect(wrapper.find('.dock-overlay-backdrop').exists()).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--ai-dock-right-offset')).toBe('0px')

    // Open on wide desktop: dock slides in, spacer opens, no backdrop, right offset = dockWidth
    aiStore.setDockOpen(true)
    await nextTick()

    expect(wrapper.find('.ai-dock-spacer').classes()).toContain('is-open')
    expect(wrapper.find('.ai-copilot-dock').exists()).toBe(true)
    expect(wrapper.find('.ai-copilot-dock').classes()).not.toContain('is-expanded')
    expect(wrapper.find('.ai-copilot-dock').classes()).not.toContain('is-narrow-overlay')
    expect(wrapper.find('.dock-overlay-backdrop').exists()).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--ai-dock-right-offset')).toBe(`${DEFAULT_DOCK_WIDTH}px`)

    // Splitter drag toggles .is-dragging on both spacer and dock, then clears on pointerup
    const splitter = wrapper.find('.dock-splitter')
    expect(splitter.exists()).toBe(true)
    await splitter.trigger('pointerdown', { clientX: 1000 })
    expect(wrapper.find('.ai-dock-spacer').classes()).toContain('is-dragging')
    expect(wrapper.find('.ai-copilot-dock').classes()).toContain('is-dragging')
    window.dispatchEvent(new Event('pointerup'))
    await nextTick()
    expect(wrapper.find('.ai-dock-spacer').classes()).not.toContain('is-dragging')
    expect(wrapper.find('.ai-copilot-dock').classes()).not.toContain('is-dragging')

    // Expand (inflate): .is-expanded + backdrop appear while spacer remains open so background stage stays steady
    aiStore.setDockExpanded(true)
    await nextTick()

    expect(wrapper.find('.ai-copilot-dock').classes()).toContain('is-expanded')
    expect(wrapper.find('.dock-overlay-backdrop').exists()).toBe(true)
    expect(wrapper.find('.ai-dock-spacer').classes()).toContain('is-open')
    expect(document.documentElement.dataset.aiDockOverlay).toBe('true')
    expect(document.documentElement.style.getPropertyValue('--ai-dock-right-offset')).toBe('0px')

    // Collapse (shrink): clicking backdrop shrinks dock back to side panel
    await wrapper.find('.dock-overlay-backdrop').trigger('click')
    await nextTick()

    expect(aiStore.isDockExpanded).toBe(false)
    expect(wrapper.find('.ai-copilot-dock').classes()).not.toContain('is-expanded')
    expect(wrapper.find('.dock-overlay-backdrop').exists()).toBe(false)
    expect(document.documentElement.dataset.aiDockOverlay).toBeUndefined()

    // Narrow desktop (960px): overlay drawer mode without wide spacer
    window.innerWidth = 960
    window.dispatchEvent(new Event('resize'))
    await nextTick()

    expect(wrapper.find('.ai-dock-spacer').exists()).toBe(false)
    expect(wrapper.find('.ai-copilot-dock').classes()).toContain('is-narrow-overlay')
    expect(wrapper.find('.dock-overlay-backdrop').exists()).toBe(true)
    expect(document.documentElement.dataset.aiDockOverlay).toBe('true')

    // Closing dock via backdrop hides dock & clears overlay attr
    await wrapper.find('.dock-overlay-backdrop').trigger('click')
    await nextTick()
    expect(aiStore.isDockOpen).toBe(false)
    expect(wrapper.find('.ai-copilot-dock').exists()).toBe(false)
    expect(document.documentElement.dataset.aiDockOverlay).toBeUndefined()
  })

  it('toggles AiThreadSidebar inside AiCopilotWorkspace and switches AiVoiceCallOverlay between full stage and mini bar', async () => {
    const aiStore = useAiStore()
    aiStore.threadSidebarOpen = false

    const wsWrapper = track(
      mount(AiCopilotWorkspace, {
        props: { eventId: 'evt-ws-1', mode: 'dock' },
        global: {
          plugins: [i18n]
        }
      })
    )
    await flushPromises()

    expect(wsWrapper.find('.thread-sidebar').exists()).toBe(false)
    const toggleBtn = wsWrapper.find('.hdr-icon-btn')
    await toggleBtn.trigger('click')
    await nextTick()
    expect(aiStore.threadSidebarOpen).toBe(true)
    expect(wsWrapper.find('.thread-sidebar').exists()).toBe(true)

    const capability = resolveVoiceCapability({
      id: 'p-gem',
      name: 'Gemini',
      presetId: 'gemini',
      protocol: 'GEMINI',
      apiKeyEncrypted: '****',
      hasApiKey: true,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      modelName: 'gemini-flash-latest',
      customModels: [],
      systemPrompt: '',
      temperature: 0.4,
      maxTokens: 4096,
      enableThinking: false,
      thinkingBudget: 0,
      anthropicVersion: '2023-06-01',
      maxContextMsgs: 16,
      proxyHost: '',
      proxyPort: null,
      isActive: true
    })

    const voiceWrapper = track(
      mount(AiVoiceCallOverlay, {
        props: {
          isActive: true,
          isMinimized: false,
          status: 'listening',
          engine: capability.engine,
          capability,
          isNativeLive: true,
          inputMode: 'vad',
          isMuted: false,
          isPttHolding: false,
          inputLevel: 0,
          outputLevel: 0,
          elapsedSeconds: 12,
          selectedModel: capability.defaultModel,
          selectedVoice: capability.voices[0]!.id,
          sttHelperProfileId: '',
          sttHelpers: [],
          activeSttProfile: null,
          autoSpeakTurnVoice: false,
          forceOpenAiRealtime: false,
          canUseBrowserSpeechRec: false,
          liveUserTranscript: '',
          liveAssistantTranscript: '',
          lastCompletedTurn: null,
          errorMessage: null,
          goAwayWarning: null
        },
        global: {
          plugins: [i18n]
        }
      })
    )

    expect(voiceWrapper.find('.voice-stage-overlay').exists()).toBe(true)
    expect(voiceWrapper.find('.voice-mini-bar').exists()).toBe(false)

    await voiceWrapper.setProps({ isMinimized: true })
    await nextTick()
    expect(voiceWrapper.find('.voice-stage-overlay').exists()).toBe(false)
    expect(voiceWrapper.find('.voice-mini-bar').exists()).toBe(true)

    await voiceWrapper.setProps({ isActive: false })
    await nextTick()
    expect(voiceWrapper.find('.voice-stage-overlay').exists()).toBe(false)
    expect(voiceWrapper.find('.voice-mini-bar').exists()).toBe(false)
  })
})
