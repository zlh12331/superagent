// src/main/infra/storage/migrations.ts
// 数据库版本化迁移（P4 修复）
// ──────────────────────────────────────────────────────────────
// 背景：此前 db.ts 用三段「启动期 ALTER + duplicate column name 字符串匹配」
// 做幂等迁移——无版本链、无回滚路径、错误判定依赖 SQLite 错误文案。
// 本文件改为 PRAGMA user_version 版本链（SQLite 官方机制）：
// - 每个迁移只执行一次（执行后 user_version 递增），幂等判定改为
//   PRAGMA table_info 列存在性检查（不依赖错误文案）
// - 新库路径：SCHEMA_SQL（schema-sql.ts）已是最新 schema，直接跳到当前版本
// - 老库路径：按版本逐个执行 pending 迁移
//
// 新增列的完整流程（三处同步，缺一不可）：
// 1. schema.ts（Drizzle 类型真源）加列
// 2. schema-sql.ts（新库 DDL 真源）加列
// 3. 本文件追加迁移条目（老库路径），CURRENT_SCHEMA_VERSION 随版本号递增
// ──────────────────────────────────────────────────────────────

import type { Database } from 'better-sqlite3';

/** 单个 schema 迁移 */
export interface SchemaMigration {
  /** 迁移版本号（从 1 递增，执行后写入 PRAGMA user_version） */
  readonly version: number;
  /** 迁移名称（日志/诊断用） */
  readonly name: string;
  /** 迁移执行函数（必须幂等：列已存在时跳过） */
  readonly up: (db: Database) => void;
}

/**
 * 检查表是否存在指定列（PRAGMA table_info，幂等判定的机器依据）
 */
function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as readonly {
    readonly name: string;
  }[];
  return rows.some((row) => row.name === column);
}

/** 检查表是否存在（P2 修复：迁移先于 SCHEMA_SQL 执行的顺序下，老 fixture 可能缺后续版本才引入的表） */
function hasTable(db: Database, table: string): boolean {
  const row = db
    .prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
    .get('table', table) as { readonly name: string } | undefined;
  return row !== undefined;
}

/**
 * 追加列 helper：列不存在时执行 ALTER（幂等）
 *
 * 表不存在时跳过：缺失的表随后由 SCHEMA_SQL 以最新结构创建，列天然包含；
 * 若不守卫，vN 早期迁移 ALTER 一张 v0 老库尚不存在的表会直接抛错中断迁移链。
 */
function addColumnIfMissing(db: Database, table: string, column: string, ddl: string): void {
  if (hasTable(db, table) && !hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl};`);
  }
}

/** 全部迁移（按版本升序；新迁移只能追加，禁止改动已发布的条目） */
export const MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    name: 'sessions.working_dir',
    up: (db) => {
      addColumnIfMissing(db, 'sessions', 'working_dir', "working_dir TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    version: 2,
    name: 'sessions.pinned',
    up: (db) => {
      addColumnIfMissing(db, 'sessions', 'pinned', 'pinned INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    version: 3,
    name: 'sessions.last_run_status',
    up: (db) => {
      addColumnIfMissing(
        db,
        'sessions',
        'last_run_status',
        "last_run_status TEXT NOT NULL DEFAULT 'idle'",
      );
    },
  },
  {
    // S1：渲染层 settings 下沉 SQLite（用户决策：合并到 SQLite 单一真源）
    version: 4,
    name: 'app_settings',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    // 模型设置页：展示名 + 启停开关（runtime_models 扩展）
    version: 5,
    name: 'runtime_models.display_name/is_enabled',
    up: (db) => {
      addColumnIfMissing(db, 'runtime_models', 'display_name', 'display_name TEXT');
      addColumnIfMissing(
        db,
        'runtime_models',
        'is_enabled',
        'is_enabled INTEGER NOT NULL DEFAULT 1',
      );
    },
  },
  {
    // P1 修复：turn_id 列诞生于迁移系统之前（41c4ed4），从未有过 ALTER 路径。
    // 老库（无该列）直接执行含 idx_messages_turn 的 SCHEMA_SQL 会抛
    // 「no such column: turn_id」导致启动崩溃——本条目补齐版本链。
    // 配套：db.ts 已改为「老库先迁移再执行 SCHEMA_SQL」的顺序。
    version: 6,
    name: 'messages.turn_id',
    up: (db) => {
      addColumnIfMissing(db, 'messages', 'turn_id', 'turn_id TEXT');
    },
  },
] as const;

/** 当前 schema 版本（= 最新迁移版本；新库直接落位此版本） */
export const CURRENT_SCHEMA_VERSION = MIGRATIONS.length;
