/**
 * Safe JSON parser with optional runtime type guard.
 * Returns parsed object of type T if valid, or null if parsing fails,
 * input is invalid, or the type guard check fails.
 */
export function safeJsonParse<T>(raw: unknown, guard?: (obj: any) => obj is T): T | null {
  if (typeof raw !== 'string' || !raw.trim()) {
    return null
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') {
      return null
    }
    if (guard && !guard(parsed)) {
      return null
    }
    return parsed as T
  } catch {
    return null
  }
}
