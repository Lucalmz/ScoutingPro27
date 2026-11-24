# ScoutingPro27 测试与 E2E 脚本全量深度探查报告

> **整改状态**：本报告记录 2026-11-22 整改前审计快照；全部高优工程与测试清理项已落地（当前基线：后端 `39` 个测试类 / `199` 项单测、前端 `95` 个测试文件 / `811` 项单测、`4` 个核心 E2E 套件、`frontend/generators/` 已独立分离、CI 门禁已接入 `.github/workflows/ci.yml`，详情见根目录 [`README.md`](../README.md)）。  
> **探查日期**：2026-11-22  
> **探查范围**：全仓库 **175 个**测试与 E2E 脚本文件（共 **55,677 行**）：  
> - 后端 Java（`Backend/src/test/java/com/bear27570/app/**`）：**44 个文件 / 9,396 行**  
> - 前端 Vitest 单测（`frontend/src/__tests__/**`）：**106 个文件 / 31,242 行**  
> - 前端 E2E 脚本（`frontend/e2e/**`）：**25 个文件 / 15,039 行**  
> **审计原则**：只读审计，未修改任何业务或测试代码。

---

## 一、全局总览与工程级问题

**核心结论：存在明显的“治标不治本 / 假绿 / 水测试”现象，且 E2E 目录规范性严重失控。**  
核心业务测试底座（约 83 个文件）质量扎实，但在快速迭代修 Bug、视觉改版验收与手工验证过程中，堆积了大量一次性脚本、杂烩补丁测试和防御性过弱的“自证假绿”用例。

| 模块 | 总文件数 / 总行数 | 建议删除 | 独立归类目录 | 建议合并/拆散 | 建议重构 | 质量良好（保留） |
|---|---:|---:|---:|---:|---:|---:|
| 后端 Java (`Backend/src/test`) | 44 / 9,396 行 | **7** | 0 | **4** | **14** | **19** |
| 前端单测 (`frontend/src/__tests__`) | 106 / 31,242 行 | **6** | 0 | **14** | **22** | **64** |
| 前端 E2E (`frontend/e2e`) | 25 / 15,039 行 | **14** | **4** | *(已计入删除)* | **7** *(规范化)* | *(见重构列)* |
| **合计** | **175 / 55,677 行** | **27** | **4** | **18** | **43** | **83** |

### 工程级门禁与依赖问题
1. **CI 零测试门禁**：`.github/workflows/build-installer.yml`（L49、L68）均显式传 `-DskipTests`，`.github/workflows/deploy-pwa.yml` 也未执行 `npm test` 或 E2E。
2. **生产依赖污染**：`frontend/package.json`（L33）将测试依赖 `"puppeteer-core": "^25.5.0"` 写进了生产 `dependencies`，同时 `devDependencies`（L51）又安装了完整版 `"puppeteer": "^25.5.0"`。

---

## 二、后端 Java 测试全量审计（44 个文件）

### 2.1 治标不治本 / 假绿 / 水测试 / 反模式

#### (A) 假绿 / 条件跳过 / 自证 / 恒真断言
1. **`JcefBundlePreservationTest.java`**（40 行）：L14、L19 使用 `if (isWindows && targetDir.exists())` 包裹，在非 Windows 或干净 CI 机器上**静默跳过、零断言直接绿灯**；L23-27 反射调用私有方法 `Main.ensureJcefBundle()` 直接操作真实 `~/.scoutingpro27/jcef-bundle`；L32-36 存在 `if (jcefDll.exists()) { assertThat(jcefDll.exists()).isTrue(); }` 恒真水断言。
2. **`ui/FullWindowRoundedRenderTest.java`**（L70-96）：L76-84、L94-96 测试代码**自己创建** `RoundRectangle2D clipShape`，自己 `g2.setClip` + `g2.fill`，再断言 `image.getRGB(0, 0)` 的 `alpha == 0`。完全没测到 `frame.setShape(...)` 的真实窗口裁切效果；L89-91 `catch (Exception ignored) {}` 吞异常。
3. **`SignalingRoutesTest.java`**（22 行）：L12-21 仅执行 `Javalin.create`，断言 `app != null`、`getActiveRoomCount() == 0`。未启动服务、未建立任何 WebSocket 连接、未测 room join / SDP / ICE 转发 / disconnect 清理，属于纯粹“注册不崩”空壳测试。
4. **`util/NetworkUtilTest.java`**（L79-83, L149-152）：两处 `assertThat(bool).isIn(true, false)`（L81-82, L150-151）恒真断言，且运行期间触发真实宿主机防火墙查询命令。
5. **`AiEndToEndVerificationTest.java`**（L162, L181, L260-271）：声明 `AtomicBoolean mockLlmCancelled = new AtomicBoolean(false)` 并在 mock server 异常时 `set(true)`，但在 L260-271 取消流测试中 `asyncFuture.cancel(true); asyncIs.close(); Thread.sleep(100);` 后**从未读取或断言 `mockLlmCancelled`**，取消链路形同虚设。
6. **`FtcProxyRoutesTournamentLevelTest.java`**（L41-49, L68-94）：Mock server 忽略所有 query 参数直接返回 `{"matches":[]}`，测试只校验 3 个合法值返回 `200`，**既未断言上游收到的 `tournamentLevel` 参数是否被正确转发/标准化，也未断言非法值返回 `400`**。
7. **`util/FtcApiClientTest.java`**（L104-150 `testCacheAndIfModifiedSince304Support`）：mock server 写了 L124-127 的 304 分支，但测试中第 2 次请求立即命中内存缓存（`serverCallCount` 保持 1），**304 分支从未被触发**。

