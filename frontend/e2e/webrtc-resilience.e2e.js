import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import mqtt from 'mqtt';
import { E2EClusterManager, REPO_ROOT, allocateFreePort, delay, ensureE2eBuildArtifacts } from './helpers/e2eBackendManager.js';
import {
  createEventViaUi,
  fetchBackendJson,
  joinEventViaUi,
  navigatePageWithRetry,
  robustLogin,
  switchToTab,
  waitForCondition,
  waitForConnectedWithSas
} from './helpers/e2eUiActions.js';

const SHOW_UI = process.env.SHOW_UI === '1';

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

function snapshotFileStat(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false };
  const s = fs.statSync(filePath);
  return { exists: true, size: s.size, mtimeMs: s.mtimeMs };
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

function attachConsoleRecorder(page, bucket) {
  page.on('console', (msg) => {
    bucket.push({
      type: msg.type(),
      text: msg.text(),
      ts: Date.now()
    });
  });
}

async function installRemoteIceCandidateObserver(page) {
  await page.evaluateOnNewDocument(() => {
    const proto = window.RTCPeerConnection && window.RTCPeerConnection.prototype;
    if (!proto || !proto.addIceCandidate || proto.addIceCandidate.__sp27Observed) {
      return;
    }
    window.__sp27AddedRemoteIceCandidates = [];
    const origAddIceCandidate = proto.addIceCandidate;
    const wrapped = function (candidateInit) {
      try {
        if (candidateInit && typeof candidateInit.candidate === 'string') {
          window.__sp27AddedRemoteIceCandidates.push(candidateInit.candidate);
        }
      } catch {}
      return origAddIceCandidate.apply(this, arguments);
    };
    wrapped.__sp27Observed = true;
    proto.addIceCandidate = wrapped;
  });
}

async function submitLargeMatchRecordViaUi(page, { matchNumber, teamNumber, alliance = 'Blue', notes, expectedCount }) {
  await page.waitForSelector('input[placeholder="1-999"]', { timeout: 10000 });
  await page.waitForSelector('textarea.notes-input', { timeout: 10000 });
  await page.waitForFunction(() => {
    const btn = document.querySelector('.btn-submit');
    return Boolean(btn && !btn.disabled);
  }, { timeout: 10000 });

  await page.evaluate(
    ({ mNum, tNum, targetAlliance, noteText }) => {
      const inputs = document.querySelectorAll('input[inputmode="numeric"]');
      if (inputs.length < 2) {
        throw new Error(`Expected >= 2 numeric inputs on ScoutingForm, got ${inputs.length}`);
      }
      inputs[0].value = String(mNum);
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[1].value = String(tNum);
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }));

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

      const notesEl = document.querySelector('textarea.notes-input');
      if (!notesEl) {
        throw new Error('textarea.notes-input not found on ScoutingForm');
      }
      notesEl.value = noteText;
      notesEl.dispatchEvent(new Event('input', { bubbles: true }));
    },
    { mNum: matchNumber, tNum: teamNumber, targetAlliance: alliance, noteText: notes }
  );

  await page.click('.btn-submit');
  await waitForCondition(
    async () =>
      await page.evaluate(async (minCount) => {
        const err = document.querySelector('.submit-status-msg.error');
        if (err) {
          throw new Error(`UI submission error: ${(err.textContent || '').trim()}`);
        }
        const st = await window.__sp27E2eBridge?.getNormalizedState?.();
        return Boolean(st && st.scoutingRecords.filter((r) => !r.isDeleted).length >= minCount);
      }, expectedCount),
    { timeoutMs: 10000, intervalMs: 50, label: `CRDT record #${expectedCount} (match ${matchNumber})` }
  );
}

