# 数据库迁移 (Flyway) 安全检查规范 (Flyway Migration Safety)

数据库迁移文件具有**不可变性**和**严格版本递增性**。一旦迁移文件被应用，任何版本冲突、命名错误或内容修改都会导致校验和失败（`Validate failed: Migration checksum mismatch`）或迁移中断。

---

## 1. 核心铁律：前置版本扫描 (Pre-flight Version Check)

在创建**任何新的迁移文件**之前，**必须**先执行版本排查，严禁直接凭记忆或盲猜编号命名。

### 检查步骤：
1. **扫描所有已有迁移脚本**（包括 SQL 迁移与 Java 迁移）。
2. **提取当前最大版本号**（例如当前已有 `V1__init.sql`、`V2__add_events.sql`、`V2_1__add_indexes.sql`）。
3. **确定新版本号**：新版本号必须严格大于当前已有最大版本号（如 `V3__...` 或 `V2_2__...`）。
4. **检查命名规范**：
   - 必须以大写 `V` 开头。
   - 版本号后必须紧跟**两个下划线** `__`。
   - 描述部分单词使用单下划线或驼峰分隔（例如 `V3__create_matches_table.sql`）。

---

## 2. 自动化排查命令

在创建新文件前，可在终端中直接运行以下 PowerShell 命令快速查看当前所有版本：

```powershell
# 查找项目中所有 Flyway 迁移脚本并按名称排序
Get-ChildItem -Path . -Recurse -Include "V*__*.sql", "V*__*.java" | 
    Select-Object Name, FullName | 
    Sort-Object Name
```

也可直接调用配套脚本：
```powershell
powershell -ExecutionPolicy Bypass -File .agents/skills/rigorous-verification-delivery/scripts/check-flyway-versions.ps1
```

---

## 3. Flyway 迁移编写三原则

### 原则 1：DDL / DML 幂等与容错
- 在适用场景下使用 `IF NOT EXISTS` / `IF EXISTS`（视具体数据库方言如 SQLite/H2/PostgreSQL 而定）。
- 保证迁移失败时支持事务回滚（避免留下半初始化状态的表结构）。

### 原则 2：严禁修改已发布的旧迁移文件
- 已经合并或在任何环境运行过的 `V...` 迁移文件，**绝对不能**修改内容或重命名。
- 若需要修改已有表结构或修复数据，**必须**创建新的更高版本迁移脚本（例如 `V4__fix_column_type.sql`）。

### 原则 3：本地迁移验证
- 编写完成后，在本地运行一次完整的迁移流程（`mvn flyway:migrate` 或启动 Spring Boot / 嵌入式 DB），贴出真实的成功日志：
```text
[INFO] Current version of schema "PUBLIC": 2
[INFO] Migrating schema "PUBLIC" to version 3 - create matches table
[INFO] Successfully applied 1 migration to schema "PUBLIC" (execution time 00:00.045s)
```
