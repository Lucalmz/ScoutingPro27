import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import ImagePreviewModal from '@/components/common/ImagePreviewModal.vue'

describe('ImagePreviewModal', () => {
  it('does not render when modelValue is false', () => {
    const wrapper = mount(ImagePreviewModal, {
      props: {
        modelValue: false,
        imageUrl: 'https://example.com/robot.jpg'
      }
    })
    expect(wrapper.find('.image-preview-overlay').exists()).toBe(false)
  })

  it('renders correctly when modelValue is true with single image', async () => {
    const wrapper = mount(ImagePreviewModal, {
      props: {
        modelValue: true,
        imageUrl: 'https://example.com/robot.jpg',
        title: 'Team 12345 Robot'
      },
      attachTo: document.body
    })

    const overlay = document.querySelector('.image-preview-overlay')
    expect(overlay).not.toBeNull()

    const title = document.querySelector('.preview-title')
    expect(title?.textContent).toContain('Team 12345 Robot')

    const img = document.querySelector('.preview-image') as HTMLImageElement
    expect(img?.src).toContain('robot.jpg')

    // No nav buttons for single image
    expect(document.querySelector('.prev-btn')).toBeNull()
    expect(document.querySelector('.next-btn')).toBeNull()

    wrapper.unmount()
  })

  it('renders multi-image navigation and cycles through images', async () => {
    const images = [
      'https://example.com/img1.jpg',
      'https://example.com/img2.jpg',
      'https://example.com/img3.jpg'
    ]

    const wrapper = mount(ImagePreviewModal, {
      props: {
        modelValue: true,
        images,
        initialIndex: 0
      },
      attachTo: document.body
    })

    const counter = document.querySelector('.preview-counter')
    expect(counter?.textContent?.trim()).toBe('1 / 3')

    const nextBtn = document.querySelector('.next-btn') as HTMLButtonElement
    expect(nextBtn).not.toBeNull()
    nextBtn.click()
    await wrapper.vm.$nextTick()

    expect(document.querySelector('.preview-counter')?.textContent?.trim()).toBe('2 / 3')

    const prevBtn = document.querySelector('.prev-btn') as HTMLButtonElement
    prevBtn.click()
    await wrapper.vm.$nextTick()

    expect(document.querySelector('.preview-counter')?.textContent?.trim()).toBe('1 / 3')

    wrapper.unmount()
  })

  it('emits update:modelValue false when close button clicked or Escape pressed', async () => {
    const wrapper = mount(ImagePreviewModal, {
      props: {
        modelValue: true,
        imageUrl: 'https://example.com/robot.jpg'
      },
      attachTo: document.body
    })

    const closeBtn = document.querySelector('.close-btn') as HTMLButtonElement
    closeBtn.click()
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false])

    // Escape key
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.emitted('update:modelValue')?.length).toBeGreaterThanOrEqual(2)

    wrapper.unmount()
  })

  it('converts data: URL to Blob and opens via URL.createObjectURL to bypass browser security restrictions', async () => {
    const originalOpen = window.open
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL

    const mockOpen = vi.fn()
    const mockCreateObjectURL = vi.fn().mockReturnValue('blob:http://localhost/mock-blob-uuid')
    const mockRevokeObjectURL = vi.fn()

    window.open = mockOpen
    URL.createObjectURL = mockCreateObjectURL
    URL.revokeObjectURL = mockRevokeObjectURL

    try {
      const dataUrl = 'data:image/webp;base64,AAAA'
      const wrapper = mount(ImagePreviewModal, {
        props: {
          modelValue: true,
          imageUrl: dataUrl
        },
        attachTo: document.body
      })

      const openBtn = document.querySelector('button[title="查看原图"]') as HTMLButtonElement
      expect(openBtn).not.toBeNull()
      openBtn.click()

      expect(mockCreateObjectURL).toHaveBeenCalledTimes(1)
      const passedBlob = mockCreateObjectURL.mock.calls[0][0]
      expect(passedBlob).toBeInstanceOf(Blob)
      expect(passedBlob.type).toBe('image/webp')

      expect(mockOpen).toHaveBeenCalledWith('blob:http://localhost/mock-blob-uuid', '_blank')
      wrapper.unmount()
    } finally {
      window.open = originalOpen
      URL.createObjectURL = originalCreateObjectURL
      URL.revokeObjectURL = originalRevokeObjectURL
    }
  })

  it('opens standard http/https image URL directly without Blob conversion', async () => {
    const originalOpen = window.open
    const originalCreateObjectURL = URL.createObjectURL

    const mockOpen = vi.fn()
    const mockCreateObjectURL = vi.fn()

    window.open = mockOpen
    URL.createObjectURL = mockCreateObjectURL

    try {
      const wrapper = mount(ImagePreviewModal, {
        props: {
          modelValue: true,
          imageUrl: 'https://example.com/robot-hd.jpg'
        },
        attachTo: document.body
      })

      const openBtn = document.querySelector('button[title="查看原图"]') as HTMLButtonElement
      expect(openBtn).not.toBeNull()
      openBtn.click()

      expect(mockCreateObjectURL).not.toHaveBeenCalled()
      expect(mockOpen).toHaveBeenCalledWith('https://example.com/robot-hd.jpg', '_blank')
      wrapper.unmount()
    } finally {
      window.open = originalOpen
      URL.createObjectURL = originalCreateObjectURL
    }
  })
})
