# ScoutingPro 27 — User Guide / 新手使用手册 (BIOBUZZ Pit Wall 版)

> 🌐 **Bilingual Documentation Entry / 中英双语完整教程入口**  
> 本工具面向 **零基础新手队员、看台志愿者、维修区侦察员与教练团队**，全面升级 **Cold Graphite Pit Wall** 冷石墨工业风界面（桌面原生端自动顶栏去重，网页/手机端保留完整头栏），自带全套中/英文分步实机标注截图。

## 📖 Select Your Guide / 请选择手册版本

- 🇨🇳 **简体中文完全零基础教程**：👉 [**docs/USER_GUIDE.zh.md**](docs/USER_GUIDE.zh.md) | 📄 [**直接可发给队员的离线 PDF 版**](docs/ScoutingPro27_UserGuide_ZH.pdf)  
  *从零开始：打开网址设代号 → 扫码/局域网热点连线（5 级状态 HUD 与 ECDH 零配额通道） → 自动/手动打分与 6 轮测速 → BIOBUZZ 无爬升终局计分 → 手机单手向导 → 展位抽屉表单 → 批量排班、历史改分、AI 绑 Key 对话、自定义字段与房主专属自定义 TURN 中继。*

- 🇬🇧 **English Beginner Step-by-Step User Guide**: 👉 [**docs/USER_GUIDE.en.md**](docs/USER_GUIDE.en.md) | 📄 [**Shareable Offline PDF**](docs/ScoutingPro27_UserGuide_EN.pdf)  
  *Complete walkthrough: Callsign signup → QR / Arena LAN offline join (5-tier Transport HUD & zero-quota ECDH tunnel) → Pre-match cross-check → Auto & TeleOp cycle logging (Predict Cycle Time) → BIOBUZZ Endgame steppers → One-thumb mobile wizard → Pit Form Drawer → Batch Schedule, History Edit, AI API Key Chat, Custom Fields & Custom TURN Relay.*

- 🗂️ **Bilingual Cheat-Sheet Hub**: 👉 [**docs/USER_GUIDE.md**](docs/USER_GUIDE.md) | 📡 **VPN / 跨网 P2P 真机测试指南**: 👉 [**docs/VPN_P2P_TEST_GUIDE.md**](docs/VPN_P2P_TEST_GUIDE.md)

---

## ⚡ 30 秒赛场备忘 / 30-Second Quick Reference

| 关键概念 / Feature | 记分与判据 / Key Rule | 手册对应章节 |
| :--- | :--- | :--- |
| **BIOBUZZ Endgame (无爬升)** | 仅最后 60s 有效：**Nectar +2** (联盟上限 8) · **Bottom Nectar +5/朵** (≤4) · **Pollen +2** · **Garden +1** · **Park +5** · 60s前误投记 **G410** · 底口掏球记 **G418** | [中文第 6 章](docs/USER_GUIDE.zh.md#第-6-章biobuzz-终局-endgame-最后-60-秒规则与核对提交) · [English Ch.6](docs/USER_GUIDE.en.md#chapter-6-biobuzz-endgame-last-60-seconds--offline-safe-submit) |
| **Predict Cycle Time** | 手动阶段打满 **≥ 6 轮**（相邻间隔 ≤120s），剔除最快 1 次异常间隔后取次快 4 次平均；不足 6 轮诚实显示 `不足6轮 / <6 cyc` | [中文第 5 章](docs/USER_GUIDE.zh.md#第-5-章2-分钟手动阶段-teleop-与预测单轮耗时怎么算) · [English Ch.5](docs/USER_GUIDE.en.md#chapter-5-2-minute-teleop-phase--how-predict-cycle-time-works) |
| **Swarm RP 机动分** | 离墙 (+3) + 自动停泊 (+5) + 终局停泊 (+5) = 单车最高 13 分；红蓝单边双车合计 **≥ 16 分** 预计达成 Swarm RP | [中文第 10 章](docs/USER_GUIDE.zh.md#第-10-章排名天梯与吹牛指数怎么选真正靠谱的联队队友) · [English Ch.10](docs/USER_GUIDE.en.md#chapter-10-rankings--brag-index-picking-honest-alliance-partners) |
| **Pit Scout & Brag Index** | 客观展示 **体重 (lbs)** 与 **紧凑小车 / 标准中型 / 宽体大车**（无虚假超重警报），结合 **花朵已证实 / 停泊已证实** 与 `≤1.25x` ~ `>2.20x` 吹牛指数核验 | [中文第 8 章](docs/USER_GUIDE.zh.md#第-8-章展位侦察-pit-scout怎么记大小车体重与实际录入界面) · [English Ch.8](docs/USER_GUIDE.en.md#chapter-8-pit-scouting-robot-size-weight--actual-pit-form-drawer) |
| **排班 / 改分 / AI / 自定义字段** | 拖拽框选批量排班、去「历史」点编辑改回错分、绑定 DeepSeek/Gemini Key 问 AI 教练、30 秒自定义打分/展位字段 | [中文第 9, 12–14 章](docs/USER_GUIDE.zh.md#第-9-章赛程排班谁盯哪台车怎么批量排班) · [English Ch.9, 12–14](docs/USER_GUIDE.en.md#chapter-9-match-schedule--assignments-how-batch-scheduling-works) |
| **FTC 官方同步与自定义 TURN** | 免自备 Key！填官网起始赛季年与 Event Code 一键绑定同步名单/赛程/对账/顺延晋级分；房主还可选配 AES-256 加密 **自定义 TURN 中继** | [中文第 15 章](docs/USER_GUIDE.zh.md#第-15-章怎么从-ftc-官方获取赛事信息名单赛程对账顺延晋级分与自定义-turn) · [English Ch.15](docs/USER_GUIDE.en.md#chapter-15-official-ftc-data-sync-roll-down-advancement-and-custom-turn) |
| **跨网直连 / 5 级通道 / 纯离线** | 状态胶囊实时展示 `IPv6直连 / 局域网直连 / IPv4打洞 / ECDH加密通道 / TURN中继`；桌面端自动 UPnP 开孔；纯离线支持热点 QR 与 **U盘离线同步** | [中文第 2 & 16 章](docs/USER_GUIDE.zh.md#第-2-章拉队友扫码进同一场比赛没外网也不怕) · [English Ch.2 & 16](docs/USER_GUIDE.en.md#chapter-2-scan-qr-to-join-the-same-event-even-without-venue-internet) |
