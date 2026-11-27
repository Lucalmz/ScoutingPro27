import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { E2EClusterManager, allocateFreePort, ensureE2eBuildArtifacts } from './helpers/e2eBackendManager.js'
import {
  assertNoStuckTransition,
  createEventViaUi,
  createTinyPngFile,
  fetchBackendJson,
  robustLogin,
  submitMatchRecordViaUi,
  switchToTab,
  waitForCondition,
  waitForTransition,
} from './helpers/e2eUiActions.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')

async function getAuthSession(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem('scoutingpro-user')
    if (!raw) return null
    return JSON.parse(raw)
  })
}

async function setNumericInputValue(page, selector, valueStr) {
  const ok = await page.evaluate(
    (sel, val) => {
      const el = document.querySelector(sel)
      if (!el) return false
      el.focus()
      el.value = val
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    },
    selector,
    String(valueStr)
  )
  assert.equal(ok, true, `Input element not found for selector: ${selector}`)
}

async function run() {
  ensureE2eBuildArtifacts()
  const rootDbPaths = [
    path.join(REPO_ROOT, 'app_data.mv.db'),
    path.join(REPO_ROOT, 'Backend', 'app_data.mv.db'),
  ]
  const preExistingRootDbs = new Set(rootDbPaths.filter((p) => fs.existsSync(p)))

  const manager = new E2EClusterManager('comprehensive-e2e')
  let activePages = []
  let exitCode = 0

  try {
    const PORT_HOST_A = await allocateFreePort()
    console.log(`[Interactive-E2E] Starting local MQTT broker + HostA (${PORT_HOST_A})...`)
    await manager.startLocalMqttBroker()

    const tmpHostA = manager.createTempDir('host-a')
    await manager.startBackend({ name: 'hostA', port: PORT_HOST_A, tmpDir: tmpHostA })
    const urlHostA = `http://localhost:${PORT_HOST_A}/index.html`

    const launchA = await manager.launchBrowser({
      name: 'HostA',
      index: 0,
      userDataDir: manager.createTempDir('profile-host-a'),
    })
    const hostAPage = launchA.page
    activePages = [hostAPage]
    await hostAPage.setViewport({ width: 1360, height: 920 })
    await hostAPage.goto(urlHostA, { waitUntil: 'networkidle2', timeout: 30000 })
    await hostAPage.waitForSelector('.login-card #username', { visible: true, timeout: 20000 })
    await waitForTransition(hostAPage, { strict: true })
    manager.clearPageErrors(activePages)

    // =========================================================================
    // Scenario 1: Login, Event Create, AiCopilotDock + AiSettingsModal + RenameModal
    // =========================================================================
    console.log('[Interactive-E2E] Scenario 1: Login, Event, AiCopilotDock, AiSettingsModal & RenameModal...')
    await robustLogin(hostAPage, 'InteractiveHostA')
    const { eventCode, eventId } = await createEventViaUi(hostAPage, 'Interactive Comprehensive Classic')
    await waitForTransition(hostAPage, { strict: true })

    // Desktop AI Copilot Dock open -> splitter present -> collapse
    await hostAPage.waitForSelector('.copilot-topbar-btn', { visible: true, timeout: 10000 })
    await hostAPage.evaluate(() => {
      const btn = document.querySelector('.copilot-topbar-btn')
      if (!btn) throw new Error('Expected .copilot-topbar-btn')
      btn.click()
    })
    await waitForCondition(
      () =>
        hostAPage.evaluate(
          () =>
            Boolean(document.querySelector('.ai-copilot-dock')) &&
            Boolean(document.querySelector('.ai-copilot-dock .dock-splitter'))
        ),
      { timeoutMs: 10000, label: 'AiCopilotDock opened with .dock-splitter' }
    )
    await hostAPage.evaluate(() => {
      const btn = document.querySelector('.copilot-topbar-btn')
      if (!btn) throw new Error('Expected .copilot-topbar-btn')
      btn.click()
    })
    await waitForCondition(
      () => hostAPage.evaluate(() => !document.querySelector('.ai-copilot-dock')),
      { timeoutMs: 10000, label: 'AiCopilotDock collapsed' }
    )

    // AiSettingsModal open via topbar button -> native <dialog class="ai-settings-dialog"> open -> close
    await hostAPage.waitForSelector('.copilot-settings-btn', { visible: true, timeout: 10000 })
    await hostAPage.evaluate(() => {
      const btn = document.querySelector('.copilot-settings-btn')
      if (!btn) throw new Error('Expected .copilot-settings-btn')
      btn.click()
    })
    await waitForCondition(
      () =>
        hostAPage.evaluate(() => {
          const dlg = document.querySelector('dialog.ai-settings-dialog')
          return Boolean(dlg && dlg.open)
        }),
      { timeoutMs: 10000, label: 'dialog.ai-settings-dialog opened' }
    )
    await hostAPage.click('dialog.ai-settings-dialog .btn-dialog-close')
    await waitForCondition(
      () =>
        hostAPage.evaluate(() => {
          const dlg = document.querySelector('dialog.ai-settings-dialog')
          return Boolean(!dlg || !dlg.open)
        }),
      { timeoutMs: 10000, label: 'dialog.ai-settings-dialog closed cleanly' }
    )

    // RenameModal strict lifecycle (wait for modal unmount + topbar username update)
    await hostAPage.waitForSelector('.event-view .user-profile-btn', { visible: true, timeout: 10000 })
    await hostAPage.evaluate(() => {
      const btn = document.querySelector('.event-view .user-profile-btn')
      if (!btn) throw new Error('Expected .event-view .user-profile-btn')
      btn.click()
    })
    await hostAPage.waitForSelector('.rename-modal .username-input', { visible: true, timeout: 10000 })
    await waitForTransition(hostAPage, { strict: true })
    await setNumericInputValue(hostAPage, '.rename-modal .username-input', 'InteractiveRenamed')
    await hostAPage.evaluate(() => {
      const saveBtn = document.querySelector('.rename-modal .modal-actions .btn-primary')
      if (!saveBtn) throw new Error('Expected .rename-modal .modal-actions .btn-primary')
      saveBtn.click()
    })
    await waitForCondition(
      () =>
        hostAPage.evaluate(() => {
          const modalStillOpen = Boolean(document.querySelector('.rename-modal'))
          const badge = document.querySelector('.event-view .user-profile-btn .username-text')?.textContent?.trim()
          return !modalStillOpen && badge === 'InteractiveRenamed'
        }),
      { timeoutMs: 12000, label: 'RenameModal closed cleanly & username updated to InteractiveRenamed' }
    )
    await waitForTransition(hostAPage, { strict: true })
    await assertNoStuckTransition(hostAPage)

    // =========================================================================
    // Scenario 2: BIOBUZZ Scoring Math, 4-Ball Cycle Cap, Endgame Clamp, Alliance Toggle & Draft Reload
    // =========================================================================
    console.log('[Interactive-E2E] Scenario 2: BIOBUZZ scoring boundaries, alliance mode & Match 2 reload draft...')
    await switchToTab(hostAPage, 'scout')
    await hostAPage.waitForSelector('.scouting-form .phase-teleop', { visible: true, timeout: 10000 })

    // 4-ball cycle cap boundary
    for (let i = 0; i < 4; i++) {
      await hostAPage.click('.scouting-form .phase-teleop .pad-hit-btn')
    }
    const disabledAtFour = await hostAPage.evaluate(() => {
      const hitBtn = document.querySelector('.scouting-form .phase-teleop .pad-hit-btn')
      const missBtn = document.querySelector('.scouting-form .phase-teleop .pad-miss-btn')
      return {
        hitDisabled: Boolean(hitBtn?.disabled),
        missDisabled: Boolean(missBtn?.disabled),
      }
    })
    assert.equal(disabledAtFour.hitDisabled, true, '.pad-hit-btn must be disabled after 4 balls in active cycle')
    assert.equal(disabledAtFour.missDisabled, true, '.pad-miss-btn must be disabled after 4 balls in active cycle')

    // New cycle resets ball slot capacity -> record hit -> undo
    await hostAPage.click('.scouting-form .phase-teleop .btn-new-cycle')
    await waitForCondition(
      () =>
        hostAPage.evaluate(() => {
          const missBtn = document.querySelector('.scouting-form .phase-teleop .pad-miss-btn')
          return Boolean(missBtn && !missBtn.disabled)
        }),
      { timeoutMs: 5000, label: '.btn-new-cycle re-enables teleop pads' }
    )
    await hostAPage.click('.scouting-form .phase-teleop .pad-hit-btn')
    await hostAPage.click('.scouting-form .phase-teleop .btn-undo-cycle')
    // Clear back cleanly or check teleop undo leaves cycle enabled

    // Endgame bottom-bonus clamp: set Nectars = 2, try to increment Bottom Bonus 5 times -> clamped at 2!
    const clampCheck = await hostAPage.evaluate(async () => {
      const endgameSec = document.querySelector('.scouting-form .phase-endgame') ||
        Array.from(document.querySelectorAll('.scouting-form .form-section')).find((s) =>
          /endgame|终局/i.test(s.textContent || '')
        )
      if (!endgameSec) throw new Error('Endgame section not found in ScoutingForm')
      // Find numeric stepper groups inside endgame section in order:
      // 1: flowerNectars, 2: flowerBottomBonusCount, 3: flowerPollens, 4: gardenBalls
      const steppers = Array.from(endgameSec.querySelectorAll('.endgame-stepper-card .counter-controls')).filter(
        (c) => c.querySelectorAll('button').length >= 2
      )
      if (steppers.length < 2) {
        return { stepperCount: steppers.length, ok: false }
      }
      const nectarsBtns = steppers[0].querySelectorAll('button')
      const bottomBtns = steppers[1].querySelectorAll('button')
      const nectarsPlus = nectarsBtns[nectarsBtns.length - 1]
      const bottomPlus = bottomBtns[bottomBtns.length - 1]
      // Add 2 nectars
      nectarsPlus.click()
      nectarsPlus.click()
      await Promise.resolve()
      // Try adding bottom bonus 5 times (must clamp to min(4, nectars) = 2)
      for (let i = 0; i < 5; i++) {
        bottomPlus.click()
        await Promise.resolve()
      }
      const valNode = steppers[1].querySelector('.counter-val')
      const bottomVal = parseInt((valNode?.textContent || '').trim(), 10)
      return { stepperCount: steppers.length, bottomVal, plusDisabled: Boolean(bottomPlus.disabled), ok: true }
    })
    assert.equal(clampCheck.ok, true, `Endgame steppers missing in ScoutingForm: ${JSON.stringify(clampCheck)}`)
    assert.equal(clampCheck.bottomVal, 2, `Bottom bonus expected clamped at 2 (nectars=2), got ${clampCheck.bottomVal}`)
    assert.equal(clampCheck.plusDisabled, true, 'Bottom bonus + button should be disabled when clamped at nectars=2')

    // Alliance 2-team mode toggle -> assert 2 .team-column elements -> switch back to Single
    const allianceToggleStats = await hostAPage.evaluate(() => {
      const beforeCols = document.querySelectorAll('.scouting-form .team-column').length
      const segButtons = Array.from(document.querySelectorAll('.scouting-form .segmented-control button'))
      const allianceBtn = segButtons.find((b) => /alliance|双车|同盟/i.test(b.textContent || ''))
      const singleBtn = segButtons.find((b) => /single|单车/i.test(b.textContent || ''))
      if (!allianceBtn || !singleBtn) return { ok: false, beforeCols }
      allianceBtn.click()
      return { ok: true, beforeCols }
    })
    assert.equal(allianceToggleStats.ok, true, 'Alliance/Single segmented buttons not found')
    assert.equal(allianceToggleStats.beforeCols, 1, 'Expected 1 .team-column in single mode initially')
    await waitForCondition(
      () => hostAPage.evaluate(() => document.querySelectorAll('.scouting-form .team-column').length === 2),
      { timeoutMs: 5000, label: 'Alliance mode renders 2 .team-column panels' }
    )
    await hostAPage.evaluate(() => {
      const segButtons = Array.from(document.querySelectorAll('.scouting-form .segmented-control button'))
      const singleBtn = segButtons.find((b) => /single|单车/i.test(b.textContent || ''))
      singleBtn.click()
    })
    await waitForCondition(
      () => hostAPage.evaluate(() => document.querySelectorAll('.scouting-form .team-column').length === 1),
      { timeoutMs: 5000, label: 'Single mode returns to 1 .team-column panel' }
    )

    // Add tags for #27570 and #12345 AND submit Match 1 (#27570) so both teams exist cleanly in Pit / Rankings
    await submitMatchRecordViaUi(hostAPage, { matchNumber: 1, teamNumber: 27570, alliance: 'Blue' })

    // Match 2 draft persistence across page.reload() -> submit -> sp27_active_draft_* cleanup
    await setNumericInputValue(hostAPage, '.scouting-form input[placeholder="1-999"]', '2')
    await setNumericInputValue(hostAPage, '.scouting-form input[placeholder="e.g. 12345"]', '12345')
    // Select Red alliance via .spdt-labels span
    await hostAPage.evaluate(() => {
      const redSpan = Array.from(document.querySelectorAll('.scouting-form .spdt-labels span')).find((el) =>
        /red|红/i.test(el.textContent || '')
      )
      if (!redSpan) throw new Error('Red alliance option not found in .spdt-labels')
      redSpan.click()
    })
    await hostAPage.click('.scouting-form .phase-teleop .pad-hit-btn')

    // Also add quick tag on #12345 and #27570? Wait: Scenario 3 needs >=2 teams in PitRoster, OR let's tag #12345 right here via TagPicker
    await hostAPage.waitForSelector('.scouting-form .team-tags-section .btn-add-tag', { visible: true, timeout: 5000 })
    await hostAPage.click('.scouting-form .team-tags-section .btn-add-tag')
    await hostAPage.waitForSelector('.scouting-form .team-tags-section .tag-input', { visible: true, timeout: 5000 })
    await hostAPage.type('.scouting-form .team-tags-section .tag-input', 'DraftPeerTag')
    await hostAPage.click('.scouting-form .team-tags-section .btn-confirm-add')
    await waitForCondition(
      () =>
        hostAPage.evaluate(
          () =>
            (document.querySelector('.scouting-form .team-tags-section')?.textContent || '').includes('draftpeertag') &&
            Object.keys(localStorage).some(
              (k) => k.startsWith('sp27_active_draft_') && (localStorage.getItem(k) || '').includes('"matchNumber":"2"')
            )
        ),
      { timeoutMs: 8000, label: 'sp27_active_draft_* and draftpeertag saved before reload' }
    )

    await hostAPage.reload({ waitUntil: 'networkidle2', timeout: 30000 })
    await waitForTransition(hostAPage, { strict: true })
    await hostAPage.waitForSelector('.scouting-form .draft-restored-banner', { visible: true, timeout: 15000 })
    const restoredDraft = await hostAPage.evaluate(() => ({
      matchVal: document.querySelector('.scouting-form input[placeholder="1-999"]')?.value,
      teamVal: document.querySelector('.scouting-form input[placeholder="e.g. 12345"]')?.value,
    }))
    assert.equal(restoredDraft.matchVal, '2', `Restored draft match expected 2, got ${restoredDraft.matchVal}`)
    assert.equal(restoredDraft.teamVal, '12345', `Restored draft team expected 12345, got ${restoredDraft.teamVal}`)

    // Submit Match 2 -> verify sp27_active_draft_* cleared
    await hostAPage.click('.scouting-form .btn-submit')
    await waitForCondition(
      () =>
        hostAPage.evaluate(
          () => !document.querySelector('.scouting-form .draft-restored-banner') &&
            !Object.keys(localStorage).some((k) => k.startsWith('sp27_active_draft_') && localStorage.getItem(k)?.includes('"matchNumber":"2"'))
        ),
      { timeoutMs: 12000, label: 'Match 2 submitted and active draft cleared' }
    )

    // Give #27570 a tag in Rankings -> TeamDetailView so Pit Roster has BOTH #12345 and #27570 (>= 2 cards for search narrowing)
    await switchToTab(hostAPage, 'rankings')
    await hostAPage.waitForSelector('tr[data-team-row="27570"] .team-cell', { visible: true, timeout: 10000 })
    await hostAPage.click('tr[data-team-row="27570"] .team-cell')
    await waitForCondition(
      () => hostAPage.evaluate(() => Boolean(document.querySelector('.team-detail-view .btn-add-tag'))),
      { timeoutMs: 12000, label: 'TeamDetailView mounted with .btn-add-tag' }
    )
    await waitForTransition(hostAPage, { strict: true })
    await hostAPage.click('.team-detail-view .btn-add-tag')
    await hostAPage.waitForSelector('.team-detail-view .tag-input', { visible: true, timeout: 10000 })
    await hostAPage.type('.team-detail-view .tag-input', 'pitrosterseed27570')
    await hostAPage.click('.team-detail-view .btn-confirm-add')
    await waitForCondition(
      () => hostAPage.evaluate(() => (document.querySelector('.team-detail-view')?.textContent || '').includes('pitrosterseed27570')),
      { timeoutMs: 10000, label: 'pitrosterseed27570 tag visible in TeamDetailView' }
    )
    await hostAPage.click('.team-detail-view .btn-close')
    await waitForCondition(() => hostAPage.evaluate(() => !document.querySelector('.team-detail-view')), {
      timeoutMs: 10000,
      label: 'TeamDetailView closed after seeding #27570 tag',
    })
    await waitForTransition(hostAPage, { strict: true })

    // =========================================================================
    // Scenario 3: Pit Scouting (Swerve + Real PNG Upload + Dirty Close Cancel + Reload + Strict Search)
    // =========================================================================
    console.log('[Interactive-E2E] Scenario 3: Pit Scouting, PNG photo upload, dirty confirm & strict search...')
    await switchToTab(hostAPage, 'pit')
    await hostAPage.waitForSelector('.pit-scout-view .team-roster-card', { visible: true, timeout: 15000 })
    const initialPitCards = await hostAPage.evaluate(
      () => document.querySelectorAll('.pit-scout-view .team-roster-card').length
    )
    assert.ok(initialPitCards >= 2, `Expected >= 2 pit roster cards (#12345 & #27570), got ${initialPitCards}`)

    // Click #27570 card to open PitScoutFormDrawer
    await hostAPage.evaluate(() => {
      const card = Array.from(document.querySelectorAll('.pit-scout-view .team-roster-card')).find((c) =>
        (c.textContent || '').includes('27570')
      )
      if (!card) throw new Error('Pit roster card for #27570 not found')
      card.click()
    })
    await hostAPage.waitForSelector('.drawer-panel', { visible: true, timeout: 10000 })

    // Select Swerve drivetrain
    await hostAPage.evaluate(() => {
      const swerveBtn = Array.from(document.querySelectorAll('.drawer-panel .radio-btn')).find((b) =>
        /swerve|舵轮/i.test(b.textContent || '')
      )
      if (!swerveBtn) throw new Error('Swerve radio button not found in Pit drawer')
      swerveBtn.click()
    })

    // Upload real PNG photo into .drawer-panel input[type="file"]
    const pitPngPath = path.join(manager.createTempDir('pit-img'), 'robot-pit-photo.png')
    createTinyPngFile(pitPngPath, 24, 24)
    const fileInput = await hostAPage.$('.drawer-panel input[type="file"]')
    assert.ok(fileInput, 'Pit photo file input not found in .drawer-panel')
    await fileInput.uploadFile(pitPngPath)
    await hostAPage.waitForSelector('.drawer-panel .photo-item img', { visible: true, timeout: 10000 })

    // Dirty close confirmation: click .close-btn -> .confirm-modal-overlay -> cancel stays inside drawer!
    await hostAPage.click('.drawer-panel .close-btn')
    await hostAPage.waitForSelector('.confirm-modal-overlay', { visible: true, timeout: 10000 })
    await hostAPage.click('.confirm-modal-overlay .confirm-btn.btn-secondary')
    await waitForCondition(
      () =>
        hostAPage.evaluate(
          () => !document.querySelector('.confirm-modal-overlay') && Boolean(document.querySelector('.drawer-panel'))
        ),
      { timeoutMs: 8000, label: 'Canceling dirty-close confirmation kept Pit drawer open' }
    )

    // Save Pit record -> drawer closes
    await hostAPage.click('.drawer-panel .drawer-footer .btn-primary')
    await waitForCondition(
      () => hostAPage.evaluate(() => !document.querySelector('.drawer-panel')),
      { timeoutMs: 12000, label: 'Pit drawer closed after saving #27570' }
    )

    const hostSession = await getAuthSession(hostAPage)
    assert.ok(hostSession && hostSession.id, 'Expected host auth session with id')
    await waitForCondition(
      async () => {
        await hostAPage.evaluate(() => window.__sp27E2eBridge?.flushCrdtNow?.())
        const res = await fetchBackendJson(PORT_HOST_A, `/api/events/${eventId}/pit-records`, hostSession.token).catch(() => null)
        const recs = Array.isArray(res) ? res : res?.records || []
        return recs.some((r) => Number(r.teamNumber) === 27570 && r.drivetrainType === 'swerve')
      },
      { timeoutMs: 10000, label: 'Pit record #27570 persisted to backend before reload' }
    )
    await hostAPage.reload({ waitUntil: 'networkidle2', timeout: 30000 })
    await waitForTransition(hostAPage, { strict: true })
    await switchToTab(hostAPage, 'pit')
    await hostAPage.waitForSelector('.pit-scout-view .team-roster-card', { visible: true, timeout: 15000 })
    await hostAPage.waitForSelector('.pit-scout-view .pit-toolbar input', { visible: true, timeout: 10000 })
    await setNumericInputValue(hostAPage, '.pit-scout-view .pit-toolbar input', '27570')
    await waitForCondition(
      () => hostAPage.evaluate(() => document.querySelectorAll('.pit-scout-view .team-roster-card').length === 1),
      { timeoutMs: 8000, label: 'Pit search "27570" strictly narrows to 1 card' }
    )
    const filteredText = await hostAPage.evaluate(
      () => document.querySelector('.pit-scout-view .team-roster-card')?.textContent || ''
    )
    assert.ok(filteredText.includes('27570') && !filteredText.includes('12345'), `Unexpected filtered pit card: ${filteredText}`)

    // Clear search
    await setNumericInputValue(hostAPage, '.pit-scout-view .pit-toolbar input', '')

    // =========================================================================
    // Scenario 4: Schedule CSV Import & Assigned Task Handoff
    // =========================================================================
    console.log('[Interactive-E2E] Scenario 4: Schedule CSV import & task handoff...')
    await switchToTab(hostAPage, 'schedule')
    const importBtnSel = '.schedule-manager .btn-empty-import, .schedule-manager .btn-tool.primary'
    await hostAPage.waitForSelector(importBtnSel, { visible: true, timeout: 10000 })
    await hostAPage.click(importBtnSel)
    await hostAPage.waitForSelector('.schedule-import-modal', { visible: true, timeout: 10000 })

    // Switch to CSV tab (2nd button in .import-tabs)
    await hostAPage.evaluate(() => {
      const tabs = document.querySelectorAll('.schedule-import-modal .import-tabs .tab-btn')
      if (tabs.length < 2) throw new Error('Expected CSV tab in ScheduleImportModal')
      tabs[1].click()
    })
    await hostAPage.waitForSelector('.schedule-import-modal .csv-textarea', { visible: true, timeout: 10000 })
    await setNumericInputValue(
      hostAPage,
      '.schedule-import-modal .csv-textarea',
      '1,27570,12345,54321,99999\n2,27570,54321,12345,99999\n5,12345,99999,27570,54321'
    )
    await hostAPage.waitForSelector('.schedule-import-modal .preview-table tbody tr', { visible: true, timeout: 8000 })
    await hostAPage.click('.schedule-import-modal .csv-action-box .btn-primary-action')
    await waitForCondition(
      () =>
        hostAPage.evaluate(
          () => !document.querySelector('.schedule-import-modal') && document.querySelectorAll('.schedule-table tr.match-row').length >= 3
        ),
      { timeoutMs: 12000, label: 'Schedule CSV imported (>= 3 match rows)' }
    )

    // Assign Match 5 Red1 (#12345) to current logged-in Host user so nextPendingAssignment shows in ScoutingForm
    const assignedOk = await hostAPage.evaluate((myUid) => {
      const m5Row = document.querySelector('.schedule-table tr[data-match-num="5"]')
      if (!m5Row) return false
      const sel = m5Row.querySelector('.td-alliance.red-zone select.scout-select')
      if (!sel) return false
      sel.value = myUid
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return sel.value === myUid
    }, hostSession.id)
    assert.equal(assignedOk, true, 'Failed to assign Match 5 Red1 to self in ScheduleManager')

    await switchToTab(hostAPage, 'scout')
    await hostAPage.waitForSelector('.scouting-form .assigned-task-banner:not(.draft-restored-banner)', {
      visible: true,
      timeout: 10000,
    })
    await hostAPage.click('.scouting-form .assigned-task-banner .btn-load-task')
    const loadedTaskValues = await hostAPage.evaluate(() => ({
      matchVal: document.querySelector('.scouting-form input[placeholder="1-999"]')?.value,
      teamVal: document.querySelector('.scouting-form input[placeholder="e.g. 12345"]')?.value,
      redSelected: Boolean(document.querySelector('.scouting-form .spdt-switch.pos-red')),
    }))
    assert.equal(loadedTaskValues.matchVal, '5', `Loaded task match expected 5, got ${loadedTaskValues.matchVal}`)
    assert.equal(loadedTaskValues.teamVal, '12345', `Loaded task team expected 12345, got ${loadedTaskValues.teamVal}`)
    assert.equal(loadedTaskValues.redSelected, true, 'Loaded task should activate Red alliance on .scouting-form .spdt-switch.pos-red')

    // =========================================================================
    // Scenario 5: Custom Fields ("Defense Rating") -> Form Teleop Render -> Match 3 Persist
    // =========================================================================
    console.log('[Interactive-E2E] Scenario 5: Custom Fields ("Defense Rating") in teleop & Match 3 backend persistence...')
    await switchToTab(hostAPage, 'scouts')
    await hostAPage.waitForSelector('.event-scouts-panel', { visible: true, timeout: 10000 })
    const openedCf = await hostAPage.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('.event-scouts-panel button')).find((b) =>
        (b.querySelector('.material-icons')?.textContent || '').trim() === 'tune' ||
        /custom fields|自定义字段/i.test(b.textContent || '')
      )
      if (!btn) return false
      btn.click()
      return true
    })
    assert.equal(openedCf, true, 'Custom fields button not found in EventScoutsPanel')
    await hostAPage.waitForSelector('.cf-modal-card .btn-create-field', { visible: true, timeout: 10000 })
    await hostAPage.click('.cf-modal-card .btn-create-field')
    await hostAPage.waitForSelector('.field-builder-form input[type="text"]', { visible: true, timeout: 10000 })
    await setNumericInputValue(hostAPage, '.field-builder-form input[type="text"]', 'Defense Rating')
    await hostAPage.click('.field-builder-form .btn-save')
    await waitForCondition(
      () =>
        hostAPage.evaluate(
          () => !document.querySelector('.field-builder-form') && (document.querySelector('.cf-modal-card')?.textContent || '').includes('Defense Rating')
        ),
      { timeoutMs: 10000, label: 'Defense Rating custom field created' }
    )
    await hostAPage.click('.cf-modal-card .btn-close')
    await waitForCondition(() => hostAPage.evaluate(() => !document.querySelector('.cf-modal-card')), {
      timeoutMs: 10000,
      label: 'CustomFieldsManagerModal closed cleanly',
    })

    // Go back to scout form, verify 'Defense Rating' renders inside .phase-teleop, enter 8, submit Match 3 (#12345)
    await switchToTab(hostAPage, 'scout')
    await waitForCondition(
      () => hostAPage.evaluate(() => (document.querySelector('.scouting-form .phase-teleop')?.textContent || '').includes('Defense Rating')),
      { timeoutMs: 10000, label: 'Defense Rating renders inside .scouting-form .phase-teleop' }
    )
    await hostAPage.evaluate(() => {
      const teleop = document.querySelector('.scouting-form .phase-teleop')
      const customInp = teleop?.querySelector('input[type="number"], input.num-input')
      if (!customInp) throw new Error('Numeric input for Defense Rating not found inside .phase-teleop')
      customInp.value = '8'
      customInp.dispatchEvent(new Event('input', { bubbles: true }))
      customInp.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await submitMatchRecordViaUi(hostAPage, { matchNumber: 3, teamNumber: 12345, alliance: 'Blue' })
    await hostAPage.evaluate(() => window.__sp27E2eBridge?.flushCrdtNow?.())

    const backendRecsAfterMatch3 = await fetchBackendJson(PORT_HOST_A, `/api/records?eventId=${eventId}`, hostSession.token)
    const match3Rec = backendRecsAfterMatch3.find((r) => Number(r.matchNumber) === 3 && Number(r.teamNumber) === 12345 && !r.isDeleted)
    assert.ok(match3Rec, 'Match 3 record for #12345 not found in backend H2 DB')
    const match3Raw = JSON.parse(match3Rec.rawData || '{}')
    const customVals = Object.values(match3Raw.customFields || {})
    assert.ok(customVals.some((v) => Number(v) === 8), `Expected Defense Rating = 8 in Match 3 rawData.customFields, got ${JSON.stringify(match3Raw.customFields)}`)

    // =========================================================================
    // Scenario 6: Rankings Sort Order Flip & TagPicker Lifecycle
    // =========================================================================
    console.log('[Interactive-E2E] Scenario 6: Rankings sort flip & TagPicker lifecycle...')
    await switchToTab(hostAPage, 'rankings')
    await waitForCondition(
      () => hostAPage.evaluate(() => document.querySelectorAll('.rankings-panel tr.ranking-row').length >= 2),
      { timeoutMs: 10000, label: 'At least 2 team rows in RankingsTable' }
    )
    const getRowOrder = () =>
      hostAPage.evaluate(() =>
        Array.from(document.querySelectorAll('.rankings-panel tr.ranking-row')).map((r) => r.getAttribute('data-team-row'))
      )
    await hostAPage.click('.rankings-panel th.team-col-th')
    const orderFirstClick = await getRowOrder()
    await hostAPage.click('.rankings-panel th.team-col-th')
    const orderSecondClick = await getRowOrder()
    assert.notDeepEqual(orderFirstClick, orderSecondClick, `Expected sorting team column twice to flip order, got ${JSON.stringify(orderFirstClick)} vs ${JSON.stringify(orderSecondClick)}`)

    // Open TeamDetailView -> add purple tag -> reload -> verify -> delete -> reload -> stays gone
    await hostAPage.click('tr[data-team-row="12345"] .team-cell')
    await waitForCondition(
      () => hostAPage.evaluate(() => Boolean(document.querySelector('.team-detail-view .btn-add-tag'))),
      { timeoutMs: 12000, label: 'TeamDetailView mounted for #12345' }
    )
    await waitForTransition(hostAPage, { strict: true })
    await hostAPage.click('.team-detail-view .btn-add-tag')
    await hostAPage.waitForSelector('.team-detail-view .tag-input', { visible: true, timeout: 10000 })
    await hostAPage.type('.team-detail-view .tag-input', 'sortpurpletag')
    await hostAPage.click('.team-detail-view .color-dot.bg-purple')
    await hostAPage.click('.team-detail-view .btn-confirm-add')
    await waitForCondition(
      () => hostAPage.evaluate(() => (document.querySelector('.team-detail-view .tag-badge.tag-purple')?.textContent || '').includes('sortpurpletag')),
      { timeoutMs: 10000, label: 'Purple tag sortpurpletag created' }
    )
    await waitForCondition(
      async () => {
        await hostAPage.evaluate(() => window.__sp27E2eBridge?.flushCrdtNow?.())
        const tags = await fetchBackendJson(PORT_HOST_A, `/api/events/${eventId}/tags`, hostSession.token).catch(() => [])
        return Array.isArray(tags) && tags.some((t) => Number(t.teamNumber) === 12345 && t.tag === 'sortpurpletag')
      },
      { timeoutMs: 10000, label: 'sortpurpletag persisted to backend before reload' }
    )
    await hostAPage.reload({ waitUntil: 'networkidle2', timeout: 30000 })
    await waitForTransition(hostAPage, { strict: true })
    await hostAPage.waitForSelector('.team-detail-view .tag-badge.tag-purple', { visible: true, timeout: 12000 })
    await hostAPage.click('.team-detail-view .tag-badge.tag-purple .btn-tag-remove')
    await waitForCondition(
      () => hostAPage.evaluate(() => document.querySelectorAll('.team-detail-view .tag-badge.tag-purple').length === 0),
      { timeoutMs: 10000, label: 'sortpurpletag deleted' }
    )
    await waitForCondition(
      async () => {
        await hostAPage.evaluate(() => window.__sp27E2eBridge?.flushCrdtNow?.())
        const tags = await fetchBackendJson(PORT_HOST_A, `/api/events/${eventId}/tags`, hostSession.token).catch(() => [])
        return Array.isArray(tags) && !tags.some((t) => Number(t.teamNumber) === 12345 && t.tag === 'sortpurpletag')
      },
      { timeoutMs: 10000, label: 'sortpurpletag deletion persisted to backend before reload' }
    )
    await hostAPage.reload({ waitUntil: 'networkidle2', timeout: 30000 })
    await waitForTransition(hostAPage, { strict: true })
    await hostAPage.waitForSelector('.team-detail-view .match-card', { visible: true, timeout: 12000 })
    const purpleTagsAfterDelReload = await hostAPage.evaluate(
      () => document.querySelectorAll('.team-detail-view .tag-badge.tag-purple').length
    )
    assert.equal(purpleTagsAfterDelReload, 0, 'Deleted purple tag reappeared after reload')
    await hostAPage.click('.team-detail-view .btn-close')
    await waitForCondition(() => hostAPage.evaluate(() => !document.querySelector('.team-detail-view')), {
      timeoutMs: 10000,
      label: 'TeamDetailView closed after TagPicker scenario',
    })

    // =========================================================================
    // Scenario 7: History Edit Persistence (' [E2E Verified]')
    // =========================================================================
    console.log('[Interactive-E2E] Scenario 7: History edit persistence...')
    await switchToTab(hostAPage, 'history')
    await hostAPage.waitForSelector('.history-card .btn-edit', { visible: true, timeout: 10000 })
    const editedCardMeta = await hostAPage.evaluate(() => {
      const card = document.querySelector('.history-card')
      const title = card?.querySelector('.card-teams')?.textContent || ''
      const mMatch = title.match(/#[QP](\d+)/)
      const tMatch = title.match(/#(\d+)\s*$/)
      return {
        matchNumber: mMatch ? Number(mMatch[1]) : 3,
        teamNumber: tMatch ? Number(tMatch[1]) : 12345,
      }
    })
    await hostAPage.click('.history-card .btn-edit')
    await waitForTransition(hostAPage, { strict: true })
    await hostAPage.waitForSelector('.scouting-form textarea', { visible: true, timeout: 10000 })
    const editedNotes = await hostAPage.evaluate(() => {
      const ta = document.querySelector('.scouting-form textarea')
      if (!ta) throw new Error('Notes textarea missing when editing record')
      const next = (ta.value || '') + ' [E2E Verified]'
      ta.value = next
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      ta.dispatchEvent(new Event('change', { bubbles: true }))
      return next
    })
    await hostAPage.click('.scouting-form .btn-submit')
    await hostAPage.waitForSelector('.submit-status-msg', { timeout: 10000 })
    await switchToTab(hostAPage, 'history')
    await waitForCondition(
      async () => {
        await hostAPage.evaluate(() => window.__sp27E2eBridge?.flushCrdtNow?.())
        const recs = await fetchBackendJson(PORT_HOST_A, `/api/records?eventId=${eventId}`, hostSession.token).catch(() => [])
        return Array.isArray(recs) && recs.some((r) => !r.isDeleted && String(r.notes || '').includes(' [E2E Verified]'))
      },
      { timeoutMs: 10000, label: 'History edit [E2E Verified] flushed to backend before reload' }
    )
    await hostAPage.reload({ waitUntil: 'networkidle2', timeout: 30000 })
    await waitForTransition(hostAPage, { strict: true })
    // Verify in TeamDetailView visible DOM (.comments-section .comments-text) AND in backend H2 DB
    await switchToTab(hostAPage, 'rankings')
    await hostAPage.waitForSelector(`tr[data-team-row="${editedCardMeta.teamNumber}"] .team-cell`, { visible: true, timeout: 10000 })
    await hostAPage.click(`tr[data-team-row="${editedCardMeta.teamNumber}"] .team-cell`)
    await waitForCondition(
      () => hostAPage.evaluate((txt) => (document.querySelector('.team-detail-view')?.textContent || '').includes(txt), ' [E2E Verified]'),
      { timeoutMs: 12000, label: 'History edit [E2E Verified] persisted across reload in TeamDetailView DOM' }
    )
    await waitForTransition(hostAPage, { strict: true })
    await hostAPage.evaluate(() => {
      const btn = document.querySelector('.team-detail-view .btn-close')
      if (!btn) throw new Error('Expected .team-detail-view .btn-close')
      btn.click()
    })
    await waitForCondition(() => hostAPage.evaluate(() => !document.querySelector('.team-detail-view')), {
      timeoutMs: 10000,
      label: 'TeamDetailView closed after History edit verification',
    })
    await waitForTransition(hostAPage, { strict: true })
    await hostAPage.evaluate(() => window.__sp27E2eBridge?.flushCrdtNow?.())
    const recsAfterHistEdit = await fetchBackendJson(PORT_HOST_A, `/api/records?eventId=${eventId}`, hostSession.token)
    assert.ok(
      recsAfterHistEdit.some((r) => !r.isDeleted && String(r.notes || '').includes(' [E2E Verified]')),
      `Expected backend H2 record notes containing "${editedNotes}"`
    )

    // =========================================================================
    // Scenario 8 (Absorbed from motion-and-sheet): Backdrop Hit-Test, Drag Handle, Escape & Reduced Motion
    // =========================================================================
    console.log('[Interactive-E2E] Scenario 8: Backdrop hit-test, sheet dismissals & prefers-reduced-motion...')
    const openDetail12345 = async () => {
      await switchToTab(hostAPage, 'rankings')
      await hostAPage.waitForSelector('tr[data-team-row="12345"] .team-cell', { visible: true, timeout: 10000 })
      await hostAPage.click('tr[data-team-row="12345"] .team-cell')
      await waitForCondition(
        () => hostAPage.evaluate(() => Boolean(document.querySelector('.team-detail-view .btn-close'))),
        { timeoutMs: 12000, label: 'TeamDetailView mounted for #12345' }
      )
      await waitForTransition(hostAPage, { strict: true })
    }

    await openDetail12345()
    const backdropHitPoint = await hostAPage.evaluate(() => {
      const bd = document.querySelector('.team-detail-backdrop')
      const vw = document.querySelector('.team-detail-view')
      if (!bd || !vw) return null
      const bRect = bd.getBoundingClientRect()
      const vRect = vw.getBoundingClientRect()
      const hitX = Math.floor(bRect.left + Math.max(8, (vRect.left - bRect.left) / 2))
      const hitY = Math.floor(bRect.top + bRect.height / 2)
      const elAtPoint = document.elementFromPoint(hitX, hitY)
      return {
        hitX,
        hitY,
        outsideView: hitX < vRect.left,
        hitsBackdrop: elAtPoint === bd,
      }
    })
    assert.ok(
      backdropHitPoint && backdropHitPoint.outsideView && backdropHitPoint.hitsBackdrop,
      `Expected exposed backdrop point outside .team-detail-view, got ${JSON.stringify(backdropHitPoint)}`
    )
    await hostAPage.mouse.click(backdropHitPoint.hitX, backdropHitPoint.hitY)
    await waitForCondition(
      () => hostAPage.evaluate((id) => window.location.hash.includes(`/event/${id}`) && !document.querySelector('.team-detail-view'), eventId),
      { timeoutMs: 12000, label: 'Backdrop mouse.click closed TeamDetailView' }
    )
    await waitForTransition(hostAPage, { strict: true })

    await openDetail12345()
    await hostAPage.click('.team-detail-view .sheet-drag-handle')
    await waitForCondition(
      () => hostAPage.evaluate(() => !document.querySelector('.team-detail-view')),
      { timeoutMs: 12000, label: '.sheet-drag-handle closed TeamDetailView' }
    )
    await waitForTransition(hostAPage, { strict: true })

    await openDetail12345()
    await hostAPage.keyboard.press('Escape')
    await waitForCondition(
      () => hostAPage.evaluate(() => !document.querySelector('.team-detail-view')),
      { timeoutMs: 12000, label: 'Escape key closed TeamDetailView' }
    )
    await waitForTransition(hostAPage, { strict: true })

    const baselineTabTransitionMs = await hostAPage.evaluate(() => {
      const btn = document.querySelector('.tab-bar .tab-btn')
      if (!btn) return NaN
      const dur = getComputedStyle(btn).transitionDuration.split(',')[0].trim()
      return dur.endsWith('ms') ? parseFloat(dur) : parseFloat(dur) * 1000
    })
    assert.ok(baselineTabTransitionMs >= 100, `Expected baseline .tab-btn transition >= 100ms, got ${baselineTabTransitionMs}`)

    try {
      await hostAPage.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
      const reducedCheck = await hostAPage.evaluate(() => {
        const btn = document.querySelector('.tab-bar .tab-btn')
        const dur = btn ? getComputedStyle(btn).transitionDuration.split(',')[0].trim() : ''
        const ms = dur.endsWith('ms') ? parseFloat(dur) : parseFloat(dur) * 1000
        return { matches: window.matchMedia('(prefers-reduced-motion: reduce)').matches, ms }
      })
      assert.equal(reducedCheck.matches, true, 'prefers-reduced-motion media query did not match')
      assert.ok(reducedCheck.ms <= 1, `Expected reduced transitionDuration <= 1ms, got ${reducedCheck.ms}ms`)

      await openDetail12345()
      await hostAPage.keyboard.press('Escape')
      await waitForCondition(
        () => hostAPage.evaluate(() => !document.querySelector('.team-detail-view')),
        { timeoutMs: 10000, label: 'TeamDetailView closed cleanly under reduced-motion' }
      )
      await assertNoStuckTransition(hostAPage)
    } finally {
      await hostAPage.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }])
    }

    await manager.assertNoUnexpectedErrors([hostAPage], {
      allowConsolePatterns: [/WakeLock/i],
    })
    console.log('[Interactive-E2E] ALL scenarios PASSED cleanly!')
  } catch (err) {
    exitCode = 1
    console.error('[Interactive-E2E] FAILED:', err)
  } finally {
    await manager.cleanupAll({ assertDeleted: true })
    for (const dbPath of rootDbPaths) {
      if (!preExistingRootDbs.has(dbPath) && fs.existsSync(dbPath)) {
        exitCode = 1
        console.error(`[Interactive-E2E] ERROR: Repo-root H2 DB polluted at ${dbPath}`)
      }
    }
    process.exit(exitCode)
  }
}

run()
