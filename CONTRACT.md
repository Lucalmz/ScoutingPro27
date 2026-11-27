# ScoutingPro27 API, Sync & Architecture Contract (`CONTRACT.md`)

> **多 Agent 节能阅读规范（必读）**：
> 1. 任何开发、排障或测试任务，**必须先读取 `§0`（快速导航目录与文件归属矩阵）** 定位目标章节的行号范围与所属源码。
> 2. 定位后，**仅使用 `read_file(Path, StartLine, EndLine)` 按需加载对应章节**，严禁一次性通读整份 `CONTRACT.md` 浪费上下文 Token。
> 3. 任何新增、修改或删除接口、数据结构、Schema、Bridge 或存储键的操作，必须在同一任务中同步更新 `CONTRACT.md` 对应章节与 `§0` 行号索引。

---

## 0. 快速导航目录与多 Agent 并行改码分片地图

### 0.1 章节行号索引表 (Table of Contents)

| 章节 | 行号范围 (`[StartLine, EndLine]`) | 核心域与契约内容 | 主要关联文件 |
| :--- | :--- | :--- | :--- |
| 全局约定 | `[62, 86]` | 全局鉴权、JWT 规范、异常映射与前端 API 客户端约定 | `ApiRoutes.java`, `JwtUtil.java`, `services/api.ts`, `crdtApi.ts` |
| §0 | `[10, 58]` | 快速导航目录与多 Agent 并行改码分片地图 | `CONTRACT.md` |
| §1 | `[90, 156]` | 用户与鉴权模块（注册/登录/校验/改名/账号合并） | `UserRoutes.java`, `UserDao.java`, `stores/user.ts` |
| §2 | `[160, 213]` | 系统与网络模块（网卡探测/防火墙/日志/测试清理） | `SystemRoutes.java`, `NetworkUtil.java` |
| §3 | `[217, 359]` | 信令、WebRTC 安全票据、混合信道、主备选举与 P2P 协议 | `SignalingRoutes.java`, `WebRtcRoutes.java`, `services/webrtc/*` |
| §4 | `[363, 456]` | 赛事、成员、TURN 配置与禁选战队模块 | `EventRoutes.java`, `EventDao.java`, `stores/events.ts` |
| §5 | `[460, 492]` | 战队标签模块 | `TeamTagRoutes.java`, `model/TeamTag.java` |
| §6 | `[496, 551]` | 赛程与排班模块 | `ScheduleRoutes.java`, `stores/schedule.ts` |
| §7 | `[555, 697]` | 比赛侦察记录、`rawData` 架构与 ECDSA 签名协议 | `RecordRoutes.java`, `RecordDao.java`, `EcdsaRecordVerifier.java`, `stores/records.ts` |
| §8 | `[701, 814]` | Pit 展位侦察、官方战队底册与照片存储模块 | `PitScoutRoutes.java`, `PitScoutDao.java`, `stores/pitScout.ts` |
| §9 | `[818, 976]` | 自定义字段与公式引擎（文法/函数/命名空间/DAG） | `CustomFieldRoutes.java`, `FormulaValidator.java`, `utils/formula/*` |
| §10 | `[980, 1033]` | CRDT 状态快照与 TinyBase 8 表关系投影 | `CrdtRoutes.java`, `CrdtProjectionService.java`, `services/crdt/*` |
| §11 | `[1037, 1207]` | FTC 官方数据代理与晋级分汇算（Java + TS 双端同步） | `FtcProxyRoutes.java`, `AdvancementCalculator.java`, `advancement.ts` |
| §12 | `[1211, 1605]` | AI Copilot 配置、连通探测、SSE 流式、实时语音与多会话 | `AiRoutes.java`, `routes/ai/*`, `stores/ai.ts`, `components/ai/*` |
| §13 | `[1609, 1639]` | JCEF 桌面容器、静态托管与前端全局桥接 | `Main.java`, `desktopShell.ts`, `stores/connection.ts` |
| §14 | `[1643, 1697]` | 运行时存储路径、H2/HikariCP/Flyway 与 CLI/环境变量 | `Main.java`, `AppConfig.java`, `JdbiConfig.java` |
| §15 | `[1701, 1860]` | H2 数据库 Schema 与索引契约（V1–V10 + 启动自愈） | `resources/db/V*.sql`, `CrdtProjectionService.java`, `AiSchemaBootstrap.java` |
| §16 | `[1864, 1941]` | 前端持久化存储、Pinia Stores、路由、i18n 与离线同步格式 | `stores/*`, `router/index.ts`, `i18n.ts`, `offlineSync.ts` |

### 0.2 统一模块文件与测试归属矩阵 (Unified Ownership Matrix)

| 模块 / 子系统 | 后端源码 (`Backend/src/main/java/com/bear27570/app/...`) | 前端源码 (`frontend/src/...`) |
| :--- | :--- | :--- |
| **全局鉴权 / JWT** | `routes/ApiRoutes.java`, `util/JwtUtil.java` | `services/api.ts`, `utils/errorHelper.ts` |
| **§1 用户与鉴权** | `routes/UserRoutes.java`, `model/User.java`, `dao/UserDao.java`, `db/UserDeterministicIdMigrator.java` | `services/api.ts`, `stores/user.ts`, `utils/userId.ts`, `types/index.ts` |
| **§2 系统与网络** | `routes/SystemRoutes.java`, `util/NetworkUtil.java`, `util/PortForwardingService.java` | `services/api.ts` |
| **§3 信令与 WebRTC** | `routes/SignalingRoutes.java`, `routes/WebRtcRoutes.java` | `services/webrtc/{index,signaling,hostElection,sasManager,epochStore,virtualDataChannel,selfHealing,channelPhotoHandler,types}.ts`, `services/dataChannelSender.ts`, `stores/connection.ts`, `utils/crypto.ts`, `types/index.ts` |
| **§4 赛事与成员** | `routes/EventRoutes.java`, `model/{ScoutingEvent,TurnServerConfig,EventMember}.java`, `dao/EventDao.java` | `services/api.ts`, `stores/events.ts`, `types/index.ts` |
| **§5 战队标签** | `routes/TeamTagRoutes.java`, `model/TeamTag.java` | `services/api.ts`, `types/index.ts` |
| **§6 赛程与排班** | `routes/ScheduleRoutes.java`, `model/{MatchScheduleItem,ScoutAssignment}.java` | `services/api.ts`, `stores/schedule.ts`, `types/index.ts` |
| **§7 比赛记录与签名** | `routes/RecordRoutes.java`, `model/ScoutingRecord.java`, `dao/RecordDao.java`, `util/EcdsaRecordVerifier.java` | `services/api.ts`, `stores/records.ts`, `services/crdt/recordSignature.ts`, `utils/{crypto,offlineSync}.ts`, `types/index.ts` |
| **§8 Pit 与底册** | `routes/PitScoutRoutes.java`, `model/{PitScoutingRecord,OfficialTeam}.java`, `dao/PitScoutDao.java` | `services/api.ts`, `stores/pitScout.ts`, `services/{photoStorage,mobilePhotoCache}.ts`, `types/index.ts` |
| **§9 自定义字段与公式** | `routes/CustomFieldRoutes.java`, `model/CustomFieldDefinition.java`, `dao/CustomFieldDao.java`, `util/FormulaValidator.java` | `services/api.ts`, `stores/customFields.ts`, `utils/formula/{types,tokenizer,parser,functions,evaluator,dependencyGraph,dataSources,templates,index}.ts`, `shared/formula-conformance-cases.json` |
| **§10 CRDT 快照与投影** | `routes/CrdtRoutes.java`, `service/CrdtProjectionService.java` | `services/crdt/{crdtApi,crdtPersistence,crdtStore,crdtStoreBridge,crdtChunker,hlcGuard,schema,webrtcCrdtSynchronizer,index}.ts` |
| **§11 FTC 代理与晋级分** | `routes/FtcProxyRoutes.java`, `util/{FtcApiClient,AdvancementCalculator}.java` | `services/api.ts`, `services/ftcApi.ts`, `utils/analytics/advancement.ts`, `types/index.ts` |
| **§12 AI 路由与中继** | `routes/AiRoutes.java`, `routes/ai/{AiProfileRoutes,AiStreamAndProbeRoutes,AiThreadRoutes,AiVoiceRoutes,AiUrlGuard,AiSchemaBootstrap}.java`, `util/AiClient.java`, `util/ai/{AiProxyResolver,AiStreamSupport,AiVoiceRelaySession,AbstractVoiceWsRelay,GeminiLiveRelaySession,OpenAiRealtimeRelaySession,OpenAiProtocolAdapter,GeminiProtocolAdapter,AnthropicProtocolAdapter}.java`, `model/{AiProviderProfile,AiSettings,AiChatThread,AiChatSession}.java`, `dao/{AiProviderProfileDao,AiSettingsDao,AiChatThreadDao,AiChatSessionDao}.java` | `stores/ai.ts`, `stores/aiModules/{aiDockState,aiProfiles,aiThreads,aiStreaming}.ts`, `components/ai/{constants,personas,presets,protocolCatalog,keyMatcher,contextBuilder,useAiChatStream,teamMatcher,exportThread}.ts`, `components/ai/voice/{useAiVoiceSession,voiceCatalog,audioEngine}.ts`, `components/ai/**/*.vue`, `types/index.ts` |
| **§13–§15 桌面/配置/DB** | `Main.java`, `SplashScreen.java`, `db/{AppConfig,JdbiConfig}.java`, `ui/{CustomTitleBar,WindowResizer}.java`, `Backend/src/main/resources/db/V*.sql` | `utils/desktopShell.ts` |
| **§16 路由/存储/工具/分析** | — | `router/index.ts`, `i18n.ts`, `locales/{en,zh}.json`, `stores/{navigation,inbox,toast}.ts`, `utils/{identityStore,tournament,bragIndex,errorHelper,csvExport,pwaUpdater}.ts`, `utils/analytics/{npOpr,rankings,predictCycleTime,audit}.ts` |

- **测试目录、质量门禁与分工契约**：
  - **后端测试 (`Backend/src/test/java/com/bear27570/app/`)**：按模块对应 `db/`、`routes/`（含 `RouteTestSupport.java` 与 `*RoutesTest.java`）、`service/`、`ui/`、`util/`；JaCoCo 构建期门禁 `LINE COVEREDRATIO >= 0.76`（`Backend/pom.xml`）。
  - **前端单测与类型检查**：Vitest 单测位于 `frontend/src/__tests__/*.test.ts`（覆盖率门禁 `statements >= 77%`, `lines >= 77%`，`@vitest/coverage-v8`）。类型检查采用渐进式 `tsconfig.vitest.json`（保留对全部业务源码与非遗留/新增单测的严格校验，显式排除 35 个早期局部 Mock 历史测试文件以避免大面积重写无关旧用例）。
  - **端到端 E2E 测试 (`frontend/e2e/*.e2e.js`)**：基于 **Puppeteer + Node `assert`**（辅助工具在 `frontend/e2e/helpers/`；`ensureE2eBuildArtifacts()` 在单独运行 `test:e2e:qr` / `inbox` / `interactive` 时自动构建含 `VITE_ENABLE_E2E_BRIDGE=true` 的前端产物；`capture-userguide-screens.js` 使用 `os.tmpdir()` 隔离 `--data-dir` 避免污染仓库根目录数据库）。真实 WebRTC ICE / PeerConnection / MQTT Broker / JCEF 全链路集成由 Puppeteer E2E 兜底，单测专注状态机、安全不变量与协议分支。

---

> **全局鉴权与拦截规则（`ApiRoutes.java` / `JwtUtil.java`）**
> - **默认鉴权**：所有 `/api/*` 请求默认必须携带 `Authorization: Bearer <jwt_token>`；缺失、签名/Claim 无效、或 `scope === "webrtc:handshake"` 返回 `401 Unauthorized`（纯文本 `"Missing or invalid token"` / `"Invalid or expired token"` / `"User does not exist or database was reset; please log in again"`）。`OPTIONS` 预检请求直接放行。
> - **免鉴权白名单**：
>   - `GET /api/user/check`、`POST /api/user/verify-token`、`POST /api/user/register`、`POST /api/user/login`（过滤器按路径精确匹配放行）
>   - `GET /api/system/network-info`、`POST /api/system/open-firewall-cmd`（免 JWT 鉴权，但严格限制本机回环地址 `127.0.0.1`/`::1`，局域网远端调用返回 `403`）、`POST /api/system/log`
>   - `GET /api/events/{eventId}/pit/photos/{key}`（仅 `GET`，供原生 `<img>` 标签加载）
>   - `POST /api/test/cleanup`（鉴权过滤器无条件放行；仅在 `ENABLE_TEST_CLEANUP` 环境变量或 `-DENABLE_TEST_CLEANUP` JVM 属性 `trim()` 后忽略大小写等于 `"true"` 时注册路由，未开启时返回 `404`）
>   - `POST /api/test/shutdown`（仅在 `ENABLE_TEST_CLEANUP=true` 时注册路由并加入免鉴权白名单；未开启时无 Token 返回 `401`，携带有效 Token 返回 `404`）
>   - `WS /ws/signal/{room}`、`WS /ws/ai/voice`（位于 `/api/*` 过滤器之外；`/ws/ai/voice` 采用首帧 `start.token` JWT 鉴权，10 秒超时断开）
> - **JWT 签发与校验规范（`JwtUtil.java`）**：
>   - 签名算法：HMAC-SHA256（密钥持久化于 `jwt.secret`，缺失时生成 32 字节随机 Base64）。
>   - API Token Claims：`iss="ScoutingPro27"`、`scope="api:full"`、`userId`、`username`、TTL **7 天**（`7L * 24 * 3600 * 1000` ms）。`verifyTokenClaims` 显式拒绝 `scope="webrtc:handshake"`。
>   - WebRTC 握手票据 Claims：`iss="ScoutingPro27"`、`sub="WEBRTC_HANDSHAKE"`、`scope="webrtc:handshake"`、`userId`、`username`、`eventId`（规范化为赛事 UUID）、`pkHash = sha256Hex(ecdhPublicKey.trim().toLowerCase())`、TTL **180 秒**（`3 * 60 * 1000` ms）。
> - **确定性用户 ID 自愈头**：当旧 UUID Token 对应用户已在数据库中迁移为确定性 ID 时，全局过滤器与 `/api/user/verify-token` 自动按 `username`（`findRegisteredByUsername`）匹配并在响应头下发 `X-Refreshed-Token: <new_jwt_token>`。
> - **全局异常与错误响应映射**：
>   - `JsonSyntaxException` → `400` 纯文本 `"Invalid JSON body"`。
>   - `NullPointerException` → `500` JSON `{"error":"Internal server error: unexpected null pointer"}`。
>   - 未捕获 `Exception` → `500` JSON `{"error":"Internal server error"}`（若响应已提交且客户端断开则忽略）。
>   - **例外**：Javalin `HttpResponseException`（`400`/`401`/`403`/`404`/`409`）返回纯文本错误消息；`UserRoutes`（`/register`、`/login`、`/rename`、`/merge`）及 `/api/test/cleanup` 内部捕获 `Exception` 并返回纯文本 `500`（如 `"Internal Server Error"` / `"Internal Server Error: ..."` / `"Cleanup Failed: ..."`）。
>
> **前端 API 客户端约定（`frontend/src/services/api.ts` & `services/crdt/crdtApi.ts`）**
> - **Base URL**：所有 HTTP 请求经由相对路径 `/api` 发起；自动从 `localStorage['scoutingpro-user']` 读取 `token` 写入 `Authorization: Bearer <token>`，超时默认 `8000ms`（超时抛出 `LocalApiTimeoutError`）。
> - **静态云端托管降级**：当 `window.location.hostname` 匹配 `github.io` / `pages.dev` / `vercel.app` / `netlify.app` / `gitlab.io`，或探测到 `404` HTML 响应时，切换至 `handleStaticHostFallback`（`/user/merge`、`/users/merge`、`/records`（`POST`/`PUT`）、`/pit-records`（`POST`/`PUT`）、`/pit/records`（`POST`/`PUT`）与 `/pit/photos` 上传显式 reject 以回退 WebRTC；其余读/登录接口返回零延迟合成响应）。
> - **透明续期**：`api.ts` 与 `crdtApi.ts` 均读取响应头 `x-refreshed-token`，若存在则原地更新 `localStorage['scoutingpro-user'].token`。
> - **401 自动登出豁免**：除 `/user/rename`、`/user/login`、`/webrtc/verify-ticket`、`/users/merge`、`/user/merge` 外，`api.ts` 与 `crdtApi.ts`（`GET/PUT /api/events/{eventId}/crdt-state`）收到 `401` 均清除 `localStorage['scoutingpro-user']` 并派发 `window` 事件 `'auth-unauthorized'` 触发登出。

---

## 1. 用户与鉴权模块 (`UserRoutes`)

> **用户查询与占位符语义（`UserDao.java`）**：`findRegisteredByUsername(username)` 执行 `LOWER(TRIM(username)) = LOWER(TRIM(:username)) AND password != '' AND password IS NOT NULL LIMIT 1`，即**大小写不敏感、自动 `trim()`、且忽略无密码占位符账号**。

### `GET /api/user/check`
- **说明**：检查已注册用户名是否已存在（免鉴权，忽略无密码占位符）。
- **Request**：
  ```ts
  interface CheckUserQuery {
    username: string; // Query 参数
  }
  ```
- **Response**：`{ exists: boolean }`
  - 错误码：`400` (`"username required"`)

### `POST /api/user/verify-token`
- **说明**：校验 JWT Token 有效性；若用户经历了确定性 ID 迁移则自动签发新 Token（免鉴权）。
- **Request**：`{ token: string }`
- **Response**：
  ```ts
  interface VerifyTokenResponse {
    valid: true;
    userId: string;
    username: string;
    token?: string; // 仅触发迁移自愈时返回（同时写入 X-Refreshed-Token 响应头）
  }
  ```
  - 错误码：`400` (`"token required"`), `401` (`"Invalid token signature"`), `404` (`"User not found"`)

### `POST /api/user/register`
- **说明**：注册新账号（BCrypt 加密密码），生成确定性 `userId`（基于 `username.trim()`）与 JWT Token（免鉴权）；若该确定性 `userId` 为无密码占位符且用户名为空、同名或由 `external-sync` 创建的 `"Host <6-char-prefix>"`，则直接认领激活该占位符。若 `users` 表中该确定性 `userId` 已被其他已设密（如曾改名）或不同用户名的占位符账号占用，自动回退生成随机非碰撞 UUID (`UUID.randomUUID()`)，绝不覆盖既有注册账号。
- **Request**：
  ```ts
  interface RegisterBody {
    username: string; // trim() 后 1..50 字符
    password: string; // 1..72 字符（必填非空；不执行 trim() 以保留用户原始密码字符）
  }
  ```
- **Response**：`AuthUserResponse` (`{ id: string; username: string; token: string }`)
  - 错误码：`400` (`"Invalid JSON body"` / `"username and password required"` / `"username or password too long"`), `409` (`"User already exists"`), `500` (`"Internal Server Error"`)
  - *注*：`types/index.ts` 中 `LoginRequest` 保留 `password?: string` 供静态云端托管（PWA）合成登录降级复用，后端在线接口强制要求非空。

### `POST /api/user/login`
- **说明**：用户名（`trim()` + 大小写不敏感）密码登录并签发 JWT Token（免鉴权）。
- **Request**：`{ username: string; password: string }`
- **Response**：`AuthUserResponse` (`{ id: string; username: string; token: string }`)
  - 错误码：`400` (`"Invalid JSON body"` / `"username and password required"`), `401` (`"Invalid credentials"`), `500` (`"Internal Server Error"`)

### `POST /api/user/rename`
- **说明**：修改当前登录用户的用户名及/或密码（`userId` 不可变；事务内锁 `DbUtil.RECORD_WRITE_LOCK` 级联更新 `scouting_records`、`scout_assignments`、`pit_scouting_records` 中的 `scout_name` 与 `updated_at`，并自增 `scouting_records` 和 `pit_scouting_records` 的 `version`）。
- **Request**：
  ```ts
  interface RenameUserBody {
    newUsername?: string; // 留空则沿用原用户名；trim() 后 <= 50 字符
    oldPassword?: string; // 传 newPassword 且原账号有密码时必填
    newPassword?: string; // 传非空则 BCrypt(12) 重设密码（长度 <= 72 字符，防 BCrypt 72 字节静默截断）
  }
  ```
- **Response**：`AuthUserResponse` (`{ id: string; username: string; token: string }`)
  - 错误码：`400` (`"Invalid JSON body"` / `"newUsername too long"` / `"newPassword too long"`), `401` (`"Unauthorized"` / `"Incorrect old password"`), `404` (`"User not found"`), `409` (`"Username already taken"`), `500` (`"Internal Server Error: ..."`)
  - *前端兼容*：`api.ts` `UpdateProfileParams` 保留历史可选字段 `newId?: string`，后端忽略该字段。

### `POST /api/user/merge`（别名：`POST /api/users/merge`）
- **说明**：将当前登录账号（`sourceId`）的所有赛事归属、侦察记录、排班、标签、AI 会话等通过 `UserDeterministicIdMigrator.mergeUserInto` 原子级联迁移至目标已注册账号（`targetUsername`），并返回目标账号 Token。若 `target.id === sourceId`，校验密码后直接幂等返回目标账号与新 Token。
- **Request**：`{ targetUsername: string; targetPassword: string }`（后端仅对 `targetUsername` 执行 `trim()`，`targetPassword` 保留原始首尾空白字符以与 `/register`、`/login` 一致）
- **Response**：`AuthUserResponse` (`{ id: string; username: string; token: string }`)
  - 错误码：`400` (`"Invalid JSON body"` / `"targetUsername and targetPassword required"`), `401` (`"Unauthorized"` / `"Invalid target account password"`), `404` (`"Target user not found"`), `500` (`"Internal Server Error: ..."`)

---

## 2. 系统与网络模块 (`SystemRoutes` / `ApiRoutes`)

### `GET /api/system/network-info`
- **说明**：探测宿主机操作系统、活动局域网 IPv4（优先移动热点段 `192.168.137.*`/`192.168.43.*`/`172.20.10.*`）与全球单播 IPv6 (`2000::/3`，剥离 `%scope_id`)、当前端口、Windows 防火墙状态与扫码加入基础 URL（免鉴权）。
- **Request**：无
- **Response**：
  ```ts
  interface NetworkInfoResponse {
    os: 'windows' | 'macos' | 'linux' | 'unknown';
    isWindows: boolean;
    isMac: boolean;
    primaryIp: string;        // 无可用网卡时回退 "127.0.0.1"
    allIps: string[];
    primaryIpv6: string | null;
    allIpv6s: string[];
    port: number;
    firewallAllowed: boolean; // 非 Windows 恒为 true
    firewallCommand: string;
    macFirewallCommand: string;
    joinBaseUrl: string;
    joinBaseUrlIpv6?: string; // 仅当 primaryIpv6 非空时返回
  }
  ```

### `POST /api/system/open-firewall-cmd`
- **说明**：在 Windows 主机触发 UAC 弹窗放行当前端口与 JCEF helper 防火墙规则（免 JWT 鉴权，但严格校验底层 socket `ctx.req().getRemoteAddr()` 为本机回环地址，忽略可伪造的 `X-Forwarded-For`，防止赛场公共 Wi-Fi 对端恶意触发主机 UAC 弹窗）。
- **Request**：无
- **Response**：
  ```ts
  interface OpenFirewallResponse {
    success: boolean; // success && allowed
    allowed: boolean;
    command: string;
    port: number;
    os: string;       // 注意：返回原始 System.getProperty("os.name").toLowerCase()（如 "windows 11"），非标准化 osType
  }
  ```
  - 错误码：`403` (`{ error: "Firewall configuration is restricted to local host loopback" }`)

### `POST /api/system/log`
- **说明**：将远端客户端文本日志以单行 `[ISO_LOCAL_DATE_TIME] [RemoteClient-<ip>] <escapedBody>` 格式追加写入主机 `<logDir>/scoutingpro_*.log`（免鉴权；单次请求上限 `16,384` 字符，且自动将 `\r\n`/`\r`/`\n` 转义为字面量 `\n` 防止日志伪造与大包刷盘 DoS）。
- **Request**：`Body: string`（纯文本，`<= 16,384` 字符）
- **Response**：`{ success: true }`
  - 错误码：`400` (`{ error: "Log payload exceeds 16 KB limit" }`)

### `POST /api/test/cleanup`（仅 `ENABLE_TEST_CLEANUP=true`）
- **说明**：按用户名数组级联删除其主持的 `events`（依赖 DB `ON DELETE CASCADE`）与 `users` 记录（免鉴权；未开启时返回 `404`）。
- **Request**：`Body: string[]`
- **Response**：`200 ("Cleanup OK")` / `500 ("Cleanup Failed: <msg>")` / `404`（未开启时）

