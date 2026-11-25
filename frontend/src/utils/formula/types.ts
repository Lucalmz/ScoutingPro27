import type { CustomFieldTarget } from '@/types'

export type FormulaErrorCode =
  | 'EMPTY_FORMULA'
  | 'EXPR_TOO_LONG'
  | 'TOKEN_LIMIT_EXCEEDED'
  | 'AST_DEPTH_EXCEEDED'
  | 'AST_NODE_LIMIT_EXCEEDED'
  | 'INVALID_TOKEN'
  | 'INVALID_SYNTAX'
  | 'FORBIDDEN_IDENTIFIER'
  | 'DISALLOWED_NAMESPACE'
  | 'DISALLOWED_FUNCTION'
  | 'CROSS_LAYER_REFERENCE'
  | 'CIRCULAR_DEPENDENCY'

export type FormulaNamespace =
  | 'match'
  | 'cf'
  | 'pit'
  | 'pit_cf'
  | 'official'
  | 'opr'
  | 'match_cf'
  | 'formula'

export const FORMULA_LIMITS = {
  MAX_EXPR_LENGTH: 1000,
  MAX_TOKENS: 256,
  MAX_AST_DEPTH: 20,
  MAX_AST_NODES: 200,
  MAX_STEP_BUDGET: 500,
  MAX_EVAL_DEPTH: 16
} as const

export const ALL_FORMULA_NAMESPACES: ReadonlySet<string> = new Set<FormulaNamespace>([
  'match',
  'cf',
  'pit',
  'pit_cf',
  'official',
  'opr',
  'match_cf',
  'formula'
])

export const TARGET_ALLOWED_NAMESPACES: Record<CustomFieldTarget, ReadonlySet<FormulaNamespace>> = {
  MATCH: new Set<FormulaNamespace>(['match', 'cf', 'formula']),
  PIT: new Set<FormulaNamespace>(['pit', 'pit_cf', 'cf', 'formula']),
  TEAM: new Set<FormulaNamespace>(['match', 'official', 'opr', 'pit', 'pit_cf', 'cf', 'match_cf', 'formula'])
}

export const FORBIDDEN_IDENTIFIERS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'window',
  'globalthis',
  'process',
  'eval',
  'function',
  'import',
  'require',
  'this',
  'self'
])

export type TokenType =
  | 'NUMBER'
  | 'BOOLEAN'
  | 'NULL'
  | 'IDENT'
  | 'OP'
  | 'LPAREN'
  | 'RPAREN'
  | 'COMMA'
  | 'DOT'
  | 'QUESTION'
  | 'COLON'
  | 'EOF'

export interface FormulaToken {
  type: TokenType
  value: string
  pos: number
}

export type FormulaAstNode =
  | { type: 'NumberLiteral'; value: number }
  | { type: 'BooleanLiteral'; value: boolean }
  | { type: 'NullLiteral' }
  | { type: 'VariableRef'; namespace: FormulaNamespace; key: string; fullKey: string }
  | { type: 'UnaryOp'; op: '!' | '-' | '+'; operand: FormulaAstNode }
  | {
      type: 'BinaryOp'
      op: '+' | '-' | '*' | '/' | '%' | '^' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||'
      left: FormulaAstNode
      right: FormulaAstNode
    }
  | { type: 'TernaryOp'; condition: FormulaAstNode; whenTrue: FormulaAstNode; whenFalse: FormulaAstNode }
  | { type: 'FunctionCall'; name: string; args: FormulaAstNode[] }

export type FormulaScalarValue = number | boolean | null | undefined
export type FormulaContextValue = FormulaScalarValue | number[]
export type FormulaContext = Partial<Record<FormulaNamespace, Record<string, FormulaContextValue>>>

export interface FormulaValidationResult {
  valid: boolean
  error?: string
  errorCode?: FormulaErrorCode
  dependencies: string[]
  ast?: FormulaAstNode
  cyclePath?: string[]
}

export interface FormulaEvalResult {
  value: number | null
  error?: string
  reason?: string
  errorCode?: FormulaErrorCode
}
