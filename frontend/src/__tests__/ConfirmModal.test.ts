import { describe, it, expect, afterEach } from 'vitest'
import { mount, VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import ConfirmModal from '@/components/common/ConfirmModal.vue'
import { useConfirm } from '@/composables/useConfirm'

describe('ConfirmModal.vue & useConfirm', () => {
  const wrappers: VueWrapper[] = []
  const track = (w: VueWrapper) => {
    wrappers.push(w)
    return w
  }

  afterEach(() => {
    while (wrappers.length > 0) {
      wrappers.pop()!.unmount()
    }
    document.body.innerHTML = ''
  })

  it('renders modal when showConfirm is triggered and resolves on confirm', async () => {
    const { showConfirm, confirmState } = useConfirm()
    track(mount(ConfirmModal, { attachTo: document.body }))

    expect(confirmState.value).toBeNull()
    expect(document.body.querySelector('.confirm-modal-card')).toBeNull()

    const confirmPromise = showConfirm({
      title: '注意',
      message: '确定要丢弃吗？',
      type: 'warning'
    })

    await nextTick()
    expect(confirmState.value?.isOpen).toBe(true)

    const card = document.body.querySelector('.confirm-modal-card')
    expect(card).toBeTruthy()
    expect(card?.querySelector('.confirm-title')?.textContent).toContain('注意')
    expect(card?.querySelector('.confirm-message')?.textContent).toContain('确定要丢弃吗？')

    const confirmBtn = card?.querySelector('.btn-primary') as HTMLButtonElement
    confirmBtn.click()

    const result = await confirmPromise
    expect(result).toBe(true)
    expect(confirmState.value).toBeNull()
  })

  it('resolves false on cancel', async () => {
    const { showConfirm, confirmState } = useConfirm()
    track(mount(ConfirmModal, { attachTo: document.body }))

    const confirmPromise = showConfirm({
      message: '取消操作测试',
      type: 'danger'
    })

    await nextTick()

    const card = document.body.querySelector('.confirm-modal-card')
    expect(card).toBeTruthy()
    const cancelBtn = card?.querySelector('.btn-secondary') as HTMLButtonElement
    cancelBtn.click()

    const result = await confirmPromise
    expect(result).toBe(false)
    expect(confirmState.value).toBeNull()
  })
})
