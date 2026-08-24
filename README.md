# ScoutingPro27 🚀

<p align="left">
  <img src="https://img.shields.io/badge/Vue.js-35495E?style=for-the-badge&logo=vue.js&logoColor=4FC08D" alt="Vue.js" />
  <img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Java-ED8B00?style=for-the-badge&logo=openjdk&logoColor=white" alt="Java" />
  <img src="https://img.shields.io/badge/WebRTC-333333?style=for-the-badge&logo=webrtc&logoColor=white" alt="WebRTC" />
  <img src="https://img.shields.io/badge/MQTT-660066?style=for-the-badge&logo=mqtt&logoColor=white" alt="MQTT" />
  <img src="https://img.shields.io/badge/H2_Database-003545?style=for-the-badge&logo=databricks&logoColor=white" alt="H2 Database" />
</p>

ScoutingPro27 是一款专为 FIRST Tech Challenge (FTC) 打造的离线优先赛事侦察与数据分析桌面应用，目标是在赛场网络条件不稳定的环境下，为车队提供可靠的数据同步与队伍战力分析。

数据完全存储在本地（内嵌 H2 数据库），设备之间通过 WebRTC 建立点对点连接同步数据。这意味着不需要自建或租用后端服务器、不需要 Docker，双击启动即可使用。**但请注意**：设备发现和 NAT 穿透依赖公共的免费信令服务（MQTT broker）和免费额度的 TURN 中继服务，这两者本身是外部第三方服务，存在限流或服务变更的可能——详见下方「已知限制」一节。

## 🌟 主要功能 (Features)

- **多端离线协作**：赛事现场无网/弱网时本地缓存侦察数据，网络恢复后自动双向同步（含断线自动重连，见下）。
- **智能化表单录入**：支持单机或双机侦察模式，提供防重录入、自增运算等输入校验。
- **动态能力排行榜**：基于历史数据计算队伍得分能力，附带战力走势分析（`↗` / `➡` / `↘`）。
- **赛事内网即时通讯**：Host 与 Scout 可通过点对点连接进行文字通讯与任务分发。
- **官方数据一键比对**：接入 FTC 官方数据源核对成绩，自动剔除赛场违规得分。
- **冲突检测与解决**：多人对同一场次/队伍重复提交数据时自动标记冲突，双方可各自修正，无需人工仲裁谁对谁错。

---

## 核心技术架构

### 1. WebRTC + MQTT 信令 + STUN/TURN 三级穿透

设备之间的数据同步走 WebRTC DataChannel 点对点连接，具体流程：

- **信令交换**：通过公共的 `broker.emqx.io` (MQTT over WebSocket) 交换 SDP offer/answer 和 ICE candidate，用邀请码的 SHA-256 哈希生成唯一 topic，避免不同房间之间串消息。
- **连接建立优先级**：ICE 协议会按顺序自动尝试局域网直连（host candidate）→ 公网 STUN 反射直连（srflx candidate）→ TURN 中继（relay candidate）。前两者失败时才会退化到 TURN，这也是目前唯一能保证赛场上不同网络环境（尤其是移动网络下常见的对称 NAT）都能连上的兜底方案。
- **拓扑**：以 Host 为中心的星状拓扑，任意一端提交/修改数据都会被广播给其他所有已连接的端。

### 2. 断线自动恢复

赛场网络抖动是常态，为此实现了两层机制：

- **快速感知**：ICE 连接出现异常时，UI 会立即给出「网络不稳定」的提示，而不必等到彻底判定离线；同时区分「Host 主动退出」（通过信令主动广播，客户端可秒级感知）和「Host 异常掉线」（依赖标准的 ICE 超时判定，通常需要数秒到十几秒）。
- **指数退避重连**：客户端断线后按 1s、2s、4s...最多 6 次尝试重新建立连接，达到上限后进入明确的长时间离线状态，避免无意义的持续重试消耗电量和网络请求。断线期间用于信令交换的 MQTT 连接保持存活，一旦 Host 恢复上线会主动广播通知，客户端可以立即重连，不必等待重试计时器。

### 3. 离线数据持久化

所有数据先写入内存与 `localStorage`（防抖写入，避免频繁 IO），并处理了以下几种真实会发生的边界情况：读取时数据损坏的容错、写入超限（QuotaExceeded）时的用户可见提示、页面关闭前的强制落盘（`beforeunload`）、以及多标签页打开同一应用时的数据同步。

### 4. 冲突检测机制

当多人对同一场次/队伍提交了不同的记录（比如两人都记了同一场同一队），系统不会武断地丢弃或覆盖任何一方的数据，而是把所有版本都保留下来并标记为冲突状态，提示相关人员各自核实修正。任意一方修正后，只要冲突双方的数据重新一致，冲突标记会自动解除并广播给所有端 —— 不需要 Host 手动裁决。

### 5. 侦察员数据可信度加权

系统会将每位 Scout 提交的成绩单与 `api.ftcscout.org` 的官方比赛成绩做比对。当某位侦察员的历史平均误差率超过 20%，其后续提交的数据在计算队伍综合评分时权重减半（0.5），以降低偶发误记录对整体数据的影响。

### 6. 幂等的数据合并

后端使用 H2 的 `MERGE INTO` 语句处理数据的插入/更新合并，并用子查询保证一条记录不管经历多少次断线重传或多端覆盖写入，其最初的 `created_at` 时间戳都不会被后续写入覆盖。

### 7. 桌面端封装 (JCEF)

