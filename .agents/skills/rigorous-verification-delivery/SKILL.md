---
name: rigorous-verification-delivery
description: Enforces strict, evidence-based verification and phase delivery standards. Activates whenever implementing features, declaring completion, performing tests, handling database migrations (Flyway), resolving compilation/build errors, modifying platform-specific code (Windows ACL/file permissions), or delivering work to the user. Prohibits unverified claims, requires real command output and full-link proof, mandates root-cause investigation for build errors (90% of small compilation errors mask major bugs), mandates explicit disclosure of untested parts, and ensures end-to-end user flow simulation before handover.
---

# Rigorous Verification & Delivery Protocol (严谨验证与交付工作流)

本 Skill 定义了 Antigravity 在功能开发、编译修复、平台适配、数据迁移、测试验证与阶段交付时的**铁律准则**。旨在杜绝"口头完成"、"空口断言"、"敷衍式消除编译报错"、"逻辑推测代替真实运行"等顽疾，确保每一次交付都具备可复现、有据可查的真实证据链。

---

## 核心准则与六大铁律 (The 6 Golden Rules)

任何声称"已完成"、"已测试"、"已修复"或交付阶段成果的交互，必须无条件遵循以下六大铁律：

### 1. 证据三要素闭环 (No Evidence, No Claim)
- **绝对禁止空口下结论**：不得使用"代码逻辑上应该没问题"、"按规范实现已完成"等主观推断作为完成标志。
- **证据三要素必须完整呈现**：
  1. **实际执行的命令**（精确的 CLI / HTTP / 脚本指令）。
  2. **完整的原始输出**（终端真实 stdout/stderr、HTTP 响应体、日志片段，严禁臆造或手工总结改写）。
  3. **基于输出的客观结论**。
- **单元测试通过 ≠ 功能可用**：单测仅验证局部函数逻辑，**绝不能**替代端到端（从入口触发 -> 业务处理 -> 持久化/响应）的完整链路验证。关键用户操作（保存配置、发送消息、测试连接、导出数据等）必须真实触发并以数据/日志证明链路打通。

### 2. 编译报错深挖根因，严禁头痛医头 (Compilation Errors Mask Major Bugs)
- **小编译错误 90% 潜藏着大 Bug**：编译报错（类型不匹配、方法签名变动、参数缺失、未捕获异常、泛型不一致等）往往是冰山一角，是底层契约不一致、架构调整不完整或上游业务语义破坏的外在表征。
- **严禁"为了让编译器闭嘴而打补丁"**：绝对禁止通过盲目强转类型、塞默认值/Dummy 参数、随意更改方法返回值、增加 `@SuppressWarnings` 或草率修改单行语法来消灭编译错误。
- **必须执行全调用链盘查**：
  1. **溯源**：这个编译错误为什么发生？是谁改动了上游接口或底层数据结构？改动的完整业务语义是什么？
  2. **广度扫描**：同类型的调用方、关联类、前后端协议、序列化/反序列化逻辑是否同样存在潜在不一致？
  3. **深度验证**：修复后必须重新审视整条业务逻辑链，确认没有破坏原有的业务不变量与边缘逻辑。

### 3. 诚实边界披露 (Explicit Disclosure of Gaps)
- **做不到/没条件验证必须直说"没做"**：凡是缺少工具、缺乏交互权限（如需用户物理点击外部硬件、特定云端后台配置等）的环节，必须明确标注：`【未验证项】这一步无法在当前环境自动完成，需要人工验证：...`。
- **严禁掩盖断点**：不得用看似完美的阶段总结将未验证的技术缺口含糊掩盖。

### 4. 平台行为真实运行验证 (Real-world OS & ACL Verification)
- **涉及 Windows 特性（ACL、文件权限、专有路径、注册表等）必须真实运行**：
  - 严禁凭标准库 API 规范想象实际行为。
  - 权限类代码（如 ACL 继承、文件只读/独占锁）写完后，必须**实际生成测试文件并执行真实读写操作**，彻底验证未发生"所有者被自己反锁"、"权限缺失导致主进程崩溃"等反噬问题。

### 5. 数据库迁移版本前置排查 (Flyway Pre-flight Check)
- **写迁移脚本前必须先扫描现有版本号**：
  - 严禁等执行报错后再回头修改版本号或文件名。
  - 迁移文件一旦执行过，修改文件名或内容会导致 Checksum 不一致引发灾难。
  - 新增 `V...__xxx.sql` 或 Java Migration 前，必须先检索已有版本最大编号与命名规范，确保序号递增且无冲突。

### 6. 交付前用户行为全链路自测 (End-to-End User Simulation)
- **交付前必须以真实用户视角自走完整流程**：
  - 交付一个阶段前，不是看单测绿灯，不是静态走查代码，而是**模拟真实用户行为**：填写参数/表单 -> 触发操作/点击 -> 校验持久化结果与界面反馈。
  - 确认整条链路完整无断点后，方可提交用户验收。

---

## 快速导航与子规范 (Detailed References)

根据当前处理的任务类型，**必须**查阅并执行对应的子规范：

1. **[证据三要素格式与规范](references/evidence-standard.md)**: 规范日志输出、命令记录与交付格式。
2. **[编译错误根因盘查指南](references/compilation-error-root-cause.md)**: 编译报错深挖根因、防敷衍与全调用链扫描指引。
3. **[Windows 平台特性与 ACL 权限验证指南](references/windows-acl-safety.md)**: Windows 文件锁、ACL 权限、防自锁验证脚本与避坑指引。
4. **[数据库迁移 (Flyway) 安全检查规范](references/flyway-migration-guide.md)**: 迁移版本冲突排查、幂等性与校验和保护机制。
5. **[全链路自测与用户视角模拟指南](references/full-link-testing.md)**: 接口级与业务流级的全链路触发实操方法。
6. **[交付自检清单与违规熔断机制](references/delivery-protocol.md)**: 阶段交付前的 6 点强制自检与违规停机处理。

---

## 违规响应协议 (Violation Protocol)

> **触发机制**：若用户指出违反了第 1~6 条中的任意一项：
> 1. **立即停止**推进新任务或后续阶段。
> 2. **明确承认**违规点（例如："我刚才在未提供实际执行日志的情况下得出了测试通过的结论，违反了第 1 条" 或 "我刚才只是草率消除了编译报错而未深挖根因，违反了第 2 条"）。
> 3. **现场执行**真实的排查与验证命令，补全完整的原始输出与日志证据。
> 4. **重新走查**该阶段是否遗留其他未验证盲区。