#### (B) 污染真实工作区 / 真实本地 DB / 残留文件
1. **`SimulateScoutingVerificationTest.java`**（L25-28）：**高危**——直接调用 `SimulateScouting.main(new String[]{"BIOBUZZ26"})` 而未隔离 `scouting.data.dir`，每次 `mvn test` **直接覆写工程根目录真实 `app_data.mv.db`**（且未调用 `JdbiConfig.closeDataSources()` 释放 H2 连接池）。
2. **`TimestampedFileLoggingTest.java`**（L34, L47, L72-73, L78, L104）：直接在工程真实 `log/` 目录创建 `scoutingpro_*.log`，清理代码写在方法末尾而非 `try/finally`，一旦断言失败将把垃圾日志永久遗留在工作区。
3. **`PitPhotoStorageTest.java`**（L50）& **`EventReparentingE2ETest.java`**（L50-51）：均未通过 `@TempDir` + `scouting.data.dir` 隔离，直接在真实工作区 `pit_photos/` 下读写图片。
4. **`JcefMultiInstanceProfileTest.java`**（L23-29）：反射调用 `Main.resolveJcefProfileDir()`、`releaseProfileLock`、`tryAcquireProfileLock`，直接读写/锁定真实用户目录 `~/.scoutingpro27`。
5. **4 个视觉渲染测试持续向临时目录写 PNG 且不清理**：`SplashScreenVisualRenderTest`（3 张）、`ui/FullWindowRoundedRenderTest`（1 张）、`ui/LogoHiDpiVisualRenderTest`（4 张）、`ui/TitleBarVisualRenderTest`（4 张，且 4 处 `catch (Exception ignored) {}` 吞异常）均往 `${java.io.tmpdir}/sp27-tests/` 写图。

#### (C) 单测中混入真实公网请求
1. **`ApiRoutesTest.java`**（L621 `testFtcMatchesProxyEndpoint` & L1335 `testFtcConfigRejectsNonExistentEventCodeBiobuzz26`）：`setUp()` 使用默认真实 `FtcApiClient`，导致 `mvn test` 时向公网 FTC API 发起真实 HTTP 请求。
2. **`SimulateScoutingVerificationTest.java`**（L54-59）：`new FtcApiClient().eventExists(2026, "BIOBUZZ26")` 直接请求公网，并用空 `catch (Exception e)` 静默吞掉网络异常。

#### (D) 过度反射 / 脆弱像素坐标 / 跨平台缺陷
1. **`ui/TitleBarVisualRenderTest.java`**（L178-185）：反射访问私有字段 `animTimer`、`hoverProgress`、`targetHover`（后两者 `setAccessible(true)` 后**完全未使用**）。
2. **4 个 Swing 测试缺少 headless 防护**：`SplashScreenVisualRenderTest`、`ui/CustomTitleBarDragTest`、`ui/FullWindowRoundedRenderTest`、`ui/TitleBarVisualRenderTest` 均无 `Assumptions.assumeFalse(GraphicsEnvironment.isHeadless())`，在无显示器的 Linux CI 环境会直接抛 `HeadlessException`。`SplashScreenVisualRenderTest` 还校验绝对像素坐标 `(20, 120)` 等，极度脆弱。
3. **硬编码工作区名 / Windows-only 断言**：`EnvironmentIsolationTest.java`（L37, L41, L45）硬编码 `.contains("ScoutingPro27")`；`PitPhotoStorageTest.java`（L152）在照片存储测试中硬编码断言 `contains("netsh advfirewall firewall add rule")`。
4. **`JdbiMapperTest.java`**（L25-27）：手写 `CREATE TABLE` 建表而非走 Flyway，与真实 Schema 存在漂移风险。

