import fs from 'node:fs';
import path from 'node:path';

export const PITWALL_GRAPHITE = {
  '--g-950': '#07090a',
  '--g-900': '#0b0e10',
  '--g-850': '#101417',
  '--g-800': '#151a1e',
  '--g-750': '#1b2126',
  '--g-700': '#232a30',
  '--g-650': '#2c353c',
  '--g-600': '#39444e',
  '--g-500': '#4b5660',
  '--g-400': '#6e7a84',
  '--g-300': '#97a2ab',
  '--g-200': '#c3cbd1',
  '--g-100': '#e6ebee',
  '--g-50': '#f6f8f9'
};

export const PITWALL_REQUIRED_TOKENS = {
  '--primary': '#39ff14',
  '--accent': '#39ff14',
  '--ring': '#39ff14',
  '--background': '#0b0e10',
  '--phase-auto': '#5ed3e0',
  '--phase-teleop': '#39ff14',
  '--phase-endgame': '#f7b53b',
  '--alliance-red': '#ff5d52',
  '--alliance-blue': '#4fa3ff',
  '--status-warning': '#f7b53b',
  '--status-error': '#ff5577',
  '--destructive': '#ff5577',
  '--status-info': '#5ed3e0',
  '--status-ai': '#a48cff',
  '--motion-duration-fast': '160ms',
  '--motion-duration-moderate': '240ms',
  '--motion-duration-normal': '320ms',
  '--motion-duration-slow': '480ms'
};

export const REMOVED_FONT_NAMES = [
  'PinyonScript',
  'ZCOOLXiaoWei',
  'ZCOOLQingKeHuangYou'
];

export const LEGACY_WARM_AND_SLATE_HEXES = new Set([
  '#0c0c0b',
  '#080807',
  '#090908',
  '#141413',
  '#181816',
  '#1c1c1a',
  '#1e1e1c',
  '#262624',
  '#353532',
  '#f0efe9',
  '#8e8d87',
  '#9e9d95',
  '#0d1117',
  '#ef4444',
  '#3b82f6',
  '#38bdf8',
  '#fcd34d',
  '#101110',
  '#09090b',
  '#f1f5f9',
  '#94a3b8'
]);

export const APPROVED_CHEVRON_ENCODED_HEXES = new Set([
  '%2397a2ab',
  '%2339ff14',
  '%23e6ebee',
  '%23ff5577',
  '%235ed3e0'
]);

export function parseCssColor(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim().toLowerCase();
  if (trimmed === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

  const hexMatch = trimmed.match(/^#([0-9a-f]{3,8})$/);
  if (hexMatch) {
    const h = hexMatch[1];
    if (h.length === 3 || h.length === 4) {
      const r = parseInt(h[0] + h[0], 16);
      const g = parseInt(h[1] + h[1], 16);
      const b = parseInt(h[2] + h[2], 16);
      const a = h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1;
      return { r, g, b, a };
    }
    if (h.length === 6 || h.length === 8) {
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, a };
    }
  }

  const rgbMatch = trimmed.match(
    /^rgba?\(\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)(?:\s*[,/]\s*([0-9.]+))?\s*\)$/
  );
  if (rgbMatch) {
    return {
      r: Math.round(Number(rgbMatch[1])),
      g: Math.round(Number(rgbMatch[2])),
      b: Math.round(Number(rgbMatch[3])),
      a: rgbMatch[4] !== undefined ? Number(rgbMatch[4]) : 1
    };
  }
  return null;
}

export function colorsEqual(actual, expected, tolerance = 3) {
  const c1 = typeof actual === 'string' ? parseCssColor(actual) : actual;
  const c2 = typeof expected === 'string' ? parseCssColor(expected) : expected;
  if (!c1 || !c2) return false;
  return (
    Math.abs(c1.r - c2.r) <= tolerance &&
    Math.abs(c1.g - c2.g) <= tolerance &&
    Math.abs(c1.b - c2.b) <= tolerance
  );
}

export function relativeLuminance({ r, g, b }) {
  const toLin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
}

