## ScoutingPro27 v1.0.1 - First Field-Ready MVP Edition

> 💡 **本项目完全由 FIRST Tech Challenge (FTC) Team 27570 B.E.A.R. 的中学生团队独立构思、架构设计并全栈开发完成。**  
> 诞生于真实赛场的一线实战需求，用硬核的现代工程实践，重新定义全球 FIRST 赛事的侦察协同体验。

---

### 📌 版本定位与赛前承诺 (Release Positioning & Season Commitment)

- **版本定位**：本版本（`v1.0.1`）是面向全新赛季的**首版现场稳定可用的基础交付版 (Production-Ready MVP)**，已完成全链路架构闭环与核心交互定型，具备在真实赛场环境独立、稳定、高可用运作的完整能力。
- **开题承诺**：**我们郑重承诺：在第一场官方资格赛打响之前（Before the First Qualifying Tournament），团队将带来一次重大版本更新！** 我们将紧密追踪新赛季官方规则细化与第一线实战测试反馈，对数据模型、人机工效与战术分析模块进行针对性演进与深度打磨。

---

### ✨ 本版本核心演进与技术亮点 (Key Highlights & Evolution)

#### 1. 突破性去中心化通信与赛场网络弹性 (P2P Mesh & Venue Resilience)
- **公网 WebRTC P2P 毫秒级直连**：跨越 Wi-Fi 与 4G/5G 移动蜂窝网络物理隔离，看台队员与领队笔记本实现端到端直接通信（实测延迟 <50ms），彻底摆脱对场馆易受管制的中心 Wi-Fi 或云服务器的依赖；
- **多信令节点集群与国内高速反射**：构建 MQTT 多 Broker 自动故障转移（Multi-Broker Failover），引入国内自建与低延迟 STUN 反射节点（腾讯云 / 小米 / Metered.ca 国内外混合 ICE 自愈体系）；
- **移动端熄屏与后台保活自愈**：接入 `visibilitychange` 与 `Screen Wake Lock API`，杜绝手机切屏或熄屏后连接假死，网络恢复毫秒级自愈对齐；
- **微型 Transport HUD**：移动端状态栏集成赛博光效网络指示器，实时显示链路类型（Direct 直连 / Relay 中继 / Offline 离线）与往返延时。

#### 2. 零信任军工级安全与纯净身份治理 (Zero-Trust Security & Pure Identity)
- **端到端加密与防篡改**：ECDH (P-256) 临时密钥协商 + HKDF-SHA256 派生会话密钥 + AES-256-GCM 全程加密；报文携带 HMAC-SHA256 签名与 Nonce LRU 防重放过滤；
- **4 位短认证码 (SAS) 与 TOFU 资产信任**：设备互联核验 4 位动态安全指纹码，首次配对自动录入信任库；彻底消除了备用主机伪弹窗、幽灵信令与握手超时死锁；
- **确定性身份模型与断网数据平滑合并**：彻底铲除伪造与幽灵用户，建立基于确定性 UUID 的用户身份体系；上线账号平滑合并协议（`/api/users/merge`），即便断网离线也能完整保全历史打分归属；
- **Host 全局权限与人性化呈现**：Host 领队主机具备全场数据最高管理权限（可查看、修改与删除任何队员提交的记录）；普通队员维护自身记录权限；历史记录页面彻底移除内部底层 UUID 暴露，全面平滑呈现清晰的 Scouter 用户名。

#### 3. 极致人机工效与赛场盲操打分 (Mobile Ergonomics & Match Scouting)
- **5 阶段沉浸式向导表单 (MobilePhaseWizardForm)**：单手即可流畅自如推进比赛阶段，触控热区严格遵循 44px 黄金防误触标准；
- **全新统一 Cycle 轮次急速盲操打分**：独立解耦的 Auto 与 TeleOp 轮次计数器，支持卡片增量累加（0➔1➔2➔3➔4）与数字药丸直选；搭载折叠式瀑布流时间轴，新增轮次平滑自动触底，历史回看防突兀跳屏；
- **展位底册联动自动补全**：打分表单联动 Pit 展位档案底册，输入队伍编号即刻自动联想补全队伍基本信息与红蓝阵营；
- **移动端扫码专属通道**：优化手机端扫码入场交互，彻底移除对于普通打分队员无意义的局域网/IPv6/防火墙等冗余提示。

