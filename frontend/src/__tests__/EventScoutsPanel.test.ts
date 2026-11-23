import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import EventScoutsPanel from '../components/scouting/EventScoutsPanel.vue'
import SendMessageModal from '../components/scouting/SendMessageModal.vue'
import { useConnectionStore } from '../stores/connection'
import { useRecordStore } from '../stores/records'
import { useEventStore } from '../stores/events'
import { useUserStore } from '../stores/user'
import { useToastStore } from '../stores/toast'
import { useConfirm } from '../composables/useConfirm'
import * as api from '../services/api'
import { downloadCSV } from '../utils/csvExport'
import type { ScoutingRecord, ScoutingEvent } from '../types'

vi.mock('../utils/csvExport', () => ({
  downloadCSV: vi.fn()
}))

vi.mock('../services/api', async () => {
  const actual = await vi.importActual('../services/api')
  return {
    ...actual,
    fetchEventMembers: vi.fn(),
    updateEventFtcConfig: vi.fn(),
    updateEventTurnConfig: vi.fn(),
    removeEventMember: vi.fn()
  }
})

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({
      locale: { value: 'en' },
      t: (key: string, values?: any) => {
        const dict: Record<string, string> = {
          'event.tab_scouts': 'Scouts & Settings',
          'event.scouts_title': 'Scouts',
          'event.scouts_refresh': 'Refresh List',
          'event.scouts_records_count': `Records: ${values?.count ?? 0}`,
          'event.send_message': 'Send Message',
          'event.status_online': 'Online',
          'event.status_offline': 'Offline',
          'event.role_host': 'Host',
          'connection.transport_ipv6': 'IPv6 Direct',
          'connection.transport_lan': 'LAN Direct',
          'connection.transport_nat': 'IPv4 Hole-punch',
          'connection.transport_virtual_tunnel': 'ECDH Tunnel (TLS)',
          'connection.transport_relay': 'TURN Relay',
          'connection.transport_unknown': 'P2P',
          'connection.transport_tooltip_ipv6': 'IPv6 direct tooltip',
          'connection.transport_tooltip_lan': 'LAN direct tooltip',
          'connection.transport_tooltip_nat': 'IPv4 NAT tooltip',
          'connection.transport_tooltip_virtual_tunnel': 'ECDH virtual tunnel tooltip',
          'connection.transport_tooltip_relay': 'TURN relay tooltip'
        }
        return dict[key] || key
      }
    })
  }
})

