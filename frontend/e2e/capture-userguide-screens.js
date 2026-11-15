import puppeteer from 'puppeteer-core';
import { spawn, execSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.USERGUIDE_PORT || 7071);
const BASE_URL = `http://localhost:${PORT}/index.html`;
const BACKEND_DIR = path.resolve(__dirname, '../../Backend');
const ROOT_OUTPUT_DIR = path.resolve(__dirname, '../../docs/images/userguide');

const DESKTOP_VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 2 };
const MOBILE_VIEWPORT = {
  width: 414,
  height: 896,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getChromeExecutablePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const platform = os.platform();
  if (platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe')
    ];
    return candidates.find((p) => fs.existsSync(p)) || candidates[0];
  }
  if (platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  return '/usr/bin/google-chrome';
}

const CHROME_PATH = getChromeExecutablePath();

function killProcessTree(pid) {
  if (!pid) return;
  try {
    if (os.platform() === 'win32') {
      execSync(`taskkill /pid ${pid} /f /t`, { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Ignore already exited processes
  }
}

async function isServerRunning() {
  try {
    const res = await fetch(`http://localhost:${PORT}/index.html`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServerDown(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isServerRunning())) return true;
    await delay(250);
  }
  return false;
}

function cleanOutputDirs() {
  fs.mkdirSync(ROOT_OUTPUT_DIR, { recursive: true });
  for (const entry of fs.readdirSync(ROOT_OUTPUT_DIR, { withFileTypes: true })) {
    const full = path.join(ROOT_OUTPUT_DIR, entry.name);
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) {
      fs.unlinkSync(full);
    }
  }
  for (const lang of ['zh', 'en']) {
    const dir = path.join(ROOT_OUTPUT_DIR, lang);
    fs.mkdirSync(dir, { recursive: true });
    for (const file of fs.readdirSync(dir)) {
      if (file.toLowerCase().endsWith('.png')) {
        fs.unlinkSync(path.join(dir, file));
      }
    }
  }
}

async function waitForTransition(page) {
  await page.waitForFunction(() => {
    return (
      !document.documentElement.hasAttribute('data-direction') &&
      !document.documentElement.hasAttribute('data-transition-type')
    );
  }, { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready?.catch(() => {}));
  await delay(260);
}

/**
 * Waits briefly for any active transient toast notification to settle,
 * and hides `.toast-container` so floating toasts never occlude UI elements in guide captures.
 */
async function suppressToasts(page) {
  await delay(300);
  await page.evaluate(() => {
    const styleId = 'ug-hide-toasts-style';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = '.toast-container, .toast-pill { display: none !important; opacity: 0 !important; pointer-events: none !important; }';
      document.head.appendChild(style);
    }
  });
}

async function clickTab(page, tabKey) {
  const clicked = await page.evaluate((key) => {
    const btns = Array.from(document.querySelectorAll('.tab-bar .tab-btn'));
    const exact = btns.find((b) => b.getAttribute('data-tab') === key);
    if (exact) {
      exact.click();
      return true;
    }
    const mobileNavBtns = Array.from(document.querySelectorAll('.mobile-bottom-nav button, nav button'));
    const fallback = mobileNavBtns.find((b) => (b.textContent || '').toLowerCase().includes(key.toLowerCase()));
    if (fallback) {
      fallback.click();
      return true;
    }
    return false;
  }, tabKey);

  if (!clicked) {
    throw new Error(`Tab button not found for key="${tabKey}"`);
  }
  await waitForTransition(page);
  await delay(550);
}

async function clearAnnotations(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.ug-annotation-layer').forEach((el) => el.remove());
  });
}

/**
 * Wait until an element's layout rect has settled (no active CSS transform on itself/ancestors
 * and two consecutive reads 120ms apart match within 0.5px). Eliminates <transition-group> offset drift.
 */
async function waitForRectStable(page, selector, timeoutMs = 3000) {
  const start = Date.now();
  let last = null;
  let stableCount = 0;

  while (Date.now() - start < timeoutMs) {
    const cur = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      let node = el;
      let hasTransform = false;
      while (node && node !== document.body) {
        const tf = window.getComputedStyle(node).transform;
        if (tf && tf !== 'none') {
          hasTransform = true;
          break;
        }
        node = node.parentElement;
      }
      return { x: r.x, y: r.y, w: r.width, h: r.height, hasTransform };
    }, selector);

    if (cur && !cur.hasTransform && cur.w > 1 && cur.h > 1 && last) {
      const diff =
        Math.abs(cur.x - last.x) +
        Math.abs(cur.y - last.y) +
        Math.abs(cur.w - last.w) +
        Math.abs(cur.h - last.h);
      if (diff < 0.5) {
        stableCount += 1;
        if (stableCount >= 2) return;
      } else {
        stableCount = 0;
      }
    } else {
      stableCount = 0;
    }
    last = cur;
    await delay(120);
  }
}

/**
 * Scroll primary element (if requested) smoothly/instantly into a comfortable viewport region,
 * draw glowing callout boxes, numbered circles, leader lines, and multi-line wrapped labels
 * clamped strictly inside viewport boundaries with automated collision avoidance.
 */
async function annotateElements(page, annotations, options = {}) {
  const { scrollSelector = null, scrollBlock = 'center' } = options;

  await suppressToasts(page);
  await clearAnnotations(page);

  if (scrollSelector) {
    await page.evaluate((sel, block) => {
      const target = document.querySelector(sel);
      if (target) {
        target.scrollIntoView({ behavior: 'instant', block, inline: 'nearest' });
      }
    }, scrollSelector, scrollBlock);
    await delay(180);
  }

  const report = await page.evaluate((items) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const isMobile = vw <= 600;
    const margin = isMobile ? 8 : 12;
    const maxCalloutWidth = isMobile ? Math.min(260, vw - margin * 2) : 320;

    const layer = document.createElement('div');
    layer.className = 'ug-annotation-layer';
    Object.assign(layer.style, {
      position: 'fixed',
      inset: '0',
      width: `${vw}px`,
      height: `${vh}px`,
      pointerEvents: 'none',
      zIndex: '99999',
      overflow: 'hidden',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    });

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', String(vw));
    svg.setAttribute('height', String(vh));
    Object.assign(svg.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none'
    });
    layer.appendChild(svg);
    document.body.appendChild(layer);

    const resolveTarget = (spec) => {
      const selectors = Array.isArray(spec.selector) ? spec.selector : [spec.selector];
      for (const sel of selectors) {
        const nodes = Array.from(document.querySelectorAll(sel));
        const visibleNodes = nodes.filter((el) => {
          const st = window.getComputedStyle(el);
          if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
          const r = el.getBoundingClientRect();
          return r.width > 1 && r.height > 1;
        });
        if (visibleNodes.length === 0) continue;
        if (spec.matchText) {
          const hit = visibleNodes.find((el) => (el.textContent || '').includes(spec.matchText));
          if (hit) return hit;
        }
        const idx = spec.matchIndex ?? 0;
        if (visibleNodes[idx]) return visibleNodes[idx];
      }
      return null;
    };

    const clamp = (val, min, max) => Math.max(min, Math.min(max, val));
    const intersectArea = (a, b) => {
      const xOverlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const yOverlap = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      return xOverlap * yOverlap;
    };

    const resolved = [];
    const missing = [];

    items.forEach((spec, idx) => {
      const el = resolveTarget(spec);
      if (!el) {
        missing.push(`${idx + 1}: ${spec.selector}`);
        return;
      }

      if (spec.scrollIntoView) {
        el.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
      }

      const raw = el.getBoundingClientRect();
      const pad = spec.pad ?? 4;
      const left = clamp(raw.left - pad, margin, vw - margin - 8);
      const top = clamp(raw.top - pad, margin, vh - margin - 8);
      const rawRight = spec.maxBoxWidth ? Math.min(raw.right, raw.left + spec.maxBoxWidth) : raw.right;
      const right = clamp(rawRight + pad, left + 8, vw - margin);
      const bottom = clamp(raw.bottom + pad, top + 8, vh - margin);

      resolved.push({
        spec,
        index: idx + 1,
        color: spec.color || '#39ff14',
        box: { left, top, right, bottom, width: right - left, height: bottom - top }
      });
    });

    // Reserve all target highlight boxes so labels avoid occluding important highlighted targets when possible
    const boxRects = resolved.map((r) => ({ ...r.box }));
    const placedLabels = [];
    const placedBadges = [];

    // Draw target highlight frames first
    resolved.forEach((item) => {
      const frame = document.createElement('div');
      Object.assign(frame.style, {
        position: 'fixed',
        left: `${item.box.left}px`,
        top: `${item.box.top}px`,
        width: `${item.box.width}px`,
        height: `${item.box.height}px`,
        border: `2.5px solid ${item.color}`,
        borderRadius: '10px',
        backgroundColor: `${item.color}14`,
        boxShadow: `0 0 0 1px rgba(0, 0, 0, 0.55), 0 0 14px ${item.color}55`,
        boxSizing: 'border-box',
        pointerEvents: 'none'
      });
      layer.appendChild(frame);
    });

    // Measure & place callout cards cleanly without clipping or collision
    const labelPlacements = [];

    resolved.forEach((item, idx) => {
      const badgeSize = isMobile ? 22 : 26;
      // Place badge inside/at top-left (or top-right if specified) corner of box clamped within viewport
      let bLeft = item.spec.badgeAlign === 'right'
        ? clamp(item.box.right - badgeSize + 6, margin, vw - margin - badgeSize)
        : clamp(item.box.left - 8, margin, vw - margin - badgeSize);
      let bTop = clamp(item.box.top - 10, margin, vh - margin - badgeSize);
      for (const prevB of placedBadges) {
        if (intersectArea({ left: bLeft, top: bTop, right: bLeft + badgeSize, bottom: bTop + badgeSize }, prevB) > 0) {
          bLeft = clamp(item.box.right - badgeSize + 6, margin, vw - margin - badgeSize);
        }
      }
      const badgeRect = { left: bLeft, top: bTop, right: bLeft + badgeSize, bottom: bTop + badgeSize };
      placedBadges.push(badgeRect);

      const badge = document.createElement('div');
      badge.textContent = String(item.index);
      Object.assign(badge.style, {
        position: 'fixed',
        left: `${bLeft}px`,
        top: `${bTop}px`,
        width: `${badgeSize}px`,
        height: `${badgeSize}px`,
        borderRadius: '50%',
        backgroundColor: item.color,
        color: '#071108',
        fontWeight: '900',
        fontSize: isMobile ? '12px' : '13px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: '0 2px 10px rgba(0,0,0,0.7)',
        border: '2px solid #09090b',
        zIndex: '100002'
      });
      layer.appendChild(badge);

      // Build callout card & measure true dimensions offscreen
      const card = document.createElement('div');
      card.className = 'ug-callout-card';
      Object.assign(card.style, {
        position: 'fixed',
        left: '-9999px',
        top: '-9999px',
        maxWidth: `${maxCalloutWidth}px`,
        width: 'max-content',
        backgroundColor: 'rgba(10, 12, 13, 0.94)',
        color: '#f8fafc',
        border: `1.5px solid ${item.color}`,
        borderRadius: '9px',
        padding: isMobile ? '6px 9px' : '7px 11px',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.78)',
        boxSizing: 'border-box',
        whiteSpace: 'normal',
        wordBreak: 'break-word',
        lineHeight: '1.35',
        zIndex: '100001'
      });

      const titleEl = document.createElement('div');
      titleEl.textContent = item.spec.label;
      Object.assign(titleEl.style, {
        color: item.color,
        fontWeight: '800',
        fontSize: isMobile ? '11.5px' : '12.5px',
        marginBottom: item.spec.desc ? '2px' : '0'
      });
      card.appendChild(titleEl);

      if (item.spec.desc) {
        const descEl = document.createElement('div');
        descEl.textContent = item.spec.desc;
        Object.assign(descEl.style, {
          color: '#e2e8f0',
          fontWeight: '500',
          fontSize: isMobile ? '10.5px' : '11px'
        });
        card.appendChild(descEl);
      }

      layer.appendChild(card);
      const rect = card.getBoundingClientRect();
      const cw = Math.ceil(rect.width);
      const ch = Math.ceil(rect.height);

      const box = item.box;
      const gap = item.spec.gap ?? (isMobile ? 8 : 12);
      const pref = item.spec.preferredPos || 'auto';

      const rawCandidates = [];
      const addCand = (side, x, y, priority = 0) => {
        const cx = clamp(x, margin, vw - margin - cw);
        const cy = clamp(y, margin, vh - margin - ch);
        rawCandidates.push({
          side,
          left: cx,
          top: cy,
          right: cx + cw,
          bottom: cy + ch,
          priority
        });
      };

      const offsets = [0, 28, -28, 60, -60, 96, -96];
      const sideOrder =
        pref === 'top'
          ? ['top', 'bottom', 'right', 'left']
          : pref === 'right'
            ? ['right', 'left', 'bottom', 'top']
            : pref === 'left'
              ? ['left', 'right', 'bottom', 'top']
              : ['bottom', 'top', 'right', 'left'];

      sideOrder.forEach((side, sIdx) => {
        for (const off of offsets) {
          const prio = sIdx * 10 + Math.abs(off) * 0.05;
          if (side === 'bottom') {
            addCand('bottom', box.left + off, box.bottom + gap, prio);
            addCand('bottom', box.right - cw + off, box.bottom + gap, prio + 1);
          } else if (side === 'top') {
            addCand('top', box.left + off, box.top - ch - gap, prio);
            addCand('top', box.right - cw + off, box.top - ch - gap, prio + 1);
          } else if (side === 'right') {
            addCand('right', box.right + gap, box.top + off, prio);
            addCand('right', box.right + gap, box.bottom - ch + off, prio + 1);
          } else if (side === 'left') {
            addCand('left', box.left - cw - gap, box.top + off, prio);
            addCand('left', box.left - cw - gap, box.bottom - ch + off, prio + 1);
          }
        }
      });

      // Fallback grid scan across safe screen strips if tightly packed
      for (let gx = margin; gx <= vw - margin - cw; gx += Math.max(40, Math.floor(cw / 2))) {
        for (let gy = margin; gy <= vh - margin - ch; gy += Math.max(32, Math.floor(ch / 2))) {
          addCand('scan', gx, gy, 50);
        }
      }

      let best = rawCandidates[0];
      let bestScore = Infinity;

      for (const cand of rawCandidates) {
        let overlapLabels = 0;
        for (const pl of placedLabels) overlapLabels += intersectArea(cand, pl);
        for (const pb of placedBadges) overlapLabels += intersectArea(cand, pb);

        let overlapOwnBox = intersectArea(cand, box);
        let overlapOtherBoxes = 0;
        if (!item.spec.allowOverlapOtherBoxes) {
          boxRects.forEach((br, bIdx) => {
            if (bIdx !== idx) overlapOtherBoxes += intersectArea(cand, br);
          });
        }

        // Distance from card center to target box center
        const cx = (cand.left + cand.right) / 2;
        const cy = (cand.top + cand.bottom) / 2;
        const bx = (box.left + box.right) / 2;
        const by = (box.top + box.bottom) / 2;
        const dist = Math.hypot(cx - bx, cy - by);

        const score =
          overlapLabels * 500 +
          overlapOtherBoxes * 25 +
          overlapOwnBox * 15 +
          dist * 0.15 +
          cand.priority * 8;

        if (score < bestScore) {
          bestScore = score;
          best = cand;
        }
      }

      card.style.left = `${best.left}px`;
      card.style.top = `${best.top}px`;
      placedLabels.push({ left: best.left, top: best.top, right: best.right, bottom: best.bottom });
      labelPlacements.push({
        index: item.index,
        left: best.left,
        top: best.top,
        right: best.right,
        bottom: best.bottom,
        color: item.color,
        box
      });

      // Draw crisp SVG connector line when label sits clearly outside target box
      const cardCx = clamp((best.left + best.right) / 2, best.left + 8, best.right - 8);
      const cardCy = clamp((best.top + best.bottom) / 2, best.top + 8, best.bottom - 8);
      const targetX = clamp(cardCx, box.left, box.right);
      const targetY = clamp(cardCy, box.top, box.bottom);
      const originX = clamp(targetX, best.left, best.right);
      const originY = clamp(targetY, best.top, best.bottom);
      if (Math.hypot(originX - targetX, originY - targetY) > 6) {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', String(originX));
        line.setAttribute('y1', String(originY));
        line.setAttribute('x2', String(targetX));
        line.setAttribute('y2', String(targetY));
        line.setAttribute('stroke', item.color);
        line.setAttribute('stroke-width', '1.8');
        line.setAttribute('stroke-dasharray', '4 3');
        line.setAttribute('opacity', '0.9');
        svg.appendChild(line);
      }
    });

    // Self-check overlaps and clipping
    let overlapCount = 0;
    for (let i = 0; i < labelPlacements.length; i++) {
      for (let j = i + 1; j < labelPlacements.length; j++) {
        if (intersectArea(labelPlacements[i], labelPlacements[j]) > 2) {
          overlapCount++;
        }
      }
    }
    const clippedCount = labelPlacements.filter(
      (p) => p.left < 0 || p.top < 0 || p.right > vw || p.bottom > vh
    ).length;

    return {
      placed: labelPlacements.length,
      missing,
      overlapCount,
      clippedCount
    };
  }, annotations);

  if (report.missing.length > 0) {
    throw new Error(`Annotation selector(s) missing: ${report.missing.join('; ')}`);
  }
  if (report.clippedCount > 0 || report.overlapCount > 0) {
    console.warn(`⚠️ Annotation layout warning: overlaps=${report.overlapCount}, clipped=${report.clippedCount}`);
  }
  return report;
}

