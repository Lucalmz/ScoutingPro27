# ScoutingPro 27 官方宣传片制作脚本与资产物料指南
> **专为 Google Vids / Google Flow / 智能视频生成平台设计的分镜与配音物料包**  
> 项目：ScoutingPro 27 (FTC Team 27570 独立打造的去中心化 P2P 机器人赛事侦察系统)  
> 推荐视频总时长：**90 秒 ~ 120 秒**  
> 视觉风格：**赛博朋克极简暗黑风 (Dark Cyberpunk) + 电光绿/科技蓝强调色 + 工业硬核工程感**

---

## 快速导入指南 (Quick Prompt for Google Flow / Google Vids)

在使用 Google Vids 或 Google Flow 时，可以直接在 **“Create a video with Gemini”** 提示词框中输入以下总导演提示：

```text
Create a 90-second high-energy, cinematic tech product showcase video for "ScoutingPro 27". 
Target Audience: FIRST Robotics (FTC/FRC) teams, competition judges, and high-school engineers.
Theme & Visual Style: Modern dark cyberpunk, electric green (#39ff14) and tech blue accents, crisp UI screen recordings, high-contrast typography, and dynamic transitions.
Pacing: Fast-paced, punchy, problem-to-solution narrative, concluding with team engineering pride.
Use the uploaded screenshots as primary scene visual assets according to the storyboard below.
```

---

## 完整分镜脚本与音画对账表 (Scene-by-Scene Storyboard)

### Scene 1: 痛点引入 (The Arena Chaos)
* **时间轴**：`00:00 - 00:15` (15 秒)
* **核心画面资产**：`screenshots/01_brand_login_screen.png`（缓速微距推入，聚焦深色赛博登录界面）+ 叠加“全场断网”文字动效
* **屏幕醒目标题 (On-Screen Text)**：
  * **FTC Championship Arena** / **万人会场 · Wi-Fi 瘫痪**
  * **纸质表格丢单 · 云端转圈掉线 · 你的战术如何落地？**
* **中文解说词 (Voiceover)**：
  > “在万人呐喊的 FIRST 机器人锦标赛现场，Wi-Fi 频道全线管制，基站流量严重拥堵。传统的云端侦察系统瞬间掉线转圈，纸质表格不仅效率低下而且极易丢单。在分秒必争的赛场上，你如何指挥你的战队打赢这场淘汰赛？”
* **英文解说词 (English Option)**：
  > "Inside the roaring FIRST championship arena, Wi-Fi channels are jammed and cellular data fails. Cloud scouting apps freeze; paper sheets get lost. How does your team scout the best alliance partners when connection drops?"

---

### Scene 2: 颠覆创新 (The P2P Breakthrough)
* **时间轴**：`00:15 - 00:35` (20 秒)
* **核心画面资产**：`screenshots/02_host_event_created.png`（展示赛事大厅、房间代码与 WebRTC 就绪状态）+ `screenshots/03_mobile_qr_modal.png`（免装 App 极速扫码弹窗）+ 架构矢量图 `docs/images/architecture.svg`
* **屏幕醒目标题 (On-Screen Text)**：
  * **ScoutingPro 27**
  * **彻底去中心化 · 零云服务器 · 零运维成本**
  * **公网 WebRTC P2P 穿透直连**
* **中文解说词 (Voiceover)**：
  > “ScoutingPro 27 颠覆登场！由 FTC 27570 少年工程师团队独立研发，彻底抛弃脆弱昂贵的中心化服务器，首次将公网 WebRTC P2P 穿透直连引入机器人赛事协同。领队电脑连场馆热点，看台队员用手机 5G——扫码即连，跨越物理局域网隔绝，瞬间完成分布式并网！”
* **英文解说词 (English Option)**：
  > "Introducing ScoutingPro 27—the world's first decentralized scouting system powered by public WebRTC P2P mesh. Zero cloud servers, zero operational costs. The commander uses arena Wi-Fi, scouters use cellular 5G. Scan, punch through NAT, and establish instant direct mesh."

---

### Scene 3: 极速侦察 (Split-Second Bleacher Scouting)
* **时间轴**：`00:35 - 00:55` (20 秒)
* **核心画面资产**：`screenshots/04_mobile_scout_join.png`（iPhone 竖屏看台单手打分界面、红蓝联盟切换、底部赛博导航）
* **屏幕醒目标题 (On-Screen Text)**：
  * **专为看台而生 · 单手盲操急速打分**
  * **自动阶段 / 手动拾取 / 升降悬挂 · 毫秒级防冲突同步**
* **中文解说词 (Voiceover)**：
  > “专为看台侦察量身定制的单手盲操打分系统。高对比度触控布局，自动阶段、周期拾取、终局悬挂，即录即走。搭载分布式单调时钟冲突消解算法，即使赛场信号偶发中断，数据本地零信任安全驻留，重连瞬间毫秒级自动补发对账！”
* **英文解说词 (English Option)**：
  > "Tailored for rapid bleacher scouting: high-contrast, one-hand tactile controls. Autonomous points, tele-op scoring, and endgame hang recorded in split seconds. Equipped with distributed monotonic clock synchronization—offline resilient, instant conflict-free catch-up."

---

