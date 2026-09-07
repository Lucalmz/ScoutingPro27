# ScoutingPro27 🚀

<p align="left">
  <img src="https://img.shields.io/badge/Vue.js_3-35495E?style=for-the-badge&logo=vue.js&logoColor=4FC08D" alt="Vue.js" />
  <img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Java_21-ED8B00?style=for-the-badge&logo=openjdk&logoColor=white" alt="Java" />
  <img src="https://img.shields.io/badge/Javalin_7-009688?style=for-the-badge&logo=fastapi&logoColor=white" alt="Javalin" />
  <img src="https://img.shields.io/badge/WebRTC-333333?style=for-the-badge&logo=webrtc&logoColor=white" alt="WebRTC" />
  <img src="https://img.shields.io/badge/MQTT-660066?style=for-the-badge&logo=mqtt&logoColor=white" alt="MQTT" />
  <img src="https://img.shields.io/badge/H2_Database-003545?style=for-the-badge&logo=databricks&logoColor=white" alt="H2 Database" />
  <img src="https://img.shields.io/badge/JCEF_Desktop-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="JCEF" />
</p>

**ScoutingPro27** 是一款专为 **FIRST Tech Challenge (FTC)** 机器人赛事打造的**离线优先、去中心化分布式赛事侦察、赛程排班与战力智能分析桌面/移动协同系统**。

在赛场极其恶劣的网络条件（Wi-Fi 严重干扰、移动网络对称 NAT 隔离、基站限流）下，系统基于本地嵌入式 H2 数据库与 WebRTC 点对点直连技术，为车队提供毫秒级多端增量同步、量化展位侦察 (Pit Scouting)、智能排班指派、基于官方成绩的队伍“吹牛指数”对账分析，以及搭载流式 SSE 的战术 AI 助手。

无需自建云端服务器、无需部署 Docker，双击即可在单机或多设备局域网/互联网中即时组网运行。

---

## 🌟 核心功能矩阵 (Features)

### 1. 离线优先的多端协同组网
- **无公网依赖**：数据完整驻留本地嵌入式 H2 数据库中。设备间通过 WebRTC DataChannel 点对点直连，网络中断时本地全功能运行，网络恢复后毫秒级增量双向同步。
- **移动端扫码秒级接入**：Host 主机一键生成携带内网 IP 的动态二维码，手机端侦察员无需下载任何客户端，微信/系统相机扫码即以 Web 端无缝接入。

### 2. 赛事赛程与侦察员智能排班 (Match Schedule & Assignments)
- **赛程导入与管理**：支持从 FTC 官方 API 一键同步或自定义导入资格赛/淘汰赛赛程，自动解析红一/红二/蓝一/蓝二联盟战队。
- **动态排班工作台**：支持为每场比赛的 4 个工位灵活指派侦察员；支持持久“留空”模式，排班变动实时通过 WebRTC 广播同步到所有侦察员屏幕。

### 3. 量化展位侦察与特写照片系统 (Quantified Pit Scouting & Photos)
- **标准量化自述指标**：细致记录各战队底盘构型（麦轮/全向/西海岸）、机械臂结构、悬挂类型、测距传感器配置，以及自主、手动、终局各阶段量化自述指标。
- **分层混合照片资产管理**：电脑端直接流式落盘到本地磁盘，手机端采用 IndexedDB 异步队列缓冲，支持弱网环境下的断点续传与静默批量回传。

### 4. 战力天梯榜与“吹牛指数”量化对账 (Brag Index Analytics)
- **吹牛指数 (Brag Index) 算法**：将战队在 Pit 展位填报的“自述数据”与天梯赛实际得分进行多维动态对账，自动划分【真实守信 🎯】、【略偏乐观 🟡】、【夸大其词 ⚠️】与【吹破牛皮 🔥】四档，并内置“高悬挂留力”特赦核验机制。
- **官方数据交叉验证**：直连 FTC 官方数据平台核实战队真实表现，侦察员历史误报率超过 20% 时自动启动可信度降权防线。

