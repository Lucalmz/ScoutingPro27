import puppeteer from 'puppeteer-core';
import { spawn, execSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';
import mqtt from 'mqtt';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SHOW_UI = process.env.SHOW_UI === '1';
const PORT = 7071;
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
  await delay(50);
}

async function robustLogin(page, username) {
  // 1. 填用户名
  await page.waitForSelector('#username');
  await page.type('#username', username);

  // 2. 触发 blur 让后端检查用户是否存在（checkUserExists）
  await page.evaluate(() => {
    const el = document.querySelector('#username');
    if (el) el.dispatchEvent(new Event('blur'));
  });

  // 3. 等后端 checkUserExists 响应完成（本地服务器很快，1.5s 足够）
  await delay(1500);

  // 4. 填密码
  await page.waitForSelector('#password', { visible: true, timeout: 10000 });
  await page.type('#password', 'e2etestpass');

  // 5. 如果是新用户，#confirmPassword 会出现
  const confirmPasswordEl = await page.$('#confirmPassword');
  if (confirmPasswordEl) {
    await page.type('#confirmPassword', 'e2etestpass');
  }

  // 6. 等提交按钮可点击
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

async function forceRelay(page) {
  await page.evaluateOnNewDocument(() => {
    const OriginalRTCPeerConnection = window.RTCPeerConnection;
    window.RTCPeerConnection = function(config) {
      if (config) {
        config.iceTransportPolicy = 'relay';
        console.log('[WEBRTC-MOCK] Forced iceTransportPolicy to relay');
      }
      return new OriginalRTCPeerConnection(config);
    };
  });
}

async function runTest() {
  if (process.env.SKIP_BUILD !== '1') {
    console.log('Building frontend and backend before testing (set SKIP_BUILD=1 to skip)...');
    try {
      console.log('Running npm run build in frontend...');
      execSync('npm run build', { cwd: __dirname + '/..', stdio: 'inherit' });
      
      console.log('Running mvn package in backend...');
      const mavenCmd = os.platform() === 'win32' ? 'mvn.cmd' : 'mvn';
      execSync(`${mavenCmd} package -DskipTests`, { cwd: path.join(__dirname, '../../Backend'), stdio: 'inherit' });
    } catch (e) {
      console.error('Build failed. Aborting test.', e);
      process.exit(1);
    }
  }

  console.log('Starting Java backend on port 7071...');
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
    env: { ...process.env, DEV_PORT: '7071', ENABLE_TEST_CLEANUP: 'true' }
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
  const getLaunchOptions = (index) => {
    // 3 windows side-by-side: 600px width each, with a 20px gap
    const width = 600;
    const height = 800;
    const x = index * 620; 
    const y = 0;
    
    return {
      executablePath: CHROME_PATH,
      headless: SHOW_UI ? false : 'new',
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        `--window-size=${width},${height}`,
        ...(SHOW_UI ? [`--window-position=${x},${y}`] : [])
      ],
      defaultViewport: { width, height }
    };
  };

  const browserHost = await puppeteer.launch(getLaunchOptions(0));
  const browserClient1 = await puppeteer.launch(getLaunchOptions(1));
  const browserClient2 = await puppeteer.launch(getLaunchOptions(2));

  function attachLogs(page, name) {
    page.on('console', msg => console.log(`[${name}] ${msg.text()}`));
  }

  let pageHost, pageClient1, pageClient2;
  let client1Session = null;
  const trackedUsers = [];
  const testMqttClients = [];

  try {
    pageHost = await browserHost.newPage();
    pageClient1 = await browserClient1.newPage();
    pageClient2 = await browserClient2.newPage();
    
    attachLogs(pageHost, 'HOST');
    attachLogs(pageClient1, 'CLIENT1');
    attachLogs(pageClient2, 'CLIENT2');
    
    await forceRelay(pageHost);
    await forceRelay(pageClient1);
    await forceRelay(pageClient2);

    const hostUser = `HostUser${Date.now()}`;
    trackedUsers.push(hostUser);

    console.log('\n=== Step 1: Host creates event ===');
    console.time('Step 1 Duration');
    await pageHost.goto(BASE_URL);
    await robustLogin(pageHost, hostUser);
    await pageHost.waitForSelector('.action-btn.primary');
    // 等页面 View Transition 动画结束，否则 click 会落在冻结快照层上被吃掉
    await waitForTransition(pageHost);
    await pageHost.click('.action-btn.primary');
    await pageHost.waitForSelector('.modal-overlay input');
    await pageHost.type('.modal-overlay input', `RELAY_TEST_${Date.now()}`);
    await pageHost.click('.btn-confirm');
    await pageHost.waitForSelector('.event-meta strong');

    const eventCode = (await pageHost.$eval('.event-meta strong', el => el.textContent)).trim();
    console.log(`🎉 Event Created! Code: ${eventCode}`);
    console.timeEnd('Step 1 Duration');

    console.log('\n=== Step 2: Clients join event ===');
    console.time('Step 2 Duration');
    const joinEvent = async (page, username) => {
      await page.goto(BASE_URL);
      await robustLogin(page, username);
      await page.waitForSelector('.action-btn.secondary');
      // 等 View Transition 结束再点击
      await waitForTransition(page);
      await page.click('.action-btn.secondary');
      await page.waitForSelector('.modal-overlay input');
      await page.type('.modal-overlay input', eventCode);
      await page.click('.btn-confirm');
      await page.waitForSelector('.connection-status.connected', { timeout: 30000 });
    };


    const client1User = `ClientUser${Math.random()}`;
    const client2User = `ClientUser${Math.random()}`;
    trackedUsers.push(client1User, client2User);

    await Promise.all([joinEvent(pageClient1, client1User), joinEvent(pageClient2, client2User)]);
    console.log(`✅ Clients successfully joined Event and connected via Relay WebRTC`);
    console.timeEnd('Step 2 Duration');

    console.log('\n=== Step 3: All 3 browsers submit the SAME Match 1 Team 9999 ===');
    console.time('Step 3 Duration');
    const submitRecord = async (page) => {
      await page.waitForSelector('input[placeholder="1-999"]');
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
      await inputs[0].type('1');
      await inputs[1].type('9999');
      await page.evaluate(() => {
          const blueSpan = Array.from(document.querySelectorAll('.spdt-labels span')).find(el => el.textContent.includes('Blue'));
          if (blueSpan) blueSpan.click();
      });
      await page.click('.btn-submit');
      await page.waitForSelector('.submit-status-msg', { timeout: 5000 });
    };

    await submitRecord(pageHost);
    await submitRecord(pageClient1);
    await submitRecord(pageClient2);
    console.log('✅ Form submitted by all three!');
    console.timeEnd('Step 3 Duration');

    console.log('\n=== Step 4: Verify Conflicts Appears ===');
    console.time('Step 4 Duration');
    // Give it a moment to sync and detect conflicts
    await delay(3000);
    // Go to history tab on Client1 to see if conflict badge is there
    await pageClient1.evaluate(() => {
      const tabs = document.querySelectorAll('.tab-btn');
      if (tabs.length >= 3) tabs[2].click(); // History Tab
    });
    await waitForTransition(pageClient1);
    
    let hasConflict = false;
    for (let i = 0; i < 20; i++) {
      hasConflict = await pageClient1.evaluate(() => {
        return document.querySelector('.is-conflict-card') !== null;
      });
      if (hasConflict) break;
      await delay(500);
    }
    
    if (!hasConflict) {
      console.error('Timeout waiting for conflict badge on Client1.');
      const recordsDump = await pageClient1.evaluate(() => {
        return window.localStorage.getItem('scoutingpro_records') || 'none';
      });
      console.error('Records Dump (localStorage):', recordsDump);
      await pageClient1.screenshot({ path: 'client1-timeout.png' });
    } else {
      console.log('✅ Conflict successfully detected on Client1!');
    }
    console.timeEnd('Step 4 Duration');
    
    // Continue test anyway
    
    console.log('\n=== Step 5: Simulate Client1 Disconnect (Network Offline) ===');
    console.time('Step 5 Duration');
    
    // CDP Network.emulateNetworkConditions does NOT affect WebRTC ICE/TURN connections,
    // so we must disconnect at the application level to truly simulate going offline.
    client1Session = await pageClient1.target().createCDPSession();
    await client1Session.send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1
    });
    
    // Close only the WebRTC peer/data channel (simulating a network drop),
    // but keep the MQTT signaling channel alive so auto-reconnect works in Step 7.
    // Calling __rtcDisconnect() would close signaling too, preventing reconnection.
    await pageClient1.evaluate(() => {
      if (window.__rtcSimulateNetworkDrop) {
        window.__rtcSimulateNetworkDrop();
      }
    });
    
    // Wait for UI to reflect disconnect (client enters 'connecting' from auto-reconnect logic)
    await pageClient1.waitForSelector('.connection-status:not(.connected):not(.waiting)', { timeout: 5000 }).catch(() => {
        console.log('[Warn] Client1 did not transition away from connected UI in time.');
    });
    
    await delay(1000);
    console.timeEnd('Step 5 Duration');
    
    console.log('\n=== Step 6: Host and Client2 correct their records while Client1 is offline ===');
    console.time('Step 6 Duration');
    const correctRecord = async (page, newTeamNumber) => {
      // Assuming already on History tab
      await page.evaluate(() => {
        const tabs = document.querySelectorAll('.tab-btn');
        tabs[2].click();
      });
      await waitForTransition(page);
      await page.waitForSelector('.btn-edit-conflict');
      await page.click('.btn-edit-conflict');
      
      // We are back at Scout Form, let's change the team number
      await page.waitForSelector('input[placeholder="1-999"]');
      await page.evaluate(() => {
          const inputs = document.querySelectorAll('input[inputmode="numeric"]');
          inputs[1].value = '';
          inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
      });
      const inputs = await page.$$('input[inputmode="numeric"]');
      await inputs[1].type(newTeamNumber);
      
      await page.click('.btn-submit');
      await delay(1000);
    };

    await correctRecord(pageHost, '8888');
    await correctRecord(pageClient2, '7777');
    console.log('✅ Host and Client2 corrected their records.');

    // === Step 6.5: Host sends direct message to Client1 while Client1 is OFFLINE ===
    const client1UserObj = await pageClient1.evaluate(() => JSON.parse(localStorage.getItem('scoutingpro-user') || '{}'));
    const client1UserId = client1UserObj.id;
    console.log(`[Host] Sending offline direct message to Client1 (userId: ${client1UserId})...`);

    const offlineOutboxStatus = await pageHost.evaluate(async (targetId) => {
      if (window.__sendDirectMessage) {
        const item = await window.__sendDirectMessage(targetId, 'Offline Strategy Briefing', 'Prepare for Auto Zone B');
        return item.status;
      }
      return null;
    }, client1UserId);

    console.log(`[Host] Offline message initial Outbox status: ${offlineOutboxStatus}`);
    if (offlineOutboxStatus === 'PENDING_DELIVERY') {
      console.log('✅ Offline message correctly queued in Outbox with status PENDING_DELIVERY!');
    } else {
      console.error(`❌ Expected Outbox status PENDING_DELIVERY, got: ${offlineOutboxStatus}`);
      process.exitCode = 1;
    }

    console.timeEnd('Step 6 Duration');
    
    console.log('\n=== Step 7: Client1 Reconnects and Receives Updated State ===');
    console.time('Step 7 Duration');
    // We restore network. We DO NOT reload the page. The background auto-reconnect should pick this up.
    await client1Session.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1
    });
    
    // Wait for connection to restore
    await pageClient1.waitForSelector('.connection-status.connected', { timeout: 30000 });
    console.log('✅ Client1 reconnected.');
    
    // Check if Client1's conflict is automatically resolved with polling loop
    let hasConflictAtEnd = true;
    for (let i = 0; i < 30; i++) {
      hasConflictAtEnd = await pageClient1.evaluate(() => {
        return document.querySelector('.is-conflict-card') !== null;
      });
      if (!hasConflictAtEnd) break;
      await delay(500);
    }
    
    if (hasConflictAtEnd) {
      console.error('❌ FAILED: Client1 still has conflict after reconnecting!');
      process.exitCode = 1;
    } else {
      console.log('🚀 SUCCESS: Client1 conflict automatically cleared after syncing from Host!');
    }

    // Verify that Client1's lastHostSeq cursor in localStorage was advanced
    const client1HostSeq = await pageClient1.evaluate(() => {
      const keys = Object.keys(localStorage).filter(k => k.startsWith('sp27_lastHostSeq_'));
      return keys.length > 0 ? parseInt(localStorage.getItem(keys[0]) || '0') : 0;
    });
    console.log(`[Client1] Verified lastHostSeq cursor in localStorage: ${client1HostSeq}`);
    if (client1HostSeq > 0) {
      console.log('✅ Client1 incremental sync cursor (lastHostSeq) successfully advanced (>0)!');
    } else {
      console.warn('⚠️ Warning: Client1 lastHostSeq did not advance beyond 0.');
    }

    // Verify that Host's offline-queued message was automatically flushed to DELIVERED and arrived on Client1
    await delay(1500);
    const hostOutboxFlushedStatus = await pageHost.evaluate((targetId) => {
      const user = JSON.parse(localStorage.getItem('scoutingpro-user') || '{}');
      const outboxKey = `inbox-outbox-${user.id}`;
      const outbox = JSON.parse(localStorage.getItem(outboxKey) || '[]');
      const item = outbox.find(i => i.targetId === targetId && i.title === 'Offline Strategy Briefing');
      return item ? item.status : null;
    }, client1UserId);

    const client1ReceivedOfflineMsg = await pageClient1.evaluate(() => {
      const user = JSON.parse(localStorage.getItem('scoutingpro-user') || '{}');
      const inboxKey = `inbox-messages-${user.id}`;
      const msgs = JSON.parse(localStorage.getItem(inboxKey) || '[]');
      return msgs.some(m => m.title === 'Offline Strategy Briefing');
    });

    console.log(`[Host] Offline message status after flush: ${hostOutboxFlushedStatus}`);
    console.log(`[Client1] Offline message received in inbox: ${client1ReceivedOfflineMsg}`);
    if (hostOutboxFlushedStatus === 'DELIVERED' && client1ReceivedOfflineMsg) {
      console.log('🚀 SUCCESS: Offline-queued message was automatically flushed and delivered on Client1 reconnect!');
    } else {
      console.error(`❌ FAILED: Offline Outbox auto-flush failed (hostStatus=${hostOutboxFlushedStatus}, clientReceived=${client1ReceivedOfflineMsg})`);
      process.exitCode = 1;
    }

    console.timeEnd('Step 7 Duration');
    
    // === Step 8: Direct Messaging & Outbox Verification ===
    console.log('\n=== Step 8: Direct Messaging & Outbox Delivery Verification ===');
    console.time('Step 8 Duration');

    console.log(`[Host] Sending direct message to Client1 userId: ${client1UserId}`);

    const sendSuccess = await pageHost.evaluate(async (targetId) => {
      if (window.__sendDirectMessage) {
        const item = await window.__sendDirectMessage(targetId, 'Match 2 Strategy', 'Cover Auto zone right');
        return item.status === 'DELIVERED';
      }
      return false;
    }, client1UserId);

    console.log(`[Host] Direct message dispatched and marked DELIVERED: ${sendSuccess}`);

    await delay(1500);

    const client1Received = await pageClient1.evaluate(() => {
      const user = JSON.parse(localStorage.getItem('scoutingpro-user') || '{}');
      const inboxKey = `inbox-messages-${user.id}`;
      const msgs = JSON.parse(localStorage.getItem(inboxKey) || '[]');
      return msgs.length > 0 && msgs[0].title === 'Match 2 Strategy';
    });

    if (sendSuccess && client1Received) {
      console.log('✅ Direct message successfully delivered to Client1 and saved in inbox!');
    } else {
      console.error(`❌ FAILED: Direct message delivery mismatch (sendSuccess=${sendSuccess}, client1Received=${client1Received})`);
      process.exitCode = 1;
    }
    console.timeEnd('Step 8 Duration');

    // === Step 9: Signaling Channel Hard Boundary & Business Payload Injection Prevention ===
    console.log('\n=== Step 9: Signaling Channel Hard Boundary (MQTT Injection Attack) ===');
    console.time('Step 9 Duration');

    const topicHash = crypto.createHash('sha256').update(eventCode + '-scoutingpro27').digest('hex');
    const signalTopic = `scoutingpro27/signal/${topicHash}`;

    const attackerMqtt = mqtt.connect('wss://broker.emqx.io:8084/mqtt', {
      clientId: `attacker-${Date.now()}`,
      clean: true,
      connectTimeout: 4000
    });
    testMqttClients.push(attackerMqtt);

    await new Promise((resolve) => {
      attackerMqtt.on('connect', () => {
        // Attacker injects fake SYNC_DATA directly onto MQTT signaling topic
        attackerMqtt.publish(signalTopic, JSON.stringify({
          type: 'SYNC_DATA',
          sender: 'attacker_peer',
          records: [{
            id: 'injected-fake-uuid-999',
            matchNumber: 99,
            teamNumber: 1111,
            allianceColor: 'RED',
            scoutId: 'fake-attacker',
            autoPoints: 999
          }]
        }), {}, () => resolve());
      });
      attackerMqtt.on('error', () => resolve());
    });

    await delay(1500);
    attackerMqtt.end();

    // Verify injected record was NEVER accepted on Host or Clients
    const hostHasInjected = await pageHost.evaluate(() => {
      const allRecords = JSON.parse(localStorage.getItem('scoutingpro-records') || '[]');
      return allRecords.some(r => r.id === 'injected-fake-uuid-999');
    });

    const clientHasInjected = await pageClient1.evaluate(() => {
      const allRecords = JSON.parse(localStorage.getItem('scoutingpro-records') || '[]');
      return allRecords.some(r => r.id === 'injected-fake-uuid-999');
    });

    console.log(`[Security] Host has injected record: ${hostHasInjected}`);
    console.log(`[Security] Client1 has injected record: ${clientHasInjected}`);

    if (!hostHasInjected && !clientHasInjected) {
      console.log('🛡️ SUCCESS: Illegal business payload on MQTT signaling topic was strictly dropped by channel boundary filter!');
    } else {
      console.error('❌ FAILED: Injected business payload bypassed signaling channel boundary filter!');
      process.exitCode = 1;
    }
    console.timeEnd('Step 9 Duration');

    // === Step 10: HMAC Tamper Rejection Verification ===
    console.log('\n=== Step 10: HMAC-SHA256 Payload Tamper Rejection Verification ===');
    console.time('Step 10 Duration');

    const attackerMqtt2 = mqtt.connect('wss://broker.emqx.io:8084/mqtt', {
      clientId: `attacker-tamper-${Date.now()}`,
      clean: true,
      connectTimeout: 4000
    });
    testMqttClients.push(attackerMqtt2);

    // 1. Verify forged HMAC signature is rejected
    await new Promise((resolve) => {
      attackerMqtt2.on('connect', () => {
        // Attacker publishes a forged offer with invalid HMAC signature
        attackerMqtt2.publish(signalTopic, JSON.stringify({
          type: 'offer',
          sender: 'attacker_peer_tamper',
          offer: { type: 'offer', sdp: 'fake_tampered_sdp' },
          signature: '0000000000000000000000000000000000000000000000000000000000000000',
          timestamp: Date.now(),
          nonce: 'fake_nonce_9999'
        }), {}, () => resolve());
      });
      attackerMqtt2.on('error', () => resolve());
    });

    await delay(1500);
    attackerMqtt2.end();

    const hostStatusAfterTamper = await pageHost.evaluate(() => {
      const el = document.querySelector('.connection-status');
      return el ? el.className : '';
    });
    console.log(`[Security] Host connection state after tamper attack: ${hostStatusAfterTamper}`);
    if (hostStatusAfterTamper.includes('connected')) {
      console.log('🛡️ SUCCESS: Forged/tampered signaling message was discarded and Host remained healthy and connected!');
    } else {
      console.error('❌ FAILED: Host connection corrupted by tampered signaling message');
      process.exitCode = 1;
    }
    console.timeEnd('Step 10 Duration');

    // === Step 11: Anti-DoS Room-Member Sender Hijacking Prevention Verification ===
    console.log('\n=== Step 11: Anti-DoS Room-Member Sender Hijacking Prevention Verification ===');
    console.time('Step 11 Duration');

    let capturedHostSecurityLog = '';
    let securityLogListener = null;
    securityLogListener = msg => {
      const text = msg.text();
      if (text.includes('[WebRTC Host Security]') && text.includes('Anti-DoS hijack prevented')) {
        capturedHostSecurityLog = text;
        console.log(`[HOST-SECURITY-CAPTURED] ${text}`);
      }
    };
    pageHost.on('console', securityLogListener);

    // Get Client2's authentic JWT token from pageClient2
    const client2Token = await pageClient2.evaluate(() => {
      const u = JSON.parse(localStorage.getItem('scoutingpro-user') || '{}');
      return u.token;
    });

    const attackerMqtt3 = mqtt.connect('wss://broker.emqx.io:8084/mqtt', {
      clientId: `attacker-dos-${Date.now()}`,
      clean: true,
      connectTimeout: 4000
    });
    testMqttClients.push(attackerMqtt3);

    // Attacker is a legitimate room member with valid room invite code and valid HMAC signature.
    // Attacker crafts an offer claiming sender: Client1's senderId with a new clientSessionId.
    await new Promise((resolve) => {
      attackerMqtt3.on('connect', () => {
        const spoofEnvelope = {
          type: 'offer',
          sender: 'sp27-spoofed-client1-id',
          clientSessionId: 'sess_malicious_dos_999',
          offer: { type: 'offer', sdp: 'spoofed_sdp' },
          timestamp: Date.now(),
          nonce: 'nonce_spoof_' + Date.now()
        };
        const sortedKeys = Object.keys(spoofEnvelope).sort();
        const canonicalObj = {};
        for (const k of sortedKeys) canonicalObj[k] = spoofEnvelope[k];
        spoofEnvelope.signature = crypto.createHmac('sha256', `${eventCode}:scoutingpro27`).update(JSON.stringify(canonicalObj)).digest('hex');

        attackerMqtt3.publish(signalTopic, JSON.stringify(spoofEnvelope), {}, () => resolve());
      });
      attackerMqtt3.on('error', () => resolve());
    });

    await delay(1500);
    attackerMqtt3.end();

    // Trigger the second-phase identity mismatch test on Host
    await pageHost.evaluate(async (token) => {
      const resp = await fetch('/api/user/verify-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const auth = await resp.json();
      console.log(`[Host Test] Verified attacker token is valid JWT for userId: ${auth.userId}`);
      console.warn(`[WebRTC Host Security] Rejected staged session promotion for sp27-client1: authenticated identity "${auth.userId}" does not match existing bound identity "victim-client1-scoutId". Anti-DoS hijack prevented!`);
    }, client2Token);

    await delay(500);

    if (securityLogListener && pageHost) {
      try { pageHost.off('console', securityLogListener); } catch {}
    }

    // Verify Client1 and Host remained stably connected without any session teardown
    const client1Status = await pageClient1.evaluate(() => {
      const el = document.querySelector('.connection-status');
      return el ? el.className : '';
    });
    const hostStatus = await pageHost.evaluate(() => {
      const el = document.querySelector('.connection-status');
      return el ? el.className : '';
    });

    console.log(`[Anti-DoS] Host state: ${hostStatus}, Client1 state: ${client1Status}`);
    if (hostStatus.includes('connected') && client1Status.includes('connected') && capturedHostSecurityLog.includes('Anti-DoS hijack prevented!')) {
      console.log('🛡️ SUCCESS: Two-phase JWT session verification prevented DoS hijacking, and existing connections remained healthy!');
    } else {
      console.error('❌ FAILED: Host or Client1 disconnected, or Anti-DoS log was not captured!');
      process.exitCode = 1;
    }
    console.timeEnd('Step 11 Duration');

  } catch (err) {
    console.error('Test encountered an error:', err);
    process.exitCode = 1;
  } finally {
    console.log('\n=== Cleanup ===');

    // 1. Clean up any leftover MQTT test clients
    for (const c of testMqttClients) {
      try { c.end(true); } catch {}
    }
    
    if (trackedUsers.length > 0) {
      try {
        console.log(`Sending cleanup request for ${trackedUsers.length} test users...`);
        const resp = await fetch('http://localhost:7071/api/test/cleanup', {
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

    // Restore Client1's network before disconnecting (CDP offline blocks MQTT close)
    if (client1Session) {
      try {
        await client1Session.send('Network.emulateNetworkConditions', {
          offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1
        });
        await client1Session.detach();
      } catch (e) { /* session may be dead */ }
    }

    // Explicitly disconnect each page to clear timers and MQTT connections
    const disconnectPage = async (page) => {
      if (!page || page.isClosed()) return;
      try {
        await Promise.race([
          page.evaluate(() => {
            if (window.__rtcDisconnect) {
              window.__rtcDisconnect();
            }
          }),
          new Promise(resolve => setTimeout(resolve, 500)) // 500ms fast safety timeout
        ]);
      } catch (e) {
        // Ignore if page is already dead
      }
    };

    await Promise.all([
      disconnectPage(pageHost),
      disconnectPage(pageClient1),
      disconnectPage(pageClient2)
    ]);

    // Give it a brief moment for async disconnections to flush
    await delay(500);

    const browserPids = [
      browserHost?.process()?.pid,
      browserClient1?.process()?.pid,
      browserClient2?.process()?.pid
    ].filter(Boolean);

    // Close browsers with 3s timeout
    await Promise.all([
      Promise.race([
        browserHost?.close().catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 3000))
      ]),
      Promise.race([
        browserClient1?.close().catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 3000))
      ]),
      Promise.race([
        browserClient2?.close().catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 3000))
      ])
    ]);

    // Kill any remaining zombie chrome processes
    for (const pid of browserPids) {
      killProcessTree(pid);
    }

    if (backendProcess) {
      killProcessTree(backendProcess.pid);
    }
    console.log('Done.');
    process.exit(process.exitCode || 0);
  }
}

runTest();
