import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '../i18n'
import CustomFieldBuilderForm from '../components/customFields/CustomFieldBuilderForm.vue'
import { useToastStore } from '../stores/toast'
import type { CustomFieldDefinition } from '../types'

vi.mock('@/utils/haptics', () => ({
  hapticLight: vi.fn()
}))

describe('CustomFieldBuilderForm.vue', () => {
  const wrappers: VueWrapper<any>[] = []
  const track = <T extends VueWrapper<any>>(w: T): T => {
    wrappers.push(w)
    return w
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  afterEach(() => {
    while (wrappers.length) wrappers.pop()!.unmount()
    localStorage.clear()
  })

  it('validates required name and emits sanitized payload for select field with options', async () => {
    const toast = useToastStore()
    const toastSpy = vi.spyOn(toast, 'showToast')

    const w = track(
      mount(CustomFieldBuilderForm, {
        props: {
          eventId: 'evt-1',
          activeTab: 'MATCH',
          editingField: null,
          isSaving: false,
          existingFields: []
        },
        global: { plugins: [i18n] }
      })
    )

    // Empty name triggers validation toast and does not emit save
    await w.find('.btn-save').trigger('click')
    expect(toastSpy).toHaveBeenCalledWith(expect.any(String), 'error')
    expect(w.emitted('save')).toBeUndefined()

    // Fill name & key, switch to 'select', add & remove options, then save
    const inputs = w.findAll('input[type="text"]')
    await inputs[0]!.setValue('  Intake Type  ')
    await inputs[2]!.setValue('intake_type')

    const selectBtn = w.findAll('.type-choice-btn').find((b) => b.text().includes(i18n.global.t('custom_fields.type_select')))!
    await selectBtn.trigger('click')

    const optInput = w.find(`input[placeholder="${i18n.global.t('custom_fields.option_input_placeholder')}"]`)
    await optInput.setValue('Claw')
    await w.find('.option-numeric-input').setValue(5)
    await w.find('.btn-add-opt').trigger('click')

    await optInput.setValue('Roller')
    await w.find('.option-numeric-input').setValue(10)
    await w.find('.btn-add-opt').trigger('click')

    expect(w.findAll('.opt-preview-chip')).toHaveLength(2)
    await w.find('.btn-opt-del').trigger('click')
    expect(w.findAll('.opt-preview-chip')).toHaveLength(1)

    await w.find('.btn-save').trigger('click')
    const saveEmits = w.emitted('save')
    expect(saveEmits).toHaveLength(1)
    const [payload, editingId] = saveEmits![0]!
    expect(editingId).toBeNull()
    expect(payload).toMatchObject({
      eventId: 'evt-1',
      target: 'MATCH',
      name: 'Intake Type',
      fieldKey: 'intake_type',
      fieldType: 'select'
    })
    const parsedOpts = JSON.parse((payload as CustomFieldDefinition).optionsJson!)
    expect(parsedOpts).toHaveLength(1)
    expect(parsedOpts[0].label).toBe('Roller')
    expect(parsedOpts[0].numericValue).toBe(10)
  })

  it('forces TEAM target to formula type, validates non-empty/valid formula, and hydrates editingField', async () => {
    const toast = useToastStore()
    const toastSpy = vi.spyOn(toast, 'showToast')

    const w = track(
      mount(CustomFieldBuilderForm, {
        props: {
          eventId: 'evt-1',
          activeTab: 'TEAM',
          editingField: null,
          isSaving: false,
          existingFields: []
        },
        global: { plugins: [i18n] }
      })
    )

    // TEAM hides type selector and forces formula
    expect(w.find('.types-selector-grid').exists()).toBe(false)
    await w.find('input[type="text"]').setValue('Power Score')

    // Missing formula expression -> toast error
    await w.find('.btn-save').trigger('click')
    expect(toastSpy).toHaveBeenCalledWith(expect.any(String), 'error')
    expect(w.emitted('save')).toBeUndefined()

    // Enter valid formula and save
    await w.find('.formula-textarea').setValue('opr.np * 1.5')
    await w.find('.btn-save').trigger('click')
    expect(w.emitted('save')).toHaveLength(1)
    const [teamPayload] = w.emitted('save')![0]!
    expect(teamPayload).toMatchObject({
      target: 'TEAM',
      phase: 'overall',
      fieldType: 'formula',
      formulaExpr: 'opr.np * 1.5'
    })

    // Editing an existing tier-formatted field preserves config
    const existing: CustomFieldDefinition = {
      id: 'cf-edit-1',
      eventId: 'evt-1',
      target: 'TEAM',
      phase: 'overall',
      name: 'Tier Metric',
      fieldKey: 'tier_metric',
      fieldType: 'formula',
      required: false,
      formulaExpr: 'opr.np',
      displayFormat: 'tier',
      configJson: JSON.stringify({ decimalPlaces: 1, tierThresholds: { high: 50, mid: 30, direction: 'higher_better' } }),
      orderSeq: 1,
      isActive: true
    }
    await w.setProps({ editingField: existing })
    await w.find('.btn-save').trigger('click')
    const [editPayload, editId] = w.emitted('save')![1]!
    expect(editId).toBe('cf-edit-1')
    expect((editPayload as any).configJson).toContain('"high":50')
  })
})
