import type { AiChatThread } from '@/types'

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
    lines.push(m.content || '')
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
