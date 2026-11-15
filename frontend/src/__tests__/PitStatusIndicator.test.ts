import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import PitStatusIndicator from '../components/pit/PitStatusIndicator.vue'
import { usePitScoutStore } from '../stores/pitScout'
import { useRecordStore } from '../stores/records'
import en from '@/locales/en.json'
import zh from '@/locales/zh.json'
import type { ScoutingRecord } from '../types'

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
        ballCompatibility: 'universal',
        launcherType: '差速双飞轮',
        flowerMechanism: '垂直级联高抬升',
        hasColorSensor: true,
        odometryType: 'two_wheel',
        claimedAutoScore: 60,
        claimedTeleopCycles: 7,
        claimedTeleopScore: 70,
        claimedEndgameScore: 15,
        claimedTotalScore: 135,
        version: 1
      }
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

  it('renders localized pending label instead of 0x when matchCount > 0 and claimedTotalScore is 0', () => {
    const pitStore = usePitScoutStore()
    const recordStore = useRecordStore()

    pitStore.records = [
      {
        id: 'p-empty',
        eventId: 'e1',
        teamNumber: 27570,
        scoutId: 's1',
        scoutName: 'Alice',
        drivetrainType: 'mecanum',
        weightLbs: 38,
        ballCompatibility: 'universal',
        launcherType: 'dual_flywheel',
        flowerMechanism: 'none',
        hasColorSensor: true,
        odometryType: 'two_wheel',
        claimedAutoScore: 0,
        claimedTeleopCycles: 0,
        claimedTeleopScore: 0,
        claimedEndgameScore: 0,
        claimedTotalScore: 0,
        version: 1
      }
    ]
    recordStore.records = [
      {
        id: 'm1',
        eventId: 'e1',
        scoutId: 's1',
        matchNumber: 1,
        teamNumber: 27570,
        autoScore: 20,
        teleopScore: 30,
        endgameScore: 5,
        totalScore: 55,
        syncStatus: 'SYNCED',
        createdAt: '',
        updatedAt: ''
      } as ScoutingRecord
    ]

    const i18n = createI18n({ legacy: false, locale: 'en', messages: { en, zh } })
    const wrapper = mount(PitStatusIndicator, {
      props: { teamNumber: 27570, showLabel: true, showBrag: true },
      global: { plugins: [i18n] }
    })

    const badge = wrapper.find('.brag-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.classes()).toContain('tier-pending')
    expect(badge.text()).not.toBe('0x')
    expect(badge.text()).toContain('Claims Incomplete')
    expect(wrapper.attributes('title')).toContain('Claims Incomplete')
  })
})
