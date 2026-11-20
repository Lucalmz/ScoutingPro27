import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { delay, killProcessTree } from './server.js';

export const DESKTOP_VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1 };
export const MOBILE_VIEWPORT = {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true
};

export async function resolveChromeExecutable() {
  const candidates = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);

  const platform = os.platform();
  if (platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    );
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    );
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }

  try {
    const fullPuppeteer = await import('puppeteer');
    const p = fullPuppeteer.default?.executablePath?.();
    if (p && fs.existsSync(p)) return p;
  } catch {
    // ignore fallback failure
  }

  throw new Error(`No Chrome/Edge executable found. Checked: ${candidates.join(', ')}`);
}

export async function launchPitwallBrowser({
  headless = true,
  viewport = DESKTOP_VIEWPORT
} = {}) {
  const executablePath = await resolveChromeExecutable();
  const tempUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp27-pitwall-chrome-'));
  const browser = await puppeteer.launch({
    executablePath,
    headless: headless ? 'new' : false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      `--user-data-dir=${tempUserDataDir}`,
      `--window-size=${viewport.width},${viewport.height}`
    ],
    defaultViewport: viewport
  });

  const procPid = browser.process()?.pid;
  const runtimeErrors = {
    pageErrors: [],
    consoleErrors: [],
    suppressExpectedErrors: false
  };

  function attachPageListeners(page) {
    page.on('pageerror', (err) => {
      if (!runtimeErrors.suppressExpectedErrors) {
        runtimeErrors.pageErrors.push(String(err?.message || err));
      }
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !runtimeErrors.suppressExpectedErrors) {
        const text = msg.text();
        runtimeErrors.consoleErrors.push(text);
      }
    });
  }

  async function openCleanPage(vp = viewport) {
    const page = await browser.newPage();
    await page.setViewport(vp);
    attachPageListeners(page);
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('app-locale', 'en');
    });
    return page;
  }

  async function close() {
    try {
      await Promise.race([
        browser.close(),
        delay(3000).then(() => {
          throw new Error('browser.close() timeout');
        })
      ]);
    } catch {
      killProcessTree(procPid);
    }
    try {
      fs.rmSync(tempUserDataDir, { recursive: true, force: true });
    } catch {
      // ignore temp lock
    }
  }

  return {
    browser,
    executablePath,
    tempUserDataDir,
    runtimeErrors,
    openCleanPage,
    attachPageListeners,
    close
  };
}

export async function waitForTransition(page, timeoutMs = 5000) {
  await page.waitForFunction(() => {
    return (
      !document.documentElement.hasAttribute('data-direction') &&
      !document.documentElement.hasAttribute('data-transition-type')
    );
  }, { timeout: timeoutMs }).catch(() => {});
  await page.evaluate(async () => {
    if (document.fonts?.ready) {
      await document.fonts.ready;
    }
  }).catch(() => {});
  await delay(120);
}

export async function robustLogin(page, entryUrl, username, password = 'pitwall_e2e_pass') {
  await page.goto(entryUrl, { waitUntil: 'networkidle0', timeout: 25000 });
  await waitForTransition(page);

  await page.waitForSelector('#username', { visible: true, timeout: 10000 });
  await page.click('#username', { clickCount: 3 });
  await page.type('#username', username);
  await page.evaluate(() => {
    const el = document.querySelector('#username');
    if (el) el.dispatchEvent(new Event('blur'));
  });
  await delay(1200);

  await page.waitForSelector('#password', { visible: true, timeout: 10000 });
  await page.type('#password', password);

  const confirmEl = await page.$('#confirmPassword');
  if (confirmEl) {
    await page.type('#confirmPassword', password);
  }

  await page.waitForFunction(() => {
    const btn = document.querySelector('button[type="submit"]');
    return btn && !btn.disabled;
  }, { timeout: 10000 });

  await page.click('button[type="submit"]');
  await page.waitForSelector('.action-btn, .dashboard-view, .event-view, .user-tag-btn', {
    visible: true,
    timeout: 15000
  });
  await waitForTransition(page);
}