async function verifyLocaleAndCleanUi(page, lang, label) {
  const result = await page.evaluate((expectedLang) => {
    const htmlLang = document.documentElement.lang;
    const bodyText = document.body?.innerText || '';
    const rawKeyMatches =
      bodyText.match(
        /\b(?:scouting|rankings|pit_scout|wizard|whiteboard|qr_modal|schedule|event|dashboard|login|common)\.[a-z0-9_]+\b/g
      ) || [];
    const legacyBadText = [];
    if (bodyText.includes('Hang')) legacyBadText.push('Legacy Hang text found');
    if (bodyText.includes('Overweight')) legacyBadText.push('Legacy Overweight text found');
    return {
      htmlLang,
      expectedLang,
      rawKeyMatches: Array.from(new Set(rawKeyMatches)),
      legacyBadText
    };
  }, lang);

  if (result.htmlLang !== lang) {
    throw new Error(`[${lang}/${label}] Expected document.documentElement.lang="${lang}", got "${result.htmlLang}"`);
  }
  if (result.rawKeyMatches.length > 0) {
    throw new Error(`[${lang}/${label}] Raw untranslated i18n keys rendered: ${result.rawKeyMatches.join(', ')}`);
  }
  if (result.legacyBadText.length > 0) {
    throw new Error(`[${lang}/${label}] Legacy invalid text rendered: ${result.legacyBadText.join(', ')}`);
  }
}

async function robustLogin(page, username, password = 'userguide123') {
  await page.waitForSelector('#username', { visible: true, timeout: 10000 });
  await page.click('#username', { clickCount: 3 });
  await page.type('#username', username);
  await page.evaluate(() => {
    const el = document.querySelector('#username');
    if (el) el.dispatchEvent(new Event('blur'));
  });
  await delay(900);

  await page.waitForSelector('#password', { visible: true, timeout: 10000 });
  await page.type('#password', password);
  const confirmEl = await page.$('#confirmPassword');
  if (confirmEl) {
    await page.type('#confirmPassword', password);
  }
  await page.waitForFunction(() => {
    const btn = document.querySelector('button[type="submit"]');
    return btn && !btn.disabled;
  }, { timeout: 10000 });
  await page.click('button[type="submit"]');
  await page.waitForSelector('.action-btn, .dashboard-view, .event-view', { timeout: 15000 });
  await waitForTransition(page);
}