### 5. 零信任 P2P 安全加固与防篡改体系
- **ECDH 密钥协商与 4 位短认证码 (SAS)**：WebRTC 建联时双方自动生成临时公私钥并推导共享密钥，生成 4 位可视短认证码防范中间人攻击（MITM）。
- **TOFU (Trust-On-First-Use) 设备资产信任**：首次连接设备自动建档存入 IndexedDB，后续连接自动认证；遇到公钥突变（重装或冒充）时触发高危告警阻断。
- **会话防篡改与接管仲裁**：防范冒充他人 ID 提交记录；同名登录自动建议重命名，同用户跨设备登录支持授权接管与 30s 冷却超时防抖。

### 6. 流式赛事战术 AI 助手 2.0 (Tactical AI Engine)
- **双引擎多模型支持**：原生适配 Google Gemini 与 OpenAI 系模型，密钥本地 AES-256 对称加密安全存储。
- **全赛事实时数据注入**：动态提取当前赛事排位、战队自述、历史战绩与标签作为 Context 注入 Prompt。
- **SSE 流式打字机与心跳保活**：基于 Server-Sent Events 实现流式输出，内置 15s 后端心跳守护；支持 Markdown 表格渲染与战队编号正则捕获（点击战队编号即刻拉起战队详尽档案抽屉）。

---

## 🛠️ 架构蓝图与运行原理 (Architecture & Working Principles)

```
+-----------------------------------------------------------------------------------+
|                               ScoutingPro27 协同拓扑                               |
+-----------------------------------------------------------------------------------+
                                        |
                 [公共信令通道 (MQTT over WSS - broker.emqx.io)]
                                        |
    +-----------------------------------+-----------------------------------+
    |                                                                       |
    v                                                                       v
+-----------------------+        WebRTC P2P DataChannel         +-----------------------+
|   Host 节点 (电脑端)   |<====================================>|  Scout 节点 (手机/PC)  |
|                       |  • ECDH 共享密钥加密信令                 |                       |
|  • JCEF 原生桌面容器   |  • 4位 SAS 短认证码 / TOFU 设备信任    |  • 移动端浏览器 / JCEF |
|  • Javalin 7 本地服务 |  • 全局 hostSeq 增量版本同步游标       |  • IndexedDB 离线队列 |
|  • H2 嵌入式关系数据库 |  • 赛程 / 排班 / 展位侦察即时广播      |  • 本地 Pinia 反应式  |
|  • 本地磁盘特写照片库  |  • 背压感知 (DataChannelSender)       |  • 增量请求 (sinceSeq)|
+-----------------------+                                       +-----------------------+
```

---

## 💡 六大核心技术亮点与运行逻辑原理

### 亮点一：分布式逻辑时钟与增量同步机制 (Host Monotonic Sequence)
- **运行逻辑**：摒弃跨设备本地时钟极易偏差（时区、设备时间不准）的时间戳同步方案，改由 Host 统一下发全局严格单调递增的逻辑游标 `hostSeq`。
- **断线增量补偿**：从机本地持久化记录上次确认的 `lastHostSeq`。网络重连后，Client 只需发起 `REQUEST_SYNC(sinceVersion = lastHostSeq)`，Host 仅检索过滤出 `hostSeq > sinceVersion` 的增量记录，单次同步数据量从全量几百 KB 骤降至几 KB，保障弱网秒级恢复。
- **防覆灭三向合并 (3-Way Guarded Merge)**：客户端页面刷新（F5）或后端重启时，通过 `records.ts` 执行内存、LocalStorage 与后端查询的三向合并，确保高版本内存记录绝不被空库或旧库冲掉。

### 亮点二：零信任 P2P 通信与 SAS / TOFU 安全矩阵
- **ECDH 密钥协商**：两端初始化时通过 Web Crypto API 动态生成椭圆曲线临时密钥对（ECDH P-256），信令传输使用协商后的 AES-GCM 密钥加密。
- **短认证码 (SAS Fingerprint)**：双方依据各自公钥与赛事邀请码哈希衍生 4 位 16 进制指纹码（如 `6EEF-550C`）。侦察员在赛场现场目测核对即可物理阻断信令劫持与中间人嗅探。
- **TOFU 信任持久化**：设备首次配对后自动将设备指纹存入 IndexedDB（`identityStore.ts`）。再次建联时比对历史指纹自动放行；一旦检测到公钥突变（Key Flapping），系统立即冻结 DataChannel 消息收发，阻断未授权接入。