export async function createEvent(page, eventName) {
  await page.waitForSelector('.action-btn.primary', { visible: true, timeout: 10000 });
  await page.click('.action-btn.primary');
  await page.waitForSelector('.modal-overlay .modal-card input, .modal-card input', {
    visible: true,
    timeout: 8000
  });
  await page.type('.modal-overlay .modal-card input, .modal-card input', eventName);
  await page.click('.btn-confirm');
  await page.waitForSelector('.event-view', { visible: true, timeout: 15000 });
  await waitForTransition(page);
  await delay(300);

  const info = await page.evaluate(() => {
    const m = window.location.hash.match(/\/event\/([^/?#]+)/);
    const code = document.querySelector('.event-code strong')?.textContent?.trim() || '';
    const userRaw = localStorage.getItem('scoutingpro-user');
    return {
      eventId: m ? decodeURIComponent(m[1]) : null,
      inviteCode: code,
      scoutInfo: userRaw ? JSON.parse(userRaw) : null
    };
  });

  if (!info.eventId) {
    throw new Error('Failed to parse created eventId from hash URL');
  }
  return info;
}

export async function selectTab(page, tabKey) {
  const desktopTab = await page.$(`.tab-bar .tab-btn[data-tab="${tabKey}"]`);
  if (desktopTab) {
    const visible = await desktopTab.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && window.getComputedStyle(el).display !== 'none';
    });
    if (visible) {
      await desktopTab.click();
      await waitForTransition(page);
      await delay(200);
      return;
    }
  }

  // Mobile bottom nav fallback (MobileBottomNav.vue has primary slots 0..3 and secondary tabs in .more-sheet)
  const directMobile = await page.$(`.mobile-bottom-nav .nav-item-btn[data-tab="${tabKey}"]`);
  if (directMobile) {
    await directMobile.click();
    await waitForTransition(page);
    await delay(200);
    return;
  }

  const primaryIndexMap = { scout: 0, pit: 1, schedule: 2, rankings: 3 };
  const iconMap = {
    scout: 'sports_score',
    pit: 'storefront',
    schedule: 'calendar_month',
    rankings: 'leaderboard',
    whiteboard: 'draw',
    history: 'history',
    ai: 'smart_toy',
    scouts: 'groups'
  };
  const labelTermsMap = {
    scout: ['scout', 'match'],
    pit: ['pit'],
    schedule: ['schedule'],
    whiteboard: ['whiteboard', 'tactical'],
    rankings: ['rank'],
    history: ['history'],
    ai: ['ai'],
    scouts: ['scouts', 'settings', 'team']
  };

  if (tabKey in primaryIndexMap) {
    const clickedPrimary = await page.evaluate((key, idx, iconName, terms) => {
      const btns = Array.from(document.querySelectorAll('.mobile-bottom-nav .nav-item-btn'));
      if (btns.length === 0) return false;
      const byIcon = btns.find((b) => (b.querySelector('.nav-icon')?.textContent || '').trim() === iconName);
      const byText = btns.find((b) => terms.some((t) => (b.textContent || '').toLowerCase().includes(t)));
      const target = byIcon || byText || btns[idx];
      if (!target) return false;
      target.click();
      return true;
    }, tabKey, primaryIndexMap[tabKey], iconMap[tabKey], labelTermsMap[tabKey]);
    if (!clickedPrimary) {
      throw new Error(`Could not locate desktop tab or mobile primary nav button for "${tabKey}"`);
    }
    await waitForTransition(page);
    await delay(200);
    return;
  }

  // Secondary tabs (whiteboard, history, ai, scouts) live in .more-sheet unless already active as the 5th slot
  const alreadyOnSecondary = await page.evaluate((iconName) => {
    const lastBtn = document.querySelector('.mobile-bottom-nav .nav-item-btn:last-child');
    if (!lastBtn) return false;
    const active = lastBtn.classList.contains('is-active');
    const icon = (lastBtn.querySelector('.nav-icon')?.textContent || '').trim();
    return active && icon === iconName;
  }, iconMap[tabKey] || '');
  if (alreadyOnSecondary) {
    await waitForTransition(page);
    await delay(150);
    return;
  }

  let sheetVisible = await page.$('.more-sheet');
  if (!sheetVisible) {
    const moreBtn = await page.$('.mobile-bottom-nav .nav-item-btn:last-child');
    if (!moreBtn) {
      throw new Error(`Could not locate desktop tab or mobile nav for "${tabKey}"`);
    }
    await moreBtn.click();
    await page.waitForSelector('.more-sheet', { visible: true, timeout: 5000 });
  }

  const sheetBtn = await page.$(`.more-sheet .sheet-item-btn[data-tab="${tabKey}"]`);
  if (sheetBtn) {
    await sheetBtn.click();
  } else {
    const clicked = await page.evaluate((iconName, terms) => {
      const btns = Array.from(document.querySelectorAll('.more-sheet .sheet-item-btn'));
      const byIcon = iconName
        ? btns.find((b) => (b.querySelector('.sheet-icon')?.textContent || '').trim() === iconName)
        : null;
      const byText = btns.find((b) => terms.some((t) => (b.textContent || '').toLowerCase().includes(t)));
      const match = byIcon || byText;
      if (!match) return false;
      match.click();
      return true;
    }, iconMap[tabKey] || '', labelTermsMap[tabKey] || [tabKey]);
    if (!clicked) throw new Error(`Tab "${tabKey}" not found in mobile more-sheet`);
  }
  await waitForTransition(page);
  await delay(200);
}

export async function captureScreenshot(page, screenshotsDir, filename) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const target = path.join(screenshotsDir, filename);
  await page.screenshot({ path: target });
  return target;
}
