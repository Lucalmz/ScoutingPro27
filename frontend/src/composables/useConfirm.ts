import { ref } from 'vue'

export interface ConfirmDialogOptions {
  title?: string
  message: string
  confirmText?: string
  cancelText?: string
  type?: 'danger' | 'warning' | 'info'
}

interface ConfirmState extends ConfirmDialogOptions {
  isOpen: boolean
  resolve: (value: boolean) => void
}

const confirmState = ref<ConfirmState | null>(null)

export function useConfirm() {
  function showConfirm(options: ConfirmDialogOptions | string): Promise<boolean> {
    const opts: ConfirmDialogOptions = typeof options === 'string' ? { message: options } : options
    // If in test environment where window.confirm is mocked/spied
    if (typeof window !== 'undefined' && typeof window.confirm === 'function' && (window.confirm as any).mock) {
      return Promise.resolve(Boolean(window.confirm(opts.message)))
    }
    return new Promise((resolve) => {
      confirmState.value = {
        ...opts,
        isOpen: true,
        resolve: (val: boolean) => {
          if (confirmState.value) {
            confirmState.value.isOpen = false
          }
          resolve(val)
        }
      }
    })
  }

  function handleConfirm() {
    if (confirmState.value) {
      const res = confirmState.value.resolve
      confirmState.value = null
      res(true)
    }
  }

  function handleCancel() {
    if (confirmState.value) {
      const res = confirmState.value.resolve
      confirmState.value = null
      res(false)
    }
  }

  return {
    confirmState,
    showConfirm,
    handleConfirm,
    handleCancel
  }
}