### `POST /api/test/shutdown`（仅 `ENABLE_TEST_CLEANUP=true`）
- **说明**：延迟 100ms 触发后端优雅停机（开启时免鉴权；未开启时无 Token 返回 `401`，携带有效 Token 返回 `404`）。
- **Request**：无
- **Response**：`200` `{ status: "shutting_down" }` / `401` / `404`

---

## 3. 信令、WebRTC 安全票据与 P2P 同步协议 (`SignalingRoutes` / `WebRtcRoutes` / `services/webrtc/*`)

### `WS /ws/signal/{room}`
- **说明**：离线局域网 WebSocket 信令中继房间；收到文本帧后原样广播给同 `{room}` 内除发送方外的所有在线对端。
- **Request / Response**：Path `{ room: string }`（赛事邀请码，**非** UUID），文本帧为 JSON 序列化的签名信令信封。

### `POST /api/webrtc/handshake-ticket`
- **说明**：赛事成员获取绑定自身 `userId`、`eventId`（UUID）与 `ecdhPublicKey` SHA-256 指纹的短期 WebRTC 握手票据。
- **Request**：`{ eventId: string /* UUID 或 inviteCode */; ecdhPublicKey: string }`
- **Response**：`{ ticket: string; expiresIn: number /* 180 秒 */ }`
  - 错误码：`400` (`"Invalid JSON body"` / `"eventId and ecdhPublicKey are required"`), `403` (`"User is not a member of this event"`), `404` (`"User not found"` / `"Event not found"`)

### `POST /api/webrtc/verify-ticket`
- **说明**：校验对端 WebRTC 握手票据签名、赛事归属及 `ecdhPublicKey` 指纹是否匹配。
- **Request**：`{ ticket: string; eventId: string /* UUID 或 inviteCode */; ecdhPublicKey: string }`
- **Response**：
  - 校验通过或票据无效/过期/指纹不匹配时均返回 **HTTP `200`**：
    ```ts
    type VerifyTicketResponse =
      | { valid: true; userId: string; username: string; eventId: string }
      | { valid: false; error: string };
    ```
  - 其他错误码（其中 `403`/`404` 返回 JSON `{ valid: false, error }`）：`400` (`"Invalid JSON body"` / `"ticket, eventId, and ecdhPublicKey are required"`), `401` (`"Missing or invalid token"`), `403` (`{ valid: false, error: "Caller is not a member of this event" }`), `404` (`{ valid: false, error: "Event not found" | "User not found" }`)

### WebRTC 混合信令、主备选举与 P2P DataChannel 协议（`frontend/src/services/webrtc/*`）
1. **双栈信令信道（`signaling.ts`）**：
   - **Topic 派生**：`roomHash = sha256Hex(room + '-scoutingpro27')`，信令 Topic 为 `scoutingpro27/signal/${roomHash}`，保留信标 Topic 为 `${topic}/epoch-beacon`（MQTT `retain: true, qos: 1`）。
   - **内置公网 MQTT Failover**：`emqx` (`wss://broker.emqx.io:8084/mqtt`) → `hivemq` (`wss://broker.hivemq.com:8884/mqtt`) → `mosquitto` (`wss://test.mosquitto.org:8081/mqtt`)；支持 `localStorage['sp27-custom-broker']` 或 `'lan'`（原生 WS `/ws/signal/{room}`）。MQTT 模式下自动挂载伴随局域网 WS 桥（`/ws/signal/{room}`）实现双发与 180ms SUBACK 兜底。
   - **安全信封与硬隔离**：每条信令自动注入 `sender` (`clientId`)、`timestamp`、`nonce` 与基于房间派生的 HMAC-SHA256 `signature`；接收端通过 `NonceLruCache(5000, ±15min)` 防重放并拦截一切 `BUSINESS_TYPES`（22 种业务消息禁止走信令）。
   - **信令白名单 (`ALLOWED_SIGNAL_TYPES`)**：`offer`, `answer`, `candidate`, `host_hello`, `client_hello`, `host_probe`, `host_heartbeat`, `host_takeover`, `HOST_LEAVING`, `key_exchange`, `sas_challenge`, `sas_verified`, `sas_rejected`, `sas_retry`, `host_discovery`, `epoch_witness`, `epoch_superseded`（另允许含 `offer`/`answer`/`candidate`/`encrypted` 载荷的帧）。
   - **保留任期信标 (`EpochBeaconPayload`)**：`{ type: 'epoch_beacon', inviteCode, hostEpoch, hostSessionId, hostDeviceId, hostUserId, authoritativeEventId, eventName, ftcYear?, ftcEventCode?, publishedAt, sender, signature? }`（绕过 15 分钟 Nonce 过期，仅校验 HMAC）。
2. **主备选举与 Epoch Fencing（`hostElection.ts` / `epochStore.ts`）**：
   - 仅桌面端可成为 Host（`isMobileDevice()` 强制禁止）。启动时先进入 `1500ms` `host_probe` + `host_discovery` 探测窗口；无人应答则按 `priorMax` / 跨设备升任递增 `hostEpoch` 并发布 `host_hello` + `epoch_beacon`。
   - **确定性权威比较器 (`compareHostAuthority`)**：先比 `hostEpoch`（大者胜），平局比 `sessionId` 字典序（小者先占胜），再比 `deviceId` 字典序（小者胜）。落败方收到 `epoch_superseded` 或更高权威心跳后立即降级为 Standby/Client。
   - **优雅退场 (`HOST_LEAVING`)**：Host 调用 `disconnect()` 时广播 `{ type: 'HOST_LEAVING', hostSessionId, deviceId }` 并关闭所有 `clients`/`stagedClients` 连接；Client 收到后立即 `hardResetChannels()`、置状态为 `offline` 并触发 `onActiveHostLeft`。
3. **ECDH + SAS 信任门禁（`sasManager.ts`）**：
   - 首连执行 ECDH 密钥交换并可选校验证书票据；未在 `localStorage['scoutingpro_verified_sas_<inviteCode>_<pubHex>']` 或 IndexedDB 信任库记录的对端进入 `PENDING_VERIFICATION` 状态，所有入站/出站业务帧入队门禁，直至双方用户 `confirmSas` 放行或 `rejectSas` 立即断开。
4. **虚拟 DataChannel、自愈、ICE 优先级保留与心跳韧性（`virtualDataChannel.ts` / `selfHealing.ts` / `iceCandidateOptimizer.ts` / `clientHeartbeat.ts`）**：
   - 原生 UDP 打洞超时时，通过 `SignalingChannel` 传输 ECDH AES-256-GCM 密文 `{ encrypted, clientSessionId }`（内层接受 `{ vdc: 'open' | 'data', sessionId, payload? }`）；原生通道恢复后支持 `startDrain(5000, 1000)` 无感热切回。
   - `selfHealing.ts`：网络 `online` 与页面 `visible` 恢复时受 `THROTTLE_MS = 1200`、`RESUME_DEBOUNCE_MS = 500` 及 `connecting < 15000ms` 保护；Host 侧 `handleOnline` 保留 `connected`/`waiting`/`connecting` 态，`handleResume` 保留除 `offline`/`long_offline` 外的全部状态，严禁拆房重连。
   - `iceCandidateOptimizer.ts`：接收端（`clientSession.ts` / `hostSession.ts`）处理远端候选时必须传入 `{ preserveRemoteSrflxTier: true }`，保留发送端显式标注的代理出口降权（IPv4 `typePref = 80`，IPv6 `115`/`95`）与国内直连提权（IPv4 `95`，IPv6 `126`/`105`），同时继续清洗 TUN 虚拟 `raddr` 与 `network-cost <= 50`；`synthesizeSymmetricNatPortCandidates` 对 `incomingTypePref <= 80` 的降权代理出口候选将预测端口上限压制在 `< 80`（`Math.max(20, incomingTypePref - 2) = 78`），避免预测端口反超代理出口基准或国内直连候选。
   - `clientHeartbeat.ts`：原生通道单次 `PING` 超时按已观测 RTT 自适应缩放（`clamp(round(rttMs * 4 + 1200), 1800, 4500)` ms）；`handlePong` 即使在 `PING` 已超时出表后仍更新 `lastPongReceivedAt`、重置连续丢包计数并恢复 `degraded -> connected`；突发大数据发送期间若 `bufferedAmount` 或发送队列长度存在前向排空进展（`madeDrainProgress`），将连续未回包计数封顶于 `HEARTBEAT_DEGRADE_MISSES (2)`，防止误触发 `heartbeat_timeout (8)` 重建，而对完全僵死零进展的 SCTP 仍如期触发重建。
   - `useEventWebRtcBridge.ts`（瞬时降级/拥塞恢复门控）：Client/Standby 收到 `degraded` 时仅保守调用 `setCrdtTransportActive(eventId, false)`，保留 `openCrdtPeers` 与 `hostChannelNeedsFullSync`；同一 `'host'` DataChannel 保持打开（`openCrdtPeers.has('host') && !hostChannelNeedsFullSync`）且由 `degraded`/`unstable` 恢复至 `connected` 时，仅恢复 `setCrdtTransportActive(eventId, true)`、更新本地 CRDT 投影状态（`degraded -> connected` 时调用 `syncRecordsFromCrdt`）并刷新离线 Pit/照片队列，不重复触发 `REQUEST_SYNC` 与 `triggerFullSyncWithPeer('host')`；仅在真实 `onPeerDataChannelClose('host')` 或 `offline`/`long_offline` 后重连才重置 `hostChannelNeedsFullSync = true` 并执行全量重同步。
5. **DataChannel 业务消息协议、双车道优先级与 CRDT 分片（`WebRtcMessage` 联合类型，`types/index.ts:209-609`）**：
   - `DataChannelSender` 与 `messageDispatcher.ts`：单帧上限 `MAX_PAYLOAD_SIZE = 64 KiB`、背压超时 `5000ms`；维护 `highQueue`/`queue` 双车道 FIFO 队列，将 `PING`/`PONG`/`CLOCK_SYNC_REQ`/`CLOCK_SYNC_RES`/`FORCE_CLOCK_RESYNC` 路由至 `high` 优先级抢占大块业务分片；小控制帧（`<= 4096B`）放宽控制面背压上限至 `64 KiB`（`BUFFER_HIGH_WATERMARK * 2`），其余帧沿用 `32 KiB / 16 KiB` 水位线并在 `while (needsWait())` 循环中复检缓冲与中止状态；派发层通过 `sender.isAborted() || sender.getChannel() !== dc` 校验通道实例一致性。
   - CRDT 分片与同步超时（`crdtChunker.ts` / `webrtcCrdtSynchronizer.ts`）：`CRDT_MAX_FRAME_BYTES = 16 KiB`、`CRDT_CHUNK_DATA_CHARS = 12 KiB`（按 UTF-8 字节安全切分且不拆断代理对，确保慢速 VPN 下控制帧可平滑插队）；`createWebRtcCrdtSynchronizerHub` 默认请求超时 `requestTimeoutSeconds = 12`（12 秒）。
   - 同步与记录：`REQUEST_SYNC`、`SYNC_DATA`、`ACK_SYNC`（含 `stampedRecords`、`rejectedRecordIds`）、`CRDT_SYNC_MSG`、`CRDT_SYNC_CHUNK`
   - 时钟校准：`CLOCK_SYNC_REQ`、`CLOCK_SYNC_RES`、`FORCE_CLOCK_RESYNC`、`PING`、`PONG`
   - 照片分片：`PIT_PHOTO_UPLOAD`、`PIT_PHOTO_CHUNK`（接收端上限 `totalChunks <= 500`、5 分钟分片超时清理，`channelPhotoHandler.ts:83,104`）、`PIT_PHOTO_ACK`
   - 赛程/Pit/标签/自定义字段：`REQUEST_SCHEDULE_SYNC`、`SCHEDULE_FULL_SYNC`、`SCHEDULE_BATCH_SYNC`、`ASSIGNMENT_UPDATE`、`PIT_SCOUT_UPDATE`、`PIT_SCOUT_FULL_SYNC`、`PIT_SCOUT_BATCH_SYNC`、`PIT_SCOUT_ACK`、`REQUEST_PIT_SYNC`、`OFFICIAL_ROSTER_SYNC`、`TEAM_TAGS_UPDATE`、`REQUEST_TAGS_SYNC`、`TAGS_FULL_SYNC`、`CUSTOM_FIELDS_FULL_SYNC`、`CUSTOM_FIELD_UPDATE`、`REQUEST_CUSTOM_FIELDS_SYNC`
   - 身份/会话/消息：`EVENT_METADATA`、`IDENTITY_MIGRATION`、`ACK_MIGRATION`、`SESSION_CONFLICT`、`TAKEOVER_REQUEST`、`TAKEOVER_PROMPT`、`TAKEOVER_DECISION`、`SESSION_KICKED`、`TAKEOVER_SUCCESS`、`MERGE_ACCOUNT_REQUEST`、`MERGE_ACCOUNT_RESPONSE`、`DIRECT_MESSAGE`


### WebRTC Signaling Envelope & DataChannel `WebRtcMessage` Union

```ts
// 1. Signaling Envelope (`frontend/src/services/webrtc/signaling.ts`, `utils/crypto.ts`)
// HMAC-SHA256 key derived via PBKDF2(inviteCode, salt="scoutingpro27", 100_000 iters).
// Signature = hex(HMAC-SHA256(key, JSON.stringify(canonicalObjExcludingSignatureSortedByTopLevelKeys))).
export interface SignedSignalEnvelope {
  type?:
    | 'offer' | 'answer' | 'candidate'
    | 'host_hello' | 'client_hello' | 'host_probe' | 'host_heartbeat' | 'host_takeover'
    | 'HOST_LEAVING' | 'key_exchange'
    | 'sas_challenge' | 'sas_verified' | 'sas_rejected' | 'sas_retry'
    | 'host_discovery' | 'epoch_witness' | 'epoch_superseded'
    | 'epoch_beacon';
  sender: string;       // SignalingChannel.clientId (`sp27-<ts>-<rand>`)
  target?: string;      // Optional recipient clientId
  timestamp?: number;   // Epoch ms; checked against ±15 min NonceLruCache(5000) window (retained epoch_beacon omits both timestamp and nonce, using publishedAt)
  nonce?: string;       // Random hex nonce (retained epoch_beacon omits both timestamp and nonce, using publishedAt)
  signature?: string;   // Hex HMAC-SHA256; mandatory in production
  // Common signal payload fields (offer/answer/candidate/encrypted/hostSessionId/deviceId/hostEpoch/ecdhPublicKey/etc.)
  [key: string]: unknown;
}

export interface EpochBeaconPayload {
  type: 'epoch_beacon';
  inviteCode: string;
  hostEpoch: number;
  hostSessionId: string;
  hostDeviceId: string;
  hostUserId: string;
  authoritativeEventId: string;
  eventName: string;
  ftcYear?: number;
  ftcEventCode?: string;
  publishedAt: number;
  sender: string;
  signature?: string;
}

// 2. DataChannel `WebRtcMessage` Discriminated Union (`frontend/src/types/index.ts:209-609`)
export type WebRtcMessage =
  // Records & Sync
  | { type: 'REQUEST_SYNC'; lastSyncTime: string; sinceVersion?: number; authCode?: string; senderUserId?: string; senderUserName?: string; token?: string; hostSessionId?: string }
  | { type: 'SYNC_DATA'; records: ScoutingRecord[]; authCode?: string; senderUserId?: string; senderUserName?: string; token?: string; hostSessionId?: string }
  | { type: 'ACK_SYNC'; recordIds: string[]; stampedRecords?: ScoutingRecord[]; rejectedRecordIds?: string[]; authCode?: string; hostSessionId?: string }
  // CRDT Sync
  | { type: 'CRDT_SYNC_MSG'; eventId: string; fromClientId: string; toClientId?: string; requestId?: string | null; message: number; body: unknown; authCode?: string }
  | { type: 'CRDT_SYNC_CHUNK'; eventId: string; transferId: string; chunkIndex: number; totalChunks: number; chunkData: string; authCode?: string }
  // Clock & Keepalive
  | { type: 'CLOCK_SYNC_REQ'; reqId: string; clientMonoM1: number; authCode?: string }
  | { type: 'CLOCK_SYNC_RES'; reqId: string; clientMonoM1: number; hostNow: number; hostEpoch: number; authCode?: string }
  | { type: 'FORCE_CLOCK_RESYNC'; reason?: string; hostNow?: number; hostEpoch?: number; authCode?: string }
  | { type: 'PING'; timestamp: number; authCode?: string }
  | { type: 'PONG'; timestamp: number; authCode?: string }
  // Pit Photos
  | { type: 'PIT_PHOTO_UPLOAD'; eventId: string; key: string; dataUrl: string; authCode?: string; senderId?: string }
  | { type: 'PIT_PHOTO_CHUNK'; transferId: string; eventId: string; key: string; chunkIndex: number; totalChunks: number; chunkData: string; authCode?: string; senderId?: string }
  | { type: 'PIT_PHOTO_ACK'; eventId: string; key: string; success: boolean; authCode?: string }
  // Schedule & Assignments
  | { type: 'REQUEST_SCHEDULE_SYNC'; authCode?: string; senderId?: string }
  | { type: 'SCHEDULE_FULL_SYNC'; schedules: MatchScheduleItem[]; assignments: ScoutAssignment[]; authCode?: string }
  | { type: 'SCHEDULE_BATCH_SYNC'; batchIndex: number; totalBatches: number; schedules: MatchScheduleItem[]; assignments: ScoutAssignment[]; authCode?: string; syncId?: string }
  | { type: 'ASSIGNMENT_UPDATE'; assignment: ScoutAssignment; authCode?: string }
  // Pit Scouting & Official Roster
  | { type: 'PIT_SCOUT_UPDATE'; record: PitScoutingRecord; authCode?: string; senderId?: string }
  | { type: 'PIT_SCOUT_FULL_SYNC'; records: PitScoutingRecord[]; authCode?: string }
  | { type: 'PIT_SCOUT_BATCH_SYNC'; records: PitScoutingRecord[]; authCode?: string; senderId?: string }
  | { type: 'PIT_SCOUT_ACK'; teamNumbers: number[]; authCode?: string }
  | { type: 'REQUEST_PIT_SYNC'; authCode?: string; senderId?: string }
  | { type: 'OFFICIAL_ROSTER_SYNC'; teams: OfficialTeamInfo[]; authCode?: string }
  // Team Tags
  | { type: 'TEAM_TAGS_UPDATE'; eventId: string; teamNumber: number; tag: TeamTagItem; action: 'ADD' | 'REMOVE'; authCode?: string; senderUserId?: string; token?: string; hostSessionId?: string }
  | { type: 'REQUEST_TAGS_SYNC'; eventId: string; authCode?: string; senderUserId?: string; token?: string; hostSessionId?: string }
  | { type: 'TAGS_FULL_SYNC'; eventId: string; tags: TeamTagItem[]; authCode?: string; senderUserId?: string; token?: string; hostSessionId?: string }
  // Custom Fields
  | { type: 'CUSTOM_FIELDS_FULL_SYNC'; eventId: string; fields: CustomFieldDefinition[]; authCode?: string; senderUserId?: string; token?: string; hostSessionId?: string }
  | { type: 'CUSTOM_FIELD_UPDATE'; eventId: string; field: CustomFieldDefinition; action: 'CREATE' | 'UPDATE' | 'DELETE'; authCode?: string; senderUserId?: string; token?: string; hostSessionId?: string }
  | { type: 'REQUEST_CUSTOM_FIELDS_SYNC'; eventId: string; authCode?: string; senderUserId?: string; token?: string; hostSessionId?: string }
  // Identity, Session Takeover, Account Merge & Messaging
  | { type: 'EVENT_METADATA'; event: ScoutingEvent; authCode?: string; hostSessionId?: string }
  | { type: 'IDENTITY_MIGRATION'; eventId: string; oldScoutId: string; newScoutId: string; newScoutName: string; authCode?: string }
  | { type: 'ACK_MIGRATION'; eventId: string; newScoutId: string; authCode?: string }
  | { type: 'SESSION_CONFLICT'; conflictingUsername: string; conflictingUserId: string; conflictType?: 'SAME_USER' | 'DUPLICATE_NAME'; suggestedName?: string; rejected?: boolean; authCode?: string }
  | { type: 'TAKEOVER_REQUEST'; username: string; userId?: string; authCode?: string }
  | { type: 'TAKEOVER_PROMPT'; requesterUsername: string; timeoutSeconds: number; authCode?: string }
  | { type: 'TAKEOVER_DECISION'; username: string; permit: boolean; authCode?: string }
  | { type: 'SESSION_KICKED'; reason: string; authCode?: string }
  | { type: 'TAKEOVER_SUCCESS'; authCode?: string; message?: string }
  | { type: 'MERGE_ACCOUNT_REQUEST'; requestId: string; targetUsername: string; targetPassword: string; sourceUserId: string; sourceUsername: string; authCode?: string }
  | { type: 'MERGE_ACCOUNT_RESPONSE'; requestId: string; success: boolean; newId?: string; newUsername?: string; token?: string; error?: string; authCode?: string }
  | { type: 'DIRECT_MESSAGE'; id?: string; messageId?: string; targetId: string; targetName?: string; senderId?: string; senderName?: string; title: string; body: string; authCode?: string };
```
---

## 4. 赛事、成员、TURN 配置与禁选战队模块 (`EventRoutes`)

> **赛事权限约定**：`GET /api/events/{id}/banned-teams` 与 `GET /api/events/{id}/members` 要求调用方为当前赛事成员（`eventDao.isMember(eventId, userId)`，否则返回 `403 "Not a member of this event"`）；`PUT /api/events/{id}/ftc-config`、`PUT /api/events/{id}/turn-config`、`POST|DELETE /api/events/{id}/banned-teams*`、`POST|DELETE /api/events/{id}/members*` 均严格要求调用方为赛事 Host（`userId === event.hostId`），否则返回 `403 Forbidden`。

```ts
interface TurnServerConfig {
  urls: string[];     // 必须以 turn: 或 turns: 开头，最多 10 条
  username: string;
  credential: string;
}

interface ScoutingEvent {
  id: string;
  name: string;
  inviteCode: string;
  hostId: string;
  createdAt?: string;
  ftcYear?: number | null;
  ftcEventCode?: string | null;
  customTurnConfig?: TurnServerConfig | null;
  hasCustomTurn?: boolean;
  // turnConfigEncrypted 仅存在于后端持久化模型，响应序列化前强制置 null 剔除
}
```

### `GET /api/events`
- **说明**：获取当前登录用户（取自 JWT `userId`，忽略前端可能附带的 `?userId=` 查询参数）已加入或主持的所有赛事列表（自动解密并水合 `customTurnConfig`）。
- **Request**：无
- **Response**：`ScoutingEvent[]`

