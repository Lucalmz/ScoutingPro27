import {
  FORMULA_LIMITS,
  FORBIDDEN_IDENTIFIERS,
  type FormulaErrorCode,
  type FormulaToken
} from './types'

export class FormulaSyntaxError extends Error {
  readonly errorCode: FormulaErrorCode
  readonly pos?: number

  constructor(errorCode: FormulaErrorCode, message: string, pos?: number) {
    super(message)
    this.name = 'FormulaSyntaxError'
    this.errorCode = errorCode
    this.pos = pos
  }
}

const TWO_CHAR_OPS = new Set(['==', '!=', '<=', '>=', '&&', '||'])
const ONE_CHAR_OPS = new Set(['+', '-', '*', '/', '%', '^', '<', '>', '!'])

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_'
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch)
}

export function tokenizeFormula(expr: string): FormulaToken[] {
  if (typeof expr !== 'string' || expr.trim().length === 0) {
    throw new FormulaSyntaxError('EMPTY_FORMULA', 'Formula expression cannot be empty')
  }

  if (expr.length > FORMULA_LIMITS.MAX_EXPR_LENGTH) {
    throw new FormulaSyntaxError(
      'EXPR_TOO_LONG',
      `Formula expression exceeds maximum length of ${FORMULA_LIMITS.MAX_EXPR_LENGTH} characters`
    )
  }

  const tokens: FormulaToken[] = []
  let i = 0
  const len = expr.length

  while (i < len) {
    const ch = expr[i]!

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }

    if (isDigit(ch)) {
      const start = i
      while (i < len && isDigit(expr[i]!)) i++
      if (i < len && expr[i] === '.') {
        if (i + 1 < len && isDigit(expr[i + 1]!)) {
          i++
          while (i < len && isDigit(expr[i]!)) i++
        } else {
          throw new FormulaSyntaxError('INVALID_TOKEN', `Invalid number literal at position ${start}`, start)
        }
      }
      tokens.push({ type: 'NUMBER', value: expr.slice(start, i), pos: start })
    } else if (isIdentStart(ch)) {
      const start = i
      while (i < len && isIdentPart(expr[i]!)) i++
      const ident = expr.slice(start, i)
      if (FORBIDDEN_IDENTIFIERS.has(ident.toLowerCase())) {
        throw new FormulaSyntaxError('FORBIDDEN_IDENTIFIER', `Forbidden identifier: ${ident}`, start)
      }
      if (ident === 'true' || ident === 'false') {
        tokens.push({ type: 'BOOLEAN', value: ident, pos: start })
      } else if (ident === 'null') {
        tokens.push({ type: 'NULL', value: ident, pos: start })
      } else {
        tokens.push({ type: 'IDENT', value: ident, pos: start })
      }
    } else if (i + 1 < len && TWO_CHAR_OPS.has(expr.slice(i, i + 2))) {
      tokens.push({ type: 'OP', value: expr.slice(i, i + 2), pos: i })
      i += 2
    } else if (ONE_CHAR_OPS.has(ch)) {
      tokens.push({ type: 'OP', value: ch, pos: i })
      i++
    } else if (ch === '(') {
      tokens.push({ type: 'LPAREN', value: ch, pos: i })
      i++
    } else if (ch === ')') {
      tokens.push({ type: 'RPAREN', value: ch, pos: i })
      i++
    } else if (ch === ',') {
      tokens.push({ type: 'COMMA', value: ch, pos: i })
      i++
    } else if (ch === '.') {
      tokens.push({ type: 'DOT', value: ch, pos: i })
      i++
    } else if (ch === '?') {
      tokens.push({ type: 'QUESTION', value: ch, pos: i })
      i++
    } else if (ch === ':') {
      tokens.push({ type: 'COLON', value: ch, pos: i })
      i++
    } else {
      throw new FormulaSyntaxError('INVALID_TOKEN', `Unexpected character '${ch}' at position ${i}`, i)
    }

    if (tokens.length > FORMULA_LIMITS.MAX_TOKENS) {
      throw new FormulaSyntaxError(
        'TOKEN_LIMIT_EXCEEDED',
        `Formula exceeds maximum token count of ${FORMULA_LIMITS.MAX_TOKENS}`,
        i
      )
    }
  }

  tokens.push({ type: 'EOF', value: '', pos: len })
  return tokens
}