export function contrastRatio(fgHexOrObj, bgHexOrObj) {
  const fg = typeof fgHexOrObj === 'string' ? parseCssColor(fgHexOrObj) : fgHexOrObj;
  const bg = typeof bgHexOrObj === 'string' ? parseCssColor(bgHexOrObj) : bgHexOrObj;
  if (!fg || !bg) return 0;
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

export function normalizeDurationMs(val) {
  if (!val) return null;
  const s = String(val).trim().toLowerCase();
  if (s.endsWith('ms')) return Number.parseFloat(s.slice(0, -2));
  if (s.endsWith('s')) return Number.parseFloat(s.slice(0, -1)) * 1000;
  return null;
}

export function walkSourceFiles(rootDir, exts = ['.vue', '.css', '.ts']) {
  const results = [];
  if (!fs.existsSync(rootDir)) return results;

  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') {
          continue;
        }
        visit(full);
      } else if (exts.some((ext) => entry.name.endsWith(ext))) {
        results.push(full);
      }
    }
  }
  visit(rootDir);
  return results;
}

function extractTagBlock(content, tagName) {
  const blocks = [];
  const tagRe = new RegExp(`<(\\/)?${tagName}(?=[\\s/>])((?:"[^"]*"|'[^']*'|[^>"'])*)>`, 'gi');
  let depth = 0;
  let innerStart = -1;
  let m;
  while ((m = tagRe.exec(content)) !== null) {
    const isClose = Boolean(m[1]);
    const attrs = m[2] || '';
    const isSelfClosing = !isClose && /\/\s*$/.test(attrs);
    if (isSelfClosing) continue;
    if (!isClose) {
      if (depth === 0) {
        innerStart = tagRe.lastIndex;
      }
      depth += 1;
    } else if (depth > 0) {
      depth -= 1;
      if (depth === 0 && innerStart !== -1) {
        blocks.push(content.slice(innerStart, m.index));
        innerStart = -1;
      }
    }
  }
  return blocks.join('\n');
}

function stripCssComments(txt) {
  return txt.replace(/\/\*[\s\S]*?\*\//g, '');
}

function stripRootBlocks(cssText) {
  const noComments = stripCssComments(cssText);
  let out = '';
  let pos = 0;
  let stmtStart = 0;
  let depth = 0;
  let inQuote = null;
  let skippingRoot = false;

  for (let i = 0; i < noComments.length; i += 1) {
    const ch = noComments[i];
    if (inQuote) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === inQuote) {
        inQuote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === ';' && depth === 0) {
      stmtStart = i + 1;
    } else if (ch === '{') {
      if (depth === 0) {
        const sel = noComments.slice(stmtStart, i).trim();
        if (/(?:^|[\s,]):root(?=$|[\s,:{[])/.test(sel)) {
          out += noComments.slice(pos, stmtStart);
          skippingRoot = true;
        }
      }
      depth += 1;
    } else if (ch === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0) {
          if (skippingRoot) {
            pos = i + 1;
            skippingRoot = false;
          }
          stmtStart = i + 1;
        }
      }
    }
  }
  out += noComments.slice(pos);
  return out;
}

function splitTopLevelCommas(val) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let quote = null;
  for (let i = 0; i < val.length; i += 1) {
    const ch = val[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')' && depth > 0) {
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      parts.push(val.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(val.slice(start));
  return parts;
}

function isZeroOffsetGlowLayer(layerStr) {
  let cleaned = layerStr;
  for (let pass = 0; pass < 3; pass += 1) {
    cleaned = cleaned.replace(/[a-z-]+\([^()]*\)/gi, ' ');
  }
  cleaned = cleaned.replace(/#[0-9a-fA-F]{3,8}\b/g, ' ').replace(/\binset\b/gi, ' ');
  const tokens = cleaned.trim().split(/\s+/).filter(Boolean);
  const lengths = tokens.filter((t) => /^-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|pt|%)?$/i.test(t));
  if (lengths.length < 3) return false;
  const ox = Number.parseFloat(lengths[0]);
  const oy = Number.parseFloat(lengths[1]);
  const blur = Number.parseFloat(lengths[2]);
  return ox === 0 && oy === 0 && blur > 0;
}

const SVG_DATA_URI_RE = /"(data:image\/svg\+xml[^"\r\n]*)"|'(data:image\/svg\+xml[^'\r\n]*)'|(data:image\/svg\+xml[^\r\n)"']*)/gi;

