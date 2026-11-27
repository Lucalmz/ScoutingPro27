/**
 * teamMatcher.ts
 *
 * AI 消息中队伍编号白名单精准识别与安全 HTML 高亮。
 *
 * 安全约束：
 *   1. 仅在 renderMarkdown() 或已转义的 HTML 字符串上操作，不触碰原始 markdown 字符串
 *   2. 跳过 <pre>...</pre>、非纯队号的 <code>...</code>、<a ...>...</a> 链接内部及 HTML 标签/属性
 *   3. 对插入到 HTML 属性（如 aria-label、data-team）的文本严格做 HTML 属性转义
 *   4. 正则实例由外部缓存传入（buildTeamRegex 结果在 knownTeams 变化时重建一次）
 */

import { i18n } from '@/i18n'

function getTeamChipAria(team: string): string {
  try {
    if (i18n?.global?.t) {
      return i18n.global.t('ai.team_chip_aria', { team })
    }
  } catch {}
  return `Team ${team}`
}

function escapeHtmlAttr(val: string): string {
  return val
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 根据白名单构建正则表达式（结果应由调用方缓存，仅在 knownTeams 变化时重建）。
 *
 * @param knownTeams 当前赛事所有已知队伍编号字符串集合
 * @returns 带 'g' flag 的 RegExp，或 null（集合为空时）
 */
export function buildTeamRegex(knownTeams: Set<string>): RegExp | null {
  if (knownTeams.size === 0) return null

  const escaped = [...knownTeams].map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

  // 按长度降序排序，防止短数字在长数字前匹配（如 "196" 先于 "19600"）
  escaped.sort((a, b) => b.length - a.length)

  const pattern = escaped.join('|')
  // (?<!\d) 前向负断言 + (?!\d) 后向负断言：确保不匹配子串
  return new RegExp(`(?<!\\d)(${pattern})(?!\\d)`, 'g')
}

/**
 * 在 HTML 字符串中安全替换正文文本里的队伍编号为可点击徽章。
 * 自动跳过 <pre>...</pre>、<a ...>...</a>、非纯队号的 <code>...</code>、以及 HTML 标签/属性。
 * 同时支持白名单队伍号（如 27570）以及显式队伍标记（如 #27570、Team 27570、队伍 27570、<code>#27570</code>），
 * 即使 knownTeamRegex 为 null 或新队伍尚未录入排名表也能点击进入详情页。
 */
export function applyTeamChipsToHtml(html: string, regex: RegExp | null): string {
  if (!html) return html

  const renderChip = (teamNum: string, label: string): string => {
    const safeTeam = escapeHtmlAttr(teamNum)
    const ariaLabel = escapeHtmlAttr(getTeamChipAria(teamNum))
    return `<span class="team-chip" data-team="${safeTeam}" role="button" tabindex="0" aria-label="${ariaLabel}">${label}</span>`
  }

  const patterns: string[] = [
    '(?<blockPre><pre[\\s\\S]*?<\\/pre>)',
    '(?<blockLink><a\\b[^>]*>[\\s\\S]*?<\\/a>)',
    '(?<blockCode><code\\b[^>]*>[\\s\\S]*?<\\/code>)',
    '(?<htmlTag><[^>]+>)',
    '(?<htmlEntity>&#(?:\\d+|x[0-9a-f]+);)',
    '(?<explicitTeam>(?:\\bTeam\\s*#?(\\d{1,6})|队伍\\s*#?(\\d{1,6})|#(\\d{3,6}))(?!\\d))'
  ]
  if (regex && regex.source) {
    patterns.push(`(?<knownTeam>#?(?:${regex.source}))`)
  }

  const combinedRegex = new RegExp(patterns.join('|'), 'gi')

  return html.replace(combinedRegex, (match, ...args) => {
    const groups = args[args.length - 1] as Record<string, string | undefined> | undefined
    if (groups?.['blockPre'] || groups?.['blockLink'] || groups?.['htmlTag'] || groups?.['htmlEntity']) {
      return match
    }
    if (groups?.['blockCode']) {
      const innerMatch = match.match(/^<code\b[^>]*>([\s\S]*?)<\/code>$/i)
      const innerText = innerMatch?.[1]?.trim() || ''
      const explicitCodeTeam = innerText.match(/^(?:#(\d{1,6})|(?:Team|队伍)\s*#?(\d{1,6}))$/i)
      const codeTeamNum = explicitCodeTeam?.[1] || explicitCodeTeam?.[2]
      if (codeTeamNum) {
        return renderChip(codeTeamNum, `#${codeTeamNum}`)
      }
      return match
    }
    if (groups?.['explicitTeam']) {
      const numMatch = match.match(/(\d{1,6})/)
      const teamNum = numMatch?.[1]
      if (!teamNum) return match
      return renderChip(teamNum, match.trim())
    }
    if (groups?.['knownTeam']) {
      const raw = match.trim()
      const teamNum = raw.startsWith('#') ? raw.slice(1) : raw
      if (!teamNum) return match
      return renderChip(teamNum, raw)
    }
    return match
  })
}
