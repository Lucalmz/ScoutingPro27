import { delay } from './e2eBackendManager.js';

export async function waitForTransition(page) {
  await page
    .waitForFunction(
      () =>
        !document.documentElement.hasAttribute('data-direction') &&
        !document.documentElement.hasAttribute('data-transition-type'),
      { timeout: 5000 }
    )
    .catch(() => {});
  await delay(60);
}

export async function waitForCondition(fn, { timeoutMs = 30000, intervalMs = 300, label = 'condition', onPoll } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (onPoll) {
      try {
        await onPoll();
      } catch {}
    }
    try {
      const result = await fn();
      if (result) return result;
    } catch (err) {
      lastError = err;
    }
    await delay(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}${lastError ? ` (last error: ${lastError.message})` : ''}`);
}

export async function robustLogin(page, username, password = 'e2etestpass') {
  await page.waitForSelector('#username', { visible: true, timeout: 15000 });
  await page.evaluate(() => {
    const el = document.querySelector('#username');
    if (el) el.value = '';
  });
  await page.type('#username', username);
  await page.evaluate(() => {
    const el = document.querySelector('#username');
    if (el) el.dispatchEvent(new Event('blur'));
  });
  await delay(900);

  await page.waitForSelector('#password', { visible: true, timeout: 10000 });
  await page.type('#password', password);

  const confirmEl = await page.$('#confirmPassword');
  if (confirmEl) {
    await page.type('#confirmPassword', password);
  }

  await page.waitForFunction(() => {
    const btn = document.querySelector('button[type="submit"]');
    return Boolean(btn && !btn.disabled);
  }, { timeout: 10000 });

  await page.click('button[type="submit"]');
  await page.waitForSelector('.action-btn, .dashboard', { timeout: 15000 });
  await waitForTransition(page);
}

export async function confirmAnySasModals(pages) {
  for (const page of pages) {
    if (!page || page.isClosed()) continue;
    try {
      const clicked = await page.evaluate(() => {
        const btn = document.querySelector('.sas-modal-overlay .btn-success');
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
      if (clicked) {
        await delay(150);
      }
    } catch {}
  }
}

export async function waitForConnectedWithSas(targetPage, allLivePages, timeoutMs = 45000) {
  await waitForCondition(
    async () => {
      if (targetPage.isClosed()) return false;
      return await targetPage.evaluate(() => {
        const el = document.querySelector('.connection-status');
        return Boolean(el && el.classList.contains('connected'));
      });
    },
    {
      timeoutMs,
      intervalMs: 250,
      label: 'connection-status.connected',
      onPoll: () => confirmAnySasModals(allLivePages)
    }
  );
}

export async function createEventViaUi(page, eventName) {
  await page.waitForSelector('.action-btn.primary', { timeout: 15000 });
  await waitForTransition(page);
  await page.click('.action-btn.primary');
  await page.waitForSelector('.modal-overlay input', { timeout: 10000 });
  await page.type('.modal-overlay input', eventName);
  await page.click('.btn-confirm');
  await page.waitForSelector('.event-code strong, .event-meta strong', { timeout: 15000 });
  await waitForTransition(page);
  await page.waitForFunction(
    () =>
      Boolean(window.__sp27E2eBridge?.getEventId?.()) &&
      window.__sp27E2eBridge?.isHostMode?.() === true &&
      (window.__sp27E2eBridge?.getHostEpoch?.() ?? 0) >= 1,
    { timeout: 25000 }
  );

  const eventCode = (await page.$eval('.event-code strong, .event-meta strong', (el) => el.textContent || '')).trim();
  const eventId = await page.evaluate(() => window.__sp27E2eBridge?.getEventId?.() || '');
  return { eventCode, eventId };
}

export async function joinEventViaUi(page, eventCode, allLivePages = [page]) {
  const btnSelector = '.action-btn.secondary, .action-btn.primary';
  await page.waitForFunction(() => {
    const btns = Array.from(document.querySelectorAll('.action-btn'));
    return btns.some((b) => {
      const t = b.textContent || '';
      return t.includes('加入') || t.includes('Join');
    });
  }, { timeout: 15000 });
  await waitForTransition(page);
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.action-btn'));
    const joinBtn = btns.find((b) => {
      const t = b.textContent || '';
      return t.includes('加入') || t.includes('Join');
    }) || btns[btns.length - 1];
    joinBtn?.click();
  });
  await page.waitForSelector('.modal-overlay input', { timeout: 10000 });
  await page.type('.modal-overlay input', eventCode);
  await page.click('.btn-confirm');
  await page.waitForSelector('.event-code strong, .event-meta strong', { timeout: 25000 });
  await waitForTransition(page);
  await waitForConnectedWithSas(page, allLivePages, 45000);
  await page.waitForFunction(() => Boolean(window.__sp27E2eBridge?.getEventId?.()), { timeout: 20000 });
}

export async function enterExistingEventCardViaUi(page, eventCode) {
  await page.waitForFunction(
    (code) => {
      const cards = Array.from(document.querySelectorAll('.event-card'));
      return cards.some((c) => (c.textContent || '').toUpperCase().includes(code.toUpperCase()));
    },
    { timeout: 15000 },
    eventCode
  );
  await waitForTransition(page);
  await page.evaluate((code) => {
    const cards = Array.from(document.querySelectorAll('.event-card'));
    const target = cards.find((c) => (c.textContent || '').toUpperCase().includes(code.toUpperCase()));
    if (!target) throw new Error(`Missing event card for ${code}`);
    target.click();
  }, eventCode);
  await page.waitForSelector('.event-code strong, .connection-status', { timeout: 15000 });
  await waitForTransition(page);
  await page.waitForFunction(() => Boolean(window.__sp27E2eBridge?.getEventId?.()), { timeout: 20000 });
}

export async function logoutViaUi(page) {
  const hasBackBtn = await page.$('.btn-back');
  if (hasBackBtn) {
    await page.click('.btn-back');
    await page.waitForSelector('.btn-logout', { timeout: 15000 });
    await waitForTransition(page);
  }
  await page.waitForSelector('.btn-logout', { timeout: 15000 });
  await page.click('.btn-logout');
  await page.waitForSelector('#username', { timeout: 15000 });
  await waitForTransition(page);
}

export async function switchToTab(page, tabKey) {
  await page.evaluate((key) => {
    const byAttr = document.querySelector(`.tab-btn[data-tab="${key}"]`);
    if (byAttr) {
      byAttr.click();
      return;
    }
    const labelMap = {
      scout: ['打分', 'Scout', 'Record'],
      schedule: ['赛程', 'Schedule'],
      pit: ['展位', 'Pit'],
      history: ['历史', 'History'],
      rankings: ['排行', 'Rankings']
    };
    const needles = labelMap[key] || [key];
    const btns = Array.from(document.querySelectorAll('.tab-btn'));
    const match = btns.find((b) => needles.some((n) => (b.textContent || '').includes(n)));
    if (match) match.click();
  }, tabKey);
  await waitForTransition(page);
}

export async function submitMatchRecordViaUi(page, { matchNumber, teamNumber, alliance = 'Blue' }) {
  await switchToTab(page, 'scout');
  await page.waitForSelector('input[placeholder="1-999"]', { timeout: 10000 });
  await page.evaluate(() => {
    const inputs = document.querySelectorAll('input[inputmode="numeric"]');
    if (inputs.length >= 2) {
      inputs[0].value = '';
      inputs[1].value = '';
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  const inputs = await page.$$('input[inputmode="numeric"]');
  await inputs[0].type(String(matchNumber));
  await inputs[1].type(String(teamNumber));
  await page.evaluate((targetAlliance) => {
    const span = Array.from(document.querySelectorAll('.spdt-labels span')).find((el) =>
      (el.textContent || '').toLowerCase().includes(targetAlliance.toLowerCase())
    );
    if (span) span.click();
  }, alliance);
  await page.click('.btn-submit');
  await page.waitForSelector('.submit-status-msg', { timeout: 8000 }).catch(() => {});
  await delay(150);
}

export async function editOwnMatchTeamViaHistoryUi(page, newTeamNumber, matchNumber) {
  await switchToTab(page, 'history');
  await page.waitForFunction(
    (mNum) => {
      const u = JSON.parse(localStorage.getItem('scoutingpro-user') || '{}');
      const cards = Array.from(document.querySelectorAll('.history-card'));
      return cards.some(
        (c) =>
          (!u.id || c.getAttribute('data-scout-id') === u.id) &&
          (!mNum || (c.textContent || '').includes(String(mNum))) &&
          Boolean(c.querySelector('.btn-edit'))
      );
    },
    { timeout: 12000 },
    matchNumber
  );

  await page.evaluate((mNum) => {
    const u = JSON.parse(localStorage.getItem('scoutingpro-user') || '{}');
    const cards = Array.from(document.querySelectorAll('.history-card'));
    const card = cards.find(
      (c) =>
        (!u.id || c.getAttribute('data-scout-id') === u.id) &&
        (!mNum || (c.textContent || '').includes(String(mNum))) &&
        Boolean(c.querySelector('.btn-edit'))
    );
    const editBtn = card?.querySelector('.btn-edit');
    if (!editBtn) throw new Error('Own editable history card not found');
    editBtn.click();
  }, matchNumber);
  await waitForTransition(page);

  await page.waitForSelector('input[placeholder="1-999"]', { timeout: 10000 });
  await page.evaluate(() => {
    const inputs = document.querySelectorAll('input[inputmode="numeric"]');
    if (inputs[1]) {
      inputs[1].value = '';
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  const inputs = await page.$$('input[inputmode="numeric"]');
  await inputs[1].type(String(newTeamNumber));
  await page.click('.btn-submit');
  await page.waitForSelector('.submit-status-msg', { timeout: 8000 }).catch(() => {});
  await delay(250);
}

export async function setPageClockOffset(page, offsetMs) {
  await page.evaluate((offset) => {
    sessionStorage.setItem('__SP27_E2E_CLOCK_OFFSET_MS__', String(offset));
    window.__TEST_CLOCK_OFFSET_MS__ = offset;
  }, offsetMs);
}

export async function fetchBackendJson(port, apiPath, token) {
  const res = await fetch(`http://localhost:${port}${apiPath}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${apiPath}: ${await res.text()}`);
  }
  return await res.json();
}

export async function navigatePageWithRetry(page, url, attempts = 2, timeout = 25000) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      return;
    } catch (err) {
      lastError = err;
      const pending = page.__sp27PendingRequests ? Array.from(page.__sp27PendingRequests) : [];
      console.warn(`[Navigation] Attempt ${i}/${attempts} failed for ${url}: ${err.message}; pendingRequests=${JSON.stringify(pending)}`);
      if (i < attempts) {
        await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
        await delay(400);
      }
    }
  }
  throw lastError;
}