### `POST /api/events`
- **说明**：创建新赛事，自动生成终身不可变的 6 位大写邀请码（字符集 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`，避开 `I/O/0/1`，空间 $32^6 \approx 10.7$ 亿并做库内唯一校验），当前用户自动成为 Host 并加入赛事。
- **Request**：`{ name: string }`（`trim()` 后必填非空且 `<= 100` 字符）
- **Response**：`{ id: string; inviteCode: string }`
  - 错误码：`400` (`"Invalid JSON body"` / `"Event name is required"` / `"Event name cannot exceed 100 characters"`)

### `POST /api/events/join`
- **说明**：凭邀请码（`trim().toUpperCase()`）加入赛事；若本地数据库不存在该邀请码，自动创建占位符用户 `external_host`（`"External Host"`）及临时外部赛事存根 `ext_<INVITECODE>`（`name = "Remote Event (<CODE>)"`）并加入。
- **Request**：`{ inviteCode: string }`
- **Response**：`ScoutingEvent`
  - 错误码：`400` (`"Invalid JSON body"` / `"Missing inviteCode"`)

### `DELETE /api/events/{id}`
- **说明**：若调用者为赛事 Host 则彻底删除赛事；若为普通成员则仅移除 `event_users` 关联；赛事不存在时幂等返回 `204`。
- **Request**：`Path: { id: string }`
- **Response**：`204 No Content`
  - 错误码：`400` (`"Event ID required"`), `401` (`"Unauthorized"`)

### `POST /api/events/external-sync`
- **说明**：将从远端 Host 同步来的权威赛事元数据写入本地数据库（不存在 `hostId` 时自动创建 `"Host <prefix>"` 占位符用户，`name` 为空时回退 `"Event <CODE>"` 并截断至 `<= 100` 字符，同时加密或清空 `customTurnConfig`），在通过归属与邀请码不可变校验后，仅允许解绑未设密占位符或同一调用者持有的本地临时存根（`ext_*` 且非他方已设密本地用户托管，或 `hostId === "external_host"`）的 `invite_code` 并原子过户（`reparentEventData`）12 张关联表（`scouting_records`, `pit_scouting_records`, `event_official_teams`, `match_schedules`, `scout_assignments`, `team_tags`, `banned_teams`, `event_users`, `ai_chat_sessions`, `ai_chat_threads`, `event_custom_fields`, `event_crdt_state`）及物理目录 `pit_photos/<eventId>` 到权威 `eventId`（冲突行去重删除）；绝不允许将 `evt-*` 权威赛事作为临时存根解绑夺权。
  - **`inviteCode` 全局不可变与防夺权约束**：赛事 `inviteCode` 一经生成，**任何人（含赛事 Host 本人）均不可修改**——若目标 `id` 已存在且传入不同的 `inviteCode`，直接拒绝（`400 "Event inviteCode is immutable and cannot be changed"`）；若同 `inviteCode` 已被其他非存根权威赛事占用，无论调用者是否为 Host 均拒绝解绑覆盖（`403 "Event inviteCode is immutable; cannot overwrite invite code of an existing event"`）；若目标 `id` 已存在且非占位符存根，禁止修改 `hostId`（`403 "Cannot hijack host ownership of an existing event"`），且原 `hostId` 为本机已设密注册账号时非 Host 禁止修改（`403 "Only the event host can modify an authoritative local event"`）。
- **Request**：`Body: ScoutingEvent`（必填非空 `id`、`inviteCode`）
- **Response**：`ScoutingEvent`
  - 错误码：`400` (`"Invalid event payload"` / `"Event inviteCode is immutable and cannot be changed"`), `401` (`"Unauthorized"`), `403` (`"Cannot hijack host ownership of an existing event"` / `"Only the event host can modify an authoritative local event"` / `"Event inviteCode is immutable; cannot overwrite invite code of an existing event"`)

### `PUT /api/events/{id}/ftc-config`
- **说明**：Host 配置或清空赛事绑定的 FTC 官方赛季与赛事代码（非空代码会在线调用 `FtcApiClient.eventExists` 校验）。
- **Request**：`{ ftcYear?: number | null /* 2000..2100 */; ftcEventCode?: string | null /* /^[A-Za-z0-9_-]{1,32}$/，传空或 null 清空 */ }`
- **Response**：`200 ("OK")`
  - 错误码：`400` (`"Invalid JSON body"` / `"Invalid ftcYear format"` / `"Invalid ftcYear"` / `"Invalid ftcEventCode format"` / `"FTC 官方赛事代码不存在: <code> (赛季 <year>)"`), `403` (`"Only the host can configure the event"`), `404` (`"Event not found"`), `502` (`"FTC 官方 API 校验失败: ..."`)

### `PUT /api/events/{id}/turn-config`
- **说明**：Host 配置或清空赛事自定义 TURN 中继服务器配置（AES 加密落盘）。若 `credential` 为空、`null`、`"****"` **或包含 `"***"` 子串**，则尝试沿用已保存的解密密码。
- **Request**：`{ clear?: boolean; urls?: string[]; username?: string; credential?: string }`
- **Response**：`{ hasCustomTurn: boolean; customTurnConfig: TurnServerConfig | null }`
  - 错误码：`400` (`"Invalid JSON body"` / `"urls must be a list of strings"` / `"Too many TURN URLs (max 10)"` / `"Invalid TURN URL: must start with turn: or turns:"` / `"TURN username is required"` / `"TURN credential is required"`), `401` (`"Unauthorized"`), `403` (`"Only the host can configure the event"`), `404` (`"Event not found"`)

### `GET /api/events/{id}/banned-teams`
- **Request**：`Path: { id: string }` → **Response**：`number[]`
  - 错误码：`403` (`"Not a member of this event"`)

### `POST /api/events/{id}/banned-teams`
- **Request**：`{ teamNumber: number }` → **Response**：`200 ("OK")`
  - 错误码：`400` (`"Invalid JSON body"` / `"Invalid teamNumber format"`), `403` (`"Only the host can ban teams"`), `404` (`"Event not found"`)

### `DELETE /api/events/{id}/banned-teams/{teamNumber}`
- **Request**：`Path: { id: string; teamNumber: number }` → **Response**：`200 ("OK")`
  - 错误码：`400` (`"Invalid teamNumber format"`), `403` (`"Only the host can unban teams"`), `404` (`"Event not found"`)

### `GET /api/events/{id}/members`
- **Request**：`Path: { id: string }`
- **Response**：`Array<{ id: string; username: string; host: boolean }>`
  - 错误码：`403` (`"Not a member of this event"`)
  - *前端兼容*：`api.ts` `EventMemberItem` 包含客户端扩展字段 `role?: string`。

### `POST /api/events/{id}/members`
- **说明**：Host 代理注册/添加成员到当前赛事（`username` 缺省时回退为 `userId`；绝不覆盖已设置密码用户的用户名）。
- **Request**：`{ userId: string; username?: string }`
- **Response**：`200 ("OK")`
  - 错误码：`400` (`"Invalid JSON body"` / `"Missing userId"`), `401` (`"Unauthorized"`), `403` (`"Only the event host can register members"`), `404` (`"Event not found"`)

### `DELETE /api/events/{id}/members/{userId}`
- **Request**：`Path: { id: string; userId: string }` → **Response**：`200 ("OK")`
  - 错误码：`400` (`"Host cannot be removed from event"`), `401` (`"Unauthorized"`), `403` (`"Only the event host can remove members"`), `404` (`"Event not found"`)

---

## 5. 战队标签模块 (`TeamTagRoutes`)

```ts
interface TeamTag {
  id: string;
  eventId: string;
  teamNumber: number;
  tag: string;       // 1..30 字符；符合 /^[A-Za-z0-9 _#-]+$/ 时自动转小写；禁止含 '.'；必须符合 /^[\p{L}\p{N} _#-]+$/
  color: 'red' | 'orange' | 'green' | 'blue' | 'purple' | 'gray' | 'yellow'; // 其他值静默回退为 'blue'
  isPreset: boolean; // 后端强制写为 false
  createdBy: string;
  createdAt?: string;
  updatedAt?: string;
}
```

### `GET /api/events/{id}/tags`
- **说明**：赛事成员获取赛事下所有战队标签列表。
- **Request**：`Path: { id: string }` → **Response**：`TeamTag[]`
  - 错误码：`403` (`"Not a member of this event"`)

### `POST /api/events/{id}/teams/{teamNumber}/tags`
- **说明**：赛事成员为指定战队（`teamNumber > 0`）添加或更新标签（每队最多 15 个标签）。
- **Request**：`{ tag: string; color?: string }`
  - *前端兼容*：`api.ts` `addTeamTag` 可附带 `isPreset?: boolean`，后端忽略并强制写为 `false`。
- **Response**：`TeamTag`
  - 错误码：`400` (`"Invalid teamNumber format"` / `"tag required"` / `"Tag must be between 1 and 30 characters"` / `"Tags cannot contain '.'"` / `"Tag contains invalid characters"` / `"Maximum 15 tags per team allowed"`), `403` (`"Not a member of this event"`), `404` (`"Event not found"`)

### `DELETE /api/events/{id}/teams/{teamNumber}/tags/{tag}`
- **说明**：赛事成员删除指定战队（`teamNumber > 0`）的标签（仅标签创建者或赛事 Host 可删；标签不存在时幂等返回 `200`；直接使用 Javalin 已解码的 `pathParam("tag")`，不执行二次 `URLDecoder.decode`）。
- **Request**：`Path: { id: string; teamNumber: number; tag: string }`（`tag` 需 URL 编码，后端同步尝试小写规范化与原始值匹配）
- **Response**：`200 ("OK")`
  - 错误码：`400` (`"Invalid teamNumber format"`), `403` (`"Not a member of this event"` / `"Only the tag creator or event host can delete this tag"`), `404` (`"Event not found"`)

---

## 6. 赛程与排班模块 (`ScheduleRoutes`)

```ts
interface MatchScheduleItem {
  id: string;
  eventId: string;
  matchNumber: number;
  tournamentLevel: string; // 默认 'QUALIFICATION'
  red1: number;
  red2: number;
  blue1: number;
  blue2: number;
  createdAt?: string;
  // 注意：frontend/src/types/index.ts 含客户端字段 scoreRedFinal? / scoreBlueFinal?，后端不存储也不返回
}

interface ScoutAssignment {
  id: string;
  eventId: string;
  matchNumber: number;
  tournamentLevel: string; // 默认 'QUALIFICATION'
  station: 'red1' | 'red2' | 'blue1' | 'blue2' | string;
  teamNumber: number;
  scoutId: string | null;
  scoutName: string | null;
  updatedAt?: string;
}
```

### `GET /api/events/{id}/schedule`
- **Request**：`Path: { id: string }` → **Response**：`{ schedules: MatchScheduleItem[]; assignments: ScoutAssignment[] }`
  - 错误码：`403` (`"Not a member of this event"`)

### `POST /api/events/{id}/schedule/batch`
- **说明**：Host 批量导入或覆盖赛程。
  - **副作用与 ID 规则**：`replace: true` 时先清空既有赛程并通过 `clearAssignmentsByEvent` 清空既有 `assignments`；`items` 缺省 `id` 时生成 `UUID`；`assignments` 缺省 `id` 时生成 `${eventId}_${tournamentLevel}_${matchNumber}_${station}`。对每个有效赛程自动调用 `initStationAssignment` 初始化 `red1`/`red2`/`blue1`/`blue2` 工位（`replace: false` 且工位已存在时仅更新 `teamNumber` 并**保留原 `scoutId`/`scoutName`**）。`matchNumber <= 0` 或 `station` 为空的条目会被**静默跳过**。
- **Request**：
  ```ts
  interface BatchScheduleBody {
    replace?: boolean;
    items: Array<{ id?: string; matchNumber: number; tournamentLevel?: string; red1?: number; red2?: number; blue1?: number; blue2?: number }>;
    assignments?: Array<{ id?: string; matchNumber: number; tournamentLevel?: string; station: string; teamNumber?: number; scoutId?: string | null; scoutName?: string | null }>;
  }
  ```
- **Response**：`{ success: true; count: number }`
  - 错误码：`400` (`"Invalid JSON payload"` / `"items array required"` / `"Invalid integer field: ..."` / `"Invalid boolean field: ..."` / `"Invalid string field: ..."`), `403` (`"Only the event host can modify match schedule or assignments"`), `404` (`"Event not found"`)

### `DELETE /api/events/{id}/schedule`
- **Request**：`Path: { id: string }` → **Response**：`{ success: true }`
  - 错误码：`403` (`"Only the event host can modify match schedule or assignments"`), `404` (`"Event not found"`)

### `PUT /api/events/{id}/assignments`
- **说明**：Host 批量更新工位排班（空白 `scoutId`/`scoutName` 自动归一化为 `null`；缺省 `id` 时使用 `${eventId}_${tournamentLevel}_${matchNumber}_${station}`；`matchNumber <= 0` 或 `station` 为空的条目静默跳过；`JsonNull` 回退默认值，非原始类型返回 `400`）。
- **Request**：`{ assignments: Array<{ id?: string; matchNumber: number; tournamentLevel?: string; station: string; teamNumber?: number; scoutId?: string | null; scoutName?: string | null }> }`
- **Response**：`{ success: true; count: number }`
  - 错误码：`400` (`"Invalid JSON payload"` / `"assignments array required"` / `"Invalid integer field: ..."` / `"Invalid string field: ..."`), `403` (`"Only the event host can modify match schedule or assignments"`), `404` (`"Event not found"`)

---

## 7. 比赛侦察记录模块 (`RecordRoutes`)、`rawData` 架构与 ECDSA 签名协议

```ts
interface ScoutingRecord {
  id: string;
  eventId: string;
  scoutId: string;     // 非 Host 写接口默认强制绑定 userId；客户端类型非可选
  scoutName: string;
  matchNumber: number; // > 0
  teamNumber: number;  // > 0
  autoScore: number;
  teleopScore: number;
  endgameScore: number;
  totalScore: number;
  notes: string;
  rawData: string;     // JSON 字符串（ScoutingFormData，见 §7.1）
  syncStatus: 'PENDING' | 'SYNCED';
  createdAt: string;
  updatedAt: string;
  isBroken: boolean;
  isDeleted?: boolean;
  isConflict?: boolean; // 仅前端本地冲突标记，后端不持久化
  version: number;      // 记录级逻辑版本号，每次编辑 +1，用于 LWW 冲突裁决
  authorPubKey?: string; // ECDSA P-256 SPKI Base64 公钥
  authorSig?: string;    // ECDSA P-256 / SHA-256 P1363 Base64 签名
  hostSig?: string;      // Host 权威双签（预留）
}
```

### 7.1 `rawData` 完整表单结构 (`ScoutingFormData`)
前端 `ScoutingRecord.rawData` 为以下对象的 `JSON.stringify` 字符串（`PitScoutingRecord.rawData` 仅含 `{ customFields?: Record<string, any> }`）：

```ts
interface ScoutingFormData {
  matchNumber: number;
  tournamentLevel?: string;              // 'QUALIFICATION' | 'PLAYOFF' 等
  teamNumber: number;
  allianceColor: 'none' | 'red' | 'blue';
  isBroken: boolean;

  // Auto (2026-2027 BIOBUZZ)
  autoLeave: boolean;
  autoBalls: number;
  autoCycles?: number[];
  autoMissedCycles?: number[];
  autoCycleTimestamps?: number[];        // epoch ms
  autoCycleTimeSec?: number | null;
  autoPark: boolean;
  autoPreload?: boolean;
  autoSecondary?: boolean;

  // Teleop (Cycle Tracker)
  teleopCycles: number[];
  teleopMissedCycles?: number[];
  teleopCycleTimestamps?: number[];      // 与 teleopCycles 同步对齐的 epoch ms
  predictCycleTimeSec?: number | null;   // 单场缓存（有效间隔 >= 5 时去最快 1 次取接下来 4 次均值）

  // Endgame (2026-2027 BIOBUZZ)
  teleopPark: boolean;                   // +5 pts
  flowerNectars?: number;                // 0..8 (+2 pts/ball)
  flowerBottomBonusCount?: number;       // 0..min(4, flowerNectars) (+5 pts/flower)
  flowerPollens?: number;                // 0..12 (+2 pts/ball)
  gardenBalls?: number;                  // 0..12 (+1 pt/ball)
  flowerDescore?: boolean;               // G418 拆台战术标签
  g410EarlyFlowerFoul?: boolean;         // G410 <60s 误投 Nectar 大犯规标签
  /** @deprecated */ flowerPlaced?: boolean;
  /** @deprecated */ flowerBottomBonus?: boolean;

  // Custom Fields (以 fieldKey 为键)
  customFields?: Record<string, any>;
}
```

### 7.2 ECDSA 签名与可信身份锚点协议 (`EcdsaRecordVerifier` / `recordSignature.ts`)
- **算法与编码**：ECDSA `P-256` + `SHA-256`；前端使用 WebCrypto `subtle.sign` 输出 IEEE P1363 原始签名，后端使用 `Signature.getInstance("SHA256withECDSAinP1363Format")` 验签。`authorPubKey` 为 SPKI Base64，`authorSig` 为 P1363 Base64。
- **规范化签名载荷（严禁 HTML 转义，对应 `GsonBuilder().disableHtmlEscaping()` 与 `JSON.stringify`）**：
  - 比赛记录载荷：
    ```ts
    JSON.stringify([
      'SP27_REC_V1',
      id || '', eventId || '', scoutId || '',
      Number(matchNumber || 0), Number(teamNumber || 0),
      Number(autoScore || 0), Number(teleopScore || 0),
      Number(endgameScore || 0), Number(totalScore || 0),
      notes ?? '',
      rawData && rawData.length > 0 ? rawData : '{}',
      Boolean(isBroken), Boolean(isDeleted)
    ])
    ```
  - 成员设备身份锚点载荷（存 TinyBase `member_identities` 表）：
    ```ts
    JSON.stringify(['SP27_ID_V1', eventId || '', userId, deviceId, signingPubKeyHex])
    ```
- **非 Host 队友代传验签与两阶段密钥绑定规则 (`verifyNonHostPeerRecordAuthorization`)**：
  1. 首先校验 `authorPubKey`/`authorSig` 对 `SP27_REC_V1` 载荷验签通过；`scoutId` 不可为空；若记录已存在，禁止修改 `scoutId`。
  2. 若调用者即作者（`scoutId === callerUserId`）直接放行；否则从 `scouting_records`（历史已落盘签名记录）与 `event_crdt_state.member_identities` 加载可信密钥绑定：
     - **Pass 1（Host 锚点引导）**：若尚未钉住 Host 公钥，仅接受 `member_identities` 中 `userId === eventHostId` 且 `signingPubKeyHex === hostPubKey` 的有效自签名行作为可信 Host 公钥。
     - **Pass 2（成员背书）**：凡由可信 Host 公钥对 `SP27_ID_V1` 有效签发 `hostSig` 的 `member_identities` 行，绑定 `(userId, signingPubKeyHex)`。
  3. 约束：若记录已存在且已有 `authorPubKey`，新签名公钥必须等于原公钥或为 Host 公钥；若原记录无公钥（未签名），仅当 `(scoutId, pubKey)` 已锚定于 `member_identities` 或使用 Host 公钥时允许补签；禁止同公钥跨 `scoutId` 冒用（Host 公钥除外）。

### 7.3 LWW 冲突裁决与入库副作用 (`RecordDao.upsert`)
- **LWW 优先级**：`src.version > target.version`，若相等则比较 `src.updated_at > target.updated_at`，仍相等则比较 `src.scout_id >= target.scout_id`。
- **未来时钟钳位**：传入 `updatedAt > CURRENT_TIMESTAMP + 5s` 时，服务端钳位为 `CURRENT_TIMESTAMP`。
- **签名列保留**：更新时 `author_pub_key` / `author_sig` / `host_sig` 使用 `COALESCE(NULLIF(TRIM(src...), ''), target...)`，空值不会覆盖已有签名。
- **用户占位与自动入赛**：`POST /api/records` 与 `POST /api/records/sync` 在 `scoutId` 非空时自动调用 `ensureScoutUserPlaceholder` 与 `eventDao.joinEvent`。

### 7.4 接口契约

#### `GET /api/records`
- **说明**：赛事成员获取指定赛事的全部比赛侦察记录（含软删除墓碑，按 `match_number` 升序）。
- **Request**：`Query: { eventId: string }`
- **Response**：`ScoutingRecord[]`
  - 错误码：`400` (`"eventId required"`), `403` (`"Not a member of this event"`)

#### `POST /api/records`
- **说明**：赛事成员新增或更新单条比赛记录（非 Host 仅可修改本人记录，且强制绑定 `scoutId = userId`；禁止跨赛事复用已有 `record.id`）。
- **Request**：`Body: ScoutingRecord`
- **Response**：`200 ("OK")`
  - 错误码：`400` (`"Invalid JSON body"` / `"Invalid matchNumber or teamNumber"` / `"Event ID cannot be blank"` / `"Invalid data: ..."`), `403` (`"Not a member of this event"` / `"Record belongs to another event"` / `"Cannot modify another scout's record"`)

#### `POST /api/records/sync`
- **说明**：批量同步比赛侦察记录（按 `id` 排序加锁事务落库，并强制写 `syncStatus = "SYNCED"`；禁止跨赛事复用已有 `record.id`；非 Host 仅可同步本人未签名记录，或经 ECDSA 验签且满足公钥绑定与作者不可变约束的队友签名记录）。
- **Request**：`Body: ScoutingRecord[]`
- **Response**：`200 ("OK")`
  - 错误码：`400` (`"Invalid JSON body"` / `"Sync failed: ..."`), `403` (`"Not a member of event: ..."` / `"Record belongs to another event"` / `"Cannot sync records belonging to another scout"` / `"Cannot modify another scout's record"` / ECDSA 拒绝原因：`"Invalid ECDSA signature"` / `"Signed record is missing scoutId"` / `"Cannot alter the author of an existing record"` / `"Author public key mismatch for existing record"` / `"Cannot retroactively sign another scout's unsigned record"` / `"Author public key is not bound to scoutId"` / `"Author public key is already bound to another scout"`)

#### `POST /api/records/migrate-scout`
- **说明**：将指定赛事下 `oldScoutId` 的比赛记录、排班、Pit 记录、标签及成员关系迁移至 `newScoutId`（仅赛事 Host 或该赛事成员本人迁移自身 `callerId === oldScoutId` 可调用，禁止仅凭 `callerId === newScoutId` 接管他人数据；仅当 `oldScoutId` 为无密码占位符账号或当前调用者本人自迁移时级联执行 `UserDeterministicIdMigrator.mergeUserInto`，绝不通过赛事 Host 权限全局删除其他已设密注册用户）。
- **Request**：`{ eventId: string; oldScoutId: string; newScoutId: string; newScoutName: string }`
- **Response**：`200 ("OK")`
  - 错误码：`400` (`"Invalid JSON body"` / `"eventId, oldScoutId, newScoutId, and newScoutName required"`), `401` (`"Unauthorized"`), `403` (`"Only event host or the migrating scout can migrate records"`), `404` (`"Event not found"`), `500` (`"Migrate scout failed: ..."`)

#### `GET /api/records/pending`
- **说明**：赛事成员获取指定赛事下 `sync_status = 'PENDING'` 的待同步记录。
- **Request**：`Query: { eventId: string }`
- **Response**：`ScoutingRecord[]`
  - 错误码：`400` (`"eventId required"`), `403` (`"Not a member of this event"`)

#### `POST /api/records/mark-synced`
- **说明**：将当前用户名下（`WHERE id = :id AND scout_id = :userId`）的记录 ID 列表标记为 `'SYNCED'`；非本人记录静默忽略。
- **Request**：`Body: string[]`
- **Response**：`200 ("OK")`
  - 错误码：`400` (`"Invalid JSON body"` / `"Invalid data"`)

---

## 8. Pit 展位侦察与官方战队底册模块 (`PitScoutRoutes`)

```ts
interface PitScoutingRecord {
  id: string;
  eventId: string;
  teamNumber: number;
  scoutId: string;
  scoutName: string;
  robotName?: string;
  drivetrainType: 'mecanum' | 'tank' | 'swerve' | 'other' | string; // 默认 'mecanum'（前端 types/index.ts 为严格联合类型，无 | string）
  weightLbs: number;                 // 默认 0.0，服务端钳位 >= 0
  chassisSize?: string;              // 默认 ""，trim 后截断 <= 64 字符
  odometryType: string;              // 默认 'none'
  ballCompatibility: 'universal' | 'sorting' | 'pollen_only' | string; // 默认 'universal'（前端 types/index.ts 为严格联合类型，无 | string）
  launcherType: string;              // 默认 ""
  flowerMechanism: string;           // 默认 ""
  hasColorSensor: boolean;           // 默认 false
  hasDescoreMech?: boolean;          // 默认 false
  hasApriltagVision?: boolean;       // 默认 false
  claimedAutoStrategy?: string;      // 默认 ""
  claimedAutoScore: number;          // 默认 0，钳位 >= 0
  claimedTeleopCycles: number;       // 默认 0，钳位 >= 0
  claimedTeleopScore: number;        // 默认 0，钳位 >= 0
  claimedTeleopPark?: boolean;       // 默认 false
  claimedFlowerNectars?: number;     // 默认 0，钳位 0..8
  claimedFlowerBottomBonus?: number; // 默认 0，钳位 0..min(4, claimedFlowerNectars)
  claimedFlowerPollens?: number;     // 默认 0，钳位 >= 0
  claimedGardenBalls?: number;       // 默认 0，钳位 >= 0
  claimedEndgameScore: number;       // 默认 0，按 §8.1 规则归一化
  claimedTotalScore: number;         // 默认 0，按 §8.1 规则归一化
  photoKeys?: string[];              // 默认 []；JSON 数组或 JSON 字符串均可解析
  rawData?: string;                  // JSON 字符串，存 { customFields?: Record<string, any> }
  customFields?: Record<string, any>; // 仅前端内存字段，读写 CRDT 时与 rawData 互转
  version: number;                   // 默认 1
  isDeleted?: boolean;               // 默认 false
  createdAt?: string;
  updatedAt?: string;
  syncStatus?: 'PENDING' | 'SYNCED'; // 仅前端状态
}