#### 4. 本地化高质中文字体与赛博拟态美学 (Typography & Cyber Glassmorphism)
- **内置 Google Fonts Noto Sans SC 变量字体**：本地化集成 `NotoSansSC-VariableFont_wght.ttf`（覆盖 100~900 字重），客户端离线内置，彻底攻克 Windows 与各类手机高分屏下中文小字、表单标签、徽章与按钮字形模糊与边缘毛刺难题；
- **全链路中英双语国际化 100% 覆盖**：深度盘查并对齐 `zh.json` 与 `en.json`，实现 1100+ 词条 1:1 零遗漏覆盖，全面支持动态变量插值与 CSV 导出本地化；
- **统一暗黑赛博玻璃拟态**：全站彻底告别浏览器原生割裂弹窗，统一采用具备危险 (Danger)、警告 (Warning)、信息 (Info) 三级视觉梯度的专属响应式对话框系统。

#### 5. 展位技术摸底、智能排班与深度战术分析 (Pit, Scheduling & Strategy)
- **量化展位侦察 (Pit Scouting)**：底盘构型、升降取放、发射器、分选、悬挂与里程计方案全维度建档；支持离线 IndexedDB 高清照片队列与 WebP 渐进式断点续传；
- **4 机位智能排班与实时推送**：赛程矩阵支持批量排班与留空；保存后实时向队员手机触发震动与任务推送，手机端一键载入对阵信息杜绝现场错录；
- **独创“吹牛指数”算法与常规赛留力特赦**：自述得分与实战表现多维交叉对账，智能点亮【常规赛留力特赦 🛡️】避免误伤保留实力的王牌盟友；
- **双主机互斥热备与全量交接架构**：分布式 Epoch + 设备 ID 确定性 Tie-Breaker 彻底杜绝脑裂死锁；2000ms 接管暂存门闸（Takeover Staging Gate）确保交接期间发包零乱序、零丢失；
- **FTC 官方 API 深度打通**：一键同步官方赛程，智能剥离对手技术犯规罚分，还原机器人真实纯进攻得分；
- **战术 AI 军师助手**：支持 Google Gemini 与 OpenAI 大模型，自动注入全场战况与队伍档案，流式输出淘汰赛挑选策略与针对性防守方案，点击战队编号即刻滑出档案卡片。

#### 6. 严谨工程验证与自动化套件 (Rigorous Verification)
- **证据三要素全绿灯交付**：
  - 前端 Vitest 单元与组件测试：**73 套件 / 562 项测试 100% 通过**；
  - 后端 Maven Surefire 测试：**136 项测试 100% 通过**；
  - 全链路多浏览器并发攻防演练（E2E）全阶段通过；
- **SimulateScouting 现代化重构**：全面适配确定性身份架构与高并发对齐机制，支持赛前高压模拟演练。

---

### 📦 获取与安装 (Download & Access)

- **📱 移动端在线版 (PWA)**：无需安装任何应用，手机浏览器直接访问：  
  👉 **https://lucalmz.github.io/ScoutingPro27/**  
  *(亦可在手机主屏幕直接添加为桌面应用离线使用)*
- **💻 桌面端领队客户端 (Windows / macOS)**：  
  - Windows 原生安装程序：**`ScoutingPro27-windows-1.0.1.msi`** (已挂载至本 Release 附件)
  - macOS (Apple Silicon arm64) 原生镜像：**`ScoutingPro27-mac-arm64-1.0.1.dmg`** (已挂载至本 Release 附件)

---

<p align="center">
  <b>Designed & Built with ❤️ by FTC Team 27570 B.E.A.R.</b><br/>
  <i>Empowering Every Robot Alliance with Next-Gen Distributed Intelligence.</i>
</p>
