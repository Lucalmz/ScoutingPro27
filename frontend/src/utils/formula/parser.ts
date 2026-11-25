import type { CustomFieldTarget } from '@/types'
import { ALLOWED_FORMULA_FUNCTIONS } from './functions'
import { FormulaSyntaxError, tokenizeFormula } from './tokenizer'
import {
  ALL_FORMULA_NAMESPACES,
  FORMULA_LIMITS,
  TARGET_ALLOWED_NAMESPACES,
  type FormulaAstNode,
  type FormulaNamespace,
  type FormulaToken,
  type FormulaValidationResult
} from './types'

class FormulaParser {
  private readonly tokens: FormulaToken[]
  private readonly target: CustomFieldTarget
  private pos = 0
  private nodeCount = 0
  private readonly deps = new Set<string>()

  constructor(tokens: FormulaToken[], target: CustomFieldTarget) {
    this.tokens = tokens
    this.target = target
  }

  private peek(offset = 0): FormulaToken {
    return this.tokens[this.pos + offset] ?? this.tokens[this.tokens.length - 1]!
  }

  private consume(): FormulaToken {
    const tok = this.peek()
    if (tok.type !== 'EOF') this.pos++
    return tok
  }

  private countNode(node: FormulaAstNode): FormulaAstNode {
    this.nodeCount++
    if (this.nodeCount > FORMULA_LIMITS.MAX_AST_NODES) {
      throw new FormulaSyntaxError(
        'AST_NODE_LIMIT_EXCEEDED',
        `Formula AST exceeds maximum node limit of ${FORMULA_LIMITS.MAX_AST_NODES}`
      )
    }
    return node
  }

  private checkDepth(depth: number): void {
    if (depth > FORMULA_LIMITS.MAX_AST_DEPTH) {
      throw new FormulaSyntaxError(
        'AST_DEPTH_EXCEEDED',
        `Formula AST exceeds maximum depth of ${FORMULA_LIMITS.MAX_AST_DEPTH}`
      )
    }
  }

  parse(): { ast: FormulaAstNode; dependencies: string[] } {
    const ast = this.parseTernary(1)
    if (this.peek().type !== 'EOF') {
      const tok = this.peek()
      throw new FormulaSyntaxError('INVALID_SYNTAX', `Unexpected token '${tok.value}' at position ${tok.pos}`, tok.pos)
    }
    return { ast, dependencies: Array.from(this.deps) }
  }

  private parseTernary(depth: number): FormulaAstNode {
    this.checkDepth(depth)
    const cond = this.parseOr(depth)
    if (this.peek().type === 'QUESTION') {
      this.consume()
      const whenTrue = this.parseTernary(depth + 1)
      if (this.peek().type !== 'COLON') {
        throw new FormulaSyntaxError('INVALID_SYNTAX', "Expected ':' in ternary expression", this.peek().pos)
      }
      this.consume()
      const whenFalse = this.parseTernary(depth + 1)
      return this.countNode({ type: 'TernaryOp', condition: cond, whenTrue, whenFalse })
    }
    return cond
  }

  private parseOr(depth: number): FormulaAstNode {
    let left = this.parseAnd(depth)
    while (this.peek().type === 'OP' && this.peek().value === '||') {
      this.consume()
      const right = this.parseAnd(depth + 1)
      left = this.countNode({ type: 'BinaryOp', op: '||', left, right })
    }
    return left
  }

  private parseAnd(depth: number): FormulaAstNode {
    let left = this.parseEquality(depth)
    while (this.peek().type === 'OP' && this.peek().value === '&&') {
      this.consume()
      const right = this.parseEquality(depth + 1)
      left = this.countNode({ type: 'BinaryOp', op: '&&', left, right })
    }
    return left
  }

  private parseEquality(depth: number): FormulaAstNode {
    let left = this.parseRelational(depth)
    while (this.peek().type === 'OP' && (this.peek().value === '==' || this.peek().value === '!=')) {
      const op = this.consume().value as '==' | '!='
      const right = this.parseRelational(depth + 1)
      left = this.countNode({ type: 'BinaryOp', op, left, right })
    }
    return left
  }

  private parseRelational(depth: number): FormulaAstNode {
    let left = this.parseAdditive(depth)
    while (
      this.peek().type === 'OP' &&
      (this.peek().value === '<' ||
        this.peek().value === '<=' ||
        this.peek().value === '>' ||
        this.peek().value === '>=')
    ) {
      const op = this.consume().value as '<' | '<=' | '>' | '>='
      const right = this.parseAdditive(depth + 1)
      left = this.countNode({ type: 'BinaryOp', op, left, right })
    }
    return left
  }

  private parseAdditive(depth: number): FormulaAstNode {
    let left = this.parseMultiplicative(depth)
    while (this.peek().type === 'OP' && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.consume().value as '+' | '-'
      const right = this.parseMultiplicative(depth + 1)
      left = this.countNode({ type: 'BinaryOp', op, left, right })
    }
    return left
  }

  private parseMultiplicative(depth: number): FormulaAstNode {
    let left = this.parseUnary(depth)
    while (
      this.peek().type === 'OP' &&
      (this.peek().value === '*' || this.peek().value === '/' || this.peek().value === '%')
    ) {
      const op = this.consume().value as '*' | '/' | '%'
      const right = this.parseUnary(depth + 1)
      left = this.countNode({ type: 'BinaryOp', op, left, right })
    }
    return left
  }

