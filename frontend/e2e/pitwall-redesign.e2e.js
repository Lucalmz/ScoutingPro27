import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPitwallBrowser } from './pitwall/browser.js';
import { CliUsageError, formatCliHelp, parseCliArgs } from './pitwall/cli.js';
import {
  auditBrandSvg,
  auditSingleFileContent,
  contrastRatio,
  normalizeDurationMs,
  PITWALL_GRAPHITE
} from './pitwall/css-audit.js';
import {
  buildSyntheticIco,
  buildSyntheticRgbaPng,
  generateMultiScaleBrandPreview,
  isJpegBuffer,
  parseIco,
  parsePng,
  readPngFile
} from './pitwall/png-ico.js';
import { startIsolatedServer } from './pitwall/server.js';
import { TIER1_TESTS } from './pitwall/tier1-features.js';
import { TIER2_TESTS } from './pitwall/tier2-boundaries.js';
import { TIER3_TESTS } from './pitwall/tier3-combinations.js';
import { TIER4_TESTS } from './pitwall/tier4-scenarios.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');

const ALL_FEATURES = Array.from({ length: 15 }, (_, i) => `F${i + 1}`);

export function getAllTests() {
  return [...TIER1_TESTS, ...TIER2_TESTS, ...TIER3_TESTS, ...TIER4_TESTS];
}

export function validateRegistryIntegrity(tests) {
  const seenIds = new Set();
  const byTier = { 1: [], 2: [], 3: [], 4: [] };
  const tier1ByFeature = Object.fromEntries(ALL_FEATURES.map((f) => [f, 0]));
  const tier2ByFeature = Object.fromEntries(ALL_FEATURES.map((f) => [f, 0]));

  for (const t of tests) {
    if (!t || typeof t.id !== 'string' || !t.id.trim()) {
      throw new Error(`Invalid test id in registry: ${JSON.stringify(t)}`);
    }
    if (seenIds.has(t.id)) {
      throw new Error(`Duplicate test ID detected: ${t.id}`);
    }
    seenIds.add(t.id);

    if (![1, 2, 3, 4].includes(t.tier)) {
      throw new Error(`Test ${t.id} has invalid tier: ${t.tier}`);
    }
    if (!t.feature || typeof t.feature !== 'string') {
      throw new Error(`Test ${t.id} missing feature`);
    }
    if (!t.title || typeof t.title !== 'string') {
      throw new Error(`Test ${t.id} missing title`);
    }
    if (typeof t.run !== 'function') {
      throw new Error(`Test ${t.id} missing run(ctx) function`);
    }

    byTier[t.tier].push(t);
    if (t.tier === 1 && t.feature in tier1ByFeature) tier1ByFeature[t.feature] += 1;
    if (t.tier === 2 && t.feature in tier2ByFeature) tier2ByFeature[t.feature] += 1;
  }

  const errors = [];
  if (byTier[1].length < 75) errors.push(`Tier 1 count ${byTier[1].length} < 75`);
  if (byTier[2].length < 75) errors.push(`Tier 2 count ${byTier[2].length} < 75`);
  if (byTier[3].length < 15) errors.push(`Tier 3 count ${byTier[3].length} < 15`);
  if (byTier[4].length < 8) errors.push(`Tier 4 count ${byTier[4].length} < 8`);
  if (tests.length < 173) errors.push(`Total count ${tests.length} < 173`);

  for (const f of ALL_FEATURES) {
    if (tier1ByFeature[f] < 5) errors.push(`Tier 1 feature ${f} has ${tier1ByFeature[f]} tests (< 5)`);
    if (tier2ByFeature[f] < 5) errors.push(`Tier 2 feature ${f} has ${tier2ByFeature[f]} tests (< 5)`);
  }

  if (errors.length > 0) {
    throw new Error(`Registry validation failed:\n - ${errors.join('\n - ')}`);
  }

  return {
    total: tests.length,
    countsByTier: {
      1: byTier[1].length,
      2: byTier[2].length,
      3: byTier[3].length,
      4: byTier[4].length
    },
    tier1ByFeature,
    tier2ByFeature
  };
}

