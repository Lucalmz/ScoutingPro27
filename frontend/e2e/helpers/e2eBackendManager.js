import puppeteer from 'puppeteer';
import { spawn, execSync } from 'child_process';
import http from 'http';
import net from 'net';
import path from 'path';
import os from 'os';
import fs from 'fs';
import assert from 'assert';
import { fileURLToPath } from 'url';
import { startLocalMqttBroker as startInProcessMqttBroker } from './localMqttBroker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const REPO_ROOT = path.resolve(__dirname, '../../..');
export const FRONTEND_DIR = path.resolve(__dirname, '../..');
export const BACKEND_JAR_PATH = path.join(REPO_ROOT, 'Backend', 'target', 'ScoutingPro27.jar');
export const STATIC_PUBLIC_DIR = path.join(REPO_ROOT, 'Backend', 'src', 'main', 'resources', 'public');

export function ensureE2eBuildArtifacts() {
  if (process.env.SKIP_BUILD === '1') {
    return;
  }
  console.log('Building frontend (with VITE_ENABLE_E2E_BRIDGE=true) and packaging Backend fat JAR before E2E (set SKIP_BUILD=1 to skip)...');
  execSync('npm run build', {
    cwd: FRONTEND_DIR,
    stdio: 'inherit',
    env: { ...process.env, VITE_ENABLE_E2E_BRIDGE: 'true' }
  });
  const mavenCmd = os.platform() === 'win32' ? 'mvn.cmd' : 'mvn';
  execSync(`${mavenCmd} package -DskipTests`, {
    cwd: path.join(REPO_ROOT, 'Backend'),
    stdio: 'inherit'
  });
}

export async function allocateFreePorts(count, host = '127.0.0.1') {
  const servers = [];
  const ports = [];
  try {
    for (let i = 0; i < count; i++) {
      const srv = net.createServer();
      await new Promise((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(0, host, () => resolve());
      });
      servers.push(srv);
      const addr = srv.address();
      ports.push(typeof addr === 'object' && addr ? addr.port : 0);
    }
  } finally {
    await Promise.all(
      servers.map(
        (srv) =>
          new Promise((resolve) => {
            srv.close(() => resolve());
          })
      )
    );
  }
  return ports;
}

