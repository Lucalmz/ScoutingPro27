import { describe, it, expect } from 'vitest'
import { safeJsonParse } from '../utils/json'

describe('safeJsonParse', () => {
  it('correctly parses valid JSON string', () => {
    const raw = JSON.stringify({ a: 1, b: 'hello' })
    const res = safeJsonParse<{ a: number; b: string }>(raw)
    expect(res).toEqual({ a: 1, b: 'hello' })
  })

  it('returns null on null, undefined, empty string, or non-string inputs', () => {
    expect(safeJsonParse(null)).toBeNull()
    expect(safeJsonParse(undefined)).toBeNull()
    expect(safeJsonParse('')).toBeNull()
    expect(safeJsonParse('   ')).toBeNull()
    expect(safeJsonParse(123 as any)).toBeNull()
  })

  it('returns null on "null", primitive JSON values, or malformed JSON', () => {
    expect(safeJsonParse('null')).toBeNull()
    expect(safeJsonParse('123')).toBeNull()
    expect(safeJsonParse('"string"')).toBeNull()
    expect(safeJsonParse('true')).toBeNull()
    expect(safeJsonParse('{ malformed json')).toBeNull()
    expect(safeJsonParse('<xml></xml>')).toBeNull()
  })

  it('supports custom runtime type guards', () => {
    interface Message {
      type: string
      count: number
    }
    const isMessage = (val: any): val is Message => {
      return typeof val === 'object' && val !== null && typeof val.type === 'string' && typeof val.count === 'number'
    }

    const valid = JSON.stringify({ type: 'SYNC', count: 5 })
    const invalid = JSON.stringify({ type: 'SYNC', count: 'wrong_type' })

    expect(safeJsonParse<Message>(valid, isMessage)).toEqual({ type: 'SYNC', count: 5 })
    expect(safeJsonParse<Message>(invalid, isMessage)).toBeNull()
  })
})