function runDryRunHelperSelfTests() {
  const checks = [];

  // 1. CLI self-tests
  const parsed = parseCliArgs(['--tier=2', '--port=7091', '--headless=false', '--skip-build'], {});
  if (parsed.tier !== '2' || parsed.port !== 7091 || parsed.headless !== false || !parsed.skipBuild) {
    throw new Error(`CLI parse self-test failed: ${JSON.stringify(parsed)}`);
  }
  let invalidRejected = false;
  try {
    parseCliArgs(['--tier=9'], {});
  } catch (err) {
    invalidRejected = err?.exitCode === 2;
  }
  if (!invalidRejected) {
    throw new Error('CLI did not reject --tier=9 with exitCode=2');
  }
  checks.push('cli.parseCliArgs');

  // 2. PNG & ICO pure-Node decoder self-tests (in-memory + isolated tmpdir)
  const synPngBuf = buildSyntheticRgbaPng(16, 16, (x, y) =>
    (x === 0 || y === 0 || x === 15 || y === 15) ? [0, 0, 0, 0] : [0x39, 0xff, 0x14, 0xff]
  );
  const decoded = parsePng(synPngBuf);
  if (decoded.width !== 16 || decoded.height !== 16 || decoded.colorType !== 6) {
    throw new Error(`PNG round-trip failed: ${JSON.stringify(decoded)}`);
  }
  if (!decoded.inspectBorder(1).allCornersTransparent || decoded.sampleStats().pitGreenCount < 100) {
    throw new Error('PNG pixel/corner alpha self-test failed');
  }
  const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  if (!isJpegBuffer(fakeJpeg)) {
    throw new Error('JPEG magic detector failed');
  }
  let jpegRejected = false;
  try {
    parsePng(fakeJpeg);
  } catch {
    jpegRejected = true;
  }
  if (!jpegRejected) {
    throw new Error('parsePng did not reject fake JPEG buffer');
  }
  const synIcoBuf = buildSyntheticIco([16, 20, 24, 32, 40, 48, 64, 128, 256]);
  const ico = parseIco(synIcoBuf);
  if (ico.count !== 9 || !ico.entries.every((e) => e.bpp === 32 && e.isPng)) {
    throw new Error(`ICO self-test failed: ${JSON.stringify(ico)}`);
  }

  // 2b. Reject 0x0 PNG and garbage non-PNG/non-DIB ICO entry
  const zeroPng = Buffer.from(synPngBuf);
  zeroPng.writeUInt32BE(0, 16); // IHDR width = 0
  zeroPng.writeUInt32BE(0, 20); // IHDR height = 0
  let zeroDimRejected = false;
  try {
    parsePng(zeroPng);
  } catch {
    zeroDimRejected = true;
  }
  if (!zeroDimRejected) {
    throw new Error('parsePng did not reject 0x0 PNG dimensions');
  }
  const garbageIco = Buffer.alloc(6 + 16 + 16);
  garbageIco.writeUInt16LE(0, 0);
  garbageIco.writeUInt16LE(1, 2);
  garbageIco.writeUInt16LE(1, 4);
  garbageIco[6] = 16;
  garbageIco[7] = 16;
  garbageIco.writeUInt16LE(1, 10);
  garbageIco.writeUInt16LE(32, 12);
  garbageIco.writeUInt32LE(16, 14);
  garbageIco.writeUInt32LE(22, 18);
  garbageIco.write('NOT_PNG_OR_DIB!!', 22, 'ascii');
  let garbageIcoRejected = false;
  try {
    parseIco(garbageIco);
  } catch {
    garbageIcoRejected = true;
  }
  if (!garbageIcoRejected) {
    throw new Error('parseIco did not reject non-PNG/non-DIB garbage entry');
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp27-dryrun-'));
  try {
    const pngPath = path.join(tmpDir, 'logo.png');
    fs.writeFileSync(pngPath, synPngBuf);
    const previewPath = generateMultiScaleBrandPreview(path.join(tmpDir, 'preview.png'), {
      logo512Path: pngPath,
      logo128Path: pngPath,
      logo32Path: pngPath,
      logo24Path: pngPath,
      logoBearPath: pngPath
    });
    const previewPng = readPngFile(previewPath);
    if (previewPng.width !== 920 || previewPng.height !== 600) {
      throw new Error('Multi-scale preview generator produced wrong dimensions');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  checks.push('png-ico.parsePng/parseIco/preview');

  // 3. CSS & SVG audit self-tests
  const cleanMainCss = `
:root { --g-900: #0B0E10; --primary: #39FF14; }
select { background-image: url("data:image/svg+xml,%3Csvg stroke='%2397A2AB'%3E%3C/svg%3E"); }
select:focus { background-image: url("data:image/svg+xml,%3Csvg stroke='%2339FF14'%3E%3C/svg%3E"); }
`;
  const cleanRes = auditSingleFileContent('assets/main.css', cleanMainCss);
  if (cleanRes.legacyHexes.length || cleanRes.unallowlistedHexes.length || cleanRes.badChevrons.length) {
    throw new Error(`Clean Pit Wall main.css flagged false positives: ${JSON.stringify(cleanRes)}`);
  }
  const dirtyMainCss = `
:root { --background: #0c0c0b; }
select { background-image: url("data:image/svg+xml,%3Csvg stroke='%238e8d87'%3E%3C/svg%3E"); }
.card { background: #141413; box-shadow: 0 0 12px #39ff14; transition: all 0.85s; font-family: ZCOOLQingKeHuangYou; }
`;
  const dirtyRes = auditSingleFileContent('assets/main.css', dirtyMainCss);
  if (
    !dirtyRes.legacyHexes.length ||
    !dirtyRes.badChevrons.length ||
    !dirtyRes.unapprovedGlows.length ||
    !dirtyRes.legacyDurations.length ||
    !dirtyRes.legacyFonts.length
  ) {
    throw new Error(`Dirty CSS audit missed violations: ${JSON.stringify(dirtyRes)}`);
  }
  const canvasAllow = auditSingleFileContent(
    'components/whiteboard/WhiteboardFieldCanvas.vue',
    `<template><canvas /></template><script setup>ctx.fillStyle = '#39ff14';</script><style scoped>.x { color: var(--g-100); }</style>`
  );
  if (canvasAllow.unallowlistedHexes.length > 0) {
    throw new Error('WhiteboardFieldCanvas Canvas 2D script triggered false positive');
  }
  const canvasStyleFlag = auditSingleFileContent(
    'components/whiteboard/WhiteboardFieldCanvas.vue',
    `<template><canvas /></template><script setup>ctx.fillStyle = '#39ff14';</script><style scoped>.x { border-color: #ABCDEF; }</style>`
  );
  if (!canvasStyleFlag.unallowlistedHexes.includes('#abcdef')) {
    throw new Error(`WhiteboardFieldCanvas <style scoped> hex missed: ${JSON.stringify(canvasStyleFlag)}`);
  }

  // Nested <template> extraction test
  const nestedTplRes = auditSingleFileContent(
    'components/NestedTpl.vue',
    `<template><div><template v-if="ok"><span>a</span></template><div style="color: #123456">b</div></div></template><style scoped>.b{color:var(--g-100);}</style>`
  );
  if (!nestedTplRes.unallowlistedHexes.includes('#123456')) {
    throw new Error(`Nested <template> hex after inner </template> missed: ${JSON.stringify(nestedTplRes)}`);
  }

  // :root with comment containing '}', nested {}, and :root, :host + ;charset=utf-8, / 3-digit %23abc deduplication
  const rootAndChevronCss = `
:root, :host { /* comment } */ --g-900: #0B0E10; &.nested { --x: #07090A; } --primary: #39FF14; }
select { background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg stroke='%238e8d87'%3E%3Cpath fill='%23abc'/%3E%3C/svg%3E"); }
`;
  const rootAndChevronRes = auditSingleFileContent('assets/main.css', rootAndChevronCss);
  if (rootAndChevronRes.unallowlistedHexes.length > 0) {
    throw new Error(`:root exclusion failed on comment/nested/:host: ${JSON.stringify(rootAndChevronRes)}`);
  }
  if (
    rootAndChevronRes.badChevrons.length !== 2 ||
    !rootAndChevronRes.badChevrons.includes('%238e8d87') ||
    !rootAndChevronRes.badChevrons.includes('%23abc')
  ) {
    throw new Error(`Chevron URI audit/dedup failed: ${JSON.stringify(rootAndChevronRes.badChevrons)}`);
  }

  // box-shadow 0 0 0 3px vs 0px 0px 12px, multi-line 0.5rem, .card-pulse vs .status-dot
  const glowAuditRes = auditSingleFileContent(
    'views/GlowTest.vue',
    `<template><div /></template><style scoped>
.ring-only { box-shadow: 0 0 0 3px var(--primary); }
.px-glow { box-shadow: 0px 0px 12px var(--primary); }
.rem-glow {
  box-shadow:
    0 0 0.5rem rgba(57, 255, 20, 0.4);
}
.card-pulse { box-shadow: 0 0 10px var(--primary); }
.status-dot { box-shadow: 0 0 8px var(--primary); }
.inp:focus-visible { box-shadow: 0 0 0 4px rgba(57, 255, 20, 0.18); }
</style>`
  );
  if (glowAuditRes.unapprovedGlows.length !== 3) {
    throw new Error(`box-shadow glow audit expected 3 violations (.px-glow, .rem-glow, .card-pulse), got: ${JSON.stringify(glowAuditRes.unapprovedGlows)}`);
  }

  // Canonical PITWALL_GRAPHITE check
  if (
    PITWALL_GRAPHITE['--g-700'] !== '#232a30' ||
    PITWALL_GRAPHITE['--g-500'] !== '#4b5660' ||
    PITWALL_GRAPHITE['--g-400'] !== '#6e7a84' ||
    PITWALL_GRAPHITE['--g-200'] !== '#c3cbd1'
  ) {
    throw new Error(`PITWALL_GRAPHITE mismatch: ${JSON.stringify(PITWALL_GRAPHITE)}`);
  }

  const badSvg = auditBrandSvg('<svg viewBox="0 0 600 600"><filter id="neon-glow"></filter><g class="surrounding-honeycomb"></g></svg>');
  const draft1ReticleSvg = auditBrandSvg(
    `<svg viewBox="0 0 64 64" fill="none">
      <polygon points="10.5,0.5 53.5,0.5 63.5,10.5 63.5,53.5 53.5,63.5 10.5,63.5 0.5,53.5 0.5,10.5" fill="#0B0E10"/>
      <polygon points="12.5,6 51.5,6 58,12.5 58,51.5 51.5,58 12.5,58 6,51.5 6,12.5" stroke="#1B2126"/>
      <polygon points="11,2.5 53,2.5 61.5,11 61.5,53 53,61.5 11,61.5 2.5,53 2.5,11" stroke="#24661A"/>
      <path d="M32,1 L32,5.5 M32,58.5 L32,63 M1,32 L5.5,32 M58.5,32 L63,32" stroke="#39FF14"/>
    </svg>`
  );
  const draft1PolygonOnlySvg = auditBrandSvg(
    `<svg viewBox="0 0 64 64" fill="none">
      <polygon points="10.5,0.5 53.5,0.5 63.5,10.5 63.5,53.5 53.5,63.5 10.5,63.5 0.5,53.5 0.5,10.5" fill="#0B0E10"/>
      <polygon points="12.5,6 51.5,6 58,12.5 58,51.5 51.5,58 12.5,58 6,51.5 6,12.5" stroke="#1B2126"/>
      <polygon points="11,2.5 53,2.5 61.5,11 61.5,53 53,61.5 11,61.5 2.5,53 2.5,11" stroke="#39FF14"/>
    </svg>`
  );
  const draft1PolylineSvg = auditBrandSvg(
    `<svg viewBox="0 0 64 64" fill="none">
      <polyline points="10.5,0.5 53.5,0.5 63.5,10.5 63.5,53.5 53.5,63.5 10.5,63.5 0.5,53.5 0.5,10.5 10.5,0.5" fill="#0B0E10"/>
      <polyline points="12.5,6 51.5,6 58,12.5 58,51.5 51.5,58 12.5,58 6,51.5 6,12.5 12.5,6" stroke="#1B2126"/>
      <polyline points="11,2.5 53,2.5 61.5,11 61.5,53 53,61.5 11,61.5 2.5,53 2.5,11 11,2.5" stroke="#39FF14"/>
    </svg>`
  );
  const draft1PathSeparatedSvg = auditBrandSvg(
    `<svg viewBox="0 0 64 64" fill="none">
      <path d="M10.5,0.5 H53.5 L63.5,10.5 V53.5 L53.5,63.5 H10.5 L0.5,53.5 V10.5 Z" fill="#0B0E10"/>
      <path d="m12.5,6 h39 l6.5,6.5 v39 l-6.5,6.5 h-39 l-6.5,-6.5 v-39 z" stroke="#1B2126"/>
      <path d="M11,2.5 L53,2.5 L61.5,11 L61.5,53 L53,61.5 L11,61.5 L2.5,53 L2.5,11 Z" stroke="#39FF14"/>
    </svg>`
  );
  const draft1MultiSubpathSvg = auditBrandSvg(
    `<svg viewBox="0 0 64 64" fill="none">
      <path d="M10.5,0.5 H53.5 L63.5,10.5 V53.5 L53.5,63.5 H10.5 L0.5,53.5 V10.5 Z M11,2.5 H53 L61.5,11 V53 L53,61.5 H11 L2.5,53 V11 Z M12.5,6 H51.5 L58,12.5 V51.5 L51.5,58 H12.5 L6,51.5 V12.5 Z" fill="#0B0E10" stroke="#39FF14"/>
    </svg>`
  );
  const goodSvg = auditBrandSvg('<svg viewBox="0 0 600 600"><rect fill="#0B0E10"/><path fill="#39FF14" d="M0 0"/></svg>');
  const goodSingleQuoteSvg = auditBrandSvg("<svg viewBox='0 0 64 64' fill='none'><path fill='#39FF14' d='M8 8h48v48H8z'/></svg>");
  const goodImplicitSvg = auditBrandSvg('<svg viewBox="0 0 64 64"><polygon points="8,0 56,0 64,8 64,56 56,64 8,64 0,56 0,8" fill="#0B0E10"/><polygon points="12,12 20,12 20,20 12,20" fill="#39FF14"/><polygon points="22,12 30,12 30,20 22,20" fill="#39FF14"/><polygon points="32,12 40,12 40,20 32,20" fill="#39FF14"/></svg>');
  const goodNonConcentricOctagonsSvg = auditBrandSvg(
    `<svg viewBox="0 0 120 40" fill="none">
      <polygon points="8,2 22,2 28,8 28,22 22,28 8,28 2,22 2,8" fill="#0B0E10"/>
      <polygon points="48,2 62,2 68,8 68,22 62,28 48,28 42,22 42,8" stroke="#232A30"/>
      <polygon points="88,2 102,2 108,8 108,22 102,28 88,28 82,22 82,8" stroke="#39FF14"/>
    </svg>`
  );
  const goodTwoRingDupStrokeSvg = auditBrandSvg(
    `<svg viewBox="0 0 64 64" fill="none">
      <path d="M12,2 L52,2 L62,12 L62,52 L52,62 L12,62 L2,52 L2,12 Z" fill="#0B0E10"/>
      <path d="M12,2 L52,2 L62,12 L62,52 L52,62 L12,62 L2,52 L2,12 Z" stroke="#232A30"/>
      <path d="M16,6 L48,6 L58,16 L58,48 L48,58 L16,58 L6,48 L6,16 Z" stroke="#39FF14"/>
    </svg>`
  );
  const realIconSvg = auditBrandSvg(fs.readFileSync(path.join(REPO_ROOT, 'frontend/public/icon.svg'), 'utf8'));
  const realFaviconSvg = auditBrandSvg(fs.readFileSync(path.join(REPO_ROOT, 'frontend/public/favicon.svg'), 'utf8'));
  if (
    badSvg.ok ||
    draft1ReticleSvg.ok ||
    !draft1PolygonOnlySvg.hasDraft1Reticle ||
    draft1PolygonOnlySvg.ok ||
    !draft1PolylineSvg.hasDraft1Reticle ||
    draft1PolylineSvg.ok ||
    !draft1PathSeparatedSvg.hasDraft1Reticle ||
    draft1PathSeparatedSvg.ok ||
    !draft1MultiSubpathSvg.hasDraft1Reticle ||
    draft1MultiSubpathSvg.ok ||
    !goodSvg.ok ||
    !goodSingleQuoteSvg.ok ||
    !goodImplicitSvg.ok ||
    !goodNonConcentricOctagonsSvg.ok ||
    !goodTwoRingDupStrokeSvg.ok ||
    !realIconSvg.ok ||
    realIconSvg.hasDraft1Reticle ||
    !realFaviconSvg.ok ||
    realFaviconSvg.hasDraft1Reticle
  ) {
    throw new Error(
      `SVG audit self-test failed: bad=${JSON.stringify(badSvg)}, draft1=${JSON.stringify(draft1ReticleSvg)}, poly=${JSON.stringify(draft1PolygonOnlySvg)}, polyline=${JSON.stringify(draft1PolylineSvg)}, pathSep=${JSON.stringify(draft1PathSeparatedSvg)}, multiSub=${JSON.stringify(draft1MultiSubpathSvg)}, good=${JSON.stringify(goodSvg)}, sq=${JSON.stringify(goodSingleQuoteSvg)}, imp=${JSON.stringify(goodImplicitSvg)}, nonCon=${JSON.stringify(goodNonConcentricOctagonsSvg)}, twoRing=${JSON.stringify(goodTwoRingDupStrokeSvg)}, icon=${JSON.stringify(realIconSvg)}, favicon=${JSON.stringify(realFaviconSvg)}`
    );
  }
  if (contrastRatio('#E6EBEE', '#0B0E10') < 15 || normalizeDurationMs('160ms') !== 160) {
    throw new Error('Contrast / duration helper self-test failed');
  }
  checks.push('css-audit.rules/allowlists/svg');

  return checks;
}

function writeReport(reportPath, payload) {
  if (!reportPath) return;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(payload, null, 2));
}

async function main() {
  let opts;
  try {
    opts = parseCliArgs(process.argv.slice(2), process.env);
  } catch (err) {
    console.error(`[CLI Error] ${err.message}`);
    process.exit(err instanceof CliUsageError ? err.exitCode : 2);
  }

  if (opts.help) {
    console.log(formatCliHelp());
    process.exit(0);
  }

  const allTests = getAllTests();
  const registryStats = validateRegistryIntegrity(allTests);
  const selectedTests =
    opts.tier === 'all' ? allTests : allTests.filter((t) => String(t.tier) === opts.tier);

  console.log('======================================================================');
  console.log('ScoutingPro27 Pit Wall Redesign — 4-Tier Puppeteer E2E Verification');
  console.log('======================================================================');
  console.log(
    `Registry: Total=${registryStats.total} (T1=${registryStats.countsByTier[1]}, T2=${registryStats.countsByTier[2]}, T3=${registryStats.countsByTier[3]}, T4=${registryStats.countsByTier[4]})`
  );
  console.log(`Selected Tier=${opts.tier} (${selectedTests.length} test(s)), DryRun=${opts.dryRun}`);

  if (opts.dryRun) {
    const selfChecks = runDryRunHelperSelfTests();
    console.log(`Dry-run self-checks passed: ${selfChecks.join(', ')}`);
    console.log('Dry-run execution plan (no builds, no Maven, no Chrome launched):');
    for (const t of selectedTests.slice(0, 10)) {
      console.log(`  - [${t.id}] (${t.feature}) ${t.title}`);
    }
    if (selectedTests.length > 10) {
      console.log(`  ... and ${selectedTests.length - 10} more test(s)`);
    }
    writeReport(opts.reportPath, {
      mode: 'dry-run',
      tier: opts.tier,
      registryStats,
      selectedCount: selectedTests.length,
      selfChecks,
      passed: true
    });
    process.exit(0);
  }

  let serverHandle = null;
  let browserHandle = null;

  const cleanup = async () => {
    if (browserHandle) {
      await browserHandle.close().catch(() => {});
      browserHandle = null;
    }
    if (serverHandle) {
      await serverHandle.stop().catch(() => {});
      serverHandle = null;
    }
  };

  const onSignal = async (sig) => {
    console.error(`\nReceived ${sig}, cleaning up browser & backend...`);
    await cleanup();
    process.exit(1);
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  const results = [];
  let passedCount = 0;
  let failedCount = 0;

  try {
    const userProvidedBaseUrl = process.argv.some((a) => a.startsWith('--base-url'));
    if (!userProvidedBaseUrl) {
      serverHandle = await startIsolatedServer({
        repoRoot: REPO_ROOT,
        port: opts.port,
        origin: opts.origin,
        skipBuild: opts.skipBuild,
        skipBackendBuild: opts.skipBackendBuild
      });
    } else {
      console.log(`[Server] Attaching to external --base-url=${opts.baseUrl}`);
    }

    browserHandle = await launchPitwallBrowser({ headless: opts.headless });
    console.log(`[Browser] Chrome launched: ${browserHandle.executablePath}`);
    console.log(`[Screenshots] Output directory: ${opts.screenshotsDir}`);

    const ctx = {
      repoRoot: REPO_ROOT,
      baseUrl: opts.baseUrl,
      origin: opts.origin,
      screenshotsDir: opts.screenshotsDir,
      browserHandle
    };

    for (const testCase of selectedTests) {
      const started = Date.now();
      try {
        const out = (await testCase.run(ctx)) || {};
        const durationMs = Date.now() - started;
        passedCount += 1;
        results.push({
          id: testCase.id,
          tier: testCase.tier,
          feature: testCase.feature,
          title: testCase.title,
          passed: true,
          durationMs,
          detail: out.detail || ''
        });
        console.log(`  [PASS] ${testCase.id} (${durationMs}ms) — ${out.detail || testCase.title}`);
      } catch (err) {
        const durationMs = Date.now() - started;
        failedCount += 1;
        results.push({
          id: testCase.id,
          tier: testCase.tier,
          feature: testCase.feature,
          title: testCase.title,
          passed: false,
          durationMs,
          error: err?.message || String(err)
        });
        console.error(`  [FAIL] ${testCase.id} (${durationMs}ms) — ${err?.message || err}`);
      }
    }

    const runtimeErrors = browserHandle.runtimeErrors;
    if (runtimeErrors.pageErrors.length > 0 || runtimeErrors.consoleErrors.length > 0) {
      failedCount += 1;
      console.error('[FAIL] Runtime browser pageerror / console.error detected:', runtimeErrors);
    }

    const summary = {
      mode: 'live',
      tier: opts.tier,
      baseUrl: opts.baseUrl,
      screenshotsDir: opts.screenshotsDir,
      registryStats,
      executed: selectedTests.length,
      passedCount,
      failedCount,
      runtimeErrors,
      results
    };
    writeReport(opts.reportPath, summary);

    console.log('----------------------------------------------------------------------');
    console.log(`Completed: ${passedCount} passed, ${failedCount} failed (out of ${selectedTests.length})`);
    process.exitCode = failedCount === 0 ? 0 : 1;
  } catch (err) {
    console.error(`[Fatal Error] ${err?.message || err}`);
    process.exitCode = err?.exitCode || 1;
  } finally {
    await cleanup();
  }
}

main();
