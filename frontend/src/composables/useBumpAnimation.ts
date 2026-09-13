import { ref } from 'vue'

export type BumpDirection = 'up' | 'down'

export interface BumpState {
  id: string
  dir: BumpDirection
  toggle: boolean
}

function buildBumpKey(arg1: string | number, arg2?: string): string {
  return arg2 !== undefined ? `${arg1}::${arg2}` : String(arg1)
}

/**
 * Provides alternating bump animations ('bump-up-a' / 'bump-up-b', 'bump-down-a' / 'bump-down-b')
 * so rapid consecutive clicks force the browser CSS engine to re-trigger CSS animations on every tap.
 */
export function useBumpAnimation() {
  const lastBump = ref<BumpState | null>(null)
  let bumpToggle = false

  function bump(field: string, dir: BumpDirection): void
  function bump(index: number | string, field: string, dir: BumpDirection): void
  function bump(fieldOrIndex: string | number, dirOrField: BumpDirection | string, dirIfTwo?: BumpDirection) {
    bumpToggle = !bumpToggle
    let key: string
    let direction: BumpDirection

    if (dirIfTwo !== undefined) {
      key = buildBumpKey(fieldOrIndex, dirOrField as string)
      direction = dirIfTwo
    } else {
      key = String(fieldOrIndex)
      direction = dirOrField as BumpDirection
    }

    lastBump.value = { id: key, dir: direction, toggle: bumpToggle }
  }

  function getBumpClass(field: string): string
  function getBumpClass(index: number | string, field?: string): string
  function getBumpClass(fieldOrIndex: string | number, field?: string): string {
    if (!lastBump.value) return ''
    const key = buildBumpKey(fieldOrIndex, field)
    if (lastBump.value.id === key) {
      const variant = lastBump.value.toggle ? 'a' : 'b'
      return lastBump.value.dir === 'up' ? `bump-up-${variant}` : `bump-down-${variant}`
    }
    return ''
  }

  function clearBump(field: string): void
  function clearBump(index: number | string, field?: string): void
  function clearBump(fieldOrIndex: string | number, field?: string): void {
    if (!lastBump.value) return
    const key = buildBumpKey(fieldOrIndex, field)
    if (lastBump.value.id === key) {
      lastBump.value = null
    }
  }

  return {
    lastBump,
    bump,
    getBumpClass,
    clearBump
  }
}
