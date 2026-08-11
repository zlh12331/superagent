# 18. 数据层规范（SQLite + Drizzle）

> 基于项目实际数据栈（better-sqlite3 + Drizzle ORM，userData 动态路径）制定 schema/迁移/访问约定。
> 最后同步：2026-08-11

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

```
Service 层（session-service/git-service 等）→ Repository 风格封装 → db 实例
```

1. **禁止**：组件/handler 直接 import db（业务逻辑不依赖基础设施——架构原则）；db 访问收敛在 `src/main/infra/storage/`
2. **事务**：多表写入用 `db.transaction`（better-sqlite3 同步事务）；跨服务写操作由调用方编排（无分布式事务）
3. **参数化**：所有查询用 Drizzle 绑定参数，禁止字符串拼接 SQL
4. **错误**：DB 异常包装为 AppError（code + statusCode），不外泄 SQL 细节

## 四、性能与维护

1. 查询加索引列优先 `where` 主键/索引列；大数据量分页（`limit/offset`，session:list 已用）
2. 全表扫描预警：新增查询先 `EXPLAIN QUERY PLAN`（复杂查询）
3. 备份：userData 目录整体备份策略（发布/升级流程中）

## 五、检查清单

- [ ] 新表/列：schema.ts 单一真源 + 迁移文件 + 测试
- [ ] 访问收敛：storage/ 层封装，组件不直连 db
- [ ] 参数化查询，无 SQL 拼接
- [ ] 索引覆盖高频查询
- [ ] DB 错误 → AppError