const COPY = {
  zh: {
    eventName: '2026 BIOBUZZ 华东区域赛',
    demoNotes: [
      '自动离墙+停泊稳定，手动 6 轮循环顺畅，最后 60s 投入 2 颗花朵 Nectar 并占底。',
      '小车机动极快，主动穿行抢球并与队友分工保底。',
      '单轮节奏稳定，擅长 Garden 推进与底口掏球拆台 (G418)。',
      '轮次偏少仅 4 轮，重点承担防守与 Garden 推球辅助。'
    ],
    pitStrategies: {
      27570: '自动 2 球+离墙+停泊；手动全能快循环；最后 60s 双花封顶加停泊',
      11115: '紧凑小车灵活钻缝，高速 6–7 轮清球 + 摆臂放花 + 掏球拆台',
      28410: '宽体稳定推射与 Garden 推进，自述偏高待赛场实测检验',
      9999: '主打中场拦截与 Garden 推球，辅助联盟凑齐停泊机动分'
    },
    robotNames: {
      27570: '熊蜂先锋号 (Swarm Alpha)',
      11115: '银影穿梭机 (Vortex Mini)',
      28410: '重装花匠 (Garden Titan)',
      9999: '绿野铁盾 (Shield Runner)',
      31024: '光子采蜜蜂 (Photon Bee)'
    },
    tacticalNote: 'Q1 红盟分工：#27570 主打快速 6 轮循环与双花封顶，#11115 紧凑小车负责清扫外围并协助终局停泊冲 Swarm RP。',
    annotations: {
      s01: [
        { selector: '.lang-btn', label: '(1) 中/英文一键切换', desc: '点这里可随时在中文与英文界面之间切换', color: '#38bdf8', preferredPos: 'bottom' },
        { selector: '#username', label: '(2) 输入你的名字或代号', desc: '比如填“小明”或队内昵称，方便后台知道谁提交的', color: '#39ff14', preferredPos: 'left' },
        { selector: '#confirmPassword', label: '(3) 首次使用设个登录密码', desc: '新用户自动显示确认密码栏，无需邮箱验证码', color: '#f59e0b', preferredPos: 'right' },
        { selector: 'button[type="submit"]', label: '(4) 点此登录或秒建账号', desc: '登录一次后本地自动保活，赛场断网也不掉线', color: '#a855f7', preferredPos: 'bottom' }
      ],
      s02: [
        { selector: ['.channel-pill-bar', '.qr-modal-header'], label: '(1) 公网云端 / 赛场热点切换', desc: '看台没网就切到“赛场内网/热点”，照样点对点传数据', color: '#38bdf8', preferredPos: 'right' },
        { selector: '.code-badge-bar', label: '(2) 6 位赛事邀请码', desc: '不会扫码时，点一下复制 6 位代码发给队友手动输入', color: '#f59e0b', preferredPos: 'left' },
        { selector: '.qr-canvas-container canvas', label: '(3) 手机相机直接扫码进场', desc: '队员打开手机相机或微信/浏览器扫一扫直接进入活动', color: '#39ff14', preferredPos: 'right' },
        { selector: '.url-copy-box', label: '(4) 网页入场直达链接', desc: '点击“复制链接”可快速粘贴发到微信/QQ 战队群', color: '#a855f7', preferredPos: 'bottom' }
      ],
      s03: [
        { selector: '.setting-group:first-child .segmented-control', label: '(1) 选单车记录还是双车同时记', desc: '新手强烈建议选“单队伍”，专心盯好一台车不点乱', color: '#38bdf8', preferredPos: 'right' },
        { selector: '.spdt-switch', label: '(2) 拨动开关选红方或蓝方', desc: '看清场边队伍贴纸颜色，往左红方、往右蓝方', color: '#f43f5e', preferredPos: 'left' },
        { selector: 'input[placeholder="e.g. 12345"]', label: '(3) 输入你要盯的队号', desc: '填完自动联调 Pit 侦察数据，防填错队号', color: '#39ff14', preferredPos: 'right' },
        { selector: '.pit-quick-hint', label: '(4) 自动弹出展位情报卡', desc: '显示大小车尺寸、放花机构与自述分数，方便现场核对', color: '#f59e0b', preferredPos: 'left' }
      ],
      s04: [
        { selector: '.phase-auto .pad-hit-btn', label: '(1) 自动进球大绿键 (+3 分/球)', desc: '前 30 秒每投进 1 颗球就点一次这里', color: '#39ff14', preferredPos: 'left' },
        { selector: '.phase-auto .pad-miss-btn', label: '(2) 自动打偏记录 (+1 失误)', desc: '机器人出手但没投进时点红键，算命中率用', color: '#f43f5e', preferredPos: 'right' },
        { selector: '.form-section:has(.phase-auto) .biobuzz-toggles-grid .toggle-card:nth-child(1)', label: '(3) 完全离墙 (+3 分 · 计入 Swarm RP)', desc: '看到机器人离开起始区且不压线就勾选', color: '#38bdf8', preferredPos: 'bottom' },
        { selector: '.form-section:has(.phase-auto) .biobuzz-toggles-grid .toggle-card:nth-child(2)', label: '(4) 自动停泊装载区 (+5 分 · 计入 RP)', desc: '自动结束时成功停回己方装载区就勾选', color: '#f59e0b', preferredPos: 'bottom' }
      ],
      s05: [
        { selector: '.phase-teleop .pad-hit-btn', label: '(1) 手动进球大绿键 (+2 分/球)', desc: '盯着场子直接按这里，进几球点几下，支持连续累加', color: '#39ff14', preferredPos: 'left' },
        { selector: '.phase-teleop .chamber-dots', label: '(2) 本轮装弹圆点指示器', desc: '亮起几个圆点就代表这一趟进了/打了几颗球（上限 4 颗）', color: '#38bdf8', preferredPos: 'left' },
        { selector: '.phase-teleop .chips-group', label: '(3) 1–4 球快捷数字键', desc: '连进 3 球来不及点三下？直接点“3”一键填入', color: '#f59e0b', preferredPos: 'right' },
        { selector: '.phase-teleop .btn-new-cycle', label: '(4) 跑完一趟点“记录新轮次”', desc: '每打完一趟点一次，打满 6 轮自动算出“预测单轮耗时”！', color: '#a855f7', preferredPos: 'right' }
      ],
      s06: [
        { selector: '.biobuzz-endgame-steppers .endgame-stepper-card:nth-child(1)', label: '(1) 花朵大球 Nectar (+2 分/颗)', desc: '只能计最后 60 秒投入的 Nectar！联盟上限 8 颗', color: '#f59e0b', preferredPos: 'left' },
        { selector: '.biobuzz-endgame-steppers .endgame-stepper-card:nth-child(2)', label: '(2) 花朵占底大球 (+5 分/朵)', desc: '每朵由己方 Nectar 封底的花奖 +5 分（最多 4 朵且≤大球数）', color: '#39ff14', preferredPos: 'right' },
        { selector: '.biobuzz-endgame-steppers .endgame-stepper-card:nth-child(3)', label: '(3) Pollen (+2) 与右侧 Garden (+1)', desc: '无爬升规则！Pollen 需己方有 Nectar 才有效，右侧 Garden 推球+1', color: '#38bdf8', preferredPos: 'left' },
        { selector: '.form-section:has(.biobuzz-endgame-steppers) .biobuzz-toggles-grid', label: '(4) 终局停泊 (+5) / 掏球 (G418) / G410', desc: '勾选终局停泊、合法底口掏球拆台，以及 60 秒前误投 G410 犯规', color: '#f43f5e', preferredPos: 'right' },
        { selector: '.btn-submit', label: '(5) 核对总分后一键保存提交', desc: '点此提交；就算没网也会先存手机本地，有网自动同步！', color: '#a855f7', preferredPos: 'left' }
      ],
      s07: [
        { selector: '.wizard-stepper', label: '(1) 5步向导：赛前→自动→手动→终局→提交', desc: '', color: '#38bdf8', preferredPos: 'top', gap: 3 },
        { selector: '.preset-capsules-grid', label: '(2) 1–4 球快捷胶囊', desc: '拇指单手一键记多球', color: '#f59e0b', preferredPos: 'top', gap: 4 },
        { selector: '.teleop-hero-hit', label: '(3) 拇指盲操超大绿键 (+2分)', desc: '盯紧场内直接盲按不出错', color: '#39ff14', preferredPos: 'bottom' },
        { selector: '.btn-new-cycle', label: '(4) 下一轮打卡计速键', desc: '打完一趟点一下自动计耗时', color: '#a855f7', preferredPos: 'bottom' }
      ],
      s08: [
        { selector: '.pit-toolbar .filter-controls', label: '(1) 按录入状态/大车小车过滤与排序', desc: '快速查哪支队伍还没去展位走访，或对比大车/小车', color: '#38bdf8', preferredPos: 'top' },
        { selector: '.team-roster-card:nth-child(3) .hardware-pills', label: '(2) 体重 · 大/小车 · 放花/掏球/视觉徽章', desc: '仅客观展示重量与大车/小车特征（无超重警报），含放花与掏球', color: '#39ff14', preferredPos: 'top', gap: 118 },
        { selector: '.team-roster-card:nth-child(3) .quant-grid', label: '(3) 展位自述理论分 vs 实战对比', desc: '把展位吹的轮次数、自动与 BIOBUZZ 终局分和赛场真成绩同框排比', color: '#f59e0b', preferredPos: 'bottom', gap: 195 },
        { selector: '.team-roster-card:nth-child(3) .match-reconcile-bar', label: '(4) 吹牛指数 + 放花/停泊履约实测', desc: '系统自动核验“花朵已证实”“停泊已证实”，一眼揪出嘴强王者', color: '#a855f7', preferredPos: 'bottom', gap: 16 }
      ],
      s09: [
        { selector: '.toolbar-right', label: '(1) 一键自动排班 & 导入赛程', desc: '主办方点自动排班，系统把 4 个场边工位均匀分给所有队员', color: '#38bdf8', preferredPos: 'left' },
        { selector: '.schedule-table .match-row:first-child .btn-match-whiteboard', label: '(2) 场次号 + 一键跳战术白板', desc: '点画笔小图标，直接把这场的 4 支队带进战术白板推演', color: '#a855f7', preferredPos: 'bottom' },
        { selector: '.schedule-table .match-row:nth-child(2) .station-card.red', label: '(3) 红蓝联盟工位战队卡', desc: '清晰标出红1/红2/蓝1/蓝2对应的真实车号', color: '#f43f5e', preferredPos: 'bottom' },
        { selector: '.schedule-table .match-row:nth-child(3) .station-card.blue .scout-select', label: '(4) 指派具体某位队员盯这台车', desc: '下拉框选人，选中后对方手机顶部会自动跳出“一键接单”横幅！', color: '#39ff14', preferredPos: 'bottom' }
      ],
      s10: [
        { selector: '.ranking-row:first-child td:nth-child(8)', label: '(1) 场均机动分 (Swarm RP)', desc: '离墙(3)+自动停泊(5)+终局停泊(5)；双车合计≥16分拿联盟RP', color: '#38bdf8', preferredPos: 'top', gap: 56 },
        { selector: '.ranking-row:nth-child(5) td:nth-child(10)', label: '(2) BIOBUZZ 花朵与 Garden 实绩', desc: 'N=大球 Nectar / B=占底 / P=Pollen / G=Garden 场均数据', color: '#f59e0b', preferredPos: 'bottom', gap: 16 },
        { selector: '.ranking-row:first-child td:nth-child(11)', label: '(3) 预测单轮耗时 (≥6轮触发)', desc: '打满 6 轮剔除最快 1 次取 4 轮均值；不足 6 轮如第5行显示“不足6轮”', color: '#39ff14', preferredPos: 'top', gap: 56 },
        { selector: '.ranking-row:first-child td:nth-child(15) .brag-tier-pill', label: '(4) 吹牛指数与实测真伪徽章', desc: '对比展位自述与赛场实打实得分，选联队时优先挑“真实守信”队友', color: '#a855f7', preferredPos: 'top', gap: 56 }
      ],
      s11: [
        { selector: '[data-testid="wb-match-select"]', label: '(1) 选推演场次与 Auto/Tele/End 阶段', desc: '选 Q1..Q5 规划三阶段路线', color: '#38bdf8', preferredPos: 'right' },
        { selector: '[data-testid="whiteboard-canvas"]', label: '(2) BIOBUZZ 战术画板', desc: '手指/鼠标拖 4 台机器人站位，画实线路径、虚线传球与禁区', color: '#39ff14', preferredPos: 'top' },
        { selector: '[data-testid="wb-btn-play-sim"]', label: '(3) 一键动态路线推演播放', desc: '点此播放按钮，让四台车按你画的箭头轨迹真实动起来看会不会撞车！', color: '#f59e0b', preferredPos: 'bottom' },
        { selector: '[data-testid="wb-swarm-rp-strip"]', label: '(4) 胜率预测 · Swarm RP · 单轮节奏', desc: '自动算红蓝预估总分、Swarm RP ≥16 缺口、8 Nectar 预算与耗时芯片', color: '#a855f7', preferredPos: 'left', allowOverlapOtherBoxes: true }
      ],
      s08b: [
        { selector: '.drawer-header', label: '(1) 当前编辑队伍编号与标题栏', desc: '点击卡片底部“查看/修改”即弹出此抽屉录入页', color: '#38bdf8', preferredPos: 'left' },
        { selector: '.drawer-body .form-section:nth-child(2)', label: '(2) 体重 · 紧凑小车/宽体大车 · 硬件特性', desc: '如实选体重、大小车轮廓、放花机构与掏球/AprilTag 开关（绝无超重警报）', color: '#39ff14', preferredPos: 'left' },
        { selector: '.drawer-body .form-section:nth-child(3)', label: '(3) 自述自动 / 手动 / BIOBUZZ 终局量化', desc: '问清楚对手声称能拿几分、放几颗 Nectar/Pollen 与能否终局停泊', color: '#f59e0b', preferredPos: 'left' },
        { selector: '.drawer-footer .btn-primary', label: '(4) 保存展位数据（断网也能存）', desc: '点保存立刻刷新卡片与吹牛指数基线', color: '#a855f7', preferredPos: 'left' }
      ],
      s12: [
        { selector: '.history-card .card-teams', label: '(1) 场次号、队伍与红蓝阵营徽章', desc: '按比赛顺序排列，快速找到你刚提交错的那一场记录', color: '#38bdf8', preferredPos: 'bottom' },
        { selector: '.history-card .card-biobuzz-pills', label: '(2) BIOBUZZ 终局与单轮耗时明细', desc: '一目了然列出本场 Nectar/占底/Pollen/Garden 与 Predict Cycle 秒数', color: '#f59e0b', preferredPos: 'bottom' },
        { selector: '.history-card .btn-edit', label: '(3) 点“编辑”回到打分表改记录', desc: '点此按钮自动跳回表单编辑模式，改完分数后点底部“保存”即可覆盖更新', color: '#39ff14', preferredPos: 'left' },
        { selector: '.history-card .card-score', label: '(4) 实时总分与同步状态', desc: '绿色表示已成功同步至主机总库', color: '#a855f7', preferredPos: 'left' }
      ],
      s13: [
        { selector: '.inner-tabs', label: '(1) 在“对话”与“设置”间切换', desc: '首次使用先点右边“设置”绑定你的大模型 API Key', color: '#38bdf8', preferredPos: 'bottom' },
        { selector: '.settings-form select', label: '(2) 选择 AI 服务商协议与预设', desc: '支持 DeepSeek / Moonshot / OpenAI 兼容或 Google Gemini', color: '#f59e0b', preferredPos: 'right' },
        { selector: '.settings-form input[type="password"]', label: '(3) 粘贴 API Key（可点上方链接直达申请）', desc: '密钥仅加密保存在你的账号配置中，点右上方链接可去官方控制台生成', color: '#39ff14', preferredPos: 'bottom' },
        { selector: '.settings-form .button-group', label: '(4) 先“测试连接”再点“保存设置”', desc: '看到绿色“连接成功”提示后切回“对话”页即可开始提问', color: '#a855f7', preferredPos: 'top' }
      ],
      s14: [
        { selector: '.btn-toggle-prompt', label: '(1) 自定义 AI 教练人设 / 提示词', desc: '可展开微调回答风格（如“只看淘汰赛选联队”）', color: '#38bdf8', preferredPos: 'bottom' },
        { selector: '.data-badge', label: '(2) 自动携带全场队伍实测数据', desc: '无需手动复制表格！系统自动附带所有队伍的 Predict Cycle Time 与 BIOBUZZ 数据', color: '#39ff14', preferredPos: 'bottom' },
        { selector: '.attach-toggle', label: '(3) 勾选“附带赛事数据上下文”', desc: '保持勾选，AI 才能基于真实赛场表现帮你分析队友', color: '#f59e0b', preferredPos: 'bottom' },
        { selector: '.chat-input-area', label: '(4) 输入大白话问题并点击发送', desc: '例如直接问“帮我对比 27570 和 11115 谁更稳，会不会吹牛？”', color: '#a855f7', preferredPos: 'top' }
      ],
      s15: [
        { selector: '.cf-tabs', label: '(1) 切换挂在“比赛表单”还是“展位侦察”', desc: '按需要给看台打分表或维修区展位表加专属字段', color: '#38bdf8', preferredPos: 'bottom' },
        { selector: '.btn-create-field', label: '(2) 点此“新增自定义字段”', desc: '支持数字、是/否开关、1–5 评分等级、单选、备注文本，并可指定放进自动/手动/终局哪个区', color: '#39ff14', preferredPos: 'left' },
        { selector: '.cf-card', label: '(3) 实时启用/停用、调序、编辑或删除', desc: '启用后所有队员表单会自动多出这个字段，排名表也能一键勾选展示列！', color: '#f59e0b', preferredPos: 'bottom' },
        { selector: '.cf-modal-header .btn-close', label: '(4) 配好直接关闭即可全局生效', desc: '字段定义会自动同步给房间内所有联网队友', color: '#a855f7', preferredPos: 'left' }
      ],
      s16: [
        { selector: '.event-scouts-panel .settings-panel:first-child .form-group:nth-of-type(1)', label: '(1) 填写 FTC 赛季年份（网址中的起始年）', desc: '按 ftc-events.firstinspires.org/<年份>/<代码> 填写，如 2025-26 赛季填 2025', color: '#38bdf8', preferredPos: 'right', maxBoxWidth: 280, badgeAlign: 'right' },
        { selector: '.event-scouts-panel .settings-panel:first-child .form-group:nth-of-type(2)', label: '(2) 填写官方比赛代码 Event Code', desc: '填官网赛事页末尾代码（如 AUADQ / USUTSAS1），系统会自动校验是否存在', color: '#39ff14', preferredPos: 'right', maxBoxWidth: 660, badgeAlign: 'right' },
        { selector: '.event-scouts-panel .settings-panel:first-child .settings-form .btn-primary', label: '(3) 一键绑定并同步官方数据', desc: '软件已内置 FTC API 通道无需自备 Key！绑定后可同步名单、赛程、官方比分与顺延晋级分', color: '#f59e0b', preferredPos: 'right', maxBoxWidth: 960 },
        { selector: '.event-scouts-panel > .settings-panel:nth-child(2) .settings-form .btn-primary:last-child', label: '(4) 赛后导出 CSV 与无外网 U盘离线同步', desc: '主机没通外网时仍可正常排班记分，或通过 U盘同步文件与 CSV 导出完整战报', color: '#a855f7', preferredPos: 'right' }
      ]
    },
    aiSamplePrompt: '请结合本场真实数据对比 #27570 和 #11115：谁的 Predict Cycle Time 更稳、Swarm RP 更靠谱，选联队优先选谁？',
    customFieldSample: { name: '防守抗干扰能力', key: 'defense_resilience', hint: '1=易被撞停，5=丝滑抗防' }
  },
  en: {
    eventName: '2026 BIOBUZZ Regional',
    demoNotes: [
      'Clean Auto Leave + Park, smooth 6-cycle TeleOp pacing, plus 2 last-60s Flower Nectars with bottom bonus.',
      'Compact nimble chassis weaves fast through traffic; reliable Pollen feeder.',
      'Steady 6-cycle rhythm; excels at Garden push and opponent Flower bottom descore (G418).',
      'Defense & Garden push specialist (<6 cycles logged, focused on lane control & Swarm RP Park).'
    ],
    pitStrategies: {
      27570: '2-ball Auto + Leave + Park; fast 7-cycle TeleOp; dual Flower top/bottom lock + Park',
      11115: 'Compact <=15" frame threads tight gaps; 6-7 fast cycles + Pivot Arm Flower + Descore',
      28410: 'Wide stable chassis for Garden pushes & launcher scoring; high claims pending match check',
      9999: 'Defensive midfield disruptor & Garden feeder helping alliance lock Swarm RP Park'
    },
    robotNames: {
      27570: 'Swarm Alpha',
      11115: 'Vortex Mini',
      28410: 'Garden Titan',
      9999: 'Shield Runner',
      31024: 'Photon Bee'
    },
    tacticalNote: 'Q1 Red Plan: #27570 runs 6-cycle TeleOp & caps 2 Flowers; compact #11115 sweeps outer Pollens and locks Endgame Park for Swarm RP.',
    annotations: {
      s01: [
        { selector: '.lang-btn', label: '(1) Switch Language (EN / 中文)', desc: 'Toggle full English or Chinese interface anytime in one click', color: '#38bdf8', preferredPos: 'bottom' },
        { selector: '#username', label: '(2) Enter Your Name or Callsign', desc: 'Use a simple nickname (no email needed) so teammates know who scouted', color: '#39ff14', preferredPos: 'left' },
        { selector: '#confirmPassword', label: '(3) Pick Any Password on First Visit', desc: 'Confirm password box opens automatically for instant offline-ready signup', color: '#f59e0b', preferredPos: 'right' },
        { selector: 'button[type="submit"]', label: '(4) Sign In or Create Account', desc: 'Stays logged in offline on bleachers even if arena Wi-Fi drops', color: '#a855f7', preferredPos: 'bottom' }
      ],
      s02: [
        { selector: ['.channel-pill-bar', '.qr-modal-header'], label: '(1) Cloud vs Arena LAN / Hotspot', desc: 'No venue internet? Switch to Arena LAN/Hotspot for direct local sync', color: '#38bdf8', preferredPos: 'right' },
        { selector: '.code-badge-bar', label: '(2) 6-Character Invite Code', desc: 'Tap to copy the event code for teammates typing manually', color: '#f59e0b', preferredPos: 'left' },
        { selector: '.qr-canvas-container canvas', label: '(3) Scan QR Code on Any Phone', desc: 'Scouts scan directly with camera or browser to join your event lobby', color: '#39ff14', preferredPos: 'right' },
        { selector: '.url-copy-box', label: '(4) Direct Join Web Link', desc: 'One-click copy link to paste into team chat or Discord', color: '#a855f7', preferredPos: 'bottom' }
      ],
      s03: [
        { selector: '.setting-group:first-child .segmented-control', label: '(1) Single Team vs Alliance Mode', desc: 'Beginners pick Single Team so you only watch and track one robot', color: '#38bdf8', preferredPos: 'right' },
        { selector: '.spdt-switch', label: '(2) Flip Red or Blue Alliance', desc: 'Match the robot bumper color: left for Red Alliance, right for Blue', color: '#f43f5e', preferredPos: 'left' },
        { selector: 'input[placeholder="e.g. 12345"]', label: '(3) Enter Match # & Team Number', desc: 'Typing the team # instantly loads their Pit profile below', color: '#39ff14', preferredPos: 'right' },
        { selector: '.pit-quick-hint', label: '(4) Live Pit Intel Preview', desc: 'Displays chassis size, flower mechanism & claimed score to catch typos', color: '#f59e0b', preferredPos: 'left' }
      ],
      s04: [
        { selector: '.phase-auto .pad-hit-btn', label: '(1) Auto Ball Scored (+3 pts each)', desc: 'Tap once per Auto ball scored during the opening 30 seconds', color: '#39ff14', preferredPos: 'left' },
        { selector: '.phase-auto .pad-miss-btn', label: '(2) Auto Ball Missed (+1 miss)', desc: 'Logs missed Auto shots cleanly for shot accuracy tracking', color: '#f43f5e', preferredPos: 'right' },
        { selector: '.form-section:has(.phase-auto) .biobuzz-toggles-grid .toggle-card:nth-child(1)', label: '(3) Full Leave Wall (+3 pts · Swarm RP)', desc: 'Check if robot completely leaves starting wall/zone', color: '#38bdf8', preferredPos: 'bottom' },
        { selector: '.form-section:has(.phase-auto) .biobuzz-toggles-grid .toggle-card:nth-child(2)', label: '(4) Auto Loading Park (+5 pts · RP)', desc: 'Check if robot parks in Loading Zone at end of Autonomous', color: '#f59e0b', preferredPos: 'bottom' }
      ],
      s05: [
        { selector: '.phase-teleop .pad-hit-btn', label: '(1) TeleOp Hit Button (+2 pts/ball)', desc: 'Tap per ball scored while watching the field — zero squinting needed', color: '#39ff14', preferredPos: 'left' },
        { selector: '.phase-teleop .chamber-dots', label: '(2) Chamber Cycle Dots (Max 4)', desc: 'Green dots show hits and red dots show misses in the current run', color: '#38bdf8', preferredPos: 'left' },
        { selector: '.phase-teleop .chips-group', label: '(3) Quick 1–4 Ball Preset Chips', desc: 'Robot dumped 3 balls fast? Tap chip "3" once to log all 3', color: '#f59e0b', preferredPos: 'right' },
        { selector: '.phase-teleop .btn-new-cycle', label: '(4) Next Cycle Logs Speed (≥6 Cycles)', desc: 'Tap when robot heads back for balls; ≥6 cycles unlocks Predict Cycle Time', color: '#a855f7', preferredPos: 'right' }
      ],
      s06: [
        { selector: '.biobuzz-endgame-steppers .endgame-stepper-card:nth-child(1)', label: '(1) Last-60s Flower Nectars (+2/ea)', desc: 'Count Nectars placed ONLY in last 60s (max 8 per alliance)', color: '#f59e0b', preferredPos: 'left' },
        { selector: '.biobuzz-endgame-steppers .endgame-stepper-card:nth-child(2)', label: '(2) Bottom Nectar Bonus (+5/flower)', desc: 'Flowers owning >=1 bottom Nectar (+5 pts each, capped at Nectars <= 4)', color: '#39ff14', preferredPos: 'right' },
        { selector: '.biobuzz-endgame-steppers .endgame-stepper-card:nth-child(3)', label: '(3) Pollens (+2) & Right Garden (+1)', desc: 'No climbing in BIOBUZZ! Pollens need alliance Nectar; Garden = +1/ball', color: '#38bdf8', preferredPos: 'left' },
        { selector: '.form-section:has(.biobuzz-endgame-steppers) .biobuzz-toggles-grid', label: '(4) Endgame Park (+5) / Descore / G410', desc: 'Toggle Loading Park, opponent Flower Descore (G418), or <60s G410 Foul', color: '#f43f5e', preferredPos: 'right' },
        { selector: '.btn-submit', label: '(5) Verify Live Total & Submit', desc: 'Saves instantly; queues offline safely if stadium signal drops', color: '#a855f7', preferredPos: 'left' }
      ],
      s07: [
        { selector: '.wizard-stepper', label: '(1) 5-Step: Setup->Auto->Tele->End->Submit', desc: '', color: '#38bdf8', preferredPos: 'top', gap: 3 },
        { selector: '.preset-capsules-grid', label: '(2) 1–4 Ball Quick Capsules', desc: 'Log multi-ball dumps with one thumb tap', color: '#f59e0b', preferredPos: 'top', gap: 4 },
        { selector: '.teleop-hero-hit', label: '(3) Giant Eyes-Free Thumb Pad (+2)', desc: 'Watch the field while tapping hits reliably', color: '#39ff14', preferredPos: 'bottom' },
        { selector: '.btn-new-cycle', label: '(4) Next Cycle Speed Logger', desc: 'Tap between runs for Predict Cycle Time', color: '#a855f7', preferredPos: 'bottom' }
      ],
      s08: [
        { selector: '.pit-toolbar .filter-controls', label: '(1) Filter by Status, Chassis Size & Sort', desc: 'Spot unvisited pits or compare compact vs wide robots', color: '#38bdf8', preferredPos: 'top' },
        { selector: '.team-roster-card:nth-child(3) .hardware-pills', label: '(2) Weight · Size · Flower / Descore / Vision', desc: 'Neutral weight & Small/Large chassis cues (no false weight warnings!)', color: '#39ff14', preferredPos: 'top', gap: 118 },
        { selector: '.team-roster-card:nth-child(3) .quant-grid', label: '(3) Pit Claimed vs Match Actuals', desc: 'Side-by-side Auto, TeleOp cycles, and BIOBUZZ Endgame vs field output', color: '#f59e0b', preferredPos: 'bottom', gap: 195 },
        { selector: '.team-roster-card:nth-child(3) .match-reconcile-bar', label: '(4) Brag Index + Flower/Park Verified', desc: 'Confirms Flower & Park claims from real match rawData automatically', color: '#a855f7', preferredPos: 'bottom', gap: 16 }
      ],
      s09: [
        { selector: '.toolbar-right', label: '(1) Auto-Fill Duty & Import FTC Schedule', desc: 'One click spreads all 4 station watches evenly across your scouts', color: '#38bdf8', preferredPos: 'left' },
        { selector: '.schedule-table .match-row:first-child .btn-match-whiteboard', label: '(2) Match Badge + Whiteboard Shortcut', desc: 'Tap the draw icon to jump straight into Whiteboard prep for that match', color: '#a855f7', preferredPos: 'bottom' },
        { selector: '.schedule-table .match-row:nth-child(2) .station-card.red', label: '(3) Red & Blue Station Cards', desc: 'Shows all 4 robots (Red 1/2, Blue 1/2) cleanly per qualification match', color: '#f43f5e', preferredPos: 'bottom' },
        { selector: '.schedule-table .match-row:nth-child(3) .station-card.blue .scout-select', label: '(4) Assign Specific Scout per Robot', desc: 'Picked scout gets a 1-tap "Load Assigned Task" banner in their form', color: '#39ff14', preferredPos: 'bottom' }
      ],
      s10: [
        { selector: '.ranking-row:first-child td:nth-child(8)', label: '(1) Mobility RP Pts (Swarm RP)', desc: 'Leave(3) + AutoPark(5) + TeleOpPark(5); Alliance >=16 earns Swarm RP', color: '#38bdf8', preferredPos: 'top', gap: 56 },
        { selector: '.ranking-row:nth-child(5) td:nth-child(10)', label: '(2) BIOBUZZ Flower & Garden Avgs', desc: 'Shows avg Nectars (N), Bottom Bonus (B), Pollens (P), and Garden (G)', color: '#f59e0b', preferredPos: 'bottom', gap: 16 },
        { selector: '.ranking-row:first-child td:nth-child(11)', label: '(3) Predict Cycle Time (>=6 Cycles)', desc: 'Drops fastest 1 & averages next 4; row 5 flags <6 cyc as insufficient', color: '#39ff14', preferredPos: 'top', gap: 56 },
        { selector: '.ranking-row:first-child td:nth-child(15) .brag-tier-pill', label: '(4) Brag Index Verification Badge', desc: 'Honesty multiplier + Flower/Park verification for alliance selection', color: '#a855f7', preferredPos: 'top', gap: 56 }
      ],
      s11: [
        { selector: '[data-testid="wb-match-select"]', label: '(1) Match & Auto/Tele/End Selector', desc: 'Pick Q1..Q5 & toggle phase layers', color: '#38bdf8', preferredPos: 'right' },
        { selector: '[data-testid="whiteboard-canvas"]', label: '(2) Interactive BIOBUZZ Field Canvas', desc: 'Drag all 4 robots, draw solid routes, pass lines, and defense zones', color: '#39ff14', preferredPos: 'top' },
        { selector: '[data-testid="wb-btn-play-sim"]', label: '(3) Play Trajectory Simulation', desc: 'Animates robots smoothly along drawn arrows to catch traffic collisions', color: '#f59e0b', preferredPos: 'bottom' },
        { selector: '[data-testid="wb-swarm-rp-strip"]', label: '(4) Alliance Forecast, Swarm RP & Speed', desc: 'Live predicted score, Swarm RP >=16 check, 8-Nectar cap & cycle chips', color: '#a855f7', preferredPos: 'left', allowOverlapOtherBoxes: true }
      ],
      s08b: [
        { selector: '.drawer-header', label: '(1) Pit Form Drawer Header (Team #)', desc: 'Opens when you tap "View / Edit Pit Data" on any team card', color: '#38bdf8', preferredPos: 'left' },
        { selector: '.drawer-body .form-section:nth-child(2)', label: '(2) Weight · Small/Large Chassis · Hardware', desc: 'Log neutral weight, Compact/Wide chassis, flower lift, Descore & AprilTag (no false alerts)', color: '#39ff14', preferredPos: 'left' },
        { selector: '.drawer-body .form-section:nth-child(3)', label: '(3) Claimed Auto, TeleOp & BIOBUZZ Endgame', desc: 'Record what the pit crew claims they score (feeds Brag Index checks)', color: '#f59e0b', preferredPos: 'left' },
        { selector: '.drawer-footer .btn-primary', label: '(4) Save Pit Record (Works Offline)', desc: 'Saves immediately and updates team cards + scouting form hints', color: '#a855f7', preferredPos: 'left' }
      ],
      s12: [
        { selector: '.history-card .card-teams', label: '(1) Match #, Team # & Alliance Badge', desc: 'Sorted by match so you can quickly find any entry to fix', color: '#38bdf8', preferredPos: 'bottom' },
        { selector: '.history-card .card-biobuzz-pills', label: '(2) BIOBUZZ Endgame & Cycle Pills', desc: 'Shows Nectar/Bottom/Pollen/Garden counts and Predict Cycle pace', color: '#f59e0b', preferredPos: 'bottom' },
        { selector: '.history-card .btn-edit', label: '(3) Tap "Edit" to Fix Any Record', desc: 'Re-opens the Scout form in edit mode—change numbers and click Save!', color: '#39ff14', preferredPos: 'left' },
        { selector: '.history-card .card-score', label: '(4) Total Score & Sync Status', desc: 'Green badge confirms the record synced to the Host database', color: '#a855f7', preferredPos: 'left' }
      ],
      s13: [
        { selector: '.inner-tabs', label: '(1) Switch Between Chat & Settings', desc: 'Open Settings first to bind your AI API Key', color: '#38bdf8', preferredPos: 'bottom' },
        { selector: '.settings-form select', label: '(2) Choose Provider & Preset', desc: 'Supports DeepSeek, Moonshot, OpenAI-compatible, or Google Gemini', color: '#f59e0b', preferredPos: 'right' },
        { selector: '.settings-form input[type="password"]', label: '(3) Paste API Key (+ One-Click Key Link)', desc: 'Encrypted per-user; click "Get API Key" above to open the provider console', color: '#39ff14', preferredPos: 'bottom' },
        { selector: '.settings-form .button-group', label: '(4) Test Connection, Then Save', desc: 'Once "Connection Successful" appears, switch back to Chat to ask questions', color: '#a855f7', preferredPos: 'top' }
      ],
      s14: [
        { selector: '.btn-toggle-prompt', label: '(1) Customize AI Coach Persona', desc: 'Expand to tune analysis style (e.g., focus on playoff alliance picks)', color: '#38bdf8', preferredPos: 'bottom' },
        { selector: '.data-badge', label: '(2) Auto-Attached Live Event Telemetry', desc: 'Zero manual copy-paste! Includes Predict Cycle Time, Swarm RP & BIOBUZZ stats', color: '#39ff14', preferredPos: 'bottom' },
        { selector: '.attach-toggle', label: '(3) Include Event Data Context', desc: 'Keep checked so the AI answers using real match results', color: '#f59e0b', preferredPos: 'bottom' },
        { selector: '.chat-input-area', label: '(4) Ask Plain Questions & Send', desc: 'Example: "Compare #27570 vs #11115 for alliance selection"', color: '#a855f7', preferredPos: 'top' }
      ],
      s15: [
        { selector: '.cf-tabs', label: '(1) Choose Target: Match Form vs Pit Form', desc: 'Attach extra team-specific questions to either form', color: '#38bdf8', preferredPos: 'bottom' },
        { selector: '.btn-create-field', label: '(2) Add New Custom Field', desc: 'Supports Number, Toggle, 1–5 Rating, Select, or Text in any match phase', color: '#39ff14', preferredPos: 'left' },
        { selector: '.cf-card', label: '(3) Toggle, Reorder, Edit or Delete', desc: 'Active fields auto-appear on every scout device and in Rankings columns', color: '#f59e0b', preferredPos: 'bottom' },
        { selector: '.cf-modal-header .btn-close', label: '(4) Close When Done — Syncs Live', desc: 'Custom fields sync automatically across your connected scouting team', color: '#a855f7', preferredPos: 'left' }
      ],
      s16: [
        { selector: '.event-scouts-panel .settings-panel:first-child .form-group:nth-of-type(1)', label: '(1) Enter FTC Season Year (URL Start Year)', desc: 'Match ftc-events.firstinspires.org/<year>/<code> (e.g., 2025 for 2025-26 season)', color: '#38bdf8', preferredPos: 'right', maxBoxWidth: 280, badgeAlign: 'right' },
        { selector: '.event-scouts-panel .settings-panel:first-child .form-group:nth-of-type(2)', label: '(2) Enter Official FTC Event Code', desc: 'Copy the event code from FTC Events URL (e.g., AUADQ, USUTSAS1); backend verifies it', color: '#39ff14', preferredPos: 'right', maxBoxWidth: 660, badgeAlign: 'right' },
        { selector: '.event-scouts-panel .settings-panel:first-child .settings-form .btn-primary', label: '(3) Bind & Sync Official Data', desc: 'Built-in API credentials included! Unlocks Roster, Schedule, Score Audit & Roll-Down Adv. Pts', color: '#f59e0b', preferredPos: 'right', maxBoxWidth: 960 },
        { selector: '.event-scouts-panel > .settings-panel:nth-child(2) .settings-form .btn-primary:last-child', label: '(4) CSV Exports & Offline USB Sync', desc: 'Export Rankings/Records CSV anytime, or move packets offline if venue internet drops', color: '#a855f7', preferredPos: 'right' }
      ]
    },
    aiSamplePrompt: 'Compare #27570 and #11115 using our live data: whose Predict Cycle Time and Swarm RP look stronger for alliance selection?',
    customFieldSample: { name: 'Defense Resilience', key: 'defense_resilience', hint: '1 = stalls easily, 5 = pushes through defense' }
  }
};

