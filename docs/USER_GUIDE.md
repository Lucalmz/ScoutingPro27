# ScoutingPro 27 使用手册双语总入口 / Bilingual User Guide Hub (BIOBUZZ Pit Wall 版)

> 👋 **第一次拿手机或电脑做赛场记录？完全不懂专业术语也没关系！**  
> 本手册已全面适配最新 **Cold Graphite Pit Wall** 界面与 **P2P 跨网直连 / 自定义 TURN** 体系，包含完整的中/英双语实机高清标注截图（`1440×900` 桌面端 + `414×896` 手机单手向导），手把手带你 3 分钟上手 **BIOBUZZ 赛季全流程**。

| 选择你的阅读语言 / Choose Your Language | 直达完整保姆级手册 | 离线 PDF 版 | 包含截图套数 |
| :--- | :--- | :--- | :--- |
| 🇨🇳 **简体中文完全零基础教程** | 👉 [**点击打开 `docs/USER_GUIDE.zh.md`**](./USER_GUIDE.zh.md) | 📄 [`ScoutingPro27_UserGuide_ZH.pdf`](./ScoutingPro27_UserGuide_ZH.pdf) | 17 张全中文高清实机标注图 (`images/userguide/zh/`) |
| 🇬🇧 **English Beginner Step-by-Step Guide** | 👉 [**Open `docs/USER_GUIDE.en.md`**](./USER_GUIDE.en.md) | 📄 [`ScoutingPro27_UserGuide_EN.pdf`](./ScoutingPro27_UserGuide_EN.pdf) | 17 English Annotated Screenshots (`images/userguide/en/`) |

---

## ⚡ 30 秒赛场极速速查卡 / 30-Second Arena Cheat-Sheet

### 1. 我该点哪个功能？（按赛场角色速查）

