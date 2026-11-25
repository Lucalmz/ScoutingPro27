import type { CustomFieldTarget } from '@/types'
import { getFormulaFunction } from './functions'
import { parseFormula } from './parser'
import {
  FORMULA_LIMITS,
  type FormulaAstNode,
  type FormulaContext,
  type FormulaContextValue,
  type FormulaEvalResult
} from './types'

export interface EvaluateFormulaOptions {
  target?: CustomFieldTarget
  stepBudget?: number
  maxDepth?: number
  fieldKey?: string
  evaluatingStack?: string[]
  resolveFormula?: (key: string, stack: string[]) => number | null
}

type RuntimeValue = number | boolean | null | number[]

class EvalAbortError extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(reason)
    this.reason = reason
  }
}

function toNumeric(val: RuntimeValue): number | null {
  if (typeof val === 'number' && Number.isFinite(val)) return val
  if (typeof val === 'boolean') return val ? 1 : 0
  return null
}

function toBoolean(val: RuntimeValue): boolean {
  if (typeof val === 'boolean') return val
  if (typeof val === 'number') return Number.isFinite(val) && val !== 0
  return false
}

function sanitizeContextValue(val: FormulaContextValue): RuntimeValue {
  if (Array.isArray(val)) {
    return val.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  }
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : null
  }
  if (typeof val === 'boolean') {
    return val
  }
  return null
}

export function evaluateFormulaAst(
  ast: FormulaAstNode,
  context: FormulaContext,
  options: EvaluateFormulaOptions = {}
): FormulaEvalResult {
  const maxDepth = options.maxDepth ?? FORMULA_LIMITS.MAX_EVAL_DEPTH
  const stack = options.evaluatingStack ?? []

  if (stack.length >= maxDepth) {
    return {
      value: null,
      reason: 'MAX_EVAL_DEPTH_EXCEEDED',
      error: `Formula evaluation exceeded max depth of ${maxDepth}`
    }
  }

  if (options.fieldKey) {
    if (stack.includes(options.fieldKey)) {
      return {
        value: null,
        reason: 'CIRCULAR_DEPENDENCY_RUNTIME',
        error: `Circular dependency detected at '${options.fieldKey}'`
      }
    }
  }

  const nextStack = options.fieldKey ? [...stack, options.fieldKey] : stack
  let remainingSteps = options.stepBudget ?? FORMULA_LIMITS.MAX_STEP_BUDGET

  const evalNode = (node: FormulaAstNode): RuntimeValue => {
    remainingSteps--
    if (remainingSteps < 0) {
      throw new EvalAbortError('STEP_BUDGET_EXCEEDED')
    }

    switch (node.type) {
      case 'NumberLiteral':
        return node.value

      case 'BooleanLiteral':
        return node.value

      case 'NullLiteral':
        return null

      case 'VariableRef': {
        if (node.namespace === 'formula' && options.resolveFormula) {
          const nsObj = context.formula
          if (nsObj && Object.prototype.hasOwnProperty.call(nsObj, node.key)) {
            return sanitizeContextValue(nsObj[node.key])
          }
          return options.resolveFormula(node.key, nextStack)
        }
        const nsObj = context[node.namespace]
        if (!nsObj || !Object.prototype.hasOwnProperty.call(nsObj, node.key)) {
          return null
        }
        return sanitizeContextValue(nsObj[node.key])
      }

      case 'UnaryOp': {
        const val = evalNode(node.operand)
        if (node.op === '!') {
          return !toBoolean(val)
        }
        const num = toNumeric(val)
        if (num === null) return null
        return node.op === '-' ? -num : num
      }

      case 'BinaryOp': {
        if (node.op === '&&') {
          return toBoolean(evalNode(node.left)) && toBoolean(evalNode(node.right))
        }
        if (node.op === '||') {
          return toBoolean(evalNode(node.left)) || toBoolean(evalNode(node.right))
        }

        const leftVal = evalNode(node.left)
        const rightVal = evalNode(node.right)

        if (node.op === '==' || node.op === '!=') {
          const lNum = toNumeric(leftVal)
          const rNum = toNumeric(rightVal)
          if (lNum === null && rNum === null) {
            return node.op === '==' ? leftVal === rightVal : leftVal !== rightVal
          }
          if (lNum === null || rNum === null) {
            return node.op === '!='
          }
          return node.op === '==' ? lNum === rNum : lNum !== rNum
        }

        const lNum = toNumeric(leftVal)
        const rNum = toNumeric(rightVal)
        if (lNum === null || rNum === null) return null

        switch (node.op) {
          case '+':
            return lNum + rNum
          case '-':
            return lNum - rNum
          case '*':
            return lNum * rNum
          case '/': {
            if (rNum === 0) throw new EvalAbortError('DIV_BY_ZERO')
            const q = lNum / rNum
            if (!Number.isFinite(q)) throw new EvalAbortError('NON_FINITE_RESULT')
            return q
          }
          case '%': {
            if (rNum === 0) throw new EvalAbortError('DIV_BY_ZERO')
            const rem = lNum % rNum
            if (!Number.isFinite(rem)) throw new EvalAbortError('NON_FINITE_RESULT')
            return rem
          }
          case '^': {
            const p = Math.pow(lNum, rNum)
            if (!Number.isFinite(p)) throw new EvalAbortError('NON_FINITE_RESULT')
            return p
          }
          case '<':
            return lNum < rNum
          case '<=':
            return lNum <= rNum
          case '>':
            return lNum > rNum
          case '>=':
            return lNum >= rNum
        }
      }

      case 'TernaryOp': {
        const cond = toBoolean(evalNode(node.condition))
        return cond ? evalNode(node.whenTrue) : evalNode(node.whenFalse)
      }

      case 'FunctionCall': {
        const fn = getFormulaFunction(node.name)
        if (!fn) {
          throw new EvalAbortError('DISALLOWED_FUNCTION')
        }
        const args = node.args.map((arg) => evalNode(arg))
        const res = fn(...args)
        if (typeof res === 'number' && !Number.isFinite(res)) {
          throw new EvalAbortError('NON_FINITE_RESULT')
        }
        return res
      }
    }
  }

  try {
    const rawResult = evalNode(ast)
    const numeric = toNumeric(rawResult)
    if (numeric === null) {
      return { value: null, reason: 'NULL_RESULT' }
    }
    if (!Number.isFinite(numeric)) {
      return { value: null, reason: 'NON_FINITE_RESULT' }
    }
    return { value: Object.is(numeric, -0) ? 0 : numeric }
  } catch (err) {
    if (err instanceof EvalAbortError) {
      return {
        value: null,
        reason: err.reason,
        error: err.message
      }
    }
    return {
      value: null,
      reason: 'EVAL_ERROR',
      error: err instanceof Error ? err.message : 'Evaluation failed'
    }
  }
}

export function evaluateFormula(
  expr: string,
  context: FormulaContext,
  options: EvaluateFormulaOptions = {}
): FormulaEvalResult {
  const target = options.target ?? 'TEAM'
  const parsed = parseFormula(expr, target)
  if (!parsed.valid || !parsed.ast) {
    return {
      value: null,
      error: parsed.error,
      errorCode: parsed.errorCode,
      reason: parsed.errorCode
    }
  }
  return evaluateFormulaAst(parsed.ast, context, options)
}
