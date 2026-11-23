import { describe, it, expect, vi, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mount, VueWrapper } from '@vue/test-utils'
import ImagePreviewModal from '@/components/common/ImagePreviewModal.vue'

describe('ImagePreviewModal', () => {
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

  it('does not render Teleported overlay when modelValue is false, and renders on true', async () => {
    const wrapper = track(mount(ImagePreviewModal, {
      props: {
        modelValue: false,
        imageUrl: 'https://example.com/robot.jpg'
      },
      attachTo: document.body
    }))
    expect(document.body.querySelector('.image-preview-overlay')).toBeNull()

    await wrapper.setProps({ modelValue: true })
    expect(document.body.querySelector('.image-preview-overlay')).not.toBeNull()
  })

  it('renders correctly when modelValue is true with single image', async () => {
    track(mount(ImagePreviewModal, {
      props: {
        modelValue: true,
        imageUrl: 'https://example.com/robot.jpg',
        title: 'Team 12345 Robot'
      },
      attachTo: document.body
    }))

    const overlay = document.body.querySelector('.image-preview-overlay')
    expect(overlay).not.toBeNull()

    const title = document.body.querySelector('.preview-title')
    expect(title?.textContent).toContain('Team 12345 Robot')

    const img = document.body.querySelector('.preview-image') as HTMLImageElement
    expect(img?.src).toContain('robot.jpg')

    expect(document.body.querySelector('.prev-btn')).toBeNull()
    expect(document.body.querySelector('.next-btn')).toBeNull()
  })

  it('renders multi-image navigation and cycles through images', async () => {
    const images = [
      'https://example.com/img1.jpg',
      'https://example.com/img2.jpg',
      'https://example.com/img3.jpg'
    ]

    const wrapper = track(mount(ImagePreviewModal, {
      props: {
        modelValue: true,
        images,
        initialIndex: 0
      },
      attachTo: document.body
    }))

    const counter = document.body.querySelector('.preview-counter')
    expect(counter?.textContent?.trim()).toBe('1 / 3')

    const nextBtn = document.body.querySelector('.next-btn') as HTMLButtonElement
    expect(nextBtn).not.toBeNull()
    nextBtn.click()
    await nextTick()

    expect(document.body.querySelector('.preview-counter')?.textContent?.trim()).toBe('2 / 3')

    const prevBtn = document.body.querySelector('.prev-btn') as HTMLButtonElement
    prevBtn.click()
    await nextTick()

    expect(document.body.querySelector('.preview-counter')?.textContent?.trim()).toBe('1 / 3')
  })

  it('emits update:modelValue false when close button clicked or Escape pressed', async () => {
    const wrapper = track(mount(ImagePreviewModal, {
      props: {
        modelValue: true,
        imageUrl: 'https://example.com/robot.jpg'
      },
      attachTo: document.body
    }))

    const closeBtn = document.body.querySelector('.close-btn') as HTMLButtonElement
    closeBtn.click()
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false])

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.emitted('update:modelValue')?.length).toBeGreaterThanOrEqual(2)
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
      track(mount(ImagePreviewModal, {
        props: {
          modelValue: true,
          imageUrl: dataUrl
        },
        attachTo: document.body
      }))

      const openBtn = document.body.querySelector('button[title="查看原图"]') as HTMLButtonElement
      expect(openBtn).not.toBeNull()
      openBtn.click()

      expect(mockCreateObjectURL).toHaveBeenCalledTimes(1)
      const passedBlob = mockCreateObjectURL.mock.calls[0][0]
      expect(passedBlob).toBeInstanceOf(Blob)
      expect(passedBlob.type).toBe('image/webp')

      expect(mockOpen).toHaveBeenCalledWith('blob:http://localhost/mock-blob-uuid', '_blank')
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
      track(mount(ImagePreviewModal, {
        props: {
          modelValue: true,
          imageUrl: 'https://example.com/robot-hd.jpg'
        },
        attachTo: document.body
      }))

      const openBtn = document.body.querySelector('button[title="查看原图"]') as HTMLButtonElement
      expect(openBtn).not.toBeNull()
      openBtn.click()

      expect(mockCreateObjectURL).not.toHaveBeenCalled()
      expect(mockOpen).toHaveBeenCalledWith('https://example.com/robot-hd.jpg', '_blank')
    } finally {
      window.open = originalOpen
      URL.createObjectURL = originalCreateObjectURL
    }
  })
})
