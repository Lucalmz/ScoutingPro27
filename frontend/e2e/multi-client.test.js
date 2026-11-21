import assert from 'assert';
import { execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import mqtt from 'mqtt';
import { E2EClusterManager, REPO_ROOT, delay } from './helpers/e2eBackendManager.js';
import {
  createEventViaUi,
  editOwnMatchTeamViaHistoryUi,
  enterExistingEventCardViaUi,
  fetchBackendJson,
  joinEventViaUi,
  logoutViaUi,
  navigatePageWithRetry,
  robustLogin,
  setPageClockOffset,
  submitMatchRecordViaUi,
  switchToTab,
  waitForCondition,
  waitForConnectedWithSas,
  waitForTransition
} from './helpers/e2eUiActions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SHOW_UI = process.env.SHOW_UI === '1';

const PORT_HOST_A = 7071;
const PORT_HOST_B = 7072;
const PORT_HOST_C = 7073;
const PORT_STATIC_CLIENT = 7079;

const URL_HOST_A = `http://localhost:${PORT_HOST_A}/index.html`;
const URL_HOST_B = `http://localhost:${PORT_HOST_B}/index.html`;
const URL_HOST_C = `http://localhost:${PORT_HOST_C}/index.html`;

const TEN_YEARS_MS = 10 * 365 * 24 * 3600 * 1000;
const ONE_YEAR_MS = 365 * 24 * 3600 * 1000;
const TWO_HOURS_MS = 2 * 3600 * 1000;

function snapshotFileStat(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false };
  const s = fs.statSync(filePath);
  return { exists: true, size: s.size, mtimeMs: s.mtimeMs };
}