  private parseUnary(depth: number): FormulaAstNode {
    this.checkDepth(depth)
    if (
      this.peek().type === 'OP' &&
      (this.peek().value === '!' || this.peek().value === '-' || this.peek().value === '+')
    ) {
      const op = this.consume().value as '!' | '-' | '+'
      const operand = this.parseUnary(depth + 1)
      return this.countNode({ type: 'UnaryOp', op, operand })
    }
    return this.parsePower(depth)
  }

  private parsePower(depth: number): FormulaAstNode {
    const left = this.parsePrimary(depth)
    if (this.peek().type === 'OP' && this.peek().value === '^') {
      this.consume()
      // Power is right-associative and higher precedence than unary (-2^2 = -4, 2^3^2 = 512)
      const right = this.parseUnary(depth + 1)
      return this.countNode({ type: 'BinaryOp', op: '^', left, right })
    }
    return left
  }

  private parsePrimary(depth: number): FormulaAstNode {
    this.checkDepth(depth)
    const tok = this.peek()

    if (tok.type === 'NUMBER') {
      this.consume()
      const num = Number(tok.value)
      if (!Number.isFinite(num)) {
        throw new FormulaSyntaxError('INVALID_SYNTAX', `Invalid number '${tok.value}'`, tok.pos)
      }
      return this.countNode({ type: 'NumberLiteral', value: num })
    }

    if (tok.type === 'BOOLEAN') {
      this.consume()
      return this.countNode({ type: 'BooleanLiteral', value: tok.value === 'true' })
    }

    if (tok.type === 'NULL') {
      this.consume()
      return this.countNode({ type: 'NullLiteral' })
    }

    if (tok.type === 'LPAREN') {
      this.consume()
      const inner = this.parseTernary(depth + 1)
      if (this.peek().type !== 'RPAREN') {
        throw new FormulaSyntaxError('INVALID_SYNTAX', "Expected ')'", this.peek().pos)
      }
      this.consume()
      return inner
    }

    if (tok.type === 'IDENT') {
      this.consume()
      const next = this.peek()

      // Function call
      if (next.type === 'LPAREN') {
        const fnName = tok.value.toUpperCase()
        if (!ALLOWED_FORMULA_FUNCTIONS.has(fnName)) {
          throw new FormulaSyntaxError('DISALLOWED_FUNCTION', `Function '${tok.value}' is not allowed`, tok.pos)
        }
        this.consume() // '('
        if (this.peek().type === 'RPAREN') {
          throw new FormulaSyntaxError(
            'INVALID_SYNTAX',
            `Function '${tok.value}' requires at least one argument`,
            this.peek().pos
          )
        }
        const args: FormulaAstNode[] = []
        while (true) {
          args.push(this.parseTernary(depth + 1))
          if (this.peek().type === 'COMMA') {
            this.consume()
            continue
          }
          break
        }
        if (this.peek().type !== 'RPAREN') {
          throw new FormulaSyntaxError('INVALID_SYNTAX', "Expected ')' after function arguments", this.peek().pos)
        }
        this.consume() // ')'
        return this.countNode({ type: 'FunctionCall', name: fnName, args })
      }

      // Namespaced variable reference: ns.key
      if (next.type === 'DOT') {
        this.consume() // '.'
        const keyTok = this.peek()
        if (keyTok.type !== 'IDENT') {
          throw new FormulaSyntaxError('INVALID_SYNTAX', `Expected field key after '${tok.value}.'`, keyTok.pos)
        }
        this.consume()

        // Disallow deep property chains (a.b.c) or method calls (a.b())
        if (this.peek().type === 'DOT' || this.peek().type === 'LPAREN') {
          throw new FormulaSyntaxError(
            'INVALID_SYNTAX',
            `Deep property chains or method calls are not allowed near '${tok.value}.${keyTok.value}'`,
            this.peek().pos
          )
        }

        const ns = tok.value
        if (!ALL_FORMULA_NAMESPACES.has(ns)) {
          throw new FormulaSyntaxError('DISALLOWED_NAMESPACE', `Disallowed namespace '${ns}'`, tok.pos)
        }

        const typedNs = ns as FormulaNamespace
        if (!TARGET_ALLOWED_NAMESPACES[this.target].has(typedNs)) {
          throw new FormulaSyntaxError(
            'CROSS_LAYER_REFERENCE',
            `Target '${this.target}' cannot reference namespace '${ns}'`,
            tok.pos
          )
        }

        const fullKey = `${typedNs}.${keyTok.value}`
        this.deps.add(fullKey)
        return this.countNode({ type: 'VariableRef', namespace: typedNs, key: keyTok.value, fullKey })
      }

      // Bare identifier without namespace
      throw new FormulaSyntaxError(
        'DISALLOWED_NAMESPACE',
        `Bare identifier '${tok.value}' must use a valid namespace prefix`,
        tok.pos
      )
    }

    throw new FormulaSyntaxError('INVALID_SYNTAX', `Unexpected token '${tok.value || 'EOF'}'`, tok.pos)
  }
}

export function parseFormula(
  expr: string,
  target: CustomFieldTarget = 'TEAM'
): FormulaValidationResult {
  try {
    const tokens = tokenizeFormula(expr)
    const parser = new FormulaParser(tokens, target)
    const { ast, dependencies } = parser.parse()
    return {
      valid: true,
      dependencies,
      ast
    }
  } catch (err) {
    if (err instanceof FormulaSyntaxError) {
      return {
        valid: false,
        error: err.message,
        errorCode: err.errorCode,
        dependencies: []
      }
    }
    return {
      valid: false,
      error: err instanceof Error ? err.message : 'Invalid formula syntax',
      errorCode: 'INVALID_SYNTAX',
      dependencies: []
    }
  }
}
