// src/main/infra/storage/schema-sql.ts
// 数据库建表 SQL（单一真源）
// ──────────────────────────────────────────────────────────────
// 设计动机（可维护性）：
// - 建表 SQL 此前在 db.ts（生产）与 session-service.test.ts（测试）各写一份，
//   加列（如 last_run_status）需同步两处，漏一处即 SqliteError。
// - 抽为无依赖常量后，生产与测试共用同一份，杜绝双源真相。
// - 本文件不 import electron / drizzle，测试可安全 import（不触发 app.getPath）。
// ──────────────────────────────────────────────────────────────

/**
 * 建表 + 索引 SQL（幂等，IF NOT EXISTS）
 *
 * 包含 sessions / messages / prompts 三表 + 三个索引。
 * 测试环境直接复用（多建的 prompts 表对会话测试无影响）。
 */
export const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_message TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      working_dir TEXT NOT NULL DEFAULT '',
      last_run_status TEXT NOT NULL DEFAULT 'idle'
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
    CREATE INDEX IF NOT EXISTS idx_prompts_role ON prompts(role);
  `;