interface OfficialTeam { // 前端 types/index.ts 命名为 OfficialTeamInfo（不含 updatedAt）
  eventId?: string;
  teamNumber: number;
  nameFull: string;
  robotName?: string;
  city?: string;
  country?: string;
  updatedAt?: string;
}
```

### 8.1 BIOBUZZ 终局与总分归一化规则 (`PitScoutRoutes.normalizePitRecord` / `CrdtProjectionService` / `schema.ts`) & LWW
- **三端统一执行**：REST 写入（`PitScoutRoutes`）、CRDT 关系表投影（`CrdtProjectionService.projectPitAndPhotos`）与前端 CRDT 读取解码（`services/crdt/schema.ts#readPitRecordsFromCrdt`）执行完全一致的字段与得分归一化，保证多设备离线按单元格（Cell-level）并发修改不同自述分项合并后总分与终局分始终自洽。
- **结构化终局公式**（与前端 `calcBiobuzzEndgameScore` 一致；`weightLbs` 对非有限值或 `< 0` 钳位为 `0.0`；`pollens`/`garden` 钳位 `>= 0`）：
  - `nectars = clamp(claimedFlowerNectars, 0, 8)`
  - `bottomBonus = clamp(claimedFlowerBottomBonus, 0, min(4, nectars))`
  - `pollens = max(0, claimedFlowerPollens)`，`garden = max(0, claimedGardenBalls)`
  - `structuredEndgame = (claimedTeleopPark ? 5 : 0) + (nectars * 2) + (bottomBonus * 5) + (pollens * 2) + garden`
- **覆盖判定**：
  - `hasStructuredEndgame = claimedTeleopPark || nectars > 0 || bottomBonus > 0 || pollens > 0 || garden > 0`
  - 若 `hasStructuredEndgame === true`，覆盖 `claimedEndgameScore = structuredEndgame`；否则仅当 `claimedEndgameScore < 0` 时钳位为 `0`（保留旧端非负直填终局分）。
  - `claimedTotalScore`（记 `componentSum = auto + teleop + effectiveEndgame`）：若 `originalTotal <= 0 && componentSum > 0`，或 `hasStructuredEndgame && originalEndgame != effectiveEndgame && originalTotal == auto + teleop + originalEndgame`，或 `originalTotal > 0 && componentSum > originalTotal`（并发单元格合并后分项之和高于旧总分），则重算为 `componentSum`；否则仅当 `< 0` 时钳位为 `0`。
- **LWW 冲突裁决 (`PitScoutDao.upsertPitRecord`)**：以 `(event_id, team_number)` 为主键，按 `version > updated_at > scout_id` 胜出，且 `updatedAt > CURRENT_TIMESTAMP + 5s` 钳位为 `CURRENT_TIMESTAMP`。

### 8.2 接口契约

#### `GET /api/events/{eventId}/pit-records`
- **说明**：赛事成员获取全部未删除（`is_deleted = FALSE`）Pit 侦察记录与官方战队底册。
- **Request**：`Path: { eventId: string }`
- **Response**：`{ records: PitScoutingRecord[]; officialTeams: OfficialTeam[] }`
  - 错误码：`400` (`"Invalid eventId"`), `403` (`"Not a member of this event"`)

#### `POST /api/events/{eventId}/pit-records`
- **说明**：赛事成员新增或更新单条 Pit 侦察记录（要求 `teamNumber > 0`，自动生成缺失 `id`、回填 `scoutId`/`scoutName` 并执行 `normalizePitRecord`；禁止跨赛事复用已有 Pit 记录 `id`）。
- **Request**：`Body: PitScoutingRecord`
- **Response**：`{ success: true; record: PitScoutingRecord }`
  - 错误码：`400` (`"Invalid PitScoutingRecord payload"` / `"Invalid teamNumber"`), `403` (`"Not a member of this event"` / `"Pit record ID belongs to another event"`), `500` (`"Save pit record failed: ..."`)

#### `POST /api/events/{eventId}/pit-records/batch`
- **说明**：赛事成员批量同步 Pit 侦察记录（按 `id` 排序加锁事务写入，校验 `teamNumber > 0` 并拒绝跨赛事 `id` 复用；请求体为 `null` 或空数组 `[]` 时直接返回 `200 { success: true, count: 0 }`）。
- **Request**：`Body: PitScoutingRecord[]`
- **Response**：`{ success: true; count: number }`
  - 错误码：`400` (`"Invalid teamNumber"`), `403` (`"Not a member of this event"` / `"Pit record ID belongs to another event"`), `500` (`"Batch pit sync failed: ..."`)

#### `POST /api/events/{eventId}/official-teams/sync`
- **说明**：赛事成员批量保存或同步官方参赛战队名录底册（空数组直接返回 `{ success: true, count: 0 }`）。
- **Request**：`Body: OfficialTeam[]`
- **Response**：`{ success: true; count: number }`
  - 错误码：`403` (`"Not a member of this event"`), `500` (`"Official teams sync failed: ..."`)

#### `GET /api/events/{eventId}/official-teams`
- **说明**：赛事成员单独获取官方参赛战队名录底册（按 `team_number` 升序）。
- **Request**：`Path: { eventId: string }`
- **Response**：`OfficialTeam[]`
  - 错误码：`403` (`"Not a member of this event"`)

#### `POST /api/events/{eventId}/pit/photos`
- **说明**：赛事成员上传 Base64 编码的展位照片并原子落盘为 `<dataDir>/pit_photos/{eventId}/{key}.webp`（带路径穿越防护；`<dataDir>` 解析规则见 `§14`）。
- **Request**：`{ key: string; dataUrl: string }`（`eventId` 与 `key` 均须匹配 `/^[a-zA-Z0-9_\-]+$/`；`dataUrl` 可含 `data:...;base64,` 前缀或为纯 Base64）
- **Response**：`{ success: true; key: string; url: string }`（`url = "/api/events/{eventId}/pit/photos/{key}"`）
  - 错误码：`400` (`"Invalid eventId"` / `"Invalid JSON payload"` / `"Invalid photo key"` / `"Missing photo data"` / `"Invalid base64 encoding"` / `"Illegal path traversal detected"`), `403` (`"Not a member of this event"`), `500` (`"Failed to save photo to disk"`)

#### `GET /api/events/{eventId}/pit/photos/{key}`
- **说明**：流式读取磁盘上的展位 WebP 照片（免鉴权，带 `Cache-Control: public, max-age=31536000, immutable`）。
- **Request**：`Path: { eventId: string; key: string }`（均须匹配 `/^[a-zA-Z0-9_\-]+$/`）
- **Response**：`200 image/webp`（二进制字节流）
  - 错误码：`400` (`"Invalid eventId or key"` / `"Illegal path traversal detected"`), `404` (`"Photo not found"`), `500` (`"Failed to read photo file"`)

#### `DELETE /api/events/{eventId}/pit/photos/{key}`
- **说明**：赛事成员删除磁盘上的指定展位照片（文件不存在时幂等返回 200）。
- **Request**：`Path: { eventId: string; key: string }`
- **Response**：`{ success: true; key: string }`
  - 错误码：`400` (`"Invalid eventId or key"` / `"Illegal path traversal detected"`), `403` (`"Not a member of this event"`), `500` (`"Failed to delete photo file"`)

---

## 9. 自定义字段与公式模块 (`CustomFieldRoutes` & Formula Engine)

```ts
type CustomFieldTarget = 'MATCH' | 'PIT' | 'TEAM';
type CustomFieldPhase = 'auto' | 'teleop' | 'endgame' | 'overall' | 'hardware' | 'strategy';
type CustomFieldType = 'boolean' | 'number' | 'timer' | 'level' | 'select' | 'multi_select' | 'text' | 'formula';
type CustomFieldAggregationMode = 'avg' | 'median' | 'max' | 'min' | 'sum' | 'last3' | 'trimmed_avg' | 'stddev' | 'rate';
type CustomFieldDisplayFormat = 'number' | 'integer' | 'percent' | 'boolean' | 'tier';

interface CustomFieldOption {
  label: string;
  value: string;
  color?: string;
  numericValue?: number | null; // 供公式与聚合计算使用的选项数值权重
}

interface CustomFieldConfig {
  inputMode?: 'stepper' | 'slider' | 'counter' | 'direct';
  quickSteps?: number[];
  showTicks?: boolean;
  tristate?: boolean;
  trueLabel?: string;
  falseLabel?: string;
  levelStyle?: 'blocks' | 'stars';
  levelLowLabel?: string;
  levelHighLabel?: string;
  selectStyle?: 'chips' | 'dropdown';
  multiline?: boolean;
  maxLength?: number;
  placeholder?: string;
  decimalPlaces?: number;
  tierThresholds?: { high?: number; mid?: number; direction?: 'higher_better' | 'lower_better' };
}

interface CustomFieldDefinition {
  id: string;
  eventId: string;
  target: CustomFieldTarget;                  // 默认 'MATCH'；'TEAM' 目标强制 fieldType === 'formula'
  phase: CustomFieldPhase;                    // 默认 'overall'（非法值静默回退/忽略，不报 400）
  name: string;                               // 1..100 字符
  fieldKey: string;                           // /^[a-z0-9_]{1,100}$/，不传时生成 field_<8hex>
  fieldType: CustomFieldType;                 // 默认 'text'；非 'formula' 时清空 formulaExpr 与 dependenciesJson
  required: boolean;                          // 默认 false
  defaultVal?: string | null;
  optionsJson?: string | null;                // JSON 字符串（CustomFieldOption[]）
  options?: CustomFieldOption[];              // 仅前端解析缓存
  minVal?: number | null;
  maxVal?: number | null;
  stepVal?: number | null;
  unit?: string | null;
  description?: string | null;                // <= 300 字符
  configJson?: string | null;                 // JSON 对象字符串（<= 8192 字节，CustomFieldConfig）
  config?: CustomFieldConfig;                 // 仅前端解析缓存
  formulaExpr?: string | null;                // fieldType === 'formula' 时必填（<= 1000 字符）
  aggregationMode?: CustomFieldAggregationMode | null; // 默认 'avg'
  displayFormat?: CustomFieldDisplayFormat | null;     // 默认 'number'
  dependenciesJson?: string | null;           // 服务端解析并归一化的依赖键数组 JSON
  orderSeq: number;
  isActive: boolean;                          // 默认 true
  createdAt?: string;
  updatedAt?: string;
}

interface FormulaValidationErrorResponse {
  error: string;
  errorCode:
    | 'EMPTY_FORMULA'
    | 'EXPR_TOO_LONG'
    | 'TOKEN_LIMIT_EXCEEDED'
    | 'AST_DEPTH_EXCEEDED'
    | 'AST_NODE_LIMIT_EXCEEDED'
    | 'INVALID_TOKEN'
    | 'INVALID_SYNTAX'
    | 'FORBIDDEN_IDENTIFIER'
    | 'DISALLOWED_NAMESPACE'
    | 'DISALLOWED_FUNCTION'
    | 'CROSS_LAYER_REFERENCE'
    | 'CIRCULAR_DEPENDENCY';
  cyclePath?: string[]; // 仅 CIRCULAR_DEPENDENCY 时返回环路节点 key 列表
}
```

### 9.1 公式文法、前后端强一致约束与运行时引擎约定
> 契约测试用例见 `shared/formula-conformance-cases.json`（Java `FormulaValidatorTest` 与前端 `formulaEngine.test.ts` 共用同一份用例库）。
- **静态与运行时限额**：表达式 `<= 1000` 字符、Token `<= 256`、AST 嵌套深度 `<= 20`（Java `FormulaValidator` 与 TS `parser.ts` 均以 0-based `depth > 20` 严格一致判定，恰好 20 层允许、21 层拒绝）、AST 节点数 `<= 200`；前端求值器附加 `MAX_STEP_BUDGET = 500`、`MAX_EVAL_DEPTH = 16`（超限或运行时错误返回 `{ value: null, reason: 'STEP_BUDGET_EXCEEDED' | 'MAX_EVAL_DEPTH_EXCEEDED' | 'CIRCULAR_DEPENDENCY_RUNTIME' | 'DIV_BY_ZERO' | 'NON_FINITE_RESULT' | 'NULL_RESULT' | 'DISALLOWED_FUNCTION' | 'EVAL_ERROR' }`，且 `evaluateFormula` 亦透传 `parsed.errorCode`）。
- **优先级（低 → 高）**：`?:`（右结合） `<` `||` `<` `&&` `<` `== !=` `<` `< <= > >=` `<` `+ -` `<` `* / %` `<` 一元 `! - +` `<` `^`（右结合，高于一元负号，即 `-2^2 = -4`、`2^3^2 = 512`） `<` 函数调用 / 原子。
- **防注入与命名空间白名单**：严禁 `__proto__`、`constructor`、`prototype`、`window`、`globalThis`、`process`、`eval`、`Function`、`import`、`require`、`this`、`self`（大小写不敏感匹配）及 `;`、`=`、`[]`、字符串字面量、多级点链 `a.b.c`。变量引用必须为 `namespace.fieldKey`：
  - `MATCH` 允许：`match.*`、`cf.*`、`formula.*`
  - `PIT` 允许：`pit.*`、`pit_cf.*`、`cf.*`、`formula.*`
  - `TEAM` 允许：`match.*`、`official.*`、`opr.*`、`pit.*`、`pit_cf.*`、`cf.*`、`match_cf.*`、`formula.*`
- **跨层约束**：`MATCH` 公式不可引用 `TEAM`/`PIT` 公式或 `opr.*`/`official.*`/`pit.*`/`pit_cf.*`/`match_cf.*`；`PIT` 公式不可引用 `MATCH`/`TEAM` 公式或 `match.*`/`opr.*`/`official.*`/`match_cf.*`。
- **Java (`FormulaValidator.java`) 与 TS (`utils/formula/*`) 强一致词法/语法/图规则**：
  1. 字面量关键字：`true`、`false`、`null`（小写精确匹配；`null` 求值为 `null`，可供 `SAFE_DIV(a, b, null)`、`COALESCE(null, x)`、`ISNULL(...)` 使用）。
  2. 禁用标识符：对 `FORBIDDEN_IDENTIFIERS` 统一忽略大小写拦截并返回 `FORBIDDEN_IDENTIFIER`。
  3. 数字字面量：尾部悬空小数点（如 `1.`）在词法阶段统一拒绝并返回 `INVALID_TOKEN`。
  4. 零参函数调用：所有零参调用（如 `ABS()`、`SUM()`）在语法阶段统一拒绝并返回 `INVALID_SYNTAX`。
  5. 命名空间方法调用：在检查 `namespace` 合法性前先校验 `.` 后字段名与无 `LPAREN` 调用约束，对 `system.env()`、`opr.np()` 等统一返回 `INVALID_SYNTAX`。
  6. 目标隔离 DAG 与原位编辑：`fieldKey` 统一转小写并按 `<TARGET>:<fieldKey>`（如 `MATCH:score` vs `TEAM:score`）作用域建图，允许跨目标同名键且不误报伪自环；编辑已有公式时按 `candidate.id` 跳过自身旧定义；检测到环路时 `cyclePath` 统一剥离 `<TARGET>:` 前缀并返回首尾闭合路径（如 `[metric_a, metric_b, metric_a]`）。

### 9.2 允许函数白名单与语义 (`frontend/src/utils/formula/functions.ts`)
所有函数名大小写不敏感；数值转换规则：`boolean` 转为 `1/0`，`NaN`/`Infinity` 视为 `null`；真值规则：`boolean` 原值，有限非零数 `true`，其余 `false`。

| 类别 | 函数签名 | 语义与边界行为 |
| :--- | :--- | :--- |
| 数学 | `ABS(x)`, `FLOOR(x)`, `CEIL(x)`, `SIGN(x)` | 单参有限数，无效返回 `null` |
| 数学 | `ROUND(x, digits=0)` | `digits` 钳位 `0..10` 并截断取整 |
| 数学 | `MIN(...args)`, `MAX(...args)` | 展平数字/数组；空输入返回 `null` |
| 数学 | `CLAMP(x, min, max)` | `Math.max(min, Math.min(max, x))`，任一无效返回 `null` |
| 数学 | `SQRT(x)`, `POW(base, exp)` | `x < 0` 或非有限结果返回 `null` |
| 数学 | `LOG(x, base?)` | 省略 `base` 为自然对数 `ln(x)`；`x <= 0`、`base <= 0` 或 `base === 1` 返回 `null` |
| 条件/空值 | `IF(cond, whenTrue, whenFalse)` | 真值分支选择；`boolean` 原样返回，否则转有限数 |
| 条件/空值 | `COALESCE(...args)` | 返回首个可转为有限数的参数，全空返回 `null` |
| 条件/空值 | `ISNULL(x)` | `x === null \|\| x === undefined \|\| (typeof x === 'number' && !Number.isFinite(x))` 返回 `boolean` |
| 条件/空值 | `SAFE_DIV(a, b, fallback=null)` | 分母为 `0`/无效或结果非有限时返回 `fallback` |
| 统计 | `AVG(...args)`, `MEDIAN(...args)`, `STDDEV(...args)` | 展平有限数（`STDDEV` 为总体标准差 `sqrt(mean((v-mean)^2))`）；空输入返回 `null` |
| 统计 | `SUM(...args)`, `COUNT(...args)` | 展平有限数；**空输入均返回 `0`** |
| 统计 | `RATE(...args)` | `count(v > 0) / length`；空输入返回 `null` |
| 统计 | `TRIMMED_AVG(...args)` | 排序后若 `length >= 3` 剔除首尾各 1 个再求均值；空输入返回 `null` |
| 统计 | `RECENT_AVG(values, count=3)` | 取 `values` 末尾 `max(1, trunc(count))` 项均值；空输入返回 `null` |
| 统计 | `PERCENTILE(values, p)` | `p` 钳位 `0..100`，线性插值分位数；空输入返回 `null` |
| 统计 | `WEIGHTED_AVG(values, weights)` | 仅计入 `v` 有限且 `w > 0` 的配对项；总权重 `<= 0` 返回 `null` |
| 归一化 | `NORM(x, min, max)` | `clamp(((x - min) / (max - min)) * 100, 0, 100)`；`max === min` 返回 `null` |
| 归一化 | `MAP_RANGE(x, inMin, inMax, outMin, outMax)` | 线性映射；`inMax === inMin` 时返回 `outMin` |

### 9.3 各命名空间变量目录与数据来源 (`dataSources.ts` / `rankings.ts` / `npOpr.ts` / `predictCycleTime.ts`)
- **自定义字段数值解析 (`resolveCustomFieldNumericValue`)**：`boolean` → `1/0`；`select` 匹配 `options[].value` 的 `numericValue`；`multi_select` 对选中项 `numericValue` 求和（无权重项返回 `null`）；字符串 `'true'`/`'false'` 或 `Number(...)`。
- **聚合入队 (`TEAM` 下 `cf.*` 与 `match_cf.*`)**：跳过 `isDeleted || isBroken` 场次。`match_cf.<key>` 为该队所有有效场次数值数组 `number[]`（供 `MEDIAN`/`RECENT_AVG` 等使用）；`cf.<key>` 按字段定义 `aggregationMode`（`avg`/`median`/`max`/`min`/`sum`/`last3`/`trimmed_avg`/`stddev`/`rate`）聚合为标量。
- **内置命名空间字段**：
  - `match.*` (`MATCH` 目标)：`autoScore`, `teleopScore`, `endgameScore`, `totalScore`, `autoBalls`, `autoCyclesCount`, `teleopCyclesCount`, `autoLeave`, `autoPark`, `teleopPark`, `flowerNectars`, `flowerBottomBonusCount`, `flowerPollens`, `gardenBalls`, `isBroken`, `autoCycleTime`, `teleopCycleTime`, `predictCycleTime`（后两者等价，取自 `calcMatchPredictCycleTime`：`>= 5` 个 `<= 120s` 有效间隔去最快 1 次取接下来 4 次均值）。
  - `match.*` (`TEAM` 目标，来自 `RankingRow`)：`avgAutoScore`, `avgTeleopScore`, `avgEndgameScore`, `avgRating`, `maxScore`, `matchCount`, `brokenCount`, `avgTipsPerMatch`, `teleopParkRate`, `avgMobilityRpPts`, `avgFlowerNectars`, `avgFlowerBottomBonus`, `avgFlowerPollens`, `avgGardenBalls`, `descoreRate`, `g410FoulRate`, `autoCycleTime`, `autoCycleMatches`, `teleopCycleTime`, `predictCycleTime`, `predictCycleMatches`, `predictCycleSpread`, `estimatedMaxCycles`（基于 90s 有效窗口推算）, `minCycles`, `cycleVariance`。
  - `opr.*` (`TEAM` 目标，来自 `calculateEventNpOpr`)：`np` (`spNpOpr`), `rawNp` (`rawNpOpr`), `auto`, `teleop`, `endgame`, `delta`, `confidenceScore`, `officialMatches`, `brokenExcluded`。
  - `official.*` (`TEAM` 目标)：`advancementPoints`, `advancementRank`。
  - `pit.*` (`PIT` & `TEAM` 目标)：`weightLbs`, `claimedAutoScore`, `claimedTeleopCycles`, `claimedTeleopScore`, `claimedEndgameScore`, `claimedTotalScore`, `hasColorSensor`, `hasDescoreMech`, `hasApriltagVision`。
  - `pit_cf.*` (`PIT` & `TEAM`) / `cf.*` (`MATCH`/`PIT`/`TEAM`) / `formula.*`（同层或下层已求值公式结果）。

### 9.4 接口契约

#### `GET /api/events/{eventId}/custom-fields`
- **说明**：赛事成员查询赛事下所有自定义字段与公式定义（按 `order_seq ASC, created_at ASC`）。
- **Response**：`CustomFieldDefinition[]`
  - 错误码：`403` (`"Not a member of this event"`)

#### `POST /api/events/{eventId}/custom-fields`
- **说明**：Host 新增自定义字段或公式定义（校验 `eventId + target + fieldKey` 唯一性；`formula` 执行 AST + 跨层 + 3-color DFS 环检测并写入 `dependenciesJson`；非 `formula` 清空 `formulaExpr`/`dependenciesJson`）。
- **Request**：`Body: CustomFieldDefinition`
- **Response**：`201` -> `CustomFieldDefinition`
  - 错误码：`400` (`"Invalid JSON body"` / `"Field name is required"` / `"Field name cannot exceed 100 characters"` / `"Invalid target: must be 'MATCH', 'PIT', or 'TEAM'"` / `"Invalid fieldType: ..."` / `"TEAM custom fields must have fieldType 'formula'"` / `"Field key must contain only letters, numbers, and underscores (max 100 chars)"` / `"Field key '...' already exists for target ..."` / `"Description cannot exceed 300 characters"` / `"configJson cannot exceed 8192 bytes"` / `"configJson must be a valid JSON object"` / `"Invalid aggregationMode: ..."` / `"Invalid displayFormat: ..."` / `FormulaValidationErrorResponse`), `403` (`"Only event host can manage custom fields"`), `404` (`"Event not found"`)

#### `PUT /api/events/{eventId}/custom-fields/{id}`
- **说明**：Host 部分更新现有自定义字段或公式定义（`target` 与 `fieldKey` 不可变更；仅对 JSON 请求体中显式传入的字段执行更新，未传字段保留库内原值不被覆写为 `null`；修改时重新执行校验与全赛事 DAG 环检测）。
- **Request**：`Path: { eventId: string; id: string }`, `Body: Partial<CustomFieldDefinition>`
- **Response**：`CustomFieldDefinition`
  - 错误码：`400` (同 `POST` 参数及 `FormulaValidationErrorResponse`), `403` (`"Only event host can manage custom fields"`), `404` (`"Event not found"` / `"Custom field not found"`)

#### `DELETE /api/events/{eventId}/custom-fields/{id}`
- **说明**：Host 删除指定自定义字段或公式定义。
- **设计取舍**：后端删除接口有意不硬拦截仍被其他公式引用的字段（前端弹窗通过 `findDependentFormulas` 给出依赖警告并由 Host 确认），以便赛事中快速清理废弃字段；运行期 `evaluateFormula` 将缺失字段安全求值为 `null`。
- **Response**：`{ success: true; id: string }`
  - 错误码：`403` (`"Only event host can manage custom fields"`), `404` (`"Event not found"` / `"Custom field not found"`)

---

## 10. CRDT 状态快照与关系表投影模块 (`CrdtRoutes` & TinyBase 8 表架构)

### 10.1 TinyBase `MergeableStore` 快照结构与 8 张表 Schema (`services/crdt/schema.ts`)
- **快照 JSON 形态 (`[tablesStamp, valuesStamp]`)**：
  ```
  [
    [ { [tableId]: [ { [rowId]: [ { [cellId]: [primitiveVal, hlc?, hash?] }, hlc?, hash? ] }, hlc?, hash? ] }, hlc?, hash? ],
    [ { [valueId]: [primitiveVal, hlc?, hash?] }, hlc?, hash? ]
  ]
  ```
- **8 张受管表定义**（注意：`pit_records` 与 `scouting_records` 中 JSON 单元格名均为 **`rawDataJson`** 而非 `rawData`）：

