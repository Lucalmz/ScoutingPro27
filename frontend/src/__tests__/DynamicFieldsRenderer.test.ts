import { mount, type VueWrapper } from '@vue/test-utils'
import { describe, it, expect, vi, afterEach } from 'vitest'
import DynamicFieldsRenderer from '../components/customFields/DynamicFieldsRenderer.vue'
import type { CustomFieldDefinition } from '../types'

vi.mock('@/utils/haptics', () => ({
  hapticSelection: vi.fn(),
  hapticMedium: vi.fn(),
  hapticLight: vi.fn()
}))

const createField = (overrides: Partial<CustomFieldDefinition>): CustomFieldDefinition => ({
  id: 'f1',
  eventId: 'e1',
  target: 'MATCH',
  phase: 'teleop',
  name: 'Test Field',
  fieldKey: 'test_key',
  fieldType: 'boolean',
  required: false,
  options: [],
  orderSeq: 0,
  isActive: true,
  createdAt: '2026-09-15T00:00:00Z',
  updatedAt: '2026-09-15T00:00:00Z',
  ...overrides
})

describe('DynamicFieldsRenderer.vue', () => {
  const wrappers: VueWrapper<any>[] = []
  const track = <T extends VueWrapper<any>>(w: T): T => {
    wrappers.push(w)
    return w
  }

  afterEach(() => {
    while (wrappers.length) wrappers.pop()!.unmount()
  })

  it('renders boolean field and emits update:modelValue on click', async () => {
    const field = createField({ fieldType: 'boolean', fieldKey: 'is_super' })
    const wrapper = track(mount(DynamicFieldsRenderer, {
      props: {
        definitions: [field],
        modelValue: { is_super: false }
      }
    }))

    const toggleCard = wrapper.find('.boolean-toggle-card')
    expect(toggleCard.exists()).toBe(true)
    expect(toggleCard.classes()).not.toContain('is-active')

    await toggleCard.trigger('click')
    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toEqual({ is_super: true })
  })

  it('renders number stepper and increments/decrements value', async () => {
    const field = createField({
      fieldType: 'number',
      fieldKey: 'cycle_count',
      minVal: 0,
      maxVal: 10,
      stepVal: 1
    })

    const wrapper = track(mount(DynamicFieldsRenderer, {
      props: {
        definitions: [field],
        modelValue: { cycle_count: 3 }
      }
    }))

    const plusBtn = wrapper.find('.stepper-btn.btn-inc')
    const minusBtn = wrapper.find('.stepper-btn.btn-dec')
    expect(plusBtn.exists()).toBe(true)
    expect(minusBtn.exists()).toBe(true)

    // Click plus
    await plusBtn.trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0][0]).toEqual({ cycle_count: 4 })

    // Click minus
    await minusBtn.trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[1][0]).toEqual({ cycle_count: 2 })
  })

  it('renders level rating buttons (1-5) and emits selected level', async () => {
    const field = createField({
      fieldType: 'level',
      fieldKey: 'defense_rating',
      maxVal: 5
    })

    const wrapper = track(mount(DynamicFieldsRenderer, {
      props: {
        definitions: [field],
        modelValue: { defense_rating: 2 }
      }
    }))

    const buttons = wrapper.findAll('.level-tick-btn')
    expect(buttons).toHaveLength(5)
    expect(buttons[1].classes()).toContain('is-active') // index 1 is level 2

    // Click level 4
    await buttons[3].trigger('click')
    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toEqual({ defense_rating: 4 })
  })

  it('renders select option pills and handles single selection', async () => {
    const field = createField({
      fieldType: 'select',
      fieldKey: 'intake_type',
      options: [
        { label: 'Roller', value: 'roller', color: 'blue' },
        { label: 'Claw', value: 'claw', color: 'green' }
      ]
    })

    const wrapper = track(mount(DynamicFieldsRenderer, {
      props: {
        definitions: [field],
        modelValue: { intake_type: 'roller' }
      }
    }))

    const pills = wrapper.findAll('.capsule-chip')
    expect(pills).toHaveLength(2)
    expect(pills[0].classes()).toContain('is-selected')

    // Click second pill (claw)
    await pills[1].trigger('click')
    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toEqual({ intake_type: 'claw' })
  })

  it('renders multi-select option tags and toggles items in array', async () => {
    const field = createField({
      fieldType: 'multi_select',
      fieldKey: 'auto_routes',
      options: [
        { label: 'Left', value: 'left', color: 'blue' },
        { label: 'Center', value: 'center', color: 'green' },
        { label: 'Right', value: 'right', color: 'orange' }
      ]
    })

    const wrapper = track(mount(DynamicFieldsRenderer, {
      props: {
        definitions: [field],
        modelValue: { auto_routes: ['left'] }
      }
    }))

    const tags = wrapper.findAll('.tag-flow-badge')
    expect(tags).toHaveLength(3)
    expect(tags[0].classes()).toContain('is-selected')
    expect(tags[1].classes()).not.toContain('is-selected')

    // Click 'center' to add
    await tags[1].trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0][0]).toEqual({
      auto_routes: ['left', 'center']
    })

    // Click 'left' to remove
    await tags[0].trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[1][0]).toEqual({
      auto_routes: []
    })
  })

  it('renders text input and emits typed text', async () => {
    const field = createField({
      fieldType: 'text',
      fieldKey: 'custom_notes'
    })

    const wrapper = track(mount(DynamicFieldsRenderer, {
      props: {
        definitions: [field],
        modelValue: { custom_notes: 'Initial' }
      }
    }))

    const input = wrapper.find('.dynamic-textarea')
    expect(input.exists()).toBe(true)

    await input.setValue('Updated observation')
    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toEqual({ custom_notes: 'Updated observation' })
  })

  it('clamps number stepper at minVal and maxVal', async () => {
    const field = createField({
      fieldType: 'number',
      fieldKey: 'score',
      minVal: 0,
      maxVal: 5,
      stepVal: 1
    })

    // At minVal (0)
    const wrapperMin = track(mount(DynamicFieldsRenderer, {
      props: { definitions: [field], modelValue: { score: 0 } }
    }))
    const minusBtn = wrapperMin.find('.stepper-btn.btn-dec')
    await minusBtn.trigger('click')
    // Value does not go below minVal
    expect(wrapperMin.emitted('update:modelValue')).toBeFalsy()

    // At maxVal (5)
    const wrapperMax = track(mount(DynamicFieldsRenderer, {
      props: { definitions: [field], modelValue: { score: 5 } }
    }))
    const plusBtn = wrapperMax.find('.stepper-btn.btn-inc')
    await plusBtn.trigger('click')
    // Value does not exceed maxVal
    expect(wrapperMax.emitted('update:modelValue')).toBeFalsy()
  })

  it('handles decimal stepVal without floating point inaccuracies', async () => {
    const field = createField({
      fieldType: 'number',
      fieldKey: 'cycle_time',
      minVal: 0,
      maxVal: 10,
      stepVal: 0.1
    })

    const wrapper = track(mount(DynamicFieldsRenderer, {
      props: { definitions: [field], modelValue: { cycle_time: 0.2 } }
    }))
    await wrapper.find('.stepper-btn.btn-inc').trigger('click')

    // 0.2 + 0.1 = 0.3 (not 0.30000000000000004)
    expect(wrapper.emitted('update:modelValue')?.[0][0]).toEqual({ cycle_time: 0.3 })
  })

  it('handles direct number input with out-of-bounds clamping and NaN fallback', async () => {
    const field = createField({
      fieldType: 'number',
      fieldKey: 'auto_balls',
      minVal: 0,
      maxVal: 10
    })

    const wrapper = track(mount(DynamicFieldsRenderer, {
      props: { definitions: [field], modelValue: { auto_balls: 2 } }
    }))
    const input = wrapper.find('.stepper-input')

    // 1. Enter value above maxVal (15) -> clamps to 10
    ;(input.element as HTMLInputElement).value = '15'
    await input.trigger('change')
    expect(wrapper.emitted('update:modelValue')?.[0][0]).toEqual({ auto_balls: 10 })

    // 2. Enter value below minVal (-5) -> clamps to 0
    ;(input.element as HTMLInputElement).value = '-5'
    await input.trigger('change')
    expect(wrapper.emitted('update:modelValue')?.[1][0]).toEqual({ auto_balls: 0 })

    // 3. Enter non-numeric text -> falls back to minVal (0)
    ;(input.element as HTMLInputElement).value = 'invalid_number'
    await input.trigger('change')
    expect(wrapper.emitted('update:modelValue')?.[2][0]).toEqual({ auto_balls: 0 })
  })

  it('level rating: toggles off to 0 when not required, but preserves selection when required', async () => {
    const optionalLevelField = createField({
      fieldType: 'level',
      fieldKey: 'rating_opt',
      required: false,
      maxVal: 5
    })
    const requiredLevelField = createField({
      fieldType: 'level',
      fieldKey: 'rating_req',
      required: true,
      maxVal: 5
    })

    // Optional field: clicking currently selected level 3 sets to 0
    const wrapperOpt = track(mount(DynamicFieldsRenderer, {
      props: { definitions: [optionalLevelField], modelValue: { rating_opt: 3 } }
    }))
    const optButtons = wrapperOpt.findAll('.level-tick-btn')
    await optButtons[2].trigger('click') // index 2 is level 3
    expect(wrapperOpt.emitted('update:modelValue')?.[0][0]).toEqual({ rating_opt: 0 })

    // Required field: clicking currently selected level 3 stays 3
    const wrapperReq = track(mount(DynamicFieldsRenderer, {
      props: { definitions: [requiredLevelField], modelValue: { rating_req: 3 } }
    }))
    const reqButtons = wrapperReq.findAll('.level-tick-btn')
    await reqButtons[2].trigger('click')
    expect(wrapperReq.emitted('update:modelValue')?.[0][0]).toEqual({ rating_req: 3 })
  })

  it('level rating: dynamically clamps tick counts between 3 and 10', () => {
    // maxVal: 1 -> clamped to min 3
    const wrapperSmall = track(mount(DynamicFieldsRenderer, {
      props: {
        definitions: [createField({ fieldType: 'level', fieldKey: 'lvl1', maxVal: 1 })],
        modelValue: {}
      }
    }))
    expect(wrapperSmall.findAll('.level-tick-btn')).toHaveLength(3)

    // maxVal: 15 -> clamped to max 10
    const wrapperLarge = track(mount(DynamicFieldsRenderer, {
      props: {
        definitions: [createField({ fieldType: 'level', fieldKey: 'lvl2', maxVal: 15 })],
        modelValue: {}
      }
    }))
    expect(wrapperLarge.findAll('.level-tick-btn')).toHaveLength(10)
  })

  it('select capsule: toggles off to null when not required, but preserves selection when required', async () => {
    const optField = createField({
      fieldType: 'select',
      fieldKey: 'opt_test',
      required: false,
      options: [{ label: 'Opt A', value: 'opt_a' }]
    })
    const reqField = createField({
      fieldType: 'select',
      fieldKey: 'req_test',
      required: true,
      options: [{ label: 'Opt A', value: 'opt_a' }]
    })

    // Optional: clicking active option deselects to null
    const wrapperOpt = track(mount(DynamicFieldsRenderer, {
      props: { definitions: [optField], modelValue: { opt_test: 'opt_a' } }
    }))
    await wrapperOpt.find('.capsule-chip').trigger('click')
    expect(wrapperOpt.emitted('update:modelValue')?.[0][0]).toEqual({ opt_test: null })

    // Required: clicking active option retains opt_a
    const wrapperReq = track(mount(DynamicFieldsRenderer, {
      props: { definitions: [reqField], modelValue: { req_test: 'opt_a' } }
    }))
    await wrapperReq.find('.capsule-chip').trigger('click')
    expect(wrapperReq.emitted('update:modelValue')?.[0][0]).toEqual({ req_test: 'opt_a' })
  })

  it('multi-select: initializes array when starting from undefined', async () => {
    const field = createField({
      fieldType: 'multi_select',
      fieldKey: 'tags',
      options: [{ label: 'Tag 1', value: 'tag1' }]
    })

    const wrapper = track(mount(DynamicFieldsRenderer, {
      props: { definitions: [field], modelValue: {} }
    }))
    await wrapper.find('.tag-flow-badge').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0][0]).toEqual({ tags: ['tag1'] })
  })

  it('renders required star and unit badge conditionally', () => {
    const fieldWithUnitAndReq = createField({
      name: 'Pressure',
      required: true,
      unit: 'psi',
      fieldType: 'number',
      fieldKey: 'pressure'
    })
    const fieldWithout = createField({
      name: 'Simple',
      required: false,
      unit: undefined,
      fieldType: 'number',
      fieldKey: 'simple'
    })

    const wrapper = track(mount(DynamicFieldsRenderer, {
      props: { definitions: [fieldWithUnitAndReq, fieldWithout], modelValue: {} }
    }))

    const items = wrapper.findAll('.dynamic-field-item')
    // Item 0 has required star and unit badge
    expect(items[0].find('.required-star').exists()).toBe(true)
    expect(items[0].find('.field-unit-badge').text()).toBe('psi')

    // Item 1 has no required star and no unit badge
    expect(items[1].find('.required-star').exists()).toBe(false)
    expect(items[1].find('.field-unit-badge').exists()).toBe(false)
  })

  it('renders empty container gracefully when definitions is empty array', () => {
    const wrapper = track(mount(DynamicFieldsRenderer, {
      props: { definitions: [], modelValue: {} }
    }))
    expect(wrapper.find('.dynamic-custom-fields').exists()).toBe(false)
  })

  it('renders number slider, counter, quickSteps, and initializes defaultVal', async () => {
    const sliderField = createField({
      fieldType: 'number',
      fieldKey: 'slider_val',
      minVal: 0,
      maxVal: 100,
      defaultVal: '25',
      configJson: JSON.stringify({ inputMode: 'slider', showTicks: true })
    })
    const counterField = createField({
      id: 'f2',
      fieldType: 'number',
      fieldKey: 'counter_val',
      stepVal: 2,
      configJson: JSON.stringify({ inputMode: 'counter' })
    })
    const quickField = createField({
      id: 'f3',
      fieldType: 'number',
      fieldKey: 'quick_val',
      configJson: JSON.stringify({ inputMode: 'stepper', quickSteps: [5] })
    })

    const wrapper = track(mount(DynamicFieldsRenderer, {
      props: {
        definitions: [sliderField, counterField, quickField],
        modelValue: { counter_val: 0, quick_val: 10 }
      }
    }))

    // defaultVal emitted for slider_val
    expect(wrapper.emitted('update:modelValue')?.[0][0]).toMatchObject({ slider_val: 25 })
    expect(wrapper.find('.slider-ticks').exists()).toBe(true)

    await wrapper.find('.counter-plus-btn').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[1][0]).toMatchObject({ counter_val: 2 })

    await wrapper.find('.quick-step-btn.is-inc').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[2][0]).toMatchObject({ quick_val: 15 })
  })

  it('timer stopwatch uses Date.now delta and flushes running elapsed seconds on unmount before cancelling RAF', async () => {
    vi.useFakeTimers()
    let now = 1_700_000_000_000
    vi.setSystemTime(now)

    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 42)
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})

    try {
      const timerField = createField({
        fieldType: 'timer',
        fieldKey: 'align_sec',
        unit: 's'
      })

      const wrapper = mount(DynamicFieldsRenderer, {
        props: {
          definitions: [timerField],
          modelValue: {}
        }
      })

      await wrapper.find('.timer-btn-start').trigger('click')
      expect(rafSpy).toHaveBeenCalled()

      // Simulate 3.45s wall-clock elapsed (even if mobile slept)
      now += 3450
      vi.setSystemTime(now)

      wrapper.unmount()
      const emitted = wrapper.emitted('update:modelValue')
      expect(emitted).toBeTruthy()
      const lastPayload = emitted![emitted!.length - 1][0] as Record<string, any>
      expect(lastPayload.align_sec).toBeCloseTo(3.45, 2)
      expect(cancelSpy).toHaveBeenCalledWith(42)
    } finally {
      rafSpy.mockRestore()
      cancelSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('renders tristate boolean, dropdown select with numericValue, and live formula preview with cycle detection', async () => {
    const triField = createField({
      id: 'b1',
      fieldType: 'boolean',
      fieldKey: 'tri_bool',
      description: 'Three-state toggle',
      configJson: JSON.stringify({ tristate: true, trueLabel: 'Yes!', falseLabel: 'No!' })
    })
    const dropField = createField({
      id: 's1',
      fieldType: 'select',
      fieldKey: 'def_tier',
      configJson: JSON.stringify({ selectStyle: 'dropdown' }),
      options: [
        { label: 'Strong', value: 'strong', numericValue: 7 }
      ]
    })
    const formulaField = createField({
      id: 'fm1',
      fieldType: 'formula',
      fieldKey: 'calc_bonus',
      formulaExpr: 'ROUND(cf.def_tier * 2, 1)',
      displayFormat: 'number'
    })
    const cyclicField = createField({
      id: 'fm2',
      fieldType: 'formula',
      fieldKey: 'loop_a',
      formulaExpr: 'formula.loop_a + 1'
    })

    const wrapper = track(mount(DynamicFieldsRenderer, {
      props: {
        definitions: [triField, dropField, formulaField, cyclicField],
        modelValue: { def_tier: 'strong' }
      }
    }))

    expect(wrapper.find('.field-description').text()).toBe('Three-state toggle')
    const triBtns = wrapper.findAll('.tristate-btn')
    expect(triBtns).toHaveLength(3)
    await triBtns[2]!.trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0][0]).toMatchObject({ tri_bool: false })

    expect(wrapper.find('.dynamic-select-dropdown').exists()).toBe(true)
    expect(wrapper.find('.formula-result-value').text()).toBe('14')
    expect(wrapper.find('.formula-error-badge.is-cycle').exists()).toBe(true)
  })

  it('rejects trailing non-numeric characters in onNumberInput and isolates cross-target formula previews', async () => {
    const numField = createField({
      id: 'n1',
      target: 'MATCH',
      fieldType: 'number',
      fieldKey: 'balls',
      minVal: 0,
      maxVal: 10,
      defaultVal: '3',
      configJson: JSON.stringify({ inputMode: 'direct' })
    })
    const matchFormula = createField({
      id: 'mf1',
      target: 'MATCH',
      fieldType: 'formula',
      fieldKey: 'shared_score',
      formulaExpr: 'cf.balls * 2'
    })
    const teamFormula = createField({
      id: 'tf1',
      target: 'TEAM',
      fieldType: 'formula',
      fieldKey: 'shared_score',
      formulaExpr: 'opr.np + 100'
    })

    const wrapper = track(mount(DynamicFieldsRenderer, {
      props: {
        definitions: [numField, matchFormula],
        allDefinitions: [numField, matchFormula, teamFormula],
        modelValue: { balls: 4 },
        formulaContext: { opr: { np: 50 } }
      }
    }))

    // Cross-target TEAM formula with same fieldKey must NOT overwrite MATCH formula result (4 * 2 = 8)
    expect(wrapper.find('.formula-result-value').text()).toBe('8')

    // Trailing garbage like "12abc" must fall back to clamped default (3) instead of parseFloat -> 10
    const input = wrapper.find('.direct-number-input')
    await input.setValue('12abc')
    await input.trigger('change')
    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    expect(emitted![emitted!.length - 1]![0]).toMatchObject({ balls: 3 })
  })
})
