import { mount } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import ScoutingForm from '../components/scouting/ScoutingForm.vue'
import type { ScoutingRecord } from '../../types'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key
  }),
  createI18n: () => ({})
}))

describe('ScoutingForm', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })
  
  const defaultProps = {
    eventId: 'event-1',
    scoutId: 'scout-1',
    scoutName: 'Alice'
  }

  it('changes teamsData length correctly when switching between single and alliance modes', async () => {
    const wrapper = mount(ScoutingForm, { props: defaultProps })
    
    // Initially single mode
    expect(wrapper.vm.scoutMode).toBe('single')
    expect(wrapper.vm.teamsData).toHaveLength(1)

    // Switch to alliance mode
    wrapper.vm.scoutMode = 'alliance'
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.teamsData).toHaveLength(2)

    // Switch back to single mode
    wrapper.vm.scoutMode = 'single'
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.teamsData).toHaveLength(2)
  })

  describe('Form validation (isFormValid)', () => {
    it('disables submit (invalid) if matchNumber <= 0', async () => {
      const wrapper = mount(ScoutingForm, { props: defaultProps })
      
      // Setup valid other fields
      wrapper.vm.allianceColor = 'red'
      wrapper.vm.teamsData[0].teamNumber = '123'
      
      wrapper.vm.matchNumber = '0'
      expect(wrapper.vm.isFormValid).toBe(false)
      
      wrapper.vm.matchNumber = '-1'
      expect(wrapper.vm.isFormValid).toBe(false)
      
      wrapper.vm.matchNumber = '1'
      expect(wrapper.vm.isFormValid).toBe(true)
    })

    it('disables submit (invalid) if allianceColor === "none"', async () => {
      const wrapper = mount(ScoutingForm, { props: defaultProps })
      
      wrapper.vm.matchNumber = '1'
      wrapper.vm.teamsData[0].teamNumber = '123'
      
      wrapper.vm.allianceColor = 'none'
      expect(wrapper.vm.isFormValid).toBe(false)
      
      wrapper.vm.allianceColor = 'blue'
      expect(wrapper.vm.isFormValid).toBe(true)
    })

    it('disables submit (invalid) if in alliance mode and the two teamNumbers are exactly the same', async () => {
      const wrapper = mount(ScoutingForm, { props: defaultProps })
      
      wrapper.vm.matchNumber = '1'
      wrapper.vm.allianceColor = 'red'
      wrapper.vm.scoutMode = 'alliance'
      await wrapper.vm.$nextTick()
      
      // Valid if different
      wrapper.vm.teamsData[0].teamNumber = '123'
      wrapper.vm.teamsData[1].teamNumber = '456'
      expect(wrapper.vm.isFormValid).toBe(true)

      // Invalid if same
      wrapper.vm.teamsData[1].teamNumber = '123'
      expect(wrapper.vm.isFormValid).toBe(false)
    })
  })

  it('previousScoutMode logic: reverts to alliance mode after successful submit of editRecord', async () => {
    const wrapper = mount(ScoutingForm, { props: defaultProps })
    
    // 1. Enter alliance mode
    wrapper.vm.scoutMode = 'alliance'
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.teamsData).toHaveLength(2)

    // 2. Set editRecord (simulate clicking edit on a record)
    const mockRecord: ScoutingRecord = {
      id: 'rec-1',
      eventId: 'event-1',
      scoutId: 'scout-1',
      scoutName: 'Alice',
      matchNumber: 2,
      teamNumber: 123,
      autoScore: 0,
      teleopScore: 0,
      endgameScore: 0,
      totalScore: 0,
      notes: '',
      rawData: JSON.stringify({
        matchNumber: 2,
        teamNumber: 123,
        allianceColor: 'blue',
        autoLeave: true,
        autoBalls: 1,
        autoPark: true,
        teleopCycles: [2, 3],
        flowerPlaced: false,
        flowerBottomBonus: false,
        teleopPark: true
      }),
      syncStatus: 'PENDING',
      createdAt: '2023-01-01T00:00:00Z',
      updatedAt: '2023-01-01T00:00:00Z'
    }

    await wrapper.setProps({ editRecord: mockRecord })
    
    // Check if mode switched to single and previous mode is saved
    expect(wrapper.vm.scoutMode).toBe('single')
    expect(wrapper.vm.previousScoutMode).toBe('alliance')
    expect(wrapper.vm.teamsData).toHaveLength(1)

    // 3. Submit successfully
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.isFormValid).toBe(true)

    await wrapper.find('form').trigger('submit.prevent')
    await wrapper.vm.$nextTick()
    
    // 4. Verify it reverted to alliance mode and length 2
    expect(wrapper.vm.scoutMode).toBe('alliance')
    expect(wrapper.vm.teamsData).toHaveLength(2)
  })

  describe('Team Tags Integration', () => {
    it('renders TagPicker only when a valid positive teamNumber is entered', async () => {
      const wrapper = mount(ScoutingForm, { props: defaultProps })
      
      // Initially teamNumber is empty -> no TagPicker
      expect(wrapper.findComponent({ name: 'TagPicker' }).exists()).toBe(false)

      // Enter invalid or non-numeric teamNumber
      wrapper.vm.teamsData[0].teamNumber = '0'
      await wrapper.vm.$nextTick()
      expect(wrapper.findComponent({ name: 'TagPicker' }).exists()).toBe(false)

      // Enter valid teamNumber
      wrapper.vm.teamsData[0].teamNumber = '12345'
      await wrapper.vm.$nextTick()
      const tagPicker = wrapper.findComponent({ name: 'TagPicker' })
      expect(tagPicker.exists()).toBe(true)
      expect(tagPicker.props('eventId')).toBe('event-1')
      expect(tagPicker.props('teamNumber')).toBe(12345)
    })
  })

  describe('Cycle Tracker Controls', () => {
    it('records, modifies and undoes teleop cycles correctly', async () => {
      const wrapper = mount(ScoutingForm, { props: defaultProps })
      const team = wrapper.vm.teamsData[0]
      
      expect(team.teleopCycles.length).toBe(0)
      
      // Add first cycle with default 1 ball
      wrapper.vm.addCycle(team, 1)
      expect(team.teleopCycles).toEqual([1])

      // Quick change to 3 balls
      wrapper.vm.setLastCycleBalls(team, 3)
      expect(team.teleopCycles).toEqual([3])

      // Increment balls up to max 4
      wrapper.vm.incrementCycle(team, 0)
      expect(team.teleopCycles).toEqual([4])
      wrapper.vm.incrementCycle(team, 0) // capped at 4
      expect(team.teleopCycles).toEqual([4])

      // Decrement down to 0
      wrapper.vm.decrementCycle(team, 0)
      expect(team.teleopCycles).toEqual([3])

      // Add second cycle with 2 balls
      wrapper.vm.addCycle(team, 2)
      expect(team.teleopCycles).toEqual([3, 2])
      expect(wrapper.vm.getCycleBallsTotal(team)).toBe(5)
      expect(wrapper.vm.getAvgBallsPerCycle(team)).toBe('2.5')

      // Undo last cycle
      wrapper.vm.undoLastCycle(team)
      expect(team.teleopCycles).toEqual([3])
    })

    it('handles rapid consecutive addCycle clicks by incrementing balls on the current cycle', async () => {
      const wrapper = mount(ScoutingForm, { props: defaultProps })
      const team = wrapper.vm.teamsData[0]

      // Tap 1: creates cycle 1 with 0 balls (defaults to 0)
      wrapper.vm.addCycle(team, 'teleop', 0)
      expect(team.teleopCycles).toEqual([0])
      expect(wrapper.vm.isCycleTapping(0, 'teleop')).toBe(true)

      // Tap 2 (rapid within 2s): increments cycle 1 to 1 ball
      wrapper.vm.addCycle(team, 'teleop', 0)
      expect(team.teleopCycles).toEqual([1])

      // Tap 3: increments to 2 balls
      wrapper.vm.addCycle(team, 'teleop', 0)
      expect(team.teleopCycles).toEqual([2])

      // Tap 4: increments to 3 balls
      wrapper.vm.addCycle(team, 'teleop', 0)
      expect(team.teleopCycles).toEqual([3])

      // Tap 5: increments to 4 balls
      wrapper.vm.addCycle(team, 'teleop', 0)
      expect(team.teleopCycles).toEqual([4])

      // Tap 6: capped at 4 balls
      wrapper.vm.addCycle(team, 'teleop', 0)
      expect(team.teleopCycles).toEqual([4])
    })

    it('unifies auto balls with cycle recording and direct chip selection', async () => {
      const wrapper = mount(ScoutingForm, { props: defaultProps })
      const team = wrapper.vm.teamsData[0]

      expect(team.autoBalls).toBe(0)
      expect(team.autoCycles).toEqual([])

      // Tap 1 on auto: adds cycle with 0 balls
      wrapper.vm.addCycle(team, 'auto', 0)
      expect(team.autoCycles).toEqual([0])
      expect(team.autoBalls).toBe(0)

      // Rapid tap: increments to 1 ball
      wrapper.vm.addCycle(team, 'auto', 0)
      expect(team.autoCycles).toEqual([1])
      expect(team.autoBalls).toBe(1)

      // Direct chip selection: set to 3 balls
      wrapper.vm.setAutoBalls(team, 3, 0)
      expect(team.autoCycles).toEqual([3])
      expect(team.autoBalls).toBe(3)

      // Direct chip selection: set to 0 (clears cycles)
      wrapper.vm.setAutoBalls(team, 0, 0)
      expect(team.autoCycles).toEqual([])
      expect(team.autoBalls).toBe(0)
    })
  })
})