| TinyBase `tableId` | `rowId` 格式 | 单元格 (`cellId: type`) | 投影目标 / 备注 |
| :--- | :--- | :--- | :--- |
| `scouting_records` | `record.id` | `id`, `eventId`, `scoutId`, `scoutName`, `matchNumber: number`, `teamNumber: number`, `autoScore: number`, `teleopScore: number`, `endgameScore: number`, `totalScore: number`, `notes`, `rawDataJson`, `isBroken: boolean`, `version: number`, `isDeleted: boolean`, `createdAt`, `updatedAt`, `authorPubKey`, `authorSig`, `hostSig` | 投影至 `scouting_records`，强制 `sync_status='SYNCED'`；`scoutId` 空回退 `'crdt_sync'`，`scoutName` 空回退 `'Scout'` |
| `pit_records` | `String(teamNumber)` | `id`, `eventId`, `teamNumber: number`, `scoutId`, `scoutName`, `robotName`, `drivetrainType`, `weightLbs: number`, `chassisSize`, `ballCompatibility`, `launcherType`, `flowerMechanism`, `hasColorSensor: boolean`, `hasDescoreMech: boolean`, `hasApriltagVision: boolean`, `odometryType`, `claimedAutoStrategy`, `claimedAutoScore: number`, `claimedTeleopCycles: number`, `claimedTeleopScore: number`, `claimedTeleopPark: boolean`, `claimedFlowerNectars: number`, `claimedFlowerBottomBonus: number`, `claimedFlowerPollens: number`, `claimedGardenBalls: number`, `claimedEndgameScore: number`, `claimedTotalScore: number`, `rawDataJson`, `version: number`, `isDeleted: boolean` | 投影至 `pit_scouting_records`（`KEY(event_id, team_number)`）；聚合 `pit_photo_keys` 写入 `photo_keys` |
| `pit_photo_keys` | `${teamNumber}::${photoKey}` | `teamNumber: number`, `photoKey: string`, `active: boolean`, `addedBy: string` | LWW-Element-Set（禁止 `delRow`）；若仅 `pit_photo_keys` 脏则直接 `UPDATE pit_scouting_records.photo_keys` |
| `team_tags` | `${teamNumber}::${normalizedTag}` | `id`, `eventId`, `teamNumber: number`, `tag`, `color`, `isPreset: boolean`, `active: boolean`, `createdBy` | `active=false` 时硬删 `team_tags`；`active=true` 时 `MERGE KEY(event_id, team_number, tag)` |
| `custom_fields` | `field.id` | `id`, `eventId`, `target`, `phase`, `name`, `fieldKey`, `fieldType`, `required: boolean`, `defaultVal`, `optionsJson`, `minVal: number\|""`, `maxVal: number\|""`, `stepVal: number\|""`, `unit`, `description`, `configJson`, `formulaExpr`, `aggregationMode`, `displayFormat`, `dependenciesJson`, `orderSeq: number`, `orderKey: string`, `isActive: boolean`, `isDeleted: boolean` | `isDeleted=true` 硬删；`orderSeq<=0` 时按 `orderKey` 排序生成稠密序号；写入前先删同 `(event_id, target, field_key)` 不同 `id` 冲突行；公式仅调用 `FormulaValidator.validate`（允许离线合环落库） |
| `schedules` | `${LEVEL}_${matchNumber}` | `id`, `eventId`, `matchNumber: number`, `tournamentLevel` (默认 `'QUALIFICATION'`), `red1..blue2: number`, `scoreRedFinal: number\|""`, `scoreBlueFinal: number\|""`, `isDeleted: boolean` | `isDeleted=true` 硬删 `match_schedules`；否则 `MERGE KEY(event_id, match_number, tournament_level)` |
| `assignments` | `${LEVEL}_${matchNumber}_${station}` | `id`, `eventId`, `matchNumber: number`, `tournamentLevel` (默认 `'QUALIFICATION'`), `station`, `teamNumber: number`, `scoutId`, `scoutName`, `isDeleted: boolean` | `isDeleted=true` 硬删 `scout_assignments`；否则 `MERGE KEY(event_id, match_number, tournament_level, station)` |
| `member_identities` | `${userId}::${deviceId}` | `eventId`, `userId`, `deviceId`, `signingPubKeyHex`, `trustedAt: number`, `hostPubKey`, `hostSig` | **仅存快照，不投影至关系表**；供 `EcdsaRecordVerifier` 与前端 P2P 验签读取 |

### 10.2 接口契约

#### `GET /api/events/{eventId}/crdt-state`
- **说明**：赛事成员获取 `event_crdt_state` 中的 TinyBase `MergeableStore` 快照（不存在时不自动回填，返回 `exists: false`）。
- **Response**：`{ exists: boolean; eventId: string; hostEpoch: number; snapshotRevision: number; snapshot: unknown[] | null; updatedAt: string | null }`
  - 错误码：`400` (`{ error: "Invalid eventId" }`), `403` (`"Not a member of this event"`)

#### `PUT /api/events/{eventId}/crdt-state`
- **说明**：保存 `snapshot` 至 `event_crdt_state` 并按 `dirtyRows`（或 `fullProjection === true`，或首次写入且 `dirtyRows` 为空）事务投影至关系表。
  - **Epoch / Revision 与 Host 独占抬升规则 (`CrdtProjectionService.java`)**：
    - `requestedEpoch = Math.max(1, hostEpoch)`；若 `< DB.hostEpoch` 返回 `409 (stale_epoch)`。
    - **非 Host 严禁抬升 `hostEpoch`**：当 `eventHostId` 为本机已设密注册账号（`isRegisteredUserWithPassword(eventHostId) == true`）且请求方非该 Host（`!callerUserId.equals(eventHostId)`）时，若 `requestedEpoch > currentEpoch` 直接拒绝并返回 `403 Forbidden`（`"Only the event host can advance hostEpoch"`），防止普通成员恶意抬高纪元锁死真 Host（`409`）。
    - 若 `requestedEpoch == DB.hostEpoch && snapshotRevision > 0 && snapshotRevision < DB.snapshotRevision` 返回 `409 (stale_revision)`。
    - 首次写入（`existing == null`）：`effectiveRev = Math.max(1L, snapshotRevision)`（即使传入 `0` 也返回 `1`）；新纪元跃迁（`requestedEpoch > existing.hostEpoch`）：`effectiveRev = Math.max(snapshotRevision, existing.snapshotRevision + 1)`。
  - **非 Host 快照强一致净化与只读表隔离（`member_identities`、`scouting_records`、`custom_fields`、`schedules`、`assignments`、`team_tags`、`pit_records`）**：
    - `member_identities`：当 `eventHostId` 为本机已设密注册账号时，严禁非 Host 成员注入自签名 Host 主密钥引导锚点（仅在从机冷备库 `eventHostId` 为无密码占位符且尚未钉住任何 Host 公钥时，允许引导唯一一条合法自签名 Host 锚点）；非 Host 仅可写入本人的无 `hostSig` 设备公钥行（`userId === callerUserId` 且不覆盖已有 `hostSig`）或经可信 Host 公钥有效背书（`SP27_ID_V1` 验签通过）的身份行；篡改或省略他人既有身份锚点自动回滚为库内可信行。
    - `scouting_records`：对快照内全部行执行作者归属、跨赛事 `id` 隔离（即使 Host 亦不可通过 CRDT 投影跨赛事劫持既有 `scouting_records.id`）与 ECDSA 验签；伪造新增行或跨赛事冲突行被剥离/跳过投影，篡改或省略他人已有行自动回滚为库内可信行并裁剪 TinyBase Stamp 哈希。
    - Host 独占配置表（`custom_fields`、`schedules`、`assignments`）：在权威 Host 本机库（`!isHost && hostIsRegisteredLocalUser`）中，非 Host 成员对这三张表的任意增删改均被回滚至库内最新可信快照并跳过关系表投影。
    - `team_tags`：在权威 Host 本机库上对非 Host 强制执行创建者删改隔离（不可删除他人创建的标签、不可伪造 `isPreset` 或冒充他人 `createdBy`、不可超越单队 15 标签上限及字符白名单，超限/越权行回滚至既有快照并同步跳过关系表越权删除）。
    - `pit_records`：非 Host 在权威 Host 本机库上不得将他人提交的 Pit 记录标记为 `isDeleted = true`（越权软删回滚为原记录）。
  - **设计取舍与有意边界（CRDT 离线协作模型）**：
    - **冷备副本例外 (`!hostIsRegisteredLocalUser`)**：当赛事由 `POST /api/events/external-sync` 同步进只读备机（`events.host_id` 为无密码占位符），允许授权事件成员将远端 P2P `Host Takeover` 产生的高 `hostEpoch` 与配置快照镜像写入本地备机，保证备机跨主切换与接管后不与远端主库分裂。
    - **Pit 侦察协同写入**：与 `PitScoutRoutes` 一致，`pit_records` 与 `pit_photo_keys` 允许同赛事侦察员协作增补展位信息与照片，仅禁止非 Host 软删除他人 Pit 记录。
    - **CRDT 离线公式环容错**：`projectCustomFields` 对离线同步的公式强制校验语法、注入、DoS 与命名空间白名单，但有意容忍多端离线编辑合入的潜在公式环并落盘持久化（前端求值器运行期通过 `CIRCULAR_DEPENDENCY_RUNTIME` 安全降级，避免单条坏公式阻塞整包 CRDT 同步）。
  - **Pit 投影归一化**：`projectPitAndPhotos` 写入 `pit_scouting_records` 前统一调用 `PitScoutRoutes.normalizePitRecord` 执行 BIOBUZZ 终局与总分归一化。
  - **`dirtyRows` 键名**：必须严格使用 snake_case（`scouting_records`, `pit_records`, `pit_photo_keys`, `team_tags`, `custom_fields`, `schedules`, `assignments`）。
- **Request**：`{ hostEpoch?: number; snapshotRevision?: number; fullProjection?: boolean; snapshot?: unknown[] | string; crdtSnapshotJson?: unknown[] | string; dirtyRows?: Record<string, string[]> }`
- **Response**：
  - `200 OK`: `{ saved: true, stale: false, eventId, hostEpoch, snapshotRevision, projectedCounts: { pit_records, team_tags, custom_fields, schedules, assignments, scouting_records } }`
  - `409 Conflict`: `{ saved: false, stale: true, error: 'stale_epoch' | 'stale_revision', eventId, hostEpoch, snapshotRevision }`
  - 错误码：`400` (`{ error: "Invalid eventId" | "Request body must be a JSON object" | "Invalid JSON body" | "snapshot array is required" }`), `403` (`"Not a member of this event"` / `"Only the event host can advance hostEpoch"`)

---

## 11. FTC 官方数据代理与晋级分汇算模块 (`FtcProxyRoutes` / `AdvancementCalculator` / `advancement.ts`)

> 所有 `/api/ftc/{season}/*/{eventCode}` 接口均要求：`season` 为 `2000..2100` 的整数，`eventCode` 匹配 `/^[A-Za-z0-9_-]{1,32}$/`；参数不合法返回 **`400` 纯文本**（如 `"Invalid season format"` / `"Invalid season"` / `"Invalid eventCode format"` / `"Invalid tournamentLevel"`，非 JSON），上游异常返回 `500 ({ error: string })`。
> 底层 `FtcApiClient` 内置 **45 秒内存 TTL 缓存**（`CACHE_TTL_MS = 45_000L`）与 `ETag` / `Last-Modified` HTTP `304` 协商缓存保护（上游 `404` 返回空 `{}`；其余非 `2xx` 抛出异常）；支持通过环境变量 `FTC_API_BASE_URL` / `FTC_API_USER` / `FTC_API_TOKEN` 覆盖默认官方端点与凭证（**环境变量优先于** `-Dftc.api.*` JVM 属性，见 `§14.4`）。

### `GET /api/ftc/{season}/matches/{eventCode}`
- **说明**：获取归一化后的 FTC 官方比赛列表及净得分（扣除对方犯规送分后的 `totalPointsNp = max(0, scoreFinal - opponentFoul)`）。不支持 `BIOBUZZ_SYNTHETIC`/`SYNTHETIC` 合成数据。
- **Request**：`Path: { season: number; eventCode: string }`, `Query: { tournamentLevel?: 'QUAL' | 'QUALIFICATION' | 'PLAYOFF' }`（大小写不敏感；`play*` 归一化为 `playoff`，其余归一化为 `qual`）
- **Response**：
  ```ts
  interface FtcNormalizedMatch {
    matchNum: number;
    tournamentLevel: string;
    series?: number;
    description?: string;
    scores: {
      red: { penaltyPointsCommitted: number; totalPointsNp: number; finalScore: number; totalTips?: number };
      blue: { penaltyPointsCommitted: number; totalPointsNp: number; finalScore: number; totalTips?: number };
    } | null;
    teams: Array<{
      teamNumber: number;
      alliance: 'Red' | 'Blue';
      dq?: boolean;
      onField?: boolean;
    }>;
  }
  type GetFtcMatchesResponse = FtcNormalizedMatch[];
  ```

### `GET /api/ftc/{season}/scores/{eventCode}`
- **说明**：获取 FTC 官方比赛详细小分（Score Breakdown 原始 JSON 对象）。
- **Request**：`Path: { season: number; eventCode: string }`, `Query: { tournamentLevel?: 'QUAL' | 'QUALIFICATION' | 'PLAYOFF' }`（缺省按 `qual` 请求）
- **Response**：`Record<string, unknown>`（FTC v2.0 `/v2.0/{season}/scores/{eventCode}/{level}` 响应体）

### `GET /api/ftc/{season}/teams/{eventCode}`
- **说明**：获取自动翻页聚合后的 FTC 官方参赛战队列表（最多翻页 20 页；跳过 `teamNumber <= 0`）。不支持 `BIOBUZZ_SYNTHETIC`/`SYNTHETIC` 合成数据。
- **Request**：`Path: { season: number; eventCode: string }`
- **Response**：
  ```ts
  interface FtcNormalizedTeam {
    teamNumber: number;
    nameFull: string;
    robotName: string;
    city: string;
    country: string;
  }
  type GetFtcTeamsResponse = FtcNormalizedTeam[];
  ```

### `GET /api/ftc/{season}/rankings/{eventCode}`
- **说明**：获取归一化后的 FTC 官方资格赛排名列表（`eventCode` 为 `BIOBUZZ_SYNTHETIC` / `SYNTHETIC` 时返回 16 支合成测试队伍排名）。
- **Request**：`Path: { season: number; eventCode: string }`
- **Response**：
  ```ts
  interface FtcNormalizedRanking {
    rank: number;
    teamNumber: number;
    sortOrder1?: number;
    sortOrder2?: number;
    sortOrder3?: number;
    sortOrder4?: number;
    sortOrder5?: number;
    sortOrder6?: number;
    wins?: number;
    losses?: number;
    ties?: number;
    qualMatchesPlayed?: number;
    dq?: number;
  }
  type GetFtcRankingsResponse = FtcNormalizedRanking[];
  ```

### `GET /api/ftc/{season}/awards/{eventCode}`
- **说明**：获取归一化后的 FTC 官方赛事奖项列表（支持 `BIOBUZZ_SYNTHETIC` / `SYNTHETIC` 合成测试数据）。
- **Request**：`Path: { season: number; eventCode: string }`
- **Response**：
  ```ts
  interface FtcNormalizedAward {
    teamNumber: number;
    name: string;
    series: number;
    awardId?: number;
  }
  type GetFtcAwardsResponse = FtcNormalizedAward[];
  ```

### `GET /api/ftc/{season}/alliances/{eventCode}`
- **说明**：获取归一化后的 FTC 官方季后赛联盟选队列表（支持 `BIOBUZZ_SYNTHETIC` / `SYNTHETIC` 合成测试数据）。
- **Request**：`Path: { season: number; eventCode: string }`
- **Response**：
  ```ts
  interface FtcNormalizedAlliance {
    number: number;
    captain: number;
    round1: number;
    round2?: number;
    round3?: number;
    backup?: number;
    name?: string;
  }
  type GetFtcAlliancesResponse = FtcNormalizedAlliance[];
  ```

### `GET /api/ftc/{season}/advancement/{eventCode}`
- **说明**：实时汇算赛事全部战队的 FTC 官方标准晋级分、晋级状态及顺延结果。若 `rankings` 为空但 `teams` 非空，则按队伍顺序构建默认 `rank = 1..N`。
- **设计取舍（`slots <= 0` 与双大小写解析）**：`slots <= 0`（或非有限数）在 HTTP 参数、Java `AdvancementCalculator` 及 TS `advancement.ts` 中均有意视为“未指定名额”，统一回退至官方 `/v2.0/{season}/advancement/{eventCode}` 返回的 `slots` 后再回退默认 `4`；负队号在双端统一夹紧丢弃；场次/队伍/排名同时兼容 FTC API 原始 PascalCase（`MatchNum`/`TeamNumber`/`Alliance` 等）与前端归一化 camelCase 字段。
- **Request**：`Path: { season: number; eventCode: string }`, `Query: { slots?: number }`（可选覆盖官方晋级名额；**非整数或 `<= 0` 时静默忽略**并回退至官方 `/v2.0/{season}/advancement/{eventCode}` 的 `slots`，再回退默认 `4`）
- **Response**：
  ```ts
  interface AdvancementBreakdown {
    qualPoints: number;
    alliancePoints: number;
    playoffPoints: number;
    awardPoints: number;
  }

  interface TeamAdvancementEntry {
    teamNumber: number;
    advancementRank: number;
    totalAdvancementPoints: number;
    qualRank: number;
    qualPoints: number;
    alliancePoints: number;
    playoffPoints: number;
    awardPoints: number;
    advancementStatus: 'ADVANCING' | 'BUBBLE' | 'COMPETING' | 'ALREADY_ADVANCING' | 'DECLINED' | 'INELIGIBLE';
    rolledDown: boolean;
    declined?: boolean;             // 仅当 declined === true 时序列化
    officialStatus?: string;        // 原始 FTC API 状态（如 'FIRST'、'ALREADY_ADVANCING'、'INELIGIBLE'；'ALREADY_ADVANCED' 归一化为 'ALREADY_ADVANCING'）
    advancementSlot?: number;       // 仅当 > 0 时序列化
    advancementCriteria?: string;   // 仅当非空时序列化
    advancesTo?: string;            // 仅当官方返回非空 advancesTo 时序列化
    breakdown: AdvancementBreakdown;
  }
  type GetFtcAdvancementResponse = TeamAdvancementEntry[];
  ```

### FTC 晋级积分与顺延规则契约（Java + TS 双端必须严格同步）
> [!IMPORTANT]
> 后端 `AdvancementCalculator.java` 与前端 `frontend/src/utils/analytics/advancement.ts` **同时实现了以下完整算法**（前端用于离线/实时重算，后端用于 `/api/ftc/{season}/advancement/{eventCode}`）。修改任意一方计分、平分或顺延逻辑时，**必须同步修改另一端**。

1. **Qualification Phase Performance Points (`qualPoints`, `2..16`)**：
   - 常数 `ALPHA = 1.07`；若 `totalTeams <= 0 || rank <= 0` 返回 `0`，`totalTeams === 1` 返回 `16`。
   - 公式：`ceil( invErf(clamp((N - 2*rank + 2) / (ALPHA * N), -0.999999, 0.999999)) * (7 / invErf(1 / ALPHA)) + 9 )`，结果夹紧至 `[2, 16]`（`erf` 采用 Abramowitz & Stegun 7.1.26，`invErf` 采用 Winitzki 初值 + 2 轮 Newton-Raphson）。
2. **Alliance Selection Results Points (`alliancePoints`)**：
   - `totalAlliances = alliances.length >= 2 ? max(alliances.length, maxSeed) : max(4, maxSeed)`。
   - Captain 与 Round 1 Pick：`max(0, 21 - seed)`。
   - Round 2 Pick（蛇形逆序）：`max(0, 21 - (2 * totalAlliances - seed + 1))`。
   - Round 3 Pick：`max(0, 21 - (2 * totalAlliances + seed))`。
3. **Playoff Advancement Points (`playoffPoints`)**：
   - 仅统计 `tournamentLevel === 'PLAYOFF'` 场次及非个人/非评审类奖项（`Winner = 40`, `Finalist = 20`, `3rd = 10`, `4th = 5`）。
   - 双败淘汰赛通过 `description` 含 `upper bracket`/`lower bracket`/`final bracket` 识别：进入 Finals 的队伍按 `officialWinnerTeams`/`officialFinalistTeams` 或胜场决出 `40`/`20`；未进 Finals 的队伍优先匹配官方 3rd/4th 奖项，若 Finals 未开赛则胜场 `> 0` 暂定 `20` 否则 `5`；双败已进 Finals 时按最高淘汰轮次 `tierIndex 0 -> 10, tierIndex 1 -> 5`，单败/兜底则胜场 `> 0 -> 10` 否则 `5`。
4. **Judged Team Award Points (`awardPoints`, Rule A215)**：
   - 排除 `dean` / `compass` / `promote` / `volunteer` / `safety`。
   - **Inspire / 启迪**：1st=`60`, 2nd=`30`, 3rd=`15`。
   - **其他官方评审团队奖**（Think, Connect, Innovate, Design, Motivate, Control, Sustain, Reach, Judges' Choice 及对应中文名）：1st=`12`, 2nd=`6`, 3rd=`3`。
   - 若 `series <= 1` 但奖项名含 `2nd`/`second`/`finalist`/`第二`/`第2` 或 `3rd`/`third`/`第三`/`第3`，自动修正 `effectiveSeries` 为 `2` 或 `3`。
   - **Rule A215**：单支队伍单场赛事仅取最高一项评审奖项积分（`max(awardPoints, pts)`）。
5. **Table 4-2 排序与平分规则（7 级降序 + 队号升序兜底）**：
   1. `totalAdvancementPoints` (`qual + alliance + playoff + award`) 降序
   2. `awardPoints` 降序
   3. `playoffPoints` 降序
   4. `alliancePoints` 降序
   5. `qualPoints` 降序
   6. `tiebreakerSort1`（来自 `rankings.sortOrder1`）降序
   7. `tiebreakerSort2`（来自 `rankings.sortOrder2`）降序
   8. `teamNumber` 升序
6. **状态与顺延逻辑 (`applyAdvancementStatuses`)**：
   - 跳过资格判定：`rawStatus === 'ALREADY_ADVANCING'`（或 `'ALREADY_ADVANCED'`）-> `'ALREADY_ADVANCING'`；`'INELIGIBLE'` -> `'INELIGIBLE'`；`declined === true` -> `'DECLINED'`。
   - 若未显式传 `?slots=` 且官方列表含有效 `FIRST` 记录，优先按官方 `FIRST` 标记分配 `ADVANCING`（最多 `slots` 个），随后按积分排序顺延补足剩余名额；`rolledDown = (advancementSlot > slots) || (advancementRank > slots)`。
   - 剩余未跳过且未晋级队伍中，前 **2** 名标记为 `'BUBBLE'`，其余标记为 `'COMPETING'`。

---

## 12. AI Copilot 配置、连通性探测、实时语音与多会话模块 (`AiRoutes` / `routes/ai/*`)

> 路由入口由 `AiRoutes` 协调注册，具体实现拆分为 `AiProfileRoutes`（配置档案与旧版 `/ai-settings`）、`AiStreamAndProbeRoutes`（连通性探测与流式/非流式对话）、`AiThreadRoutes`（多会话线程与旧版 `/ai-chat`）、`AiVoiceRoutes`（全双工实时语音中继 `WS /ws/ai/voice` 与语音识别 `POST /api/ai/audio/transcribe`）、`AiUrlGuard`（HTTP/WS SSRF 校验与 Key 脱敏）及 `AiSchemaBootstrap`（幂等建表自愈）。

```ts
interface AiProviderProfile {
  id: string;
  userId?: string;
  name: string;
  presetId: string;
  protocol: 'OPENAI' | 'GEMINI' | 'ANTHROPIC';
  apiKeyEncrypted: string; // 响应中始终脱敏：长度 > 6 时为 "<前2字符>****************<后4字符>"，1..6 时为 "****"，无密钥为 ""，主密钥丢失解密失败为 "ERR_KEY_LOST"
  hasApiKey: boolean;
  baseUrl: string;
  modelName: string;
  customModels: string[];
  customModelsJson?: string;
  systemPrompt: string;
  temperature: number;     // 默认 0.4
  maxTokens: number;       // 默认 4096 (<= 0 时重置为 4096)
  enableThinking: boolean; // 默认 false（可在前端聊天栏按次切换 off/low/medium/high）
  thinkingBudget: number;  // 默认 4096 (< 1024 时重置为 4096；按次覆盖支持 0 关闭)
  anthropicVersion: string;// 默认 '2023-06-01'
  maxContextMsgs: number;  // 默认 16 (<= 0 时重置为 16)
  proxyHost: string;
  proxyPort?: number | null;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

interface AiSettings { // 旧版兼容模型
  userId?: string;
  provider: 'OPENAI' | 'GEMINI' | 'ANTHROPIC';
  apiKeyEncrypted: string; // GET 响应中脱敏
  modelName: string;
  systemPrompt: string;
  proxyHost: string;
  proxyPort: number | null;
  baseUrl?: string;
  createdAt?: string;
  updatedAt?: string;
}
```

