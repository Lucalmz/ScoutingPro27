import { mount, flushPromises, VueWrapper } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import ScoutingForm from '../components/scouting/ScoutingForm.vue'
import { useRecordStore } from '../stores/records'
import type { ScoutingRecord } from '../../types'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, any>) =>
      params && 'sec' in params ? `${params.sec}s` : key,
    te: () => false
  }),
  createI18n: () => ({})
}))

describe('ScoutingForm', () => {
  const wrappers: VueWrapper[] = []
  const track = (w: VueWrapper) => {
    wrappers.push(w)
    return w
  }

  const defaultProps = {
    eventId: 'event-1',
    scoutId: 'scout-1',
    scoutName: 'Alice'
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    while (wrappers.length > 0) {
      wrappers.pop()!.unmount()
    }
    localStorage.clear()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('switches between single and alliance mode via segmented control DOM buttons', async () => {
    const wrapper = track(mount(ScoutingForm, { props: defaultProps }))
    expect(wrapper.findAll('.team-column')).toHaveLength(1)

    const modeBtns = wrapper.findAll('.settings-section .segmented-control button')
    expect(modeBtns).toHaveLength(2)

    await modeBtns[1].trigger('click')
    expect(modeBtns[1].classes()).toContain('active')
    expect(wrapper.findAll('.team-column')).toHaveLength(2)

    await modeBtns[0].trigger('click')
    expect(modeBtns[0].classes()).toContain('active')
    expect(wrapper.findAll('.team-column')).toHaveLength(1)
  })

  describe('Form validation on submit via DOM inputs', () => {
    it('blocks submit and renders error message when matchNumber <= 0 or allianceColor is none', async () => {
      const wrapper = track(mount(ScoutingForm, { props: defaultProps }))
      const matchInput = wrapper.find('input[placeholder="1-999"]')
      const teamInput = wrapper.find('input[placeholder="e.g. 12345"]')

      // Valid team & alliance color, invalid matchNumber=0
      await wrapper.findAll('.spdt-labels span')[0].trigger('click') // red
      await teamInput.setValue('123')
      await matchInput.setValue('0')
      await wrapper.find('form.scouting-form').trigger('submit')
      expect(wrapper.emitted('submit')).toBeUndefined()
      expect(wrapper.find('.submit-status-msg.error').exists()).toBe(true)

      // Invalid matchNumber=-1
      await matchInput.setValue('-1')
      await wrapper.find('form.scouting-form').trigger('submit')
      expect(wrapper.emitted('submit')).toBeUndefined()

      // Valid matchNumber=1 submits cleanly
      await matchInput.setValue('1')
      await wrapper.find('form.scouting-form').trigger('submit')
      await flushPromises()
      expect(wrapper.emitted('submit')).toHaveLength(1)
    })

    it('blocks submit when allianceColor is not chosen and succeeds once blue is clicked', async () => {
      const wrapper = track(mount(ScoutingForm, { props: defaultProps }))
      await wrapper.find('input[placeholder="1-999"]').setValue('1')
      await wrapper.find('input[placeholder="e.g. 12345"]').setValue('123')

      expect(wrapper.find('.spdt-switch').classes()).toContain('pos-none')
      await wrapper.find('form.scouting-form').trigger('submit')
      expect(wrapper.emitted('submit')).toBeUndefined()
      expect(wrapper.find('.submit-status-msg.error').exists()).toBe(true)

      await wrapper.findAll('.spdt-labels span')[1].trigger('click')
      expect(wrapper.find('.spdt-switch').classes()).toContain('pos-blue')
      await wrapper.find('form.scouting-form').trigger('submit')
      await flushPromises()
      expect(wrapper.emitted('submit')).toHaveLength(1)
    })

    it('blocks submit in alliance mode when both teams share the same teamNumber', async () => {
      const wrapper = track(mount(ScoutingForm, { props: defaultProps }))
      await wrapper.find('input[placeholder="1-999"]').setValue('1')
      await wrapper.findAll('.spdt-labels span')[0].trigger('click')
      await wrapper.findAll('.settings-section .segmented-control button')[1].trigger('click')

      const teamInputs = wrapper.findAll('input[placeholder="e.g. 12345"]')
      expect(teamInputs).toHaveLength(2)

      await teamInputs[0].setValue('123')
      await teamInputs[1].setValue('123')
      await wrapper.find('form.scouting-form').trigger('submit')
      expect(wrapper.emitted('submit')).toBeUndefined()
      expect(wrapper.find('.submit-status-msg.error').exists()).toBe(true)

      await teamInputs[1].setValue('456')
      await wrapper.find('form.scouting-form').trigger('submit')
      await flushPromises()
      expect(wrapper.emitted('submit')).toHaveLength(1)
    })
  })

  it('previousScoutMode logic: reverts to alliance mode after submitting editRecord', async () => {
    const wrapper = track(mount(ScoutingForm, { props: defaultProps }))

    await wrapper.findAll('.settings-section .segmented-control button')[1].trigger('click')
    expect(wrapper.findAll('.team-column')).toHaveLength(2)

    const mockRecord: ScoutingRecord = {
      id: 'rec-1',
      eventId: 'event-1',
      scoutId: 'scout-1',
      scoutName: 'Alice',
      matchNumber: 2,
      teamNumber: 123,
      autoScore: 0,
      teleopScore: 0,
      endgameScore: 0,
      totalScore: 0,
      notes: '',
      rawData: JSON.stringify({
        matchNumber: 2,
        teamNumber: 123,
        allianceColor: 'blue',
        autoLeave: true,
        autoBalls: 1,
        autoPark: true,
        teleopCycles: [2, 3],
        flowerPlaced: false,
        flowerBottomBonus: false,
        teleopPark: true
      }),
      syncStatus: 'PENDING',
      createdAt: '2023-01-01T00:00:00Z',
      updatedAt: '2023-01-01T00:00:00Z'
    }

    await wrapper.setProps({ editRecord: mockRecord })
    expect(wrapper.findAll('.team-column')).toHaveLength(1)

    await wrapper.find('form.scouting-form').trigger('submit')
    await flushPromises()

    expect(wrapper.emitted('submit')).toHaveLength(1)
    expect(wrapper.findAll('.team-column')).toHaveLength(2)
  })

  it('allows editing original match and team without conflict deadlock, while blocking duplicate collision', async () => {
    const recordStore = useRecordStore()
    const r1: ScoutingRecord = {
      id: 'r_rec_1',
      eventId: 'event-1',
      scoutId: 'scout-1',
      scoutName: 'Alice',
      matchNumber: 1,
      teamNumber: 27570,
      autoScore: 10,
      teleopScore: 20,
      endgameScore: 10,
      totalScore: 40,
      notes: '',
      rawData: JSON.stringify({ tournamentLevel: 'QUALIFICATION', allianceColor: 'red' }),
      syncStatus: 'SYNCED',
      createdAt: '2026-09-16T12:00:00Z',
      updatedAt: '2026-09-16T12:00:00Z',
      isBroken: false,
      isDeleted: false,
      version: 1
    }
    const r2Duplicate: ScoutingRecord = { ...r1, id: 'r_rec_2', updatedAt: '2026-09-16T12:01:00Z' }
    const r3Match2: ScoutingRecord = {
      ...r1,
      id: 'r_rec_3',
      matchNumber: 2,
      rawData: JSON.stringify({ matchNumber: 2, teamNumber: 27570, tournamentLevel: 'QUALIFICATION', allianceColor: 'red' })
    }

    recordStore.currentEventId = 'event-1'
    recordStore.records = [r1, r2Duplicate, r3Match2]

    const wrapper = track(mount(ScoutingForm, {
      props: { ...defaultProps, editRecord: r1 }
    }))
    await nextTick()

    expect(wrapper.find('.btn-submit').exists()).toBe(true)
    await wrapper.find('form.scouting-form').trigger('submit')
    await flushPromises()
    expect(wrapper.emitted('submit')).toHaveLength(1)
    expect(wrapper.find('.submit-status-msg.error').exists()).toBe(false)

    await wrapper.find('input[placeholder="1-999"]').setValue('2')
    await wrapper.find('form.scouting-form').trigger('submit')
    await flushPromises()
    expect(wrapper.find('.submit-status-msg.error').exists()).toBe(true)
    expect(wrapper.emitted('submit')).toHaveLength(1)
  })

  describe('Team Tags Integration', () => {
    it('renders TagPicker only when a valid positive teamNumber is entered via DOM input', async () => {
      const wrapper = track(mount(ScoutingForm, { props: defaultProps }))
      expect(wrapper.find('form.scouting-form').exists()).toBe(true)
      const teamInput = wrapper.find('input[placeholder="e.g. 12345"]')

      expect(wrapper.findComponent({ name: 'TagPicker' }).exists()).toBe(false)

      await teamInput.setValue('0')
      expect(wrapper.find('form.scouting-form').exists()).toBe(true)
      expect(wrapper.findComponent({ name: 'TagPicker' }).exists()).toBe(false)

      await teamInput.setValue('12345')
      const tagPicker = wrapper.findComponent({ name: 'TagPicker' })
      expect(tagPicker.exists()).toBe(true)
      expect(tagPicker.props('eventId')).toBe('event-1')
      expect(tagPicker.props('teamNumber')).toBe(12345)
    })

    it('prevents TagPicker add/remove buttons inside ScoutingForm from triggering form submit', async () => {
      const recordStore = useRecordStore()
      recordStore.teamTags = [
        {
          id: 'tag-1',
          eventId: 'event-1',
          teamNumber: 27570,
          tag: 'fast-auto',
          color: 'blue',
          isPreset: false,
          createdAt: new Date().toISOString()
        }
      ] as any

      const wrapper = track(mount(ScoutingForm, { props: defaultProps }))
      await wrapper.find('input[placeholder="e.g. 12345"]').setValue('27570')

      const addBtn = wrapper.find('.btn-add-tag')
      const removeBtn = wrapper.find('.btn-tag-remove')
      expect(addBtn.exists()).toBe(true)
      expect(removeBtn.exists()).toBe(true)
      expect(addBtn.attributes('type')).toBe('button')
      expect(removeBtn.attributes('type')).toBe('button')

      await addBtn.trigger('click')
      expect(wrapper.find('.tag-edit-panel').exists()).toBe(true)
      expect(wrapper.emitted('submit')).toBeUndefined()
      expect(wrapper.find('.submit-status-msg').exists()).toBe(false)
    })
  })

  describe('Cycle Tracker Controls & Counter Animations', () => {
    it('records, increments/decrements with alternating bump classes, and undoes cycles via DOM', async () => {
      const wrapper = track(mount(ScoutingForm, { props: defaultProps }))
      const teleop = wrapper.find('.phase-teleop')

      // Start cycle 1
      await teleop.find('.btn-action-new-cycle').trigger('click')
      const counterVal = teleop.find('.active-cycle-card .counter-val')
      const [minusBtn, plusBtn] = teleop.findAll('.active-cycle-card .counter-btn')
      expect(minusBtn.text()).toBe('-')
      expect(plusBtn.text()).toBe('+')
      expect(counterVal.text()).toBe('0')

      // Consecutive clicks alternate bump-up-a / bump-up-b
      await plusBtn.trigger('click')
      expect(counterVal.text()).toBe('1')
      expect(counterVal.classes()).toContain('bump-up-a')

      await plusBtn.trigger('click')
      expect(counterVal.text()).toBe('2')
      expect(counterVal.classes()).toContain('bump-up-b')
      expect(counterVal.classes()).not.toContain('bump-up-a')

      await plusBtn.trigger('click')
      expect(counterVal.text()).toBe('3')
      expect(counterVal.classes()).toContain('bump-up-a')

      await counterVal.trigger('animationend')
      expect(counterVal.classes()).not.toContain('bump-up-a')
      expect(counterVal.classes()).not.toContain('bump-up-b')

      // Cap at 4 balls
      await plusBtn.trigger('click')
      expect(counterVal.text()).toBe('4')
      expect((plusBtn.element as HTMLButtonElement).disabled).toBe(true)

      // Consecutive decrements continue global parity: bump-down-a / bump-down-b
      await minusBtn.trigger('click')
      expect(counterVal.text()).toBe('3')
      expect(counterVal.classes()).toContain('bump-down-a')

      await minusBtn.trigger('click')
      expect(counterVal.text()).toBe('2')
      expect(counterVal.classes()).toContain('bump-down-b')

      // Add a 2nd cycle with preset 3 balls (total 5 balls across 2 cycles)
      await teleop.find('.btn-action-new-cycle').trigger('click')
      await teleop.findAll('.chips-group .quick-ball-btn')[3].trigger('click') // 3 balls
      expect(teleop.findAll('.kpi-card .kpi-num')[0].text()).toBe('2')
      expect(teleop.findAll('.kpi-card .kpi-num')[1].text()).toBe('5')

      // Undo last ball action decreases cycle 2 balls from 3 to 2
      await teleop.find('.btn-action-undo').trigger('click')
      expect(teleop.findAll('.kpi-card .kpi-num')[1].text()).toBe('4')
    })

    it('updates autoBalls via auto stepper DOM clicks with alternating bump animations and chip selection', async () => {
      const wrapper = track(mount(ScoutingForm, { props: defaultProps }))
      const autoPhase = wrapper.find('.phase-auto')
      const autoVal = autoPhase.find('.auto-stepper .counter-val')
      const [autoMinus, autoPlus] = autoPhase.findAll('.auto-stepper .counter-btn')

      expect(autoVal.text()).toBe('0')

      await autoPlus.trigger('click')
      expect(autoVal.text()).toBe('1')
      expect(autoVal.classes()).toContain('bump-up-a')

      await autoPlus.trigger('click')
      expect(autoVal.text()).toBe('2')
      expect(autoVal.classes()).toContain('bump-up-b')

      await autoMinus.trigger('click')
      expect(autoVal.text()).toBe('1')
      expect(autoVal.classes().some((c) => c.startsWith('bump-down-'))).toBe(true)

      // Chip preset 3 balls -> total inline score reflects 3 * 3 = 9
      await autoPhase.findAll('.chips-group .quick-ball-btn')[3].trigger('click')
      expect(autoVal.text()).toBe('3')
      expect(wrapper.find('.total-score-inline .total-value').text()).toBe('9')

      // Chip preset 0 balls resets auto to 0
      await autoPhase.findAll('.chips-group .quick-ball-btn')[0].trigger('click')
      expect(autoVal.text()).toBe('0')
      expect(wrapper.find('.total-score-inline .total-value').text()).toBe('0')
    })
  })

  describe('Draft Autosave, Restore & Rapid Keystroke Stress', () => {
    it('restores valid draft into DOM and clears on dismiss click, while discarding stale >24h draft', async () => {
      const freshDraft = {
        matchNumber: '42',
        allianceColor: 'blue',
        currentTournamentLevel: 'PLAYOFF',
        scoutMode: 'single',
        teamsData: [{
          teamNumber: '9999',
          autoLeave: true,
          autoBalls: 2,
          autoCycles: [2],
          autoMissedCycles: [],
          autoPark: true,
          teleopCycles: [3, 4],
          teleopMissedCycles: [],
          flowerPlaced: true,
          flowerBottomBonus: false,
          teleopPark: true,
          isBroken: false,
          notes: 'Restored from draft after screen sleep',
          customFields: {}
        }],
        savedAt: Date.now()
      }
      localStorage.setItem('sp27_active_draft_event-1', JSON.stringify(freshDraft))

      const wrapper = track(mount(ScoutingForm, { props: defaultProps }))
      await nextTick()

      expect(wrapper.find('.draft-restored-banner').exists()).toBe(true)
      expect((wrapper.find('input[placeholder="1-999"]').element as HTMLInputElement).value).toBe('42')
      expect(wrapper.find('.spdt-switch').classes()).toContain('pos-blue')
      expect((wrapper.find('input[placeholder="e.g. 12345"]').element as HTMLInputElement).value).toBe('9999')
      expect((wrapper.find('textarea.notes-input').element as HTMLTextAreaElement).value).toBe('Restored from draft after screen sleep')

      await wrapper.find('.draft-restored-banner .btn-load-task').trigger('click')
      expect(wrapper.find('.draft-restored-banner').exists()).toBe(false)
      expect(localStorage.getItem('sp27_active_draft_event-1')).toBeNull()
      wrapper.unmount()

      // Stale draft > 24h must be discarded
      localStorage.setItem('sp27_active_draft_event-1', JSON.stringify({
        matchNumber: '10',
        allianceColor: 'red',
        teamsData: [{ teamNumber: '1111', notes: 'ancient draft' }],
        savedAt: Date.now() - 25 * 60 * 60 * 1000
      }))
      const staleWrapper = track(mount(ScoutingForm, { props: defaultProps }))
      await nextTick()
      expect(staleWrapper.find('form.scouting-form').exists()).toBe(true)
      expect(staleWrapper.find('.draft-restored-banner').exists()).toBe(false)
      expect(localStorage.getItem('sp27_active_draft_event-1')).toBeNull()
    })

    it('saves draft via debounce when editing notes under assignedTask and flushes immediately on unmount', async () => {
      vi.useFakeTimers()
      try {
        const wrapper = track(mount(ScoutingForm, {
          props: {
            ...defaultProps,
            assignedTask: { matchNumber: 5, teamNumber: 27570, allianceColor: 'red', tournamentLevel: 'QUALIFICATION' }
          }
        }))
        await nextTick()

        await wrapper.find('textarea.notes-input').setValue('Great defense during match 5')
        vi.advanceTimersByTime(500)

        const saved = JSON.parse(localStorage.getItem('sp27_active_draft_event-1')!)
        expect(saved.matchNumber).toBe('5')
        expect(saved.teamsData[0].notes).toBe('Great defense during match 5')
        wrapper.unmount()

        // Immediate unmount flush before 400ms debounce expires
        localStorage.removeItem('sp27_active_draft_event-1')
        const w2 = track(mount(ScoutingForm, { props: defaultProps }))
        await nextTick()
        await w2.find('input[placeholder="e.g. 12345"]').setValue('27570')
        await w2.find('textarea.notes-input').setValue('Unmounting without waiting 400ms')
        w2.unmount()

        const flushed = JSON.parse(localStorage.getItem('sp27_active_draft_event-1')!)
        expect(flushed.teamsData[0].notes).toBe('Unmounting without waiting 400ms')
      } finally {
        vi.useRealTimers()
      }
    })

    it('resets submit button disabled state post-submit and advances matchNumber', async () => {
      const wrapper = track(mount(ScoutingForm, { props: defaultProps }))
      await wrapper.find('input[placeholder="1-999"]').setValue('1')
      await wrapper.findAll('.spdt-labels span')[0].trigger('click')
      await wrapper.find('input[placeholder="e.g. 12345"]').setValue('27570')

      const submitBtn = wrapper.find('button.btn-submit')
      expect(submitBtn.attributes('disabled')).toBeUndefined()

      await wrapper.find('form.scouting-form').trigger('submit')
      await flushPromises()

      expect(submitBtn.attributes('disabled')).toBeUndefined()
      expect((wrapper.find('input[placeholder="1-999"]').element as HTMLInputElement).value).toBe('2')
      expect((wrapper.find('input[placeholder="e.g. 12345"]').element as HTMLInputElement).value).toBe('')
    })

    it.each([
      { delayAfterSubmitMs: 50, delayBeforeUnmountMs: 50 },
      { delayAfterSubmitMs: 250, delayBeforeUnmountMs: 200 }
    ])('preserves rapid keystrokes at %oms post-submit across immediate unmount/reload', async ({ delayAfterSubmitMs, delayBeforeUnmountMs }) => {
      vi.useFakeTimers()
      const wrapper = track(mount(ScoutingForm, { props: defaultProps }))
      await nextTick()

      await wrapper.find('input[placeholder="1-999"]').setValue('1')
      await wrapper.findAll('.spdt-labels span')[0].trigger('click')
      await wrapper.find('input[placeholder="e.g. 12345"]').setValue('12345')
      await wrapper.find('form.scouting-form').trigger('submit')
      await flushPromises()

      vi.advanceTimersByTime(delayAfterSubmitMs)
      await wrapper.find('input[placeholder="e.g. 12345"]').setValue('99999')
      await wrapper.find('textarea.notes-input').setValue(`Rapid post-submit ${delayAfterSubmitMs}ms`)
      vi.advanceTimersByTime(delayBeforeUnmountMs)
      wrapper.unmount()

      const draft = JSON.parse(localStorage.getItem('sp27_active_draft_event-1')!)
      expect(draft.matchNumber).toBe('2')
      expect(draft.teamsData[0].teamNumber).toBe('99999')
      expect(draft.teamsData[0].notes).toBe(`Rapid post-submit ${delayAfterSubmitMs}ms`)

      const reloaded = track(mount(ScoutingForm, { props: defaultProps }))
      await nextTick()
      expect(reloaded.find('.draft-restored-banner').exists()).toBe(true)
      expect((reloaded.find('input[placeholder="1-999"]').element as HTMLInputElement).value).toBe('2')
      expect((reloaded.find('input[placeholder="e.g. 12345"]').element as HTMLInputElement).value).toBe('99999')
      expect((reloaded.find('textarea.notes-input').element as HTMLTextAreaElement).value).toBe(`Rapid post-submit ${delayAfterSubmitMs}ms`)
    })

    it('preserves keystrokes entered at 480ms post-submit via 400ms debounce and across 20 rapid submit cycles', async () => {
      vi.useFakeTimers()
      const wrapper = track(mount(ScoutingForm, { props: defaultProps }))
      await nextTick()

      await wrapper.find('input[placeholder="1-999"]').setValue('1')
      await wrapper.findAll('.spdt-labels span')[0].trigger('click')
      await wrapper.find('input[placeholder="e.g. 12345"]').setValue('12345')
      await wrapper.find('form.scouting-form').trigger('submit')
      await flushPromises()

      vi.advanceTimersByTime(480)
      await wrapper.find('input[placeholder="e.g. 12345"]').setValue('77777')
      vi.advanceTimersByTime(450)
      wrapper.unmount()

      const fresh = track(mount(ScoutingForm, { props: defaultProps }))
      await nextTick()
      expect(fresh.find('.draft-restored-banner').exists()).toBe(true)
      expect((fresh.find('input[placeholder="e.g. 12345"]').element as HTMLInputElement).value).toBe('77777')
      await fresh.find('.draft-restored-banner .btn-load-task').trigger('click')
      fresh.unmount()

      for (let cycle = 1; cycle <= 20; cycle++) {
        const w = track(mount(ScoutingForm, { props: defaultProps }))
        await nextTick()

        await w.find('input[placeholder="1-999"]').setValue(String(cycle))
        await w.findAll('.spdt-labels span')[0].trigger('click')
        await w.find('input[placeholder="e.g. 12345"]').setValue(String(1000 + cycle))
        await w.find('form.scouting-form').trigger('submit')
        await flushPromises()

        expect((w.find('input[placeholder="1-999"]').element as HTMLInputElement).value).toBe(String(cycle + 1))

        vi.advanceTimersByTime(80)
        const nextTeamNumber = String(2000 + cycle)
        await w.find('input[placeholder="e.g. 12345"]').setValue(nextTeamNumber)
        await w.find('textarea.notes-input').setValue(`Cycle ${cycle} rapid input`)
        vi.advanceTimersByTime(70)
        w.unmount()

        const reloaded = track(mount(ScoutingForm, { props: defaultProps }))
        await nextTick()
        expect(reloaded.find('.draft-restored-banner').exists()).toBe(true)
        expect((reloaded.find('input[placeholder="1-999"]').element as HTMLInputElement).value).toBe(String(cycle + 1))
        expect((reloaded.find('input[placeholder="e.g. 12345"]').element as HTMLInputElement).value).toBe(nextTeamNumber)
        expect((reloaded.find('textarea.notes-input').element as HTMLTextAreaElement).value).toBe(`Cycle ${cycle} rapid input`)
        await reloaded.find('.draft-restored-banner .btn-load-task').trigger('click')
        reloaded.unmount()
      }
    })
  })

  describe('Restored UI interactions & BIOBUZZ endgame scoring', () => {
    it('wires DOM clicks for alliance SPDT switch and toggle cards', async () => {
      const wrapper = track(mount(ScoutingForm, { props: defaultProps }))

      const spdtLabels = wrapper.findAll('.spdt-labels span')
      expect(spdtLabels).toHaveLength(2)
      await spdtLabels[1].trigger('click')
      expect(wrapper.find('.scouting-wrapper').classes()).toContain('color-blue')
      await spdtLabels[0].trigger('click')
      expect(wrapper.find('.scouting-wrapper').classes()).toContain('color-red')

      const toggles = wrapper.findAll('.toggle-card')
      expect(toggles).toHaveLength(6)
      await toggles[0].find('input[type="checkbox"]').setValue(true) // autoLeave (+3)
      await toggles[2].find('input[type="checkbox"]').setValue(true) // teleopPark (+5)
      expect(toggles[0].classes()).toContain('is-active')
      expect(toggles[2].classes()).toContain('is-active')
      expect(wrapper.find('.total-score-inline .total-value').text()).toBe('8')
    })

    it('calculates BIOBUZZ Endgame scoring, clamps bottom bonus <= nectars, warns on unowned pollens and alliance nectar > 8', async () => {
      const wrapper = track(mount(ScoutingForm, { props: defaultProps }))

      await wrapper.find('input[placeholder="1-999"]').setValue('3')
      await wrapper.findAll('.spdt-labels span')[0].trigger('click')
      await wrapper.find('input[placeholder="e.g. 12345"]').setValue('27570')

      const stepperCards = wrapper.findAll('.endgame-stepper-card')
      expect(stepperCards).toHaveLength(4)
      const nectarChips = stepperCards[0].findAll('.quick-ball-btn')
      const bonusChips = stepperCards[1].findAll('.quick-ball-btn')
      const pollenChips = stepperCards[2].findAll('.quick-ball-btn')
      const gardenChips = stepperCards[3].findAll('.quick-ball-btn')

      // Set pollens = 2 while flowerNectars === 0 -> shows hint banner
      await pollenChips[1].trigger('click')
      expect(pollenChips[1].classes()).toContain('is-selected')
      expect(wrapper.find('.endgame-hint-banner').exists()).toBe(true)

      // Set flowerNectars = 2 -> hint disappears, bonus chips up to 2 become enabled
      await nectarChips[2].trigger('click')
      expect(nectarChips[2].classes()).toContain('is-selected')
      expect(wrapper.find('.endgame-hint-banner').exists()).toBe(false)

      // Set flowerBottomBonusCount = 2, then reduce flowerNectars to 1 -> auto-clamps bottom bonus to 1
      await bonusChips[2].trigger('click')
      expect(bonusChips[2].classes()).toContain('is-selected')
      await nectarChips[1].trigger('click') // flowerNectars = 1
      expect(bonusChips[1].classes()).toContain('is-selected')

      // Set gardenBalls = 3 via chip 2 (value 4) then '-' button (4 -> 3), enable teleopPark (+5)
      await gardenChips[2].trigger('click')
      await stepperCards[3].findAll('.counter-btn')[0].trigger('click')
      await wrapper.findAll('.toggle-card')[2].find('input[type="checkbox"]').setValue(true)

      // Endgame = park(5) + 1*2 + 1*5 + 2*2 + garden 3*1 = 19
      expect(wrapper.find('.total-score-inline .total-value').text()).toBe('19')

      // Switch to alliance mode, set team 1 nectar=8 (chip 4) and team 2 nectar=1 (chip 1) -> total 9 > 8 warning
      await wrapper.findAll('.settings-section .segmented-control button')[1].trigger('click')
      const allSteppers = wrapper.findAll('.endgame-stepper-card')
      await allSteppers[0].findAll('.quick-ball-btn')[4].trigger('click') // team 1 nectars = 8
      await allSteppers[4].findAll('.quick-ball-btn')[1].trigger('click') // team 2 nectars = 1
      expect(wrapper.find('.endgame-warn-banner').exists()).toBe(true)
    })

    it('passively collects teleopCycleTimestamps via DOM clicks, pops on undo, and computes predictCycleTime', async () => {
      vi.useFakeTimers()
      let now = 1_700_000_000_000
      vi.setSystemTime(now)

      const wrapper = track(mount(ScoutingForm, { props: defaultProps }))
      await wrapper.find('input[placeholder="1-999"]').setValue('10')
      await wrapper.findAll('.spdt-labels span')[1].trigger('click')
      await wrapper.find('input[placeholder="e.g. 12345"]').setValue('27570')

      const teleop = wrapper.find('.phase-teleop')
      const gaps = [0, 6000, 8000, 10000, 12000, 14000]
      for (const g of gaps) {
        now += g
        vi.setSystemTime(now)
        await teleop.find('.btn-action-new-cycle').trigger('click')
        await teleop.findAll('.chips-group .quick-ball-btn')[2].trigger('click') // 2 balls
      }

      // 6 cycles (5 intervals [6,8,10,12,14], drop min 6 -> avg(8,10,12,14) = 11.0s)
      expect(wrapper.find('.teleop-predict-bar .predict-val').text()).toBe('11s')

      // Adding an empty 7th cycle then undoing it keeps 11s without truncating cycle 6's timestamp
      now += 5000
      vi.setSystemTime(now)
      await teleop.find('.btn-action-new-cycle').trigger('click')
      await teleop.find('.btn-action-undo').trigger('click') // removes empty 7th cycle
      expect(wrapper.find('.teleop-predict-bar .predict-val').text()).toBe('11s')

      // Adding a stamped 7th cycle (+7s from 6th) shifts prediction; undoing ball + cycle pops timestamp and restores 11s
      now += 2000
      vi.setSystemTime(now)
      await teleop.find('.btn-action-new-cycle').trigger('click')
      await teleop.findAll('.chips-group .quick-ball-btn')[2].trigger('click') // stamps 7th cycle at +7s
      expect(wrapper.find('.teleop-predict-bar .predict-val').text()).toBe('9.3s')

      await teleop.find('.btn-action-undo').trigger('click') // 7th cycle balls 2 -> 1
      await teleop.find('.btn-action-undo').trigger('click') // 7th cycle balls 1 -> 0
      await teleop.find('.btn-action-undo').trigger('click') // removes empty 7th cycle + pops 7th timestamp
      expect(wrapper.find('.teleop-predict-bar .predict-val').text()).toBe('11s')
    })
  })
})
