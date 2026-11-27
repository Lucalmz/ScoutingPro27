import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en.json'
import zh from '@/locales/zh.json'
import { useUserStore } from '@/stores/user'
import { useEventStore } from '@/stores/events'
import { useNavigationStore } from '@/stores/navigation'
import { useAiStore } from '@/stores/ai'
import { handleChannelIdentityAndTakeoverMessage } from '@/services/webrtc/channelIdentityHandler'
import DynamicFieldsRenderer from '@/components/customFields/DynamicFieldsRenderer.vue'
import CustomFieldBuilderForm from '@/components/customFields/CustomFieldBuilderForm.vue'
import { useEventTransitions } from '@/views/useEventTransitions'
import type { CustomFieldDefinition } from '@/types'

function makeI18n() {
  return createI18n({ legacy: false, locale: 'en', messages: { en, zh } })
}

describe('Audit Fixes & Uncovered Module Tests (#4, #5, #15, #24)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('#4: preserves immutable userId & token on static cloud host rename', async () => {
    vi.resetModules()
    const { useUserStore: useIsolatedUserStore } = await import('@/stores/user')
    const userStore = useIsolatedUserStore()
    userStore.$patch({
      user: { id: 'det-user-fixed-1', username: 'Alice', token: 'jwt-fixed-1' }
    })
    localStorage.setItem('scoutingpro-user', JSON.stringify(userStore.user))

    // Simulate static host 404 HTML response -> handleStaticHostFallback
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<!doctype html><html><body>404</body></html>', {
          status: 404,
          headers: { 'Content-Type': 'text/html' }
        })
      )
    )

    const res = await userStore.rename({ newUsername: 'AliceRenamed' })
    expect(res.success).toBe(true)
    expect(res.oldId).toBe('det-user-fixed-1')
    expect(res.newId).toBe('det-user-fixed-1')
    expect(userStore.userId).toBe('det-user-fixed-1')
    expect(userStore.token).toBe('jwt-fixed-1')
    expect(userStore.username).toBe('AliceRenamed')
    vi.resetModules()
  })

  it('#5: channelIdentityHandler preserves leading/trailing whitespace in targetPassword during MERGE_ACCOUNT_REQUEST', async () => {
    const sentMessages: Array<{ msg: any; target?: string }> = []
    let capturedLoginBody: any = null

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/api/user/login')) {
          capturedLoginBody = JSON.parse(String(init?.body || '{}'))
          return new Response(
            JSON.stringify({ id: 'target-id-1', username: 'SpaceUser', token: 'target-jwt' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        return new Response('{}', { status: 200 })
      })
    )

    const ctx: any = {
      isHostMode: () => true,
      currentInviteCode: () => 'INV123',
      getCurrentEventId: () => 'evt-1',
      callbacks: {
        onIdentityMigration: vi.fn().mockResolvedValue(undefined)
      },
      scoutIdToClientIds: new Map<string, Set<string>>(),
      clientIdToScoutId: new Map<string, string>(),
      clientIdToScoutName: new Map<string, string>(),
      clients: new Map(),
      takeoverCooldowns: new Map(),
      pendingTakeovers: new Map(),
      promoteTakeover: vi.fn(),
      sendMessage: (msg: any, target?: string) => {
        sentMessages.push({ msg, target })
      }
    }

    const handled = await handleChannelIdentityAndTakeoverMessage(
      ctx,
      new Set(),
      {
        type: 'MERGE_ACCOUNT_REQUEST',
        requestId: 'req-ws-1',
        targetUsername: '  SpaceUser  ',
        targetPassword: '  my secret pass  ',
        sourceUserId: 'src-1',
        sourceUsername: 'TempScout'
      },
      'peer-client-1'
    )

    expect(handled).toBe(true)
    expect(capturedLoginBody).toEqual({
      username: 'SpaceUser',
      password: '  my secret pass  '
    })
    expect(sentMessages[0]?.msg).toMatchObject({
      type: 'MERGE_ACCOUNT_RESPONSE',
      requestId: 'req-ws-1',
      success: true,
      newId: 'target-id-1'
    })
  })

  it('#15: DynamicFieldsRenderer clamps empty number input to maxVal when maxVal < 0 and CustomFieldBuilderForm emits null instead of empty string', async () => {
    const negMaxField: CustomFieldDefinition = {
      id: 'cf-neg',
      eventId: 'evt-1',
      target: 'MATCH',
      phase: 'overall',
      name: 'Penalty Delta',
      fieldKey: 'pen_delta',
      fieldType: 'number',
      required: false,
      minVal: null,
      maxVal: -5,
      stepVal: 1,
      configJson: JSON.stringify({ inputMode: 'direct' }),
      orderSeq: 1,
      isActive: true
    }

    const model = ref<Record<string, any>>({ pen_delta: -10 })
    const renderer = mount(DynamicFieldsRenderer, {
      props: {
        definitions: [negMaxField],
        modelValue: model.value,
        'onUpdate:modelValue': (v: Record<string, any>) => {
          model.value = v
        }
      },
      global: { plugins: [makeI18n()] }
    })

    const numInput = renderer.find('input.direct-number-input')
    expect(numInput.exists()).toBe(true)
    await numInput.setValue('')
    await numInput.trigger('change')
    expect(model.value.pen_delta).toBe(-5)
    renderer.unmount()

    const form = mount(CustomFieldBuilderForm, {
      props: {
        eventId: 'evt-1',
        activeTab: 'MATCH',
        editingField: null,
        isSaving: false,
        existingFields: []
      },
      global: { plugins: [makeI18n()] }
    })

    await form.find('input[type="text"]').setValue('Score Delta')
    // Clear number min/max inputs by simulating empty string emitted by Vue v-model.number
    const numberInputs = form.findAll('input[type="number"]')
    expect(numberInputs.length).toBeGreaterThanOrEqual(3)
    for (const ni of numberInputs) {
      await ni.setValue('')
    }
    await form.find('.btn-save').trigger('click')

    const emitted = form.emitted('save')
    expect(emitted).toBeTruthy()
    const payload = emitted![0]![0] as Partial<CustomFieldDefinition>
    expect(payload.minVal).toBeNull()
    expect(payload.maxVal).toBeNull()
    expect(payload.stepVal).toBeNull()
    form.unmount()
  })

  it('#24: discoverRoomWitness handles blank inviteCode and absorbs epoch_witness + host_heartbeat over mocked SignalingChannel', async () => {
    const handlersRef: { current?: any } = {}
    vi.doMock('@/services/webrtc/signaling', () => ({
      SignalingChannel: class MockSignalingChannel {
        async initTopic() {}
        connect(h: any) {
          handlersRef.current = h
          h.onConnect?.()
          h.onMessage?.({
            type: 'epoch_witness',
            authoritativeEventId: '11111111-1111-4111-8111-111111111111',
            eventName: 'Discovered Regional',
            hostUserId: 'host-u-1',
            highestEpoch: 4,
            maxKnownHlcPt: 12345
          })
          h.onMessage?.({
            type: 'host_heartbeat',
            userId: 'host-u-1',
            hostEpoch: 4,
            hostSessionId: 'sess-h4',
            deviceId: 'dev-h4'
          })
        }
        async send() {}
        close() {}
      }
    }))
    vi.resetModules()
    const { discoverRoomWitness } = await import('@/services/webrtc/roomDiscovery')

    const emptyRes = await discoverRoomWitness({ inviteCode: '   ' })
    expect(emptyRes.found).toBe(false)

    const res = await discoverRoomWitness({ inviteCode: 'DISC27', timeoutMs: 200 })
    expect(res.found).toBe(true)
    expect(res.hasLiveHost).toBe(true)
    expect(res.authoritativeEventId).toBe('11111111-1111-4111-8111-111111111111')
    expect(res.highestSeenEpoch).toBe(4)
    expect(res.activeHostSessionId).toBe('sess-h4')
    expect(res.witnessMaxHlcPts).toContain(12345)
    vi.doUnmock('@/services/webrtc/signaling')
  })

  it('#24: useEventTransitions manages desktop AI dock vs mobile tab, route query sync, and navigation scroll state', () => {
    const eventStore = useEventStore()
    eventStore.$patch({
      currentEvent: { id: 'evt-tr', name: 'Event', inviteCode: 'TR01', hostId: 'u-host' }
    })
    const userStore = useUserStore()
    userStore.$patch({ user: { id: 'u-host', username: 'Host', token: 'jwt' } })

    const aiStore = useAiStore()
    const navStore = useNavigationStore()
    const replaceMock = vi.fn()
    const isMobile = ref(false)
    const eventId = ref('evt-tr')
    const contentEl = document.createElement('div')
    contentEl.scrollTop = 120
    const contentRef = ref<HTMLElement | null>(contentEl)

    const tr = useEventTransitions({
      route: { params: { eventId: 'evt-tr' }, query: { tab: 'ai' } } as any,
      router: { replace: replaceMock } as any,
      eventId,
      contentRef,
      isMobile,
      t: (k: string) => k
    })

    // Desktop initial tab 'ai' opens Copilot dock and falls back to 'rankings'
    expect(aiStore.isDockOpen).toBe(true)
    expect(tr.activeTab.value).toBe('rankings')
    expect(tr.tabs.value.some(tb => tb.key === 'scouts')).toBe(true)
    expect(tr.tabs.value.some(tb => tb.key === 'ai')).toBe(false)

    // Switch tab updates route & saves navigation position
    tr.switchTab('history')
    expect(tr.activeTab.value).toBe('history')
    expect(replaceMock).toHaveBeenCalledWith({ query: { tab: 'history' } })
    expect(navStore.getEventPosition('evt-tr')?.fromTab).toBe('history')

    tr.saveLeavePosition(27570)
    expect(navStore.getEventPosition('evt-tr')?.teamNumber).toBe(27570)
  })
})