### `GET /api/users/{userId}/ai-profiles`
- **说明**：获取当前用户的多 AI 服务商配置档案列表（若尚无新档案但有旧版 `ai_settings`，自动迁移生成 `migrated-<uuid>`；API Key 自动脱敏）。
- **Request**：`Path: { userId: string }`（必须等于当前登录 `userId`）
- **Response**：`AiProviderProfile[]`
  - 错误码：`403` (`"Cannot access AI profiles of another user"`)

### `POST /api/users/{userId}/ai-profiles`
- **说明**：创建或更新 AI 服务商配置档案。
  - **归属与列宽安全**：若客户端传入 `id`（先 `trim()`，上限 `128` 字符）且该 `id` 在全局已存在但 `user_id != sessionUserId`，直接返回 `403`；`UPDATE` 严格限定 `WHERE id = :id AND user_id = :userId`。校验 `baseUrl`（<=500）与 `proxyHost`（<=255，`AiUrlGuard.isSafeProxyHost`）、`proxyPort`（`1..65535`）、`temperature`（`[0, 2]`），拒绝 `apiKey`/`anthropicVersion` 中的 CR/LF 控制字符，并对 `name`（120）、`presetId`（48）、`modelName`（200）、`anthropicVersion`（32）安全截断。
  - **Key 解析、密文损坏拦截与沿用**：优先读取 `body.apiKey`，其次 `body.apiKeyEncrypted`；当更新已有档案但库内密文不可解密（`!AiUrlGuard.isDecryptableEncryptedKey`）时，若请求未提供有效新明文（空串、脱敏占位符或 `"ERR_KEY_LOST"`，且非显式 `clearApiKey === true` 本地免密清除），强制返回 `400 ("Saved API key could not be decrypted; please re-enter your API key")` 严禁静默覆盖或保留坏密文；当库内密文完好且提交值为空或非 `"ERR_KEY_LOST"` 的脱敏占位符（`***` / `****`）时沿用原加密 Key；仅当 `protocol === 'OPENAI'` 且 `baseUrl` 为 Loopback 地址时允许免 Key（`""`）或通过 `clearApiKey: true` 清除。
  - **默认值与激活**：新建 `GEMINI` 档案且 `customModels` 为空时自动填充 `["gemini-flash-latest", "gemini-pro-latest", "gemini-flash-lite-latest"]`。若 `isActive === true`、用户尚无任何档案、或更新当前激活档案且请求体未显式传 `isActive` 字段，则自动设为唯一激活档案。
- **Request**：
  ```ts
  interface SaveAiProfileBody {
    id?: string;
    name?: string;
    presetId?: string;
    protocol: 'OPENAI' | 'GEMINI' | 'ANTHROPIC';
    apiKey?: string;
    apiKeyEncrypted?: string;
    clearApiKey?: boolean;
    baseUrl?: string;
    modelName?: string;
    customModels?: string[];
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
    enableThinking?: boolean;
    thinkingBudget?: number;
    anthropicVersion?: string;
    maxContextMsgs?: number;
    proxyHost?: string;
    proxyPort?: number | null;
    isActive?: boolean;
  }
  ```
- **Response**：`AiProviderProfile`
  - 错误码：`400` (`{ error: "Request body must be a JSON object" | "Invalid JSON body: ..." | "Invalid profile fields: ..." | "Missing profile payload" | "Unsupported AI protocol: ..." | "Forbidden baseUrl: SSRF protection blocked access" | "API Key is required for non-local AI provider profile" }`), `403`, `500`

### `POST /api/users/{userId}/ai-profiles/{profileId}/activate`
- **说明**：将指定 AI 配置档案设为当前用户的唯一激活档案。
- **Request**：`Path: { userId: string; profileId: string }`
- **Response**：`{ success: true; activeProfileId: string }`
  - 错误码：`403`, `404` (`{ error: "AI profile not found" }`)

### `DELETE /api/users/{userId}/ai-profiles/{profileId}`
- **说明**：删除指定 AI 配置档案；若删除的是当前激活档案，自动激活剩余列表中的第一个档案；否则返回当前激活档案 ID（或 `null`）。
- **Request**：`Path: { userId: string; profileId: string }`
- **Response**：`{ success: true; nextActiveProfileId: string | null }`
  - 错误码：`403`, `404` (`{ error: "AI profile not found" }`)

### `GET /api/users/{userId}/ai-settings` & `POST /api/users/{userId}/ai-settings`（旧版兼容）
- **说明**：读取或保存旧版按 `provider`（`OPENAI | GEMINI | ANTHROPIC`）存储的 `AiSettings`（Key 脱敏与沿用规则同上，但不支持免 Key；`POST` 同样强制执行 `baseUrl` / `proxyHost` SSRF 校验、`proxyPort` `1..65535` 校验及 Key CR/LF 校验）。
- **Response (`GET`)**：`AiSettings[]`；**Response (`POST`)**：`{ success: true }`
  - 错误码：`400` (`{ error: "Invalid JSON body..." | "Invalid JSON body or missing provider" | "API Key is required for new provider configuration" | "Forbidden baseUrl: SSRF protection blocked access" | "Forbidden proxyHost: SSRF protection blocked access" }`), `403`, `500`

### `POST /api/ai/test-connection`（别名：`GET /api/ai/test-connection`、`POST /api/ai/models`）
- **说明**：测试 AI 服务商连通性并在线拉取可用模型列表（支持 `OPENAI`、`GEMINI`、`ANTHROPIC`；当未传明文 `apiKey` 且按协议归一化比对 `AiUrlGuard.isTrustedSavedUrl(customBaseUrl, savedBaseUrl, protocol)` 为真时——包括库内或请求 `baseUrl` 为空回退协议默认基址及尾部斜杠 `/` 差异——允许解密已存 Key，防止篡改远端宿主触发 SSRF 窃取 Key）。
  - **SSRF 安全边界（`AiUrlGuard.isSafeUrl` / `isSafeProxyHost`）**：仅允许 `http://` 或 `https://`（禁止 URL `userInfo` 与控制字符）；通过 `InetAddress.getAllByName` 校验全部解析记录；除显式放行本机 Loopback（`localhost`、`127.0.0.1`、`::1`、`0:0:0:0:0:0:0:1`）外，严禁访问其他 Loopback（如 `127.0.0.2`）、局域网私网段（`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`）、CGNAT（`100.64.0.0/10`）、链路本地/云元数据地址（`169.254.0.0/16`、`fe80::/10`）、IPv6 ULA（`fc00::/7`）、IPv4-mapped IPv6（`::ffff:0:0/96`）、IPv4-compatible IPv6（`::/96`，按内嵌 `bytes[12..15]` IPv4 规则校验并拦截私网/元数据/回环段）、多播与未指定地址（`0.0.0.0/8`、`::`）；自定义 `proxyHost` 同样受 `isSafeProxyHost` 约束。
  - **HTTP 状态码约定**：参数或 SSRF 校验失败返回 HTTP `400`；进入上游 HTTP 探测后，即使上游返回错误或超时（8s 连接/请求超时），本接口 HTTP 状态码**始终返回 `200`**。
- **Request**：（支持 JSON Body 或同名 Query 参数）
  ```ts
  interface AiProbeRequest {
    profileId?: string;
    protocol?: 'OPENAI' | 'GEMINI' | 'ANTHROPIC';
    provider?: string; // protocol 的兼容别名
    baseUrl?: string;
    apiKey?: string;
    anthropicVersion?: string; // 默认 '2023-06-01'
    proxyHost?: string;
    proxyPort?: number | string;
  }
  ```
- **Response**：
  ```ts
  interface AiProbeResponse {
    success: boolean;
    modelsSupported?: boolean;
    statusCode?: number;
    latencyMs: number;
    models: string[];
    messageCode?: 'PROBE_AUTH_OK' | 'PROBE_REACHABLE_OK' | 'PROBE_MODELS_UNSUPPORTED' | 'PROBE_NEEDS_KEY' | 'PROBE_AUTH_FAILED' | 'PROBE_HTTP_ERROR';
    message?: string;
    error?: string;
  }
  ```
  - 错误码：`400` (`{ error: "Missing provider/protocol" | "Unsupported protocol: ..." | "Forbidden target URL: SSRF protection blocked access to private or metadata addresses" | "Invalid proxy port" }`)

### `POST /api/ai/chat`
- **说明**：执行非流式 AI 对话请求（当仅传旧版 `provider` 而未传 `profileId` 且未显式传 `enableThinking` 时自动关闭深度思考 `enableThinking = false`；若无正文返回 `"[No Content Returned]"`）。**与流式接口同样强制执行 `AiUrlGuard.isSafeUrl` / `isSafeProxyHost`、`temperature` (`[0, 2]`) 及严格 JSON 类型校验（非法类型返回 `400`）**。
- **Request**：
  ```ts
  interface AiChatBody {
    profileId?: string; // profileId 与 provider 二选一必填
    provider?: string;
    systemPrompt?: string;
    modelName?: string;
    temperature?: number;
    enableThinking?: boolean;   // 可选：按次覆盖档案深度思考开关（Gemini 显式下发 thinkingConfig.includeThoughts/thinkingBudget）
    thinkingBudget?: number;    // 可选：按次覆盖思考 Token 预算（>= 0；false+0 时 Gemini 自动降级 128/省略以兼容仅支持思考模型）
    reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high'; // 可选：OpenAI o1/o3/o4/gpt-5 reasoning_effort 映射
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  }
  ```
- **Response**：`{ reply: string }`
  - 错误码：`400` (`{ error: "Request body must be a JSON object" | "Invalid JSON format: ..." | "Missing provider or profileId" | "AI Settings not configured for provider: ..." }`), `401`, `500` (`{ error: string }`)

### `POST /api/ai/chat/stream`
- **说明**：执行三协议统一的 SSE（`text/event-stream; charset=UTF-8`）流式 AI 对话（显式设置 `AsyncContext.setTimeout(300_000L)`、含 15 秒 `: heartbeat` 保活、深度思考 `reasoning` 块、正文 `text` 块与 Token `usage` 统计；进入流式前及 `AiClient.chatStream` 拼接最终 endpoint 后均执行 `AiUrlGuard.isSafeUrl` 校验）。
- **Request**：同 `AiChatBody`
- **Response**：`200 text/event-stream; charset=UTF-8`
  ```ts
  // SSE 帧序列（三大协议适配器均统一输出 camelCase usage）：
  // : heartbeat
  // data: {"reasoning": string}
  // data: {"text": string}
  // data: {"usage": { promptTokens: number; completionTokens: number; totalTokens: number; thoughtsTokens?: number }}
  // data: {"error": string}
  // data: [DONE]
  ```
  - 错误码：`400` (`{ error: "Missing provider or profileId" | "AI Settings not configured..." | "Forbidden baseUrl: SSRF protection blocked access" }`), `401`
  - **前端兼容注意**：`useAiChatStream.ts` 解析 `usage` 时同时兼容 camelCase (`promptTokens`) 与 snake_case (`prompt_tokens`)，且采用 `requestAnimationFrame` 合并高频 delta。

### `WS /ws/ai/voice`
- **说明**：AI Copilot 原生全双工实时语音中继通道（Jetty WS 单帧上限 `2 MB`、空闲超时 `15 min`，每 20s 自动 Ping 保活）。建立连接后须在 **`10s`** 内发送首帧 `start` 完成 JWT 鉴权与档案绑定；后端在服务端解密 Key，按协议路由至 Google Gemini Live (`BidiGenerateContent` v1beta，默认 `gemini-3.8-live`，16kHz PCM16 上行 / 24kHz PCM16 下行) 或 OpenAI Realtime (`/v1/realtime`，GA 默认 `gpt-realtime` / 含 `preview` 模型自动附加 `OpenAI-Beta: realtime=v1`，24kHz PCM16 上下行)，并复用 `AiProxyResolver` 与 `AiUrlGuard.isSafeUrl` / `isSafeWebSocketUrl`。
- **Live 模型解析优先级 (`resolveEffectiveLiveModel`)**：
  1. `start.model` 非空时优先使用；
  2. 否则仅当 `profile.modelName` 含 `live` / `native-audio`（Gemini）或含 `realtime`（OpenAI）时继承；
  3. 否则回退至 `gemini-3.8-live`（Gemini）或 `gpt-realtime`（OpenAI）。
- **Client → Server JSON 帧**：
  ```ts
  type AiVoiceClientFrame =
    | {
        type: 'start';
        token: string;
        profileId?: string;
        provider?: 'GEMINI' | 'OPENAI' | string;
        model?: string;
        voice?: string;        // GEMINI 默认 'Kore'；OPENAI 默认 'alloy'
        inputMode?: 'vad' | 'ptt'; // 默认 'vad'；OPENAI 'ptt' 模式将 turn_detection 设为 null
        systemPrompt?: string; // 含赛事上下文与人设的完整系统提示词
        history?: Array<{ role: 'user' | 'assistant' | 'model'; content: string }>; // 最多截取最近 12 轮 / 12,000 字符
      }
    | { type: 'audio'; data: string }            // Base64 Raw PCM16 Little-Endian Mono
    | { type: 'audio_end'; commit?: boolean }    // 暂停拾音 / PTT 结束提交（默认 commit = true；OpenAI 仅 'ptt' 模式发送 commit+response.create）
    | { type: 'mode'; inputMode: 'vad' | 'ptt' } // 通话中动态切换 OpenAI Realtime 的 VAD/PTT 模式
    | { type: 'text'; text: string }             // 通话中静默补充文字指令
    | { type: 'interrupt' }                      // 主动打断 AI 当前语音输出
    | { type: 'stop' };                          // 主动结束并关闭会话
  ```
- **Server → Client JSON 帧**：
  ```ts
  type AiVoiceServerFrame =
    | {
        type: 'ready';
        engine: 'gemini-live' | 'openai-realtime';
        model: string;
        voice: string;
        inputSampleRate: 16000 | 24000;
        outputSampleRate: 24000;
      }
    | { type: 'audio'; data: string; sampleRate: number; mimeType: string }
    | { type: 'transcript'; role: 'user' | 'assistant'; text: string; interim: boolean; replace?: boolean; final?: boolean }
    | { type: 'interrupted' }
    | { type: 'status'; interactionStatus: 'IN_PROGRESS' | 'IDLE' | string }
    | { type: 'turn_complete'; turnComplete?: boolean; generationComplete?: boolean; interactionStatus?: string }
    | { type: 'go_away'; timeLeft?: string }
    | { type: 'usage'; usage: { promptTokens: number; completionTokens: number; totalTokens: number; thoughtsTokens?: number } }
    | { type: 'error'; code: string; message: string };
  ```
- **完整错误码 (`error.code`)**：
  - 鉴权/协议与帧校验：`AUTH_TIMEOUT`、`UNAUTHORIZED`、`ALREADY_STARTED`、`BAD_MESSAGE`、`INVALID_JSON`、`MISSING_TYPE`、`UNKNOWN_TYPE`、`NOT_STARTED`、`MISSING_PROFILE`、`PROFILE_NOT_FOUND`、`FORBIDDEN_URL`、`KEY_DECRYPT_FAILED`、`API_KEY_REQUIRED`、`UNSUPPORTED_PROTOCOL`。
  - 上游中继：`UPSTREAM_CONNECT_FAILED`、`UPSTREAM_SEND_FAILED`、`UPSTREAM_ERROR`、`UPSTREAM_WS_ERROR`。
- **Token 用量帧闭环**：前端 `useAiVoiceSession.ts` 在 `socket.onmessage` 中监听 `type: 'usage'` 帧，无论该帧先于或紧随 `turn_complete` 到达，均将 `usage`（`promptTokens`/`completionTokens`/`totalTokens`/`thoughtsTokens`）挂载至对应 `viaVoice` 助手消息并触发 `scheduleSaveThread` 持久化。

### `POST /api/ai/audio/transcribe`
- **说明**：统一语音识别（STT）后端接口（请求体上限 `15 MB`、音频解码上限 `10 MB` 且使用 `Base64.getMimeDecoder()` 兼容换行，并对 `profile.baseUrl` 与 `proxyHost` 执行 `AiUrlGuard` 校验）。
  - `GEMINI`：向 `:generateContent` 发送 `inline_data` 音频做逐字转录；模型优先取 `model` 覆盖参数，其次取不含 `live`/`tts` 的 `profile.modelName`，否则回退 `gemini-flash-latest`。
  - `OPENAI`：向 `<baseUrl>/audio/transcriptions` 发送 `multipart/form-data`（若未传 `model`，按厂商自动选择：Groq → `whisper-large-v3-turbo`、SiliconFlow → `FunAudioLLM/SenseVoiceSmall`、OpenAI 官方 → `gpt-4o-mini-transcribe`、其余兼容网关 → `whisper-1`）。
  - `ANTHROPIC`：返回 `400`（不支持音频转录）。
- **Request**：
  ```ts
  interface AiTranscribeBody {
    profileId?: string; // profileId 与 provider 二选一必填
    provider?: string;
    audioBase64: string; // Base64 编码或 data:audio/...;base64,...（解码后 1 B .. 10 MB）
    mimeType?: string;   // 默认 'audio/wav'
    language?: string;   // 可选语言提示（如 'zh' / 'en'）
    model?: string;      // 可选覆盖识别模型
  }
  ```
- **Response**：`{ text: string }`
  - 错误码：`400` (`"Request body must be a JSON object"` / `"Invalid JSON format: ..."` / `"Missing provider or profileId"` / `"audioBase64 is required"` / `"Invalid audioBase64 encoding"` / `"Audio payload cannot be empty"` / `"Audio payload exceeds 10 MB limit"` / `"AI Settings not configured for provider: ..."` / `"Forbidden baseUrl: SSRF protection blocked access"` / `"Anthropic protocol does not support audio transcription"` / `"Failed to decrypt API key; please re-save it in settings"` / `"API Key is required for audio transcription"` / `"Unsupported protocol for transcription: ..."`), `401`, `502` (`{ error: string }`)

### AI 会话线程消息与上下文数据结构（`AiChatThread`）
```ts
interface AiTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  thoughtsTokens?: number;
}

interface AiTurboActionResult {
  id: string;
  type: string;
  status: 'pending' | 'success' | 'error';
  summary: string;
  detail?: string;
  error?: string;
  actedAsUsername?: string;
  executedAt?: string;
}

interface AiChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  reasoningDurationMs?: number;
  createdAt?: string;
  modelName?: string;
  profileName?: string;
  usage?: AiTokenUsage;
  durationMs?: number;
  contextSummary?: string;
  viaVoice?: boolean;
  stopped?: boolean;
  error?: string;
  aiMode?: 'ask' | 'turbo';
  turboActions?: AiTurboActionResult[];
}

interface AiContextSections {
  rankings: boolean;
  schedule: boolean;
  pit: boolean;
  matches: boolean;
  tags: boolean;
}

interface AiContextFocusMatch {
  matchNumber: number;
  tournamentLevel?: string;
}

interface AiContextConfig {
  enabled: boolean;
  sections: AiContextSections;
  focusTeams: number[];
  focusMatch: AiContextFocusMatch | null;
}
```
> **前后端默认差异**：后端创建线程时若省略 `contextConfig`，默认持久化 `{"enabled":true}`（无 `sections`/`focusTeams`/`focusMatch`）；前端 `normalizeContextConfig()` 会将缺省字段补全为全 `true`、`focusTeams: []`、`focusMatch: null`。

### `GET /api/events/{id}/ai-threads`
- **说明**：赛事成员获取本人在该赛事下的 AI 战术会话线程摘要列表（若无线程但有旧版 `ai_chat_sessions` 记录则自动迁移生成）。
- **Request**：`Path: { id: string }`
- **Response**：
  ```ts
  interface AiThreadSummary {
    id: string;
    eventId: string;
    title: string;
    personaId: string;
    pinned: boolean;
    messageCount: number;
    lastMessagePreview: string; // 剥离已闭合及尾部未闭合 sp27-action 块并压缩空白后截断 80 字符；纯 action 消息回退 "[Turbo] <summary>"
    createdAt?: string;
    updatedAt?: string;
  }
  type GetAiThreadsResponse = AiThreadSummary[];
  ```
  - 错误码：`401`, `403` (`"Not a member of this event"`)

### `POST /api/events/{id}/ai-threads`
- **说明**：赛事成员在当前赛事下创建新的 AI 会话线程（强归属校验：若传入 `id` 在全局已存在且属于其他用户返回 `403`，同用户但属于其他赛事返回 `409`；`id` 上限 `128` 字符，`personaId` 截断 `48` 字符，`pinned` 必须为布尔值）。
- **Request**：
  ```ts
  interface CreateAiThreadBody {
    id?: string;
    title?: string;     // 默认 'New Tactical Chat'，最长 180 字符
    personaId?: string; // 默认 'strategist'
    pinned?: boolean;
    messages?: AiChatMessage[];
    contextConfig?: Partial<AiContextConfig>;
  }
  ```
- **Response**：
  ```ts
  interface AiThreadPayload {
    id: string;
    userId: string;
    eventId: string;
    title: string;
    personaId: string;
    pinned: boolean;
    messages: AiChatMessage[];
    contextConfig: AiContextConfig | { enabled: boolean };
    createdAt?: string;
    updatedAt?: string;
  }
  ```
  - 错误码：`400` (`{ error: "Invalid JSON body" }`), `401`, `403`, `409`

### `GET /api/events/{id}/ai-threads/{threadId}`
- **说明**：赛事成员获取单个 AI 会话线程的完整消息与上下文配置（线程属于其他用户返回 `403`，不存在或属于其他赛事返回 `404`）。
- **Request**：`Path: { id: string; threadId: string }`
- **Response**：`AiThreadPayload`
  - 错误码：`401`, `403`, `404` (`{ error: "Thread not found" }`)

### `PUT /api/events/{id}/ai-threads/{threadId}`
- **说明**：赛事成员更新（或按 ID 幂等创建）单个 AI 会话线程（归属核验：属于其他用户返回 `403`，同用户属于其他赛事返回 `409`，SQL `UPDATE` 严格限定 `WHERE id = :id AND user_id = :userId AND event_id = :eventId`）；`messages`/`messagesJson` 与 `contextConfig`/`contextConfigJson` 互斥优先取对象/数组字段。
- **Request**：
  ```ts
  interface UpdateAiThreadBody {
    title?: string;
    personaId?: string;
    pinned?: boolean;
    messages?: AiChatMessage[];
    messagesJson?: string;
    contextConfig?: Partial<AiContextConfig>;
    contextConfigJson?: string;
  }
  ```
- **Response**：`AiThreadPayload`
  - 错误码：`400` (`{ error: "Request body must be a JSON object" | "Invalid JSON: ..." | "messages must be a JSON array" | "messagesJson must be a JSON array string" | "contextConfig must be a JSON object" | "contextConfigJson must be a JSON object string" }`), `401`, `403`, `409`

### `DELETE /api/events/{id}/ai-threads/{threadId}`
- **说明**：赛事成员删除本人的指定 AI 会话线程（属于其他用户返回 `403`）。
- **Request**：`Path: { id: string; threadId: string }`
- **Response**：`{ success: true }`
  - 错误码：`401`, `403`, `404` (`{ error: "Thread not found" }`)

### `GET /api/events/{id}/ai-chat` & `PUT /api/events/{id}/ai-chat`（旧版兼容）
- **说明**：赛事成员读取或覆盖当前用户在指定赛事下的旧版单会话消息 JSON 数组（统一通过 `requireEventMember` 校验 `isMember`）。
- **Request (`PUT`)**：`Body: unknown[]`（必须为 JSON 数组）
- **Response (`GET`)**：`unknown[]`；**Response (`PUT`)**：`{ success: true }`
  - 错误码：`400` (`"Body must be a JSON array"` / `"Invalid JSON"`), `401`, `403` (`"Not a member of this event"`), `500`

