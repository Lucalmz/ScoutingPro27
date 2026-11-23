import assert from 'assert';
import { execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import mqtt from 'mqtt';
import { E2EClusterManager, REPO_ROOT, allocateFreePorts, delay } from './helpers/e2eBackendManager.js';
import {
  confirmAnySasModals,
  createEventViaUi,
  createTinyPngFile,
  editOwnMatchTeamViaHistoryUi,
  enterExistingEventCardViaUi,
  fetchBackendJson,
  joinEventViaUi,
  logoutViaUi,
  navigatePageWithRetry,
  robustLogin,
  sendDirectMessageViaUi,
  setPageClockOffset,
  submitMatchRecordViaUi,
  switchToTab,
  uploadOfflineSyncFileViaUi,
  waitForCondition,
  waitForConnectedWithSas,
  waitForTransition
} from './helpers/e2eUiActions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SHOW_UI = process.env.SHOW_UI === '1';

let PORT_HOST_A;
let PORT_HOST_B;
let PORT_HOST_C;

let URL_HOST_A;
let URL_HOST_B;
let URL_HOST_C;

const TEN_YEARS_MS = 10 * 365 * 24 * 3600 * 1000;
const ONE_YEAR_MS = 365 * 24 * 3600 * 1000;
const TWO_HOURS_MS = 2 * 3600 * 1000;

const EXPECTED_OFFLINE_CONSOLE_PATTERNS = [
  /ERR_INTERNET_DISCONNECTED/i,
  /ERR_FAILED/i,
  /Failed to load resource/i,
  /WebSocket connection.*failed/i,
  /Failed to fetch/i
];

function snapshotFileStat(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false };
  const s = fs.statSync(filePath);
  return { exists: true, size: s.size, mtimeMs: s.mtimeMs };
}

async function ensureServiceWorkerControlled(page) {
  const swSupport = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { supported: false, controlled: false };
    try {
      await navigator.serviceWorker.ready;
      const deadline = Date.now() + 8000;
      while (!navigator.serviceWorker.controller && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150));
      }
      return { supported: true, controlled: Boolean(navigator.serviceWorker.controller) };
    } catch {
      return { supported: true, controlled: false };
    }
  });
  if (swSupport.supported && !swSupport.controlled) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    const afterReload = await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      const deadline = Date.now() + 8000;
      while (!navigator.serviceWorker.controller && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150));
      }
      return Boolean(navigator.serviceWorker.controller);
    });
    assert.strictEqual(afterReload, true, 'ServiceWorker controller failed to take control after reload');
  }
  return swSupport.controlled;
}

async function getUserSession(page) {
  return await page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('scoutingpro-user') || '{}');
    } catch {
      return {};
    }
  });
}