### 2.2 规范性问题
1. **4 个 `public static void main` 手工脚本混在 `src/test/java`（零 `@Test`）**：
   - `AiManualVerificationMain.java`（176 行）：硬编码端口 `18899`，仅 `System.out.println` 零断言，已被 `AiEndToEndVerificationTest` 100% 覆盖。
   - `LiveApiKeySmokeTest.java`（78 行）：**以 `*Test` 结尾却无 `@Test`**，读取真实本地 `app_data.mv.db`、解密真实用户 API Key 并发起真实 LLM 调用。
   - `LiveFtcApiVerificationMain.java`（100 行）：调公网 FTC API，零断言。
   - `TestConnectionVerificationMain.java`（109 行）：硬编码端口 `18898`，连真实本地 `app_data.mv.db` 并执行 `Flyway.migrate()`，还往真实库注册测试账号 `real_user_tester`。
2. **包目录归属混乱**：`routes/` 下只有 2 个测试，其余 7 个路由测试全堆在根包；`db/` 下只有 1 个测试，其余 7 个 DB/DAO 测试全在根包。
3. **测试内容错位与重复**：
   - `DaoTest.java` 内部 `testFutureTimeClampingAndTombstoneGC()`（L248-291）与 `testPurgeExpiredTombstones()`（L366-420）重复。
   - `ApiRoutesTest.java` 内部 `testTeamTagEndpoints`（L628-724）与 `testTeamTagCaseInsensitiveLifecycleAndPermissions`（L1430-1479）重叠；且与 `AiEndToEndVerificationTest`、`EventReparentingE2ETest` 存在用例重叠。
   - `PitPhotoStorageTest.java`（L128-162）混入无关的 `/api/system/network-info` 和 `/api/system/open-firewall-cmd` 测试（前者与 `NetworkUtilTest` L171-187 重复）。
   - `SimulateScoutingVerificationTest.java`（L384-393）与 `EnvironmentIsolationTest.java` 重复。

### 2.3 后端 44 个文件完整处置清单

- **删除（7 个）**：
  1. `AiManualVerificationMain.java`（176 行）— 已被 `AiEndToEndVerificationTest` 覆盖
  2. `TestConnectionVerificationMain.java`（109 行）— 污染真实 DB 的手工脚本
  3. `LiveApiKeySmokeTest.java`（78 行）— 伪装 `*Test` 的手工真实 Key 探针
  4. `LiveFtcApiVerificationMain.java`（100 行）— 零断言公网探针
  5. `JcefBundlePreservationTest.java`（40 行）— 环境依赖假绿 + 恒真断言 + 直触 `~/.scoutingpro27`
  6. `ui/LogoHiDpiVisualRenderTest.java`（124 行）— 一次性看图脚本，残留 PNG
  7. `ui/TitleBarVisualRenderTest.java`（197 行）— 脆弱像素亮度 + 私有字段反射 + 残留 PNG + 无 headless 防护
- **合并（4 个）**：
  1. `AppIconMultiResTest.java`（24 行）+ `MainLocalUrlTest.java`（20 行）→ 合并为 `MainTest.java`
  2. `FtcProxyRoutesTournamentLevelTest.java`（95 行）→ 并入 `FtcAdvancementRoutesTest.java`（重命名为 `FtcProxyRoutesTest.java`）并补齐上游参数与 400 校验
  3. `JdbiMapperTest.java`（64 行）→ 并入 Flyway 驱动的 `DaoTest.java`