async function publishSignedSignalEnvelope(mqttBrokerUrl, manager, eventCode, envelope) {
  const topicHash = crypto.createHash('sha256').update(eventCode + '-scoutingpro27').digest('hex');
  const signalTopic = `scoutingpro27/signal/${topicHash}`;
  const client = manager.registerMqttClient(
    mqtt.connect(mqttBrokerUrl, {
      clientId: `resilience-sig-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      clean: true,
      connectTimeout: 5000
    })
  );

  const fullEnvelope = {
    ...envelope,
    timestamp: Date.now(),
    nonce: `nonce_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  };
  const canonicalObj = {};
  for (const k of Object.keys(fullEnvelope).sort()) {
    canonicalObj[k] = fullEnvelope[k];
  }
  const derivedKey = crypto.pbkdf2Sync(eventCode, 'scoutingpro27', 100000, 32, 'sha256');
  fullEnvelope.signature = crypto.createHmac('sha256', derivedKey).update(JSON.stringify(canonicalObj)).digest('hex');

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MQTT publish timeout on ${signalTopic}`)), 6000);
    client.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    const doPublish = () => {
      client.publish(signalTopic, JSON.stringify(fullEnvelope), {}, (err) => {
        clearTimeout(timer);
        if (err) return reject(err);
        resolve();
      });
    };
    if (client.connected) doPublish();
    else client.once('connect', doPublish);
  });

  client.end();
}

function parseCandidateTypePref(candidateStr) {
  const clean = String(candidateStr || '')
    .trim()
    .replace(/^a=/, '')
    .replace(/^candidate:/, '')
    .trim();
  const parts = clean.split(/\s+/);
  if (parts.length < 8) return null;
  const prio = Number.parseInt(parts[3] || '0', 10);
  const ip = parts[4] || '';
  const port = Number.parseInt(parts[5] || '0', 10);
  return {
    foundation: parts[0] || '',
    priority: prio,
    typePref: Math.floor(prio / 16777216),
    ip,
    port,
    raw: candidateStr
  };
}

async function runResilienceE2ETest() {
  ensureE2eBuildArtifacts();

  const rootDbPaths = [
    path.join(REPO_ROOT, 'app_data.mv.db'),
    path.join(REPO_ROOT, 'Backend', 'app_data.mv.db')
  ];
  const rootDbBaselines = rootDbPaths.map((p) => ({ path: p, stat: snapshotFileStat(p) }));

  const runId = Date.now();
  const manager = new E2EClusterManager(runId);

  const signalHandler = async (sig) => {
    console.warn(`\n[Resilience E2E] Caught ${sig}; running cleanup...`);
    await manager.cleanupAll({ assertDeleted: false }).catch(() => {});
    process.exit(1);
  };
  process.on('SIGINT', signalHandler);
  process.on('SIGTERM', signalHandler);

  const dirHostA = manager.createTempDir('resilience-hostA');
  const chromeDirHostA = manager.createTempDir('resilience-chrome-hostA');
  const chromeDirClient1 = manager.createTempDir('resilience-chrome-client1');

  let pageHostA = null;
  let pageClient1 = null;
  let client1Cdp = null;

  const hostLogs = [];
  const clientLogs = [];
  const livePages = () => [pageHostA, pageClient1].filter((p) => p && !p.isClosed());

  try {
    const portHostA = await allocateFreePort();
    const urlHostA = `http://localhost:${portHostA}/index.html`;
    const mqttBrokerUrl = await manager.startLocalMqttBroker();
    const clientBaseUrl = await manager.startStaticClientServer(0, '127.0.0.2');
    const urlStaticClient = `${clientBaseUrl}/index.html`;

    await manager.startBackend({ name: 'hostA', port: portHostA, tmpDir: dirHostA });

    const [hostLaunch, clientLaunch] = await Promise.all([
      manager.launchBrowser({ name: 'hostA', index: 0, userDataDir: chromeDirHostA, showUi: SHOW_UI }),
      manager.launchBrowser({
        name: 'client1',
        index: 1,
        userDataDir: chromeDirClient1,
        showUi: SHOW_UI,
        extraSecureOrigin: clientBaseUrl
      })
    ]);

    pageHostA = hostLaunch.page;
    pageClient1 = clientLaunch.page;

    attachConsoleRecorder(pageHostA, hostLogs);
    attachConsoleRecorder(pageClient1, clientLogs);
    await installRemoteIceCandidateObserver(pageClient1);

    const hostUser = `ResHost_${runId}`;
    const client1User = `ResClient_${runId}`;

    await navigatePageWithRetry(pageHostA, urlHostA);
    await robustLogin(pageHostA, hostUser);
    const { eventCode, eventId } = await createEventViaUi(pageHostA, `WEBRTC_RESILIENCE_${runId}`);
    assert.ok(eventCode && eventId, 'HostA failed to create event');
    const hostASession = await getUserSession(pageHostA);

    await navigatePageWithRetry(pageClient1, urlStaticClient);
    await ensureServiceWorkerControlled(pageClient1);
    await robustLogin(pageClient1, client1User);
    await joinEventViaUi(pageClient1, eventCode, livePages());
    await waitForConnectedWithSas(pageClient1, livePages(), 45000);

    await waitForCondition(
      async () =>
        await pageClient1.evaluate((eid) => {
          const raw = localStorage.getItem(`sp27_clock_anchor_${eid}`);
          return raw ? JSON.parse(raw)?.calibratedByHost === true : false;
        }, eventId),
      { timeoutMs: 15000, label: 'Initial Host clock calibration on Client1' }
    );

    // ========================================================================
    // SCENARIO 1: Large Multi-Chunk CRDT Sync + Zero False Heartbeat Disconnect
    //             + Zero Backpressure Overflow
    // ========================================================================
    console.log('\n=== Scenario 1: Large Multi-Chunk CRDT Sync (34 x 6.2KB records) & Resilience ===');
    client1Cdp = manager.registerCdpSession(await pageClient1.target().createCDPSession());
    await client1Cdp.send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1
    });
    await pageClient1.evaluate(() => window.__rtcSimulateNetworkDrop?.());
    await waitForCondition(
      async () =>
        await pageClient1.evaluate(() => !document.querySelector('.connection-status.connected')),
      { timeoutMs: 15000, label: 'Client1 disconnect before seeding 34 large records' }
    );
    await delay(400);

    const RECORD_COUNT = 34;
    const NOTE_PAD = 'R'.repeat(6200);
    await switchToTab(pageClient1, 'scout');
    for (let i = 1; i <= RECORD_COUNT; i++) {
      const teamNum = 1000 + i;
      const noteText = `RES_M${i}_T${teamNum}_${NOTE_PAD}`;
      await submitLargeMatchRecordViaUi(pageClient1, {
        matchNumber: i,
        teamNumber: teamNum,
        alliance: i % 2 === 0 ? 'Red' : 'Blue',
        notes: noteText,
        expectedCount: i
      });
    }

    const clientPreSync = await pageClient1.evaluate(() => window.__sp27E2eBridge.getNormalizedState());
    assert.strictEqual(clientPreSync.scoutingRecords.length, RECORD_COUNT, `Expected ${RECORD_COUNT} seeded records on Client1`);
    assert.ok(
      clientPreSync.scoutingRecords.every((r) => Boolean(r.authorPubKey) && r.notes.length >= 6200),
      'All seeded records on Client1 must be ECDSA-signed and contain >= 6200-char notes'
    );

    // Snapshot log indices & clear offline console errors right before reconnecting for the burst
    manager.clearPageErrors([pageHostA, pageClient1]);
    const burstStartHostIdx = hostLogs.length;
    const burstStartClientIdx = clientLogs.length;

    await client1Cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1
    });
    await pageClient1.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitForConnectedWithSas(pageClient1, livePages(), 45000);

    await waitForCondition(
      async () => {
        const [hostNorm, clientNorm] = await Promise.all([
          pageHostA.evaluate(() => window.__sp27E2eBridge.getNormalizedState()),
          pageClient1.evaluate(() => window.__sp27E2eBridge.getNormalizedState())
        ]);
        return (
          hostNorm?.scoutingRecords?.length === RECORD_COUNT &&
          clientNorm?.scoutingRecords?.length === RECORD_COUNT
        );
      },
      { timeoutMs: 45000, label: `HostA & Client1 convergence of all ${RECORD_COUNT} large records` }
    );

    // Allow post-convergence heartbeat ticks to keep running while observing stability
    await delay(2500);

    const burstHostLogs = hostLogs.slice(burstStartHostIdx);
    const burstClientLogs = clientLogs.slice(burstStartClientIdx);
    const chunkSentCount = burstClientLogs.filter((l) => l.text.includes('Sending message CRDT_SYNC_CHUNK')).length;
    const chunkRecvCount = burstHostLogs.filter((l) => l.text.includes('Received message CRDT_SYNC_CHUNK')).length;
    console.log(`[Scenario 1] Observed CRDT_SYNC_CHUNK frames: sent=${chunkSentCount}, received=${chunkRecvCount}`);

    // Positive prerequisite assertion (AGENTS.md Rule 3): real multi-chunk transfer must have occurred
    assert.ok(
      chunkSentCount >= 15,
      `Expected >= 15 CRDT_SYNC_CHUNK frames sent by Client1, observed ${chunkSentCount}`
    );
    assert.ok(
      chunkRecvCount >= 15,
      `Expected >= 15 CRDT_SYNC_CHUNK frames received by HostA, observed ${chunkRecvCount}`
    );

    const forbiddenPatterns = [
      /BackpressureTimeoutError/i,
      /DataChannel closed/i,
      /heartbeat_timeout/i,
      /SCTP wedged/i
    ];
    for (const [label, logs] of [
      ['HostA', burstHostLogs],
      ['Client1', burstClientLogs]
    ]) {
      for (const pat of forbiddenPatterns) {
        const hits = logs.filter((l) => pat.test(l.text));
        assert.strictEqual(
          hits.length,
          0,
          `${label} emitted forbidden error pattern ${pat}: ${hits.map((h) => h.text).join(' | ')}`
        );
      }
    }

    const [hostStatusAfterBurst, clientStatusAfterBurst] = await Promise.all([
      pageHostA.evaluate(() => ({
        bridgeStatus: window.__sp27E2eBridge?.getConnectionStatus?.(),
        domConnected: Boolean(document.querySelector('.connection-status.connected'))
      })),
      pageClient1.evaluate(() => ({
        bridgeStatus: window.__sp27E2eBridge?.getConnectionStatus?.(),
        domConnected: Boolean(document.querySelector('.connection-status.connected'))
      }))
    ]);
    assert.strictEqual(hostStatusAfterBurst.bridgeStatus, 'connected', 'HostA bridge status must remain connected');
    assert.strictEqual(hostStatusAfterBurst.domConnected, true, 'HostA DOM .connection-status must remain connected');
    assert.strictEqual(clientStatusAfterBurst.bridgeStatus, 'connected', 'Client1 bridge status must remain connected');
    assert.strictEqual(clientStatusAfterBurst.domConnected, true, 'Client1 DOM .connection-status must remain connected');

    await pageHostA.evaluate(async () => {
      await window.__sp27E2eBridge.flushCrdtNow();
    });
    const [hostNormFinal, clientNormFinal] = await Promise.all([
      pageHostA.evaluate(() => window.__sp27E2eBridge.getNormalizedState()),
      pageClient1.evaluate(() => window.__sp27E2eBridge.getNormalizedState())
    ]);
    assert.deepStrictEqual(
      hostNormFinal.scoutingRecords,
      clientNormFinal.scoutingRecords,
      'HostA and Client1 CRDT normalized scoutingRecords must converge identically'
    );

    const hostCrdtDb = await fetchBackendJson(portHostA, `/api/events/${eventId}/crdt-state`, hostASession.token);
    assert.strictEqual(hostCrdtDb.exists, true, 'HostA H2 /crdt-state must exist');
    const dbCrdtRows = hostCrdtDb.snapshot?.[0]?.[0]?.scouting_records?.[0] || {};
    assert.strictEqual(
      Object.keys(dbCrdtRows).length,
      RECORD_COUNT,
      `Expected ${RECORD_COUNT} scouting_records in HostA H2 /crdt-state, got ${Object.keys(dbCrdtRows).length}`
    );
    console.log('✅ Scenario 1 passed: 34 large signed CRDT records converged via 15+ chunks with zero disconnects/backpressure errors.');

    // ========================================================================
    // SCENARIO 2: Remote ICE Split-Tunnel Proxy-Exit Demotion Preservation
    // ========================================================================
    console.log('\n=== Scenario 2: Remote ICE Proxy-Exit (typePref=80) Preservation Over Real Signaling ===');
    let hostSenderId = null;
    for (let i = clientLogs.length - 1; i >= 0; i--) {
      const m = clientLogs[i].text.match(/Received host_hello:.*sender=(sp27-[^\s,]+)/);
      if (m && m[1]) {
        hostSenderId = m[1];
        break;
      }
    }
    assert.ok(hostSenderId, 'Failed to extract HostA signaling sender ID from Client1 host_hello logs');

    const proxyPrio = 80 * 16777216 + 32768 * 256 + 255;
    const domesticPrio = 90 * 16777216 + 32768 * 256 + 255;
    const proxyExitCandStr = `candidate:proxy80 1 udp ${proxyPrio} 188.253.121.98 41000 typ srflx raddr 0.0.0.0 rport 9 generation 0 network-id 1 network-cost 10`;
    const domesticCandStr = `candidate:dom90 1 udp ${domesticPrio} 39.157.117.183 42000 typ srflx raddr 0.0.0.0 rport 9 generation 0 network-id 1 network-cost 10`;

    await pageClient1.evaluate(() => {
      window.__sp27AddedRemoteIceCandidates = [];
    });

    await publishSignedSignalEnvelope(mqttBrokerUrl, manager, eventCode, {
      type: 'candidate',
      sender: hostSenderId,
      candidate: {
        candidate: proxyExitCandStr,
        sdpMid: '0',
        sdpMLineIndex: 0
      }
    });
    await publishSignedSignalEnvelope(mqttBrokerUrl, manager, eventCode, {
      type: 'candidate',
      sender: hostSenderId,
      candidate: {
        candidate: domesticCandStr,
        sdpMid: '0',
        sdpMLineIndex: 0
      }
    });

    const addedCandidates = await waitForCondition(
      async () => {
        const list = await pageClient1.evaluate(() => window.__sp27AddedRemoteIceCandidates || []);
        const hasProxy = list.some((c) => c.includes('188.253.121.98') && c.includes('41000'));
        const hasDom = list.some((c) => c.includes('39.157.117.183') && c.includes('42000'));
        const hasProxyPred = list.some((c) => c.includes('188.253.121.98') && !c.includes(' 41000 '));
        return hasProxy && hasDom && hasProxyPred ? list : null;
      },
      { timeoutMs: 15000, label: 'Client1 RTCPeerConnection.addIceCandidate receiving proxy-exit (80) & domestic (90) candidates' }
    );

    const parsedAdded = addedCandidates.map(parseCandidateTypePref).filter(Boolean);
    const baseProxy = parsedAdded.find((c) => c.ip === '188.253.121.98' && c.port === 41000);
    const predictedProxy = parsedAdded.filter((c) => c.ip === '188.253.121.98' && c.port !== 41000);
    const baseDomestic = parsedAdded.find((c) => c.ip === '39.157.117.183' && c.port === 42000);

    assert.ok(baseProxy, 'Missing base proxy-exit candidate 188.253.121.98:41000 in addIceCandidate');
    assert.strictEqual(
      baseProxy.typePref,
      80,
      `Expected receiver to preserve demoted proxy-exit typePref=80, got ${baseProxy.typePref} (${baseProxy.raw})`
    );
    assert.ok(predictedProxy.length > 0, 'Expected synthesized symmetric-NAT port predictions for proxy-exit candidate');
    for (const pred of predictedProxy) {
      assert.strictEqual(
        pred.typePref,
        78,
        `Expected predicted port for demoted proxy-exit to have typePref=78 (< 80), got ${pred.typePref} (${pred.raw})`
      );
      assert.ok(pred.typePref < baseProxy.typePref, 'Predicted proxy port must stay strictly below typePref=80');
    }
    assert.ok(baseDomestic, 'Missing domestic candidate 39.157.117.183:42000 in addIceCandidate');
    assert.strictEqual(
      baseDomestic.typePref,
      90,
      `Expected domestic srflx typePref=90, got ${baseDomestic.typePref} (${baseDomestic.raw})`
    );
    assert.ok(
      baseDomestic.priority > baseProxy.priority,
      'Domestic srflx (90) must strictly outrank demoted proxy-exit srflx (80)'
    );
    console.log(`✅ Scenario 2 passed: Preserved typePref=80 on 188.253.121.98, capped ${predictedProxy.length} port predictions at typePref=78, domestic=90.`);

    // ========================================================================
    // SCENARIO 3: Post-Burst Clock Sync & Heartbeat Health
    // ========================================================================
    console.log('\n=== Scenario 3: Post-Burst Clock Sync & Heartbeat Health ===');
    const postBurstClockSyncReqCount = burstClientLogs.filter((l) => l.text.includes('Sending message CLOCK_SYNC_REQ')).length;
    const postBurstClockSyncResCount = burstClientLogs.filter((l) => l.text.includes('Received message CLOCK_SYNC_RES')).length;
    assert.ok(
      postBurstClockSyncReqCount >= 1 && postBurstClockSyncResCount >= 1,
      `Expected CLOCK_SYNC_REQ/RES during/after burst, got req=${postBurstClockSyncReqCount}, res=${postBurstClockSyncResCount}`
    );

    const [hostClockNow, clientClockNow, clientAnchor] = await Promise.all([
      pageHostA.evaluate(() => window.__sp27E2eBridge.getClockNow()),
      pageClient1.evaluate(() => window.__sp27E2eBridge.getClockNow()),
      pageClient1.evaluate((eid) => {
        const raw = localStorage.getItem(`sp27_clock_anchor_${eid}`);
        return raw ? JSON.parse(raw) : null;
      }, eventId)
    ]);
    assert.strictEqual(clientAnchor?.calibratedByHost, true, 'Client1 clock anchor must remain calibratedByHost=true');
    assert.ok(
      Math.abs(clientClockNow - hostClockNow) < 3000,
      `Expected HostA & Client1 calibrated clock delta < 3000ms, got ${Math.abs(clientClockNow - hostClockNow)}ms`
    );

    const s3StartHostIdx = hostLogs.length;
    const s3StartClientIdx = clientLogs.length;
    await delay(4500);

    const s3ClientLogs = clientLogs.slice(s3StartClientIdx);
    const s3HostLogs = hostLogs.slice(s3StartHostIdx);
    const postBurstPingsSent = s3ClientLogs.filter((l) => l.text.includes('Sending message PING')).length;
    const postBurstPongsSent = s3HostLogs.filter((l) => l.text.includes('Sending message PONG')).length;
    const postBurstPongsRecv = s3ClientLogs.filter((l) => l.text.includes('Received message PONG')).length;

    assert.ok(postBurstPingsSent >= 2, `Expected >= 2 post-burst PINGs sent by Client1, got ${postBurstPingsSent}`);
    assert.ok(postBurstPongsSent >= 2, `Expected >= 2 post-burst PONGs sent by HostA, got ${postBurstPongsSent}`);
    assert.ok(postBurstPongsRecv >= 2, `Expected >= 2 post-burst PONGs received by Client1, got ${postBurstPongsRecv}`);

    const [hostFinalConn, clientFinalConn] = await Promise.all([
      pageHostA.evaluate(() => window.__sp27E2eBridge.getConnectionStatus()),
      pageClient1.evaluate(() => window.__sp27E2eBridge.getConnectionStatus())
    ]);
    assert.strictEqual(hostFinalConn, 'connected', 'HostA must remain connected after Scenario 3');
    assert.strictEqual(clientFinalConn, 'connected', 'Client1 must remain connected after Scenario 3');

    manager.assertNoUnexpectedErrors(livePages(), {
      allowConsolePatterns: [/WakeLock/i]
    });
    console.log(`✅ Scenario 3 passed: CLOCK_SYNC (req=${postBurstClockSyncReqCount}/res=${postBurstClockSyncResCount}) & post-burst PING/PONG (${postBurstPongsRecv} PONGs) healthy.`);
  } finally {
    await manager.cleanupAll({ assertDeleted: true });
    for (const base of rootDbBaselines) {
      const after = snapshotFileStat(base.path);
      assert.deepStrictEqual(after, base.stat, `E2E test unexpectedly modified root DB file: ${base.path}`);
    }
    process.off('SIGINT', signalHandler);
    process.off('SIGTERM', signalHandler);
  }
}

runResilienceE2ETest().catch((err) => {
  console.error('\n❌ WebRTC Resilience E2E failed:', err);
  process.exit(1);
});
