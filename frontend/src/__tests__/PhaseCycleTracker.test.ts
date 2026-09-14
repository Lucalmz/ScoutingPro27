import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import PhaseCycleTracker from '@/components/scouting/PhaseCycleTracker.vue'
import zh from '@/locales/zh.json'

const i18n = createI18n({
  legacy: false,
  locale: 'zh',
  messages: { zh }
})

describe('PhaseCycleTracker.vue', () => {
  const createWrapper = (props = {}) => {
    return mount(PhaseCycleTracker, {
      props: {
        phase: 'auto',
        title: '自动阶段',
        icon: 'smart_toy',
        rateText: '+3 分/球',
        modelValue: [],
        missedValue: [],
        ...props
      },
      global: {
        plugins: [i18n]
      }
    })
  }

  it('renders header, icon, and rate capsule correctly', () => {
    const wrapper = createWrapper()
    expect(wrapper.find('.tracker-title').text()).toBe('自动阶段')
    expect(wrapper.find('.tracker-icon').text()).toBe('smart_toy')
    expect(wrapper.find('.rate-capsule').text()).toBe('+3 分/球')
    expect(wrapper.find('.cycle-empty-hint').exists()).toBe(true)
  })

  it('clicking "Record New Cycle" defaults to 0 balls when empty', async () => {
    const wrapper = createWrapper()
    const newCycleBtn = wrapper.find('.btn-action-new-cycle')
    expect(newCycleBtn.attributes('disabled')).toBeUndefined()
    await newCycleBtn.trigger('click')

    // Emits update:modelValue with [0] and update:missedValue with [0]
    expect(wrapper.emitted('update:modelValue')).toBeTruthy()
    expect(wrapper.emitted('update:modelValue')![0]).toEqual([[0]])
    expect(wrapper.emitted('update:missedValue')![0]).toEqual([[0]])
  })

  it('disallows starting a new cycle when current cycle has 0 balls', async () => {
    const wrapper = createWrapper({ modelValue: [0], missedValue: [0] })
    const newCycleBtn = wrapper.find('.btn-action-new-cycle')

    // Disabled when current attempts is 0
    expect(newCycleBtn.attributes('disabled')).toBeDefined()
    expect(wrapper.find('.empty-block-hint').exists()).toBe(true)

    // Triggering click should not emit new cycle
    await newCycleBtn.trigger('click')
    expect(wrapper.emitted('update:modelValue')).toBeFalsy()

    // When current cycle has at least 1 shot (hit or miss), new cycle button becomes enabled
    await wrapper.setProps({ modelValue: [1], missedValue: [0] })
    expect(wrapper.find('.btn-action-new-cycle').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('.empty-block-hint').exists()).toBe(false)

    await wrapper.find('.btn-action-new-cycle').trigger('click')
    expect(wrapper.emitted('update:modelValue')![0]).toEqual([[1, 0]])
  })

  it('blind touchpad: HIT button adds scored ball, MISS button adds missed ball', async () => {
    const wrapper = createWrapper({ modelValue: [0], missedValue: [0] })
    const hitBtn = wrapper.find('.pad-hit-btn')
    const missBtn = wrapper.find('.pad-miss-btn')

    // HIT: 0 -> 1
    await hitBtn.trigger('click')
    expect(wrapper.emitted('update:modelValue')![0]).toEqual([[1]])

    // MISS: 0 -> 1
    await missBtn.trigger('click')
    expect(wrapper.emitted('update:missedValue')![0]).toEqual([[1]])
  })

  it('blind touchpad: initial touch when cycles is empty creates first cycle', async () => {
    const wrapperHit = createWrapper({ modelValue: [], missedValue: [] })
    await wrapperHit.find('.pad-hit-btn').trigger('click')
    expect(wrapperHit.emitted('update:modelValue')![0]).toEqual([[1]])
    expect(wrapperHit.emitted('update:missedValue')![0]).toEqual([[0]])

    const wrapperMiss = createWrapper({ modelValue: [], missedValue: [] })
    await wrapperMiss.find('.pad-miss-btn').trigger('click')
    expect(wrapperMiss.emitted('update:modelValue')![0]).toEqual([[0]])
    expect(wrapperMiss.emitted('update:missedValue')![0]).toEqual([[1]])
  })

  it('blind touchpad: caps at 4 attempts total in current cycle', async () => {
    // 3 hits, 1 miss = 4 attempts total
    const wrapper = createWrapper({ modelValue: [3], missedValue: [1] })
    const hitBtn = wrapper.find('.pad-hit-btn')
    const missBtn = wrapper.find('.pad-miss-btn')

    expect(hitBtn.attributes('disabled')).toBeDefined()
    expect(missBtn.attributes('disabled')).toBeDefined()
    expect(wrapper.find('.cap-badge').exists()).toBe(true)

    // New cycle button is suggested when capped at 4
    expect(wrapper.find('.btn-action-new-cycle').classes()).toContain('is-suggested')
  })

  it('calculates KPI statistics and accuracy correctly', () => {
    // Cycle 1: 3 hits, 1 miss; Cycle 2: 1 hit, 1 miss -> Total: 4 hits, 2 misses (6 attempts) -> 67%
    const wrapper = createWrapper({
      modelValue: [3, 1],
      missedValue: [1, 1]
    })

    const kpiCards = wrapper.findAll('.kpi-card')
    expect(kpiCards.length).toBe(4)
    expect(kpiCards[0]!.find('.kpi-num').text()).toBe('2') // total cycles
    expect(kpiCards[1]!.find('.kpi-num').text()).toBe('4') // total scored
    expect(kpiCards[2]!.find('.kpi-num').text()).toBe('2') // total missed
    expect(kpiCards[3]!.find('.kpi-num').text()).toBe('67%') // accuracy
    expect(kpiCards[3]!.classes()).toContain('accuracy-medium')
  })

  it('increments balls with stepper and direct chip selection', async () => {
    const wrapper = createWrapper({ modelValue: [0] })
    const plusBtn = wrapper.findAll('.active-cycle-card .counter-btn')[1]!

    // 0 -> 1
    await plusBtn.trigger('click')
    expect(wrapper.emitted('update:modelValue')![0]).toEqual([[1]])

    // Chips
    const chips = wrapper.findAll('.chip-ball-btn')
    expect(chips.length).toBe(5) // 0, 1, 2, 3, 4
    await chips[3]!.trigger('click')
    expect(wrapper.emitted('update:modelValue')![1]).toEqual([[3]])
  })

  it('undo action: steps back single shot first, removes cycle when empty', async () => {
    // Current cycle has 2 balls: clicking undo decrements 2 -> 1
    const wrapper = createWrapper({ modelValue: [3, 2], missedValue: [0, 0] })
    const undoBtn = wrapper.find('.btn-undo-cycle')
    await undoBtn.trigger('click')
    expect(wrapper.emitted('update:modelValue')![0]).toEqual([[3, 1]])

    // Empty cycle: clicking undo removes the cycle
    const emptyWrapper = createWrapper({ modelValue: [3, 0], missedValue: [0, 0] })
    await emptyWrapper.find('.btn-undo-cycle').trigger('click')
    expect(emptyWrapper.emitted('update:modelValue')![0]).toEqual([[3]])
  })

  it('toggles expand/collapse when cycle count exceeds 3', async () => {
    const wrapper = createWrapper({ modelValue: [2, 3, 1, 4] })
    const toggleBtn = wrapper.find('.btn-toggle-expand')
    expect(toggleBtn.exists()).toBe(true)

    const scrollContainer = wrapper.find('.cycles-scroll-container')
    expect(scrollContainer.classes()).not.toContain('is-expanded')

    await toggleBtn.trigger('click')
    expect(scrollContainer.classes()).toContain('is-expanded')

    await toggleBtn.trigger('click')
    expect(scrollContainer.classes()).not.toContain('is-expanded')
  })

  it('supports inline editing of past cycles', async () => {
    const wrapper = createWrapper({ modelValue: [2, 4], missedValue: [0, 0] })
    const rows = wrapper.findAll('.cycle-row-item')
    expect(rows.length).toBe(2)

    // First cycle decrement 2 -> 1
    const row0Minus = rows[0]!.find('.mini-counter-btn')
    await row0Minus.trigger('click')
    expect(wrapper.emitted('update:modelValue')![0]).toEqual([[1, 4]])
  })
})
