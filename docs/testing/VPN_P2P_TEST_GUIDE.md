# ScoutingPro27 手机端 VPN 开启/关闭 P2P 连通性真机测试指南

本指南用于真机验证手机客户端在 **VPN 关闭** 与 **VPN 开启**（如 Clash Meta `VpnService` 重写源地址/端口、禁用 IPv6、Fake-IP TUN 等）场景下的 **直连 P2P 打洞**、**Host 端可选路由器 UPnP/IPv6 Pinhole (`50000-50009/UDP`) 辅助开孔（JCEF `webrtc.udp_port_range=50000-50099`）**、**`VirtualDataChannel`（零 TURN 配额的 `ECDH 加密通道` / `ECDH Tunnel (TLS)`，`wss/tls`）兜底**、**Metered TURN (`attempt >= 3`) 严格最后保底** 以及 **`[WebRTC:IceStats]` 诊断采集**。

> **架构优先级（直连优先、零配额保护 TURN）**：
> `1. Direct P2P（IPv6 直连 / LAN 直连 / IPv4 STUN 打洞；常规家庭路由器依赖 RFC 8445 出站 STUN + RFC 6092 有状态防火墙即可直连，无需路由器启用 UPnP/NAT-PMP/PCP 或静态 IPv6 入站规则）` -> `2. MQTT VirtualDataChannel（ECDH 端到端加密 TLS 隧道，零 TURN 流量消耗）` -> `3. Metered TURN 中继（仅当 Direct 与 VirtualDataChannel 均不可用、attempt >= 3 或显式 forceRelay 时作为严格最后保底，默认优先单一 turns:443/tcp）`

---

## 1. 测试前提

1. **桌面 Host 端**：
   - 已构建并运行最新版 ScoutingPro27 桌面端（同时包含 `backend` 与重新构建嵌入的 `frontend`）。
   - 启动时桌面端会自动：
     - 将 JCEF `libwebrtc` UDP 端口范围设置为 **`50000-50099`**（共 100 个端口，支持 10+ 并发 Scout 客户端，对应 `CefRequestContext` preference: `webrtc.udp_port_range`）。
     - 在**真实物理网卡**（自动排除 `198.18.0.1` Clash TUN、WARP、WSL、VMware 等虚拟网卡）上以受限预算（12 秒总预算、超时快速失败）异步探测可选路由器 UPnP IGDv1/IGDv2（仅在 IPv6 控制端点可达时启用 `WANIPv6FirewallControl:1`）、NAT-PMP 与 PCP，仅为 `50000-50009/UDP` 申请短租约映射（`<= 600s`，周期续租，退出限时清理 `unmapPort`），并结合物理网卡 STUN `srflx` 检测路由器 WAN 是否为真公网 IPv4 / CGNAT / 双重 NAT。
     - **注意（R1 事实核查）**：在标准家庭宽带 / 移动蜂窝 IPv6（如 2409/240e/2408）环境下，即使路由器（如 SK-D847N）关闭 UPnP / NAT-PMP / PCP 或未配置静态 IPv6 入站防火墙规则，只要双方同时发起出站 UDP STUN 检查即可触发 RFC 6092 有状态防火墙放行并实现 `ipv6_p2p` 直连（实测日志中 VPN 关闭时 2.6 秒直接打通 `ipv6_p2p`）。端口映射仅作为对称 NAT / 严格防火墙下的可选辅助，非直连前置条件。
2. **手机 Client 端**：
   - Android Chrome（推荐 ≥ 123，支持 `RTCIceCandidate.url` 与远程 DevTools）或 iOS Safari（WebKit），访问 Host 对应的 HTTPS/PWA 地址。
3. **零额外操作约束验证**：
   - 测试过程中 **禁止** 在手机 VPN 中手动添加分应用绕过（Split-Tunnel/Bypass）或手动配置路由器端口转发，也 **无需** 修改任何应用内开关。
4. **日志准备**：
   - 记录本次测试开始时间，便于对照 Host 端 `log/scoutingpro_<日期>.log`、`app_data/jcef_profile/chrome_debug.log` 与手机导出诊断报告。

---

## 2. 测试步骤

### 场景 A：VPN 关闭（基准对照，验证不退化为中继）

