import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import FormulaEditorPanel from '../components/customFields/FormulaEditorPanel.vue'
import { useRecordStore } from '../stores/records'
import { usePitScoutStore } from '../stores/pitScout'
import type { CustomFieldDefinition } from '../types'

const makeField = (overrides: Partial<CustomFieldDefinition>): CustomFieldDefinition => ({
  id: 'f1',
  eventId: 'evt-1',
  target: 'TEAM',
  phase: 'overall',
  name: 'Base',
  fieldKey: 'base_metric',
  fieldType: 'formula',
  required: false,
  formulaExpr: 'opr.np + 10',
  orderSeq: 1,
  isActive: true,
  ...overrides
})

describe('FormulaEditorPanel.vue', () => {
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

  it('validates expressions, shows cycle errors, inserts chips, and evaluates live sample & team previews', async () => {
    const recordStore = useRecordStore()
    const pitStore = usePitScoutStore()
    recordStore.records = [
      {
        id: 'r1',
        eventId: 'evt-1',
        scoutId: 's1',
        scoutName: 'Scout1',
        matchNumber: 1,
        teamNumber: 27570,
        autoScore: 20,
        teleopScore: 30,
        endgameScore: 10,
        totalScore: 60,
        notes: '',
        rawData: '{}',
        syncStatus: 'SYNCED',
        createdAt: '',
        updatedAt: '',
        isBroken: false,
        version: 1
      }
    ]
    pitStore.records = [
      {
        id: 'p1',
        eventId: 'evt-1',
        teamNumber: 27570,
        scoutId: 's1',
        scoutName: 'Scout1',
        drivetrainType: 'swerve',
        weightLbs: 30,
        ballCompatibility: 'universal',
        launcherType: 'Flywheel',
        flowerMechanism: 'Arm',
        hasColorSensor: true,
        odometryType: 'pinpoint',
        claimedAutoScore: 20,
        claimedTeleopCycles: 8,
        claimedTeleopScore: 30,
        claimedEndgameScore: 10,
        claimedTotalScore: 60,
        version: 1
      }
    ]

    const existingFields: CustomFieldDefinition[] = [
      makeField({ id: 'f-match-cf', target: 'MATCH', fieldKey: 'defense', fieldType: 'number', name: 'Defense' }),
      makeField({ id: 'f-pit-cf', target: 'PIT', fieldKey: 'lift_speed', fieldType: 'number', name: 'Lift' }),
      makeField({ id: 'f-base', target: 'TEAM', fieldKey: 'base_metric', fieldType: 'formula', formulaExpr: 'opr.np + 10' })
    ]

    const w = track(
      mount(FormulaEditorPanel, {
        props: {
          modelValue: 'formula.base_metric * 2',
          target: 'TEAM',
          fieldKey: 'double_metric',
          existingFields,
          displayFormat: 'number'
        }
      })
    )

    expect(w.find('.formula-status-badge.is-valid').exists()).toBe(true)
    expect(w.emitted('validation-change')?.[0]?.[0]).toMatchObject({ valid: true })

    // Team 27570 is auto-selected from availableTeams; switch to sample to verify sample context preview
    const select = w.find('.preview-team-select')
    await select.setValue('sample')
    // sample opr.np = 48.5 => base_metric = 58.5 => * 2 = 117
    expect(w.find('.preview-value').text()).toBe('117')

    // Click a variable chip to insert into textarea
    const varChip = w.find('.var-chip')
    expect(varChip.exists()).toBe(true)
    await varChip.trigger('click')
    expect(w.emitted('update:modelValue')?.length).toBeGreaterThan(0)

    // Invalid expression renders error box
    await w.setProps({ modelValue: 'formula.double_metric + 1' })
    expect(w.find('.formula-status-badge.is-error').exists()).toBe(true)
    expect(w.find('.formula-error-box').exists()).toBe(true)
    expect(w.find('.cycle-path').text()).toContain('double_metric')
  })
})
