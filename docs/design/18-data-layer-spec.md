# 18. 数据层规范（SQLite + Drizzle）

> 基于项目实际数据栈（better-sqlite3 + Drizzle ORM，userData 动态路径）制定 schema/迁移/访问约定。
> 最后同步：2026-09-24（访问分层拍板「Service 直访合法化」+ 事务边界清单全量盘点）

---

## 一、技术基线

| 项 | 现状 | 约束 |
|---|---|---|
| 引擎 | better-sqlite3（同步原生） | 禁止引入其他数据库（PostgreSQL/Prisma 已删除，勿恢复） |
| ORM | Drizzle ORM + drizzle-kit | schema 单一真源 |
| 路径 | `app.getPath('userData')` 动态：dev = `.electron-user-data/sessions.db`，prod = `%APPDATA%/…` | 禁止硬编码路径 |
| 关闭 | 主进程退出 closeDb 最后执行（01-architecture dispose 第 12 步） | db 必须先于服务关闭 |

## 二、Schema 管理

1. **单一真源**：`src/main/infra/storage/schema.ts`（Drizzle schema 定义）——表结构只在此声明
2. **迁移**：drizzle-kit（`drizzle.config.ts` 已配置）；schema 变更 → 生成迁移 → 提交迁移文件 → 验证升级路径
3. **表设计约定**：
   - 主键：`id`（TEXT UUID 或 INTEGER autoincrement，按表语义）
   - 时间戳：`createdAt`/`updatedAt`（ISO 字符串或整数 ms，全库统一）
   - 外键：显式声明（Drizzle relations），禁裸字符串关联
   - 索引：高频查询列建索引（session_id/turn_id 等），迁移中体现
4. **变更流程**：
   1. 改 schema.ts → 2. `pnpm drizzle-kit generate` → 3. 提交迁移 SQL → 4. 主进程启动 migrate 应用 → 5. 测试覆盖新表/列

## 三、访问分层

**现行拍板（2026-09-24，debt.md#d6 收敛）：Service 直访合法。**

```
Service 层（session-service/cron-service/goal-service 等）→ getDb() 直接执行 Drizzle 查询
```

1. **Service 直访模式**（以 session-service 为范本）：Service 不持有 DB 连接，经
   `getDb()` 动态获取（便于测试重置与 dispose 顺序）；直接编写 Drizzle 查询。
   旧规「Service → Repository 封装 → db」「db 访问收敛在 storage/」与实现矛盾，已废止——
   storage/ 目录保留的是**无主业务方**的共享存取（usage-turn-store / settings-pref / db 本体），
   有明确业务归属的表由对应 Service 直访。
2. **禁止**：组件/IPC handler 直接 import db 或 getDb——业务逻辑不依赖基础设施（架构原则）；
   渲染层永不触达 db（只经 IPC）。
3. **参数化**：所有查询用 Drizzle 绑定参数，禁止字符串拼接 SQL
4. **错误**：DB 异常包装为 AppError（code + statusCode），不外泄 SQL 细节
5. **多语句写**：必须用 `db.transaction` 包裹（判据与全量盘点见「四、事务边界清单」）

## 四、事务边界清单

> 2026-09-24 全量盘点（grep `db.transaction(` + 逐一核查全部 `getDb()` DML 现场）。
> 「多语句写」判据：**同一业务动作包含 >1 条 DML，且中间无可接受的中间态**（失败回滚优于半写）。

### 4.1 已有事务（生产代码全部 4 处，均已正确覆盖）

| 位置 | 覆盖的业务动作 | 原子性保证 |
|---|---|---|
| session-service `create` | sessions 行 + 首批 messages 批量插入 | 无孤立 messages 行 |
| session-service `appendMessage` | messages 批量插入 + sessions 计数/lastMessage 更新 | 计数与行集一致 |
| session-service `replaceMessages` | 删全量 messages + 重插压缩后消息 + sessions 更新 | /compact 半写不可见 |
| goal-service `create` | 旧 active 目标标 aborted + 新目标 insert | 每会话至多一个 active |

### 4.2 单语句 DML 现场（天然原子，无需事务）

以下模块的全部 DB 写均为**单条语句**（INSERT/UPDATE/DELETE/UPSERT 单发），SQLite 保证
单语句原子性，不构成事务边界：

- **cron-service**：create（单 insert）/ delete（单 delete）/ setEnabled·fire·start（单 update）。
  create 的「先 paused 建 job → insert → resume」是调度层时序（修首次触发丢失），DB 侧单语句。
