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

function formulaNodeId(target: CustomFieldTarget | string | undefined, fieldKey: string): string {
  const t = (target ?? 'TEAM').trim().toUpperCase()
  const k = fieldKey.trim().toLowerCase()
  return `${t}:${k}`
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
  const candidateNode = formulaNodeId(target, candidateKey)
  const fieldsByKey = new Map<string, Map<CustomFieldTarget, Partial<CustomFieldDefinition>>>()
  const nodeFields = new Map<string, Partial<CustomFieldDefinition>>()

  for (const f of existingFields) {
    if (candidate.id && f.id === candidate.id) continue
    if (f.fieldType === 'formula' && f.fieldKey) {
      const fTarget: CustomFieldTarget = f.target ?? 'TEAM'
      const fKey = f.fieldKey.trim().toLowerCase()
      if (fKey === candidateKey && fTarget === target) continue
      const targetMap = fieldsByKey.get(fKey) ?? new Map<CustomFieldTarget, Partial<CustomFieldDefinition>>()
      targetMap.set(fTarget, f)
      fieldsByKey.set(fKey, targetMap)
      nodeFields.set(formulaNodeId(fTarget, fKey), f)
    }
  }
  const candMap = fieldsByKey.get(candidateKey) ?? new Map<CustomFieldTarget, Partial<CustomFieldDefinition>>()
  candMap.set(target, { ...candidate, target, fieldKey: candidateKey, fieldType: 'formula' })
  fieldsByKey.set(candidateKey, candMap)
  nodeFields.set(candidateNode, { ...candidate, target, fieldKey: candidateKey, fieldType: 'formula' })

  const formulaDeps = parsed.dependencies
    .filter((d) => d.startsWith('formula.'))
    .map((d) => d.slice('formula.'.length).trim().toLowerCase())

  // Cross-layer formula reference check
  for (const depKey of formulaDeps) {
    const depTargets = fieldsByKey.get(depKey)
    if (!depTargets || depTargets.size === 0) continue
    if (target === 'MATCH' && !depTargets.has('MATCH')) {
      const firstOther = depTargets.has('TEAM') ? 'TEAM' : 'PIT'
      return {
        valid: false,
        error: `MATCH formula cannot reference ${firstOther} formula '${depKey}'`,
        errorCode: 'CROSS_LAYER_REFERENCE',
        dependencies: parsed.dependencies
      }
    }
    if (target === 'PIT' && !depTargets.has('PIT')) {
      return {
        valid: false,
        error: `PIT formula cannot reference MATCH/TEAM formula '${depKey}'`,
        errorCode: 'CROSS_LAYER_REFERENCE',
        dependencies: parsed.dependencies
      }
    }
  }

  // Build target-scoped directed graph for cycle detection
  const adj = new Map<string, string[]>()
  for (const [node, field] of nodeFields) {
    const sep = node.indexOf(':')
    const nodeTarget = (sep >= 0 ? node.slice(0, sep) : 'TEAM') as CustomFieldTarget
    const nodeKey = sep >= 0 ? node.slice(sep + 1) : node
    const rawDeps = node === candidateNode ? formulaDeps : getFormulaDepsFromField(field)
    const resolved: string[] = []
    for (const depKey of rawDeps) {
      if (nodeTarget !== 'TEAM') {
        resolved.push(formulaNodeId(nodeTarget, depKey))
      } else if (depKey === nodeKey) {
        let addedLower = false
        for (const lower of ['MATCH', 'PIT'] as const) {
          const lowerNode = formulaNodeId(lower, depKey)
          if (nodeFields.has(lowerNode)) {
            resolved.push(lowerNode)
            addedLower = true
          }
        }
        if (!addedLower) {
          resolved.push(formulaNodeId('TEAM', depKey))
        }
      } else {
        for (const t of ['TEAM', 'MATCH', 'PIT'] as const) {
          const depNode = formulaNodeId(t, depKey)
          if (nodeFields.has(depNode)) {
            resolved.push(depNode)
          }
        }
      }
    }
    adj.set(node, resolved)
  }

  // DFS from candidateNode to detect any cycle reachable from candidate
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

  const rawCyclePath = dfs(candidateNode)
  if (rawCyclePath) {
    const cyclePath = rawCyclePath.map((n) => {
      const sep = n.indexOf(':')
      return sep >= 0 ? n.slice(sep + 1) : n
    })
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
  const byNode = new Map<string, CustomFieldDefinition>()
  for (const f of formulaFields) {
    byNode.set(formulaNodeId(f.target ?? 'TEAM', f.fieldKey), f)
  }

  const depsMap = new Map<string, string[]>()
  for (const f of formulaFields) {
    const fTarget: CustomFieldTarget = f.target ?? 'TEAM'
    const fKey = f.fieldKey.trim().toLowerCase()
    const node = formulaNodeId(fTarget, fKey)
    const rawDeps = getFormulaDepsFromField(f)
    const resolved: string[] = []
    for (const depKey of rawDeps) {
      if (fTarget !== 'TEAM') {
        const depNode = formulaNodeId(fTarget, depKey)
        if (byNode.has(depNode)) resolved.push(depNode)
      } else if (depKey === fKey) {
        let addedLower = false
        for (const lower of ['MATCH', 'PIT'] as const) {
          const lowerNode = formulaNodeId(lower, depKey)
          if (byNode.has(lowerNode)) {
            resolved.push(lowerNode)
            addedLower = true
          }
        }
        if (!addedLower) {
          const selfNode = formulaNodeId('TEAM', depKey)
          if (byNode.has(selfNode)) resolved.push(selfNode)
        }
      } else {
        for (const t of ['TEAM', 'MATCH', 'PIT'] as const) {
          const depNode = formulaNodeId(t, depKey)
          if (byNode.has(depNode)) resolved.push(depNode)
        }
      }
    }
    depsMap.set(node, resolved)
  }

  const state = new Map<string, 0 | 1 | 2>()
  const sorted: CustomFieldDefinition[] = []
  const cyclicSet = new Set<string>()
  const cyclicKeysSet = new Set<string>()

  const visit = (node: string): void => {
    const st = state.get(node) ?? 0
    if (st === 2) return
    if (st === 1) {
      cyclicSet.add(node)
      const f = byNode.get(node)
      if (f) cyclicKeysSet.add(f.fieldKey)
      return
    }
    state.set(node, 1)
    for (const dep of depsMap.get(node) ?? []) {
      visit(dep)
    }
    state.set(node, 2)
    const field = byNode.get(node)
    if (field && !cyclicSet.has(node)) {
      sorted.push(field)
    }
  }

  for (const f of formulaFields) {
    visit(formulaNodeId(f.target ?? 'TEAM', f.fieldKey))
  }

  return {
    sorted,
    cyclicKeys: Array.from(cyclicKeysSet)
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
      const bareDep = (fullDep.includes('.') ? fullDep.slice(fullDep.indexOf('.') + 1) : fullDep).toLowerCase()
      for (const matchKey of [fullDep.toLowerCase(), bareDep]) {
        const list = directDependents.get(matchKey) ?? []
        if (!list.includes(f)) list.push(f)
        directDependents.set(matchKey, list)
      }
    }
  }

  const result: CustomFieldDefinition[] = []
  const visitedNodes = new Set<string>()
  const queue: string[] = [fieldKey.trim().toLowerCase()]

  while (queue.length > 0) {
    const curr = queue.shift()!
    for (const depField of directDependents.get(curr) ?? []) {
      const depNode = formulaNodeId(depField.target ?? 'TEAM', depField.fieldKey)
      if (!visitedNodes.has(depNode)) {
        visitedNodes.add(depNode)
        result.push(depField)
        queue.push(depField.fieldKey.trim().toLowerCase())
      }
    }
  }

  return result
}
