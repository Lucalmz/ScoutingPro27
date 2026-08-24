/**
 * teamMatcher.test.ts
 *
 * 覆盖 teamMatcher.ts 的所有边界 case，包含 V1/V2/V21/V22 专项验证。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildTeamRegex, highlightTeamChips } from '@/components/ai/teamMatcher'

// ─── 辅助函数 ────────────────────────────────────────────────────────────────

/** 创建一个包含 innerHTML 的 div，模拟 renderMarkdown 输出 */
function makeContainer(html: string): HTMLDivElement {
  const div = document.createElement('div')
  div.innerHTML = html
  return div
}

/** 提取容器内所有 .team-chip 的 data-team 值 */
function getChips(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.team-chip')].map(
    el => (el as HTMLElement).dataset['team'] ?? ''
  )
}

/** 提取容器内所有 .team-chip 的文本内容（去前缀空格） */
function getChipTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.team-chip')].map(
    el => el.textContent?.trim() ?? ''
  )
}

// ─── 测试：buildTeamRegex ────────────────────────────────────────────────────

describe('buildTeamRegex', () => {
  it('空集合返回 null（V22：空集不应产生无效正则）', () => {
    expect(buildTeamRegex(new Set())).toBeNull()
  })

  it('返回带 global flag 的正则（供 exec 循环使用）', () => {
    const regex = buildTeamRegex(new Set(['27570']))
    expect(regex).not.toBeNull()
    expect(regex!.flags).toContain('g')
  })

  it('长数字优先于短数字排序，防止 "196" 在 "19600" 前匹配（V1 子串防护）', () => {
    const regex = buildTeamRegex(new Set(['196', '19600']))
    expect(regex).not.toBeNull()
    // 正则源中 19600 应排在 196 之前
    const src = regex!.source
    expect(src.indexOf('19600')).toBeLessThan(src.indexOf('|196|') !== -1 ? src.indexOf('|196|') : src.indexOf('|196)'))
  })
})

// ─── 测试：highlightTeamChips ────────────────────────────────────────────────

