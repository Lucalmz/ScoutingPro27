import { mount } from '@vue/test-utils'
import { describe, it, expect, vi } from 'vitest'
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
  it('renders boolean field and emits update:modelValue on click', async () => {
    const field = createField({ fieldType: 'boolean', fieldKey: 'is_super' })
    const wrapper = mount(DynamicFieldsRenderer, {
      props: {
        definitions: [field],
        modelValue: { is_super: false }
      }
    })

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

    const wrapper = mount(DynamicFieldsRenderer, {
      props: {
        definitions: [field],
        modelValue: { cycle_count: 3 }
      }
    })

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

    const wrapper = mount(DynamicFieldsRenderer, {
      props: {
        definitions: [field],
        modelValue: { defense_rating: 2 }
      }
    })

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

    const wrapper = mount(DynamicFieldsRenderer, {
      props: {
        definitions: [field],
        modelValue: { intake_type: 'roller' }
      }
    })

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

    const wrapper = mount(DynamicFieldsRenderer, {
      props: {
        definitions: [field],
        modelValue: { auto_routes: ['left'] }
      }
    })

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

    const wrapper = mount(DynamicFieldsRenderer, {
      props: {
        definitions: [field],
        modelValue: { custom_notes: 'Initial' }
      }
    })

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
    const wrapperMin = mount(DynamicFieldsRenderer, {
      props: { definitions: [field], modelValue: { score: 0 } }
    })
    const minusBtn = wrapperMin.find('.stepper-btn.btn-dec')
    await minusBtn.trigger('click')
    // Value does not go below minVal
    expect(wrapperMin.emitted('update:modelValue')).toBeFalsy()

    // At maxVal (5)
    const wrapperMax = mount(DynamicFieldsRenderer, {
      props: { definitions: [field], modelValue: { score: 5 } }
    })
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

    const wrapper = mount(DynamicFieldsRenderer, {
      props: { definitions: [field], modelValue: { cycle_time: 0.2 } }
    })
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

    const wrapper = mount(DynamicFieldsRenderer, {
      props: { definitions: [field], modelValue: { auto_balls: 2 } }
    })
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
    const wrapperOpt = mount(DynamicFieldsRenderer, {
      props: { definitions: [optionalLevelField], modelValue: { rating_opt: 3 } }
    })
    const optButtons = wrapperOpt.findAll('.level-tick-btn')
    await optButtons[2].trigger('click') // index 2 is level 3
    expect(wrapperOpt.emitted('update:modelValue')?.[0][0]).toEqual({ rating_opt: 0 })

    // Required field: clicking currently selected level 3 stays 3
    const wrapperReq = mount(DynamicFieldsRenderer, {
      props: { definitions: [requiredLevelField], modelValue: { rating_req: 3 } }
    })
    const reqButtons = wrapperReq.findAll('.level-tick-btn')
    await reqButtons[2].trigger('click')
    expect(wrapperReq.emitted('update:modelValue')?.[0][0]).toEqual({ rating_req: 3 })
  })

  it('level rating: dynamically clamps tick counts between 3 and 7', () => {
    // maxVal: 1 -> clamped to min 3
    const wrapperSmall = mount(DynamicFieldsRenderer, {
      props: {
        definitions: [createField({ fieldType: 'level', fieldKey: 'lvl1', maxVal: 1 })],
        modelValue: {}
      }
    })
    expect(wrapperSmall.findAll('.level-tick-btn')).toHaveLength(3)

    // maxVal: 10 -> clamped to max 7
    const wrapperLarge = mount(DynamicFieldsRenderer, {
      props: {
        definitions: [createField({ fieldType: 'level', fieldKey: 'lvl2', maxVal: 10 })],
        modelValue: {}
      }
    })
    expect(wrapperLarge.findAll('.level-tick-btn')).toHaveLength(7)
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
    const wrapperOpt = mount(DynamicFieldsRenderer, {
      props: { definitions: [optField], modelValue: { opt_test: 'opt_a' } }
    })
    await wrapperOpt.find('.capsule-chip').trigger('click')
    expect(wrapperOpt.emitted('update:modelValue')?.[0][0]).toEqual({ opt_test: null })

    // Required: clicking active option retains opt_a
    const wrapperReq = mount(DynamicFieldsRenderer, {
      props: { definitions: [reqField], modelValue: { req_test: 'opt_a' } }
    })
    await wrapperReq.find('.capsule-chip').trigger('click')
    expect(wrapperReq.emitted('update:modelValue')?.[0][0]).toEqual({ req_test: 'opt_a' })
  })

  it('multi-select: initializes array when starting from undefined', async () => {
    const field = createField({
      fieldType: 'multi_select',
      fieldKey: 'tags',
      options: [{ label: 'Tag 1', value: 'tag1' }]
    })

    const wrapper = mount(DynamicFieldsRenderer, {
      props: { definitions: [field], modelValue: {} }
    })
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

    const wrapper = mount(DynamicFieldsRenderer, {
      props: { definitions: [fieldWithUnitAndReq, fieldWithout], modelValue: {} }
    })

    const items = wrapper.findAll('.dynamic-field-item')
    // Item 0 has required star and unit badge
    expect(items[0].find('.required-star').exists()).toBe(true)
    expect(items[0].find('.field-unit-badge').text()).toBe('psi')

    // Item 1 has no required star and no unit badge
    expect(items[1].find('.required-star').exists()).toBe(false)
    expect(items[1].find('.field-unit-badge').exists()).toBe(false)
  })

  it('renders empty container gracefully when definitions is empty array', () => {
    const wrapper = mount(DynamicFieldsRenderer, {
      props: { definitions: [], modelValue: {} }
    })
    expect(wrapper.find('.dynamic-custom-fields').exists()).toBe(false)
  })
})
