# ScoutingPro27 API & Bridge Contract (`CONTRACT.md`)

> **全局鉴权与拦截规则（`ApiRoutes.java`）**
> - **默认鉴权**：所有 `/api/*` 请求默认必须携带 `Authorization: Bearer <jwt_token>`；缺失或无效返回 `401 Unauthorized`。
> - **免鉴权白名单**：
>   - `GET /api/user/check`、`POST /api/user/verify-token`、`POST /api/user/register`、`POST /api/user/login`
>   - `GET /api/system/network-info`、`POST /api/system/open-firewall-cmd`、`POST /api/system/log`
>   - `GET /api/events/{eventId}/pit/photos/{key}`（供原生 `<img>` 标签加载）
>   - `POST /api/test/cleanup`（鉴权过滤器无条件放行；仅在 `ENABLE_TEST_CLEANUP=true` 环境变量或 `-DENABLE_TEST_CLEANUP=true` 时注册路由，未开启时返回 `404`）
>   - `POST /api/test/shutdown`（仅在 `ENABLE_TEST_CLEANUP=true` 环境变量或 `-DENABLE_TEST_CLEANUP=true` 时注册路由并加入免鉴权白名单；未开启时无 Token 返回 `401`，携带有效 Token 返回 `404`）
>   - `WS /ws/signal/{room}`
> - **确定性用户 ID 自愈头**：当旧 UUID Token 对应用户已迁移为确定性 ID 时，后端自动按 `username` 匹配并在响应头下发 `X-Refreshed-Token: <new_jwt_token>`。
> - **全局异常映射**：非法 JSON 体返回 `400 ("Invalid JSON body")`；未捕获异常返回 `500 ({ error: string })`。

---

## 1. 用户与鉴权模块 (`UserRoutes`)

### `GET /api/user/check`
- **说明**：检查注册用户名是否已存在（免鉴权）。
- **Request**：
  ```ts
  interface CheckUserQuery {
    username: string; // Query 参数
  }
  ```
- **Response**：
  ```ts
  interface CheckUserResponse {
    exists: boolean;
  }
  ```
  - 错误码：`400` (`"username required"`)

### `POST /api/user/verify-token`
- **说明**：校验 JWT Token 有效性；若用户经历了确定性 ID 迁移则自动签发新 Token（免鉴权）。
- **Request**：
  ```ts
  interface VerifyTokenBody {
    token: string;
  }
  ```
- **Response**：
  ```ts
  interface VerifyTokenResponse {
    valid: true;
    userId: string;
    username: string;
    token?: string; // 仅在触发迁移自愈时返回（同时写入 X-Refreshed-Token 响应头）
  }
  ```
  - 错误码：`400` (`"token required"`), `401` (`"Invalid token signature"`), `404` (`"User not found"`)

### `POST /api/user/register`
- **说明**：注册新账号并生成确定性 `userId` 与 JWT Token（免鉴权）。
- **Request**：
  ```ts
  interface RegisterBody {
    username: string; // 1..50 字符
    password: string; // 1..72 字符
  }
  ```
- **Response**：
  ```ts
  interface AuthUserResponse {
    id: string;
    username: string;
    token: string;
  }
  ```
  - 错误码：`400` (`"username and password required"` / `"username or password too long"`), `409` (`"User already exists"`)

### `POST /api/user/login`
- **说明**：用户名密码登录并签发 JWT Token（免鉴权）。
- **Request**：
  ```ts
  interface LoginBody {
    username: string;
    password: string;
  }
  ```
- **Response**：同 `AuthUserResponse` (`{ id: string; username: string; token: string }`)
  - 错误码：`400` (`"username and password required"`), `401` (`"Invalid credentials"`)

### `POST /api/user/rename`
- **说明**：修改当前登录用户的用户名及可选密码（`userId` 保持不变，级联更新本地比赛记录、排班、Pit 记录中的 `scout_name` 并自增 `version`）。
- **Request**：
  ```ts
  interface RenameUserBody {
    newUsername?: string; // <= 50 字符
    oldPassword?: string; // 修改密码且原账号有密码时必填
    newPassword?: string;
  }
  ```
- **Response**：同 `AuthUserResponse` (`{ id: string; username: string; token: string }`)
  - 错误码：`400` (`"newUsername too long"`), `401` (`"Unauthorized"` / `"Incorrect old password"`), `404` (`"User not found"`), `409` (`"Username already taken"`)

### `POST /api/user/merge`（别名：`POST /api/users/merge`）
- **说明**：将当前登录账号（`sourceId`）的所有赛事归属、侦察记录、排班、标签、AI 会话等原子级联迁移至目标已注册账号（`targetUsername`），并返回目标账号 Token。
- **Request**：
  ```ts
  interface MergeUserBody {
    targetUsername: string;
    targetPassword: string;
  }
  ```
- **Response**：同 `AuthUserResponse` (`{ id: string; username: string; token: string }`)
  - 错误码：`400` (`"targetUsername and targetPassword required"`), `401` (`"Invalid target account password"`), `404` (`"Target user not found"`)

---

## 2. 系统与网络模块 (`SystemRoutes` / `ApiRoutes`)

### `GET /api/system/network-info`
- **说明**：获取本机操作系统类型、局域网 IPv4/IPv6 地址列表、当前监听端口、防火墙放行状态与扫码加入基础 URL（免鉴权）。
- **Request**：无
- **Response**：
  ```ts
  interface NetworkInfoResponse {
    os: 'windows' | 'macos' | 'linux' | string;
    isWindows: boolean;
    isMac: boolean;
    primaryIp: string;
    allIps: string[];
    primaryIpv6?: string | null;
    allIpv6s: string[];
    port: number;
    firewallAllowed: boolean;
    firewallCommand: string;
    macFirewallCommand: string;
    joinBaseUrl: string;
    joinBaseUrlIpv6?: string;
  }
  ```

### `POST /api/system/open-firewall-cmd`
- **说明**：在 Windows 主机触发 UAC 弹窗放行当前端口与 JCEF helper 防火墙规则（免鉴权）。
- **Request**：无
- **Response**：
  ```ts
  interface OpenFirewallResponse {
    success: boolean;
    allowed: boolean;
    command: string;
    port: number;
    os: string;
  }
  ```

### `POST /api/system/log`
- **说明**：将远端客户端文本日志追加写入主机 `<logDir>/scoutingpro_*.log`（免鉴权；`<logDir>` 解析规则见 `§14`）。
- **Request**：`Body: string`（纯文本日志内容）
- **Response**：`{ success: true }`

### `POST /api/test/cleanup`（仅 `ENABLE_TEST_CLEANUP=true`）
- **说明**：测试专用接口，按用户名列表级联清理测试用户及其创建的赛事（需设置环境变量 `ENABLE_TEST_CLEANUP=true` 或 JVM 属性 `-DENABLE_TEST_CLEANUP=true` 方可注册；未开启时鉴权过滤器仍放行，路由未注册返回 `404`）。
- **Request**：`Body: string[]`（用户名数组）
- **Response**：`200 ("Cleanup OK")` / `500`
  - 错误码（未开启时）：`404`

