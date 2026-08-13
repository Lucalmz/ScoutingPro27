import puppeteer from 'puppeteer-core';
import { spawn, execSync } from 'child_process';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = 7071;
const BASE_URL = `http://localhost:${PORT}/index.html`;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function promptNextStep(message) {
  return new Promise(resolve => {
    rl.question(`\n[评委展示] ${message}\n👉 按 '1' (或回车) 继续下一步，按 '0' 结束展示: `, (answer) => {
      const choice = answer.trim() === '0' ? '0' : '1';
      resolve(choice);
    });
  });
}

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
  await delay(100);
}

// 高亮指示器
async function highlightElement(page, selector, text = '', duration = 2500) {
  await page.evaluate((sel, txt, dur) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const overlay = document.createElement('div');
    overlay.className = 'demo-highlight-overlay';
    const rect = el.getBoundingClientRect();
    overlay.style.position = 'fixed';
    overlay.style.top = (rect.top - 5) + 'px';
    overlay.style.left = (rect.left - 5) + 'px';
    overlay.style.width = (rect.width + 10) + 'px';
    overlay.style.height = (rect.height + 10) + 'px';
    overlay.style.border = '4px solid #39ff14';
    overlay.style.boxShadow = '0 0 20px #39ff14';
    overlay.style.borderRadius = '8px';
    overlay.style.zIndex = '999999';
    overlay.style.pointerEvents = 'none';
    overlay.style.transition = 'all 0.3s ease';
    
    if (txt) {
      const label = document.createElement('div');
      label.textContent = txt;
      label.style.position = 'absolute';
      label.style.top = '-35px';
      label.style.left = '0';
      label.style.background = '#39ff14';
      label.style.color = 'black';
      label.style.padding = '6px 12px';
      label.style.borderRadius = '4px';
      label.style.fontWeight = 'bold';
      label.style.fontSize = '16px';
      label.style.boxShadow = '0 2px 8px rgba(0,0,0,0.3)';
      overlay.appendChild(label);
    }
    
    document.body.appendChild(overlay);
    setTimeout(() => {
      overlay.style.opacity = '0';
      setTimeout(() => overlay.remove(), 300);
    }, dur);
  }, selector, text, duration);
  await delay(duration + 200);
}