function buildSeedPayload(lang, eventId, scoutInfo) {
  const c = COPY[lang];
  const tsBase = 1_760_000_000_000;

  const pitSpecs = [
    {
      team: 27570,
      drivetrainType: 'swerve',
      weightLbs: 44.5,
      chassisSize: 'wide_large',
      odometryType: 'pinpoint',
      ballCompatibility: 'universal',
      launcherType: 'dual_flywheel',
      flowerMechanism: 'vertical_lift',
      hasColorSensor: true,
      hasDescoreMech: true,
      hasApriltagVision: true,
      claimedAutoScore: 14,
      claimedTeleopCycles: 7,
      claimedTeleopScore: 52,
      claimedTeleopPark: true,
      claimedFlowerNectars: 3,
      claimedFlowerBottomBonus: 2,
      claimedFlowerPollens: 4,
      claimedGardenBalls: 3
    },
    {
      team: 11115,
      drivetrainType: 'mecanum',
      weightLbs: 36.2,
      chassisSize: 'compact_small',
      odometryType: 'sparkfun_otos',
      ballCompatibility: 'universal',
      launcherType: 'curved_rail',
      flowerMechanism: 'pivot_arm',
      hasColorSensor: true,
      hasDescoreMech: true,
      hasApriltagVision: true,
      claimedAutoScore: 11,
      claimedTeleopCycles: 6,
      claimedTeleopScore: 44,
      claimedTeleopPark: true,
      claimedFlowerNectars: 2,
      claimedFlowerBottomBonus: 1,
      claimedFlowerPollens: 3,
      claimedGardenBalls: 2
    },
    {
      team: 28410,
      drivetrainType: 'tank',
      weightLbs: 41.8,
      chassisSize: 'standard_mid',
      odometryType: 'two_wheel',
      ballCompatibility: 'sorting',
      launcherType: 'single_flywheel',
      flowerMechanism: 'angled_launcher',
      hasColorSensor: true,
      hasDescoreMech: false,
      hasApriltagVision: false,
      claimedAutoScore: 14,
      claimedTeleopCycles: 7,
      claimedTeleopScore: 60,
      claimedTeleopPark: true,
      claimedFlowerNectars: 3,
      claimedFlowerBottomBonus: 2,
      claimedFlowerPollens: 2,
      claimedGardenBalls: 4
    },
    {
      team: 9999,
      drivetrainType: 'mecanum',
      weightLbs: 34.8,
      chassisSize: 'compact_small',
      odometryType: 'none',
      ballCompatibility: 'pollen_only',
      launcherType: 'spring_punch',
      flowerMechanism: 'none',
      hasColorSensor: false,
      hasDescoreMech: true,
      hasApriltagVision: false,
      claimedAutoScore: 8,
      claimedTeleopCycles: 4,
      claimedTeleopScore: 24,
      claimedTeleopPark: true,
      claimedFlowerNectars: 0,
      claimedFlowerBottomBonus: 0,
      claimedFlowerPollens: 0,
      claimedGardenBalls: 5
    },
    {
      team: 31024,
      drivetrainType: 'swerve',
      weightLbs: 39.4,
      chassisSize: 'standard_mid',
      odometryType: 'three_wheel',
      ballCompatibility: 'universal',
      launcherType: 'dual_flywheel',
      flowerMechanism: 'vertical_lift',
      hasColorSensor: true,
      hasDescoreMech: false,
      hasApriltagVision: true,
      claimedAutoScore: 11,
      claimedTeleopCycles: 6,
      claimedTeleopScore: 40,
      claimedTeleopPark: true,
      claimedFlowerNectars: 2,
      claimedFlowerBottomBonus: 1,
      claimedFlowerPollens: 2,
      claimedGardenBalls: 2
    }
  ];

  const officialTeams = pitSpecs.map((p) => ({
    eventId,
    teamNumber: p.team,
    nameFull: c.robotNames[p.team],
    robotName: c.robotNames[p.team],
    city: lang === 'zh' ? '上海' : 'Chicago',
    country: lang === 'zh' ? '中国' : 'USA'
  }));

  const pitRecords = pitSpecs.map((p) => {
    const claimedEndgameScore =
      (p.claimedTeleopPark ? 5 : 0) +
      p.claimedFlowerNectars * 2 +
      p.claimedFlowerBottomBonus * 5 +
      p.claimedFlowerPollens * 2 +
      p.claimedGardenBalls;
    const claimedTotalScore = p.claimedAutoScore + p.claimedTeleopScore + claimedEndgameScore;

    const payload = {
      id: `${eventId}_pit_${p.team}`,
      eventId,
      teamNumber: p.team,
      scoutId: scoutInfo.id,
      scoutName: scoutInfo.username,
      robotName: c.robotNames[p.team],
      drivetrainType: p.drivetrainType,
      weightLbs: p.weightLbs,
      chassisSize: p.chassisSize,
      odometryType: p.odometryType,
      ballCompatibility: p.ballCompatibility,
      launcherType: p.launcherType,
      flowerMechanism: p.flowerMechanism,
      hasColorSensor: p.hasColorSensor,
      hasDescoreMech: p.hasDescoreMech,
      hasApriltagVision: p.hasApriltagVision,
      claimedAutoStrategy: c.pitStrategies[p.team],
      claimedAutoScore: p.claimedAutoScore,
      claimedTeleopCycles: p.claimedTeleopCycles,
      claimedTeleopScore: p.claimedTeleopScore,
      claimedTeleopPark: p.claimedTeleopPark,
      claimedFlowerNectars: p.claimedFlowerNectars,
      claimedFlowerBottomBonus: p.claimedFlowerBottomBonus,
      claimedFlowerPollens: p.claimedFlowerPollens,
      claimedGardenBalls: p.claimedGardenBalls,
      claimedEndgameScore,
      claimedTotalScore,
      photoKeys: [],
      version: 1
    };
    payload.rawData = JSON.stringify(payload);
    return payload;
  });

  const makeMatchRecord = ({
    id,
    matchNumber,
    teamNumber,
    allianceColor,
    autoLeave,
    autoBalls,
    autoPark,
    teleopCycles,
    teleopMissedCycles,
    gapSequenceMs,
    teleopPark,
    flowerNectars,
    flowerBottomBonusCount,
    flowerPollens,
    gardenBalls,
    flowerDescore,
    noteIdx
  }) => {
    const autoScore = (autoLeave ? 3 : 0) + autoBalls * 3 + (autoPark ? 5 : 0);
    const teleopScore = teleopCycles.reduce((s, v) => s + v, 0) * 2;
    const clampedBottom = Math.min(flowerBottomBonusCount, flowerNectars, 4);
    const endgameScore =
      (teleopPark ? 5 : 0) +
      flowerNectars * 2 +
      clampedBottom * 5 +
      flowerPollens * 2 +
      gardenBalls;
    const totalScore = autoScore + teleopScore + endgameScore;

    const teleopCycleTimestamps = [];
    let cursor = tsBase + matchNumber * 300_000 + 8_000;
    for (let i = 0; i < teleopCycles.length; i++) {
      if (i > 0) {
        cursor += gapSequenceMs[i - 1] ?? 9500;
      }
      teleopCycleTimestamps.push(cursor);
    }

    const rawObj = {
      matchNumber,
      tournamentLevel: 'QUALIFICATION',
      teamNumber,
      allianceColor,
      isBroken: false,
      autoLeave,
      autoBalls,
      autoCycles: autoBalls > 0 ? [autoBalls] : [],
      autoMissedCycles: autoBalls > 0 ? [0] : [],
      autoPreload: autoBalls > 0,
      autoPark,
      teleopCycles,
      teleopMissedCycles,
      teleopCycleTimestamps,
      flowerNectars,
      flowerBottomBonusCount: clampedBottom,
      flowerPollens,
      gardenBalls,
      flowerDescore,
      g410EarlyFlowerFoul: false,
      flowerPlaced: flowerNectars > 0,
      flowerBottomBonus: clampedBottom > 0,
      teleopPark
    };

    const nowIso = new Date().toISOString();
    return {
      id: `${eventId}_rec_${id}`,
      eventId,
      scoutId: scoutInfo.id,
      scoutName: scoutInfo.username,
      matchNumber,
      teamNumber,
      autoScore,
      teleopScore,
      endgameScore,
      totalScore,
      notes: c.demoNotes[noteIdx % c.demoNotes.length],
      rawData: JSON.stringify(rawObj),
      syncStatus: 'SYNCED',
      createdAt: nowIso,
      updatedAt: nowIso,
      isBroken: false,
      version: 1
    };
  };

  // Match dataset:
  // - 27570, 11115, 28410, 31024 all have >=6 cycles (Predict Cycle Time displays cleanly!)
  // - 9999 intentionally logs 4 cycles (demonstrates "<6 cyc" insufficient badge cleanly!)
  // - 28410 scores lower than high Pit claim -> shows "Overclaimed" / "Optimistic" contrast
  const matchRecords = [
    makeMatchRecord({
      id: 'q1_27570',
      matchNumber: 1,
      teamNumber: 27570,
      allianceColor: 'red',
      autoLeave: true,
      autoBalls: 2,
      autoPark: true,
      teleopCycles: [4, 4, 4, 4, 4, 3, 2],
      teleopMissedCycles: [0, 1, 0, 0, 1, 0, 0],
      gapSequenceMs: [8400, 8900, 8100, 8600, 9100, 8700],
      teleopPark: true,
      flowerNectars: 3,
      flowerBottomBonusCount: 2,
      flowerPollens: 4,
      gardenBalls: 3,
      flowerDescore: true,
      noteIdx: 0
    }),
    makeMatchRecord({
      id: 'q2_27570',
      matchNumber: 2,
      teamNumber: 27570,
      allianceColor: 'red',
      autoLeave: true,
      autoBalls: 2,
      autoPark: true,
      teleopCycles: [4, 4, 3, 4, 4, 3],
      teleopMissedCycles: [0, 0, 1, 0, 0, 0],
      gapSequenceMs: [8800, 8200, 8700, 9000, 8500],
      teleopPark: true,
      flowerNectars: 2,
      flowerBottomBonusCount: 2,
      flowerPollens: 3,
      gardenBalls: 2,
      flowerDescore: false,
      noteIdx: 0
    }),
    makeMatchRecord({
      id: 'q1_11115',
      matchNumber: 1,
      teamNumber: 11115,
      allianceColor: 'red',
      autoLeave: true,
      autoBalls: 1,
      autoPark: true,
      teleopCycles: [4, 3, 4, 3, 4, 3],
      teleopMissedCycles: [0, 1, 0, 0, 1, 0],
      gapSequenceMs: [9200, 9800, 8900, 9500, 9300],
      teleopPark: true,
      flowerNectars: 2,
      flowerBottomBonusCount: 1,
      flowerPollens: 3,
      gardenBalls: 2,
      flowerDescore: true,
      noteIdx: 1
    }),
    makeMatchRecord({
      id: 'q3_11115',
      matchNumber: 3,
      teamNumber: 11115,
      allianceColor: 'blue',
      autoLeave: true,
      autoBalls: 2,
      autoPark: true,
      teleopCycles: [4, 3, 3, 4, 3, 3],
      teleopMissedCycles: [0, 0, 1, 0, 0, 1],
      gapSequenceMs: [9400, 9000, 9600, 9100, 9500],
      teleopPark: true,
      flowerNectars: 2,
      flowerBottomBonusCount: 1,
      flowerPollens: 2,
      gardenBalls: 3,
      flowerDescore: false,
      noteIdx: 1
    }),
    makeMatchRecord({
      id: 'q1_28410',
      matchNumber: 1,
      teamNumber: 28410,
      allianceColor: 'blue',
      autoLeave: true,
      autoBalls: 1,
      autoPark: false,
      teleopCycles: [3, 2, 3, 2, 2, 2],
      teleopMissedCycles: [1, 1, 0, 1, 0, 0],
      gapSequenceMs: [11500, 12800, 11200, 12100, 11900],
      teleopPark: false,
      flowerNectars: 1,
      flowerBottomBonusCount: 0,
      flowerPollens: 1,
      gardenBalls: 3,
      flowerDescore: false,
      noteIdx: 2
    }),
    makeMatchRecord({
      id: 'q2_31024',
      matchNumber: 2,
      teamNumber: 31024,
      allianceColor: 'blue',
      autoLeave: true,
      autoBalls: 1,
      autoPark: true,
      teleopCycles: [3, 3, 3, 3, 3, 2],
      teleopMissedCycles: [0, 1, 0, 0, 1, 0],
      gapSequenceMs: [10100, 10800, 9900, 10400, 10200],
      teleopPark: true,
      flowerNectars: 2,
      flowerBottomBonusCount: 1,
      flowerPollens: 2,
      gardenBalls: 2,
      flowerDescore: false,
      noteIdx: 0
    }),
    makeMatchRecord({
      id: 'q1_9999',
      matchNumber: 1,
      teamNumber: 9999,
      allianceColor: 'blue',
      autoLeave: true,
      autoBalls: 0,
      autoPark: true,
      teleopCycles: [2, 2, 2, 2],
      teleopMissedCycles: [0, 1, 0, 1],
      gapSequenceMs: [14000, 15200, 14600],
      teleopPark: true,
      flowerNectars: 0,
      flowerBottomBonusCount: 0,
      flowerPollens: 0,
      gardenBalls: 4,
      flowerDescore: true,
      noteIdx: 3
    })
  ];

  const schedules = [
    { id: `${eventId}_sch_1`, eventId, matchNumber: 1, tournamentLevel: 'QUALIFICATION', red1: 27570, red2: 11115, blue1: 28410, blue2: 9999 },
    { id: `${eventId}_sch_2`, eventId, matchNumber: 2, tournamentLevel: 'QUALIFICATION', red1: 27570, red2: 28410, blue1: 31024, blue2: 11115 },
    { id: `${eventId}_sch_3`, eventId, matchNumber: 3, tournamentLevel: 'QUALIFICATION', red1: 9999, red2: 31024, blue1: 11115, blue2: 27570 },
    { id: `${eventId}_sch_4`, eventId, matchNumber: 4, tournamentLevel: 'QUALIFICATION', red1: 11115, red2: 9999, blue1: 27570, blue2: 31024 },
    { id: `${eventId}_sch_5`, eventId, matchNumber: 5, tournamentLevel: 'QUALIFICATION', red1: 28410, red2: 31024, blue1: 9999, blue2: 27570 }
  ];

  const assignments = [
    { id: `${eventId}_QUALIFICATION_1_red1`, eventId, matchNumber: 1, tournamentLevel: 'QUALIFICATION', station: 'red1', teamNumber: 27570, scoutId: scoutInfo.id, scoutName: scoutInfo.username },
    { id: `${eventId}_QUALIFICATION_1_red2`, eventId, matchNumber: 1, tournamentLevel: 'QUALIFICATION', station: 'red2', teamNumber: 11115, scoutId: 'scout_demo_alex', scoutName: 'Alex' },
    { id: `${eventId}_QUALIFICATION_1_blue1`, eventId, matchNumber: 1, tournamentLevel: 'QUALIFICATION', station: 'blue1', teamNumber: 28410, scoutId: 'scout_demo_chris', scoutName: 'Chris' },
    { id: `${eventId}_QUALIFICATION_1_blue2`, eventId, matchNumber: 1, tournamentLevel: 'QUALIFICATION', station: 'blue2', teamNumber: 9999, scoutId: 'scout_demo_jordan', scoutName: 'Jordan' },
    { id: `${eventId}_QUALIFICATION_2_red1`, eventId, matchNumber: 2, tournamentLevel: 'QUALIFICATION', station: 'red1', teamNumber: 27570, scoutId: scoutInfo.id, scoutName: scoutInfo.username },
    { id: `${eventId}_QUALIFICATION_2_red2`, eventId, matchNumber: 2, tournamentLevel: 'QUALIFICATION', station: 'red2', teamNumber: 28410, scoutId: 'scout_demo_alex', scoutName: 'Alex' },
    { id: `${eventId}_QUALIFICATION_2_blue1`, eventId, matchNumber: 2, tournamentLevel: 'QUALIFICATION', station: 'blue1', teamNumber: 31024, scoutId: 'scout_demo_chris', scoutName: 'Chris' },
    { id: `${eventId}_QUALIFICATION_2_blue2`, eventId, matchNumber: 2, tournamentLevel: 'QUALIFICATION', station: 'blue2', teamNumber: 11115, scoutId: 'scout_demo_jordan', scoutName: 'Jordan' }
  ];

  const whiteboardPlan = {
    matchKey: 'QUALIFICATION_1',
    matchNumber: 1,
    tournamentLevel: 'QUALIFICATION',
    customTeams: { red1: 27570, red2: 11115, blue1: 28410, blue2: 9999 },
    phases: {
      auto: {
        strokes: [
          {
            id: 'str_auto_1',
            type: 'arrow',
            color: '#ef4444',
            width: 4,
            points: [{ x: 0.16, y: 0.28 }, { x: 0.34, y: 0.42 }, { x: 0.46, y: 0.32 }],
            createdAt: Date.now()
          },
          {
            id: 'str_auto_2',
            type: 'dashed-arrow',
            color: '#f97316',
            width: 3,
            points: [{ x: 0.16, y: 0.72 }, { x: 0.36, y: 0.64 }, { x: 0.50, y: 0.52 }],
            createdAt: Date.now()
          },
          {
            id: 'str_auto_3',
            type: 'arrow',
            color: '#3b82f6',
            width: 4,
            points: [{ x: 0.84, y: 0.28 }, { x: 0.68, y: 0.38 }, { x: 0.58, y: 0.46 }],
            createdAt: Date.now()
          },
          {
            id: 'str_auto_4',
            type: 'rect',
            color: '#eab308',
            width: 3,
            points: [{ x: 0.41, y: 0.22 }, { x: 0.59, y: 0.40 }],
            createdAt: Date.now()
          }
        ],
        undoStack: [],
        redoStack: [],
        robots: {
          red1: { station: 'red1', teamNumber: 27570, x: 0.16, y: 0.28, heading: 0, role: 'scorer' },
          red2: { station: 'red2', teamNumber: 11115, x: 0.16, y: 0.72, heading: 0, role: 'cycler' },
          blue1: { station: 'blue1', teamNumber: 28410, x: 0.84, y: 0.28, heading: 180, role: 'scorer' },
          blue2: { station: 'blue2', teamNumber: 9999, x: 0.84, y: 0.72, heading: 180, role: 'defense' }
        }
      },
      teleop: { strokes: [], undoStack: [], redoStack: [], robots: {} },
      endgame: { strokes: [], undoStack: [], redoStack: [], robots: {} }
    },
    tacticalNotes: c.tacticalNote,
    updatedAt: Date.now()
  };

  return { officialTeams, pitRecords, matchRecords, schedules, assignments, whiteboardPlan };
}

