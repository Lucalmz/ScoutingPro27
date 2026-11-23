import { describe, it, expect } from 'vitest'
import { renderMarkdown } from '@/utils/markdown'

describe('renderMarkdown utility', () => {
  it('renders bold, italics and headers', () => {
    const md = '### Strategy Plan\n**Team 27570** is *ready*.'
    const html = renderMarkdown(md)
    expect(html).toContain('<h3>Strategy Plan</h3>')
    expect(html).toContain('<strong>Team 27570</strong>')
    expect(html).toContain('<em>ready</em>')
  })

  it('renders syntax highlighted code blocks', () => {
    const md = '```json\n{"team": 27570, "score": 142.5}\n```'
    const html = renderMarkdown(md)
    expect(html).toContain('<pre class="hljs"><code class="hljs language-json">')
    expect(html).toContain('hljs-attr')
  })

  it('renders tables properly', () => {
    const md = '| Match | Score |\n|---|---|\n| Q1 | 120 |\n| Q2 | 145 |'
    const html = renderMarkdown(md)
    expect(html).toContain('<table>')
    expect(html).toContain('<th>Match</th>')
    expect(html).toContain('<td>120</td>')
  })

  it('escapes dangerous raw HTML and scripts safely', () => {
    const dirty = '<script>alert("hacked")</script>**Safe Content**<img src="x" onerror="alert(1)">'
    const html = renderMarkdown(dirty)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('<strong>Safe Content</strong>')
  })

  it('sets target="_blank" and rel="noopener noreferrer" on external links', () => {
    const md = '[FTC Events](https://ftc-events.firstinspires.org)'
    const html = renderMarkdown(md)
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })
})

describe('renderMarkdown v2 commercial wrappers', () => {
  it('wraps fenced code blocks with .md-code-block, .md-code-header, and [data-code-copy]', () => {
    const html = renderMarkdown('```ts\nconst team = 27570\n```')
    expect(html).toContain('class="md-code-block"')
    expect(html).toContain('class="md-code-header"')
    expect(html).toContain('class="md-code-lang">ts</span>')
    expect(html).toContain('data-code-copy')
    expect(html).toContain('<pre class="hljs">')
    expect(html).toContain('27570')
  })

  it('wraps plain fenced code blocks with fallback code lang', () => {
    const html = renderMarkdown('```\nhello pit\n```')
    expect(html).toContain('class="md-code-block"')
    expect(html).toContain('class="md-code-lang">code</span>')
    expect(html).toContain('hello pit')
  })

  it('wraps markdown tables with .md-table-scroll container', () => {
    const html = renderMarkdown('| Team | Avg |\n| --- | --- |\n| 27570 | 142.5 |')
    expect(html).toContain('<div class="md-table-scroll">')
    expect(html).toContain('<table>')
    expect(html).toContain('27570')
    expect(html).toMatch(/<\/table>\s*<\/div>/)
  })
})
