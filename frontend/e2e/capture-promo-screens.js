import puppeteer from 'puppeteer-core';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = 7071;
const BASE_URL = `http://localhost:${PORT}/index.html`;

const OUTPUT_DIR = path.join(__dirname, '../../promo_assets/screenshots');
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

      // 在移动端录入界面稍微输入一些信息显得真实
      await mobilePage.evaluate(() => {
        const matchInput = document.querySelector('input[name="matchNumber"], input[placeholder*="Match"], input[type="number"]');
        if (matchInput) {
          matchInput.value = '12';
          matchInput.dispatchEvent(new Event('input', { bubbles: true }));
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
        // 1. 注入 Pit Scouting 展位数据
        const pitRecords = [
          {
            id: `pit_${eid}_27570`,
            eventId: eid,
            teamNumber: 27570,
            scoutId: 'scout_1',
            scoutName: 'Commander',
            robotName: 'Titanium Bear Mk.IV',
            drivetrainType: 'swerve',
            weightLbs: 41.5,
            ballCompatibility: 'universal',
            launcherType: 'dual_flywheel',
            flowerMechanism: 'cascade_lift',
            hasColorSensor: true,
            odometryType: 'sparkfun_otos',
            claimedAutoStrategy: '3 Samples + High Basket + Level 1 Park',
            claimedAutoScore: 60,
            claimedTeleopCycles: 9,
            claimedTeleopScore: 90,
            claimedEndgameScore: 30,
            claimedTotalScore: 180,
            photoKeys: [],
            version: 1,
            hostSeq: 1,
            isDeleted: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          },
          {
            id: `pit_${eid}_11115`,
            eventId: eid,
            teamNumber: 11115,
            scoutId: 'scout_2',
            scoutName: 'Alex',
            robotName: 'Gluten Free Special',
            drivetrainType: 'mecanum',
            weightLbs: 39.8,
            ballCompatibility: 'universal',
            launcherType: 'catapult',
            flowerMechanism: 'linkage_arm',
            hasColorSensor: true,
            odometryType: 'optical_flow',
            claimedAutoStrategy: '4 Samples Net + High Hang',
            claimedAutoScore: 70,
            claimedTeleopCycles: 11,
            claimedTeleopScore: 110,
            claimedEndgameScore: 30,
            claimedTotalScore: 210,
            photoKeys: [],
            version: 1,
            hostSeq: 2,
            isDeleted: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
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
            ballCompatibility: 'specialized',
            launcherType: 'dual_flywheel',
            flowerMechanism: 'scissor_lift',
            hasColorSensor: false,
            odometryType: 'deadwheel_3wire',
            claimedAutoStrategy: '2 Samples + Level 2 Hang',
            claimedAutoScore: 45,
            claimedTeleopCycles: 8,
            claimedTeleopScore: 85,
            claimedEndgameScore: 30,
            claimedTotalScore: 160,
            photoKeys: [],
            version: 1,
            hostSeq: 3,
            isDeleted: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ];

        // 2. 注入比赛实测记录
        const matchRecords = [
          {
            id: `rec_${eid}_1`,
            eventId: eid,
            scoutId: 'scout_1',
            scoutName: 'Commander',
            matchNumber: 1,
            teamNumber: 27570,
            autoScore: 50,
            teleopScore: 92,
            endgameScore: 30,
            totalScore: 172,
            notes: 'Swerve 走位极其丝滑，中场球控场极佳，末端 Level 3 稳定高挂！',
            rawData: JSON.stringify({ allianceColor: 'red' }),
            syncStatus: 'SYNCED',
            version: 1,
            createdAt: new Date(Date.now() - 3600000).toISOString(),
            updatedAt: new Date().toISOString()
          },
          {
            id: `rec_${eid}_2`,
            eventId: eid,
            scoutId: 'scout_2',
            scoutName: 'Alex',
            matchNumber: 1,
            teamNumber: 11115,
            autoScore: 65,
            teleopScore: 105,
            endgameScore: 30,
            totalScore: 200,
            notes: '投石发射机构射速极高，循环周期 8 秒以内，高篮命中率 100%！',
            rawData: JSON.stringify({ allianceColor: 'blue' }),
            syncStatus: 'SYNCED',
            version: 1,
            createdAt: new Date(Date.now() - 3000000).toISOString(),
            updatedAt: new Date().toISOString()
          },
          {
            id: `rec_${eid}_3`,
            eventId: eid,
            scoutId: 'scout_1',
            scoutName: 'Commander',
            matchNumber: 2,
            teamNumber: 27570,
            autoScore: 55,
            teleopScore: 96,
            endgameScore: 30,
            totalScore: 181,
            notes: '创下赛季新高！自研 OTOS 航向角零飘移，自主阶段完美收拢 4 球。',
            rawData: JSON.stringify({ allianceColor: 'blue' }),
            syncStatus: 'SYNCED',
            version: 1,
            createdAt: new Date(Date.now() - 1800000).toISOString(),
            updatedAt: new Date().toISOString()
          },
          {
            id: `rec_${eid}_4`,
            eventId: eid,
            scoutId: 'scout_3',
            scoutName: 'Chris',
            matchNumber: 2,
            teamNumber: 28410,
            autoScore: 40,
            teleopScore: 80,
            endgameScore: 25,
            totalScore: 145,
            notes: '底盘推力强劲，防守端压制力出色，拦截率 80%。',
            rawData: JSON.stringify({ allianceColor: 'red' }),
            syncStatus: 'SYNCED',
            version: 1,
            createdAt: new Date(Date.now() - 1200000).toISOString(),
            updatedAt: new Date().toISOString()
          }
        ];

        // 3. 注入 AI 对话历史
        const aiHistory = [
          {
            id: 'ai_msg_1',
            role: 'user',
            content: '军师，请分析 Team 27570 与上位联盟搭配的契合度，以及自主阶段得分走势。',
            timestamp: Date.now() - 600000
          },
          {
            id: 'ai_msg_2',
            role: 'assistant',
            content: '🤖 **ScoutingPro27 战术军师数据分析报告：**\n\n- 🏆 **Team 27570（Titanium Bear）核心指标：**\n  - 自主阶段均分 **52.5 分**（Swerve 底盘零死角航向控制，稳定挂钩 + 4 样本清场）。\n  - **展位自报吻合度（吹牛审计）**：自报 180 分，实测最高 181 分，实测吻合度 **100.5%**（实干型硬核战队，无虚标）。\n\n- 🤝 **最优首选搭档：Team 11115**\n  - 两队场均综合输出预计突破 **370 分**。\n  - 建议分工：27570 承担中场球源分配与重型防守压制，11115 专职 8 秒快速装填，具备区域锦标赛夺冠实力！',
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

    console.log('🎉 所有 8 张宣传片高清晰度核心截图已成功捕获到 promo_assets/screenshots/ 目录！');

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


