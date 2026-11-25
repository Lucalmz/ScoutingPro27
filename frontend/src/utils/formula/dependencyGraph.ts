import type { CustomFieldDefinition, CustomFieldTarget } from '@/types'
import { parseFormula } from './parser'
import type { FormulaValidationResult } from './types'

export function extractDependencies(
  expr: string,
  target: CustomFieldTarget = 'TEAM'
): string[] {
  const res = parseFormula(expr, target)
  return res.valid ? res.dependencies : []
}

function getFormulaDepsFromField(field: Partial<CustomFieldDefinition>): string[] {
  const target: CustomFieldTarget = field.target ?? 'TEAM'
  let deps: string[] = []
  if (typeof field.formulaExpr === 'string' && field.formulaExpr.trim()) {
    deps = extractDependencies(field.formulaExpr, target)
  } else if (typeof field.dependenciesJson === 'string' && field.dependenciesJson) {
    try {
      const parsed = JSON.parse(field.dependenciesJson)
      if (Array.isArray(parsed)) {
        deps = parsed.filter((d): d is string => typeof d === 'string')
      }
    } catch {
      deps = []
    }
  }
  return deps
    .filter((d) => d.startsWith('formula.'))
    .map((d) => d.slice('formula.'.length).trim().toLowerCase())
}

export function validateFormulaGraph(
  candidate: Partial<CustomFieldDefinition>,
  existingFields: CustomFieldDefinition[]
): FormulaValidationResult {
  const target: CustomFieldTarget = candidate.target ?? 'TEAM'
  const expr = candidate.formulaExpr ?? ''
  const parsed = parseFormula(expr, target)
  if (!parsed.valid) {
    return parsed
  }

  const candidateKey = candidate.fieldKey?.trim().toLowerCase() || '__candidate__'
  const fieldByKey = new Map<string, Partial<CustomFieldDefinition>>()

  for (const f of existingFields) {
    if (candidate.id && f.id === candidate.id) continue
    if (f.fieldType === 'formula' && f.fieldKey) {
      fieldByKey.set(f.fieldKey.trim().toLowerCase(), f)
    }
  }
  fieldByKey.set(candidateKey, { ...candidate, target, fieldKey: candidateKey, fieldType: 'formula' })

  const formulaDeps = parsed.dependencies
    .filter((d) => d.startsWith('formula.'))
    .map((d) => d.slice('formula.'.length).trim().toLowerCase())

  // Cross-layer formula reference check
  for (const depKey of formulaDeps) {
    const depField = fieldByKey.get(depKey)
    if (!depField) continue
    const depTarget = depField.target ?? 'TEAM'
    if (target === 'MATCH' && depTarget !== 'MATCH') {
      return {
        valid: false,
        error: `MATCH formula cannot reference ${depTarget} formula '${depKey}'`,
        errorCode: 'CROSS_LAYER_REFERENCE',
        dependencies: parsed.dependencies
      }
    }
    if (target === 'PIT' && depTarget !== 'PIT') {
      return {
        valid: false,
        error: `PIT formula cannot reference ${depTarget} formula '${depKey}'`,
        errorCode: 'CROSS_LAYER_REFERENCE',
        dependencies: parsed.dependencies
      }
    }
  }

  // Build directed graph for cycle detection
  const adj = new Map<string, string[]>()
  for (const [key, field] of fieldByKey) {
    if (key === candidateKey) {
      adj.set(key, formulaDeps)
    } else {
      adj.set(key, getFormulaDepsFromField(field))
    }
  }

  // DFS from candidateKey to detect any cycle reachable from candidate
  const state = new Map<string, 0 | 1 | 2>() // 0/undef=unvisited, 1=visiting, 2=visited
  const stack: string[] = []

  const dfs = (node: string): string[] | null => {
    state.set(node, 1)
    stack.push(node)

    const neighbors = adj.get(node) ?? []
    for (const next of neighbors) {
      const nextState = state.get(next) ?? 0
      if (nextState === 1) {
        const idx = stack.indexOf(next)
        return idx >= 0 ? [...stack.slice(idx), next] : [next, next]
      }
      if (nextState === 0 && adj.has(next)) {
        const cycle = dfs(next)
        if (cycle) return cycle
      }
    }

    stack.pop()
    state.set(node, 2)
    return null
  }

  const cyclePath = dfs(candidateKey)
  if (cyclePath) {
    return {
      valid: false,
      error: `Circular formula dependency detected: ${cyclePath.join(' -> ')}`,
      errorCode: 'CIRCULAR_DEPENDENCY',
      dependencies: parsed.dependencies,
      cyclePath
    }
  }

  return parsed
}

export function topologicalSortFormulas(
  fields: CustomFieldDefinition[]
): { sorted: CustomFieldDefinition[]; cyclicKeys: string[] } {
  const formulaFields = fields.filter((f) => f.fieldType === 'formula' && f.fieldKey)
  const byKey = new Map<string, CustomFieldDefinition>()
  for (const f of formulaFields) {
    byKey.set(f.fieldKey, f)
  }

  const depsMap = new Map<string, string[]>()
  for (const f of formulaFields) {
    const deps = getFormulaDepsFromField(f).filter((d) => byKey.has(d))
    depsMap.set(f.fieldKey, deps)
  }

  const state = new Map<string, 0 | 1 | 2>()
  const sorted: CustomFieldDefinition[] = []
  const cyclicSet = new Set<string>()

  const visit = (key: string): void => {
    const st = state.get(key) ?? 0
    if (st === 2) return
    if (st === 1) {
      cyclicSet.add(key)
      return
    }
    state.set(key, 1)
    for (const dep of depsMap.get(key) ?? []) {
      visit(dep)
    }
    state.set(key, 2)
    const field = byKey.get(key)
    if (field && !cyclicSet.has(key)) {
      sorted.push(field)
    }
  }

  for (const f of formulaFields) {
    visit(f.fieldKey)
  }

  return {
    sorted,
    cyclicKeys: Array.from(cyclicSet)
  }
}

export function findDependentFormulas(
  fieldKey: string,
  fields: CustomFieldDefinition[]
): CustomFieldDefinition[] {
  const formulaFields = fields.filter((f) => f.fieldType === 'formula' && f.fieldKey)
  const directDependents = new Map<string, CustomFieldDefinition[]>()

  for (const f of formulaFields) {
    const target: CustomFieldTarget = f.target ?? 'TEAM'
    const allDeps = typeof f.formulaExpr === 'string' && f.formulaExpr.trim()
      ? extractDependencies(f.formulaExpr, target)
      : []

    for (const fullDep of allDeps) {
      const bareDep = fullDep.includes('.') ? fullDep.slice(fullDep.indexOf('.') + 1) : fullDep
      for (const matchKey of [fullDep, bareDep]) {
        const list = directDependents.get(matchKey) ?? []
        if (!list.includes(f)) list.push(f)
        directDependents.set(matchKey, list)
      }
    }
  }

  const result: CustomFieldDefinition[] = []
  const visited = new Set<string>()
  const queue: string[] = [fieldKey]

  while (queue.length > 0) {
    const curr = queue.shift()!
    for (const depField of directDependents.get(curr) ?? []) {
      if (!visited.has(depField.fieldKey)) {
        visited.add(depField.fieldKey)
        result.push(depField)
        queue.push(depField.fieldKey)
      }
    }
  }

  return result
}
