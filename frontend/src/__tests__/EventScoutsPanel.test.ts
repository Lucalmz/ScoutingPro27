import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import EventScoutsPanel from '../components/scouting/EventScoutsPanel.vue'
import SendMessageModal from '../components/scouting/SendMessageModal.vue'
import { useConnectionStore } from '../stores/connection'
import { useRecordStore } from '../stores/records'
import { useEventStore } from '../stores/events'
import { useConfirm } from '../composables/useConfirm'
import * as api from '../services/api'
import { downloadCSV } from '../utils/csvExport'
import type { ScoutingRecord } from '../types'

vi.mock('../utils/csvExport', () => ({
  downloadCSV: vi.fn()
}))

vi.mock('../services/api', async () => {
  const actual = await vi.importActual('../services/api')
  return {
    ...actual,
    fetchEventMembers: vi.fn(),
    updateEventFtcConfig: vi.fn(),
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
          'event.role_host': 'Host'
        }
        return dict[key] || key
      }
    })
  }
})

describe('EventScoutsPanel.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('fetches event members and renders new users immediately even with 0 records', async () => {
    const mockMembers = [
      { id: 'u_alice', username: 'Alice', host: true },
      { id: 'u_bob', username: 'Bob', host: false }
    ]
    vi.mocked(api.fetchEventMembers).mockResolvedValue(mockMembers)

    const wrapper = mount(EventScoutsPanel, {
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
    })

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

    const wrapper = mount(EventScoutsPanel, {
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
    })

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

    const wrapper = mount(EventScoutsPanel, {
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
    })

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

    const wrapper = mount(EventScoutsPanel, {
      props: {
        event: eventStore.currentEvent
      }
    })

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

    const wrapper = mount(EventScoutsPanel, {
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
    })

    await flushPromises()

    const btns = wrapper.findAll('button')
    const exportRankingsBtn = btns.find(b => b.text().includes('event.export_rankings'))!
    const exportRecordsBtn = btns.find(b => b.text().includes('event.export_records'))!

    await exportRankingsBtn.trigger('click')
    await exportRecordsBtn.trigger('click')

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
})
