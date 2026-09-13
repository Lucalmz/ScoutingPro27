import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ConfirmModal from '@/components/common/ConfirmModal.vue'
import { useConfirm } from '@/composables/useConfirm'

describe('ConfirmModal.vue & useConfirm', () => {
  it('renders modal when showConfirm is triggered and resolves on confirm', async () => {
    const { showConfirm, confirmState } = useConfirm()
    const wrapper = mount(ConfirmModal)

    expect(confirmState.value).toBeNull()

    const confirmPromise = showConfirm({
      title: '注意',
      message: '确定要丢弃吗？',
      type: 'warning'
    })

    await wrapper.vm.$nextTick()
    expect(confirmState.value?.isOpen).toBe(true)

    // The modal overlay and card are rendered into body via Teleport
    const card = document.body.querySelector('.confirm-modal-card')
    expect(card).toBeTruthy()
    expect(card?.querySelector('.confirm-title')?.textContent).toContain('注意')
    expect(card?.querySelector('.confirm-message')?.textContent).toContain('确定要丢弃吗？')

    // Click confirm button
    const confirmBtn = card?.querySelector('.btn-primary') as HTMLButtonElement
    confirmBtn.click()

    const result = await confirmPromise
    expect(result).toBe(true)
    expect(confirmState.value).toBeNull()
  })

  it('resolves false on cancel', async () => {
    const { showConfirm, confirmState } = useConfirm()
    mount(ConfirmModal)

    const confirmPromise = showConfirm({
      message: '取消操作测试',
      type: 'danger'
    })

    await new Promise((r) => setTimeout(r, 10))

    const card = document.body.querySelector('.confirm-modal-card')
    const cancelBtn = card?.querySelector('.btn-secondary') as HTMLButtonElement
    cancelBtn.click()

    const result = await confirmPromise
    expect(result).toBe(false)
    expect(confirmState.value).toBeNull()
  })
})