### `POST /api/test/shutdown`（仅 `ENABLE_TEST_CLEANUP=true`）
- **说明**：测试专用接口，触发后端优雅停机（需设置环境变量 `ENABLE_TEST_CLEANUP=true` 或 JVM 属性 `-DENABLE_TEST_CLEANUP=true` 方可注册并免鉴权；未开启时无 Token 返回 `401`，携带有效 Token 返回 `404`）。
- **Request**：无
- **Response**：`{ status: "shutting_down" }`
  - 错误码（未开启时）：`401`（无有效 Token）、`404`（携带有效 Token）

---

## 3. 信令与 WebRTC 安全票据模块 (`SignalingRoutes` / `WebRtcRoutes`)

### `WS /ws/signal/{room}`
- **说明**：离线局域网 WebSocket 信令中继房间；收到任意客户端文本帧后原样广播给同 `{room}` 内除发送方外的所有在线对端。
- **Request**：
  ```ts
  interface SignalWsPath {
    room: string; // Path 参数：赛事邀请码或信令房间号
  }
  // WebSocket Text Frame: JSON 序列化的信令负载（host_probe / host_hello / offer / answer / candidate / sdp / sas_rejected 等）
  ```
- **Response**：向同房间其余客户端广播相同的文本帧。

### `POST /api/webrtc/handshake-ticket`
- **说明**：赛事成员获取绑定自身 `userId`、`eventId` 与 `ecdhPublicKey` SHA-256 指纹的短期 WebRTC 握手票据。
- **Request**：
  ```ts
  interface HandshakeTicketBody {
    eventId: string;       // 赛事 UUID 或 inviteCode
    ecdhPublicKey: string; // 客户端 ECDH 公钥
  }
  ```
- **Response**：
  ```ts
  interface HandshakeTicketResponse {
    ticket: string;
    expiresIn: number; // 秒
  }
  ```
  - 错误码：`400` (`"eventId and ecdhPublicKey are required"`), `403` (`"User is not a member of this event"`), `404` (`"User not found"` / `"Event not found"`)

### `POST /api/webrtc/verify-ticket`
- **说明**：校验对端 WebRTC 握手票据签名、赛事归属及 ECDH 公钥绑定是否匹配。
- **Request**：
  ```ts
  interface VerifyTicketBody {
    ticket: string;
    eventId: string;       // 赛事 UUID 或 inviteCode
    ecdhPublicKey: string;
  }
  ```
- **Response**：
  ```ts
  type VerifyTicketResponse =
    | { valid: true; userId: string; username: string; eventId: string }
    | { valid: false; error: string };
  ```
  - 错误码：`400` (`"ticket, eventId, and ecdhPublicKey are required"`), `403` (`{ valid: false, error: "Caller is not a member of this event" }`), `404` (`{ valid: false, error: "Event not found" | "User not found" }`)

---

## 4. 赛事、成员、TURN 配置与禁选战队模块 (`EventRoutes`)