export function auditSingleFileContent(relPathPosix, content) {
  const findings = {
    legacyFonts: [],
    legacyHexes: [],
    unallowlistedHexes: [],
    unapprovedGlows: [],
    badChevrons: [],
    legacyDurations: []
  };

  if (relPathPosix.includes('/__tests__/') || relPathPosix.startsWith('__tests__/')) {
    return findings;
  }

  // 1. Removed font references (all non-test .vue/.css/.ts)
  const fontRegex = /\b(PinyonScript|ZCOOLXiaoWei|ZCOOLQingKeHuangYou)\b/g;
  let fm;
  while ((fm = fontRegex.exec(content)) !== null) {
    findings.legacyFonts.push(fm[1]);
  }

  // 2. Determine CSS/template segments vs Canvas 2D / logger / QR allowlists
  let auditText = content;
  const isMainCss = relPathPosix === 'assets/main.css' || relPathPosix.endsWith('/assets/main.css');
  const isWhiteboardCanvas = relPathPosix.endsWith('components/whiteboard/WhiteboardFieldCanvas.vue');
  const isWhiteboardComposable = relPathPosix.endsWith('components/whiteboard/useTacticalWhiteboard.ts');
  const isLogger = relPathPosix.endsWith('utils/logger.ts');
  const isMobileQr = relPathPosix.endsWith('components/common/MobileQrModal.vue');
  let extractedWhiteboardBlocks = '';

  if (isMainCss) {
    // Exclude :root { ... } token definitions from unallowlisted hex checks,
    // BUT still check the full main.css for legacy hexes & bad chevrons.
    auditText = stripRootBlocks(content);
  } else if (isWhiteboardCanvas) {
    // Only audit <template> and <style>, exempting Canvas 2D imperative draw script
    extractedWhiteboardBlocks = `${extractTagBlock(content, 'template')}\n${extractTagBlock(content, 'style')}`;
    auditText = extractedWhiteboardBlocks;
  } else if (isWhiteboardComposable) {
    // Exempt Pit Wall palette definitions, flag legacy warm/slate hexes
    auditText = '';
  } else if (isLogger) {
    // DevTools console %c palette is explicitly allowlisted
    auditText = '';
  } else if (isMobileQr) {
    // Strip QRCode.toCanvas color options
    auditText = content.replace(/QRCode\.toCanvas\([\s\S]*?\}\s*\)/g, '');
  }

  // Strip CSS/HTML comments from hex scans (keep code & styles intact)
  const stripComments = (txt) => stripCssComments(txt).replace(/<!--[\s\S]*?-->/g, '');

  // Check legacy hexes across non-exempt file text (and inside main.css :root too!)
  const hexRegex = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g;
  const legacyScanTarget = stripComments(
    isLogger
      ? ''
      : isWhiteboardCanvas
        ? extractedWhiteboardBlocks
        : isMobileQr
          ? auditText
          : content
  );

  let lm;
  while ((lm = hexRegex.exec(legacyScanTarget)) !== null) {
    const h = lm[0].toLowerCase();
    if (LEGACY_WARM_AND_SLATE_HEXES.has(h)) {
      findings.legacyHexes.push(h);
    }
  }

  // Check unallowlisted hardcoded hexes in CSS/style/template outside :root/allowlists
  const styleScanTarget = stripComments(
    isWhiteboardCanvas
      ? auditText
      : relPathPosix.endsWith('.vue')
        ? `${extractTagBlock(auditText, 'template')}\n${extractTagBlock(auditText, 'style')}`
        : auditText
  );

  const strippedOfDataUri = styleScanTarget.replace(SVG_DATA_URI_RE, '""');
  let hm;
  while ((hm = hexRegex.exec(strippedOfDataUri)) !== null) {
    findings.unallowlistedHexes.push(hm[0].toLowerCase());
  }

  // 3. Check data:image/svg+xml chevrons (supporting ;utf8, and ;charset=utf-8, and 3..8 digit %23 hexes)
  const chevronScanText = stripComments(content);
  const seenBadChevrons = new Set();
  SVG_DATA_URI_RE.lastIndex = 0;
  let sm;
  while ((sm = SVG_DATA_URI_RE.exec(chevronScanText)) !== null) {
    const uri = (sm[1] || sm[2] || sm[3] || '').toLowerCase();
    const encodedHexes = uri.match(/%23[0-9a-f]{3,8}/g) || [];
    for (const eh of encodedHexes) {
      if (!APPROVED_CHEVRON_ENCODED_HEXES.has(eh) && !seenBadChevrons.has(eh)) {
        seenBadChevrons.add(eh);
        findings.badChevrons.push(eh);
      }
    }
    const rawHexes = uri.match(/#[0-9a-f]{3,8}/g) || [];
    for (const rh of rawHexes) {
      const encodedEquiv = `%23${rh.slice(1)}`;
      if (!APPROVED_CHEVRON_ENCODED_HEXES.has(encodedEquiv) && !seenBadChevrons.has(rh)) {
        seenBadChevrons.add(rh);
        findings.badChevrons.push(rh);
      }
    }
  }

  // 4. Check box-shadow 0 0 <blur>0 neon glows across full multi-line declarations
  const boxShadowRe = /box-shadow\s*:\s*([\s\S]*?)(?=;|\})/gi;
  let bm;
  while ((bm = boxShadowRe.exec(styleScanTarget)) !== null) {
    const declVal = bm[1];
    const layers = splitTopLevelCommas(declVal);
    if (!layers.some(isZeroOffsetGlowLayer)) continue;

    const beforeDecl = styleScanTarget.slice(0, bm.index);
    const lastOpenBrace = beforeDecl.lastIndexOf('{');
    const prevCloseBrace = lastOpenBrace !== -1 ? beforeDecl.lastIndexOf('}', lastOpenBrace) : -1;
    let selectorText = lastOpenBrace !== -1
      ? beforeDecl.slice(prevCloseBrace + 1, lastOpenBrace).toLowerCase()
      : '';
    if (/^(?:from|to|\d+(?:\.\d+)?%)$/.test(selectorText.trim())) {
      const kfMatch = beforeDecl.slice(0, prevCloseBrace + 1).match(/@keyframes\s+([^\s{]+)\s*\{[^@]*$/i);
      if (kfMatch) {
        selectorText += ` ${kfMatch[1].toLowerCase()}`;
      }
    }

    const isFocusRing =
      selectorText.includes(':focus') ||
      selectorText.includes('focus-ring');
    const isOnlineDot =
      selectorText.includes('dot-online') ||
      selectorText.includes('status-indicator-dot') ||
      selectorText.includes('status-dot') ||
      selectorText.includes('online-dot') ||
      selectorText.includes('.connected .dot') ||
      selectorText.includes('is-online');
    const isBootReady =
      selectorText.includes('ready-flash') ||
      selectorText.includes('boot-ready') ||
      selectorText.includes('tactical-boot');

    if (!isFocusRing && !isOnlineDot && !isBootReady) {
      findings.unapprovedGlows.push(bm[0].trim().replace(/\s+/g, ' '));
    }
  }

  // 5. Legacy motion durations
  const legacyMotionRegex = /\b0?\.(?:272|476|612|816|85)s\b/g;
  let mm;
  while ((mm = legacyMotionRegex.exec(styleScanTarget)) !== null) {
    findings.legacyDurations.push(mm[0]);
  }

  return findings;
}

export function scanFrontendSourceTree(srcDir) {
  const files = walkSourceFiles(srcDir);
  const perFile = {};
  const totals = {
    filesScanned: files.length,
    legacyFonts: [],
    legacyHexes: [],
    unallowlistedHexes: [],
    unapprovedGlows: [],
    badChevrons: [],
    legacyDurations: []
  };

  for (const full of files) {
    const rel = path.relative(srcDir, full).replace(/\\/g, '/');
    const content = fs.readFileSync(full, 'utf8');
    const f = auditSingleFileContent(rel, content);
    const hasIssues =
      f.legacyFonts.length ||
      f.legacyHexes.length ||
      f.unallowlistedHexes.length ||
      f.unapprovedGlows.length ||
      f.badChevrons.length ||
      f.legacyDurations.length;
    if (hasIssues) {
      perFile[rel] = f;
    }
    for (const k of ['legacyFonts', 'legacyHexes', 'unallowlistedHexes', 'unapprovedGlows', 'badChevrons', 'legacyDurations']) {
      for (const item of f[k]) totals[k].push({ file: rel, value: item });
    }
  }

  return { perFile, totals };
}

function extractPointsFromAttr(pointsStr) {
  const nums = (pointsStr.match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || []).map(Number);
  if (nums.length < 6 || nums.length % 2 !== 0) return [];
  const pts = [];
  for (let i = 0; i < nums.length; i += 2) {
    pts.push({ x: nums[i], y: nums[i + 1] });
  }
  return pts;
}

function extractSubpathPolygonsFromPath(d) {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
  const subpaths = [];
  let cur = null;
  let cmd = null;
  let curX = 0;
  let curY = 0;
  let startX = 0;
  let startY = 0;
  let i = 0;

  const finishSubpath = () => {
    if (cur) {
      subpaths.push(cur);
      cur = null;
    }
  };

  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z]$/.test(t)) {
      cmd = t;
      i += 1;
      if (cmd === 'Z' || cmd === 'z') {
        if (cur) cur.closed = true;
        curX = startX;
        curY = startY;
        cmd = null;
      }
      continue;
    }
    if (!cmd) {
      i += 1;
      continue;
    }
    if (cmd === 'M' || cmd === 'm') {
      finishSubpath();
      const x = Number(tokens[i]);
      const y = Number(tokens[i + 1]);
      if (Number.isNaN(x) || Number.isNaN(y)) break;
      i += 2;
      curX = cmd === 'm' ? curX + x : x;
      curY = cmd === 'm' ? curY + y : y;
      startX = curX;
      startY = curY;
      cur = { pts: [{ x: curX, y: curY }], closed: false, hasCurve: false };
      cmd = cmd === 'm' ? 'l' : 'L';
    } else if (cmd === 'L' || cmd === 'l') {
      const x = Number(tokens[i]);
      const y = Number(tokens[i + 1]);
      if (Number.isNaN(x) || Number.isNaN(y)) break;
      i += 2;
      curX = cmd === 'l' ? curX + x : x;
      curY = cmd === 'l' ? curY + y : y;
      if (cur) cur.pts.push({ x: curX, y: curY });
    } else if (cmd === 'H' || cmd === 'h') {
      const x = Number(tokens[i]);
      if (Number.isNaN(x)) break;
      i += 1;
      curX = cmd === 'h' ? curX + x : x;
      if (cur) cur.pts.push({ x: curX, y: curY });
    } else if (cmd === 'V' || cmd === 'v') {
      const y = Number(tokens[i]);
      if (Number.isNaN(y)) break;
      i += 1;
      curY = cmd === 'v' ? curY + y : y;
      if (cur) cur.pts.push({ x: curX, y: curY });
    } else {
      const paramCounts = { C: 6, c: 6, S: 4, s: 4, Q: 4, q: 4, T: 2, t: 2, A: 7, a: 7 };
      const count = paramCounts[cmd];
      if (!count) {
        i += 1;
        continue;
      }
      if (cur) cur.hasCurve = true;
      if (i + count - 1 >= tokens.length) break;
      const isRel = cmd === cmd.toLowerCase();
      const x = Number(tokens[i + count - 2]);
      const y = Number(tokens[i + count - 1]);
      if (!Number.isNaN(x) && !Number.isNaN(y)) {
        curX = isRel ? curX + x : x;
        curY = isRel ? curY + y : y;
      }
      i += count;
    }
  }
  finishSubpath();
  return subpaths;
}

