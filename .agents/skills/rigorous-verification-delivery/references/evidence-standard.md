# 证据三要素规范 (Evidence Specification Standard)

在任何技术沟通、Bug 修复确认、阶段交付中，只要下达**"已完成"、"已修复"、"已测试"、"功能正常"**等确定性结论，必须遵循本规范。

---

## 1. 证据三要素定义

每一次结论输出，必须包含以下三个结构化要素，缺一不可：

```markdown
### 验证证据

**1. 执行命令 (Execution Command)**
```bash
# 真实的完整命令（包括工作目录与参数）
mvn test -Dtest=ConfigServiceTest
```

**2. 原始输出 (Raw Output / Logs / Payload)**
```text
[INFO] Running com.scoutingpro.service.ConfigServiceTest
[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 1.234 s - in com.scoutingpro.service.ConfigServiceTest
[DEBUG] Saved config to path: C:\AppData\Local\ScoutingPro\config.json with CRC32=a1b2c3d4
```

**3. 客观结论 (Objective Conclusion)**
- 配置文件已成功写入指定路径，校验和一致，读写单测 3/3 全部通过。
```

---

## 2. 严禁的反模式 (Anti-Patterns)

| 严禁的反模式 | 为什么禁止 | 正确做法 |
| :--- | :--- | :--- |
| **"我看了代码，逻辑没问题，已修复"** | 静态推断常忽略运行时环境、类型转换、空指针、并发问题。 | 实际运行复现用例，贴出修复前失败、修复后成功的日志。 |
| **"单元测试全绿，功能已搞定"** | 单测常有 Mock，可能未验证真实 DB/网络/文件系统链路。 | 触发真实入口（API/CLI/交互），验证数据落盘或状态改变。 |
| **手工篡改或美化输出日志** | 破坏真实性，隐藏隐蔽警告或副作用。 | 原样复制终端/响应体输出（截取核心关键段落，保留真实报错或耗时）。 |
| **"应该可以了，你试一下吧"** | 将 Agent 自身的验证责任转嫁给用户。 | 自己先跑通并提供证据；如果确实无法在当前环境跑，走"诚实边界披露"。 |

---

## 3. 常见场景的证据获取方式

### 场景 A: 后端接口/控制器已修复
- **执行**：使用 `curl` / `Invoke-RestMethod` 或内建测试发送真实请求。
- **证据**：真实的 HTTP 状态码（如 200 OK）与响应 JSON 数据体 + 后端控制台输出的真实处理日志。

### 场景 B: 数据库写入/更新功能
- **执行**：执行插入/更新操作，随后执行一次真实的查询命令（SQL 或服务查询）。
- **证据**：查询返回的真实记录数据，证明数据已持久化。

### 场景 C: 构建与编译
- **执行**：`mvn clean compile` / `npm run build`。
- **证据**：带有 `BUILD SUCCESS` / `vite v... built in ...ms` 的真实构建输出。
