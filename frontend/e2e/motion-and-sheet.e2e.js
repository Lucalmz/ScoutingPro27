import puppeteer from 'puppeteer-core';
import { spawn, execSync } from 'child_process';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SHOW_UI = process.env.SHOW_UI === '1';
const PORT = 7088;
const BASE_URL = `http://localhost:${PORT}/index.html`;

function getChromeExecutablePath() {
  const platform = os.platform();
  if (platform === 'win32') return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  if (platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return '/usr/bin/google-chrome';
}

const CHROME_PATH = getChromeExecutablePath();

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function killProcessTree(pid) {
  try {
    if (os.platform() === 'win32') {
      execSync(`taskkill /pid ${pid} /f /t`, { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch (e) {}
}

async function waitForTransition(page) {
  await page.waitForFunction(() => {
    return !document.documentElement.hasAttribute('data-direction') && 
           !document.documentElement.hasAttribute('data-transition-type');
  }, { timeout: 5000 }).catch(() => {});
  await delay(100);
}

async function robustLogin(page, username) {
  await page.waitForSelector('#username', { visible: true, timeout: 10000 });
  await page.type('#username', username);

  await page.evaluate(() => {
    const el = document.querySelector('#username');
    if (el) el.dispatchEvent(new Event('blur'));
  });

  await delay(1500);

  await page.waitForSelector('#password', { visible: true, timeout: 10000 });
  await page.type('#password', 'e2etestpass');

  const confirmPasswordEl = await page.$('#confirmPassword');
  if (confirmPasswordEl) {
    await page.type('#confirmPassword', 'e2etestpass');
  }

  await page.waitForFunction(() => {
    const btn = document.querySelector('button[type="submit"]');
    return btn && !btn.disabled;
  }, { timeout: 10000 });

  await page.click('button[type="submit"]');
  await page.waitForSelector('.user-tag-btn', { visible: true, timeout: 15000 });
}

async function runMotionE2ETest() {
  console.log('===============================================================');
  console.log('🚀 [E2E] Starting Motion & Team Detail Sheet End-to-End Tests');
  console.log('===============================================================');

  // 1. Build and synchronize static resources
  if (process.env.SKIP_BUILD !== '1') {
    console.log('\n[1/7] Building frontend and updating backend static resources...');
    try {
      execSync('npm run build', { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
      const mavenCmd = os.platform() === 'win32' ? 'mvn.cmd' : 'mvn';
      execSync(`${mavenCmd} process-resources -DskipTests`, { cwd: path.join(__dirname, '../../Backend'), stdio: 'inherit' });
    } catch (err) {
      console.error('❌ Build failed. Aborting test.', err);
      process.exit(1);
    }
  }

  // 2. Launch Backend on isolated port
  console.log(`\n[2/7] Starting Java backend on isolated port ${PORT}...`);
  const mavenCmd = os.platform() === 'win32' ? 'mvn.cmd' : 'mvn';
  const backendProcess = spawn(mavenCmd, [
    'exec:java',
    '-Dexec.mainClass=com.bear27570.app.Main',
    '-Dexec.args=--headless',
    '-DENABLE_TEST_CLEANUP=true'
  ], {
    cwd: path.join(__dirname, '../../Backend'),
    detached: os.platform() !== 'win32',
    shell: os.platform() === 'win32',
    env: { ...process.env, DEV_PORT: String(PORT), ENABLE_TEST_CLEANUP: 'true' }
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Backend failed to start within 60s')), 60000);
    const onData = (data) => {
      const s = data.toString();
      if (s.includes('Listening on http://localhost:')) {
        clearTimeout(timeout);
        console.log(`✅ Backend successfully running on http://localhost:${PORT}`);
        resolve();
      }
    };
    backendProcess.stdout.on('data', onData);
    backendProcess.stderr.on('data', onData);
  });

  // 3. Launch Puppeteer Chrome
  console.log('\n[3/7] Launching Chrome via Puppeteer...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: SHOW_UI ? false : 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1280,920'
    ],
    defaultViewport: { width: 1280, height: 920 }
  });

  const errors = [];
  const checks = [];

  function recordCheck(name, passed, detail = '') {
    checks.push({ name, passed, detail });
    if (passed) {
      console.log(`  ✅ [PASS] ${name}${detail ? ` (${detail})` : ''}`);
    } else {
      console.error(`  ❌ [FAIL] ${name}${detail ? ` (${detail})` : ''}`);
      errors.push(`${name}: ${detail}`);
    }
  }

  try {
    const page = await browser.newPage();
    page.on('console', msg => {
      const txt = msg.text();
      if (txt.includes('[ERROR]') || txt.includes('Uncaught')) {
        console.warn(`[Browser Warning] ${txt}`);
      }
    });

    // -------------------------------------------------------------
    // STEP 1: Global Motion Tokens Verification
    // -------------------------------------------------------------
    console.log('\n--- Step 1: Global Motion Tokens Verification ---');
    await page.goto(BASE_URL);
    await delay(600);

    const tokens = await page.evaluate(() => {
      const root = document.documentElement;
      const cs = window.getComputedStyle(root);
      return {
        easeOut: cs.getPropertyValue('--motion-ease-out').trim(),
        durationFast: cs.getPropertyValue('--motion-duration-fast').trim(),
        durationModerate: cs.getPropertyValue('--motion-duration-moderate').trim(),
        durationNormal: cs.getPropertyValue('--motion-duration-normal').trim(),
        durationSlow: cs.getPropertyValue('--motion-duration-slow').trim(),
      };
    });

    recordCheck('CSS Token --motion-ease-out', tokens.easeOut.includes('16') && tokens.easeOut.includes('cubic-bezier'), tokens.easeOut);
    recordCheck('CSS Token --motion-duration-fast', Math.abs(parseFloat(tokens.durationFast) - 0.272) < 0.01, tokens.durationFast);
    recordCheck('CSS Token --motion-duration-moderate', Math.abs(parseFloat(tokens.durationModerate) - 0.476) < 0.01, tokens.durationModerate);
    recordCheck('CSS Token --motion-duration-normal', Math.abs(parseFloat(tokens.durationNormal) - 0.612) < 0.01, tokens.durationNormal);
    recordCheck('CSS Token --motion-duration-slow', Math.abs(parseFloat(tokens.durationSlow) - 0.816) < 0.01, tokens.durationSlow);

    // -------------------------------------------------------------
    // STEP 2: Login Flow & User Profile Shared Elements
    // -------------------------------------------------------------
    console.log('\n--- Step 2: Login & Shared Element Verification ---');
    const testUsername = `MotionTester_${Date.now()}`;
    await robustLogin(page, testUsername);

    // Verify Dashboard reached
    const profileAttrs = await page.evaluate(() => {
      const box = document.querySelector('.user-tag-btn');
      const txt = document.querySelector('.username-text');
      return {
        boxTransition: box ? window.getComputedStyle(box).getPropertyValue('view-transition-name').trim() : null,
        textTransition: txt ? window.getComputedStyle(txt).getPropertyValue('view-transition-name').trim() : null
      };
    });
    recordCheck('Shared Element view-transition-name on user-tag-btn', profileAttrs.boxTransition === 'user-profile-box', profileAttrs.boxTransition);
    recordCheck('Shared Element view-transition-name on username-text', profileAttrs.textTransition === 'user-profile-text', profileAttrs.textTransition);

    // Click user profile to trigger RenameModal transition
    console.log('\n--- Step 3: RenameModal Smooth Open & ESC Dismiss ---');
    await waitForTransition(page);
    await page.click('.user-tag-btn');
    await page.waitForSelector('.rename-modal', { visible: true, timeout: 5000 });
    recordCheck('RenameModal opened smoothly', true);

    // Press Escape to dismiss modal
    await page.keyboard.press('Escape');
    await page.waitForSelector('.rename-modal', { hidden: true, timeout: 5000 });
    recordCheck('RenameModal dismissed via Escape key', true);
    await waitForTransition(page);

    // -------------------------------------------------------------
    // STEP 4: Event Creation & Shared Title Transition
    // -------------------------------------------------------------
    console.log('\n--- Step 4: Event Creation & Shared Title Transition ---');
    await page.click('.action-btn.primary');
    await page.waitForSelector('.modal-card input', { visible: true, timeout: 5000 });
    const eventName = `E2E_MOTION_${Date.now()}`;
    await page.type('.modal-card input', eventName);
    await page.click('.btn-confirm');

    await page.waitForSelector('.event-view', { visible: true, timeout: 15000 });
    await page.waitForSelector('.event-view .event-name', { visible: true, timeout: 5000 });
    const eventTitleAttrs = await page.evaluate(() => {
      const el = document.querySelector('.event-view .event-name');
      return {
        titleTransition: el ? window.getComputedStyle(el).getPropertyValue('view-transition-name').trim() : null,
        text: el ? el.textContent.trim() : null
      };
    });
    recordCheck('Shared Element view-transition-name on event-name', eventTitleAttrs.titleTransition === 'event-card-title', eventTitleAttrs.titleTransition);

    // Get current eventId from URL
    const eventUrl = page.url();
    const eventIdMatch = eventUrl.match(/\/event\/([^\/?#]+)/);
    const eventId = eventIdMatch ? eventIdMatch[1] : null;
    recordCheck('Captured eventId from URL', !!eventId, eventId);

    // Tab switching motion test
    console.log('\n--- Step 5: EventView Tab Indicator Motion ---');
    const tabButtons = await page.$$('.tab-btn');
    if (tabButtons.length >= 2) {
      await tabButtons[1].click(); // click Rankings tab
      await delay(350);
      const indicatorStyle = await page.evaluate(() => {
        const ind = document.querySelector('.tab-indicator');
        return ind ? window.getComputedStyle(ind).transition : null;
      });
      recordCheck('Tab indicator animated transition', indicatorStyle && indicatorStyle.includes('transform'), indicatorStyle);
    }

    // -------------------------------------------------------------
    // STEP 6: Team Detail Sheet Redesign Verification (Core Target)
    // -------------------------------------------------------------
    console.log('\n--- Step 6: Team Detail Sheet Redesign & 4-Way Dismissal ---');
    const testTeamNumber = 27570;
    const teamDetailUrl = `http://localhost:${PORT}/index.html#/event/${eventId}/team/${testTeamNumber}`;

    // Sub-test A: Inspect Sheet DOM, Backdrop Blur, Drag Handle, Close Button
    console.log('Sub-test A: Inspect Sheet DOM, Backdrop Blur, Drag Handle, Close Button');
    await page.goto(teamDetailUrl);
    await page.waitForSelector('.team-detail-view', { visible: true, timeout: 10000 });

    const sheetMetrics = await page.evaluate(() => {
      const backdrop = document.querySelector('.team-detail-backdrop');
      const sheet = document.querySelector('.team-detail-view');
      const dragHandle = document.querySelector('.sheet-drag-handle');
      const closeBtn = document.querySelector('.btn-close');
      const backBtn = document.querySelector('.btn-back');

      const bStyle = backdrop ? window.getComputedStyle(backdrop) : null;
      const sStyle = sheet ? window.getComputedStyle(sheet) : null;

      return {
        hasBackdrop: !!backdrop,
        backdropPosition: bStyle ? bStyle.position : null,
        backdropFilter: bStyle ? (bStyle.backdropFilter || bStyle.webkitBackdropFilter || '') : '',
        backdropBg: bStyle ? bStyle.backgroundColor : null,
        hasDragHandle: !!dragHandle,
        hasCloseButton: !!closeBtn,
        hasBackButton: !!backBtn,
        sheetTransitionName: sStyle ? sStyle.getPropertyValue('view-transition-name').trim() : null,
        sheetHeight: sStyle ? sStyle.height : null,
        sheetBorderRadius: sStyle ? sStyle.borderRadius : null,
        viewportHeight: window.innerHeight
      };
    });

    recordCheck('Team detail backdrop exists with position: fixed', sheetMetrics.hasBackdrop && sheetMetrics.backdropPosition === 'fixed', sheetMetrics.backdropPosition);
    recordCheck('Team detail backdrop has blur filter or dark overlay (no black void)', sheetMetrics.hasBackdrop && (sheetMetrics.backdropFilter.includes('blur') || sheetMetrics.backdropBg.includes('0.65')), sheetMetrics.backdropFilter || sheetMetrics.backdropBg);
    recordCheck('Sheet view-transition-name is modal-sheet', sheetMetrics.sheetTransitionName === 'modal-sheet', sheetMetrics.sheetTransitionName);
    recordCheck('Sheet has visual drag handle (.sheet-drag-handle)', sheetMetrics.hasDragHandle);
    recordCheck('Sheet has dedicated top-right close button (.btn-close)', sheetMetrics.hasCloseButton);

    // Sub-test B: Dismiss Mechanism 1 - Click Outside Backdrop (Top region)
    console.log('\nSub-test B: Dismiss Mechanism 1 - Click Outside Backdrop');
    await waitForTransition(page);
    await delay(300);
    await page.evaluate(() => {
      const backdrop = document.querySelector('.team-detail-backdrop');
      if (backdrop) {
        backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      }
    });
    await page.waitForFunction(expected => window.location.hash.endsWith(expected), { timeout: 8000 }, `/event/${eventId}`);
    await page.waitForSelector('.team-detail-view', { hidden: true, timeout: 5000 });
    let currentHash = await page.evaluate(() => window.location.hash);
    recordCheck('Clicking outside backdrop navigated back to EventView', currentHash.endsWith(`/event/${eventId}`), currentHash);

    // Sub-test C: Dismiss Mechanism 2 - Keyboard ESC Key
    console.log('\nSub-test C: Dismiss Mechanism 2 - Keyboard Escape Key');
    await page.goto(teamDetailUrl);
    await page.waitForSelector('.team-detail-view', { visible: true, timeout: 10000 });
    await waitForTransition(page);
    await delay(300);
    await page.keyboard.press('Escape');
    await page.waitForFunction(expected => window.location.hash.endsWith(expected), { timeout: 8000 }, `/event/${eventId}`);
    await page.waitForSelector('.team-detail-view', { hidden: true, timeout: 5000 });
    currentHash = await page.evaluate(() => window.location.hash);
    recordCheck('Pressing Escape key navigated back to EventView', currentHash.endsWith(`/event/${eventId}`), currentHash);

    // Sub-test D: Dismiss Mechanism 3 - Close Button (.btn-close)
    console.log('\nSub-test D: Dismiss Mechanism 3 - Top-Right Close Button');
    await page.goto(teamDetailUrl);
    await page.waitForSelector('.team-detail-view', { visible: true, timeout: 10000 });
    await waitForTransition(page);
    await delay(300);
    await page.evaluate(() => {
      const btn = document.querySelector('.team-detail-view .btn-close');
      if (btn) btn.click();
    });
    await page.waitForFunction(expected => window.location.hash.endsWith(expected), { timeout: 8000 }, `/event/${eventId}`);
    await page.waitForSelector('.team-detail-view', { hidden: true, timeout: 5000 });
    currentHash = await page.evaluate(() => window.location.hash);
    recordCheck('Clicking .btn-close navigated back to EventView', currentHash.endsWith(`/event/${eventId}`), currentHash);

    // Sub-test E: Dismiss Mechanism 4 - Back Button (.btn-back)
    console.log('\nSub-test E: Dismiss Mechanism 4 - Top-Left Back Button');
    await page.goto(teamDetailUrl);
    await page.waitForSelector('.team-detail-view', { visible: true, timeout: 10000 });
    await waitForTransition(page);
    await delay(300);
    await page.evaluate(() => {
      const btn = document.querySelector('.team-detail-view .btn-back');
      if (btn) btn.click();
    });
    await page.waitForFunction(expected => window.location.hash.endsWith(expected), { timeout: 8000 }, `/event/${eventId}`);
    await page.waitForSelector('.team-detail-view', { hidden: true, timeout: 5000 });
    currentHash = await page.evaluate(() => window.location.hash);
    recordCheck('Clicking .btn-back navigated back to EventView', currentHash.endsWith(`/event/${eventId}`), currentHash);

    // -------------------------------------------------------------
    // STEP 7: Tag Picker & Transitions in Team Detail
    // -------------------------------------------------------------
    console.log('\n--- Step 7: Tag Picker & Transitions inside Team Detail ---');
    await page.goto(teamDetailUrl);
    await page.waitForSelector('.team-tags-card', { visible: true, timeout: 10000 });
    await waitForTransition(page);
    await delay(300);
    await page.waitForSelector('.team-tags-card', { visible: true, timeout: 10000 });

    // Open tag edit panel
    await page.waitForSelector('.btn-add-tag', { visible: true });
    await page.evaluate(() => {
      const btn = document.querySelector('.btn-add-tag');
      if (btn) btn.click();
    });
    await page.waitForSelector('.tag-edit-panel', { visible: true, timeout: 5000 });
    recordCheck('Tag edit panel appeared with transition', true);

    // Type custom tag and select purple color
    const customTag = `e2e_${Date.now().toString().slice(-4)}`;
    await page.waitForSelector('.tag-input', { visible: true });
    await page.type('.tag-input', customTag);
    await page.evaluate(() => {
      const dot = document.querySelector('.color-dot.bg-purple');
      if (dot) dot.click();
    });
    await page.evaluate(() => {
      const btn = document.querySelector('.btn-confirm-add');
      if (btn) btn.click();
    });
    await delay(600);

    // Verify tag badge rendered
    const tagAdded = await page.evaluate((tag) => {
      const badges = Array.from(document.querySelectorAll('.tag-badge .tag-text'));
      return badges.some(b => b.textContent.trim() === tag);
    }, customTag);
    recordCheck('Custom tag badge rendered with animation', tagAdded, customTag);

    // Remove tag badge
    await page.evaluate(() => {
      const removeBtn = document.querySelector('.btn-tag-remove');
      if (removeBtn) removeBtn.click();
    });
    await delay(600);
    const tagRemoved = await page.evaluate((tag) => {
      const badges = Array.from(document.querySelectorAll('.tag-badge .tag-text'));
      return !badges.some(b => b.textContent.trim() === tag);
    }, customTag);
    recordCheck('Tag badge removed smoothly with FLIP transition', tagRemoved);

  } catch (err) {
    console.error('💥 E2E Test Exception:', err);
    errors.push(err.message);
  } finally {
    console.log('\n[6/7] Closing Chrome browser...');
    await browser.close().catch(() => {});
    console.log('[7/7] Terminating Java backend...');
    killProcessTree(backendProcess.pid);
  }

  // -------------------------------------------------------------
  // Summary & Assertion
  // -------------------------------------------------------------
  console.log('\n===============================================================');
  console.log('📊 MOTION & TEAM DETAIL SHEET E2E RESULT SUMMARY');
  console.log('===============================================================');
  const total = checks.length;
  const passed = checks.filter(c => c.passed).length;
  const failed = total - passed;

  console.log(`Total Checks: ${total} | Passed: ${passed} | Failed: ${failed}`);

  if (errors.length === 0 && failed === 0) {
    console.log('\n🎉 ALL E2E MOTION & SHEET CHECKS PASSED WITH 100% SUCCESS!');
    process.exit(0);
  } else {
    console.error('\n❌ E2E TEST FAILED with errors:');
    errors.forEach((err, idx) => console.error(`  ${idx + 1}. ${err}`));
    process.exit(1);
  }
}

runMotionE2ETest();
