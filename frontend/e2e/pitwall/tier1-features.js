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
  normalizeDurationMs,
  PITWALL_GRAPHITE,
  REMOVED_FONT_NAMES
} from './css-audit.js';
import {
  isJpegBuffer,
  parseIco,
  readPngFile,
  sha256File
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

export const TIER1_TESTS = [
  // =========================================================================
  // F1: Pit Wall CSS Token System in main.css (5 tests)
  // =========================================================================
  {
    id: 'T1-F01-01',
    tier: 1,
    feature: 'F1',
    title: 'Cold Graphite neutral scale (--g-950..--g-50) and --background=#0B0E10 defined on :root',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      const checked = {};
      for (const [token, expected] of Object.entries(PITWALL_GRAPHITE)) {
        const val = await readRootCssVar(page, token);
        assertColorMatch(val, expected, `Token ${token}`);
        checked[token] = val;
      }
      const bg = await readRootCssVar(page, '--background');
      assertColorMatch(bg, '#0B0E10', '--background');
      return { detail: 'All 14 Cold Graphite tokens + --background=#0B0E10 verified', evidence: checked };
    }
  },
  {
    id: 'T1-F01-02',
    tier: 1,
    feature: 'F1',
    title: 'Primary/Accent/Ring tokens enforce #39FF14 per ORIGINAL_REQUEST precedence',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      const tokens = {};
      for (const t of ['--primary', '--accent', '--ring']) {
        tokens[t] = await readRootCssVar(page, t);
        assertColorMatch(tokens[t], '#39FF14', t);
      }
      const onPrimary = await readRootCssVar(page, '--on-primary');
      assert(onPrimary.length > 0, '--on-primary token missing');
      assertColorMatch(onPrimary, '#06140A', '--on-primary');
      return { detail: '--primary/--accent/--ring=#39FF14, --on-primary=#06140A', evidence: tokens };
    }
  },
  {
    id: 'T1-F01-03',
    tier: 1,
    feature: 'F1',
    title: 'Exclusive Red & Blue alliance semantic tokens resolve to Pit Wall hexes',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      const expected = {
        '--red-300': '#FF8F87',
        '--red-400': '#FF5D52',
        '--red-500': '#E5483E',
        '--red-700': '#6B231F',
        '--red-900': '#2A1311',
        '--alliance-red': '#FF5D52',
        '--blue-300': '#8EC5FF',
        '--blue-400': '#4FA3FF',
        '--blue-500': '#2F7FEA',
        '--blue-700': '#1C3F6E',
        '--blue-900': '#0E1B2E',
        '--alliance-blue': '#4FA3FF'
      };
      const actual = {};
      for (const [k, hex] of Object.entries(expected)) {
        actual[k] = await readRootCssVar(page, k);
        assertColorMatch(actual[k], hex, k);
      }
      return { detail: 'Alliance Red/Blue scales match Pit Wall contract', evidence: actual };
    }
  },
  {
    id: 'T1-F01-04',
    tier: 1,
    feature: 'F1',
    title: 'Status & Match Phase tokens (Auto #5ED3E0, TeleOp #39FF14, Endgame #F7B53B) defined',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      const expected = {
        '--status-success': '#39FF14',
        '--status-warning': '#F7B53B',
        '--status-error': '#FF5577',
        '--destructive': '#FF5577',
        '--status-info': '#5ED3E0',
        '--status-ai': '#A48CFF',
        '--phase-auto': '#5ED3E0',
        '--phase-teleop': '#39FF14',
        '--phase-endgame': '#F7B53B'
      };
      const actual = {};
      for (const [k, hex] of Object.entries(expected)) {
        actual[k] = await readRootCssVar(page, k);
        assertColorMatch(actual[k], hex, k);
      }
      return { detail: 'Status & Match Phase tokens match spec', evidence: actual };
    }
  },
  {
    id: 'T1-F01-05',
    tier: 1,
    feature: 'F1',
    title: 'Elevation shadows (--shadow-1/2/3) defined and dark-only theme enforced',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      const s1 = await readRootCssVar(page, '--shadow-1');
      const s2 = await readRootCssVar(page, '--shadow-2');
      const s3 = await readRootCssVar(page, '--shadow-3');
      assert(s1.length > 0 && s2.length > 0 && s3.length > 0, 'Missing --shadow-1/2/3 tokens');
      const mainCss = fs.readFileSync(path.join(ctx.repoRoot, 'frontend/src/assets/main.css'), 'utf8');
      assert(!/\[data-theme=["']light["']\]/i.test(mainCss), 'Light theme rule detected in main.css');
      assert(!/prefers-color-scheme:\s*light/i.test(mainCss), 'prefers-color-scheme: light detected in main.css');
      return { detail: 'Dark-only theme with --shadow-1/2/3 verified', evidence: { s1, s2, s3 } };
    }
  },

  // =========================================================================
  // F2: Global <select> Chevron SVG, Inputs & Scrollbars (5 tests)
  // =========================================================================
  {
    id: 'T1-F02-01',
    tier: 1,
    feature: 'F2',
    title: 'Global <select> uses Pit Wall chevron (CSS gradient or SVG) without legacy %238e8d87',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'pit', '.pit-scout-view .filter-select');
      const selectState = await page.evaluate(() => {
        const sel = document.querySelector('.pit-scout-view .filter-select, select');
        if (!sel) return null;
        const defaultBgImg = window.getComputedStyle(sel).backgroundImage;
        sel.focus();
        const focusBgImg = window.getComputedStyle(sel).backgroundImage;
        sel.blur();
        return { defaultBgImg, focusBgImg };
      });
      assert(selectState, 'No <select> found on Pit view');
      const { defaultBgImg, focusBgImg } = selectState;
      const hasChevronImg =
        defaultBgImg.includes('linear-gradient') || defaultBgImg.includes('data:image/svg+xml');
      assert(hasChevronImg, `Expected CSS gradient or SVG data URI chevron on <select>, got "${defaultBgImg}"`);
      assert(!defaultBgImg.toLowerCase().includes('%238e8d87'), `Legacy %238e8d87 chevron detected: ${defaultBgImg}`);
      assert(!defaultBgImg.includes('142, 141, 135'), `Legacy #8e8d87 RGB chevron detected: ${defaultBgImg}`);

      const mainCss = fs.readFileSync(path.join(ctx.repoRoot, 'frontend/src/assets/main.css'), 'utf8');
      assert(!mainCss.toLowerCase().includes('%238e8d87'), 'main.css still contains %238e8d87');
      const usesCssGradientChevron =
        /select\s*\{[\s\S]*?linear-gradient[\s\S]*?var\(--g-300\)[\s\S]*?\}/i.test(mainCss) &&
        /select:focus[\s\S]*?linear-gradient[\s\S]*?var\(--primary\)[\s\S]*?\}/i.test(mainCss);
      const usesSvgChevron =
        mainCss.toLowerCase().includes('%2397a2ab') && mainCss.toLowerCase().includes('%2339ff14');
      assert(
        usesCssGradientChevron || usesSvgChevron,
        'main.css <select> chevron must use Pit Wall linear-gradient (var(--g-300)/var(--primary)) or SVG (%2397A2AB/%2339FF14)'
      );
      return {
        detail: usesCssGradientChevron
          ? 'Select chevron uses Pit Wall CSS linear-gradient tokens'
          : 'Select chevron SVG uses Pit Wall strokes',
        evidence: { defaultBgImg: defaultBgImg.slice(0, 120), focusBgImg: focusBgImg.slice(0, 120) }
      };
    }
  },
  {
    id: 'T1-F02-02',
    tier: 1,
    feature: 'F2',
    title: 'Rendered <select> & <option> surfaces use Cold Graphite instead of warm gray',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'pit', '.pit-scout-view .filter-select');
      const styles = await page.evaluate(() => {
        const sel = document.querySelector('.pit-scout-view .filter-select, select');
        const opt = sel?.querySelector('option');
        const cs = sel ? window.getComputedStyle(sel) : null;
        const co = opt ? window.getComputedStyle(opt) : null;
        return {
          selectBg: cs?.backgroundColor || '',
          selectColor: cs?.color || '',
          optionBg: co?.backgroundColor || '',
          optionColor: co?.color || ''
        };
      });
      assert(!colorsEqual(styles.selectBg, '#141413', 2), `Warm gray select bg ${styles.selectBg}`);
      assert(!colorsEqual(styles.selectColor, '#f0efe9', 2), `Warm gray select text ${styles.selectColor}`);
      return { detail: 'Select & option surfaces use Cold Graphite', evidence: styles };
    }
  },
  {
    id: 'T1-F02-03',
    tier: 1,
    feature: 'F2',
    title: 'Global <input> controls use Cold Graphite recessed surface (#07090A/#0B0E10) and #E6EBEE text',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'pit', '.pit-toolbar .search-input');
      const styles = await page.evaluate(() => {
        const inp = document.querySelector('.pit-toolbar .search-input');
        const cs = window.getComputedStyle(inp);
        return { bg: cs.backgroundColor, color: cs.color, border: cs.borderColor };
      });
      assert(!colorsEqual(styles.bg, '#080807', 1), `Legacy warm #080807 input bg: ${styles.bg}`);
      assert(colorsEqual(styles.color, '#E6EBEE', 8) || colorsEqual(styles.color, '#F6F8F9', 8), `Expected Pit Wall light text, got ${styles.color}`);
      return { detail: 'Input background and text aligned to Cold Graphite', evidence: styles };
    }
  },
  {
    id: 'T1-F02-04',
    tier: 1,
    feature: 'F2',
    title: 'Focused <input> / <select> renders #39FF14 Pit Wall focus ring/border',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'pit', '.pit-toolbar .search-input');
      await page.focus('.pit-toolbar .search-input');
      await delay(100);
      const focusStyle = await page.evaluate(() => {
        const inp = document.querySelector('.pit-toolbar .search-input');
        const cs = window.getComputedStyle(inp);
        return { borderColor: cs.borderColor, outlineColor: cs.outlineColor, boxShadow: cs.boxShadow };
      });
      const hasPrimaryAccent =
        colorsEqual(focusStyle.borderColor, '#39FF14', 12) ||
        colorsEqual(focusStyle.outlineColor, '#39FF14', 12) ||
        focusStyle.boxShadow.includes('57, 255, 20');
      assert(hasPrimaryAccent, `Expected #39FF14 focus accent, got ${JSON.stringify(focusStyle)}`);
      return { detail: 'Focused input exhibits #39FF14 focus ring', evidence: focusStyle };
    }
  },
  {
    id: 'T1-F02-05',
    tier: 1,
    feature: 'F2',
    title: 'Static scan across all frontend/src finds zero legacy %238e8d87 chevron SVG overrides',
    async run(ctx) {
      const scan = getFrontendScan(ctx);
      assert(
        scan.totals.badChevrons.length === 0,
        `Found unapproved/legacy SVG chevron strokes: ${JSON.stringify(scan.totals.badChevrons)}`
      );
      return { detail: `Scanned ${scan.totals.filesScanned} files with 0 legacy chevron strokes` };
    }
  },

  // =========================================================================
  // F3: Views, App.vue, ToastProvider, Logger & PWA Manifest (5 tests)
  // =========================================================================
  {
    id: 'T1-F03-01',
    tier: 1,
    feature: 'F3',
    title: 'App body & LoginView render #0B0E10 canvas and Cold Graphite login card',
    async run(ctx) {
      const page = await ctx.browserHandle.openCleanPage(DESKTOP_VIEWPORT);
      try {
        await page.goto(ctx.baseUrl, { waitUntil: 'networkidle0', timeout: 20000 });
        await waitForTransition(page);
        const styles = await page.evaluate(() => {
          const bodyBg = window.getComputedStyle(document.body).backgroundColor;
          const card = document.querySelector('.login-card');
          const cardBg = card ? window.getComputedStyle(card).backgroundColor : '';
          const btn = document.querySelector('button[type="submit"]');
          const btnBg = btn ? window.getComputedStyle(btn).backgroundColor : '';
          return { bodyBg, cardBg, btnBg };
        });
        assertColorMatch(styles.bodyBg, '#0B0E10', 'body background', 4);
        assert(!colorsEqual(styles.cardBg, '#141413', 2), `Warm gray login card: ${styles.cardBg}`);
        return { detail: 'LoginView canvas is #0B0E10 and card is Cold Graphite', evidence: styles };
      } finally {
        await page.close();
      }
    }
  },
  {
    id: 'T1-F03-02',
    tier: 1,
    feature: 'F3',
    title: 'DashboardView topbar & event cards render Pit Wall Cold Graphite without legacy #141413/#262624',
    async run(ctx) {
      const { page, eventId } = await ensureDesktopSession(ctx);
      await page.goto(`${ctx.baseUrl}#/dashboard`, { waitUntil: 'networkidle0', timeout: 15000 });
      await page.waitForSelector('.dashboard, .dashboard-view', { visible: true, timeout: 10000 });
      await waitForTransition(page);
      const dash = await page.evaluate(() => {
        const card = document.querySelector('.event-card');
        const primary = document.querySelector('.action-btn.primary');
        return {
          cardBg: card ? window.getComputedStyle(card).backgroundColor : '',
          cardBorder: card ? window.getComputedStyle(card).borderColor : '',
          primaryBg: primary ? window.getComputedStyle(primary).backgroundColor : ''
        };
      });
      assert(!colorsEqual(dash.cardBg, '#141413', 1), `Legacy warm gray event-card: ${dash.cardBg}`);
      assertColorMatch(dash.primaryBg, '#39FF14', '.action-btn.primary', 6);
      await page.goto(`${ctx.baseUrl}#/event/${encodeURIComponent(eventId)}`, { waitUntil: 'networkidle0' });
      await waitForTransition(page);
      return { detail: 'Dashboard cards & primary CTA follow Pit Wall tokens', evidence: dash };
    }
  },
  {
    id: 'T1-F03-03',
    tier: 1,
    feature: 'F3',
    title: 'EventView topbar, tab track & active tab underline render Cold Graphite + #39FF14',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      const ev = await page.evaluate(() => {
        const topbar = document.querySelector('.event-view .topbar');
        const activeTab = document.querySelector('.tab-bar .tab-btn.active, .tab-bar .tab-btn[aria-selected="true"], .tab-bar .tab-btn');
        return {
          topbarBg: topbar ? window.getComputedStyle(topbar).backgroundColor : '',
          topbarBorder: topbar ? window.getComputedStyle(topbar).borderBottomColor : '',
          activeTabColor: activeTab ? window.getComputedStyle(activeTab).color : ''
        };
      });
      assert(ev.topbarBg.length > 0, 'Missing EventView .topbar');
      assert(!colorsEqual(ev.topbarBg, '#0c0c0b', 1), `Legacy warm #0c0c0b topbar: ${ev.topbarBg}`);
      return { detail: 'EventView topbar & tabs migrated to Cold Graphite', evidence: ev };
    }
  },
  {
    id: 'T1-F03-04',
    tier: 1,
    feature: 'F3',
    title: 'ToastProvider renders Pit Wall toast pills with semantic left border & --shadow-2',
    async run(ctx) {
      const toastVue = fs.readFileSync(path.join(ctx.repoRoot, 'frontend/src/components/ToastProvider.vue'), 'utf8');
      const hasLegacy = /#(?:141413|181816|262624|ef4444|38bdf8|fcd34d)/i.test(toastVue);
      assert(!hasLegacy, 'ToastProvider.vue still contains legacy hex colors');
      assert(toastVue.includes('--shadow-2') || toastVue.includes('--g-800') || toastVue.includes('--popover'), 'ToastProvider.vue missing Pit Wall surface/shadow tokens');
      return { detail: 'ToastProvider.vue uses Pit Wall tokens without legacy hexes' };
    }
  },
  {
    id: 'T1-F03-05',
    tier: 1,
    feature: 'F3',
    title: 'vite.config.ts PWA manifest aligns theme_color & background_color to #0B0E10',
    async run(ctx) {
      const viteCfg = fs.readFileSync(path.join(ctx.repoRoot, 'frontend/vite.config.ts'), 'utf8');
      assert(!/#0d1117/i.test(viteCfg), 'vite.config.ts still contains legacy #0d1117');
      const matches = viteCfg.match(/#0b0e10/gi) || [];
      assert(matches.length >= 2, `Expected both theme_color & background_color #0B0E10 in vite.config.ts, found ${matches.length}`);
      return { detail: 'PWA manifest theme_color & background_color set to #0B0E10' };
    }
  },

  // =========================================================================
  // F4: components/scouting/* Pit Wall Migration & Match Phase Bars (5 tests)
  // =========================================================================
  {
    id: 'T1-F04-01',
    tier: 1,
    feature: 'F4',
    title: 'ScoutingForm Match Phase sections render 3px left accent bars (Auto #5ED3E0, TeleOp #39FF14, Endgame #F7B53B)',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'scout', '.scouting-form');
      const phases = await page.evaluate(() => {
        const readBorder = (el) => {
          if (!el) return null;
          const cs = window.getComputedStyle(el);
          return {
            borderLeftWidth: cs.borderLeftWidth,
            borderLeftColor: cs.borderLeftColor,
            boxShadow: cs.boxShadow
          };
        };
        const pickPhase = (innerSel, fallbackChildSel) => {
          const inner = document.querySelector(innerSel);
          if (inner) {
            const innerStats = readBorder(inner);
            if (parseFloat(innerStats.borderLeftWidth) >= 2.5) {
              return innerStats;
            }
            const section = inner.closest('.form-section');
            if (section) return readBorder(section);
            return innerStats;
          }
          const fb = fallbackChildSel ? document.querySelector(fallbackChildSel) : null;
          if (fb) {
            const fbStats = readBorder(fb);
            if (parseFloat(fbStats.borderLeftWidth) >= 2.5) return fbStats;
            const section = fb.closest('.form-section');
            return section ? readBorder(section) : fbStats;
          }
          return null;
        };
        return {
          auto: pickPhase('.phase-auto'),
          teleop: pickPhase('.phase-teleop'),
          endgame: pickPhase('.phase-endgame', '.biobuzz-endgame-steppers')
        };
      });
      assert(phases.auto && phases.teleop && phases.endgame, `Missing phase containers: ${JSON.stringify(phases)}`);
      assert(parseFloat(phases.auto.borderLeftWidth) >= 2.5, `Auto 3px border missing: ${JSON.stringify(phases.auto)}`);
      assert(parseFloat(phases.teleop.borderLeftWidth) >= 2.5, `TeleOp 3px border missing: ${JSON.stringify(phases.teleop)}`);
      assert(parseFloat(phases.endgame.borderLeftWidth) >= 2.5, `Endgame 3px border missing: ${JSON.stringify(phases.endgame)}`);
      assertColorMatch(phases.auto.borderLeftColor, '#5ED3E0', 'Auto left accent', 10);
      assertColorMatch(phases.teleop.borderLeftColor, '#39FF14', 'TeleOp left accent', 10);
      assertColorMatch(phases.endgame.borderLeftColor, '#F7B53B', 'Endgame left accent', 10);
      return { detail: 'All 3 Match Phase 3px left borders verified', evidence: phases };
    }
  },
  {
    id: 'T1-F04-02',
    tier: 1,
    feature: 'F4',
    title: 'HIT/MISS pads (.pad-hit-btn / .pad-miss-btn) use Pit Wall semantic tokens & >= 120x56px ergonomics',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'scout', '.phase-teleop .pad-hit-btn');
      const pads = await page.evaluate(() => {
        const hit = document.querySelector('.phase-teleop .pad-hit-btn');
        const miss = document.querySelector('.phase-teleop .pad-miss-btn');
        const hr = hit.getBoundingClientRect();
        const mr = miss.getBoundingClientRect();
        const hs = window.getComputedStyle(hit);
        const ms = window.getComputedStyle(miss);
        return {
          hitRect: { w: hr.width, h: hr.height },
          missRect: { w: mr.width, h: mr.height },
          hitBg: hs.backgroundColor,
          hitBorder: hs.borderColor,
          hitColor: hs.color,
          missBg: ms.backgroundColor,
          missBorder: ms.borderColor,
          missColor: ms.color
        };
      });
      assert(pads.hitRect.w >= 110 && pads.hitRect.h >= 50, `HIT pad too small: ${JSON.stringify(pads.hitRect)}`);
      assert(pads.missRect.w >= 110 && pads.missRect.h >= 50, `MISS pad too small: ${JSON.stringify(pads.missRect)}`);
      assert(!colorsEqual(pads.missBg, '#ef4444', 5), 'MISS pad still uses legacy #ef4444');
      assert(
        colorsEqual(pads.hitBg, '#0E2210', 12) ||
          colorsEqual(pads.hitBorder, '#24661A', 14) ||
          colorsEqual(pads.hitBorder, '#39FF14', 14),
        `HIT pad missing Pit Wall semantic green tokens (#0E2210 / #24661A / #39FF14): ${JSON.stringify(pads)}`
      );
      assert(
        colorsEqual(pads.missBg, '#2B0F17', 12) ||
          colorsEqual(pads.missBorder, '#6E1F33', 14) ||
          colorsEqual(pads.missBorder, '#FF5577', 14),
        `MISS pad missing Pit Wall semantic error tokens (#2B0F17 / #6E1F33 / #FF5577): ${JSON.stringify(pads)}`
      );
      return { detail: 'HIT/MISS pads ergonomic and Pit Wall styled', evidence: pads };
    }
  },
  {
    id: 'T1-F04-03',
    tier: 1,
    feature: 'F4',
    title: 'SPDT Alliance Switch renders Red #FF5D52 vs Blue #4FA3FF exclusively',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'scout', '.spdt-switch');
      await page.click('.spdt-labels span:first-child');
      await delay(120);
      const redActive = await page.evaluate(() => {
        const sw = document.querySelector('.spdt-switch');
        const thumb = document.querySelector('.spdt-thumb');
        return {
          hasRedClass: sw?.classList.contains('pos-red') || document.querySelector('.scouting-wrapper')?.classList.contains('color-red'),
          thumbBg: thumb ? window.getComputedStyle(thumb).backgroundColor : ''
        };
      });
      await page.click('.spdt-labels span:last-child');
      await delay(120);
      const blueActive = await page.evaluate(() => {
        const sw = document.querySelector('.spdt-switch');
        const thumb = document.querySelector('.spdt-thumb');
        return {
          hasBlueClass: sw?.classList.contains('pos-blue') || document.querySelector('.scouting-wrapper')?.classList.contains('color-blue'),
          thumbBg: thumb ? window.getComputedStyle(thumb).backgroundColor : ''
        };
      });
      assert(redActive.hasRedClass && blueActive.hasBlueClass, 'SPDT alliance switch did not toggle red/blue');
      return { detail: 'Alliance SPDT switch toggles Pit Wall Red & Blue', evidence: { redActive, blueActive } };
    }
  },
  {
    id: 'T1-F04-04',
    tier: 1,
    feature: 'F4',
    title: 'MobilePhaseWizardForm (390x844) renders Pit Wall Cold Graphite stepper & alliance buttons',
    async run(ctx) {
      const { page } = await ensureMobilePage(ctx);
      await openTabAndWait(page, 'scout', '.mobile-wizard-container');
      const mobile = await page.evaluate(() => {
        const wizard = document.querySelector('.mobile-wizard-container');
        const redBtn = document.querySelector('.alliance-btn.red-btn');
        const blueBtn = document.querySelector('.alliance-btn.blue-btn');
        return {
          wizardBg: wizard ? window.getComputedStyle(wizard).backgroundColor : '',
          redColor: redBtn ? window.getComputedStyle(redBtn).borderColor : '',
          blueColor: blueBtn ? window.getComputedStyle(blueBtn).borderColor : ''
        };
      });
      assert(mobile.redColor && mobile.blueColor, 'Mobile wizard alliance buttons missing');
      return { detail: 'MobilePhaseWizardForm renders Pit Wall stepper & alliance colors', evidence: mobile };
    }
  },
  {
    id: 'T1-F04-05',
    tier: 1,
    feature: 'F4',
    title: 'Static audit of components/scouting/* finds zero legacy hexes or unapproved glows',
    async run(ctx) {
      const scan = getFrontendScan(ctx);
      const scoutingIssues = Object.entries(scan.perFile).filter(([f]) => f.startsWith('components/scouting/'));
      assert(scoutingIssues.length === 0, `Scouting CSS audit issues: ${JSON.stringify(scoutingIssues)}`);
      return { detail: 'All files in components/scouting/* passed hex/glow/font audit' };
    }
  },

  // =========================================================================
  // F5: components/whiteboard/* Chrome & Station Palette (5 tests)
  // =========================================================================
  {
    id: 'T1-F05-01',
    tier: 1,
    feature: 'F5',
    title: 'TacticalWhiteboardView topbar & toolbar render Cold Graphite chrome',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'whiteboard', '[data-testid="tactical-whiteboard-view"]');
      const wb = await page.evaluate(() => {
        const root = document.querySelector('[data-testid="tactical-whiteboard-view"]');
        const bar = document.querySelector('.wb-topbar');
        return {
          rootBg: root ? window.getComputedStyle(root).backgroundColor : '',
          barBg: bar ? window.getComputedStyle(bar).backgroundColor : ''
        };
      });
      assert(!colorsEqual(wb.barBg, '#0c0c0b', 1) && !colorsEqual(wb.barBg, '#141413', 1), `Legacy whiteboard topbar bg: ${wb.barBg}`);
      return { detail: 'Whiteboard chrome uses Cold Graphite tokens', evidence: wb };
    }
  },
  {
    id: 'T1-F05-02',
    tier: 1,
    feature: 'F5',
    title: 'WhiteboardSidebar prediction card & alliance bars use Red #FF5D52 / Blue #4FA3FF (no #101110)',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'whiteboard', '[data-testid="whiteboard-sidebar"]');
      const sb = await page.evaluate(() => {
        const card = document.querySelector('.wb-prediction-card');
        const redSide = document.querySelector('.wb-pred-side.red');
        const blueSide = document.querySelector('.wb-pred-side.blue');
        return {
          cardBg: card ? window.getComputedStyle(card).backgroundColor : '',
          redColor: redSide ? window.getComputedStyle(redSide).color : '',
          blueColor: blueSide ? window.getComputedStyle(blueSide).color : ''
        };
      });
      assert(!colorsEqual(sb.cardBg, '#101110', 1), `Legacy #101110 prediction card bg: ${sb.cardBg}`);
      return { detail: 'WhiteboardSidebar prediction card & alliance colors migrated', evidence: sb };
    }
  },
  {
    id: 'T1-F05-03',
    tier: 1,
    feature: 'F5',
    title: 'useTacticalWhiteboard.ts station & pen palette aligned to Pit Wall colors',
    async run(ctx) {
      const ts = fs.readFileSync(path.join(ctx.repoRoot, 'frontend/src/components/whiteboard/useTacticalWhiteboard.ts'), 'utf8');
      assert(!/#(?:ef4444|3b82f6)/i.test(ts), 'useTacticalWhiteboard.ts still uses legacy #ef4444 or #3b82f6');
      assert(/#ff5d52/i.test(ts) && /#4fa3ff/i.test(ts), 'useTacticalWhiteboard.ts missing Pit Wall #FF5D52/#4FA3FF');
      return { detail: 'useTacticalWhiteboard.ts aligned to Pit Wall palette' };
    }
  },
  {
    id: 'T1-F05-04',
    tier: 1,
    feature: 'F5',
    title: 'WhiteboardFieldCanvas renders interactive canvas & playback simulation without console errors',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'whiteboard', '[data-testid="whiteboard-canvas"]');
      const canvasRect = await page.evaluate(() => {
        const c = document.querySelector('[data-testid="whiteboard-canvas"]');
        const r = c.getBoundingClientRect();
        return { w: r.width, h: r.height };
      });
      assert(canvasRect.w > 200 && canvasRect.h > 150, `Whiteboard canvas too small: ${JSON.stringify(canvasRect)}`);
      const playBtn = await page.$('[data-testid="wb-btn-play-sim"]');
      if (playBtn) {
        await playBtn.click();
        await delay(250);
        await playBtn.click();
      }
      return { detail: 'Whiteboard canvas & sim controls interactive', evidence: canvasRect };
    }
  },
  {
    id: 'T1-F05-05',
    tier: 1,
    feature: 'F5',
    title: 'Static audit of components/whiteboard/* <style> & <template> finds zero unallowlisted hexes/glows',
    async run(ctx) {
      const scan = getFrontendScan(ctx);
      const wbIssues = Object.entries(scan.perFile).filter(([f]) => f.startsWith('components/whiteboard/'));
      assert(wbIssues.length === 0, `Whiteboard audit issues: ${JSON.stringify(wbIssues)}`);
      return { detail: 'components/whiteboard/* passed allowlisted Canvas 2D & CSS audit' };
    }
  },

  // =========================================================================
  // F6: pit, schedule, rankings, customFields, ai, history (5 tests)
  // =========================================================================
  {
    id: 'T1-F06-01',
    tier: 1,
    feature: 'F6',
    title: 'PitScoutView & PitScoutFormDrawer render Cold Graphite cards/drawers without neon glow',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'pit', '.pit-scout-view .team-roster-card');
      const card = await page.evaluate(() => {
        const el = document.querySelector('.team-roster-card');
        const cs = window.getComputedStyle(el);
        return { bg: cs.backgroundColor, boxShadow: cs.boxShadow };
      });
      assert(!colorsEqual(card.bg, '#141413', 1), `Legacy warm card bg: ${card.bg}`);
      await page.click('.team-roster-card');
      await page.waitForSelector('.drawer-panel', { visible: true, timeout: 8000 });
      const drawerBg = await page.evaluate(() => window.getComputedStyle(document.querySelector('.drawer-panel')).backgroundColor);
      assert(!colorsEqual(drawerBg, '#141413', 1), `Legacy warm drawer bg: ${drawerBg}`);
      const closeBtn = await page.$('.drawer-panel .close-btn, .drawer-footer .btn-cancel');
      if (closeBtn) await closeBtn.click();
      await delay(200);
      return { detail: 'PitScoutView & Drawer render Pit Wall surfaces', evidence: { card, drawerBg } };
    }
  },
  {
    id: 'T1-F06-02',
    tier: 1,
    feature: 'F6',
    title: 'ScheduleManager renders Pit Wall Red/Blue station cards without legacy hexes',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'schedule', '.schedule-manager');
      const sch = await page.evaluate(() => {
        const red = document.querySelector('.station-card.red');
        const blue = document.querySelector('.station-card.blue');
        return {
          redBg: red ? window.getComputedStyle(red).backgroundColor : '',
          blueBg: blue ? window.getComputedStyle(blue).backgroundColor : ''
        };
      });
      assert(sch.redBg && sch.blueBg, 'Missing schedule station cards');
      return { detail: 'ScheduleManager station cards migrated', evidence: sch };
    }
  },
  {
    id: 'T1-F06-03',
    tier: 1,
    feature: 'F6',
    title: 'RankingsTable renders gold/silver/bronze rank badges & telemetry bars without neon glow or #38bdf8',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'rankings', '.rankings-panel .ranking-row');
      const rk = await page.evaluate(() => {
        const gold = document.querySelector('.rank-index-badge.rank-gold');
        const cyanBar = document.querySelector('.telemetry-bar-fill.bar-cyan');
        const primaryBar = document.querySelector('.telemetry-bar-fill.bar-primary');
        return {
          goldColor: gold ? window.getComputedStyle(gold).color : '',
          goldShadow: gold ? window.getComputedStyle(gold).boxShadow : 'none',
          cyanBg: cyanBar ? window.getComputedStyle(cyanBar).backgroundColor : '',
          primaryShadow: primaryBar ? window.getComputedStyle(primaryBar).boxShadow : 'none'
        };
      });
      assert(!colorsEqual(rk.cyanBg, '#38bdf8', 3), `Legacy #38bdf8 telemetry bar: ${rk.cyanBg}`);
      assert(rk.goldShadow === 'none' || !rk.goldShadow.includes('0px 0px'), `Unexpected glow on gold badge: ${rk.goldShadow}`);
      return { detail: 'RankingsTable badges & telemetry bars follow Pit Wall palette', evidence: rk };
    }
  },
  {
    id: 'T1-F06-04',
    tier: 1,
    feature: 'F6',
    title: 'HistoryList & AiChatView render Cold Graphite cards and #A48CFF AI accent',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'history', '.history-panel .history-card');
      const histBg = await page.evaluate(() => window.getComputedStyle(document.querySelector('.history-card')).backgroundColor);
      await openTabAndWait(page, 'ai', '.ai-chat-view');
      const aiExists = await page.$('.ai-chat-view .chat-container, .ai-chat-view .inner-tabs');
      assert(aiExists, 'AiChatView container not rendered');
      assert(!colorsEqual(histBg, '#141413', 1), `Legacy warm history-card bg: ${histBg}`);
      return { detail: 'HistoryList & AiChatView migrated cleanly', evidence: { histBg } };
    }
  },
  {
    id: 'T1-F06-05',
    tier: 1,
    feature: 'F6',
    title: 'Static audit of pit, schedule, rankings, customFields, ai, history passes zero-legacy-hex check',
    async run(ctx) {
      const scan = getFrontendScan(ctx);
      const prefixes = ['components/pit/', 'components/schedule/', 'components/rankings/', 'components/customFields/', 'components/ai/', 'components/history/'];
      const issues = Object.entries(scan.perFile).filter(([f]) => prefixes.some((p) => f.startsWith(p)));
      assert(issues.length === 0, `Domain modules CSS issues: ${JSON.stringify(issues)}`);
      return { detail: 'All 6 domain component directories passed hex/glow/font audit' };
    }
  },

  // =========================================================================
  // F7: components/common/* Modals & Inbox 52px Cold Graphite FAB (5 tests)
  // =========================================================================
  {
    id: 'T1-F07-01',
    tier: 1,
    feature: 'F7',
    title: 'InboxWidget FAB (.inbox-morph-container) is 52x52px Cold Graphite (#151A1E) not neon green circle',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      const fab = await page.evaluate(() => {
        const el = document.querySelector('.inbox-morph-container');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = window.getComputedStyle(el);
        return { w: r.width, h: r.height, bg: cs.backgroundColor, border: cs.borderColor };
      });
      assert(fab, 'InboxWidget .inbox-morph-container not found');
      assert(Math.abs(fab.w - 52) <= 3 && Math.abs(fab.h - 52) <= 3, `Expected 52x52px FAB, got ${fab.w}x${fab.h}`);
      assert(!colorsEqual(fab.bg, '#39FF14', 30), `FAB must NOT be solid neon green (#39FF14), got ${fab.bg}`);
      assertColorMatch(fab.bg, '#151A1E', 'Inbox FAB background', 10);
      return { detail: 'Inbox FAB is 52px Cold Graphite (#151A1E)', evidence: fab };
    }
  },
  {
    id: 'T1-F07-02',
    tier: 1,
    feature: 'F7',
    title: 'Modal dialogs render #151A1E surface, #2C353C border, --shadow-3, and zero top neon-green border',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await page.waitForSelector('.host-qr-btn', { visible: true, timeout: 8000 });
      await page.click('.host-qr-btn');
      await page.waitForSelector('.modal-card, .qr-modal-dialog', { visible: true, timeout: 8000 });
      const modal = await page.evaluate(() => {
        const dlg = document.querySelector('.qr-modal-dialog, .modal-card');
        const cs = window.getComputedStyle(dlg);
        return {
          bg: cs.backgroundColor,
          borderTopColor: cs.borderTopColor,
          borderTopWidth: cs.borderTopWidth,
          boxShadow: cs.boxShadow
        };
      });
      assert(!colorsEqual(modal.borderTopColor, '#39FF14', 20), `Modal still has legacy neon-green top border: ${modal.borderTopColor}`);
      const closeBtn = await page.$('.qr-modal-dialog .close-btn, .qr-modal-dialog .btn-close, .modal-card .close-btn, .modal-card .btn-close, .modal-card .btn-cancel');
      assert(closeBtn, 'Modal close button not found for MobileQrModal');
      await closeBtn.click();
      await page.waitForFunction(() => !document.querySelector('.qr-modal-backdrop, .modal-overlay'), { timeout: 3000 });
      return { detail: 'Modal surface migrated with top neon border removed', evidence: modal };
    }
  },
  {
    id: 'T1-F07-03',
    tier: 1,
    feature: 'F7',
    title: 'ConnectionStatus & MobileStatusPill render Pit Wall capsule surface & semantic status dot',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      const desktopStatus = await page.evaluate(() => {
        const el = document.querySelector('.connection-status');
        return el ? { bg: window.getComputedStyle(el).backgroundColor, cls: el.className } : null;
      });
      assert(desktopStatus, 'ConnectionStatus element missing');
      return { detail: 'ConnectionStatus capsule rendered with Pit Wall tokens', evidence: desktopStatus };
    }
  },
  {
    id: 'T1-F07-04',
    tier: 1,
    feature: 'F7',
    title: 'MobileBottomNav & .more-sheet render Pit Wall dark chrome on 390x844 viewport',
    async run(ctx) {
      const { page } = await ensureMobilePage(ctx);
      const nav = await page.evaluate(() => {
        const el = document.querySelector('.mobile-bottom-nav');
        return el ? { bg: window.getComputedStyle(el).backgroundColor, borderTop: window.getComputedStyle(el).borderTopColor } : null;
      });
      assert(nav, 'MobileBottomNav not found on 390x844');
      assert(!colorsEqual(nav.bg, '#141413', 1), `Legacy warm gray mobile nav: ${nav.bg}`);
      return { detail: 'MobileBottomNav uses Pit Wall dark chrome', evidence: nav };
    }
  },
  {
    id: 'T1-F07-05',
    tier: 1,
    feature: 'F7',
    title: 'Static audit of components/common/* finds zero ZCOOLQingKeHuangYou & zero unallowlisted hexes',
    async run(ctx) {
      const scan = getFrontendScan(ctx);
      const commonIssues = Object.entries(scan.perFile).filter(([f]) => f.startsWith('components/common/'));
      assert(commonIssues.length === 0, `Common component audit issues: ${JSON.stringify(commonIssues)}`);
      return { detail: 'All files in components/common/* passed font/hex/glow audit' };
    }
  },

  // =========================================================================
  // F8: Typography (Manrope -> NotoSansSC headings, Orbitron + tabular-nums) (5 tests)
  // =========================================================================
  {
    id: 'T1-F08-01',
    tier: 1,
    feature: 'F8',
    title: 'Body and H1/H2/H3 headings compute Manrope/NotoSansSC (never ZCOOLQingKeHuangYou or Orbitron)',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      const fonts = await page.evaluate(() => {
        const bodyFf = window.getComputedStyle(document.body).fontFamily;
        const headings = Array.from(document.querySelectorAll('h1, h2, h3')).map((h) => ({
          tag: h.tagName,
          ff: window.getComputedStyle(h).fontFamily
        }));
        return { bodyFf, headings };
      });
      assert(fonts.bodyFf.toLowerCase().includes('manrope'), `Body font-family missing Manrope: ${fonts.bodyFf}`);
      for (const h of fonts.headings) {
        const low = h.ff.toLowerCase();
        assert(!low.includes('zcoolqingkehuangyou'), `${h.tag} still uses ZCOOLQingKeHuangYou: ${h.ff}`);
        assert(!low.includes('orbitron'), `${h.tag} should use Manrope/NotoSansSC, not Orbitron: ${h.ff}`);
      }
      return { detail: 'Body & headings use Manrope/NotoSansSC', evidence: fonts };
    }
  },
  {
    id: 'T1-F08-02',
    tier: 1,
    feature: 'F8',
    title: 'Numeric readouts (scores, team numbers, invite codes) use Orbitron + tabular-nums',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'scout', '.total-score-inline .total-value');
      const totalFont = await page.evaluate(() => {
        const el = document.querySelector('.total-score-inline .total-value');
        const cs = window.getComputedStyle(el);
        return { ff: cs.fontFamily, fvn: cs.fontVariantNumeric };
      });
      await openTabAndWait(page, 'rankings', '.rankings-panel .team-number, .rankings-panel .advancement-score-val');
      const rankFont = await page.evaluate(() => {
        const el = document.querySelector('.rankings-panel .team-number, .rankings-panel .advancement-score-val');
        const cs = el ? window.getComputedStyle(el) : null;
        return cs ? { ff: cs.fontFamily, fvn: cs.fontVariantNumeric } : null;
      });
      assert(totalFont.ff.toLowerCase().includes('orbitron'), `Total score missing Orbitron: ${totalFont.ff}`);
      assert(totalFont.fvn.includes('tabular-nums'), `Total score missing tabular-nums: ${totalFont.fvn}`);
      assert(rankFont && rankFont.ff.toLowerCase().includes('orbitron'), `Rankings numeric missing Orbitron: ${JSON.stringify(rankFont)}`);
      return { detail: 'Numeric readouts use Orbitron + tabular-nums', evidence: { totalFont, rankFont } };
    }
  },
  {
    id: 'T1-F08-03',
    tier: 1,
    feature: 'F8',
    title: 'LoginView title & Powered-by typography render crisp Manrope/Orbitron hierarchy',
    async run(ctx) {
      const page = await ctx.browserHandle.openCleanPage(DESKTOP_VIEWPORT);
      try {
        await page.goto(ctx.baseUrl, { waitUntil: 'networkidle0', timeout: 15000 });
        await waitForTransition(page);
        const h1Font = await page.evaluate(() => {
          const h1 = document.querySelector('.login-card h1, h1');
          return h1 ? window.getComputedStyle(h1).fontFamily : '';
        });
        assert(!h1Font.toLowerCase().includes('zcool'), `Login h1 uses ZCOOL font: ${h1Font}`);
        return { detail: 'LoginView typography free of ZCOOL fallback', evidence: { h1Font } };
      } finally {
        await page.close();
      }
    }
  },
  {
    id: 'T1-F08-04',
    tier: 1,
    feature: 'F8',
    title: 'Hit/Miss big readouts compute Orbitron + tabular-nums without clipping',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      await openTabAndWait(page, 'scout', '.pad-big-readout');
      const readout = await page.evaluate(() => {
        const el = document.querySelector('.pad-big-readout');
        const cs = window.getComputedStyle(el);
        return { ff: cs.fontFamily, fvn: cs.fontVariantNumeric, h: el.getBoundingClientRect().height };
      });
      assert(readout.h > 10, 'Pad readout height is 0');
      assert(readout.fvn.includes('tabular-nums') || readout.ff.toLowerCase().includes('orbitron'), `Pad readout font check: ${JSON.stringify(readout)}`);
      return { detail: 'Pad big readout typography verified', evidence: readout };
    }
  },
  {
    id: 'T1-F08-05',
    tier: 1,
    feature: 'F8',
    title: 'main.css h1/h2/h3 rule uses Manrope/NotoSansSC instead of Orbitron/ZCOOLQingKeHuangYou',
    async run(ctx) {
      const mainCss = fs.readFileSync(path.join(ctx.repoRoot, 'frontend/src/assets/main.css'), 'utf8');
      const headingMatch = mainCss.match(/h1\s*,\s*h2\s*,\s*h3[^}]*\{[^}]*\}/i);
      assert(headingMatch, 'Heading rule not found in main.css');
      assert(!headingMatch[0].includes('ZCOOLQingKeHuangYou'), `Heading stack still includes ZCOOLQingKeHuangYou: ${headingMatch[0]}`);
      assert(!headingMatch[0].includes('Orbitron'), `Heading stack should not include Orbitron: ${headingMatch[0]}`);
      if (headingMatch[0].includes('var(--font-sans)')) {
        const fontSansMatch = mainCss.match(/--font-sans\s*:\s*([^;]+);/);
        assert(fontSansMatch, '--font-sans token missing in main.css');
        const stack = fontSansMatch[1];
        assert(
          stack.includes('Manrope') && stack.includes('NotoSansSC') && stack.indexOf('Manrope') < stack.indexOf('NotoSansSC'),
          `--font-sans must resolve Manrope -> NotoSansSC: ${stack}`
        );
        assert(!stack.includes('ZCOOLQingKeHuangYou') && !stack.includes('Orbitron'), `--font-sans must not contain ZCOOL/Orbitron: ${stack}`);
      } else {
        assert(headingMatch[0].includes('Manrope'), `Heading stack missing Manrope: ${headingMatch[0]}`);
      }
      return { detail: 'main.css heading rule updated to Manrope -> NotoSansSC' };
    }
  },

  // =========================================================================
  // F9: Font File Removal & @font-face Cleanup (5 tests)
  // =========================================================================
  {
    id: 'T1-F09-01',
    tier: 1,
    feature: 'F9',
    title: 'Removed TTFs (PinyonScript, ZCOOLXiaoWei, ZCOOLQingKeHuangYou) absent from frontend/src/assets/fonts/',
    async run(ctx) {
      const dir = path.join(ctx.repoRoot, 'frontend/src/assets/fonts');
      const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      const forbidden = files.filter((f) => REMOVED_FONT_NAMES.some((r) => f.toLowerCase().includes(r.toLowerCase())));
      assert(forbidden.length === 0, `Removed fonts still in frontend/src/assets/fonts: ${forbidden.join(', ')}`);
      return { detail: `Kept fonts in src/assets/fonts: ${files.join(', ')}` };
    }
  },
  {
    id: 'T1-F09-02',
    tier: 1,
    feature: 'F9',
    title: 'Removed TTFs absent from frontend/public/assets/',
    async run(ctx) {
      const dir = path.join(ctx.repoRoot, 'frontend/public/assets');
      const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      const forbidden = files.filter((f) => REMOVED_FONT_NAMES.some((r) => f.toLowerCase().includes(r.toLowerCase())));
      assert(forbidden.length === 0, `Removed fonts still in frontend/public/assets: ${forbidden.join(', ')}`);
      return { detail: `Kept assets in frontend/public/assets: ${files.join(', ')}` };
    }
  },
  {
    id: 'T1-F09-03',
    tier: 1,
    feature: 'F9',
    title: 'Removed TTFs absent from Backend/src/main/resources/assets/',
    async run(ctx) {
      const dir = path.join(ctx.repoRoot, 'Backend/src/main/resources/assets');
      const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      const forbidden = files.filter((f) => REMOVED_FONT_NAMES.some((r) => f.toLowerCase().includes(r.toLowerCase())));
      assert(forbidden.length === 0, `Removed fonts still in Backend resources/assets: ${forbidden.join(', ')}`);
      return { detail: `Kept Backend assets: ${files.join(', ')}` };
    }
  },
  {
    id: 'T1-F09-04',
    tier: 1,
    feature: 'F9',
    title: '@font-face in main.css declares ONLY Manrope, NotoSansSC, Orbitron and kept TTFs match SHA-256 across dirs',
    async run(ctx) {
      const mainCss = fs.readFileSync(path.join(ctx.repoRoot, 'frontend/src/assets/main.css'), 'utf8');
      const fontFaces = Array.from(mainCss.matchAll(/@font-face\s*\{[\s\S]*?font-family\s*:\s*['"]([^'"]+)['"][\s\S]*?\}/gi)).map((m) => m[1]);
      for (const ff of fontFaces) {
        assert(['Manrope', 'NotoSansSC', 'Orbitron'].includes(ff), `Unexpected @font-face family: ${ff}`);
      }
      assert(fontFaces.includes('Manrope') && fontFaces.includes('Orbitron') && fontFaces.includes('NotoSansSC'), `Missing required @font-face: ${fontFaces.join(', ')}`);

      const pubAssets = path.join(ctx.repoRoot, 'frontend/public/assets');
      const beAssets = path.join(ctx.repoRoot, 'Backend/src/main/resources/assets');
      for (const name of ['Manrope-VariableFont_wght-0N3pECc_.ttf', 'NotoSansSC-VariableFont_wght.ttf', 'Orbitron-VariableFont_wght-CYB_IVAf.ttf']) {
        const p1 = path.join(pubAssets, name);
        const p2 = path.join(beAssets, name);
        assert(fs.existsSync(p1) && fs.existsSync(p2), `Missing kept font ${name}`);
        assert(sha256File(p1) === sha256File(p2), `SHA-256 mismatch for ${name}`);
      }
      return { detail: '3 kept @font-face families & SHA-256 parity verified', evidence: fontFaces };
    }
  },
  {
    id: 'T1-F09-05',
    tier: 1,
    feature: 'F9',
    title: 'Browser document.fonts loads Manrope & Orbitron cleanly with zero 404 font requests',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      const loaded = await page.evaluate(async () => {
        await document.fonts.ready;
        return Array.from(document.fonts).map((f) => ({ family: f.family, status: f.status }));
      });
      const families = loaded.map((f) => f.family.replace(/['"]/g, ''));
      assert(families.includes('Manrope') || families.includes('Orbitron'), `Loaded fonts unexpected: ${JSON.stringify(loaded)}`);
      const removedLoaded = families.filter((f) => REMOVED_FONT_NAMES.includes(f));
      assert(removedLoaded.length === 0, `Removed fonts loaded by browser: ${removedLoaded.join(', ')}`);
      return { detail: 'Browser document.fonts verified clean', evidence: loaded.slice(0, 6) };
    }
  },

  // =========================================================================
  // F10: Motion Duration Tightening (160/240/320/480ms + ease-out) (5 tests)
  // =========================================================================
  {
    id: 'T1-F10-01',
    tier: 1,
    feature: 'F10',
    title: 'Root motion duration tokens equal 160ms, 240ms, 320ms, 480ms',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      const expected = {
        '--motion-duration-fast': 160,
        '--motion-duration-moderate': 240,
        '--motion-duration-normal': 320,
        '--motion-duration-slow': 480
      };
      const measured = {};
      for (const [tok, ms] of Object.entries(expected)) {
        const raw = await readRootCssVar(page, tok);
        const parsed = normalizeDurationMs(raw);
        assert(parsed === ms, `${tok} expected ${ms}ms, got "${raw}" (${parsed}ms)`);
        measured[tok] = raw;
      }
      return { detail: 'Motion durations tightened to 160/240/320/480ms', evidence: measured };
    }
  },
  {
    id: 'T1-F10-02',
    tier: 1,
    feature: 'F10',
    title: '--motion-ease-out preserves cubic-bezier(0.16, 1, 0.3, 1)',
    async run(ctx) {
      const { page } = await ensureDesktopSession(ctx);
      const ease = await readRootCssVar(page, '--motion-ease-out');
      const normalized = ease.replace(/\s+/g, '');
      assert(normalized === 'cubic-bezier(0.16,1,0.3,1)', `Unexpected --motion-ease-out: "${ease}"`);
      return { detail: '--motion-ease-out verified', evidence: ease };
    }
  },
  {
    id: 'T1-F10-03',
    tier: 1,
    feature: 'F10',
    title: 'App.vue page transition & boot splash fade-out complete within tightened <= 480ms',
    async run(ctx) {
      const appVue = fs.readFileSync(path.join(ctx.repoRoot, 'frontend/src/App.vue'), 'utf8');
      assert(!/1100/.test(appVue), 'App.vue still contains legacy 1100ms boot timeout');
      assert(!/0\.85s|850ms/i.test(appVue), 'App.vue still contains legacy 0.85s page transition');
      return { detail: 'App.vue boot & page transitions tightened' };
    }
  },
  {
    id: 'T1-F10-04',
    tier: 1,
    feature: 'F10',
    title: 'TeamDetailView sheet route transition opens & closes smoothly without lingering data-direction',
    async run(ctx) {
      const { page, eventId } = await ensureDesktopSession(ctx);
      const t0 = Date.now();
      await page.goto(`${ctx.baseUrl}#/event/${encodeURIComponent(eventId)}/team/27570`, {
        waitUntil: 'networkidle0',
        timeout: 15000
      });
      await page.waitForSelector('.team-detail-view', { visible: true, timeout: 8000 });
      await waitForTransition(page);
      const elapsed = Date.now() - t0;
      const closeBtn = await page.$('.team-detail-view .btn-close, .team-detail-view .btn-back');
      if (closeBtn) {
        await closeBtn.click();
        await waitForTransition(page);
      }
      assert(elapsed < 4000, `TeamDetail transition took too long: ${elapsed}ms`);
      return { detail: `TeamDetail transition settled in ${elapsed}ms` };
    }
  },
  {
    id: 'T1-F10-05',
    tier: 1,
    feature: 'F10',
    title: 'Static scan across frontend/src finds zero legacy 0.272/0.476/0.612/0.816/0.85s durations',
    async run(ctx) {
      const scan = getFrontendScan(ctx);
      assert(
        scan.totals.legacyDurations.length === 0,
        `Legacy motion durations remain: ${JSON.stringify(scan.totals.legacyDurations)}`
      );
      return { detail: 'Zero legacy 0.272/0.476/0.612/0.816/0.85s durations found' };
    }
  },

  // =========================================================================
  // F11: SP27 Logo Redesign & SVG/PNG/ICO/PWA Regeneration (5 tests)
  // =========================================================================
  {
    id: 'T1-F11-01',
    tier: 1,
    feature: 'F11',
    title: 'frontend/public/icon.svg & favicon.svg use sharp SP27 monogram (no 3-hexagon honeycomb)',
    async run(ctx) {
      for (const name of ['icon.svg', 'favicon.svg']) {
        const text = fs.readFileSync(path.join(ctx.repoRoot, 'frontend/public', name), 'utf8');
        const audit = auditBrandSvg(text);
        assert(audit.ok, `${name} failed Pit Wall SVG audit: ${JSON.stringify(audit)}`);
      }
      return { detail: 'icon.svg and favicon.svg match SP27 Pit Wall geometric monogram' };
    }
  },
  {
    id: 'T1-F11-02',
    tier: 1,
    feature: 'F11',
    title: 'pwa-192x192.png is exact 192x192 RGBA PNG and pwa-512x512.png is exact 512x512 RGBA PNG',
    async run(ctx) {
      const p192 = readPngFile(path.join(ctx.repoRoot, 'frontend/public/pwa-192x192.png'));
      const p512 = readPngFile(path.join(ctx.repoRoot, 'frontend/public/pwa-512x512.png'));
      assert(p192.width === 192 && p192.height === 192, `pwa-192x192.png wrong dims: ${p192.width}x${p192.height}`);
      assert(p512.width === 512 && p512.height === 512, `pwa-512x512.png wrong dims: ${p512.width}x${p512.height}`);
      assert(p192.colorType === 6 && p512.colorType === 6, 'PWA icons must be RGBA (colorType=6)');
      assert(p192.sampleStats().pitGreenCount > 50, 'pwa-192x192.png missing #39FF14 brand pixels');
      return { detail: 'PWA 192x192 and 512x512 RGBA PNGs verified' };
    }
  },
  {
    id: 'T1-F11-03',
    tier: 1,
    feature: 'F11',
    title: 'logo_24..128.png match exact pixel sizes, #39FF14 pixels, and SHA-256 parity with Backend',
    async run(ctx) {
      const sizes = [24, 28, 30, 36, 42, 48, 60, 64, 128];
      for (const sz of sizes) {
        const fePath = path.join(ctx.repoRoot, 'frontend/public', `logo_${sz}.png`);
        const bePath = path.join(ctx.repoRoot, 'Backend/src/main/resources', `logo_${sz}.png`);
        assert(fs.existsSync(fePath) && fs.existsSync(bePath), `Missing logo_${sz}.png`);
        const png = readPngFile(fePath);
        assert(png.width === sz && png.height === sz, `logo_${sz}.png dims ${png.width}x${png.height}`);
        assert(png.colorType === 6, `logo_${sz}.png not RGBA`);
        assert(png.sampleStats().pitGreenCount > 0, `logo_${sz}.png has no #39FF14 pixels`);
        assert(sha256File(fePath) === sha256File(bePath), `SHA-256 mismatch on logo_${sz}.png`);
      }
      return { detail: 'All 9 logo_24..128.png assets verified & synced to Backend' };
    }
  },
  {
    id: 'T1-F11-04',
    tier: 1,
    feature: 'F11',
    title: 'favicon.ico & Backend icon.ico contain 9 valid 32bpp entries (16..256) and match SHA-256',
    async run(ctx) {
      const feIco = path.join(ctx.repoRoot, 'frontend/public/favicon.ico');
      const beIco = path.join(ctx.repoRoot, 'Backend/src/main/resources/icon.ico');
      const parsed = parseIco(fs.readFileSync(feIco));
      const required = [16, 20, 24, 32, 40, 48, 64, 128, 256];
      const present = parsed.entries.map((e) => e.width);
      for (const r of required) {
        assert(present.includes(r), `ICO missing ${r}x${r} entry`);
      }
      assert(parsed.entries.every((e) => e.bpp === 32), 'All ICO entries must be 32bpp');
      assert(sha256File(feIco) === sha256File(beIco), 'favicon.ico and Backend icon.ico SHA-256 mismatch');
      return { detail: `ICO verified with ${parsed.count} 32bpp entries (${present.join(',')})` };
    }
  },
  {
    id: 'T1-F11-05',
    tier: 1,
    feature: 'F11',
    title: 'logo_transparent.png synced across frontend/public, Backend root, and Backend/assets',
    async run(ctx) {
      const p1 = path.join(ctx.repoRoot, 'frontend/public/logo_transparent.png');
      const p2 = path.join(ctx.repoRoot, 'Backend/src/main/resources/logo_transparent.png');
      const p3 = path.join(ctx.repoRoot, 'Backend/src/main/resources/assets/logo_transparent.png');
      assert(fs.existsSync(p1) && fs.existsSync(p2) && fs.existsSync(p3), 'logo_transparent.png missing in one of 3 destinations');
      const h1 = sha256File(p1);
      assert(h1 === sha256File(p2) && h1 === sha256File(p3), 'logo_transparent.png SHA-256 mismatch across destinations');
      const png = readPngFile(p1);
      assert(png.width === 512 && png.height === 512 && png.colorType === 6, 'logo_transparent.png must be 512x512 RGBA');
      assert(png.inspectBorder(4).allCornersTransparent, 'logo_transparent.png corners must be transparent');
      return { detail: 'logo_transparent.png 512x512 RGBA & 3-way SHA-256 parity verified' };
    }
  },

  // =========================================================================
  // F12: logo-bear.png True-Alpha Transparent RGBA PNG Conversion (5 tests)
  // =========================================================================
  {
    id: 'T1-F12-01',
    tier: 1,
    feature: 'F12',
    title: 'logo-bear.png is a genuine PNG (magic 89 50 4E 47) and NOT a JPEG',
    async run(ctx) {
      const bearPath = path.join(ctx.repoRoot, 'Backend/src/main/resources/assets/logo-bear.png');
      const buf = fs.readFileSync(bearPath);
      assert(!isJpegBuffer(buf), 'logo-bear.png is still disguised JPEG (FF D8 FF)');
      const png = readPngFile(bearPath);
      return { detail: `logo-bear.png decoded as true PNG ${png.width}x${png.height}` };
    }
  },
  {
    id: 'T1-F12-02',
    tier: 1,
    feature: 'F12',
    title: 'logo-bear.png IHDR reports colorType=6 (RGBA), bitDepth=8, height >= 300',
    async run(ctx) {
      const png = readPngFile(path.join(ctx.repoRoot, 'Backend/src/main/resources/assets/logo-bear.png'));
      assert(png.colorType === 6 && png.bitDepth === 8, `Expected 8-bit RGBA, got bd=${png.bitDepth} ct=${png.colorType}`);
      assert(png.height >= 300, `Expected height >= 300px, got ${png.height}`);
      return { detail: `IHDR ${png.width}x${png.height} 8-bit RGBA` };
    }
  },
  {
    id: 'T1-F12-03',
    tier: 1,
    feature: 'F12',
    title: 'logo-bear.png has all 4 corners transparent (alpha === 0)',
    async run(ctx) {
      const png = readPngFile(path.join(ctx.repoRoot, 'Backend/src/main/resources/assets/logo-bear.png'));
      const border = png.inspectBorder(5);
      assert(border.allCornersTransparent, `Non-transparent corners on logo-bear.png: ${JSON.stringify(border.corners)}`);
      return { detail: 'All 4 corners alpha === 0', evidence: border.corners };
    }
  },
  {
    id: 'T1-F12-04',
    tier: 1,
    feature: 'F12',
    title: 'logo-bear.png perimeter has true transparent background (< 5% opaque #000000 pixels)',
    async run(ctx) {
      const png = readPngFile(path.join(ctx.repoRoot, 'Backend/src/main/resources/assets/logo-bear.png'));
      const border = png.inspectBorder(6);
      assert(border.opaqueBlackRatio < 0.05, `Too many opaque #000000 border pixels (${(border.opaqueBlackRatio * 100).toFixed(1)}%)`);
      assert(border.transparentRatio >= 0.5, `Expected transparent perimeter >= 50%, got ${(border.transparentRatio * 100).toFixed(1)}%`);
      return { detail: `Border transparent=${(border.transparentRatio * 100).toFixed(1)}%, opaqueBlack=${(border.opaqueBlackRatio * 100).toFixed(2)}%` };
    }
  },
  {
    id: 'T1-F12-05',
    tier: 1,
    feature: 'F12',
    title: 'logo-bear.png interior contains opaque emblem pixels (alpha >= 200)',
    async run(ctx) {
      const png = readPngFile(path.join(ctx.repoRoot, 'Backend/src/main/resources/assets/logo-bear.png'));
      const stats = png.sampleStats();
      assert(stats.opaqueCount > 1000, `logo-bear.png lacks opaque emblem content: ${JSON.stringify(stats)}`);
      assert(stats.transparentCount > 1000, `logo-bear.png lacks transparent background area: ${JSON.stringify(stats)}`);
      return { detail: 'Opaque emblem & transparent alpha region both present', evidence: stats };
    }
  },

  // =========================================================================
  // F13: Web Boot Layer (index.html + App.vue fade-out) (5 tests)
  // =========================================================================
  {
    id: 'T1-F13-01',
    tier: 1,
    feature: 'F13',
    title: 'frontend/index.html defines inline html, body background #0B0E10 before JS execution',
    async run(ctx) {
      const html = fs.readFileSync(path.join(ctx.repoRoot, 'frontend/index.html'), 'utf8');
      assert(/<style[^>]*>[\s\S]*?#0b0e10[\s\S]*?<\/style>/i.test(html), 'index.html missing inline #0B0E10 style');
      return { detail: 'index.html inline #0B0E10 style present' };
    }
  },
  {
    id: 'T1-F13-02',
    tier: 1,
    feature: 'F13',
    title: 'frontend/index.html includes pre-JS Pit Wall boot splash (logo + #1B2126/#39FF14 progress bar)',
    async run(ctx) {
      const html = fs.readFileSync(path.join(ctx.repoRoot, 'frontend/index.html'), 'utf8');
      assert(/<img[^>]+logo_transparent\.png/i.test(html) || /<svg/i.test(html), 'index.html pre-JS splash missing logo');
      assert(/#1b2126/i.test(html) && /#39ff14/i.test(html), 'index.html pre-JS splash missing #1B2126 track / #39FF14 bar');
      return { detail: 'index.html pre-JS Pit Wall boot splash markup verified' };
    }
  },
  {
    id: 'T1-F13-03',
    tier: 1,
    feature: 'F13',
    title: 'Initial DOMContentLoaded render in browser paints #0B0E10 with zero white flash',
    async run(ctx) {
      const page = await ctx.browserHandle.openCleanPage(DESKTOP_VIEWPORT);
      try {
        await page.goto(ctx.baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const bg = await page.evaluate(() => ({
          htmlBg: window.getComputedStyle(document.documentElement).backgroundColor,
          bodyBg: window.getComputedStyle(document.body).backgroundColor
        }));
        assertColorMatch(bg.bodyBg, '#0B0E10', 'Initial body background', 4);
        assert(!colorsEqual(bg.htmlBg, '#FFFFFF', 10) && !colorsEqual(bg.bodyBg, '#FFFFFF', 10), 'White flash background detected');
        return { detail: 'Zero white flash on DOMContentLoaded (#0B0E10)', evidence: bg };
      } finally {
        await page.close();
      }
    }
  },
  {
    id: 'T1-F13-04',
    tier: 1,
    feature: 'F13',
    title: 'App.vue smoothly fades out (~240ms) and removes pre-JS boot splash after mount',
    async run(ctx) {
      const page = await ctx.browserHandle.openCleanPage(DESKTOP_VIEWPORT);
      try {
        await page.goto(ctx.baseUrl, { waitUntil: 'networkidle0', timeout: 20000 });
        await delay(650);
        const splashVisible = await page.evaluate(() => {
          const els = document.querySelectorAll('#web-boot-splash, #pitwall-boot-splash, #boot-splash, .boot-splash, .tactical-boot-overlay');
          for (const el of els) {
            const cs = window.getComputedStyle(el);
            if (cs.display !== 'none' && Number(cs.opacity) > 0.05) return true;
          }
          return false;
        });
        assert(!splashVisible, 'Web boot splash / tactical-boot-overlay remained visible >650ms after Vue mount');
        return { detail: 'Web boot splash fades out and unmounts cleanly after mount' };
      } finally {
        await page.close();
      }
    }
  },
  {
    id: 'T1-F13-05',
    tier: 1,
    feature: 'F13',
    title: 'Document meta theme-color / PWA color aligns to #0B0E10',
    async run(ctx) {
      const html = fs.readFileSync(path.join(ctx.repoRoot, 'frontend/index.html'), 'utf8');
      const metaMatch = html.match(/<meta[^>]+name=["']theme-color["'][^>]*>/i);
      if (metaMatch) {
        assert(/#0b0e10/i.test(metaMatch[0]), `index.html theme-color meta not #0B0E10: ${metaMatch[0]}`);
      }
      const viteCfg = fs.readFileSync(path.join(ctx.repoRoot, 'frontend/vite.config.ts'), 'utf8');
      assert(/theme_color:\s*['"]#0b0e10['"]/i.test(viteCfg), 'vite.config.ts theme_color not #0B0E10');
      return { detail: 'Theme-color aligned to #0B0E10' };
    }
  },

  // =========================================================================
  // F14: Java SplashScreen.java Pit Wall Redesign & Main.java Failure Retention (5 tests)
  // =========================================================================
  {
    id: 'T1-F14-01',
    tier: 1,
    feature: 'F14',
    title: 'SplashScreen.java implements Pit Wall 560x380, #0B0E10, #1B2126, #39FF14, 45ms typewriter, 5 segments, legible Bear mark',
    async run(ctx) {
      const java = fs.readFileSync(path.join(ctx.repoRoot, 'Backend/src/main/java/com/bear27570/app/SplashScreen.java'), 'utf8');
      assert(java.includes('560') && java.includes('380'), 'SplashScreen.java missing 560x380 dimensions');
      assert(/0x0B\s*,\s*0x0E\s*,\s*0x10/i.test(java), 'SplashScreen.java missing #0B0E10 background');
      assert(/0x1B\s*,\s*0x21\s*,\s*0x26/i.test(java), 'SplashScreen.java missing #1B2126 border');
      assert(/0x39\s*,\s*0xFF\s*,\s*0x14/i.test(java), 'SplashScreen.java missing #39FF14 accent');
      assert(/TITLE_CHAR_MS\s*=\s*45\b/.test(java), 'SplashScreen.java TITLE_CHAR_MS is not 45');
      assert(java.includes('SYSTEM BOOT') && java.includes('B.E.A.R ROBOTICS'), 'SplashScreen.java missing SYSTEM BOOT or B.E.A.R ROBOTICS footer');

      // Follow-up #2 / PROJECT.md:93: Bear footer mark must be >= 32px tall or use cropped emblem
      const usesCroppedBear = /getSubimage|crop|bear[_-]?emblem/i.test(java);
      if (!usesCroppedBear) {
        assert(
          !/\b(?:bear|footerLogo|logo)H(?:eight)?\s*=\s*(?:1\d|2[0-9]|3[01])\b/i.test(java),
          'SplashScreen.java scales full logo-bear.png too small (< 32px) per PROJECT.md:93'
        );
        const hMatch = java.match(/\b(?:bear(?:Logo)?H(?:eight)?|BEAR_LOGO_HEIGHT|footerBearH(?:eight)?)\s*=\s*(\d+)/i);
        if (hMatch) {
          assert(Number(hMatch[1]) >= 32, `SplashScreen.java Bear footer height ${hMatch[1]}px < 32px`);
        }
      }
      return { detail: 'SplashScreen.java Pit Wall design constants & Bear footer sizing verified' };
    }
  },
  {
    id: 'T1-F14-02',
    tier: 1,
    feature: 'F14',
    title: 'Main.java emits all 6 English boot status strings and keeps Splash visible on startup failure',
    async run(ctx) {
      const mainJava = fs.readFileSync(path.join(ctx.repoRoot, 'Backend/src/main/java/com/bear27570/app/Main.java'), 'utf8');
      const requiredStrings = [
        'Preparing database...',
        'Connecting to database...',
        'Starting local server...',
        'Initializing browser engine...',
        'Loading interface...',
        'Ready'
      ];
      for (const s of requiredStrings) {
        assert(mainJava.includes(s), `Main.java missing English boot message: "${s}"`);
      }
      const catchBlock = mainJava.match(/catch\s*\([^)]*\)\s*\{[\s\S]*?Startup failed:[\s\S]*?\}/);
      assert(catchBlock, 'Main.java catch block with "Startup failed:" not found');
      assert(!/splash\.dispose\(\)\s*;\s*[\r\n]+\s*JOptionPane/i.test(catchBlock[0]), 'Main.java still calls splash.dispose() immediately before error display');
      return { detail: 'Main.java English boot statuses & error-state splash retention verified' };
    }
  },
  {
    id: 'T1-F14-03',
    tier: 1,
    feature: 'F14',
    title: 'Maven executes >= 1 SplashScreen JUnit visual/unit test with 0 failures',
    async run(ctx) {
      const run = runBackendUiAndSplashTests(ctx);
      assert(run.exitCode === 0, `Maven UI test run failed (exit ${run.exitCode}):\n${run.stdout.slice(-800)}`);
      const splashReports = run.reports.filter((r) => /splash/i.test(r.name));
      assert(splashReports.length > 0, `No SplashScreen Surefire report found. Available: ${run.reports.map((r) => r.name).join(', ')}`);
      const totalTests = splashReports.reduce((s, r) => s + r.tests, 0);
      const totalFails = splashReports.reduce((s, r) => s + r.failures + r.errors, 0);
      assert(totalTests >= 1 && totalFails === 0, `Splash tests invalid: tests=${totalTests}, fails=${totalFails}`);
      return { detail: `Executed ${totalTests} SplashScreen test(s) with 0 failures`, evidence: splashReports };
    }
  },
  {
    id: 'T1-F14-04',
    tier: 1,
    feature: 'F14',
    title: 'Rendered SplashScreen PNGs in %TEMP%/sp27-tests/ are 560x380 with #0B0E10 bg & #1B2126 border',
    async run(ctx) {
      const run = runBackendUiAndSplashTests(ctx);
      const splashPngs = findSplashRenderPngs(run.sp27TestsDir, run.copiedPngs);
      assert(splashPngs.length >= 1, `No rendered splash*.png found in ${run.sp27TestsDir}`);
      const summary = [];
      for (const item of splashPngs) {
        const { png, name } = item;
        assert(png.width === 560 && png.height === 380, `${name} expected 560x380, got ${png.width}x${png.height}`);
        const bgPx = png.getPixel(30, 50);
        const diffBg = Math.abs(bgPx[0] - 0x0b) + Math.abs(bgPx[1] - 0x0e) + Math.abs(bgPx[2] - 0x10);
        assert(diffBg <= 18, `${name} background at (30,50) expected ~#0B0E10, got rgb(${bgPx.slice(0, 3).join(',')})`);

        // Verify 1px #1B2126 inner border along bottom/left/right mid-edges
        let borderHits = 0;
        for (let x = 200; x <= 360; x += 8) {
          for (const y of [378, 379]) {
            const [r, g, b, a] = png.getPixel(x, y);
            if (a > 128 && Math.abs(r - 0x1b) + Math.abs(g - 0x21) + Math.abs(b - 0x26) <= 18) {
              borderHits += 1;
            }
          }
        }
        for (let y = 140; y <= 240; y += 8) {
          for (const x of [0, 1, 558, 559]) {
            const [r, g, b, a] = png.getPixel(x, y);
            if (a > 128 && Math.abs(r - 0x1b) + Math.abs(g - 0x21) + Math.abs(b - 0x26) <= 18) {
              borderHits += 1;
            }
          }
        }
        assert(borderHits > 0, `${name} missing #1B2126 inner border pixels on mid-edges`);
        summary.push({ name, width: png.width, height: png.height, bgPx, borderHits });
      }
      return { detail: `Verified ${splashPngs.length} rendered SplashScreen PNG(s)`, evidence: summary };
    }
  },
  {
    id: 'T1-F14-05',
    tier: 1,
    feature: 'F14',
    title: 'Rendered SplashScreen PNGs show #39FF14 accent pixels and required error-state #FF5577 PNG',
    async run(ctx) {
      const run = runBackendUiAndSplashTests(ctx);
      const splashPngs = findSplashRenderPngs(run.sp27TestsDir, run.copiedPngs);
      assert(splashPngs.length >= 1, 'No rendered splash PNGs to inspect');
      const hasGreen = splashPngs.some((s) => s.png.sampleStats().pitGreenCount > 20);
      assert(hasGreen, 'No #39FF14 highlight/accent pixels found in any rendered SplashScreen PNG');
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
      assert(roseCount > 10, `Error splash PNG "${errImg.name}" missing #FF5577 failure pixels (found ${roseCount})`);
      return { detail: `SplashScreen #39FF14 accents and #FF5577 error PNG (${errImg.name}) verified` };
    }
  },

  // =========================================================================
  // F15: CustomTitleBar.java & Main.java Cold Graphite Desktop Chrome (5 tests)
  // =========================================================================
  {
    id: 'T1-F15-01',
    tier: 1,
    feature: 'F15',
    title: 'CustomTitleBar.java & Main.java use #0B0E10 / #1B2126 / #E6EBEE Cold Graphite chrome',
    async run(ctx) {
      const tb = fs.readFileSync(path.join(ctx.repoRoot, 'Backend/src/main/java/com/bear27570/app/ui/CustomTitleBar.java'), 'utf8');
      const mn = fs.readFileSync(path.join(ctx.repoRoot, 'Backend/src/main/java/com/bear27570/app/Main.java'), 'utf8');
      assert(/0x0B\s*,\s*0x0E\s*,\s*0x10/i.test(tb), 'CustomTitleBar.java missing #0B0E10 BG_COLOR');
      assert(/0x1B\s*,\s*0x21\s*,\s*0x26/i.test(tb), 'CustomTitleBar.java missing #1B2126 BORDER_COLOR');
      assert(/0xE6\s*,\s*0xEB\s*,\s*0xEE/i.test(tb), 'CustomTitleBar.java missing #E6EBEE TEXT_COLOR');
      assert(/0x0B\s*,\s*0x0E\s*,\s*0x10/i.test(mn), 'Main.java missing #0B0E10 windowBg');
      return { detail: 'CustomTitleBar.java & Main.java Cold Graphite constants verified' };
    }
  },
  {
    id: 'T1-F15-02',
    tier: 1,
    feature: 'F15',
    title: 'Maven UI tests (AppIconMultiRes, TitleBarVisualRender, LogoHiDpi, FullWindowRounded, Drag) pass',
    async run(ctx) {
      const run = runBackendUiAndSplashTests(ctx);
      assert(run.exitCode === 0, `Maven UI tests failed (exit ${run.exitCode})`);
      const expected = ['AppIconMultiResTest', 'TitleBarVisualRenderTest', 'LogoHiDpiVisualRenderTest', 'FullWindowRoundedRenderTest', 'CustomTitleBarDragTest'];
      for (const cls of expected) {
        const rep = run.reports.find((r) => r.name.includes(cls));
        assert(rep && rep.tests >= 1 && rep.failures === 0 && rep.errors === 0, `Surefire report failed or missing for ${cls}: ${JSON.stringify(rep)}`);
      }
      return { detail: 'All 5 desktop UI JUnit suites passed with 0 failures' };
    }
  },
  {
    id: 'T1-F15-03',
    tier: 1,
    feature: 'F15',
    title: 'titlebar_visual_render.png (1024x38) center pixel is #0B0E10 and bottom border is #1B2126',
    async run(ctx) {
      const run = runBackendUiAndSplashTests(ctx);
      const tbPath = path.join(run.sp27TestsDir, 'titlebar_visual_render.png');
      assert(fs.existsSync(tbPath), `Missing ${tbPath}`);
      const png = readPngFile(tbPath);
      assert(png.width === 1024 && png.height === 38, `Expected 1024x38, got ${png.width}x${png.height}`);
      const center = png.getPixel(500, 19);
      const bottom = png.getPixel(500, 37);
      assert(center[0] === 0x0b && center[1] === 0x0e && center[2] === 0x10, `Center expected #0B0E10 (11,14,16), got ${center.join(',')}`);
      assert(bottom[0] === 0x1b && bottom[1] === 0x21 && bottom[2] === 0x26, `Bottom border expected #1B2126 (27,33,38), got ${bottom.join(',')}`);
      return { detail: 'titlebar_visual_render.png #0B0E10 & #1B2126 verified', evidence: { center, bottom } };
    }
  },
  {
    id: 'T1-F15-04',
    tier: 1,
    feature: 'F15',
    title: 'full_window_rounded_render.png (700x450) corner alpha=0 and titlebar interior=#0B0E10',
    async run(ctx) {
      const run = runBackendUiAndSplashTests(ctx);
      const winPath = path.join(run.sp27TestsDir, 'full_window_rounded_render.png');
      assert(fs.existsSync(winPath), `Missing ${winPath}`);
      const png = readPngFile(winPath);
      assert(png.width === 700 && png.height === 450, `Expected 700x450, got ${png.width}x${png.height}`);
      const corner = png.getPixel(0, 0);
      const titlePx = png.getPixel(50, 20);
      assert(corner[3] === 0, `Expected transparent rounded corner at (0,0), got alpha=${corner[3]}`);
      assert(titlePx[3] === 255 && titlePx[0] === 0x0b && titlePx[1] === 0x0e && titlePx[2] === 0x10, `Titlebar pixel expected #0B0E10, got ${titlePx.join(',')}`);
      return { detail: 'full_window_rounded_render.png rounded mask & #0B0E10 verified' };
    }
  },
  {
    id: 'T1-F15-05',
    tier: 1,
    feature: 'F15',
    title: 'HiDPI titlebar renders (1.0x..2.0x) match exact scaled dimensions',
    async run(ctx) {
      const run = runBackendUiAndSplashTests(ctx);
      const expectedDims = {
        'titlebar_dpi_1.0x.png': [500, 38],
        'titlebar_dpi_1.25x.png': [625, 48],
        'titlebar_dpi_1.5x.png': [750, 57],
        'titlebar_dpi_2.0x.png': [1000, 76]
      };
      for (const [file, [w, h]] of Object.entries(expectedDims)) {
        const png = readPngFile(path.join(run.sp27TestsDir, file));
        assert(Math.abs(png.width - w) <= 1 && Math.abs(png.height - h) <= 1, `${file} expected ~${w}x${h}, got ${png.width}x${png.height}`);
      }
      return { detail: 'HiDPI 1.0x..2.0x titlebar renders verified' };
    }
  }
];
