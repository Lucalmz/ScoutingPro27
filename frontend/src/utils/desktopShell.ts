/**
 * Detects whether the frontend is hosted inside the desktop JCEF window
 * that already renders the native CustomTitleBar above the web viewport.
 */
export function hasDesktopTitleBar(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const params = new URLSearchParams(window.location.search)
    return params.get('shell') === 'desktop'
  } catch {
    return false
  }
}