function toConvexOctagon(rawPts, isExplicitlyClosed) {
  if (!rawPts || rawPts.length < 8) return null;
  const eps = 1e-3;
  const pts = [];
  for (const p of rawPts) {
    const prev = pts[pts.length - 1];
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > eps) {
      pts.push(p);
    }
  }
  const hasClosingDuplicate =
    pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) <= eps;
  if (hasClosingDuplicate) {
    pts.pop();
  }
  if (!isExplicitlyClosed && !hasClosingDuplicate) return null;
  if (pts.length !== 8) return null;

  let sign = 0;
  for (let i = 0; i < 8; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % 8];
    const c = pts[(i + 2) % 8];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) <= 1e-2) return null;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return null;
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (w <= 0 || h <= 0) return null;
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w, h };
}

function detectDraft1ReticlePattern(svgText) {
  const lower = svgText.toLowerCase();
  if (/\b(reticle|crosshair)\b/.test(lower)) return true;

  const vbMatch = svgText.match(/viewbox\s*=\s*["']\s*([0-9.-]+)[,\s]+([0-9.-]+)[,\s]+([0-9.-]+)[,\s]+([0-9.-]+)\s*["']/i);

  // 1. Triple concentric convex octagons (3+ distinct concentric 8-gon rings across polygon/polyline/path)
  const convexOctagons = [];
  const polyMatches = svgText.matchAll(/<polygon\b[^>]*\bpoints\s*=\s*["']([^"']+)["'][^>]*>/gi);
  for (const pm of polyMatches) {
    const oct = toConvexOctagon(extractPointsFromAttr(pm[1]), true);
    if (oct) convexOctagons.push(oct);
  }
  const polylineMatches = svgText.matchAll(/<polyline\b[^>]*\bpoints\s*=\s*["']([^"']+)["'][^>]*>/gi);
  for (const pm of polylineMatches) {
    const oct = toConvexOctagon(extractPointsFromAttr(pm[1]), false);
    if (oct) convexOctagons.push(oct);
  }
  const pathMatches = svgText.matchAll(/<path\b[^>]*\bd\s*=\s*["']([^"']+)["'][^>]*>/gi);
  const pathDs = [];
  for (const pm of pathMatches) {
    const d = pm[1];
    pathDs.push(d);
    for (const sp of extractSubpathPolygonsFromPath(d)) {
      if (sp.hasCurve) continue;
      const oct = toConvexOctagon(sp.pts, sp.closed);
      if (oct) convexOctagons.push(oct);
    }
  }
  if (convexOctagons.length >= 3) {
    const vbW = vbMatch ? Number(vbMatch[3]) : 0;
    const vbH = vbMatch ? Number(vbMatch[4]) : 0;
    const refSize = Math.max(
      vbW > 0 ? vbW : 0,
      vbH > 0 ? vbH : 0,
      ...convexOctagons.map((o) => Math.max(o.w, o.h)),
      1
    );
    const centerTol = Math.max(2, refSize * 0.05);
    const sizeTol = Math.max(0.5, refSize * 0.01);

    for (const anchor of convexOctagons) {
      const concentric = convexOctagons.filter(
        (o) => Math.abs(o.cx - anchor.cx) <= centerTol && Math.abs(o.cy - anchor.cy) <= centerTol
      );
      if (concentric.length < 3) continue;
      const distinctSizes = [];
      for (const o of concentric) {
        const isDupSize = distinctSizes.some(
          (s) => Math.abs(s.w - o.w) <= sizeTol && Math.abs(s.h - o.h) <= sizeTol
        );
        if (!isDupSize) {
          distinctSizes.push({ w: o.w, h: o.h });
        }
      }
      if (distinctSizes.length >= 3) return true;
    }
  }

  // 2. 4-tick cardinal crosshair pattern around viewBox perimeter midpoints
  if (vbMatch) {
    const minX = Number(vbMatch[1]);
    const minY = Number(vbMatch[2]);
    const w = Number(vbMatch[3]);
    const h = Number(vbMatch[4]);
    if (w > 0 && h > 0) {
      const midX = minX + w / 2;
      const midY = minY + h / 2;
      const segments = [];

      for (const d of pathDs) {
        const segRe = /M\s*([0-9.-]+)[,\s]+([0-9.-]+)\s*L\s*([0-9.-]+)[,\s]+([0-9.-]+)/gi;
        let sm;
        while ((sm = segRe.exec(d)) !== null) {
          segments.push([Number(sm[1]), Number(sm[2]), Number(sm[3]), Number(sm[4])]);
        }
      }
      const lineRe = /<line\b([^>]*)>/gi;
      let lm;
      while ((lm = lineRe.exec(svgText)) !== null) {
        const attrs = lm[1];
        const getNum = (k) => {
          const m = attrs.match(new RegExp(`\\b${k}\\s*=\\s*["']([0-9.-]+)["']`, 'i'));
          return m ? Number(m[1]) : null;
        };
        const x1 = getNum('x1');
        const y1 = getNum('y1');
        const x2 = getNum('x2');
        const y2 = getNum('y2');
        if (x1 !== null && y1 !== null && x2 !== null && y2 !== null) {
          segments.push([x1, y1, x2, y2]);
        }
      }

      let hasTopTick = false;
      let hasBottomTick = false;
      let hasLeftTick = false;
      let hasRightTick = false;

      for (const [x1, y1, x2, y2] of segments) {
        const tolX = Math.max(1.5, w * 0.04);
        const tolY = Math.max(1.5, h * 0.04);
        const loY = Math.min(y1, y2);
        const hiY = Math.max(y1, y2);
        const loX = Math.min(x1, x2);
        const hiX = Math.max(x1, x2);
        if (Math.abs(x1 - midX) <= tolX && Math.abs(x2 - midX) <= tolX) {
          if (loY <= minY + h * 0.1 && hiY <= minY + h * 0.22 && hiY > loY) hasTopTick = true;
          if (hiY >= minY + h * 0.9 && loY >= minY + h * 0.78 && hiY > loY) hasBottomTick = true;
        }
        if (Math.abs(y1 - midY) <= tolY && Math.abs(y2 - midY) <= tolY) {
          if (loX <= minX + w * 0.1 && hiX <= minX + w * 0.22 && hiX > loX) hasLeftTick = true;
          if (hiX >= minX + w * 0.9 && loX >= minX + w * 0.78 && hiX > loX) hasRightTick = true;
        }
      }

      if (hasTopTick && hasBottomTick && hasLeftTick && hasRightTick) return true;
    }
  }

  return false;
}

export function auditBrandSvg(svgText) {
  const lower = svgText.toLowerCase();
  const svgOpenTagMatch = svgText.match(/<svg\b([^>]*)>/i);
  const hasSvgRoot = /<svg\b[^>]*viewbox=/i.test(svgText);
  const hasPrimaryGreen = lower.includes('#39ff14');
  const svgHasImplicitTransparentRoot = svgOpenTagMatch ? !/\bfill\s*=/i.test(svgOpenTagMatch[1]) : false;
  const hasColdGraphiteOrTransparent =
    lower.includes('#0b0e10') ||
    /fill\s*=\s*["']none["']/i.test(svgText) ||
    lower.includes('transparent') ||
    svgHasImplicitTransparentRoot;
  const hasLegacyHoneycomb =
    lower.includes('surrounding-honeycomb') ||
    lower.includes('sp27-core') ||
    lower.includes('honeycomb cell') ||
    lower.includes('fegaussianblur') ||
    lower.includes('neon-glow');
  const hasDraft1Reticle = detectDraft1ReticlePattern(svgText);
  const hasLegacyMarkers = hasLegacyHoneycomb || hasDraft1Reticle;
  const polygonCount = (svgText.match(/<polygon\b/gi) || []).length;

  return {
    ok: hasSvgRoot && hasPrimaryGreen && hasColdGraphiteOrTransparent && !hasLegacyMarkers,
    hasSvgRoot,
    hasPrimaryGreen,
    hasColdGraphiteOrTransparent,
    hasLegacyMarkers,
    hasLegacyHoneycomb,
    hasDraft1Reticle,
    polygonCount
  };
}