async function waitForServiceWorkerControl(page) {
  await page
    .evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      try {
        await navigator.serviceWorker.ready;
        const deadline = Date.now() + 6000;
        while (!navigator.serviceWorker.controller && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 150));
        }
        return Boolean(navigator.serviceWorker.controller);
      } catch {
        return false;
      }
    })
    .catch(() => false);
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
    const clientBaseUrl = await manager.startStaticClientServer(PORT_STATIC_CLIENT, '127.0.0.2');
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
        await waitForServiceWorkerControl(pageClient1);
        await robustLogin(pageClient1, client1User);
      }),
      pageClient2.goto(urlStaticClient, { waitUntil: 'domcontentloaded' }).then(async () => {
        await waitForServiceWorkerControl(pageClient2);
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
    console.log('✅ Step 1 passed: All 4 nodes connected, SAS verified, and calibrated.');

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
    console.log('✅ Step 2 passed: Pure derived conflict badges appeared on all active nodes.');

    // ========================================================================
    // STEP 3: Anti-Clock-Poisoning Double Kill (+10y/-1y Date.now + 2036 HLC packet)
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

    // Wait for Pit #27570 baseline (`weightLbs: 28, launcherType: 'Drum'`) to replicate to Client2 & HostB before Step 6!
    await waitForCondition(
      async () => {
        const s2 = await pageClient2.evaluate(() => window.__sp27E2eBridge.getNormalizedState());
        const sb = await pageHostB.evaluate(() => window.__sp27E2eBridge.getNormalizedState());
        return (
          s2?.pitRecords?.some((p) => p.teamNumber === 27570 && p.robotName === 'ClockTestPlus10Yr') &&
          sb?.pitRecords?.some((p) => p.teamNumber === 27570 && p.robotName === 'ClockTestPlus10Yr')
        );
      },
      { timeoutMs: 20000, label: 'Pit #27570 baseline replication across Client2 and HostB' }
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
    console.log('✅ Step 3 passed: System clock spoofing ignored & 2036 packet intercepted + FORCE_CLOCK_RESYNC verified.');

    // ========================================================================
    // STEP 4: Baseline Offline Direct Messaging Outbox & Online Delivery
    // ========================================================================
    console.log('\n=== Step 4: Offline Outbox Queuing & Reconnect Flush ===');
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

    const offlineDmStatus = await pageHostA.evaluate(async (targetId) => {
      const item = await window.__sendDirectMessage?.(targetId, 'Offline Strategy Briefing', 'Prepare for Auto Zone B');
      return item?.status || null;
    }, client1Session.id);
    assert.strictEqual(offlineDmStatus, 'PENDING_DELIVERY', `Expected PENDING_DELIVERY, got ${offlineDmStatus}`);

    await client1Cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1
    });
    await waitForConnectedWithSas(pageClient1, livePages(), 40000);

    await waitForCondition(
      async () => {
        const hostStatus = await pageHostA.evaluate((targetId) => {
          const u = JSON.parse(localStorage.getItem('scoutingpro-user') || '{}');
          const outbox = JSON.parse(localStorage.getItem(`inbox-outbox-${u.id}`) || '[]');
          return outbox.find((i) => i.targetId === targetId && i.title === 'Offline Strategy Briefing')?.status || null;
        }, client1Session.id);
        const arrived = await pageClient1.evaluate((uid) => {
          const msgs = JSON.parse(localStorage.getItem(`inbox-messages-${uid}`) || '[]');
          return msgs.some((m) => m.title === 'Offline Strategy Briefing');
        }, client1Session.id);
        return hostStatus === 'DELIVERED' && arrived;
      },
      { timeoutMs: 20000, label: 'Offline DM flush & arrival on Client1' }
    );

    const onlineDmOk = await pageHostA.evaluate(async (targetId) => {
      const item = await window.__sendDirectMessage?.(targetId, 'Match 2 Strategy', 'Cover Auto zone right');
      return item?.status === 'DELIVERED';
    }, client1Session.id);
    assert.strictEqual(onlineDmOk, true, 'Online direct message should send cleanly');
    console.log('✅ Step 4 passed: Offline Outbox auto-flushed and online DM delivered.');

    // ========================================================================
    // STEP 5: Baseline Signaling Hard Boundary, HMAC Tamper & Anti-DoS Hijack Defense
    // ========================================================================
    console.log('\n=== Step 5: MQTT Signaling Boundary, HMAC Tamper & Anti-DoS ===');
    const topicHash = crypto.createHash('sha256').update(eventCode + '-scoutingpro27').digest('hex');
    const signalTopic = `scoutingpro27/signal/${topicHash}`;

    const mqttAttack1 = manager.registerMqttClient(
      mqtt.connect(mqttBrokerUrl, {
        clientId: `attacker-inj-${runId}`,
        clean: true,
        connectTimeout: 4000
      })
    );
    await new Promise((resolve) => {
      mqttAttack1.on('connect', () => {
        mqttAttack1.publish(
          signalTopic,
          JSON.stringify({
            type: 'SYNC_DATA',
            sender: 'attacker_peer',
            records: [{ id: 'injected-fake-uuid-999', matchNumber: 99, teamNumber: 1111, totalScore: 999 }]
          }),
          {},
          () => resolve()
        );
      });
      mqttAttack1.on('error', () => resolve());
    });
    await delay(1000);
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
    await new Promise((resolve) => {
      mqttAttack2.on('connect', () => {
        mqttAttack2.publish(
          signalTopic,
          JSON.stringify({
            type: 'offer',
            sender: 'attacker_tamper',
            offer: { type: 'offer', sdp: 'fake_tampered_sdp' },
            signature: '0'.repeat(64),
            timestamp: Date.now(),
            nonce: `nonce_${runId}`
          }),
          {},
          () => resolve()
        );
      });
      mqttAttack2.on('error', () => resolve());
    });
    await delay(800);
    mqttAttack2.end();

    const hostConnectedAfterHmac = await pageHostA.evaluate(() =>
      Boolean(document.querySelector('.connection-status.connected'))
    );
    assert.strictEqual(hostConnectedAfterHmac, true, 'HostA must stay connected after forged HMAC attack');

    // Valid-HMAC room-member sender hijacking attempt + HostA JWT verification check
    const mqttAttack3 = manager.registerMqttClient(
      mqtt.connect(mqttBrokerUrl, {
        clientId: `attacker-dos-${runId}`,
        clean: true,
        connectTimeout: 4000
      })
    );
    await new Promise((resolve) => {
      mqttAttack3.on('connect', () => {
        const spoofEnvelope = {
          type: 'offer',
          sender: 'sp27-spoofed-client1-id',
          clientSessionId: `sess_dos_${runId}`,
          offer: { type: 'offer', sdp: 'spoofed_sdp' },
          timestamp: Date.now(),
          nonce: `nonce_spoof_${runId}`
        };
        const sortedKeys = Object.keys(spoofEnvelope).sort();
        const canonicalObj = {};
        for (const k of sortedKeys) canonicalObj[k] = spoofEnvelope[k];
        const derivedKey = crypto.pbkdf2Sync(eventCode, 'scoutingpro27', 100000, 32, 'sha256');
        spoofEnvelope.signature = crypto.createHmac('sha256', derivedKey).update(JSON.stringify(canonicalObj)).digest('hex');
        mqttAttack3.publish(signalTopic, JSON.stringify(spoofEnvelope), {}, () => resolve());
      });
      mqttAttack3.on('error', () => resolve());
    });
    await delay(1000);
    mqttAttack3.end();

    const verifyHostJwtRes = await pageHostA.evaluate(async (token) => {
      const resp = await fetch('/api/user/verify-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      return await resp.json();
    }, hostASession.token);
    assert.strictEqual(verifyHostJwtRes.valid, true, 'HostA verify-token check should validate real HostA JWT');
    const c1ConnectedAfterDos = await pageClient1.evaluate(() => Boolean(document.querySelector('.connection-status.connected')));
    assert.strictEqual(c1ConnectedAfterDos, true, 'Client1 must remain stably connected after Anti-DoS test');
    console.log('✅ Step 5 passed: MQTT signaling boundary, HMAC tamper & Anti-DoS sender hijack protection verified.');

    // ========================================================================
    // STEP 6: HostA Hard Crash + 2h Offline Window + Multi-Client Concurrent Field Edits
    // ========================================================================
    console.log('\n=== Step 6: HostA Hard Crash + 2h Offline Window + Concurrent Field Edits ===');
    // Isolate HostB, Client1, Client2 BEFORE HostA submits exclusive Match 5
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

    // Verify peers did NOT receive exclusive Match 5 before HostA dies
    const preCrashC1 = await pageClient1.evaluate(() => window.__sp27E2eBridge.getNormalizedState());
    assert.strictEqual(preCrashC1.scoutingRecords.some((r) => r.matchNumber === 5), false, 'Client1 must NOT have unbroadcasted Match 5');

    // 💥 Hard-kill HostA backend process & close browserHostA without graceful handoff
    await manager.hardKillBackend('hostA');
    await manager.closeBrowser('hostA', { gracefulDisconnect: false });
    pageHostA = null;

    // Advance logical test clock +2 hours on Client1, Client2, HostB
    await Promise.all([
      setPageClockOffset(pageClient1, TWO_HOURS_MS),
      setPageClockOffset(pageClient2, TWO_HOURS_MS),
      setPageClockOffset(pageHostB, TWO_HOURS_MS)
    ]);

    // Client1 2h offline work + full offline page.reload()
    await editOwnMatchTeamViaHistoryUi(pageClient1, 8888, 1);
    await submitMatchRecordViaUi(pageClient1, { matchNumber: 2, teamNumber: 27570 });
    await submitMatchRecordViaUi(pageClient1, { matchNumber: 3, teamNumber: 1234 });
    await pageClient1.evaluate(async () => {
      await window.__sp27E2eBridge.updatePitFields(27570, { weightLbs: 31.5 });
      await window.__sp27E2eBridge.flushCrdtNow();
    });
    await delay(300);

    // Offline reload via PWA Service Worker cache while client1Cdp offline=true!
    await pageClient1.reload({ waitUntil: 'domcontentloaded' });
    await pageClient1.waitForFunction(() => Boolean(window.__sp27E2eBridge?.getNormalizedState), { timeout: 20000 });
    const c1AfterReloadState = await pageClient1.evaluate(() => window.__sp27E2eBridge.getNormalizedState());
    assert.ok(
      c1AfterReloadState.scoutingRecords.some((r) => r.matchNumber === 3 && r.teamNumber === 1234),
      'Client1 offline Match 3 must survive full offline page.reload()'
    );
    assert.strictEqual(
      c1AfterReloadState.pitRecords.find((p) => p.teamNumber === 27570)?.weightLbs,
      31.5,
      'Client1 Pit #27570 weightLbs=31.5 must survive offline page.reload()'
    );

    // Client2 2h offline work: Match 1->7777, Match 2 & 4, Pit launcherType + photoKey, add & soft-delete tag
    await editOwnMatchTeamViaHistoryUi(pageClient2, 7777, 1);
    await submitMatchRecordViaUi(pageClient2, { matchNumber: 2, teamNumber: 1111 });
    await submitMatchRecordViaUi(pageClient2, { matchNumber: 4, teamNumber: 2222 });
    await pageClient2.evaluate(async () => {
      await window.__sp27E2eBridge.updatePitFields(27570, {
        launcherType: 'Turret',
        photoKeys: ['pit_27570_turret_angle1.jpg']
      });
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
    console.log('✅ Step 6 passed: HostA killed, +2h offline edits persisted & Bob logged out cleanly.');

    // ========================================================================
    // STEP 7: Shared-DB Computer B Account Switch (Zero Invite Code -> Epoch = 2)
    // ========================================================================
    console.log('\n=== Step 7: Shared-DB Computer B Direct Dashboard Takeover (Epoch=2) ===');
    await robustLogin(pageHostB, hostUser);

    // Assert Dashboard shows existing authoritative event card directly (no invite code needed),
    // then restore Client1 & Client2 online BEFORE entering so HostB 1.5s probe receives live EPOCH_WITNESS
    await pageHostB.waitForFunction(
      (code) =>
        Array.from(document.querySelectorAll('.event-card')).some((c) =>
          (c.textContent || '').toUpperCase().includes(code.toUpperCase())
        ),
      { timeout: 15000 },
      eventCode
    );
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

    await enterExistingEventCardViaUi(pageHostB, eventCode);

    await waitForCondition(
      async () =>
        await pageHostB.evaluate(
          () => window.__sp27E2eBridge?.isHostMode?.() === true && window.__sp27E2eBridge?.getHostEpoch?.() >= 2
        ),
      {
        timeoutMs: 25000,
        label: 'HostB promotion to Epoch=2',
        onPoll: async () => {
          const pages = livePages();
          for (const p of pages) {
            await p
              .evaluate(() => {
                document.querySelector('.sas-modal-overlay .btn-success')?.click();
              })
              .catch(() => {});
          }
        }
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
            pit.photoKeys.includes('pit_27570_turret_angle1.jpg');
          const hasTags =
            st.teamTags.some((t) => t.teamNumber === 27570 && t.tag === 'strong-auto') &&
            !st.teamTags.some((t) => t.teamNumber === 27570 && t.tag === 'fragile-intake');
          const hasBobAssign = st.assignments.some(
            (a) => a.matchNumber === 10 && a.station === 'red1' && a.scoutId === bobSession.id
          );
          const hasBobMatch6 = st.scoutingRecords.some((r) => r.matchNumber === 6 && r.scoutId === bobSession.id);
          const hasC1Match3 = st.scoutingRecords.some((r) => r.matchNumber === 3 && r.teamNumber === 1234);
          const hasC2Match4 = st.scoutingRecords.some((r) => r.matchNumber === 4 && r.teamNumber === 2222);
          return Boolean(hasPitMerge && hasTags && hasBobAssign && hasBobMatch6 && hasC1Match3 && hasC2Match4 && st.conflicts.length === 0);
        };
        return checkNode(sb) && checkNode(s1) && checkNode(s2);
      },
      { timeoutMs: 45000, label: 'Step 7 full convergence across HostB, Client1, Client2' }
    );

    // Also flush HostB & verify Temp H2 #2 relational projections!
    await pageHostB.evaluate(async () => {
      await window.__sp27E2eBridge.flushCrdtNow();
    });
    const hostBSession = await getUserSession(pageHostB);
    const db2Records = await fetchBackendJson(PORT_HOST_B, `/api/records?eventId=${eventId}`, hostBSession.token);
    assert.ok(db2Records.some((r) => r.matchNumber === 6 && r.scoutId === bobSession.id), 'Bob Match 6 must project into Temp H2 #2');
    assert.ok(db2Records.some((r) => r.matchNumber === 4 && r.teamNumber === 2222), 'Client2 Match 4 must project into Temp H2 #2');
    console.log('✅ Step 7 passed: HostB direct takeover (Epoch=2), concurrent Pit field/set merge, Bob Match 6 & 10 preserved, Match 1 conflict cleared.');

    // ========================================================================
    // STEP 8: Extreme Split-Brain Fencing (Stale HostA Epoch=1 -> Standby + Match 5 Merge)
    // ========================================================================
    console.log('\n=== Step 8: Stale HostA Revival (Epoch=1) Fencing & Exclusive Match 5 Merge ===');
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
    if (await pageHostA.$('#username')) {
      await robustLogin(pageHostA, hostUser);
    }
    await enterExistingEventCardViaUi(pageHostA, eventCode);

    // Assert HostA auto-fences from Epoch=2 and demotes to Standby Client
    await waitForCondition(
      async () =>
        await pageHostA.evaluate(
          () =>
            window.__sp27E2eBridge?.isHostMode?.() === false &&
            window.__sp27E2eBridge?.isStandbyHost?.() === true &&
            document.querySelector('.connection-status.connected') !== null
        ),
      {
        timeoutMs: 35000,
        intervalMs: 250,
        label: 'Stale HostA Epoch=1 demoted to connected Standby Client',
        onPoll: () => confirmAnySasModals(livePages())
      }
    );

    // Assert dead HostA's exclusive Match 5 Team 27570 merges losslessly to HostB, Client1, Client2!
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
    console.log('✅ Step 8 passed: Stale Epoch=1 HostA fenced & demoted, Match 5 merged losslessly.');

    // ========================================================================
    // STEP 9: Fallback Bare-Metal Empty HostC (Invite Code -> Epoch=3) + Teammate Relay + Dual Attack
    // ========================================================================
    console.log('\n=== Step 9: Empty-DB Bare Metal HostC (Epoch=3) + Teammate Relay + Dual Attack ===');
    // Take down HostA, HostB, and Client2, leaving ONLY Client1 online
    await Promise.all([manager.closeBrowser('hostA'), manager.closeBrowser('hostB'), manager.closeBrowser('client2')]);
    pageHostA = null;
    pageHostB = null;
    pageClient2 = null;
    await Promise.all([manager.gracefulStopBackend('hostA'), manager.gracefulStopBackend('hostB')]);

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

    // Assert Dashboard is empty on fresh HostC (Temp H2 #3 has 0 events)
    await pageHostC.waitForSelector('.empty-state', { timeout: 10000 });
    await joinEventViaUi(pageHostC, eventCode, livePages());

    // Wait for HostC promotion to Epoch=3 and Client1 reconnection
    await waitForCondition(
      async () =>
        await pageHostC.evaluate(
          () => window.__sp27E2eBridge?.isHostMode?.() === true && window.__sp27E2eBridge?.getHostEpoch?.() >= 3
        ),
      {
        timeoutMs: 30000,
        label: 'HostC Epoch=3 promotion via Client1 Witness discovery',
        onPoll: () => confirmAnySasModals(livePages())
      }
    );
    const hostCEpoch = await pageHostC.evaluate(() => window.__sp27E2eBridge.getHostEpoch());
    assert.strictEqual(hostCEpoch, 3, `Expected HostC Epoch=3, got ${hostCEpoch}`);
    await waitForConnectedWithSas(pageClient1, livePages(), 45000);

    // Assert Client2's signed historical Match 4 (team 2222) recovered into empty HostC via Client1 relay!
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

    // Fire Dual Forged Relay Attacks from Client1 -> HostC
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
    assert.strictEqual(scAfterAttack.scoutingRecords.some((r) => r.id === 'rec-attack-tampered'), false, 'Attack 1 tampered record must not enter HostC');
    assert.strictEqual(scAfterAttack.scoutingRecords.some((r) => r.id === 'rec-attack-rogue'), false, 'Attack 2 rogue record must not enter HostC');
    console.log('✅ Step 9 passed: Bare-metal HostC restored via Witness (Epoch=3), Client2 Match 4 recovered via Client1 relay, dual attacks rejected.');

    // ========================================================================
    // STEP 10: USB Offline .info Package CRDT Merge Idempotency
    // ========================================================================
    console.log('\n=== Step 10: USB Offline .info CRDT Idempotent Merge ===');
    const pkgText = await pageHostC.evaluate(async () => await window.__sp27E2eBridge.exportOfflineSyncPackage());
    const parsedPkg = JSON.parse(pkgText);
    assert.ok(parsedPkg.payload?.crdtSnapshot, 'Exported .info package must contain crdtSnapshot');

    const c1StateBeforeUsb = await pageClient1.evaluate(() => window.__sp27E2eBridge.getNormalizedState());
    await pageClient1.evaluate(async (txt) => {
      await window.__sp27E2eBridge.importOfflineSyncPackage(txt, 'e2e_crdt.info');
    }, pkgText);
    const c1StateAfterUsb1 = await pageClient1.evaluate(() => window.__sp27E2eBridge.getNormalizedState());
    await pageClient1.evaluate(async (txt) => {
      await window.__sp27E2eBridge.importOfflineSyncPackage(txt, 'e2e_crdt.info');
    }, pkgText);
    const c1StateAfterUsb2 = await pageClient1.evaluate(() => window.__sp27E2eBridge.getNormalizedState());

    assert.deepStrictEqual(c1StateAfterUsb1, c1StateBeforeUsb, '1st .info import must converge cleanly without duplicating rows');
    assert.deepStrictEqual(c1StateAfterUsb2, c1StateAfterUsb1, '2nd repeated .info import must be strictly idempotent');
    console.log('✅ Step 10 passed: Repeated USB .info CRDT import is 100% idempotent.');

    // ========================================================================
    // STEP 11: Full-Cluster Byte-Level State Equality Audit (HostC, Client1, HostB, Client2)
    // ========================================================================
    console.log('\n=== Step 11: Cluster-Wide Byte-Level Convergence Audit ===');
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
        if (await pageHostB.$('#username')) {
          await robustLogin(pageHostB, hostUser);
        }
        await enterExistingEventCardViaUi(pageHostB, eventCode);
      }),
      navigatePageWithRetry(pageClient2, urlStaticClient).then(async () => {
        await pageClient2.waitForFunction(
          () => Boolean(document.querySelector('#username')) || Boolean(document.querySelector('.dashboard')),
          { timeout: 15000 }
        );
        if (await pageClient2.$('#username')) {
          await robustLogin(pageClient2, client2User);
          await joinEventViaUi(pageClient2, eventCode, livePages());
        } else {
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
    console.log(
      `✅ Step 11 passed: 100% identical state across all 4 live nodes (${finalHostCState.scoutingRecords.length} match records, ${finalHostCState.pitRecords.length} pit records, ${finalHostCState.teamTags.length} tags, ${finalHostCState.assignments.length} assignments).`
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