### 亮点三：自愈型 ICE 穿透与看门狗降级 (Self-Healing ICE Watchdog)
- **穿透梯度机制**：ICE 优先探测局域网直连（host candidate）→ 公网 STUN 反射（srflx candidate）→ TURN 中继（relay candidate）。
- **智能看门狗计时器**：
  - 若连接处于 `checking` 状态超过 3.5 秒，触发网络抖动提示；
  - 停滞超过 5.5 秒，自动触发 `pc.restartIce()` 进行备用地址重协商（支持最多 2 次重启）；
  - 若 2 次尝试后仍受阻（赛场高对称 NAT 拦截 UDP 报文），看门狗主动销毁当前连接，直接注入 `iceTransportPolicy: 'relay'` 强制启用 Metered.ca TURN 中继建立链路，实现极端网络下的自愈建联。

### 亮点四：分层混合持久化存储架构 (Hybrid Persistence Layer)
- **电脑 Host 端**：依托 Java 21 原生进程运行内嵌式 **H2 数据库**（开启 `AUTO_SERVER=TRUE` 模式），搭配 Jdbi 3 处理高吞吐并发事务；展位大图采用 WebP 压缩后直接流式存储在电脑物理磁盘中，利用 HTTP 强缓存（`Cache-Control: immutable`）实现零内存损耗加载。
- **移动 Scout 端**：浏览器环境通过封装的 **IndexedDB**（`indexedDb.ts` 与 `mobilePhotoCache.ts`）维护离线照片缓冲队列；业务数据通过防抖监听持久化于 `localStorage`，并在网络畅通时静默回传电脑主机。

### 亮点五：“吹牛指数”动态对账与高悬挂特赦算法 (Brag Index)
- **量化对账模型**：战队在 Pit 填报的自述总分、自主分、手动分与实际排位赛的平均分及最高分进行动态比对：
  $$\text{OverallRatio} = \frac{\text{ClaimedTotalScore}}{\max(\text{MaxActualScore}, \text{AvgActualScore} \times 1.05, 1)}$$
- **高悬挂机构特赦机制 (High-Hang Pardon Rule)**：针对 FTC 机器人高悬挂装置在常规赛中“结构复位极其繁琐、战队选择留力”的工程实际，算法设定：
  1. 只要战队在任意一场实际比赛中展现过高悬挂能力（终局得分 $\ge 15$ 分），即铁证如山，直接点亮【高杠已证实 🧗】；
  2. 若打满 $\ge 2$ 场仍未挂出，系统判定为常规赛留力，自动予以【特赦免责】，不直接扣除信誉分，避免算法脱离赛事实情。

### 亮点六：流式 SSE 战术 AI 助手与赛事上下文智能融合
- **服务端事件流 (SSE)**：基于 Javalin 异步上下文与 HTTP 响应流，配合后端单线程定时调度器每 15 秒输出 `: heartbeat\n\n` 保持连接，彻底解决移动端弱网或长耗时推理导致的连接中断。
- **智能滑动窗口 (Sliding Window)**：采用 `MAX_CONTEXT_MESSAGES = 10` 对历史轮次进行动态修剪，避免 Token 爆炸与超长计费。
- **实体高亮联动**：前端 Markdown 渲染引擎配合自定义正则捕获模型返回的战队编号（如 `#27570` 或 `Team 25787`），自动渲染为可交互战队芯片，点击即刻通过 Pinia 状态树滑出该战队的综合能力抽屉。

---

## 💻 快速开始与运行指南 (Getting Started)

### 环境要求
- **后端运行**：JDK 21+，Maven 3.8+
- **前端开发**：Node.js 18+，npm 9+
- **网络环境**：用于设备发现与信令交换的互联网络（赛场内网可连接外网 MQTT 即可）

### 方式一：开发调试模式 (前后端独立启动)

1. **后端启动 (Javalin REST + H2)**
   ```powershell
   cd Backend
   mvn clean compile exec:java -Dexec.mainClass="com.bear27570.app.Main" -Dexec.args="--headless --port=8080"
   ```
   > 提示：`--headless` 参数会跳过 JCEF 桌面窗口，仅启动后台 RESTful 接口与嵌入式 H2 数据库。

