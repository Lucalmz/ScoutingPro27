import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
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
  flushOfflinePhotos: vi.fn().mockResolvedValue(undefined)
}))

describe('PitScoutFormDrawer.vue', () => {
  const origCreateObjectUrlDesc = Object.getOwnPropertyDescriptor(global.URL, 'createObjectURL')
  const origRevokeObjectUrlDesc = Object.getOwnPropertyDescriptor(global.URL, 'revokeObjectURL')
  const origOverflow = document.body.style.overflow
  const mountedWrappers: VueWrapper<any>[] = []

  const mountDrawer = (options: any) => {
    const wrapper = mount(PitScoutFormDrawer, options)
    mountedWrappers.push(wrapper)
    return wrapper
  }

  beforeEach(async () => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    const photoStorage = await import('@/services/photoStorage')
    vi.mocked(photoStorage.savePhoto).mockResolvedValue(undefined as any)
    vi.mocked(photoStorage.getPhotoUrl).mockResolvedValue('blob:test-photo-url')
    vi.mocked(photoStorage.flushOfflinePhotos).mockResolvedValue(undefined as any)
    if (!global.URL.createObjectURL) {
      global.URL.createObjectURL = vi.fn(() => 'blob:mock')
      global.URL.revokeObjectURL = vi.fn()
    }
  })

  afterEach(() => {
    while (mountedWrappers.length > 0) {
      mountedWrappers.pop()?.unmount()
    }
    document.body.innerHTML = ''
    document.body.style.overflow = origOverflow
    if (origCreateObjectUrlDesc) {
      Object.defineProperty(global.URL, 'createObjectURL', origCreateObjectUrlDesc)
    } else {
      delete (global.URL as any).createObjectURL
    }
    if (origRevokeObjectUrlDesc) {
      Object.defineProperty(global.URL, 'revokeObjectURL', origRevokeObjectUrlDesc)
    } else {
      delete (global.URL as any).revokeObjectURL
    }
    vi.restoreAllMocks()
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
        isDeleted: false,
        createdAt: '',
        updatedAt: ''
      }
    ]

    const wrapper = mountDrawer({ props: defaultProps })
    await nextTick()
    await flushPromises()

    expect(wrapper.text()).toContain('Apex Predator')
    expect(wrapper.text()).toContain('12345')
    const swerveBtn = wrapper.findAll('.radio-btn').find(b => b.text().includes('pit_scout.drivetrain.swerve'))
    expect(swerveBtn).toBeDefined()
    expect(swerveBtn!.classes()).toContain('is-active')
    expect(wrapper.find('[data-field="weight"] .stepper-val').text()).toBe('38.5')
    expect(wrapper.find('[data-field="autoScore"] .stepper-val').text()).toBe('45')
    expect(wrapper.findAll('.photo-item')).toHaveLength(1)
  })

  it('tracks isDirty and triggers confirmation dialog on close when dirty', async () => {
    const wrapper = mountDrawer({ props: defaultProps })
    await nextTick()
    await flushPromises()

    // Request close via DOM close button when clean -> closes immediately without confirm
    const confirmSpy = vi.spyOn(window, 'confirm')
    await wrapper.find('.close-btn').trigger('click')
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(wrapper.emitted('update:modelValue')).toBeTruthy()
    expect(wrapper.emitted('update:modelValue')![0]).toEqual([false])

    // Now change a form field (drivetrainType) via DOM click to make it dirty
    const swerveBtn = wrapper.findAll('.radio-btn').find(b => b.text().includes('pit_scout.drivetrain.swerve'))!
    await swerveBtn.trigger('click')
    expect(swerveBtn.classes()).toContain('is-active')

    // User cancels close -> modal stays open
    confirmSpy.mockReturnValue(false)
    await wrapper.find('.close-btn').trigger('click')
    expect(confirmSpy).toHaveBeenCalled()
    // Should NOT have emitted a second update:modelValue
    expect(wrapper.emitted('update:modelValue')).toHaveLength(1)

    // User confirms close -> modal closes
    confirmSpy.mockReturnValue(true)
    await wrapper.find('.close-btn').trigger('click')
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
        queueMicrotask(() => {
          if (this.onerror) this.onerror(new Error('Corrupt image'))
        })
      }
    } as any

    try {
      const wrapper = mountDrawer({ props: defaultProps })
      await nextTick()
      await flushPromises()

      const dummyFile = new File(['fake-image-bytes'], 'robot.png', { type: 'image/png' })
      const fileInput = wrapper.find('input[type="file"]')
      expect(fileInput.exists()).toBe(true)
      Object.defineProperty(fileInput.element, 'files', {
        value: [dummyFile],
        configurable: true
      })
      await fileInput.trigger('change')

      await vi.waitFor(() => {
        expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining('pit_scout.photo_save_failed'), 'error')
      })
      expect(wrapper.findAll('.photo-item')).toHaveLength(0)
    } finally {
      global.Image = origImage
    }
  })

  it('correctly increments and decrements all 8 stepper controls and computes structured endgame & total scores', async () => {
    const wrapper = mountDrawer({ props: defaultProps })
    await nextTick()
    await flushPromises()

    const steppers = wrapper.findAll('.stepper-control')
    expect(steppers).toHaveLength(8)

    // Stepper 0: weightLbs (starts at 38.0, step 0.5)
    const weightMinus = steppers[0].findAll('.step-btn')[0]
    const weightVal = steppers[0].find('.stepper-val')
    const weightPlus = steppers[0].findAll('.step-btn')[1]

    expect(weightVal.text()).toBe('38')
    await weightPlus.trigger('click')
    expect(weightVal.text()).toBe('38.5')
    await weightMinus.trigger('click')
    expect(weightVal.text()).toBe('38')

    // Stepper 1: claimedAutoScore (starts at 30, step 5)
    const autoMinus = steppers[1].findAll('.step-btn')[0]
    const autoVal = steppers[1].find('.stepper-val')
    const autoPlus = steppers[1].findAll('.step-btn')[1]

    expect(autoVal.text()).toBe('30')
    await autoPlus.trigger('click')
    expect(autoVal.text()).toBe('35')
    await autoMinus.trigger('click')
    expect(autoVal.text()).toBe('30')

    // Stepper 2: claimedTeleopCycles (starts at 5, step 1)
    const cycleMinus = steppers[2].findAll('.step-btn')[0]
    const cycleVal = steppers[2].find('.stepper-val')
    const cyclePlus = steppers[2].findAll('.step-btn')[1]

    expect(cycleVal.text()).toBe('5')
    await cyclePlus.trigger('click')
    expect(cycleVal.text()).toBe('6')
    await cycleMinus.trigger('click')
    expect(cycleVal.text()).toBe('5')

    // Stepper 3: claimedTeleopScore (starts at 60, step 5)
    const teleopScoreMinus = steppers[3].findAll('.step-btn')[0]
    const teleopScoreVal = steppers[3].find('.stepper-val')
    const teleopScorePlus = steppers[3].findAll('.step-btn')[1]

    expect(teleopScoreVal.text()).toBe('60')
    await teleopScorePlus.trigger('click')
    expect(teleopScoreVal.text()).toBe('65')
    await teleopScoreMinus.trigger('click')
    expect(teleopScoreVal.text()).toBe('60')

    // Enable claimedTeleopPark (+5 pts)
    const parkButtons = wrapper.find('[data-field="claimedTeleopPark"]').findAll('.radio-btn')
    await parkButtons[0].trigger('click')
    expect(parkButtons[0].classes()).toContain('is-active')

    // Stepper 4: flowerNectars (+2 each, cap 8)
    const nectarMinus = steppers[4].findAll('.step-btn')[0]
    const nectarVal = steppers[4].find('.stepper-val')
    const nectarPlus = steppers[4].findAll('.step-btn')[1]
    await nectarPlus.trigger('click')
    await nectarPlus.trigger('click')
    expect(nectarVal.text()).toBe('2')

    // Stepper 5: flowerBottomBonus (+5 each, capped by min(4, nectars) = 2)
    const bonusVal = steppers[5].find('.stepper-val')
    const bonusPlus = steppers[5].findAll('.step-btn')[1]
    await bonusPlus.trigger('click')
    await bonusPlus.trigger('click')
    expect(bonusVal.text()).toBe('2')
    expect((bonusPlus as any).attributes('disabled')).toBeDefined()

    // Decreasing flowerNectars automatically clamps flowerBottomBonus <= nectars
    await nectarMinus.trigger('click')
    expect(nectarVal.text()).toBe('1')
    expect(bonusVal.text()).toBe('1')

    // Stepper 6: flowerPollens (+2 each) & Stepper 7: gardenBalls (+1 each)
    const pollenPlus = steppers[6].findAll('.step-btn')[1]
    const gardenPlus = steppers[7].findAll('.step-btn')[1]
    await pollenPlus.trigger('click')
    await gardenPlus.trigger('click')
    await gardenPlus.trigger('click')

    // Endgame = park(5) + nectar(1*2) + bottomBonus(1*5) + pollen(1*2) + garden(2*1) = 16
    const endgameInput = wrapper.find('[data-field="claimedEndgameScore"]').element as HTMLInputElement
    const totalInput = wrapper.find('[data-field="calculatedTotalScore"]').element as HTMLInputElement
    expect(endgameInput.value).toBe('16')
    // Total = auto(30) + teleop(60) + endgame(16) = 106
    expect(totalInput.value).toBe('106')
    await autoPlus.trigger('click')
    expect(totalInput.value).toBe('111')
  })

  it('triggers alternating bump animations on consecutive clicks and clears on animationend', async () => {
    const wrapper = mountDrawer({ props: defaultProps })
    await nextTick()
    await flushPromises()

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
    const wrapper = mountDrawer({ props: defaultProps })
    await nextTick()
    await flushPromises()

    const weightStepper = wrapper.findAll('.stepper-control')[0]
    const minusBtn = weightStepper.findAll('.step-btn')[0] as any
    const plusBtn = weightStepper.findAll('.step-btn')[1] as any
    const weightVal = weightStepper.find('.stepper-val')

    // Step weight down from default 38 to min = 0 via real DOM clicks
    for (let i = 0; i < 76; i++) {
      await minusBtn.trigger('click')
    }
    expect(weightVal.text()).toBe('0')
    expect(minusBtn.attributes('disabled')).toBeDefined()
    expect(plusBtn.attributes('disabled')).toBeUndefined()

    // Clicking disabled minus does not decrease past 0
    await minusBtn.trigger('click')
    expect(weightVal.text()).toBe('0')

    // Step weight up from 0 to max = 50 via real DOM clicks
    for (let i = 0; i < 100; i++) {
      await plusBtn.trigger('click')
    }
    expect(weightVal.text()).toBe('50')
    expect(plusBtn.attributes('disabled')).toBeDefined()
    expect(minusBtn.attributes('disabled')).toBeUndefined()

    // Clicking disabled plus does not increase past 50
    await plusBtn.trigger('click')
    expect(weightVal.text()).toBe('50')
  })

  it('separates pinpoint and sparkfun_otos into independent selectable buttons', async () => {
    const wrapper = mountDrawer({ props: defaultProps })
    await nextTick()
    await flushPromises()

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
    expect(pinpointBtn.classes()).toContain('is-active')
    expect(otosBtn.classes()).not.toContain('is-active')

    // Click sparkfun_otos
    await otosBtn.trigger('click')
    expect(otosBtn.classes()).toContain('is-active')
    expect(pinpointBtn.classes()).not.toContain('is-active')
  })

  it('teleports to document.body and renders drawer-footer with Save Record button when teleportDisabled is false', async () => {
    document.body.innerHTML = ''
    const wrapper = mountDrawer({
      props: {
        ...defaultProps,
        teleportDisabled: false
      },
      attachTo: document.body
    })
    await nextTick()
    await flushPromises()

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
    const wrapper = mountDrawer({
      props: defaultProps
    })
    await nextTick()

    expect(document.body.style.overflow).toBe('hidden')

    await wrapper.setProps({ modelValue: false })
    await nextTick()
    expect(document.body.style.overflow).toBe('')

    await wrapper.setProps({ modelValue: true })
    await nextTick()
    expect(document.body.style.overflow).toBe('hidden')

    wrapper.unmount()
    expect(document.body.style.overflow).toBe('')
  })

  it('handles Escape key to requestClose when drawer is open', async () => {
    const wrapper = mountDrawer({ props: defaultProps })
    await nextTick()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false])

    wrapper.unmount()
  })

  it('allows weightLbs > 42 without compliance/weight warnings and updates chassisSize via quick chips or text input', async () => {
    const wrapper = mountDrawer({ props: defaultProps })
    await nextTick()
    await flushPromises()

    const weightStepper = wrapper.find('[data-field="weight"]')
    const weightPlus = weightStepper.findAll('.step-btn')[1]
    // Increment from 38.0 to 48.5 (21 clicks * 0.5)
    for (let i = 0; i < 21; i++) {
      await weightPlus.trigger('click')
    }
    expect(weightStepper.find('.stepper-val').text()).toBe('48.5')

    expect(wrapper.find('.warning-text').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('weight_over_warning')

    const chipsWrap = wrapper.findAll('.quick-chips-wrap')
    const chassisChip = chipsWrap[0].findAll('.quick-chip-btn')[0]
    const chassisInput = wrapper.find('[data-field="chassisSize"]')
    await chassisChip.trigger('click')
    expect((chassisInput.element as HTMLInputElement).value).toMatch(/\S+/)
    expect(chassisChip.classes()).toContain('is-active')

    await chassisInput.setValue('16x17 custom')
    expect((chassisInput.element as HTMLInputElement).value).toBe('16x17 custom')
  })

  it('preserves legacy claimedEndgameScore until structured endgame capabilities are adjusted', async () => {
    const pitStore = usePitScoutStore()
    pitStore.currentEventId = 'evt-1'
    pitStore.records = [
      {
        id: 'pit_legacy',
        eventId: 'evt-1',
        teamNumber: 9999,
        scoutId: 's1',
        scoutName: 'Alice',
        drivetrainType: 'mecanum',
        weightLbs: 36,
        ballCompatibility: 'universal',
        launcherType: '差速双飞轮',
        flowerMechanism: '垂直级联高抬升',
        hasColorSensor: true,
        odometryType: 'two_wheel',
        claimedAutoScore: 30,
        claimedTeleopCycles: 4,
        claimedTeleopScore: 50,
        claimedEndgameScore: 15,
        claimedTotalScore: 95,
        version: 1
      }
    ]

    const wrapper = mountDrawer({
      props: { modelValue: true, teamNumber: 9999 }
    })
    await nextTick()
    await flushPromises()

    const endgameInput = wrapper.find('[data-field="claimedEndgameScore"]').element as HTMLInputElement
    const totalInput = wrapper.find('[data-field="calculatedTotalScore"]').element as HTMLInputElement
    expect(endgameInput.value).toBe('15')
    expect(totalInput.value).toBe('95')

    // Adjusting structured flowerNectars replaces legacy score with live structured sum
    const nectarStepper = wrapper.find('[data-field="flowerNectars"]')
    const nectarPlus = nectarStepper.findAll('.step-btn')[1]
    await nectarPlus.trigger('click')
    expect(nectarStepper.find('.stepper-val').text()).toBe('1')
    expect(endgameInput.value).toBe('2')
    expect(totalInput.value).toBe('82')
  })

  it('allows unrestricted hasColorSensor with pollen_only and saves complete V6 payload on save', async () => {
    const pitStore = usePitScoutStore()
    pitStore.currentEventId = 'evt-v6'
    const saveSpy = vi.spyOn(pitStore, 'saveRecord').mockResolvedValue(undefined)

    const wrapper = mountDrawer({
      props: { modelValue: true, teamNumber: 27570 }
    })
    await nextTick()
    await flushPromises()

    // Select pollen_only compatibility via DOM click, then ensure hasColorSensor remains freely toggleable
    const pollenOnlyBtn = wrapper.findAll('.radio-btn').find(b => b.text().includes('pit_scout.drawer.ball_compat_pollen_only'))!
    await pollenOnlyBtn.trigger('click')
    expect(pollenOnlyBtn.classes()).toContain('is-active')

    const colorBtns = wrapper.find('[data-field="hasColorSensor"]').findAll('.radio-btn')
    await colorBtns[1].trigger('click')
    expect(colorBtns[1].classes()).toContain('is-active')
    await colorBtns[0].trigger('click')
    expect(colorBtns[0].classes()).toContain('is-active')

    // Toggle V6 traits & fill chassisSize + structured endgame
    await wrapper.find('[data-field="hasDescoreMech"]').findAll('.radio-btn')[0].trigger('click')
    await wrapper.find('[data-field="hasApriltagVision"]').findAll('.radio-btn')[0].trigger('click')
    await wrapper.find('[data-field="chassisSize"]').setValue('紧凑小车 (≤15")')
    await wrapper.find('[data-field="claimedTeleopPark"]').findAll('.radio-btn')[0].trigger('click')
    await wrapper.find('[data-field="flowerNectars"]').findAll('.step-btn')[1].trigger('click')

    await wrapper.find('.btn-primary').trigger('click')

    expect(saveSpy).toHaveBeenCalledTimes(1)
    const saved = saveSpy.mock.calls[0]![0]
    expect(saved.chassisSize).toBe('紧凑小车 (≤15")')
    expect(saved.ballCompatibility).toBe('pollen_only')
    expect(saved.hasColorSensor).toBe(true)
    expect(saved.hasDescoreMech).toBe(true)
    expect(saved.hasApriltagVision).toBe(true)
    expect(saved.claimedTeleopPark).toBe(true)
    expect(saved.claimedFlowerNectars).toBe(1)
    expect(saved.claimedEndgameScore).toBe(7)
    expect(saved.claimedTotalScore).toBe(97)

    const parsedRaw = JSON.parse(saved.rawData || '{}')
    expect(parsedRaw.chassisSize).toBe('紧凑小车 (≤15")')
    expect(parsedRaw.hasDescoreMech).toBe(true)
    expect(parsedRaw.hasApriltagVision).toBe(true)
    expect(parsedRaw.claimedTeleopPark).toBe(true)
    expect(parsedRaw.claimedFlowerNectars).toBe(1)
  })
})
