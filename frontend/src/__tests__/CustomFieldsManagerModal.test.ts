import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import CustomFieldsManagerModal from '@/components/customFields/CustomFieldsManagerModal.vue'
import CustomFieldBuilderForm from '@/components/customFields/CustomFieldBuilderForm.vue'
import { useCustomFieldsStore } from '@/stores/customFields'
import { useToastStore } from '@/stores/toast'
import zh from '@/locales/zh.json'
import en from '@/locales/en.json'
import type { CustomFieldDefinition } from '@/types'

// Mock useConfirm so delete confirmation can be controlled
const mockShowConfirm = vi.fn().mockResolvedValue(true)
vi.mock('@/composables/useConfirm', () => ({
  useConfirm: () => ({
    showConfirm: mockShowConfirm
  })
}))

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh',
    messages: { zh, en }
  })
}

describe('CustomFieldsManagerModal & CustomFieldBuilderForm', () => {
  const wrappers: VueWrapper<any>[] = []
  const track = <T extends VueWrapper<any>>(w: T): T => {
    wrappers.push(w)
    return w
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mockShowConfirm.mockResolvedValue(true)
  })

  afterEach(() => {
    while (wrappers.length) wrappers.pop()!.unmount()
    vi.restoreAllMocks()
  })

  const sampleField: CustomFieldDefinition = {
    id: 'cf-1',
    eventId: 'evt-1',
    target: 'MATCH',
    phase: 'teleop',
    name: '远射命中',
    fieldKey: 'long_shot_hits',
    fieldType: 'number',
    required: true,
    unit: '球',
    minVal: 0,
    maxVal: 20,
    stepVal: 1,
    optionsJson: null,
    sortOrder: 0,
    isActive: true
  }

  it('renders empty state when no fields exist and switches between MATCH and PIT tabs', async () => {
    const store = useCustomFieldsStore()
    vi.spyOn(store, 'fetchFields').mockResolvedValue([])
    vi.spyOn(store, 'getFields').mockReturnValue([])

    const wrapper = track(mount(CustomFieldsManagerModal, {
      props: { visible: true, eventId: 'evt-1' },
      global: { plugins: [createTestI18n()] }
    }))

    expect(wrapper.find('.cf-empty-state').exists()).toBe(true)

    const tabs = wrapper.findAll('.cf-tab-btn')
    expect(tabs).toHaveLength(3)
    expect(tabs[0]!.classes()).toContain('is-active')

    await tabs[1]!.trigger('click')
    expect(tabs[1]!.classes()).toContain('is-active')
  })

  it('renders existing fields and delegates toggle, reorder, and delete actions to store', async () => {
    const store = useCustomFieldsStore()
    const secondField: CustomFieldDefinition = {
      ...sampleField,
      id: 'cf-2',
      name: '防守评级',
      fieldKey: 'def_level',
      fieldType: 'level',
      sortOrder: 1
    }
    vi.spyOn(store, 'fetchFields').mockResolvedValue([sampleField, secondField])
    vi.spyOn(store, 'getFields').mockReturnValue([sampleField, secondField])
    const toggleSpy = vi.spyOn(store, 'toggleFieldActive').mockResolvedValue()
    const moveSpy = vi.spyOn(store, 'moveFieldOrder').mockResolvedValue()
    const deleteSpy = vi.spyOn(store, 'deleteField').mockResolvedValue()

    const wrapper = track(mount(CustomFieldsManagerModal, {
      props: { visible: true, eventId: 'evt-1' },
      global: { plugins: [createTestI18n()] }
    }))

    const cards = wrapper.findAll('.cf-card')
    expect(cards).toHaveLength(2)
    expect(cards[0]!.text()).toContain('远射命中')
    expect(cards[0]!.text()).toContain('long_shot_hits')

    // Move first card down
    const firstOrderBtns = cards[0]!.findAll('.order-btns .btn-icon')
    expect((firstOrderBtns[0]!.element as HTMLButtonElement).disabled).toBe(true)
    await firstOrderBtns[1]!.trigger('click')
    expect(moveSpy).toHaveBeenCalledWith('evt-1', 'cf-1', 'down', 'MATCH')

    // Toggle active switch
    const checkbox = cards[0]!.find('.switch-toggle input[type="checkbox"]')
    await checkbox.trigger('change')
    expect(toggleSpy).toHaveBeenCalledWith('evt-1', 'cf-1')

    // Delete field
    const delBtn = cards[0]!.find('.del-btn')
    await delBtn.trigger('click')
    await flushPromises()
    expect(mockShowConfirm).toHaveBeenCalled()
    expect(deleteSpy).toHaveBeenCalledWith('evt-1', 'cf-1')
  })

  it('opens builder drawer for creating a field, validates empty name, and saves select options', async () => {
    const store = useCustomFieldsStore()
    const toast = useToastStore()
    vi.spyOn(store, 'fetchFields').mockResolvedValue([])
    vi.spyOn(store, 'getFields').mockReturnValue([])
    const createSpy = vi.spyOn(store, 'createField').mockResolvedValue(sampleField)
    const toastSpy = vi.spyOn(toast, 'showToast')

    const wrapper = track(mount(CustomFieldsManagerModal, {
      props: { visible: true, eventId: 'evt-1' },
      global: { plugins: [createTestI18n()] }
    }))

    // Click create button
    await wrapper.find('.btn-create-field').trigger('click')
    const builder = wrapper.findComponent(CustomFieldBuilderForm)
    expect(builder.exists()).toBe(true)

    // Attempt save with empty name -> triggers error toast
    await builder.find('.btn-save').trigger('click')
    expect(toastSpy).toHaveBeenCalledWith(expect.any(String), 'error')
    expect(createSpy).not.toHaveBeenCalled()

    // Fill name, key, select 'select' type, add options, and save
    const inputs = builder.findAll('.form-group input[type="text"]')
    await inputs[0]!.setValue('底盘风格')
    await inputs[2]!.setValue('Drive_Style')

    const typeBtns = builder.findAll('.type-choice-btn')
    // 0: boolean, 1: number, 2: timer, 3: level, 4: select
    await typeBtns[4]!.trigger('click')

    const optInput = builder.find('.option-add-row input[type="text"]')
    await optInput.setValue('激进突破')
    await builder.find('.color-dot.dot-red').trigger('click')
    await builder.find('.btn-add-opt').trigger('click')

    await optInput.setValue('稳健防守')
    await builder.find('.btn-add-opt').trigger('click')

    expect(builder.findAll('.opt-preview-chip')).toHaveLength(2)

    // Remove second option
    await builder.findAll('.btn-opt-del')[1]!.trigger('click')
    expect(builder.findAll('.opt-preview-chip')).toHaveLength(1)

    // Save form
    await builder.find('.btn-save').trigger('click')
    await flushPromises()

    expect(createSpy).toHaveBeenCalledTimes(1)
    const [evtId, payload] = createSpy.mock.calls[0]!
    expect(evtId).toBe('evt-1')
    expect(payload.name).toBe('底盘风格')
    expect(payload.fieldKey).toBe('drive_style')
    expect(payload.fieldType).toBe('select')
    const parsedOptions = JSON.parse(payload.optionsJson!)
    expect(parsedOptions).toHaveLength(1)
    expect(parsedOptions[0].label).toBe('激进突破')
    expect(parsedOptions[0].color).toBe('red')
  })

  it('opens builder drawer in edit mode and updates existing field', async () => {
    const store = useCustomFieldsStore()
    vi.spyOn(store, 'fetchFields').mockResolvedValue([sampleField])
    vi.spyOn(store, 'getFields').mockReturnValue([sampleField])
    const updateSpy = vi.spyOn(store, 'updateField').mockResolvedValue(sampleField)

    const wrapper = track(mount(CustomFieldsManagerModal, {
      props: { visible: true, eventId: 'evt-1' },
      global: { plugins: [createTestI18n()] }
    }))

    await wrapper.find('.edit-btn').trigger('click')
    const builder = wrapper.findComponent(CustomFieldBuilderForm)
    expect(builder.exists()).toBe(true)

    const nameInput = builder.findAll('.form-group input[type="text"]')[0]!
    expect((nameInput.element as HTMLInputElement).value).toBe('远射命中')

    await nameInput.setValue('远射精准命中')
    await builder.find('.btn-save').trigger('click')
    await flushPromises()

    expect(updateSpy).toHaveBeenCalledWith(
      'evt-1',
      'cf-1',
      expect.objectContaining({
        name: '远射精准命中',
        fieldKey: 'long_shot_hits'
      })
    )
  })

  it('supports TEAM tab with forced formula type, template import, and impacted formula warning on delete', async () => {
    const store = useCustomFieldsStore()
    const dependentFormula: CustomFieldDefinition = {
      id: 'fm-1',
      eventId: 'evt-1',
      target: 'TEAM',
      phase: 'overall',
      name: 'Shot Power',
      fieldKey: 'shot_power',
      fieldType: 'formula',
      formulaExpr: 'cf.long_shot_hits * 2',
      required: false,
      orderSeq: 1,
      isActive: true
    }
    vi.spyOn(store, 'fetchFields').mockResolvedValue([sampleField, dependentFormula])
    vi.spyOn(store, 'getFields').mockImplementation((_evtId, target) => {
      if (target === 'MATCH') return [sampleField]
      if (target === 'TEAM') return [dependentFormula]
      return [sampleField, dependentFormula]
    })
    const createSpy = vi.spyOn(store, 'createField').mockResolvedValue(dependentFormula)
    const deleteSpy = vi.spyOn(store, 'deleteField').mockResolvedValue(undefined)

    const wrapper = track(mount(CustomFieldsManagerModal, {
      props: { visible: true, eventId: 'evt-1' },
      global: { plugins: [createTestI18n()] }
    }))

    // Delete sampleField -> mockShowConfirm should receive impacted formula name 'Shot Power'
    await wrapper.find('.del-btn').trigger('click')
    await flushPromises()
    expect(mockShowConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Shot Power')
      })
    )
    expect(deleteSpy).toHaveBeenCalledWith('evt-1', 'cf-1')

    // Open template drawer and import first template
    await wrapper.find('.btn-templates').trigger('click')
    expect(wrapper.findAll('.template-card').length).toBeGreaterThan(0)
    await wrapper.find('.btn-import-tpl').trigger('click')
    await flushPromises()
    expect(createSpy).toHaveBeenCalledTimes(1)

    // Switch to TEAM tab and open builder -> FormulaEditorPanel is mounted & chips insert text
    await wrapper.findAll('.cf-tab-btn')[2]!.trigger('click')
    await wrapper.find('.btn-create-field').trigger('click')
    const builder = wrapper.findComponent(CustomFieldBuilderForm)
    expect(builder.find('.formula-editor-panel').exists()).toBe(true)

    await builder.find('.var-chip').trigger('click')
    const exprEl = builder.find('.formula-textarea').element as HTMLTextAreaElement
    expect(exprEl.value.length).toBeGreaterThan(0)
  })
})