1. 确保手机系统 VPN **完全关闭**（Wi-Fi 或蜂窝网络）。
2. 打开手机端 PWA，扫码或输入邀请码加入 Host 房间。
3. 观察状态栏（移动端悬浮胶囊 `MobileStatusPill` 或 `ConnectionStatus`）：
   - 预期在 **1~3 秒** 内进入「已连接（Connected）」。
   - 点击状态胶囊展开 HUD 详情，传输标签应为 **IPv6 直连**、**局域网直连** 或 **IPv4 打洞**（不得走 TURN 中继）。
4. 触发一笔实际业务操作（如同步赛程或发送一条直连消息），确认 Host 与手机双方收发正常。

### 场景 B：VPN 开启（核心验证：Host 主动开孔接收 VPN `prflx` 直连 + 兜底链路）

建议分别测试以下真实手机 VPN 模式（无需修改 VPN 内部策略）：
- **模式 B1**：常规代理/TUN VPN（如 Clash Meta `VpnService`，可能对直连 UDP 做 NAT 端口重写、开启 Fake-IP、禁用 IPv6 路由）。
- **模式 B2**：严格/全局 VPN（如 Android「始终开启 VPN / 阻止未使用 VPN 的连接」，或外层存在 ISP CGNAT / 完全丢弃直连 UDP 的网络）。

操作步骤：
1. 开启手机 VPN，确认手机端可正常访问公网 HTTPS 页面。
2. 彻底刷新/重开手机端 PWA，重新加入 Host 房间，记录建连耗时。
3. 观察预期结果：
   - **若 Host 路由器支持 UPnP/PCP/NAT-PMP 且具备可直达路径（真公网 IPv4 或 IPv6 Pinhole 放行）**：手机透过 VPN 发出的 UDP 包在 Host 端生成 **`prflx`** 候选并直接打通，状态展示直连标签（`IPv4 打洞` / `IPv6 直连`）。
   - **若底层 UDP 仍被 ISP CGNAT / 对称型移动代理彻底阻断**：
     - 若 `< 3.8s` 发生 `ice_failed` 且存在共享密钥与 `hostSenderId`（或到达 `3.8s` 兜底超时），系统**立即**激活 `VirtualDataChannel`（`ECDH 加密通道` / `ECDH Tunnel (TLS)`，`wss/tls`），快速进入 `connected` 并完成 `SCHEDULE_FULL_SYNC`，**不会**陷入 `< 3.8s` 重连循环。
     - 后台探针（`+20s -> +40s -> ... -> 300s`）与静默升级保持 **`allowTurn: false`**（STUN/直连优先），避免无谓消耗 TURN 配额；仅当标准 ICE 重试达到 **`attempt >= 3`** 或用户/策略显式 `forceRelay` 时才启用 `turns:global.relay.metered.ca:443?transport=tcp` 作为最后保底。
4. 若测试完成并关闭桌面 Host 端，确认日志出现 `[PortForwarding] Shutdown complete: unmapped ...` 且无残留端口映射。

---

## 3. 如何导出手机端与桌面端日志

### 3.1 应用内一键导出 `[WebRTC:IceStats]` 诊断报告（无需开启 `ENABLE_DIAGNOSTICS`）

即使生产构建中 `frontend/src/config/features.ts` 的 `ENABLE_DIAGNOSTICS` 为 `false`，代码已对 **`WebRTC:IceStats`** 标签放行留存：
- 在原生 `PeerConnection` 发生 `VirtualDataChannel` 接管、`ice_failed` / `connection_failed` 失败、或未连接状态下 `close()` 前，系统会自动调用 `pc.getStats()` 并将全部 `candidate-pair` 与 `remote-candidate`（含 `prflx`）序列化为 JSON 写入：
  1. **控制台日志**（Host 端自动落盘到 `log/`，手机端可在 DevTools Console 看到 `[WebRTC:IceStats]`）。
  2. **内存诊断缓冲**：在手机端调用或通过 UI 导出诊断报告（`exportDiagnosticReport()`）时，可直接导出包含 `[WebRTC:IceStats]` 快照的完整文本，归档到 `report-from-phone/`。

### 3.2 Android 手机（USB 调试 + 电脑 Chrome）

