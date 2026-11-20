import { ref, readonly } from 'vue'

export type ScoutAllianceHalo = 'none' | 'red' | 'blue'

const activeAllianceHalo = ref<ScoutAllianceHalo>('none')
let activeOwner: symbol | null = null

function normalizeAllianceHalo(color: string | null | undefined): ScoutAllianceHalo {
  if (color === 'red' || color === 'blue') return color
  return 'none'
}

function syncDocumentHaloAttr(color: ScoutAllianceHalo) {
  if (typeof document === 'undefined') return
  if (color === 'none') {
    document.documentElement.removeAttribute('data-scout-alliance')
  } else {
    document.documentElement.dataset.scoutAlliance = color
  }
}

/**
 * Coordinates the global full-panel ambient halo tint for Scout alliance selection.
 */
export function useScoutAllianceHalo() {
  function setScoutAllianceHalo(color: ScoutAllianceHalo, owner?: symbol) {
    const normalized = normalizeAllianceHalo(color)
    activeOwner = owner ?? null
    activeAllianceHalo.value = normalized
    syncDocumentHaloAttr(normalized)
  }

  function clearScoutAllianceHalo(owner?: symbol) {
    if (owner !== undefined && activeOwner !== null && activeOwner !== owner) {
      return
    }
    activeOwner = null
    activeAllianceHalo.value = 'none'
    syncDocumentHaloAttr('none')
  }

  return {
    scoutAllianceHalo: readonly(activeAllianceHalo),
    setScoutAllianceHalo,
    clearScoutAllianceHalo
  }
}
