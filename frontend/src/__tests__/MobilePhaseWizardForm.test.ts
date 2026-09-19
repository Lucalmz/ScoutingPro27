import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import MobilePhaseWizardForm from '../components/scouting/mobile/MobilePhaseWizardForm.vue'
import { useRecordStore } from '../stores/records'
import { useScheduleStore } from '../stores/schedule'
import type { ScoutingRecord } from '../types'

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  const dict: Record<string, string> = {
    'wizard.pre_match': '赛前准备',
    'wizard.tag_defense': '防守强',
    'wizard.tag_slipping': '底盘打滑',
    'wizard.tag_mechanics': '掉链/脱困',
    'wizard.tag_accuracy': '高命中率',
    'wizard.tag_fouls': '违规判罚',
    'wizard.tag_synergy': '配合默契',
    'wizard.start_auto': '开始自动阶段',
    'wizard.prev_step': '上一步',
    'wizard.next_step': '下一步',
    'wizard.to_summary': '结算核对',
    'wizard.modify': '修改',
    'wizard.confirm_submit': '确认并提交记录',
    'wizard.cancel_edit': '取消编辑',
    'wizard.level_qual': '资格赛',
    'wizard.level_playoff': '淘汰赛',
    'wizard.missed_short': '丢',
    'scouting.red': '红方',
    'scouting.blue': '蓝方'
  }
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string, fallback?: any) => (typeof fallback === 'string' ? dict[key] || fallback : dict[key] || key),
      te: (key: string) => Boolean(dict[key])
    })
  }
})

