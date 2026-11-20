import path from 'node:path';
import {
  createEvent,
  DESKTOP_VIEWPORT,
  MOBILE_VIEWPORT,
  robustLogin,
  selectTab,
  waitForTransition
} from './browser.js';
import { colorsEqual, scanFrontendSourceTree } from './css-audit.js';
import { seedEventViaApi } from './seed.js';
import { delay } from './server.js';

export function assert(cond, message) {
  if (!cond) {
    throw new Error(message);
  }
}

export function assertColorMatch(actual, expectedHex, label, tolerance = 4) {
  if (!colorsEqual(actual, expectedHex, tolerance)) {
    throw new Error(`${label}: expected color ~${expectedHex}, got "${actual}"`);
  }
}

export function getFrontendScan(ctx) {
  if (!ctx._frontendScanCache) {
    ctx._frontendScanCache = scanFrontendSourceTree(path.join(ctx.repoRoot, 'frontend', 'src'));
  }
  return ctx._frontendScanCache;
}

export async function ensureDesktopSession(ctx) {
  if (ctx._desktopSession) {
    const { page, eventId } = ctx._desktopSession;
    await page.setViewport(DESKTOP_VIEWPORT);
    const inEvent = await page.evaluate((eid) => {
      return window.location.hash.includes(`/event/${encodeURIComponent(eid)}`) && !!document.querySelector('.event-view');
    }, eventId);
    if (!inEvent) {
      await page.goto(`${ctx.baseUrl}#/event/${encodeURIComponent(eventId)}`, {
        waitUntil: 'networkidle0',
        timeout: 20000
      });
      await page.waitForSelector('.event-view', { visible: true, timeout: 10000 }).catch(async () => {
        const card = await page.$('.event-card');
        if (card) await card.click();
        await page.waitForSelector('.event-view', { visible: true, timeout: 10000 });
      });
      await waitForTransition(page);
    }
    return ctx._desktopSession;
  }

  const page = await ctx.browserHandle.openCleanPage(DESKTOP_VIEWPORT);
  const username = `pitwall_host_${Date.now().toString().slice(-6)}`;
  await robustLogin(page, ctx.baseUrl, username);
  const { eventId, inviteCode, scoutInfo } = await createEvent(page, `PitWall E2E ${Date.now().toString().slice(-4)}`);
  const seed = await seedEventViaApi(page, eventId, scoutInfo);

  ctx._desktopSession = { page, username, eventId, inviteCode, scoutInfo, seed };
  return ctx._desktopSession;
}

export async function ensureMobilePage(ctx) {
  const session = await ensureDesktopSession(ctx);
  if (!ctx._mobilePage) {
    const mPage = await ctx.browserHandle.openCleanPage(MOBILE_VIEWPORT);
    await mPage.evaluateOnNewDocument((user) => {
      localStorage.setItem('scoutingpro-user', JSON.stringify(user));
      localStorage.setItem('app-locale', 'en');
    }, session.scoutInfo);
    await mPage.goto(`${ctx.baseUrl}#/event/${encodeURIComponent(session.eventId)}`, {
      waitUntil: 'networkidle0',
      timeout: 20000
    });
    await mPage.waitForSelector('.event-view', { visible: true, timeout: 15000 });
    await waitForTransition(mPage);
    ctx._mobilePage = mPage;
  } else {
    await ctx._mobilePage.setViewport(MOBILE_VIEWPORT);
    const inEvent = await ctx._mobilePage.evaluate((eid) => {
      return window.location.hash.includes(`/event/${encodeURIComponent(eid)}`) && !!document.querySelector('.event-view');
    }, session.eventId);
    if (!inEvent) {
      await ctx._mobilePage.goto(`${ctx.baseUrl}#/event/${encodeURIComponent(session.eventId)}`, {
        waitUntil: 'networkidle0',
        timeout: 20000
      });
      await ctx._mobilePage.waitForSelector('.event-view', { visible: true, timeout: 15000 });
      await waitForTransition(ctx._mobilePage);
    }
  }
  return { page: ctx._mobilePage, ...session };
}

export async function openTabAndWait(page, tabKey, waitSelector) {
  await selectTab(page, tabKey);
  if (waitSelector) {
    await page.waitForSelector(waitSelector, { visible: true, timeout: 12000 });
  }
  await delay(150);
}

export async function readRootCssVar(page, varName) {
  return page.evaluate((name) => {
    return window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }, varName);
}
