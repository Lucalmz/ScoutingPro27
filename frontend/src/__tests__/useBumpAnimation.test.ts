import { describe, it, expect } from 'vitest'
import { useBumpAnimation } from '../composables/useBumpAnimation'

describe('useBumpAnimation composable', () => {
  it('handles single key bump with alternating variants a and b', () => {
    const { bump, getBumpClass, clearBump } = useBumpAnimation()

    expect(getBumpClass('weight')).toBe('')

    // 1st click
    bump('weight', 'up')
    expect(getBumpClass('weight')).toBe('bump-up-a')

    // 2nd click: alternating toggle
    bump('weight', 'up')
    expect(getBumpClass('weight')).toBe('bump-up-b')

    // 3rd click: decrement
    bump('weight', 'down')
    expect(getBumpClass('weight')).toBe('bump-down-a')

    // 4th click: consecutive decrement
    bump('weight', 'down')
    expect(getBumpClass('weight')).toBe('bump-down-b')

    // Clearing clears active class
    clearBump('weight')
    expect(getBumpClass('weight')).toBe('')
  })

  it('handles composite index + field key seamlessly', () => {
    const { bump, getBumpClass, clearBump } = useBumpAnimation()

    bump(0, 'autoBalls', 'up')
    expect(getBumpClass(0, 'autoBalls')).toBe('bump-up-a')
    expect(getBumpClass(1, 'autoBalls')).toBe('')

    bump(0, 'autoBalls', 'down')
    expect(getBumpClass(0, 'autoBalls')).toBe('bump-down-b')

    clearBump(0, 'autoBalls')
    expect(getBumpClass(0, 'autoBalls')).toBe('')
  })
})
