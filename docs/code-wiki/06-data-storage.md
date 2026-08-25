# 06 · 数据层与存储

> 覆盖：`src/main/infra/storage/`（SQLite + Drizzle、SessionService、keychain、偏好持久化）。

## 1. 存储体系总览

| 组件 | 落盘位置 | 用途 |
|---|---|---|
| SQLite（better-sqlite3 + Drizzle） | userData `sessions.db` | 会话/消息/Prompt/token 用量/回合/运行时模型/技能/设置/任务/目标/定时任务 |
| keychain（safeStorage） | userData `keychain.dat` | API Key 等机密加密存储 |
| 偏好 JSON | userData `approval-pref.json` / `telemetry-pref.json` / `whitelist.json` / `window-state.json` | 审批模式、遥测级别、命令白名单、窗口状态 |
| app-data | userData `logs/backups/cache/...` | 目录路径统一封装 |

> 记忆功能已整体替换为 TencentDB-Agent-Memory（MemoryHubService sidecar），**不再有自研 memories 表**。见记忆模块文档。

## 2. SQLite 生命周期（`db.ts`）

- `initDb()`：建 `sessions.db`、启用 WAL + 外键约束 + busy_timeout + quick_check 完整性校验 + 异步热备份（保留 3 份轮转）→ 执行 **drizzle 迁移**（`migrate()`，见第 7 节）。
- `getDb()`：动态获取连接（服务不直接持有）。
- `closeDb()` / `resetDb()`：关闭/重置连接（测试用）。
- **铁律**：db 必须 `initDb`（启动）后首次访问，`closeDb` 在 dispose 最后调用（SessionService 在 closeDb 之前清理）。

## 3. 表结构（唯一真源 `schema.ts`）

`schema.ts` 是**全库唯一真源**（11 张表 + 约束），DDL/迁移由 Drizzle Kit 自动派生：

| 表 | 关键字段 | 领域约束 |
|---|---|---|
| `sessions` | id, title, created_at, updated_at, last_message, message_count, working_dir, last_run_status(idle/running/interrupted), pinned | last_run_status CHECK（0002 触发器实现） |
| `messages` | id, session_id(FK CASCADE), turn_id, seq, role, content(JSON), created_at | role CHECK |
| `prompts` | id, name, description, role, content, is_default | — |
| `token_usage` | session_id, model_id, input/output/total_tokens, cache_read, reasoning, created_at | — |
| `turns` | turn_id, session_id, seq, model_id, status, tokens, duration_ms | turn_id UNIQUE |
| `runtime_models` | model_id, provider_kind, base_url, display_name, is_enabled | is_enabled CHECK(0/1) |
| `skills` | name, description, prompt, source('learned') | source CHECK |
| `app_settings` | key, value(JSON) | — |
| `cron_tasks` | id, session_id, expression, description, next_fire_at, enabled | enabled CHECK(0/1)；session_id **无外键**（可关联子代理内部回合 id，与 tasks 同决策） |
| `tasks` | id, session_id, kind, description, status, start/end_time | — |
| `goals` | id, session_id, condition, status, iterations, last_reason | — |

索引：`sessions(updated_at)`、`messages(session_id,seq)`、`messages(turn_id)`、`prompts(role)`、`token_usage(created_at)`、`turns(session_id,seq)`、`goals(session_id)` + 唯一索引 `turns(turn_id)`。

**约束策略**：稳定枚举 → DB CHECK/触发器；演进枚举（`goals.status`、`tasks.status/kind`）→ `$type<T>()` 应用层约束（SQLite 改 CHECK 需重建表，代价高）。枚举类型定义在 `schema.ts`，ai 层从 `storage/schema` 导入，勿重复定义。

## 4. SessionService（`session-service.ts`）

- **IPC 暴露组**（request-response）：`list / get / delete / rename / pin / create / listRecentDirs / exportAll / getUsageSummary / getTurns / getRecentTurns / getTurnMessages / compact`。
- **内部 API 组**（直接调用）：`create`（主进程创建会话）、`appendMessage`（写消息）、`replaceMessages`（编辑/压缩后替换）。
- 核心职责：
  - `sessions/messages` CRUD，消息 `JSON.stringify` 序列化到 `content`，读取反序列化为 `unknown[]`（不向 shared 泄漏 AI SDK 类型）。
  - 崩溃恢复：`markAllInterrupted()` 把残留 running 会话标 `interrupted`。
  - token 用量与回合（`turns`）记录；`/compact` 上下文压缩后用 `replaceMessages` 替换历史。
  - **原子性**：create/appendMessage/replaceMessages 全走 `db.transaction`，`message_count` 冗余字段同事务维护（不漂移）；JSON 序列化在事务外完成缩短写锁。