- **task-service**：create（单 insert）/ update（单 update）/ markAllRunningFailed（单 UPDATE）。
- **learn-skill-agent**：learn（单 upsert onConflictDoUpdate）/ remove（单 delete）。
- **prompt-service**：initialize（单 insert onConflictDoNothing）/ updatePrompt（单 update）。
- **usage-turn-store**：recordUsage / recordTurn（单 insert）/ pruneExpiredUsage（单 delete）。
- **settings-pref**：upsert / delete（单语句）。
- **goal-service**：clear（单 update）/ judge 落账（单 update）——create 属 4.1 事务清单。

### 4.3 跨存储组合写（SQLite 事务不适用，按顺序设计 + 可重建投影兜底）

**runtime-model-store** 的写是「DB 行 + keychain（safeStorage 加密）+ 内存 ModelRegistry」
三方组合——keychain 与 registry 不是 SQLite 资源，`db.transaction` 包不住。现行设计：

- 顺序：DB 先行（唯一持久真源）→ keychain 增量写 → registry 对账（注销旧快照按最新记录重建）
- 自愈依据：registry 是**可重建投影**（`loadAll` 启动期从 DB 全量重放），任何一步中断
  在重启后收敛；不存在需要回滚的持久半态（keychain 残留 key 无行为影响，下次覆盖）
- 结论：保持现状，不加分布式式补偿；未来若引入第二持久真源需重新评估

### 4.4 审计更正

外部审计所称「cron/goal/prompt 等约 13 处多语句写」实为 13 处 `getDb()` **调用现场**，
逐一核查均为单语句 DML。全主进程真正的多语句写即 4.1 所列 4 处，均已有事务。
**无需补任何事务**；新增代码遵守 4.1 判据自查。

## 五、性能与维护

1. 查询加索引列优先 `where` 主键/索引列；大数据量分页（`limit/offset`，session:list 已用）
2. 全表扫描预警：新增查询先 `EXPLAIN QUERY PLAN`（复杂查询）
3. 备份：userData 目录整体备份策略（发布/升级流程中）

## 六、检查清单

- [ ] 新表/列：schema.ts 单一真源 + 迁移文件 + 测试
- [ ] 访问：Service 直访 getDb()（动态获取、不持有连接）；组件/IPC handler 不 import db；渲染层只经 IPC
- [ ] 参数化查询，无 SQL 拼接
- [ ] 多语句写：db.transaction 包裹（对照四、事务边界清单判据）
- [ ] 索引覆盖高频查询
- [ ] DB 错误 → AppError

---

# 附录：数据层现状详述（自 code-wiki 06 合并，2026-10-12）

> 存储体系的实然细节（表结构 / 迁移链 / 备份自愈），与上文演化规范互补；以 schema.ts 为唯一真源。

## 1. 存储体系总览

| 组件 | 落盘位置 | 用途 |
|---|---|---|
| SQLite（better-sqlite3 + Drizzle） | userData `sessions.db` | 会话/消息/Prompt/token 用量/回合/运行时模型/技能/设置/任务/目标/定时任务（11 张表） |
| keychain（safeStorage） | userData `keychain.dat` | API Key 等机密加密存储（Windows 侧 icacls 收紧 ACL，whoami 解析进程令牌主体） |
| 偏好 JSON | userData `approval-pref.json` / `telemetry-pref.json` / `whitelist.json` / `remote-pref.json` / `im-allowlist-pref.json` | 审批模式、遥测级别、命令白名单、远程绑定范围、IM 群白名单（窗口状态在 `src/main/utils/window-state.ts`） |
| app-data | userData `logs/backups/cache/...` | 目录路径统一封装 |

> 记忆功能已整体替换为 TencentDB-Agent-Memory（MemoryHubService sidecar），**不再有自研 memories 表**（见 05 号功能设计附录·记忆引擎）。

## 2. SQLite 生命周期（`db.ts`）

- `initDb()`：建 `sessions.db`、启用 WAL + 外键约束 + busy_timeout(3000ms) + quick_check 完整性校验 + 损坏自愈（从最新健康备份恢复/重建）+ 异步热备份（保留 3 份轮转）→ 执行 **drizzle 迁移**（`migrate()`，见第 7 节）+ 消费暂存恢复点（`applyPendingRestore`：37 号 B 的「暂存 + 重启生效」语义，连接打开前替换主库）。
- `getDb()`：动态获取连接（服务不直接持有）。
- `closeDb()` / `resetDb()`：关闭/重置连接（测试用）。
- **铁律**：db 必须 `initDb`（启动）后首次访问，`closeDb` 在 dispose 最后调用（SessionService 在 closeDb 之前清理）。

