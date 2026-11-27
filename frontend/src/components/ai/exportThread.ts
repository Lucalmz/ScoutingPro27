import type { AiChatThread } from '@/types'
import { stripTurboActionBlocks } from './turboAgent'

export interface ThreadExportLabels {
  event: string
  persona: string
  time: string
  reasoning: string
  roleYou: string
  roleCopilot: string
}

export function exportThreadToMarkdown(params: {
  thread: AiChatThread
  eventName: string
  labels: ThreadExportLabels
}): void {
  const { thread, eventName, labels } = params
  const lines: string[] = [
    `# ${thread.title}`,
    `> ${labels.event}: ${eventName} · ${labels.persona}: ${thread.personaId} · ${labels.time}: ${new Date().toLocaleString()}`,
    ''
  ]
  for (const m of thread.messages) {
    lines.push(`## ${m.role === 'user' ? labels.roleYou : `${labels.roleCopilot} (${m.modelName || 'Model'})`}`)
    if (m.reasoning) {
      lines.push(`<details><summary>${labels.reasoning}</summary>\n\n${m.reasoning}\n\n</details>\n`)
    }
    const cleanBody = m.role === 'assistant'
      ? stripTurboActionBlocks(m.content || '').displayContent
      : (m.content || '')
    if (cleanBody) {
      lines.push(cleanBody)
    }
    if (m.turboActions && m.turboActions.length > 0) {
      for (const act of m.turboActions) {
        lines.push(`- [${act.status}] ${act.summary}${act.detail ? ` — ${act.detail}` : ''}`)
      }
    }
    lines.push('')
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${thread.title.replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 40) || 'tactical_brief'}.md`
  a.click()
  URL.revokeObjectURL(url)
}
