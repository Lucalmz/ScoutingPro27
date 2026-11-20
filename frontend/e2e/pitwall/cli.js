import os from 'node:os';
import path from 'node:path';

export class CliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliUsageError';
    this.exitCode = 2;
  }
}

const VALID_TIERS = new Set(['1', '2', '3', '4', 'all']);

export function normalizeBaseUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new CliUsageError(`Invalid --base-url value: "${rawUrl}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CliUsageError(`--base-url must use http:// or https://, got "${rawUrl}"`);
  }
  const origin = parsed.origin;
  const pathname = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
  const entryUrl = `${origin}${pathname}${parsed.search}${parsed.hash}`;
  return { origin, entryUrl };
}

export function parseCliArgs(argv = process.argv.slice(2), env = process.env) {
  const opts = {
    tier: 'all',
    dryRun: false,
    baseUrl: null,
    origin: null,
    skipBuild: env.SKIP_BUILD === '1',
    skipBackendBuild: false,
    port: env.PITWALL_E2E_PORT ? Number(env.PITWALL_E2E_PORT) : 7089,
    headless: env.SHOW_UI === '1' ? false : true,
    screenshotsDir: path.join(os.tmpdir(), 'sp27-pitwall-screenshots'),
    reportPath: null,
    help: false
  };

  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    throw new CliUsageError(`Invalid PITWALL_E2E_PORT: "${env.PITWALL_E2E_PORT}"`);
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }

    if (arg === '--all') {
      opts.tier = 'all';
      continue;
    }

    if (arg === '--dry-run') {
      opts.dryRun = true;
      continue;
    }

    if (arg === '--skip-build') {
      opts.skipBuild = true;
      continue;
    }

    if (arg === '--skip-backend-build') {
      opts.skipBackendBuild = true;
      continue;
    }

    if (arg.startsWith('--tier=')) {
      const value = arg.slice('--tier='.length).trim();
      if (!VALID_TIERS.has(value)) {
        throw new CliUsageError(`Invalid --tier="${value}". Expected 1|2|3|4|all.`);
      }
      opts.tier = value;
      continue;
    }

    if (arg === '--tier') {
      const next = argv[++i];
      if (!next || !VALID_TIERS.has(next.trim())) {
        throw new CliUsageError(`Invalid --tier "${next ?? ''}". Expected 1|2|3|4|all.`);
      }
      opts.tier = next.trim();
      continue;
    }

    if (arg.startsWith('--base-url=')) {
      const raw = arg.slice('--base-url='.length).trim();
      const normalized = normalizeBaseUrl(raw);
      opts.baseUrl = normalized.entryUrl;
      opts.origin = normalized.origin;
      opts.skipBuild = true;
      continue;
    }

    if (arg === '--base-url') {
      const raw = argv[++i];
      if (!raw) throw new CliUsageError('Missing value for --base-url');
      const normalized = normalizeBaseUrl(raw.trim());
      opts.baseUrl = normalized.entryUrl;
      opts.origin = normalized.origin;
      opts.skipBuild = true;
      continue;
    }

    if (arg.startsWith('--port=')) {
      const rawPort = arg.slice('--port='.length).trim();
      const port = Number(rawPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new CliUsageError(`Invalid --port="${rawPort}". Expected integer 1..65535.`);
      }
      opts.port = port;
      continue;
    }

    if (arg.startsWith('--headless=')) {
      const val = arg.slice('--headless='.length).trim().toLowerCase();
      if (val !== 'true' && val !== 'false') {
        throw new CliUsageError(`Invalid --headless="${val}". Expected true|false.`);
      }
      opts.headless = val === 'true';
      continue;
    }

    if (arg.startsWith('--screenshots-dir=')) {
      const val = arg.slice('--screenshots-dir='.length).trim();
      if (!val) throw new CliUsageError('Missing path for --screenshots-dir=');
      opts.screenshotsDir = path.resolve(val);
      continue;
    }

    if (arg.startsWith('--report=')) {
      const val = arg.slice('--report='.length).trim();
      if (!val) throw new CliUsageError('Missing path for --report=');
      opts.reportPath = path.resolve(val);
      continue;
    }

    throw new CliUsageError(`Unknown CLI argument: "${arg}"`);
  }

  if (!opts.origin) {
    opts.origin = `http://localhost:${opts.port}`;
    opts.baseUrl = `${opts.origin}/index.html`;
  }

  return opts;
}

export function formatCliHelp() {
  return [
    'ScoutingPro27 Pit Wall 4-Tier E2E Runner',
    '',
    'Usage: node frontend/e2e/pitwall-redesign.e2e.js [options]',
    '',
    'Options:',
    '  --tier=1|2|3|4|all      Select tier to execute (default: all)',
    '  --all                   Alias for --tier=all',
    '  --dry-run               Validate registry counts & run pure-Node self-checks without builds/Chrome',
    '  --base-url=<url>        Attach to running server (skips builds and backend spawn)',
    '  --skip-build            Skip npm run build and mvn process-resources (or SKIP_BUILD=1)',
    '  --skip-backend-build    Skip mvn process-resources before launch',
    '  --port=<N>              Isolated backend DEV_PORT (default: 7089 or PITWALL_E2E_PORT)',
    '  --headless=true|false   Puppeteer headless mode (default: true; SHOW_UI=1 -> false)',
    '  --screenshots-dir=<dir> Output directory for visual quality-gate PNGs',
    '  --report=<path>         Write structured JSON summary report',
    '  --help, -h              Show this help message'
  ].join('\n');
}