- **重构（14 个）**：
  1. `SimulateScoutingVerificationTest.java`（394 行）：`@TempDir` 隔离 DB、`@AfterEach` 关数据源、删公网调用及空 catch、删重复的 L384
  2. `ApiRoutesTest.java`（1482 行）：L621/L1335 改本地 mock `HttpServer`、按领域拆分并去重
  3. `SignalingRoutesTest.java`（22 行）：补全真实 Javalin + WebSocket 客户端连接/转发/断连测试
  4. `TimestampedFileLoggingTest.java`（117 行）：`@TempDir` 隔离 + `try/finally` 清理
  5. `PitPhotoStorageTest.java`（294 行）：`@TempDir` 隔离；移出 L128-162 系统路由测试
  6. `EventReparentingE2ETest.java`（183 行）：`@TempDir` 隔离 `pit_photos`
  7. `JcefMultiInstanceProfileTest.java`（67 行）：使 profile 目录可注入（`@TempDir`），去反射
  8. `AiEndToEndVerificationTest.java`（543 行）：补齐 `mockLlmCancelled` 断言（用 `CountDownLatch` 替 `Thread.sleep`）、清 40+ 行 `System.err.println`、隔离 `master.key`
  9. `EnvironmentIsolationTest.java`（95 行）：去硬编码 `"ScoutingPro27"`
  10. `util/NetworkUtilTest.java`（314 行）：删 2 个恒真断言，移出 L171-187 路由测试
  11. `SplashScreenVisualRenderTest.java`（105 行）：去 `ImageIO.write` 和脆像素断言，加 headless 防护
  12. `ui/FullWindowRoundedRenderTest.java`（111 行）：删自画自测假像素测试，仅保留 L49-63 `Main.updateWindowShape` 并入 `MainTest`
  13. `ui/CustomTitleBarDragTest.java`（214 行）：加 headless 防护和 `try/finally { frame.dispose(); }`
  14. `DaoTest.java`（421 行）：合并重复的 Tombstone GC 测试
- **保留（19 个，质量扎实）**：`db/AppConfigIsolationTest.java`、`routes/CrdtRoutesTest.java`、`routes/EventTurnConfigRoutesTest.java`、`util/AdvancementCalculatorTest.java`、`util/AiClientTest.java`、`util/EcdsaRecordVerifierTest.java`、`util/PortForwardingServiceTest.java`、`util/FtcApiClientTest.java`（建议补齐 304 实际触发）、`util/AESUtilTest.java`、`CustomFieldsApiTest.java`、`EventDeleteRouteTest.java`、`EventMemberLifecycleTest.java`、`FtcAdvancementRoutesTest.java`、`H2HikariConcurrencyTest.java`、`PitScoutDaoTest.java`、`PitScoutingRecordSerializationTest.java`、`ScheduleDaoTest.java`、`UserDeterministicIdMigratorTest.java`、`UserMergeRouteTest.java`。

---

## 三、前端 E2E 脚本全量审计（25 个文件）

### 3.1 目录与脚本规范性
1. **4 个非测试生成器/演示脚本混入 `frontend/e2e/`**：
   - `capture-promo-screens.js`（637 行，宣传片截图，未接入 `package.json`）
   - `capture-userguide-screens.js`（1997 行，用户手册中英文截图，对应 `package.json:21` `capture:userguide`）
   - `export-userguide-pdf.js`（284 行，Markdown 转 PDF，对应 `package.json:22` `export:userguide-pdf`）
   - `demo-judges.js`（505 行，带 `readline` 交互暂停的评委现场演示脚本，未接入 `package.json`）
   - **建议**：在 `frontend/` 下单独新建文件夹（如 `frontend/generators/` 或 `frontend/tools/`）将这 4 个脚本分出来，并更新 `package.json` 路径。
2. **两套互不复用的基础设施 + 13 个孤立的 `pitwall` 文件**：
   - `pitwall-redesign.e2e.js` + `pitwall/*`（共 **13 个文件 / 6,300+ 行**）未接入任何 `package.json` 脚本或 CI，属于一次性“Pit Wall 视觉改版验收脚本”；自建了 `server.js`、`browser.js`、`test-utils.js`（与 `helpers/e2eBackendManager.js`、`e2eUiActions.js` 重复造轮子），含手写 PNG/ICO 二进制解码器（`png-ico.js` 482 行）、旧色号正则扫描（`css-audit.js` 841 行），甚至在前端 E2E 里 `spawnSync('mvn test')` 拉起 Java Swing 窗口测试（`backend-desktop.js` 166 行）。