## 3. 表结构（唯一真源 `schema.ts`）

`schema.ts` 是**全库唯一真源**（11 张表 + 约束），DDL/迁移由 Drizzle Kit 自动派生：

| 表 | 关键字段 | 领域约束 |
|---|---|---|
| `sessions` | id, title, created_at, updated_at, last_message, message_count, working_dir, last_run_status(idle/running/interrupted, 默认 idle), pinned | last_run_status CHECK（0002 触发器实现） |
| `messages` | id, session_id(FK CASCADE), turn_id, seq, role, content(JSON), created_at | role CHECK；`uq_messages_session_seq` UNIQUE(session_id, seq) |
| `prompts` | id, name, description, role, content, is_default | — |
| `token_usage` | id, session_id, model_id, input/output/total_tokens, cache_read_tokens, reasoning_tokens, created_at | — |
| `turns` | turn_id, session_id, seq, model_id, status, tokens, duration_ms, created_at | `uq_turns_turn_id` UNIQUE + `uq_turns_session_seq` UNIQUE(session_id, seq) |
| `runtime_models` | model_id, provider_kind, base_url, display_name, timeout_ms, api_format, capabilities(JSON), is_enabled | is_enabled CHECK(0/1) |
| `skills` | name, description, prompt, source('learned') | source CHECK |
| `app_settings` | key, value(JSON) | — |
| `cron_tasks` | id, session_id, expression, description, next_fire_at, enabled | enabled CHECK(0/1)；session_id **无外键**（可关联子代理内部回合 id，与 tasks 同决策） |
| `tasks` | id, session_id, kind, description, status, start/end_time | — |
| `goals` | id, session_id(FK CASCADE), condition, status, iterations, last_reason, created_at, finished_at | — |

索引（实测 `schema.ts`）：`idx_sessions_updated_at`、`idx_sessions_pinned_updated(pinned,updated_at)`、`idx_sessions_working_dir(working_dir,updated_at)`、`idx_messages_turn`、`idx_prompts_role`、`idx_token_usage_created_at`、`idx_token_usage_session_id`、`idx_turns_created_at`、`idx_goals_session`；三个 UNIQUE 约束兼做查询索引（0005/0006 性能索引专项，冗余索引已清理）。

**约束策略**：稳定枚举 → DB CHECK/触发器；演进枚举（`goals.status`、`tasks.status/kind`）→ `$type<T>()` 应用层约束（SQLite 改 CHECK 需重建表，代价高）。枚举类型定义在 `schema.ts`，ai 层从 `storage/schema` 导入，勿重复定义。

## 4. SessionService（`session-service.ts`）

- **IPC 暴露组**（request-response，meta.ts 实测 15 方法）：`list / get / delete / clearAll / rename / pin / create / listRecentDirs / exportAll / importAll / getUsageSummary / getTurns / getRecentTurns / getTurnMessages / compact`。
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
| `approval-pref.ts` | 审批模式（**`plan/ask/auto/yolo` 四档**，与 shared ApprovalModeSchema 同源），启动时同步读入 PermissionService |
| `telemetry-pref.ts` | 遥测级别（`off|error-only|full`），OTel 初始化前同步读（off→跳过初始化） |
| `whitelist-pref.ts` | 命令白名单（`whitelist.json`），跨会话保留 |
| `remote-pref.ts` | 远程控制绑定范围（仅本机/局域网） |
| `ai-pref.ts` | AI 设置读取（`app_settings.ai.defaultModel`，主进程侧消费：对话回合无头入口 / compact 预算；读取失败一律回落 undefined） |
| `im-allowlist-pref.ts` | IM 群白名单（IM 域允许列表） |

> 窗口状态记忆在 `src/main/utils/window-state.ts`（非 storage 目录）。

## 7. 迁移（Drizzle Kit 官方迁移）

**机制**：
- `drizzle/` 目录由 `drizzle-kit generate` 从 schema.ts 派生 + `drizzle/meta/_journal.json`（version/Dialect/entries）与逐迁移 snapshot 登记。
- 运行时 `db.ts` 调 `migrate()`：建 `__drizzle_migrations` journal 表，按 `_journal.json` `when`（folderMillis）前进执行，`SQL` 按 `--> statement-breakpoint` 分割，整体一个事务，失败回滚。
- 迁移目录路径：dev/测试 → `app.getAppPath()/drizzle`；打包 → `process.resourcesPath/drizzle`（electron-builder extraResources）。

