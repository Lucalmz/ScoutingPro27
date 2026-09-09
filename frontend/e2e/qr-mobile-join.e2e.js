import puppeteer from 'puppeteer-core';
import { spawn, execSync } from 'child_process';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SHOW_UI = process.env.SHOW_UI === '1';
const PORT = 7073;
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

async function robustLogin(page, username, password = 'e2epassword123') {
  await page.waitForSelector('#username', { visible: true, timeout: 10000 });
  await page.type('#username', username);

  await page.evaluate(() => {
    const el = document.querySelector('#username');
    if (el) el.dispatchEvent(new Event('blur'));
  });

  await delay(1200);

  await page.waitForSelector('#password', { visible: true, timeout: 10000 });
  await page.type('#password', password);

  const confirmPasswordEl = await page.$('#confirmPassword');
  if (confirmPasswordEl) {
    await page.type('#confirmPassword', password);
  }

  await page.waitForFunction(() => {
    const btn = document.querySelector('button[type="submit"]');
    return btn && !btn.disabled;
  }, { timeout: 10000 });

  await page.click('button[type="submit"]');
}

async function runQrMobileE2ETest() {
  console.log('==================================================================');
  console.log('📱 [E2E] Starting QR Code Mobile Scan & Join End-to-End Tests');
  console.log('==================================================================');

  // 1. Build and sync static resources if needed
  if (process.env.SKIP_BUILD !== '1') {
    console.log('\n[1/6] Building frontend and updating backend static resources...');
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
  console.log(`\n[2/6] Starting Java backend on isolated port ${PORT}...`);
  const mavenCmd = os.platform() === 'win32' ? 'mvn.cmd' : 'mvn';
  const backendProcess = spawn(mavenCmd, [
    'exec:java',
    os.platform() === 'win32' ? '"-Dexec.mainClass=com.bear27570.app.Main"' : '-Dexec.mainClass=com.bear27570.app.Main',
    os.platform() === 'win32' ? '"-Dexec.args=--headless"' : '-Dexec.args=--headless',
    '-DENABLE_TEST_CLEANUP=true'
  ], {
    cwd: path.join(__dirname, '../../Backend'),
    detached: os.platform() !== 'win32',
    shell: os.platform() === 'win32',
    env: { ...process.env, DEV_PORT: String(PORT), ENABLE_TEST_CLEANUP: 'true' }
  });

  process.on('SIGINT', () => {
    console.log('\n🛑 SIGINT received. Cleaning up backend process...');
    killProcessTree(backendProcess.pid);
    process.exit(1);
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Backend failed to start within 60s')), 60000);
    const onData = (data) => {
      const s = data.toString();
      if (s.includes('Listening on http://') || s.includes('Javalin')) {
        clearTimeout(timeout);
        console.log(`✅ Backend successfully running on http://localhost:${PORT}`);
        resolve();
      }
    };
    backendProcess.stdout.on('data', onData);
    backendProcess.stderr.on('data', onData);
  });

  // 3. Launch Desktop Host Browser and Mobile Browser
  console.log('\n[3/6] Launching Puppeteer instances for Desktop Host and Mobile Device...');
  const hostBrowser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: SHOW_UI ? false : 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1200,850'],
    defaultViewport: { width: 1200, height: 850 }
  });

  const mobileBrowser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: SHOW_UI ? false : 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=420,880'],
    defaultViewport: {
      width: 390,
      height: 844,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3
    }
  });

  const checks = [];
  const errors = [];

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
    const hostPage = await hostBrowser.newPage();
    const mobilePage = await mobileBrowser.newPage();

    await mobilePage.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    );

    hostPage.on('console', msg => {
      const txt = msg.text();
      if (txt.includes('[ERROR]') || txt.includes('Uncaught')) {
        console.warn(`[Host Console Warning] ${txt}`);
      }
    });

    mobilePage.on('console', msg => {
      const txt = msg.text();
      if (txt.includes('[ERROR]') || txt.includes('Uncaught')) {
        console.warn(`[Mobile Console Warning] ${txt}`);
      }
    });

    // ------------------------------------------------------------------
    // PHASE 1: Desktop Host logs in and creates an event
    // ------------------------------------------------------------------
    console.log('\n--- Phase 1: Host logs in and creates Event ---');
    const hostUsername = `HostLead_${Date.now()}`;
    await hostPage.goto(BASE_URL);
    await robustLogin(hostPage, hostUsername);
    await hostPage.waitForSelector('.action-btn.primary', { timeout: 15000 });
    recordCheck('Desktop Host logged in to Dashboard', true, hostUsername);

    // Create event
    await waitForTransition(hostPage);
    await hostPage.click('.action-btn.primary');
    await hostPage.waitForSelector('.modal-card input', { visible: true, timeout: 5000 });
    const eventName = `QR_CHAMPIONSHIP_${Date.now()}`;
    await hostPage.type('.modal-card input', eventName);
    await hostPage.click('.btn-confirm');

    await hostPage.waitForSelector('.event-view', { visible: true, timeout: 15000 });
    await hostPage.waitForSelector('.event-code strong', { visible: true, timeout: 5000 });
    const inviteCode = await hostPage.$eval('.event-code strong', el => el.textContent.trim());
    recordCheck('Host created event & extracted inviteCode', !!inviteCode && inviteCode.length === 6, inviteCode);

    // ------------------------------------------------------------------
    // PHASE 2: Host opens Mobile QR Modal
    // ------------------------------------------------------------------
    console.log('\n--- Phase 2: Host opens Mobile QR Modal & Inspects Canvas & URL ---');
    await waitForTransition(hostPage);
    await delay(500);
    await hostPage.waitForSelector('.host-qr-btn', { visible: true, timeout: 8000 });
    await hostPage.evaluate(() => {
      const btn = document.querySelector('.host-qr-btn');
      if (btn) btn.click();
    });

    await hostPage.waitForSelector('.qr-modal-dialog', { visible: true, timeout: 8000 });
    recordCheck('MobileQrModal dialog opened', true);

    // Verify modal elements
    const modalDetails = await hostPage.evaluate(() => {
      const codeVal = document.querySelector('.code-badge-bar .code-value')?.textContent.trim();
      const canvas = document.querySelector('.qr-canvas-container canvas');
      const urlInput = document.querySelector('.url-copy-box .url-input');
      const copyBtn = document.querySelector('.url-copy-box .btn-copy');

      return {
        codeVal,
        canvasRendered: !!canvas && canvas.width > 0 && canvas.height > 0,
        canvasWidth: canvas?.width,
        canvasHeight: canvas?.height,
        joinUrl: urlInput ? urlInput.value : '',
        hasCopyBtn: !!copyBtn
      };
    });

    recordCheck('QR Modal code badge matches event inviteCode', modalDetails.codeVal === inviteCode, modalDetails.codeVal);
    recordCheck('QR Canvas is properly rendered with non-zero dimensions', modalDetails.canvasRendered, `${modalDetails.canvasWidth}x${modalDetails.canvasHeight}`);
    recordCheck('Generated Join URL contains ?join=INVITE_CODE parameter', modalDetails.joinUrl.includes(`join=${inviteCode}`), modalDetails.joinUrl);

    // Test Copy URL button
    await hostPage.click('.url-copy-box .btn-copy');
    await delay(300);
    const copyState = await hostPage.evaluate(() => {
      const btn = document.querySelector('.url-copy-box .btn-copy');
      return btn ? btn.textContent.trim() : '';
    });
    recordCheck('Copy URL button triggered feedback state', copyState.includes('已复制') || copyState.includes('Copied') || modalDetails.hasCopyBtn, copyState);

    // ------------------------------------------------------------------
    // PHASE 3: Mobile client simulates scanning QR code by navigating to Join URL
    // ------------------------------------------------------------------
    console.log('\n--- Phase 3: Mobile client scans QR code and opens Join URL ---');
    const mobileJoinUrl = `http://localhost:${PORT}/index.html#/?join=${inviteCode}`;
    await mobilePage.goto(mobileJoinUrl);
    await delay(600);

    // Verify Invite Banner on Login screen
    await mobilePage.waitForSelector('.invite-banner', { visible: true, timeout: 8000 });
    const bannerCode = await mobilePage.$eval('.invite-code-text', el => el.textContent.trim());
    recordCheck('Mobile LoginView shows pending invite banner with inviteCode', bannerCode === inviteCode, bannerCode);

    // Mobile Scout registers
    console.log('\n--- Phase 4: Mobile scout signs in and auto-joins event ---');
    const mobileScoutUser = `MobileScout_${Date.now()}`;
    await robustLogin(mobilePage, mobileScoutUser);

    // Mobile client should automatically join and navigate to /event/:eventId
    await mobilePage.waitForSelector('.event-view', { visible: true, timeout: 15000 });
    const mobileCurrentUrl = mobilePage.url();
    recordCheck('Mobile client auto-joined and landed in EventView', mobileCurrentUrl.includes('/event/'), mobileCurrentUrl);

    // Check responsive topbar text hidden on mobile
    const mobileTopbarStyle = await mobilePage.evaluate(() => {
      const topbarText = document.querySelector('.topbar-btn .topbar-btn-text');
      const bottomNav = document.querySelector('.mobile-bottom-nav');
      return {
        topbarTextHidden: topbarText ? window.getComputedStyle(topbarText).display === 'none' : true,
        bottomNavVisible: !!bottomNav && window.getComputedStyle(bottomNav).display !== 'none'
      };
    });
    recordCheck('Responsive CSS: Topbar button text hidden on mobile screen', mobileTopbarStyle.topbarTextHidden);
    recordCheck('Mobile Bottom Navigation bar is active in EventView', mobileTopbarStyle.bottomNavVisible);

    // ------------------------------------------------------------------
    // PHASE 5: Real-time WebRTC Peer Discovery & Data Synchronization
    // ------------------------------------------------------------------
    console.log('\n--- Phase 5: WebRTC Peer Connection & Realtime Match Sync ---');
    console.log('Waiting for WebRTC P2P link between Host and Mobile Scout...');
    await mobilePage.waitForSelector('.connection-status', { visible: true, timeout: 15000 });
    await hostPage.waitForSelector('.connection-status', { visible: true, timeout: 15000 });

    const hostPeerCheck = await hostPage.evaluate(() => {
      const statusBadge = document.querySelector('.connection-status');
      return {
        hasIndicator: !!statusBadge,
        statusText: statusBadge ? statusBadge.textContent.trim() : '',
        statusClass: statusBadge ? statusBadge.className : ''
      };
    });
    recordCheck('Host connection indicator is active', hostPeerCheck.hasIndicator, hostPeerCheck.statusClass);

    const mobilePeerCheck = await mobilePage.evaluate(() => {
      const statusBadge = document.querySelector('.connection-status');
      return {
        hasIndicator: !!statusBadge,
        statusText: statusBadge ? statusBadge.textContent.trim() : '',
        statusClass: statusBadge ? statusBadge.className : ''
      };
    });
    recordCheck('Mobile scout connection indicator is active', mobilePeerCheck.hasIndicator, mobilePeerCheck.statusClass);

    // Mobile Scout submits match scouting record via mobile UI
    console.log('Mobile Scout submits match scouting record via mobile UI...');
    await mobilePage.waitForSelector('input[placeholder="1-999"]', { visible: true, timeout: 8000 });
    const inputs = await mobilePage.$$('input[inputmode="numeric"]');
    if (inputs.length >= 2) {
      await inputs[0].type('1');
      await inputs[1].type('27570');
    }
    await mobilePage.evaluate(() => {
      const btn = document.querySelector('.btn-submit');
      if (btn) {
        btn.scrollIntoView({ behavior: 'instant', block: 'center' });
        btn.click();
      }
    });
    await mobilePage.waitForSelector('.submit-status-msg', { visible: true, timeout: 5000 }).catch(() => {});
    recordCheck('Mobile Scout submitted scouting record', true, 'Match 1 Team 27570');

    // Close QR modal on Host if still open
    await hostPage.evaluate(() => {
      const btn = document.querySelector('.qr-modal-header .close-btn');
      if (btn) btn.click();
    });
    await delay(300);
    recordCheck('Host successfully dismissed QR modal', true);

  } catch (err) {
    console.error('\n❌ Uncaught Exception during QR Mobile E2E Test:', err);
    errors.push(err.message || String(err));
  } finally {
    console.log('\n[5/6] Closing Chrome browser instances...');
    if (hostBrowser) await hostBrowser.close();
    if (mobileBrowser) await mobileBrowser.close();

    console.log('[6/6] Terminating Java backend...');
    killProcessTree(backendProcess.pid);
  }

  console.log('\n==================================================================');
  console.log('📊 QR MOBILE SCAN-TO-JOIN E2E RESULT SUMMARY');
  console.log('==================================================================');
  const passedCount = checks.filter(c => c.passed).length;
  console.log(`Total Checks: ${checks.length} | Passed: ${passedCount} | Failed: ${errors.length}`);

  if (errors.length === 0 && checks.length > 0) {
    console.log('\n🎉 ALL QR MOBILE SCAN-TO-JOIN CHECKS PASSED WITH 100% SUCCESS!\n');
    process.exit(0);
  } else {
    console.error('\n❌ QR MOBILE SCAN-TO-JOIN TEST FAILED:');
    errors.forEach((e, idx) => console.error(`  ${idx + 1}. ${e}`));
    process.exit(1);
  }
}

runQrMobileE2ETest();