3. **非标准运行器 + 命名混乱 + 硬编码端口**：
   - 25 个文件均为手写 Node + Puppeteer + `node:assert`（零 Playwright），不支持单用例过滤、失败自动 trace/截图、并行执行。
   - 命名混用 `.test.js`（`multi-client.test.js`）、`.e2e.js`（5 个）、`.js`（19 个）。
   - 端口全部硬编码（`7071~7089`），无法并行。

### 3.2 治标不治本 / 假绿 / 脆弱测试现象
1. **错误被清空或未断言（高危假绿）**：
   - `inbox-lifecycle.e2e.js:522-523`：最终断言前先调用 `manager.clearPageErrors([scoutPage])`，紧接着 `assertNoUnexpectedErrors([hostPage, scoutPage])`，把 Steps 8–11 期间 `scoutPage` 的报错直接抹平。
   - `comprehensive-interactive.e2e.js:751, 793-798`：`hostAPage` 跑完 Scenarios 1–7 后直接销毁，**全程从未调用 `assertNoUnexpectedErrors([hostAPage])`**；且 L794/797 放行正则 `/WebRTC|ICE|DataChannel|connection/i` 过宽；L476 计算了 `redSelected` 却从未断言。
   - `multi-client.test.js:539, 973, 1157, 1535`：Steps 4/6/7/10 结束时直接 `clearPageErrors` 而未先断言。
   - `qr-mobile-join.e2e.js:390`：放行正则 `/401|403|404|Invalid|Unauthorized|WakeLock|.../` 过宽。
2. **静默跳过（Silent Skip）与错误吞没**：
   - `motion-and-sheet.e2e.js:178`：`if (swerveBtn) swerveBtn.click()`（找不到按钮直接跳过）。
   - `qr-mobile-join.e2e.js:179`：`if (modalDetails.hasChannelPill)`（丢失控件直接跳过整段 LAN QR 校验）。
   - `helpers/e2eUiActions.js:16` / `pitwall/browser.js:137`：`waitForTransition` 默认 `.catch(() => {})` 吞掉超时。
3. **硬编码 `sleep` 替代状态等待**：`e2eUiActions.js:71`（`delay(900)`）、`motion-and-sheet.e2e.js`（`sleep(750)`）、`comprehensive-interactive.e2e.js`（大量 `sleep(300/600)`）、`inbox-lifecycle.e2e.js`（`delay(650/250)`）、`pitwall/tier1..3`（30+ 处 `delay`）。
4. **脆弱选择器**：除 Whiteboard（`data-testid`）外，95%+ 使用 `input[placeholder="1-999"]`、`btns[4]`、`tabs[1]`、`.nav-item-btn:last-child`、Material Icon 文本定位。
5. **绕过真实用户流 & 共享状态污染**：`pitwall/seed.js` & `test-utils.js` 直接调 API 灌数 + `localStorage.setItem` 伪造移动端登录态，173+ 用例共享同一 session；`multi-client.test.js` 多处通过 `window.__sp27E2eBridge` 直接写数据绕过 UI。

### 3.3 E2E 25 个文件完整处置清单

- **保留并规范化（4 个核心套件 + 3 个 helpers）**：
  1. `multi-client.test.js`（1710 行）：核心分布式 CRDT/灾备/安全套件；建议统一命名为 `.e2e.js`、修复 `clearPageErrors` 漏检、动态端口化。
  2. `comprehensive-interactive.e2e.js`（815 行）：核心交互套件；建议删去与 `multi-client` 重叠的 Scenario 8、补全 `hostAPage` 错误断言、消去 `sleep`、吸收 `motion-and-sheet` 中的 Esc/backdrop 关闭与 `prefers-reduced-motion` 用例。
  3. `qr-mobile-join.e2e.js`（424 行）：唯一覆盖 `jsQR` 解码与 5 步移动端向导；建议去掉 `if (hasChannelPill)` 静默跳过并收紧错误白名单。
  4. `inbox-lifecycle.e2e.js`（547 行）：Teleport 跨路由保活与多用户隔离；建议删除 L522 `clearPageErrors([scoutPage])`，精简与 `multi-client` Step 4 重复的离线私信段。
  5. `helpers/e2eBackendManager.js`（557 行）：保留并增加动态空闲端口分配。
  6. `helpers/e2eUiActions.js`（647 行）：保留，逐步迁移为 `data-testid` 选择器并移除 `delay(900)`。
  7. `helpers/localMqttBroker.js`（185 行）：设计干净，直接保留。
