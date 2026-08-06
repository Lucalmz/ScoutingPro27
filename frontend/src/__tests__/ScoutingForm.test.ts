import { mount } from '@vue/test-utils'
import { describe, it, expect, vi } from 'vitest'
import ScoutingForm from '../components/scouting/ScoutingForm.vue'
import type { ScoutingRecord } from '../../types'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key
  })
}))

describe('ScoutingForm', () => {
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
    expect(wrapper.vm.teamsData).toHaveLength(1)
  })

  describe('Form validation (isFormValid)', () => {
    it('disables submit (invalid) if matchNumber <= 0', async () => {
      const wrapper = mount(ScoutingForm, { props: defaultProps })
      
      // Setup valid other fields
      wrapper.vm.allianceColor = 'red'
      wrapper.vm.teamsData[0].teamNumber = 123
      
      wrapper.vm.matchNumber = 0
      expect(wrapper.vm.isFormValid).toBe(false)
      
      wrapper.vm.matchNumber = -1
      expect(wrapper.vm.isFormValid).toBe(false)
      
      wrapper.vm.matchNumber = 1
      expect(wrapper.vm.isFormValid).toBe(true)
    })

    it('disables submit (invalid) if allianceColor === "none"', async () => {
      const wrapper = mount(ScoutingForm, { props: defaultProps })
      
      wrapper.vm.matchNumber = 1
      wrapper.vm.teamsData[0].teamNumber = 123
      
      wrapper.vm.allianceColor = 'none'
      expect(wrapper.vm.isFormValid).toBe(false)
      
      wrapper.vm.allianceColor = 'blue'
      expect(wrapper.vm.isFormValid).toBe(true)
    })

    it('disables submit (invalid) if in alliance mode and the two teamNumbers are exactly the same', async () => {
      const wrapper = mount(ScoutingForm, { props: defaultProps })
      
      wrapper.vm.matchNumber = 1
      wrapper.vm.allianceColor = 'red'
      wrapper.vm.scoutMode = 'alliance'
      await wrapper.vm.$nextTick()
      
      // Valid if different
      wrapper.vm.teamsData[0].teamNumber = 123
      wrapper.vm.teamsData[1].teamNumber = 456
      expect(wrapper.vm.isFormValid).toBe(true)

      // Invalid if same
      wrapper.vm.teamsData[1].teamNumber = 123
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
        autoClassified: 0,
        autoOverflow: 0,
        autoPatterns: 0,
        autoMovementScore: 0,
        teleopClassified: 0,
        teleopOverflow: 0,
        gatesTriggered: 0,
        baseScore: 5,
        supportMultiplier: 0,
        minorFouls: 0,
        majorFouls: 0
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
})
