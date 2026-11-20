import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function isServerRunning(origin) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${origin}/index.html`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

export async function waitForServerDown(origin, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isServerRunning(origin))) return true;
    await delay(200);
  }
  return false;
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
    // Process already exited
  }
}

export async function startIsolatedServer({
  repoRoot,
  port,
  origin,
  skipBuild = false,
  skipBackendBuild = false
}) {
  const frontendDir = path.join(repoRoot, 'frontend');
  const backendDir = path.join(repoRoot, 'Backend');
  const mavenCmd = os.platform() === 'win32' ? 'mvn.cmd' : 'mvn';

  if (await isServerRunning(origin)) {
    const err = new Error(`Port ${port} is already occupied (${origin}). Use --port=<N> or --base-url=<url>.`);
    err.exitCode = 2;
    throw err;
  }

  if (!skipBuild) {
    console.log('[Server] Building frontend (`npm run build`)...');
    execSync('npm run build', { cwd: frontendDir, stdio: 'inherit' });
    if (!skipBackendBuild) {
      console.log('[Server] Syncing backend resources (`mvn process-resources -DskipTests`)...');
      execSync(`${mavenCmd} process-resources -DskipTests`, { cwd: backendDir, stdio: 'inherit' });
    }
  } else if (!skipBackendBuild) {
    // Even with --skip-build, do not force mvn if user explicitly passed --skip-build
    // (mirrors motion-and-sheet.e2e.js SKIP_BUILD=1 contract)
  }

  const tempDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp27-pitwall-db-'));
  const dbPathNormalized = path.join(tempDbDir, 'sp27_pitwall').replace(/\\/g, '/');
  const dbUrl = `jdbc:h2:${dbPathNormalized};LOCK_TIMEOUT=15000;AUTO_RECONNECT=TRUE`;

  console.log(`[Server] Starting isolated Javalin backend on ${origin} (DB: ${tempDbDir})...`);
  const args = [
    'exec:java',
    os.platform() === 'win32' ? '"-Dexec.mainClass=com.bear27570.app.Main"' : '-Dexec.mainClass=com.bear27570.app.Main',
    os.platform() === 'win32' ? '"-Dexec.args=--headless"' : '-Dexec.args=--headless',
    '-DENABLE_TEST_CLEANUP=true',
    '-DSKIP_FIREWALL_CHECK=true'
  ];

  const backendProcess = spawn(mavenCmd, args, {
    cwd: backendDir,
    detached: os.platform() !== 'win32',
    shell: os.platform() === 'win32',
    env: {
      ...process.env,
      DEV_PORT: String(port),
      DB_URL: dbUrl,
      ENABLE_TEST_CLEANUP: 'true',
      SKIP_FIREWALL_CHECK: 'true'
    }
  });

  const logs = [];
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`Backend failed to listen on ${origin} within 60s.\nLast logs:\n${logs.slice(-20).join('')}`));
        }
      }, 60000);

      const onData = (chunk) => {
        const s = chunk.toString();
        logs.push(s);
        if (logs.length > 200) logs.shift();
        if (!settled && (s.includes('Listening on http://') || s.includes('Javalin'))) {
          settled = true;
          clearTimeout(timeout);
          resolve();
        }
      };

      backendProcess.stdout.on('data', onData);
      backendProcess.stderr.on('data', onData);
      backendProcess.on('exit', (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`Backend exited prematurely with code ${code}.\nLogs:\n${logs.slice(-20).join('')}`));
        }
      });
    });

    // Poll HTTP readiness
    let ready = false;
    for (let i = 0; i < 30; i += 1) {
      if (await isServerRunning(origin)) {
        ready = true;
        break;
      }
      await delay(250);
    }
    if (!ready) {
      throw new Error(`Backend process started but HTTP endpoint ${origin}/index.html did not respond.`);
    }
  } catch (err) {
    killProcessTree(backendProcess.pid);
    try {
      fs.rmSync(tempDbDir, { recursive: true, force: true });
    } catch {
      // ignore temp lock on cleanup
    }
    throw err;
  }

  let cleanedUp = false;
  async function stop() {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      await fetch(`${origin}/api/test/cleanup`, { method: 'POST' }).catch(() => {});
    } catch {
      // ignore
    }
    killProcessTree(backendProcess.pid);
    await waitForServerDown(origin, 6000);
    try {
      fs.rmSync(tempDbDir, { recursive: true, force: true });
    } catch {
      // ignore locked H2 cleanup race
    }
  }

  return {
    origin,
    port,
    tempDbDir,
    pid: backendProcess.pid,
    stop
  };
}