async function captureLocaleSuite(browser, lang) {
  console.log(`\n==================== Capturing [${lang.toUpperCase()}] UserGuide Screenshots ====================`);
  const outDir = path.join(ROOT_OUTPUT_DIR, lang);
  const c = COPY[lang];

  const context = await browser.createBrowserContext();
  const pageErrors = [];
  const page = await context.newPage();
  await page.setViewport(DESKTOP_VIEWPORT);

  page.on('pageerror', (err) => {
    pageErrors.push(`pageerror: ${err.message}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const txt = msg.text();
      if (!txt.includes('favicon') && !txt.includes('[WebRTC:Signaling]')) {
        pageErrors.push(`console.error: ${txt}`);
      }
    }
  });

  await page.evaluateOnNewDocument((targetLang) => {
    localStorage.setItem('app-locale', targetLang);
  }, lang);

  try {
    // 1. Login View
    console.log(`📸 [${lang}] 01/11 Capturing 01_login_roles.png...`);
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await page.evaluate((targetLang) => {
      localStorage.setItem('app-locale', targetLang);
    }, lang);
    // Ensure LoginView uses exact targetLang
    const currentHtmlLang = await page.evaluate(() => document.documentElement.lang);
    if (currentHtmlLang !== lang) {
      await page.click('.lang-btn');
      await delay(300);
    }

    const demoUser = `GuideHost_${lang}_${Date.now().toString().slice(-5)}`;
    await page.waitForSelector('#username', { visible: true, timeout: 10000 });
    await page.type('#username', demoUser);
    await page.evaluate(() => document.querySelector('#username')?.dispatchEvent(new Event('blur')));
    await delay(900);
    await page.waitForSelector('#confirmPassword', { visible: true, timeout: 8000 });
    await page.type('#password', 'userguide123');
    await page.type('#confirmPassword', 'userguide123');

    await verifyLocaleAndCleanUi(page, lang, '01_login_roles');
    await annotateElements(page, c.annotations.s01);
    await page.screenshot({ path: path.join(outDir, '01_login_roles.png') });
    await clearAnnotations(page);

    // Log in & Create Event
    await page.waitForFunction(() => {
      const btn = document.querySelector('button[type="submit"]');
      return btn && !btn.disabled;
    }, { timeout: 10000 });
    await page.click('button[type="submit"]');
    await page.waitForSelector('.action-btn, .dashboard-view', { timeout: 15000 });
    await waitForTransition(page);

    await page.click('.action-btn.primary');
    await page.waitForSelector('.modal-overlay .modal-card input', { visible: true, timeout: 8000 });
    await page.type('.modal-overlay .modal-card input', c.eventName);
    await page.click('.btn-confirm');
    await page.waitForSelector('.event-view', { timeout: 15000 });
    await waitForTransition(page);
    await delay(500);

    const eventId = await page.evaluate(() => {
      const m = window.location.hash.match(/event\/([^/?]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    });
    if (!eventId) {
      throw new Error('Failed to parse created eventId from hash URL');
    }

    const scoutInfo = await page.evaluate(() => {
      const raw = localStorage.getItem('scoutingpro-user');
      return raw ? JSON.parse(raw) : { id: 'host_id', username: 'GuideHost', token: '' };
    });

    // Seed clean BIOBUZZ dataset via Backend API + reload
    const seed = buildSeedPayload(lang, eventId, scoutInfo);
    const seedResults = await page.evaluate(async (eid, payload, token) => {
      const headers = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      };
      const out = {};

      const rTeams = await fetch(`/api/events/${encodeURIComponent(eid)}/official-teams/sync`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload.officialTeams)
      });
      out.officialTeams = { status: rTeams.status, ok: rTeams.ok };

      const rPit = await fetch(`/api/events/${encodeURIComponent(eid)}/pit-records/batch`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload.pitRecords)
      });
      out.pit = { status: rPit.status, ok: rPit.ok };

      const rRec = await fetch('/api/records/sync', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload.matchRecords)
      });
      out.records = { status: rRec.status, ok: rRec.ok };

      const rSch = await fetch(`/api/events/${encodeURIComponent(eid)}/schedule/batch`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          items: payload.schedules,
          replace: true,
          assignments: payload.assignments
        })
      });
      out.schedule = { status: rSch.status, ok: rSch.ok };

      localStorage.setItem(`sp27_whiteboard_v1_${eid}`, JSON.stringify({ QUALIFICATION_1: payload.whiteboardPlan }));
      return out;
    }, eventId, seed, scoutInfo.token);

    for (const [k, v] of Object.entries(seedResults)) {
      if (!v.ok) {
        throw new Error(`Seed step "${k}" failed with HTTP ${v.status}`);
      }
    }

    // Reload EventView cleanly so all stores hydrate directly from backend DB
    await page.reload({ waitUntil: 'networkidle0' });
    await waitForTransition(page);
    await delay(800);
    // Ensure we're inside EventView (reload stays on #/event/<id>)
    if (!(await page.$('.event-view'))) {
      await page.waitForSelector('.event-card', { timeout: 10000 });
      await page.click('.event-card');
      await page.waitForSelector('.event-view', { timeout: 10000 });
      await waitForTransition(page);
    }

    // 2. Host QR Modal (02_event_lobby_qr.png)
    console.log(`📸 [${lang}] 02/11 Capturing 02_event_lobby_qr.png...`);
    await suppressToasts(page);
    await page.waitForSelector('.host-qr-btn', { visible: true, timeout: 8000 });
    await waitForRectStable(page, '.host-qr-btn');
    await page.click('.host-qr-btn');
    await page.waitForSelector('.qr-modal-dialog .qr-canvas-container canvas', { visible: true, timeout: 8000 });
    await delay(500);
    await verifyLocaleAndCleanUi(page, lang, '02_event_lobby_qr');
    await annotateElements(page, c.annotations.s02);
    await page.screenshot({ path: path.join(outDir, '02_event_lobby_qr.png') });
    await clearAnnotations(page);
    await page.click('.qr-modal-header .close-btn');
    await delay(350);

    // 3. Match Scouting Setup (03_match_scouting_setup.png)
    console.log(`📸 [${lang}] 03/11 Capturing 03_match_scouting_setup.png...`);
    await clickTab(page, 'scout');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForSelector('.spdt-switch', { visible: true, timeout: 8000 });

    // Select Red Alliance & Enter Team #27570 so Pit quick hint shows
    await page.evaluate(() => {
      const redSpan = document.querySelector('.spdt-labels span:first-child');
      if (redSpan) redSpan.click();
    });
    const teamInput = await page.$('input[placeholder="e.g. 12345"]');
    await teamInput.click({ clickCount: 3 });
    await teamInput.type('27570');
    await delay(500);
    await page.waitForSelector('.pit-quick-hint', { visible: true, timeout: 5000 });

    await verifyLocaleAndCleanUi(page, lang, '03_match_scouting_setup');
    await annotateElements(page, c.annotations.s03, { scrollSelector: '.settings-section', scrollBlock: 'start' });
    await page.screenshot({ path: path.join(outDir, '03_match_scouting_setup.png') });
    await clearAnnotations(page);

    // 4. Autonomous Phase (04_autonomous_phase.png)
    console.log(`📸 [${lang}] 04/11 Capturing 04_autonomous_phase.png...`);
    await page.click('.phase-auto .pad-hit-btn');
    await delay(120);
    await page.click('.phase-auto .pad-hit-btn');
    await delay(120);
    // Toggle Auto Leave & Auto Park by clicking actual labels
    await page.click('.form-section:has(.phase-auto) .biobuzz-toggles-grid .toggle-card:nth-child(1)');
    await delay(100);
    await page.click('.form-section:has(.phase-auto) .biobuzz-toggles-grid .toggle-card:nth-child(2)');
    await delay(250);

    await verifyLocaleAndCleanUi(page, lang, '04_autonomous_phase');
    await annotateElements(page, c.annotations.s04, { scrollSelector: '.form-section:has(.phase-auto)', scrollBlock: 'center' });
    await page.screenshot({ path: path.join(outDir, '04_autonomous_phase.png') });
    await clearAnnotations(page);

    // 5. TeleOp Manual Counting (05_teleop_manual_counting.png)
    // Simulate realistic ~9.2s cycle intervals while pressing real Next Cycle buttons so Predict Cycle Time displays authentically
    console.log(`📸 [${lang}] 05/11 Capturing 05_teleop_manual_counting.png...`);
    await page.evaluate(() => {
      window.__ugRealDateNow = Date.now;
      window.__ugFakeNow = window.__ugRealDateNow();
      Date.now = () => window.__ugFakeNow;
    });

    const teleopCycleBalls = [3, 4, 3, 4, 3, 3];
    const gapIncrementsMs = [8800, 9600, 9100, 8400, 9500];
    for (let i = 0; i < teleopCycleBalls.length; i++) {
      const targetBalls = teleopCycleBalls[i];
      await page.evaluate((count) => {
        const chips = Array.from(document.querySelectorAll('.phase-teleop .chips-group .quick-ball-btn'));
        const chipBtn = chips.find((btn) => btn.textContent.trim() === String(count));
        if (chipBtn) chipBtn.click();
      }, targetBalls);
      await delay(90);
      if (i < teleopCycleBalls.length - 1) {
        await page.evaluate((delta) => {
          window.__ugFakeNow += delta;
        }, gapIncrementsMs[i]);
        await page.click('.phase-teleop .btn-new-cycle');
        await delay(90);
      }
    }
    // Restore Date.now
    await page.evaluate(() => {
      if (window.__ugRealDateNow) {
        Date.now = window.__ugRealDateNow;
      }
    });
    await delay(250);

    await verifyLocaleAndCleanUi(page, lang, '05_teleop_manual_counting');
    await annotateElements(page, c.annotations.s05, { scrollSelector: '.form-section:has(.phase-teleop)', scrollBlock: 'center' });
    await page.screenshot({ path: path.join(outDir, '05_teleop_manual_counting.png') });
    await clearAnnotations(page);

    // 6. BIOBUZZ Endgame (06_endgame_biobuzz.png)
    console.log(`📸 [${lang}] 06/11 Capturing 06_endgame_biobuzz.png...`);
    await page.evaluate(() => {
      const endgameSec = document.querySelector('.form-section:has(.biobuzz-endgame-steppers)');
      if (endgameSec) endgameSec.scrollIntoView({ behavior: 'instant', block: 'start' });
    });
    await delay(200);

    // Set Nectar=2, BottomBonus=1, Pollen=4, Garden=4 using real chips, plus Park & Descore toggles
    await page.evaluate(() => {
      const steppers = document.querySelectorAll('.biobuzz-endgame-steppers .endgame-stepper-card');
      const pickChip = (card, val) => {
        const btns = Array.from(card.querySelectorAll('.quick-ball-btn'));
        const b = btns.find((x) => x.textContent.trim() === String(val));
        if (b && !b.disabled) b.click();
      };
      if (steppers[0]) pickChip(steppers[0], 2);
      setTimeout(() => {
        if (steppers[1]) pickChip(steppers[1], 1);
        if (steppers[2]) pickChip(steppers[2], 4);
        if (steppers[3]) pickChip(steppers[3], 4);
      }, 60);
    });
    await delay(250);
    await page.click('.form-section:has(.biobuzz-endgame-steppers) .biobuzz-toggles-grid .toggle-card:nth-child(1)');
    await delay(100);
    await page.click('.form-section:has(.biobuzz-endgame-steppers) .biobuzz-toggles-grid .toggle-card:nth-child(2)');
    await delay(250);

    // Scroll so both Endgame heading/steppers and Submit button fit cleanly inside 1440x900
    await page.evaluate(() => {
      const btnSubmit = document.querySelector('.btn-submit');
      const endgameSec = document.querySelector('.form-section:has(.biobuzz-endgame-steppers)');
      if (btnSubmit) btnSubmit.scrollIntoView({ behavior: 'instant', block: 'end' });
      if (btnSubmit && endgameSec) {
        const titleEl = endgameSec.querySelector('h2, h3, .section-header, .section-title') || endgameSec;
        const bRect = btnSubmit.getBoundingClientRect();
        const tRect = titleEl.getBoundingClientRect();
        // Keep Submit bottom >= 8px inside viewport, and pull up slightly only within spare bottom margin
        const spareBottom = window.innerHeight - 8 - bRect.bottom;
        if (tRect.top < 10 && spareBottom > 0) {
          window.scrollBy(0, -Math.min(10 - tRect.top, spareBottom));
        } else if (bRect.bottom > window.innerHeight - 8) {
          window.scrollBy(0, bRect.bottom - (window.innerHeight - 8));
        }
      }
    });
    await delay(250);

    await verifyLocaleAndCleanUi(page, lang, '06_endgame_biobuzz');
    await annotateElements(page, c.annotations.s06);
    await page.screenshot({ path: path.join(outDir, '06_endgame_biobuzz.png') });
    await clearAnnotations(page);

    // 7. Mobile Single-Handed Wizard (07_mobile_wizard_phone.png)
    console.log(`📸 [${lang}] 07/11 Capturing 07_mobile_wizard_phone.png (414x896)...`);
    const mobilePage = await context.newPage();
    mobilePage.on('pageerror', (err) => pageErrors.push(`mobile pageerror: ${err.message}`));
    await mobilePage.setViewport(MOBILE_VIEWPORT);
    await mobilePage.evaluateOnNewDocument((targetLang) => {
      localStorage.setItem('app-locale', targetLang);
    }, lang);
    await mobilePage.goto(`${BASE_URL}#/event/${encodeURIComponent(eventId)}`, { waitUntil: 'networkidle0' });
    await waitForTransition(mobilePage);
    await mobilePage.waitForSelector('.mobile-wizard-container', { visible: true, timeout: 12000 });
    await delay(400);

    // Step 0 -> fill team #27570 and select Red Alliance
    await mobilePage.click('.alliance-btn.red-btn');
    await mobilePage.click('.number-input-wrap .giant-num-input', { clickCount: 3 });
    await mobilePage.type('.number-input-wrap .giant-num-input', '27570');
    await delay(250);

    // Go to Step 2 (TeleOp) via Stepper or Next buttons
    await mobilePage.click('.btn-wizard-primary'); // Step 0 -> 1 (Auto)
    await delay(300);
    await mobilePage.click('.btn-wizard-primary'); // Step 1 -> 2 (TeleOp)
    await mobilePage.waitForSelector('.step-teleop .teleop-hero-hit', { visible: true, timeout: 8000 });
    await delay(250);

    // Tap some realistic TeleOp cycles on mobile wizard
    await mobilePage.click('.step-teleop .preset-capsules-grid .btn-preset-capsule:nth-child(3)'); // 3 balls
    await delay(150);
    await mobilePage.click('.step-teleop .btn-new-cycle');
    await delay(150);
    await mobilePage.click('.step-teleop .teleop-hero-hit');
    await delay(120);
    await mobilePage.click('.step-teleop .teleop-hero-hit');
    await delay(250);

    await verifyLocaleAndCleanUi(mobilePage, lang, '07_mobile_wizard_phone');
    await annotateElements(mobilePage, c.annotations.s07);
    await mobilePage.screenshot({ path: path.join(outDir, '07_mobile_wizard_phone.png') });
    await mobilePage.close();

    // 8. Pit Scouting Dashboard (08_pit_scouting.png)
    console.log(`📸 [${lang}] 08/11 Capturing 08_pit_scouting.png...`);
    await clickTab(page, 'pit');
    await page.waitForSelector('.team-roster-card .hardware-pills', { visible: true, timeout: 10000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await delay(500);

    await verifyLocaleAndCleanUi(page, lang, '08_pit_scouting');
    await annotateElements(page, c.annotations.s08, { scrollSelector: '.pit-header-banner', scrollBlock: 'start' });
    await page.screenshot({ path: path.join(outDir, '08_pit_scouting.png') });
    await clearAnnotations(page);

    // 8b. Pit Scout Actual Form Drawer (08b_pit_scout_form_drawer.png)
    console.log(`📸 [${lang}] 08b/16 Capturing 08b_pit_scout_form_drawer.png...`);
    await page.click('.team-roster-card:nth-child(3) .card-actions button, .team-roster-card:nth-child(3) button');
    await page.waitForSelector('.drawer-panel .drawer-body .form-section:nth-child(3)', { visible: true, timeout: 8000 });
    await delay(500);
    await verifyLocaleAndCleanUi(page, lang, '08b_pit_scout_form_drawer');
    await annotateElements(page, c.annotations.s08b);
    await page.screenshot({ path: path.join(outDir, '08b_pit_scout_form_drawer.png') });
    await clearAnnotations(page);
    await page.click('.drawer-footer .btn-cancel');
    await delay(350);

    // 9. Match Schedule & Assignments (09_match_schedule_assignments.png)
    console.log(`📸 [${lang}] 09/11 Capturing 09_match_schedule_assignments.png...`);
    await clickTab(page, 'schedule');
    await page.waitForSelector('.schedule-table .match-row', { visible: true, timeout: 10000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await delay(600);

    await verifyLocaleAndCleanUi(page, lang, '09_match_schedule_assignments');
    await annotateElements(page, c.annotations.s09, { scrollSelector: '.schedule-toolbar', scrollBlock: 'start' });
    await page.screenshot({ path: path.join(outDir, '09_match_schedule_assignments.png') });
    await clearAnnotations(page);

    // 10. Rankings, Predict Cycle Time & Brag Index (10_rankings_brag_index.png)
    console.log(`📸 [${lang}] 10/11 Capturing 10_rankings_brag_index.png...`);
    await clickTab(page, 'rankings');
    await page.waitForSelector('.ranking-row td:nth-child(15) .brag-tier-pill', { visible: true, timeout: 10000 });
    await delay(1000);
    await waitForRectStable(page, '.ranking-row:first-child td:nth-child(15) .brag-tier-pill');

    // Scroll `.table-wrapper` horizontally so sticky Adv Pts (#1) + Team (#2) + Mobility RP (#8) + BIOBUZZ (#10) + Predict Cycle Time (#11) + Brag Index (#15) are all comfortably inside viewport!
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      const wrap = document.querySelector('.table-wrapper');
      const col15 = document.querySelector('.ranking-row:first-child td:nth-child(15)');
      if (wrap && col15) {
        const wrapRect = wrap.getBoundingClientRect();
        const colRect = col15.getBoundingClientRect();
        if (colRect.right > wrapRect.right - 20) {
          wrap.scrollLeft += colRect.right - wrapRect.right + 48;
        }
      }
    });
    await delay(300);
    await waitForRectStable(page, '.ranking-row:first-child td:nth-child(15) .brag-tier-pill');

    await verifyLocaleAndCleanUi(page, lang, '10_rankings_brag_index');
    await annotateElements(page, c.annotations.s10);
    await page.screenshot({ path: path.join(outDir, '10_rankings_brag_index.png') });
    await clearAnnotations(page);

    // 11. Tactical Whiteboard & Strategy (11_tactical_whiteboard.png)
    console.log(`📸 [${lang}] 11/11 Capturing 11_tactical_whiteboard.png...`);
    await clickTab(page, 'whiteboard');
    await page.waitForSelector('[data-testid="whiteboard-canvas"]', { visible: true, timeout: 10000 });
    await page.waitForSelector('[data-testid="wb-btn-play-sim"]', { visible: true, timeout: 10000 });
    await page.waitForSelector('[data-testid="wb-swarm-rp-strip"]', { visible: true, timeout: 10000 });
    await delay(700);

    await verifyLocaleAndCleanUi(page, lang, '11_tactical_whiteboard');
    await annotateElements(page, c.annotations.s11, { scrollSelector: '[data-testid="tactical-whiteboard-view"]', scrollBlock: 'start' });
    await page.screenshot({ path: path.join(outDir, '11_tactical_whiteboard.png') });
    await clearAnnotations(page);

    // 12. History & Edit Record (12_history_edit_record.png)
    console.log(`📸 [${lang}] 12/16 Capturing 12_history_edit_record.png...`);
    await clickTab(page, 'history');
    await page.waitForSelector('.history-card .btn-edit', { visible: true, timeout: 10000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await delay(500);
    await verifyLocaleAndCleanUi(page, lang, '12_history_edit_record');
    await annotateElements(page, c.annotations.s12);
    await page.screenshot({ path: path.join(outDir, '12_history_edit_record.png') });
    await clearAnnotations(page);

    // 13. AI API Key Settings (13_ai_api_key_settings.png)
    console.log(`📸 [${lang}] 13/16 Capturing 13_ai_api_key_settings.png...`);
    await clickTab(page, 'ai');
    await page.waitForSelector('.ai-chat-view .inner-tabs button:nth-child(2)', { visible: true, timeout: 10000 });
    await page.click('.ai-chat-view .inner-tabs button:nth-child(2)');
    await page.waitForSelector('.ai-chat-view .settings-panel input[type="password"]', { visible: true, timeout: 8000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await delay(450);
    await verifyLocaleAndCleanUi(page, lang, '13_ai_api_key_settings');
    await annotateElements(page, c.annotations.s13);
    await page.screenshot({ path: path.join(outDir, '13_ai_api_key_settings.png') });
    await clearAnnotations(page);

    // 14. AI Chat Assistant (14_ai_chat_assistant.png)
    console.log(`📸 [${lang}] 14/16 Capturing 14_ai_chat_assistant.png...`);
    await page.click('.ai-chat-view .inner-tabs button:nth-child(1)');
    await page.waitForSelector('.chat-input-area textarea', { visible: true, timeout: 8000 });
    await page.type('.chat-input-area textarea', c.aiSamplePrompt);
    await delay(350);
    await verifyLocaleAndCleanUi(page, lang, '14_ai_chat_assistant');
    await annotateElements(page, c.annotations.s14);
    await page.screenshot({ path: path.join(outDir, '14_ai_chat_assistant.png') });
    await clearAnnotations(page);

    // 15. Custom Fields Manager (15_custom_fields_manager.png)
    console.log(`📸 [${lang}] 15/16 Capturing 15_custom_fields_manager.png...`);
    await clickTab(page, 'scouts');
    await page.waitForSelector('.event-scouts-panel, .scouts-header-bar', { visible: true, timeout: 10000 });
    await delay(400);
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.querySelector('.material-icons')?.textContent?.trim() === 'tune'
      );
      if (!btn) throw new Error('Custom Fields manager button not found');
      btn.click();
    });
    await page.waitForSelector('.cf-modal-card .btn-create-field', { visible: true, timeout: 8000 });
    await page.click('.cf-modal-card .btn-create-field');
    await page.waitForSelector('.cf-modal-card input[type="text"]', { visible: true, timeout: 8000 });
    await page.type('.cf-modal-card input[type="text"]', c.customFieldSample.name);
    await page.waitForSelector('.cf-modal-card .btn-save', { visible: true, timeout: 5000 });
    await page.click('.cf-modal-card .btn-save');
    await page.waitForSelector('.cf-modal-card .cf-card', { visible: true, timeout: 8000 });
    await delay(500);
    await suppressToasts(page);
    await verifyLocaleAndCleanUi(page, lang, '15_custom_fields_manager');
    await annotateElements(page, c.annotations.s15);
    await page.screenshot({ path: path.join(outDir, '15_custom_fields_manager.png') });
    await clearAnnotations(page);
    await page.click('.cf-modal-header .btn-close');
    await delay(250);

    // 16. FTC Official Data Binding & Sync (16_ftc_official_sync.png)
    console.log(`📸 [${lang}] 16/17 Capturing 16_ftc_official_sync.png...`);
    const seasonSel = '.event-scouts-panel .settings-panel:first-child input[type="number"]';
    const codeSel = '.event-scouts-panel .settings-panel:first-child input[type="text"]';
    await page.waitForSelector(seasonSel, { visible: true, timeout: 8000 });
    const fillInputClean = async (sel, val) => {
      await page.focus(sel);
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await page.$eval(sel, (el) => {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.type(sel, val);
      const actual = await page.$eval(sel, (el) => String(el.value));
      if (actual !== val) {
        throw new Error(`Expected ${sel} to equal "${val}", got "${actual}"`);
      }
    };
    await fillInputClean(seasonSel, '2025');
    await fillInputClean(codeSel, 'AUADQ');
    await page.evaluate(() => window.scrollTo(0, 0));
    await delay(300);
    await suppressToasts(page);
    await verifyLocaleAndCleanUi(page, lang, '16_ftc_official_sync');
    await annotateElements(page, c.annotations.s16);
    await page.screenshot({ path: path.join(outDir, '16_ftc_official_sync.png') });
    await clearAnnotations(page);

    if (pageErrors.length > 0) {
      throw new Error(`[${lang}] Browser runtime/console errors detected:\n  - ${pageErrors.join('\n  - ')}`);
    }
    console.log(`✅ Completed [${lang.toUpperCase()}] capture suite -> ${outDir}`);
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  console.log('🚀 [UserGuide E2E] Preparing clean dual-locale screenshot capture (ZH + EN)...');
  cleanOutputDirs();

  let backendProcess = null;
  let browser = null;

  const cleanup = () => {
    if (backendProcess?.pid) {
      killProcessTree(backendProcess.pid);
      backendProcess = null;
    }
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });

  try {
    const alreadyRunning = await isServerRunning();
    if (alreadyRunning) {
      throw new Error(
        `Port ${PORT} is already in use by another server. Stop it first or set USERGUIDE_PORT so stale assets are never captured.`
      );
    }

    console.log('📦 Syncing latest frontend assets into Backend target/classes...');
    const mavenCmd = os.platform() === 'win32' ? 'mvn.cmd' : 'mvn';
    execSync(`${mavenCmd} process-resources -DskipTests`, {
      cwd: BACKEND_DIR,
      stdio: 'inherit'
    });

    console.log(`⚡ Spawning headless Backend on isolated port ${PORT}...`);
    backendProcess = spawn(
      mavenCmd,
      [
        'exec:java',
        os.platform() === 'win32' ? '"-Dexec.mainClass=com.bear27570.app.Main"' : '-Dexec.mainClass=com.bear27570.app.Main',
        os.platform() === 'win32' ? '"-Dexec.args=--headless"' : '-Dexec.args=--headless',
        '-DENABLE_TEST_CLEANUP=true'
      ],
      {
        cwd: BACKEND_DIR,
        detached: os.platform() !== 'win32',
        shell: os.platform() === 'win32',
        env: { ...process.env, DEV_PORT: String(PORT), ENABLE_TEST_CLEANUP: 'true' }
      }
    );

    let bootLogs = '';
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Backend boot timeout on port ${PORT}.\nLogs:\n${bootLogs}`));
      }, 60000);
      const onData = (chunk) => {
        const text = chunk.toString();
        bootLogs += text;
        if (text.includes('Listening on http://') || text.includes('Javalin started')) {
          clearTimeout(timeout);
          resolve();
        }
      };
      backendProcess.stdout.on('data', onData);
      backendProcess.stderr.on('data', onData);
      backendProcess.on('exit', (code) => {
        if (code !== null && code !== 0) {
          clearTimeout(timeout);
          reject(new Error(`Backend exited prematurely with code ${code}.\nLogs:\n${bootLogs}`));
        }
      });
    });

    // Double check static server response before Puppeteer starts
    for (let i = 0; i < 20; i++) {
      if (await isServerRunning()) break;
      await delay(250);
    }
    console.log(`✅ Backend ready on ${BASE_URL}`);

    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--window-size=1440,900'
      ]
    });

    await captureLocaleSuite(browser, 'zh');
    await captureLocaleSuite(browser, 'en');

    console.log('\n🎉 All 34 ZH + EN UserGuide screenshots generated and verified cleanly!');
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    cleanup();
    const down = await waitForServerDown(6000);
    console.log(`🧹 Cleanup complete (port ${PORT} free=${down}).`);
  }
}

main().catch((err) => {
  console.error('❌ [UserGuide E2E Failed]:', err);
  process.exit(1);
});