2. **前端启动 (Vite Dev Server)**
   ```powershell
   cd frontend
   npm install
   npm run dev
   ```
   浏览器访问 `http://localhost:5173` 即可进入系统。

### 方式二：生产桌面一体化模式 (JCEF 独立桌面程序)

1. **构建前端产物**
   ```powershell
   cd frontend
   npm run build
   ```
   构建产物将自动输出至 `Backend/src/main/resources/public`。

2. **编译打包后端可执行 JAR**
   ```powershell
   cd ../Backend
   mvn clean package -DskipTests
   ```

3. **双击运行桌面应用**
   ```powershell
   java -jar target/ScoutingPro27-1.0-SNAPSHOT.jar
   ```
   系统将自动完成数据库 Flyway 迁移、加载 JCEF 原生 Chromium 渲染内核并淡入主界面。

### 方式三：赛场现场单机多开演练 (Multi-Client Simulation)
系统原生支持单台电脑同时启动多个实例（1 个 Host 房间端 + 多个 Scout 客户端）：
- **端口冲突自愈**：当默认 8080 端口被占用时，后续实例会自动按 8081 -> 动态空闲随机端口降级启动；
- **JCEF 缓存隔离**：每个进程分配独立的 `scoutingpro-jcef-<uuid>` 临时缓存目录，杜绝 Chromium 多进程排他锁死；
- **H2 数据库并发代理**：基于 `AUTO_SERVER=TRUE`，首个进程启动嵌入式引擎，后续实例自动通过 TCP 代理并发读写。

---

## ⚙️ 核心配置与环境变量

| 配置项 / 变量名 | 默认值 | 作用说明 |
|---|---|---|
| `DEV_PORT` / `--port=N` | `8080` | 指定本地 Javalin 服务监听端口 |
| `SCOUTING_ENV` / `app.env` | `DEV` / `PROD` | 运行环境标识；开发环境下数据存放在 `app_data/`，生产环境下统一存放在 `~/.scoutingpro27/` |
| `DB_URL` | 自动解析 | 自定义 H2 数据库 JDBC 连接字符串 |
| `ENABLE_TEST_CLEANUP` | `false` | 是否开启集成测试数据重置接口 (`/api/test/cleanup`) |

---

## 🧪 测试与质量保障 (Verification & Testing)

项目遵循严格的**证据闭环与全链路验证铁律**：

```powershell
# 1. 运行后端完整单测 (77 项单测全部绿灯)
cd Backend
mvn test

# 2. 运行前端 Vitest 单元与组件测试 (231 项单测全部通过)
cd ../frontend
npm test -- --run

# 3. 运行前端 TypeScript 静态编译与强类型检查
npm run type-check

# 4. 运行 Puppeteer 端到端多端并发模拟测试
node e2e/multi-client.test.js
```

配套的 **`MANUAL_TESTING_CHECKLIST.md`** 详细列出了真实比赛前必须执行的 10 项物理环境人工验收清单（包括真实 4G/5G 移动蜂窝网络下的 TURN 中继穿透、手机扫码离线拍照与静默回传、高悬挂对账特赦判定等）。

---

## ⚠️ 已知限制与使用建议

1. **信令与 TURN 免费额度**：MQTT broker (`broker.emqx.io`) 与 Metered.ca TURN 中继属于公共服务，重度使用需关注流量配额，正式比赛建议车队自建小型 MQTT/TURN 节点。
2. **NAT 穿透边界**：STUN 直连取决于赛场局域网与运营商 NAT 类型（对称型 NAT 需依靠 TURN 中继兜底）。
3. **正式比赛前建议**：在比赛前一天，使用物理隔离的双手机移动热点与电脑进行一次实操演练，确认 TURN 链路畅通。

---

## 🎨 视觉与设计资产

- 应用内图标：**Google Material Icons**
- 视觉排版字体：**Manrope** & **Orbitron**

---

> *Crafted with ❤️ by FTC Team 27570 B.E.A.R. & 25787 TechBY*
