import type { AiThinkingMode } from '@/types'
import { isStaticCloudHost } from '@/services/api'

export const DEFAULT_ANTHROPIC_VERSION = '2023-06-01'

export const AI_PROFILE_DEFAULTS = {
  temperature: 0.4,
  maxTokens: 4096,
  enableThinking: false,
  thinkingBudget: 4096,
  anthropicVersion: DEFAULT_ANTHROPIC_VERSION,
  maxContextMsgs: 16
} as const

export const THINKING_MODE_ORDER: readonly AiThinkingMode[] = ['off', 'low', 'medium', 'high'] as const

export const THINKING_MODE_CONFIG: Record<
  AiThinkingMode,
  { enableThinking: boolean; thinkingBudget: number; reasoningEffort: 'none' | 'low' | 'medium' | 'high' }
> = {
  off: { enableThinking: false, thinkingBudget: 0, reasoningEffort: 'none' },
  low: { enableThinking: true, thinkingBudget: 1024, reasoningEffort: 'low' },
  medium: { enableThinking: true, thinkingBudget: 4096, reasoningEffort: 'medium' },
  high: { enableThinking: true, thinkingBudget: 8192, reasoningEffort: 'high' }
}

export const MIN_DOCK_WIDTH = 360
export const MAX_DOCK_WIDTH = 680
export const DEFAULT_DOCK_WIDTH = 420

export const AI_LAYOUT = {
  WIDE_DESKTOP_BREAKPOINT: 1120,
  SIDEBAR_DOCK_BREAKPOINT: 720,
  DUAL_COLUMN_CARD_BREAKPOINT: 520,
  DEFAULT_MOBILE_WIDTH: 390
} as const

export const API_KEY_ERR_LOST = 'ERR_KEY_LOST'
export const API_KEY_MASK_SENTINEL = '****'

export const DEFAULT_THREAD_TITLES = ['New Tactical Chat', '新战术分析'] as const

/**
 * Returns true if the stored/input API key is blank or a masked sentinel (`****`, `***`, `ERR_KEY_LOST`),
 * so plain HTTP payloads do not overwrite server-held encrypted keys and mismatch detectors stay quiet.
 */
export function isMaskedOrPlaceholderApiKey(raw?: string | null): boolean {
  const key = (raw || '').trim()
  return !key || key === API_KEY_MASK_SENTINEL || key === API_KEY_ERR_LOST || key.includes('***')
}

export function isZhLocale(locale?: string | null): boolean {
  return (locale || 'zh').toLowerCase().startsWith('zh')
}

export interface AiFetchOptions extends RequestInit {
  token?: string
  onRefreshedToken?: (token: string) => void
}

function buildStaticHostAiResponse(url: string, method: string): Response {
  const upperMethod = method.toUpperCase()
  if (upperMethod === 'GET') {
    if (url.includes('/ai-profiles') || url.includes('/ai-settings') || url.includes('/ai-threads') || url.includes('/ai-chat')) {
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
  }
  if (url.includes('/api/ai/models') || url.includes('/api/ai/test-connection')) {
    return new Response(
      JSON.stringify({ success: false, models: [], error: 'AI backend is unavailable on static cloud host' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }
  return new Response(
    JSON.stringify({ error: 'AI backend is unavailable on static cloud host' }),
    { status: 503, headers: { 'Content-Type': 'application/json' } }
  )
}

/**
 * Unified fetch wrapper for AI HTTP endpoints:
 * - Short-circuits gracefully on static cloud hosts (GitHub Pages / Cloudflare Pages / Vercel / Netlify)
 * - Injects Bearer token
 * - Transparently applies `x-refreshed-token` to localStorage & userStore
 * - Clears credentials and dispatches `auth-unauthorized` on HTTP 401
 */
export async function aiFetch(url: string, options: AiFetchOptions = {}): Promise<Response> {
  const { token, onRefreshedToken, headers: rawHeaders, ...restInit } = options
  const method = (restInit.method || 'GET').toUpperCase()

  if (isStaticCloudHost()) {
    return buildStaticHostAiResponse(url, method)
  }

  const headers = new Headers(rawHeaders || {})
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  const res = await fetch(url, {
    ...restInit,
    method,
    headers
  })

  const refreshedToken = res.headers?.get?.('x-refreshed-token')
  if (refreshedToken) {
    try {
      if (typeof localStorage !== 'undefined' && localStorage) {
        const userJson = localStorage.getItem('scoutingpro-user')
        if (userJson) {
          const parsed = JSON.parse(userJson)
          if (parsed && typeof parsed === 'object') {
            parsed.token = refreshedToken
            localStorage.setItem('scoutingpro-user', JSON.stringify(parsed))
          }
        }
      }
    } catch {
      // ignore storage errors
    }
    onRefreshedToken?.(refreshedToken)
  }

  if (res.status === 401) {
    try {
      if (typeof localStorage !== 'undefined' && localStorage) {
        localStorage.removeItem('scoutingpro-user')
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('auth-unauthorized'))
      }
    } catch {
      // ignore storage/event errors
    }
  }

  if (res.status === 404) {
    const contentType = res.headers?.get?.('content-type') || ''
    if (contentType.includes('text/html')) {
      const text = await res.clone().text().catch(() => '')
      if (text.includes('<!DOCTYPE') || text.includes('<html') || text.includes('<head')) {
        return buildStaticHostAiResponse(url, method)
      }
    }
  }

  return res
}