1. 手机开启「开发者选项 -> USB 调试」，用数据线连接电脑并授权调试。
2. 电脑打开 Chrome，地址栏输入 `chrome://inspect/#devices`，点击 ScoutingPro27 标签下的 **`inspect`**。
3. **导出 Console 日志**：勾选 `Preserve log` 和时间戳，复现后右键 **`Save as...`** 保存至 `report-from-phone/`（例如 `phone-console-vpn-off.log` / `phone-console-vpn-on.log`）。
4. **导出 `chrome://webrtc-internals` 状态**：在设备新标签页打开 `chrome://webrtc-internals`，复现后点击 **`Create Dump`** -> **`Download the PeerConnection updates and stats data`**。

### 3.3 iOS 设备（Mac Safari）

1. iPhone「设置 -> Safari 浏览器 -> 高级」开启「网页检查器」。
2. Mac Safari 菜单「开发 -> [你的 iPhone] -> ScoutingPro27」，保存 **Console** 输出至 `report-from-phone/`。

### 3.4 桌面 Host 端对照日志

- 应用主日志（含 `[PortForwarding]`、`[JCEF]` 与前端转发的 `[WebRTC:IceStats]`）：`log/scoutingpro_YYYY-MM-DD_HH-MM-SS.log`
- Chromium 底层日志：`app_data/jcef_profile/chrome_debug.log`

---

## 4. 预期日志关键词与 Transport 标签 / 时序

### 4.1 桌面端启动与开孔日志（`log/scoutingpro_*.log`）

1. **JCEF 端口范围锁定**：
   - `[JCEF] Configured webrtc.udp_port_range=50000-50099 (canSet=true, verified=50000-50099)`
2. **物理网卡过滤与路由器探测**：
   - `[PortForwarding] Physical NIC candidates (virtual/TUN excluded): [...]`（不应包含 `198.18.0.1`）
   - 若发现 Clash TUN 等虚拟映射器会打印 `[PortForwarding] Filtered out non-physical mapper ...`
   - IPv4 映射与 IPv6 Pinhole 分别打印：
     - `[PortForwarding] IPv4 PortMap [...] src=... range=50000-50009/UDP -> mapped=10/10 extAddr=... lease=...s`
     - `[PortForwarding] IPv6 Pinhole [...] src=... range=50000-50009/UDP -> mapped=10/10 extAddr=... lease=...s`
   - NAT/CGNAT 判别结论：
     - `[PortForwarding] IPv4 WAN Verdict: TRUE_PUBLIC_IPV4 ...` 或 `CGNAT 100.64/10 detected ...` 或 `PRIVATE_OR_DOUBLE_NAT ...`
3. **退出清理**：
   - `[PortForwarding] Shutdown complete: unmapped X/X active mappings/pinholes.`

### 4.2 `[WebRTC:IceStats]` 快照字段（Host 与手机均有记录）

每条日志格式类似：
`[WebRTC:IceStats] [ICE Stats] trigger=virtual_dc_takeover, target=host, pairs=..., remoteCandidates=..., hasPrflx=..., stats={"candidatePairs":[...],"remoteCandidates":[...]}`
重点关注：
- `candidatePairs[]`: `state`, `nominated`, `requestsSent`, `requestsReceived`, `responsesReceived`, `responsesSent`
- `remoteCandidates[]`: `candidateType`（重点检查是否出现 `prflx` / `srflx` / `host`）, `address`, `port`, `protocol`

### 4.3 UI 传输标签对照表

| 场景 | UI 显示标签（中文 / 英文） | `transportInfo.type` | 底层协议 / 特征 |
| :--- | :--- | :--- | :--- |
| **VPN 关闭（IPv6 互通）** | **IPv6 直连** / `IPv6 Direct` | `ipv6_p2p` | `UDP`，两端均为 `host` / `srflx` IPv6（如 `2409:...`） |
| **同局域网直连（含绕过 LAN 的 VPN）** | **局域网直连** / `LAN Direct` | `lan_p2p` | `UDP`，内网 IPv4（如 `192.168.x.x`） |
| **IPv4 NAT 打洞（含 VPN `prflx` 打通）** | **IPv4 打洞** / `IPv4 Hole-punch` | `nat_p2p` | `UDP`，公网 IPv4 `srflx` / `prflx`（Host 端 `50000-50099`） |
| **ECDH 信令加密通道兜底** | **ECDH 加密通道** / `ECDH Tunnel (TLS)` | `relay` (`isVirtualTunnel: true`) | `wss/tls`，零 TURN 配额消耗，`virtual-e2ee <-> wss-broker:8084` |
| **TURN 最后保底（`attempt >= 3` / `forceRelay`）** | **TURN 中继** / `TURN Relay` | `relay` | `TCP` / `TLS`（`localCandidateType: relay`，默认优先 `turns:443/tcp`；支持独立非破坏性探针热升级回 Direct P2P） |