async function robustLogin(page, username) {
  await page.waitForSelector('#username');
  await page.type('#username', username);
  await page.evaluate(() => {
    const el = document.querySelector('#username');
    if (el) el.dispatchEvent(new Event('blur'));
  });
  await delay(1000); // 展示呼吸感
  await page.waitForSelector('#password', { visible: true, timeout: 10000 });
  await page.type('#password', 'demopass');
  const confirmPasswordEl = await page.$('#confirmPassword');
  if (confirmPasswordEl) {
    await page.type('#confirmPassword', 'demopass');
  }
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

async function runDemo() {
  console.log('✨ 正在准备 ScoutingPro 27 评委展示环境...');
  
  if (process.env.SKIP_BUILD !== '1') {
    try {
      execSync('npm run build', { cwd: __dirname + '/..', stdio: 'ignore' });
      const mavenCmd = os.platform() === 'win32' ? 'mvn.cmd' : 'mvn';
      execSync(`${mavenCmd} package -DskipTests`, { cwd: path.join(__dirname, '../../Backend'), stdio: 'ignore' });
    } catch (e) {
      console.error('构建失败。', e);
      process.exit(1);
    }
  }

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

  process.on('SIGINT', () => {
    console.log('\n🛑 收到 Ctrl+C 信号，正在强制清理后台进程...');
    killProcessTree(backendProcess.pid);
    process.exit(1);
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Backend failed to start (Timeout)")), 60000);
    
    backendProcess.stdout.on('data', data => {
      const str = data.toString();
      if (str.includes('Listening on http://localhost:')) {
        clearTimeout(timeout);
        resolve();
      }
    });

    backendProcess.stderr.on('data', data => {
      const str = data.toString();
      if (str.includes('Listening on http://localhost:')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    
    backendProcess.on('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`Backend Process exited with code ${code}`));
    });
  });

  const getLaunchOptions = (index) => {
    const width = 800;
    const height = 850;
    // 并排显示：左边 Host，右边 Client (适配较小屏幕)
    const x = index * 810 + 10; 
    const y = 50;
    
    return {
      executablePath: CHROME_PATH,
      headless: false,
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        `--window-size=${width},${height}`,
        `--window-position=${x},${y}`
      ],
      defaultViewport: null // 设为 null 让视口自适应实际窗口内容区域
    };
  };

  let browserHost, browserClient;
  let pageHost, pageClient;
  const trackedUsers = [];

  try {
    const startChoice = await promptNextStep("即将开启双屏展示模式 (左侧 Host主机，右侧 Client从机)");
    if (startChoice === '0') throw new Error('EARLY_EXIT');

    browserHost = await puppeteer.launch(getLaunchOptions(0));
    browserClient = await puppeteer.launch(getLaunchOptions(1));

    pageHost = await browserHost.newPage();
    pageClient = await browserClient.newPage();

    const hostUser = `Host_Judge${Date.now()}`;
    trackedUsers.push(hostUser);

    console.log('\n🎬 第一幕: 主机建房');
    await pageHost.goto(BASE_URL);
    await robustLogin(pageHost, hostUser);
    
    await pageHost.waitForSelector('.action-btn.primary');
    await highlightElement(pageHost, '.action-btn.primary', '1. 主机发起一场新的赛事');
    await waitForTransition(pageHost);
    await pageHost.click('.action-btn.primary');
    
    await pageHost.waitForSelector('.modal-overlay input');
    await pageHost.type('.modal-overlay input', `DEMO_${Date.now()}`);
    await delay(500);
    await pageHost.click('.btn-confirm');
    await pageHost.waitForSelector('.event-meta strong');

    const eventCode = (await pageHost.$eval('.event-meta strong', el => el.textContent)).trim();
    
    const choice2 = await promptNextStep(`赛事已创建 [${eventCode}]。接下来展示从机通过 WebRTC 接入房间。`);
    if (choice2 === '0') throw new Error('EARLY_EXIT');

    console.log('\n🎬 第二幕: 从机无缝加入与底层 WebRTC P2P 直连');
    const clientUser = `Scouter_Alice${Math.random()}`;
    trackedUsers.push(clientUser);

    await pageClient.goto(BASE_URL);
    await robustLogin(pageClient, clientUser);
    
    await pageClient.waitForSelector('.action-btn.secondary');
    await waitForTransition(pageClient);
    await highlightElement(pageClient, '.action-btn.secondary', '2. 调查员输入房间号加入');
    await pageClient.click('.action-btn.secondary');
    
    await pageClient.waitForSelector('.modal-overlay input');
    await pageClient.type('.modal-overlay input', eventCode);
    await delay(500);
    await pageClient.click('.btn-confirm');
    
    // 等待 WebRTC 连通
    await pageClient.waitForSelector('.connection-status.connected', { timeout: 30000 });
    await highlightElement(pageClient, '.connection-status', '3. WebRTC P2P 打洞成功！');
    await highlightElement(pageHost, '.scouts-list', '4. 主机实时感知到从机上线');

    const choice3 = await promptNextStep("WebRTC 连接成功。接下来展示核心功能：从机录入多组数据，主机实时瞬间同步。");
    if (choice3 === '0') throw new Error('EARLY_EXIT');

    console.log('\n🎬 第三幕: 极速 P2P 实时数据录入 (多条展示)');
    
    // Client 去录入页 (Tab 0: Scout)
    await pageClient.evaluate(() => document.querySelectorAll('.tab-btn')[0].click());
    await waitForTransition(pageClient);
    
    // Host 去计分板页监控 (Tab 1: Rankings) 展示爬榜动画
    await pageHost.evaluate(() => document.querySelectorAll('.tab-btn')[1].click());
    await waitForTransition(pageHost);
    
    await highlightElement(pageClient, '.scout-form-container', '5. 调查员准备连续录入 15 组比赛数据');
    
    const records = [
      { match: '1', team: '254', alliance: 'Blue', score: '10' },
      { match: '1', team: '1678', alliance: 'Red', score: '8' },
      { match: '2', team: '1323', alliance: 'Blue', score: '5' },
      { match: '2', team: '971', alliance: 'Red', score: '6' },
      { match: '3', team: '254', alliance: 'Blue', score: '2' },  // 254 失误，排名下降
      { match: '3', team: '1678', alliance: 'Red', score: '15' }, // 1678 爆发，反超
      { match: '4', team: '1323', alliance: 'Blue', score: '20' }, // 1323 登顶
      { match: '4', team: '971', alliance: 'Red', score: '4' },
      { match: '5', team: '254', alliance: 'Blue', score: '18' }, // 254 追赶
      { match: '5', team: '1678', alliance: 'Red', score: '5' },
      { match: '6', team: '1323', alliance: 'Blue', score: '2' },
      { match: '6', team: '971', alliance: 'Red', score: '22' },  // 971 黑马跃升
      { match: '7', team: '254', alliance: 'Blue', score: '12' },
      { match: '7', team: '1678', alliance: 'Red', score: '14' },
      { match: '8', team: '1323', alliance: 'Blue', score: '15' }
    ];

    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      await pageClient.waitForSelector('input[placeholder="1-999"]');
      
      // 先清空输入框
      await pageClient.evaluate(() => {
          const inputs = document.querySelectorAll('input[inputmode="numeric"]');
          if (inputs.length >= 3) {
              inputs[0].value = '';
              inputs[1].value = '';
              inputs[2].value = '';
              inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
              inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
              inputs[2].dispatchEvent(new Event('input', { bubbles: true }));
          }
      });
      
      const inputs = await pageClient.$$('input[inputmode="numeric"]');
      await inputs[0].type(rec.match); 
      await inputs[1].type(rec.team); 
      // 输入得分以触发排名变动
      if (inputs.length >= 3) {
        await inputs[2].type(rec.score); 
      }
      
      await pageClient.evaluate((color) => {
          const span = Array.from(document.querySelectorAll('.spdt-labels span')).find(el => el.textContent.includes(color));
          if (span) span.click();
      }, rec.alliance);
      
      if (i === 0) {
        await highlightElement(pageClient, '.btn-submit', '6. 提交数据 (请评委注意左侧主机的实时反应)');
      }
      await pageClient.click('.btn-submit');
      
      // 前 3 个数据稍慢方便看清，后面的加速刷入以展示排名洗牌
      await delay(i < 3 ? 800 : 300); 
    }
    
    await highlightElement(pageHost, '.stats-card', '7. 零延迟！计分板瞬间刷新，展示爬榜动态！');

    const choice4 = await promptNextStep("数据池已丰富。接下来展示前沿的 View Transitions 平滑动画与 3D 悬浮看板。");
    if (choice4 === '0') throw new Error('EARLY_EXIT');

    console.log('\n🎬 第四幕: 极致的丝滑体验与数据看板展示');
    
    // Client 端展示底部导航切换动画
    await highlightElement(pageClient, '.bottom-nav', '8. 体验媲美原生 App 的 View Transitions 视口动画');
    const tabsClient = await pageClient.$$('.tab-btn');
    if (tabsClient.length >= 3) {
      await tabsClient[1].click(); // 去 Rankings(Dashboard)
      await waitForTransition(pageClient);
      await delay(1000);
      await tabsClient[2].click(); // 去 History 页
      await waitForTransition(pageClient);
      await delay(1000);
      await tabsClient[0].click(); // 回 Scout 页
      await waitForTransition(pageClient);
    }
    
    // Host 端回到 Dashboard 展示 3D Card 悬浮
    await pageHost.evaluate(() => document.querySelectorAll('.tab-btn')[1].click());
    await waitForTransition(pageHost);
    await highlightElement(pageHost, '.stats-card', '9. 计分板已汇总数据，物理引擎级 3D 倾斜交互');
    
    const cardRect = await pageHost.evaluate(() => {
      const card = document.querySelector('.stats-card');
      if (!card) return null;
      const rect = card.getBoundingClientRect();
      return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
    });
    
    if (cardRect) {
      // 模拟鼠标在卡片四周滑动以触发 3D tilt
      const cx = cardRect.x + cardRect.w / 2;
      const cy = cardRect.y + cardRect.h / 2;
      await pageHost.mouse.move(cx - 30, cy - 30, { steps: 5 });
      await delay(500);
      await pageHost.mouse.move(cx + 40, cy + 30, { steps: 5 });
      await delay(800);
      await pageHost.mouse.move(0, 0); // 移开
    }
    
    // 最后再秀一下 Inbox
    await highlightElement(pageHost, '.inbox-morph-container', '10. 全新设计的荧光绿信息中心，随时待命');

    const choice5 = await promptNextStep("基本看板展示完毕。接下来展示跨页面的「推拉滑动动画」以及「Inbox 实时消息系统」。");
    if (choice5 === '0') throw new Error('EARLY_EXIT');

    console.log('\n🎬 第五幕: 退出与重进 (丝滑原生推拉动画)');
    
    // Client 退出房间
    await highlightElement(pageClient, '.btn-back', '11. 调查员点击返回，展示页面级 Slide-out 动画');
    await pageClient.click('.btn-back');
    await waitForTransition(pageClient);
    await delay(1000);
    
    // Client 再次点击卡片进入
    await highlightElement(pageClient, '.event-card', '12. 再次点击比赛卡片，展示 Slide-in 动画');
    await pageClient.click('.event-card');
    await waitForTransition(pageClient);
    await delay(1000);

    console.log('\n🎬 第六幕: 主机下发指令，Inbox 荧光接收');
    
    // Host 切到 Scouts 页面
    await highlightElement(pageHost, '.tab-btn:nth-child(4)', '13. 主机切换到人员管理页');
    await pageHost.evaluate(() => document.querySelectorAll('.tab-btn')[3].click());
    await waitForTransition(pageHost);
    
    // 拦截 Prompt 并自动发送消息
    pageHost.on('dialog', async dialog => {
      await delay(500);
      await dialog.accept('hello');
    });

    await highlightElement(pageHost, '.btn-msg', '14. 主机向该调查员下发指令消息');
    await pageHost.click('.btn-msg');
    
    // Client 的 Inbox 会闪烁或更新
    await delay(1000); // 等待消息通过 WebRTC 传给 Client
    await highlightElement(pageClient, '.inbox-morph-container', '15. 调查员的 Inbox 瞬间收到消息，触发荧光动画！');
    
    // 自动帮 Client 点开 Inbox 看看消息
    await pageClient.click('.inbox-morph-container');
    await delay(1500); // 等待展开动画完成

    // 标记已读
    await highlightElement(pageClient, '.mark-read', '16. 查看消息内容并点击已读');
    await pageClient.click('.mark-read');
    await delay(1000);

    // 关掉 Inbox 弹窗
    await highlightElement(pageClient, '.inbox-header', '17. 关闭消息中心');
    await pageClient.click('.inbox-header');
    await delay(1500); // 等待收缩动画完成

    console.log('\n🎉 展示流程完毕，感谢评委观看！');
    await promptNextStep("敲击回车清理数据并优雅关闭环境");

  } catch (err) {
    if (err.message !== 'EARLY_EXIT') {
      console.error('展示脚本遇到错误:', err);
      process.exitCode = 1;
    } else {
      console.log('🛑 收到终止指令，即将进行资源收尾...');
    }
  } finally {
    console.log('\n=== 收尾与清理资源 ===');
    
    if (trackedUsers.length > 0) {
      try {
        console.log(`正在彻底抹除本次展示创建的赛事记录...`);
        const resp = await fetch('http://localhost:7071/api/test/cleanup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(trackedUsers)
        });
        if (resp.ok) console.log('✅ 测试垃圾数据清理完毕。');
      } catch (err) {}
    }

    const disconnectPage = async (page) => {
      if (!page) return;
      try {
        await Promise.race([
          page.evaluate(() => { if (window.__rtcDisconnect) window.__rtcDisconnect(); }),
          new Promise(resolve => setTimeout(resolve, 2000))
        ]);
      } catch (e) {}
    };

    await Promise.all([disconnectPage(pageHost), disconnectPage(pageClient)]);
    await delay(500);

    console.log('正在关闭浏览器窗口...');
    await Promise.all([
      browserHost?.close().catch(() => {}),
      browserClient?.close().catch(() => {})
    ]);
    
    if (backendProcess) killProcessTree(backendProcess.pid);
    rl.close();
    console.log('👋 退出完毕。');
    process.exit(process.exitCode || 0);
  }
}

runDemo();
