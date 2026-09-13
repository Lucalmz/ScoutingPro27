import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import ScoutingForm from '../components/scouting/ScoutingForm.vue'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      scouting: {
        mode: 'Mode',
        single_team: 'Single',
        alliance: 'Alliance',
        alliance_color: 'Color',
        red: 'Red',
        blue: 'Blue',
        match_info: 'Match Info',
        match_number: 'Match #',
        team_number: 'Team #',
        autonomous: 'Autonomous',
        auto_leave: 'Leave',
        auto_balls: 'Auto Balls',
        auto_balls_rate: '+3 pts/ball',
        auto_preload: 'Preload',
        auto_secondary: 'Secondary',
        auto_park: 'Park',
        teleop: 'TeleOp',
        cycle_tracker_title: 'Cycle Tracker',
        btn_new_cycle: '+ New Cycle',
        btn_cycle_tapping: 'Cycle #{num}: {count} balls (Tap +1)',
        btn_add_ball: '+1 Ball',
        btn_undo_cycle: 'Undo',
        cycle_num: 'Cycle #{num}',
        balls_unit: '{count} balls',
        total_cycles: 'Total Cycles',
        total_balls: 'Total Balls',
        avg_balls_per_cycle: 'Avg Balls/Cycle',
        unit_cycles: 'Cycles',
        unit_balls: 'Balls',
        endgame: 'Endgame',
        flower_placed: 'Flower',
        flower_bottom_bonus: 'Bonus',
        teleop_park: 'Park',
        is_broken: 'Broken',
        notes: 'Notes',
        notes_placeholder: 'Notes...',
        total_score: 'Total',
        submit: 'Submit',
        saving: 'Saving'
      },
      schedule: {
        assigned_task_hint: 'Task hint',
        btn_load_task: 'Load'
      }
    }
  }
})

describe('ScoutingForm Counter Animations', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('triggers alternating bump animations on consecutive clicks so every click animates', async () => {
    const wrapper = mount(ScoutingForm, {
      props: {
        eventId: 'evt_1',
        scoutId: 'scout_1',
        scoutName: 'Tester'
      },
      global: {
        plugins: [i18n],
        stubs: {
          TagPicker: true,
          PitStatusIndicator: true
        }
      }
    })

    // Click "+ New Cycle" to add the first cycle (defaults to 0 balls)
    const newCycleBtn = wrapper.find('.btn-action-new-cycle')
    expect(newCycleBtn.exists()).toBe(true)
    await newCycleBtn.trigger('click')

    // Find the counter field for the active cycle
    const patternVal = wrapper.find('.active-cycle-card .counter-val')
    expect(patternVal.exists()).toBe(true)
    expect(patternVal.text()).toBe('0')

    // Find the buttons for the active cycle
    const incrementBtns = wrapper.findAll('.active-cycle-card .counter-btn')
    const plusBtn = incrementBtns[1] // The second button is "+"
    expect(plusBtn.text()).toBe('+')

    // 1st click (0 -> 1)
    await plusBtn.trigger('click')
    expect(patternVal.text()).toBe('1')
    expect(patternVal.classes()).toContain('bump-up-a')

    // 2nd consecutive click (WITHOUT waiting or animationend)
    await plusBtn.trigger('click')
    expect(patternVal.text()).toBe('2')
    // Must alternate to bump-up-b so the CSS engine re-triggers the animation!
    expect(patternVal.classes()).toContain('bump-up-b')
    expect(patternVal.classes()).not.toContain('bump-up-a')

    // 3rd consecutive click (2 -> 3)
    await plusBtn.trigger('click')
    expect(patternVal.text()).toBe('3')
    expect(patternVal.classes()).toContain('bump-up-a')
    expect(patternVal.classes()).not.toContain('bump-up-b')

    // When animationend fires, class is cleaned up
    await patternVal.trigger('animationend')
    expect(patternVal.classes()).not.toContain('bump-up-a')
    expect(patternVal.classes()).not.toContain('bump-up-b')

    // Click decrement "-"
    const minusBtn = incrementBtns[0]
    expect(minusBtn.text()).toBe('-')
    await minusBtn.trigger('click')
    expect(patternVal.text()).toBe('2')
    expect(patternVal.classes()).toContain('bump-down-b')

    // Consecutive decrement click
    await minusBtn.trigger('click')
    expect(patternVal.text()).toBe('1')
    expect(patternVal.classes()).toContain('bump-down-a')
  })

  it('triggers alternating bump animations on autoBalls increment and decrement', async () => {
    const wrapper = mount(ScoutingForm, {
      props: {
        eventId: 'evt_1',
        scoutId: 'scout_1',
        scoutName: 'Tester'
      },
      global: {
        plugins: [i18n],
        stubs: {
          TagPicker: true,
          PitStatusIndicator: true
        }
      }
    })

    const autoVal = wrapper.find('.auto-stepper .counter-val')
    expect(autoVal.exists()).toBe(true)
    expect(autoVal.text()).toBe('0')

    const autoBtns = wrapper.findAll('.auto-stepper .counter-btn')
    const autoMinus = autoBtns[0]
    const autoPlus = autoBtns[1]

    // 1st click
    await autoPlus.trigger('click')
    expect(autoVal.text()).toBe('1')
    expect(autoVal.classes()).toContain('bump-up-a')

    // 2nd consecutive click
    await autoPlus.trigger('click')
    expect(autoVal.text()).toBe('2')
    expect(autoVal.classes()).toContain('bump-up-b')

    // Decrement
    await autoMinus.trigger('click')
    expect(autoVal.text()).toBe('1')
    expect(autoVal.classes().some(c => c.startsWith('bump-down-'))).toBe(true)
  })
})