- 不持有 db 连接（`getDb()` 动态获取）。

## 5. keychain（`keychain.ts`）

- 使用 Electron `safeStorage` 加密读写 `keychain.dat`，存放不同供应商的 API Key。互斥锁防并发读写丢更新。
- `setApiKey(provider, key)` / `getApiKey(provider)` / `deleteApiKey(provider)`。
- **损坏防护**：读失败（JSON 解析失败）记日志 + 保留 `.corrupt` 副本，不静默丢失全部密钥。

## 6. 偏好持久化（`*_pref.ts`）

| 文件 | 内容 |
|---|---|
| `settings-pref.ts` | 渲染层设置下沉 SQLite `app_settings` 表（key-value JSON） |
| `approval-pref.ts` | 审批模式（`ask|auto|deny`），启动时同步读入 PermissionService |
| `telemetry-pref.ts` | 遥测级别（`off|error-only|full`），Sentry 初始化前同步读 |
| `whitelist-pref.ts` | 命令白名单（`whitelist.json`），跨会话保留 |

## 7. 迁移（Drizzle Kit 官方迁移）

**机制**：
- `drizzle/` 目录由 `drizzle-kit generate` 从 schema.ts 派生 + `drizzle/meta/_journal.json`（version/Dialect/entries）与逐迁移 snapshot 登记。
- 运行时 `db.ts` 调 `migrate()`：建 `__drizzle_migrations` journal 表，按 `_journal.json` `when`（folderMillis）前进执行，`SQL` 按 `--> statement-breakpoint` 分割，整体一个事务，失败回滚。
- 迁移目录路径：dev/测试 → `app.getAppPath()/drizzle`；打包 → `process.resourcesPath/drizzle`（electron-builder extraResources）。

**当前迁移链**：

| 迁移 | 语义 |
|---|---|
| `0000_baseline` | 全新库基线（全量 `IF NOT EXISTS` 建表+索引，老库幂等跳过） |
| `0001_legacy_upgrade` | 老库（手写 schema 时代）→ 数据保真重建 5 张安全表（messages/turns/skills/cron_tasks/runtime_models）补齐 CHECK/UNIQUE |
| `0002_sessions_last_run_status` | sessions 的 last_run_status 触发器约束（INSERT + UPDATE 校验） |
| `0003_uniq_session_seq` | messages / turns 新增 `(session_id, seq)` UNIQUE 索引（会话内业务游标 DB 层兜底，防并发/重试写入双行；SQLite 对已有表加 UNIQUE = CREATE UNIQUE INDEX，无需重建表） |

**schema 演化规范**（重要）：
- **加列/加表/改索引**：改 `schema.ts` → `pnpm exec drizzle-kit generate`（自动生成迁移 + journal + snapshot）→ `pnpm exec drizzle-kit check` 验证。
- **给已有表加 CHECK/UNIQUE**（SQLite 无法 `ALTER TABLE ADD CHECK`）：
  1. **重建式迁移**（`0001` 先例）：`ALTER TABLE RENAME` → 带约束 `CREATE TABLE` → `INSERT SELECT` 数据保真 → `DROP` 旧表 → 重建索引。**仅限无其他表外键引用的表**。
  2. **触发器兜底**（`0002` 先例）：BEFORE INSERT/UPDATE 校验枚举，`RAISE(ABORT, 'CHECK constraint failed: ...')`。**被 FK 引用的表（如 sessions——重建会触发 ON DELETE CASCADE 清空全部会话数据）只能用此方式**。
- 手工迁移须登记 `_journal.json`（`when` 取当前时间戳，必须大于前一条）并复制上一快照改 `id`/`prevId`。
- CI 已加 `drizzle-kit check` 防 schema.ts ↔ 快照漂移。

## 8. app-data（`app-data.ts`）

统一返回日志、备份、缓存、keychain 等路径的绝对位置，隔离系统 `%APPDATA%` 与 dev 重定向差异。

## 9. 关键文件

- `db.ts` / `schema.ts` / `db.test.ts`——核心：初始化 + 迁移 + 约束断言（含"老库升级"集成测试）
- `test-utils.ts`——测试共享：drizzle 迁移建内存库（测试不再维护第二份建表 SQL）
- `session-service.ts` / `keychain.ts` / `app-data.ts` / `settings-pref.ts` / `approval-pref.ts` / `telemetry-pref.ts` / `whitelist-pref.ts`
- `drizzle/`——迁移产物（入仓管理，electron-builder 打包进 resources/drizzle）