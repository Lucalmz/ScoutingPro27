import { describe, it, expect } from 'vitest'
import { ALLOWED_FORMULA_FUNCTIONS, getFormulaFunction } from '@/utils/formula/functions'

describe('Formula Functions - Complete Registry & Edge Cases', () => {
  it('blocks prototype pollution lookups and resolves function names case-insensitively', () => {
    expect(getFormulaFunction('constructor')).toBeUndefined()
    expect(getFormulaFunction('__proto__')).toBeUndefined()
    expect(getFormulaFunction('toString')).toBeUndefined()
    expect(getFormulaFunction('abs')).toBe(getFormulaFunction('ABS'))
    expect(ALLOWED_FORMULA_FUNCTIONS.has('WEIGHTED_AVG')).toBe(true)
  })

  it('covers math functions (ABS, ROUND, FLOOR, CEIL, MIN, MAX, CLAMP, SQRT, POW, LOG, SIGN)', () => {
    expect(getFormulaFunction('ABS')!(-7.5)).toBe(7.5)
    expect(getFormulaFunction('ABS')!(null)).toBeNull()
    expect(getFormulaFunction('ABS')!(Infinity)).toBeNull()

    expect(getFormulaFunction('ROUND')!(3.14159, 2)).toBe(3.14)
    expect(getFormulaFunction('ROUND')!(3.6)).toBe(4)
    expect(getFormulaFunction('ROUND')!(1.234, -5)).toBe(1) // clamped to 0
    expect(getFormulaFunction('ROUND')!(1.234567890123, 99)).toBeCloseTo(1.2345678901, 10)
    expect(getFormulaFunction('ROUND')!(NaN, 2)).toBeNull()

    expect(getFormulaFunction('FLOOR')!(3.9)).toBe(3)
    expect(getFormulaFunction('FLOOR')!(null)).toBeNull()
    expect(getFormulaFunction('CEIL')!(3.1)).toBe(4)
    expect(getFormulaFunction('CEIL')!(undefined)).toBeNull()

    expect(getFormulaFunction('MIN')!([5, 2], true, 9)).toBe(1)
    expect(getFormulaFunction('MIN')!()).toBeNull()
    expect(getFormulaFunction('MAX')!([5, 2], false, 9)).toBe(9)
    expect(getFormulaFunction('MAX')!([NaN, null])).toBeNull()

    expect(getFormulaFunction('CLAMP')!(15, 0, 10)).toBe(10)
    expect(getFormulaFunction('CLAMP')!(-3, 0, 10)).toBe(0)
    expect(getFormulaFunction('CLAMP')!(5, null, 10)).toBeNull()

    expect(getFormulaFunction('SQRT')!(9)).toBe(3)
    expect(getFormulaFunction('SQRT')!(-1)).toBeNull()
    expect(getFormulaFunction('SQRT')!(null)).toBeNull()

    expect(getFormulaFunction('POW')!(2, 3)).toBe(8)
    expect(getFormulaFunction('POW')!(10, 1000)).toBeNull() // Infinity -> null
    expect(getFormulaFunction('POW')!(null, 2)).toBeNull()

    expect(getFormulaFunction('LOG')!(Math.E)).toBeCloseTo(1, 8)
    expect(getFormulaFunction('LOG')!(100, 10)).toBeCloseTo(2, 8)
    expect(getFormulaFunction('LOG')!(0)).toBeNull()
    expect(getFormulaFunction('LOG')!(-5)).toBeNull()
    expect(getFormulaFunction('LOG')!(10, 1)).toBeNull()
    expect(getFormulaFunction('LOG')!(10, -2)).toBeNull()

    expect(getFormulaFunction('SIGN')!(-5)).toBe(-1)
    expect(getFormulaFunction('SIGN')!(0)).toBe(0)
    expect(getFormulaFunction('SIGN')!(42)).toBe(1)
    expect(getFormulaFunction('SIGN')!(null)).toBeNull()
  })

  it('covers conditional & null-handling functions (IF, COALESCE, ISNULL, SAFE_DIV)', () => {
    const IF = getFormulaFunction('IF')!
    expect(IF(true, 10, 20)).toBe(10)
    expect(IF(false, true, false)).toBe(false)
    expect(IF(0, 10, 20)).toBe(20)
    expect(IF(NaN, 10, 20)).toBe(20)
    expect(IF(2, 'invalid', 20)).toBeNull()

    const COALESCE = getFormulaFunction('COALESCE')!
    expect(COALESCE(null, undefined, NaN, false, 7)).toBe(0) // false -> 0 finite
    expect(COALESCE(null, Infinity)).toBeNull()

    const ISNULL = getFormulaFunction('ISNULL')!
    expect(ISNULL(null)).toBe(true)
    expect(ISNULL(undefined)).toBe(true)
    expect(ISNULL(NaN)).toBe(true)
    expect(ISNULL(Infinity)).toBe(true)
    expect(ISNULL(0)).toBe(false)
    expect(ISNULL(false)).toBe(false)

    const SAFE_DIV = getFormulaFunction('SAFE_DIV')!
    expect(SAFE_DIV(10, 2)).toBe(5)
    expect(SAFE_DIV(10, 0)).toBeNull()
    expect(SAFE_DIV(10, 0, -1)).toBe(-1)
    expect(SAFE_DIV(null, 2, 99)).toBe(99)
    expect(SAFE_DIV(1e308, 1e-10, 0)).toBe(0) // overflow -> fallback
  })

  it('covers statistical & normalization functions (AVG, SUM, MEDIAN, STDDEV, COUNT, RATE, TRIMMED_AVG, RECENT_AVG, PERCENTILE, WEIGHTED_AVG, NORM, MAP_RANGE)', () => {
    expect(getFormulaFunction('AVG')!(10, 20, 30)).toBe(20)
    expect(getFormulaFunction('AVG')!()).toBeNull()

    expect(getFormulaFunction('SUM')!()).toBe(0)
    expect(getFormulaFunction('SUM')!([1, 2], true, 3)).toBe(7)

    expect(getFormulaFunction('MEDIAN')!([10, 2, 6])).toBe(6)
    expect(getFormulaFunction('MEDIAN')!([10, 2, 6, 4])).toBe(5)
    expect(getFormulaFunction('MEDIAN')!()).toBeNull()

    expect(getFormulaFunction('STDDEV')!(2, 4, 4, 4, 5, 5, 7, 9)).toBeCloseTo(2, 6)
    expect(getFormulaFunction('STDDEV')!()).toBeNull()

    expect(getFormulaFunction('COUNT')!()).toBe(0)
    expect(getFormulaFunction('COUNT')!([1, NaN, 2], true)).toBe(3)

    expect(getFormulaFunction('RATE')!(true, false, 5, 0)).toBe(0.5)
    expect(getFormulaFunction('RATE')!()).toBeNull()

    expect(getFormulaFunction('TRIMMED_AVG')!(100, 10, 20, 1)).toBe(15)
    expect(getFormulaFunction('TRIMMED_AVG')!(10, 20)).toBe(15)
    expect(getFormulaFunction('TRIMMED_AVG')!()).toBeNull()

    expect(getFormulaFunction('RECENT_AVG')!([10, 20, 30, 40], 2)).toBe(35)
    expect(getFormulaFunction('RECENT_AVG')!([10, 20, 30, 40])).toBe(30) // default 3
    expect(getFormulaFunction('RECENT_AVG')!([], 2)).toBeNull()

    expect(getFormulaFunction('PERCENTILE')!([10, 20, 30, 40], 50)).toBe(25)
    expect(getFormulaFunction('PERCENTILE')!([42], 90)).toBe(42)
    expect(getFormulaFunction('PERCENTILE')!([10, 20], 150)).toBe(20) // clamped to 100
    expect(getFormulaFunction('PERCENTILE')!([10, 20], -10)).toBe(10) // clamped to 0
    expect(getFormulaFunction('PERCENTILE')!([], 50)).toBeNull()

    expect(getFormulaFunction('WEIGHTED_AVG')!([10, 20, 30], [1, 3, 0])).toBe(17.5)
    expect(getFormulaFunction('WEIGHTED_AVG')!([10, 20], [0, -2])).toBeNull()
    expect(getFormulaFunction('WEIGHTED_AVG')!(10, 2)).toBe(10)

    expect(getFormulaFunction('NORM')!(50, 0, 100)).toBe(50)
    expect(getFormulaFunction('NORM')!(150, 0, 100)).toBe(100)
    expect(getFormulaFunction('NORM')!(-10, 0, 100)).toBe(0)
    expect(getFormulaFunction('NORM')!(10, 5, 5)).toBeNull()

    expect(getFormulaFunction('MAP_RANGE')!(5, 0, 10, 100, 200)).toBe(150)
    expect(getFormulaFunction('MAP_RANGE')!(5, 10, 10, 100, 200)).toBe(100)
    expect(getFormulaFunction('MAP_RANGE')!(null, 0, 10, 100, 200)).toBeNull()
  })
})