> **赛事权限约定**：`GET /api/events/{id}/banned-teams` 与 `GET /api/events/{id}/members` 仅要求携带有效登录 Token（不校验调用方是否已加入该赛事）；`PUT /api/events/{id}/ftc-config`、`PUT /api/events/{id}/turn-config`、`POST|DELETE /api/events/{id}/banned-teams*`、`POST|DELETE /api/events/{id}/members*` 均严格要求调用方为赛事 Host（`userId === event.hostId`），否则返回 `403 Forbidden`。

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
}
```

### `GET /api/events`
- **说明**：获取当前用户已加入的所有赛事列表（自动解密并水合 `customTurnConfig`）。
- **Request**：无
- **Response**：`ScoutingEvent[]`

### `POST /api/events`
- **说明**：创建新赛事，当前用户自动成为 Host 并加入赛事。
- **Request**：
  ```ts
  interface CreateEventBody {
    name: string;
  }
  ```
- **Response**：
  ```ts
  interface CreateEventResponse {
    id: string;
    inviteCode: string; // 6 位大写字母数字邀请码
  }
  ```

### `POST /api/events/join`
- **说明**：凭邀请码加入赛事；若本地数据库不存在该邀请码（跨机分布式场景），自动创建 `ext_<INVITECODE>` 外部赛事存根并加入。
- **Request**：
  ```ts
  interface JoinEventBody {
    inviteCode: string;
  }
  ```
- **Response**：`ScoutingEvent`
  - 错误码：`400` (`"Missing inviteCode"`)

### `DELETE /api/events/{id}`
- **说明**：若调用者为赛事 Host 则彻底删除赛事；若为普通成员则仅退出赛事（移除 `event_users` 关联）。
- **Request**：`Path: { id: string }`
- **Response**：`204 No Content`

### `POST /api/events/external-sync`
- **说明**：将从远端 Host 同步来的权威赛事元数据写入本地数据库，并将本地 `ext_<INVITECODE>` 临时存根下的所有记录、排班、Pit 照片、CRDT 状态等自动过户（Reparent）到权威 `eventId`。
- **Request**：`Body: ScoutingEvent`（必填 `id`、`inviteCode`）
- **Response**：`ScoutingEvent`
  - 错误码：`400` (`"Invalid event payload"`)

### `PUT /api/events/{id}/ftc-config`
- **说明**：Host 配置或清空赛事绑定的 FTC 官方赛季与赛事代码（配置非空代码时会在线校验 FTC 官方 API 是否存在该赛事）。
- **Request**：
  ```ts
  interface UpdateFtcConfigBody {
    ftcYear?: number | null;      // 2000..2100
    ftcEventCode?: string | null; // /^[A-Za-z0-9_-]{1,32}$/，传空或 null 清空配置
  }
  ```
- **Response**：`200 ("OK")`
  - 错误码：`400` (`"Invalid ftcYear"` / `"Invalid ftcEventCode format"` / `"FTC 官方赛事代码不存在..."`), `403` (`"Only the host can configure the event"`), `404` (`"Event not found"`), `502` (`"FTC 官方 API 校验失败..."`)

### `PUT /api/events/{id}/turn-config`
- **说明**：Host 配置或清空赛事的自定义 TURN 中继服务器配置（AES 加密落盘，支持掩码密码 `****` 保留原密码）。
- **Request**：
  ```ts
  interface UpdateTurnConfigBody {
    clear?: boolean;
    urls?: string[];     // turn: 或 turns: 开头，最多 10 个
    username?: string;
    credential?: string; // 首次必填；更新时传 "****" 可沿用已保存密码
  }
  ```
- **Response**：
  ```ts
  interface UpdateTurnConfigResponse {
    hasCustomTurn: boolean;
    customTurnConfig: TurnServerConfig | null;
  }
  ```
  - 错误码：`400`, `403` (`"Only the host can configure the event"`), `404` (`"Event not found"`)

### `GET /api/events/{id}/banned-teams`
- **说明**：获取指定赛事的黑名单（禁选）队伍号列表。
- **Request**：`Path: { id: string }`
- **Response**：`number[]`

### `POST /api/events/{id}/banned-teams`
- **说明**：Host 将某支队伍加入赛事禁选名单。
- **Request**：
  ```ts
  interface BanTeamBody {
    teamNumber: number;
  }
  ```
- **Response**：`200 ("OK")`
  - 错误码：`400`, `403` (`"Only the host can ban teams"`), `404` (`"Event not found"`)

### `DELETE /api/events/{id}/banned-teams/{teamNumber}`
- **说明**：Host 将某支队伍移出赛事禁选名单。
- **Request**：`Path: { id: string; teamNumber: number }`
- **Response**：`200 ("OK")`
  - 错误码：`400`, `403` (`"Only the host can unban teams"`), `404` (`"Event not found"`)

### `GET /api/events/{id}/members`
- **说明**：获取赛事所有成员列表。
- **Request**：`Path: { id: string }`
- **Response**：
  ```ts
  interface EventMember {
    id: string;
    username: string;
    host: boolean;
  }
  type GetEventMembersResponse = EventMember[];
  ```

### `POST /api/events/{id}/members`
- **说明**：Host 代理注册/添加成员到当前赛事（为离线或 P2P 成员建立本地用户占位符，绝不覆盖已设置密码用户的用户名）。
- **Request**：
  ```ts
  interface RegisterEventMemberBody {
    userId: string;
    username?: string;
  }
  ```
- **Response**：`200 ("OK")`
  - 错误码：`400` (`"Missing userId"`), `403` (`"Only the event host can register members"`), `404` (`"Event not found"`)

### `DELETE /api/events/{id}/members/{userId}`
- **说明**：Host 移除赛事中的指定成员（Host 不能移除自己）。
- **Request**：`Path: { id: string; userId: string }`
- **Response**：`200 ("OK")`
  - 错误码：`400` (`"Host cannot be removed from event"`), `403` (`"Only the event host can remove members"`), `404` (`"Event not found"`)

---

## 5. 战队标签模块 (`TeamTagRoutes`)

```ts
interface TeamTag {
  id: string;
  eventId: string;
  teamNumber: number;
  tag: string;       // 1..30 字符，纯 ASCII 时自动转小写，禁止包含 '.'
  color: 'red' | 'orange' | 'green' | 'blue' | 'purple' | 'gray' | 'yellow';
  isPreset: boolean;
  createdBy: string;
  createdAt?: string;
  updatedAt?: string;
}
```

### `GET /api/events/{id}/tags`
- **说明**：获取赛事下所有战队的标签列表（仅需有效登录 Token，不校验 `isMember`）。
- **Request**：`Path: { id: string }`
- **Response**：`TeamTag[]`

### `POST /api/events/{id}/teams/{teamNumber}/tags`
- **说明**：为指定战队添加或更新标签（每支队伍最多 15 个标签；仅校验有效登录 Token 与赛事存在，不校验 `isMember`，`isPreset` 强制写为 `false`）。
- **Request**：
  ```ts
  interface AddTeamTagBody {
    tag: string;    // 1..30 字符，禁止含 '.'
    color?: string; // 默认 'blue'
  }
  ```
- **Response**：`TeamTag`
  - 错误码：`400` (`"tag required"` / `"Tag must be between 1 and 30 characters"` / `"Tags cannot contain '.'"` / `"Tag contains invalid characters"` / `"Maximum 15 tags per team allowed"`), `404` (`"Event not found"`)

### `DELETE /api/events/{id}/teams/{teamNumber}/tags/{tag}`
- **说明**：删除指定战队的标签（仅标签创建者或赛事 Host 可删；标签不存在时幂等返回 200）。
- **Request**：`Path: { id: string; teamNumber: number; tag: string }`（`tag` URL 编码）
- **Response**：`200 ("OK")`
  - 错误码：`400`, `403` (`"Only the tag creator or event host can delete this tag"`), `404` (`"Event not found"`)

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
- **说明**：赛事成员获取完整赛程与排班列表。
- **Request**：`Path: { id: string }`
- **Response**：
  ```ts
  interface GetScheduleResponse {
    schedules: MatchScheduleItem[];
    assignments: ScoutAssignment[];
  }
  ```
  - 错误码：`403` (`"Not a member of this event"`)

### `POST /api/events/{id}/schedule/batch`
- **说明**：Host 批量导入或覆盖赛程（自动初始化 `red1/red2/blue1/blue2` 四个工位排班，并可选同时批量写入 `assignments`）。
- **Request**：
  ```ts
  interface BatchScheduleBody {
    replace?: boolean; // 为 true 时先清空旧赛程与排班
    items: Array<{
      id?: string;
      matchNumber: number; // > 0
      tournamentLevel?: string;
      red1?: number;
      red2?: number;
      blue1?: number;
      blue2?: number;
    }>;
    assignments?: Array<{
      id?: string;
      matchNumber: number;
      tournamentLevel?: string;
      station: string;
      teamNumber?: number;
      scoutId?: string | null;
      scoutName?: string | null;
    }>;
  }
  ```
- **Response**：`{ success: true; count: number }`
  - 错误码：`400` (`"items array required"`), `403` (`"Only the event host can modify match schedule or assignments"`), `404` (`"Event not found"`)

### `DELETE /api/events/{id}/schedule`
- **说明**：Host 清空指定赛事的全部赛程与排班。
- **Request**：`Path: { id: string }`
- **Response**：`{ success: true }`
  - 错误码：`403` (`"Only the event host can modify match schedule or assignments"`)

### `PUT /api/events/{id}/assignments`
- **说明**：Host 批量更新工位排班（支持传 `scoutId: null` 留空工位）。
- **Request**：
  ```ts
  interface UpdateAssignmentsBody {
    assignments: Array<{
      id?: string;
      matchNumber: number;
      tournamentLevel?: string;
      station: 'red1' | 'red2' | 'blue1' | 'blue2' | string;
      teamNumber?: number;
      scoutId?: string | null;
      scoutName?: string | null;
    }>;
  }
  ```
- **Response**：`{ success: true; count: number }`
  - 错误码：`400` (`"assignments array required"`), `403` (`"Only the event host can modify match schedule or assignments"`)

---

## 7. 比赛侦察记录模块 (`RecordRoutes`)

```ts
interface ScoutingRecord {
  id: string;
  eventId: string;
  scoutId?: string;
  scoutName?: string;
  matchNumber: number; // > 0
  teamNumber: number;  // > 0
  autoScore: number;
  teleopScore: number;
  endgameScore: number;
  totalScore: number;
  notes?: string;
  rawData?: string;    // JSON 字符串，含详细打分与 customFields
  syncStatus?: string;
  createdAt?: string;
  updatedAt?: string;
  isBroken?: boolean;
  isDeleted?: boolean;
  version?: number;
  authorPubKey?: string;
  authorSig?: string;
  hostSig?: string;
}
```

### `GET /api/records`
- **说明**：赛事成员获取指定赛事的全部比赛侦察记录。
- **Request**：`Query: { eventId: string }`
- **Response**：`ScoutingRecord[]`
  - 错误码：`400` (`"eventId required"`), `403` (`"Not a member of this event"`)

### `POST /api/records`
- **说明**：赛事成员新增或更新单条比赛记录（非 Host 仅可修改本人记录，且强制绑定 `scoutId = userId`）。
- **Request**：`Body: ScoutingRecord`
- **Response**：`200 ("OK")`
  - 错误码：`400` (`"Invalid matchNumber or teamNumber"` / `"Event ID cannot be blank"`), `403` (`"Not a member of this event"` / `"Cannot modify another scout's record"`)

### `POST /api/records/sync`
- **说明**：批量同步比赛侦察记录（非 Host 普通成员仅可同步本人未签名记录，或经 ECDSA 验签且符合公钥绑定与作者不可变约束的队友签名记录）。
- **Request**：`Body: ScoutingRecord[]`
- **Response**：`200 ("OK")`
  - 错误码：`400` (`"Sync failed: ..."`), `403` (`"Not a member of event: ..."` / `"Cannot sync records belonging to another scout"` / `"Cannot modify another scout's record"` / ECDSA 拒绝原因)

### `POST /api/records/migrate-scout`
- **说明**：将指定赛事下 `oldScoutId` 的全部比赛记录、排班、Pit 记录、标签及成员关系迁移至 `newScoutId`（仅 Host 或涉及的侦察员本人可调用）。
- **Request**：
  ```ts
  interface MigrateScoutBody {
    eventId: string;
    oldScoutId: string;
    newScoutId: string;
    newScoutName: string;
  }
  ```
- **Response**：`200 ("OK")`
  - 错误码：`400` (`"eventId, oldScoutId, newScoutId, and newScoutName required"`), `403` (`"Only event host or the scout can migrate records"`)

### `GET /api/records/pending`
- **说明**：赛事成员获取指定赛事下 `sync_status != 'SYNCED'` 的待同步记录。
- **Request**：`Query: { eventId: string }`
- **Response**：`ScoutingRecord[]`
  - 错误码：`400` (`"eventId required"`), `403` (`"Not a member of this event"`)

### `POST /api/records/mark-synced`
- **说明**：将当前用户名下（`WHERE id = :id AND scout_id = :userId`）的一组记录 ID 标记为已同步（`SYNCED`）；不属于当前调用者的记录 ID 会被静默忽略。
- **Request**：`Body: string[]`（记录 ID 数组）
- **Response**：`200 ("OK")`

---

## 8. Pit 展位侦察与官方战队底册模块 (`PitScoutRoutes`)

```ts
interface PitScoutingRecord {
  id?: string;
  eventId?: string;
  teamNumber: number;
  scoutId?: string;
  scoutName?: string;
  robotName?: string;
  drivetrainType?: string;            // 默认 'mecanum'
  weightLbs?: number;                 // >= 0
  chassisSize?: string;               // <= 64 字符
  odometryType?: string;              // 默认 'none'
  ballCompatibility?: string;         // 默认 'universal'
  launcherType?: string;
  flowerMechanism?: string;
  hasColorSensor?: boolean;
  hasDescoreMech?: boolean;
  hasApriltagVision?: boolean;
  claimedAutoStrategy?: string;
  claimedAutoScore?: number;
  claimedTeleopCycles?: number;
  claimedTeleopScore?: number;
  claimedTeleopPark?: boolean;
  claimedFlowerNectars?: number;      // 0..8
  claimedFlowerBottomBonus?: number;  // 0..min(4, claimedFlowerNectars)
  claimedFlowerPollens?: number;      // >= 0
  claimedGardenBalls?: number;        // >= 0
  claimedEndgameScore?: number;       // 传入结构化终局项时按 BIOBUZZ 公式自动归一化
  claimedTotalScore?: number;
  photoKeys?: string[];               // JSON 数组或 JSON 字符串均可被适配器解析
  version?: number;
  isDeleted?: boolean;
  rawData?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface OfficialTeam {
  eventId?: string;
  teamNumber: number;
  nameFull: string;
  robotName?: string;
  city?: string;
  country?: string;
  updatedAt?: string;
}
```

### `GET /api/events/{eventId}/pit-records`
- **说明**：赛事成员获取全部有效 Pit 侦察记录与官方参赛战队名录底册。
- **Request**：`Path: { eventId: string }`
- **Response**：
  ```ts
  interface GetPitRecordsResponse {
    records: PitScoutingRecord[];
    officialTeams: OfficialTeam[];
  }
  ```
  - 错误码：`400`, `403` (`"Not a member of this event"`)

### `POST /api/events/{eventId}/pit-records`
- **说明**：赛事成员新增或更新单条 Pit 侦察记录（自动按 BIOBUZZ 规则归一化终局与总分）。
- **Request**：`Body: PitScoutingRecord`
- **Response**：`{ success: true; record: PitScoutingRecord }`
  - 错误码：`400` (`"Invalid PitScoutingRecord payload"`), `403` (`"Not a member of this event"`)

### `POST /api/events/{eventId}/pit-records/batch`
- **说明**：赛事成员批量同步 Pit 侦察记录。
- **Request**：`Body: PitScoutingRecord[]`
- **Response**：`{ success: true; count: number }`
  - 错误码：`403` (`"Not a member of this event"`), `500`

### `POST /api/events/{eventId}/official-teams/sync`
- **说明**：赛事成员批量保存或同步官方参赛战队名录底册。
- **Request**：`Body: OfficialTeam[]`
- **Response**：`{ success: true; count: number }`
  - 错误码：`403` (`"Not a member of this event"`)

### `GET /api/events/{eventId}/official-teams`
- **说明**：赛事成员单独获取官方参赛战队名录底册。
- **Request**：`Path: { eventId: string }`
- **Response**：`OfficialTeam[]`
  - 错误码：`403` (`"Not a member of this event"`)

### `POST /api/events/{eventId}/pit/photos`
- **说明**：赛事成员上传 Base64 编码的展位照片并原子落盘为 `<dataDir>/pit_photos/{eventId}/{key}.webp`（带路径穿越防护；`<dataDir>` 解析规则见 `§14`）。
- **Request**：
  ```ts
  interface UploadPitPhotoBody {
    key: string;     // /^[a-zA-Z0-9_\-]+$/
    dataUrl: string; // data:image/webp;base64,... 或纯 Base64 字符串
  }
  ```
- **Response**：
  ```ts
  interface UploadPitPhotoResponse {
    success: true;
    key: string;
    url: string; // "/api/events/{eventId}/pit/photos/{key}"
  }
  ```
  - 错误码：`400` (`"Invalid eventId"` / `"Invalid photo key"` / `"Missing photo data"` / `"Invalid base64 encoding"`), `403` (`"Not a member of this event"`)

### `GET /api/events/{eventId}/pit/photos/{key}`
- **说明**：流式读取磁盘上的展位 WebP 照片（免鉴权，带 `Cache-Control: public, max-age=31536000, immutable`）。
- **Request**：`Path: { eventId: string; key: string }`（均须匹配 `/^[a-zA-Z0-9_\-]+$/`）
- **Response**：`200 image/webp`（二进制字节流）
  - 错误码：`400` (`"Invalid eventId or key"`), `404` (`"Photo not found"`)

### `DELETE /api/events/{eventId}/pit/photos/{key}`
- **说明**：赛事成员删除磁盘上的指定展位照片（文件不存在时幂等返回 200）。
- **Request**：`Path: { eventId: string; key: string }`
- **Response**：`{ success: true; key: string }`
  - 错误码：`400` (`"Invalid eventId or key"`), `403` (`"Not a member of this event"`)

---

## 9. 自定义字段模块 (`CustomFieldRoutes`)

```ts
interface CustomFieldDefinition {
  id?: string;
  eventId?: string;
  target?: 'MATCH' | 'PIT'; // 默认 'MATCH'
  phase?: 'auto' | 'teleop' | 'endgame' | 'overall' | 'hardware' | 'strategy'; // 默认 'overall'
  name: string;             // 1..100 字符
  fieldKey?: string;        // /^[a-z0-9_]{1,100}$/，不传时自动生成 field_<8hex>
  fieldType?: 'boolean' | 'number' | 'level' | 'select' | 'multi_select' | 'text'; // 默认 'text'
  required?: boolean;
  defaultVal?: string | null;
  optionsJson?: string | null;
  minVal?: number | null;
  maxVal?: number | null;
  stepVal?: number | null;
  unit?: string | null;
  orderSeq?: number;
  isActive?: boolean;
  createdAt?: string;
  updatedAt?: string;
}
```

### `GET /api/events/{eventId}/custom-fields`
- **说明**：赛事成员查询赛事下所有自定义字段定义。
- **Request**：`Path: { eventId: string }`
- **Response**：`CustomFieldDefinition[]`
  - 错误码：`403` (`"Not a member of this event"`)

### `POST /api/events/{eventId}/custom-fields`
- **说明**：Host 新增自定义字段定义（校验同一 `eventId + target + fieldKey` 唯一性，返回 `201 Created`）。
- **Request**：`Body: CustomFieldDefinition`
- **Response**：`201` -> `CustomFieldDefinition`
  - 错误码：`400` (`"Field name is required"` / `"Invalid target..."` / `"Invalid fieldType..."` / `"Field key '...' already exists..."`), `403` (`"Only event host can manage custom fields"`), `404` (`"Event not found"`)

### `PUT /api/events/{eventId}/custom-fields/{id}`
- **说明**：Host 修改现有自定义字段定义（`target` 与 `fieldKey` 不可变更）。
- **Request**：`Path: { eventId: string; id: string }`, `Body: Partial<CustomFieldDefinition>`
- **Response**：`CustomFieldDefinition`
  - 错误码：`400`, `403` (`"Only event host can manage custom fields"`), `404` (`"Event not found"` / `"Custom field not found"`)

### `DELETE /api/events/{eventId}/custom-fields/{id}`
- **说明**：Host 删除指定自定义字段定义。
- **Request**：`Path: { eventId: string; id: string }`
- **Response**：`{ success: true; id: string }`
  - 错误码：`403` (`"Only event host can manage custom fields"`), `404` (`"Event not found"` / `"Custom field not found"`)

---

## 10. CRDT 状态快照与关系表投影模块 (`CrdtRoutes`)

### `GET /api/events/{eventId}/crdt-state`
- **说明**：赛事成员获取指定赛事在 `event_crdt_state` 表中持久化的 TinyBase `MergeableStore` CRDT 快照。若该赛事尚未写入过 `event_crdt_state`，返回 `{ exists: false, eventId, hostEpoch: 1, snapshotRevision: 0, snapshot: null, updatedAt: null }`（服务端**不会**自动从关系表回填生成快照）。
- **Request**：`Path: { eventId: string }`
- **Response**：
  ```ts
  interface GetCrdtStateResponse {
    exists: boolean;
    eventId: string;
    hostEpoch: number;
    snapshotRevision: number;
    snapshot: unknown[] | null; // TinyBase MergeableStore [tablesStamp, valuesStamp] JSON 数组；exists=false 时为 null
    updatedAt: string | null;
  }
  ```
  - 错误码：`400` (`{ error: "Invalid eventId" }`), `403` (`"Not a member of this event"`)

### `PUT /api/events/{eventId}/crdt-state`
- **说明**：赛事成员保存整个 `snapshot` 至 `event_crdt_state` 表，并按 `dirtyRows`（或当 `fullProjection === true`，或数据库尚无 `event_crdt_state` 记录且 `dirtyRows` 为空时执行全量投影）向关系表（`scouting_records`、`pit_scouting_records`、`team_tags`、`event_custom_fields`、`match_schedules`、`scout_assignments`）执行事务投影。
  - **注意 1（快照覆盖 vs 增量投影）**：`event_crdt_state.crdt_snapshot_json` 会在服务端直接被本次传入的 `snapshot` 替换覆盖（服务端不做 TinyBase CRDT 内存合并，合并由前端在 PUT 前完成）。
  - **注意 2（`dirtyRows` 键名规范）**：服务端 `CrdtProjectionService` 严格读取 **snake_case** 表名键（见下方类型定义）；若传入 camelCase 键名（如 `scoutingRecords`）会导致对应表增量投影被跳过！
  - **注意 3（非 Host 权限静默过滤）**：当非 Host 普通成员调用 PUT 时，`scouting_records` 中不属于本人且未通过 ECDSA 验签/公钥绑定的记录会被**静默跳过投影**（不抛 `403`），但其余表（如 `pit_records`、`schedules` 等）及 `event_crdt_state` 快照仍会按传入内容落盘。
- **Request**：
  ```ts
  interface PutCrdtStateBody {
    hostEpoch?: number;                // 默认 1；若 < 数据库当前 hostEpoch 则触发 stale_epoch 栅栏拒绝（409）
    snapshotRevision?: number;         // 默认 0；若 hostEpoch 相同且 snapshotRevision > 0 但 < 数据库当前 snapshotRevision 则触发 stale_revision 拒绝（409）
    fullProjection?: boolean;          // 默认 false；为 true 时忽略 dirtyRows 全量投影所有表
    snapshot?: unknown[] | string;     // TinyBase MergeableStore 快照 JSON 数组（或序列化后的 JSON 数组字符串）
    crdtSnapshotJson?: unknown[] | string; // snapshot 的兼容别名（当 snapshot 未传时回退读取）
    dirtyRows?: {                      // 键名必须严格使用以下 snake_case（与 TinyBase 表名一致）：
      scouting_records?: string[];     // rowId: record.id
      pit_records?: string[];          // rowId: String(teamNumber)
      pit_photo_keys?: string[];       // rowId: `${teamNumber}::${photoKey}`
      team_tags?: string[];            // rowId: `${teamNumber}::${normalizedTag}`
      custom_fields?: string[];        // rowId: field.id
      schedules?: string[];            // rowId: schedule row key
      assignments?: string[];          // rowId: assignment row key
    };
  }
  ```
- **Response**：
  ```ts
  interface PutCrdtStateResponse {
    saved: boolean;
    stale: boolean;
    eventId: string;
    hostEpoch: number;
    snapshotRevision: number;
    error?: 'stale_epoch' | 'stale_revision' | string; // 仅当 stale === true 时存在
    projectedCounts?: {                                // 仅当 stale === false 时存在
      pit_records: number;
      team_tags: number;
      custom_fields: number;
      schedules: number;
      assignments: number;
      scouting_records: number;
    };
  }
  ```
  - 错误码：`400` (`{ error: "Invalid eventId" | "Request body must be a JSON object" | "Invalid JSON body" | "snapshot array is required" }`), `403` (`"Not a member of this event"`), `409 Conflict`（当 `stale === true` 时返回 HTTP 409 及上述 `PutCrdtStateResponse` JSON）

---

## 11. FTC 官方数据代理与晋级分汇算模块 (`FtcProxyRoutes`)

> 所有 `/api/ftc/{season}/*/{eventCode}` 接口均要求：`season` 为 `2000..2100` 的整数，`eventCode` 匹配 `/^[A-Za-z0-9_-]{1,32}$/`；参数不合法返回 `400`，上游异常返回 `500 ({ error: string })`。

### `GET /api/ftc/{season}/matches/{eventCode}`
- **说明**：获取归一化后的 FTC 官方比赛列表及净得分（扣除对方犯规送分后的 `totalPointsNp`）。
- **Request**：`Path: { season: number; eventCode: string }`, `Query: { tournamentLevel?: 'QUAL' | 'QUALIFICATION' | 'PLAYOFF' }`
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
- **Request**：`Path: { season: number; eventCode: string }`, `Query: { tournamentLevel?: 'QUAL' | 'QUALIFICATION' | 'PLAYOFF' }`
- **Response**：`Record<string, unknown>`（FTC v2.0 `/scores/{eventCode}/{level}` 响应体）

### `GET /api/ftc/{season}/teams/{eventCode}`
- **说明**：获取自动翻页聚合后的 FTC 官方参赛战队列表。
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
- **说明**：获取归一化后的 FTC 官方资格赛排名列表（支持 `BIOBUZZ_SYNTHETIC` / `SYNTHETIC` 合成测试数据）。
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
- **说明**：获取归一化后的 FTC 官方赛事奖项列表。
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
- **说明**：获取归一化后的 FTC 官方季后赛联盟选队列表。
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
- **说明**：实时汇算赛事全部战队的 FTC 官方标准晋级分、晋级状态及顺延结果。
- **Request**：`Path: { season: number; eventCode: string }`, `Query: { slots?: number }`（可选覆盖官方晋级名额）
- **Response**：
  ```ts
  interface TeamAdvancementEntry {
    teamNumber: number;
    qualRank: number;
    advancementRank: number;
    qualPoints: number;
    alliancePoints: number;
    playoffPoints: number;
    awardPoints: number;
    totalAdvancementPoints: number;
    advancementStatus: 'ADVANCING' | 'BUBBLE' | 'COMPETING' | 'ALREADY_ADVANCING' | 'DECLINED' | 'INELIGIBLE';
    officialStatus?: string;
    declined: boolean;
    rolledDown: boolean;
    advancementSlot: number;
    advancementCriteria: string;
    advancesTo?: string;
    tiebreakerSort1: number;
    tiebreakerSort2: number;
    tiebreakerAuto: number;
    tiebreakerHigh: number;
  }
  type GetFtcAdvancementResponse = TeamAdvancementEntry[];
  ```

---

## 12. AI Copilot 配置、连通性探测与多会话模块 (`AiRoutes`)

```ts
interface AiProviderProfile {
  id: string;
  userId: string;
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
  maxTokens: number;       // 默认 4096
  enableThinking: boolean; // 默认 true
  thinkingBudget: number;  // 默认 4096 (>= 1024)
  anthropicVersion: string;// 默认 '2023-06-01'
  maxContextMsgs: number;  // 默认 16
  proxyHost: string;
  proxyPort?: number | null;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}
```

### `GET /api/users/{userId}/ai-profiles`
- **说明**：获取当前用户的多 AI 服务商配置档案列表（若尚无新档案但有旧版 `ai_settings`，自动迁移生成；API Key 自动脱敏）。
- **Request**：`Path: { userId: string }`（必须等于当前登录 `userId`）
- **Response**：`AiProviderProfile[]`
  - 错误码：`403` (`"Cannot access AI profiles of another user"`)

### `POST /api/users/{userId}/ai-profiles`
- **说明**：创建或更新 AI 服务商配置档案（内置 SSRF 私网/元数据地址拦截；支持传脱敏 Key 沿用原已保存密钥；本地 Loopback OpenAI 兼容端点允许免 Key）。
- **Request**：
  ```ts
  interface SaveAiProfileBody {
    id?: string;
    name?: string;
    presetId?: string;
    protocol: 'OPENAI' | 'GEMINI' | 'ANTHROPIC';
    apiKey?: string;
    apiKeyEncrypted?: string;
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
  - 错误码：`400` (`{ error: "Unsupported AI protocol..." | "Forbidden baseUrl: SSRF protection blocked access" | "API Key is required for non-local AI provider profile" }`), `403`

### `POST /api/users/{userId}/ai-profiles/{profileId}/activate`
- **说明**：将指定 AI 配置档案设为当前用户的唯一激活档案。
- **Request**：`Path: { userId: string; profileId: string }`
- **Response**：`{ success: true; activeProfileId: string }`
  - 错误码：`403`, `404` (`{ error: "AI profile not found" }`)

### `DELETE /api/users/{userId}/ai-profiles/{profileId}`
- **说明**：删除指定 AI 配置档案；若删除的是当前激活档案，自动激活剩余列表中的第一个档案。
- **Request**：`Path: { userId: string; profileId: string }`
- **Response**：`{ success: true; nextActiveProfileId: string | null }`
  - 错误码：`403`, `404` (`{ error: "AI profile not found" }`)

### `GET /api/users/{userId}/ai-settings`（旧版兼容）
- **说明**：获取旧版按 provider 存储的 AI 设置列表（API Key 脱敏）。
- **Request**：`Path: { userId: string }`
- **Response**：`AiSettings[]`
  - 错误码：`403`

### `POST /api/users/{userId}/ai-settings`（旧版兼容）
- **说明**：保存旧版 AI 设置。
- **Request**：`Body: AiSettings`（必填 `provider`）
- **Response**：`{ success: true }`
  - 错误码：`400`, `403`

### `POST /api/ai/test-connection`（别名：`GET /api/ai/test-connection`、`POST /api/ai/models`）
- **说明**：测试 AI 服务商连通性并在线拉取可用模型列表（支持 `OPENAI`、`GEMINI`、`ANTHROPIC` 三种协议；当未传明文 `apiKey` 且传入的 `baseUrl` 为空或与已存档案的 `baseUrl` 忽略大小写完全一致时，才允许解密已存 Key，防止篡改 `baseUrl` 触发 SSRF 窃取已存 Key）。
  - **SSRF 安全边界（`AiUrlGuard.isSafeUrl`）**：仅允许 `http://` 或 `https://`；除显式放行本机 Loopback（`localhost`、`127.0.0.1`、`::1`、`0:0:0:0:0:0:0:1`，供本地 Ollama 等使用）外，严禁访问其他 Loopback（如 `127.0.0.2`）、局域网私网段（`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`）、链路本地/云元数据地址（`169.254.0.0/16`）及未指定地址。
  - **HTTP 状态码约定**：参数或 SSRF 校验失败返回 HTTP `400`；一旦进入上游 HTTP 探测流程，即使上游返回 401/403/500 或网络超时，本接口 HTTP 状态码**始终返回 `200`**，通过响应体 `success: false`、`statusCode` 与 `messageCode` 区分结果。
- **Request**：（支持 JSON Body 或同名 Query 参数）
  ```ts
  interface AiProbeRequest {
    profileId?: string;
    protocol?: 'OPENAI' | 'GEMINI' | 'ANTHROPIC';
    provider?: string; // protocol 的兼容别名
    baseUrl?: string;
    apiKey?: string;
    anthropicVersion?: string;
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
  - 错误码：`400` (`{ error: "Missing provider/protocol" | "Unsupported protocol..." | "Forbidden target URL: SSRF protection..." | "Invalid proxy port" }`)

### `POST /api/ai/chat`
- **说明**：执行非流式 AI 对话请求。
- **Request**：
  ```ts
  interface AiChatBody {
    profileId?: string; // profileId 与 provider 二选一必填
    provider?: string;
    systemPrompt?: string;
    modelName?: string;
    temperature?: number;
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  }
  ```
- **Response**：`{ reply: string }`
  - 错误码：`400` (`{ error: "Missing provider or profileId" | "AI Settings not configured..." }`), `500` (`{ error: string }`)

### `POST /api/ai/chat/stream`
- **说明**：执行三协议统一的 SSE（`text/event-stream`）流式 AI 对话（含 15 秒 `: heartbeat` 保活、深度思考 `reasoning` 块、正文 `text` 块与 Token `usage` 统计）。
- **Request**：同 `AiChatBody`
- **Response**：`200 text/event-stream; charset=UTF-8`
  ```ts
  // SSE 帧序列：
  // : heartbeat
  // data: {"reasoning": string}
  // data: {"text": string}
  // data: {"usage": { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; ... }}
  // data: {"error": string}
  // data: [DONE]
  ```

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
    lastMessagePreview: string;
    createdAt?: string;
    updatedAt?: string;
  }
  type GetAiThreadsResponse = AiThreadSummary[];
  ```
  - 错误码：`401`, `403` (`"Not a member of this event"`)

### `POST /api/events/{id}/ai-threads`
- **说明**：赛事成员在当前赛事下创建新的 AI 会话线程。
- **Request**：
  ```ts
  interface CreateAiThreadBody {
    id?: string;
    title?: string;     // 默认 'New Tactical Chat'，最长 180 字符
    personaId?: string; // 默认 'strategist'
    pinned?: boolean;
    messages?: unknown[];
    contextConfig?: Record<string, unknown>;
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
    messages: unknown[];
    contextConfig: Record<string, unknown>;
    createdAt?: string;
    updatedAt?: string;
  }
  ```

### `GET /api/events/{id}/ai-threads/{threadId}`
- **说明**：赛事成员获取单个 AI 会话线程的完整消息与上下文配置。
- **Request**：`Path: { id: string; threadId: string }`
- **Response**：`AiThreadPayload`
  - 错误码：`403`, `404` (`{ error: "Thread not found" }`)

### `PUT /api/events/{id}/ai-threads/{threadId}`
- **说明**：赛事成员更新（或按 ID 幂等创建）单个 AI 会话线程。
- **Request**：
  ```ts
  interface UpdateAiThreadBody {
    title?: string;
    personaId?: string;
    pinned?: boolean;
    messages?: unknown[];
    messagesJson?: string;
    contextConfig?: Record<string, unknown>;
    contextConfigJson?: string;
  }
  ```
- **Response**：`AiThreadPayload`
  - 错误码：`400` (`{ error: "messages must be a JSON array" | ... }`), `403`

### `DELETE /api/events/{id}/ai-threads/{threadId}`
- **说明**：赛事成员删除本人的指定 AI 会话线程。
- **Request**：`Path: { id: string; threadId: string }`
- **Response**：`{ success: true }`
  - 错误码：`403`, `404` (`{ error: "Thread not found" }`)

### `GET /api/events/{id}/ai-chat` & `PUT /api/events/{id}/ai-chat`（旧版兼容）
- **说明**：读取或覆盖当前用户在指定赛事下的旧版单会话消息 JSON 数组（仅校验登录态 `userId != null`，不校验 `isMember`）。
- **Request (`PUT`)**：`Body: unknown[]`（必须为 JSON 数组）
- **Response (`GET`)**：`unknown[]`；**Response (`PUT`)**：`{ success: true }`

---

## 13. JCEF 桌面容器与前端全局桥接 (`Main.java` / `window.*`)

> 本项目 JCEF 容器未注册 `CefMessageRouter`（无 `window.cefQuery`），桌面宿主与前端通过内嵌 Javalin HTTP/WS 服务及以下全局 Window Hook / 控制台拦截交互：

### `JCEF Shell Query: ?shell=desktop`（仅 Windows 桌面壳）
- **说明**：`Main.buildLocalAppUrl(port, hasCustomTitleBar)` 在 Windows 桌面端（`hasCustomTitleBar = true`，使用无边框 `JFrame` + Swing `CustomTitleBar`）启动内嵌浏览器时加载 `http://localhost:<port>/index.html?shell=desktop`；macOS / Linux 使用系统原生标题栏（`hasCustomTitleBar = false`），加载 `http://localhost:<port>/index.html`（不带 `shell` 参数）。
- **前端识别与表现**：`frontend/src/utils/desktopShell.ts#hasDesktopTitleBar()` 通过 `new URLSearchParams(window.location.search).get('shell') === 'desktop'` 判定；返回 `true` 时，`DashboardView.vue` 为 `.topbar` 添加 `.is-desktop-shell` 并用 `.page-heading` 替代 `.brand` Logo，`EventView.vue` 隐藏 `.event-brand-logo`，避免与桌面自定义标题栏重复展示品牌元素。

### `JCEF Bridge: window.__rtcDisconnect`
- **说明**：桌面主窗口关闭（`windowClosing`）时，Swing 宿主通过 `browser.executeJavaScript("if (window.__rtcDisconnect) { window.__rtcDisconnect(); }")` 触发前端立即广播 `HOST_LEAVING` 并主动断开 WebRTC / 信令连接，随后等待 150ms 再销毁 CEF 与 Javalin 实例。
- **Request**：无参数调用 `window.__rtcDisconnect()`
- **Response**：`void`

### `JCEF Bridge: CefDisplayHandler.onConsoleMessage`
- **说明**：JCEF 拦截前端所有 `console.log / warn / error` 输出，自动格式化为 `[<ISO_LOCAL_DATE_TIME>] [Frontend-Console] (<source>:<line>) <message>` 并追加落盘至桌面端 `<logDir>/scoutingpro_*.log`（`<logDir>` 解析规则见 `§14`）。

### `JCEF Bridge: CefDownloadHandler.onBeforeDownload`
- **说明**：前端触发文件下载（如 CSV 导出、`.info` 离线同步包下载）时，JCEF 自动在 Swing EDT 线程弹出原生 `JFileChooser` 保存对话框，填入 `suggestedName` 并写入用户选定的本地路径。

### `JCEF Profile & Bundle Storage`（目录隔离与原生库缓存）
- **Profile 隔离（`<dataDir>/jcef_profile*`）**：`Main.resolveJcefProfileDir()` 优先尝试锁定持久化主目录 `<dataDir>/jcef_profile`（通过 Chromium `lockfile` + `.instance.lock`）；若主目录已被运行中实例占用（多开场景），依次探测 `<dataDir>/jcef_profile_2` .. `jcef_profile_10`；全部占用时回退至 `java.io.tmpdir/scoutingpro-jcef-<timestamp>`（窗口关闭时自动递归删除，持久化目录保留）。
- **原生二进制缓存**：`Main.ensureJcefBundle()` 固定使用 `~/.scoutingpro27/jcef-bundle`（不受 `--data-dir` 影响；Windows 防火墙放行规则 `ScoutingPro27 App JCEF` 指向其中的 `jcef_helper.exe`）。

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
- `resolveAppDbFile()` 与所有持久化资产统一落盘于 `resolveBaseDataDir()`（即 `<dataDir>`）之下，按以下优先级解析：

| 模式 / 条件 | `<dataDir>` 解析结果 | H2 数据库物理文件（`resolveAppDbFile()` + `.mv.db`） |
|---|---|---|
| **显式隔离目录**（`--data-dir` / `-Dscouting.data.dir` / `SCOUTING_DATA_DIR`） | `<explicitDir>`（自动剥离首尾匹配引号并创建目录） | `<explicitDir>/app_data.mv.db` |
| **`DEV` 默认**（命中 `Backend/pom.xml` 且无显式目录） | `<project_root>/app_data` | `<project_root>/app_data/app_data.mv.db` |
| **`PROD` 默认**（无 `Backend/pom.xml` 且无显式目录） | `~/.scoutingpro27` | `~/.scoutingpro27/app_data.mv.db` |

- **JDBC URL 解析（`resolveAppDbUrl()`）**：
  - 若环境变量 `DB_URL` 非空，直接返回该值（用于 E2E / 外部连接覆盖）。
  - 否则将 `resolveAppDbFile()` 路径中的 `\` 归一化为 `/`，默认构造 `jdbc:h2:<dbPath>;AUTO_SERVER=TRUE;LOCK_TIMEOUT=15000;AUTO_RECONNECT=TRUE`；若启用 `--no-auto-server` / `-Dscouting.noAutoServer=true` / `SCOUTING_NO_AUTO_SERVER=true`，则构造 `jdbc:h2:<dbPath>;AUTO_SERVER=FALSE;LOCK_TIMEOUT=15000`。
  - `AppConfig` 静态初始化块（及 `Main.initAndRun`）在未预设 `h2.bindAddress` 时强制设置为 `127.0.0.1`，防止 H2 `AUTO_SERVER` 绑定至 VPN/TUN 虚拟网卡阻塞本地进程通信。
- **`<dataDir>` 内标准子路径清单**：
  - `app_data.mv.db`（H2 数据库文件）、`jwt.secret`（HMAC-SHA256 密钥）、`master.key`（AES-256 主密钥）、`pit_photos/{eventId}/{key}.webp`、`jcef_profile`（及多开 `jcef_profile_2..10`）。

### `14.3 日志目录 <logDir> 与文件命名（AppConfig.resolveLogDir() / resolveLogFile()）`
- **解析优先级**：
  1. 若指定显式隔离目录（`--data-dir` / `-Dscouting.data.dir` / `SCOUTING_DATA_DIR`）→ `<explicitDir>/log/`
  2. 否则若 `AppConfig.findProjectRootDir() != null`（当前位于源码仓库内）→ `<project_root>/log/`（**注意**：直接按源码根目录判定，即使通过 `SCOUTING_ENV=prod` 切换环境但未指定 `--data-dir`，日志仍写入 `<project_root>/log/`）
  3. 否则 → `<dataDir>/log/`（`PROD` 模式下即 `~/.scoutingpro27/log/`）
- **单实例日志文件**：单次 JVM 运行缓存唯一文件 `<logDir>/scoutingpro_yyyy-MM-dd_HH-mm-ss[_N].log`（遇非空同名文件时自增 `_1`、`_2`），同步聚合后端 stdout/stderr、JCEF 前端控制台与 `POST /api/system/log` 远端日志。

### `14.4 CLI 启动参数与环境变量对照（Main.java / NetworkUtil.java / ApiRoutes.java）`

| 参数 / 变量 | 类型 | 作用与优先级说明 |
|---|---|---|
| `--data-dir=<path>` / `--data-dir <path>` | CLI 参数 | 在日志与数据库初始化前写入 `-Dscouting.data.dir`（自动剥离首尾匹配引号），覆盖 `<dataDir>` 与 `<logDir>`。 |
| `--no-auto-server` | CLI 参数 | 写入 `-Dscouting.noAutoServer=true`，禁用 H2 `AUTO_SERVER`。 |
| `--headless` | CLI 参数 | 设置 `java.awt.headless=true`，跳过 Swing Splash 与 JCEF 窗口仅运行 Javalin 服务（**不会**单独跳过 Windows 防火墙检测）。 |
| `--port=N` | CLI 参数 | 指定 HTTP/WS 监听端口，优先级高于 `DEV_PORT` 与默认 `8080`；绑定失败时按 `::` → `0.0.0.0` → `8081`（仅原目标为 `8080` 时）/`0` → `0` 回退。 |
| `--jcef-prewarm` | CLI 参数 | CI 专用，将当前平台 JCEF 原生库下载解压至 `./jcef-bundle` 后立即退出（退出码 `0` 或 `1`）。 |
| `DEV_PORT` | 环境变量 | 覆盖默认监听端口 `8080`（低于 `--port=N`）。 |
| `DB_URL` | 环境变量 | 直接覆盖 H2 JDBC URL（高于 `resolveAppDbFile()` 自动拼接）。 |
| `SCOUTING_DATA_DIR` / `-Dscouting.data.dir` | 环境变量 / JVM 属性 | 指定显式隔离数据目录 `<explicitDir>`（JVM 属性优先级高于环境变量）。 |
| `SCOUTING_NO_AUTO_SERVER` / `-Dscouting.noAutoServer` | 环境变量 / JVM 属性 | 设为 `"true"` 时禁用 H2 `AUTO_SERVER`。 |
| `SCOUTING_ENV` / `APP_ENV` / `-Dscouting.env` / `-Dapp.env` | 环境变量 / JVM 属性 | 显式覆盖运行环境（`DEV` / `PROD` / `TEST`）。 |
| `ENABLE_TEST_CLEANUP` / `-DENABLE_TEST_CLEANUP` | 环境变量 / JVM 属性 | 设为 `"true"` 时注册 `/api/test/cleanup` 与 `/api/test/shutdown`（并加入 `/api/test/shutdown` 免鉴权白名单），同时跳过 Windows 自动防火墙检测。 |
| `SKIP_FIREWALL_CHECK` / `-DSKIP_FIREWALL_CHECK` | 环境变量 / JVM 属性 | 设为 `"true"` 时跳过 Windows 启动防火墙检测与 UAC 提权弹窗（不注册测试接口）。 |