### AI 前端目录、人设与上下文构建关键不变量
- **`personas.ts`**：`DEFAULT_PERSONA_ID = 'strategist'`；内置 5 个 `personaId`：`strategist`、`match_coach`、`brag_auditor`、`concise_brief`、`custom`。`assembleSystemPrompt` 对非 `custom` 人设自动注入 `getBiobuzzRulesBase(locale)` + 人设指令 + 非 `LEGACY_GENERIC_PROMPT` 的档案附加提示词 + `dataContext`；若 `personaId === 'custom'` 且 `profileSystemPrompt` 为空则回退至 `strategist`。队号须按 `#27570` 或 `Team 27570` 格式输出以支持前端团队芯片解析。
- **`protocolCatalog.ts` / `presets.ts`**：
  - `PROTOCOL_META` 定义三协议默认基址与鉴权头：`OPENAI` (`https://api.openai.com/v1`, `Authorization: Bearer <KEY>`)、`GEMINI` (`https://generativelanguage.googleapis.com/v1beta`, `x-goog-api-key: <KEY>`)、`ANTHROPIC` (`https://api.anthropic.com`, `x-api-key: <KEY>` + `anthropic-version: 2023-06-01`)。
  - `GEMINI_DEFAULT_MODELS` 为 `['gemini-flash-latest', 'gemini-pro-latest', 'gemini-flash-lite-latest']`。
  - `AI_PROFILE_DEFAULTS` 与后端一致：`temperature: 0.4`, `maxTokens: 4096`, `enableThinking: false`, `thinkingBudget: 4096`, `anthropicVersion: '2023-06-01'`, `maxContextMsgs: 16`。
  - `isMaskedOrPlaceholderApiKey` 识别空串、`****`、`ERR_KEY_LOST` 或含 `***` 的脱敏串，避免前端回传覆盖后端密文。
- **`turboAgent.ts` & `sp27-action` 协议隔离**：Turbo 模式以当前登录用户身份执行前端/CRDT/后端真实写入（`add_tag`/`remove_tag`/`create_match_record`/`update_match_record`/`delete_match_record`/`upsert_pit_record`/`ban_team`/`unban_team`/`assign_scout`/`set_my_team`/`create_custom_field`/`update_custom_field`/`delete_custom_field`），严格校验 Host/作者权限；`ask` 模式严格只读不执行任何 `sp27-action` 块。`sp27-action` 块在历史上下文（`payloadMessages`）、消息复制、Markdown 导出、TTS 朗读（流式推送同步保留末尾反引号前缀缓冲）及侧边栏摘要中统一剥离，仅持久化人类可读正文 + `turboActions` 回执；纯 action 无正文且有已执行回执时**不填充** `ai.no_content_returned`；SSE 流错误响应仅单次读取 `res.text()` 后尝试 `JSON.parse`，保留上游非 JSON 明文错误提示。
- **`teamMatcher.ts` 设计取舍（3–6 位 FTC 队号约束）**：交互式队号高亮与芯片解析刻意限定匹配 3–6 位数字（`100..999999`），避免比赛场号/得分等 1–2 位常见数字误触发战队跳转芯片（`#1`、`Q2` 等）。
- **`contextBuilder.ts`**：`DEFAULT_MAX_CHARS_BUDGET = 28000`；`buildEventDataContext` 按 Focus/MyTeam → BannedTeams → Rankings（含 SP-NP OPR、Predict Cycle、Advancement）→ Schedule（优先相关场次，最多 32 场）→ Tags → Pit → CustomMetrics → Budgeted Matches 组装紧凑文本快照。

---

## 13. JCEF 桌面容器、静态托管与前端全局桥接 (`Main.java` / `window.*`)

> 本项目 JCEF 容器未注册 `CefMessageRouter`（无 `window.cefQuery`），桌面宿主与前端通过内嵌 Javalin HTTP/WS 服务及以下全局 Window Hook / 控制台拦截交互：

### `JCEF Shell Query: ?shell=desktop`（仅 Windows 桌面壳）
- **说明**：`Main.buildLocalAppUrl(port, hasCustomTitleBar)` 在 Windows 桌面端（`hasCustomTitleBar = true`，使用无边框 `JFrame` + Swing `CustomTitleBar` + `WindowResizer`，`1024x768`，`#0B0E10` 背景，`24px` 圆角、`MAXIMIZED_BOTH` 时取消圆角）启动内嵌浏览器时加载 `http://localhost:<port>/index.html?shell=desktop`；macOS / Linux 使用系统原生标题栏（`hasCustomTitleBar = false`，macOS 额外追加 `--no-sandbox` 防止 `NSWindowStyleMaskBorderless` SIGTRAP），加载 `http://localhost:<port>/index.html`（不带 `shell` 参数）。
- **前端识别与表现**：`frontend/src/utils/desktopShell.ts#hasDesktopTitleBar()` 通过 `new URLSearchParams(window.location.search).get('shell') === 'desktop'` 判定；返回 `true` 时，`DashboardView.vue` 为 `.topbar` 添加 `.is-desktop-shell` 并用 `.page-heading` 替代 `.brand` Logo，`EventView.vue` 隐藏 `.event-brand-logo`，避免与桌面自定义标题栏重复展示品牌元素。

### `JCEF & E2E Bridges: window.__rtcDisconnect` / `__rtcSimulateNetworkDrop` / `__sp27E2eBridge`
- **说明**：
  - `window.__rtcDisconnect()`：在 `frontend/src/stores/connection.ts` 中绑定 `() => svc?.disconnect()`。桌面主窗口关闭（`windowClosing`）时，Swing 宿主通过 `browser.executeJavaScript("if (window.__rtcDisconnect) { window.__rtcDisconnect(); }", browser.getURL(), 0)` 触发前端立即广播 `HOST_LEAVING` 并主动断开 WebRTC / 信令连接，随后等待 `150ms` 再销毁 CEF 与 Javalin 实例。
  - `window.__rtcSimulateNetworkDrop()`（测试辅助 Hook）：在 `frontend/src/stores/connection.ts` 中绑定，仅关闭底层 `DataChannel`（不关闭信令连接），供 E2E 模拟断网重连测试使用。
  - `window.__sp27E2eBridge`（含 `sendForgedRecordAttacks`）与 `__LAST_CRDT_FUTURE_SKEW__` / `__LAST_CRDT_SECURITY_REJECTS__`：仅在 `import.meta.env.DEV || import.meta.env.VITE_ENABLE_E2E_BRIDGE === 'true'` 编译期门禁为真时挂载至 `window`（`useEventWebRtcBridge.ts`），生产打包（`npm run build`）完全剔除，严禁暴露给线上 PWA 或桌面正式版。

### `JCEF Bridge: CefDisplayHandler.onConsoleMessage`
- **说明**：JCEF 拦截前端所有 `console.log / warn / error` 输出，自动格式化为 `[<ISO_LOCAL_DATE_TIME>] [Frontend-Console] (<source>:<line>) <message>` 并追加落盘至桌面端 `<logDir>/scoutingpro_*.log`（`<logDir>` 解析规则见 `§14`）。

### `JCEF Bridge: CefDownloadHandler.onBeforeDownload`
- **说明**：前端触发文件下载（如 `.csv` 导出、`.info` 离线同步包、`.event` 赛事配置包、`.md` AI 战报导出）时，JCEF 自动在 Swing EDT 线程弹出原生 `JFileChooser` 保存对话框，填入 `suggestedName` 并写入用户选定的本地路径（取消时回调空字符串 `""`）。

### `Javalin Static Hosting & CORS`（`Main.createJavalinApp`）
- **静态资源托管**：注册两处 `Location.CLASSPATH` 静态目录——`/` → `/public`、`/assets` → `/assets`。
- **CORS 策略**：启用 `config.bundledPlugins.enableCors(cors -> cors.addRule(rule -> rule.anyHost()))` 允许任意来源跨域访问。
- **无 SPA History Fallback**：未配置 Javalin `spaRoot`；前端强制使用 `vue-router` 的 `createWebHashHistory()`（`#/...`），未知 HTTP 路径直接返回 `404`。

### `JCEF & Javalin Network / Profile / Bundle Storage`（端口、请求上限、目录隔离与原生库缓存）
- **HTTP/WS 上限与端口开孔**：Javalin `config.http.maxRequestSize = 15_000_000L`（15 MB）；Jetty WebSocket 配置 `maxTextMessageSize = 2 * 1024 * 1024`（2 MB）、`maxBinaryMessageSize = 2 * 1024 * 1024`（2 MB）、`idleTimeout = 15 min`；JCEF 启动参数固定包含 `--use-fake-ui-for-media-stream`、`--disable-features=WebRtcHideLocalIpsWithMdns,WebUsb,MediaRouter,CalculateNativeWinOcclusion`、`--force-fieldtrials=WebRTC-IPv6Default/Enabled/WebRTC-BindUsingInterfaceIndex/Enabled/WebRTC-IceFieldTrials/send_ping_on_switch_ice_controlling:true,send_ping_on_selected_ice_controlling:true,send_ping_on_nomination_ice_controlled:true/WebRTC-Bwe-Bbr/Enabled/`、`--disable-device-discovery-notifications`、`--disable-usb-keyboard-detect`（macOS 追加 `--no-sandbox`）；`onContextInitialized` 锁定 `webrtc.udp_port_range=50000-50099`；后台 `PortForwardingService` 在物理网卡上以 `12_000 ms` 预算异步探测 UPnP IGDv1/v2（含 `WANIPv6FirewallControl:1`）、NAT-PMP、PCP，为 `50000-50009/UDP` 申请短租约（默认 `300s`，上限 `600s`，退出时自动清理）。
- **Profile 隔离（`<dataDir>/jcef_profile*`）**：`Main.resolveJcefProfileDir()` 优先锁定持久化主目录 `<dataDir>/jcef_profile`（检查 Chromium `lockfile` 并持有应用级 `.instance.lock`）；被占用时依次探测 `jcef_profile_2` .. `jcef_profile_10`；全满时回退至 `java.io.tmpdir/scoutingpro-jcef-<timestamp>`。注意：仅桌面窗口 `windowClosing` 回调会递归删除 `scoutingpro-jcef-*` 临时目录，`gracefulShutdown`（`/api/test/shutdown` 或 JVM ShutdownHook）仅释放锁不删除临时目录。
- **原生二进制缓存**：`Main.ensureJcefBundle()` 固定使用 `~/.scoutingpro27/jcef-bundle`（以 `.extracted_v3_ok` 标记校验；当打包内嵌离线归档 `/jcef-bundle.tar.gz` 或 `/jcef-bundle.zip` 存在时，额外通过 `CefInstallationChecker.checkInstallation()` 校验 `install.lock` 与 `build_meta.json` 版本匹配，防止跨版本升级后残留旧版 JCEF 触发离线联网下载；macOS 解压或复用时自动执行 `xattr -r -d com.apple.quarantine`；且 GUI 模式下在 `ensureJcefBundle()` 完成后再异步触发 `firewall-check`，确保 Windows 防火墙规则 `ScoutingPro27 App JCEF` 命中刚解压的 `jcef_helper.exe`）。
- **原生安装包构建规范（`.github/workflows/build-installer.yml`）**：Windows `.msi` 固定 `--win-upgrade-uuid 1640af3f-2837-35d3-b98a-d8d8fe87e5e7` 与 `--vendor "FTC Team 27570 B.E.A.R."`；macOS Apple Silicon 先产出 `.app` (`--type app-image` + `java.awt.peer`/`sun.awt`/`sun.lwawt`/`sun.lwawt.macosx` `--add-opens`)，向 `Info.plist` 注入 `NSMicrophoneUsageDescription`、`NSCameraUsageDescription` 与 `LSMinimumSystemVersion=11.0`，由内向外执行 Apple Silicon ad-hoc `codesign --force --sign -` 验签后通过 `ditto` + `ln -s /Applications` + `hdiutil create -format UDZO` 封装 `.dmg`，并在 CI 挂载 `.dmg` 复验签名与 `Info.plist`。

---

## 14. 运行时存储路径、数据库解析与启动引导契约 (`Main.java` / `AppConfig.java`)

### `14.1 运行环境判定（AppConfig.getEnvironment()）`
- **判定优先级**（高 → 低）：
  1. 单测覆盖：`AppConfig.setEnvironmentOverride(...)`
  2. JVM 系统属性：`scouting.env` > `app.env`
  3. 环境变量：`SCOUTING_ENV` > `APP_ENV`
  4. 源码根目录自动探测：`AppConfig.findProjectRootDir()` 从当前工作目录（`new File(".").getCanonicalFile()`）逐级向上查找 `Backend/pom.xml`，命中则为 `DEV`，否则为 `PROD`。
- **值映射规则**：忽略大小写与首尾空白后，`prod` / `production` → `PROD`；`test` / `testing` → `TEST`；其他非空值 → `DEV`。

### `14.2 数据基准目录 <dataDir> 与持久化资产（AppConfig.resolveBaseDataDir() / resolveAppDbFile() / resolveAppDbUrl()）`
- `resolveAppDbFile()` 与所有持久化资产统一落盘于 `resolveBaseDataDir()`（即 `<dataDir>`）之下：

| 模式 / 条件 | `<dataDir>` 解析结果 | H2 数据库物理文件（`resolveAppDbFile()` + `.mv.db`） |
|---|---|---|
| **显式隔离目录**（`--data-dir` / `-Dscouting.data.dir` / `SCOUTING_DATA_DIR`） | `<explicitDir>`（自动剥离首尾匹配引号并创建目录） | `<explicitDir>/app_data.mv.db` |
| **`DEV` 默认**（命中 `Backend/pom.xml` 且无显式目录） | `<project_root>/app_data` | `<project_root>/app_data/app_data.mv.db` |
| **`PROD` 默认**（无 `Backend/pom.xml` 且无显式目录） | `~/.scoutingpro27` | `~/.scoutingpro27/app_data.mv.db` |

- **JDBC URL 解析（`resolveAppDbUrl()`）**：
  - 若环境变量 `DB_URL` 非空，直接返回该值。
  - 否则将 `resolveAppDbFile()` 路径中的 `\` 归一化为 `/`，默认构造 `jdbc:h2:<dbPath>;AUTO_SERVER=TRUE;LOCK_TIMEOUT=15000;AUTO_RECONNECT=TRUE`；若启用 `--no-auto-server` / `-Dscouting.noAutoServer=true` / `SCOUTING_NO_AUTO_SERVER=true`，则构造 `jdbc:h2:<dbPath>;AUTO_SERVER=FALSE;LOCK_TIMEOUT=15000`。
  - `AppConfig` 静态块及 `Main.initAndRun` 在未预设 `h2.bindAddress` 时强制设置为 `127.0.0.1`。
  - **HikariCP 连接池（`JdbiConfig.java`）**：`maximumPoolSize = 10`、`minimumIdle = 2`、`connectionTimeout = 10000 ms`、`idleTimeout = 60000 ms`、`maxLifetime = 1800000 ms`，默认凭据 `user = "sa"`, `password = ""`。
  - **Schema 迁移与启动期幂等自愈**：`Main.initAndRun` 依次执行 `Flyway.locations("classpath:db")`（**`V1`–`V10`**，含 `cleanDisabled(false)`；先执行 `flyway.repair()` 再执行 `flyway.migrate()`），随后执行 `CrdtProjectionService.ensureCrdtSchema(jdbi)`、`AiRoutes.ensureAiCopilotSchema(jdbi)`（委托 `AiSchemaBootstrap.ensureAiCopilotSchema(jdbi)`）与 `UserDeterministicIdMigrator.migrate(jdbi)`。
- **`<dataDir>` 内标准子路径清单**：
  - `app_data.mv.db`（H2 数据库）、`jwt.secret`（HMAC-SHA256 密钥）、`master.key`（AES-256 主密钥）、`pit_photos/{eventId}/{key}.webp`、`jcef_profile`（及多开 `jcef_profile_2..10`）。

### `14.3 日志目录 <logDir> 与文件命名（AppConfig.resolveLogDir() / resolveLogFile()）`
- **解析优先级**：
  1. 若指定显式隔离目录（`--data-dir` / `-Dscouting.data.dir` / `SCOUTING_DATA_DIR`）→ `<explicitDir>/log/`
  2. 否则若 `AppConfig.findProjectRootDir() != null` → `<project_root>/log/`（直接按源码根目录判定，即使通过 `SCOUTING_ENV=prod` 切换环境但未指定 `--data-dir`，日志仍写入 `<project_root>/log/`）
  3. 否则 → `<dataDir>/log/`（`PROD` 模式下即 `~/.scoutingpro27/log/`）
- **单实例日志文件**：单次 JVM 运行缓存唯一文件 `<logDir>/scoutingpro_yyyy-MM-dd_HH-mm-ss[_N].log`（遇非空同名文件时自增 `_1`、`_2`），同步聚合后端 stdout/stderr、JCEF 前端控制台与 `POST /api/system/log` 远端日志。

### `14.4 CLI 启动参数与环境变量对照（Main.java / NetworkUtil.java / ApiRoutes.java / FtcApiClient.java / AiProxyResolver.java）`

| 参数 / 变量 | 类型 | 作用与优先级说明 |
|---|---|---|
| `--data-dir=<path>` / `--data-dir <path>` | CLI 参数 | 在日志与数据库初始化前写入 `-Dscouting.data.dir`（剥离首尾匹配引号），覆盖 `<dataDir>` 与 `<logDir>`。 |
| `--no-auto-server` | CLI 参数 | 写入 `-Dscouting.noAutoServer=true`，禁用 H2 `AUTO_SERVER`。 |
| `--headless` | CLI 参数 | 设置 `java.awt.headless=true`，跳过 Swing Splash 与 JCEF 窗口仅运行 Javalin 服务（**不会**单独跳过 Windows 防火墙检测）。 |
| `--port=N` | CLI 参数 | 指定 HTTP/WS 监听端口，高于 `DEV_PORT` 与默认 `8080`；绑定失败时按 `::` → `0.0.0.0` → `8081`（仅原目标为 `8080` 时）/`0` → `0` 回退。 |
| `--jcef-prewarm` | CLI 参数 | CI 专用，将当前平台 JCEF 原生库下载解压至 `./jcef-bundle` 后立即退出（退出码 `0` 或 `1`）。 |
| `DEV_PORT` | 环境变量 | 覆盖默认监听端口 `8080`（低于 `--port=N`）。 |
| `DB_URL` | 环境变量 | 直接覆盖 H2 JDBC URL（高于 `resolveAppDbFile()` 自动拼接）。 |
| `SCOUTING_DATA_DIR` / `-Dscouting.data.dir` | 环境变量 / JVM 属性 | 指定显式隔离数据目录（**JVM 属性优先级高于环境变量**）。 |
| `SCOUTING_NO_AUTO_SERVER` / `-Dscouting.noAutoServer` | 环境变量 / JVM 属性 | 设为 `"true"`（忽略大小写）时禁用 H2 `AUTO_SERVER`（**JVM 属性高于环境变量**）。 |
| `SCOUTING_ENV` / `APP_ENV` / `-Dscouting.env` / `-Dapp.env` | 环境变量 / JVM 属性 | 覆盖运行环境（`DEV` / `PROD` / `TEST`，**JVM 属性高于环境变量**）。 |
| `ENABLE_TEST_CLEANUP` / `-DENABLE_TEST_CLEANUP` | 环境变量 / JVM 属性 | `trim()` 后忽略大小写设为 `"true"` 时注册 `/api/test/cleanup` 与 `/api/test/shutdown` 并跳过防火墙检测（`ApiRoutes.isTestCleanupEnabled()` 与 `NetworkUtil.isTrueFlag()` 行为完全一致）。 |
| `SKIP_FIREWALL_CHECK` / `-DSKIP_FIREWALL_CHECK` | 环境变量 / JVM 属性 | 设为 `"true"`（忽略大小写+`trim()`）时跳过 Windows 启动防火墙检测与 UAC 提权弹窗（不注册测试接口）。 |
| `FTC_API_BASE_URL` / `-Dftc.api.base.url` | 环境变量 / JVM 属性 | 覆盖 FTC 官方 API v2.0 基准地址（默认 `https://ftc-api.firstinspires.org`；**环境变量优先级高于 JVM 属性**）。 |
| `FTC_API_USER` / `-Dftc.api.user` | 环境变量 / JVM 属性 | 覆盖 FTC 官方 API Basic Auth 用户名（**环境变量优先级高于 JVM 属性**）。 |
| `FTC_API_TOKEN` / `-Dftc.api.token` | 环境变量 / JVM 属性 | 覆盖 FTC 官方 API Basic Auth Token（**环境变量优先级高于 JVM 属性**）。 |
| `HTTPS_PROXY` / `HTTP_PROXY` | 环境变量 | `AiProxyResolver` 在非回环目标 URL 时优先读取 `HTTPS_PROXY`，其次 `HTTP_PROXY`（格式为 URI，需含 `host` 与 `port > 0`），否则探测本地常见代理端口。 |

---

## 15. H2 数据库 Schema 与索引契约 (`V1`–`V10` + 启动期幂等引导)

> 以下为执行完 Flyway `V1`–`V10` 迁移及启动期 `CrdtProjectionService.ensureCrdtSchema`、`AiSchemaBootstrap.ensureAiCopilotSchema` 后的**最终生效表结构**（H2 数据库）。修改 `Dao` / SQL 查询时必须严格对齐以下列名与类型：

### `users` (`V1`, `V4`)
- `id VARCHAR(2048) PRIMARY KEY`（由 `V1` `VARCHAR(36)` 经 `V4` 扩至 `2048`）
- `username VARCHAR(50) NOT NULL`
- `password VARCHAR(255) DEFAULT ''`
- `created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`
- **索引**：`idx_users_username ON users(username)` (`V4`)

### `events` (`V1`, `V4`, `V8`)
- `id VARCHAR(2048) PRIMARY KEY` (`V4`)
- `name VARCHAR(100) NOT NULL`
- `invite_code VARCHAR(10) UNIQUE`
- `host_id VARCHAR(2048) NOT NULL REFERENCES users(id)` (`V4`)
- `ftc_year INT`
- `ftc_event_code VARCHAR(50)`
- `turn_config_encrypted TEXT` (`V8`)
- `created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`
- **索引**：`idx_events_host ON events(host_id)` (`V4`)

### `event_users` (`V1`, `V4`)
- `event_id VARCHAR(2048) REFERENCES events(id) ON DELETE CASCADE`
- `user_id VARCHAR(2048) REFERENCES users(id) ON DELETE CASCADE`
- **PK**：`(event_id, user_id)`
- **索引**：`idx_event_users_user ON event_users(user_id)` (`V4`)

### `scouting_records` (`V1`, `V4`, `V8`)
- `id VARCHAR(2048) PRIMARY KEY` (`V4`)
- `event_id VARCHAR(2048) NOT NULL REFERENCES events(id) ON DELETE CASCADE` (`V4`)
- `scout_id VARCHAR(2048) NOT NULL` (`V4`)
- `scout_name VARCHAR(50) NOT NULL`
- `match_number INT NOT NULL`
- `team_number INT NOT NULL`
- `auto_score INT DEFAULT 0`
- `teleop_score INT DEFAULT 0`
- `endgame_score INT DEFAULT 0`
- `total_score INT DEFAULT 0`
- `notes TEXT`
- `raw_data TEXT`
- `sync_status VARCHAR(20) DEFAULT 'PENDING'`
- `is_broken BOOLEAN DEFAULT FALSE`
- `version INT DEFAULT 1 NOT NULL`
- `host_seq INT`
- `is_deleted BOOLEAN DEFAULT FALSE NOT NULL`
- `author_pub_key VARCHAR(256)` (`V8`)
- `author_sig VARCHAR(256)` (`V8`)
- `host_sig VARCHAR(256)` (`V8`)
- `created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`
- `updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`
- **索引**：`idx_records_event(event_id)`, `idx_records_sync(sync_status)` (`V1`); `idx_records_scout(scout_id)`, `idx_records_event_team(event_id, team_number)`, `idx_records_tombstone(is_deleted, updated_at)` (`V4`)

### `banned_teams` (`V1`, `V4`)
- `event_id VARCHAR(2048) NOT NULL REFERENCES events(id) ON DELETE CASCADE`
- `team_number INT NOT NULL`
- **PK**：`(event_id, team_number)`

### `team_tags` (`V1`, `V4`)
- `id VARCHAR(2048) NOT NULL PRIMARY KEY` (`V4`)
- `event_id VARCHAR(2048) NOT NULL REFERENCES events(id) ON DELETE CASCADE` (`V4`)
- `team_number INT NOT NULL`
- `tag VARCHAR(30) NOT NULL`
- `color VARCHAR(16) NOT NULL DEFAULT 'blue'`
- `is_preset BOOLEAN NOT NULL DEFAULT FALSE`
- `created_by VARCHAR(2048)` (`V4`)
- `created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`
- `updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`
- **约束/索引**：`UNIQUE uq_event_team_tag (event_id, team_number, tag)`；`idx_team_tags_event_team(event_id, team_number)`, `idx_team_tags_event(event_id)`

