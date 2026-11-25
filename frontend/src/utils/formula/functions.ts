const toNumberArray = (args: unknown[]): number[] => {
  const out: number[] = []
  for (const arg of args) {
    if (Array.isArray(arg)) {
      for (const item of arg) {
        if (typeof item === 'number' && Number.isFinite(item)) {
          out.push(item)
        } else if (typeof item === 'boolean') {
          out.push(item ? 1 : 0)
        }
      }
    } else if (typeof arg === 'number' && Number.isFinite(arg)) {
      out.push(arg)
    } else if (typeof arg === 'boolean') {
      out.push(arg ? 1 : 0)
    }
  }
  return out
}

const toFiniteNumber = (val: unknown): number | null => {
  if (typeof val === 'number' && Number.isFinite(val)) return val
  if (typeof val === 'boolean') return val ? 1 : 0
  return null
}

const isTruthy = (val: unknown): boolean => {
  if (typeof val === 'boolean') return val
  if (typeof val === 'number') return Number.isFinite(val) && val !== 0
  return false
}

export type FormulaFn = (...args: unknown[]) => number | boolean | null

const registry: Record<string, FormulaFn> = Object.create(null)

registry['ABS'] = (x) => {
  const n = toFiniteNumber(x)
  return n === null ? null : Math.abs(n)
}

registry['ROUND'] = (x, digits = 0) => {
  const n = toFiniteNumber(x)
  const d = toFiniteNumber(digits)
  if (n === null || d === null) return null
  const clamped = Math.max(0, Math.min(10, Math.trunc(d)))
  const factor = Math.pow(10, clamped)
  return Math.round(n * factor) / factor
}

registry['FLOOR'] = (x) => {
  const n = toFiniteNumber(x)
  return n === null ? null : Math.floor(n)
}

registry['CEIL'] = (x) => {
  const n = toFiniteNumber(x)
  return n === null ? null : Math.ceil(n)
}

registry['MIN'] = (...args) => {
  const nums = toNumberArray(args)
  return nums.length === 0 ? null : Math.min(...nums)
}

registry['MAX'] = (...args) => {
  const nums = toNumberArray(args)
  return nums.length === 0 ? null : Math.max(...nums)
}

registry['CLAMP'] = (x, min, max) => {
  const n = toFiniteNumber(x)
  const lo = toFiniteNumber(min)
  const hi = toFiniteNumber(max)
  if (n === null || lo === null || hi === null) return null
  return Math.max(lo, Math.min(hi, n))
}

registry['SQRT'] = (x) => {
  const n = toFiniteNumber(x)
  if (n === null || n < 0) return null
  return Math.sqrt(n)
}

registry['POW'] = (base, exp) => {
  const b = toFiniteNumber(base)
  const e = toFiniteNumber(exp)
  if (b === null || e === null) return null
  const res = Math.pow(b, e)
  return Number.isFinite(res) ? res : null
}

registry['LOG'] = (x, base) => {
  const n = toFiniteNumber(x)
  if (n === null || n <= 0) return null
  if (base === undefined) {
    return Math.log(n)
  }
  const b = toFiniteNumber(base)
  if (b === null || b <= 0 || b === 1) return null
  return Math.log(n) / Math.log(b)
}

registry['SIGN'] = (x) => {
  const n = toFiniteNumber(x)
  return n === null ? null : Math.sign(n)
}

registry['IF'] = (cond, whenTrue, whenFalse) => {
  const chosen = isTruthy(cond) ? whenTrue : whenFalse
  if (typeof chosen === 'boolean') return chosen
  return toFiniteNumber(chosen)
}

registry['COALESCE'] = (...args) => {
  for (const arg of args) {
    const n = toFiniteNumber(arg)
    if (n !== null) return n
  }
  return null
}

registry['ISNULL'] = (x) => {
  return x === null || x === undefined || (typeof x === 'number' && !Number.isFinite(x))
}

registry['SAFE_DIV'] = (a, b, fallback = null) => {
  const num = toFiniteNumber(a)
  const den = toFiniteNumber(b)
  if (num === null || den === null || den === 0) {
    return fallback === undefined ? null : toFiniteNumber(fallback)
  }
  const res = num / den
  return Number.isFinite(res) ? res : toFiniteNumber(fallback)
}

