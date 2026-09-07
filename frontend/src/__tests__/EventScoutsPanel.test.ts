import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import EventScoutsPanel from '../components/scouting/EventScoutsPanel.vue'
import { useConnectionStore } from '../stores/connection'
import { useRecordStore } from '../stores/records'
import * as api from '../services/api'
import type { ScoutingRecord } from '../types'

vi.mock('../services/api', async () => {
  const actual = await vi.importActual('../services/api')
  return {
    ...actual,
    fetchEventMembers: vi.fn(),
    updateEventFtcConfig: vi.fn()
  }
})

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({
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
})
