import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPngFile } from './png-ico.js';

export function discoverBackendTestFiles(backendDir) {
  const testRoot = path.join(backendDir, 'src', 'test', 'java');
  const results = [];
  if (!fs.existsSync(testRoot)) return results;

  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith('Test.java')) results.push(full);
    }
  }
  visit(testRoot);
  return results;
}

export function parseSurefireXml(xmlText) {
  const suiteMatch = xmlText.match(/<testsuite\b([^>]*)>/);
  if (!suiteMatch) return null;
  const attrs = suiteMatch[1];
  const getAttr = (name) => {
    const m = attrs.match(new RegExp(`${name}="([^"]+)"`));
    return m ? m[1] : null;
  };
  return {
    name: getAttr('name') || 'unknown',
    tests: Number(getAttr('tests') || 0),
    failures: Number(getAttr('failures') || 0),
    errors: Number(getAttr('errors') || 0),
    skipped: Number(getAttr('skipped') || 0),
    hasHeadlessException: xmlText.includes('HeadlessException')
  };
}

export function runBackendUiAndSplashTests(ctx) {
  if (ctx._backendUiTestCache) return ctx._backendUiTestCache;

  const backendDir = path.join(ctx.repoRoot, 'Backend');
  const testFiles = discoverBackendTestFiles(backendDir);
  const splashTests = testFiles
    .map((f) => path.basename(f, '.java'))
    .filter((name) => /splash/i.test(name));

  const targetTestNames = [
    'AppIconMultiResTest',
    'TitleBarVisualRenderTest',
    'LogoHiDpiVisualRenderTest',
    'FullWindowRoundedRenderTest',
    'CustomTitleBarDragTest',
    ...splashTests
  ];

  const uniqueTargets = [...new Set(targetTestNames)];
  const mavenCmd = os.platform() === 'win32' ? 'mvn.cmd' : 'mvn';

  // Intentionally do NOT pass -Djava.awt.headless=true (Swing JWindow/JFrame requires GUI mode)
  const proc = spawnSync(
    mavenCmd,
    ['test', `-Dtest=${uniqueTargets.join(',')}`, '-DfailIfNoTests=false'],
    {
      cwd: backendDir,
      shell: os.platform() === 'win32',
      encoding: 'utf8',
      timeout: 180_000
    }
  );

  const surefireDir = path.join(backendDir, 'target', 'surefire-reports');
  const reports = [];
  if (fs.existsSync(surefireDir)) {
    for (const file of fs.readdirSync(surefireDir)) {
      if (!file.startsWith('TEST-') || !file.endsWith('.xml')) continue;
      const parsed = parseSurefireXml(fs.readFileSync(path.join(surefireDir, file), 'utf8'));
      if (parsed && uniqueTargets.some((t) => parsed.name.endsWith(t) || parsed.name.includes(t))) {
        reports.push(parsed);
      }
    }
  }

  // Copy %TEMP%/sp27-tests/*.png into screenshotsDir/desktop/ for visual gate inspection
  const sp27TestsDir = path.join(os.tmpdir(), 'sp27-tests');
  const copiedPngs = {};
  if (fs.existsSync(sp27TestsDir)) {
    const destDir = path.join(ctx.screenshotsDir, 'desktop');
    fs.mkdirSync(destDir, { recursive: true });
    for (const entry of fs.readdirSync(sp27TestsDir)) {
      if (!entry.toLowerCase().endsWith('.png')) continue;
      const src = path.join(sp27TestsDir, entry);
      const dst = path.join(destDir, entry);
      fs.copyFileSync(src, dst);
      copiedPngs[entry] = dst;
    }
  }

  const result = {
    exitCode: proc.status ?? 1,
    stdout: proc.stdout || '',
    stderr: proc.stderr || '',
    splashTestClasses: splashTests,
    reports,
    sp27TestsDir,
    copiedPngs
  };
  ctx._backendUiTestCache = result;
  return result;
}

export function findSplashRenderPngs(sp27TestsDir, copiedPngs = {}) {
  const candidates = new Map();
  for (const [name, full] of Object.entries(copiedPngs)) {
    if (/splash/i.test(name)) candidates.set(name, full);
  }
  if (fs.existsSync(sp27TestsDir)) {
    for (const name of fs.readdirSync(sp27TestsDir)) {
      if (/splash.*\.png$/i.test(name) && !candidates.has(name)) {
        candidates.set(name, path.join(sp27TestsDir, name));
      }
    }
  }
  return Array.from(candidates.entries()).map(([name, filePath]) => ({
    name,
    filePath,
    png: readPngFile(filePath)
  }));
}