export async function allocateFreePort(host = '127.0.0.1') {
  const [port] = await allocateFreePorts(1, host);
  return port;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

export function getChromeExecutablePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const platform = os.platform();
  const candidates =
    platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
        ]
      : platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const found = candidates.find((p) => fs.existsSync(p));
  if (found) return found;
  if (typeof puppeteer.executablePath === 'function') {
    const bundled = puppeteer.executablePath();
    if (bundled && fs.existsSync(bundled)) return bundled;
  }
  throw new Error(`No Chrome/Chromium executable found. Checked: ${candidates.join(', ')}`);
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function killProcessTree(pid) {
  if (!pid) return;
  try {
    if (os.platform() === 'win32') {
      execSync(`taskkill /pid ${pid} /f /t`, { stdio: 'ignore' });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {
    // Process may already have exited
  }
}

export async function injectE2ePageHooks(
  page,
  initialClockOffsetMs = 0,
  mqttBrokerUrl = null,
  { forceTurnRelay = process.env.FORCE_TURN_RELAY === '1' } = {}
) {
  await page.evaluateOnNewDocument(({ initOffset, brokerUrl, useForceTurn }) => {
    window.__TEST_FORCE_ALLOW_TURN__ = Boolean(useForceTurn);
    window.__SP27_E2E_FORCE_TURN_RELAY__ = Boolean(useForceTurn);

    if (brokerUrl) {
      try {
        localStorage.setItem('sp27-custom-broker', brokerUrl);
      } catch {}
    }

    try {
      const savedOffset = sessionStorage.getItem('__SP27_E2E_CLOCK_OFFSET_MS__');
      if (savedOffset !== null && savedOffset !== '') {
        const parsed = Number(savedOffset);
        if (Number.isFinite(parsed)) {
          window.__TEST_CLOCK_OFFSET_MS__ = parsed;
        }
      } else if (typeof initOffset === 'number' && initOffset !== 0) {
        sessionStorage.setItem('__SP27_E2E_CLOCK_OFFSET_MS__', String(initOffset));
        window.__TEST_CLOCK_OFFSET_MS__ = initOffset;
      }
    } catch {}

    if (useForceTurn) {
      const FALLBACK_TURN_SERVERS = [
        {
          urls: 'turn:global.relay.metered.ca:80',
          username: 'ac2f17ce5be760e70209a1da',
          credential: 'hnCbsBr54qxItqgo'
        },
        {
          urls: 'turn:global.relay.metered.ca:80?transport=tcp',
          username: 'ac2f17ce5be760e70209a1da',
          credential: 'hnCbsBr54qxItqgo'
        },
        {
          urls: 'turn:global.relay.metered.ca:443',
          username: 'ac2f17ce5be760e70209a1da',
          credential: 'hnCbsBr54qxItqgo'
        },
        {
          urls: 'turns:global.relay.metered.ca:443?transport=tcp',
          username: 'ac2f17ce5be760e70209a1da',
          credential: 'hnCbsBr54qxItqgo'
        }
      ];
      const OriginalRTCPeerConnection = window.RTCPeerConnection;
      window.RTCPeerConnection = function (config) {
        if (config) {
          config.iceTransportPolicy = 'relay';
          const existing = Array.isArray(config.iceServers) ? config.iceServers : [];
          const hasTurn = existing.some((s) => {
            const u = Array.isArray(s.urls) ? s.urls.join(',') : String(s.urls || '');
            return u.includes('turn:') || u.includes('turns:');
          });
          if (!hasTurn) {
            config.iceServers = [...existing, ...FALLBACK_TURN_SERVERS];
          }
        }
        return new OriginalRTCPeerConnection(config);
      };
      window.RTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
    }
  }, { initOffset: initialClockOffsetMs, brokerUrl: mqttBrokerUrl, useForceTurn: forceTurnRelay });
}

export class E2EClusterManager {
  constructor(runId = Date.now()) {
    this.runId = runId;
    this.tempDirs = [];
    this.backends = new Map();
    this.browsers = new Map();
    this.trackedPages = new Set();
    this.mqttClients = [];
    this.cdpSessions = [];
    this.staticServer = null;
    this.mqttBroker = null;
    this.cleaned = false;
  }

  async startLocalMqttBroker() {
    this.mqttBroker = await startInProcessMqttBroker('127.0.0.1', 0);
    console.log(`[Cluster] Local MQTT-over-WS broker listening at ${this.mqttBroker.url}`);
    return this.mqttBroker.url;
  }

  createTempDir(label) {
    const dir = path.join(os.tmpdir(), `sp27-e2e-${this.runId}-${label}`);
    fs.mkdirSync(dir, { recursive: true });
    if (!this.tempDirs.includes(dir)) {
      this.tempDirs.push(dir);
    }
    return dir;
  }

  registerMqttClient(client) {
    this.mqttClients.push(client);
    return client;
  }

  registerCdpSession(session) {
    this.cdpSessions.push(session);
    return session;
  }

  async startBackend({ name, port, tmpDir }) {
    if (!fs.existsSync(BACKEND_JAR_PATH)) {
      throw new Error(`Backend JAR not found at ${BACKEND_JAR_PATH}. Run mvn package -DskipTests first.`);
    }
    const dbUrl = `jdbc:h2:${tmpDir.replace(/\\/g, '/')}/app_data;AUTO_SERVER=FALSE;LOCK_TIMEOUT=15000`;
    const javaArgs = [
      '-DENABLE_TEST_CLEANUP=true',
      '-DSKIP_FIREWALL_CHECK=true',
      `-Dscouting.data.dir=${tmpDir}`,
      '-Dscouting.noAutoServer=true',
      '-jar',
      BACKEND_JAR_PATH,
      '--headless',
      '--no-auto-server',
      `--data-dir=${tmpDir}`
    ];

    console.log(`[Cluster] Starting backend "${name}" on port ${port} with isolated H2 dir: ${tmpDir}`);
    const proc = spawn('java', javaArgs, {
      cwd: tmpDir,
      detached: os.platform() !== 'win32',
      env: {
        ...process.env,
        DEV_PORT: String(port),
        SCOUTING_DATA_DIR: tmpDir,
        DB_URL: dbUrl,
        ENABLE_TEST_CLEANUP: 'true',
        SKIP_FIREWALL_CHECK: 'true'
      }
    });

    const entry = { name, port, tmpDir, proc, exited: false, exitPromise: null };
    entry.exitPromise = new Promise((resolve) => {
      proc.once('exit', (code) => {
        entry.exited = true;
        resolve(code);
      });
    });

    const logs = [];
    const appendLog = (chunk) => {
      const text = chunk.toString();
      logs.push(text);
      if (logs.length > 80) logs.shift();
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed && (trimmed.includes('ERROR') || trimmed.includes('Listening on') || trimmed.includes('Started'))) {
          console.log(`[Backend:${name}] ${trimmed}`);
        }
      }
    };
    proc.stdout.on('data', appendLog);
    proc.stderr.on('data', appendLog);

    this.backends.set(name, entry);

    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (entry.exited) {
        throw new Error(`Backend "${name}" exited prematurely during startup:\n${logs.join('')}`);
      }
      try {
        const res = await fetch(`http://localhost:${port}/index.html`);
        if (res.ok) {
          console.log(`[Cluster] ✅ Backend "${name}" is ready at http://localhost:${port}`);
          return entry;
        }
      } catch {}
      await delay(300);
    }
    throw new Error(`Backend "${name}" startup timed out after 60s:\n${logs.join('')}`);
  }

  async hardKillBackend(name) {
    const entry = this.backends.get(name);
    if (!entry) return;
    console.log(`[Cluster] 💥 Hard-killing backend "${name}" (pid: ${entry.proc.pid}) — preserving temp H2 at ${entry.tmpDir}`);
    killProcessTree(entry.proc.pid);
    await Promise.race([entry.exitPromise, delay(5000)]);
    this.backends.delete(name);
    await delay(350);
  }

  async gracefulStopBackend(name) {
    const entry = this.backends.get(name);
    if (!entry) return;
    console.log(`[Cluster] Gracefully shutting down backend "${name}" on port ${entry.port}...`);
    if (!entry.exited) {
      try {
        await fetch(`http://localhost:${entry.port}/api/test/shutdown`, { method: 'POST' });
      } catch {}
      await Promise.race([entry.exitPromise, delay(5000)]);
    }
    if (!entry.exited) {
      console.warn(`[Cluster] Graceful shutdown timed out for "${name}"; forcing kill.`);
      killProcessTree(entry.proc.pid);
      await Promise.race([entry.exitPromise, delay(3000)]);
    }
    this.backends.delete(name);
    await delay(350);
  }

  async startStaticClientServer(port = 0, host = '127.0.0.2') {
    if (!fs.existsSync(STATIC_PUBLIC_DIR)) {
      throw new Error(`Frontend dist missing at ${STATIC_PUBLIC_DIR}. Run npm run build first.`);
    }
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || '/', `http://${host}:${port}`);
      const pathname = decodeURIComponent(reqUrl.pathname);

      if (pathname.startsWith('/api/')) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!DOCTYPE html><html><body>404 Static Client Host</body></html>');
        return;
      }

      let relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      let filePath = path.resolve(STATIC_PUBLIC_DIR, relPath);
      if (!filePath.startsWith(path.resolve(STATIC_PUBLIC_DIR))) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(STATIC_PUBLIC_DIR, 'index.html');
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache'
      });
      fs.createReadStream(filePath).pipe(res);
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve());
    });
    this.staticServer = server;
    const addr = server.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : port;
    const baseUrl = `http://${host}:${actualPort}`;
    console.log(`[Cluster] Static client PWA server listening at ${baseUrl}`);
    return baseUrl;
  }

  clearPageErrors(pages = Array.from(this.trackedPages)) {
    for (const p of pages) {
      if (!p) continue;
      p.__sp27PageErrors = [];
      p.__sp27ConsoleErrors = [];
      p.__sp27Http5xx = [];
      p.__sp27FailedRequests = [];
    }
  }

  assertNoUnexpectedErrors(
    pages = Array.from(this.trackedPages),
    { allowConsolePatterns = [], allowPageErrorPatterns = [], allowHttp5xx = false } = {}
  ) {
    const matchesAny = (text, patterns) =>
      patterns.some((pat) => (pat instanceof RegExp ? pat.test(text) : String(text).includes(String(pat))));

    const failures = [];
    for (const p of pages) {
      if (!p) continue;
      const label = p.__sp27Name || 'page';
      for (const msg of p.__sp27PageErrors || []) {
        if (!matchesAny(msg, allowPageErrorPatterns)) {
          failures.push(`[${label}] uncaught pageerror: ${msg}`);
        }
      }
      for (const msg of p.__sp27ConsoleErrors || []) {
        const isExpectedStaticPwaFallback =
          p.__sp27IsStaticPwa &&
          (/the server responded with a status of 404 \(Not Found\)/i.test(msg) ||
            /WebSocket connection to 'ws:\/\/127\.0\.0\.2:/i.test(msg));
        if (!isExpectedStaticPwaFallback && !matchesAny(msg, allowConsolePatterns)) {
          failures.push(`[${label}] console.error: ${msg}`);
        }
      }
      if (!allowHttp5xx) {
        for (const item of p.__sp27Http5xx || []) {
          failures.push(`[${label}] HTTP ${item.status} on ${item.url}`);
        }
      }
    }
    if (failures.length > 0) {
      throw new Error(`Unexpected browser/server runtime errors (${failures.length}):\n  - ${failures.join('\n  - ')}`);
    }
  }

  async launchBrowser({ name, index = 0, userDataDir, showUi = false, extraSecureOrigin, initialClockOffsetMs = 0, forceTurnRelay }) {
    const width = 1280;
    const height = 860;
    const x = (index % 3) * 420;
    const y = index >= 3 ? 280 : 0;
    const chromeArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      `--window-size=${width},${height}`,
      ...(showUi ? [`--window-position=${x},${y}`] : []),
      ...(extraSecureOrigin ? [`--unsafely-treat-insecure-origin-as-secure=${extraSecureOrigin}`] : [])
    ];

    const browser = await puppeteer.launch({
      executablePath: getChromeExecutablePath(),
      headless: showUi ? false : 'new',
      userDataDir,
      args: chromeArgs,
      defaultViewport: { width, height }
    });

    this.browsers.set(name, { browser, userDataDir });
    const page = await browser.newPage();
    this.trackedPages.add(page);
    page.__sp27Name = name;
    page.__sp27IsStaticPwa = Boolean(extraSecureOrigin);
    page.__sp27PageErrors = [];
    page.__sp27ConsoleErrors = [];
    page.__sp27Http5xx = [];
    page.__sp27FailedRequests = [];
    const pendingRequests = new Set();
    page.__sp27PendingRequests = pendingRequests;
    page.on('request', (req) => {
      pendingRequests.add(req.url());
    });
    page.on('requestfinished', (req) => {
      pendingRequests.delete(req.url());
    });
    page.on('requestfailed', (req) => {
      pendingRequests.delete(req.url());
      page.__sp27FailedRequests.push({
        url: req.url(),
        errorText: req.failure()?.errorText || 'failed'
      });
    });
    page.on('response', (res) => {
      if (res.status() >= 500) {
        page.__sp27Http5xx.push({ url: res.url(), status: res.status() });
      }
    });
    page.on('console', (msg) => {
      const text = msg.text();
      const type = msg.type();
      if (type === 'error') {
        page.__sp27ConsoleErrors.push(text);
      }
      const isHeartbeatChatter =
        text.includes('PING') || text.includes('PONG') || text.includes('host_heartbeat');
      if (isHeartbeatChatter && type !== 'error' && type !== 'warning') {
        return;
      }
      if (
        type === 'error' ||
        type === 'warning' ||
        text.includes('[CRDT:') ||
        text.includes('[ClockSync]') ||
        text.includes('[Epoch') ||
        text.includes('[Room') ||
        text.includes('[WebRTC:Host]') ||
        text.includes('[WebRTC:Client]') ||
        text.includes('[WebRTC:Signaling]') ||
        text.includes('[WEBRTC-MOCK]') ||
        text.includes('SAS') ||
        text.includes('ERROR') ||
        text.includes('Security')
      ) {
        console.log(`[${name}:${type}] ${text}`);
      }
    });
    page.on('pageerror', (err) => {
      page.__sp27PageErrors.push(err?.message || String(err));
      console.error(`[${name}:PageError] ${err.message}`);
    });
    await injectE2ePageHooks(page, initialClockOffsetMs, this.mqttBroker?.url || null, { forceTurnRelay });
    return { browser, page };
  }

  async closeBrowser(name, { gracefulDisconnect = true } = {}) {
    const entry = this.browsers.get(name);
    if (!entry) return;
    const { browser } = entry;
    const pid = browser?.process()?.pid;
    if (gracefulDisconnect) {
      try {
        const pages = await browser.pages().catch(() => []);
        await Promise.all(
          pages.map(async (p) => {
            this.trackedPages.delete(p);
            if (p.isClosed()) return;
            await Promise.race([
              p.evaluate(() => {
                window.__rtcDisconnect?.();
              }),
              delay(400)
            ]).catch(() => {});
          })
        );
        await delay(150);
      } catch {}
      await Promise.race([browser.close().catch(() => {}), delay(3000)]);
    } else {
      try {
        const pages = await browser.pages().catch(() => []);
        for (const p of pages) {
          this.trackedPages.delete(p);
        }
      } catch {}
    }
    killProcessTree(pid);
    this.browsers.delete(name);
    await delay(250);
  }

  async cleanupAll({ assertDeleted = true } = {}) {
    if (this.cleaned) return;
    this.cleaned = true;
    console.log('\n=== [Cluster] Cleaning up browsers, backends & temporary H2 dirs ===');

    for (const c of this.mqttClients) {
      try {
        c.end(true);
      } catch {}
    }

    for (const session of this.cdpSessions) {
      try {
        await session.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1
        });
        await session.detach();
      } catch {}
    }

    const browserNames = Array.from(this.browsers.keys());
    await Promise.all(browserNames.map((n) => this.closeBrowser(n)));

    const backendNames = Array.from(this.backends.keys());
    for (const bName of backendNames) {
      await this.gracefulStopBackend(bName);
    }

    if (this.staticServer) {
      await new Promise((resolve) => this.staticServer.close(() => resolve())).catch(() => {});
      this.staticServer = null;
    }

    if (this.mqttBroker) {
      await this.mqttBroker.close().catch(() => {});
      this.mqttBroker = null;
    }

    await delay(400);
    for (const dir of this.tempDirs) {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 250 });
      }
      if (assertDeleted) {
        assert.strictEqual(fs.existsSync(dir), false, `Temporary directory was NOT deleted cleanly: ${dir}`);
      }
    }
    console.log(`✅ [Cluster] Deleted and verified 0 remaining temp dirs (${this.tempDirs.length} checked).`);
  }
}