describe('MobilePhaseWizardForm.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders Step 0 (Pre-match) initially, supports stepper adjustments and disables progression until valid', async () => {
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
    expect((numInputs[0].element as HTMLInputElement).value).toBe('1')

    // Test match steppers [+] and [-]
    const plusBtn = wrapper.find('.btn-stepper-plus')
    await plusBtn.trigger('click')
    expect((numInputs[0].element as HTMLInputElement).value).toBe('2')

    const minusBtn = wrapper.find('.btn-stepper-minus')
    await minusBtn.trigger('click')
    expect((numInputs[0].element as HTMLInputElement).value).toBe('1')

    // Test tournament level toggle
    const levelBtns = wrapper.findAll('.btn-level-seg')
    expect(levelBtns.length).toBe(2)
    expect(levelBtns[0].classes()).toContain('is-active')
    await levelBtns[1].trigger('click') // Switch to playoff
    expect(levelBtns[1].classes()).toContain('is-active')

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

  it('populates existing data in editRecord mode and provides cancelEdit button', async () => {
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

    // Edit mode top bar should be visible with cancel button
    const editBar = wrapper.find('.edit-mode-bar')
    expect(editBar.exists()).toBe(true)

    const cancelChip = wrapper.find('.btn-cancel-edit-chip')
    expect(cancelChip.exists()).toBe(true)
    await cancelChip.trigger('click')
    expect(wrapper.emitted('cancelEdit')).toBeTruthy()

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
  })

  it('shows banned warning card when team is in bannedTeams list', async () => {
    const recordStore = useRecordStore()
    recordStore.bannedTeams = [12345]

    const wrapper = mount(MobilePhaseWizardForm, {
      props: {
        eventId: 'evt_1',
        scoutId: 'scout_1',
        scoutName: 'Alice'
      }
    })

    const teamInput = wrapper.findAll('.giant-num-input')[1]
    await teamInput.setValue('12345')

    const warning = wrapper.find('.banned-warning-card')
    expect(warning.exists()).toBe(true)
  })

  it('supports teleop cycle chips: tapping chip decrements ball count, tapping close icon removes cycle', async () => {
    const wrapper = mount(MobilePhaseWizardForm, {
      props: {
        eventId: 'evt_1',
        scoutId: 'scout_1',
        scoutName: 'Alice'
      }
    })

    // Setup match
    await wrapper.find('.red-btn').trigger('click')
    await wrapper.findAll('.giant-num-input')[1].setValue('27570')

    // Go to Teleop step (Step 2)
    const steps = wrapper.findAll('.stepper-step')
    await steps[2].trigger('click')
    expect(wrapper.find('.step-teleop').exists()).toBe(true)

    // Add shots: 2 balls in cycle #1
    const teleopHeroHit = wrapper.find('.teleop-hero-hit')
    await teleopHeroHit.trigger('click') // 1 ball
    await teleopHeroHit.trigger('click') // 2 balls
    let chips = wrapper.findAll('.cycle-chip')
    expect(chips.length).toBe(1)
    expect(chips[0].text()).toContain('2')

    // Tapping chip decrements ball count from 2 to 1
    await chips[0].trigger('click')
    chips = wrapper.findAll('.cycle-chip')
    expect(chips.length).toBe(1)
    expect(chips[0].text()).toContain('1')

    // Tapping close icon removes cycle completely
    const closeIcon = chips[0].find('.chip-remove-icon')
    await closeIcon.trigger('click')
    chips = wrapper.findAll('.cycle-chip')
    expect(chips.length).toBe(0)
  })

  it('enforces manual cycle progression with 0-ball protection and max-4-balls cap with pulsing glow', async () => {
    const wrapper = mount(MobilePhaseWizardForm, {
      props: {
        eventId: 'evt_1',
        scoutId: 'scout_1',
        scoutName: 'Alice'
      }
    })

    await wrapper.find('.red-btn').trigger('click')
    await wrapper.findAll('.giant-num-input')[1].setValue('27570')
    const steps = wrapper.findAll('.stepper-step')
    await steps[2].trigger('click')

    const newCycleBtn = wrapper.find('.step-teleop .btn-new-cycle')
    const teleopHitBtn = wrapper.find('.teleop-hero-hit')

    // 1 ball
    await teleopHitBtn.trigger('click')
    expect(wrapper.findAll('.step-teleop .cycle-chip').length).toBe(1)
    expect(wrapper.find('.step-teleop .cycle-chip').text()).toContain('1')

    // Now start new cycle
    await newCycleBtn.trigger('click')
    // Cycle #2 started with 0 balls
    expect(wrapper.findAll('.step-teleop .cycle-chip').length).toBe(2)

    // 0-ball protection: attempting to click newCycleBtn again while current cycle is 0 balls should be blocked!
    await newCycleBtn.trigger('click')
    expect(wrapper.findAll('.step-teleop .cycle-chip').length).toBe(2) // still 2

    // Now fill 4 balls in Cycle #2
    await teleopHitBtn.trigger('click') // 1
    await teleopHitBtn.trigger('click') // 2
    await teleopHitBtn.trigger('click') // 3
    await teleopHitBtn.trigger('click') // 4 (cap reached!)
    expect(wrapper.findAll('.step-teleop .cycle-chip')[1].text()).toContain('4')

    // Pulsing glow should be active on the new cycle button
    expect(newCycleBtn.classes()).toContain('pulsing-glow')

    // Clicking hit again should NOT exceed 4 balls
    await teleopHitBtn.trigger('click') // 5th click blocked
    expect(wrapper.findAll('.step-teleop .cycle-chip')[1].text()).toContain('4')

    // Cycle #2 is capped at 4 balls, cut to Cycle #3
    await newCycleBtn.trigger('click')
    expect(wrapper.findAll('.step-teleop .cycle-chip').length).toBe(3)
  })

  it('supports preset capsules [1, 2, 3, 4] with safety truncation', async () => {
    const wrapper = mount(MobilePhaseWizardForm, {
      props: {
        eventId: 'evt_1',
        scoutId: 'scout_1',
        scoutName: 'Alice'
      }
    })

    await wrapper.find('.red-btn').trigger('click')
    await wrapper.findAll('.giant-num-input')[1].setValue('27570')
    const steps = wrapper.findAll('.stepper-step')
    await steps[2].trigger('click')

    // Tapping preset capsule [3球]
    const presetCapsules = wrapper.findAll('.step-teleop .btn-preset-capsule')
    expect(presetCapsules.length).toBe(4)

    await presetCapsules[2].trigger('click') // 3 balls
    expect(wrapper.find('.step-teleop .cycle-chip').text()).toContain('3')

    // Add 1 miss -> 3 hits + 1 miss = 4 attempts (full cap)
    await wrapper.find('.step-teleop .btn-miss').trigger('click')
    expect(wrapper.find('.step-teleop .cycle-chip').text()).toContain('3')
    expect(wrapper.find('.step-teleop .chip-miss-val').text()).toContain('1丢')

    // Tapping preset [4球] should truncate miss to 0 because 4 - 4 = 0: hits=4, misses=0
    await presetCapsules[3].trigger('click') // 4 balls
    expect(wrapper.find('.step-teleop .cycle-chip').text()).toContain('4')
    expect(wrapper.find('.step-teleop .chip-miss-val').exists()).toBe(false)
  })

  it('supports single-step undo and cross-cycle empty undo', async () => {
    const wrapper = mount(MobilePhaseWizardForm, {
      props: {
        eventId: 'evt_1',
        scoutId: 'scout_1',
        scoutName: 'Alice'
      }
    })

    await wrapper.find('.red-btn').trigger('click')
    await wrapper.findAll('.giant-num-input')[1].setValue('27570')
    const steps = wrapper.findAll('.stepper-step')
    await steps[2].trigger('click')

    const teleopHitBtn = wrapper.find('.teleop-hero-hit')
    const teleopUndoBtn = wrapper.find('.step-teleop .btn-undo')
    const newCycleBtn = wrapper.find('.step-teleop .btn-new-cycle')

    // Add 2 balls in Cycle #1
    await teleopHitBtn.trigger('click')
    await teleopHitBtn.trigger('click')
    expect(wrapper.find('.step-teleop .cycle-chip').text()).toContain('2')

    // Single step undo: decrements to 1 ball
    await teleopUndoBtn.trigger('click')
    expect(wrapper.find('.step-teleop .cycle-chip').text()).toContain('1')

    // Cut to Cycle #2
    await newCycleBtn.trigger('click')
    expect(wrapper.findAll('.step-teleop .cycle-chip').length).toBe(2)

    // Cycle #2 is currently 0 hits and 0 misses (empty cycle).
    // Tapping UNDO should perform cross-cycle undo: pop empty Cycle #2 and return to Cycle #1!
    await teleopUndoBtn.trigger('click')
    expect(wrapper.findAll('.step-teleop .cycle-chip').length).toBe(1)
    expect(wrapper.find('.step-teleop .cycle-chip').text()).toContain('1')
  })
})