registry['AVG'] = (...args) => {
  const nums = toNumberArray(args)
  if (nums.length === 0) return null
  return nums.reduce((acc, v) => acc + v, 0) / nums.length
}

registry['SUM'] = (...args) => {
  const nums = toNumberArray(args)
  if (nums.length === 0) return 0
  return nums.reduce((acc, v) => acc + v, 0)
}

registry['MEDIAN'] = (...args) => {
  const nums = toNumberArray(args).sort((a, b) => a - b)
  if (nums.length === 0) return null
  const mid = Math.floor(nums.length / 2)
  if (nums.length % 2 === 1) return nums[mid]!
  return (nums[mid - 1]! + nums[mid]!) / 2
}

registry['STDDEV'] = (...args) => {
  const nums = toNumberArray(args)
  if (nums.length === 0) return null
  const mean = nums.reduce((acc, v) => acc + v, 0) / nums.length
  const variance = nums.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / nums.length
  return Math.sqrt(variance)
}

registry['COUNT'] = (...args) => {
  return toNumberArray(args).length
}

registry['RATE'] = (...args) => {
  const nums = toNumberArray(args)
  if (nums.length === 0) return null
  const hits = nums.filter((v) => v > 0).length
  return hits / nums.length
}

registry['TRIMMED_AVG'] = (...args) => {
  const nums = toNumberArray(args).sort((a, b) => a - b)
  if (nums.length === 0) return null
  const sliced = nums.length >= 3 ? nums.slice(1, nums.length - 1) : nums
  return sliced.reduce((acc, v) => acc + v, 0) / sliced.length
}

registry['RECENT_AVG'] = (values, count = 3) => {
  const nums = toNumberArray([values])
  if (nums.length === 0) return null
  const n = Math.max(1, Math.trunc(toFiniteNumber(count) ?? 3))
  const recent = nums.slice(-n)
  return recent.reduce((acc, v) => acc + v, 0) / recent.length
}

registry['PERCENTILE'] = (values, p) => {
  const nums = toNumberArray([values]).sort((a, b) => a - b)
  const pct = toFiniteNumber(p)
  if (nums.length === 0 || pct === null) return null
  const clamped = Math.max(0, Math.min(100, pct))
  if (nums.length === 1) return nums[0]!
  const rank = (clamped / 100) * (nums.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return nums[lo]!
  return nums[lo]! + (nums[hi]! - nums[lo]!) * (rank - lo)
}

registry['WEIGHTED_AVG'] = (values, weights) => {
  const vals = Array.isArray(values) ? values : [values]
  const wts = Array.isArray(weights) ? weights : [weights]
  const len = Math.min(vals.length, wts.length)
  let weightedSum = 0
  let totalWeight = 0
  for (let i = 0; i < len; i++) {
    const v = toFiniteNumber(vals[i])
    const w = toFiniteNumber(wts[i])
    if (v !== null && w !== null && w > 0) {
      weightedSum += v * w
      totalWeight += w
    }
  }
  return totalWeight > 0 ? weightedSum / totalWeight : null
}

registry['NORM'] = (x, min, max) => {
  const n = toFiniteNumber(x)
  const lo = toFiniteNumber(min)
  const hi = toFiniteNumber(max)
  if (n === null || lo === null || hi === null || hi === lo) return null
  const scaled = ((n - lo) / (hi - lo)) * 100
  return Math.max(0, Math.min(100, scaled))
}

registry['MAP_RANGE'] = (x, inMin, inMax, outMin, outMax) => {
  const n = toFiniteNumber(x)
  const iLo = toFiniteNumber(inMin)
  const iHi = toFiniteNumber(inMax)
  const oLo = toFiniteNumber(outMin)
  const oHi = toFiniteNumber(outMax)
  if (n === null || iLo === null || iHi === null || oLo === null || oHi === null) return null
  if (iHi === iLo) return oLo
  return oLo + ((n - iLo) / (iHi - iLo)) * (oHi - oLo)
}

export const ALLOWED_FORMULA_FUNCTIONS: ReadonlySet<string> = new Set(Object.keys(registry))

export function getFormulaFunction(name: string): FormulaFn | undefined {
  const upper = name.toUpperCase()
  return Object.prototype.hasOwnProperty.call(registry, upper) ? registry[upper] : undefined
}
