import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import MarkdownIt from 'markdown-it'
import puppeteer from 'puppeteer'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..', '..')
const docsDir = path.join(repoRoot, 'docs')

function githubSlug(rawText) {
  return String(rawText)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
}

function renderMarkdownWithAnchorsAndEmbeddedImages(mdContent, baseDir) {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false
  })

  const seenSlugs = new Map()
  const defaultHeadingOpen =
    md.renderer.rules.heading_open ||
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

  md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
    const inlineToken = tokens[idx + 1]
    const rawHeading = inlineToken?.children?.map((c) => c.content).join('') || inlineToken?.content || ''
    let slug = githubSlug(rawHeading)
    if (slug) {
      const count = seenSlugs.get(slug) || 0
      seenSlugs.set(slug, count + 1)
      if (count > 0) slug = `${slug}-${count}`
      tokens[idx].attrSet('id', slug)
    }
    return defaultHeadingOpen(tokens, idx, options, env, self)
  }

  const defaultImage =
    md.renderer.rules.image ||
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

  let embeddedCount = 0
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const src = tokens[idx].attrGet('src') || ''
    if (src && !src.startsWith('http://') && !src.startsWith('https://') && !src.startsWith('data:')) {
      const resolved = path.resolve(baseDir, src)
      if (!fs.existsSync(resolved)) {
        throw new Error(`Missing image referenced in markdown: ${src} -> ${resolved}`)
      }
      const ext = path.extname(resolved).toLowerCase().replace('.', '') || 'png'
      const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
      const b64 = fs.readFileSync(resolved).toString('base64')
      tokens[idx].attrSet('src', `data:${mime};base64,${b64}`)
      embeddedCount++
    }
    return defaultImage(tokens, idx, options, env, self)
  }

  const html = md.render(mdContent)
  return { html, embeddedCount }
}

function buildHtmlDocument({ lang, title, bodyHtml }) {
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8" />
  <title>${title}</title>
  <style>
    @page {
      size: A4;
      margin: 14mm 13mm 16mm 13mm;
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Segoe UI", system-ui, -apple-system, sans-serif;
      font-size: 10.2pt;
      line-height: 1.58;
      color: #0f172a;
      background: #ffffff;
    }
    h1 {
      font-size: 19pt;
      line-height: 1.25;
      color: #064e3b;
      margin: 0 0 10px 0;
      padding-bottom: 8px;
      border-bottom: 2.5px solid #10b981;
      break-after: avoid;
    }
    h2 {
      font-size: 13.8pt;
      line-height: 1.3;
      color: #0f172a;
      margin: 18px 0 8px 0;
      padding: 5px 10px;
      background: #f1f5f9;
      border-left: 4px solid #10b981;
      border-radius: 0 6px 6px 0;
      break-after: avoid;
    }
    h3 {
      font-size: 11pt;
      color: #1e293b;
      margin: 11px 0 5px 0;
      break-after: avoid;
    }
    p {
      margin: 5px 0 8px 0;
    }
    blockquote {
      margin: 8px 0 12px 0;
      padding: 8px 12px;
      background: #ecfdf5;
      border-left: 4px solid #10b981;
      border-radius: 0 6px 6px 0;
      color: #064e3b;
      break-inside: avoid;
    }
    blockquote p {
      margin: 3px 0;
    }
    hr {
      border: none;
      border-top: 1px solid #cbd5e1;
      margin: 14px 0;
    }
    ul, ol {
      margin: 4px 0 9px 0;
      padding-left: 20px;
    }
    li {
      margin: 3px 0;
    }
    a {
      color: #0284c7;
      text-decoration: none;
    }
    code {
      font-family: "Cascadia Code", "Consolas", monospace;
      font-size: 9pt;
      background: #f1f5f9;
      color: #0f172a;
      padding: 1px 4px;
      border-radius: 4px;
      border: 1px solid #e2e8f0;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 8px 0 12px 0;
      font-size: 9.2pt;
    }
    thead {
      display: table-header-group;
    }
    tr {
      break-inside: avoid;
    }
    th, td {
      border: 1px solid #cbd5e1;
      padding: 6px 8px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: #0f172a;
      color: #f8fafc;
      font-weight: 600;
    }
    tbody tr:nth-child(even) {
      background: #f8fafc;
    }
    img {
      display: block;
      max-width: 100%;
      max-height: 152mm;
      width: auto;
      height: auto;
      margin: 8px auto 10px auto;
      border-radius: 8px;
      border: 1px solid #94a3b8;
      box-shadow: 0 2px 8px rgba(15, 23, 42, 0.14);
      break-inside: avoid;
    }
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`
}

const TARGETS = [
  {
    lang: 'zh-CN',
    title: 'ScoutingPro 27 新手使用手册 (BIOBUZZ 赛季)',
    inputMd: path.join(docsDir, 'USER_GUIDE.zh.md'),
    outputPdf: path.join(docsDir, 'ScoutingPro27_UserGuide_ZH.pdf'),
    footerLabel: 'ScoutingPro 27 · BIOBUZZ 新手使用手册 (中文版)'
  },
  {
    lang: 'en',
    title: 'ScoutingPro 27 Beginner User Guide (BIOBUZZ Season)',
    inputMd: path.join(docsDir, 'USER_GUIDE.en.md'),
    outputPdf: path.join(docsDir, 'ScoutingPro27_UserGuide_EN.pdf'),
    footerLabel: 'ScoutingPro 27 · BIOBUZZ Beginner User Guide (English)'
  }
]

async function main() {
  console.log('🚀 [UserGuide PDF] Launching headless Chromium...')
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  })

  try {
    for (const target of TARGETS) {
      const mdRaw = fs.readFileSync(target.inputMd, 'utf8')
      const { html, embeddedCount } = renderMarkdownWithAnchorsAndEmbeddedImages(
        mdRaw,
        path.dirname(target.inputMd)
      )
      const fullHtml = buildHtmlDocument({
        lang: target.lang,
        title: target.title,
        bodyHtml: html
      })

      const page = await browser.newPage()
      await page.setContent(fullHtml, { waitUntil: 'load' })
      await page.evaluate(async () => {
        const imgs = Array.from(document.images)
        await Promise.all(
          imgs.map((img) =>
            img.complete && img.naturalWidth > 0
              ? Promise.resolve()
              : new Promise((resolve, reject) => {
                  img.onload = resolve
                  img.onerror = () => reject(new Error(`Failed to decode embedded image`))
                })
          )
        )
      })

      await page.pdf({
        path: target.outputPdf,
        format: 'A4',
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: '<div></div>',
        footerTemplate: `<div style="width:100%;font-size:8px;color:#64748b;padding:0 13mm;display:flex;justify-content:space-between;font-family:'Microsoft YaHei','Segoe UI',sans-serif;"><span>${target.footerLabel}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
        margin: {
          top: '14mm',
          right: '13mm',
          bottom: '16mm',
          left: '13mm'
        }
      })
      await page.close()

      const sizeKB = (fs.statSync(target.outputPdf).size / 1024).toFixed(1)
      console.log(`✅ Generated ${path.relative(repoRoot, target.outputPdf)} (${sizeKB} KB, ${embeddedCount} embedded images)`)
    }
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error('❌ PDF export failed:', err)
  process.exit(1)
})