### Scene 4: 独创算法与天梯 (The Truth Machine: Brag Index & Ladder)
* **时间轴**：`00:55 - 01:15` (20 秒)
* **核心画面资产**：`screenshots/05_pit_scout_view.png`（展位硬件规格摸底卡片）+ `screenshots/06_live_rankings_ladder.png`（实时爬榜天梯排行榜）+ 吹牛指数逻辑图 `docs/images/brag-index.svg`
* **屏幕醒目标题 (On-Screen Text)**：
  * **独创「吹牛指数 (Brag Index)」对账算法**
  * **展位摸底 vs 真实战力 · 虚假宣传无所遁形**
  * **实时天梯爬榜，锁定最强选秀联盟**
* **中文解说词 (Voiceover)**：
  > “数据真实胜过一切！ScoutingPro 27 独创‘吹牛指数’对账状态机——将赛前展位打探的夸大宣传，与赛场现场打分的真实表现进行多维交叉校验。常规赛留力、机械偶发故障无所遁形！实时战力天梯动态排位，助你在联盟选秀大会中稳操胜券。”
* **英文解说词 (English Option)**：
  > "Truth over claims! Our proprietary 'Brag Index' cross-audits pit scouting claims against real match telemetry. Detect sandbagging and mechanical breakdowns instantly. A live dynamic ladder guides your alliance selection with total precision."

---

### Scene 5: 战术 AI 军师与赛博指挥 (Tactical AI Advisor & Ambient Mesh)
* **时间轴**：`01:15 - 01:35` (20 秒)
* **核心画面资产**：`screenshots/07_chat_with_ai.png`（战术 AI 军师对话与实时数据挂载）+ `screenshots/08_inbox_and_settings.png`（领队控制台、离线 U 盘应急与悬浮 Inbox）
* **屏幕醒目标题 (On-Screen Text)**：
  * **嵌入式战术 AI 军师 · 实时数据精准推演**
  * **赛博荧光信息中心 · U 盘离线全量备份**
* **中文解说词 (Voiceover)**：
  > “领队电脑端一键派活，看台队员荧光信息流毫秒级响应。更有离线 U 盘应急一键同步包，以及嵌入式的赛场战术 AI 军师，即使面临最极端的断网环境，也能筑牢最严密的数据护城河。”
* **英文解说词 (English Option)**：
  > "Command from host, execute in bleachers. A cyberpunk ambient Inbox delivers real-time assignments over P2P data channels. Bundled with USB offline snapshot syncing and tactical AI intelligence—your ultimate fail-safe scouting fortress."

---

### Scene 6: 团队情怀与开源致谢 (Engineering Pride & Call to Action)
* **时间轴**：`01:35 - 01:50` (15 秒)
* **核心画面资产**：FTC Team 27570 B.E.A.R. 战队 Logo + GitHub 开源仓库地址画面
* **屏幕醒目标题 (On-Screen Text)**：
  * **ScoutingPro 27 🚀**
  * **完全由 FTC Team 27570 (B.E.A.R.) 中学生独立构思与全栈自研**
  * **全面开源 · 赋能全球 FIRST 战队**
  * `github.com/Lucalmz/ScoutingPro27`
* **中文解说词 (Voiceover)**：
  > “这不仅仅是一款工具，更是一群中学生工程师用硬核代码对 FIRST 竞技精神的致敬。ScoutingPro 27，完全开源免费，赋能全球赛场。探索属于你的赛场胜负手，立即在 GitHub 上体验！”
* **英文解说词 (English Option)**：
  > "Proudly engineered by high-school students of FTC Team 27570 B.E.A.R. 100% open-source, zero cost, built for the global FIRST community. Power your championship run with ScoutingPro 27 on GitHub today!"

---

## 素材清单映射与技术元数据 (Captured High-Res Visual Assets)

所有素材均已保存在 `promo_assets/screenshots/` 目录下，采用真实应用端到端无头浏览器高分屏（2x/3x Retina）无失真捕获：

| 序号 | 真实文件名 | 规格分辨率 | 对应场景 | 重点呈现视觉元素 |
| :---: | :--- | :---: | :---: | :--- |
| **01** | `01_brand_login_screen.png` | 3840x2160 (4K Retina) | Scene 1 | 战队 Logo、赛博暗黑主题、FTC 27570 战队标识与极简入口 |
| **02** | `02_host_event_created.png` | 3840x2160 (4K Retina) | Scene 2 | 赛事房间代码（如 WMCAJK）、领队中控台、单机/P2P在线指示器 |
| **03** | `03_mobile_qr_modal.png` | 3840x2160 (4K Retina) | Scene 2 / 3 | 免装 App 手机局域网/公网扫码弹窗、动态 IP 检测与一键复制链接 |
| **04** | `04_mobile_scout_join.png` | 1242x2688 (Mobile 9:16) | Scene 3 | 手机看台单手打分界面、红蓝联盟切换、底部 4+1 赛博导航条与脉冲连接器 |
| **05** | `05_pit_scout_view.png` | 3840x2160 (4K Retina) | Scene 4 | 展位摸底战队卡片网格 (#11115, #27570, #28410)、底盘与硬件构型筛选 |
| **06** | `06_live_rankings_ladder.png` | 3840x2160 (4K Retina) | Scene 4 | 实时爬榜天梯表（Rating 200.0/176.5/145.0、Auto/Teleop/End 细分均分、趋势标识） |
| **07** | `07_chat_with_ai.png` | 3840x2160 (4K Retina) | Scene 5 | 战术军师 AI 界面、动态挂载赛事数据胶囊、交互式战队微标与吹牛审计对账建议 |
| **08** | `08_inbox_and_settings.png` | 3840x2160 (4K Retina) | Scene 5 | 领队中控台、FTC 官方赛事绑定、离线 U 盘应急导出包与悬浮 Inbox 消息中心 |
