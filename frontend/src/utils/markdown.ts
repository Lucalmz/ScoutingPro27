import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/common'
import 'highlight.js/styles/github-dark.css'

const md = new MarkdownIt({
  html: false, // Disallow raw HTML to prevent XSS attacks
  xhtmlOut: false,
  breaks: true,
  langPrefix: 'language-',
  linkify: true,
  typographer: true,
  highlight: (str: string, lang: string): string => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code class="hljs language-${md.utils.escapeHtml(lang)}">${hljs.highlight(str, { language: lang, ignoreIllegals: true }).value}</code></pre>`
      } catch {
        // Fallback below
      }
    }
    const escaped = md.utils.escapeHtml(str)
    const langClass = lang ? ` language-${md.utils.escapeHtml(lang)}` : ''
    return `<pre class="hljs"><code class="hljs${langClass}">${escaped}</code></pre>`
  }
})

// Ensure external links open safely in a new tab with noopener
const defaultLinkRender =
  md.renderer.rules.link_open ||
  function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options)
  }

md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
  const token = tokens[idx]
  if (token) {
    const targetIndex = token.attrIndex('target')
    if (targetIndex < 0) {
      token.attrPush(['target', '_blank'])
    } else if (token.attrs && token.attrs[targetIndex]) {
      const attr = token.attrs[targetIndex]
      if (attr) attr[1] = '_blank'
    }
    const relIndex = token.attrIndex('rel')
    if (relIndex < 0) {
      token.attrPush(['rel', 'noopener noreferrer'])
    } else if (token.attrs && token.attrs[relIndex]) {
      const attr = token.attrs[relIndex]
      if (attr) attr[1] = 'noopener noreferrer'
    }
  }
  return defaultLinkRender(tokens, idx, options, env, self)
}

// Wrap fenced code blocks with header bar + safe copy button (text read from DOM code element on click)
md.renderer.rules.fence = function (tokens, idx, options, env) {
  const token = tokens[idx]
  if (!token) return ''
  const info = token.info ? md.utils.unescapeAll(token.info).trim() : ''
  const langName = info ? info.split(/\s+/g)[0] || '' : ''
  const displayLang = md.utils.escapeHtml(langName || 'code')
  const copyLabel = md.utils.escapeHtml(
    env && typeof env.copyLabel === 'string' && env.copyLabel.trim() ? env.copyLabel : 'Copy'
  )

  let highlighted = ''
  if (options.highlight) {
    highlighted = options.highlight(token.content, langName, '')
  } else {
    highlighted = `<pre class="hljs"><code class="hljs">${md.utils.escapeHtml(token.content)}</code></pre>`
  }

  return `<div class="md-code-block"><div class="md-code-header"><span class="md-code-lang">${displayLang}</span><button type="button" class="md-code-copy-btn" data-code-copy>${copyLabel}</button></div>${highlighted}</div>\n`
}

// Wrap tables in a horizontal scroll container so wide tactical tables never overflow compact sidebars
const defaultTableOpen =
  md.renderer.rules.table_open ||
  function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options)
  }
const defaultTableClose =
  md.renderer.rules.table_close ||
  function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options)
  }

md.renderer.rules.table_open = function (tokens, idx, options, env, self) {
  return `<div class="md-table-scroll">${defaultTableOpen(tokens, idx, options, env, self)}`
}

md.renderer.rules.table_close = function (tokens, idx, options, env, self) {
  return `${defaultTableClose(tokens, idx, options, env, self)}</div>`
}

export function renderMarkdown(content: string, options?: { copyLabel?: string }): string {
  if (!content) return ''
  return md.render(content, { copyLabel: options?.copyLabel })
}
