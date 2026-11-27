import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import AiMessageItem from '@/components/ai/AiMessageItem.vue'
import { i18n } from '@/i18n'
import { useToastStore } from '@/stores/toast'
import type { AiChatMessage } from '@/types'

describe('AiMessageItem.vue', () => {
  let writeTextMock: ReturnType<typeof vi.fn>
  const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const originalLocale = i18n.global.locale.value
  const wrappers: VueWrapper[] = []
  const track = (w: VueWrapper) => {
    wrappers.push(w)
    return w
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    i18n.global.locale.value = 'en'
    writeTextMock = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true
    })
  })

  afterEach(() => {
    while (wrappers.length > 0) {
      wrappers.pop()!.unmount()
    }
    if (originalClipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor)
    } else {
      delete (navigator as any).clipboard
    }
    i18n.global.locale.value = originalLocale
    vi.restoreAllMocks()
  })

  it('renders Markdown code copy, table scroll wrapper, thinking accordion, usage stats, and team chips', async () => {
    const assistantMsg: AiChatMessage = {
      id: 'm-asst-1',
      role: 'assistant',
      content: [
        '### Alliance Brief',
        '',
        '- Team 27570 fast cycle',
        '',
        '| Team | Auto |',
        '| --- | --- |',
        '| 27570 | 32 |',
        '',
        '```ts',
        'const score = 150',
        '```'
      ].join('\n'),
      reasoning: 'Step 1: Inspect TeleOp cycles.\nStep 2: Verify Swarm RP.',
      reasoningDurationMs: 1400,
      modelName: 'gemini-flash-latest',
      profileName: 'Gemini Pro',
      durationMs: 2600,
      usage: {
        promptTokens: 120,
        completionTokens: 45,
        totalTokens: 185,
        thoughtsTokens: 20
      }
    }

    const wrapper = track(mount(AiMessageItem, {
      props: {
        message: assistantMsg,
        isStreaming: false,
        isLatestAssistant: true,
        knownTeamRegex: /\b(27570|12345)\b/g,
        followUpSuggestions: [
          { label: 'Compare 27570', prompt: 'Compare 27570 vs 12345' }
        ]
      },
      global: {
        plugins: [i18n]
      }
    }))

    // Markdown rendered (not plain .user-text)
    const mdBody = wrapper.find('.markdown-body')
    expect(mdBody.exists()).toBe(true)
    expect(wrapper.find('.user-text').exists()).toBe(false)

    // Code block & table wrappers exist
    expect(mdBody.find('.md-code-block').exists()).toBe(true)
    expect(mdBody.find('.md-code-header').exists()).toBe(true)
    const copyCodeBtn = mdBody.find('[data-code-copy]')
    expect(copyCodeBtn.exists()).toBe(true)
    expect(copyCodeBtn.text()).toBe('Copy')
    expect(mdBody.find('.md-table-scroll table').exists()).toBe(true)

    // Usage pill & duration
    expect(wrapper.find('.msg-meta-stats').text()).toContain('2.6s')
    expect(wrapper.find('.msg-meta-stats').text()).toContain('120 in / 45 out')

    // Thinking starts collapsed when idle & content present, expands on click
    expect(wrapper.find('.thinking-body').exists()).toBe(false)
    await wrapper.find('.thinking-toggle').trigger('click')
    expect(wrapper.find('.thinking-body').exists()).toBe(true)
    expect(wrapper.find('.thinking-body').text()).toContain('Inspect TeleOp cycles')

    // Team chip click & keyboard Enter emit teamClick
    const teamChip = mdBody.find('[data-team="27570"]')
    expect(teamChip.exists()).toBe(true)
    await teamChip.trigger('click')
    expect(wrapper.emitted('teamClick')?.[0]).toEqual([27570])
    await teamChip.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('teamClick')?.[1]).toEqual([27570])

    // Code copy delegation copies code text, updates button label, & shows Toast
    await copyCodeBtn.trigger('click')
    await nextTick()
    expect(writeTextMock).toHaveBeenCalledWith('const score = 150\n')
    expect(copyCodeBtn.text()).toBe('Copied ✓')
    const toastStore = useToastStore()
    expect(toastStore.toasts.length).toBeGreaterThan(0)

    // Whole message copy button
    const actBtns = wrapper.findAll('.btn-msg-act')
    expect(actBtns.length).toBe(3) // copy, regenerate, delete
    await actBtns[0]!.trigger('click')
    expect(writeTextMock).toHaveBeenCalledWith(assistantMsg.content)

    // Regenerate & Delete emits
    await actBtns[1]!.trigger('click')
    expect(wrapper.emitted('regenerate')?.[0]).toEqual(['m-asst-1'])
    await actBtns[2]!.trigger('click')
    expect(wrapper.emitted('deleteMessage')?.[0]).toEqual(['m-asst-1'])

    // Follow-up chip click
    await wrapper.find('.followup-chip').trigger('click')
    expect(wrapper.emitted('sendFollowUp')?.[0]).toEqual(['Compare 27570 vs 12345'])
  })

  it('expands thinking live during reasoning phase and auto-collapses when answer text begins', async () => {
    const msg: AiChatMessage = {
      id: 'm-stream-1',
      role: 'assistant',
      content: '',
      reasoning: 'Evaluating Q14 partner compatibility...'
    }

    const wrapper = track(mount(AiMessageItem, {
      props: {
        message: msg,
        isStreaming: true,
        isLatestAssistant: true,
        knownTeamRegex: null
      },
      global: { plugins: [i18n] }
    }))

    // During reasoning-only phase, thinking accordion is expanded
    expect(wrapper.find('.thinking-body').exists()).toBe(true)

    // When content begins arriving, thinking auto-collapses once
    await wrapper.setProps({
      message: {
        ...msg,
        content: 'Here is the recommendation.'
      }
    })
    await nextTick()
    expect(wrapper.find('.thinking-body').exists()).toBe(false)
    expect(wrapper.find('.markdown-body').text()).toContain('Here is the recommendation.')
  })

  it('supports inline editing and re-sending user prompts', async () => {
    const userMsg: AiChatMessage = {
      id: 'm-user-1',
      role: 'user',
      content: 'Original question about 27570'
    }

    const wrapper = track(mount(AiMessageItem, {
      props: {
        message: userMsg,
        isStreaming: false,
        isLatestAssistant: false,
        knownTeamRegex: null
      },
      global: { plugins: [i18n] }
    }))

    expect(wrapper.find('.user-text').exists()).toBe(true)
    const editBtn = wrapper.findAll('.btn-msg-act')[0]!
    await editBtn.trigger('click')

    const textarea = wrapper.find('.inline-edit-textarea')
    expect(textarea.exists()).toBe(true)
    await textarea.setValue('Updated question for Q18')
    await wrapper.find('.btn-edit-resend').trigger('click')

    expect(wrapper.emitted('editResend')?.[0]).toEqual([
      { messageId: 'm-user-1', newContent: 'Updated question for Q18' }
    ])
  })

  it('renders localized Chinese usage stats and code-copy labels when locale is zh', async () => {
    i18n.global.locale.value = 'zh'
    const msg: AiChatMessage = {
      id: 'm-asst-zh',
      role: 'assistant',
      content: '```python\nprint(27570)\n```',
      durationMs: 1200,
      usage: {
        promptTokens: 120,
        completionTokens: 45,
        thoughtsTokens: 20
      }
    }

    const wrapper = track(mount(AiMessageItem, {
      props: {
        message: msg,
        isStreaming: false,
        isLatestAssistant: true,
        knownTeamRegex: null
      },
      global: { plugins: [i18n] }
    }))

    const copyBtn = wrapper.find('[data-code-copy]')
    expect(copyBtn.text()).toBe('复制')
    expect(wrapper.find('.msg-meta-stats').text()).toContain('120 输入 / 45 输出')
    expect(wrapper.find('.msg-meta-stats span[title]').attributes('title')).toBe('思考：20 tokens')

    await copyBtn.trigger('click')
    await nextTick()
    expect(copyBtn.text()).toBe('已复制 ✓')
  })

  it('keeps team chips clickable during streaming and renders Turbo execution receipt while hiding raw sp27-action JSON', async () => {
    const msg: AiChatMessage = {
      id: 'm-turbo-1',
      role: 'assistant',
      aiMode: 'turbo',
      content: [
        'I have updated #27570 as requested.',
        '',
        '```sp27-action',
        '{"actions":[{"type":"add_tag","teamNumber":27570,"tag":"fast-cycle"}]}',
        '```'
      ].join('\n'),
      turboActions: [
        {
          id: 'act-1',
          type: 'add_tag',
          status: 'success',
          summary: 'Added tag "fast-cycle" to #27570',
          actedAsUsername: 'captain'
        },
        {
          id: 'act-2',
          type: 'ban_team',
          status: 'error',
          summary: 'Ban #19600',
          error: 'Permission denied: only event Host can ban teams',
          actedAsUsername: 'captain'
        }
      ]
    }

    const wrapper = track(mount(AiMessageItem, {
      props: {
        message: msg,
        isStreaming: true,
        isLatestAssistant: true,
        knownTeamRegex: null
      },
      global: { plugins: [i18n] }
    }))

    // Team chip is clickable immediately while streaming
    const chip = wrapper.find('[data-team="27570"]')
    expect(chip.exists()).toBe(true)
    await chip.trigger('click')
    expect(wrapper.emitted('teamClick')?.[0]).toEqual([27570])

    // Raw sp27-action block is stripped from rendered markdown
    expect(wrapper.find('.markdown-body').text()).not.toContain('sp27-action')
    expect(wrapper.find('.markdown-body').text()).not.toContain('"actions"')

    // Turbo badge & execution receipt card are rendered in DOM
    expect(wrapper.find('.msg-turbo-pill').exists()).toBe(true)
    const receipt = wrapper.find('.turbo-receipt-card')
    expect(receipt.exists()).toBe(true)
    expect(receipt.text()).toContain('Turbo Execution (1/2)')
    expect(receipt.text()).toContain('Acted as: captain')
    expect(receipt.text()).toContain('Added tag "fast-cycle" to #27570')
    expect(receipt.text()).toContain('Permission denied: only event Host can ban teams')
  })

  it('escapes HTML quotes/tags in user messages and blocks dangerous link protocols in assistant markdown', () => {
    const userMsg: AiChatMessage = {
      id: 'm-user-xss',
      role: 'user',
      content: `<img src=x onerror="alert('xss')"> check #27570`
    }
    const userWrapper = track(mount(AiMessageItem, {
      props: {
        message: userMsg,
        isStreaming: false,
        isLatestAssistant: false,
        knownTeamRegex: /\b(27570)\b/g
      },
      global: { plugins: [i18n] }
    }))

    const userTextEl = userWrapper.find('.user-text')
    expect(userTextEl.exists()).toBe(true)
    expect(userTextEl.find('img').exists()).toBe(false)
    expect(userTextEl.text()).toContain(`<img src=x onerror="alert('xss')">`)
    expect(userTextEl.find('[data-team="27570"]').exists()).toBe(true)

    const asstMsg: AiChatMessage = {
      id: 'm-asst-xss',
      role: 'assistant',
      content: [
        '[ClickJS](javascript:alert(1))',
        '[ClickVBS](vbscript:msgbox(1))',
        '[ClickData](data:text/html,<script>alert(1)</script>)',
        '[Team 27570](https://ftc-events.firstinspires.org/team/27570)'
      ].join('\n')
    }
    const asstWrapper = track(mount(AiMessageItem, {
      props: {
        message: asstMsg,
        isStreaming: false,
        isLatestAssistant: true,
        knownTeamRegex: /\b(27570)\b/g
      },
      global: { plugins: [i18n] }
    }))

    const mdBody = asstWrapper.find('.markdown-body')
    expect(mdBody.exists()).toBe(true)
    const links = mdBody.findAll('a')
    for (const a of links) {
      const href = (a.attributes('href') || '').toLowerCase()
      expect(href.startsWith('javascript:')).toBe(false)
      expect(href.startsWith('vbscript:')).toBe(false)
      expect(href.startsWith('data:text/html')).toBe(false)
    }
    // Safe external link should remain intact without nested .team-chip
    expect(links.length).toBe(1)
    expect(links[0]!.attributes('href')).toBe('https://ftc-events.firstinspires.org/team/27570')
    expect(links[0]!.find('.team-chip').exists()).toBe(false)
  })

  it('strips sp27-action blocks from copy/TTS and hides copy button on action-only messages without prose', async () => {
    const mixedMsg: AiChatMessage = {
      id: 'm-mixed',
      role: 'assistant',
      content: 'Clean tactical advice.\n```sp27-action\n{"actions":[{"type":"set_my_team","teamNumber":27570}]}\n```',
      turboActions: [{ id: 'a1', type: 'set_my_team', status: 'success', summary: 'Set my team to #27570' }]
    }
    const mixedWrapper = track(mount(AiMessageItem, {
      props: { message: mixedMsg, isStreaming: false, isLatestAssistant: false, knownTeamRegex: null },
      global: { plugins: [i18n] }
    }))

    const copyBtn = mixedWrapper.find('.btn-msg-act[title="Copy content"]')
    expect(copyBtn.exists()).toBe(true)
    await copyBtn.trigger('click')
    expect(writeTextMock).toHaveBeenCalledWith('Clean tactical advice.')

    const actionOnlyMsg: AiChatMessage = {
      id: 'm-action-only',
      role: 'assistant',
      content: '```sp27-action\n{"actions":[{"type":"set_my_team","teamNumber":27570}]}\n```',
      turboActions: [{ id: 'a2', type: 'set_my_team', status: 'success', summary: 'Set my team to #27570' }]
    }
    const actionOnlyWrapper = track(mount(AiMessageItem, {
      props: { message: actionOnlyMsg, isStreaming: false, isLatestAssistant: false, knownTeamRegex: null },
      global: { plugins: [i18n] }
    }))

    expect(actionOnlyWrapper.find('.turbo-receipt-card').exists()).toBe(true)
    expect(actionOnlyWrapper.find('.btn-msg-act[title="Copy content"]').exists()).toBe(false)
  })
})