describe('EventScoutsPanel.vue', () => {
  const wrappers: VueWrapper<any>[] = []
  const track = <T extends VueWrapper<any>>(w: T): T => {
    wrappers.push(w)
    return w
  }

  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  afterEach(() => {
    while (wrappers.length) wrappers.pop()!.unmount()
    document.body.innerHTML = ''
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('fetches event members and renders new users immediately even with 0 records', async () => {
    const mockMembers = [
      { id: 'u_alice', username: 'Alice', host: true },
      { id: 'u_bob', username: 'Bob', host: false }
    ]
    vi.mocked(api.fetchEventMembers).mockResolvedValue(mockMembers)

    const wrapper = track(mount(EventScoutsPanel, {
      props: {
        event: {
          id: 'event-test-1',
          name: 'Test Regional',
          inviteCode: 'TEST01',
          creatorId: 'u_alice',
          createdAt: '',
          updatedAt: ''
        }
      }
    }))

    await flushPromises()

    expect(api.fetchEventMembers).toHaveBeenCalledWith('event-test-1')
    const scoutItems = wrapper.findAll('.scout-item')
    expect(scoutItems).toHaveLength(2)

    // Alice is host
    expect(wrapper.text()).toContain('Alice')
    expect(wrapper.text()).toContain('Host')
    expect(wrapper.text()).toContain('Records: 0')

    // Bob has just joined and has 0 records
    expect(wrapper.text()).toContain('Bob')
  })

  it('aggregates WebRTC online state and tally records accurately', async () => {
    const mockMembers = [
      { id: 'u_alice', username: 'Alice', host: true },
      { id: 'u_charlie', username: 'Charlie', host: false }
    ]
    vi.mocked(api.fetchEventMembers).mockResolvedValue(mockMembers)

    const connStore = useConnectionStore()
    const recordStore = useRecordStore()

    // Charlie connects via WebRTC
    connStore.addConnectedScout('u_charlie', 'Charlie')

    // Charlie has submitted 2 records
    recordStore.records = [
      {
        id: 'r1',
        eventId: 'event-test-1',
        scoutId: 'u_charlie',
        scoutName: 'Charlie',
        matchNumber: 1,
        teamNumber: 1001,
        autoScore: 10,
        teleopScore: 20,
        endgameScore: 5,
        totalScore: 35,
        syncStatus: 'SYNCED',
        createdAt: '',
        updatedAt: ''
      } as ScoutingRecord,
      {
        id: 'r2',
        eventId: 'event-test-1',
        scoutId: 'u_charlie',
        scoutName: 'Charlie',
        matchNumber: 2,
        teamNumber: 1002,
        autoScore: 15,
        teleopScore: 25,
        endgameScore: 10,
        totalScore: 50,
        syncStatus: 'SYNCED',
        createdAt: '',
        updatedAt: ''
      } as ScoutingRecord
    ]

    const wrapper = track(mount(EventScoutsPanel, {
      props: {
        event: {
          id: 'event-test-1',
          name: 'Test Regional',
          inviteCode: 'TEST01',
          creatorId: 'u_alice',
          createdAt: '',
          updatedAt: ''
        }
      }
    }))

    await flushPromises()

    expect(wrapper.text()).toContain('Records: 2')
    const charlieDot = wrapper.find('.dot-online')
    expect(charlieDot.exists()).toBe(true)
  })

  it('opens custom SendMessageModal when clicking send message button', async () => {
    const mockMembers = [
      { id: 'u_alice', username: 'Alice', host: true },
      { id: 'u_bob', username: 'Bob', host: false }
    ]
    vi.mocked(api.fetchEventMembers).mockResolvedValue(mockMembers)

    const wrapper = track(mount(EventScoutsPanel, {
      props: {
        event: {
          id: 'event-test-1',
          name: 'Test Regional',
          inviteCode: 'TEST01',
          creatorId: 'u_alice',
          createdAt: '',
          updatedAt: ''
        }
      }
    }))

    await flushPromises()

    // Find the Send Message button for Bob (second scout item)
    const scoutItems = wrapper.findAll('.scout-item')
    const bobItem = scoutItems[1]
    const msgBtn = bobItem.find('.btn-msg')
    expect(msgBtn.exists()).toBe(true)

    // Initially SendMessageModal is not visible
    const modalComponent = wrapper.findComponent(SendMessageModal)
    expect(modalComponent.exists()).toBe(true)
    expect(modalComponent.props('visible')).toBe(false)

    // Click Send Message button
    await msgBtn.trigger('click')
    await flushPromises()

    // Modal is now open and targeted at Bob
    expect(modalComponent.props('visible')).toBe(true)
    expect(modalComponent.props('targetScoutId')).toBe('u_bob')
    expect(modalComponent.props('targetScoutName')).toBe('Bob')
  })

  it('triggers custom ConfirmModal instead of native window.confirm when removing a member', async () => {
    const mockMembers = [
      { id: 'u_alice', username: 'Alice', host: true },
      { id: 'u_bob', username: 'Bob', host: false }
    ]
    vi.mocked(api.fetchEventMembers).mockResolvedValue(mockMembers)
    vi.mocked(api.removeEventMember).mockResolvedValue({ success: true } as any)

    const eventStore = useEventStore()
    const connStore = useConnectionStore()
    connStore.rtcService = { isHostMode: () => true } as any

    // Alice is current host
    eventStore.currentEvent = {
      id: 'event-test-1',
      name: 'Test Regional',
      inviteCode: 'TEST01',
      creatorId: 'u_alice',
      createdAt: '',
      updatedAt: ''
    }

    const { confirmState, handleConfirm } = useConfirm()
    expect(confirmState.value).toBeNull()

    const wrapper = track(mount(EventScoutsPanel, {
      props: {
        event: eventStore.currentEvent
      }
    }))

    await flushPromises()

    // Bob item has remove button for host
    const scoutItems = wrapper.findAll('.scout-item')
    const bobItem = scoutItems[1]
    const removeBtn = bobItem.find('.btn-remove-scout')
    expect(removeBtn.exists()).toBe(true)

    // Trigger remove
    await removeBtn.trigger('click')

    // Verify custom confirmState was opened with danger type
    expect(confirmState.value).toBeTruthy()
    expect(confirmState.value?.isOpen).toBe(true)
    expect(confirmState.value?.type).toBe('danger')

    // Confirm the action
    handleConfirm()
    await flushPromises()

    // Verify member removal API was called
    expect(api.removeEventMember).toHaveBeenCalledWith('event-test-1', 'u_bob')
  })

  it('exports BIOBUZZ Endgame and Predict Cycle Time columns in Rankings and Records CSV', async () => {
    vi.mocked(api.fetchEventMembers).mockResolvedValue([])
    const recordStore = useRecordStore()
    const baseMs = 1_700_000_000_000
    const ts = [0, 5, 7, 9, 11, 13].reduce<number[]>((acc, g, idx) => {
      acc.push(idx === 0 ? baseMs : acc[idx - 1]! + g * 1000)
      return acc
    }, [])

    recordStore.records = [
      {
        id: 'rec_csv_1',
        eventId: 'event-test-1',
        scoutId: 'u_alice',
        scoutName: 'Alice',
        matchNumber: 1,
        teamNumber: 27570,
        autoScore: 20,
        teleopScore: 24,
        endgameScore: 27,
        totalScore: 71,
        rawData: JSON.stringify({
          autoLeave: true,
          teleopPark: true,
          flowerNectars: 4,
          flowerBottomBonusCount: 2,
          flowerPollens: 2,
          gardenBalls: 0,
          flowerDescore: true,
          g410EarlyFlowerFoul: false,
          teleopCycles: [2, 2, 2, 2, 2, 2],
          teleopCycleTimestamps: ts
        }),
        syncStatus: 'SYNCED',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1
      }
    ]
    recordStore.currentEventId = 'event-test-1'

    const wrapper = track(mount(EventScoutsPanel, {
      props: {
        event: {
          id: 'event-test-1',
          name: 'Test Regional',
          inviteCode: 'TEST01',
          creatorId: 'u_alice',
          createdAt: '',
          updatedAt: ''
        }
      }
    }))

    await flushPromises()

    const btns = wrapper.findAll('button')
    const exportRankingsBtn = btns.find(b => b.text().includes('event.export_rankings'))
    const exportRecordsBtn = btns.find(b => b.text().includes('event.export_records'))
    expect(exportRankingsBtn).toBeDefined()
    expect(exportRecordsBtn).toBeDefined()

    await exportRankingsBtn!.trigger('click')
    await exportRecordsBtn!.trigger('click')

    expect(vi.mocked(downloadCSV)).toHaveBeenCalledTimes(2)
    const [rankFile, rankHeaders, rankRows] = vi.mocked(downloadCSV).mock.calls[0]!
    expect(rankFile).toContain('rankings')
    expect(rankHeaders).toContain('Predict Cycle Time (s)')
    expect(rankHeaders).toContain('Avg Nectars')
    expect(rankHeaders).toContain('TeleOp Park (%)')
    expect(rankRows[0]).toContain(10) // Predict Cycle Time 10.0s

    const [recFile, recHeaders, recRows] = vi.mocked(downloadCSV).mock.calls[1]!
    expect(recFile).toContain('records')
    expect(recHeaders).toContain('Flower Nectars')
    expect(recHeaders).toContain('Predict Cycle (s)')
    expect(recRows[0]).toContain(10)
    expect(recRows[0]).toContain('Yes')
  })

  it('displays live connection mode and latency pill for active online scouts and updates reactively', async () => {
    const mockMembers = [
      { id: 'u_alice', username: 'Alice', host: true },
      { id: 'u_bob', username: 'Bob', host: false },
      { id: 'u_offline', username: 'OfflineScout', host: false }
    ]
    vi.mocked(api.fetchEventMembers).mockResolvedValue(mockMembers)

    const connStore = useConnectionStore()
    connStore.addConnectedScout('u_bob', 'Bob', {
      type: 'ipv6_p2p',
      localCandidateType: 'host',
      remoteCandidateType: 'host',
      localAddress: '2409:8a00::1',
      remoteAddress: '2409:8900::2',
      protocol: 'UDP',
      rttMs: 19
    })

    const wrapper = track(mount(EventScoutsPanel, {
      props: {
        event: {
          id: 'event-test-1',
          name: 'Test Regional',
          inviteCode: 'TEST01',
          creatorId: 'u_alice',
          createdAt: '',
          updatedAt: ''
        }
      }
    }))

    await flushPromises()

    const scoutItems = wrapper.findAll('.scout-item')
    expect(scoutItems).toHaveLength(3)

    // Host (Alice) and offline user do not render scout transport pill
    expect(scoutItems[0]!.find('.scout-transport-pill').exists()).toBe(false)
    expect(scoutItems[2]!.find('.scout-transport-pill').exists()).toBe(false)

    // Active online scout (Bob) renders connection mode + latency pill
    const bobPill = scoutItems[1]!.find('.scout-transport-pill')
    expect(bobPill.exists()).toBe(true)
    expect(bobPill.classes()).toContain('ipv6_p2p')
    expect(bobPill.text()).toContain('IPv6 Direct')
    expect(bobPill.text()).toContain('19ms')

    // Reactive update when transport switches to zero-quota ECDH Tunnel (TLS)
    connStore.setScoutTransportInfo('u_bob', {
      type: 'relay',
      label: 'ECDH Tunnel (TLS)',
      isVirtualTunnel: true,
      localCandidateType: 'virtual',
      remoteCandidateType: 'virtual',
      localAddress: 'virtual-e2ee',
      remoteAddress: 'wss-broker:8084',
      protocol: 'wss/tls',
      rttMs: 45
    })
    await flushPromises()

    const updatedPill = wrapper.findAll('.scout-item')[1]!.find('.scout-transport-pill')
    expect(updatedPill.classes()).toContain('virtual-tunnel')
    expect(updatedPill.text()).toContain('ECDH Tunnel (TLS)')
    expect(updatedPill.text()).toContain('45ms')
  })

  it('renders Custom TURN configuration panel only for Host and hides it for non-host Scouts', async () => {
    vi.mocked(api.fetchEventMembers).mockResolvedValue([])
    const userStore = useUserStore()
    const eventStore = useEventStore()

    const baseEvent: ScoutingEvent = {
      id: 'event-turn-1',
      name: 'Turn Event',
      inviteCode: 'TURN01',
      hostId: 'u_host',
      creatorId: 'u_host',
      createdAt: '',
      updatedAt: ''
    }

    // Non-host scout
    userStore.user = { id: 'u_scout', username: 'Scout' } as any
    eventStore.setCurrentEvent(baseEvent)
    expect(eventStore.isHost).toBe(false)

    const scoutWrapper = track(mount(EventScoutsPanel, {
      props: { event: baseEvent }
    }))
    await flushPromises()
    expect(scoutWrapper.find('.event-scouts-panel').exists()).toBe(true)
    expect(scoutWrapper.find('.settings-panel').exists()).toBe(true)
    expect(scoutWrapper.find('[data-testid="custom-turn-panel"]').exists()).toBe(false)

    // Host
    userStore.user = { id: 'u_host', username: 'Host' } as any
    expect(eventStore.isHost).toBe(true)

    const hostWrapper = track(mount(EventScoutsPanel, {
      props: { event: baseEvent }
    }))
    await flushPromises()
    expect(hostWrapper.find('[data-testid="custom-turn-panel"]').exists()).toBe(true)
    expect(hostWrapper.find('[data-testid="turn-status-banner"]').text()).toContain('event.turn_status_default')
  })

  it('saves valid custom TURN config, updates eventStore, broadcasts EVENT_METADATA, and updates status banner', async () => {
    vi.mocked(api.fetchEventMembers).mockResolvedValue([])
    const savedConfig = {
      urls: ['turn:team.turn.example:3478', 'turns:team.turn.example:5349?transport=tcp'],
      username: 'team27570',
      credential: 'secret-password'
    }
    vi.mocked(api.updateEventTurnConfig).mockResolvedValue({
      hasCustomTurn: true,
      customTurnConfig: savedConfig
    })

    const userStore = useUserStore()
    const eventStore = useEventStore()
    const connStore = useConnectionStore()
    const setEventMetadata = vi.fn()
    const sendMessage = vi.fn()
    connStore.setRtcService({
      isHostMode: () => true,
      setEventMetadata,
      sendMessage
    } as any)

    const evt: ScoutingEvent = {
      id: 'event-turn-2',
      name: 'Turn Event 2',
      inviteCode: 'TURN02',
      hostId: 'u_host',
      creatorId: 'u_host',
      createdAt: '',
      updatedAt: ''
    }
    userStore.user = { id: 'u_host', username: 'Host' } as any
    eventStore.setCurrentEvent(evt)
    eventStore.events = [evt]

    const wrapper = track(mount(EventScoutsPanel, {
      props: { event: eventStore.currentEvent }
    }))
    await flushPromises()

    await wrapper.find('[data-testid="turn-urls-input"]').setValue(
      'turn:team.turn.example:3478\nturns:team.turn.example:5349?transport=tcp'
    )
    await wrapper.find('[data-testid="turn-username-input"]').setValue('team27570')
    await wrapper.find('[data-testid="turn-credential-input"]').setValue('secret-password')

    await wrapper.find('[data-testid="turn-save-btn"]').trigger('click')
    await flushPromises()

    expect(api.updateEventTurnConfig).toHaveBeenCalledWith('event-turn-2', savedConfig)
    expect(eventStore.currentEvent?.hasCustomTurn).toBe(true)
    expect(eventStore.currentEvent?.customTurnConfig).toEqual(savedConfig)
    expect(setEventMetadata).toHaveBeenCalledWith(eventStore.currentEvent)
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'EVENT_METADATA',
      event: eventStore.currentEvent
    })

    await wrapper.setProps({ event: eventStore.currentEvent })
    await flushPromises()
    expect(wrapper.find('[data-testid="turn-status-banner"]').text()).toContain('event.turn_status_custom')
  })

  it('resets custom TURN config to default fallback', async () => {
    vi.mocked(api.fetchEventMembers).mockResolvedValue([])
    vi.mocked(api.updateEventTurnConfig).mockResolvedValue({
      hasCustomTurn: false,
      customTurnConfig: null
    })

    const userStore = useUserStore()
    const eventStore = useEventStore()
    const evt: ScoutingEvent = {
      id: 'event-turn-3',
      name: 'Turn Event 3',
      inviteCode: 'TURN03',
      hostId: 'u_host',
      creatorId: 'u_host',
      hasCustomTurn: true,
      customTurnConfig: {
        urls: ['turn:team.turn.example:3478'],
        username: 'team27570',
        credential: 'secret-password'
      },
      createdAt: '',
      updatedAt: ''
    }
    userStore.user = { id: 'u_host', username: 'Host' } as any
    eventStore.setCurrentEvent(evt)
    eventStore.events = [evt]

    const wrapper = track(mount(EventScoutsPanel, {
      props: { event: eventStore.currentEvent }
    }))
    await flushPromises()

    expect(wrapper.find('[data-testid="turn-status-banner"]').text()).toContain('event.turn_status_custom')

    await wrapper.find('[data-testid="turn-reset-btn"]').trigger('click')
    await flushPromises()

    expect(api.updateEventTurnConfig).toHaveBeenCalledWith('event-turn-3', null)
    expect(eventStore.currentEvent?.hasCustomTurn).toBe(false)
    expect(eventStore.currentEvent?.customTurnConfig).toBeNull()

    await wrapper.setProps({ event: eventStore.currentEvent })
    await flushPromises()
    expect(wrapper.find('[data-testid="turn-status-banner"]').text()).toContain('event.turn_status_default')
  })

  it('shows error toast and does not call updateEventTurnConfig when TURN URL is invalid', async () => {
    vi.mocked(api.fetchEventMembers).mockResolvedValue([])
    const userStore = useUserStore()
    const eventStore = useEventStore()
    const toastStore = useToastStore()

    const evt: ScoutingEvent = {
      id: 'event-turn-4',
      name: 'Turn Event 4',
      inviteCode: 'TURN04',
      hostId: 'u_host',
      creatorId: 'u_host',
      createdAt: '',
      updatedAt: ''
    }
    userStore.user = { id: 'u_host', username: 'Host' } as any
    eventStore.setCurrentEvent(evt)

    const wrapper = track(mount(EventScoutsPanel, {
      props: { event: evt }
    }))
    await flushPromises()

    await wrapper.find('[data-testid="turn-urls-input"]').setValue('https://not-a-turn-url.example.com')
    await wrapper.find('[data-testid="turn-username-input"]').setValue('team27570')
    await wrapper.find('[data-testid="turn-credential-input"]').setValue('secret-password')

    await wrapper.find('[data-testid="turn-save-btn"]').trigger('click')
    await flushPromises()

    expect(api.updateEventTurnConfig).not.toHaveBeenCalled()
    expect(toastStore.toasts.some(t => t.type === 'error' && t.message === 'event.turn_invalid_url')).toBe(true)
  })
})
