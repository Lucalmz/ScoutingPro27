/**
 * teamMatcher.ts
 *
 * Phase 1: AI 消息中队伍编号白名单精准识别与安全 DOM 高亮。
 *
 * 安全约束（对应漏洞编号）：
 *   V1  - 在 renderMarkdown() 输出的 HTML DOM 上操作，不触碰原始 markdown 字符串
 *   V2  - 跳过 PRE/CODE 祖先节点（代码块内数字不高亮）
 *   V3  - 仅操作 TEXT_NODE，永不修改 HTML 属性
 *   V4  - isStreaming 为 true 时不调用（由调用方 AiChatView.vue 保证）
 *   V21 - 先收集所有待替换文本节点进数组，遍历结束后统一替换，
 *          避免"边走边改 DOM"导致节点跳过或重复处理。
 *          注意：不使用 TreeWalker（happy-dom 测试环境下行为不一致），
 *          改用纯递归 childNodes 遍历，可移植性更强。
 *   V22 - 正则实例由外部缓存传入，不在此处重建（buildTeamRegex 结果在
 *          knownTeams 变化时重建一次，渲染时直接复用）
 */

/**
 * 根据白名单构建正则表达式（结果应由调用方缓存，仅在 knownTeams 变化时重建 - V22）。
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
  // (?<!\d) 前向负断言 + (?!\d) 后向负断言：确保不匹配子串（V1 边界保证）
  return new RegExp(`(?<!\\d)(${pattern})(?!\\d)`, 'g')
}

/**
 * 判断一个节点是否处于 PRE 或 CODE 标签的祖先链中（V2）。
 */
function isInsideCodeBlock(node: Node, container: HTMLElement): boolean {
  let current = node.parentElement
  while (current && current !== container) {
    const tag = current.tagName.toUpperCase()
    if (tag === 'PRE' || tag === 'CODE') return true
    current = current.parentElement
  }
  return false
}

/**
 * 递归收集容器内所有符合条件的文本节点（V21：仅收集，不修改 DOM）。
 *
 * 不使用 TreeWalker，因为 happy-dom（vitest 测试环境）对 TreeWalker filter
 * 的实现与 W3C 标准有差异，会导致所有节点被过滤掉。纯 childNodes 递归
 * 在 happy-dom / jsdom / 真实浏览器中行为完全一致，可移植性最强。
 */
function collectTextNodes(
  node: Node,
  container: HTMLElement,
  regex: RegExp,
  result: Text[]
): void {
  if (node.nodeType === Node.TEXT_NODE) {
    // V2：跳过 PRE/CODE 内的文本节点
    if (isInsideCodeBlock(node, container)) return
    // 防重复高亮：跳过已经是 team-chip 子节点的文本
    if ((node.parentElement as HTMLElement | null)?.classList.contains('team-chip')) return

    const text = node.textContent ?? ''
    regex.lastIndex = 0  // global regex 有状态，test 前必须 reset
    if (regex.test(text)) {
      result.push(node as Text)
    }
    return
  }

  // 元素节点：递归处理子节点
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as HTMLElement
    // V2：整体跳过 PRE/CODE 元素及其所有子孙
    const tag = el.tagName.toUpperCase()
    if (tag === 'PRE' || tag === 'CODE') return
    // 跳过 team-chip 本身（防止递归进入已生成的徽章）
    if (el.classList.contains('team-chip')) return
  }

  for (const child of Array.from(node.childNodes)) {
    collectTextNodes(child, container, regex, result)
  }
}

/**
 * 将单个文本节点中命中正则的数字替换为队伍徽章 span。
 *
 * 使用 DocumentFragment 正向扫描构建新节点序列后整体替换原节点。
 * 单次 replaceChild 调用，对已完成遍历的节点列表无影响（V21）。
 */
function replaceTextNodeWithChips(textNode: Text, regex: RegExp): void {
  const text = textNode.textContent ?? ''
  regex.lastIndex = 0

  const fragment = document.createDocumentFragment()
  let lastIndex = 0
  let m: RegExpExecArray | null

  while ((m = regex.exec(text)) !== null) {
    const team = m[1]
    if (!team) continue

    // 负向断言是零宽的，m[0] === m[1]，matchStart = m.index
    const matchStart = m.index + (m[0].length - team.length)
    const matchEnd = matchStart + team.length

    // 匹配前的普通文本段
    if (matchStart > lastIndex) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex, matchStart)))
    }

    // 队伍徽章 span（data-team 供事件委托识别，V5）
    const chip = document.createElement('span')
    chip.className = 'team-chip'
    chip.dataset['team'] = team
    chip.textContent = team

    chip.setAttribute('role', 'button')
    chip.setAttribute('tabindex', '0')
    chip.setAttribute('aria-label', `查看队伍 ${team} 详情`)
    fragment.appendChild(chip)

    lastIndex = matchEnd
  }

  // 末尾剩余文本
  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(lastIndex)))
  }

  if (!fragment.hasChildNodes()) return

  // 整体替换原文本节点（单次 DOM 操作，V21）
  textNode.parentNode?.replaceChild(fragment, textNode)
}

/**
 * 在已渲染的 HTML 容器 DOM 中，安全高亮队伍编号为可交互徽章。
 *
 * 必须在 renderMarkdown() 之后、isStreaming 为 false 时调用（V1/V4）。
 *
 * @param container  消息内容的根 HTMLElement（.markdown-body）
 * @param teamRegex  由 buildTeamRegex() 返回的缓存正则；null 时立即返回（V22）
 */
export function highlightTeamChips(container: HTMLElement, teamRegex: RegExp | null): void {
  if (!teamRegex) return

  // ── 第一步：收集（只读遍历，不修改 DOM）── V21 核心
  const textNodesToProcess: Text[] = []
  teamRegex.lastIndex = 0
  collectTextNodes(container, container, teamRegex, textNodesToProcess)

  // ── 第二步：统一替换（遍历结束后才修改 DOM，V21 关键保证）──
  for (const textNode of textNodesToProcess) {
    teamRegex.lastIndex = 0  // 每次替换前 reset，防止循环间 lastIndex 串扰
    replaceTextNodeWithChips(textNode, teamRegex)
  }
}

/**
 * 在 HTML 字符串中安全替换正文文本里的队伍编号为可点击徽章。
 * 自动跳过 HTML 标签、属性以及 PRE/CODE 代码块（V1/V2/V3 防护）。
 */
export function applyTeamChipsToHtml(html: string, regex: RegExp | null): string {
  if (!html || !regex) return html

  // 匹配 HTML 标签及代码块或队伍编号
  const combinedRegex = new RegExp(
    `(<pre[\\s\\S]*?<\\/pre>|<code[\\s\\S]*?<\\/code>|<[^>]+>)|${regex.source}`,
    'gi'
  )

  return html.replace(combinedRegex, (match, tag) => {
    // 命中 HTML 标签或代码块，原样返回
    if (tag) return tag

    const team = match.trim()
    if (!team) return match

    return `<span class="team-chip" data-team="${team}" role="button" tabindex="0" aria-label="查看队伍 ${team} 详情">${team}</span>`
  })
}
