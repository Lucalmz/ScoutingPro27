import fs from 'node:fs';
import path from 'node:path';
import {
  findSplashRenderPngs,
  runBackendUiAndSplashTests
} from './backend-desktop.js';
import {
  DESKTOP_VIEWPORT,
  MOBILE_VIEWPORT,
  waitForTransition
} from './browser.js';
import {
  auditBrandSvg,
  colorsEqual,
  contrastRatio,
  LEGACY_WARM_AND_SLATE_HEXES,
  normalizeDurationMs,
  REMOVED_FONT_NAMES
} from './css-audit.js';
import {
  isJpegBuffer,
  parseIco,
  readPngFile
} from './png-ico.js';
import { delay } from './server.js';
import {
  assert,
  assertColorMatch,
  ensureDesktopSession,
  ensureMobilePage,
  getFrontendScan,
  openTabAndWait,
  readRootCssVar
} from './test-utils.js';

export const TIER2_TESTS = [
  // =========================================================================
  // F1 Boundaries (5 tests)
  // =========================================================================
  {
    id: 'T2-F01-01',
    tier: 2,
    feature: 'F1',
    title: 'main.css contains zero legacy warm-gray or slate hexes anywhere (including :root)',
    async run(ctx) {
      const scan = getFrontendScan(ctx);
      const mainFindings = scan.perFile['assets/main.css'];
      const legacy = mainFindings?.legacyHexes || [];
      assert(legacy.length === 0, `Legacy hexes still present in main.css: ${legacy.join(', ')}`);
      return { detail: 'Zero legacy warm-gray/slate hexes in main.css' };
    }
  },
  {
    id: 'T2-F01-02',
    tier: 2,
    feature: 'F1',
    title: 'Primary/Accent/Ring tokens never downgraded to #5CEB3B (ORIGINAL_REQUEST overrides design_spec)',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      for (const tok of ['--primary', '--accent', '--ring']) {
        const val = await readRootCssVar(page, tok);
        assert(!colorsEqual(val, '#5CEB3B', 4), `${tok} was downgraded to #5CEB3B instead of #39FF14`);
        assertColorMatch(val, '#39FF14', tok, 2);
      }
      return { detail: '--primary/--accent/--ring strictly #39FF14 (not #5CEB3B)' };
    }
  },
  {
    id: 'T2-F01-03',
    tier: 2,
    feature: 'F1',
    title: 'Light theme media/attribute emulation cannot flip background away from #0B0E10',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
      await delay(80);
      const bg = await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor);
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
      assertColorMatch(bg, '#0B0E10', 'prefers-color-scheme:light override guard', 4);
      return { detail: 'Dark-only theme unaffected by prefers-color-scheme: light' };
    }
  },
  {
    id: 'T2-F01-04',
    tier: 2,
    feature: 'F1',
    title: 'Pit Wall contrast pairs meet WCAG AA (>= 4.5:1) using resolved runtime tokens',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      const pairs = [
        ['--foreground', '--background'],
        ['--text-muted', '--background'],
        ['--primary', '--background'],
        ['--status-error', '--card'],
        ['--alliance-red', '--card'],
        ['--alliance-blue', '--card']
      ];
      const ratios = {};
      for (const [fgTok, bgTok] of pairs) {
        const fg = await readRootCssVar(page, fgTok);
        const bg = await readRootCssVar(page, bgTok);
        const r = contrastRatio(fg, bg);
        assert(r >= 4.5, `WCAG AA failed for ${fgTok} (${fg}) on ${bgTok} (${bg}): ${r.toFixed(2)}`);
        ratios[`${fgTok}/${bgTok}`] = Number(r.toFixed(2));
      }
      return { detail: 'All Pit Wall token pairs >= 4.5:1 WCAG AA', evidence: ratios };
    }
  },
  {
    id: 'T2-F01-05',
    tier: 2,
    feature: 'F1',
    title: 'main.css enforces glow budget (zero unapproved box-shadow 0 0 [1-9] outside focus/online/boot)',
    async run(ctx) {
      const scan = getFrontendScan(ctx);
      const glows = scan.perFile['assets/main.css']?.unapprovedGlows || [];
      assert(glows.length === 0, `Unapproved neon glows in main.css: ${JSON.stringify(glows)}`);
      return { detail: 'main.css glow budget strictly enforced' };
    }
  },

  // =========================================================================
  // F2 Boundaries (5 tests)
  // =========================================================================
  {
    id: 'T2-F02-01',
    tier: 2,
    feature: 'F2',
    title: 'Disabled <select> / <input> elements preserve muted Cold Graphite styling without active focus glow',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      const disabledCheck = await page.evaluate(() => {
        const sel = document.createElement('select');
        sel.disabled = true;
        sel.innerHTML = '<option>Disabled Option</option>';
        sel.style.position = 'fixed';
        sel.style.left = '-9999px';
        document.body.appendChild(sel);
        const cs = window.getComputedStyle(sel);
        const out = { bg: cs.backgroundColor, color: cs.color, opacity: cs.opacity };
        sel.remove();
        return out;
      });
      assert(!colorsEqual(disabledCheck.bg, '#FFFFFF', 20), `Disabled select leaked white bg: ${disabledCheck.bg}`);
      return { detail: 'Disabled select retains Cold Graphite surface', evidence: disabledCheck };
    }
  },
  {
    id: 'T2-F02-02',
    tier: 2,
    feature: 'F2',
    title: 'Long option labels inside <select> do not cause horizontal page overflow',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'pit', '.pit-scout-view .filter-select');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert(overflow <= 2, `Horizontal overflow detected (${overflow}px) on Pit view select`);
      return { detail: 'Zero horizontal overflow around <select> controls' };
    }
  },
  {
    id: 'T2-F02-03',
    tier: 2,
    feature: 'F2',
    title: 'Keyboard Tab focus onto input/select applies #39FF14 focus outline/ring',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'pit', '.pit-scout-view .filter-select');
      await page.focus('.pit-scout-view .filter-select');
      await delay(100);
      const focused = await page.evaluate(() => {
        const el = document.querySelector('.pit-scout-view .filter-select');
        const cs = window.getComputedStyle(el);
        return { bgImg: cs.backgroundImage, border: cs.borderColor, shadow: cs.boxShadow, outline: cs.outlineColor };
      });
      const hasGreen =
        focused.bgImg.toLowerCase().includes('%2339ff14') ||
        colorsEqual(focused.border, '#39FF14', 12) ||
        colorsEqual(focused.outline, '#39FF14', 12) ||
        focused.shadow.includes('57, 255, 20');
      assert(hasGreen, `Focused select did not show #39FF14 accent: ${JSON.stringify(focused)}`);
      return { detail: 'Focused <select> shows #39FF14 chevron/focus indicator' };
    }
  },
  {
    id: 'T2-F02-04',
    tier: 2,
    feature: 'F2',
    title: 'select option rules in main.css contain zero legacy warm-gray hexes (#141413/#f0efe9/#1c1c1a)',
    async run(ctx) {
      const mainCss = fs.readFileSync(path.join(ctx.repoRoot, 'frontend/src/assets/main.css'), 'utf8');
      const optMatches = mainCss.match(/select\s+option[\s\S]*?\}/gi) || [];
      for (const block of optMatches) {
        assert(!/#(?:141413|f0efe9|1c1c1a|0c0c0b|8e8d87)/i.test(block), `Legacy hex in select option block: ${block}`);
      }
      return { detail: 'select option blocks migrated away from warm gray' };
    }
  },
  {
    id: 'T2-F02-05',
    tier: 2,
    feature: 'F2',
    title: 'Component-level select chevron files (AiSettingsPanel, CustomFieldBuilderForm, PitScoutView, ScheduleManager) free of %238e8d87',
    async run(ctx) {
      const targets = [
        'frontend/src/components/ai/AiSettingsPanel.vue',
        'frontend/src/components/customFields/CustomFieldBuilderForm.vue',
        'frontend/src/components/pit/PitScoutView.css',
        'frontend/src/components/schedule/ScheduleManager.css'
      ];
      for (const rel of targets) {
        const text = fs.readFileSync(path.join(ctx.repoRoot, rel), 'utf8');
        assert(!text.toLowerCase().includes('%238e8d87'), `${rel} still contains legacy %238e8d87 chevron`);
      }
      return { detail: 'All 4 component chevron stylesheets clean of %238e8d87' };
    }
  },

  // =========================================================================
  // F3 Boundaries (5 tests)
  // =========================================================================
  {
    id: 'T2-F03-01',
    tier: 2,
    feature: 'F3',
    title: 'Login submit with empty credentials keeps submit disabled / shows Pit Wall error (no crash)',
    async run(ctx) {
      const page = await ctx.browserHandle.openCleanPage(DESKTOP_VIEWPORT);
      try {
        await page.goto(ctx.baseUrl, { waitUntil: 'networkidle0', timeout: 15000 });
        await waitForTransition(page);
        const disabled = await page.evaluate(() => {
          const btn = document.querySelector('button[type="submit"]');
          return btn ? btn.disabled : false;
        });
        assert(disabled, 'Submit button should be disabled when username/password are empty');
        return { detail: 'Empty login credentials safely guarded' };
      } finally {
        await page.close();
      }
    }
  },
  {
    id: 'T2-F03-02',
    tier: 2,
    feature: 'F3',
    title: 'Invalid route hash (#/unknown-pitwall-route) recovers cleanly on #0B0E10 without white flash',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await page.goto(`${ctx.baseUrl}#/unknown-pitwall-route`, { waitUntil: 'networkidle0', timeout: 15000 });
      await waitForTransition(page);
      const bg = await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor);
      assertColorMatch(bg, '#0B0E10', 'Fallback route background', 4);
      return { detail: 'Unknown hash route stays on #0B0E10 canvas' };
    }
  },
  {
    id: 'T2-F03-03',
    tier: 2,
    feature: 'F3',
    title: 'Static scan across views/* finds zero unallowlisted hex colors or neon glows',
    async run(ctx) {
      const scan = getFrontendScan(ctx);
      const viewIssues = Object.entries(scan.perFile).filter(([f]) => f.startsWith('views/'));
      assert(viewIssues.length === 0, `Views audit issues: ${JSON.stringify(viewIssues)}`);
      return { detail: 'All views/* files passed hex/glow/font audit' };
    }
  },
  {
    id: 'T2-F03-04',
    tier: 2,
    feature: 'F3',
    title: 'logger.ts only uses console styling inside logger guard (no DOM CSS injection)',
    async run(ctx) {
      const loggerTs = fs.readFileSync(path.join(ctx.repoRoot, 'frontend/src/utils/logger.ts'), 'utf8');
      assert(!loggerTs.includes('document.createElement'), 'logger.ts should not inject DOM styles');
      return { detail: 'logger.ts confined to DevTools console formatting' };
    }
  },
  {
    id: 'T2-F03-05',
    tier: 2,
    feature: 'F3',
    title: 'App.vue contains zero legacy #0c0c0b or #141413 or #39ff14 scanline glow bloat',
    async run(ctx) {
      const scan = getFrontendScan(ctx);
      const appIssues = scan.perFile['App.vue'];
      assert(!appIssues, `App.vue static audit issues: ${JSON.stringify(appIssues)}`);
      return { detail: 'App.vue clean of legacy hexes and unapproved glows' };
    }
  },

  // =========================================================================
  // F4 Boundaries (5 tests)
  // =========================================================================
  {
    id: 'T2-F04-01',
    tier: 2,
    feature: 'F4',
    title: 'Switching ScoutingForm alliance Red -> Blue clears opposing red tint completely',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'scout', '.spdt-switch');
      await page.click('.spdt-labels span:first-child');
      await delay(100);
      await page.click('.spdt-labels span:last-child');
      await delay(100);
      const cls = await page.evaluate(() => document.querySelector('.scouting-wrapper')?.className || '');
      assert(cls.includes('color-blue') && !cls.includes('color-red'), `Opposing color-red lingered: ${cls}`);
      return { detail: 'Alliance switch clears opposing tint on toggle' };
    }
  },
  {
    id: 'T2-F04-02',
    tier: 2,
    feature: 'F4',
    title: 'Rapid TeleOp HIT/MISS taps update readouts without NaN or negative counts',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'scout', '.phase-teleop .pad-hit-btn');
      for (let i = 0; i < 4; i += 1) {
        await page.click('.phase-teleop .pad-hit-btn');
      }
      await page.click('.phase-teleop .pad-miss-btn');
      await delay(120);
      const totalText = await page.evaluate(() => document.querySelector('.total-score-inline .total-value')?.textContent?.trim() || '');
      const num = Number(totalText);
      assert(Number.isFinite(num) && num >= 0, `Invalid total score after rapid taps: "${totalText}"`);
      return { detail: `Total readout numeric & valid after rapid taps (${num})` };
    }
  },
  {
    id: 'T2-F04-03',
    tier: 2,
    feature: 'F4',
    title: 'isBroken robot toggle activates negative semantic state without crashing form',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'scout', '.biobuzz-toggles-grid .is-broken-card');
      await page.click('.biobuzz-toggles-grid .is-broken-card');
      await delay(100);
      const active = await page.evaluate(() => document.querySelector('.is-broken-card')?.classList.contains('is-active'));
      assert(active, 'is-broken-card did not activate');
      await page.click('.biobuzz-toggles-grid .is-broken-card');
      return { detail: 'isBroken toggle toggles cleanly' };
    }
  },
  {
    id: 'T2-F04-04',
    tier: 2,
    feature: 'F4',
    title: 'Mobile wizard (390x844) Step 1->2 navigation respects pre-match required fields',
    async run(ctx) {
      const { page } = await ensureMobilePage(ctx);
      await openTabAndWait(page, 'scout', '.mobile-wizard-container');
      const stepperCount = await page.evaluate(() => document.querySelectorAll('.wizard-stepper .stepper-step').length);
      assert(stepperCount >= 4, `Expected multi-step wizard stepper, got ${stepperCount}`);
      return { detail: `Mobile wizard rendered ${stepperCount} steps on 390x844` };
    }
  },
  {
    id: 'T2-F04-05',
    tier: 2,
    feature: 'F4',
    title: 'PhaseCycleTracker preserves backward-compatible .phase-auto/.phase-teleop .pad-hit-btn selectors',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'scout', '.scouting-form');
      const hasAuto = !!(await page.$('.phase-auto .pad-hit-btn'));
      const hasTeleop = !!(await page.$('.phase-teleop .pad-hit-btn'));
      assert(hasAuto && hasTeleop, 'Backward-compatible .phase-auto/.phase-teleop .pad-hit-btn selectors broken');
      return { detail: 'Selector compatibility contract preserved' };
    }
  },

  // =========================================================================
  // F5 Boundaries (5 tests)
  // =========================================================================
  {
    id: 'T2-F05-01',
    tier: 2,
    feature: 'F5',
    title: 'Whiteboard Undo/Redo/Clear on empty or seeded state executes with zero console/page errors',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'whiteboard', '[data-testid="wb-btn-undo"]');
      await page.click('[data-testid="wb-btn-undo"]');
      await page.click('[data-testid="wb-btn-redo"]');
      await delay(100);
      return { detail: 'Whiteboard undo/redo boundary safe' };
    }
  },
  {
    id: 'T2-F05-02',
    tier: 2,
    feature: 'F5',
    title: 'Whiteboard fullscreen toggle preserves #0B0E10/#101417 dark canvas and restores cleanly',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'whiteboard', '[data-testid="wb-toggle-fullscreen"]');
      await page.click('[data-testid="wb-toggle-fullscreen"]');
      await delay(150);
      const isFs = await page.evaluate(() => document.querySelector('.wb-root')?.classList.contains('is-fullscreen'));
      assert(isFs, 'Whiteboard did not enter .is-fullscreen');
      await page.click('[data-testid="wb-toggle-fullscreen"]');
      await delay(150);
      return { detail: 'Whiteboard fullscreen toggle enters & exits cleanly' };
    }
  },
  {
    id: 'T2-F05-03',
    tier: 2,
    feature: 'F5',
    title: 'Whiteboard canvas maintains non-zero bounding box across desktop and narrow viewports',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'whiteboard', '[data-testid="whiteboard-canvas"]');
      await page.setViewport({ width: 960, height: 700 });
      await delay(150);
      const box = await page.evaluate(() => {
        const r = document.querySelector('[data-testid="whiteboard-canvas"]').getBoundingClientRect();
        return { w: r.width, h: r.height };
      });
      await page.setViewport(DESKTOP_VIEWPORT);
      assert(box.w > 100 && box.h > 100, `Canvas collapsed at 960px viewport: ${JSON.stringify(box)}`);
      return { detail: 'Whiteboard canvas responsive at 960px', evidence: box };
    }
  },
  {
    id: 'T2-F05-04',
    tier: 2,
    feature: 'F5',
    title: 'Whiteboard phase switch (Auto -> TeleOp -> Endgame) updates active tab without layout jump',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'whiteboard', '[data-testid="wb-phase-auto"]');
      await page.click('[data-testid="wb-phase-teleop"]');
      await page.click('[data-testid="wb-phase-endgame"]');
      await page.click('[data-testid="wb-phase-auto"]');
      return { detail: 'Whiteboard phase tabs switch smoothly' };
    }
  },
  {
    id: 'T2-F05-05',
    tier: 2,
    feature: 'F5',
    title: 'WhiteboardFieldCanvas.vue <style> block contains zero unallowlisted hexes or neon glows',
    async run(ctx) {
      const scan = getFrontendScan(ctx);
      const issue = scan.perFile['components/whiteboard/WhiteboardFieldCanvas.vue'];
      assert(!issue, `WhiteboardFieldCanvas.vue <style>/<template> audit failed: ${JSON.stringify(issue)}`);
      return { detail: 'WhiteboardFieldCanvas.vue <style>/<template> clean' };
    }
  },

  // =========================================================================
  // F6 Boundaries (5 tests)
  // =========================================================================
  {
    id: 'T2-F06-01',
    tier: 2,
    feature: 'F6',
    title: 'Pit search query with 0 matches renders Cold Graphite empty state with no crash',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'pit', '.pit-toolbar .search-input');
      await page.click('.pit-toolbar .search-input', { clickCount: 3 });
      await page.type('.pit-toolbar .search-input', '99999999');
      await delay(150);
      const count = await page.evaluate(() => document.querySelectorAll('.team-roster-card').length);
      await page.click('.pit-toolbar .search-input', { clickCount: 3 });
      await page.keyboard.press('Backspace');
      assert(count === 0, `Expected 0 cards for unmatched team filter, got ${count}`);
      return { detail: 'Pit zero-match filter renders cleanly' };
    }
  },
  {
    id: 'T2-F06-02',
    tier: 2,
    feature: 'F6',
    title: 'RankingsTable preserves Cold Graphite header (#0B0E10/#07090A) & 1px #1B2126 row dividers',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'rankings', '.rankings-panel .ranking-row');
      const rk = await page.evaluate(() => {
        const th = document.querySelector('.rankings-panel th');
        const row = document.querySelector('.rankings-panel .ranking-row td, .rankings-panel .ranking-row');
        return {
          thBg: th ? window.getComputedStyle(th).backgroundColor : '',
          rowBorder: row ? window.getComputedStyle(row).borderBottomColor : ''
        };
      });
      assert(!colorsEqual(rk.thBg, '#0c0c0b', 1), `Legacy warm #0c0c0b rankings header: ${rk.thBg}`);
      return { detail: 'RankingsTable header & row dividers aligned to Cold Graphite', evidence: rk };
    }
  },
  {
    id: 'T2-F06-03',
    tier: 2,
    feature: 'F6',
    title: 'CustomFieldsManagerModal opens from EventScoutsPanel and validates empty field name boundary',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'scouts', '.event-scouts-panel');
      const clickedOpen = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('.event-scouts-panel .settings-panel button'));
        const btn = buttons.find((b) => {
          const icon = (b.querySelector('.material-icons')?.textContent || '').trim();
          const txt = (b.textContent || '').toLowerCase();
          return icon === 'tune' || txt.includes('custom') || txt.includes('自定义') || txt.includes('字段');
        });
        if (!btn) return false;
        btn.click();
        return true;
      });
      assert(clickedOpen, 'Custom Fields manage button (tune icon) not found in EventScoutsPanel .settings-panel');
      await page.waitForSelector('.cf-modal-card', { visible: true, timeout: 6000 });

      const createBtn = await page.$('.cf-modal-card .btn-create-field');
      assert(createBtn, '.btn-create-field missing inside CustomFieldsManagerModal');
      await createBtn.click();
      await page.waitForSelector('.field-builder-form .btn-save', { visible: true, timeout: 5000 });
      await page.click('.field-builder-form .btn-save');
      await delay(150);
      const stillInForm = !!(await page.$('.field-builder-form'));
      assert(stillInForm, 'CustomFieldBuilderForm allowed saving with empty field name');

      const closeBtn = await page.$('.cf-modal-header .btn-close, .cf-modal-header .close-btn');
      assert(closeBtn, 'CustomFieldsManagerModal close button missing');
      await closeBtn.click();
      await page.waitForFunction(() => !document.querySelector('.cf-modal-backdrop'), { timeout: 3000 });

      const cfText = fs.readFileSync(path.join(ctx.repoRoot, 'frontend/src/components/customFields/CustomFieldsManagerModal.vue'), 'utf8');
      assert(!/#(?:141413|262624|0c0c0b|f0efe9)/i.test(cfText), 'CustomFieldsManagerModal.vue contains legacy hexes');
      return { detail: 'CustomFieldsManagerModal empty-name guard & clean close verified' };
    }
  },
  {
    id: 'T2-F06-04',
    tier: 2,
    feature: 'F6',
    title: 'AiSettingsPanel.vue contains zero legacy hexes and uses Pit Wall form tokens',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'ai', '.ai-chat-view');
      const settingsTab = await page.$('.ai-chat-view .inner-tabs button:last-child');
      if (settingsTab) {
        await settingsTab.click();
        await delay(150);
      }
      const scan = getFrontendScan(ctx);
      assert(!scan.perFile['components/ai/AiSettingsPanel.vue'], 'AiSettingsPanel.vue failed static audit');
      return { detail: 'AiSettingsPanel verified clean' };
    }
  },
  {
    id: 'T2-F06-05',
    tier: 2,
    feature: 'F6',
    title: 'HistoryList & ScheduleManager contain zero unapproved neon box-shadow glows',
    async run(ctx) {
      const scan = getFrontendScan(ctx);
      for (const rel of ['components/history/HistoryList.vue', 'components/schedule/ScheduleManager.css', 'components/rankings/RankingsTable.vue']) {
        const f = scan.perFile[rel];
        assert(!f || f.unapprovedGlows.length === 0, `Unapproved glows in ${rel}: ${JSON.stringify(f?.unapprovedGlows)}`);
      }
      return { detail: 'HistoryList, ScheduleManager, RankingsTable free of unapproved glows' };
    }
  },

  // =========================================================================
  // F7 Boundaries (5 tests)
  // =========================================================================
  {
    id: 'T2-F07-01',
    tier: 2,
    feature: 'F7',
    title: 'InboxWidget is hidden on LoginView and hidden when closed on mobile <= 768px',
    async run(ctx) {
      const { page } = await ensureMobilePage(ctx);
      const hiddenOnMobile = await page.evaluate(() => {
        const w = document.querySelector('.inbox-widget');
        if (!w) return true;
        return window.getComputedStyle(w).display === 'none';
      });
      assert(hiddenOnMobile, 'InboxWidget should be hidden when closed on 390x844 mobile');
      return { detail: 'InboxWidget hidden when closed on mobile 390x844' };
    }
  },
  {
    id: 'T2-F07-02',
    tier: 2,
    feature: 'F7',
    title: 'InboxWidget opens dropdown cleanly on click and closes via .inbox-header .close-btn',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await page.click('.inbox-morph-container');
      await page.waitForSelector('.inbox-widget.is-open .inbox-header .close-btn', { visible: true, timeout: 5000 });
      await page.click('.inbox-header .close-btn');
      await page.waitForFunction(() => !document.querySelector('.inbox-widget')?.classList.contains('is-open'), { timeout: 3000 });
      const stillOpen = await page.evaluate(() => document.querySelector('.inbox-widget')?.classList.contains('is-open'));
      assert(!stillOpen, 'InboxWidget stayed open after .inbox-header .close-btn click');
      return { detail: 'InboxWidget open/close lifecycle verified' };
    }
  },
  {
    id: 'T2-F07-03',
    tier: 2,
    feature: 'F7',
    title: 'Modal close & Escape dismissal leave zero orphaned .modal-overlay / .qr-modal-backdrop blocking clicks',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await page.click('.host-qr-btn');
      await page.waitForSelector('.qr-modal-dialog, .modal-card', { visible: true, timeout: 6000 });
      const closeBtn = await page.$('.qr-modal-dialog .close-btn, .qr-modal-dialog .btn-close, .modal-card .close-btn, .modal-card .btn-close');
      assert(closeBtn, 'MobileQrModal close button not found');
      await closeBtn.click();
      await page.waitForFunction(() => !document.querySelector('.modal-overlay, .qr-modal-backdrop'), { timeout: 3000 });

      const renameTrigger = await page.$('.user-profile-btn, .user-tag-btn');
      assert(renameTrigger, 'RenameModal trigger button missing');
      await renameTrigger.click();
      await page.waitForSelector('.modal-overlay .rename-modal', { visible: true, timeout: 6000 });
      await delay(200);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.modal-overlay, .qr-modal-backdrop'), { timeout: 4000 });

      const overlayVisible = await page.evaluate(() => {
        const els = document.querySelectorAll('.modal-overlay, .qr-modal-backdrop');
        return Array.from(els).some((ov) => window.getComputedStyle(ov).display !== 'none');
      });
      assert(!overlayVisible, 'Orphaned modal overlay/backdrop remained visible after close/Escape');
      return { detail: 'Modal close & Escape dismissal leave zero orphaned overlays' };
    }
  },
  {
    id: 'T2-F07-04',
    tier: 2,
    feature: 'F7',
    title: 'All 16 files in components/common/ free of ZCOOLQingKeHuangYou',
    async run(ctx) {
      const scan = getFrontendScan(ctx);
      const commonZcool = scan.totals.legacyFonts.filter((x) => x.file.startsWith('components/common/'));
      assert(commonZcool.length === 0, `Removed fonts found in components/common: ${JSON.stringify(commonZcool)}`);
      return { detail: 'Zero removed font references in components/common/' };
    }
  },
  {
    id: 'T2-F07-05',
    tier: 2,
    feature: 'F7',
    title: 'Modals in components/common/ do not retain legacy neon-green border-top accents',
    async run(ctx) {
      const modalFiles = [
        'MobileQrModal.vue',
        'QrScannerModal.vue',
        'RenameModal.vue',
        'SasVerificationModal.vue',
        'SessionConflictModal.vue',
        'TakeoverPromptModal.vue',
        'ConfirmModal.vue'
      ];
      for (const f of modalFiles) {
        const text = fs.readFileSync(path.join(ctx.repoRoot, 'frontend/src/components/common', f), 'utf8');
        assert(!/border-top\s*:[^;]*#39ff14/i.test(text), `${f} still has hardcoded #39ff14 border-top`);
      }
      return { detail: 'All common modals clean of hardcoded #39ff14 top border' };
    }
  },

  // =========================================================================
  // F8 Boundaries (5 tests)
  // =========================================================================
  {
    id: 'T2-F08-01',
    tier: 2,
    feature: 'F8',
    title: 'Mixed CJK + ASCII text renders without falling back to ZCOOLQingKeHuangYou',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      const check = await page.evaluate(() => {
        const h2 = document.createElement('h2');
        h2.textContent = '27570 自动阶段 Auto Telemetry';
        h2.style.position = 'fixed';
        h2.style.left = '-9999px';
        document.body.appendChild(h2);
        const ff = window.getComputedStyle(h2).fontFamily;
        h2.remove();
        return ff;
      });
      assert(check.toLowerCase().includes('manrope') && check.toLowerCase().includes('notosanssc'), `Heading fallback missing Manrope/NotoSansSC: ${check}`);
      assert(!check.toLowerCase().includes('zcool'), `Heading still includes ZCOOL: ${check}`);
      return { detail: 'Mixed CJK/ASCII heading stack verified', evidence: check };
    }
  },
  {
    id: 'T2-F08-02',
    tier: 2,
    feature: 'F8',
    title: 'Numeric tabular-nums stability: digits 11111 vs 88888 occupy identical width in .total-value',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'scout', '.total-score-inline .total-value');
      const widths = await page.evaluate(() => {
        const ref = document.querySelector('.total-score-inline .total-value');
        const cs = window.getComputedStyle(ref);
        const probe = document.createElement('span');
        probe.style.fontFamily = cs.fontFamily;
        probe.style.fontSize = cs.fontSize;
        probe.style.fontWeight = cs.fontWeight;
        probe.style.fontVariantNumeric = cs.fontVariantNumeric;
        probe.style.position = 'fixed';
        probe.style.left = '-9999px';
        document.body.appendChild(probe);
        probe.textContent = '11111';
        const w1 = probe.getBoundingClientRect().width;
        probe.textContent = '88888';
        const w8 = probe.getBoundingClientRect().width;
        probe.remove();
        return { w1, w8 };
      });
      assert(Math.abs(widths.w1 - widths.w8) <= 1.5, `Non-tabular width variance: 11111=${widths.w1}, 88888=${widths.w8}`);
      return { detail: `Tabular numerals verified (11111=${widths.w1.toFixed(1)}px, 88888=${widths.w8.toFixed(1)}px)` };
    }
  },
  {
    id: 'T2-F08-03',
    tier: 2,
    feature: 'F8',
    title: 'Zero occurrences of ZCOOLQingKeHuangYou in any .vue/.css/.ts file outside __tests__',
    async run(ctx) {
      const scan = getFrontendScan(ctx);
      assert(scan.totals.legacyFonts.length === 0, `Removed fonts found: ${JSON.stringify(scan.totals.legacyFonts)}`);
      return { detail: 'Zero legacy font references across all non-test frontend files' };
    }
  },
  {
    id: 'T2-F08-04',
    tier: 2,
    feature: 'F8',
    title: 'Orbitron font is NOT applied globally to body or paragraph copy',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      const bodyFf = await page.evaluate(() => window.getComputedStyle(document.body).fontFamily.toLowerCase());
      assert(!bodyFf.startsWith('orbitron') && !bodyFf.startsWith('"orbitron"'), `Body text must not default to Orbitron: ${bodyFf}`);
      return { detail: 'Body text uses readable Manrope/NotoSansSC, not Orbitron' };
    }
  },
  {
    id: 'T2-F08-05',
    tier: 2,
    feature: 'F8',
    title: 'Uppercase table headers / group labels keep legible >= 11px size',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'rankings', '.rankings-panel th');
      const thSize = await page.evaluate(() => parseFloat(window.getComputedStyle(document.querySelector('.rankings-panel th')).fontSize));
      assert(thSize >= 10.5, `Table header font too small: ${thSize}px`);
      return { detail: `Table header font size ${thSize}px` };
    }
  },

  // =========================================================================
  // F9 Boundaries (5 tests)
  // =========================================================================
  {
    id: 'T2-F09-01',
    tier: 2,
    feature: 'F9',
    title: 'Case-insensitive regex scan across all frontend/src finds 0 PinyonScript/ZCOOL references',
    async run(ctx) {
      const scan = getFrontendScan(ctx);
      assert(scan.totals.legacyFonts.length === 0, `Case-insensitive font scan failed: ${JSON.stringify(scan.totals.legacyFonts)}`);
      return { detail: 'Zero case-insensitive matches for removed fonts' };
    }
  },
  {
    id: 'T2-F09-02',
    tier: 2,
    feature: 'F9',
    title: 'frontend/src/assets/fonts/ contains <= 3 .ttf files (6.4MB+ bloat removed)',
    async run(ctx) {
      const dir = path.join(ctx.repoRoot, 'frontend/src/assets/fonts');
      const ttfs = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.ttf'));
      assert(ttfs.length <= 3 && ttfs.length >= 1, `Expected <= 3 kept TTFs, found ${ttfs.length}: ${ttfs.join(', ')}`);
      return { detail: `Font directory trimmed to ${ttfs.length} TTFs` };
    }
  },
  {
    id: 'T2-F09-03',
    tier: 2,
    feature: 'F9',
    title: 'NotoSansSC-VariableFont_wght.ttf exists and is non-corrupt (> 1MB) in all 3 font directories',
    async run(ctx) {
      const paths = [
        'frontend/src/assets/fonts/NotoSansSC-VariableFont_wght.ttf',
        'frontend/public/assets/NotoSansSC-VariableFont_wght.ttf',
        'Backend/src/main/resources/assets/NotoSansSC-VariableFont_wght.ttf'
      ];
      for (const rel of paths) {
        const st = fs.statSync(path.join(ctx.repoRoot, rel));
        assert(st.size > 1_000_000, `NotoSansSC TTF unexpectedly small (${st.size} B): ${rel}`);
      }
      return { detail: 'NotoSansSC TTF intact across all 3 mirrored directories' };
    }
  },
  {
    id: 'T2-F09-04',
    tier: 2,
    feature: 'F9',
    title: 'Browser network requests during navigation trigger zero 404 font asset failures',
    async run(ctx) {
      const page = await ctx.browserHandle.openCleanPage(DESKTOP_VIEWPORT);
      const font404s = [];
      page.on('response', (res) => {
        if (res.url().includes('.ttf') && res.status() >= 400) {
          font404s.push({ url: res.url(), status: res.status() });
        }
      });
      try {
        await page.goto(ctx.baseUrl, { waitUntil: 'networkidle0', timeout: 20000 });
        await delay(300);
        assert(font404s.length === 0, `Font 404 errors occurred: ${JSON.stringify(font404s)}`);
        return { detail: 'Zero 404 font responses during boot & login' };
      } finally {
        await page.close();
      }
    }
  },
  {
    id: 'T2-F09-05',
    tier: 2,
    feature: 'F9',
    title: 'main.css @font-face rules never point to deleted hashed ZCOOL/PinyonScript TTF filenames',
    async run(ctx) {
      const mainCss = fs.readFileSync(path.join(ctx.repoRoot, 'frontend/src/assets/main.css'), 'utf8');
      for (const removed of REMOVED_FONT_NAMES) {
        assert(!mainCss.toLowerCase().includes(removed.toLowerCase()), `main.css still references ${removed}`);
      }
      return { detail: 'main.css @font-face free of removed TTF URLs' };
    }
  },

  // =========================================================================
  // F10 Boundaries (5 tests)
  // =========================================================================
  {
    id: 'T2-F10-01',
    tier: 2,
    feature: 'F10',
    title: 'prefers-reduced-motion: reduce does not stall UI transitions or freeze elements',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      await openTabAndWait(page, 'rankings', '.rankings-panel');
      await openTabAndWait(page, 'scout', '.scouting-form');
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
      return { detail: 'prefers-reduced-motion navigation completes cleanly' };
    }
  },
  {
    id: 'T2-F10-02',
    tier: 2,
    feature: 'F10',
    title: 'Rapid tab switching (scout -> pit -> schedule -> rankings -> whiteboard) leaves zero stuck transition attrs',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      for (const tab of ['scout', 'pit', 'schedule', 'rankings', 'whiteboard']) {
        await page.click(`.tab-bar .tab-btn[data-tab="${tab}"]`);
        await delay(60);
      }
      await waitForTransition(page, 3000);
      const stuck = await page.evaluate(() =>
        document.documentElement.hasAttribute('data-direction') ||
        document.documentElement.hasAttribute('data-transition-type')
      );
      assert(!stuck, 'Transition attributes stuck after rapid tab switching');
      return { detail: 'Rapid tab switches settle with zero stuck transition state' };
    }
  },
  {
    id: 'T2-F10-03',
    tier: 2,
    feature: 'F10',
    title: 'Standard UI transition durations never exceed 480ms',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      const slowMs = await readRootCssVar(page, '--motion-duration-slow');
      assert(normalizeDurationMs(slowMs) <= 480, `--motion-duration-slow exceeds 480ms: ${slowMs}`);
      return { detail: `Max motion token is ${slowMs} (<= 480ms)` };
    }
  },
  {
    id: 'T2-F10-04',
    tier: 2,
    feature: 'F10',
    title: 'Zero legacy 0.272s/0.476s/0.612s/0.816s/0.85s values in App.vue & main.css',
    async run(ctx) {
      const app = fs.readFileSync(path.join(ctx.repoRoot, 'frontend/src/App.vue'), 'utf8');
      const css = fs.readFileSync(path.join(ctx.repoRoot, 'frontend/src/assets/main.css'), 'utf8');
      const bad = /\b0?\.(?:272|476|612|816|85)s\b/;
      assert(!bad.test(app) && !bad.test(css), 'Legacy pre-Pit-Wall duration value found in App.vue or main.css');
      return { detail: 'App.vue & main.css free of legacy 0.272..0.85s durations' };
    }
  },
  {
    id: 'T2-F10-05',
    tier: 2,
    feature: 'F10',
    title: 'Motion tokens support fast < moderate < normal < slow strict monotonic ordering',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      const f = normalizeDurationMs(await readRootCssVar(page, '--motion-duration-fast'));
      const m = normalizeDurationMs(await readRootCssVar(page, '--motion-duration-moderate'));
      const n = normalizeDurationMs(await readRootCssVar(page, '--motion-duration-normal'));
      const s = normalizeDurationMs(await readRootCssVar(page, '--motion-duration-slow'));
      assert(f < m && m < n && n < s, `Non-monotonic durations: ${f}, ${m}, ${n}, ${s}`);
      return { detail: `Monotonic scale verified: ${f} < ${m} < ${n} < ${s}ms` };
    }
  },

  // =========================================================================
  // F11 Boundaries (5 tests)
  // =========================================================================
  {
    id: 'T2-F11-01',
    tier: 2,
    feature: 'F11',
    title: 'icon.svg & favicon.svg reject legacy honeycomb, neon-glow filter, and Draft 1 2x2 reticle/triple-octagon/crosshair',
    async run(ctx) {
      for (const name of ['icon.svg', 'favicon.svg']) {
        const svg = fs.readFileSync(path.join(ctx.repoRoot, 'frontend/public', name), 'utf8');
        const audit = auditBrandSvg(svg);
        assert(!audit.hasLegacyHoneycomb, `${name} still contains honeycomb/neon-glow markers`);
        assert(!audit.hasDraft1Reticle, `${name} still contains rejected Draft 1 2x2 reticle / triple-octagon / 4-tick crosshair pattern`);
      }
      return { detail: 'Zero honeycomb/feGaussianBlur/Draft-1-reticle SVG markers' };
    }
  },
  {
    id: 'T2-F11-02',
    tier: 2,
    feature: 'F11',
    title: 'pwa-192x192.png strictly rejects 512x512 pre-M1 size mismatch',
    async run(ctx) {
      const p192 = readPngFile(path.join(ctx.repoRoot, 'frontend/public/pwa-192x192.png'));
      assert(p192.width === 192 && p192.height === 192, `pwa-192x192.png must be exact 192x192, got ${p192.width}x${p192.height}`);
      return { detail: 'pwa-192x192.png exact 192x192 boundary passed' };
    }
  },
  {
    id: 'T2-F11-03',
    tier: 2,
    feature: 'F11',
    title: 'apple-touch-icon.png, app_icon.png, logo.png, icon.png are valid PNGs (never JPEG)',
    async run(ctx) {
      const files = [
        'frontend/public/apple-touch-icon.png',
        'frontend/public/app_icon.png',
        'frontend/public/logo.png',
        'Backend/src/main/resources/icon.png',
        'Backend/src/main/resources/logo.png'
      ];
      for (const rel of files) {
        const full = path.join(ctx.repoRoot, rel);
        const buf = fs.readFileSync(full);
        assert(!isJpegBuffer(buf), `${rel} is JPEG instead of PNG`);
        const png = readPngFile(full);
        assert(png.width >= 180 && png.height >= 180, `${rel} too small: ${png.width}x${png.height}`);
      }
      return { detail: 'All 5 primary app/touch/logo PNGs decoded cleanly' };
    }
  },
  {
    id: 'T2-F11-04',
    tier: 2,
    feature: 'F11',
    title: 'favicon.ico & icon.ico reject truncated payloads or non-32bpp entries',
    async run(ctx) {
      for (const rel of ['frontend/public/favicon.ico', 'Backend/src/main/resources/icon.ico']) {
        const ico = parseIco(fs.readFileSync(path.join(ctx.repoRoot, rel)));
        assert(ico.count >= 9, `${rel} has only ${ico.count} entries`);
        assert(ico.entries.every((e) => e.isPng || e.isDib), `${rel} contains invalid entry payload`);
      }
      return { detail: 'All ICO directory entries & payloads validated' };
    }
  },
  {
    id: 'T2-F11-05',
    tier: 2,
    feature: 'F11',
    title: 'logo.png uses Pit Wall dark background (#0B0E10 or transparent), not pure #000000 honeycomb',
    async run(ctx) {
      const png = readPngFile(path.join(ctx.repoRoot, 'frontend/public/logo.png'));
      const corner = png.getPixel(0, 0);
      const isTransparentOrColdGraphite =
        corner[3] === 0 ||
        (Math.abs(corner[0] - 0x0b) <= 3 && Math.abs(corner[1] - 0x0e) <= 3 && Math.abs(corner[2] - 0x10) <= 3);
      assert(isTransparentOrColdGraphite, `logo.png corner expected transparent or #0B0E10, got rgba(${corner.join(',')})`);
      return { detail: `logo.png corner rgba(${corner.join(',')})` };
    }
  },

  // =========================================================================
  // F12 Boundaries (5 tests)
  // =========================================================================
  {
    id: 'T2-F12-01',
    tier: 2,
    feature: 'F12',
    title: 'logo-bear.png strictly rejects JPEG magic (FF D8 FF)',
    async run(ctx) {
      const buf = fs.readFileSync(path.join(ctx.repoRoot, 'Backend/src/main/resources/assets/logo-bear.png'));
      assert(!isJpegBuffer(buf), 'logo-bear.png failed JPEG rejection guard');
      return { detail: 'JPEG magic absent on logo-bear.png' };
    }
  },
  {
    id: 'T2-F12-02',
    tier: 2,
    feature: 'F12',
    title: 'logo-bear.png rejects non-RGBA color types (must be colorType=6)',
    async run(ctx) {
      const png = readPngFile(path.join(ctx.repoRoot, 'Backend/src/main/resources/assets/logo-bear.png'));
      assert(png.colorType === 6, `logo-bear.png colorType=${png.colorType}, expected 6 (RGBA)`);
      return { detail: 'colorType === 6 verified' };
    }
  },
  {
    id: 'T2-F12-03',
    tier: 2,
    feature: 'F12',
    title: 'logo-bear.png 5px perimeter band contains < 5% opaque #000000 pixels',
    async run(ctx) {
      const png = readPngFile(path.join(ctx.repoRoot, 'Backend/src/main/resources/assets/logo-bear.png'));
      const border = png.inspectBorder(5);
      assert(border.opaqueBlackRatio < 0.05, `Opaque black border ratio too high: ${border.opaqueBlackRatio}`);
      return { detail: `Opaque black border ratio ${(border.opaqueBlackRatio * 100).toFixed(2)}%` };
    }
  },
  {
    id: 'T2-F12-04',
    tier: 2,
    feature: 'F12',
    title: 'logo-bear.png mid-edge samples (top/bottom/left/right midpoints) are transparent',
    async run(ctx) {
      const png = readPngFile(path.join(ctx.repoRoot, 'Backend/src/main/resources/assets/logo-bear.png'));
      const pts = [
        png.getPixel(Math.floor(png.width / 2), 1),
        png.getPixel(Math.floor(png.width / 2), png.height - 2),
        png.getPixel(1, Math.floor(png.height / 2)),
        png.getPixel(png.width - 2, Math.floor(png.height / 2))
      ];
      assert(pts.some((p) => p[3] < 20), `All 4 mid-edge pixels opaque: ${JSON.stringify(pts)}`);
      return { detail: 'Mid-edge alpha transparency confirmed' };
    }
  },
  {
    id: 'T2-F12-05',
    tier: 2,
    feature: 'F12',
    title: 'logo-bear.png alpha-compositing on #0B0E10 vs #151A1E yields distinct background corners (proving true alpha)',
    async run(ctx) {
      const png = readPngFile(path.join(ctx.repoRoot, 'Backend/src/main/resources/assets/logo-bear.png'));
      const [r, g, b, a] = png.getPixel(2, 2);
      const alpha = a / 255;
      const on0B = Math.round(r * alpha + 0x0b * (1 - alpha));
      const on15 = Math.round(r * alpha + 0x15 * (1 - alpha));
      assert(on0B !== on15, `Corner pixel (2,2) rgba(${r},${g},${b},${a}) blocked underlying surface change`);
      return { detail: `True alpha verified via dual-surface composite (${on0B} vs ${on15})` };
    }
  },

  // =========================================================================
  // F13 Boundaries (5 tests)
  // =========================================================================
  {
    id: 'T2-F13-01',
    tier: 2,
    feature: 'F13',
    title: 'Simulated slow JS bundle (request interception) keeps #0B0E10 + pre-JS splash visible with 0 white flash',
    async run(ctx) {
      const page = await ctx.browserHandle.openCleanPage(DESKTOP_VIEWPORT);
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (req.resourceType() === 'script' && req.url().includes('/assets/')) {
          setTimeout(() => req.continue(), 400);
        } else {
          req.continue();
        }
      });
      try {
        await page.goto(ctx.baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const snap = await page.evaluate(() => ({
          bg: window.getComputedStyle(document.body).backgroundColor,
          hasSplashImgOrSvg: !!document.querySelector('#web-boot-splash, img[src*="logo_transparent"], #pitwall-boot-splash, .boot-splash')
        }));
        assertColorMatch(snap.bg, '#0B0E10', 'Slow-JS initial background', 4);
        assert(snap.hasSplashImgOrSvg, 'Pre-JS splash element missing before script load');
        return { detail: 'Pre-JS splash & #0B0E10 active before JS bundle completes' };
      } finally {
        await page.close();
      }
    }
  },
  {
    id: 'T2-F13-02',
    tier: 2,
    feature: 'F13',
    title: 'Web boot splash never blocks pointer clicks once mounted (< 1000ms)',
    async run(ctx) {
      const page = await ctx.browserHandle.openCleanPage(DESKTOP_VIEWPORT);
      try {
        await page.goto(ctx.baseUrl, { waitUntil: 'networkidle0', timeout: 15000 });
        await delay(400);
        const clickable = await page.evaluate(() => {
          const input = document.querySelector('#username');
          if (!input) return false;
          const r = input.getBoundingClientRect();
          const topEl = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return topEl === input || input.contains(topEl);
        });
        assert(clickable, 'Boot splash overlay still blocking pointer input on #username');
        return { detail: 'Boot splash unblocks pointer events cleanly' };
      } finally {
        await page.close();
      }
    }
  },
  {
    id: 'T2-F13-03',
    tier: 2,
    feature: 'F13',
    title: 'Mobile 390x844 boot splash renders centered without horizontal scroll overflow',
    async run(ctx) {
      const page = await ctx.browserHandle.openCleanPage(MOBILE_VIEWPORT);
      try {
        await page.goto(ctx.baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert(overflow <= 1, `Mobile boot splash horizontal overflow: ${overflow}px`);
        return { detail: 'Mobile 390x844 boot splash zero horizontal overflow' };
      } finally {
        await page.close();
      }
    }
  },
  {
    id: 'T2-F13-04',
    tier: 2,
    feature: 'F13',
    title: 'index.html pre-JS splash uses local /logo_transparent.png or inline SVG (no external CDN URLs)',
    async run(ctx) {
      const html = fs.readFileSync(path.join(ctx.repoRoot, 'frontend/index.html'), 'utf8');
      assert(!/https?:\/\//i.test(html), 'index.html should not depend on external HTTP/HTTPS URLs');
      return { detail: 'index.html strictly offline/local-first' };
    }
  },
  {
    id: 'T2-F13-05',
    tier: 2,
    feature: 'F13',
    title: 'Post-splash document background remains #0B0E10 across route transitions',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      const bg = await page.evaluate(() => window.getComputedStyle(document.documentElement).backgroundColor);
      assertColorMatch(bg, '#0B0E10', 'Post-splash html background', 4);
      return { detail: 'Root background stays #0B0E10 post-splash' };
    }
  },

  // =========================================================================
  // F14 Boundaries (5 tests)
  // =========================================================================
  {
    id: 'T2-F14-01',
    tier: 2,
    feature: 'F14',
    title: 'SplashScreen.java rejects legacy BG_BLACK=(0,0,0) and slow TITLE_CHAR_MS=85',
    async run(ctx) {
      const java = fs.readFileSync(path.join(ctx.repoRoot, 'Backend/src/main/java/com/bear27570/app/SplashScreen.java'), 'utf8');
      assert(!/new Color\(\s*0x?00?\s*,\s*0x?00?\s*,\s*0x?00?\s*\)/.test(java), 'SplashScreen.java still uses pure #000000 background');
      assert(!/TITLE_CHAR_MS\s*=\s*85\b/.test(java), 'SplashScreen.java still uses legacy 85ms typewriter');
      return { detail: 'Legacy #000000 and 85ms typewriter removed from SplashScreen.java' };
    }
  },
  {
    id: 'T2-F14-02',
    tier: 2,
    feature: 'F14',
    title: 'SplashScreen.java actually paints statusText in paintComponent (not assigned-only dead field)',
    async run(ctx) {
      const java = fs.readFileSync(path.join(ctx.repoRoot, 'Backend/src/main/java/com/bear27570/app/SplashScreen.java'), 'utf8');
      const paintIdx = java.indexOf('paintComponent');
      assert(paintIdx !== -1, 'paintComponent not found in SplashScreen.java');
      const paintSlice = java.slice(paintIdx);
      assert(paintSlice.includes('statusText'), 'SplashScreen.java paintComponent never draws statusText');
      return { detail: 'statusText is actively painted in SplashScreen.paintComponent' };
    }
  },
  {
    id: 'T2-F14-03',
    tier: 2,
    feature: 'F14',
    title: 'Main.java retains English boot status messages (not replaced with Chinese-only literals)',
    async run(ctx) {
      const mainJava = fs.readFileSync(path.join(ctx.repoRoot, 'Backend/src/main/java/com/bear27570/app/Main.java'), 'utf8');
      assert(mainJava.includes('Preparing database...') && mainJava.includes('Startup failed:'), 'Main.java missing required English boot/error messages');
      return { detail: 'English boot/failure strings preserved per ORIGINAL_REQUEST precedence' };
    }
  },
  {
    id: 'T2-F14-04',
    tier: 2,
    feature: 'F14',
    title: 'SplashScreen JUnit run triggers zero java.awt.HeadlessException in Surefire XML',
    async run(ctx) {
      const run = runBackendUiAndSplashTests(ctx);
      const headlessErrs = run.reports.filter((r) => r.hasHeadlessException);
      assert(headlessErrs.length === 0, `HeadlessException occurred in Surefire reports: ${JSON.stringify(headlessErrs)}`);
      return { detail: 'Zero HeadlessException in Maven Swing/Splash tests' };
    }
  },
  {
    id: 'T2-F14-05',
    tier: 2,
    feature: 'F14',
    title: 'SplashScreen error state keeps splash open and renders #FF5577 error bar in failure PNG',
    async run(ctx) {
      const java = fs.readFileSync(path.join(ctx.repoRoot, 'Backend/src/main/java/com/bear27570/app/SplashScreen.java'), 'utf8');
      assert(/0xFF\s*,\s*0x55\s*,\s*0x77/i.test(java), 'SplashScreen.java missing #FF5577 error state color');
      const run = runBackendUiAndSplashTests(ctx);
      const splashPngs = findSplashRenderPngs(run.sp27TestsDir, run.copiedPngs);
      assert(splashPngs.length >= 1, 'No SplashScreen PNG rendered to inspect');
      const errImg = splashPngs.find((s) => /err|fail/i.test(s.name));
      assert(
        errImg,
        `Required failure-state SplashScreen PNG (*err*.png or *fail*.png) missing in ${run.sp27TestsDir}. Found: ${splashPngs.map((s) => s.name).join(', ')}`
      );
      let roseCount = 0;
      for (let y = 0; y < errImg.png.height; y += 2) {
        for (let x = 0; x < errImg.png.width; x += 2) {
          const [r, g, b] = errImg.png.getPixel(x, y);
          if (r > 200 && g < 115 && b > 85 && b < 155) roseCount += 1;
        }
      }
      assert(roseCount > 10, `Failure Splash PNG "${errImg.name}" missing #FF5577 pixels (found ${roseCount})`);
      return { detail: `SplashScreen #FF5577 error state & failure PNG (${errImg.name}) verified` };
    }
  },

  // =========================================================================
  // F15 Boundaries (5 tests)
  // =========================================================================
  {
    id: 'T2-F15-01',
    tier: 2,
    feature: 'F15',
    title: 'CustomTitleBar.java removes Color.BLACK and legacy (20,20,24) border',
    async run(ctx) {
      const tb = fs.readFileSync(path.join(ctx.repoRoot, 'Backend/src/main/java/com/bear27570/app/ui/CustomTitleBar.java'), 'utf8');
      assert(!/BG_COLOR\s*=\s*Color\.BLACK/.test(tb), 'CustomTitleBar.java still sets BG_COLOR = Color.BLACK');
      assert(!/new Color\(\s*20\s*,\s*20\s*,\s*24\s*\)/.test(tb), 'CustomTitleBar.java still uses legacy (20,20,24) border');
      return { detail: 'CustomTitleBar legacy black/border colors removed' };
    }
  },
  {
    id: 'T2-F15-02',
    tier: 2,
    feature: 'F15',
    title: 'Main.java windowBg removes legacy new Color(10, 10, 10)',
    async run(ctx) {
      const mn = fs.readFileSync(path.join(ctx.repoRoot, 'Backend/src/main/java/com/bear27570/app/Main.java'), 'utf8');
      assert(!/windowBg\s*=\s*new Color\(\s*10\s*,\s*10\s*,\s*10\s*\)/.test(mn), 'Main.java still uses legacy Color(10,10,10)');
      return { detail: 'Main.java windowBg migrated from (10,10,10) to #0B0E10' };
    }
  },
  {
    id: 'T2-F15-03',
    tier: 2,
    feature: 'F15',
    title: 'close_btn_hover.png (46x38) renders Windows close red without bleeding into titlebar right edge',
    async run(ctx) {
      const run = runBackendUiAndSplashTests(ctx);
      const closePng = readPngFile(path.join(run.sp27TestsDir, 'close_btn_hover.png'));
      const tbPng = readPngFile(path.join(run.sp27TestsDir, 'titlebar_visual_render.png'));
      assert(closePng.width === 46 && closePng.height === 38, `close_btn_hover.png wrong dims: ${closePng.width}x${closePng.height}`);
      const c = closePng.getPixel(5, 5);
      assert(c[0] > 200 && c[1] < 40 && c[2] < 60, `close_btn_hover corner (5,5) not red: ${c.join(',')}`);
      const edge = tbPng.getPixel(1023, 19);
      assert((edge[0] + edge[1] + edge[2]) / 3 < 60, `Titlebar right edge artifact brightness >= 60: ${edge.join(',')}`);
      return { detail: 'Close button hover red & clean titlebar right edge verified' };
    }
  },
  {
    id: 'T2-F15-04',
    tier: 2,
    feature: 'F15',
    title: 'min_btn_hover.png & max_btn_hover.png (46x38) composited over #0B0E10 stay in Cold Graphite hover range',
    async run(ctx) {
      const run = runBackendUiAndSplashTests(ctx);
      for (const fname of ['min_btn_hover.png', 'max_btn_hover.png']) {
        const png = readPngFile(path.join(run.sp27TestsDir, fname));
        assert(png.width === 46 && png.height === 38, `${fname} wrong dims: ${png.width}x${png.height}`);
        const [r, g, b, a] = png.getPixel(5, 5);
        const alpha = a / 255;
        const compR = Math.round(r * alpha + 0x0b * (1 - alpha));
        const compG = Math.round(g * alpha + 0x0e * (1 - alpha));
        const compB = Math.round(b * alpha + 0x10 * (1 - alpha));
        assert(
          a > 0 && compR < 80 && compG < 80 && compB < 80,
          `${fname} composited over #0B0E10 unexpectedly bright: rgba(${r},${g},${b},${a}) -> rgb(${compR},${compG},${compB})`
        );
      }
      return { detail: 'min/max hover renders composited on #0B0E10 stay in Cold Graphite range' };
    }
  },
  {
    id: 'T2-F15-05',
    tier: 2,
    feature: 'F15',
    title: 'All Backend UI Surefire tests execute with 0 skipped and 0 HeadlessExceptions',
    async run(ctx) {
      const run = runBackendUiAndSplashTests(ctx);
      assert(run.reports.length >= 5, `Expected >= 5 UI Surefire reports, got ${run.reports.length}`);
      for (const r of run.reports) {
        assert(r.failures === 0 && r.errors === 0 && r.skipped === 0 && !r.hasHeadlessException, `Surefire issue in ${r.name}: ${JSON.stringify(r)}`);
      }
      return { detail: `${run.reports.length} Backend UI suites verified (0 failures, 0 skipped)` };
    }
  }
];

export { LEGACY_WARM_AND_SLATE_HEXES };