- **独立分出到新目录如 `frontend/generators/`（4 个）**：`capture-promo-screens.js`、`capture-userguide-screens.js`、`export-userguide-pdf.js`、`demo-judges.js`。
- **删除（14 个）**：
  - `pitwall-redesign.e2e.js` + `pitwall/*` 全部 **13 个文件**（`backend-desktop.js`、`browser.js`、`cli.js`、`css-audit.js`、`png-ico.js`、`seed.js`、`server.js`、`test-utils.js`、`tier1-features.js`、`tier2-boundaries.js`、`tier3-combinations.js`、`tier4-scenarios.js`）。
  - `motion-and-sheet.e2e.js`（有价值的 2 个交互用例合入 `comprehensive-interactive.e2e.js` 后删除）。

---

## 四、前端 Vitest 单测全量审计（106 个文件）

### 4.1 治标不治本 / 假绿 / 水测试问题（附精确证据）

1. **零生产代码导入 / 测试自己重写逻辑（100% 假绿）**：
   - `customFields.downstream.test.ts`（L1-157）：仅 `import type`，测试内自写 3 个本地函数自测自绿，删光 `src/` 依然 100% 通过。
   - `scout-storage-lifecycle.test.ts`（L69-101）：测试内现写 `handleClientConnected` 函数和本地 `Set` 自测。
   - `network-sync-fixes.test.ts`（L270-306）：把 `callbacks.onPitScoutAckReceived` 自己 mock 成调用 `pitStore.markSynced`，实质测自己的回调。
2. **前提未激活 / 空心断言 / Teleport 假绿**：
   - `webrtc-hard-reset.test.ts`（L101-117）：测 `reconnectNow` 把 `clientForceRelay` 从 `true` 重置为 `false`，但从未设为 `true`。
   - `webrtc.test.ts`（L477-490）：`disconnect` 清理测试在零 peer 连接下调用，未验证任何 peer/map 清理。
   - `concurrency-takeover-edge.test.ts`（L587-618）：4 次 `reconnectNow()` 断言构造次数在 `[+0, +4]` 之间，无论是否节流必绿。
   - `ImagePreviewModal.test.ts`（L6-14）：`<Teleport to="body">` 组件却用 `wrapper.find(...)` 做 `exists() === false` 负向断言。
   - `inboxThemeAndMorphStress.test.ts`（L68-112, L164-200）：自己 `setProperty('--card', '#141413')` 再断言 `getPropertyValue`；脱离 `App.vue` 单独挂载 `InboxWidget` 假测路由切换不销毁。
   - `multi-device-coexistence.test.ts`（L144）：双端组播断言用 `hasMsg1 || hasMsg2`（OR），发件方自己满足即绿，且两用例与 `webrtc.test.ts:690-805` 完全重复。
3. **源码正则匹配代替行为测试**：
   - `mobile-responsive.test.ts`（L38-52）、`ScoutingForm.test.ts`（L378-382）、`AiMessageItem.test.ts`（L30-34）。
4. **零业务代码、纯测第三方库**：
   - `tinybaseSmoke.test.ts`（179 行，零 `src/` 导入）。
5. **只测装饰性样式 / 私有 `vm` 钩子 / 绕过 DOM**：
   - `ScheduleManager.test.ts`（L39-158）：全部 3 个用例仅测 `.hover-highlight` inline style 和私调 `vm.beforeEnter/enter`，对排班业务零覆盖。
   - `DashboardView.test.ts`（L242-288）、`HistoryList.test.ts`（L214-260）、`rankings-detail-navigation.test.ts`（L492-537）：同样私调 `vm.beforeEnter/enter`。
   - `draftRapidKeystrokeStress.test.ts` & `ScoutingForm.test.ts`：大量直接修改 `wrapper.vm.*` 绕过真实 DOM 交互。
6. **伪造数据结构**：
   - `webrtcConcurrencyStress.test.ts`（L242-313 `Stress 4`）：构造不匹配真实 `ScoutingRecord` 接口的假字段；`Stress 2`（L128-129）在 100 次循环中用 `Math.random()` sleep。

