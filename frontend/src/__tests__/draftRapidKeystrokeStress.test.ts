import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import ScoutingForm from '../components/scouting/ScoutingForm.vue'
import { nextTick } from 'vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key
  }),
  createI18n: () => ({})
}))

describe('ScoutingForm & useScoutingDraft Rapid Keystroke Stress Suite', () => {
  const defaultProps = {
    eventId: 'stress-event-01',
    scoutId: 'scout-stress-01',
    scoutName: 'StressTester',
    tournamentLevel: 'QUALIFICATION',
    assignedTask: null,
    editRecord: null,
    teamsInEvent: [12345, 27570, 99999, 11111]
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    localStorage.clear()
    vi.useRealTimers()
  })

  it('verifies submitting.value resets immediately to false post-submit', async () => {
    const wrapper = mount(ScoutingForm, { props: defaultProps })
    await nextTick()

    // Setup valid Match 1 data
    wrapper.vm.matchNumber = '1'
    wrapper.vm.allianceColor = 'red'
    wrapper.vm.teamsData[0].teamNumber = '27570'
    await nextTick()

    expect(wrapper.vm.submitting).toBe(false)

    // Trigger submit
    await wrapper.vm.handleSubmit()

    // Submitting must be false immediately in finally block, not artificially delayed
    expect(wrapper.vm.submitting).toBe(false)
    expect(wrapper.vm.matchNumber).toBe('2')
    expect(wrapper.vm.teamsData[0].teamNumber).toBe('')
  })

  it('preserves rapid keystrokes entered at 50ms post-submit across immediate component unmount / reload', async () => {
    vi.useFakeTimers()
    const wrapper = mount(ScoutingForm, { props: defaultProps })
    await nextTick()

    // Submit Match 1
    wrapper.vm.matchNumber = '1'
    wrapper.vm.allianceColor = 'red'
    wrapper.vm.teamsData[0].teamNumber = '12345'
    await nextTick()

    await wrapper.vm.handleSubmit()
    expect(wrapper.vm.matchNumber).toBe('2')

    // Simulate 50ms post-submit delay before user starts typing Match 2
    vi.advanceTimersByTime(50)

    // User rapidly types Match 2 team number
    wrapper.vm.teamsData[0].teamNumber = '99999'
    wrapper.vm.teamsData[0].notes = 'Scouted right after submit at 50ms'
    await nextTick()

    // Simulate page reload / unmount at 100ms post-submit (only 50ms after typing, well before 400ms debounce!)
    vi.advanceTimersByTime(50)
    wrapper.unmount()

    // Verify localStorage has the unmount-flushed draft
    const raw = localStorage.getItem('sp27_active_draft_stress-event-01')
    expect(raw).not.toBeNull()
    const draft = JSON.parse(raw!)
    expect(draft.matchNumber).toBe('2')
    expect(draft.teamsData[0].teamNumber).toBe('99999')
    expect(draft.teamsData[0].notes).toBe('Scouted right after submit at 50ms')

    // Now simulate mounting a fresh component after reload
    const reloadedWrapper = mount(ScoutingForm, { props: defaultProps })
    await nextTick()

    expect(reloadedWrapper.vm.isDraftRestored).toBe(true)
    expect(reloadedWrapper.vm.matchNumber).toBe('2')
    expect(reloadedWrapper.vm.teamsData[0].teamNumber).toBe('99999')
    expect(reloadedWrapper.vm.teamsData[0].notes).toBe('Scouted right after submit at 50ms')

    reloadedWrapper.unmount()
  })

  it('preserves rapid keystrokes entered at 250ms post-submit when reload occurs at 450ms', async () => {
    vi.useFakeTimers()
    const wrapper = mount(ScoutingForm, { props: defaultProps })
    await nextTick()

    // Submit Match 1
    wrapper.vm.matchNumber = '1'
    wrapper.vm.allianceColor = 'blue'
    wrapper.vm.teamsData[0].teamNumber = '12345'
    await nextTick()

    await wrapper.vm.handleSubmit()

    // 250ms post-submit
    vi.advanceTimersByTime(250)

    // User types keystrokes
    wrapper.vm.teamsData[0].teamNumber = '88888'
    wrapper.vm.teamsData[0].autoBalls = 5
    wrapper.vm.teamsData[0].autoLeave = true
    await nextTick()

    // Advance to 450ms post-submit (200ms after typing, debounce timer still pending)
    vi.advanceTimersByTime(200)

    // Crash / unexpected page reload occurs at 450ms
    wrapper.unmount()

    // Draft must have been flushed synchronously on unmount
    const raw = localStorage.getItem('sp27_active_draft_stress-event-01')
    expect(raw).not.toBeNull()
    const draft = JSON.parse(raw!)
    expect(draft.matchNumber).toBe('2')
    expect(draft.teamsData[0].teamNumber).toBe('88888')
    expect(draft.teamsData[0].autoBalls).toBe(5)
    expect(draft.teamsData[0].autoLeave).toBe(true)

    // Fresh mount recovers complete state
    const newWrapper = mount(ScoutingForm, { props: defaultProps })
    await nextTick()

    expect(newWrapper.vm.isDraftRestored).toBe(true)
    expect(newWrapper.vm.matchNumber).toBe('2')
    expect(newWrapper.vm.teamsData[0].teamNumber).toBe('88888')
    expect(newWrapper.vm.teamsData[0].autoBalls).toBe(5)
    expect(newWrapper.vm.teamsData[0].autoLeave).toBe(true)

    newWrapper.unmount()
  })

  it('preserves rapid keystrokes entered at 480ms post-submit and saved via standard 400ms debounce', async () => {
    vi.useFakeTimers()
    const wrapper = mount(ScoutingForm, { props: defaultProps })
    await nextTick()

    // Submit Match 1
    wrapper.vm.matchNumber = '1'
    wrapper.vm.allianceColor = 'red'
    wrapper.vm.teamsData[0].teamNumber = '12345'
    await nextTick()
    await wrapper.vm.handleSubmit()

    // User waits 480ms (within 500ms post-submit), then types
    vi.advanceTimersByTime(480)
    wrapper.vm.teamsData[0].teamNumber = '77777'
    await nextTick()

    // Allow the 400ms debounce timer to fire naturally (total time 880ms)
    vi.advanceTimersByTime(450)

    const raw = localStorage.getItem('sp27_active_draft_stress-event-01')
    expect(raw).not.toBeNull()
    const draft = JSON.parse(raw!)
    expect(draft.teamsData[0].teamNumber).toBe('77777')

    // Page reloads without needing unmount flush (already persisted by debounce)
    wrapper.unmount()

    const freshWrapper = mount(ScoutingForm, { props: defaultProps })
    await nextTick()
    expect(freshWrapper.vm.isDraftRestored).toBe(true)
    expect(freshWrapper.vm.teamsData[0].teamNumber).toBe('77777')
    freshWrapper.unmount()
  })

  it('stress-tests 20 consecutive rapid submit -> type (<200ms) -> reload cycles without data loss', async () => {
    vi.useFakeTimers()

    for (let cycle = 1; cycle <= 20; cycle++) {
      const wrapper = mount(ScoutingForm, { props: defaultProps })
      await nextTick()

      // Current match is `cycle`
      wrapper.vm.matchNumber = String(cycle)
      wrapper.vm.allianceColor = 'red'
      wrapper.vm.teamsData[0].teamNumber = String(1000 + cycle)
      await nextTick()

      // Submit
      await wrapper.vm.handleSubmit()
      expect(wrapper.vm.matchNumber).toBe(String(cycle + 1))

      // User types next match data after just 80ms
      vi.advanceTimersByTime(80)
      const nextTeamNumber = String(2000 + cycle)
      wrapper.vm.teamsData[0].teamNumber = nextTeamNumber
      wrapper.vm.teamsData[0].notes = `Cycle ${cycle} rapid input`
      await nextTick()

      // Page reload occurs at 150ms (before 400ms debounce fires)
      vi.advanceTimersByTime(70)
      wrapper.unmount()

      // Fresh reload verifies draft persistence
      const reloaded = mount(ScoutingForm, { props: defaultProps })
      await nextTick()

      expect(reloaded.vm.isDraftRestored).toBe(true)
      expect(reloaded.vm.matchNumber).toBe(String(cycle + 1))
      expect(reloaded.vm.teamsData[0].teamNumber).toBe(nextTeamNumber)
      expect(reloaded.vm.teamsData[0].notes).toBe(`Cycle ${cycle} rapid input`)

      // Clear draft for clean slate into next cycle
      reloaded.vm.clearDraft()
      reloaded.unmount()
    }
  })
})
