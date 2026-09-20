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
        ballCompatibility: 'universal',
        launcherType: '差速双飞轮',
        flowerMechanism: '垂直级联高抬升',
        hasColorSensor: true,
        odometryType: 'sparkfun_otos',
        claimedAutoStrategy: '3 balls leave',
        claimedAutoScore: 45,
        claimedTeleopCycles: 5,
        claimedTeleopScore: 60,
        claimedEndgameScore: 15,
        claimedTotalScore: 120,
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

  it('correctly increments and decrements all 5 stepper controls via DOM button clicks and updates calculatedTotalScore', async () => {
    const wrapper = mount(PitScoutFormDrawer, { props: defaultProps })
    await wrapper.vm.$nextTick()
    await new Promise((r) => setTimeout(r, 20))

    const steppers = wrapper.findAll('.stepper-control')
    expect(steppers).toHaveLength(5)

    // Stepper 0: weightLbs (starts at 38.0, step 0.5)
    const weightMinus = steppers[0].findAll('.step-btn')[0]
    const weightVal = steppers[0].find('.stepper-val')
    const weightPlus = steppers[0].findAll('.step-btn')[1]

    expect(weightVal.text()).toBe('38')
    await weightPlus.trigger('click')
    expect(weightVal.text()).toBe('38.5')
    expect(wrapper.vm.weightLbs).toBe(38.5)
    await weightMinus.trigger('click')
    expect(weightVal.text()).toBe('38')

    // Stepper 1: claimedAutoScore (starts at 30, step 5)
    const autoMinus = steppers[1].findAll('.step-btn')[0]
    const autoVal = steppers[1].find('.stepper-val')
    const autoPlus = steppers[1].findAll('.step-btn')[1]

    expect(autoVal.text()).toBe('30')
    await autoPlus.trigger('click')
    expect(autoVal.text()).toBe('35')
    expect(wrapper.vm.claimedAutoScore).toBe(35)
    await autoMinus.trigger('click')
    expect(autoVal.text()).toBe('30')

    // Stepper 2: claimedTeleopCycles (starts at 5, step 1)
    const cycleMinus = steppers[2].findAll('.step-btn')[0]
    const cycleVal = steppers[2].find('.stepper-val')
    const cyclePlus = steppers[2].findAll('.step-btn')[1]

    expect(cycleVal.text()).toBe('5')
    await cyclePlus.trigger('click')
    expect(cycleVal.text()).toBe('6')
    expect(wrapper.vm.claimedTeleopCycles).toBe(6)
    await cycleMinus.trigger('click')
    expect(cycleVal.text()).toBe('5')

    // Stepper 3: claimedTeleopScore (starts at 60, step 5)
    const teleopScoreMinus = steppers[3].findAll('.step-btn')[0]
    const teleopScoreVal = steppers[3].find('.stepper-val')
    const teleopScorePlus = steppers[3].findAll('.step-btn')[1]

    expect(teleopScoreVal.text()).toBe('60')
    await teleopScorePlus.trigger('click')
    expect(teleopScoreVal.text()).toBe('65')
    expect(wrapper.vm.claimedTeleopScore).toBe(65)
    await teleopScoreMinus.trigger('click')
    expect(teleopScoreVal.text()).toBe('60')

    // Stepper 4: claimedEndgameScore (starts at 15, step 5)
    const endgameMinus = steppers[4].findAll('.step-btn')[0]
    const endgameVal = steppers[4].find('.stepper-val')
    const endgamePlus = steppers[4].findAll('.step-btn')[1]

    expect(endgameVal.text()).toBe('15')
    await endgamePlus.trigger('click')
    expect(endgameVal.text()).toBe('20')
    expect(wrapper.vm.claimedEndgameScore).toBe(20)
    await endgameMinus.trigger('click')
    expect(endgameVal.text()).toBe('15')

    // Total: auto(30) + teleop(60) + endgame(15) = 105
    expect(wrapper.vm.calculatedTotalScore).toBe(105)
    await autoPlus.trigger('click') // +5
    expect(wrapper.vm.calculatedTotalScore).toBe(110)
  })

  it('triggers alternating bump animations on consecutive clicks and clears on animationend', async () => {
    const wrapper = mount(PitScoutFormDrawer, { props: defaultProps })
    await wrapper.vm.$nextTick()
    await new Promise((r) => setTimeout(r, 20))

    const weightStepper = wrapper.findAll('.stepper-control')[0]
    const plusBtn = weightStepper.findAll('.step-btn')[1]
    const valSpan = weightStepper.find('.stepper-val')

    // 1st click -> bump-up-a
    await plusBtn.trigger('click')
    expect(valSpan.classes()).toContain('bump-up-a')

    // 2nd consecutive click -> bump-up-b
    await plusBtn.trigger('click')
    expect(valSpan.classes()).toContain('bump-up-b')
    expect(valSpan.classes()).not.toContain('bump-up-a')

    // animationend -> clears
    await valSpan.trigger('animationend')
    expect(valSpan.classes()).not.toContain('bump-up-a')
    expect(valSpan.classes()).not.toContain('bump-up-b')

    // Decrement click -> bump-down-a or b
    const minusBtn = weightStepper.findAll('.step-btn')[0]
    await minusBtn.trigger('click')
    expect(valSpan.classes().some(c => c.startsWith('bump-down-'))).toBe(true)
  })

  it('disables minus button at min and plus button at max', async () => {
    const wrapper = mount(PitScoutFormDrawer, { props: defaultProps })
    await wrapper.vm.$nextTick()
    await new Promise((r) => setTimeout(r, 20))

    // Set weight to min = 0
    wrapper.vm.weightLbs = 0
    await wrapper.vm.$nextTick()

    const weightStepper = wrapper.findAll('.stepper-control')[0]
    const minusBtn = weightStepper.findAll('.step-btn')[0] as any
    const plusBtn = weightStepper.findAll('.step-btn')[1] as any

    expect(minusBtn.attributes('disabled')).toBeDefined()
    expect(plusBtn.attributes('disabled')).toBeUndefined()

    // Clicking disabled minus does not decrease past 0
    await minusBtn.trigger('click')
    expect(wrapper.vm.weightLbs).toBe(0)

    // Set weight to max = 50
    wrapper.vm.weightLbs = 50
    await wrapper.vm.$nextTick()

    expect(plusBtn.attributes('disabled')).toBeDefined()
    expect(minusBtn.attributes('disabled')).toBeUndefined()

    // Clicking disabled plus does not increase past 50
    await plusBtn.trigger('click')
    expect(wrapper.vm.weightLbs).toBe(50)
  })

  it('separates pinpoint and sparkfun_otos into independent selectable buttons', async () => {
    const wrapper = mount(PitScoutFormDrawer, { props: defaultProps })
    await wrapper.vm.$nextTick()
    await new Promise((r) => setTimeout(r, 20))

    const radioGroups = wrapper.findAll('.radio-group')
    // Find the odometry group which has 5 buttons
    const odomGroup = radioGroups.find(g => g.findAll('.radio-btn').length === 5)
    expect(odomGroup).toBeDefined()
    const odomButtons = odomGroup!.findAll('.radio-btn')

    // Button 3 is pinpoint, Button 4 is sparkfun_otos
    const pinpointBtn = odomButtons[3]
    const otosBtn = odomButtons[4]

    // Click pinpoint
    await pinpointBtn.trigger('click')
    expect(wrapper.vm.odometryType).toBe('pinpoint')
    expect(pinpointBtn.classes()).toContain('is-active')
    expect(otosBtn.classes()).not.toContain('is-active')

    // Click sparkfun_otos
    await otosBtn.trigger('click')
    expect(wrapper.vm.odometryType).toBe('sparkfun_otos')
    expect(otosBtn.classes()).toContain('is-active')
    expect(pinpointBtn.classes()).not.toContain('is-active')
  })

  it('teleports to document.body and renders drawer-footer with Save Record button when teleportDisabled is false', async () => {
    document.body.innerHTML = ''
    const wrapper = mount(PitScoutFormDrawer, {
      props: {
        ...defaultProps,
        teleportDisabled: false
      },
      attachTo: document.body
    })
    await wrapper.vm.$nextTick()
    await new Promise((r) => setTimeout(r, 20))

    const overlay = document.body.querySelector('.drawer-overlay')
    expect(overlay).not.toBeNull()

    const footer = document.body.querySelector('.drawer-footer')
    expect(footer).not.toBeNull()

    const saveBtn = footer!.querySelector('.btn-primary') as HTMLButtonElement
    expect(saveBtn).not.toBeNull()
    expect(saveBtn.textContent).toContain('pit_scout.drawer.btn_save')

    const cancelBtn = footer!.querySelector('.btn-cancel') as HTMLButtonElement
    expect(cancelBtn).not.toBeNull()

    wrapper.unmount()
    expect(document.body.querySelector('.drawer-overlay')).toBeNull()
  })

  it('locks body overflow when opened and unlocks when unmounted or closed', async () => {
    document.body.style.overflow = ''
    const wrapper = mount(PitScoutFormDrawer, {
      props: defaultProps
    })
    await wrapper.vm.$nextTick()

    expect(document.body.style.overflow).toBe('hidden')

    await wrapper.setProps({ modelValue: false })
    await wrapper.vm.$nextTick()
    expect(document.body.style.overflow).toBe('')

    await wrapper.setProps({ modelValue: true })
    await wrapper.vm.$nextTick()
    expect(document.body.style.overflow).toBe('hidden')

    wrapper.unmount()
    expect(document.body.style.overflow).toBe('')
  })

  it('handles Escape key to requestClose when drawer is open', async () => {
    const wrapper = mount(PitScoutFormDrawer, { props: defaultProps })
    await wrapper.vm.$nextTick()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false])

    wrapper.unmount()
  })
})
