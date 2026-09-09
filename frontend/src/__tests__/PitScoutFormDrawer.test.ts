import { mount } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import PitScoutFormDrawer from '../components/pit/PitScoutFormDrawer.vue'
import { usePitScoutStore } from '../stores/pitScout'
import { useToastStore } from '../stores/toast'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key
  }),
  createI18n: () => ({
    global: {
      t: (key: string) => key
    }
  })
}))

vi.mock('@/services/photoStorage', () => ({
  savePhoto: vi.fn().mockResolvedValue(undefined),
  deletePhoto: vi.fn(),
  getPhotoUrl: vi.fn().mockResolvedValue('blob:test-photo-url'),
  flushOfflinePhotos: vi.fn()
}))

describe('PitScoutFormDrawer.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    if (!global.URL.createObjectURL) {
      global.URL.createObjectURL = vi.fn(() => 'blob:mock')
      global.URL.revokeObjectURL = vi.fn()
    }
  })

  const defaultProps = {
    modelValue: true,
    teamNumber: 12345
  }

  it('renders initial form values from store record', async () => {
    const pitStore = usePitScoutStore()
    pitStore.currentEventId = 'evt-1'
    pitStore.records = [
      {
        id: 'pit_1',
        eventId: 'evt-1',
        teamNumber: 12345,
        scoutId: 's1',
        scoutName: 'Alice',
        robotName: 'Apex Predator',
        drivetrainType: 'swerve',
        weightLbs: 38.5,
        sizingPassed: true,
        mechanismType: 'intake_claw',
        hangType: 'telescoping',
        odometryType: 'sparkfun_otos',
        claimedAutoScore: 45,
        claimedAutoPieces: 3,
        claimedAutoHangLevel: 'level1',
        claimedTeleopScore: 60,
        claimedTeleopCycleSec: 12,
        claimedEndgameHangLevel: 'level3',
        claimedEndgameTimeSec: 8,
        claimedTotalScore: 105,
        photoKeys: ['photo_1'],
        version: 1,
        hostSeq: 1,
        isDeleted: false,
        createdAt: '',
        updatedAt: ''
      }
    ]

    const wrapper = mount(PitScoutFormDrawer, { props: defaultProps })
    await wrapper.vm.$nextTick()
    await new Promise((r) => setTimeout(r, 20))

    expect(wrapper.text()).toContain('Apex Predator')
    expect(wrapper.text()).toContain('12345')
    expect(wrapper.vm.drivetrainType).toBe('swerve')
    expect(wrapper.vm.weightLbs).toBe(38.5)
    expect(wrapper.vm.claimedAutoScore).toBe(45)
    expect(wrapper.vm.photoPreviews).toHaveLength(1)
  })

  it('tracks isDirty and triggers confirmation dialog on close when dirty', async () => {
    const wrapper = mount(PitScoutFormDrawer, { props: defaultProps })
    await wrapper.vm.$nextTick()
    await new Promise((r) => setTimeout(r, 20))

    // Clean state
    expect(wrapper.vm.isDirty).toBe(false)

    // Request close when clean -> closes immediately without confirm
    const confirmSpy = vi.spyOn(window, 'confirm')
    wrapper.vm.requestClose()
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(wrapper.emitted('update:modelValue')).toBeTruthy()
    expect(wrapper.emitted('update:modelValue')![0]).toEqual([false])

    // Now change a form field (drivetrainType) to make it dirty
    wrapper.vm.drivetrainType = 'swerve'
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.isDirty).toBe(true)

    // User cancels close -> modal stays open
    confirmSpy.mockReturnValue(false)
    wrapper.vm.requestClose()
    expect(confirmSpy).toHaveBeenCalled()
    // Should NOT have emitted a second update:modelValue
    expect(wrapper.emitted('update:modelValue')).toHaveLength(1)

    // User confirms close -> modal closes
    confirmSpy.mockReturnValue(true)
    wrapper.vm.requestClose()
    expect(wrapper.emitted('update:modelValue')).toHaveLength(2)
    expect(wrapper.emitted('update:modelValue')![1]).toEqual([false])
  })

  it('handles image compression failure gracefully and shows error toast', async () => {
    const toastStore = useToastStore()
    const toastSpy = vi.spyOn(toastStore, 'showToast')

    // Mock Image to fail image loading
    const origImage = global.Image
    global.Image = class {
      onload: (() => void) | null = null
      onerror: ((err: any) => void) | null = null
      set src(_val: string) {
        setTimeout(() => {
          if (this.onerror) this.onerror(new Error('Corrupt image'))
        }, 0)
      }
    } as any

    try {
      const wrapper = mount(PitScoutFormDrawer, { props: defaultProps })
      await wrapper.vm.$nextTick()
      await new Promise((r) => setTimeout(r, 20))

      const dummyFile = new File(['fake-image-bytes'], 'robot.png', { type: 'image/png' })
      const fakeEvent = {
        target: {
          files: [dummyFile],
          value: 'robot.png'
        }
      } as any

      await wrapper.vm.handleFileSelected(fakeEvent)
      await new Promise((r) => setTimeout(r, 50))

      expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining('pit_scout.photo_save_failed'), 'error')
      expect(wrapper.vm.photoKeys).toHaveLength(0)
    } finally {
      global.Image = origImage
    }
  })
})
