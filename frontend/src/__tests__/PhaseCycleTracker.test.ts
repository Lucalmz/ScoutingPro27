import { describe, it, expect, vi } from 'vitest'
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

  it('clicking "Record New Cycle" defaults to 0 balls', async () => {
    const wrapper = createWrapper()
    const newCycleBtn = wrapper.find('.btn-action-new-cycle')
    await newCycleBtn.trigger('click')

    // Emits update:modelValue with [0]
    expect(wrapper.emitted('update:modelValue')).toBeTruthy()
    expect(wrapper.emitted('update:modelValue')![0]).toEqual([[0]])
  })

  it('increments balls one by one up to 4, and caps at 4', async () => {
    const wrapper = createWrapper({ modelValue: [0] })
    const plusBtn = wrapper.findAll('.active-cycle-card .counter-btn')[1]!

    // 0 -> 1
    await plusBtn.trigger('click')
    expect(wrapper.emitted('update:modelValue')![0]).toEqual([[1]])

    await wrapper.setProps({ modelValue: [3] })
    // 3 -> 4
    await plusBtn.trigger('click')
    expect(wrapper.emitted('update:modelValue')![1]).toEqual([[4]])

    await wrapper.setProps({ modelValue: [4] })
    // Capped at 4: plus button disabled
    expect(plusBtn.attributes('disabled')).toBeDefined()
    expect(wrapper.find('.cap-badge').exists()).toBe(true)
  })

  it('direct chip selection sets balls directly', async () => {
    const wrapper = createWrapper({ modelValue: [1] })
    const chips = wrapper.findAll('.chip-ball-btn')
    expect(chips.length).toBe(5) // 0, 1, 2, 3, 4

    // Click chip 3
    await chips[3]!.trigger('click')
    expect(wrapper.emitted('update:modelValue')![0]).toEqual([[3]])

    // Click chip 0
    await chips[0]!.trigger('click')
    expect(wrapper.emitted('update:modelValue')![1]).toEqual([[0]])
  })

  it('undo button removes the last cycle', async () => {
    const wrapper = createWrapper({ modelValue: [3, 2] })
    const undoBtn = wrapper.find('.btn-undo-cycle')
    await undoBtn.trigger('click')

    expect(wrapper.emitted('update:modelValue')![0]).toEqual([[3]])
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
    const wrapper = createWrapper({ modelValue: [2, 4] })
    const rows = wrapper.findAll('.cycle-row-item')
    expect(rows.length).toBe(2)

    // First cycle decrement 2 -> 1
    const row0Minus = rows[0]!.find('.mini-counter-btn')
    await row0Minus.trigger('click')
    expect(wrapper.emitted('update:modelValue')![0]).toEqual([[1, 4]])
  })
})