### 4.2 规范性与结构问题
1. **全局状态 / 定时器 / DOM 泄漏（15+ 文件）**：
   - 未还原 `global.RTCPeerConnection` / `__TEST_*` / `global.fetch` / `navigator.mediaDevices` / `navigator.clipboard` / `document.visibilityState` / `i18n.global.locale` / `localStorage`：`handshakeProtection.test.ts`、`host-mutex-standby.test.ts`、`alias-flow.test.ts`、`epochFencing.test.ts`、`api.test.ts`、`events.store.test.ts`、`errorHelper.test.ts`、`multi-device-coexistence.test.ts`、`webrtc.test.ts`、`QrScannerModal.test.ts`、`presets.test.ts`、`wakeLock.test.ts`、`selfHealing.test.ts`、`haptics.test.ts`。
   - `vi.useFakeTimers()` 未包 `try/finally`：`ScoutingForm.test.ts`、`SasVerificationModal.test.ts`、`rankings-detail-navigation.test.ts`、`ScheduleManager.test.ts`、`TacticalWhiteboard.test.ts`。
   - Teleport / `window` 监听未 `unmount()`：`ConfirmModal.test.ts`、`MobileQrModal.test.ts`、`MobileBottomNav.test.ts`、`PitScoutFormDrawer.test.ts`、`TakeoverPromptModal.test.ts`、`useIsMobile.test.ts`。
2. **100+ 处真实 `setTimeout` sleep**：`webrtc.test.ts`（48 处）、`DashboardView.test.ts`（22 处）、`PitScoutFormDrawer.test.ts`（12 处）、`host-mutex-standby`（8 处）、`host-takeover-fullsync`（8 处）、`concurrency-takeover-edge`（8 处）、`LoginView`（7 处）等。
3. **杂烩补丁堆砌文件 & 伪 E2E**：
   - `account-conflict-fixes.test.ts`（603 行，塞了 6 个无关模块）、`network-sync-fixes.test.ts`（441 行，按 Bug 1..5 堆砌）、`rankings-detail-navigation.test.ts`（684 行，塞了 5 个无关目标还复制了 `RenameModal.test.ts`）、`toast-and-error.test.ts`（48 行，2 个无关模块）、`rankings-advancement-e2e.test.ts`（单测目录里的伪 E2E）。
4. **命名风格 4 种混用**：`PascalCase` / `camelCase` / `kebab-case` / `*.store.test.ts` 并存。

### 4.3 前端单测 106 个文件完整处置清单

- **删除（6 个）**：
  1. `customFields.downstream.test.ts`（零生产代码导入，自写自测）
  2. `inboxThemeAndMorphStress.test.ts`（恒真 CSS 变量 + 假路由 + 无意义 100 次 toggle）
  3. `mobile-responsive.test.ts`（源码正则 + 重复 + 静态 class）
  4. `tinybaseSmoke.test.ts`（零项目代码导入，纯测第三方库）
  5. `team-detail.test.ts`（未导入 TeamDetail 组件，100% 重复）
  6. `multi-device-coexistence.test.ts`（100% 重复 `webrtc.test.ts` + OR 假绿 + 泄漏全局状态）
- **合并 / 拆散归位（14 个）**：
  - `account-conflict-fixes.test.ts` → 拆回 `ScoutingForm`、`schedule.store`、`selfHealing`、`webrtcSubmodules` 等
  - `network-sync-fixes.test.ts` → 拆回 `crdtStoreBridge`、各 store、`webrtcSubmodules`、`photoStorage`、`OfflineSyncModal`
  - `rankings-detail-navigation.test.ts` → 删重复 `RenameModal` 用例，拆回 `RankingsTable`、`useEventWebRtcBridge`、`TeamDetailComponents`
  - `rankings-advancement-e2e.test.ts` → 拆分并入 `RankingsTable.test.ts`
  - `toast-and-error.test.ts` → 拆入 `errorHelper.test.ts` 与 `toast.store.test.ts`
  - `scouting-form-counter.test.ts` & `draftRapidKeystrokeStress.test.ts` → 合并进 `ScoutingForm.test.ts`
  - `scouting-workflow.test.ts` → 精简重复后归位各 store 测试
  - `user-merge.test.ts` → 合并进 `user.store.test.ts`
  - `indexedDb.test.ts` → 合并进 `photoStorage.test.ts`
  - `desktopShell.test.ts` → 合并进 `DashboardView.test.ts`
  - `host-mutex-standby.test.ts`、`handshakeProtection.test.ts`、`webrtcConcurrencyStress.test.ts` → 清理假数据与 `Math.random()` 后归入规整后的 WebRTC 分模块套件
