import puppeteer from 'puppeteer-core';
import { spawn, execSync } from 'child_process';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SHOW_UI = process.env.SHOW_UI === '1';
const PORT = 7072; // Use port 7072 to avoid conflicts
const BASE_URL = `http://localhost:${PORT}/index.html`;

function getChromeExecutablePath() {
  const platform = os.platform();
  if (platform === 'win32') return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  if (platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return '/usr/bin/google-chrome';
}

const CHROME_PATH = getChromeExecutablePath();

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForTransition(page) {
  await page.waitForFunction(() => {
    return !document.documentElement.hasAttribute('data-direction') && 
           !document.documentElement.hasAttribute('data-transition-type');
  }, { timeout: 5000 }).catch(() => {});
  await delay(100);
}

async function robustLogin(page, username) {
  await page.waitForSelector('#username');
  await page.type('#username', username);

  await page.evaluate(() => {
    const el = document.querySelector('#username');
    if (el) el.dispatchEvent(new Event('blur'));
  });

  await delay(1200);

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
  await page.waitForSelector('.action-btn', { timeout: 15000 });
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

async function runE2E() {
  console.log('=== [E2E] Building frontend before testing ===');
  try {
    execSync('npm run build', { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
    const mavenCmd = os.platform() === 'win32' ? 'mvn.cmd' : 'mvn';
    execSync(`${mavenCmd} process-resources -DskipTests`, { cwd: path.join(__dirname, '../../Backend'), stdio: 'inherit' });
  } catch (e) {
    console.error('Build failed. Aborting test.', e);
    process.exit(1);
  }

  console.log(`=== [E2E] Starting Java backend on port ${PORT}... ===`);
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
    const timeout = setTimeout(() => reject(new Error("Backend failed to start")), 60000);
    backendProcess.stdout.on('data', data => {
      const s = data.toString();
      if (s.includes('Listening on http://localhost:')) {
        clearTimeout(timeout);
        console.log('✅ Backend is up and running on port ' + PORT);
        resolve();
      }
    });
    backendProcess.stderr.on('data', data => {
      const s = data.toString();
      if (s.includes('Listening on http://localhost:')) {
        clearTimeout(timeout);
        console.log('✅ Backend is up and running on port ' + PORT);
        resolve();
      }
    });
  });

  console.log('=== [E2E] Launching Chrome via Puppeteer ===');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: SHOW_UI ? false : 'new',
    args: [
      '--no-sandbox', 
      '--disable-setuid-sandbox', 
      '--window-size=1200,900'
    ],
    defaultViewport: { width: 1200, height: 900 }
  });

  let pass = true;
  const errors = [];

  try {
    const page = await browser.newPage();
    page.on('console', msg => console.log(`[Browser Console] ${msg.text()}`));

    const testUser = `LifecycleTester_${Date.now()}`;

    console.log('\n--- Step 1: Navigate to Login page ---');
    await page.goto(BASE_URL);
    await delay(500);

    // Verify Inbox is mounted in DOM but hidden via v-show (display: none)
    const loginInboxVisibility = await page.evaluate(() => {
      const el = document.querySelector('.inbox-widget');
      if (!el) return { exists: false, display: null };
      return {
        exists: true,
        display: window.getComputedStyle(el).display,
        visible: el.offsetWidth > 0 && el.offsetHeight > 0
      };
    });
    console.log('Login Page Inbox Status:', loginInboxVisibility);
    if (!loginInboxVisibility.exists) {
      errors.push('InboxWidget does not exist in DOM on login page');
    }
    if (loginInboxVisibility.display !== 'none') {
      errors.push(`InboxWidget should have display:none on login page, but got ${loginInboxVisibility.display}`);
    }

    console.log('\n--- Step 2: Login to Dashboard ---');
    await robustLogin(page, testUser);
    await waitForTransition(page);

    // Verify Inbox is now visible on Dashboard
    const dashboardInboxStatus = await page.evaluate(() => {
      const el = document.querySelector('.inbox-widget');
      if (!el) return null;
      // Stamp a unique tracker symbol & DOM property on the node
      const trackerId = `inbox-node-${Date.now()}-${Math.random()}`;
      el.__trackerId = trackerId;
      window.__initialInboxNode = el;
      window.__inboxTrackerId = trackerId;
      
      return {
        exists: true,
        display: window.getComputedStyle(el).display,
        isOpen: el.classList.contains('is-open'),
        trackerId: trackerId,
        parentElement: el.parentElement ? el.parentElement.tagName : null
      };
    });
    console.log('Dashboard Inbox Status:', dashboardInboxStatus);

    if (!dashboardInboxStatus || !dashboardInboxStatus.exists) {
      errors.push('InboxWidget not found on Dashboard');
    }
    if (dashboardInboxStatus.display === 'none') {
      errors.push('InboxWidget should be visible (not display:none) on Dashboard');
    }
    if (dashboardInboxStatus.parentElement !== 'BODY') {
      errors.push(`InboxWidget should be child of BODY via Teleport, but is child of ${dashboardInboxStatus.parentElement}`);
    }

    console.log('\n--- Step 3: Open Inbox Widget on Dashboard ---');
    await page.click('.inbox-morph-container');
    await delay(600); // Wait for CSS morph animation

    const openStatus = await page.evaluate(() => {
      const el = document.querySelector('.inbox-widget');
      const container = el ? el.querySelector('.inbox-morph-container') : null;
      const rect = container ? container.getBoundingClientRect() : null;
      const style = container ? window.getComputedStyle(container) : null;
      window.__dashboardInboxRect = rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } : null;
      return {
        isOpen: el ? el.classList.contains('is-open') : false,
        width: rect?.width,
        height: rect?.height,
        borderRadius: style?.borderRadius,
        boxShadow: style?.boxShadow,
        rect: window.__dashboardInboxRect
      };
    });
    console.log('Inbox Open Status & Style on Dashboard:', openStatus);
    if (!openStatus.isOpen) {
      errors.push('InboxWidget failed to open when clicked');
    }
    if (!openStatus.borderRadius.includes('16px')) {
      errors.push(`InboxWidget should have 16px rounded corners when open, but got ${openStatus.borderRadius}`);
    }

    console.log('\n--- Step 4: Create an Event and navigate to EventView ---');
    await page.click('.action-btn.primary');
    await page.waitForSelector('.modal-overlay input');
    await page.type('.modal-overlay input', 'E2E Lifecycle Event');
    
    // Start continuous frame sampling in browser to catch any mid-transition blink
    await page.evaluate(() => {
      window.__inboxVisibilitySamples = [];
      window.__sampleInterval = setInterval(() => {
        const el = document.querySelector('.inbox-morph-container');
        if (el) {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          window.__inboxVisibilitySamples.push({
            time: Date.now(),
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            width: rect.width,
            height: rect.height
          });
        }
      }, 16);
    });

    // Click Create button in modal
    await page.waitForSelector('.modal-overlay .btn-confirm', { visible: true });
    await page.click('.modal-overlay .btn-confirm');

    // Wait for EventView to load and View Transitions to finish
    await page.waitForSelector('.event-view', { timeout: 15000 });
    await waitForTransition(page);
    await delay(300);

    const midTransitionCheck = await page.evaluate(() => {
      clearInterval(window.__sampleInterval);
      const samples = window.__inboxVisibilitySamples || [];
      const hiddenSamples = samples.filter(s => s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0' || s.width === 0 || s.height === 0);
      return {
        totalSamples: samples.length,
        hiddenCount: hiddenSamples.length,
        firstFewSamples: samples.slice(0, 5)
      };
    });
    console.log('Mid-transition Frame Visibility Sampling Result:', JSON.stringify(midTransitionCheck, null, 2));
    if (midTransitionCheck.hiddenCount > 0) {
      errors.push(`InboxWidget container was hidden or had 0 size during transition in ${midTransitionCheck.hiddenCount} frames!`);
    }

    console.log('\n--- Step 5: Verify InboxWidget identity, state, and EXACT position in EventView ---');
    const eventViewInboxStatus = await page.evaluate(() => {
      const currentEl = document.querySelector('.inbox-widget');
      const container = currentEl ? currentEl.querySelector('.inbox-morph-container') : null;
      const rect = container ? container.getBoundingClientRect() : null;
      const currentRect = rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } : null;
      const initialRect = window.__dashboardInboxRect;
      const posDiff = initialRect && currentRect ? {
        leftDiff: Math.abs(currentRect.left - initialRect.left),
        topDiff: Math.abs(currentRect.top - initialRect.top),
        rightDiff: Math.abs(currentRect.right - initialRect.right),
        bottomDiff: Math.abs(currentRect.bottom - initialRect.bottom)
      } : null;

      return {
        exists: true,
        display: currentEl ? window.getComputedStyle(currentEl).display : null,
        isSameDomNode: currentEl === window.__initialInboxNode,
        hasSameTrackerId: currentEl?.__trackerId === window.__inboxTrackerId,
        isOpen: currentEl?.classList.contains('is-open'),
        width: rect?.width,
        height: rect?.height,
        parentElement: currentEl?.parentElement?.tagName,
        currentRect,
        initialRect,
        posDiff
      };
    });
    console.log('EventView Inbox Status & Position Check:', JSON.stringify(eventViewInboxStatus, null, 2));

    if (!eventViewInboxStatus.isSameDomNode) {
      errors.push('CRITICAL: InboxWidget DOM node was DESTROYED and RECREATED during route navigation!');
    }
    if (!eventViewInboxStatus.hasSameTrackerId) {
      errors.push('CRITICAL: Tracker ID mismatch on InboxWidget node across route transition!');
    }
    if (!eventViewInboxStatus.isOpen) {
      errors.push('InboxWidget open state was reset/lost when navigating from Dashboard to EventView');
    }
    if (eventViewInboxStatus.posDiff && (eventViewInboxStatus.posDiff.leftDiff > 1 || eventViewInboxStatus.posDiff.topDiff > 1)) {
      errors.push(`InboxWidget position shifted between Dashboard and EventView! Diff: ${JSON.stringify(eventViewInboxStatus.posDiff)}`);
    }

    console.log('\n--- Step 6: Navigate back to Dashboard ---');
    const backBtn = await page.waitForSelector('.btn-back');
    await backBtn.click();
    await page.waitForSelector('.dashboard-view, .action-btn', { timeout: 10000 });
    await waitForTransition(page);
    await delay(500);

    console.log('\n--- Step 7: Verify InboxWidget identity and state back on Dashboard ---');
    const returnDashboardStatus = await page.evaluate(() => {
      const currentEl = document.querySelector('.inbox-widget');
      return {
        exists: true,
        display: currentEl ? window.getComputedStyle(currentEl).display : null,
        isSameDomNode: currentEl === window.__initialInboxNode,
        hasSameTrackerId: currentEl?.__trackerId === window.__inboxTrackerId,
        isOpen: currentEl?.classList.contains('is-open')
      };
    });
    console.log('Return Dashboard Inbox Status:', returnDashboardStatus);

    if (!returnDashboardStatus.isSameDomNode) {
      errors.push('CRITICAL: InboxWidget DOM node was DESTROYED and RECREATED when returning to Dashboard!');
    }
    if (!returnDashboardStatus.hasSameTrackerId) {
      errors.push('CRITICAL: Tracker ID mismatch when returning to Dashboard!');
    }
    if (!returnDashboardStatus.isOpen) {
      errors.push('InboxWidget open state was reset when returning to Dashboard');
    }

  } catch (err) {
    console.error('E2E Test Exception:', err);
    errors.push(err.message);
    pass = false;
  } finally {
    await browser.close();
    console.log('\n=== Terminating Backend Process ===');
    killProcessTree(backendProcess.pid);
  }

  console.log('\n==============================');
  console.log('E2E TEST RESULT SUMMARY:');
  if (errors.length === 0 && pass) {
    console.log('🎉 ALL INBOX LIFECYCLE CHECKS PASSED PERFECTLY! ZERO RE-RENDERS / RE-CREATIONS!');
    process.exit(0);
  } else {
    console.error('❌ E2E TEST FAILED with errors:');
    errors.forEach((e, idx) => console.error(`  ${idx + 1}. ${e}`));
    process.exit(1);
  }
}

runE2E();
