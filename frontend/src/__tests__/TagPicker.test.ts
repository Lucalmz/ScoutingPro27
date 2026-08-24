import { mount } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import TagPicker from '../components/common/TagPicker.vue'
import { useRecordStore } from '../stores/records'
import { useToastStore } from '../stores/toast'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: any) => key,
    te: (key: string) => true
  }),
  createI18n: () => ({})
}))

describe('TagPicker.vue', () => {
  let pinia: any

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
  })

  it('renders existing tags for the team', () => {
    const recordStore = useRecordStore()
    recordStore.teamTags = [
      { id: 't1', eventId: 'e1', teamNumber: 27570, tag: 'preset.fast_cycle', color: 'blue', isPreset: true },
      { id: 't2', eventId: 'e1', teamNumber: 27570, tag: 'aluminum_chassis', color: 'green', isPreset: false },
      { id: 't3', eventId: 'e1', teamNumber: 19600, tag: 'other_team_tag', color: 'red', isPreset: false }
    ]

    const wrapper = mount(TagPicker, {
      props: { eventId: 'e1', teamNumber: 27570 }
    })

    const badges = wrapper.findAll('.tag-badge')
    expect(badges).toHaveLength(2)
  })

  it('adds custom tag with selected color', async () => {
    const recordStore = useRecordStore()
    vi.spyOn(recordStore, 'addTag').mockResolvedValue({
      success: true,
      tag: { id: 't1', eventId: 'e1', teamNumber: 27570, tag: 'aluminum_lift', color: 'orange', isPreset: false }
    })

    const wrapper = mount(TagPicker, {
      props: { eventId: 'e1', teamNumber: 27570 }
    })

    // Open add panel
    await wrapper.find('.btn-add-tag').trigger('click')
    expect(wrapper.find('.tag-edit-panel').exists()).toBe(true)

    // Type tag name
    await wrapper.find('.tag-input').setValue('aluminum_lift')

    // Select orange color dot
    const orangeDot = wrapper.find('.bg-orange')
    await orangeDot.trigger('click')

    // Click confirm
    await wrapper.find('.btn-confirm-add').trigger('click')

    expect(recordStore.addTag).toHaveBeenCalledWith('e1', 27570, 'aluminum_lift', 'orange', false)
  })

  it('removes tag when remove button clicked on active tag', async () => {
    const recordStore = useRecordStore()
    recordStore.teamTags = [
      { id: 't1', eventId: 'e1', teamNumber: 27570, tag: 'fast_cycle', color: 'blue', isPreset: false }
    ]
    vi.spyOn(recordStore, 'removeTag').mockResolvedValue({ success: true })

    const wrapper = mount(TagPicker, {
      props: { eventId: 'e1', teamNumber: 27570 }
    })

    const removeBtn = wrapper.find('.btn-tag-remove')
    await removeBtn.trigger('click')

    expect(recordStore.removeTag).toHaveBeenCalledWith('e1', 27570, 'fast_cycle')
  })

  it('validates custom tag: disallows dot, trims, and normalizes ASCII (V26, V27)', async () => {
    const recordStore = useRecordStore()
    const toastStore = useToastStore()
    const toastSpy = vi.spyOn(toastStore, 'showToast')
    const addTagSpy = vi.spyOn(recordStore, 'addTag').mockResolvedValue({
      success: true,
      tag: { id: 't1', eventId: 'e1', teamNumber: 27570, tag: 'intake_v2', color: 'green', isPreset: false }
    })

    const wrapper = mount(TagPicker, {
      props: { eventId: 'e1', teamNumber: 27570 }
    })

    await wrapper.find('.btn-add-tag').trigger('click')

    // 1. Try dot '.' (V27)
    const input = wrapper.find('.tag-input')
    await input.setValue('preset.fake')
    await wrapper.find('.btn-confirm-add').trigger('click')
    expect(toastSpy).toHaveBeenCalledWith('tags.no_dot_allowed', 'error')
    expect(addTagSpy).not.toHaveBeenCalled()

    // 2. Try valid custom tag with uppercase and leading/trailing space
    await input.setValue('  InTake_V2  ')
    await wrapper.find('.btn-confirm-add').trigger('click')
    expect(addTagSpy).toHaveBeenCalledWith('e1', 27570, 'intake_v2', 'green', false)
  })

  it('enforces maximum 15 tags per team limit (V14)', async () => {
    const recordStore = useRecordStore()
    const toastStore = useToastStore()
    const toastSpy = vi.spyOn(toastStore, 'showToast')

    recordStore.teamTags = Array.from({ length: 15 }, (_, i) => ({
      id: `tag-${i}`,
      eventId: 'e1',
      teamNumber: 27570,
      tag: `tag_${i}`,
      color: 'blue',
      isPreset: false
    }))

    const wrapper = mount(TagPicker, {
      props: { eventId: 'e1', teamNumber: 27570 }
    })

    // The add button should be disabled
    const addBtn = wrapper.find('.btn-add-tag')
    expect(addBtn.attributes('disabled')).toBeDefined()
  })
})