**当前迁移链**（2026-10-12 实测 10 条）：

| 迁移 | 语义 |
|---|---|
| `0000_baseline` | 全新库基线（全量 `IF NOT EXISTS` 建表+索引，老库幂等跳过） |
| `0001_legacy_upgrade` | 老库（手写 schema 时代）→ 数据保真重建 5 张安全表（messages/turns/skills/cron_tasks/runtime_models）补齐 CHECK/UNIQUE |
| `0002_sessions_last_run_status` | sessions 的 last_run_status 触发器约束（INSERT + UPDATE 校验） |
| `0003_uniq_session_seq` | messages / turns 新增 `(session_id, seq)` UNIQUE 索引（会话内业务游标 DB 层兜底，防并发/重试写入双行；SQLite 对已有表加 UNIQUE = CREATE UNIQUE INDEX，无需重建表） |
| `0004_drop_redundant_messages_index` | 清理冗余索引（UNIQUE 已覆盖单列查询路径） |
| `0005_index_cleanup` | 索引清理专项（冗余索引去重） |
| `0006_add_perf_indexes` | 性能索引专项（sessions pinned+updated_at / working_dir+updated_at 复合、token_usage session_id、turns created_at） |
| `0007_special_dreadnoughts` | runtime_models 加 `timeout_ms`（模型级总时长超时） |
| `0008_perfect_golden_guardian` | runtime_models 加 `api_format`（自定义模型 API 格式，#122） |
| `0009_glorious_namorita` | runtime_models 加 `capabilities`（模型高级配置 JSON 持久化） |

**schema 演化规范**（重要）：
- **加列/加表/改索引**：改 `schema.ts` → `pnpm exec drizzle-kit generate`（自动生成迁移 + journal + snapshot）→ `pnpm exec drizzle-kit check` 验证。
- **给已有表加 CHECK/UNIQUE**（SQLite 无法 `ALTER TABLE ADD CHECK`）：
  1. **重建式迁移**（`0001` 先例）：`ALTER TABLE RENAME` → 带约束 `CREATE TABLE` → `INSERT SELECT` 数据保真 → `DROP` 旧表 → 重建索引。**仅限无其他表外键引用的表**。
  2. **触发器兜底**（`0002` 先例）：BEFORE INSERT/UPDATE 校验枚举，`RAISE(ABORT, 'CHECK constraint failed: ...')`。**被 FK 引用的表（如 sessions——重建会触发 ON DELETE CASCADE 清空全部会话数据）只能用此方式**。
- 手工迁移须登记 `_journal.json`（`when` 取当前时间戳，必须大于前一条）并复制上一快照改 `id`/`prevId`。
- CI 已加 `drizzle-kit check` 防 schema.ts ↔ 快照漂移（`check:schema-drift`）。

## 8. app-data（`app-data.ts`）

统一返回日志、备份、缓存、keychain 等路径的绝对位置，隔离系统 `%APPDATA%` 与 dev 重定向差异。

## 9. 关键文件

- `db.ts` / `schema.ts` / `db.test.ts`——核心：初始化 + 迁移 + 约束断言（含"老库升级"集成测试）
- `test-utils.ts`——测试共享：drizzle 迁移建内存库（测试不再维护第二份建表 SQL）
- `backup-store.ts`——备份恢复点管理（37 号 B 自 db.ts 抽离：列表/手动备份/`stageRestore` 暂存恢复，重启生效——WAL 连接持有句柄，热恢复会污染打开中的库）
- `session-service.ts`——SessionService 主体；**37 号 B 拆分的配套层**：`session-types.ts`（契约接口）、`session-helpers.ts`（行转换/标题解析/序列化）、`session-io.ts`（导出/导入：每会话独立事务 + 同 id 幂等跳过 + 损坏消息跳过不阻断）、`usage-turn-store.ts`（token_usage / turns 两表存储层）
- `settings-io.ts`——设置导出/导入存储层（app_settings 全表 ↔ 版本化 JSON）
- `keychain.ts` / `app-data.ts` / `settings-pref.ts` / `approval-pref.ts` / `telemetry-pref.ts` / `whitelist-pref.ts` / `remote-pref.ts` / `im-allowlist-pref.ts`
- `drizzle/`——迁移产物（入仓管理，electron-builder 打包进 resources/drizzle）
