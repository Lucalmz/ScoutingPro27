# ScoutingPro27 CRDT + HLC 分布式协同、纪元防脑裂与极端容灾 E2E 实施规划

> **文档定位**：独立架构与工程实施规划文档（已取代并移除旧版 `IMPLEMENTATION_PLAN.md`；仅作方案设计，本文档落盘时不改动任何业务源码与测试）。  
> **目标基线**：v1.0.4+（BIOBUZZ 2026–2027 · `frontend` Vue 3 + Vite 8 + TypeScript 6 + `Backend` Java 21 + Javalin 7 + H2 + Flyway `V1`–`V8`）。

---

## 1. 元信息与总体目标

### 1.1 解决的核心工程痛点
1. **并发写入覆盖**：当前 [pitScout.ts](file:///e:/AppDevelope/ScoutingPro27/frontend/src/stores/pitScout.ts#L215-L240)（除 `photoKeys` 并集外）、[schedule.ts](file:///e:/AppDevelope/ScoutingPro27/frontend/src/stores/schedule.ts) 与全量同步协议（`TAGS_FULL_SYNC` / `CUSTOM_FIELDS_FULL_SYNC`）均偏粗粒度，离线并发改同一支队伍不同字段时容易整条覆盖丢字段。
2. **强依赖单点发号与跨设备主机灾难恢复**：当前正赛记录依赖唯一活跃 Host 发单调序号 `hostSeq`（[channelMessageHandler.ts](file:///e:/AppDevelope/ScoutingPro27/frontend/src/services/webrtc/channelMessageHandler.ts#L386-L461)），并配套了脆弱的 2000ms `Takeover Staging Gate` 与 `HOST_HANDOFF_BATCH`（[hostElection.ts](file:///e:/AppDevelope/ScoutingPro27/frontend/src/services/webrtc/hostElection.ts#L100-L136)）。一旦主机硬件暴毙（未发交接包）、隔 2 小时后领队在另一台设备登录，如何做到**零脑裂、零丢数据、全员无需重建房间无感恢复**是核心难点。
3. **赛场手机系统时钟偏移与未来时钟毒化**：传统 LWW 依赖 `Date.now()`，在断网手机、跨时区或系统时间被误调（如调成 2036 年）的场景下会导致正常更新被永久压死。
4. **极端容灾全链路端到端验证缺失**：现有 [multi-client.test.js](file:///e:/AppDevelope/ScoutingPro27/frontend/e2e/multi-client.test.js) 仅启动单一后端共享默认数据库，无法验证多台物理桌面主机各自持有独立 H2 时的暴毙接管、旧主机复活 Fencing 压制、共用库切号与裸机空库恢复。

### 1.2 明确范围与非目标 (Scope & Non-Goals)
| 数据/能力域 | 纳入策略 | 原因说明 |
| :--- | :--- | :--- |
| **Pit 展位、照片 Key 集合、战队标签、自定义字段、赛程排班** | **全面纳入 TinyBase CRDT + HLC** | 高频结构化并发协作场景，字段/单元格级无冲突合并收益最大 |
| **正赛侦察打分 (`ScoutingRecord`)** | **纳入 CRDT + 作者设备 ECDSA 签名 + 纯前端冲突派生** | 摆脱 `hostSeq` 与交接门禁，同时保留防伪造与“双人同场录同队保留两条并提示人工复核”业务铁律 |
| **主机纪元 (`hostEpoch`) 与防脑裂控制面** | **独立控制面 Fencing 协议 + MQTT Retained 信标 + 手机 Witness** | 控制只写权威，解决主机暴毙换机、双机复活、孤岛重逢仲裁 |
| **系统时钟校准 (`CalibratedMonotonicClock`)** | **握手 3 次最小 RTT 标定零点 + `performance.now()` 晶振走时** | 免疫运行期手动改系统时间，重连重新标定，配合漂移拦截防毒化 |
| **战术白板 (`useTacticalWhiteboard.ts`)** | **维持低优先级 / 随缘轻量同步（非重型目标）** | 按产品定调：不投入复杂协同撤销栈与光标引擎成本，异常或误清空直接重置处理 |
| **高清实物照片二进制 (`mobilePhotoCache.ts`)** | **保留现有 IndexedDB + `PIT_PHOTO_CHUNK` 分片通道** | 大二进制块不塞入 CRDT 文档，CRDT 仅同步 `pit_photo_keys` 集合索引 |

---

## 2. 关键架构决策（Architecture Decisions）

### 决策 1：控制面纪元 (`hostEpoch`) 与数据面时钟 (`HLC`) 彻底解耦
借鉴 Raft Term 与 Martin Kleppmann Fencing Token 思想，立下一条不可违背的架构铁律：
- **控制面 (`hostEpoch`)**：仅负责“谁是当前唯一合法 Host”、“强制降级过期 Host”、“拒收旧 Host 的控制/心跳/信令包”。
- **数据面 (`CRDT + HLC`)**：单元格/字段级胜负**绝对不把 `hostEpoch` 作为最高比较位**。原因：若空新机 B 接管后 `hostEpoch = 2`，而纪元号优先级高于 HLC 时间戳，那么 B 上任何初始化空值或过期状态会碾压全员在 `Epoch = 1` 期间离线 2 小时采集的真实数据。
- **合并保证**：数据面仅依靠 `HLC = (calibratedPt, counter, deviceId)` 与 TinyBase 的交换律/结合律/幂等律保证任意拓扑、任意重连顺序最终字节级一致。

### 决策 2：现成库选型 `tinybase`（锁定 `tinybase@^10.1.0` `MergeableStore` + `createCustomSynchronizer`）
- **选型依据**：
  1. 纯 TypeScript、零外部依赖、零 WASM（核心仅 ~10 KB gzip），彻底规避在 [package.json](file:///e:/AppDevelope/ScoutingPro27/frontend/package.json#L51-L52)（`vite@^8.1.5` Rolldown + `typescript@~6.0.0`）和 [vite.config.ts](file:///e:/AppDevelope/ScoutingPro27/frontend/vite.config.ts#L45-L47)（`vite-plugin-pwa` 默认 2 MiB 缓存上限）下引入重型 WASM 的打包与移动端首屏加载风险。
  2. **版本红线（必须锁定 `tinybase@^10.1.0`）**：第 2 参数 `getNow` 于 `v6.1.0` 引入，而第 3 参数 **`maxClockSkewSeconds` 直到 `v10.1.0` 才正式引入**（Phase 0 安装后需第一时间对照本地 `node_modules/tinybase` 的 `.d.ts` 声明文件实测核对签名与 `getHlcFunctions()` 元组解构顺序）。另注：TinyBase 官方明确通过本地 `Persister` 加载的数据不受 `maxClockSkewSeconds` 拦截（仅对外部同步生效），非常契合离线长周期冷启动恢复。
     ```ts
     createMergeableStore(
       localDeviceId,                // 必须使用 identityStore 持久化的物理 deviceId，严禁使用 userId
       () => calibratedClock.now(),  // 晶振标定单调时钟，运行时彻底隔离 Date.now()
       300                           // maxClockSkewSeconds = 300s 未来时钟防毒化护栏 (TinyBase v10.1.0+)
     )
     ```
  3. 原生提供 `createCustomSynchronizer`，协议负载为纯 JSON，可直接挂载到现有的纯字符串分片与背压管道 [DataChannelSender](file:///e:/AppDevelope/ScoutingPro27/frontend/src/services/dataChannelSender.ts) 与 [VirtualDataChannel](file:///e:/AppDevelope/ScoutingPro27/frontend/src/services/webrtc/virtualDataChannel.ts) 上。
  4. 支持多设备同账号登录：因 [channelMessageHandler.ts](file:///e:/AppDevelope/ScoutingPro27/frontend/src/services/webrtc/channelMessageHandler.ts#L158-L180) 允许 `SAME_USER` 多设备共存，将 `MergeableStore` 的节点 ID 严格绑定至 [identityStore.ts](file:///e:/AppDevelope/ScoutingPro27/frontend/src/utils/identityStore.ts#L175-L176) 生成的持久化物理 `deviceId`，可彻底避免同账号双设备 HLC 节点号冲突。

### 决策 3：主机在新设备登录的共用数据库分析与“双入口、主次分明”策略（核心拍板）

#### 现状代码实证
1. **确实共用同一个本地 H2 数据库**：桌面端通过 [AppConfig.java](file:///e:/AppDevelope/ScoutingPro27/Backend/src/main/java/com/bear27570/app/db/AppConfig.java#L141-L162) 启动单一本地 H2 库（开发模式 `<project_root>/app_data.mv.db`，生产模式 `~/.scoutingpro27/app_data.mv.db`）。当原主机账号 `LeadAlice` 换到助理/队友的电脑 B 登录时，电脑 B 上原有的队员账号 `AssistantBob` 与 `LeadAlice` 访问的是同一个本地 H2 实例。
2. **该共用库里已经存有高价值热数据**：
   - 此前电脑 B 作为 Standby Host 或普通桌面客户端加入房间时，收到 `EVENT_METADATA` 后已调用 `POST /api/events/external-sync`（[EventRoutes.java](file:///e:/AppDevelope/ScoutingPro27/Backend/src/main/java/com/bear27570/app/routes/EventRoutes.java#L159-L200)）将**权威赛事 UUID 与原始 `host_id`（即 `LeadAlice` 的确定性 UUID）**落盘到本地 `events` 表。
   - 同时电脑 B 的 H2 中已经镜像了暴毙前（如 `00:00~01:00`）全部已同步的 `scouting_records`、`pit_scouting_records`、`match_schedules`、`scout_assignments`、`team_tags`、`event_custom_fields` 与后续引入的 `event_crdt_state` 快照。
   - `LeadAlice` 的用户 ID 由 [UserUtil.java](file:///e:/AppDevelope/ScoutingPro27/Backend/src/main/java/com/bear27570/app/util/UserUtil.java#L14-L22) 和 [userId.ts](file:///e:/AppDevelope/ScoutingPro27/frontend/src/utils/userId.ts#L168-L192) 通过确定性算法 `generateDeterministicUserId(username)` 生成；且 [EventDao.java](file:///e:/AppDevelope/ScoutingPro27/Backend/src/main/java/com/bear27570/app/dao/EventDao.java#L27-L28) 的查询语句为 `WHERE e.host_id = :userId OR eu.user_id = :userId`，天然能查出归属 `LeadAlice` 的已有赛事。

#### 最终架构拍板：双入口协同（主推列表直进 + 保留邀请码兜底）
1. **首选主路径（共用库备机 / 队友电脑 B）：Dashboard 列表加载该用户数据库直接点击进入**
   - `LeadAlice` 在电脑 B 注册/登录自己账号后，[DashboardView.vue](file:///e:/AppDevelope/ScoutingPro27/frontend/src/views/DashboardView.vue#L129-L139) 调用 `fetchEvents(userId)` 从本地 H2 拉取赛事列表，直接呈现出原赛事卡片（因 `events.host_id === LeadAlice.id`，卡片角色直接标识为主机）。
   - **直接点击卡片进入是更优、更符合逻辑的路径**：
     - 无需重新记忆或输入邀请码；
     - 彻底杜绝误建 `ext_CODE` 临时占位事件导致 UUID 分裂（[EventRoutes.java](file:///e:/AppDevelope/ScoutingPro27/Backend/src/main/java/com/bear27570/app/routes/EventRoutes.java#L110-L122)）；
     - 零秒继承电脑 B 本地 H2 与 CRDT 快照中的热数据（即使部分手机刚好没带在身边或已关机，电脑 B 本地镜像也能保住历史）。
2. **必备兜底路径（全新空库裸机 C / 首次登录该电脑）：保留“输入邀请码加入（或导入 `.event` 包）”**
   - 若领队临时找来一台**从未加入过该比赛的空电脑 C**，本地 H2 为空，赛事列表里自然没有这张卡片。
   - 此时领队输入 6 位邀请码加入，桌面端进入后**禁止立即以 `ext_CODE` 开新房**，而是先发起 1.5 秒 `HOST_DISCOVERY`：从在场手机 `EPOCH_WITNESS` 与 MQTT Retained 信标取回 `{ authoritativeEventId, eventName, hostId, ftcYear, ftcEventCode, highestEpoch }`，校验 `currentUser.id === witness.hostId` 后通过 `/api/events/external-sync` 落盘权威 UUID 再正式晋升 `Epoch = maxSeen + 1`。

#### 同机跨账号切换的隔离与防丢改造（修复 [user.ts](file:///e:/AppDevelope/ScoutingPro27/frontend/src/stores/user.ts#L310-L363) 现存隐患）
当前 [user.ts](file:///e:/AppDevelope/ScoutingPro27/frontend/src/stores/user.ts#L347-L360) 的 `logout()` 会调用 `useEventStore().clearAllLocalCache()`（[events.ts](file:///e:/AppDevelope/ScoutingPro27/frontend/src/stores/events.ts#L382-L409)）把所有 `scoutingpro_*` / `sp27_*` 本地缓存与离线照片一并抹光。在“电脑 B 先登 `AssistantBob` 后切换登录 `LeadAlice`”场景下，若 `AssistantBob` 离线期间刚修改过本地数据就登出，旧逻辑会直接误删未同步缓存！因此强制重构隔离边界如下：
- **按 `eventId` / `inviteCode` 共享（登出切号绝不删除）**：
  - 本地 H2 全部业务表与 `event_crdt_state` 快照表；
  - `sp27_epoch_${inviteCode}`（赛事最高已见纪元与权威元数据）；
  - `sp27_clock_anchor_${eventId}`（本地时钟单调锚点）；
  - 赛事级 CRDT IndexedDB 存储（`logout()` 前强制执行 `await crdtManager.flushAllToH2()`，保证 `AssistantBob` 离线写的每条 CRDT 变更落入共享 H2，新登录的 `LeadAlice` 秒级继承并广播给全场）。
  - **关键权限与签名时序约束**：`assignments` 与 Pit 数据无需校验作者签章，`LeadAlice` 登录后可直接加载并广播；但如果 `AssistantBob` 在离线期间也录入了 `scouting_records`（正赛打分），**必须在写入本地 CRDT Cell 的当下立即用电脑 B 物理设备私钥（绑定在 IndexedDB，不随 `logout()` 改变）算好 `authorSig` 并写入 Cell**，严禁拖延到联网发送时再签名，否则切号 `LeadAlice` 后再广播会导致作者身份与签名上下文错位。
- **按 `userId` 严格隔离（登出清理）**：
  - 当前登录态 `scoutingpro-user`（含 JWT）、AI 密钥与会话（`ai_settings` / `ai_chat_sessions` 已按 `user_id` 分库）、收件箱 `inbox-messages-${userId}` / `inbox-outbox-${userId}`；
  - 前端 Dashboard 视口缓存 `scoutingpro_events` / `scoutingpro_current_event`（登出时清空内存与列表缓存，新账号登录后重新 `GET /api/events` 从 H2 查询属于该账号的赛事）。
- **零信任底线不降级**：即使新设备用原房主账号密码登录获得了相同的 `userId`，由于新设备的 ECDH 公钥（`identityStore.ts`）是全新的，手机端首次连入新主机 B/C 时**仍必须触发 4 位 SAS 短认证码核验**，从密码学层面杜绝赛场有人猜出领队用户名注册新号进行主机劫持。

### 决策 4：作者设备 ECDSA P-256 签名 + `member_identities` 绑定表（防伪造与灾备代传闭环）
- **现状矛盾**：当前 [channelMessageHandler.ts](file:///e:/AppDevelope/ScoutingPro27/frontend/src/services/webrtc/channelMessageHandler.ts#L368) 要求 `r.scoutId === expectedScoutId`，主机直连时防伪造有效；但一旦主机 A 暴毙、且某名队员手机 S5 也断电失联，空机器 B/C 上线后，在线队员 S1 手机里明明缓存着 S5 之前同步的历史记录，却因“代传者的通道身份不是 S5”而被主机拒收。此外，如果只拿记录自带的 `authorPubKey` 验 `authorSig`，恶意 `Client1` 仍可自造一对临时密钥填 `scoutId = Client2` 自签名绕过校验。
- **方案**：
  1. 在 [identityStore.ts](file:///e:/AppDevelope/ScoutingPro27/frontend/src/utils/identityStore.ts#L22-L27) 中伴随 ECDH P-256 身份密钥对，懒升级生成并持久化一对 **ECDSA P-256 签名密钥对**（导出 `authorPubKey` SPKI Base64）。
  2. **写时签名（Write-Time Signing）**：任何成员提交或修改 `ScoutingRecord` 时，**在写入本地 CRDT Cell 的当下**立即对规范化内容摘要 `(id, eventId, scoutId, matchNumber, teamNumber, rawData, isDeleted, hlcStamp)` 计算 `authorSig` 一并落入 Cell（绝不在同步发送阶段才补签）。
  3. **设备公钥成员绑定表 (`member_identities`)**：在 CRDT 中增设 `member_identities` 表（仅允许活跃 Host 在完成 SAS 短码核验或首次通道绑定后写入 `${userId}::${deviceId} -> signingPubKeyHex` 并附带 `hostSig`）。
  4. **通道入站双重验权**：
     - 作者本人通道直推 → 校验通道绑定 `scoutId === expectedScoutId` 且 `authorSig` 有效；
     - 队友手机代传他人的历史记录（如空主机灾备恢复）→ **必须同时满足 ① `record.authorPubKey` 已在 `member_identities` 中绑定至 `record.scoutId`（或经过确认的新主机设备背书）且 ② `ECDSA.verify` 验签通过**，才予无损接受；自造密钥冒名或篡改分数的伪造记录直接拦截并告警。

### 决策 5：`isConflict` 改为纯前端派生视图 (`computed`)
- 移除 [records.ts](file:///e:/AppDevelope/ScoutingPro27/frontend/src/stores/records.ts#L241-L283) 与 [records.ts](file:///e:/AppDevelope/ScoutingPro27/frontend/src/stores/records.ts#L425-L476) 中“修改他人记录的 `isConflict` 字段并递增 `version` 广播”的逻辑。
- 各端仅通过 CRDT 同步各自的独立打分记录行，UI 层基于全量活跃（`!isDeleted`）记录按 `(eventId, tournamentLevel, matchNumber, teamNumber)` 统计 `uniqueScouts.size > 1` **实时 `computed` 派生**冲突标记。既然 CRDT 保证各端数据集合收敛一致，各端冲突视图必然 100% 一致，彻底消灭冲突状态的并发乒乓震荡。

---

## 3. 详细技术架构设计

### 3.1 抗毒化晶振零点时钟 (`CalibratedMonotonicClock`)

新建模块 `frontend/src/services/clock/calibratedClock.ts`：

```text
[握手零点标定 (SAS 通过后 / 每次断线重连后)]
Client 发送 3 轮 CLOCK_SYNC_REQ { reqId, clientMonoM1 = performance.now() }
Host   立即响应 CLOCK_SYNC_RES { reqId, hostNow = hostClock.now(), hostEpoch }
Client 收到后取 RTT = (m2 - m1) 最小的那 1 轮样本：
    baseHostMs = hostNow + minRtt / 2
    baseMonoMs = m2
此后任何时刻读当前逻辑物理基准：
    calibratedNow() = Math.floor(baseHostMs + (performance.now() - baseMonoMs))
```

#### 4 大极端边界防护设计
1. **运行期手动改手机系统时间（+10 年 / -1 年）**：
   - 运行期完全不调用 `Date.now()`，只读晶振单调计数器 `performance.now()`，因此系统时间篡改对本地生成的所有 HLC **零影响**。
2. **手机锁屏休眠醒来后仍断网，立刻录入新数据**：
   - 部分移动 OS 在深度休眠期间会冻结 `CLOCK_MONOTONIC`（导致 `performance.now()` 少算休眠时长）。
   - **保底层**：HLC 本身强制 `nextPt = Math.max(calibratedNow(), lastLocalHlcPt)`，且相同 `pt` 时自增 `counter`，因此休眠醒来自己修改自己或新增记录**永远严格大于先前版本**。
   - **平滑补偿层**：监听 `visibilitychange`（`visible`），记录唤醒前后的 `Δwall = Date.now() - lastActiveWallMs` 与 `Δmono = performance.now() - lastActiveMonoMs`。仅当 `0 < (Δwall - Δmono) <= 12 * 3600_000` 且处于离线状态时，允许将 `baseHostMs` 平滑前拨 `Δwall - Δmono` 并重置 `baseMonoMs`；超出 `[0, 12h]` 窗口一律视为系统时间异常篡改，拒绝信任 `Date.now()`；一旦网络恢复重连，立刻重新执行 3 样本 RTT 标定覆盖零点。
3. **断网期间 PWA 被杀进程 / 刷新页面（`performance.now()` 归零）**：
   - 每次标定成功与写入本地 CRDT 时，向 `localStorage` 持久化极简时钟锚点 `sp27_clock_anchor_${eventId}`：
     `{ lastHlcPt, savedCalibratedMs, savedWallMs, calibratedByHost }`。
   - 离线冷重启时，计算 `wallDelta = Date.now() - savedWallMs`：
     - 若 `0 <= wallDelta <= 12 * 3600_000`：以 `Math.max(savedCalibratedMs + wallDelta, lastHlcPt + 1)` 锚定 `baseHostMs`、以当前 `performance.now()` 锚定 `baseMonoMs`；
     - 若 `wallDelta < 0` 或 `wallDelta > 12h`（恶意改表/系统时钟坏掉）：**拒信 `Date.now()`**，直接从 `lastHlcPt + 1` 起振。
4. **新主机 B 自身系统时间错乱 + 恶意毒包拦截（重要实现细节）**：
   - **Host 自身同样跑 `CalibratedMonotonicClock + HLC`**，绝不使用裸 `Date.now()`；
   - 电脑 B 晋升为主机时，收集在线 Witness 汇报的 `maxKnownHlcPt` 列表，过滤掉明显离谱的离群值后取**有效中位数 `medianWitnessPt`**，设定 `hostBaseMs = Math.max(B_wallClock, medianWitnessPt + 1)`（时钟只进不退，确保新主机写出的每一笔数据都比历史数据新）；
   - **入站防毒化与主动告警**：TinyBase 的 `maxClockSkewSeconds = 300` 对超前 Cell 仅执行**静默丢弃（drop）**，并不会主动触发回调通知业务层！因此必须在 `webrtcCrdtSynchronizer.ts` 将入站 `CRDT_SYNC_MSG` 喂给 `MergeableStore` 之前加一层**入站 HLC 预检扫描器**：
     - **严禁手写 12 位正则或按 ISO 字符串解析**（TinyBase 内部 HLC 为 16 字符紧凑编码字符串）；
     - 统一调用 TinyBase 导出的 `getHlcFunctions()` 中的 `decodeHlc(hlc)` 解码物理毫秒时间 `pt`，若检测到 `pt > hostClock.now() + 300_000`，立即记录安全审计日志并主动向该对端回发 `FORCE_CLOCK_RESYNC` 强制重标定零点，彻底阻断未来时钟毒化传染全房间的可能。

---

### 3.2 控制面纪元防脑裂协议 (`Epoch Fencing + Witness`)

基于现有 [hostElection.ts](file:///e:/AppDevelope/ScoutingPro27/frontend/src/services/webrtc/hostElection.ts) 与 [signaling.ts](file:///e:/AppDevelope/ScoutingPro27/frontend/src/services/webrtc/signaling.ts) 升级：

1. **按赛事分桶持久化纪元与权威元数据（全员存储）**：
   - 将原全局键 `scoutingpro_host_epoch` 改为按赛事隔离的 `sp27_epoch_${inviteCode}`，全员（桌面端 + 所有手机端）均持久化：
     ```ts
     interface EventEpochWitnessRecord {
       inviteCode: string
       authoritativeEventId: string
       eventName: string
       hostUserId: string
       ftcYear?: number
       ftcEventCode?: string
       highestSeenEpoch: number
       activeHostSessionId?: string
       activeHostDeviceId?: string
       updatedAt: number
     }
     ```
2. **独立 MQTT Retained 纪元信标子主题（解决 2 小时空窗与 `NonceLruCache` 冲突）**：
   - 现有主信令通道 [signaling.ts](file:///e:/AppDevelope/ScoutingPro27/frontend/src/services/webrtc/signaling.ts#L122) 配有 15 分钟 TTL 的 `NonceLruCache`（[crypto.ts](file:///e:/AppDevelope/ScoutingPro27/frontend/src/utils/crypto.ts#L23-L28)），若将 `Retained` 消息直接发在主 Topic，2 小时后新设备上线会因超时窗口被直接丢弃！
   - **解决方案**：增设独立子主题 `scoutingpro27/signal/${hashHex}/epoch-beacon`（`retain: true, qos: 1`）。该信标仅承载控制面最小信息 `{ type: 'epoch_beacon', hostEpoch, hostSessionId, hostDeviceId, hostUserId, authoritativeEventId, eventName, ftcYear, ftcEventCode, signature }`，校验规则为 **房间 HMAC-SHA256 验签 + `hostEpoch >= localHighestSeenEpoch` 单调规则**，不走 15 分钟 TTL 拦截，也不依赖公网 Broker 100% 永久保留（Broker 丢了 Retained 还有全员手机 `EPOCH_WITNESS` 兜底）。
3. **信令白名单扩展（严守信令与业务硬隔离边界）**：
   - 在 [signaling.ts](file:///e:/AppDevelope/ScoutingPro27/frontend/src/services/webrtc/signaling.ts#L419-L434) 的 `ALLOWED_SIGNAL_TYPES` 中仅追加控制面指令：
     `'host_discovery'`、`'epoch_witness'`、`'epoch_superseded'`。继续严禁任何业务打分/Pit 数据通过 MQTT 信令直传。
4. **Fencing 压制与平局仲裁规则**：
   - **权限准入**：仅桌面端（`isDesktopHost() && !isMobileDevice()`）且满足 `currentUser.id === authoritativeHostId`（原主机账号换设备登录）或经主机授权接管的备机账号才可发起 `HOST_ELECTED` / `host_takeover`；手机端永久禁止参选主机，只充当 Witness 与 Fencing 执行者。
   - **低纪元必杀（Fencing）**：任何节点收到 `hostEpoch < highestSeenEpoch` 的 `host_hello` / `host_heartbeat` / `host_takeover`，一律拒收并立即单播/广播回弹 `epoch_superseded { currentEpoch: highestSeenEpoch, activeHostSessionId, activeHostDeviceId }`。
   - **同纪元孤岛脑裂收敛**：若两台离线桌面主机在同纪元内各自孤岛运行后重逢，沿用 [hostElection.ts](file:///e:/AppDevelope/ScoutingPro27/frontend/src/services/webrtc/hostElection.ts#L18-L37) 的 `compareHostAuthority(epoch, deviceId, sessionId)` 选出唯一胜者，胜者将自身 Epoch 再 `+1` 广播固化，败者降级为 Standby Client 连入胜者做 CRDT 反熵合并，**无需再依赖原 `HOST_HANDOFF_BATCH` 与 2000ms 门闸**。

---

### 3.3 TinyBase CRDT 表模型、同步协议与 H2 持久化（Flyway `V8` 合并版）

#### CRDT 表设计（TinyBase `MergeableStore` 规范化扁平表）
遵循 TinyBase 最佳实践：所有 Cell 仅存原始值（`string | number | boolean`），数组/集合拆分为独立关系子表以实现真正无冲突并发增删：

| CRDT 表名 | 行主键 (RowId) | 核心单元格 (Cells) | 并发合并语义 |
| :--- | :--- | :--- | :--- |
| `pit_records` | `${teamNumber}` | `id, eventId, teamNumber, scoutId, scoutName, robotName, drivetrainType, weightLbs, chassisSize, ballCompatibility, launcherType, flowerMechanism, hasColorSensor, hasDescoreMech, hasApriltagVision, odometryType, claimed*, rawDataJson, isDeleted` | **字段级 LWW-HLC**：一人改重量、一人改发射机构同时保留不互盖 |
| `pit_photo_keys` | `${teamNumber}::${photoKey}` | `teamNumber, photoKey, active (boolean), addedBy` | **LWW-Element-Set（元素行级 HLC）**：不同照片并发增删互不覆盖，同元素以最后写入胜出 |
| `team_tags` | `${teamNumber}::${normalizedTag}` | `id, eventId, teamNumber, tag, color, isPreset, active (boolean), createdBy` | **LWW-Element-Set（元素行级 HLC）**：替代原 `TAGS_FULL_SYNC` 全量覆盖 |
| `custom_fields` | `${fieldId}` | `id, eventId, target, phase, name, fieldKey, fieldType, required, defaultVal, optionsJson, minVal, maxVal, stepVal, unit, orderKey (Fractional Index), isActive, isDeleted` | 字段级 + 分数索引排序防并发重排冲突 |
| `schedules` | `${level}_${matchNumber}` | `id, eventId, matchNumber, tournamentLevel, red1, red2, blue1, blue2, scoreRedFinal, scoreBlueFinal, isDeleted` | 场次行级/字段级增量同步 |
| `assignments` | `${level}_${matchNumber}_${station}` | `id, eventId, matchNumber, tournamentLevel, station, teamNumber, scoutId, scoutName` | 工位级 LWW-HLC，领队派单实时推屏 |
| `member_identities` | `${userId}::${deviceId}` | `userId, deviceId, signingPubKeyHex, trustedAt, hostSig` | 仅活跃 Host 在 SAS 核验/身份绑定后写入；为队友代传灾备提供公钥可信锚点 |
| `scouting_records` | `${recordId}` | `id, eventId, scoutId, scoutName, matchNumber, teamNumber, tournamentLevel, autoScore, teleopScore, endgameScore, totalScore, notes, rawDataJson, isBroken, isDeleted, authorPubKey, authorSig, hostSig` | **写时立即算 `authorSig`**，入站结合 `member_identities` 验签；`isConflict` 不入库，纯前端 `computed` 派生 |

> **集合删除统一规范（严禁混用 `delRow()`）**：虽然 TinyBase `MergeableStore` 的 `delRow()` 在底层会写入带 HLC 时间戳的删除墓碑（不会把旧数据复活），但 TinyBase 本质上仍是 Cell-level LWW-Map（非学术 OR-Set）。为保证与后端 H2 关系表脏行投影（清晰识别软删除）的语义绝对一致，本项目对 `pit_photo_keys` 与 `team_tags` **统一强制使用 `setCell(tableId, rowId, 'active', false)` 写入布尔墓碑**，UI 读取统一过滤 `active === true`，**严禁对集合表混用物理 `delRow()`**。

#### WebRTC DataChannel 传输适配器 (`webrtcCrdtSynchronizer.ts`)
- 在 [types/index.ts](file:///e:/AppDevelope/ScoutingPro27/frontend/src/types/index.ts#L203) 协议联合类型中新增：
  - `CLOCK_SYNC_REQ` / `CLOCK_SYNC_RES` / `FORCE_CLOCK_RESYNC`
  - `CRDT_SYNC_MSG`（承载 TinyBase `createCustomSynchronizer` 的 `{ to, requestId, message, body }`）
  - `CRDT_SYNC_CHUNK`（当序列化后的 JSON 超过 48 KiB 时自动分片发送，严格低于 [DataChannelSender](file:///e:/AppDevelope/ScoutingPro27/frontend/src/services/dataChannelSender.ts#L37) 的 `MAX_PAYLOAD_SIZE = 64 KiB` 红线）
- **入站 HLC 预检扫描**：喂给 `MergeableStore` 前统一调用 TinyBase 导出的 `getHlcFunctions()` 中的 `decodeHlc()`（禁止手写正则），捕捉超前 > 300s 的毒化包并触发 `FORCE_CLOCK_RESYNC`（弥补 TinyBase 内部静默丢弃无回调的缺口）。
- 兼容 [VirtualDataChannel](file:///e:/AppDevelope/ScoutingPro27/frontend/src/services/webrtc/virtualDataChannel.ts) 双轨热升级：由于 `MergeableStore` 反熵协议天然幂等，即使原生 UDP 通道热升级切换期间发生单帧重发也不会造成状态损坏。

#### 数据库迁移与后端投影（Flyway `V8__Custom_Turn_And_Crdt_Sync.sql`，与自定义 TURN 配置合并）
由于自定义 TURN 版本尚未发布，已将 `V8__Custom_Turn_Config.sql` 与 CRDT 扩展表结构合并为 **`Backend/src/main/resources/db/V8__Custom_Turn_And_Crdt_Sync.sql`**：
```sql
-- V8__Custom_Turn_And_Crdt_Sync.sql — Custom TURN Config, CRDT State Snapshot, Revision Guard & Author/Host Signatures

ALTER TABLE events ADD COLUMN IF NOT EXISTS turn_config_encrypted TEXT;

CREATE TABLE IF NOT EXISTS event_crdt_state (
    event_id           VARCHAR(2048) PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
    host_epoch         INT           NOT NULL DEFAULT 1,
    snapshot_revision  BIGINT        NOT NULL DEFAULT 0,
    crdt_snapshot_json CLOB          NOT NULL,
    updated_at         TIMESTAMP     DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE scouting_records ADD COLUMN IF NOT EXISTS author_pub_key VARCHAR(256);
ALTER TABLE scouting_records ADD COLUMN IF NOT EXISTS author_sig     VARCHAR(256);
ALTER TABLE scouting_records ADD COLUMN IF NOT EXISTS host_sig       VARCHAR(256);
```
新增后端路由 `CrdtRoutes.java`（注册到 [ApiRoutes.java](file:///e:/AppDevelope/ScoutingPro27/Backend/src/main/java/com/bear27570/app/routes/ApiRoutes.java#L178-L189)）：
- `GET /api/events/{eventId}/crdt-state`：返回持久化 `crdt_snapshot_json` 与 `host_epoch`（含客户端进入时的热启动快照）；
- `PUT /api/events/{eventId}/crdt-state`：落盘完整快照 `event_crdt_state` 并投影至关系表（`scouting_records`、`pit_scouting_records`、`match_schedules`、`scout_assignments`、`team_tags`、`event_custom_fields`），保证 AI 军师、FTC 比分核销与 CSV 导出 **100% 兼容**。针对大型区域赛快照达 300–800 KB 且后端存在 `RECORD_WRITE_LOCK` 锁竞争的瓶颈，强制落地以下 **3 项性能与并发护栏**：
  1. **防抖窗口 + `maxWait`**：默认 `debounce = 1500ms` + `maxWait = 5000ms`；仅在 `beforeunload`、`logout()`、主机接管瞬间执行强制立即 `flush()`。
  2. **脏行增量投影（Dirty-Row Projection）**：前端通过 TinyBase 事务监听器收集本防抖周期内变动的 `dirtyRows: Record<tableId, rowId[]>` 随 `PUT` 一并提交，后端覆盖写入 `event_crdt_state` 的 CLOB 时，**仅对 `dirtyRows` 命中的主键执行关系表投影**（仅空库初次恢复或 U 盘全量导入时传 `fullProjection: true` 做全量对账）。
  3. **串行 `inFlight` 落盘互斥与失败保留**：前端严禁两个防抖 `PUT` 并发竞态（通过单调 `snapshotRevision` + 串行队列确保最新快照不覆盖倒退）；唯有 `PUT` 返回 HTTP 200 后才清空已提交的 `dirtyRows`，失败则保留并入下次重试。

---

### 3.4 完整极端场景时序推演图

```mermaid
sequenceDiagram
    autonumber
    participant HostA as "原主机电脑 A (Temp H2 #1)"
    participant HostB as "队友共用库电脑 B (Temp H2 #2)"
    participant MQTT as "MQTT 盲信令 + epoch-beacon"
    participant Phones as "手机群 S1/S2 (Witness + CRDT)"
    participant HostC as "全新空库裸机 C (Temp H2 #3)"

    Note over HostA,Phones: "阶段 1 (00:00): 建房 Epoch=1，备机入场，零点标定"
    HostA->>MQTT: "发布 Retained epoch-beacon (epoch=1, eventId=E100, hostId=Lead)"
    HostB->>HostA: "AssistantBob 以备机加入并同步 E100 元数据与历史镜像入 H2 #2"
    Phones->>HostA: "SAS 核验 -> 3次RTT时钟零点标定 -> TinyBase Hash 树初始对齐"

    Note over HostA: "阶段 2 (01:00): HostA 暴毙 (先录1条本地独占记录后直接强杀进程!)"
    Note over Phones,HostB: "阶段 3 (01:00~03:00): 2 小时无主机离线并发作业 + 改系统时间攻击"
    Phones->>Phones: "S1 篡改 Date.now=+10年 无效(晶振走时) + 改 Pit weight + 离线刷新冷启动"
    Phones->>Phones: "S2 离线改 Pit launcher + 拍照Key + 增删标签 + 录 ECDSA 签名打分"
    HostB->>HostB: "AssistantBob 离线修改排班并登出(logout前flush CRDT进H2 #2不删赛事数据)"

    Note over HostB,Phones: "阶段 4 (03:00): 主路径 — 领队在共用库电脑 B 登录 Lead 账号"
    HostB->>HostB: "Dashboard 直接加载 H2 #2 中归属 Lead 的 E100 卡片并点击直进(免输邀请码)"
    HostB->>MQTT: "HOST_DISCOVERY (1.5s) -> 确认原 HostA 无响应"
    Phones-->>HostB: "回复 EPOCH_WITNESS (highestEpoch=1, maxHlcPt)"
    HostB->>HostB: "晋升 Epoch=2, hostBaseMs=max(wall, medianWitnessPt+1), 更新 Retained Beacon"
    Phones<-->HostB: "新设备 B 触发 SAS 核验 -> 重标定零点 -> CRDT 反熵吸收 2 小时全量字段与排班"

    Note over HostA,HostB: "阶段 5 (03:15): 极端分支 — 原主机 A 奇迹复活触发 Fencing"
    HostA->>MQTT: "复活广播旧心跳 (epoch=1)"
    HostB-->>HostA: "回弹 epoch_superseded (epoch=2)"
    Phones-->>HostA: "手机同步拒收 epoch=1 并回弹 epoch=2"
    HostA->>HostA: "Fencing 生效! 强制降级 Standby Client 连入 HostB"
    HostA<-->HostB: "CRDT 双向反熵 -> HostA 暴毙前独占记录无损合流到 HostB 与全员手机"

    Note over HostC,Phones: "阶段 6 (03:30): 兜底路径 — 空库裸机 C 输邀请码接管 + 队友代传救回"
    HostC->>HostC: "HostB 与 S2 离线，全新空库电脑 C 登录 Lead 并输入 6 位邀请码"
    HostC->>MQTT: "HOST_DISCOVERY -> 从 S1 收 EPOCH_WITNESS 还原权威 E100 入 H2 #3"
    HostC->>HostC: "晋升 Epoch=3 -> S1 与 HostC 反熵同步，代传 S2 带 ECDSA 签名的历史记录无损恢复"
```

---

### 3.5 后端多实例隔离与临时 H2 生命周期改造（为极端 E2E 铺路）

为了在一个测试脚本内并发拉起 3 个互不干扰的 Java 后端实例，且保证测试结束（含异常中断）后自动删尽临时 H2 文件，改造以下 3 处 Java 代码：

1. **[AppConfig.java](file:///e:/AppDevelope/ScoutingPro27/Backend/src/main/java/com/bear27570/app/db/AppConfig.java#L119-L193)**：
   - 支持 `SCOUTING_DATA_DIR` 环境变量与 `scouting.data.dir` JVM 系统属性（以及 CLI 参数 `--data-dir=<path>`，由 `Main.java` 在启动最早期写入 `System.setProperty`）。
   - 当 `SCOUTING_DATA_DIR` 非空时：
     - `resolveBaseDataDir()` 直接返回该独立目录；
     - `resolveAppDbFile()` 返回 `new File(dataDir, "app_data")`；
     - `resolveJwtSecretFile()`、`resolveMasterKeyFile()`、`resolveLogDir()` 全部收口到该临时目录内，**彻底杜绝污染项目根目录 `app_data.mv.db` 与 `log/`**；
     - `resolveAppDbUrl()` 若未显式传入 `DB_URL`，且检测到 `--no-auto-server`（或 `scouting.noAutoServer=true`），拼装 `AUTO_SERVER=FALSE`（避免多 JVM E2E 争抢 H2 Auto-Server TCP 端口，并加快 Windows 文件句柄释放）。
2. **[Main.java](file:///e:/AppDevelope/ScoutingPro27/Backend/src/main/java/com/bear27570/app/Main.java#L44-L60)**：
   - 在调用 `setupFileLogging()` 之前先解析 `--data-dir=` 和 `--no-auto-server` 参数，确保连日志文件也写入各自的隔离目录，多实例间零写文件锁冲突。
3. **[ApiRoutes.java](file:///e:/AppDevelope/ScoutingPro27/Backend/src/main/java/com/bear27570/app/routes/ApiRoutes.java#L190-L209)**：
   - 在现有 `ENABLE_TEST_CLEANUP=true` 安全门控代码块内新增 `POST /api/test/shutdown`：
     - 返回 HTTP 200 后在独立守护线程中依次执行 `apiRoutes.shutdown()`、`app.stop()`、`JdbiConfig.closeDataSources()`、`System.exit(0)`；
     - **Windows 关键意义**：`taskkill /f` 强杀有时会在 H2 未关闭时短暂遗留 `.mv.db` 句柄锁，优雅调用 `/api/test/shutdown` 关闭 HikariCP 与 H2 引擎后再删除临时目录，可确保 100% 干净删除不报错。

---

## 4. 分阶段实施路径与文件变更清单

### Phase 0：多实例隔离底座、Flyway `V8` 合并与 TinyBase PoC
- **目标**：打通独立临时 H2 启动/优雅关闭能力、合并生成 `V8__Custom_Turn_And_Crdt_Sync.sql` 表结构、安装 `tinybase@^10.1.0` 并对照本地 `.d.ts` 核对 `createMergeableStore` 三参数签名与 `getHlcFunctions()` 导出顺序，验证在 Vite 8 + TypeScript 6 + Vitest 下的构建与 PWA 缓存兼容性。
- **涉及文件**：
  - 修改 `Backend/src/main/java/com/bear27570/app/db/AppConfig.java`（`SCOUTING_DATA_DIR`、`--no-auto-server` 隔离）
  - 修改 `Backend/src/main/java/com/bear27570/app/Main.java`（前置解析 `--data-dir=`）
  - 修改 `Backend/src/main/java/com/bear27570/app/routes/ApiRoutes.java`（测试门控下 `/api/test/shutdown`）
  - 合并为 `Backend/src/main/resources/db/V8__Custom_Turn_And_Crdt_Sync.sql`（含 `turn_config_encrypted`、`event_crdt_state` 与签名列；配合启动期幂等 `ensureCrdtSchema` 自愈）
  - 修改 `frontend/package.json`（锁定安装 `tinybase@^10.1.0`）
  - 新增 `Backend/src/test/java/com/bear27570/app/db/AppConfigIsolationTest.java`
  - 新增 `frontend/src/__tests__/tinybaseSmoke.test.ts`（含 `maxClockSkewSeconds`、`getNow` 与 `decodeHlc` 实测）
- **验收命令**：
  - `cd Backend && mvn test`
  - `cd frontend && npm run type-check && npm test -- --run && npm run build`

### Phase 1：晶振零点时钟 + 纪元防脑裂控制面 + 共用库直进与邀请码双入口
- **目标**：上线抗毒化晶振时钟、分赛事 Epoch Fencing、独立 MQTT Retained 信标、`logout()` 不误删共享赛事数据的切号保护、以及 Dashboard 直进 + 空机邀请码 Witness 还原双入口。
- **涉及文件**：
  - 新增 `frontend/src/services/clock/calibratedClock.ts`
  - 修改 `frontend/src/utils/identityStore.ts`（伴随持久化 ECDSA P-256 签名密钥对）
  - 修改 `frontend/src/utils/crypto.ts`（ECDSA P-256 签名/验签工具函数）
  - 修改 `frontend/src/services/webrtc/signaling.ts`（`ALLOWED_SIGNAL_TYPES` 扩展 + `epoch-beacon` 独立保留主题发布/订阅）
  - 修改 `frontend/src/services/webrtc/hostElection.ts`（分赛事 `sp27_epoch_${inviteCode}`、`HOST_DISCOVERY`、`EPOCH_WITNESS`、`EPOCH_SUPERSEDED` Fencing）
  - 修改 `frontend/src/services/webrtc/hostSession.ts` / `clientSession.ts`（SAS 后自动触发 3 样本 `CLOCK_SYNC` + 重连自动重标定）
  - 修改 `frontend/src/stores/user.ts` / `frontend/src/stores/events.ts` / `frontend/src/views/DashboardView.vue`（切号隔离保护、共用库赛事列表直进主机身份识别、裸机输入邀请码先 Witness 还原权威 UUID 再进房）
  - 新增单测：`frontend/src/__tests__/calibratedClock.test.ts`、`frontend/src/__tests__/epochFencing.test.ts`、`frontend/src/__tests__/accountSwitchIsolation.test.ts`
- **验收命令**：`cd frontend && npm run type-check && npm test -- --run`

### Phase 2：TinyBase CRDT 协同数据域（Pit / 照片 Key / 标签 / 自定义字段 / 排班）与 H2 投影
- **目标**：用 TinyBase `MergeableStore` 接管协作数据域（集合表统一采用 `active: boolean` 软删墓碑并禁用 `delRow()`），实现字段级无冲突合并、单通道增量同步与**防抖 + 脏行增量 H2 投影**，U 盘离线 `.info` 包升级支持直接 `merge()`。
- **涉及文件**：
  - 新增 `frontend/src/services/crdt/crdtStore.ts`（初始化 `MergeableStore`、注入 `calibratedClock` 与 `maxClockSkewSeconds=300`、事务脏行收集、`inFlight` 串行落盘、IndexedDB 持久化与 `flushAllToH2`）
  - 新增 `frontend/src/services/crdt/webrtcCrdtSynchronizer.ts`（基于 `createCustomSynchronizer` + 48 KiB 分片 + 入站 `decodeHlc` 预检扫描与 `FORCE_CLOCK_RESYNC` 回弹）
  - 新增 `Backend/src/main/java/com/bear27570/app/routes/CrdtRoutes.java`（注册至 `ApiRoutes.java`，提供 `/api/events/{eventId}/crdt-state` 与 `dirtyRows` 增量关系表投影）
  - 修改 `frontend/src/stores/pitScout.ts`、`schedule.ts`、`customFields.ts`、`records.ts`（`teamTags` 部分）、`utils/offlineSync.ts`、`views/useEventWebRtcBridge.ts`
  - 新增单测：`frontend/src/__tests__/crdtFieldMerge.test.ts`、`Backend/src/test/java/com/bear27570/app/routes/CrdtRoutesTest.java`
- **验收命令**：`cd Backend && mvn test`、`cd frontend && npm run type-check && npm test -- --run`

### Phase 3：正赛记录接入 CRDT + 作者写时签名灾备 + 退役 `hostSeq` 与交接门闸
- **目标**：`ScoutingRecord` 迁入 CRDT 并启用**写时立即算 `authorSig`** + `member_identities` 绑定表双重验签（支持队友代传救回失联成员历史记录并防自签名冒名伪造），`isConflict` 改为纯 `computed` 派生，正式退役 `hostSeq`、`Takeover Staging Gate` 与 `HOST_HANDOFF_BATCH`。
- **涉及文件**：
  - 修改 `frontend/src/types/index.ts`、`frontend/src/stores/records.ts`（写时签名 + `isConflict` 纯派生计算，不再跨端写入广播）
  - 修改 `frontend/src/services/webrtc/channelMessageHandler.ts`、`messageDispatcher.ts`、`views/useEventWebRtcBridge.ts`（维护 `member_identities` 绑定并执行双重验签）
  - 清理并迁移受影响单测（如涉及 `hostSeq` / `Takeover Staging Gate` 的旧断言改为 CRDT 收敛与签名验权断言）
- **验收命令**：`cd Backend && mvn test`、`cd frontend && npm run type-check && npm test -- --run`

### Phase 4：极端容灾 E2E 测试重构（覆盖替换 `frontend/e2e/multi-client.test.js`）
- **目标**：按第 5 节完整规格重写 `frontend/e2e/multi-client.test.js`，跑通全栈端到端自动化验证（含临时 H2 隔离与退出自动删除强断言）。
- **涉及文件**：
  - 覆盖重写 `frontend/e2e/multi-client.test.js`（可按需拆出 `frontend/e2e/helpers/e2eBackendManager.js`）
- **验收命令**：`cd frontend && npm run test:e2e`（首次全量构建或配合 `SKIP_BUILD=1` 复跑验证）

---

## 5. 极端场景 E2E 测试详细设计规格（覆盖 `frontend/e2e/multi-client.test.js`）

### 5.1 多实例隔离与临时 H2 生命周期机制

封装 `E2EBackendInstance` 管理器，彻底消除旧版共用根目录 `app_data.mv.db` 的污染风险：
1. **实例隔离分配**：
   - 每次测试生成唯一 `runId = Date.now()`，为每个后端实例创建独立临时目录：
     `tmpDir = path.join(os.tmpdir(), 'sp27-e2e-' + runId + '-' + instanceName)`。
   - 每个浏览器实例同样分配独立的 Puppeteer `userDataDir`（`path.join(tmpDir, 'chrome-' + browserName)`），确保 `localStorage`、IndexedDB 设备身份密钥与 TOFU 存储彼此物理隔离。
   - 启动 Java 后端时注入参数与环境变量：
     - `DEV_PORT = String(port)`
     - `SCOUTING_DATA_DIR = tmpDir`
     - `DB_URL = jdbc:h2:${tmpDir.replace(/\\/g, '/')}/app_data;AUTO_SERVER=FALSE;LOCK_TIMEOUT=15000`
     - `ENABLE_TEST_CLEANUP = 'true'`
     - `SKIP_FIREWALL_CHECK = 'true'`
     - CLI 追加 `--headless --no-auto-server --data-dir="${tmpDir}"`
2. **退出清理与强制删除断言**：
   - 在 `try { ... } finally { ... }` 以及 `process.on('SIGINT' / 'SIGTERM')` 钩子中统一调用 `cleanupAll()`：
     1. 关闭所有测试 MQTT 客户端与 CDP 会话；
     2. 优雅关闭全部 Puppeteer 浏览器（超时 3 秒 `taskkill` 兜底）；
     3. 对所有存活后端依次发送 `POST http://localhost:${port}/api/test/shutdown` 并等待进程 `exit`（释放 Windows `.mv.db` 文件句柄；超时 5 秒则 `taskkill /f /t`）；
     4. 对所有 `tmpDirs` 执行 `fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })`；
     5. **终极断言**：逐个检查 `assert.strictEqual(fs.existsSync(dir), false)`，确保零临时数据库文件残留。

### 5.2 多实例仿真拓扑（3 后端 + 5 浏览器）

| 角色标识 | 后端端口 | 临时 H2 目录 | 模拟物理角色 |
| :--- | :---: | :--- | :--- |
| **`HostA` + `browserHostA`** | `7071` | `.../sp27-e2e-...-hostA` | 原主机领队电脑 A（`HostUser`） |
| **`HostB` + `browserHostB`** | `7072` | `.../sp27-e2e-...-hostB` | 队友共用库电脑 B（先登 `AssistantBob` 作备机镜像，后同机切号登 `HostUser` 直接点列表接管） |
| **`HostC` + `browserHostC`** | `7073` | `.../sp27-e2e-...-hostC` | 全新空库裸机电脑 C（从未入房，验证输入邀请码 + Witness 还原 + 队友代传救回） |
| **`browserClient1`** | 无独立后端 | 独立 `chrome-client1` | 手机看台终端 1（走 PWA/Client 隔离态） |
| **`browserClient2`** | 无独立后端 | 独立 `chrome-client2` | 手机看台终端 2（走 PWA/Client 隔离态） |

*(注：为保持与原 `multi-client.test.js` 一致的严苛网络仿真，所有浏览器继续保留 `forceRelay` TURN 注入及基于 CDP 的真实网络断线模拟，并保留基于 `window.__TEST_CLOCK_OFFSET_MS__` 的测试专用晶振/时间推进钩子。)*

### 5.3 12 步完整端到端测试矩阵

1. **Step 1 — 建房与初始零点标定**：`HostA` 创建赛事（`Epoch = 1`）；`HostB`（登录 `AssistantBob`）、`Client1`、`Client2` 输入邀请码加入；验证三者均进入 `connected` 状态，完成 SAS 核验与 3-Sample 晶振零点标定。
2. **Step 2 — 保留基线：同场同队冲突派生**：`HostA`、`Client1`、`Client2` 提交同一场（Match 1 Team 9999）记录，验证各端均派生出冲突卡片 `.is-conflict-card`。
3. **Step 3 — 抗时钟毒化双杀验证**：
   - 通过注入覆盖 `Client1` 的 `Date.now` 先跳到 **+10 年（2036 年）**，再跳到 **-1 年**，分别提交打分与修改 Pit 数据；验证生成记录的 HLC 物理时间戳仍锚定在晶振基准误差 `±5s` 内，**未被系统改表毒化**；
   - 构造一条使用 TinyBase `encodeHlc` 编码了 2036 年时间戳的恶意 `CRDT_SYNC_MSG` 推向 `HostA`；断言由 `webrtcCrdtSynchronizer.ts` 入站 `decodeHlc` 预检扫描器捕获并发出安全告警 + 回发 `FORCE_CLOCK_RESYNC`，同时被 `HostA` 的 `maxClockSkewSeconds = 300` 护栏拦截拒收，`HostA`/`Client2` 本地时钟均保持正常。
4. **Step 4 — 保留基线：在线私信 & 离线 Outbox 补推**：复刻原 Step 6.5/Step 8，验证 `HostA` 对离线 `Client1` 发消息入队 `PENDING_DELIVERY`，重连后自动冲刷成 `DELIVERED`。
5. **Step 5 — 保留基线：信令硬边界与 Anti-DoS 防护**：完整保留原 Step 9（MQTT 信号频道业务注入拦截）、Step 10（HMAC 篡改包拒绝）与 Step 11（Room-Member 发送方身份劫持防护）。
6. **Step 6 — 主机暴毙 + 2 小时离线空窗 + 多端并发字段级编辑**：
   - 先使 `Client1` / `Client2` 与 `HostB` 断开同步（或先下线），让 `HostA` 在本地录入一条**尚未广播出去的独占正赛记录**（Match 5 Team 27570）并落盘 `Temp H2 #1`；
   - **直接硬杀 `HostA` 后端进程（`killProcessTree`）并关闭 `browserHostA`**，模拟主板烧毁/彻底断电（不触发 `HOST_LEAVING` 与交接包）；
   - 将测试逻辑时钟推进 **+2 小时（7,200,000 ms）**；
   - 在 2 小时无主机离线窗口内：
     - `Client1`：修改 Match 1 队号为 `8888`（消解自身冲突）、新增 Match 2/3 记录、修改 Pit `#27570` 的 `weightLbs = 31.5`，随后**执行一次完整的 `page.reload()` 离线刷新**，验证断网冷启动时钟锚点接续不出错；
     - `Client2`：新增 Match 2/4 记录、修改 Pit `#27570` 的 `launcherType = 'Turret'`、追加 1 个 `photoKey`、为 `#27570` 添加后又软删一个旧标签（验证 `active: false` 墓碑不复活）；
     - `HostB` 上的 `AssistantBob`：离线修改 Match 10 排班指派**并同时离线录入 1 条带写时设备 ECDSA 签名的 `scouting_records`（Match 6）**，待防抖落盘进 `Temp H2 #2` 后点击 **退出登录 (`logout()`)**。
7. **Step 7 — 主路径验证：共用库电脑 B 切号免邀请码直进接管 (`Epoch = 2`)**：
   - 在 `browserHostB` 上使用与原房主相同的账号密码（`HostUser`）登录；
   - **关键断言 1**：Dashboard 页面**无需输入任何邀请码**，直接展示原权威赛事卡片；
   - 点击赛事卡片进入，1.5s 探测发现原 `HostA` 不在线，收集 `Client1/2` 的 `EPOCH_WITNESS` 后自动晋升为 **`Epoch = 2`** 主机；
   - `Client1` / `Client2` 自动重连至 `HostB`，新设备公钥触发一次 SAS 确认并重新完成晶振零点标定，随后执行 TinyBase Hash 树双向反熵同步；
   - **关键断言 2**：
     - `HostB` 的 `Temp H2 #2` 中 Pit `#27570` 同时保留 `weightLbs === 31.5`（来自 `Client1`）与 `launcherType === 'Turret'` + 新增 `photoKey`（来自 `Client2`），且 `Client2` 软删的标签保持隐藏不复活，**证明字段级与 `LWW-Element-Set` 并发无损合并**；
     - `AssistantBob` 登出前离线修改的 Match 10 排班**以及离线写时签名的 Match 6 `scouting_records`** 均完好保留并合法同步给 `Client1` / `Client2`（证明 `logout()` 隔离不丢共享赛事数据且设备级写时签名有效）；
     - 2 小时内全员打分、标签、排班全部收敛一致，且 Match 1 冲突卡片自动消失。
8. **Step 8 — 极端分支：旧主机 A 复活防脑裂 Fencing + 独占数据合流**：
   - 重新启动 `HostA` 后端（复用暴毙前的 `Temp H2 #1`，数据库里仍存有 `Epoch = 1` 与未广播的 Match 5 Team 27570 独占记录）并打开 `browserHostA`；
   - **关键断言**：`HostA` 发出 `Epoch = 1` 的 `host_hello`/`host_heartbeat` 后，被 `HostB`、`Client1`、`Client2` 集体拒收并回弹 `epoch_superseded(epoch=2)`；`HostA` 在 5 秒内自动降级为 Standby Client 连入 `HostB`；
   - CRDT 双向反熵完成后，验证 `HostA` 暴毙前残留的 Match 5 Team 27570 独占记录**无损合流出现在 `HostB`、`Client1` 与 `Client2` 上**。
9. **Step 9 — 兜底路径验证：全新空库裸机 C 输邀请码接管 (`Epoch = 3`) + 队友代传救回**：
   - 关闭 `HostB`、`HostA` 与 `Client2`（模拟原主机与队友 2 均失联），仅留 `Client1` 在场；
   - 打开全新空库 `HostC`（`Temp H2 #3`，端口 `7073`），登录 `HostUser`，此时 Dashboard 赛事列表为空；
   - 输入 6 位邀请码加入 → `HOST_DISCOVERY` 从 `Client1` 收回 `EPOCH_WITNESS` → 自动将权威 `eventId` 还原落盘进 `Temp H2 #3` 并晋升 `Epoch = 3`；
   - `Client1` 与 `HostC` 反熵合并 → **断言 `Client2` 之前录入且带有 `member_identities` 绑定 + ECDSA 签名的历史记录通过 `Client1` 代传无损恢复到空库 `HostC` 中**；
   - 紧接着构造两条恶意伪造代传记录推向 `HostC`：① 人为篡改 `totalScore`（`authorSig` 失效）；② 使用未在 `member_identities` 绑定过的自造临时 ECDSA 密钥填写 `scoutId = Client2` 并自签名 → **断言两者均被 `HostC` 双重验签严格拒绝拦截**。
10. **Step 10 — U 盘离线包 CRDT 合并验证**：通过 `offlineSync` 导出 `.info` 增量包并在离线端重复导入两次，验证 `merge()` 严格幂等且记录数/字段完全一致。
11. **Step 11 — 全员状态字节级一致性终审**：比对 `HostC`、`Client1`（及重连后的 `HostB`、`Client2`）全部赛事表的规范化快照，断言记录数、字段值、派生冲突数 **100% 相等**。
12. **Step 12 — 临时 H2 自动清理强断言**：执行 `cleanupAll()` 优雅关闭全部 3 个 Java 后端并递归删除所有临时目录，断言 3 个临时 H2 目录与 5 个浏览器临时目录 **100% 不再存在**，且项目根 `app_data.mv.db` 未被测试记录污染。

---

## 6. 风险控制、Windows 专项检查与交付验收门禁

1. **Flyway 迁移版本合并与自愈策略**：
   - 经用户确认当前版本尚未对外发布，已将 `V8__Custom_Turn_Config.sql` 与原 `V9` 内容统一合并为 `V8__Custom_Turn_And_Crdt_Sync.sql`，并禁止修改历史 `V1`–`V7`；启动期通过 `CrdtProjectionService.ensureCrdtSchema(jdbi)` 幂等补齐本地开发库可能缺失的表与列。
2. **Windows H2 文件锁与权限核验**：
   - E2E 运行结束后必须真实核验 Windows 下临时 `.mv.db` / `.trace.db` 是否因优雅 `/api/test/shutdown` 彻底释放锁句柄并被 `fs.rmSync` 删除干净，不得遗留锁定垃圾目录。
3. **严禁“单测代替端到端”**：
   - 每个 Phase 交付前均须按证据三要素（实际执行命令 + 完整原始输出 + 客观结论）核验：
     - 后端：`cd Backend && mvn test`
     - 前端类型与单测：`cd frontend && npm run type-check && npm test -- --run`
     - 前端构建：`cd frontend && npm run build`（同步校验 PWA Workbox 构建不超限）
     - 全栈极端容灾 E2E：`cd frontend && npm run test:e2e`
