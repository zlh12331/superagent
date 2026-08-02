// drizzle.config.ts
// Drizzle Kit 配置：schema 迁移生成与推送
// ──────────────────────────────────────────────────────────────
// 用途：
// - `pnpm drizzle-kit generate`：根据 src/main/infra/storage/schema.ts 生成 SQL 迁移文件
// - `pnpm drizzle-kit push`：直接把 schema 推送到数据库（dev 快速迭代用）
// - `pnpm drizzle-kit migrate`：执行生成的迁移文件
//
// 设计：
// - dialect: sqlite（项目使用 better-sqlite3）
// - schema 指向 src/main/infra/storage/schema.ts（单一真源）
// - out 指向 drizzle/（迁移文件目录，入仓管理）
// - dbCredentials 指向 dev 环境的 sessions.db（仅 push/migrate 用）
//
// 注意：
// - 生产环境数据库路径在 %APPDATA%/code-agent-desktop/sessions.db
// - dev 环境数据库路径在 .electron-user-data/sessions.db
// - 此处的 dbCredentials 仅用于 drizzle-kit push/migrate 命令，
//   实际运行时由 db.ts 的 getDbPath() 决定路径
// ──────────────────────────────────────────────────────────────

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/main/infra/storage/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: '.electron-user-data/sessions.db',
  },
  verbose: true,
  strict: true,
});