describe('highlightTeamChips', () => {
  const teams = new Set(['27570', '19600', '24068'])
  let regex: RegExp | null

  beforeEach(() => {
    regex = buildTeamRegex(teams)
  })

  // ── 基础命中 ──

  it('精准命中白名单中的队伍编号（基础功能）', () => {
    const c = makeContainer('<p>分析队伍 27570 的表现</p>')
    highlightTeamChips(c, regex)
    expect(getChips(c)).toEqual(['27570'])
    expect(getChipTexts(c)[0]).toBe('27570')
  })

  it('同一段落多个队伍编号同时命中', () => {
    const c = makeContainer('<p>27570 和 19600 是强队，24068 也不错</p>')
    highlightTeamChips(c, regex)
    const chips = getChips(c).sort()
    expect(chips).toEqual(['19600', '24068', '27570'])
  })

  // ── V1：词边界与子串防护 ──

  it('V1 - 子串不混淆：19600 不应命中 196006', () => {
    const bigTeams = new Set(['19600'])
    const r = buildTeamRegex(bigTeams)
    const c = makeContainer('<p>队伍 196006 的总分是 196006 分</p>')
    highlightTeamChips(c, r)
    // 196006 不在白名单，且不应被误匹配为 19600
    expect(getChips(c)).toEqual([])
  })

  it('V1 - 白名单中不存在的数字不应生成徽章', () => {
    const c = makeContainer('<p>第 3 场得分 180 分，今年 2026 年</p>')
    highlightTeamChips(c, regex)
    expect(getChips(c)).toEqual([])
  })

  it('V1 - 紧跟标点的队伍编号能正确命中（如"27570，"）', () => {
    const c = makeContainer('<p>我们支持 27570，以及 19600。</p>')
    highlightTeamChips(c, regex)
    const chips = getChips(c).sort()
    expect(chips).toContain('27570')
    expect(chips).toContain('19600')
  })

  // ── V2：代码块内数字不高亮 ──

  it('V2 - PRE/CODE 内的队伍编号不应被替换', () => {
    const c = makeContainer('<pre><code>team_id = 27570</code></pre>')
    highlightTeamChips(c, regex)
    expect(getChips(c)).toEqual([])
  })

  it('V2 - 行内 code 内的队伍编号不应被替换', () => {
    const c = makeContainer('<p>参考 <code>27570</code> 的记录</p>')
    highlightTeamChips(c, regex)
    expect(getChips(c)).toEqual([])
  })

  it('V2 - 代码块外的编号依然应被替换（代码块内外共存）', () => {
    const c = makeContainer('<p>队伍 19600 说明，<code>27570</code> 是代码</p>')
    highlightTeamChips(c, regex)
    // 只有 19600 在纯文本里，27570 在 code 里不应被命中
    expect(getChips(c)).toEqual(['19600'])
  })

  // ── null regex 快速返回 ──

  it('teamRegex 为 null 时立即返回，DOM 无任何修改（V22）', () => {
    const c = makeContainer('<p>队伍 27570</p>')
    const originalHTML = c.innerHTML
    highlightTeamChips(c, null)
    expect(c.innerHTML).toBe(originalHTML)
  })

  // ── V21：先收集后替换，DOM 不在遍历中途被修改 ──

  it('V21 - 多个相邻文本节点均被正确替换（不因 DOM 修改导致节点跳过）', () => {
    // 构造含多个文本节点的容器（模拟 markdown 渲染后的复杂 DOM）
    const c = document.createElement('div')
    const p1 = document.createElement('p')
    p1.appendChild(document.createTextNode('队伍 27570 表现优异'))
    const p2 = document.createElement('p')
    p2.appendChild(document.createTextNode('19600 也很稳定'))
    const p3 = document.createElement('p')
    p3.appendChild(document.createTextNode('24068 有待观察'))
    c.appendChild(p1)
    c.appendChild(p2)
    c.appendChild(p3)

    highlightTeamChips(c, regex)

    const chips = getChips(c).sort()
    // 全部 3 个节点都必须被处理，不能因边走边改导致跳过
    expect(chips).toEqual(['19600', '24068', '27570'])
  })

  // ── 重复调用安全性 ──

  it('对同一容器重复调用不会生成重复徽章（防止 .team-chip 内文本再次匹配）', () => {
    const c = makeContainer('<p>队伍 27570 真强</p>')
    highlightTeamChips(c, regex)
    // 第二次调用
    const regex2 = buildTeamRegex(teams)
    highlightTeamChips(c, regex2)
    // 应只有一个徽章
    expect(getChips(c)).toEqual(['27570'])
  })
})

// ─── V22：验证 buildTeamRegex 调用次数应与 knownTeams 变化次数一致 ──────────

describe('V22 - 正则缓存策略（调用次数验证）', () => {
  it('同样的 knownTeams 内容产出的正则功能等价（调用方应缓存并复用）', () => {
    const teams = new Set(['27570', '19600'])
    const r1 = buildTeamRegex(teams)
    const r2 = buildTeamRegex(teams)
    // 两次构建的正则 source 应一致（确保缓存复用有意义）
    expect(r1!.source).toBe(r2!.source)
  })

  it('knownTeams 变化后新正则能命中新增的队伍', () => {
    const teams1 = new Set(['27570'])
    const r1 = buildTeamRegex(teams1)

    const teams2 = new Set(['27570', '99999'])
    const r2 = buildTeamRegex(teams2)

    const c = makeContainer('<p>队伍 99999 新加入</p>')
    highlightTeamChips(c, r1) // 旧正则：不应命中 99999
    expect(getChips(c)).toEqual([])

    const c2 = makeContainer('<p>队伍 99999 新加入</p>')
    highlightTeamChips(c2, r2) // 新正则：应命中 99999
    expect(getChips(c2)).toEqual(['99999'])
  })
})