- **重构（22 个）**：
  - `concurrency-takeover-edge.test.ts`、`ftcApi.test.ts`、`ImagePreviewModal.test.ts`、`AiMessageItem.test.ts`、`ConfirmModal.test.ts`、`DashboardView.test.ts`、`LoginView.test.ts`、`MobileQrModal.test.ts`、`events.store.test.ts`、`alias-flow.test.ts`、`ScoutingForm.test.ts`、`scout-storage-lifecycle.test.ts`、`ScheduleManager.test.ts`、`webrtc-hard-reset.test.ts`、`webrtc.test.ts`、`webrtcDrain.test.ts`、`PitScoutFormDrawer.test.ts`、`QrScannerModal.test.ts`、`signaling.test.ts`、`nicIpv6Direct.test.ts`、`vpnTurnFallback.test.ts`、`TacticalWhiteboard.test.ts`。
- **保留（64 个，部分需顺手补 `afterEach` / `unmount()`）**：
  - 前半 34 个：`AiSettingsModal`、`ConnectionStatus`、`CustomFieldsManagerModal`、`DynamicFieldsRenderer`、`EventScoutsPanel`、`HistoryList`、`MobileBottomNav`、`MobilePhaseWizardForm`、`MobileStatusPill`、`auth-guard`、`inbox-isolation`、`aiStore.copilot`、`customFields.store`、`inbox`、`accountSwitchIsolation`、`calibratedClock`、`crdtFieldMerge`、`crdtRecordSigning`、`crdtStoreBridge`、`crypto`、`customTurnConfig`、`dataChannelSender`、`epochFencing`、`host-takeover-fullsync`、`identityStore`、`advancement`、`api`、`audit`、`bragIndex`、`contextBuilder`、`errorHelper`、`haptics`、`json`、`markdown`。
  - 后半 30 个：`navigation.store`、`offlineSync`、`OfflineSyncModal`、`PhaseCycleTracker`、`photoStorage`、`PitStatusIndicator`、`predictCycleTime`、`rankings.analytics`、`records.store`、`RenameModal`、`SendMessageModal`、`SessionConflictModal`、`scoutAllianceHalo`、`TagPicker`、`TeamDetailComponents`、`teamMatcher`、`tournament`、`useBumpAnimation`、`user.store`、`userId`、`webrtcSubmodules`、`photoChunking`、`pitScout.store`、`presets`、`SasVerificationModal`、`schedule.store`、`selfHealing`、`TakeoverPromptModal`、`useIsMobile`、`wakeLock`。

---

## 五、分阶段整改路线建议

1. **P0（立即止血，收益最大、风险最低）**：
   - 删除 27 个无效/假绿/一次性文件；将 4 个生成器/演示脚本独立分出到 `frontend/generators/`（或 `frontend/tools/`）；将 `puppeteer-core` 从 `dependencies` 移除。
   - 修复后端 `SimulateScoutingVerificationTest` 覆写本地真实 `app_data.mv.db` 及 `ApiRoutesTest` L621/L1335 直连公网问题。
   - 修复 E2E 的 `inbox-lifecycle.e2e.js:522`、`comprehensive-interactive.e2e.js:751`、`multi-client.test.js` 漏检报错问题。
2. **P1（消除假绿与脆弱性）**：
   - 修复 `webrtc-hard-reset`、`concurrency-takeover-edge`、`ImagePreviewModal`、`SignalingRoutesTest`、`NetworkUtilTest`、`AiEndToEndVerificationTest`、`ScheduleManager` 等假绿/空壳用例。
   - 为后端文件存储/日志测试补齐 `@TempDir` 隔离，为 Swing 测试加 headless 防护；为前端 15+ 个泄漏全局状态/fakeTimers/Teleport 的单测补齐 `afterEach` 与 `try/finally`。
3. **P2（长期可维护性与 CI 门禁）**：
   - 拆分 `webrtc.test.ts`、`vpnTurnFallback.test.ts`、`ApiRoutesTest.java` 三个巨型文件，用 `flushPromises()` / `vi.waitFor()` 逐步替换 100+ 处 `setTimeout`。
   - 保留的 4 个核心 E2E 套件逐步统一 `data-testid` 选择器与动态端口分配，并在 GitHub Actions 中开启前后端单测门禁。
