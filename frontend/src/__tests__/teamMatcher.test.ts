/**
 * teamMatcher.test.ts
 *
 * 覆盖 teamMatcher.ts（buildTeamRegex + applyTeamChipsToHtml）的所有边界 case 与安全防护。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { buildTeamRegex, applyTeamChipsToHtml } from '@/components/ai/teamMatcher'

function makeContainer(html: string): HTMLDivElement {
  const div = document.createElement('div')
  div.innerHTML = html
  return div
}

function getChips(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.team-chip')].map(
    el => (el as HTMLElement).dataset['team'] ?? ''
  )
}

function getChipTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.team-chip')].map(
    el => el.textContent?.trim() ?? ''
  )
}

describe('buildTeamRegex', () => {
  it('空集合返回 null', () => {
    expect(buildTeamRegex(new Set())).toBeNull()
  })

  it('返回带 global flag 的正则', () => {
    const regex = buildTeamRegex(new Set(['27570']))
    expect(regex).not.toBeNull()
    expect(regex!.flags).toContain('g')
  })

  it('长数字优先于短数字排序，防止 "196" 在 "19600" 前匹配', () => {
    const regex = buildTeamRegex(new Set(['196', '19600']))
    expect(regex).not.toBeNull()
    const src = regex!.source
    expect(src.indexOf('19600')).toBeLessThan(src.indexOf('|196|') !== -1 ? src.indexOf('|196|') : src.indexOf('|196)'))
  })
})

describe('applyTeamChipsToHtml', () => {
  const teams = new Set(['27570', '19600', '24068'])
  let regex: RegExp | null

  beforeEach(() => {
    regex = buildTeamRegex(teams)
  })

  it('精准命中白名单中的队伍编号与多队伍并存', () => {
    const html = '<p>27570 和 19600 是强队，24068 也不错</p>'
    const c = makeContainer(applyTeamChipsToHtml(html, regex))
    expect(getChips(c)).toEqual(['27570', '19600', '24068'])
    expect(getChipTexts(c)).toEqual(['27570', '19600', '24068'])
  })

  it('子串不混淆：19600 不应命中 196006，非白名单数字不应高亮', () => {
    const r = buildTeamRegex(new Set(['19600']))
    const html = '<p>编号 196006 的总分是 180 分，今年 2026 年</p>'
    const c = makeContainer(applyTeamChipsToHtml(html, r))
    expect(getChips(c)).toEqual([])
  })

  it('紧跟标点的队伍编号能正确命中（如"27570，"）', () => {
    const html = '<p>我们支持 27570，以及 19600。</p>'
    const c = makeContainer(applyTeamChipsToHtml(html, regex))
    expect(getChips(c)).toEqual(['27570', '19600'])
  })

  it('highlights explicit #team, Team N, 队伍 N, and inline code #team even when knownTeamRegex is null', () => {
    const html = '<p>Rank #1 is #27570, followed by Team 19600, 队伍 24068 and <code>#8888</code>.</p>'
    const c = makeContainer(applyTeamChipsToHtml(html, null))
    expect(getChips(c)).toEqual(['27570', '19600', '24068', '8888'])
  })

  it('preserves <pre> code blocks and bare <code> non-team numbers', () => {
    const html = '<p>Compare 27570 with <code>27570</code> and <code>team_id = 27570</code></p><pre><code>#27570</code></pre>'
    const c = makeContainer(applyTeamChipsToHtml(html, regex))
    expect(getChips(c)).toEqual(['27570'])
    expect(c.querySelector('pre')?.textContent).toBe('#27570')
  })

  it('skips <a>...</a> link inner text and nested <code> inside <a> so links are never broken', () => {
    const html = [
      '<p>See <a href="https://ftc-events.firstinspires.org/team/27570" target="_blank" rel="noopener noreferrer">Team 27570</a>',
      'and <a href="https://example.com/19600"><code>#19600</code></a>,',
      'while standalone #24068 is still highlighted.</p>'
    ].join(' ')
    const c = makeContainer(applyTeamChipsToHtml(html, regex))
    expect(getChips(c)).toEqual(['24068'])
    const links = c.querySelectorAll('a')
    expect(links.length).toBe(2)
    expect(links[0]!.querySelector('.team-chip')).toBeNull()
    expect(links[1]!.querySelector('.team-chip')).toBeNull()
  })

  it('skips HTML tag attributes and numeric HTML entities like &#8203;', () => {
    const html = '<p data-id="27570" title="Team 19600">Zero&#8203;width and 27570</p>'
    const out = applyTeamChipsToHtml(html, buildTeamRegex(new Set(['27570', '19600', '8203'])))
    const c = makeContainer(out)
    expect(getChips(c)).toEqual(['27570'])
    expect(c.querySelector('p')?.getAttribute('data-id')).toBe('27570')
    expect(c.querySelector('p')?.getAttribute('title')).toBe('Team 19600')
  })

  it('escapes HTML attribute characters in aria-label and data-team to prevent attribute breakout XSS', () => {
    const maliciousRegex = /(27570" onmouseover="alert\(1\))/g
    const html = '<p>27570" onmouseover="alert(1)</p>'
    const out = applyTeamChipsToHtml(html, maliciousRegex)
    expect(out).not.toContain('" onmouseover="alert(1)"')
    expect(out).toContain('&quot;')
    const c = makeContainer(out)
    const chip = c.querySelector('.team-chip') as HTMLElement | null
    expect(chip).not.toBeNull()
    expect(chip!.getAttribute('onmouseover')).toBeNull()
  })
})
