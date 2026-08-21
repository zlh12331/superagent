# 06 · 数据层与存储

> 覆盖：`src/main/infra/storage/`（SQLite + Drizzle、SessionService、keychain、偏好持久化）。

## 1. 存储体系总览

| 组件 | 落盘位置 | 用途 |
|---|---|---|
| SQLite（better-sqlite3 + Drizzle） | userData `sessions.db` | 会话/消息/Prompt/token 用量/回合/运行时模型/技能/设置/任务/记忆/目标/定时任务 |
| keychain（safeStorage） | userData `keychain.dat` | API Key 等机密加密存储 |
| 偏好 JSON | userData `approval-pref.json` / `telemetry-pref.json` / `whitelist.json` / `window-state.json` | 审批模式、遥测级别、命令白名单、窗口状态 |
| app-data | userData `logs/backups/cache/...` | 目录路径统一封装 |

## 2. SQLite 生命周期（`db.ts`）

- `initDb()`：建 `sessions.db`、启用 WAL + 外键约束、执行 `SCHEMA_SQL`（幂等 `IF NOT EXISTS`）、跑版本化迁移（`migrations.ts`，基于 `PRAGMA user_version`）。
- `getDb()`：动态获取连接（服务不直接持有）。
- `closeDb()` / `resetDb()`：关闭/重置连接（测试用）。
- **铁律**：db 必须 `initDb`（启动）后首次访问，`closeDb` 在 dispose 最后调用（SessionService 在 closeDb 之前清理）。

## 3. 表结构（单一真源 `schema-sql.ts`，`schema.ts` 为 Drizzle TS 定义）

| 表 | 关键字段 | 说明 |
|---|---|---|
| `sessions` | id, title, created_at, updated_at, last_message, message_count, working_dir, last_run_status(idle/running/...), pinned | 会话头 |
| `messages` | id, session_id(FK CASCADE), turn_id, seq, role, content(JSON), created_at | 消息体 |
| `prompts` | id, name, description, role, content, is_default | 用户可编辑 prompt 模板 |
| `token_usage` | session_id, model_id, input/output/total_tokens, cache_read, reasoning, created_at | token 用量 |
| `turns` | turn_id, session_id, seq, model_id, status, tokens, duration_ms | 回合记录 |
| `runtime_models` | model_id, provider_kind, base_url, display_name, is_enabled | 自定义运行时模型 |
| `skills` | name, description, prompt, source('learned') | 已学技能 |
| `app_settings` | key, value(JSON) | 渲染层设置下沉 |
| `cron_tasks` | id, session_id, expression, description, next_fire_at, enabled | 定时任务 |
| `tasks` | id, session_id, kind, description, status, start/end_time | 任务 |
| `memories` | id, session_id, content, kind, source_turn_id | 记忆 |
| `goals` | id, session_id, condition, status, iterations, last_reason | 会话目标 |

索引：`sessions(updated_at DESC)`、`messages(session_id,seq)`、`messages(turn_id)`、`prompts(role)`、`token_usage(created_at)`、`turns(session_id,seq)`、`goals(session_id)`。

## 4. SessionService（`session-service.ts`）

- **IPC 暴露组**（request-response）：`list / get / delete / rename / pin / create / listRecentDirs / exportAll / getUsageSummary / getTurns / getRecentTurns / getTurnMessages / compact`。
- **内部 API 组**（直接调用）：`create`（主进程创建会话）、`appendMessage`（写消息）、`replaceMessages`（编辑/压缩后替换）。
- 核心职责：
  - `sessions/messages` CRUD，消息 `JSON.stringify` 序列化到 `content`，读取反序列化为 `unknown[]`（不向 shared 泄漏 AI SDK 类型）。
  - 崩溃恢复：`markAllInterrupted()` 把残留 running 会话标 `interrupted`。
  - token 用量与回合（`turns`）记录；`/compact` 上下文压缩后用 `replaceMessages` 替换历史。
- 不持有 db 连接（`getDb()` 动态获取）。

## 5. keychain（`keychain.ts`）

- 使用 Electron `safeStorage` 加密读写 `keychain.dat`，存放不同供应商的 API Key。
- `setApiKey(provider, key)` / `getApiKey(provider)` / `deleteApiKey(provider)`。

## 6. 偏好持久化（`*_pref.ts`）

| 文件 | 内容 |
|---|---|
| `settings-pref.ts` | 渲染层设置下沉 SQLite `app_settings` 表（key-value JSON） |
| `approval-pref.ts` | 审批模式（`ask|auto|deny`），启动时同步读入 PermissionService |
| `telemetry-pref.ts` | 遥测级别（`off|error-only|full`），Sentry 初始化前同步读 |
| `whitelist-pref.ts` | 命令白名单（`whitelist.json`），跨会话保留 |

## 7. 迁移（`migrations.ts`）

基于 `PRAGMA user_version` 的链式迁移表，历史迁移如：`sessions.working_dir/pinned/last_run_status` 列新增、`app_settings` 表、`runtime_models` 表扩展。新增 schema 变更需追加迁移。

## 8. app-data（`app-data.ts`）

统一返回日志、备份、缓存、keychain 等路径的绝对位置，隔离系统 `%APPDATA%` 与 dev 重定向差异。

## 9. 关键文件

- `db.ts` / `schema.ts` / `schema-sql.ts` / `migrations.ts` / `session-service.ts`
- `keychain.ts` / `app-data.ts` / `settings-pref.ts` / `approval-pref.ts` / `telemetry-pref.ts` / `whitelist-pref.ts`
- 测试：`db.test.ts`、`session-service.test.ts`、`keychain.test.ts`、`db.perf.test.ts`。