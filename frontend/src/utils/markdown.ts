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
        return `<pre class="hljs"><code class="hljs language-${lang}">${hljs.highlight(str, { language: lang, ignoreIllegals: true }).value}</code></pre>`
      } catch {
        // Fallback
      }
    }
    const escaped = md.utils.escapeHtml(str)
    return `<pre class="hljs"><code class="hljs">${escaped}</code></pre>`
  }
})

// Ensure external links open safely in a new tab with noopener
const defaultLinkRender = md.renderer.rules.link_open || function (tokens, idx, options, _env, self) {
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

export function renderMarkdown(content: string): string {
  if (!content) return ''
  return md.render(content)
}
