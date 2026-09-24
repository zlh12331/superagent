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