| 角色 / Role | 中文手册直达 | English Section | 核心动作 / Key Actions |
| :--- | :--- | :--- | :--- |
| 🚩 **主机 / 队长 (Host)** | [建账号](./USER_GUIDE.zh.md#第-1-章打开软件并秒建你的名字) · [扫码与热点/通道状态](./USER_GUIDE.zh.md#第-2-章拉队友扫码进同一场比赛没外网也不怕) · [官方同步与自定义 TURN](./USER_GUIDE.zh.md#第-15-章怎么从-ftc-官方获取赛事信息名单赛程对账顺延晋级分与自定义-turn) · [批量排班](./USER_GUIDE.zh.md#第-9-章赛程排班谁盯哪台车怎么批量排班) · [自定义字段](./USER_GUIDE.zh.md#第-14-章怎么自定义字段给打分表展位表加专属指标) | [Account](./USER_GUIDE.en.md#chapter-1-open-the-app--create-your-callsign) · [QR / LAN & Transport HUD](./USER_GUIDE.en.md#chapter-2-scan-qr-to-join-the-same-event-even-without-venue-internet) · [Official Sync & Custom TURN](./USER_GUIDE.en.md#chapter-15-official-ftc-data-sync-roll-down-advancement-and-custom-turn) · [Batch Schedule](./USER_GUIDE.en.md#chapter-9-match-schedule--assignments-how-batch-scheduling-works) · [Custom Fields](./USER_GUIDE.en.md#chapter-14-how-to-add--manage-custom-fields) | 建赛事 → 绑定 FTC 代码拉名单/赛程 → 拖拽框选一键排班 → 按需配置队伍专属 TURN |
| 📱 **看台计分员 (Scout)** | [赛前选队](./USER_GUIDE.zh.md#第-3-章开赛前-10-秒准备选模式阵营与核对队号) · [自动/手动](./USER_GUIDE.zh.md#第-5-章2-分钟手动阶段-teleop-与预测单轮耗时怎么算) · [BIOBUZZ 终局](./USER_GUIDE.zh.md#第-6-章biobuzz-终局-endgame-最后-60-秒规则与核对提交) · [手机向导](./USER_GUIDE.zh.md#第-7-章手机单手盲操向导看台站着一只手记完) · [改记录](./USER_GUIDE.zh.md#第-12-章怎么改记录提交错了随时回到表单修改) | [Pre-Match](./USER_GUIDE.en.md#chapter-3-10-second-pre-match-setup-mode-alliance--pit-cross-check) · [TeleOp Cycle](./USER_GUIDE.en.md#chapter-5-2-minute-teleop-phase--how-predict-cycle-time-works) · [BIOBUZZ Endgame](./USER_GUIDE.en.md#chapter-6-biobuzz-endgame-last-60-seconds--offline-safe-submit) · [Mobile Wizard](./USER_GUIDE.en.md#chapter-7-mobile-single-handed-wizard-scout-standing-up-with-one-thumb) · [Edit Record](./USER_GUIDE.en.md#chapter-12-how-to-edit--fix-saved-match-records) | 盯住 1 台车 → 盲按进球绿键 → 点「记录新轮次」→ 录错去「历史」点编辑 |
| 🔧 **维修区侦察 (Pit Scout)** | [展位大小车、体重与抽屉表单](./USER_GUIDE.zh.md#第-8-章展位侦察-pit-scout怎么记大小车体重与实际录入界面) | [Pit Scouting & Drawer UI](./USER_GUIDE.en.md#chapter-8-pit-scouting-robot-size-weight--actual-pit-form-drawer) | 点「同步 FTC 官方名单」→ 点「查看/修改」记录体重、大小车与自述分数 |
| 🎯 **教练 / 战术分析 (Coach)** | [天梯与吹牛指数](./USER_GUIDE.zh.md#第-10-章排名天梯与吹牛指数怎么选真正靠谱的联队队友) · [官方晋级与顺延](./USER_GUIDE.zh.md#第-15-章怎么从-ftc-官方获取赛事信息名单赛程对账顺延晋级分与自定义-turn) · [战术白板推演](./USER_GUIDE.zh.md#第-11-章战术白板赛前-1-分钟画路线并播放动画防撞车) · [绑 Key 问 AI](./USER_GUIDE.zh.md#第-13-章怎么绑定-api-key-并和-ai-对话) | [Rankings & Brag Index](./USER_GUIDE.en.md#chapter-10-rankings--brag-index-picking-honest-alliance-partners) · [Official Adv. Roll-Down](./USER_GUIDE.en.md#chapter-15-official-ftc-data-sync-roll-down-advancement-and-custom-turn) · [Whiteboard & Play Sim](./USER_GUIDE.en.md#chapter-11-tactical-whiteboard-plan--play-animated-routes-before-queuing) · [Bind Key & AI Coach](./USER_GUIDE.en.md#chapter-13-how-to-bind-an-api-key--chat-with-ai) | 看首列 **晋级分（含顺延）**、**Predict Cycle Time**、**Swarm RP**、绑 Key 问 AI |

### 2. BIOBUZZ 赛季 4 条铁律（千万别按旧赛季记错！）

1. **无爬升挂架 (No Climbing / Hang)**：终局看 **最后 60 秒 Nectar (+2/颗, 上限 8)**、**己方占底花 (+5/朵, ≤4)**、**Pollen (+2)**、**Garden 推球 (+1)** 与 **Loading Zone Park (+5)**。
2. **G410 与 G418**：60 秒前偷放 Nectar 记得勾选 **G410**（+20 对手大犯规）；从敌方花底合法掏出 Pollen 勾选 **G418**。
3. **Predict Cycle Time**：必须打满 **≥ 6 轮**有效轮次（剔除最快 1 次取后续 4 次平均），不足 6 轮显示 **`不足 6 轮 / <6 cyc`**。
4. **Swarm RP 机动门槛**：离墙 (+3) + 自动停泊 (+5) + 终局停泊 (+5) = 单车最高 13 分；双车合计 **≥ 16 分** 稳拿 Swarm RP！

### 3. 最新版 5 级传输状态识别（顶部/手机端状态胶囊）
- **`IPv6 直连 / IPv6 Direct`** · **`局域网直连 / LAN Direct`** · **`IPv4 打洞 / IPv4 Hole-punch`**：点对点毫秒级直连（桌面 Host 启动自动在物理网卡尝试 UPnP/PCP 开孔）。
- **`ECDH 加密通道 / ECDH Tunnel (TLS)`**：UDP 受阻（如手机开 VPN）时秒级自动切入的 **零 TURN 流量** 端到端加密通道，后台持续静默探针升级回直连。
- **`TURN 中继 / TURN Relay`**：极端防火墙最后保底（可在「考察员与设置」配置队伍专属 **自定义 TURN**）。详情见 [VPN P2P 真机测试指南](./testing/VPN_P2P_TEST_GUIDE.md) 与 [赛前全功能手动测试清单](./testing/MANUAL_TESTING_CHECKLIST.md)。
