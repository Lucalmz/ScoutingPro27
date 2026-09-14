import { describe, it, expect, beforeEach } from 'vitest'
import { ApiError, formatUserFriendlyError } from '@/utils/errorHelper'
import { i18n } from '@/i18n'

describe('errorHelper.ts - formatUserFriendlyError', () => {
  beforeEach(() => {
    i18n.global.locale.value = 'zh'
  })

  it('converts network failures into user-friendly message', () => {
    const err1 = new Error('Failed to fetch')
    const res1 = formatUserFriendlyError(err1)
    expect(res1.message).toContain('无法连接到后台服务')

    const err2 = new Error('NetworkError when attempting to fetch resource.')
    const res2 = formatUserFriendlyError(err2)
    expect(res2.message).toContain('无法连接到后台服务')
  })

  it('converts timeout errors into user-friendly message', () => {
    const err = new Error('应用响应异常（请求 /api/records 挂起超过 8000ms），可能需要重启应用')
    const res = formatUserFriendlyError(err)
    expect(res.message).toContain('服务响应超时')
  })

  it('converts login credential errors into clear password prompt', () => {
    const apiErr = new ApiError(401, '/user/login', 'POST', 'Invalid credentials')
    const res = formatUserFriendlyError(apiErr)
    expect(res.message).toContain('密码或用户名错误')

    // Also supports raw string with API pattern
    const rawMsg = 'API POST /user/login failed (401): Invalid credentials'
    const res2 = formatUserFriendlyError(rawMsg)
    expect(res2.message).toContain('密码或用户名错误')
  })

  it('converts rename incorrect old password error', () => {
    const apiErr = new ApiError(401, '/user/rename', 'POST', 'Incorrect old password')
    const res = formatUserFriendlyError(apiErr)
    expect(res.message).toContain('原密码输入错误')
  })

  it('converts account merge target password error', () => {
    const apiErr = new ApiError(401, '/users/merge', 'POST', 'Invalid target account password')
    const res = formatUserFriendlyError(apiErr)
    expect(res.message).toContain('合并的目标账号密码错误')
  })

  it('converts target user not found and self merge', () => {
    const notFoundErr = new ApiError(404, '/users/merge', 'POST', 'Target user not found')
    expect(formatUserFriendlyError(notFoundErr).message).toContain('目标合并账号不存在')

    const selfErr = new ApiError(400, '/users/merge', 'POST', 'Cannot merge user into itself')
    expect(formatUserFriendlyError(selfErr).message).toContain('不能将账号与自身合并')
  })

  it('converts user registration duplicate and username taken', () => {
    const regErr = new ApiError(409, '/user/register', 'POST', 'User already exists')
    expect(formatUserFriendlyError(regErr).message).toContain('该用户名已被注册')

    const takenErr = new ApiError(409, '/user/rename', 'POST', 'Username already taken')
    expect(formatUserFriendlyError(takenErr).message).toContain('该用户名已被占用')
  })

  it('converts invite code errors for join event', () => {
    const err1 = new ApiError(404, '/events/join', 'POST', 'Event not found')
    expect(formatUserFriendlyError(err1).message).toContain('邀请码无效或赛事不存在')

    const err2 = new ApiError(400, '/events/join', 'POST', 'Missing inviteCode')
    expect(formatUserFriendlyError(err2).message).toContain('邀请码无效或赛事不存在')
  })

  it('converts FTC official event not found and mentions 2026 USUTSAS1', () => {
    const ftcErr = new ApiError(400, '/events/123/bind-ftc', 'POST', 'FTC 官方赛事代码不存在: INVALID (赛季 2026)')
    const res = formatUserFriendlyError(ftcErr)
    expect(res.message).toContain('未查询到该 FTC 官方赛事')
    expect(res.message).toContain('2026')
    expect(res.message).toContain('USUTSAS1')
  })

  it('converts FTC 502 gateway error', () => {
    const api502 = new ApiError(502, '/events/123/bind-ftc', 'POST', 'FTC 官方 API 校验失败: Connection refused')
    expect(formatUserFriendlyError(api502).message).toContain('FTC 官方数据服务暂时无法连接')
  })

  it('converts schedule CSV invalid format error', () => {
    const csvErr = new Error('未解析出有效的赛程行，请检查格式')
    expect(formatUserFriendlyError(csvErr).message).toContain('CSV 赛程格式不匹配')
  })

  it('converts photo save failure', () => {
    const photoErr = new ApiError(500, '/pit-scout/records/123/photos', 'POST', 'Failed to save photo to disk')
    expect(formatUserFriendlyError(photoErr).message).toContain('照片保存失败')
  })

  it('converts server 500 errors', () => {
    const serverErr = new ApiError(500, '/records', 'POST', 'Internal Server Error')
    expect(formatUserFriendlyError(serverErr).message).toContain('服务器内部处理异常')
  })

  it('parses JSON error responses from backend gracefully', () => {
    const jsonErr = new ApiError(400, '/ai/settings', 'POST', JSON.stringify({ error: 'Missing provider' }))
    const res = formatUserFriendlyError(jsonErr, 'AI 设置保存失败')
    expect(res.message).toBe('AI 设置保存失败')
    expect(res.detail).toBe('Missing provider')
  })

  it('supports English locale and outputs clear diagnostic messages', () => {
    i18n.global.locale.value = 'en'
    const loginErr = new ApiError(401, '/user/login', 'POST', 'Invalid credentials')
    const resLogin = formatUserFriendlyError(loginErr)
    expect(resLogin.message).toBe('Incorrect username or password. Please verify and try again.')

    const ftcErr = new ApiError(400, '/events/123/bind-ftc', 'POST', 'FTC 官方赛事代码不存在: INVALID')
    const resFtc = formatUserFriendlyError(ftcErr)
    expect(resFtc.message).toContain('FTC official event not found')
    expect(resFtc.message).toContain('2026')
    expect(resFtc.message).toContain('USUTSAS1')
  })
})
