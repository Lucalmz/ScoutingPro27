# ScoutingPro27 Documentation Index / 文档总索引

> 📂 本目录集中维护 ScoutingPro27 的用户手册、测试指南、发版说明、架构规划、框架参考与视觉素材，保持仓库根目录清晰整洁。

---

## 🧭 核心入口与工程契约 (Core Entry & Contracts)

| 文档 | 说明 |
| --- | --- |
| [**`../README.md`**](../README.md) · [**`../README_zh.md`**](../README_zh.md) | English / 简体中文 项目总览、架构深度拆解与测试命令基线 |
| [**`../CONTRACT.md`**](../CONTRACT.md) | 后端 REST API、WebSocket 信令、CRDT 投影协议、JCEF 桌面桥接与运行时启动契约（**单一接口真相来源**） |
| [**`../AGENTS.md`**](../AGENTS.md) | 仓库协作、契约优先维护与严谨验证交付铁律 |
| [**`../frontend/README.md`**](../frontend/README.md) | 前端开发脚本、测试指令、E2E 套件与文档生成器说明 |

---

## 📖 新手手册与离线 PDF (User Guides)

| 文档 | 说明 |
| --- | --- |
| [**`USER_GUIDE.md`**](./USER_GUIDE.md) | 中英双语速查总入口（含安装指引与 BIOBUZZ 赛规 30 秒备忘） |
| [**`USER_GUIDE.zh.md`**](./USER_GUIDE.zh.md) | 简体中文零基础分步图文手册（第 0–16 章，含 Windows `.msi`/macOS `.dmg` Gatekeeper 绕过与 `17` 张高清标注截图） |
| [**`USER_GUIDE.en.md`**](./USER_GUIDE.en.md) | English Step-by-Step Illustrated User Guide (Ch 0–16 incl. Windows `.msi`/macOS `.dmg` Gatekeeper bypass & `17` annotated screenshots) |
| **`ScoutingPro27_UserGuide_ZH.pdf`** / **`ScoutingPro27_UserGuide_EN.pdf`** | 由 `frontend/generators/export-userguide-pdf.js` 导出的离线 PDF 手册；`docs/*.pdf` 与 `docs/images/userguide/` 均为 Git 忽略的本地生成产物（`npm run capture:userguide` / `npm run export:userguide-pdf`） |

---

## 🧪 测试与真机联调指南 (Testing & QA)

| 文档 | 说明 |
| --- | --- |
| [**`testing/MANUAL_TESTING_CHECKLIST.md`**](./testing/MANUAL_TESTING_CHECKLIST.md) | 赛前全功能双端（电脑主控 + 手机）实机手动核对清单 |
| [**`testing/VPN_P2P_TEST_GUIDE.md`**](./testing/VPN_P2P_TEST_GUIDE.md) | VPN / 弱网 / ECDH 加密通道 / UPnP 物理开孔真机测试指南 |
| [**`TEST_AUDIT_REPORT.md`**](./TEST_AUDIT_REPORT.md) | 2026-11-22 测试与 E2E 全量审计报告（历史整改前快照；当前实测基线见根目录 `README.md`） |

---

## 🚀 发版说明 (Release Notes)

| 文档 | 说明 |
| --- | --- |
| [**`releases/release-notes-v1.0.4.md`**](./releases/release-notes-v1.0.4.md) | v1.0.4 赛季首版现场可用版发版说明（v1.0.1 ~ v1.0.4 核心演进汇总） |
| [**`releases/release-notes-v1.0.1.md`**](./releases/release-notes-v1.0.1.md) | v1.0.1 首个 Production-Ready MVP 版本发布说明 |

---

## 🏗️ 架构规划与框架参考 (Plans & References)

| 文档 | 说明 |
| --- | --- |
| [**`plans/AI_COPILOT_IMPLEMENTATION_PLAN.md`**](./plans/AI_COPILOT_IMPLEMENTATION_PLAN.md) | AI Copilot 商业化重构与三流派协议工程实施规划（**已落地归档**，Flyway `V9` 实现完毕；最新接口契约以 [`CONTRACT.md`](../CONTRACT.md) §12 为准） |
| [**`references/Javalin.md`**](./references/Javalin.md) | Javalin 7.2.3 框架使用规范与路由/配置速查参考 |

---

## 🎨 宣传素材与架构图 (Promo & Visual Assets)

| 路径 | 说明 |
| --- | --- |
| [**`promo/STORYBOARD_SCRIPT.md`**](./promo/STORYBOARD_SCRIPT.md) | 产品宣传视频分镜脚本、中英解说词与高分屏截图映射 |
| `promo/screenshots/` | 8 张 4K/2K 宣传核心截图（可由 `frontend/generators/capture-promo-screens.js` 重新生成） |
| `images/` | README 架构图与机制图（[`architecture.svg`](./images/architecture.svg)、[`security-flow.svg`](./images/security-flow.svg)、[`state-sync.svg`](./images/state-sync.svg)、[`brag-index.svg`](./images/brag-index.svg) 等） |
