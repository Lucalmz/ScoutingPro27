import puppeteer from 'puppeteer';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = 7071;
const BASE_URL = `http://localhost:${PORT}/index.html`;

const OUTPUT_DIR = path.join(__dirname, '../../docs/promo/screenshots');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function getChromeExecutablePath() {
  const platform = os.platform();
  if (platform === 'win32') return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  if (platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return '/usr/bin/google-chrome';
}

const CHROME_PATH = getChromeExecutablePath();
const delay = ms => new Promise(res => setTimeout(res, ms));

async function waitForTransition(page) {
  await page.waitForFunction(() => {
    return !document.documentElement.hasAttribute('data-direction') && 
           !document.documentElement.hasAttribute('data-transition-type');
  }, { timeout: 5000 }).catch(() => {});
  await delay(150);
}

async function clickTab(page, tabKeyOrName) {
  const clicked = await page.evaluate((target) => {
    const keyMap = {
      'scout': ['scout', '表单'],
      'pit': ['pit', '展位侦察', '展位'],
      'schedule': ['schedule', '赛程', '赛程排班'],
      'rankings': ['rankings', '排名'],
      'history': ['history', '历史'],
      'ai': ['ai', 'chat with ai', 'ai 对话'],
      'scouts': ['scouts', '考察员与设置', '设置', 'scouts & settings']
    };
    const keywords = keyMap[target.toLowerCase()] || [target.toLowerCase()];
    const buttons = Array.from(document.querySelectorAll('.tab-bar .tab-btn, button.tab-btn, nav button, nav a'));
    for (const btn of buttons) {
      const text = btn.textContent.trim().toLowerCase();
      if (keywords.some(k => text.includes(k))) {
        btn.click();
        return true;
      }
    }
    const allBtns = Array.from(document.querySelectorAll('button, .nav-item'));
    for (const btn of allBtns) {
      const text = btn.textContent.trim().toLowerCase();
      if (keywords.some(k => text.includes(k))) {
        btn.click();
        return true;
      }
    }
    return false;
  }, tabKeyOrName);

  if (!clicked) {
    console.warn(`⚠️ 无法通过关键字找到 Tab: ${tabKeyOrName}`);
  }
  await waitForTransition(page);
  await delay(1200);
}

async function robustLogin(page, username) {
  await page.waitForSelector('#username', { timeout: 10000 });
  await page.type('#username', username);
  await page.evaluate(() => {
    const el = document.querySelector('#username');
    if (el) el.dispatchEvent(new Event('blur'));
  });
  await delay(1500);
  await page.waitForSelector('#password', { visible: true, timeout: 10000 });
  await page.type('#password', 'demopassword123');
  const confirmPasswordEl = await page.$('#confirmPassword');
  if (confirmPasswordEl) {
    await page.type('#confirmPassword', 'demopassword123');
  }
  await page.waitForFunction(() => {
    const btn = document.querySelector('button[type="submit"]');
    return btn && !btn.disabled;
  }, { timeout: 10000 });
  await page.click('button[type="submit"]');
  await page.waitForSelector('.action-btn', { timeout: 15000 });
  await waitForTransition(page);
}

async function capture() {
  console.log('🚀 启动高清无头浏览器截取宣传片全套素材...');
  
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 2 });

  try {
    // 1. 登录 / 品牌首屏
    console.log('📸 截取 01_brand_login_screen.png...');
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await delay(1000);
    await page.screenshot({ path: path.join(OUTPUT_DIR, '01_brand_login_screen.png') });

    // 登录 Host
    const hostUser = `Commander_${Date.now().toString().slice(-4)}`;
    await robustLogin(page, hostUser);
    await delay(800);

    // 2. 赛事大厅 / 房间创建 (Host Lobby)
    console.log('📸 截取 02_host_event_created.png...');
    await page.waitForSelector('.action-btn.primary');
    await waitForTransition(page);
    await page.click('.action-btn.primary');
    await page.waitForSelector('.modal-overlay input', { timeout: 10000 });
    await page.type('.modal-overlay input', 'FTC_CHAMPIONSHIP_2026');
    await delay(500);
    await page.click('.btn-confirm');
    await delay(1500);
    await page.screenshot({ path: path.join(OUTPUT_DIR, '02_host_event_created.png') });

    // 提取房间邀请码
    const eventCode = await page.evaluate(() => {
      const t = document.body.innerText;
      const m = t.match(/Code::?\s*([A-Z0-9]{6})/i) || t.match(/邀请码::?\s*([A-Z0-9]{6})/i);
      return m ? m[1] : null;
    });
    console.log(`✅ 赛事已就绪，房间代码: ${eventCode}`);

    // 3. 点击 Mobile QR 按钮展示二维码弹窗
    console.log('📸 截取 03_mobile_qr_modal.png...');
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const qrBtn = btns.find(b => b.textContent.includes('Mobile QR') || b.textContent.includes('二维码'));
      if (qrBtn) qrBtn.click();
    });
    await delay(1200);
    await page.screenshot({ path: path.join(OUTPUT_DIR, '03_mobile_qr_modal.png') });

    // 关闭 QR 弹窗
    await page.evaluate(() => {
      const closeBtn = document.querySelector('.qr-modal-backdrop .close-btn') || 
                       document.querySelector('.close-btn') ||
                       document.querySelector('.qr-modal-backdrop');
      if (closeBtn) closeBtn.click();
    });
    await delay(800);

    // 4. 移动端扫码与侦察员打分视图 (独立上下文，iPhone 竖屏)
    if (eventCode) {
      console.log('📸 截取 04_mobile_scout_join.png (竖屏 9:16)...');
      const mobileContext = await browser.createBrowserContext();
      const mobilePage = await mobileContext.newPage();
      await mobilePage.setViewport({ width: 414, height: 896, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
      await mobilePage.goto(BASE_URL, { waitUntil: 'networkidle0' });
      const mobileUser = `Scout_Alex_${Date.now().toString().slice(-4)}`;
      await robustLogin(mobilePage, mobileUser);
      await delay(800);

      // 加入房间
      await mobilePage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('.action-btn, button'));
        const joinBtn = btns.find(b => b.textContent.includes('Join') || b.textContent.includes('加入'));
        if (joinBtn) joinBtn.click();
      });
      await mobilePage.waitForSelector('.modal-overlay input', { timeout: 10000 });
      await mobilePage.type('.modal-overlay input', eventCode);
      await delay(500);
      await mobilePage.click('.btn-confirm');
      await delay(2500);
      await waitForTransition(mobilePage);

      // 在移动端向导界面选中红方联盟并填入场次 12 与战队 27570
      await mobilePage.evaluate(() => {
        const redBtn = document.querySelector('.alliance-btn.red-btn');
        if (redBtn) redBtn.click();
        const numInputs = document.querySelectorAll('.giant-num-input, input[type="number"]');
        if (numInputs[0]) {
          numInputs[0].value = '12';
          numInputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (numInputs[1]) {
          numInputs[1].value = '27570';
          numInputs[1].dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      await delay(600);
      await mobilePage.screenshot({ path: path.join(OUTPUT_DIR, '04_mobile_scout_join.png') });
      await mobilePage.close();
      await mobileContext.close();
      console.log('✅ 04_mobile_scout_join.png 截取成功！');
    }

    // 确保弹窗已彻底关闭
    await page.evaluate(() => {
      const backdrop = document.querySelector('.qr-modal-backdrop');
      if (backdrop) backdrop.remove();
    });
    await delay(400);

    // 解析当前 Event ID 并注入高质量赛事样本数据（展位侦察、比分天梯、AI分析对话）
    const eventId = await page.evaluate(() => {
      const m = window.location.hash.match(/\/event\/([a-zA-Z0-9_-]+)/) || window.location.pathname.match(/\/event\/([a-zA-Z0-9_-]+)/);
      return m ? m[1] : null;
    });
    console.log(`📊 注入真实赛事数据至 Event: ${eventId}...`);

    if (eventId) {
      await page.evaluate(async (eid) => {
        // 1. 注入 2026-2027 BIOBUZZ Pit Scouting 展位数据
        const nowIso = new Date().toISOString();
        const pitSpecs = [
          {
            id: `pit_${eid}_27570`,
            eventId: eid,
            teamNumber: 27570,
            scoutId: 'scout_1',
            scoutName: 'Commander',
            robotName: 'Titanium Bear Mk.IV',
            drivetrainType: 'swerve',
            weightLbs: 41.5,
            chassisSize: 'standard_mid',
            ballCompatibility: 'universal',
            launcherType: 'dual_flywheel',
            flowerMechanism: 'vertical_lift',
            hasColorSensor: true,
            hasDescoreMech: true,
            hasApriltagVision: true,
            odometryType: 'sparkfun_otos',
            claimedAutoStrategy: '预载 2 球直射 + 完全离墙 + 自动停泊；双花 Nectar 占底',
            claimedAutoScore: 14,
            claimedTeleopCycles: 7,
            claimedTeleopScore: 52,
            claimedTeleopPark: true,
            claimedFlowerNectars: 3,
            claimedFlowerBottomBonus: 2,
            claimedFlowerPollens: 4,
            claimedGardenBalls: 3,
            claimedEndgameScore: 32,
            claimedTotalScore: 98,
            photoKeys: [],
            version: 1,
            isDeleted: false,
            createdAt: nowIso,
            updatedAt: nowIso
          },
          {
            id: `pit_${eid}_11115`,
            eventId: eid,
            teamNumber: 11115,
            scoutId: 'scout_2',
            scoutName: 'Alex',
            robotName: 'Gluten Free Special',
            drivetrainType: 'mecanum',
            weightLbs: 36.4,
            chassisSize: 'compact_small',
            ballCompatibility: 'universal',
            launcherType: 'curved_rail',
            flowerMechanism: 'pivot_arm',
            hasColorSensor: true,
            hasDescoreMech: true,
            hasApriltagVision: true,
            odometryType: 'pinpoint',
            claimedAutoStrategy: '预载进球 + 离墙停泊；紧凑小车 6 轮高速循环 + 底口掏球拆台',
            claimedAutoScore: 11,
            claimedTeleopCycles: 6,
            claimedTeleopScore: 44,
            claimedTeleopPark: true,
            claimedFlowerNectars: 2,
            claimedFlowerBottomBonus: 1,
            claimedFlowerPollens: 3,
            claimedGardenBalls: 2,
            claimedEndgameScore: 22,
            claimedTotalScore: 77,
            photoKeys: [],
            version: 1,
            isDeleted: false,
            createdAt: nowIso,
            updatedAt: nowIso
          },
          {
            id: `pit_${eid}_28410`,
            eventId: eid,
            teamNumber: 28410,
            scoutId: 'scout_3',
            scoutName: 'Chris',
            robotName: 'Cyber Dragon',
            drivetrainType: 'swerve',
            weightLbs: 42.0,
            chassisSize: 'wide_large',
            ballCompatibility: 'sorting',
            launcherType: 'single_flywheel',
            flowerMechanism: 'angled_launcher',
            hasColorSensor: true,
            hasDescoreMech: false,
            hasApriltagVision: false,
            odometryType: 'three_wheel',
            claimedAutoStrategy: '自动 2 球 + 离墙停泊；宽体对抗推进 Garden 与分选发射',
            claimedAutoScore: 14,
            claimedTeleopCycles: 7,
            claimedTeleopScore: 56,
            claimedTeleopPark: true,
            claimedFlowerNectars: 3,
            claimedFlowerBottomBonus: 2,
            claimedFlowerPollens: 2,
            claimedGardenBalls: 4,
            claimedEndgameScore: 29,
            claimedTotalScore: 99,
            photoKeys: [],
            version: 1,
            isDeleted: false,
            createdAt: nowIso,
            updatedAt: nowIso
          }
        ];

        const pitRecords = pitSpecs.map((p) => ({
          ...p,
          rawData: JSON.stringify(p)
        }));

        // 2. 注入 2026-2027 BIOBUZZ 比赛实测记录 (含结构化轮次时间戳与 Endgame 明细)
        const tsBase = Date.now() - 3_600_000;
        const computePredictSec = (timestamps) => {
          if (!Array.isArray(timestamps) || timestamps.length < 6) return null;
          const valid = [];
          for (let i = 1; i < timestamps.length; i++) {
            const dt = (timestamps[i] - timestamps[i - 1]) / 1000;
            if (dt > 0 && dt <= 120) valid.push(dt);
          }
          if (valid.length < 5) return null;
          valid.sort((a, b) => a - b);
          const avg = (valid[1] + valid[2] + valid[3] + valid[4]) / 4;
          return Math.round(avg * 10) / 10;
        };

        const makePromoMatchRecord = ({
          id,
          scoutId,
          scoutName,
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
          notes,
          createdOffsetMs
        }) => {
          const autoScore = (autoLeave ? 3 : 0) + autoBalls * 3 + (autoPark ? 5 : 0);
          const teleopScore = teleopCycles.reduce((sum, v) => sum + v, 0) * 2;
          const clampedBottom = Math.min(4, flowerNectars, flowerBottomBonusCount);
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
              cursor += gapSequenceMs[i - 1] ?? 9000;
            }
            teleopCycleTimestamps.push(cursor);
          }
          const predictCycleTimeSec = computePredictSec(teleopCycleTimestamps);

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
            predictCycleTimeSec,
            teleopPark,
            flowerNectars,
            flowerBottomBonusCount: clampedBottom,
            flowerPollens,
            gardenBalls,
            flowerDescore,
            g410EarlyFlowerFoul: false,
            flowerPlaced: flowerNectars > 0,
            flowerBottomBonus: clampedBottom > 0
          };

          return {
            id,
            eventId: eid,
            scoutId,
            scoutName,
            matchNumber,
            teamNumber,
            autoScore,
            teleopScore,
            endgameScore,
            totalScore,
            notes,
            rawData: JSON.stringify(rawObj),
            syncStatus: 'SYNCED',
            isBroken: false,
            version: 1,
            createdAt: new Date(Date.now() - createdOffsetMs).toISOString(),
            updatedAt: nowIso
          };
        };

        const matchRecords = [
          makePromoMatchRecord({
            id: `rec_${eid}_1`,
            scoutId: 'scout_1',
            scoutName: 'Commander',
            matchNumber: 1,
            teamNumber: 27570,
            allianceColor: 'red',
            autoLeave: true,
            autoBalls: 2,
            autoPark: true,
            teleopCycles: [4, 4, 4, 4, 4, 3, 2],
            teleopMissedCycles: [0, 1, 0, 0, 1, 0, 0],
            gapSequenceMs: [8200, 8700, 8100, 8500, 8900, 8400],
            teleopPark: true,
            flowerNectars: 3,
            flowerBottomBonusCount: 2,
            flowerPollens: 4,
            gardenBalls: 3,
            flowerDescore: true,
            notes: 'Swerve 走位丝滑，7 轮稳定循环（Predict 8.5s），终局 3 颗 Nectar 占 2 朵花底并完成停泊！',
            createdOffsetMs: 3_600_000
          }),
          makePromoMatchRecord({
            id: `rec_${eid}_2`,
            scoutId: 'scout_2',
            scoutName: 'Alex',
            matchNumber: 1,
            teamNumber: 11115,
            allianceColor: 'blue',
            autoLeave: true,
            autoBalls: 1,
            autoPark: true,
            teleopCycles: [4, 3, 4, 3, 4, 3],
            teleopMissedCycles: [0, 1, 0, 0, 1, 0],
            gapSequenceMs: [9100, 9600, 8800, 9400, 9200],
            teleopPark: true,
            flowerNectars: 2,
            flowerBottomBonusCount: 1,
            flowerPollens: 3,
            gardenBalls: 2,
            flowerDescore: true,
            notes: '紧凑小车穿梭极快，6 轮稳定输出，末段掏球拆台 (G418) + 花朵占底稳拿 Swarm RP！',
            createdOffsetMs: 3_000_000
          }),
          makePromoMatchRecord({
            id: `rec_${eid}_3`,
            scoutId: 'scout_1',
            scoutName: 'Commander',
            matchNumber: 2,
            teamNumber: 27570,
            allianceColor: 'blue',
            autoLeave: true,
            autoBalls: 2,
            autoPark: true,
            teleopCycles: [4, 4, 3, 4, 4, 4],
            teleopMissedCycles: [0, 0, 1, 0, 0, 0],
            gapSequenceMs: [8600, 8100, 8500, 8800, 8300],
            teleopPark: true,
            flowerNectars: 2,
            flowerBottomBonusCount: 2,
            flowerPollens: 3,
            gardenBalls: 3,
            flowerDescore: false,
            notes: 'OTOS 航向角零漂移，自动 14 分 + 终局停泊拿满 13 分机动分，双花封顶！',
            createdOffsetMs: 1_800_000
          }),
          makePromoMatchRecord({
            id: `rec_${eid}_4`,
            scoutId: 'scout_3',
            scoutName: 'Chris',
            matchNumber: 2,
            teamNumber: 28410,
            allianceColor: 'red',
            autoLeave: true,
            autoBalls: 1,
            autoPark: false,
            teleopCycles: [3, 2, 3, 2, 3, 2],
            teleopMissedCycles: [1, 1, 0, 1, 0, 0],
            gapSequenceMs: [11200, 12100, 10900, 11800, 11500],
            teleopPark: false,
            flowerNectars: 1,
            flowerBottomBonusCount: 0,
            flowerPollens: 2,
            gardenBalls: 3,
            flowerDescore: false,
            notes: '宽体底盘推球进 Garden 稳定，但未回装载区停泊且实测轮次略低于展位自述。',
            createdOffsetMs: 1_200_000
          })
        ];

        // 3. 注入 2026-2027 BIOBUZZ AI 战术分析对话历史
        const aiHistory = [
          {
            id: 'ai_msg_1',
            role: 'user',
            content: '军师，请结合 Predict Cycle Time、Swarm RP 和吹牛指数，分析 Team 27570 与上位联盟搭配的契合度。',
            timestamp: Date.now() - 600000
          },
          {
            id: 'ai_msg_2',
            role: 'assistant',
            content: '🤖 **ScoutingPro27 BIOBUZZ 战术军师数据分析报告：**\n\n- 🏆 **Team 27570（Titanium Bear Mk.IV）核心指标：**\n  - **Predict Cycle Time 8.5s**（6+ 轮稳定触发，预估上限 **10.6 轮**）；场均 **Auto 14.0 / TeleOp 48.0 / Endgame 30.0 / 总分 92.0 分**（最高 **96 分**），Swarm 机动 RP **13.0 / 13 分**（离墙 + 自动停泊 + 终局停泊全稳）。\n  - **展位自报吻合度（吹牛指数）**：自报 **98 分**，实测最高 **96 分** / 场均 **92.0 分**（基准 96.6 分 → **1.01x 真实守信**，放花已证实 · 停泊已证实）。\n\n- 🤝 **最优首选搭档：Team 11115（紧凑小车 ≤15"）**\n  - 场均 **Auto 11.0 / TeleOp 42.0 / Endgame 22.0 / 总分 75.0 分**，**Predict Cycle Time 9.3s**，机动 RP **13.0 / 13 分**，并具备 **G418 敌方花底掏球拆台** 能力。\n  - 两队机动分合计达 **26.0 分**（远超 ≥16 分 Swarm RP 门槛），联盟预期场均总分 **167.0 分**（峰值 **171 分**）；建议 27570 主打高节奏轮次与场均 2.5 颗 Nectar 双花占底，11115 钻缝补 Pollen 并协助拆台！',
            timestamp: Date.now() - 580000
          }
        ];

        const userJson = localStorage.getItem('scoutingpro-user');
        const user = userJson ? JSON.parse(userJson) : null;
        const authHeader = user && user.token ? { 'Authorization': `Bearer ${user.token}` } : {};

        if (user) {
          pitRecords.forEach(r => { r.scoutId = user.id; r.scoutName = user.username; });
          matchRecords.forEach(r => { r.scoutId = user.id; r.scoutName = user.username; });
        }

        try {
          const res1 = await fetch(`/api/events/${encodeURIComponent(eid)}/pit-records/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeader },
            body: JSON.stringify(pitRecords)
          });
          console.log('Pit records batch response status:', res1.status);

          const res2 = await fetch('/api/records/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeader },
            body: JSON.stringify(matchRecords)
          });
          console.log('Match records sync response status:', res2.status);

          const res3 = await fetch(`/api/events/${encodeURIComponent(eid)}/ai-chat`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', ...authHeader },
            body: JSON.stringify(aiHistory)
          });
          console.log('AI chat history response status:', res3.status);
        } catch (e) {
          console.error('API injection error:', e);
        }
      }, eventId);

      // 刷新当前页面让 Pinia store 加载新数据
      await page.reload({ waitUntil: 'networkidle0' });
      await delay(1200);

      // 如果页面重载回到了 Dashboard，重新点击卡片进入该 Event 赛事工作区
      const hasEventCard = await page.$('.event-card');
      if (hasEventCard) {
        console.log('📌 从 Dashboard 重新点击进入 Event 赛事工作区...');
        await page.click('.event-card');
        await page.waitForSelector('.tab-bar', { timeout: 10000 });
        await waitForTransition(page);
        await delay(1200);
      }
    }

    // 5. 切换到 Pit Scout 展位侦察页
    console.log('📸 截取 05_pit_scout_view.png...');
    await clickTab(page, 'pit');
    await delay(1200);
    await page.screenshot({ path: path.join(OUTPUT_DIR, '05_pit_scout_view.png') });

    // 6. 切换到 Rankings 排行榜天梯页
    console.log('📸 截取 06_live_rankings_ladder.png...');
    await clickTab(page, 'rankings');
    await delay(1200);
    await page.screenshot({ path: path.join(OUTPUT_DIR, '06_live_rankings_ladder.png') });

    // 7. 切换到 Chat with AI 战术军师助手页
    console.log('📸 截取 07_chat_with_ai.png...');
    await clickTab(page, 'ai');
    await delay(1200);
    await page.screenshot({ path: path.join(OUTPUT_DIR, '07_chat_with_ai.png') });

    // 8. 切换到 Scouts & Settings 并展示 Inbox 消息中心
    console.log('📸 截取 08_inbox_and_settings.png...');
    await clickTab(page, 'scouts');
    await delay(800);
    await page.evaluate(() => {
      const inboxBtn = document.querySelector('.inbox-topbar-btn');
      if (inboxBtn) inboxBtn.click();
    });
    await delay(1000);
    await page.screenshot({ path: path.join(OUTPUT_DIR, '08_inbox_and_settings.png') });

    console.log('🎉 所有 8 张宣传片高清晰度核心截图已成功捕获到 docs/promo/screenshots/ 目录！');

  } catch (err) {
    console.error('截图过程发生异常:', err);
    throw err;
  } finally {
    await browser.close();
  }
}

capture().catch(err => {
  console.error('Execution failed:', err);
  process.exit(1);
});


