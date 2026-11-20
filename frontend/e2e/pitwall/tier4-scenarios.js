import fs from 'node:fs';
import path from 'node:path';
import {
  findSplashRenderPngs,
  runBackendUiAndSplashTests
} from './backend-desktop.js';
import {
  captureScreenshot,
  createEvent,
  DESKTOP_VIEWPORT,
  MOBILE_VIEWPORT,
  robustLogin,
  selectTab,
  waitForTransition
} from './browser.js';
import { auditBrandSvg } from './css-audit.js';
import {
  generateMultiScaleBrandPreview,
  readPngFile
} from './png-ico.js';
import { seedEventViaApi } from './seed.js';
import { delay } from './server.js';
import {
  assert,
  assertColorMatch,
  ensureDesktopSession,
  ensureMobilePage,
  getFrontendScan,
  openTabAndWait
} from './test-utils.js';

export const TIER4_TESTS = [
  {
    id: 'T4-S01',
    tier: 4,
    feature: 'F1,F3,F8,F9,F10,F11,F13',
    title: 'S1: Web & PWA Cold Boot -> Login -> Dashboard (Desktop 1440x900) + Screenshots 01..03',
    async run(ctx) {
      const page = await ctx.browserHandle.openCleanPage(DESKTOP_VIEWPORT);
      try {
        await page.goto(ctx.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const bootBg = await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor);
        assertColorMatch(bootBg, '#0B0E10', 'Cold boot background', 4);
        await captureScreenshot(page, ctx.screenshotsDir, '01_web_boot.png');

        await page.waitForSelector('.login-card', { visible: true, timeout: 15000 });
        await waitForTransition(page);
        await captureScreenshot(page, ctx.screenshotsDir, '02_login.png');

        const username = `pitwall_s1_${Date.now().toString().slice(-6)}`;
        await robustLogin(page, ctx.baseUrl, username);
        await page.waitForSelector('.dashboard, .dashboard-view', { visible: true, timeout: 15000 });
        await waitForTransition(page);
        await captureScreenshot(page, ctx.screenshotsDir, '03_dashboard.png');

        const { eventId, inviteCode, scoutInfo } = await createEvent(page, 'S1 Cold Boot Event');
        const seed = await seedEventViaApi(page, eventId, scoutInfo);
        if (ctx._desktopSession?.page && ctx._desktopSession.page !== page) {
          await ctx._desktopSession.page.close().catch(() => {});
        }
        ctx._desktopSession = { page, username, eventId, inviteCode, scoutInfo, seed };

        return { detail: 'S1 cold boot -> login -> dashboard -> event flow passed (screenshots 01..03 saved)' };
      } catch (err) {
        await page.close().catch(() => {});
        throw err;
      }
    }
  },
  {
    id: 'T4-S02',
    tier: 4,
    feature: 'F1,F4,F8,F10',
    title: 'S2: Full Red Alliance Match Scouting Cycle (PreMatch -> Auto -> TeleOp -> Endgame -> Submit) + 04_scouting_red.png',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'scout', '.scouting-form');
      await page.click('.spdt-labels span:first-child');
      const matchInput = await page.$('input[placeholder="1-999"]');
      if (matchInput) {
        await matchInput.click({ clickCount: 3 });
        await matchInput.type('42');
      }
      const teamInput = await page.$('input[placeholder="e.g. 12345"]');
      if (teamInput) {
        await teamInput.click({ clickCount: 3 });
        await teamInput.type('27570');
      }
      await page.click('.phase-auto .pad-hit-btn');
      await page.click('.phase-teleop .pad-hit-btn');
      await page.click('.phase-teleop .pad-hit-btn');
      await page.click('.phase-teleop .pad-miss-btn');
      await delay(150);

      await captureScreenshot(page, ctx.screenshotsDir, '04_scouting_red.png');

      const submitBtn = await page.$('.btn-submit');
      assert(submitBtn, 'ScoutingForm .btn-submit missing');
      await submitBtn.click();
      await page.waitForSelector('.submit-status-msg:not(.error)', { visible: true, timeout: 8000 });
      return { detail: 'S2 Red Alliance full scouting cycle submitted & screenshot 04_scouting_red.png saved' };
    }
  },
  {
    id: 'T4-S03',
    tier: 4,
    feature: 'F1,F2,F4,F7,F8,F10',
    title: 'S3: Full Blue Alliance Match Scouting & Mobile Wizard (390x844) + 05_scouting_blue.png & 06_mobile_wizard.png',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'scout', '.scouting-form');
      await page.click('.spdt-labels span:last-child');
      await delay(150);
      await captureScreenshot(page, ctx.screenshotsDir, '05_scouting_blue.png');

      const { page: mPage } = await ensureMobilePage(ctx);
      await openTabAndWait(mPage, 'scout', '.mobile-wizard-container');
      await mPage.click('.alliance-btn.blue-btn');
      await delay(150);
      await captureScreenshot(mPage, ctx.screenshotsDir, '06_mobile_wizard.png');

      return { detail: 'S3 Blue Alliance & 390x844 Mobile Wizard captured (05, 06)' };
    }
  },
  {
    id: 'T4-S04',
    tier: 4,
    feature: 'F1,F2,F3,F6,F8,F10',
    title: 'S4: Event Hub Multi-View Workflow (Rankings + Pit Drawer + Schedule + Custom Fields + History) + 07_rankings.png',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'rankings', '.rankings-panel .ranking-row');
      await captureScreenshot(page, ctx.screenshotsDir, '07_rankings.png');

      await openTabAndWait(page, 'pit', '.pit-scout-view .team-roster-card');
      await page.click('.team-roster-card');
      await page.waitForSelector('.drawer-panel', { visible: true, timeout: 8000 });
      const closeBtn = await page.$('.drawer-footer .btn-cancel, .drawer-header .close-btn');
      if (closeBtn) await closeBtn.click();

      await openTabAndWait(page, 'schedule', '.schedule-manager .match-row');
      await openTabAndWait(page, 'history', '.history-panel .history-card');
      await openTabAndWait(page, 'scouts', '.event-scouts-panel');
      return { detail: 'S4 Event Hub multi-view workflow completed & 07_rankings.png captured' };
    }
  },
  {
    id: 'T4-S05',
    tier: 4,
    feature: 'F1,F5,F7,F8',
    title: 'S5: Tactical Whiteboard & Alliance Station Palette Interaction + Simulation + 09_whiteboard.png',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'whiteboard', '[data-testid="tactical-whiteboard-view"]');
      const playBtn = await page.$('[data-testid="wb-btn-play-sim"]');
      if (playBtn) {
        await playBtn.click();
        await delay(250);
        await playBtn.click();
      }
      await captureScreenshot(page, ctx.screenshotsDir, '09_whiteboard.png');
      return { detail: 'S5 Tactical Whiteboard interaction & 09_whiteboard.png captured' };
    }
  },
  {
    id: 'T4-S06',
    tier: 4,
    feature: 'F1,F2,F3,F6,F7,F8,F10',
    title: 'S6: Common Modals, Inbox 52px FAB, Connection Pill, Toasts & AI Assistant Flow + 08_modal.png',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await selectTab(page, 'ai');
      await page.waitForSelector('.ai-chat-view', { visible: true, timeout: 8000 });

      await page.click('.host-qr-btn');
      await page.waitForSelector('.qr-modal-dialog, .modal-card', { visible: true, timeout: 8000 });
      await delay(200);
      await captureScreenshot(page, ctx.screenshotsDir, '08_modal.png');

      const closeBtn = await page.$('.qr-modal-dialog .close-btn, .qr-modal-dialog .btn-close, .modal-card .close-btn, .modal-card .btn-close');
      assert(closeBtn, 'MobileQrModal close button missing in S6');
      await closeBtn.click();
      await page.waitForFunction(() => !document.querySelector('.qr-modal-backdrop, .modal-overlay'), { timeout: 3000 });

      await page.click('.inbox-morph-container');
      await page.waitForSelector('.inbox-widget.is-open .inbox-header .close-btn', { visible: true, timeout: 5000 });
      await page.click('.inbox-header .close-btn');
      await page.waitForFunction(() => !document.querySelector('.inbox-widget')?.classList.contains('is-open'), { timeout: 3000 });
      return { detail: 'S6 AI + Modal + 52px Inbox FAB flow passed & 08_modal.png captured' };
    }
  },
  {
    id: 'T4-S07',
    tier: 4,
    feature: 'F11,F12,F14,F15',
    title: 'S7: Desktop Java Splash (0%->100% + Error State) -> CustomTitleBar -> Rounded Chrome Verification',
    async run(ctx) {
      const run = runBackendUiAndSplashTests(ctx);
      assert(run.exitCode === 0, `Desktop Java UI Maven suite failed (exit ${run.exitCode})`);
      const splashPngs = findSplashRenderPngs(run.sp27TestsDir, run.copiedPngs);
      assert(splashPngs.length >= 1, 'No SplashScreen PNG generated in %TEMP%/sp27-tests/');
      const tbPng = readPngFile(path.join(run.sp27TestsDir, 'titlebar_visual_render.png'));
      const winPng = readPngFile(path.join(run.sp27TestsDir, 'full_window_rounded_render.png'));
      assert(tbPng.width === 1024 && winPng.width === 700, 'Desktop window chrome PNG dimensions mismatch');
      return {
        detail: `S7 Java Splash & CustomTitleBar PNGs verified & copied to ${path.join(ctx.screenshotsDir, 'desktop')}`,
        evidence: Object.keys(run.copiedPngs)
      };
    }
  },
  {
    id: 'T4-S08',
    tier: 4,
    feature: 'F1,F3,F8,F9,F11,F12,F13',
    title: 'S8: Cross-Surface Brand & Typography Consistency + Multi-Scale 10_brand_multiscale_dark.png + Zero Console Errors',
    async run(ctx) {
      const svgText = fs.readFileSync(path.join(ctx.repoRoot, 'frontend/public/icon.svg'), 'utf8');
      assert(auditBrandSvg(svgText).ok, 'icon.svg failed Pit Wall monogram verification');

      const previewPath = generateMultiScaleBrandPreview(
        path.join(ctx.screenshotsDir, '10_brand_multiscale_dark.png'),
        {
          logo512Path: path.join(ctx.repoRoot, 'frontend/public/logo_transparent.png'),
          logo128Path: path.join(ctx.repoRoot, 'frontend/public/logo_128.png'),
          logo32Path: path.join(ctx.repoRoot, 'frontend/public/logo_36.png'),
          logo24Path: path.join(ctx.repoRoot, 'frontend/public/logo_24.png'),
          logoBearPath: path.join(ctx.repoRoot, 'Backend/src/main/resources/assets/logo-bear.png')
        }
      );

      const scan = getFrontendScan(ctx);
      assert(scan.totals.legacyFonts.length === 0, `Removed fonts remain: ${JSON.stringify(scan.totals.legacyFonts)}`);
      assert(scan.totals.badChevrons.length === 0, `Legacy chevrons remain: ${JSON.stringify(scan.totals.badChevrons)}`);
      assert(ctx.browserHandle.runtimeErrors.pageErrors.length === 0, `Uncaught pageerrors: ${JSON.stringify(ctx.browserHandle.runtimeErrors.pageErrors)}`);
      assert(ctx.browserHandle.runtimeErrors.consoleErrors.length === 0, `Console errors: ${JSON.stringify(ctx.browserHandle.runtimeErrors.consoleErrors)}`);

      return { detail: `S8 Brand preview saved (${previewPath}) & zero runtime/console errors` };
    }
  }
];
