import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import assert from 'assert';
import { delay } from './e2eBackendManager.js';

export async function waitForTransition(page, { strict = true, timeout = 5000 } = {}) {
  const fn = () =>
    !document.documentElement.hasAttribute('data-direction') &&
    !document.documentElement.hasAttribute('data-transition-type') &&
    !document.querySelector('.tactical-boot-overlay');
  if (strict) {
    await page.waitForFunction(fn, { timeout });
  } else {
    await page.waitForFunction(fn, { timeout }).catch(() => {});
  }
  await delay(60);
}

export async function assertNoStuckTransition(page) {
  const state = await page.evaluate(() => ({
    direction: document.documentElement.getAttribute('data-direction'),
    transitionType: document.documentElement.getAttribute('data-transition-type')
  }));
  assert.strictEqual(state.direction, null, `Stuck data-direction="${state.direction}" on documentElement`);
  assert.strictEqual(state.transitionType, null, `Stuck data-transition-type="${state.transitionType}" on documentElement`);
}

export async function waitForCondition(fn, { timeoutMs = 30000, intervalMs = 300, label = 'condition', onPoll } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (onPoll) {
      try {
        await onPoll();
      } catch (err) {
        if (err instanceof ReferenceError || err instanceof TypeError || err instanceof SyntaxError) {
          throw err;
        }
      }
    }
    try {
      const result = await fn();
      if (result) return result;
    } catch (err) {
      if (err instanceof ReferenceError || err instanceof TypeError || err instanceof SyntaxError) {
        throw err;
      }
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
    if (el) {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await page.type('#username', username);
  await Promise.all([
    page.waitForResponse((res) => res.url().includes('/user/check'), { timeout: 5000 }).catch(() => null),
    page.evaluate(() => {
      const el = document.querySelector('#username');
      if (el) el.dispatchEvent(new Event('blur'));
    })
  ]);
  await page.waitForFunction(
    () => !document.querySelector('button[type="submit"] .spinner'),
    { timeout: 10000 }
  );

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
  await page.waitForSelector('.action-btn, .dashboard, .event-view', { timeout: 15000 });
  await waitForTransition(page, { strict: true });
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
  await waitForTransition(page, { strict: true });
  await page.click('.action-btn.primary');
  await page.waitForSelector('.modal-overlay input', { timeout: 10000 });
  await page.type('.modal-overlay input', eventName);
  await page.click('.btn-confirm');
  await page.waitForSelector('.event-code strong, .event-meta strong', { timeout: 15000 });
  await waitForTransition(page, { strict: true });
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

export async function joinEventViaUi(page, eventCode, allLivePages = [page], { waitForConnected = true } = {}) {
  await page.waitForFunction(() => {
    const btns = Array.from(document.querySelectorAll('.action-btn'));
    return btns.some((b) => {
      const t = b.textContent || '';
      return t.includes('加入') || t.includes('Join');
    });
  }, { timeout: 15000 });
  await waitForTransition(page, { strict: true });
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.action-btn'));
    const joinBtn = btns.find((b) => {
      const t = b.textContent || '';
      return t.includes('加入') || t.includes('Join');
    });
    if (!joinBtn) throw new Error('Join event action button not found');
    joinBtn.click();
  });
  await page.waitForSelector('.modal-overlay input', { timeout: 10000 });
  await page.type('.modal-overlay input', eventCode);
  await page.click('.btn-confirm');
  await page.waitForSelector('.event-code strong, .event-meta strong, .status-pill', { timeout: 25000 });
  await waitForTransition(page, { strict: true });
  if (waitForConnected) {
    await waitForConnectedWithSas(page, allLivePages, 45000);
  }
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
  await waitForTransition(page, { strict: true });
  await page.evaluate((code) => {
    const cards = Array.from(document.querySelectorAll('.event-card'));
    const target = cards.find((c) => (c.textContent || '').toUpperCase().includes(code.toUpperCase()));
    if (!target) throw new Error(`Missing event card for ${code}`);
    target.click();
  }, eventCode);
  await page.waitForSelector('.event-code strong, .connection-status, .status-pill', { timeout: 15000 });
  await waitForTransition(page, { strict: true });
  await page.waitForFunction(() => Boolean(window.__sp27E2eBridge?.getEventId?.()), { timeout: 20000 });
}

export async function logoutViaUi(page) {
  const hasBackBtn = await page.$('.btn-back');
  if (hasBackBtn) {
    await page.click('.btn-back');
    await page.waitForSelector('.btn-logout', { timeout: 15000 });
    await waitForTransition(page, { strict: true });
  }
  await page.waitForSelector('.btn-logout', { timeout: 15000 });
  await page.click('.btn-logout');
  await page.waitForSelector('#username', { timeout: 15000 });
  await waitForTransition(page, { strict: true });
}

export async function switchToTab(page, tabKey) {
  const matched = await page.evaluate((key) => {
    const byAttr = document.querySelector(`.tab-btn[data-tab="${key}"]`);
    if (byAttr) {
      byAttr.click();
      return { kind: 'desktop', text: byAttr.textContent?.trim() || key };
    }
    const labelMap = {
      scout: ['打分', 'Scout', 'Record'],
      schedule: ['赛程', 'Schedule'],
      pit: ['展位', 'Pit'],
      history: ['历史', 'History'],
      rankings: ['排行', 'Rankings'],
      whiteboard: ['战术', '白板', 'Whiteboard'],
      scouts: ['团队', '侦察', '管理', 'Scouts', 'Admin']
    };
    const needles = labelMap[key] || [key];
    const btns = Array.from(document.querySelectorAll('.tab-btn'));
    const match = btns.find((b) => needles.some((n) => (b.textContent || '').includes(n)));
    if (match) {
      match.click();
      return { kind: 'desktop', text: match.textContent?.trim() || key };
    }
    return null;
  }, tabKey);

  if (!matched) {
    throw new Error(`Tab button not found for tabKey="${tabKey}"`);
  }

  await page.waitForFunction(
    (key) => {
      const btn = document.querySelector(`.tab-btn[data-tab="${key}"]`);
      if (btn) return btn.classList.contains('active');
      return Boolean(document.querySelector('.tab-btn.active'));
    },
    { timeout: 6000 },
    tabKey
  );
  await waitForTransition(page, { strict: true });
}

export async function submitMatchRecordViaUi(page, { matchNumber, teamNumber, alliance = 'Blue', expectError = false }) {
  await switchToTab(page, 'scout');
  await page.waitForSelector('input[placeholder="1-999"]', { timeout: 10000 });
  await page.evaluate(() => {
    const inputs = document.querySelectorAll('input[inputmode="numeric"]');
    if (inputs.length < 2) {
      throw new Error(`Expected >= 2 numeric inputs on ScoutingForm, got ${inputs.length}`);
    }
    inputs[0].value = '';
    inputs[1].value = '';
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
  });
  const inputs = await page.$$('input[inputmode="numeric"]');
  assert(inputs.length >= 2, `Expected >= 2 numeric inputs on ScoutingForm, got ${inputs.length}`);
  await inputs[0].type(String(matchNumber));
  await inputs[1].type(String(teamNumber));

  await page.evaluate((targetAlliance) => {
    const norm = targetAlliance.trim().toLowerCase();
    const aliases = norm === 'red' || norm.includes('红') ? ['red', '红'] : ['blue', '蓝'];
    const span = Array.from(document.querySelectorAll('.spdt-labels span')).find((el) => {
      const txt = (el.textContent || '').trim().toLowerCase();
      return aliases.some((a) => txt.includes(a));
    });
    if (!span) {
      throw new Error(`Alliance toggle option "${targetAlliance}" not found in .spdt-labels`);
    }
    span.click();
  }, alliance);

  await page.click('.btn-submit');
  await page.waitForSelector('.submit-status-msg', { timeout: 10000 });
  const statusInfo = await page.$eval('.submit-status-msg', (el) => ({
    isError: el.classList.contains('error'),
    text: (el.textContent || '').trim()
  }));
  if (expectError) {
    assert.strictEqual(statusInfo.isError, true, `Expected submission error, got: ${statusInfo.text}`);
  } else {
    assert.strictEqual(statusInfo.isError, false, `Match submission failed with UI error: ${statusInfo.text}`);
  }
  await delay(150);
}

export async function editOwnMatchTeamViaHistoryUi(page, newTeamNumber, matchNumber) {
  await switchToTab(page, 'history');
  await page.waitForFunction(
    (mNum) => {
      const u = JSON.parse(localStorage.getItem('scoutingpro-user') || '{}');
      const cards = Array.from(document.querySelectorAll('.history-card'));
      const matchRe = mNum ? new RegExp(`#[QP]${mNum}(?:\\s*\\||\\b)`) : null;
      return cards.some((c) => {
        const cardTitle = c.querySelector('.card-teams')?.textContent || c.textContent || '';
        return (
          (!u.id || c.getAttribute('data-scout-id') === u.id) &&
          (!matchRe || matchRe.test(cardTitle)) &&
          Boolean(c.querySelector('.btn-edit'))
        );
      });
    },
    { timeout: 12000 },
    matchNumber
  );

  await page.evaluate((mNum) => {
    const u = JSON.parse(localStorage.getItem('scoutingpro-user') || '{}');
    const cards = Array.from(document.querySelectorAll('.history-card'));
    const matchRe = mNum ? new RegExp(`#[QP]${mNum}(?:\\s*\\||\\b)`) : null;
    const card = cards.find((c) => {
      const cardTitle = c.querySelector('.card-teams')?.textContent || c.textContent || '';
      return (
        (!u.id || c.getAttribute('data-scout-id') === u.id) &&
        (!matchRe || matchRe.test(cardTitle)) &&
        Boolean(c.querySelector('.btn-edit'))
      );
    });
    const editBtn = card?.querySelector('.btn-edit');
    if (!editBtn) throw new Error(`Own editable history card not found for match #${mNum}`);
    editBtn.click();
  }, matchNumber);
  await waitForTransition(page, { strict: true });

  await page.waitForSelector('input[placeholder="1-999"]', { timeout: 10000 });
  await page.evaluate(() => {
    const inputs = document.querySelectorAll('input[inputmode="numeric"]');
    if (!inputs[1]) throw new Error('Team input not found during edit');
    inputs[1].value = '';
    inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
  });
  const inputs = await page.$$('input[inputmode="numeric"]');
  await inputs[1].type(String(newTeamNumber));
  await page.click('.btn-submit');
  await page.waitForSelector('.submit-status-msg', { timeout: 10000 });
  const statusInfo = await page.$eval('.submit-status-msg', (el) => ({
    isError: el.classList.contains('error'),
    text: (el.textContent || '').trim()
  }));
  assert.strictEqual(statusInfo.isError, false, `Match edit save failed: ${statusInfo.text}`);
  await delay(200);
}

export async function sendDirectMessageViaUi(page, targetScoutName, body) {
  await switchToTab(page, 'scouts');
  await page.waitForSelector('.btn-refresh-scouts', { timeout: 10000 });
  await page.click('.btn-refresh-scouts');
  await page.waitForFunction(
    (nameNeedle) => {
      const items = Array.from(document.querySelectorAll('.scout-item'));
      return items.some((li) => (li.querySelector('.scout-name')?.textContent || '').includes(nameNeedle));
    },
    { timeout: 15000 },
    targetScoutName
  );
  await page.evaluate((nameNeedle) => {
    const items = Array.from(document.querySelectorAll('.scout-item'));
    const target = items.find((li) => (li.querySelector('.scout-name')?.textContent || '').includes(nameNeedle));
    const btn = target?.querySelector('.btn-msg');
    if (!btn) throw new Error(`DM button (.btn-msg) not found for scout "${targetScoutName}"`);
    btn.click();
  }, targetScoutName);
  await page.waitForSelector('.send-msg-overlay #direct-msg-content', { visible: true, timeout: 8000 });
  await page.type('.send-msg-overlay #direct-msg-content', body);
  await page.waitForFunction(() => {
    const btn = document.querySelector('.send-msg-overlay .btn-send-action');
    return Boolean(btn && !btn.disabled);
  }, { timeout: 5000 });
  await page.click('.send-msg-overlay .btn-send-action');
  await page.waitForFunction(() => !document.querySelector('.send-msg-overlay'), { timeout: 10000 });
}

export async function uploadOfflineSyncFileViaUi(
  page,
  { fileName, content, expectScanEmpty = false, expectApplyError = false }
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp27-upload-'));
  const tmpFile = path.join(tmpDir, fileName);
  fs.writeFileSync(tmpFile, content, 'utf8');

  try {
    await page.waitForSelector('.offline-sync-btn', { timeout: 10000 });
    await page.click('.offline-sync-btn');
    await page.waitForSelector('.offline-sync-modal', { visible: true, timeout: 8000 });

    const importTabClicked = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('.offline-sync-modal .modal-tabs .tab-btn'));
      if (tabs.length < 2) return false;
      tabs[1].click();
      return true;
    });
    assert.strictEqual(importTabClicked, true, 'OfflineSyncModal Import tab button not found');

    const fileInput = await page.waitForSelector('.offline-sync-modal input[type="file"][accept*=".info"]', {
      timeout: 8000
    });
    await fileInput.uploadFile(tmpFile);

    await page.waitForFunction(
      () =>
        !document.querySelector('.offline-sync-modal .scanning-indicator') &&
        Boolean(
          document.querySelector('.offline-sync-modal .preview-card') ||
            document.querySelector('.offline-sync-modal .empty-scan-banner') ||
            document.querySelector('.offline-sync-modal .import-error-banner')
        ),
      { timeout: 10000 }
    );

    if (expectScanEmpty) {
      const hasEmptyOrErr = await page.evaluate(() =>
        Boolean(
          document.querySelector('.offline-sync-modal .empty-scan-banner') ||
            document.querySelector('.offline-sync-modal .import-error-banner')
        )
      );
      assert.strictEqual(hasEmptyOrErr, true, `Expected rejected/empty scan for ${fileName}`);
      await page.click('.offline-sync-modal .btn-close');
      await page.waitForFunction(() => !document.querySelector('.offline-sync-modal'), { timeout: 5000 });
      return { applied: false, previewMatched: [] };
    }

    const previewInfo = await page.evaluate(() => ({
      hasPreview: Boolean(document.querySelector('.offline-sync-modal .preview-card')),
      matchedNames: Array.from(document.querySelectorAll('.offline-sync-modal .matched-file-name')).map((el) =>
        (el.textContent || '').trim()
      )
    }));
    assert.strictEqual(previewInfo.hasPreview, true, `Expected .preview-card for ${fileName}`);
    assert.ok(previewInfo.matchedNames.includes(fileName), `Expected ${fileName} in matched list: ${previewInfo.matchedNames}`);

    await page.click('.offline-sync-modal .apply-btn');

    if (expectApplyError) {
      await page.waitForFunction(
        () => {
          const banner = document.querySelector('.offline-sync-modal .import-error-banner');
          return Boolean(banner && (banner.textContent || '').trim().length > 0);
        },
        { timeout: 10000 }
      );
      const modalOpen = await page.$('.offline-sync-modal');
      assert.ok(modalOpen, 'Expected .offline-sync-modal to stay open when import fails');
      await page.click('.offline-sync-modal .btn-close');
      await page.waitForFunction(() => !document.querySelector('.offline-sync-modal'), { timeout: 5000 });
      return { applied: false, previewMatched: previewInfo.matchedNames };
    }

    await page.waitForFunction(() => !document.querySelector('.offline-sync-modal'), { timeout: 12000 });
    return { applied: true, previewMatched: previewInfo.matchedNames };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function completeMobileWizardMatchViaUi(
  page,
  {
    matchNumber,
    teamNumber,
    alliance = 'red',
    autoHits = 2,
    teleopHits = 3,
    endgameNectars = 1,
    teleopPark = true,
    notes = ''
  }
) {
  await page.waitForSelector('.mobile-wizard-container.step-0', { visible: true, timeout: 15000 });

  // Verify required-field gate keeps Next disabled while team is empty or invalid
  const initiallyDisabled = await page.$eval('.btn-wizard-primary', (btn) => Boolean(btn.disabled));
  assert.strictEqual(initiallyDisabled, true, 'Mobile Step 0 Next button must be disabled before team/alliance selection');

  const allianceSelector = alliance === 'blue' ? '.alliance-btn.blue-btn' : '.alliance-btn.red-btn';
  await page.waitForSelector(allianceSelector, { visible: true, timeout: 8000 });
  await page.click(allianceSelector);

  const numInputs = await page.$$('.giant-num-input');
  assert(numInputs.length >= 2, `Expected >= 2 .giant-num-input elements, got ${numInputs.length}`);
  await page.evaluate(() => {
    const inputs = document.querySelectorAll('.giant-num-input');
    for (const inp of inputs) {
      inp.value = '';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await numInputs[0].type(String(matchNumber));
  await numInputs[1].type(String(teamNumber));

  await page.waitForFunction(() => {
    const btn = document.querySelector('.btn-wizard-primary');
    return Boolean(btn && !btn.disabled);
  }, { timeout: 5000 });
  await page.click('.btn-wizard-primary');

  // Step 1: Auto
  await page.waitForSelector('.mobile-wizard-container.step-1', { visible: true, timeout: 8000 });
  for (let i = 0; i < autoHits; i++) {
    await page.click('.auto-hero-hit');
  }
  await page.click('.btn-wizard-primary');

  // Step 2: TeleOp
  await page.waitForSelector('.mobile-wizard-container.step-2', { visible: true, timeout: 8000 });
  for (let i = 0; i < teleopHits; i++) {
    await page.click('.teleop-hero-hit');
  }
  await page.click('.btn-wizard-primary');

  // Step 3: Endgame
  await page.waitForSelector('.mobile-wizard-container.step-3', { visible: true, timeout: 8000 });
  if (endgameNectars > 0) {
    const plusClicked = await page.evaluate((count) => {
      const cards = Array.from(document.querySelectorAll('.mobile-stepper-card'));
      const firstPlus = cards[0]?.querySelectorAll('.btn-step')?.[1];
      if (!firstPlus) return false;
      for (let i = 0; i < count; i++) firstPlus.click();
      return true;
    }, endgameNectars);
    assert.strictEqual(plusClicked, true, 'Nectar + button not found on mobile Endgame step');
  }
  if (teleopPark) {
    await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.mobile-toggles-grid .toggle-card, .toggle-card'));
      const parkCard = cards.find((c) => Boolean(c.querySelector('.icon-park')));
      if (!parkCard) throw new Error('Park toggle card not found on mobile Endgame step');
      if (!parkCard.classList.contains('is-checked')) {
        parkCard.click();
      }
    });
  }
  if (notes) {
    const noteEl = await page.$('.notes-textarea, textarea');
    if (noteEl) {
      await noteEl.type(notes);
    }
  }
  await page.click('.btn-wizard-primary');

  // Step 4: Summary & Submit
  await page.waitForSelector('.mobile-wizard-container.step-4', { visible: true, timeout: 8000 });
  const summaryTotalText = await page.$eval('.step-summary .total-score-val', (el) => (el.textContent || '').trim());
  const summaryTotal = Number(summaryTotalText);
  assert(Number.isFinite(summaryTotal) && summaryTotal > 0, `Expected positive summary total score, got "${summaryTotalText}"`);

  await page.click('.btn-wizard-submit');
  // Successful submit resets wizard back to Step 0 and increments match number
  await page.waitForSelector('.mobile-wizard-container.step-0', { visible: true, timeout: 12000 });
  const errBanner = await page.$('.submit-error-banner');
  assert.strictEqual(errBanner, null, 'Unexpected submit-error-banner on mobile wizard submit');
  return summaryTotal;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

export function createTinyPngFile(filePath, width = 16, height = 16) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rowSize = 1 + width * 4;
  const raw = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    raw[y * rowSize] = 0;
    for (let x = 0; x < width; x++) {
      const off = y * rowSize + 1 + x * 4;
      raw[off] = 57;
      raw[off + 1] = 255;
      raw[off + 2] = 20;
      raw[off + 3] = 255;
    }
  }
  const idat = zlib.deflateSync(raw);
  const png = Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
  fs.writeFileSync(filePath, png);
  return filePath;
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