桌面端使用 JCEF (Java Chromium Embedded Framework) 在 Java 进程中承载前端页面渲染，避免了 Electron 自带 Node.js 运行时的额外内存开销。多开实例时通过为每个实例分配独立的临时用户数据目录，避免 Chromium 底层对共享 `user_data_path` 的多进程锁死限制。

### 8. 端到端多端测试

针对 WebRTC 这类分布式实时同步逻辑，单元测试难以覆盖真实的多端交互场景，因此项目额外维护了一套基于 Puppeteer 的端到端测试（`e2e/multi-client.test.js`），模拟 Host + 2 个 Client 的完整交互流程：

- **多端并发场景**：三个独立浏览器实例并行连接同一房间，验证信令与连接建立在多端并发下的正确性（这类问题在两端场景下往往测不出来，比如曾经出现过的 ICE candidate 跨客户端串扰问题）。
- **强制 TURN 中继验证**：可通过注入 `iceTransportPolicy: 'relay'` 强制跳过局域网/STUN 直连，专门验证 TURN 兜底链路本身是否可用，避免因为测试机器本身在同一网络下走了直连而误判「TURN 没问题」。
- **真实断网模拟**：使用 CDP 网络条件模拟断线场景（并针对 WebRTC 层不受 HTTP 网络模拟约束的特性做了专门处理），验证断线检测、自动重连、以及重连后的数据补偿与冲突自动解除是否符合预期。
- **构建产物一致性保护**：测试执行前会自动触发前后端构建（`npm run build` + `mvn package`），避免出现「改了源码但测试跑的仍是旧编译产物」这类难以察觉的假阳性结果。
- **跨平台与资源清理**：测试脚本处理了 Windows/Unix 下子进程管理的差异，并确保浏览器实例与后端进程在测试结束（无论成功或失败）后都被彻底清理，避免残留进程导致下次运行端口冲突。

配套的 `MANUAL_TESTING_CHECKLIST.md` 补充了自动化测试无法覆盖的场景，例如真实移动网络下（非同一局域网）的 TURN 穿透实测、多方同时冲突的解决验证等，正式比赛前按清单人工过一遍，确保场上不出意外。

### 9. 现代化的 UI 交互体验 (View Transitions API & 3D Hover)

为了提供桌面级原生的极佳质感，前端页面进行了深度的视觉与交互定制：

- **View Transitions 空间动画**：深入应用原生 View Transitions API，在页面切换时提供各个页面模块的定制飞行轨迹（如表格上浮、顶部栏下滑、侧边栏飞入等）。结合 Shared Element 机制，实现了卡片大标题在进入和退出页面时的无缝缩放与形态变换（Morphing）。
- **Same-Document 方向性滑动**：在赛事内部的 Tab 切换中，使用带有动态控制方向的 View Transitions 实现原生级别滑动（向右点则内容右侧推入，反之左侧推入）。针对高频快速点击的极端边缘情况（Edge Cases），设计了 `skipTransition()` 动画并发中断与保底降级的容错机制，确保 UI 状态永不卡死。
- **光标感知边缘高光**：主面板中的赛事卡片可通过监听鼠标相对位置，在距离鼠标最近的边框位置呈现精致柔和的白色高光过渡（Spotlight Border），提供内敛现代的桌面级微交互质感。

### 10. 全局一致性的增量同步机制 (Incremental Sync)

针对大规模数据和弱网环境，从原先低效的全量推送升级为基于逻辑时钟的增量同步：

- **Host 全局单调序列**：摒弃了跨时区、跨设备极易出错的本地时间戳，改由 Host 统一下发全局唯一且单调递增的 `hostSeq` 作为同步游标。
- **持久化与断线恢复**：增量游标深度整合至 Java 后端 (H2 数据库) 及前端 `localStorage`。Client 重连时只需声明自身的 `lastHostSeq`，Host 即可精准过滤并仅下发增量记录，大幅节约了弱网环境下的带宽。
- **基于 Version 的 LWW 冲突解决**：在记录级别引入严格自增的 `version` 字段，替代时间戳解决分布式环境下的并发写冲突，并由后端 `GREATEST` 机制兜底，确保多客户端与主机之间数据最终一致。

---

## ⚠️ 已知限制

- **信令与 TURN 均为第三方免费服务**：MQTT broker 和 TURN（Metered.ca）都是公共免费额度，存在被限流、服务变更或临时不可用的可能。TURN 免费额度按流量计费，重度使用（比如整场比赛大量设备长时间在线）需要自行关注实际消耗，必要时升级到付费额度或替换为自建服务。
- **NAT 穿透效果因网络环境而异**：STUN 直连能否成功取决于当天设备所在网络的 NAT 类型，无法在代码层面保证 100% 直连成功；TURN 中继是兜底手段，不是首选路径。
- **`beforeunload` 在移动端浏览器上不完全可靠**：如果 Host 固定运行在桌面端，这个限制影响有限；但如果参与设备包含移动端浏览器访问场景，「主动离开广播」这一优化在移动端可能不会稳定触发，此时会退化为依赖标准 ICE 超时判定。
- 建议在正式比赛前，使用真实的、彼此物理隔离的移动网络环境（而非同一局域网）做一次实机连接测试，确认 TURN 兜底和断线重连在真实条件下工作正常。

---

## 🎨 设计与视觉资产

应用内图标均使用 **Google Material Icons**。

---

> *Powered by 27570 B.E.A.R. and 25787 TechBY*
