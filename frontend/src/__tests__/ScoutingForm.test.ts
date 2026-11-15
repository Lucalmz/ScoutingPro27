import { mount } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ScoutingForm from '../components/scouting/ScoutingForm.vue'
import { useRecordStore } from '../stores/records'
import type { ScoutingRecord } from '../../types'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    te: () => false
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

  describe('Draft Autosave and Restore', () => {
    it('restores draft data from localStorage on mount if present', async () => {
      const draftPayload = {
        matchNumber: '42',
        allianceColor: 'blue',
        currentTournamentLevel: 'PLAYOFF',
        scoutMode: 'single',
        teamsData: [{
          teamNumber: '9999',
          autoLeave: true,
          autoBalls: 2,
          autoCycles: [2],
          autoMissedCycles: [],
          autoPark: true,
          teleopCycles: [3, 4],
          teleopMissedCycles: [],
          flowerPlaced: true,
          flowerBottomBonus: false,
          teleopPark: true,
          isBroken: false,
          notes: 'Restored from draft after screen sleep',
          customFields: {}
        }],
        savedAt: Date.now()
      }
      localStorage.setItem('sp27_active_draft_event-1', JSON.stringify(draftPayload))

      const wrapper = mount(ScoutingForm, { props: defaultProps })
      await wrapper.vm.$nextTick()

      expect(wrapper.vm.isDraftRestored).toBe(true)
      expect(wrapper.vm.matchNumber).toBe('42')
      expect(wrapper.vm.allianceColor).toBe('blue')
      expect(wrapper.vm.teamsData[0].teamNumber).toBe('9999')
      expect(wrapper.vm.teamsData[0].notes).toBe('Restored from draft after screen sleep')

      // Clear draft
      wrapper.vm.clearDraft()
      expect(wrapper.vm.isDraftRestored).toBe(false)
      expect(localStorage.getItem('sp27_active_draft_event-1')).toBeNull()
    })

    it('discards stale draft older than 24 hours', async () => {
      const staleDraft = {
        matchNumber: '10',
        allianceColor: 'red',
        teamsData: [{ teamNumber: '1111', notes: 'ancient draft' }],
        savedAt: Date.now() - (25 * 60 * 60 * 1000) // 25 hours ago
      }
      localStorage.setItem('sp27_active_draft_event-1', JSON.stringify(staleDraft))

      const wrapper = mount(ScoutingForm, { props: defaultProps })
      await wrapper.vm.$nextTick()

      expect(wrapper.vm.isDraftRestored).toBe(false)
      expect(localStorage.getItem('sp27_active_draft_event-1')).toBeNull()
    })

    it('saves draft when user edits data even if initially loaded with assignedTask', async () => {
      vi.useFakeTimers()
      const wrapper = mount(ScoutingForm, {
        props: {
          ...defaultProps,
          assignedTask: { matchNumber: 5, teamNumber: 27570, allianceColor: 'red', tournamentLevel: 'QUALIFICATION' }
        }
      })
      await wrapper.vm.$nextTick()

      // User enters notes / scoring during assigned match
      wrapper.vm.teamsData[0].notes = 'Great defense during match 5'
      await wrapper.vm.$nextTick()

      vi.advanceTimersByTime(500)

      const saved = localStorage.getItem('sp27_active_draft_event-1')
      expect(saved).not.toBeNull()
      const parsed = JSON.parse(saved!)
      expect(parsed.matchNumber).toBe('5')
      expect(parsed.teamsData[0].notes).toBe('Great defense during match 5')

      vi.useRealTimers()
    })

    it('flushes pending draft immediately upon component unmount', async () => {
      vi.useFakeTimers()
      localStorage.removeItem('sp27_active_draft_event-1')

      const wrapper = mount(ScoutingForm, { props: defaultProps })
      await wrapper.vm.$nextTick()

      wrapper.vm.teamsData[0].teamNumber = '27570'
      wrapper.vm.teamsData[0].notes = 'Unmounting without waiting 400ms'
      await wrapper.vm.$nextTick()

      // Unmount before 400ms timer elapses
      wrapper.unmount()

      const saved = localStorage.getItem('sp27_active_draft_event-1')
      expect(saved).not.toBeNull()
      const parsed = JSON.parse(saved!)
      expect(parsed.teamsData[0].notes).toBe('Unmounting without waiting 400ms')

      vi.useRealTimers()
    })
  })

  describe('Restored UI interactions & stylesheet integrity', () => {
    it('retains scoped ScoutingForm.css import in ScoutingForm.vue SFC', () => {
      const sfcPath = resolve(__dirname, '../components/scouting/ScoutingForm.vue')
      const source = readFileSync(sfcPath, 'utf-8')
      expect(source).toMatch(/<style\s+scoped\s+src="\.\/ScoutingForm\.css"\s*><\/style>/)
    })

    it('wires DOM clicks for mode switch, alliance SPDT switch, and toggle cards', async () => {
      localStorage.removeItem('sp27_active_draft_event-1')
      const wrapper = mount(ScoutingForm, { props: defaultProps })
      await wrapper.vm.$nextTick()

      // Mode switch buttons
      const modeBtns = wrapper.findAll('.settings-section .segmented-control button')
      expect(modeBtns).toHaveLength(2)
      await modeBtns[1].trigger('click')
      expect(wrapper.vm.scoutMode).toBe('alliance')
      expect(wrapper.findAll('.team-column')).toHaveLength(2)
      await modeBtns[0].trigger('click')
      expect(wrapper.vm.scoutMode).toBe('single')
      expect(wrapper.findAll('.team-column')).toHaveLength(1)

      // Alliance SPDT switch labels
      const spdtLabels = wrapper.findAll('.spdt-labels span')
      expect(spdtLabels).toHaveLength(2)
      await spdtLabels[1].trigger('click')
      expect(wrapper.vm.allianceColor).toBe('blue')
      expect(wrapper.find('.scouting-wrapper').classes()).toContain('color-blue')
      await spdtLabels[0].trigger('click')
      expect(wrapper.vm.allianceColor).toBe('red')
      expect(wrapper.find('.scouting-wrapper').classes()).toContain('color-red')

      // Toggle cards (Auto Leave, Auto Park, TeleOp Park, Flower Descore, G410 Foul, Broken)
      const toggles = wrapper.findAll('.toggle-card')
      expect(toggles).toHaveLength(6)
      await toggles[0].find('input[type="checkbox"]').setValue(true) // autoLeave
      await toggles[2].find('input[type="checkbox"]').setValue(true) // teleopPark
      expect(wrapper.vm.teamsData[0].autoLeave).toBe(true)
      expect(wrapper.vm.teamsData[0].teleopPark).toBe(true)
      expect(toggles[0].classes()).toContain('is-active')
      expect(toggles[2].classes()).toContain('is-active')
    })

    it('prevents TagPicker add/remove buttons inside ScoutingForm from triggering form submit', async () => {
      localStorage.removeItem('sp27_active_draft_event-1')
      const recordStore = useRecordStore()
      recordStore.teamTags = [
        {
          id: 'tag-1',
          eventId: 'event-1',
          teamNumber: 27570,
          tag: 'fast-auto',
          color: 'blue',
          isPreset: false,
          createdAt: new Date().toISOString()
        }
      ] as any

      const wrapper = mount(ScoutingForm, { props: defaultProps })
      await wrapper.find('input[placeholder="e.g. 12345"]').setValue('27570')
      await wrapper.vm.$nextTick()

      const addBtn = wrapper.find('.btn-add-tag')
      const removeBtn = wrapper.find('.btn-tag-remove')
      expect(addBtn.exists()).toBe(true)
      expect(removeBtn.exists()).toBe(true)
      expect(addBtn.attributes('type')).toBe('button')
      expect(removeBtn.attributes('type')).toBe('button')

      await addBtn.trigger('click')
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.tag-edit-panel').exists()).toBe(true)
      expect(wrapper.emitted('submit')).toBeUndefined()
      expect(wrapper.find('.submit-status-msg').exists()).toBe(false)
    })

    it('calculates BIOBUZZ Endgame scoring, clamps bottom bonus <= nectars, warns on unowned pollens and alliance nectar > 8', async () => {
      localStorage.removeItem('sp27_active_draft_event-1')
      const wrapper = mount(ScoutingForm, { props: defaultProps })

      wrapper.vm.matchNumber = '3'
      wrapper.vm.allianceColor = 'red'
      wrapper.vm.teamsData[0].teamNumber = '27570'

      // Pollens > 0 while flowerNectars === 0 shows non-blocking hint banner
      wrapper.vm.setEndgameField(wrapper.vm.teamsData[0], 'flowerPollens', 2)
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.endgame-hint-banner').exists()).toBe(true)

      // Quick-chip buttons highlight active selection with `.is-selected`
      const stepperCards = wrapper.findAll('.endgame-stepper-card')
      expect(stepperCards).toHaveLength(4)
      const nectarChips = stepperCards[0].findAll('.quick-ball-btn')
      const pollenChips = stepperCards[2].findAll('.quick-ball-btn')
      const gardenChips = stepperCards[3].findAll('.quick-ball-btn')
      expect(pollenChips[1].classes()).toContain('is-selected') // 2 pollens

      await nectarChips[2].trigger('click') // flowerNectars = 2
      expect(nectarChips[2].classes()).toContain('is-selected')
      expect(nectarChips[0].classes()).not.toContain('is-selected')

      await gardenChips[2].trigger('click') // gardenBalls = 4
      expect(gardenChips[2].classes()).toContain('is-selected')

      // Nectars = 2, try setting BottomBonus = 4 -> clamped to 2
      wrapper.vm.setEndgameField(wrapper.vm.teamsData[0], 'flowerNectars', 2)
      wrapper.vm.setEndgameField(wrapper.vm.teamsData[0], 'flowerBottomBonusCount', 4)
      expect(wrapper.vm.teamsData[0].flowerBottomBonusCount).toBe(2)

      // Dropping Nectars down to 1 auto-clamps BottomBonus down to 1
      wrapper.vm.setEndgameField(wrapper.vm.teamsData[0], 'flowerNectars', 1)
      await wrapper.vm.$nextTick()
      expect(wrapper.vm.teamsData[0].flowerBottomBonusCount).toBe(1)
      const bonusChips = stepperCards[1].findAll('.quick-ball-btn')
      expect(bonusChips[1].classes()).toContain('is-selected') // 1 bottom bonus

      // Endgame = park(5) + 1*2 + 1*5 + 2*2 + garden 3*1 = 19
      wrapper.vm.teamsData[0].teleopPark = true
      wrapper.vm.setEndgameField(wrapper.vm.teamsData[0], 'gardenBalls', 3)
      await wrapper.vm.$nextTick()
      expect(wrapper.vm.calcTeamTotal(wrapper.vm.teamsData[0])).toBe(19)

      // Dual-team mode alliance nectar cap warning (> 8 across both teams)
      wrapper.vm.scoutMode = 'alliance'
      await wrapper.vm.$nextTick()
      wrapper.vm.teamsData[0].flowerNectars = 5
      wrapper.vm.teamsData[1].flowerNectars = 4
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.endgame-warn-banner').exists()).toBe(true)
    })

    it('passively collects teleopCycleTimestamps, pops on undo, ignores history +/- edits, and saves predictCycleTimeSec', async () => {
      localStorage.removeItem('sp27_active_draft_event-1')
      vi.useFakeTimers()
      let now = 1_700_000_000_000
      vi.setSystemTime(now)

      try {
        const wrapper = mount(ScoutingForm, { props: defaultProps })
        wrapper.vm.matchNumber = '10'
        wrapper.vm.allianceColor = 'blue'
        wrapper.vm.teamsData[0].teamNumber = '27570'

        const team = wrapper.vm.teamsData[0]
        // Simulate 6 cycles at +6s, +8s, +10s, +12s, +14s intervals (5 valid intervals -> drops 6s, avg(8,10,12,14)=11.0s)
        const gaps = [0, 6000, 8000, 10000, 12000, 14000]
        for (const g of gaps) {
          now += g
          vi.setSystemTime(now)
          wrapper.vm.addCycle(team)
          wrapper.vm.setLastCycleBalls(team, 2)
        }
        expect(team.teleopCycleTimestamps).toHaveLength(6)
        const snapshotBeforeEdit = [...team.teleopCycleTimestamps]

        // Historical adjustment (+/-) must NOT alter recorded timestamps
        team.teleopCycles[0] = 3
        expect(team.teleopCycleTimestamps).toEqual(snapshotBeforeEdit)

        // Adding 7th cycle then undoing it should pop its timestamp cleanly
        now += 5000
        vi.setSystemTime(now)
        wrapper.vm.addCycle(team)
        expect(team.teleopCycleTimestamps).toHaveLength(7)
        wrapper.vm.undoLastCycle(team)
        expect(team.teleopCycleTimestamps).toEqual(snapshotBeforeEdit)

        expect(wrapper.vm.getTeamPredictCycleTime(team)).toBe(11.0)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})

