import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import PitStatusIndicator from '../components/pit/PitStatusIndicator.vue'
import { usePitScoutStore } from '../stores/pitScout'
import { useRecordStore } from '../stores/records'
import type { PitScoutingRecord, ScoutingRecord } from '../types'

describe('PitStatusIndicator.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('renders unrecorded status cleanly without alarms', () => {
    const wrapper = mount(PitStatusIndicator, {
      props: {
        teamNumber: 12345,
        showLabel: true
      }
    })

    expect(wrapper.classes()).toContain('status-unrecorded')
    expect(wrapper.text()).toContain('未录入')
    expect(wrapper.find('.brag-badge').exists()).toBe(false)
  })

  it('renders recorded status and brag badge when team has record and match data', () => {
    const pitStore = usePitScoutStore()
    const recordStore = useRecordStore()

    pitStore.records = [
      {
        id: 'p1',
        eventId: 'e1',
        teamNumber: 27570,
        scoutId: 's1',
        scoutName: 'Alice',
        drivetrainType: 'mecanum',
        weightLbs: 38,
        sizingPassed: true,
        mechanismType: '',
        hangType: '',
        odometryType: '',
        claimedAutoScore: 60,
        claimedAutoPieces: 2,
        claimedAutoHangLevel: 0,
        claimedTeleopScore: 70,
        claimedTeleopCycleSec: 8,
        claimedEndgameHangLevel: 1,
        claimedEndgameTimeSec: 4,
        claimedTotalScore: 135,
        version: 1
      } as PitScoutingRecord
    ]

    recordStore.records = [
      {
        id: 'm1',
        eventId: 'e1',
        scoutId: 's1',
        matchNumber: 1,
        teamNumber: 27570,
        autoScore: 55,
        teleopScore: 65,
        endgameScore: 5,
        totalScore: 125,
        syncStatus: 'SYNCED',
        createdAt: '',
        updatedAt: ''
      } as ScoutingRecord
    ]

    const wrapper = mount(PitStatusIndicator, {
      props: {
        teamNumber: 27570,
        showLabel: true,
        showBrag: true
      }
    })

    expect(wrapper.classes()).toContain('status-recorded')
    expect(wrapper.text()).toContain('已录入')
    expect(wrapper.find('.brag-badge').exists()).toBe(true)
    expect(wrapper.find('.brag-badge').text()).toContain('1.03x')
  })

  it('emits click event when clicked', async () => {
    const wrapper = mount(PitStatusIndicator, {
      props: {
        teamNumber: 27570,
        clickable: true
      }
    })

    await wrapper.trigger('click')
    expect(wrapper.emitted('click')).toHaveLength(1)
    expect(wrapper.emitted('click')![0]).toEqual([27570])
  })
})
