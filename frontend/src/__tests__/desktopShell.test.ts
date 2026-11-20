import { describe, it, expect, afterEach } from 'vitest'
import { hasDesktopTitleBar } from '@/utils/desktopShell'

describe('desktopShell', () => {
  afterEach(() => {
    window.history.replaceState({}, '', '/')
  })

  it('returns true when ?shell=desktop is present', () => {
    window.history.replaceState({}, '', '/index.html?shell=desktop#/dashboard')
    expect(hasDesktopTitleBar()).toBe(true)
  })

  it('returns false when query is empty', () => {
    window.history.replaceState({}, '', '/index.html#/dashboard')
    expect(hasDesktopTitleBar()).toBe(false)
  })

  it('returns false when unrelated query params are present', () => {
    window.history.replaceState({}, '', '/index.html?join=ABC123&shell=web#/')
    expect(hasDesktopTitleBar()).toBe(false)
  })
})