### `match_schedules` (`V2`, `V4`)
- `id VARCHAR(2048) PRIMARY KEY` (`V4`)
- `event_id VARCHAR(2048) NOT NULL REFERENCES events(id) ON DELETE CASCADE` (`V4`)
- `match_number INT NOT NULL`
- `tournament_level VARCHAR(20) DEFAULT 'QUALIFICATION'`
- `red1 INT NOT NULL`, `red2 INT NOT NULL`, `blue1 INT NOT NULL`, `blue2 INT NOT NULL`
- `created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`
- **约束/索引**：`UNIQUE uq_event_match_level(event_id, match_number, tournament_level)`；`idx_schedules_event(event_id)`, `idx_schedules_event_match(event_id, match_number)`

### `scout_assignments` (`V2`, `V4`)
- `id VARCHAR(2048) PRIMARY KEY` (`V4`)
- `event_id VARCHAR(2048) NOT NULL REFERENCES events(id) ON DELETE CASCADE` (`V4`)
- `match_number INT NOT NULL`
- `tournament_level VARCHAR(20) DEFAULT 'QUALIFICATION'`
- `station VARCHAR(10) NOT NULL`（`'red1' | 'red2' | 'blue1' | 'blue2'`）
- `team_number INT NOT NULL`
- `scout_id VARCHAR(2048)`（可为 `NULL`）(`V4`)
- `scout_name VARCHAR(50)`（可为 `NULL`）
- `updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`
- **约束/索引**：`UNIQUE uq_event_match_station(event_id, match_number, tournament_level, station)`；`idx_assignments_event(event_id)`, `idx_assignments_scout(event_id, scout_id)`

### `event_official_teams` (`V3`, `V4`)
- `event_id VARCHAR(2048) NOT NULL REFERENCES events(id) ON DELETE CASCADE` (`V4`)
- `team_number INT NOT NULL`
- `name_full VARCHAR(500)`（`V4` 扩至 `500`）
- `robot_name VARCHAR(100)`, `city VARCHAR(100)`, `country VARCHAR(100)`
- `updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`
- **PK**：`(event_id, team_number)`

### `pit_scouting_records` (`V3`, `V4`, `V5`, `V6`, `V7`)
> 注意：`V4` 已删除 `V3` 原有的 `sizing_passed`, `mechanism_type`, `hang_type`, `claimed_auto_pieces`, `claimed_auto_hang_level`, `claimed_teleop_cycle_sec`, `claimed_endgame_hang_level`, `claimed_endgame_time_sec`。
- **标识与元数据**：`id VARCHAR(2048) PRIMARY KEY`、`event_id VARCHAR(2048) NOT NULL REFERENCES events(id) ON DELETE CASCADE`、`team_number INT NOT NULL`、`scout_id VARCHAR(2048) NOT NULL`、`scout_name VARCHAR(50) NOT NULL`、`robot_name VARCHAR(100)`
- **硬件与 BIOBUZZ 特性**：`drivetrain_type VARCHAR(30) NOT NULL DEFAULT 'mecanum'`、`weight_lbs DOUBLE DEFAULT 0.0`、`odometry_type VARCHAR(30) DEFAULT 'none'`、`ball_compatibility VARCHAR(30) DEFAULT 'universal'` (`V4`)、`launcher_type VARCHAR(100) DEFAULT ''` (`V4`)、`flower_mechanism VARCHAR(100) DEFAULT ''` (`V4`)、`has_color_sensor BOOLEAN DEFAULT FALSE` (`V4`)、`has_descore_mech BOOLEAN DEFAULT FALSE` (`V6`)、`has_apriltag_vision BOOLEAN DEFAULT FALSE` (`V6`)、`chassis_size VARCHAR(64) DEFAULT ''` (`V7`)
- **量化自述指标**：`claimed_auto_score INT DEFAULT 0`、`claimed_auto_strategy TEXT` (`V4`)、`claimed_teleop_score INT DEFAULT 0`、`claimed_teleop_cycles INT DEFAULT 0` (`V4`)、`claimed_endgame_score INT DEFAULT 0` (`V4`)、`claimed_total_score INT DEFAULT 0`、`claimed_teleop_park BOOLEAN DEFAULT FALSE` (`V6`)、`claimed_flower_nectars INT DEFAULT 0` (`V6`)、`claimed_flower_bottom_bonus INT DEFAULT 0` (`V6`)、`claimed_flower_pollens INT DEFAULT 0` (`V6`)、`claimed_garden_balls INT DEFAULT 0` (`V6`)
- **扩展与版本**：`photo_keys TEXT`、`raw_data TEXT` (`V5`)、`version INT DEFAULT 1 NOT NULL`、`host_seq INT`、`is_deleted BOOLEAN DEFAULT FALSE NOT NULL`、`created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`、`updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`
- **约束/索引**：`UNIQUE uq_pit_event_team(event_id, team_number)`；`idx_pit_records_event(event_id)`, `idx_pit_records_team(event_id, team_number)`, `idx_pit_records_active(event_id, is_deleted, team_number)` (`V4`)

### `event_custom_fields` (`V5`, `V10`)
- `id VARCHAR(2048) PRIMARY KEY`
- `event_id VARCHAR(2048) NOT NULL REFERENCES events(id) ON DELETE CASCADE`
- `target VARCHAR(30) NOT NULL`（`'MATCH' | 'PIT' | 'TEAM'`）
- `phase VARCHAR(30) NOT NULL DEFAULT 'overall'`
- `name VARCHAR(100) NOT NULL`, `field_key VARCHAR(100) NOT NULL`, `field_type VARCHAR(30) NOT NULL`
- `required BOOLEAN DEFAULT FALSE NOT NULL`, `default_val TEXT`, `options_json TEXT`
- `min_val DOUBLE`, `max_val DOUBLE`, `step_val DOUBLE`, `unit VARCHAR(30)`
- `order_seq INT DEFAULT 0 NOT NULL`, `is_active BOOLEAN DEFAULT TRUE NOT NULL`
- `description VARCHAR(300)` (`V10`), `config_json TEXT` (`V10`), `formula_expr TEXT` (`V10`), `aggregation_mode VARCHAR(30) DEFAULT 'avg'` (`V10`), `display_format VARCHAR(30) DEFAULT 'number'` (`V10`), `dependencies_json TEXT` (`V10`)
- `created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`, `updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`
- **约束/索引**：`UNIQUE uq_event_target_field_key (event_id, target, field_key)`；`idx_custom_fields_event(event_id, target, is_active)`

### `event_crdt_state` (`V8`)
- `event_id VARCHAR(2048) PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE`
- `host_epoch INT NOT NULL DEFAULT 1`
- `snapshot_revision BIGINT NOT NULL DEFAULT 0`
- `crdt_snapshot_json CLOB NOT NULL`
- `updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`

### `ai_settings`（旧版兼容，`V1`, `V4`）
- `user_id VARCHAR(2048) NOT NULL REFERENCES users(id) ON DELETE CASCADE` (`V4`)
- `provider VARCHAR(20) NOT NULL`
- `api_key_encrypted TEXT NOT NULL`
- `model_name VARCHAR(100) DEFAULT ''`, `system_prompt TEXT`, `proxy_host VARCHAR(255) DEFAULT '127.0.0.1'`, `proxy_port INT DEFAULT NULL`, `base_url VARCHAR(500) DEFAULT ''`
- `created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`, `updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`
- **PK**：`(user_id, provider)`

### `ai_chat_sessions`（旧版兼容，`V1`, `V4`）
- `user_id VARCHAR(2048) NOT NULL REFERENCES users(id) ON DELETE CASCADE` (`V4`)
- `event_id VARCHAR(2048) NOT NULL REFERENCES events(id) ON DELETE CASCADE` (`V4`)
- `chat_history_json TEXT`, `updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`
- **PK**：`(user_id, event_id)`

### `ai_provider_profiles` (`V9` + `AiSchemaBootstrap`)
- `id VARCHAR(128) PRIMARY KEY`, `user_id VARCHAR(2048) NOT NULL REFERENCES users(id) ON DELETE CASCADE`
- `name VARCHAR(120) NOT NULL`, `preset_id VARCHAR(48) DEFAULT 'custom'`, `protocol VARCHAR(20) NOT NULL`
- `api_key_encrypted TEXT DEFAULT ''`, `base_url VARCHAR(500) DEFAULT ''`, `model_name VARCHAR(200) DEFAULT ''`
- `custom_models_json CLOB DEFAULT '[]'`, `system_prompt TEXT`
- `temperature DOUBLE DEFAULT 0.4`, `max_tokens INT DEFAULT 4096`, `enable_thinking BOOLEAN NOT NULL DEFAULT FALSE`（`AiSchemaBootstrap`；`V9` 历史迁移为 `TRUE`）, `thinking_budget INT DEFAULT 4096`
- `anthropic_version VARCHAR(32) DEFAULT '2023-06-01'`, `max_context_msgs INT DEFAULT 16`
- `proxy_host VARCHAR(255) DEFAULT ''`, `proxy_port INT DEFAULT NULL`, `is_active BOOLEAN NOT NULL DEFAULT FALSE`
- `created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`, `updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`
- **索引**：`idx_ai_profiles_user ON ai_provider_profiles(user_id, is_active DESC, updated_at DESC)`

### `ai_chat_threads` (`V9` + `AiSchemaBootstrap`)
- `id VARCHAR(128) PRIMARY KEY`
- `user_id VARCHAR(2048) NOT NULL REFERENCES users(id) ON DELETE CASCADE`
- `event_id VARCHAR(2048) NOT NULL REFERENCES events(id) ON DELETE CASCADE`
- `title VARCHAR(200) NOT NULL DEFAULT 'New Tactical Chat'`, `persona_id VARCHAR(48) DEFAULT 'strategist'`, `pinned BOOLEAN NOT NULL DEFAULT FALSE`
- `messages_json CLOB NOT NULL DEFAULT '[]'`, `context_config_json CLOB DEFAULT '{}'`
- `created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`, `updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`
- **索引**：`idx_ai_threads_user_event ON ai_chat_threads(user_id, event_id, pinned DESC, updated_at DESC)`

---

## 16. 前端持久化存储契约、Pinia Stores、路由与离线同步格式

### `16.1 Pinia Stores 与状态不变量 (frontend/src/stores/)`
- **`user.ts` (`useUserStore`)**：
  - 监听 `window` 事件 `'auth-unauthorized'` 自动登出；`logout()` 先并发执行 `beforeLogoutHooks`（上限 `2000ms`），同步调用 `useAiStore().resetUserSession()` 清理 AI 用户态，再断连 WebRTC、清除用户态与单赛事内存态缓存（`scoutingpro-user`、`recordStore.clearMemoryOnly()`、`pitStore.clearLocalCache()`、`scheduleStore.clearLocalCache()` 等），**刻意保留**跨账号共享缓存（`sp27_epoch_*`, `sp27_clock_anchor_*`, IndexedDB 密钥与离线照片）。
- **`events.ts` (`useEventsStore`)**：
  - `isHost` 强制要求 `!isMobileDevice() && isDesktopHost()`；`sanitizeEventList` 自动剔除与权威 UUID 同 `inviteCode` 的 `evt-*` / `ext_*` 占位符；删除赛事时同步清理 `scoutingpro27_schedule_<id>`、`scoutingpro27_assignments_<id>`、`sp27_*_<id>`；切换 `currentEvent` 时同步更新 `connectivity.ts` 的自定义 TURN 配置。
- **`records.ts` (`useRecordStore`)**：
  - 维护跨赛事严格隔离：`currentRecords` 与 `currentTeamTags` 按 `currentEventId` 过滤，提供 `getTagsForEvent(eventId)` 与 `getTagsForTeam(teamNumber, eventId)`；`fetchRecords` 切换赛事前先冲刷上一赛事防抖持久化，并通过单调序号 `fetchSeq` 拦截过期异步返回对 `officialMatches`/`officialAdvancement`/`bannedTeams` 的回写；跨 Tab `storage` 监听仅按 `sp27_*_<currentEventId>` 同步当前赛事；`applyTagsFullSync` 严格剔除非目标赛事标签后再落盘与投影至 CRDT。
- **`pitScout.ts` (`usePitScoutStore`) & `schedule.ts` (`useScheduleStore`)**：
  - 单赛事内存态模型：切换或离开赛事（`fetchPitData` / `loadSchedule` / `EventView` 离开路由）时先清空内存并仅加载目标 `eventId` 缓存，同时对 `localStorage` 反序列化与持久化执行 `eventId` 自愈过滤，严禁将上一赛事数据带入新赛事缓存或后端合并；所有异步拉取均带 `fetchSeq` 过期丢弃守卫，CRDT/WebRTC 同步入口严格校对 `eventId` 并暴露 `clearLocalCache()` 供登出与离场清理。
- **`connection.ts` (`useConnectionStore`)**：
  - `isStandbyHost` 在移动端强制为 `false`；`takeoverHost` 受 `3000ms` 互斥冷却保护；`setRtcService` 挂载 `window.__rtcDisconnect` 与 `window.__rtcSimulateNetworkDrop`；`pendingSasQueue` 驱动 `isSasModalOpen`。
- **`ai.ts` & `stores/aiModules/*` (`useAiStore`)**：
  - `aiProfiles.ts`：`activeProfile` 优先取服务端 `isActive` 标志，其次 `localStorage['sp27_ai_active_profile_id']`，再回退列表首项。
  - `aiDockState.ts`：`sp27_ai_dock_width` 强制夹紧至 `[360, 680]`，默认 `420`。
  - `aiThreads.ts`：采用 `650ms` 防抖保存（`scheduleSaveThread`），切换/创建线程或卸载前通过 `flushPendingSaves(threadId, keepalive)` 冲刷挂起 `PUT` 请求；删除或清空线程前必须先调用 `stopStreaming(threadId)` 中止 `AbortController`。
  - `aiStreaming.ts`：仅允许同一线程单并发流式请求；每次发送至 `/api/ai/chat/stream` 时按 `profile.maxContextMsgs`（默认 `16`）截断历史消息并过滤含 `error` 的失败消息。
  - `AiCopilotWorkspace.vue` & `contextBuilder.ts`：注入至 AI 系统提示词、Token 预算统计、队伍 `@` 自动补全与 Hover 预览卡的全部赛事数据（`records`、`teamTags`、`pitRecords`、`officialTeams`、`schedules`、`assignments`、`rankings`、`bannedTeams`）均按当前 `props.eventId` 严格过滤，杜绝跨赛事上下文串台。
- **`navigation.ts` (`useNavigationStore`)**：
  - 管理跨页面跳转前的滚动位置与上下文恢复（`EventTab = 'scout' | 'rankings' | 'history' | 'schedule' | 'whiteboard' | 'scouts' | 'ai' | 'pit'`）。
  - 持久化至 `sessionStorage` 键 `sp27_nav_pos_<eventId>`；提供 `saveEventPosition`、`getEventPosition`、`consumeEventPosition`（读取后删除）、`clearEventPosition`。
- **`inbox.ts` (`useInboxStore`)**：
  - 管理站内系统通知（`messages: SystemMessage[]`，按 `msg.id` 幂等去重）与 P2P 直发消息发件箱（`outbox: DirectMessageOutboxItem[]`）。
  - 按 `userStore.userId` 隔离持久化至 `localStorage`：`inbox-messages-<userId>` 与 `inbox-outbox-<userId>`；切换/登出用户时自动重载或清理。
- **`toast.ts` (`useToastStore`)**：
  - 全局轻提示队列（`toasts: Toast[]`，支持 `error | success | info | warning`，默认 `3500ms`，同 `message + type + detail` 去重防刷屏）；`showError()` 自动经 `errorHelper.formatUserFriendlyError()` 转译后展示（默认 `4500ms`）。

### `16.2 路由、国际化与视图转场 (router/index.ts / i18n.ts / transitionState.ts)`
- **Vue Router Hash 路由**（`createWebHashHistory()`，非 `login` 路由通过 `localStorage.getItem('scoutingpro-user')` 校验 `{ id, token }`，未登录重定向至 `/` 并保留 `query`）：
  - `/` (`name: 'login'`, `depth: 0`) → `LoginView.vue`
  - `/join` → 重定向至 `/` 并透传 `query`
  - `/dashboard` (`name: 'dashboard'`, `depth: 1`) → `DashboardView.vue`
  - `/event/:eventId` (`name: 'event'`, `depth: 2`, `props: true`) → `EventView.vue`
  - `/event/:eventId/team/:teamNumber` (`name: 'team-detail'`, `depth: 3`, `props: true`) → `TeamDetailView.vue`
- **视图转场（`transitionState.ts` + `router.beforeResolve`）**：基于 `document.startViewTransition` 与 `document.documentElement.dataset.{direction, transitionType, toType, fromType}`；从 `event` 返回 `dashboard` 时自动触发 `event-card-<eventId>` 共享元素转场。
- **国际化（`i18n.ts`）**：`vue-i18n`（`legacy: false`），词典文件位于 `frontend/src/locales/en.json` 与 `frontend/src/locales/zh.json`，默认 `'en'`，通过 `switchLanguage('en' | 'zh')` 同步更新 `localStorage['app-locale']` 与 `document.documentElement.lang`。

### `16.3 全局浏览器存储键汇总 (localStorage / sessionStorage / IndexedDB)`

| 存储介质 | 键名 / 库名 | 所属模块 | 用途 |
|---|---|---|---|
| `localStorage` | `scoutingpro-user` | `stores/user.ts`, `router/index.ts`, `services/api.ts`, `crdtApi.ts` | 当前登录用户会话 `{ id, username, token, ... }` |
| `localStorage` | `app-locale` | `i18n.ts` | UI 语言偏好 (`'en' \| 'zh'`) |
| `localStorage` | `inbox-messages-<userId>` / `inbox-outbox-<userId>` | `stores/inbox.ts` | 按用户隔离的系统通知与直发消息发件箱 |
| `localStorage` | `scoutingpro_events` / `scoutingpro_current_event` | `stores/events.ts` | 赛事列表与当前选中赛事缓存 |
| `localStorage` | `sp27_records_<eventId>` / `sp27_official_matches_<eventId>` / `sp27_advancement_<eventId>` / `sp27_banned_teams_<eventId>` / `sp27_records_active_event_id` / `scoutingpro_records` / `scoutingpro_officialMatches` / `scoutingpro_advancement` / `scoutingpro_bannedTeams` / `scoutingpro_tags` | `stores/records.ts`, `stores/events.ts` | 比赛侦察记录、按赛事隔离及全局兼容的官方赛果/晋级分/禁选队伍与标签本地缓存 |
| `localStorage` | `sp27_pit_records_<eventId>` / `sp27_pit_teams_<eventId>` | `stores/pitScout.ts` | Pit 记录与官方战队底册缓存 |
| `localStorage` | `scoutingpro27_schedule_<eventId>` / `scoutingpro27_assignments_<eventId>` | `stores/schedule.ts` | 赛程与排班缓存 |
| `localStorage` | `sp27_custom_fields_<eventId>` / `sp27_cf_<eventId>` | `stores/customFields.ts`, `stores/events.ts` | 赛事自定义字段缓存 |
| `localStorage` | `sp27_team_tags_<eventId>` / `sp27_known_scouts_<eventId>` | `services/scoutStorage.ts`, `stores/events.ts` | 战队标签与已知侦察员缓存 |
| `localStorage` | `sp27_active_draft_<eventId>` | `useScoutingDraft.ts` | 桌面端比赛侦察未提交草稿 |
| `localStorage` | `sp27_mobile_active_draft_<eventId>` | `useMobileWizardForm.ts` | 移动端向导比赛侦察未提交草稿 |
| `localStorage` | `sp27_clock_anchor_<eventId>` | `services/clock/calibratedClock.ts` | 赛事校准时钟锚点偏移缓存 |
| `localStorage` | `sp27_whiteboard_v1_<eventId>` | `useTacticalWhiteboard.ts` | 战术白板本地状态 |
| `localStorage` | `scoutingpro_rankings_custom_cols` | `useRankingsCustomColumns.ts` | 排行榜自定义显示列 |
| `localStorage` | `sp27_ai_dock_open` / `sp27_ai_dock_width` / `sp27_ai_dock_expanded` / `sp27_ai_my_team_by_event` / `sp27_ai_active_profile_id` / `sp27_ai_voice_prefs` / `sp27_ai_mode` / `sp27_ai_thinking_mode` | `stores/aiModules/{aiDockState,aiProfiles}.ts`, `voiceCatalog.ts` | AI 侧边栏布局、我方队号、激活档案 ID、语音偏好、Ask/Turbo 模式与按次思考深度 |
| `localStorage` | `sp27-cloud-pwa-url` / `sp27-custom-broker` / `sp27-disable-turn` | `MobileQrModal.vue`, `signaling.ts`, `clientSession.ts` | 云端 PWA 地址、自定义 MQTT/WS 信令、禁用 TURN 开关 |
| `localStorage` | `sp27_device_identity` / `scoutingpro_verified_sas_<inviteCode>_<pubHex>` / `scoutingpro_verified_sas_<inviteCode>_<userId>_<pubHex>` / `sp27_epoch_<INVITE_CODE>` | `crdtStore.ts`, `sasManager.ts`, `epochStore.ts` | 设备标识、已验证 SAS 与 Host Epoch 缓存 |
| `sessionStorage` | `sp27_nav_pos_<eventId>` | `stores/navigation.ts` | 页面跳转滚动位置与 Tab 上下文 |
| `sessionStorage` | `sp27-active-broker` | `LoginView.vue`, `QrScannerModal.vue`, `webrtc/index.ts` | 当前会话激活的信令 Broker 地址 |
| `sessionStorage` | `sp27_sw_reloaded_at` | `utils/pwaUpdater.ts` | PWA Service Worker 自动更新防循环重载冷却时间戳 |
| `IndexedDB` | `scoutingpro_security_v1` (`device_identity`, `trusted_peers`) | `utils/identityStore.ts` | ECDH/ECDSA P-256 设备密钥对与 TOFU 信任库 |
| `IndexedDB` | `sp27_crdt_<eventId>` | `services/crdt/crdtPersistence.ts` | TinyBase MergeableStore 本地持久化 |
| `IndexedDB` | `ScoutingPro_MobileMedia` | `services/mobilePhotoCache.ts` | 移动端 Pit 照片离线二进制缓存 |

### `16.4 离线包导出格式 (frontend/src/utils/offlineSync.ts) 与共享前端工具 (frontend/src/utils/)`
- **离线包导出格式 (`offlineSync.ts`)**：
  - `.event` (`EventPackageFile`)：`{ format: 'SCOUTING_PRO_27_EVENT', version: 1, exportedAt, exportedBy: { userId, username, role }, event, schedule?, assignments? }`
  - `.info` (`SyncPackageFile`)：`{ format: 'SCOUTING_PRO_27_SYNC', version: 1, packetType: 'CLIENT_PUSH' | 'HOST_BROADCAST', eventId, eventName, sender, target: { recipientType, targetUserId?, targetUsername? }, syncRange: { recordCount, hasCrdtSnapshot? }, exportedAt, payload: { records, teamTags?, hostSessionId?, crdtSnapshot? } }`（客户端导出时仅保留 `scouting_records`, `member_identities`, `pit_records`, `pit_photo_keys`, `team_tags` 五张表及本人记录）。
- **关键共享工具 (`frontend/src/utils/`)**：
  - `userId.ts`：RFC 4122 v3 MD5 确定性 `userId` 生成器，与后端 `UserUtil.generateDeterministicUserId` 字节级一致。
  - `identityStore.ts`：IndexedDB 设备 ECDH/ECDSA P-256 密钥与 TOFU 多设备信任评估（`TRUSTED_MATCH` / `TOFU_FIRST_SEEN` / `KEY_ROTATION_ALERT` / `MULTI_USER_DEVICE_SWITCH`）。
  - `tournament.ts`：`getRecordTournamentLevel`、`getTournamentLevelOrder`、`sortRecordsChronologically`、`getMatchLevelPrefix`（`'Q' | 'P'`）、`isAssignmentCompleted`。
  - `bragIndex.ts`：`calculateBragIndex(claimed, actualMatches)`（BIOBUZZ 2026-2027 展位自述与赛场实测对账，排除 `isBroken` 场次）。
  - `errorHelper.ts`：`ApiError` 与 `formatUserFriendlyError()`（网络离线、超时、鉴权失败等统一中文化/i18n 转译）。
  - `csvExport.ts`：`downloadCSV(filename, headers, rows)`（触发浏览器/JCEF 下载回调）。
  - `pwaUpdater.ts`：`registerPwaServiceWorker()`（仅非桌面端 `isDesktopHost() === false` 时以 `updateViaCache: 'none'` 注册 `./sw.js`，监听 `visibilitychange`/`pageshow`/`online` 与周期探测 `registration.update()`，并在旧版控制器被新 SW 接管时经 `sp27_sw_reloaded_at` 5s 防循环冷却保护自动刷新页面）。
