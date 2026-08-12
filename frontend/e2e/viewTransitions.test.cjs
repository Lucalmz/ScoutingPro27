const puppeteer = require('puppeteer-core');
const { spawn, execSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const SHOW_UI = process.env.SHOW_UI === '1';
const PORT = 7070;
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

async function robustLogin(page, username) {
  await page.waitForSelector('#username');
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

async function runTest() {
  if (process.env.SKIP_BUILD !== '1') {
    console.log('Building frontend and backend before testing (set SKIP_BUILD=1 to skip)...');
    try {
      console.log('Running npm run build in frontend...');
      execSync('npm run build', { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
      
      console.log('Running mvn package in backend...');
      const mavenCmd = os.platform() === 'win32' ? 'mvn.cmd' : 'mvn';
      execSync(`${mavenCmd} package -DskipTests`, { cwd: path.join(__dirname, '../../Backend'), stdio: 'inherit' });
    } catch (e) {
      console.error('Build failed. Aborting test.', e);
      process.exit(1);
    }
  }

  console.log('Starting Java backend on port 7070...');
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
    env: { ...process.env, DEV_PORT: '7070', ENABLE_TEST_CLEANUP: 'true' }
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Backend failed to start")), 60000);
    backendProcess.stdout.on('data', data => {
      if (data.toString().includes('Listening on http://localhost:')) {
        clearTimeout(timeout);
        console.log('✅ Backend is up and running!');
        resolve();
      }
    });
    backendProcess.stderr.on('data', data => {
      if (data.toString().includes('Listening on http://localhost:')) {
        clearTimeout(timeout);
        console.log('✅ Backend is up and running!');
        resolve();
      }
    });
  });

  console.log(`Launching Puppeteer (SHOW_UI=${SHOW_UI})...`);
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: SHOW_UI ? false : 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 400, height: 800 }
  });

  const trackedUsers = [];
  let page;

  try {
    page = await browser.newPage();
    page.on('console', msg => console.log(`[PAGE] ${msg.text()}`));

    const testUser = `ViewTransUser${Date.now()}`;
    trackedUsers.push(testUser);

    console.log('\n=== Step 1: Login and Create Event ===');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    
    const isOnLogin = await page.$('.login-screen').catch(() => null);
    if (isOnLogin) {
      await robustLogin(page, testUser);
    }
    
    // Create an event to ensure we have a card
    await page.waitForSelector('.action-btn.primary', { timeout: 10000 });
    // Wait for view transition to finish if any
    await page.waitForFunction(() => !document.documentElement.dataset.direction, { timeout: 5000 }).catch(() => {});
    
    await page.click('.action-btn.primary');
    await page.waitForSelector('.modal-overlay input', { timeout: 5000 });
    await page.type('.modal-overlay input', `VT_TEST_${Date.now()}`);
    await page.click('.btn-confirm');
    
    // Wait until navigated to the event view
    await page.waitForSelector('.event-meta strong', { timeout: 15000 });
    console.log('✅ Event created successfully.');

    console.log('\n=== Step 2: Navigating to Dashboard for View Transitions Test ===');
    await page.evaluate(() => {
        // Find the Dashboard link in nav and click it
        const tabs = document.querySelectorAll('.nav-items a');
        if (tabs.length > 0) tabs[0].click();
    });
    await page.waitForFunction(() => !document.documentElement.dataset.direction, { timeout: 5000 }).catch(() => {});
    await page.waitForSelector('.event-card', { timeout: 10000 });

    console.log('\n=== Step 3: Injecting precision microtask race condition ===');
    await page.evaluate(() => {
      window.__transitionsStarted = 0;
      window.__namesCaptured = new Set();
      
      const originalStart = document.startViewTransition;
      if (!originalStart) {
        window.__noViewTransitions = true;
        return;
      }
      
      document.startViewTransition = function(cb) {
        window.__transitionsStarted++;
        const transitionNumber = window.__transitionsStarted;
        const transition = originalStart.call(this, cb);
        
        transition.updateCallbackDone.then(() => {
          console.log('[TEST] updateCallbackDone for transition ' + transitionNumber);
          const el = document.querySelector('.event-card');
          if (el && el.style.viewTransitionName && el.style.viewTransitionName !== 'none') {
            window.__namesCaptured.add(el.style.viewTransitionName);
          }
          
          if (transitionNumber < 3) {
             const backBtn = document.querySelector('.btn-back');
             const cards = document.querySelectorAll('.event-card');
             if (backBtn) {
                 console.log('[TEST] Clicking back button on EventView');
                 backBtn.click();
             } else if (cards.length > 0) {
                 console.log('[TEST] Clicking card on Dashboard');
                 cards[0].click();
             }
          }
        });
        return transition;
      };
    });

    const noSupport = await page.evaluate(() => window.__noViewTransitions);
    if (noSupport) {
      console.log('Puppeteer browser does not support View Transitions, skipping precision test.');
    } else {
      console.log('Triggering the first click to start the microtask chain...');
      const cards = await page.$$('.event-card');
      await cards[0].click();
      
      console.log('Waiting for 3 transitions to fire in sequence...');
      await page.waitForFunction(() => window.__transitionsStarted >= 3, { timeout: 10000 });
      
      console.log('Waiting for state machine to clear...');
      await page.waitForFunction(() => !document.documentElement.hasAttribute('data-direction'), { timeout: 10000 });
      
      const results = await page.evaluate(() => ({
        transitionsStarted: window.__transitionsStarted,
        namesCaptured: Array.from(window.__namesCaptured)
      }));
      
      if (results.transitionsStarted < 3) {
        throw new Error(`Expected at least 3 transitions due to microtask chaining, but got ${results.transitionsStarted}`);
      }
      if (results.namesCaptured.length === 0) {
        throw new Error('No view-transition-name was captured during updateCallbackDone. Morphing would have failed!');
      }
      console.log(`Captured active view-transition-names: ${results.namesCaptured.join(', ')}`);
      
      console.log('\n=== Step 4: Navigating back to verify popstate fallback (root fade) ===');
      await page.evaluate(() => {
         window.__popstateTransitionType = null;
         const originalStart = document.startViewTransition;
         document.startViewTransition = function(cb) {
           window.__popstateTransitionType = document.documentElement.dataset.transitionType;
           return originalStart.call(this, cb);
         }
      });

      await page.goBack();
      await page.waitForSelector('.event-card', { timeout: 5000 });
      
      const popstateType = await page.evaluate(() => window.__popstateTransitionType);
      if (popstateType !== 'root') {
        throw new Error(`Expected backward navigation to fallback to 'root' transition, got: ${popstateType}`);
      }
      
      const inlineStyle = await page.evaluate(() => {
        const el = document.querySelector('.event-card');
        return el ? el.style.viewTransitionName : null;
      });
      
      if (inlineStyle && inlineStyle !== 'none' && inlineStyle !== '') {
        throw new Error(`Leftover viewTransitionName found: ${inlineStyle}`);
      }
      
      console.log('✅ E2E Precision Test Passed: Active names verified, 3-click race defeated, popstate fallback verified.');
    }
  } catch (err) {
    console.error('❌ Test encountered an error:', err);
    process.exitCode = 1;
  } finally {
    console.log('\n=== Cleanup ===');
    if (trackedUsers.length > 0) {
      try {
        console.log(`Sending cleanup request for test users...`);
        const resp = await fetch(`http://localhost:${PORT}/api/test/cleanup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(trackedUsers)
        });
        if (resp.ok) {
          console.log('✅ Server successfully cleaned up test data.');
        } else {
          console.error('❌ Failed to clean up test data on server:', await resp.text());
        }
      } catch (err) {
        console.error('❌ Error sending cleanup request:', err);
      }
    }
    
    await browser?.close().catch(() => {});
    if (backendProcess) {
      killProcessTree(backendProcess.pid);
    }
    console.log('Done.');
    process.exit(process.exitCode || 0);
  }
}

runTest();
