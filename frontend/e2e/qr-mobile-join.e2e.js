import assert from 'assert';
import fs from 'fs';
import path from 'path';
import jsQR from 'jsqr';
import { E2EClusterManager, REPO_ROOT, allocateFreePort, ensureE2eBuildArtifacts } from './helpers/e2eBackendManager.js';
import {
  completeMobileWizardMatchViaUi,
  confirmAnySasModals,
  createEventViaUi,
  fetchBackendJson,
  robustLogin,
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

async function decodeQrCanvasOnPage(page) {
  const img = await page.evaluate(() => {
    const canvas = document.querySelector('.qr-canvas-container canvas');
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return {
      width: canvas.width,
      height: canvas.height,
      data: Array.from(imageData.data)
    };
  });
  assert.ok(img && img.width > 0 && img.height > 0, 'QR canvas missing or zero-sized');
  const decoded = jsQR(Uint8ClampedArray.from(img.data), img.width, img.height);
  assert.ok(decoded && decoded.data, 'jsQR failed to decode rendered QR canvas pixels');
  return decoded.data;
}

async function runQrMobileE2ETest() {
  ensureE2eBuildArtifacts();
  const rootDbPaths = [
    path.join(REPO_ROOT, 'app_data.mv.db'),
    path.join(REPO_ROOT, 'Backend', 'app_data.mv.db')
  ];
  const rootDbBaselines = rootDbPaths.map((p) => ({ path: p, stat: snapshotFileStat(p) }));

  const runId = Date.now();
  const manager = new E2EClusterManager(runId);

  const signalHandler = async (sig) => {
    console.warn(`\n[QR E2E] Caught ${sig}; running cleanup...`);
    await manager.cleanupAll({ assertDeleted: false }).catch(() => {});
    process.exit(1);
  };
  process.on('SIGINT', signalHandler);
  process.on('SIGTERM', signalHandler);

  const dirHost = manager.createTempDir('qr-host');
  const chromeHostDir = manager.createTempDir('qr-chrome-host');
  const chromeMob1Dir = manager.createTempDir('qr-chrome-mobile1');
  const chromeMob2Dir = manager.createTempDir('qr-chrome-mobile2');

  const checks = [];
  const errors = [];

  function recordCheck(name, passed, detail = '') {
    checks.push({ name, passed: Boolean(passed), detail });
    if (passed) {
      console.log(`  ✅ [PASS] ${name}${detail ? ` (${detail})` : ''}`);
    } else {
      console.error(`  ❌ [FAIL] ${name}${detail ? ` (${detail})` : ''}`);
      errors.push(`${name}: ${detail}`);
    }
  }

  try {
    const PORT_HOST = await allocateFreePort();
    const URL_HOST = `http://localhost:${PORT_HOST}/index.html`;
    await manager.startLocalMqttBroker();
    const clientBaseUrl = await manager.startStaticClientServer(0, '127.0.0.2');
    await manager.startBackend({ name: 'host', port: PORT_HOST, tmpDir: dirHost });

    const [hostLaunch, mob1Launch, mob2Launch] = await Promise.all([
      manager.launchBrowser({ name: 'host', index: 0, userDataDir: chromeHostDir, showUi: SHOW_UI }),
      manager.launchBrowser({
        name: 'mobile1',
        index: 1,
        userDataDir: chromeMob1Dir,
        showUi: SHOW_UI,
        extraSecureOrigin: clientBaseUrl
      }),
      manager.launchBrowser({
        name: 'mobile2',
        index: 2,
        userDataDir: chromeMob2Dir,
        showUi: SHOW_UI,
        extraSecureOrigin: clientBaseUrl
      })
    ]);

    const hostBrowser = hostLaunch.browser;
    await hostBrowser.defaultBrowserContext().overridePermissions(`http://localhost:${PORT_HOST}`, [
      'clipboard-read',
      'clipboard-write',
      'clipboard-sanitized-write'
    ]);

    const hostPage = hostLaunch.page;
    const mobilePage = mob1Launch.page;
    const mobile2Page = mob2Launch.page;

    await hostPage.setViewport({ width: 1200, height: 850 });
    for (const mPage of [mobilePage, mobile2Page]) {
      await mPage.setViewport({
        width: 390,
        height: 844,
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3
      });
      await mPage.setUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      );
    }

    const hostUsername = `HostLead_${runId}`;
    const hostPassword = 'e2epassword123';

    // ------------------------------------------------------------------
    // PHASE 1: Host creates Event & opens MobileQrModal
    // ------------------------------------------------------------------
    console.log('\n--- Phase 1: Host login & Event creation ---');
    await hostPage.goto(URL_HOST, { waitUntil: 'domcontentloaded' });
    await robustLogin(hostPage, hostUsername, hostPassword);
    const hostLoggedIn = Boolean(await hostPage.$('.action-btn.primary')) && hostPage.url().includes('/dashboard');
    recordCheck('Desktop Host logged in to Dashboard', hostLoggedIn, hostUsername);

    const { eventCode, eventId } = await createEventViaUi(hostPage, `QR_CHAMP_${runId}`);
    recordCheck('Host created event & extracted inviteCode', Boolean(eventId && eventCode.length === 6), `${eventId}/${eventCode}`);
    const hostSession = await hostPage.evaluate(() => JSON.parse(localStorage.getItem('scoutingpro-user') || '{}'));

    // ------------------------------------------------------------------
    // PHASE 2: Real jsQR Pixel Decode + Cloud/LAN Channel + Real Clipboard Check
    // ------------------------------------------------------------------
    console.log('\n--- Phase 2: MobileQrModal jsQR Decode, Channel Toggle & Real Clipboard Copy ---');
    await hostPage.waitForSelector('.host-qr-btn', { visible: true, timeout: 8000 });
    await hostPage.evaluate(() => {
      const btn = document.querySelector('.host-qr-btn');
      if (!btn) throw new Error('Expected .host-qr-btn in topbar');
      btn.click();
    });
    await hostPage.waitForSelector('.qr-modal-dialog', { visible: true, timeout: 8000 });

    const modalDetails = await hostPage.evaluate(() => {
      const codeVal = document.querySelector('.code-badge-bar .code-value')?.textContent?.trim() || '';
      const urlInput = document.querySelector('.url-copy-box .url-input');
      const hasChannelPill = Boolean(document.querySelector('.channel-pill-bar'));
      return {
        codeVal,
        joinUrl: urlInput ? urlInput.value : '',
        hasChannelPill
      };
    });
    recordCheck('QR Modal code badge matches event inviteCode', modalDetails.codeVal === eventCode, modalDetails.codeVal);
    recordCheck('Generated Join URL includes ?join=CODE&b=emqx', modalDetails.joinUrl.includes(`join=${eventCode}&b=emqx`), modalDetails.joinUrl);

    const decodedCloudQr = await decodeQrCanvasOnPage(hostPage);
    recordCheck(
      'jsQR pixel decode strictly matches generated Cloud Join URL',
      decodedCloudQr === modalDetails.joinUrl,
      decodedCloudQr
    );

    recordCheck('MobileQrModal renders Cloud/LAN channel pill bar', modalDetails.hasChannelPill);
    assert.strictEqual(modalDetails.hasChannelPill, true, 'Expected .channel-pill-bar in MobileQrModal');

    await hostPage.click('.channel-pill-item:nth-child(2)');
    await hostPage.waitForFunction(
      () => (document.querySelector('.url-copy-box .url-input')?.value || '').includes('&b=lan'),
      { timeout: 5000 }
    );
    const decodedLanQr = await waitForCondition(
      async () => {
        try {
          const val = await decodeQrCanvasOnPage(hostPage);
          return val.includes(`join=${eventCode}&b=lan`) ? val : false;
        } catch {
          return false;
        }
      },
      { timeoutMs: 5000, intervalMs: 50, label: 'QR canvas update for LAN channel (&b=lan)' }
    );
    recordCheck('jsQR decode switches cleanly to LAN channel (&b=lan)', decodedLanQr.includes(`join=${eventCode}&b=lan`), decodedLanQr);
    await hostPage.click('.channel-pill-item:nth-child(1)');
    await hostPage.waitForFunction(
      () => (document.querySelector('.url-copy-box .url-input')?.value || '').includes('&b=emqx'),
      { timeout: 5000 }
    );

    // Strict Clipboard Copy assertion (no tautological fallback!)
    await hostPage.bringToFront();
    await hostPage.click('.url-copy-box .btn-copy');
    await hostPage.waitForFunction(
      () => {
        const txt = document.querySelector('.url-copy-box .btn-copy')?.textContent || '';
        return txt.includes('已复制') || txt.includes('Copied');
      },
      { timeout: 5000 }
    );
    const clipboardCheck = await hostPage.evaluate(async () => {
      const btnText = (document.querySelector('.url-copy-box .btn-copy')?.textContent || '').trim();
      const clipText = await navigator.clipboard.readText();
      return { btnText, clipText };
    });
    recordCheck(
      'Copy URL wrote exact Join URL into system clipboard and updated button state',
      clipboardCheck.clipText === modalDetails.joinUrl,
      clipboardCheck.btnText
    );

    await hostPage.click('.qr-modal-header .close-btn');
    await hostPage.waitForFunction(() => !document.querySelector('.qr-modal-dialog'), { timeout: 5000 });
    const qrModalDismissed = await hostPage.evaluate(() => !document.querySelector('.qr-modal-dialog'));
    recordCheck('Host dismissed QR modal cleanly', qrModalDismissed);

    // ------------------------------------------------------------------
    // PHASE 3: Mobile #1 Opens Decoded QR URL -> Registers -> Real WebRTC + SAS
    // ------------------------------------------------------------------
    console.log('\n--- Phase 3: Mobile #1 QR Join, Broker Param Verification & WebRTC Connect ---');
    const decodedHash = new URL(decodedCloudQr).hash;
    const mobileEntryUrl = `${clientBaseUrl}/index.html${decodedHash}`;
    await mobilePage.goto(mobileEntryUrl, { waitUntil: 'domcontentloaded' });

    await mobilePage.waitForSelector('.invite-banner .invite-code-text', { visible: true, timeout: 10000 });
    const inviteCheck = await mobilePage.evaluate(() => ({
      bannerCode: (document.querySelector('.invite-code-text')?.textContent || '').trim(),
      activeBroker: sessionStorage.getItem('sp27-active-broker')
    }));
    recordCheck('Mobile LoginView shows decoded inviteCode banner', inviteCheck.bannerCode === eventCode, inviteCheck.bannerCode);
    recordCheck('QR ?b=emqx populated sessionStorage[sp27-active-broker]', inviteCheck.activeBroker === 'emqx', inviteCheck.activeBroker);

    // Switch mobile session broker override off before signaling so isolated local MQTT broker routes P2P test
    await mobilePage.evaluate(() => sessionStorage.removeItem('sp27-active-broker'));

    const mobileScoutUser = `MobileScout_${runId}`;
    await robustLogin(mobilePage, mobileScoutUser, hostPassword);
    await mobilePage.waitForSelector('.event-view', { visible: true, timeout: 15000 });
    await waitForTransition(mobilePage, { strict: true });

    const mobileLayout = await mobilePage.evaluate(() => {
      const topbar = document.querySelector('.topbar');
      const bottomNav = document.querySelector('.mobile-bottom-nav');
      const statusPill = document.querySelector('.status-pill');
      return {
        hasTopbarInDom: Boolean(topbar),
        topbarDisplay: topbar ? window.getComputedStyle(topbar).display : null,
        statusPillVisible: Boolean(statusPill && window.getComputedStyle(statusPill).display !== 'none'),
        bottomNavVisible: Boolean(bottomNav && window.getComputedStyle(bottomNav).display !== 'none')
      };
    });
    recordCheck(
      'Mobile Zero-Topbar mode: .topbar present in DOM and display:none',
      mobileLayout.hasTopbarInDom && mobileLayout.topbarDisplay === 'none',
      mobileLayout.topbarDisplay
    );
    recordCheck('Mobile Status Pill visible', mobileLayout.statusPillVisible);
    recordCheck('Mobile Bottom Nav visible', mobileLayout.bottomNavVisible);

    // Wait strictly for BOTH Host & Mobile to complete WebRTC + SAS handshake
    await waitForConnectedWithSas(mobilePage, [hostPage, mobilePage], 45000);
    await waitForConnectedWithSas(hostPage, [hostPage, mobilePage], 45000);
    await mobilePage.waitForFunction(
      (authEventId) => window.__sp27E2eBridge?.getEventId?.() === authEventId,
      { timeout: 15000 },
      eventId
    );
    const liveDotOk = await mobilePage.evaluate(() => Boolean(document.querySelector('.status-pill .status-indicator-dot.is-connected')));
    recordCheck('WebRTC P2P connected: Host .connected AND Mobile .status-indicator-dot.is-connected', liveDotOk);

    // ------------------------------------------------------------------
    // PHASE 4: Full 5-Step Mobile Wizard Submission -> Host History, Rankings & H2 DB
    // ------------------------------------------------------------------
    console.log('\n--- Phase 4: Full 5-Step Mobile Wizard Match Submit & Host Sync ---');
    const submittedTotal = await completeMobileWizardMatchViaUi(mobilePage, {
      matchNumber: 1,
      teamNumber: 27570,
      alliance: 'red',
      autoHits: 2,
      teleopHits: 3,
      endgameNectars: 1,
      teleopPark: true,
      notes: 'QR Mobile 5-Step Sync'
    });
    recordCheck('Mobile Scout completed 5-step wizard and submitted Match 1', submittedTotal > 0, `Score=${submittedTotal}`);

    await switchToTab(hostPage, 'history');
    await waitForCondition(
      () =>
        hostPage.evaluate(() =>
          Array.from(document.querySelectorAll('.history-card')).some(
            (c) => (c.textContent || '').includes('#Q1') && (c.textContent || '').includes('#27570')
          )
        ),
      { timeoutMs: 25000, label: 'Mobile Match 1 visible in Host History DOM' }
    );
    const historyVisible = await hostPage.evaluate(() =>
      Array.from(document.querySelectorAll('.history-card')).some(
        (c) => (c.textContent || '').includes('#Q1') && (c.textContent || '').includes('#27570')
      )
    );
    recordCheck('Mobile Match 1 converged to Host visible History DOM', historyVisible);

    await switchToTab(hostPage, 'rankings');
    await hostPage.waitForSelector('.rankings-panel .team-num', { timeout: 10000 });
    const hasTeamInRankings = await hostPage.evaluate(() =>
      Array.from(document.querySelectorAll('.rankings-panel .team-num')).some((el) => (el.textContent || '').includes('27570'))
    );
    recordCheck('Mobile Match 1 reflected in Host Rankings table', hasTeamInRankings);

    await hostPage.evaluate(() => window.__sp27E2eBridge.flushCrdtNow());
    const hostDbRecs = await fetchBackendJson(PORT_HOST, `/api/records?eventId=${eventId}`, hostSession.token);
    const h2Record = Array.isArray(hostDbRecs)
      ? hostDbRecs.find((r) => Number(r.matchNumber) === 1 && Number(r.teamNumber) === 27570)
      : null;
    recordCheck('Mobile Match 1 persisted into Host H2 DB', Boolean(h2Record && h2Record.totalScore === submittedTotal));

    // ------------------------------------------------------------------
    // PHASE 5: Duplicate-Username QR Join -> SessionConflictModal (DUPLICATE_NAME) -> Account Merge
    // ------------------------------------------------------------------
    console.log('\n--- Phase 5: Duplicate Username QR Join -> Wrong Password Error -> Real Account Merge ---');
    await mobile2Page.goto(`${clientBaseUrl}/index.html#/?join=${eventCode}`, { waitUntil: 'domcontentloaded' });
    await robustLogin(mobile2Page, hostUsername, 'tempOfflinePass99');
    await mobile2Page.waitForSelector('.event-view', { visible: true, timeout: 15000 });

    // Confirm SAS on peers and wait for SessionConflictModal (DUPLICATE_NAME) on mobile2Page
    await waitForCondition(
      () =>
        mobile2Page.evaluate(() => Boolean(document.querySelector('.modal-overlay .modal-card .merge-block'))),
      {
        timeoutMs: 35000,
        intervalMs: 250,
        label: 'SessionConflictModal DUPLICATE_NAME merge block on mobile2',
        onPoll: () => confirmAnySasModals([hostPage, mobilePage, mobile2Page])
      }
    );
    const mergeModalShown = await mobile2Page.evaluate(() => Boolean(document.querySelector('.modal-overlay .modal-card .merge-block')));
    recordCheck('Duplicate-username mobile client triggered SessionConflictModal (DUPLICATE_NAME)', mergeModalShown);

    // Wrong password must fail visibly inside modal
    await mobile2Page.type('.merge-block input[type="password"]', 'wrongpassword');
    await mobile2Page.evaluate(() => {
      const btn = document.querySelector('.merge-block .btn-accent');
      if (!btn) throw new Error('Expected .merge-block .btn-accent');
      btn.click();
    });
    await mobile2Page.waitForSelector('.merge-block .alert-banner.error', { visible: true, timeout: 10000 });
    const wrongPwdRejected = await mobile2Page.evaluate(() => Boolean(document.querySelector('.merge-block .alert-banner.error')));
    recordCheck('SessionConflictModal rejected wrong account-merge password visibly', wrongPwdRejected);

    // Clear password -> enter real Host password -> Merge succeeds & userId converges!
    await mobile2Page.evaluate(() => {
      const inp = document.querySelector('.merge-block input[type="password"]');
      if (inp) {
        inp.value = '';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await mobile2Page.type('.merge-block input[type="password"]', hostPassword);
    await mobile2Page.evaluate(() => {
      const btn = document.querySelector('.merge-block .btn-accent');
      if (!btn) throw new Error('Expected .merge-block .btn-accent');
      btn.click();
    });
    await mobile2Page.waitForFunction(() => !document.querySelector('.modal-overlay .modal-card .merge-block'), {
      timeout: 15000
    });

    const mergedSession = await mobile2Page.evaluate(() => JSON.parse(localStorage.getItem('scoutingpro-user') || '{}'));
    recordCheck(
      'Account merge migrated mobile2 userId to authoritative Host userId',
      mergedSession.id === hostSession.id,
      `mobile2=${mergedSession.id}, host=${hostSession.id}`
    );

    await waitForConnectedWithSas(mobile2Page, [hostPage, mobilePage, mobile2Page], 30000);
    const mergedConnectedDot = await mobile2Page.evaluate(() =>
      Boolean(document.querySelector('.status-pill .status-indicator-dot.is-connected, .connection-status .status-dot.online'))
    );
    recordCheck('Merged mobile2 session connected cleanly post-merge', mergedConnectedDot);

    manager.assertNoUnexpectedErrors([hostPage], {
      allowConsolePatterns: [/status of 401|Failed to load resource.*401/i]
    });
    manager.assertNoUnexpectedErrors([mobilePage, mobile2Page], {
      allowConsolePatterns: [/status of 401|Failed to load resource.*401|WakeLock|WebSocket connection to 'ws:\/\/127\.0\.0\.2/i]
    });
  } catch (err) {
    console.error('\n❌ Uncaught Exception during QR Mobile E2E Test:', err);
    errors.push(err.message || String(err));
    process.exitCode = 1;
  } finally {
    await manager.cleanupAll({ assertDeleted: !process.exitCode && errors.length === 0 }).catch((cleanupErr) => {
      console.error('❌ Cleanup error:', cleanupErr);
      process.exitCode = 1;
    });
    process.removeListener('SIGINT', signalHandler);
    process.removeListener('SIGTERM', signalHandler);
  }

  console.log('\n==================================================================');
  console.log('📊 QR MOBILE SCAN-TO-JOIN E2E RESULT SUMMARY');
  console.log('==================================================================');
  const passedCount = checks.filter((c) => c.passed).length;
  console.log(`Total Checks: ${checks.length} | Passed: ${passedCount} | Failed: ${errors.length}`);

  if (errors.length === 0 && passedCount === checks.length && checks.length > 0) {
    for (const base of rootDbBaselines) {
      assert.deepStrictEqual(snapshotFileStat(base.path), base.stat, `Root DB polluted: ${base.path}`);
    }
    console.log('\n🎉 ALL QR MOBILE SCAN-TO-JOIN CHECKS PASSED WITH 100% SUCCESS!\n');
    process.exit(0);
  } else {
    console.error('\n❌ QR MOBILE SCAN-TO-JOIN TEST FAILED:');
    errors.forEach((e, idx) => console.error(`  ${idx + 1}. ${e}`));
    process.exit(1);
  }
}

runQrMobileE2ETest();
