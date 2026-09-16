import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { useIsMobile } from '../composables/useIsMobile'

const TestComponent = defineComponent({
  setup() {
    const { isMobile } = useIsMobile(768)
    return { isMobile }
  },
  template: '<div id="test">{{ isMobile }}</div>'
})

describe('useIsMobile composable', () => {
  const originalInnerWidth = window.innerWidth

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: originalInnerWidth
    })
  })

  it('detects mobile viewport when innerWidth <= breakpoint', () => {
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 500
    })

    const wrapper = mount(TestComponent)
    expect(wrapper.text()).toBe('true')
  })

  it('detects desktop viewport when innerWidth > breakpoint', () => {
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 1024
    })

    const wrapper = mount(TestComponent)
    expect(wrapper.text()).toBe('false')
  })

  it('reacts dynamically to window resize events', async () => {
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 1024
    })

    const wrapper = mount(TestComponent)
    expect(wrapper.text()).toBe('false')

    // Resize to mobile
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 400
    })
    window.dispatchEvent(new Event('resize'))

    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toBe('true')
  })
})
