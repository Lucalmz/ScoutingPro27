import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { E2EClusterManager, REPO_ROOT, allocateFreePort } from './helpers/e2eBackendManager.js';
import {
  confirmAnySasModals,
  createEventViaUi,
  enterExistingEventCardViaUi,
  joinEventViaUi,
  logoutViaUi,
  robustLogin,
  sendDirectMessageViaUi,
  submitMatchRecordViaUi,
  switchToTab,
  waitForCondition,
  waitForConnectedWithSas,
  waitForTransition
} from './helpers/e2eUiActions.js';

const SHOW_UI = process.env.SHOW_UI === '1';

function snapshotFileStat(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false };
  const s = fs.statSync(filePath);
  return { exists: true, size: s.size, mtimeMs: s.mtimeMs };
}

async function runE2E() {
  const rootDbPaths = [
    path.join(REPO_ROOT, 'app_data.mv.db'),
    path.join(REPO_ROOT, 'Backend', 'app_data.mv.db')
  ];
  const rootDbBaselines = rootDbPaths.map((p) => ({ path: p, stat: snapshotFileStat(p) }));

  const runId = Date.now();
  const manager = new E2EClusterManager(runId);
  const errors = [];

  const signalHandler = async (sig) => {
    console.warn(`\n[Inbox E2E] Caught ${sig}; running cleanup...`);
    await manager.cleanupAll({ assertDeleted: false }).catch(() => {});
    process.exit(1);
  };
  process.on('SIGINT', signalHandler);
  process.on('SIGTERM', signalHandler);

  const dirHost = manager.createTempDir('inbox-host');
  const chromeHostDir = manager.createTempDir('inbox-chrome-host');
  const chromeScoutDir = manager.createTempDir('inbox-chrome-scout');

  try {
    const PORT_HOST = await allocateFreePort();
    const URL_HOST = `http://localhost:${PORT_HOST}/index.html`;
    const mqttBrokerUrl = await manager.startLocalMqttBroker();
    const clientBaseUrl = await manager.startStaticClientServer(0, '127.0.0.2');
    const urlStaticClient = `${clientBaseUrl}/index.html`;
    await manager.startBackend({ name: 'host', port: PORT_HOST, tmpDir: dirHost });

    const [hostLaunch, scoutLaunch] = await Promise.all([
      manager.launchBrowser({ name: 'host', index: 0, userDataDir: chromeHostDir, showUi: SHOW_UI }),
      manager.launchBrowser({
        name: 'scout',
        index: 1,
        userDataDir: chromeScoutDir,
        showUi: SHOW_UI,
        extraSecureOrigin: clientBaseUrl
      })
    ]);

    const hostPage = hostLaunch.page;
    const scoutPage = scoutLaunch.page;
    await hostPage.setViewport({ width: 1200, height: 900 });
    await scoutPage.setViewport({ width: 1200, height: 900 });

    const hostUser = `InboxHost_${runId}`;
    const hostUserB = `InboxIsolation_${runId}`;
    const scoutUser = `InboxScout_${runId}`;

    // =========================================================================
    // Step 1: Login page keeps InboxWidget mounted in DOM with display: none
    // =========================================================================
    console.log('\n--- Step 1: Login page InboxWidget DOM visibility ---');
    await hostPage.goto(URL_HOST, { waitUntil: 'domcontentloaded' });
    await hostPage.waitForSelector('#username', { visible: true, timeout: 15000 });

    const loginInboxVisibility = await hostPage.evaluate(() => {
      const el = document.querySelector('.inbox-widget');
      if (!el) return { exists: false, display: null };
      return {
        exists: true,
        display: window.getComputedStyle(el).display
      };
    });
    assert.strictEqual(loginInboxVisibility.exists, true, 'InboxWidget must exist in DOM on LoginView');
    assert.strictEqual(loginInboxVisibility.display, 'none', `InboxWidget must be display:none on LoginView, got ${loginInboxVisibility.display}`);

    // =========================================================================
    // Step 2: Login to Dashboard -> InboxWidget visible & Teleported to BODY
    // =========================================================================
    console.log('\n--- Step 2: Login to Dashboard & Stamp Inbox DOM Node ---');
    await robustLogin(hostPage, hostUser);

    const dashboardInboxStatus = await hostPage.evaluate(() => {
      const el = document.querySelector('.inbox-widget');
      if (!el) return { exists: false };
      const trackerId = `inbox-node-${Date.now()}-${Math.random()}`;
      el.__trackerId = trackerId;
      window.__initialInboxNode = el;
      window.__inboxTrackerId = trackerId;
      return {
        exists: true,
        display: window.getComputedStyle(el).display,
        isOpen: el.classList.contains('is-open'),
        parentElement: el.parentElement ? el.parentElement.tagName : null,
        hasTrackerId: Boolean(trackerId)
      };
    });
    assert.strictEqual(dashboardInboxStatus.exists, true, 'InboxWidget not found on Dashboard');
    assert.notStrictEqual(dashboardInboxStatus.display, 'none', 'InboxWidget must be visible on Dashboard');
    assert.strictEqual(dashboardInboxStatus.parentElement, 'BODY', `Expected InboxWidget parent=BODY, got ${dashboardInboxStatus.parentElement}`);
    assert.strictEqual(dashboardInboxStatus.isOpen, false, 'InboxWidget should start closed');

    // =========================================================================
    // Step 3: Open Inbox Widget on Dashboard -> Verify morph geometry & content
    // =========================================================================
    console.log('\n--- Step 3: Open InboxWidget on Dashboard & Verify Morph Geometry ---');
    await hostPage.click('.inbox-morph-container');
    await waitForCondition(
      () =>
        hostPage.evaluate(() => {
          const el = document.querySelector('.inbox-widget');
          const container = el ? el.querySelector('.inbox-morph-container') : null;
          const dropdown = el ? el.querySelector('.inbox-dropdown-content') : null;
          if (!el?.classList.contains('is-open') || !container || !dropdown) return false;
          const rect = container.getBoundingClientRect();
          const style = window.getComputedStyle(container);
          const dStyle = window.getComputedStyle(dropdown);
          return (
            style.borderRadius.includes('16px') &&
            rect.width >= 300 &&
            rect.height >= 350 &&
            dStyle.display !== 'none' &&
            dropdown.offsetHeight > 0
          );
        }),
      { timeoutMs: 5000, intervalMs: 50, label: 'InboxWidget morph open geometry' }
    );

    const openStatus = await hostPage.evaluate(() => {
      const el = document.querySelector('.inbox-widget');
      const container = el ? el.querySelector('.inbox-morph-container') : null;
      const dropdown = el ? el.querySelector('.inbox-dropdown-content') : null;
      const rect = container ? container.getBoundingClientRect() : null;
      const style = container ? window.getComputedStyle(container) : null;
      const dStyle = dropdown ? window.getComputedStyle(dropdown) : null;
      window.__dashboardInboxRect = rect
        ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
        : null;
      return {
        isOpen: Boolean(el && el.classList.contains('is-open')),
        width: rect?.width || 0,
        height: rect?.height || 0,
        borderRadius: style?.borderRadius || '',
        dropdownVisible: Boolean(dropdown && dStyle && dStyle.display !== 'none' && dropdown.offsetHeight > 0),
        rect: window.__dashboardInboxRect
      };
    });
    assert.strictEqual(openStatus.isOpen, true, 'InboxWidget failed to open on Dashboard');
    assert.ok(openStatus.borderRadius.includes('16px'), `Expected 16px borderRadius when open, got ${openStatus.borderRadius}`);
    assert.ok(openStatus.width >= 300 && openStatus.height >= 350, `Expected expanded inbox geometry (>=300x350), got ${openStatus.width}x${openStatus.height}`);
    assert.strictEqual(openStatus.dropdownVisible, true, 'Expanded .inbox-dropdown-content must be visible');

    // =========================================================================
    // Step 4: Navigate Dashboard -> EventView with 16ms Mid-Transition Sampler
    // =========================================================================
    console.log('\n--- Step 4: Navigate Dashboard -> EventView & Sample Mid-Transition ---');
    await hostPage.click('.action-btn.primary');
    await hostPage.waitForSelector('.modal-overlay input', { visible: true, timeout: 8000 });
    await hostPage.type('.modal-overlay input', `E2E_INBOX_${runId}`);

    await hostPage.evaluate(() => {
      window.__inboxVisibilitySamples = [];
      window.__inboxUnmountedSamples = 0;
      window.__sampleInterval = setInterval(() => {
        const el = document.querySelector('.inbox-morph-container');
        if (!el) {
          window.__inboxUnmountedSamples += 1;
          return;
        }
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        window.__inboxVisibilitySamples.push({
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          width: rect.width,
          height: rect.height
        });
      }, 16);
    });

    await hostPage.waitForSelector('.modal-overlay .btn-confirm', { visible: true });
    await hostPage.click('.modal-overlay .btn-confirm');
    await hostPage.waitForSelector('.event-view', { timeout: 15000 });
    await waitForTransition(hostPage, { strict: true });
    await hostPage.waitForFunction(
      () => Boolean(window.__sp27E2eBridge?.getEventId?.()) && window.__sp27E2eBridge?.isHostMode?.() === true,
      { timeout: 20000 }
    );
    await waitForCondition(
      () => hostPage.evaluate(() => (window.__inboxVisibilitySamples || []).length >= 5),
      { timeoutMs: 3000, intervalMs: 25, label: 'At least 5 mid-transition samples collected' }
    );

    const midTransitionCheck = await hostPage.evaluate(() => {
      clearInterval(window.__sampleInterval);
      const samples = window.__inboxVisibilitySamples || [];
      const hiddenCount = samples.filter(
        (s) => s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0' || s.width === 0 || s.height === 0
      ).length;
      return {
        totalSamples: samples.length,
        unmountedCount: window.__inboxUnmountedSamples || 0,
        hiddenCount
      };
    });
    assert.ok(midTransitionCheck.totalSamples >= 5, `Expected >=5 transition samples, got ${midTransitionCheck.totalSamples}`);
    assert.strictEqual(midTransitionCheck.unmountedCount, 0, `InboxWidget unmounted during transition in ${midTransitionCheck.unmountedCount} frames`);
    assert.strictEqual(midTransitionCheck.hiddenCount, 0, `InboxWidget hidden during transition in ${midTransitionCheck.hiddenCount} frames`);

    const eventMeta = await hostPage.evaluate(() => ({
      eventId: window.__sp27E2eBridge.getEventId(),
      eventCode: (document.querySelector('.event-code strong')?.textContent || '').trim()
    }));
    assert.ok(eventMeta.eventId && eventMeta.eventCode, 'Failed to read created eventId/eventCode');

    // =========================================================================
    // Step 5: Verify Exact DOM Identity & Bounds in EventView
    // =========================================================================
    console.log('\n--- Step 5: Verify InboxWidget Node Identity & Exact Bounds in EventView ---');
    const eventViewInboxStatus = await hostPage.evaluate(() => {
      const currentEl = document.querySelector('.inbox-widget');
      const container = currentEl ? currentEl.querySelector('.inbox-morph-container') : null;
      const rect = container ? container.getBoundingClientRect() : null;
      const initialRect = window.__dashboardInboxRect;
      const posDiff = initialRect && rect
        ? {
            leftDiff: Math.abs(rect.left - initialRect.left),
            topDiff: Math.abs(rect.top - initialRect.top),
            rightDiff: Math.abs(rect.right - initialRect.right),
            bottomDiff: Math.abs(rect.bottom - initialRect.bottom)
          }
        : null;
      return {
        exists: Boolean(currentEl),
        display: currentEl ? window.getComputedStyle(currentEl).display : null,
        isSameDomNode: Boolean(currentEl && window.__initialInboxNode && currentEl === window.__initialInboxNode),
        hasSameTrackerId: Boolean(currentEl && window.__inboxTrackerId && currentEl.__trackerId === window.__inboxTrackerId),
        isOpen: Boolean(currentEl && currentEl.classList.contains('is-open')),
        parentElement: currentEl?.parentElement?.tagName || null,
        posDiff
      };
    });
    assert.strictEqual(eventViewInboxStatus.exists, true, 'InboxWidget missing in EventView');
    assert.notStrictEqual(eventViewInboxStatus.display, 'none', 'InboxWidget must not be display:none in EventView');
    assert.strictEqual(eventViewInboxStatus.parentElement, 'BODY', 'InboxWidget must remain child of BODY in EventView');
    assert.strictEqual(eventViewInboxStatus.isSameDomNode, true, 'InboxWidget DOM node recreated on EventView');
    assert.strictEqual(eventViewInboxStatus.hasSameTrackerId, true, 'InboxWidget trackerId mismatch on EventView');
    assert.strictEqual(eventViewInboxStatus.isOpen, true, 'InboxWidget open state lost on EventView');
    assert.ok(eventViewInboxStatus.posDiff !== null, 'Expected non-null posDiff in EventView');
    assert.ok(
      eventViewInboxStatus.posDiff.leftDiff <= 1 &&
        eventViewInboxStatus.posDiff.topDiff <= 1 &&
        eventViewInboxStatus.posDiff.rightDiff <= 1 &&
        eventViewInboxStatus.posDiff.bottomDiff <= 1,
      `InboxWidget geometry shifted in EventView: ${JSON.stringify(eventViewInboxStatus.posDiff)}`
    );

    // =========================================================================
    // Step 6 & 7: Return to Dashboard -> Verify Exact Route, DOM Identity & Bounds
    // =========================================================================
    console.log('\n--- Step 6-7: Navigate Back to Dashboard & Verify Inbox Identity ---');
    await hostPage.click('.btn-back');
    await hostPage.waitForSelector('.dashboard', { visible: true, timeout: 10000 });
    await waitForTransition(hostPage, { strict: true });

    const returnDashboardStatus = await hostPage.evaluate(() => {
      const currentEl = document.querySelector('.inbox-widget');
      const container = currentEl ? currentEl.querySelector('.inbox-morph-container') : null;
      const rect = container ? container.getBoundingClientRect() : null;
      const initialRect = window.__dashboardInboxRect;
      const posDiff = initialRect && rect
        ? {
            leftDiff: Math.abs(rect.left - initialRect.left),
            topDiff: Math.abs(rect.top - initialRect.top),
            rightDiff: Math.abs(rect.right - initialRect.right),
            bottomDiff: Math.abs(rect.bottom - initialRect.bottom)
          }
        : null;
      return {
        hash: window.location.hash,
        exists: Boolean(currentEl),
        display: currentEl ? window.getComputedStyle(currentEl).display : null,
        isSameDomNode: Boolean(currentEl && window.__initialInboxNode && currentEl === window.__initialInboxNode),
        hasSameTrackerId: Boolean(currentEl && window.__inboxTrackerId && currentEl.__trackerId === window.__inboxTrackerId),
        isOpen: Boolean(currentEl && currentEl.classList.contains('is-open')),
        posDiff
      };
    });
    assert.ok(returnDashboardStatus.hash.includes('/dashboard'), `Expected return hash to include /dashboard, got ${returnDashboardStatus.hash}`);
    assert.strictEqual(returnDashboardStatus.exists, true, 'InboxWidget missing after return to Dashboard');
    assert.notStrictEqual(returnDashboardStatus.display, 'none', 'InboxWidget hidden after return to Dashboard');
    assert.strictEqual(returnDashboardStatus.isSameDomNode, true, 'InboxWidget DOM node destroyed returning to Dashboard');
    assert.strictEqual(returnDashboardStatus.hasSameTrackerId, true, 'InboxWidget trackerId mismatch returning to Dashboard');
    assert.strictEqual(returnDashboardStatus.isOpen, true, 'InboxWidget open state lost returning to Dashboard');
    assert.ok(returnDashboardStatus.posDiff !== null, 'Missing posDiff returning to Dashboard');
    assert.ok(
      returnDashboardStatus.posDiff.leftDiff <= 1 &&
        returnDashboardStatus.posDiff.topDiff <= 1 &&
        returnDashboardStatus.posDiff.rightDiff <= 1 &&
        returnDashboardStatus.posDiff.bottomDiff <= 1,
      `InboxWidget position shifted returning to Dashboard: ${JSON.stringify(returnDashboardStatus.posDiff)}`
    );

    // Close Inbox before DM tests
    await hostPage.click('.inbox-widget .close-btn');
    await hostPage.waitForFunction(() => !document.querySelector('.inbox-widget.is-open'), { timeout: 5000 });

    // =========================================================================
    // Step 8: Two DMs via Real UI -> Unread Badge -> Mark Read -> Reload Persistence
    // =========================================================================
    console.log('\n--- Step 8: Real UI DMs (Delivery, Mark Read & Reload Persistence) ---');
    await enterExistingEventCardViaUi(hostPage, eventMeta.eventCode);
    await scoutPage.goto(urlStaticClient, { waitUntil: 'domcontentloaded' });
    await robustLogin(scoutPage, scoutUser);
    await joinEventViaUi(scoutPage, eventMeta.eventCode, [hostPage, scoutPage]);
    await waitForConnectedWithSas(hostPage, [hostPage, scoutPage], 30000);

    const scoutSession = await scoutPage.evaluate(() => JSON.parse(localStorage.getItem('scoutingpro-user') || '{}'));
    assert.ok(scoutSession.id, 'Missing scoutSession.id');

    const firstDmBody = `Tactical Strategy_${runId}`;
    const secondDmBody = `Online Briefing_${runId}`;
    await sendDirectMessageViaUi(hostPage, scoutUser, firstDmBody);
    await sendDirectMessageViaUi(hostPage, scoutUser, secondDmBody);
    await scoutPage.waitForFunction(
      (b1, b2, uid) => {
        const msgs = JSON.parse(localStorage.getItem(`inbox-messages-${uid}`) || '[]');
        return msgs.some((m) => m.body === b1) && msgs.some((m) => m.body === b2);
      },
      { timeout: 20000 },
      firstDmBody,
      secondDmBody,
      scoutSession.id
    );

    await scoutPage.waitForSelector('.inbox-widget .badge', { visible: true, timeout: 8000 });
    const badgeBeforeRead = await scoutPage.$eval('.inbox-widget .badge', (el) => Number((el.textContent || '').trim()));
    assert.ok(badgeBeforeRead >= 2, `Expected >=2 unread badge on Scout, got ${badgeBeforeRead}`);

    await scoutPage.click('.inbox-widget .inbox-morph-container');
    await scoutPage.waitForSelector('.inbox-widget.is-open .inbox-item', { visible: true, timeout: 6000 });
    const dmTexts = await scoutPage.$$eval('.inbox-widget .inbox-item p', (els) => els.map((e) => (e.textContent || '').trim()));
    assert.ok(dmTexts.includes(firstDmBody), `Visible Inbox missing first DM "${firstDmBody}"`);
    assert.ok(dmTexts.includes(secondDmBody), `Visible Inbox missing second DM "${secondDmBody}"`);

    await scoutPage.click('.inbox-widget .inbox-item.unread .mark-read');
    await scoutPage.waitForFunction(
      (prev) => document.querySelectorAll('.inbox-widget .inbox-item.unread').length === prev - 1,
      { timeout: 5000 },
      badgeBeforeRead
    );

    await scoutPage.reload({ waitUntil: 'domcontentloaded' });
    await scoutPage.waitForFunction(() => !document.querySelector('.tactical-boot-overlay'), { timeout: 10000 });
    await scoutPage.waitForSelector('.inbox-widget .inbox-morph-container', { visible: true, timeout: 15000 });
    await scoutPage.waitForFunction(
      () => !document.documentElement.hasAttribute('data-transition-type'),
      { timeout: 10000 }
    );
    await scoutPage.click('.inbox-widget .inbox-morph-container');
    await scoutPage.waitForSelector('.inbox-widget.is-open .inbox-item', { visible: true, timeout: 6000 });
    const afterReloadCounts = await scoutPage.evaluate(() => ({
      total: document.querySelectorAll('.inbox-widget .inbox-item').length,
      unread: document.querySelectorAll('.inbox-widget .inbox-item.unread').length
    }));
    assert.strictEqual(afterReloadCounts.total, 2, `Expected 2 Inbox messages after reload, got ${afterReloadCounts.total}`);
    assert.strictEqual(afterReloadCounts.unread, badgeBeforeRead - 1, 'Expected marked-read state to persist across reload');
    await scoutPage.click('.inbox-widget .close-btn');
    await scoutPage.waitForFunction(() => !document.querySelector('.inbox-widget.is-open'), { timeout: 5000 });

    // =========================================================================
    // Step 9: Conflict Alert Deep-Link Navigation
    // =========================================================================
    console.log('\n--- Step 9: Conflict Alert Deep-Link to Highlighted History Card ---');
    await waitForConnectedWithSas(scoutPage, [hostPage, scoutPage], 30000);
    await submitMatchRecordViaUi(hostPage, { matchNumber: 1, teamNumber: 27570 });
    await submitMatchRecordViaUi(scoutPage, { matchNumber: 1, teamNumber: 27570 });

    // Switch Host away from History to Schedule, wait for conflict alert in Host Inbox, then click alert
    await switchToTab(hostPage, 'schedule');
    await hostPage.waitForFunction(
      () => {
        const u = JSON.parse(localStorage.getItem('scoutingpro-user') || '{}');
        const msgs = JSON.parse(localStorage.getItem(`inbox-messages-${u.id}`) || '[]');
        return msgs.some((m) => m.type === 'conflict' && m.conflictMatchNumber === 1 && m.conflictTeamNumber === 27570);
      },
      { timeout: 20000 }
    );

    await hostPage.click('.inbox-widget .inbox-morph-container');
    await hostPage.waitForSelector('.inbox-widget.is-open .inbox-item.clickable', { visible: true, timeout: 6000 });
    await hostPage.click('.inbox-widget .inbox-item.clickable');
    await waitForTransition(hostPage, { strict: true });

    await hostPage.waitForSelector('.history-card.highlight-conflict', { visible: true, timeout: 10000 });
    const deepLinkUrl = hostPage.url();
    assert.ok(
      deepLinkUrl.includes('tab=history') && deepLinkUrl.includes('highlightMatch=1') && deepLinkUrl.includes('highlightTeam=27570'),
      `Conflict deep-link did not navigate cleanly: ${deepLinkUrl}`
    );

    // =========================================================================
    // Step 10: Delete Single Message, Clear All, & Multi-User Isolation
    // =========================================================================
    console.log('\n--- Step 10: Single Delete, Clear All & Multi-User Isolation ---');
    await scoutPage.click('.inbox-widget .inbox-morph-container');
    await scoutPage.waitForSelector('.inbox-widget.is-open .inbox-item', { visible: true, timeout: 6000 });
    const scoutPreDeleteCount = await scoutPage.$$eval('.inbox-widget .inbox-item', (els) => els.length);
    assert.ok(scoutPreDeleteCount >= 2, `Expected at least 2 Inbox items on Scout before delete, got ${scoutPreDeleteCount}`);
    await scoutPage.click('.inbox-widget .inbox-item .delete-msg-btn');
    await scoutPage.waitForFunction(
      (expected) => document.querySelectorAll('.inbox-widget .inbox-item').length === expected,
      { timeout: 5000 },
      scoutPreDeleteCount - 1
    );
    await scoutPage.click('.inbox-widget .clear-all-btn');
    await scoutPage.waitForSelector('.inbox-widget .inbox-list .empty', { visible: true, timeout: 5000 });
    const clearedStorage = await scoutPage.evaluate(
      (uid) => JSON.parse(localStorage.getItem(`inbox-messages-${uid}`) || '[]'),
      scoutSession.id
    );
    assert.strictEqual(clearedStorage.length, 0, 'Expected localStorage inbox messages to be empty after Clear All');
    await scoutPage.click('.inbox-widget .close-btn');
    await scoutPage.waitForFunction(() => !document.querySelector('.inbox-widget.is-open'), { timeout: 5000 });

    // Multi-user isolation: Logout HostA -> Login UserB -> assert 0 leaked Inbox messages
    await logoutViaUi(hostPage);
    await robustLogin(hostPage, hostUserB);
    await hostPage.click('.inbox-widget .inbox-morph-container');
    await hostPage.waitForSelector('.inbox-widget.is-open .inbox-dropdown-content', { visible: true, timeout: 5000 });
    const userBItems = await hostPage.$$eval('.inbox-widget .inbox-item', (els) => els.length);
    assert.strictEqual(userBItems, 0, `User B must NOT see User A inbox messages (saw ${userBItems})`);

    // =========================================================================
    // Step 11: Mobile Viewport (390x844) Closed-Hidden -> MoreSheet Open -> Backdrop Dismiss
    // =========================================================================
    console.log('\n--- Step 11: Mobile Viewport (390x844) Inbox Flow ---');
    await scoutPage.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await scoutPage.waitForFunction(
      () => !document.querySelector('.tactical-boot-overlay') && !document.documentElement.hasAttribute('data-transition-type'),
      { timeout: 15000 }
    );
    await scoutPage.waitForSelector('.mobile-bottom-nav .nav-item-btn:last-child', { visible: true, timeout: 10000 });

    const mobileClosedState = await scoutPage.evaluate(() => {
      const w = document.querySelector('.inbox-widget');
      return {
        exists: Boolean(w),
        isOpen: Boolean(w && w.classList.contains('is-open')),
        display: w ? window.getComputedStyle(w).display : null
      };
    });
    assert.strictEqual(mobileClosedState.exists, true, 'InboxWidget must remain mounted on mobile');
    assert.strictEqual(mobileClosedState.isOpen, false, 'InboxWidget should start closed on mobile');
    assert.strictEqual(mobileClosedState.display, 'none', `Closed InboxWidget must be display:none on mobile (<=768px), got ${mobileClosedState.display}`);

    await scoutPage.click('.mobile-bottom-nav .nav-item-btn:last-child');
    await scoutPage.waitForSelector('.more-sheet .sheet-tool-row', { visible: true, timeout: 6000 });
    await scoutPage.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.more-sheet .sheet-tool-row'));
      const inboxRow = rows.find((r) => (r.querySelector('.sheet-tool-icon')?.textContent || '').trim() === 'inbox');
      if (!inboxRow) throw new Error('Inbox tool row missing in .more-sheet');
      inboxRow.click();
    });

    await scoutPage.waitForSelector('.inbox-widget.is-open .inbox-dropdown-content', { visible: true, timeout: 6000 });
    const mobileOpenBackdrop = await scoutPage.evaluate(() => {
      const backdrop = document.querySelector('.inbox-widget.is-open .inbox-backdrop');
      const box = document.querySelector('.inbox-morph-container')?.getBoundingClientRect();
      return {
        hasBackdrop: Boolean(backdrop && window.getComputedStyle(backdrop).display !== 'none'),
        outsideX: box ? Math.max(20, Math.floor(box.left - 30)) : 40,
        outsideY: box ? Math.max(40, Math.floor(box.top - 30)) : 60
      };
    });
    assert.strictEqual(mobileOpenBackdrop.hasBackdrop, true, 'Mobile open Inbox must show visible .inbox-backdrop');

    // Click real screen coordinates outside the expanded morph container to trigger backdrop dismiss
    await scoutPage.mouse.click(mobileOpenBackdrop.outsideX, mobileOpenBackdrop.outsideY);
    await scoutPage.waitForFunction(() => !document.querySelector('.inbox-widget.is-open'), { timeout: 5000 });

    manager.assertNoUnexpectedErrors([hostPage, scoutPage], {
      allowConsolePatterns: [/WakeLock/i]
    });
    console.log('\n🎉 ALL INBOX LIFECYCLE & EXTREME SCENARIO E2E CHECKS PASSED!');
  } catch (err) {
    console.error('\n❌ Inbox Lifecycle E2E FAILED:', err);
    errors.push(err?.message || String(err));
    process.exitCode = 1;
  } finally {
    await manager.cleanupAll({ assertDeleted: !process.exitCode && errors.length === 0 }).catch((cleanupErr) => {
      console.error('❌ Cleanup error:', cleanupErr);
      process.exitCode = 1;
    });
    process.removeListener('SIGINT', signalHandler);
    process.removeListener('SIGTERM', signalHandler);
    if (!process.exitCode && errors.length === 0) {
      for (const base of rootDbBaselines) {
        assert.deepStrictEqual(snapshotFileStat(base.path), base.stat, `Root DB polluted: ${base.path}`);
      }
    }
    process.exit(process.exitCode || 0);
  }
}

runE2E();
