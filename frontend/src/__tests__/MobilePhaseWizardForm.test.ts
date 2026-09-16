import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import MobilePhaseWizardForm from '../components/scouting/mobile/MobilePhaseWizardForm.vue'
import { useRecordStore } from '../stores/records'
import { useScheduleStore } from '../stores/schedule'
import type { ScoutingRecord } from '../types'

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string) => key,
      te: () => false
    })
  }
})

describe('MobilePhaseWizardForm.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders Step 0 (Pre-match) initially and disables progression until valid', async () => {
    const wrapper = mount(MobilePhaseWizardForm, {
      props: {
        eventId: 'evt_1',
        scoutId: 'scout_1',
        scoutName: 'Alice'
      }
    })

    // Stepper has 5 steps
    const stepButtons = wrapper.findAll('.stepper-step')
    expect(stepButtons.length).toBe(5)
    expect(stepButtons[0].classes()).toContain('is-active')

    // Initial inputs
    const numInputs = wrapper.findAll('.giant-num-input')
    expect(numInputs.length).toBe(2) // Match & Team

    // Primary next button is disabled
    const nextBtn = wrapper.find('.btn-wizard-primary')
    expect((nextBtn.element as HTMLButtonElement).disabled).toBe(true)

    // Select Red alliance
    const redBtn = wrapper.find('.red-btn')
    await redBtn.trigger('click')
    expect(redBtn.classes()).toContain('is-selected')

    // Enter team number
    await numInputs[1].setValue('27570')

    // Now primary button is enabled
    expect((nextBtn.element as HTMLButtonElement).disabled).toBe(false)
  })

  it('completes the full 5-phase match scouting flow and submits record', async () => {
    const wrapper = mount(MobilePhaseWizardForm, {
      props: {
        eventId: 'evt_1',
        scoutId: 'scout_1',
        scoutName: 'Alice'
      }
    })

    // STEP 0: Pre-Match Setup
    await wrapper.find('.blue-btn').trigger('click')
    const numInputs = wrapper.findAll('.giant-num-input')
    await numInputs[0].setValue('5')
    await numInputs[1].setValue('18457')
    await wrapper.find('.btn-wizard-primary').trigger('click')

    // STEP 1: Autonomous (30s)
    expect(wrapper.find('.step-auto').exists()).toBe(true)
    const autoHitBtn = wrapper.find('.auto-hero-hit')
    await autoHitBtn.trigger('click') // 1 ball
    await autoHitBtn.trigger('click') // 2 balls (6 pts)

    // Toggle Auto Leave (+3 pts) and Auto Park (+5 pts)
    const toggleCards = wrapper.findAll('.toggle-card')
    await toggleCards[0].trigger('click') // Leave
    await toggleCards[1].trigger('click') // Park

    // Auto score should be 6 + 3 + 5 = 14
    expect(wrapper.find('.score-val').text()).toBe('14')
    await wrapper.find('.btn-wizard-primary').trigger('click')

    // STEP 2: TeleOp (120s)
    expect(wrapper.find('.step-teleop').exists()).toBe(true)
    const teleopHeroHit = wrapper.find('.teleop-hero-hit')
    await teleopHeroHit.trigger('click') // 1 ball
    await teleopHeroHit.trigger('click') // 2 balls in cycle
    expect(wrapper.find('.score-val').text()).toBe('4') // 2 balls * 2 pts = 4
    await wrapper.find('.btn-wizard-primary').trigger('click')

    // STEP 3: Endgame (30s)
    expect(wrapper.find('.step-endgame').exists()).toBe(true)
    const endgameCards = wrapper.findAll('.toggle-card')
    await endgameCards[0].trigger('click') // Flower Placed (+10 pts)
    await endgameCards[2].trigger('click') // TeleOp Park (+5 pts)
    expect(wrapper.find('.score-val').text()).toBe('15')

    // Quick notes chip
    const noteChips = wrapper.findAll('.quick-note-chip')
    await noteChips[0].trigger('click') // "防守强"
    expect(wrapper.find('.notes-textarea').element as HTMLTextAreaElement).toHaveProperty('value', '防守强')

    await wrapper.find('.btn-wizard-primary').trigger('click')

    // STEP 4: Summary & Submit
    expect(wrapper.find('.step-summary').exists()).toBe(true)
    // Total score = 14 (auto) + 4 (teleop) + 15 (endgame) = 33
    expect(wrapper.find('.total-score-val').text()).toBe('33')

    // Click submit
    await wrapper.find('.btn-wizard-submit').trigger('click')

    // Emitted submit event
    const submitEvents = wrapper.emitted('submit')
    expect(submitEvents).toBeTruthy()
    expect(submitEvents!.length).toBe(1)
    const submittedRecord = submitEvents![0][0] as ScoutingRecord
    expect(submittedRecord.matchNumber).toBe(5)
    expect(submittedRecord.teamNumber).toBe(18457)
    expect(submittedRecord.autoScore).toBe(14)
    expect(submittedRecord.teleopScore).toBe(4)
    expect(submittedRecord.endgameScore).toBe(15)
    expect(submittedRecord.totalScore).toBe(33)
    expect(submittedRecord.notes).toContain('防守强')

    // Reset to Step 0 and auto-increment match number to 6
    expect(wrapper.find('.step-pre-match').exists()).toBe(true)
    const updatedInputs = wrapper.findAll('.giant-num-input')
    expect((updatedInputs[0].element as HTMLInputElement).value).toBe('6')
  })

  it('populates fields when assignedTask prop is supplied', async () => {
    const wrapper = mount(MobilePhaseWizardForm, {
      props: {
        eventId: 'evt_1',
        scoutId: 'scout_1',
        scoutName: 'Alice',
        assignedTask: {
          matchNumber: 12,
          teamNumber: 27570,
          allianceColor: 'red'
        }
      }
    })

    const numInputs = wrapper.findAll('.giant-num-input')
    expect((numInputs[0].element as HTMLInputElement).value).toBe('12')
    expect((numInputs[1].element as HTMLInputElement).value).toBe('27570')
    expect(wrapper.find('.red-btn').classes()).toContain('is-selected')
  })

  it('populates existing data in editRecord mode and emits cancelEdit on submit', async () => {
    const mockRecord: ScoutingRecord = {
      id: 'rec_edit_1',
      eventId: 'evt_1',
      scoutId: 'scout_1',
      scoutName: 'Alice',
      matchNumber: 8,
      teamNumber: 9999,
      autoScore: 8,
      teleopScore: 10,
      endgameScore: 10,
      totalScore: 28,
      notes: 'Good driver',
      rawData: JSON.stringify({
        matchNumber: 8,
        teamNumber: 9999,
        allianceColor: 'blue',
        autoLeave: true,
        autoBalls: 1,
        autoCycles: [1],
        autoPark: false,
        teleopCycles: [2, 3],
        flowerPlaced: true,
        flowerBottomBonus: false,
        teleopPark: false,
        isBroken: false
      }),
      syncStatus: 'SYNCED',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1
    }

    const wrapper = mount(MobilePhaseWizardForm, {
      props: {
        eventId: 'evt_1',
        scoutId: 'scout_1',
        scoutName: 'Alice',
        editRecord: mockRecord
      }
    })

    const numInputs = wrapper.findAll('.giant-num-input')
    expect((numInputs[0].element as HTMLInputElement).value).toBe('8')
    expect((numInputs[1].element as HTMLInputElement).value).toBe('9999')
    expect(wrapper.find('.blue-btn').classes()).toContain('is-selected')

    // Jump to summary directly
    const steps = wrapper.findAll('.stepper-step')
    await steps[4].trigger('click')
    expect(wrapper.find('.step-summary').exists()).toBe(true)

    // Submit edit
    await wrapper.find('.btn-wizard-submit').trigger('click')
    expect(wrapper.emitted('submit')).toBeTruthy()
    expect(wrapper.emitted('cancelEdit')).toBeTruthy()
  })
})