### 4.4 预期建连时序

1. **`t = 0 ms`（Attempt 0~2，Direct P2P 优先）**：
   - 启动 DoH 预解析（不阻塞 Offer/Answer 创建），使用精简 STUN 列表（`selectStunUrls`：国内 IPv4/IPv6 + 海外 IPv4/IPv6 + DoH 预解析出的国内 A / 境内外 AAAA 字面量），**绝对不携带 TURN**（`allowTurn: false`）。
   - 不在健康连接途中抢占性重启 ICE 或切入 TURN；冷启动且 `host_hello` 尚未到达时提供极短有界等待，防止 Attempt 0 因缺少密钥/目标 ID 而跳过 `VirtualDataChannel` 兜底。
2. **`t < 3.8 s`（早期 `ice_failed` / `connection_failed`）**：
   - 若存在有效共享密钥与 `hostSenderId`：在 dump `[WebRTC:IceStats]` 后**立即**激活 `VirtualDataChannel`（`ECDH 加密通道` / `ECDH Tunnel (TLS)`），状态转为 `connected`，不执行会销毁兜底计时器的 `hardResetChannels`。
   - 若尚未具备共享密钥或 `hostSenderId`：走 `failAttempt` 标准重试。
3. **`t = 3.8 s`（兜底定时器 `VIRTUAL_FALLBACK_DELAY_MS`）**：
   - 原生 ICE 未打开 DataChannel 时，先 dump `[WebRTC:IceStats]`，随即启用 `VirtualDataChannel` 保障实时同步；随后后台探针以 **`allowTurn: false`** 周期性尝试恢复直连 P2P，并在每次重连前显式关闭旧 `pc`、为 `bgPc` 设置 `CLIENT_CONNECT_TIMEOUT_MS` 超时回收、在异常后按上限退避重排程（`20s..300s`，最多连续 8 次异常）。
4. **`attempt >= 3` 或 `forceRelay === true`（TURN 最后保底与安全退回直连）**：
   - 若 `VirtualDataChannel` 自身出现 `heartbeat_timeout` 或不可用，且重试推进到 `attempt >= 3`（或显式强制中继），才启用 `turns:global.relay.metered.ca:443?transport=tcp`（默认单主节点模式以节省 Metered 月度配额）完成最终保底。
   - 一旦处于 TURN `relay` 连接下，`clientSilentUpgrade` 会拉起**独立非破坏性探针 `RTCPeerConnection`（`allowTurn: false`）**探测直连 P2P；在探针 `DataChannel` 真正 `open` 前**绝不拆毁或重配**当前活跃 TURN 会话，确保升级失败时业务零中断。

---

## 5. 已知边界

- 当 Host 侧处于 **ISP CGNAT（`100.64.0.0/10`）** 或 **多层无 UPnP 上级路由** 且双方无 IPv6 互通时，UPnP 仅能作用于本地最内层路由器，无法穿透运营商 CGNAT；此时将按预期落回 `VirtualDataChannel`（零 TURN 流量）或 `attempt >= 3` TURN 保底。
- `PortForwardingService` 在真实路由器（如 `SK-D847N`）环境下的 SSDP/UPnP/PCP 映射行为、`Main.java` 中桌面实机 JCEF `webrtc.udp_port_range=50000-50099` 的 `canSet` 实测返回值，以及手机真机 VPN 开启/关闭切换时的端到端 ICE/PRFLX/VirtualDC 表现，仍需按本指南在真实路由器 + 手机真机环境下实测归档至 `report-from-phone/`。
