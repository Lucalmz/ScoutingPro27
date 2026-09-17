import { i18n } from '@/i18n'

export class ApiError extends Error {
  status: number
  path: string
  method: string
  serverMessage: string

  constructor(status: number, path: string, method: string, serverMessage: string) {
    super(`API ${method} ${path} failed (${status}): ${serverMessage}`)
    this.name = 'ApiError'
    this.status = status
    this.path = path
    this.method = method
    this.serverMessage = serverMessage
  }
}

export interface FriendlyErrorResult {
  message: string
  detail?: string
}

/**
 * 将任意异常（ApiError、原生 Error、网络断开等）转化为通俗易懂、带有定位指引的友好提示
 */
export function formatUserFriendlyError(
  error: unknown,
  fallbackMessage?: string
): FriendlyErrorResult {
  const t = i18n?.global?.t ? i18n.global.t.bind(i18n.global) : ((key: string) => key)

  let status = 0
  let path = ''
  let method = ''
  let rawText = ''

  if (error instanceof ApiError) {
    status = error.status
    path = error.path
    method = error.method
    rawText = error.serverMessage || ''
  } else if (error instanceof Error) {
    rawText = error.message || ''
    // 兼容可能已经拼接过的 API 报错字串
    const match = rawText.match(/API\s+(GET|POST|PUT|DELETE)\s+([^\s]+)\s+failed\s+\((\d+)\):\s*(.*)/i)
    if (match) {
      method = match[1] ?? ''
      path = match[2] ?? ''
      status = parseInt(match[3] ?? '0', 10)
      rawText = match[4] ?? ''
    }
  } else if (typeof error === 'string') {
    rawText = error
  } else if (error && typeof error === 'object') {
    rawText = (error as any).message || JSON.stringify(error)
  }

  // 尝试解析后端返回的 JSON 错误信息 { "error": "..." }
  if (rawText && rawText.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(rawText)
      if (parsed && typeof parsed.error === 'string') {
        rawText = parsed.error
      }
    } catch {
      // 保持原始文本
    }
  }

  const lowerMsg = rawText.toLowerCase()
  const detail = rawText ? rawText.trim() : undefined

  // 1. 网络离线、服务未启动或连接被拒
  if (
    lowerMsg.includes('failed to fetch') ||
    lowerMsg.includes('networkerror') ||
    lowerMsg.includes('err_connection_refused') ||
    lowerMsg.includes('load failed') ||
    lowerMsg.includes('network error')
  ) {
    return {
      message: t('errors.network_unreachable') || '无法连接到后台服务，请确认网络连接或 ScoutingPro 后台已启动',
      detail
    }
  }

  // 2. 超时异常 (仅限真正 API/HTTP 请求的超时，不误伤 WebRTC/SAS 等应用内非 HTTP 消息)
  const isApiRequest = Boolean(error instanceof ApiError || path.startsWith('/api') || status === 408 || status === 504)
  const isApiTimeout =
    status === 408 ||
    status === 504 ||
    lowerMsg.includes('localapitimeouterror') ||
    lowerMsg.includes('挂起超过') ||
    lowerMsg.includes('gateway timeout') ||
    (isApiRequest && (lowerMsg.includes('timeout') || lowerMsg.includes('timed out') || lowerMsg.includes('timedout') || lowerMsg.includes('aborterror')))

  if (isApiTimeout) {
    return {
      message: t('errors.request_timeout') || '服务响应超时，请检查后台运行状态或稍后重试',
      detail
    }
  }

  // 3. 用户与认证模块 (密码错 / 账号存在 / 改密 / 合并)
  if (
    lowerMsg.includes('invalid credentials') ||
    (status === 401 && path.includes('/user/login'))
  ) {
    return {
      message: t('errors.invalid_credentials') || '密码或用户名错误，请核对后重试',
      detail
    }
  }

  if (lowerMsg.includes('incorrect old password')) {
    return {
      message: t('errors.incorrect_old_password') || '原密码输入错误，请确认当前账号密码后再试',
      detail
    }
  }

  if (lowerMsg.includes('invalid target account password')) {
    return {
      message: t('errors.invalid_target_password') || '合并的目标账号密码错误，请核对目标账号凭据',
      detail
    }
  }

  if (lowerMsg.includes('passwords do not match') || lowerMsg.includes('password mismatch')) {
    return {
      message: t('errors.password_mismatch') || '两次输入的密码不一致，请重新确认',
      detail
    }
  }

  if (lowerMsg.includes('username already taken')) {
    return {
      message: t('errors.username_taken') || '该用户名已被占用，请尝试其他名称',
      detail
    }
  }

  if (
    lowerMsg.includes('user already exists') ||
    (status === 409 && path.includes('/user/register'))
  ) {
    return {
      message: t('errors.user_already_exists') || '该用户名已被注册，若为您的账号请直接登录，或换一个名称',
      detail
    }
  }

  if (lowerMsg.includes('target user not found')) {
    return {
      message: t('errors.target_user_not_found') || '目标合并账号不存在，请检查用户名是否输入正确',
      detail
    }
  }

  if (lowerMsg.includes('cannot merge user into itself')) {
    return {
      message: t('errors.cannot_merge_self') || '不能将账号与自身合并',
      detail
    }
  }

  if (lowerMsg.includes('username and password required') || lowerMsg.includes('targetusername and targetpassword required')) {
    return {
      message: t('errors.credentials_required') || '请输入完整的用户名和密码',
      detail
    }
  }

  if (lowerMsg.includes('too long') || lowerMsg.includes('newusername too long')) {
    return {
      message: t('errors.input_too_long') || '用户名或密码超出长度限制（用户名最多50字，密码最多72位）',
      detail
    }
  }

  if (status === 401 && !path.includes('/user/login')) {
    return {
      message: t('errors.session_expired') || '登录状态已失效或未授权，请重新登录',
      detail
    }
  }

  // 4. 赛事与邀请码
  if (
    lowerMsg.includes('missing invitecode') ||
    lowerMsg.includes('invalid invite code') ||
    (status === 404 && (path.includes('/events/join') || path.includes('/events/')))
  ) {
    return {
      message: t('errors.invalid_invite_code') || '邀请码无效或赛事不存在，请向赛事管理员索取正确的 6 位邀请码',
      detail
    }
  }

  // 5. FTC 官方赛事绑定与排程
  if (lowerMsg.includes('ftc 官方赛事代码不存在') || lowerMsg.includes('invalid ftceventcode')) {
    return {
      message: t('errors.ftc_event_not_found') || '未查询到该 FTC 官方赛事，请核对代码拼写与赛季（如 2026、USUTSAS1）',
      detail
    }
  }

  if (lowerMsg.includes('ftc 官方 api 校验失败') || status === 502) {
    return {
      message: t('errors.ftc_api_unreachable') || 'FTC 官方数据服务暂时无法连接，请检查外网或稍后重试',
      detail
    }
  }

  if (lowerMsg.includes('未解析出有效的赛程行') || lowerMsg.includes('csv_no_valid_rows')) {
    return {
      message: t('errors.invalid_csv_format') || 'CSV 赛程格式不匹配，请按示例模板整理后再上传',
      detail
    }
  }

  // 6. 维修区照片与文件系统
  if (
    lowerMsg.includes('failed to save photo') ||
    lowerMsg.includes('invalid photo key') ||
    lowerMsg.includes('missing photo data') ||
    lowerMsg.includes('photo_save_failed')
  ) {
    return {
      message: t('errors.photo_save_failed') || '照片保存失败，可能格式损坏或磁盘空间不足，请重试',
      detail
    }
  }

  // 7. 队伍禁赛与标签
  if (lowerMsg.includes('failed to ban team') || lowerMsg.includes('failed to unban team')) {
    return {
      message: t('errors.team_ban_failed') || '更新队伍状态失败，请刷新页面重试',
      detail
    }
  }

  if (lowerMsg.includes('duplicate_tag')) {
    return {
      message: t('errors.duplicate_tag') || '已存在相同标签，无需重复添加',
      detail
    }
  }

  // 8. 500 服务器未知内部错误
  if (status >= 500 || lowerMsg.includes('internal server error')) {
    return {
      message: t('errors.internal_server_error') || '服务器内部处理异常，请稍后重试',
      detail
    }
  }

  // 9. 兜底回退
  const cleanFallback = fallbackMessage || t('errors.operation_failed') || '操作遇到问题，请重试'
  return {
    message: cleanFallback,
    detail
  }
}
