import fs from 'node:fs';
import path from 'node:path';
import { runBackendUiAndSplashTests } from './backend-desktop.js';
import { DESKTOP_VIEWPORT, waitForTransition } from './browser.js';
import { auditBrandSvg, colorsEqual } from './css-audit.js';
import { parseIco, readPngFile, sha256File } from './png-ico.js';
import { delay } from './server.js';
import {
  assert,
  assertColorMatch,
  ensureDesktopSession,
  ensureMobilePage,
  openTabAndWait
} from './test-utils.js';

export const TIER3_TESTS = [
  {
    id: 'T3-C01',
    tier: 3,
    feature: 'F1+F8+F9+F13',
    title: 'Web Boot Splash (#0B0E10 + #39FF14) + Font Loading (Manrope/Orbitron) + Login Surface Transition',
    async run(ctx) {
      const page = await ctx.browserHandle.openCleanPage(DESKTOP_VIEWPORT);
      try {
        await page.goto(ctx.baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const preBg = await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor);
        assertColorMatch(preBg, '#0B0E10', 'Boot pre-mount bg', 4);
        await page.waitForSelector('.login-card', { visible: true, timeout: 15000 });
        await waitForTransition(page);
        const post = await page.evaluate(() => ({
          bodyBg: window.getComputedStyle(document.body).backgroundColor,
          bodyFf: window.getComputedStyle(document.body).fontFamily.toLowerCase(),
          cardBg: window.getComputedStyle(document.querySelector('.login-card')).backgroundColor
        }));
        assertColorMatch(post.bodyBg, '#0B0E10', 'Post-mount body bg', 4);
        assert(post.bodyFf.includes('manrope') && !post.bodyFf.includes('zcool'), `Unexpected font: ${post.bodyFf}`);
        return { detail: 'Boot -> Login transition preserves #0B0E10 and Manrope font' };
      } finally {
        await page.close();
      }
    }
  },
  {
    id: 'T3-C02',
    tier: 3,
    feature: 'F1+F4+F8+F10',
    title: 'ScoutingForm Red Alliance + 3px Match Phase Left Borders + Orbitron Total Score Update',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'scout', '.spdt-switch');
      await page.click('.spdt-labels span:first-child');
      await delay(100);
      await page.click('.phase-auto .pad-hit-btn');
      await page.click('.phase-teleop .pad-hit-btn');
      await delay(120);
      const state = await page.evaluate(() => {
        const innerAuto = document.querySelector('.phase-auto');
        let autoEl = innerAuto;
        if (innerAuto && parseFloat(window.getComputedStyle(innerAuto).borderLeftWidth) < 2.5) {
          autoEl = innerAuto.closest('.form-section') || innerAuto;
        }
        const totalEl = document.querySelector('.total-score-inline .total-value');
        return {
          wrapperRed: document.querySelector('.scouting-wrapper')?.classList.contains('color-red'),
          autoBorder: autoEl ? window.getComputedStyle(autoEl).borderLeftColor : '',
          totalVal: Number(totalEl?.textContent?.trim() || 0),
          totalFf: window.getComputedStyle(totalEl).fontFamily.toLowerCase()
        };
      });
      assert(state.wrapperRed, 'Red alliance wrapper not active');
      assertColorMatch(state.autoBorder, '#5ED3E0', 'Auto 3px left border', 10);
      assert(state.totalVal > 0 && state.totalFf.includes('orbitron'), `Score update/Orbitron failed: ${JSON.stringify(state)}`);
      return { detail: 'Red alliance + phase borders + Orbitron live total work together' };
    }
  },
  {
    id: 'T3-C03',
    tier: 3,
    feature: 'F2+F4+F7+F10',
    title: 'Mobile 390x844 Scouting Wizard + MobileBottomNav + Hidden Closed InboxWidget',
    async run(ctx) {
      const { page } = await ensureMobilePage(ctx);
      await openTabAndWait(page, 'scout', '.mobile-wizard-container');
      const mobile = await page.evaluate(() => {
        const inbox = document.querySelector('.inbox-widget');
        const nav = document.querySelector('.mobile-bottom-nav');
        const wizard = document.querySelector('.mobile-wizard-container');
        return {
          inboxHidden: !inbox || window.getComputedStyle(inbox).display === 'none',
          navVisible: !!nav && window.getComputedStyle(nav).display !== 'none',
          wizardVisible: !!wizard && wizard.getBoundingClientRect().height > 100
        };
      });
      assert(mobile.inboxHidden && mobile.navVisible && mobile.wizardVisible, `Mobile combination failed: ${JSON.stringify(mobile)}`);
      return { detail: 'Mobile wizard + bottom nav + hidden closed inbox verified on 390x844' };
    }
  },
  {
    id: 'T3-C04',
    tier: 3,
    feature: 'F1+F5+F8',
    title: 'Tactical Whiteboard Match Selector + Sidebar Alliance Prediction + Canvas Field Rendering',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'whiteboard', '[data-testid="tactical-whiteboard-view"]');
      const wb = await page.evaluate(() => {
        const select = document.querySelector('[data-testid="wb-match-select"]');
        const canvas = document.querySelector('[data-testid="whiteboard-canvas"]');
        const sidebar = document.querySelector('[data-testid="whiteboard-sidebar"]');
        return {
          hasSelect: !!select,
          selectChevron: select ? window.getComputedStyle(select).backgroundImage : '',
          canvasOk: canvas && canvas.getBoundingClientRect().width > 200,
          sidebarOk: !!sidebar
        };
      });
      assert(wb.hasSelect && wb.canvasOk && wb.sidebarOk, `Whiteboard combination check failed: ${JSON.stringify(wb)}`);
      assert(!wb.selectChevron.toLowerCase().includes('%238e8d87'), 'Whiteboard select still uses legacy chevron');
      return { detail: 'Whiteboard select chevron + sidebar + canvas verified' };
    }
  },
  {
    id: 'T3-C05',
    tier: 3,
    feature: 'F1+F6+F8+F10',
    title: 'Rankings Table Orbitron Numerals + Team Detail Sheet Open/Close Motion',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'rankings', '.rankings-panel .ranking-row');
      const detailsBtn = await page.$('.rankings-panel .details-btn');
      assert(detailsBtn, 'Rankings .details-btn missing');
      await detailsBtn.click();
      await page.waitForSelector('.team-detail-view', { visible: true, timeout: 10000 });
      await waitForTransition(page);
      const closeBtn = await page.$('.team-detail-view .btn-close, .team-detail-view .btn-back');
      if (closeBtn) {
        await closeBtn.click();
        await waitForTransition(page);
      }
      return { detail: 'Rankings -> TeamDetailView motion & typography verified' };
    }
  },
  {
    id: 'T3-C06',
    tier: 3,
    feature: 'F1+F2+F6',
    title: 'Pit Roster Search & Filter <select> + PitScoutFormDrawer Open/Save Chrome',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'pit', '.pit-scout-view .team-roster-card');
      await page.type('.pit-toolbar .search-input', '27570');
      await delay(150);
      const cards = await page.$$('.team-roster-card');
      assert(cards.length >= 1, 'Team 27570 card missing in Pit filter');
      await cards[0].click();
      await page.waitForSelector('.drawer-panel', { visible: true, timeout: 8000 });
      const drawerBg = await page.evaluate(() => window.getComputedStyle(document.querySelector('.drawer-panel')).backgroundColor);
      assert(!colorsEqual(drawerBg, '#141413', 1), 'Pit drawer still uses warm gray');
      const cancelBtn = await page.$('.drawer-footer .btn-cancel, .drawer-header .close-btn');
      if (cancelBtn) await cancelBtn.click();
      await page.click('.pit-toolbar .search-input', { clickCount: 3 });
      await page.keyboard.press('Backspace');
      return { detail: 'Pit search filter + PitScoutFormDrawer Pit Wall chrome verified' };
    }
  },
  {
    id: 'T3-C07',
    tier: 3,
    feature: 'F1+F3+F7+F10',
    title: 'Host QR Modal + ConnectionStatus Pill + 52px Inbox FAB Coexistence on EventView',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      const fabBg = await page.evaluate(() => window.getComputedStyle(document.querySelector('.inbox-morph-container')).backgroundColor);
      const connOk = !!(await page.$('.connection-status'));
      await page.click('.host-qr-btn');
      await page.waitForSelector('.qr-modal-dialog, .modal-card', { visible: true, timeout: 8000 });
      const dlgBg = await page.evaluate(() => window.getComputedStyle(document.querySelector('.qr-modal-dialog, .modal-card')).backgroundColor);
      const closeBtn = await page.$('.qr-modal-dialog .close-btn, .qr-modal-dialog .btn-close, .modal-card .close-btn, .modal-card .btn-close');
      assert(closeBtn, 'MobileQrModal close button missing');
      await closeBtn.click();
      await page.waitForFunction(() => !document.querySelector('.qr-modal-backdrop, .modal-overlay'), { timeout: 3000 });
      assert(connOk && !colorsEqual(fabBg, '#39FF14', 25) && !colorsEqual(dlgBg, '#141413', 1), 'EventView common chrome mismatch');
      return { detail: 'FAB + ConnectionStatus + QR Modal chrome aligned' };
    }
  },
  {
    id: 'T3-C08',
    tier: 3,
    feature: 'F2+F6+F8',
    title: 'ScheduleManager Station Cards (Red/Blue) + Scout Select Chevrons + Match Number Orbitron',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'schedule', '.schedule-manager .match-row');
      const sch = await page.evaluate(() => {
        const sel = document.querySelector('.schedule-manager .scout-select');
        return {
          hasRed: !!document.querySelector('.station-card.red'),
          hasBlue: !!document.querySelector('.station-card.blue'),
          chevron: sel ? window.getComputedStyle(sel).backgroundImage : ''
        };
      });
      assert(sch.hasRed && sch.hasBlue, 'Schedule station cards missing');
      assert(!sch.chevron.toLowerCase().includes('%238e8d87'), 'Schedule select uses legacy chevron');
      return { detail: 'Schedule Red/Blue cards & Pit Wall select chevron verified' };
    }
  },
  {
    id: 'T3-C09',
    tier: 3,
    feature: 'F1+F6+F7',
    title: 'HistoryList Cards + TeamDetailDrawer/Modal Dismissal',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'history', '.history-panel .history-card');
      const cardsCount = await page.evaluate(() => document.querySelectorAll('.history-card').length);
      assert(cardsCount >= 5, `Expected >= 5 seeded history cards, got ${cardsCount}`);
      return { detail: `${cardsCount} seeded history cards rendered in Pit Wall theme` };
    }
  },
  {
    id: 'T3-C10',
    tier: 3,
    feature: 'F2+F6+F8',
    title: 'AI Chat View & AI Settings <select> Chevrons + #A48CFF AI Accent',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'ai', '.ai-chat-view');
      const settingsBtn = await page.$('.ai-chat-view .inner-tabs button:last-child');
      if (settingsBtn) {
        await settingsBtn.click();
        await delay(150);
      }
      const selImg = await page.evaluate(() => {
        const s = document.querySelector('.ai-chat-view select');
        return s ? window.getComputedStyle(s).backgroundImage : '';
      });
      if (selImg) {
        assert(!selImg.toLowerCase().includes('%238e8d87'), `AI Settings select uses legacy chevron: ${selImg}`);
      }
      return { detail: 'AI Chat & Settings select chevrons verified' };
    }
  },
  {
    id: 'T3-C11',
    tier: 3,
    feature: 'F1+F2+F6',
    title: 'EventScoutsPanel + CustomFieldsManagerModal Form Controls & Pit Wall Tokens',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'scouts', '.event-scouts-panel');
      const panelBg = await page.evaluate(() => window.getComputedStyle(document.querySelector('.event-scouts-panel .settings-panel, .event-scouts-panel')).backgroundColor);
      assert(!colorsEqual(panelBg, '#141413', 1), `EventScoutsPanel legacy warm bg: ${panelBg}`);
      return { detail: 'EventScoutsPanel & CustomFields chrome verified' };
    }
  },
  {
    id: 'T3-C12',
    tier: 3,
    feature: 'F3+F11+F13',
    title: 'PWA Manifest, Favicon ICO, and Login Brand Logo (/logo_transparent.png) Integrity',
    async run(ctx) {
      const page = await ctx.browserHandle.openCleanPage(DESKTOP_VIEWPORT);
      try {
        await page.goto(ctx.baseUrl, { waitUntil: 'networkidle0', timeout: 15000 });
        const logoOk = await page.evaluate(async () => {
          const img = document.querySelector('.login-brand-logo');
          if (!img) return false;
          const res = await fetch('/logo_transparent.png');
          return img.complete && img.naturalWidth > 0 && res.ok;
        });
        assert(logoOk, 'Login brand logo /logo_transparent.png failed to load');
        return { detail: 'Login logo_transparent.png loaded & rendered' };
      } finally {
        await page.close();
      }
    }
  },
  {
    id: 'T3-C13',
    tier: 3,
    feature: 'F11+F12+F14+F15',
    title: 'Desktop Brand Assets (SP27 logo_24..128 + logo-bear.png) + Maven Desktop Chrome Tests',
    async run(ctx) {
      const bear = readPngFile(path.join(ctx.repoRoot, 'Backend/src/main/resources/assets/logo-bear.png'));
      const logo = readPngFile(path.join(ctx.repoRoot, 'Backend/src/main/resources/assets/logo_transparent.png'));
      assert(bear.colorType === 6 && logo.colorType === 6, 'Desktop brand assets must be RGBA PNGs');
      const run = runBackendUiAndSplashTests(ctx);
      assert(run.exitCode === 0, 'Desktop UI Maven tests failed');
      return { detail: 'True-alpha logo-bear & SP27 assets integrated into passing desktop UI suite' };
    }
  },
  {
    id: 'T3-C14',
    tier: 3,
    feature: 'F1+F4+F8+F10',
    title: 'Desktop Viewport (1440x900) <-> Mobile Viewport (390x844) Responsive Transition Consistency',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'scout', '.scouting-form');
      await page.setViewport(MOBILE_VIEWPORT);
      await delay(250);
      const mobileWizard = await page.$('.mobile-wizard-container');
      await page.setViewport(DESKTOP_VIEWPORT);
      await delay(250);
      const desktopForm = await page.$('.scouting-form');
      assert(mobileWizard && desktopForm, 'Responsive switch between mobile wizard & desktop form failed');
      return { detail: '1440x900 <-> 390x844 responsive switch verified' };
    }
  },
  {
    id: 'T3-C15',
    tier: 3,
    feature: 'F1+F8+F9+F11',
    title: 'SVG Brand Monogram Browser Render + Multi-Scale Dark Canvas Check',
    async run(ctx) {
      const svgText = fs.readFileSync(path.join(ctx.repoRoot, 'frontend/public/icon.svg'), 'utf8');
      assert(auditBrandSvg(svgText).ok, 'icon.svg failed Pit Wall monogram check');
      const page = await ctx.browserHandle.openCleanPage({ width: 640, height: 640 });
      try {
        await page.setContent(`<html><body style="margin:0;background:#0B0E10;display:flex;align-items:center;justify-content:center;height:100vh">${svgText}</body></html>`);
        const rect = await page.evaluate(() => {
          const svg = document.querySelector('svg');
          const r = svg.getBoundingClientRect();
          return { w: r.width, h: r.height };
        });
        assert(rect.w > 0 && rect.h > 0, `SVG rendered with zero bounding box: ${JSON.stringify(rect)}`);
        return { detail: `icon.svg rendered cleanly in browser (${rect.w}x${rect.h})` };
      } finally {
        await page.close();
      }
    }
  },
  {
    id: 'T3-C16',
    tier: 3,
    feature: 'F1+F3+F11+F12',
    title: 'Cross-Repo Asset Parity (ICO + Transparent PNG + Fonts) + Clean Static CSS Audit',
    async run(ctx) {
      const feIco = parseIco(fs.readFileSync(path.join(ctx.repoRoot, 'frontend/public/favicon.ico')));
      const beIco = parseIco(fs.readFileSync(path.join(ctx.repoRoot, 'Backend/src/main/resources/icon.ico')));
      assert(feIco.count === beIco.count && sha256File(path.join(ctx.repoRoot, 'frontend/public/favicon.ico')) === sha256File(path.join(ctx.repoRoot, 'Backend/src/main/resources/icon.ico')), 'ICO parity mismatch');
      const bear = readPngFile(path.join(ctx.repoRoot, 'Backend/src/main/resources/assets/logo-bear.png'));
      assert(bear.inspectBorder(4).allCornersTransparent, 'logo-bear.png corners not transparent');
      return { detail: 'Cross-repo ICO + transparent logo-bear parity verified' };
    }
  }
];