async function publishMqttStrict(mqttClient, topic, payload) {
  let published = false;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MQTT publish timeout on ${topic}`)), 6000);
    mqttClient.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    const doPublish = () => {
      mqttClient.publish(topic, payload, {}, (err) => {
        clearTimeout(timer);
        if (err) return reject(err);
        published = true;
        resolve();
      });
    };
    if (mqttClient.connected) {
      doPublish();
    } else {
      mqttClient.once('connect', doPublish);
    }
  });
  assert.strictEqual(published, true, `Expected MQTT publish to succeed on ${topic}`);
}

async function runTest() {
  if (process.env.SKIP_BUILD !== '1') {
    console.log('Building frontend and packaging Backend fat JAR before E2E (set SKIP_BUILD=1 to skip)...');
    execSync('npm run build', { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' });
    const mavenCmd = os.platform() === 'win32' ? 'mvn.cmd' : 'mvn';
    execSync(`${mavenCmd} package -DskipTests`, { cwd: path.join(REPO_ROOT, 'Backend'), stdio: 'inherit' });
  }

  const rootDbPaths = [
    path.join(REPO_ROOT, 'app_data.mv.db'),
    path.join(REPO_ROOT, 'Backend', 'app_data.mv.db')
  ];
  const rootDbBaselines = rootDbPaths.map((p) => ({ path: p, stat: snapshotFileStat(p) }));

  const runId = Date.now();
  const manager = new E2EClusterManager(runId);

  const signalHandler = async (sig) => {
    console.warn(`\n[E2E] Caught ${sig}; running emergency cleanup...`);
    await manager.cleanupAll({ assertDeleted: false }).catch(() => {});
    process.exit(1);
  };
  process.on('SIGINT', signalHandler);
  process.on('SIGTERM', signalHandler);

  const dirHostA = manager.createTempDir('hostA');
  const dirHostB = manager.createTempDir('hostB');
  const dirHostC = manager.createTempDir('hostC');
  const uploadAssetDir = manager.createTempDir('assets');
  const tinyPngPath = createTinyPngFile(path.join(uploadAssetDir, 'pit_robot_e2e.png'));

  const chromeDirHostA = manager.createTempDir('chrome-hostA');
  const chromeDirHostB = manager.createTempDir('chrome-hostB');
  const chromeDirHostC = manager.createTempDir('chrome-hostC');
  const chromeDirClient1 = manager.createTempDir('chrome-client1');
  const chromeDirClient2 = manager.createTempDir('chrome-client2');

  let pageHostA = null;
  let pageHostB = null;
  let pageHostC = null;
  let pageClient1 = null;
  let pageClient2 = null;
  let client1Cdp = null;
  let client2Cdp = null;

  const livePages = () => [pageHostA, pageHostB, pageHostC, pageClient1, pageClient2].filter((p) => p && !p.isClosed());

  try {
    [PORT_HOST_A, PORT_HOST_B, PORT_HOST_C] = await allocateFreePorts(3);
    URL_HOST_A = `http://localhost:${PORT_HOST_A}/index.html`;
    URL_HOST_B = `http://localhost:${PORT_HOST_B}/index.html`;
    URL_HOST_C = `http://localhost:${PORT_HOST_C}/index.html`;

    const clientBaseUrl = await manager.startStaticClientServer(0, '127.0.0.2');
    const urlStaticClient = `${clientBaseUrl}/index.html`;
    const mqttBrokerUrl = await manager.startLocalMqttBroker();

    await Promise.all([
      manager.startBackend({ name: 'hostA', port: PORT_HOST_A, tmpDir: dirHostA }),
      manager.startBackend({ name: 'hostB', port: PORT_HOST_B, tmpDir: dirHostB })
    ]);

    const launched = await Promise.all([
      manager.launchBrowser({ name: 'hostA', index: 0, userDataDir: chromeDirHostA, showUi: SHOW_UI }),
      manager.launchBrowser({ name: 'hostB', index: 1, userDataDir: chromeDirHostB, showUi: SHOW_UI }),
      manager.launchBrowser({
        name: 'client1',
        index: 2,
        userDataDir: chromeDirClient1,
        showUi: SHOW_UI,
        extraSecureOrigin: clientBaseUrl
      }),
      manager.launchBrowser({
        name: 'client2',
        index: 3,
        userDataDir: chromeDirClient2,
        showUi: SHOW_UI,
        extraSecureOrigin: clientBaseUrl
      })
    ]);

    pageHostA = launched[0].page;
    pageHostB = launched[1].page;
    pageClient1 = launched[2].page;
    pageClient2 = launched[3].page;

    const hostUser = `HostUser_${runId}`;
    const bobUser = `AssistantBob_${runId}`;
    const client1User = `Client1_${runId}`;
    const client2User = `Client2_${runId}`;

    // ========================================================================
    // STEP 1: Create event on HostA (Epoch = 1), join HostB(Bob), Client1, Client2
    // ========================================================================
    console.log('\n=== Step 1: Create Event (Epoch=1) & 3-Sample Crystal Clock Calibration ===');
    await pageHostA.goto(URL_HOST_A, { waitUntil: 'domcontentloaded' });
    await robustLogin(pageHostA, hostUser);
    const { eventCode, eventId } = await createEventViaUi(pageHostA, `CRDT_DISASTER_${runId}`);
    assert.ok(eventCode && eventId, 'HostA failed to create authoritative event');

    const hostASession = await getUserSession(pageHostA);
    const hostAEpoch = await pageHostA.evaluate(() => window.__sp27E2eBridge?.getHostEpoch?.());
    assert.strictEqual(hostAEpoch, 1, `Expected initial HostA epoch=1, got ${hostAEpoch}`);
    console.log(`🎉 Created Event "${eventId}" (Code: ${eventCode}, Epoch: ${hostAEpoch})`);

    await Promise.all([
      pageHostB.goto(URL_HOST_B, { waitUntil: 'domcontentloaded' }).then(() => robustLogin(pageHostB, bobUser)),
      pageClient1.goto(urlStaticClient, { waitUntil: 'domcontentloaded' }).then(async () => {
        await ensureServiceWorkerControlled(pageClient1);
        await robustLogin(pageClient1, client1User);
      }),
      pageClient2.goto(urlStaticClient, { waitUntil: 'domcontentloaded' }).then(async () => {
        await ensureServiceWorkerControlled(pageClient2);
        await robustLogin(pageClient2, client2User);
      })
    ]);

    await joinEventViaUi(pageHostB, eventCode, livePages());
    await joinEventViaUi(pageClient1, eventCode, livePages());
    await joinEventViaUi(pageClient2, eventCode, livePages());

    const bobSession = await getUserSession(pageHostB);
    const client1Session = await getUserSession(pageClient1);
    const client2Session = await getUserSession(pageClient2);

    // Wait for 3-sample calibrated crystal clock anchor on Client1 & Client2
    await waitForCondition(
      async () => {
        const c1Cal = await pageClient1.evaluate((eid) => {
          const raw = localStorage.getItem(`sp27_clock_anchor_${eid}`);
          return raw ? JSON.parse(raw)?.calibratedByHost === true : false;
        }, eventId);
        const c2Cal = await pageClient2.evaluate((eid) => {
          const raw = localStorage.getItem(`sp27_clock_anchor_${eid}`);
          return raw ? JSON.parse(raw)?.calibratedByHost === true : false;
        }, eventId);
        return c1Cal && c2Cal;
      },
      { timeoutMs: 15000, label: 'calibratedByHost on Client1 & Client2' }
    );

    const hostBInfo = await pageHostB.evaluate(() => ({
      isHostMode: window.__sp27E2eBridge?.isHostMode?.(),
      eventId: window.__sp27E2eBridge?.getEventId?.()
    }));
    assert.strictEqual(hostBInfo.isHostMode, false, 'HostB logged in as AssistantBob must join as backup client, not host');
    assert.strictEqual(hostBInfo.eventId, eventId, 'HostB must be bound to the authoritative eventId');
    manager.assertNoUnexpectedErrors(livePages(), { allowConsolePatterns: [/WakeLock/i] });
    console.log('✅ Step 1 passed: All 4 nodes connected, SW controlled, SAS verified, and calibrated.');

    // ========================================================================
    // STEP 2: Baseline same Match 1 Team 9999 Conflict Derivation
    // ========================================================================
    console.log('\n=== Step 2: Baseline Multi-Scout Conflict Derivation ===');
    await submitMatchRecordViaUi(pageHostA, { matchNumber: 1, teamNumber: 9999 });
    await submitMatchRecordViaUi(pageClient1, { matchNumber: 1, teamNumber: 9999 });
    await submitMatchRecordViaUi(pageClient2, { matchNumber: 1, teamNumber: 9999 });

    await Promise.all([switchToTab(pageHostA, 'history'), switchToTab(pageClient1, 'history'), switchToTab(pageClient2, 'history')]);
    await waitForCondition(
      async () => {
        const checks = await Promise.all([
          pageHostA.evaluate(() => Boolean(document.querySelector('.is-conflict-card'))),
          pageClient1.evaluate(() => Boolean(document.querySelector('.is-conflict-card'))),
          pageClient2.evaluate(() => Boolean(document.querySelector('.is-conflict-card')))
        ]);
        return checks.every(Boolean);
      },
      { timeoutMs: 25000, label: 'Match 1 Team 9999 conflict card on HostA, Client1, Client2' }
    );
    await waitForCondition(
      async () => {
        const checkSyncedNoResync = async (page, scoutId) =>
          page.evaluate((sid) => {
            const ownCards = Array.from(document.querySelectorAll(`.history-card[data-scout-id="${sid}"]`));
            if (ownCards.length === 0) return false;
            const allOwnSynced = ownCards.every((c) => Boolean(c.querySelector('.sync-badge.is-synced')));
            const resyncCount = document.querySelectorAll('.btn-resync').length;
            return allOwnSynced && resyncCount === 0;
          }, scoutId);
        const [c1Ok, c2Ok] = await Promise.all([
          checkSyncedNoResync(pageClient1, client1Session.id),
          checkSyncedNoResync(pageClient2, client2Session.id)
        ]);
        return c1Ok && c2Ok;
      },
      { timeoutMs: 15000, label: 'Client1 & Client2 own cards SYNCED with zero .btn-resync in CRDT mode' }
    );
    for (const [label, pg] of [['Client1', pageClient1], ['Client2', pageClient2]]) {
      const storageAudit = await pg.evaluate(() => {
        const recs = JSON.parse(localStorage.getItem('scoutingpro_records') || '[]');
        const hasHostSeq = recs.some((r) => Boolean(r.hostSeq));
        const allSigned = recs.length > 0 && recs.every((r) => Boolean(r.authorPubKey) && Boolean(r.authorSig));
        const hasLegacySeqKey = Object.keys(localStorage).some((k) => k.startsWith('sp27_lastHostSeq_'));
        return { count: recs.length, hasHostSeq, allSigned, hasLegacySeqKey };
      });
      assert.strictEqual(storageAudit.hasHostSeq, false, `${label} must have zero records with truthy hostSeq in Step 2`);
      assert.strictEqual(storageAudit.allSigned, true, `${label} records must all carry ECDSA authorPubKey & authorSig in Step 2`);
      assert.strictEqual(storageAudit.hasLegacySeqKey, false, `${label} must have zero sp27_lastHostSeq_* keys`);
    }
    console.log('✅ Step 2 passed: Pure derived conflict badges appeared on all active nodes.');

    // ========================================================================
    // STEP 3: Anti-Clock-Poisoning Double Kill (+10y/-1y Date.now + 2036 HLC packet)
    //         + Seed online Match 13 for Step 6 offline tombstone test
    // ========================================================================
    console.log('\n=== Step 3: Anti-Clock-Poisoning Double Verification ===');
    const wallBefore3 = Date.now();
    await pageClient1.evaluate((deltaPlus) => {
      window.__ORIG_DATE_NOW_E2E__ = Date.now;
      const orig = window.__ORIG_DATE_NOW_E2E__;
      Date.now = () => orig() + deltaPlus;
    }, TEN_YEARS_MS);
    await submitMatchRecordViaUi(pageClient1, { matchNumber: 11, teamNumber: 27570 });
    await pageClient1.evaluate(async () => {
      await window.__sp27E2eBridge.updatePitFields(27570, {
        robotName: 'ClockTestPlus10Yr',
        weightLbs: 28,
        launcherType: 'Drum'
      });
    });

    await pageClient1.evaluate((deltaMinus) => {
      const orig = window.__ORIG_DATE_NOW_E2E__ || Date.now;
      Date.now = () => orig() - deltaMinus;
    }, ONE_YEAR_MS);
    await submitMatchRecordViaUi(pageClient1, { matchNumber: 12, teamNumber: 27570 });

    await pageClient1.evaluate(() => {
      if (window.__ORIG_DATE_NOW_E2E__) {
        Date.now = window.__ORIG_DATE_NOW_E2E__;
        delete window.__ORIG_DATE_NOW_E2E__;
      }
    });

    const client1MaxHlcAfter3A = await pageClient1.evaluate(() => window.__sp27E2eBridge.getMaxHlcPt());
    assert.ok(
      Math.abs(client1MaxHlcAfter3A - Date.now()) < 15000 && client1MaxHlcAfter3A >= wallBefore3 - 5000,
      `Expected Client1 crystal clock HLC to remain near real time despite +10y/-1y Date.now tampering, got drift=${client1MaxHlcAfter3A - Date.now()}ms`
    );

    // Also submit Match 13 (Team 27570) normally on Client1 so it replicates before Step 6 offline delete
    await submitMatchRecordViaUi(pageClient1, { matchNumber: 13, teamNumber: 27570 });

    // Wait for Pit #27570 baseline and Match 13 to replicate to Client2 & HostB before Step 6
    await waitForCondition(
      async () => {
        const s2 = await pageClient2.evaluate(() => window.__sp27E2eBridge.getNormalizedState());
        const sb = await pageHostB.evaluate(() => window.__sp27E2eBridge.getNormalizedState());
        return (
          s2?.pitRecords?.some((p) => p.teamNumber === 27570 && p.robotName === 'ClockTestPlus10Yr') &&
          sb?.pitRecords?.some((p) => p.teamNumber === 27570 && p.robotName === 'ClockTestPlus10Yr') &&
          sb?.scoutingRecords?.some((r) => r.matchNumber === 13 && !r.isDeleted)
        );
      },
      { timeoutMs: 25000, label: 'Pit #27570 + Match 13 baseline replication across Client2 and HostB' }
    );

    // 3B: Send poisoned 2036 CRDT_SYNC_MSG frame from Client1 -> HostA
    await pageClient1.evaluate(async () => {
      await window.__sp27E2eBridge.sendPoisonedFutureHlcFrame(10);
    });
    await waitForCondition(
      async () => {
        const hostSkews = await pageHostA.evaluate(() => window.__LAST_CRDT_FUTURE_SKEW__ || []);
        const clientResync = await pageClient1.evaluate(() => window.__LAST_FORCE_CLOCK_RESYNC__ || null);
        return hostSkews.length > 0 && clientResync?.reason === 'future_hlc_skew';
      },
      { timeoutMs: 15000, label: 'HostA future HLC skew alert + FORCE_CLOCK_RESYNC on Client1' }
    );

    await delay(800);
    const hostAStateAfter3 = await pageHostA.evaluate(() => window.__sp27E2eBridge.getNormalizedState());
    const c2StateAfter3 = await pageClient2.evaluate(() => window.__sp27E2eBridge.getNormalizedState());
    assert.strictEqual(
      hostAStateAfter3.pitRecords.some((p) => p.teamNumber === 99999),
      false,
      'Poisoned 2036 Pit #99999 must be dropped by HostA skew guard'
    );
    assert.strictEqual(
      c2StateAfter3.pitRecords.some((p) => p.teamNumber === 99999),
      false,
      'Poisoned 2036 Pit #99999 must never reach Client2'
    );
    const hostAMaxPt3 = await pageHostA.evaluate(() => window.__sp27E2eBridge.getMaxHlcPt());
    assert.ok(Math.abs(hostAMaxPt3 - Date.now()) < 15000, `HostA HLC poisoned after 2036 attack: ${hostAMaxPt3}`);

    // Verify HostA visible Pit UI & H2 /api/events/:id/pit reject Pit #99999
    await switchToTab(pageHostA, 'pit');
    await pageHostA.waitForSelector('.team-roster-card', { timeout: 10000 });
    const hasPoisonDom = await pageHostA.evaluate(() =>
      Array.from(document.querySelectorAll('.team-roster-card')).some((c) => (c.textContent || '').includes('99999'))
    );
    assert.strictEqual(hasPoisonDom, false, 'Poisoned Pit #99999 must NOT render in HostA Pit UI DOM');
    const hostAPitResp = await fetchBackendJson(PORT_HOST_A, `/api/events/${eventId}/pit-records`, hostASession.token);
    const hostAPits = hostAPitResp?.records || (Array.isArray(hostAPitResp) ? hostAPitResp : []);
    assert.strictEqual(
      Array.isArray(hostAPits) && hostAPits.some((p) => Number(p.teamNumber) === 99999),
      false,
      'Poisoned Pit #99999 must NOT persist into HostA H2 DB'
    );
    console.log('✅ Step 3 passed: System clock spoofing ignored, 2036 packet blocked from CRDT/DOM/H2.');

    // ========================================================================
    // STEP 4: Real UI Direct Messaging (Offline Outbox -> Reconnect -> Visible Inbox DOM -> Mark Read -> Persist)
    // ========================================================================
    console.log('\n=== Step 4: Real UI Offline Outbox Queuing, Online DM & Visible Inbox DOM ===');
    client1Cdp = manager.registerCdpSession(await pageClient1.target().createCDPSession());
    client2Cdp = manager.registerCdpSession(await pageClient2.target().createCDPSession());

    await client1Cdp.send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1
    });
    await pageClient1.evaluate(() => window.__rtcSimulateNetworkDrop?.());
    await waitForCondition(
      async () =>
        await pageClient1.evaluate(() => {
          const el = document.querySelector('.connection-status');
          return Boolean(el && !el.classList.contains('connected'));
        }),
      { timeoutMs: 10000, label: 'Client1 disconnect before offline DM' }
    );

    const offlineDmBody = 'Prepare for Auto Zone B';
    const onlineDmBody = 'Cover Auto zone right';
    await sendDirectMessageViaUi(pageHostA, client1User, offlineDmBody);

    await waitForCondition(
      () =>
        pageHostA.evaluate(
          (targetId, bodyText) => {
            const u = JSON.parse(localStorage.getItem('scoutingpro-user') || '{}');
            const outbox = JSON.parse(localStorage.getItem(`inbox-outbox-${u.id}`) || '[]');
            const entry = outbox.find((i) => i.targetId === targetId && i.body === bodyText);
            return entry?.status === 'PENDING_DELIVERY';
          },
          client1Session.id,
          offlineDmBody
        ),
      { timeoutMs: 10000, label: 'HostA outbox item queued as PENDING_DELIVERY' }
    );
    const outboxQueued = await pageHostA.evaluate((targetId, bodyText) => {
      const u = JSON.parse(localStorage.getItem('scoutingpro-user') || '{}');
      const outbox = JSON.parse(localStorage.getItem(`inbox-outbox-${u.id}`) || '[]');
      const entry = outbox.find((i) => i.targetId === targetId && i.body === bodyText);
      return entry?.status || null;
    }, client1Session.id, offlineDmBody);
    assert.strictEqual(outboxQueued, 'PENDING_DELIVERY', `Expected PENDING_DELIVERY in outbox, got ${outboxQueued}`);

    await client1Cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1
    });
    await pageClient1.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitForConnectedWithSas(pageClient1, livePages(), 40000);

    await waitForCondition(
      async () => {
        const hostStatus = await pageHostA.evaluate((targetId, bodyText) => {
          const u = JSON.parse(localStorage.getItem('scoutingpro-user') || '{}');
          const outbox = JSON.parse(localStorage.getItem(`inbox-outbox-${u.id}`) || '[]');
          return outbox.find((i) => i.targetId === targetId && i.body === bodyText)?.status || null;
        }, client1Session.id, offlineDmBody);
        const badgeCount = await pageClient1.evaluate(() => {
          const b = document.querySelector('.inbox-widget .badge');
          return b ? Number((b.textContent || '').trim()) : 0;
        });
        return hostStatus === 'DELIVERED' && badgeCount >= 1;
      },
      { timeoutMs: 25000, label: 'Offline DM flush & visible Inbox badge on Client1' }
    );

    await sendDirectMessageViaUi(pageHostA, client1User, onlineDmBody);

    // Open visible Inbox DOM on Client1 and assert BOTH messages + Mark Read + badge decrement
    await pageClient1.waitForFunction(
      (b1, b2, uid) => {
        const msgs = JSON.parse(localStorage.getItem(`inbox-messages-${uid}`) || '[]');
        return msgs.some((m) => m.body === b1) && msgs.some((m) => m.body === b2);
      },
      { timeout: 20000 },
      offlineDmBody,
      onlineDmBody,
      client1Session.id
    );
    await pageClient1.click('.inbox-widget .inbox-morph-container');
    await pageClient1.waitForSelector('.inbox-widget.is-open .inbox-item', { visible: true, timeout: 8000 });
    await waitForCondition(
      () =>
        pageClient1.evaluate(() => {
          const box = document.querySelector('.inbox-widget.is-open .inbox-morph-container')?.getBoundingClientRect();
          const btn = document.querySelector('.inbox-widget.is-open .inbox-item.unread .mark-read')?.getBoundingClientRect();
          return Boolean(
            box &&
              box.width >= 300 &&
              box.height >= 350 &&
              btn &&
              btn.width > 0 &&
              btn.height > 0 &&
              btn.bottom <= box.bottom + 1 &&
              btn.top >= box.top - 1
          );
        }),
      { timeoutMs: 5000, label: 'Inbox morph expanded and .mark-read button inside bounds' }
    );
    const inboxSnapshotBeforeRead = await pageClient1.evaluate((b1, b2) => {
      const items = Array.from(document.querySelectorAll('.inbox-widget .inbox-item'));
      const texts = items.map((el) => (el.textContent || '').trim());
      return {
        unreadBefore: items.filter((el) => el.classList.contains('unread')).length,
        hasOfflineDm: texts.some((t) => t.includes(b1)),
        hasOnlineDm: texts.some((t) => t.includes(b2))
      };
    }, offlineDmBody, onlineDmBody);
    assert.strictEqual(inboxSnapshotBeforeRead.hasOfflineDm, true, 'Client1 visible Inbox UI missing flushed offline DM');
    assert.strictEqual(inboxSnapshotBeforeRead.hasOnlineDm, true, 'Client1 visible Inbox UI missing online DM');
    assert.ok(inboxSnapshotBeforeRead.unreadBefore >= 2, `Expected >=2 unread DMs, got ${inboxSnapshotBeforeRead.unreadBefore}`);

    await pageClient1.click('.inbox-widget .inbox-item.unread .mark-read');
    await pageClient1.waitForFunction(
      (prevUnread) => document.querySelectorAll('.inbox-widget .inbox-item.unread').length === prevUnread - 1,
      { timeout: 5000 },
      inboxSnapshotBeforeRead.unreadBefore
    );
    await pageClient1.click('.inbox-widget .close-btn');
    await pageClient1.waitForFunction(() => !document.querySelector('.inbox-widget.is-open'), { timeout: 5000 });
    const readCountAfter = await pageClient1.evaluate((uid) => {
      const msgs = JSON.parse(localStorage.getItem(`inbox-messages-${uid}`) || '[]');
      return msgs.filter((m) => m.read === true).length;
    }, client1Session.id);
    assert.ok(readCountAfter >= 1, 'Expected marked-read DM state to persist in Client1 localStorage');
    manager.assertNoUnexpectedErrors([pageHostA], { allowConsolePatterns: [/WakeLock/i] });
    manager.assertNoUnexpectedErrors([pageClient1], {
      allowConsolePatterns: [...EXPECTED_OFFLINE_CONSOLE_PATTERNS, /WakeLock/i]
    });
    manager.clearPageErrors([pageClient1, pageHostA]);
    console.log('✅ Step 4 passed: Real UI DMs queued offline, flushed on reconnect, verified in Inbox UI.');

    // ========================================================================
    // STEP 5: Signaling Hard Boundary, Real ECDH/pkHash Hijack, & Backend 401/403
    // ========================================================================
    console.log('\n=== Step 5: MQTT Signaling Boundary, Real ECDH/pkHash Attack & Backend AuthZ ===');
    const topicHash = crypto.createHash('sha256').update(eventCode + '-scoutingpro27').digest('hex');
    const signalTopic = `scoutingpro27/signal/${topicHash}`;

    const mqttAttack1 = manager.registerMqttClient(
      mqtt.connect(mqttBrokerUrl, {
        clientId: `attacker-inj-${runId}`,
        clean: true,
        connectTimeout: 4000
      })
    );
    await publishMqttStrict(
      mqttAttack1,
      signalTopic,
      JSON.stringify({
        type: 'SYNC_DATA',
        sender: 'attacker_peer',
        records: [{ id: 'injected-fake-uuid-999', matchNumber: 99, teamNumber: 1111, totalScore: 999 }]
      })
    );
    await delay(800);
    mqttAttack1.end();

    const [hostInj, c1Inj] = await Promise.all([
      pageHostA.evaluate(() => JSON.parse(localStorage.getItem('scoutingpro_records') || '[]').some((r) => r.id === 'injected-fake-uuid-999')),
      pageClient1.evaluate(() => JSON.parse(localStorage.getItem('scoutingpro_records') || '[]').some((r) => r.id === 'injected-fake-uuid-999'))
    ]);
    assert.strictEqual(hostInj, false, 'Injected SYNC_DATA must not enter HostA');
    assert.strictEqual(c1Inj, false, 'Injected SYNC_DATA must not enter Client1');

    const mqttAttack2 = manager.registerMqttClient(
      mqtt.connect(mqttBrokerUrl, {
        clientId: `attacker-hmac-${runId}`,
        clean: true,
        connectTimeout: 4000
      })
    );
    await publishMqttStrict(
      mqttAttack2,
      signalTopic,
      JSON.stringify({
        type: 'offer',
        sender: 'attacker_tamper',
        offer: { type: 'offer', sdp: 'fake_tampered_sdp' },
        signature: '0'.repeat(64),
        timestamp: Date.now(),
        nonce: `nonce_${runId}`
      })
    );
    await delay(600);
    mqttAttack2.end();

    const hostConnectedAfterHmac = await pageHostA.evaluate(() =>
      Boolean(document.querySelector('.connection-status.connected'))
    );
    assert.strictEqual(hostConnectedAfterHmac, true, 'HostA must stay connected after forged HMAC attack');

    // Valid-HMAC MITM/pkHash hijack attempt carrying real rogue P-256 key & Client1's deviceId + mismatched ticket pkHash
    const client1DeviceId = await pageClient1.evaluate(() => {
      try {
        return JSON.parse(localStorage.getItem('sp27_device_identity') || '{}').deviceId || 'dev_c1';
      } catch {
        return 'dev_c1';
      }
    });
    const rogueEcdh = crypto.createECDH('prime256v1');
    rogueEcdh.generateKeys();
    const roguePubHex = rogueEcdh.getPublicKey('hex', 'uncompressed');
    const mismatchedTicket = [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: client1Session.id, pkHash: '0'.repeat(64) })).toString('base64url'),
      'forged_sig'
    ].join('.');
    const mqttAttack3 = manager.registerMqttClient(
      mqtt.connect(mqttBrokerUrl, {
        clientId: `attacker-pkhash-${runId}`,
        clean: true,
        connectTimeout: 4000
      })
    );
    const spoofEnvelope = {
      type: 'offer',
      sender: `sp27-attacker-mitm-${runId}`,
      clientSessionId: `sess_mitm_${runId}`,
      deviceId: client1DeviceId,
      userId: client1Session.id,
      username: client1User,
      ecdhPublicKey: roguePubHex,
      offer: { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n', ticket: mismatchedTicket },
      timestamp: Date.now(),
      nonce: `nonce_spoof_${runId}`
    };
    const canonicalObj = {};
    for (const k of Object.keys(spoofEnvelope).sort()) canonicalObj[k] = spoofEnvelope[k];
    const derivedKey = crypto.pbkdf2Sync(eventCode, 'scoutingpro27', 100000, 32, 'sha256');
    spoofEnvelope.signature = crypto.createHmac('sha256', derivedKey).update(JSON.stringify(canonicalObj)).digest('hex');
    await publishMqttStrict(mqttAttack3, signalTopic, JSON.stringify(spoofEnvelope));
    await delay(800);
    mqttAttack3.end();

    // Backend JWT & ECDSA non-host impersonation 401/403 checks on PORT_HOST_A
    const validVerify = await fetch(`http://localhost:${PORT_HOST_A}/api/user/verify-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: hostASession.token })
    }).then((r) => r.json());
    assert.strictEqual(validVerify.valid, true, 'HostA verify-token should validate authentic HostA JWT');

    const invalidVerifyRes = await fetch(`http://localhost:${PORT_HOST_A}/api/user/verify-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: `${hostASession.token}_tampered` })
    });
    const invalidVerifyJson = await invalidVerifyRes.json().catch(() => ({}));
    assert.ok(
      invalidVerifyRes.status === 401 || invalidVerifyJson.valid === false,
      `Tampered JWT must be rejected (status=${invalidVerifyRes.status}, body=${JSON.stringify(invalidVerifyJson)})`
    );

    const peerAttackUser = `PeerAttacker_${runId}`;
    const regAttacker = await fetch(`http://localhost:${PORT_HOST_A}/api/user/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: peerAttackUser, password: 'e2etestpass' })
    });
    assert.ok(regAttacker.ok, `Expected attacker account registration HTTP 2xx, got ${regAttacker.status}`);
    const attackerAuth = await regAttacker.json();
    const joinAttacker = await fetch(`http://localhost:${PORT_HOST_A}/api/events/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${attackerAuth.token}` },
      body: JSON.stringify({ inviteCode: eventCode })
    });
    assert.ok(joinAttacker.ok, `Expected attacker join HTTP 2xx, got ${joinAttacker.status}`);

    const forgedSyncRes = await pageClient1.evaluate(
      async ({ port, evtId, victimId, atkToken }) => {
        const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
        const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
        const pubHex = Array.from(rawPub, (b) => b.toString(16).padStart(2, '0')).join('');
        const rec = {
          id: `rec-http-forged-${Date.now()}`,
          eventId: evtId,
          scoutId: victimId,
          scoutName: 'VictimHost',
          matchNumber: 77,
          teamNumber: 7777,
          autoScore: 10,
          teleopScore: 20,
          endgameScore: 5,
          totalScore: 35,
          notes: '',
          rawData: '{}',
          isBroken: false,
          isDeleted: false,
          version: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          authorPubKey: pubHex,
          authorSig: ''
        };
        const canonical = JSON.stringify({
          id: rec.id,
          eventId: rec.eventId,
          scoutId: rec.scoutId,
          matchNumber: rec.matchNumber,
          teamNumber: rec.teamNumber,
          autoScore: rec.autoScore,
          teleopScore: rec.teleopScore,
          endgameScore: rec.endgameScore,
          totalScore: rec.totalScore,
          notes: rec.notes,
          rawData: rec.rawData,
          isBroken: rec.isBroken,
          isDeleted: rec.isDeleted,
          version: rec.version
        });
        const sigBuf = await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          kp.privateKey,
          new TextEncoder().encode(canonical)
        );
        rec.authorSig = Array.from(new Uint8Array(sigBuf), (b) => b.toString(16).padStart(2, '0')).join('');
        const resp = await fetch(`http://localhost:${port}/api/records/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${atkToken}` },
          body: JSON.stringify([rec])
        });
        return { status: resp.status, text: await resp.text() };
      },
      { port: PORT_HOST_A, evtId: eventId, victimId: hostASession.id, atkToken: attackerAuth.token }
    );
    assert.strictEqual(
      forgedSyncRes.status,
      403,
      `Expected HTTP 403 when non-host impersonates host scoutId with self-signed ECDSA key, got ${forgedSyncRes.status}: ${forgedSyncRes.text}`
    );

    const c1ConnectedAfterDos = await pageClient1.evaluate(() => Boolean(document.querySelector('.connection-status.connected')));
    assert.strictEqual(c1ConnectedAfterDos, true, 'Client1 must remain stably connected after security attacks');
    console.log('✅ Step 5 passed: MQTT signaling, real ECDH/pkHash hijack, tampered JWT & HTTP 403 impersonation verified.');

    // ========================================================================
    // STEP 6: HostA Hard Crash + 2h Offline Window + UI Binary Photo + Offline Tombstone + SW Reload
    // ========================================================================
    console.log('\n=== Step 6: HostA Hard Crash + 2h Offline Edits + Binary Photo Queue + Tombstone ===');
    await client1Cdp.send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1
    });
    await client2Cdp.send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1
    });
    await Promise.all([
      pageClient1.evaluate(() => window.__rtcSimulateNetworkDrop?.()),
      pageClient2.evaluate(() => window.__rtcSimulateNetworkDrop?.()),
      pageHostB.evaluate(() => window.__rtcDisconnect?.())
    ]);
    await waitForCondition(
      async () => {
        const [aConn, bConn, c1Conn, c2Conn] = await Promise.all([
          pageHostA.evaluate(() => Boolean(document.querySelector('.connection-status.connected'))),
          pageHostB.evaluate(() => Boolean(document.querySelector('.connection-status.connected'))),
          pageClient1.evaluate(() => Boolean(document.querySelector('.connection-status.connected'))),
          pageClient2.evaluate(() => Boolean(document.querySelector('.connection-status.connected')))
        ]);
        return !aConn && !bConn && !c1Conn && !c2Conn;
      },
      { timeoutMs: 15000, label: 'All peers isolated from HostA' }
    );

    // HostA submits unbroadcasted Match 5 Team 27570 & persists to Temp H2 #1
    await submitMatchRecordViaUi(pageHostA, { matchNumber: 5, teamNumber: 27570 });
    await pageHostA.evaluate(async () => {
      await window.__sp27E2eBridge.flushCrdtNow();
    });
    const hostACrdtDb = await fetchBackendJson(PORT_HOST_A, `/api/events/${eventId}/crdt-state`, hostASession.token);
    assert.strictEqual(hostACrdtDb.exists, true, 'HostA Temp H2 #1 must contain persisted CRDT state');

    const preCrashC1 = await pageClient1.evaluate(() => window.__sp27E2eBridge.getNormalizedState());
    assert.strictEqual(preCrashC1.scoutingRecords.some((r) => r.matchNumber === 5), false, 'Client1 must NOT have unbroadcasted Match 5');

    manager.assertNoUnexpectedErrors([pageHostA], {
      allowConsolePatterns: [/Ticket pkHash payload mismatch|WakeLock/i]
    });

    // Hard-kill HostA backend & close browserHostA ungracefully
    await manager.hardKillBackend('hostA');
    await manager.closeBrowser('hostA', { gracefulDisconnect: false });
    pageHostA = null;

    await Promise.all([
      setPageClockOffset(pageClient1, TWO_HOURS_MS),
      setPageClockOffset(pageClient2, TWO_HOURS_MS),
      setPageClockOffset(pageHostB, TWO_HOURS_MS)
    ]);

    // Client1 2h offline work: edit Match 1 -> 8888, submit Match 2 & 3, soft-delete Match 13 into offline tombstone
    await editOwnMatchTeamViaHistoryUi(pageClient1, 8888, 1);
    await submitMatchRecordViaUi(pageClient1, { matchNumber: 2, teamNumber: 27570 });
    await submitMatchRecordViaUi(pageClient1, { matchNumber: 3, teamNumber: 1234 });

    const match13RecordId = await pageClient1.evaluate(() => window.__sp27E2eBridge.getOwnRecordIdByMatch(13));
    assert.ok(match13RecordId, 'Expected Match 13 ID to exist on Client1 before offline soft delete');
    await pageClient1.evaluate(async (recId) => {
      await window.__sp27E2eBridge.softDeleteOwnRecord(recId);
    }, match13RecordId);

    // Upload real PNG binary photo through PitScoutFormDrawer on offline Client1 (saved to IndexedDB offline queue)
    await switchToTab(pageClient1, 'pit');
    await pageClient1.waitForFunction(
      () => Array.from(document.querySelectorAll('.team-roster-card')).some((c) => (c.textContent || '').includes('27570')),
      { timeout: 10000 }
    );
    await pageClient1.evaluate(() => {
      const card = Array.from(document.querySelectorAll('.team-roster-card')).find((c) => (c.textContent || '').includes('27570'));
      if (!card) throw new Error('Team 27570 Pit card missing');
      card.click();
    });
    await pageClient1.waitForSelector('.drawer-panel input[type="file"].file-hidden', { timeout: 8000 });
    const pitFileInput = await pageClient1.$('.drawer-panel input[type="file"].file-hidden');
    await pitFileInput.uploadFile(tinyPngPath);
    await pageClient1.waitForSelector('.drawer-panel .photo-item img', { visible: true, timeout: 10000 });
    await pageClient1.click('.drawer-footer .btn-primary');
    await pageClient1.waitForFunction(() => !document.querySelector('.drawer-panel'), { timeout: 8000 });

    await pageClient1.evaluate(async () => {
      await window.__sp27E2eBridge.updatePitFields(27570, { weightLbs: 31.5 });
      await window.__sp27E2eBridge.flushCrdtNow();
    });
    const uploadedPitPhotoKey = await pageClient1.evaluate(async () => {
      const st = await window.__sp27E2eBridge.getNormalizedState();
      return st?.pitRecords?.find((p) => p.teamNumber === 27570)?.photoKeys?.[0] || null;
    });
    assert.ok(uploadedPitPhotoKey && uploadedPitPhotoKey.startsWith('pit_27570_'), `Expected real uploaded Pit photoKey, got ${uploadedPitPhotoKey}`);

    await switchToTab(pageClient1, 'history');
    await pageClient1.waitForFunction(
      (c1Id) => {
        const cards = Array.from(document.querySelectorAll('.history-card'));
        const hasM3 = cards.some(
          (c) => c.getAttribute('data-scout-id') === c1Id && (c.textContent || '').includes('#Q3') && (c.textContent || '').includes('#1234')
        );
        const hasM11 = cards.some(
          (c) => c.getAttribute('data-scout-id') === c1Id && (c.textContent || '').includes('#Q11') && (c.textContent || '').includes('#27570')
        );
        const hasM13 = cards.some((c) => c.getAttribute('data-scout-id') === c1Id && (c.textContent || '').includes('#Q13'));
        return hasM3 && hasM11 && !hasM13;
      },
      { timeout: 10000 },
      client1Session.id
    );
    const preReloadAudit = await pageClient1.evaluate((c1Id) => {
      const cards = Array.from(document.querySelectorAll('.history-card'));
      const match3Card = cards.find(
        (c) => c.getAttribute('data-scout-id') === c1Id && (c.textContent || '').includes('#Q3') && (c.textContent || '').includes('#1234')
      );
      const match11Card = cards.find(
        (c) => c.getAttribute('data-scout-id') === c1Id && (c.textContent || '').includes('#Q11') && (c.textContent || '').includes('#27570')
      );
      return {
        match3Pending: Boolean(match3Card?.querySelector('.sync-badge.is-pending')),
        match3HasResync: Boolean(match3Card?.querySelector('.btn-resync')),
        match11Synced: Boolean(match11Card?.querySelector('.sync-badge.is-synced')),
        match11HasResync: Boolean(match11Card?.querySelector('.btn-resync'))
      };
    }, client1Session.id);
    assert.strictEqual(preReloadAudit.match3Pending, true, `Offline Match 3 must show .sync-badge.is-pending`);
    assert.strictEqual(preReloadAudit.match3HasResync, true, `Offline Match 3 must show .btn-resync`);
    assert.strictEqual(preReloadAudit.match11Synced, true, `Online Match 11 must remain .sync-badge.is-synced`);
    assert.strictEqual(preReloadAudit.match11HasResync, false, `Online Match 11 must not show .btn-resync`);

    // Offline Resync button click must keep PENDING + .btn-resync
    await pageClient1.evaluate((c1Id) => {
      const cards = Array.from(document.querySelectorAll('.history-card'));
      const match3Card = cards.find(
        (c) => c.getAttribute('data-scout-id') === c1Id && (c.textContent || '').includes('#Q3') && (c.textContent || '').includes('#1234')
      );
      match3Card?.querySelector('.btn-resync')?.click();
    }, client1Session.id);
    await delay(200);
    const postOfflineClickAudit = await pageClient1.evaluate((c1Id) => {
      const cards = Array.from(document.querySelectorAll('.history-card'));
      const match3Card = cards.find(
        (c) => c.getAttribute('data-scout-id') === c1Id && (c.textContent || '').includes('#Q3') && (c.textContent || '').includes('#1234')
      );
      return {
        match3Pending: Boolean(match3Card?.querySelector('.sync-badge.is-pending')),
        match3HasResync: Boolean(match3Card?.querySelector('.btn-resync'))
      };
    }, client1Session.id);
    assert.strictEqual(postOfflineClickAudit.match3Pending, true, 'Offline Resync click must keep Match 3 .sync-badge.is-pending');
    assert.strictEqual(postOfflineClickAudit.match3HasResync, true, 'Offline Resync click must retain Match 3 .btn-resync');

    // Offline reload via PWA Service Worker cache while client1Cdp offline=true
    await pageClient1.reload({ waitUntil: 'domcontentloaded' });
    await pageClient1.waitForFunction(() => Boolean(window.__sp27E2eBridge?.getNormalizedState), { timeout: 20000 });
    const c1AfterReloadState = await pageClient1.evaluate(() => window.__sp27E2eBridge.getNormalizedState());
    assert.ok(
      c1AfterReloadState.scoutingRecords.some((r) => r.matchNumber === 3 && r.teamNumber === 1234),
      'Client1 offline Match 3 must survive full offline page.reload()'
    );
    const m13AfterReload = c1AfterReloadState.scoutingRecords.find((r) => r.matchNumber === 13);
    assert.ok(m13AfterReload && m13AfterReload.isDeleted && m13AfterReload.version >= 2, 'Client1 Match 13 tombstone must survive offline reload');
    assert.strictEqual(
      c1AfterReloadState.pitRecords.find((p) => p.teamNumber === 27570)?.weightLbs,
      31.5,
      'Client1 Pit #27570 weightLbs=31.5 must survive offline page.reload()'
    );
    assert.ok(
      c1AfterReloadState.pitRecords.find((p) => p.teamNumber === 27570)?.photoKeys?.includes(uploadedPitPhotoKey),
      'Client1 real uploaded Pit photoKey must survive offline page.reload()'
    );
    // Verify Inbox read count from Step 4 survived reload too
    const persistedReadCount = await pageClient1.evaluate((uid) => {
      const msgs = JSON.parse(localStorage.getItem(`inbox-messages-${uid}`) || '[]');
      return msgs.filter((m) => m.read === true).length;
    }, client1Session.id);
    assert.ok(persistedReadCount >= 1, 'Inbox marked-read state must survive offline reload');

    await switchToTab(pageClient1, 'history');
    await waitForCondition(
      () =>
        pageClient1.evaluate((c1Id) => {
          const cards = Array.from(document.querySelectorAll('.history-card'));
          const match3Card = cards.find(
            (c) => c.getAttribute('data-scout-id') === c1Id && (c.textContent || '').includes('#Q3') && (c.textContent || '').includes('#1234')
          );
          const match11Card = cards.find(
            (c) => c.getAttribute('data-scout-id') === c1Id && (c.textContent || '').includes('#Q11') && (c.textContent || '').includes('#27570')
          );
          const match13Card = cards.find((c) => c.getAttribute('data-scout-id') === c1Id && (c.textContent || '').includes('#Q13'));
          return (
            Boolean(match3Card?.querySelector('.sync-badge.is-pending')) &&
            Boolean(match3Card?.querySelector('.btn-resync')) &&
            Boolean(match11Card?.querySelector('.sync-badge.is-synced')) &&
            !match11Card?.querySelector('.btn-resync') &&
            !match13Card
          );
        }, client1Session.id),
      { timeoutMs: 10000, label: 'Post-reload History state on offline Client1' }
    );

    // Client2 2h offline work: Match 1->7777, Match 2 & 4, Pit launcherType, add & soft-delete tag
    await editOwnMatchTeamViaHistoryUi(pageClient2, 7777, 1);
    await submitMatchRecordViaUi(pageClient2, { matchNumber: 2, teamNumber: 1111 });
    await submitMatchRecordViaUi(pageClient2, { matchNumber: 4, teamNumber: 2222 });
    await pageClient2.evaluate(async () => {
      await window.__sp27E2eBridge.updatePitFields(27570, { launcherType: 'Turret' });
      await window.__sp27E2eBridge.addTag(27570, 'strong-auto', 'green');
      await window.__sp27E2eBridge.addTag(27570, 'fragile-intake', 'red');
      await window.__sp27E2eBridge.removeTag(27570, 'fragile-intake');
      await window.__sp27E2eBridge.flushCrdtNow();
    });
    await delay(300);

    // HostB (AssistantBob) offline edits Match 10 assignment + signed Match 6 -> flush Temp H2 #2 -> logout()
    await pageHostB.evaluate(async (bid, bname) => {
      await window.__sp27E2eBridge.assignMatchScout(10, 'red1', 27570, bid, bname);
    }, bobSession.id, bobSession.username);
    await submitMatchRecordViaUi(pageHostB, { matchNumber: 6, teamNumber: 27570 });
    await pageHostB.evaluate(async () => {
      await window.__sp27E2eBridge.flushCrdtNow();
    });
    const hostBCrdtBeforeLogout = await fetchBackendJson(PORT_HOST_B, `/api/events/${eventId}/crdt-state`, bobSession.token);
    assert.strictEqual(hostBCrdtBeforeLogout.exists, true, 'Temp H2 #2 must hold Bob offline CRDT state before logout');

    await logoutViaUi(pageHostB);
    manager.assertNoUnexpectedErrors([pageHostB], {
      allowConsolePatterns: [/Only the event host can modify match schedule|status of 403 \(Forbidden\)|WakeLock/i]
    });
    manager.assertNoUnexpectedErrors([pageClient1, pageClient2], {
      allowConsolePatterns: [...EXPECTED_OFFLINE_CONSOLE_PATTERNS, /ERR_CONNECTION_REFUSED|WakeLock/i]
    });
    manager.clearPageErrors([pageClient1, pageClient2, pageHostB]);
    console.log('✅ Step 6 passed: HostA killed, +2h offline edits + UI binary photo + Match 13 tombstone + SW reload verified.');

    // ========================================================================
    // STEP 7: Shared-DB HostB Takeover (Epoch=2) + Photo Chunk Flush + DOM/H2 Checks
    // ========================================================================
    console.log('\n=== Step 7: HostB Direct Takeover (Epoch=2), Tombstone & Photo Chunk Convergence ===');
    await robustLogin(pageHostB, hostUser);

    await pageHostB.waitForFunction(
      (code) =>
        Array.from(document.querySelectorAll('.event-card')).some((c) =>
          (c.textContent || '').toUpperCase().includes(code.toUpperCase())
        ),
      { timeout: 15000 },
      eventCode
    );
    // Wait for HostB to be promoted to Epoch=2 BEFORE bringing Client1 & Client2 back online,
    // so their 'online' event and reconnect photo-queue flush target the live HostB!
    await enterExistingEventCardViaUi(pageHostB, eventCode);

    await Promise.all([
      client1Cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1
      }),
      client2Cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1
      })
    ]);
    await Promise.all([
      pageClient1.evaluate(() => window.dispatchEvent(new Event('online'))),
      pageClient2.evaluate(() => window.dispatchEvent(new Event('online')))
    ]);

    await waitForCondition(
      async () =>
        await pageHostB.evaluate(
          () => window.__sp27E2eBridge?.isHostMode?.() === true && window.__sp27E2eBridge?.getHostEpoch?.() >= 2
        ),
      {
        timeoutMs: 25000,
        label: 'HostB promotion to Epoch=2',
        onPoll: () => confirmAnySasModals(livePages())
      }
    );
    const hostBEpoch = await pageHostB.evaluate(() => window.__sp27E2eBridge.getHostEpoch());
    assert.strictEqual(hostBEpoch, 2, `Expected HostB to promote to Epoch=2, got ${hostBEpoch}`);

    await waitForConnectedWithSas(pageClient1, livePages(), 45000);
    await waitForConnectedWithSas(pageClient2, livePages(), 45000);

    await waitForCondition(
      async () => {
        const [sb, s1, s2] = await Promise.all([
          pageHostB.evaluate(() => window.__sp27E2eBridge.getNormalizedState()),
          pageClient1.evaluate(() => window.__sp27E2eBridge.getNormalizedState()),
          pageClient2.evaluate(() => window.__sp27E2eBridge.getNormalizedState())
        ]);
        const checkNode = (st) => {
          if (!st) return false;
          const pit = st.pitRecords.find((p) => p.teamNumber === 27570);
          const hasPitMerge =
            pit &&
            pit.weightLbs === 31.5 &&
            pit.launcherType === 'Turret' &&
            pit.photoKeys.includes(uploadedPitPhotoKey);
          const hasTags =
            st.teamTags.some((t) => t.teamNumber === 27570 && t.tag === 'strong-auto') &&
            !st.teamTags.some((t) => t.teamNumber === 27570 && t.tag === 'fragile-intake');
          const hasBobAssign = st.assignments.some(
            (a) => a.matchNumber === 10 && a.station === 'red1' && a.scoutId === bobSession.id
          );
          const hasBobMatch6 = st.scoutingRecords.some((r) => r.matchNumber === 6 && r.scoutId === bobSession.id);
          const hasC1Match3 = st.scoutingRecords.some((r) => r.matchNumber === 3 && r.teamNumber === 1234);
          const hasC2Match4 = st.scoutingRecords.some((r) => r.matchNumber === 4 && r.teamNumber === 2222);
          const m13Tombstone = st.scoutingRecords.find((r) => r.matchNumber === 13);
          const hasTombstone = Boolean(m13Tombstone && m13Tombstone.isDeleted && m13Tombstone.version >= 2);
          return Boolean(hasPitMerge && hasTags && hasBobAssign && hasBobMatch6 && hasC1Match3 && hasC2Match4 && hasTombstone && st.conflicts.length === 0);
        };
        return checkNode(sb) && checkNode(s1) && checkNode(s2);
      },
      { timeoutMs: 45000, label: 'Step 7 full convergence (including Pit photoKey + Match 13 tombstone)' }
    );

    await Promise.all([
      switchToTab(pageClient1, 'history'),
      switchToTab(pageClient2, 'history'),
      switchToTab(pageHostB, 'history')
    ]);
    await waitForCondition(
      async () => {
        const [c1Ok, c2Ok, hbOk] = await Promise.all([
          pageClient1.evaluate((sid) => {
            const own = Array.from(document.querySelectorAll(`.history-card[data-scout-id="${sid}"]`));
            return own.length > 0 && own.every((c) => Boolean(c.querySelector('.sync-badge.is-synced'))) && document.querySelectorAll('.btn-resync').length === 0;
          }, client1Session.id),
          pageClient2.evaluate((sid) => {
            const own = Array.from(document.querySelectorAll(`.history-card[data-scout-id="${sid}"]`));
            return own.length > 0 && own.every((c) => Boolean(c.querySelector('.sync-badge.is-synced'))) && document.querySelectorAll('.btn-resync').length === 0;
          }, client2Session.id),
          pageHostB.evaluate(() => {
            const cards = Array.from(document.querySelectorAll('.history-card'));
            const conflictCards = document.querySelectorAll('.is-conflict-card').length;
            const hasM13Visible = cards.some((c) => (c.textContent || '').includes('#Q13'));
            const resyncCount = document.querySelectorAll('.btn-resync').length;
            return cards.length > 0 && conflictCards === 0 && !hasM13Visible && resyncCount === 0;
          })
        ]);
        return c1Ok && c2Ok && hbOk;
      },
      { timeoutMs: 20000, label: 'Step 7 post-convergence visible History DOM (conflicts=0, tombstones hidden, SYNCED)' }
    );

    // Verify HostB H2 relational projections & offline binary photo flushed via WebRTC PIT_PHOTO_CHUNK to HostB disk
    await pageHostB.evaluate(async () => {
      await window.__sp27E2eBridge.flushCrdtNow();
    });
    const hostBSession = await getUserSession(pageHostB);
    const db2Records = await fetchBackendJson(PORT_HOST_B, `/api/records?eventId=${eventId}`, hostBSession.token);
    assert.ok(db2Records.some((r) => r.matchNumber === 6 && r.scoutId === bobSession.id), 'Bob Match 6 must project into Temp H2 #2');
    assert.ok(db2Records.some((r) => r.matchNumber === 4 && r.teamNumber === 2222), 'Client2 Match 4 must project into Temp H2 #2');
    const db2M13 = db2Records.find((r) => r.matchNumber === 13);
    assert.ok(db2M13 && db2M13.isDeleted === true && db2M13.version >= 2, 'Match 13 tombstone must project into Temp H2 #2');

    const db2PitResp = await fetchBackendJson(PORT_HOST_B, `/api/events/${eventId}/pit-records`, hostBSession.token);
    const db2Pits = db2PitResp?.records || (Array.isArray(db2PitResp) ? db2PitResp : []);
    const db2Pit27570 = Array.isArray(db2Pits) ? db2Pits.find((p) => Number(p.teamNumber) === 27570) : null;
    assert.ok(db2Pit27570 && db2Pit27570.weightLbs === 31.5 && db2Pit27570.launcherType === 'Turret', 'Merged Pit #27570 must project into Temp H2 #2');

    const db2Tags = await fetchBackendJson(PORT_HOST_B, `/api/events/${eventId}/tags`, hostBSession.token);
    assert.ok(Array.isArray(db2Tags) && db2Tags.some((t) => t.tag === 'strong-auto'), 'Tag strong-auto must project into Temp H2 #2');
    assert.strictEqual(Array.isArray(db2Tags) && db2Tags.some((t) => t.tag === 'fragile-intake'), false, 'Soft-deleted tag fragile-intake must not be active in Temp H2 #2');

    const db2Schedule = await fetchBackendJson(PORT_HOST_B, `/api/events/${eventId}/schedule`, hostBSession.token);
    const db2Assignments = db2Schedule?.assignments || {};
    assert.strictEqual(
      Object.values(db2Assignments).some((a) => Number(a.matchNumber) === 10 && a.scoutId === bobSession.id),
      true,
      'Bob Match 10 assignment must project into Temp H2 #2'
    );

    // Wait for Client1's queued offline Pit photo WebRTC chunk upload to reach HostB disk & verify HTTP 200
    const c1PhotoDiag = await pageClient1.evaluate(async (key, eid) => {
      const url = window.location.href;
      const hash = window.location.hash;
      const bridgeEid = window.__sp27E2eBridge?.getEventId?.();
      const dbItems = await new Promise((resolve) => {
        const req = indexedDB.open('ScoutingPro_MobileMedia', 1);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('pit_photos', 'readonly');
          const getAll = tx.objectStore('pit_photos').getAll();
          getAll.onsuccess = () => resolve(getAll.result || []);
          getAll.onerror = () => resolve([]);
        };
        req.onerror = () => resolve([]);
      });
      return {
        url,
        hash,
        bridgeEid,
        expectedEid: eid,
        expectedKey: key,
        dbItems: dbItems.map((i) => ({ key: i.key, eventId: i.eventId, syncStatus: i.syncStatus, len: i.dataUrl?.length }))
      };
    }, uploadedPitPhotoKey, eventId);
    console.log('[PhotoDiag Step 7]', JSON.stringify(c1PhotoDiag));
    await waitForCondition(
      async () => {
        await pageClient1.evaluate(() => window.dispatchEvent(new Event('online')));
        const res = await fetch(
          `http://localhost:${PORT_HOST_B}/api/events/${eventId}/pit/photos/${encodeURIComponent(uploadedPitPhotoKey)}`,
          { headers: { Authorization: `Bearer ${hostBSession.token}` } }
        );
        return res.status === 200;
      },
      { timeoutMs: 25000, intervalMs: 1000, label: `WebRTC PIT_PHOTO_CHUNK delivery to HostB disk (${uploadedPitPhotoKey})` }
    );
    manager.assertNoUnexpectedErrors(livePages(), {
      allowConsolePatterns: [...EXPECTED_OFFLINE_CONSOLE_PATTERNS, /ERR_CONNECTION_REFUSED|WakeLock/i]
    });
    manager.clearPageErrors(livePages());
    console.log('✅ Step 7 passed: HostB takeover, tombstone, H2 relational projections & real photo WebRTC flush verified.');

    // ========================================================================
    // STEP 8: Stale HostA Demotion -> Visible Standby Banner -> Live Standby Host UI Takeover
    // ========================================================================
    console.log('\n=== Step 8: Stale HostA Fencing, Match 5 Merge & Live Standby Host UI Takeover (Epoch=3) ===');
    await manager.startBackend({ name: 'hostA', port: PORT_HOST_A, tmpDir: dirHostA });
    const launchedRevivedA = await manager.launchBrowser({
      name: 'hostA',
      index: 0,
      userDataDir: chromeDirHostA,
      showUi: SHOW_UI,
      initialClockOffsetMs: TWO_HOURS_MS
    });
    pageHostA = launchedRevivedA.page;
    await pageHostA.goto(URL_HOST_A, { waitUntil: 'domcontentloaded' });
    await pageHostA.waitForFunction(
      () => Boolean(document.querySelector('#username')) || Boolean(document.querySelector('.dashboard')),
      { timeout: 15000 }
    );
    await pageHostA.waitForFunction(
      () => Boolean(document.querySelector('.dashboard')) || !localStorage.getItem('scoutingpro-user'),
      { timeout: 5000 }
    ).catch(() => {});
    await waitForTransition(pageHostA);
    if (!(await pageHostA.$('.dashboard')) && (await pageHostA.$('#username'))) {
      await robustLogin(pageHostA, hostUser);
    } else {
      await pageHostA.waitForSelector('.dashboard', { timeout: 10000 });
    }
    await enterExistingEventCardViaUi(pageHostA, eventCode);

    // Assert HostA auto-fences from Epoch=2, demotes to Standby, AND shows visible .standby-host-banner + .btn-takeover-host
    await waitForCondition(
      async () =>
        await pageHostA.evaluate(
          () =>
            window.__sp27E2eBridge?.isHostMode?.() === false &&
            window.__sp27E2eBridge?.isStandbyHost?.() === true &&
            Boolean(document.querySelector('.standby-host-banner')) &&
            Boolean(document.querySelector('.btn-takeover-host')) &&
            document.querySelector('.connection-status.connected') !== null
        ),
      {
        timeoutMs: 35000,
        intervalMs: 250,
        label: 'Stale HostA Epoch=1 fenced to visible Standby banner',
        onPoll: () => confirmAnySasModals(livePages())
      }
    );

    // Assert dead HostA's exclusive Match 5 Team 27570 merges to HostB, Client1, Client2 & HostB DOM/H2
    await waitForCondition(
      async () => {
        const [sb, s1, s2] = await Promise.all([
          pageHostB.evaluate(() => window.__sp27E2eBridge.getNormalizedState()),
          pageClient1.evaluate(() => window.__sp27E2eBridge.getNormalizedState()),
          pageClient2.evaluate(() => window.__sp27E2eBridge.getNormalizedState())
        ]);
        const hasM5 = (st) => Boolean(st?.scoutingRecords?.some((r) => r.matchNumber === 5 && r.teamNumber === 27570));
        return hasM5(sb) && hasM5(s1) && hasM5(s2);
      },
      { timeoutMs: 35000, label: 'HostA exclusive Match 5 convergence across HostB, Client1, Client2' }
    );
    await switchToTab(pageHostB, 'history');
    const hostBHasM5Dom = await pageHostB.evaluate(() =>
      Array.from(document.querySelectorAll('.history-card')).some((c) => (c.textContent || '').includes('#Q5'))
    );
    assert.strictEqual(hostBHasM5Dom, true, 'Match 5 must render in HostB visible History DOM');

    manager.assertNoUnexpectedErrors([pageHostB], {
      allowConsolePatterns: [/WakeLock/i]
    });

    // Now hard-kill live HostB & execute LIVE Standby Host takeover via .btn-takeover-host click on HostA!
    await manager.hardKillBackend('hostB');
    await manager.closeBrowser('hostB', { gracefulDisconnect: false });
    pageHostB = null;

    await waitForCondition(
      async () =>
        await pageClient1.evaluate(() => !document.querySelector('.connection-status.connected')),
      { timeoutMs: 15000, label: 'Client1 notices HostB drop before live Standby takeover' }
    );

    await pageHostA.click('.btn-takeover-host');
    await waitForCondition(
      async () =>
        await pageHostA.evaluate(
          () =>
            window.__sp27E2eBridge?.isHostMode?.() === true &&
            window.__sp27E2eBridge?.isStandbyHost?.() === false &&
            (window.__sp27E2eBridge?.getHostEpoch?.() ?? 0) >= 3 &&
            !document.querySelector('.standby-host-banner')
        ),
      {
        timeoutMs: 25000,
        intervalMs: 250,
        label: 'HostA Live Standby UI Takeover -> Epoch=3',
        onPoll: () => confirmAnySasModals(livePages())
      }
    );
    const hostAPromotedEpoch = await pageHostA.evaluate(() => window.__sp27E2eBridge.getHostEpoch());
    assert.strictEqual(hostAPromotedEpoch, 3, `Expected HostA Live Standby Takeover Epoch=3, got ${hostAPromotedEpoch}`);
    await waitForConnectedWithSas(pageClient1, livePages(), 45000);
    await waitForConnectedWithSas(pageClient2, livePages(), 45000);
    console.log('✅ Step 8 passed: Stale HostA fenced, Match 5 merged, and LIVE Standby .btn-takeover-host promoted HostA to Epoch=3.');

    // ========================================================================
    // STEP 9: Bare-Metal Empty HostC (Witness -> Epoch=4) + Teammate Relay + Dual Attack DOM/H2 Proof
    // ========================================================================
    console.log('\n=== Step 9: Empty-DB Bare Metal HostC (Epoch=4) + Teammate Relay + Dual Attack ===');
    manager.assertNoUnexpectedErrors([pageHostA, pageClient2], {
      allowConsolePatterns: [...EXPECTED_OFFLINE_CONSOLE_PATTERNS, /ERR_CONNECTION_REFUSED|WakeLock/i]
    });
    await Promise.all([manager.closeBrowser('hostA'), manager.closeBrowser('client2')]);
    pageHostA = null;
    pageClient2 = null;
    await manager.gracefulStopBackend('hostA');

    await manager.startBackend({ name: 'hostC', port: PORT_HOST_C, tmpDir: dirHostC });
    const launchedC = await manager.launchBrowser({
      name: 'hostC',
      index: 4,
      userDataDir: chromeDirHostC,
      showUi: SHOW_UI,
      initialClockOffsetMs: TWO_HOURS_MS
    });
    pageHostC = launchedC.page;

    await navigatePageWithRetry(pageHostC, URL_HOST_C);
    await robustLogin(pageHostC, hostUser);

    await pageHostC.waitForSelector('.empty-state', { timeout: 10000 });
    await joinEventViaUi(pageHostC, eventCode, livePages());

    const expectedHostCEpoch = hostAPromotedEpoch + 1;
    await waitForCondition(
      async () =>
        await pageHostC.evaluate(
          (minEp) => window.__sp27E2eBridge?.isHostMode?.() === true && (window.__sp27E2eBridge?.getHostEpoch?.() ?? 0) >= minEp,
          expectedHostCEpoch
        ),
      {
        timeoutMs: 30000,
        label: `HostC Epoch=${expectedHostCEpoch} promotion via Client1 Witness discovery`,
        onPoll: () => confirmAnySasModals(livePages())
      }
    );
    const hostCEpoch = await pageHostC.evaluate(() => window.__sp27E2eBridge.getHostEpoch());
    assert.strictEqual(hostCEpoch, expectedHostCEpoch, `Expected HostC Epoch=${expectedHostCEpoch}, got ${hostCEpoch}`);
    await waitForConnectedWithSas(pageClient1, livePages(), 45000);

    await waitForCondition(
      async () => {
        const sc = await pageHostC.evaluate(() => window.__sp27E2eBridge.getNormalizedState());
        return Boolean(
          sc?.scoutingRecords?.some((r) => r.matchNumber === 4 && r.teamNumber === 2222 && r.scoutId === client2Session.id) &&
            sc?.scoutingRecords?.some((r) => r.matchNumber === 5 && r.teamNumber === 27570)
        );
      },
      { timeoutMs: 35000, label: 'Teammate relay recovery of Client2 Match 4 & HostA Match 5 on HostC' }
    );
    await pageHostC.evaluate(async () => {
      await window.__sp27E2eBridge.flushCrdtNow();
    });
    const hostCSession = await getUserSession(pageHostC);
    const db3Records = await fetchBackendJson(PORT_HOST_C, `/api/records?eventId=${eventId}`, hostCSession.token);
    assert.ok(db3Records.some((r) => r.matchNumber === 4 && r.teamNumber === 2222), 'Client2 Match 4 must persist into Temp H2 #3');

    // Dual Forged Relay Attacks from Client1 -> HostC
    await pageClient1.evaluate(async (c2Uid) => {
      await window.__sp27E2eBridge.sendForgedRecordAttacks(c2Uid);
    }, client2Session.id);

    await waitForCondition(
      async () =>
        await pageHostC.evaluate(() => {
          const list = window.__LAST_CRDT_SECURITY_REJECTS__ || [];
          const recReasons = list.flatMap((e) => e.rejectedRecords || []).map((r) => r.reason);
          return recReasons.includes('invalid_author_signature') && recReasons.includes('unbound_author_pubkey');
        }),
      { timeoutMs: 15000, label: 'HostC ECDSA security rejections for Attack 1 & Attack 2' }
    );

    const scAfterAttack = await pageHostC.evaluate(() => window.__sp27E2eBridge.getNormalizedState());
    assert.strictEqual(scAfterAttack.scoutingRecords.some((r) => r.id === 'rec-attack-tampered'), false, 'Attack 1 must not enter HostC CRDT');
    assert.strictEqual(scAfterAttack.scoutingRecords.some((r) => r.id === 'rec-attack-rogue'), false, 'Attack 2 must not enter HostC CRDT');
    await pageHostC.evaluate(async () => {
      await window.__sp27E2eBridge.flushCrdtNow();
    });
    const db3AfterAttack = await fetchBackendJson(PORT_HOST_C, `/api/records?eventId=${eventId}`, hostCSession.token);
    assert.strictEqual(db3AfterAttack.some((r) => r.id === 'rec-attack-tampered' || r.id === 'rec-attack-rogue'), false, 'Forged relay attacks must NOT persist to HostC H2 DB');
    await switchToTab(pageHostC, 'history');
    const hostCAttackDom = await pageHostC.evaluate(() =>
      Array.from(document.querySelectorAll('.history-card')).some((c) => (c.textContent || '').includes('#Q88') || (c.textContent || '').includes('#8888'))
    );
    assert.strictEqual(hostCAttackDom, false, 'Forged Match 88 (#8888) must NOT render in HostC History DOM');
    console.log(`✅ Step 9 passed: Bare-metal HostC restored via Witness (Epoch=${expectedHostCEpoch}), relay & dual attacks verified.`);

    // ========================================================================
    // STEP 10: Real OfflineSyncModal UI Upload, Diverged Merge, Idempotency & 3 Hostile .info Rejections
    // ========================================================================
    console.log('\n=== Step 10: USB OfflineSyncModal File Upload UI, Real Merge & Hostile .info Rejections ===');
    const pkgText = await pageHostC.evaluate(async () => await window.__sp27E2eBridge.exportOfflineSyncPackage());
    const parsedPkg = JSON.parse(pkgText);
    assert.ok(parsedPkg.payload?.crdtSnapshot, 'Exported .info package must contain crdtSnapshot');
    assert.strictEqual(parsedPkg.syncRange?.fromHostSeq, undefined, 'Exported .info syncRange must not contain fromHostSeq');
    assert.strictEqual(parsedPkg.syncRange?.toHostSeq, undefined, 'Exported .info syncRange must not contain toHostSeq');
    assert.strictEqual(parsedPkg.syncRange?.hasCrdtSnapshot, true, 'Exported .info syncRange must set hasCrdtSnapshot=true');
    assert.strictEqual(
      (parsedPkg.payload?.records || []).every((r) => !r.hostSeq),
      true,
      'Exported .info payload records must contain zero hostSeq values'
    );

    await pageHostC.click('.offline-sync-btn');
    await pageHostC.waitForSelector('.offline-sync-modal', { timeout: 10000 });
    const modalUiCheck = await pageHostC.evaluate(() => {
      const hasNumberInput = document.querySelector('.offline-sync-modal input[type="number"]') !== null;
      const filename = document.querySelector('.offline-sync-modal .filename-box code')?.textContent || '';
      return { hasNumberInput, filename };
    });
    assert.strictEqual(modalUiCheck.hasNumberInput, false, 'OfflineSyncModal must not render numeric hostSeq range inputs');
    assert.ok(modalUiCheck.filename.includes('_HOST_to_ALL_r'), `Expected _HOST_to_ALL_r filename format, got "${modalUiCheck.filename}"`);
    assert.strictEqual(modalUiCheck.filename.includes('_v0_to_v'), false, `Filename must not use legacy _v0_to_v format`);
    await pageHostC.click('.offline-sync-modal .btn-close');
    await pageHostC.waitForFunction(() => !document.querySelector('.offline-sync-modal'), { timeout: 5000 });

    // Take Client1 offline -> submit new Match 8 Team 27570 -> export Client1 real CLIENT_PUSH .info -> upload via HostC UI!
    await client1Cdp.send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1
    });
    await pageClient1.evaluate(() => window.__rtcSimulateNetworkDrop?.());
    await waitForCondition(
      () => pageClient1.evaluate(() => !document.querySelector('.connection-status.connected')),
      { timeout: 10000, label: 'Client1 disconnect before diverged USB export' }
    );
    await submitMatchRecordViaUi(pageClient1, { matchNumber: 8, teamNumber: 27570 });
    const c1PushPkgText = await pageClient1.evaluate(async () => await window.__sp27E2eBridge.exportOfflineSyncPackage());
    const c1PushPkg = JSON.parse(c1PushPkgText);
    assert.strictEqual(c1PushPkg.packetType, 'CLIENT_PUSH', 'Client export must be CLIENT_PUSH');

    const hostCRecBeforeUsb = await pageHostC.evaluate(async () => (await window.__sp27E2eBridge.getNormalizedState()).scoutingRecords.length);
    await uploadOfflineSyncFileViaUi(pageHostC, {
      fileName: 'client1_match8_sync.info',
      content: c1PushPkgText
    });

    await waitForCondition(
      async () => {
        const sc = await pageHostC.evaluate(() => window.__sp27E2eBridge.getNormalizedState());
        return Boolean(sc?.scoutingRecords?.some((r) => r.matchNumber === 8 && r.teamNumber === 27570));
      },
      { timeout: 15000, label: 'HostC converges Match 8 from OfflineSyncModal .info upload' }
    );
    await switchToTab(pageHostC, 'history');
    const hostCHasM8Dom = await pageHostC.evaluate(() =>
      Array.from(document.querySelectorAll('.history-card')).some((c) => (c.textContent || '').includes('#Q8'))
    );
    assert.strictEqual(hostCHasM8Dom, true, 'Match 8 imported via OfflineSyncModal UI must appear in HostC History DOM');
    await pageHostC.evaluate(async () => {
      await window.__sp27E2eBridge.flushCrdtNow();
    });
    const db3WithM8 = await fetchBackendJson(PORT_HOST_C, `/api/records?eventId=${eventId}`, hostCSession.token);
    assert.ok(db3WithM8.some((r) => r.matchNumber === 8 && r.teamNumber === 27570), 'Match 8 imported via UI must persist to HostC H2 DB');

    // Re-upload identical Client1 .info via UI -> strictly idempotent
    const hostCRecCountAfterMerge = await pageHostC.evaluate(async () => (await window.__sp27E2eBridge.getNormalizedState()).scoutingRecords.length);
    assert.strictEqual(hostCRecCountAfterMerge, hostCRecBeforeUsb + 1, 'Expected exactly +1 record on diverged USB merge');
    await uploadOfflineSyncFileViaUi(pageHostC, {
      fileName: 'client1_match8_duplicate.info',
      content: c1PushPkgText
    });
    const hostCRecCountAfterRepeat = await pageHostC.evaluate(async () => (await window.__sp27E2eBridge.getNormalizedState()).scoutingRecords.length);
    assert.strictEqual(hostCRecCountAfterRepeat, hostCRecCountAfterMerge, 'Repeated UI .info upload must be strictly idempotent');

    // Upload 3 Hostile .info Packages via HostC UI & assert ALL 3 are rejected!
    const baseHeader = {
      format: 'SCOUTING_PRO_27_SYNC',
      version: 1,
      eventId,
      eventName: parsedPkg.eventName || eventId,
      exportedAt: new Date().toISOString(),
      syncRange: { recordCount: 1, hasCrdtSnapshot: true }
    };
    const forgedOwnerPkg = JSON.stringify({
      ...baseHeader,
      packetType: 'CLIENT_PUSH',
      sender: { userId: client1Session.id, username: client1User, role: 'SCOUT' },
      target: { recipientType: 'HOST' },
      payload: {
        records: [{
          id: 'rec-usb-forged-scout',
          eventId,
          scoutId: client2Session.id,
          scoutName: client2User,
          matchNumber: 77,
          teamNumber: 7777,
          totalScore: 99,
          autoScore: 30,
          teleopScore: 50,
          endgameScore: 19,
          notes: 'forged',
          rawData: '{}',
          version: 1,
          isDeleted: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }]
      }
    });
    const spoofHostBroadcastPkg = JSON.stringify({
      ...baseHeader,
      packetType: 'HOST_BROADCAST',
      sender: { userId: client1Session.id, username: client1User, role: 'HOST' },
      target: { recipientType: 'ALL_SCOUTS' },
      payload: {
        records: [{
          id: 'rec-usb-spoof-host',
          eventId,
          scoutId: client1Session.id,
          scoutName: client1User,
          matchNumber: 78,
          teamNumber: 7878,
          totalScore: 88,
          autoScore: 20,
          teleopScore: 50,
          endgameScore: 18,
          notes: 'spoofHost',
          rawData: '{}',
          version: 1,
          isDeleted: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }]
      }
    });
    const forbiddenTablePkg = JSON.stringify({
      ...baseHeader,
      packetType: 'CLIENT_PUSH',
      sender: { userId: client1Session.id, username: client1User, role: 'SCOUT' },
      target: { recipientType: 'HOST' },
      payload: {
        records: [],
        crdtSnapshot: [[{
          schedules: [{
            'QUALIFICATION_M777': [{
              id: `${eventId}_M777`,
              eventId,
              matchNumber: 777,
              tournamentLevel: 'QUALIFICATION',
              red1: 9191,
              red2: 0,
              blue1: 0,
              blue2: 0,
              isDeleted: false
            }, '', 1]
          }, '', 1]
        }, '', 1], [{}, '', 1]]
      }
    });

    await uploadOfflineSyncFileViaUi(pageHostC, { fileName: 'hostile_forged_scout.info', content: forgedOwnerPkg });
    await uploadOfflineSyncFileViaUi(pageHostC, { fileName: 'hostile_spoof_host.info', content: spoofHostBroadcastPkg });
    await uploadOfflineSyncFileViaUi(pageHostC, { fileName: 'hostile_forbidden_table.info', content: forbiddenTablePkg });

    const hostCStateAfterHostile = await pageHostC.evaluate(() => window.__sp27E2eBridge.getNormalizedState());
    assert.strictEqual(
      hostCStateAfterHostile.scoutingRecords.some((r) => r.id === 'rec-usb-forged-scout' || r.id === 'rec-usb-spoof-host'),
      false,
      'Hostile .info forged/spoofed records must be rejected by HostC'
    );
    assert.strictEqual(
      hostCStateAfterHostile.schedules.some((s) => s.matchNumber === 777),
      false,
      'Hostile client .info containing schedules table must be rejected by HostC'
    );

    // Bring Client1 back online for Step 11 cluster parity check
    await client1Cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1
    });
    await pageClient1.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitForConnectedWithSas(pageClient1, livePages(), 40000);
    manager.assertNoUnexpectedErrors([pageHostC], {
      allowConsolePatterns: [/WakeLock/i]
    });
    manager.assertNoUnexpectedErrors([pageClient1], {
      allowConsolePatterns: [...EXPECTED_OFFLINE_CONSOLE_PATTERNS, /ERR_CONNECTION_REFUSED|WakeLock/i]
    });
    manager.clearPageErrors(livePages());
    console.log('✅ Step 10 passed: OfflineSyncModal UI upload merged Match 8, stayed idempotent, and rejected all 3 hostile .info files.');

    // ========================================================================
    // STEP 11: Full-Cluster State & Visible DOM Parity Audit
    // ========================================================================
    console.log('\n=== Step 11: Cluster-Wide Byte-Level & Visible DOM Convergence Audit ===');
    await manager.startBackend({ name: 'hostB', port: PORT_HOST_B, tmpDir: dirHostB });
    const [reHostB, reClient2] = await Promise.all([
      manager.launchBrowser({
        name: 'hostB',
        index: 1,
        userDataDir: chromeDirHostB,
        showUi: SHOW_UI,
        initialClockOffsetMs: TWO_HOURS_MS
      }),
      manager.launchBrowser({
        name: 'client2',
        index: 3,
        userDataDir: chromeDirClient2,
        showUi: SHOW_UI,
        extraSecureOrigin: clientBaseUrl,
        initialClockOffsetMs: TWO_HOURS_MS
      })
    ]);
    pageHostB = reHostB.page;
    pageClient2 = reClient2.page;

    await Promise.all([
      navigatePageWithRetry(pageHostB, URL_HOST_B).then(async () => {
        await pageHostB.waitForFunction(
          () => Boolean(document.querySelector('#username')) || Boolean(document.querySelector('.dashboard')),
          { timeout: 15000 }
        );
        await pageHostB.waitForFunction(
          () => Boolean(document.querySelector('.dashboard')) || !localStorage.getItem('scoutingpro-user'),
          { timeout: 5000 }
        ).catch(() => {});
        await waitForTransition(pageHostB);
        if (!(await pageHostB.$('.dashboard')) && (await pageHostB.$('#username'))) {
          await robustLogin(pageHostB, hostUser);
        } else {
          await pageHostB.waitForSelector('.dashboard', { timeout: 10000 });
        }
        await enterExistingEventCardViaUi(pageHostB, eventCode);
      }),
      navigatePageWithRetry(pageClient2, urlStaticClient).then(async () => {
        await pageClient2.waitForFunction(
          () => Boolean(document.querySelector('#username')) || Boolean(document.querySelector('.dashboard')),
          { timeout: 15000 }
        );
        await pageClient2.waitForFunction(
          () => Boolean(document.querySelector('.dashboard')) || !localStorage.getItem('scoutingpro-user'),
          { timeout: 5000 }
        ).catch(() => {});
        await waitForTransition(pageClient2);
        if (!(await pageClient2.$('.dashboard')) && (await pageClient2.$('#username'))) {
          await robustLogin(pageClient2, client2User);
          await joinEventViaUi(pageClient2, eventCode, livePages());
        } else {
          await pageClient2.waitForSelector('.dashboard', { timeout: 10000 });
          await enterExistingEventCardViaUi(pageClient2, eventCode);
        }
      })
    ]);

    await Promise.all([
      waitForConnectedWithSas(pageHostB, livePages(), 45000),
      waitForConnectedWithSas(pageClient2, livePages(), 45000)
    ]);

    let finalHostCState;
    let finalClient1State;
    let finalHostBState;
    let finalClient2State;
    await waitForCondition(
      async () => {
        const [sc, s1, sb, s2] = await Promise.all([
          pageHostC.evaluate(() => window.__sp27E2eBridge.getNormalizedState()),
          pageClient1.evaluate(() => window.__sp27E2eBridge.getNormalizedState()),
          pageHostB.evaluate(() => window.__sp27E2eBridge.getNormalizedState()),
          pageClient2.evaluate(() => window.__sp27E2eBridge.getNormalizedState())
        ]);
        const jC = JSON.stringify(sc);
        if (sc && jC === JSON.stringify(s1) && jC === JSON.stringify(sb) && jC === JSON.stringify(s2)) {
          finalHostCState = sc;
          finalClient1State = s1;
          finalHostBState = sb;
          finalClient2State = s2;
          return true;
        }
        return false;
      },
      {
        timeoutMs: 45000,
        intervalMs: 400,
        label: 'byte-level cluster convergence across HostC, Client1, HostB, Client2',
        onPoll: () => confirmAnySasModals(livePages())
      }
    );

    assert.deepStrictEqual(finalClient1State, finalHostCState, 'Client1 normalized state diverges from HostC');
    assert.deepStrictEqual(finalHostBState, finalHostCState, 'HostB normalized state diverges from HostC');
    assert.deepStrictEqual(finalClient2State, finalHostCState, 'Client2 normalized state diverges from HostC');

    // Visible DOM parity check (History card count + Rankings team order) across HostC & Client1
    await Promise.all([switchToTab(pageHostC, 'history'), switchToTab(pageClient1, 'history')]);
    await Promise.all([
      pageHostC.waitForSelector('.history-card', { timeout: 10000 }),
      pageClient1.waitForSelector('.history-card', { timeout: 10000 })
    ]);
    const [hCardCountC, hCardCount1] = await Promise.all([
      pageHostC.$$eval('.history-card', (els) => els.length),
      pageClient1.$$eval('.history-card', (els) => els.length)
    ]);
    const expectedActiveCount = finalHostCState.scoutingRecords.filter((r) => !r.isDeleted).length;
    const expectedClient1OwnCount = finalClient1State.scoutingRecords.filter(
      (r) => !r.isDeleted && r.scoutId === client1Session.id
    ).length;
    assert.strictEqual(hCardCountC, expectedActiveCount, `HostC visible History cards (${hCardCountC}) != active records (${expectedActiveCount})`);
    assert.strictEqual(hCardCount1, expectedClient1OwnCount, `Client1 visible History cards (${hCardCount1}) != own active records (${expectedClient1OwnCount})`);

    await Promise.all([switchToTab(pageHostC, 'rankings'), switchToTab(pageClient1, 'rankings')]);
    await Promise.all([
      pageHostC.waitForSelector('.rankings-panel .team-num', { timeout: 10000 }),
      pageClient1.waitForSelector('.rankings-panel .team-num', { timeout: 10000 })
    ]);
    const [ranksC, ranks1] = await Promise.all([
      pageHostC.$$eval('.rankings-panel .team-num', (els) => els.map((e) => (e.textContent || '').trim())),
      pageClient1.$$eval('.rankings-panel .team-num', (els) => els.map((e) => (e.textContent || '').trim()))
    ]);
    assert.ok(ranksC.length >= 4, `Expected >=4 ranked teams on HostC, got ${ranksC.length}`);
    assert.deepStrictEqual(ranks1, ranksC, `Client1 visible Rankings (${ranks1}) diverges from HostC (${ranksC})`);

    for (const [label, pg] of [['HostC', pageHostC], ['Client1', pageClient1], ['HostB', pageHostB], ['Client2', pageClient2]]) {
      const audit = await pg.evaluate(() => {
        const recs = JSON.parse(localStorage.getItem('scoutingpro_records') || '[]');
        const hasHostSeq = recs.some((r) => ('hostSeq' in r && r.hostSeq !== undefined) || Boolean(r.hostSeq));
        const hasLegacySeqKey = Object.keys(localStorage).some((k) => k.startsWith('sp27_lastHostSeq_'));
        const hasLegacyEpochKey = Object.keys(localStorage).some((k) => k === 'scoutingpro_host_epoch');
        return { count: recs.length, hasHostSeq, hasLegacySeqKey, hasLegacyEpochKey };
      });
      assert.ok(audit.count > 0, `${label} must retain synced records in localStorage`);
      assert.strictEqual(audit.hasHostSeq, false, `${label} must contain zero hostSeq properties in Step 11`);
      assert.strictEqual(audit.hasLegacySeqKey, false, `${label} must contain zero sp27_lastHostSeq_* keys in Step 11`);
      assert.strictEqual(audit.hasLegacyEpochKey, false, `${label} must contain zero legacy scoutingpro_host_epoch keys`);
    }

    manager.assertNoUnexpectedErrors([pageHostC, pageHostB], {
      allowConsolePatterns: [/WakeLock/i]
    });
    manager.assertNoUnexpectedErrors([pageClient1, pageClient2], {
      allowConsolePatterns: [...EXPECTED_OFFLINE_CONSOLE_PATTERNS, /WakeLock/i]
    });
    console.log(
      `✅ Step 11 passed: 100% state + visible DOM parity across all 4 live nodes (${finalHostCState.scoutingRecords.length} match records, ${finalHostCState.pitRecords.length} pit records, ${finalHostCState.teamTags.length} tags, ${finalHostCState.assignments.length} assignments).`
    );

    // ========================================================================
    // STEP 12: Automated Cleanup & Strong Temp-H2 Deletion Assertion
    // ========================================================================
    console.log('\n=== Step 12: Temp H2 Auto-Deletion & Root DB Non-Pollution Assertions ===');
    await manager.cleanupAll({ assertDeleted: true });
    for (const base of rootDbBaselines) {
      assert.deepStrictEqual(
        snapshotFileStat(base.path),
        base.stat,
        `Root DB file was modified/created during E2E test: ${base.path}`
      );
    }
    console.log('✅ Step 12 passed: Zero leftover temp H2/chrome dirs and root DB untouched.');
  } catch (err) {
    console.error('\n❌ E2E Disaster-Recovery Suite FAILED:', err);
    process.exitCode = 1;
  } finally {
    await manager.cleanupAll({ assertDeleted: !process.exitCode }).catch((cleanupErr) => {
      console.error('❌ Cleanup error:', cleanupErr);
      process.exitCode = 1;
    });
    process.removeListener('SIGINT', signalHandler);
    process.removeListener('SIGTERM', signalHandler);
    process.exit(process.exitCode || 0);
  }
}

runTest();
