# 全链路自测与用户视角模拟指南 (Full-Link & E2E Verification)

"代码写好了，单测也跑过了" 绝不等于 "功能已可用"。开发的核心目标是交付真实可用的用户价值。

---

## 1. 单元测试 vs 全链路测试的本质区别

```
[单元测试 (Unit Test)]
   Mock Controller -> Mock Service -> Mock Repo -> Mock DB
   ❌ 无法验证：真实 HTTP 序列化、参数校验、数据库真实约束、文件锁、网络通信、前端状态管理

[全链路测试 (Full-Link Verification)]
   用户触发 (UI / API Request) -> 路由/分发 -> 业务逻辑 -> 真实存储/外设 -> 状态响应 -> 界面/结果回显
   ✅ 验证真实可用性：打通从入口到落盘的每一个环节
```

---

## 2. 真实用户视角自测的标准步骤 (The 4-Step User Simulation)

在声称阶段完成或交付前，必须按照用户操作行为自测：

### 步骤 1：准备输入 (Prepare Payload & Form)
- 准备真实、合规的业务参数（不要只用 `test`, `123` 等可能避开边界校验的敷衍数据）。

### 步骤 2：触发操作 (Trigger Action)
- **API / 服务层**：通过真实 HTTP Client (`curl`, `Invoke-RestMethod`, Postman 脚本) 或 集成测试 发起请求。
- **UI / 前端层**：如果有集成测试或自动化脚本，执行真实事件触发；若只能通过浏览器验证且无法自动完成，走"诚实边界披露"，明确给出手动验证 Checklist。
- **文件 / 本地系统**：真实调用应用逻辑创建/读取文件。

### 步骤 3：验证持久化与下游影响 (Verify Side-Effects)
- 不只看返回值是否 200，还要查库/查文件系统：
  - 数据库中是否有新增/更新的行？
  - 配置文件中是否生成了正确的键值对？
  - 缓存中数据是否刷新？
  - 消息/信令是否成功广播到了订阅端？

### 步骤 4：验证异常流与边界 (Boundary & Error Flow)
- 输入空值、重复值、超长字符串、非法字符，确认系统是否能友好拦截且返回预期错误提示，而不是直接抛出 500 / 崩溃。

---

## 3. 常见功能全链路自测实战示例

### 案例 1：配置保存功能
```powershell
# 1. 模拟用户提交保存配置请求
$body = '{"theme":"dark","autoSync":true,"syncIntervalSeconds":30}'
$response = Invoke-RestMethod -Uri "http://localhost:8080/api/config" -Method POST -Body $body -ContentType "application/json"

# 2. 验证响应状态与内容
$response | ConvertTo-Json

# 3. 验证本地文件是否真实持久化且内容正确
Get-Content "app_data/config.json"
```

### 案例 2：WebRTC / MQTT 信令连接
```powershell
# 1. 启动服务
# 2. 发起连接并观察日志
# 3. 确认握手完成日志与状态切换证据（输出原始日志片段）
```
