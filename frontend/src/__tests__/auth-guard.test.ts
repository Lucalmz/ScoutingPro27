import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import router from '@/router'

describe('Global Authentication Navigation Guard', () => {
  beforeEach(async () => {
    localStorage.clear()
    await router.push('/')
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('redirects unauthenticated user from /dashboard to /', async () => {
    await router.push('/dashboard')
    expect(router.currentRoute.value.name).toBe('login')
  })

  it('redirects unauthenticated user from /event/evt-999 to /', async () => {
    await router.push('/event/evt-999')
    expect(router.currentRoute.value.name).toBe('login')
  })

  it('redirects unauthenticated user from /event/evt-999/team/27570 to /', async () => {
    await router.push('/event/evt-999/team/27570')
    expect(router.currentRoute.value.name).toBe('login')
  })

  it('redirects /join?code=XYZ to / with query preserved', async () => {
    await router.push('/join?code=XYZ123')
    expect(router.currentRoute.value.name).toBe('login')
    expect(router.currentRoute.value.query.code).toBe('XYZ123')
  })

  it('redirects to login when scoutingpro-user contains corrupted JSON', async () => {
    localStorage.setItem('scoutingpro-user', '{broken-json')
    await router.push('/dashboard')
    expect(router.currentRoute.value.name).toBe('login')
  })

  it('redirects to login when scoutingpro-user is missing token', async () => {
    localStorage.setItem(
      'scoutingpro-user',
      JSON.stringify({ id: 'u-no-token', username: 'Bob' })
    )
    await router.push('/dashboard')
    expect(router.currentRoute.value.name).toBe('login')
  })

  it('allows authenticated user with valid token to access /dashboard and /event/:id', async () => {
    localStorage.setItem(
      'scoutingpro-user',
      JSON.stringify({
        id: 'a85139c7-646c-3a4b-adf0-bfba2c631023',
        username: 'Alice',
        token: 'valid_jwt_token_123'
      })
    )

    await router.push('/dashboard')
    expect(router.currentRoute.value.name).toBe('dashboard')

    await router.push('/event/evt-valid-100')
    expect(router.currentRoute.value.name).toBe('event')
    expect(router.currentRoute.value.params.eventId).toBe('evt-valid-100')
  })
})
