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

/** 追加列 helper：列不存在时执行 ALTER（幂等） */
function addColumnIfMissing(db: Database, table: string, column: string, ddl: string): void {
  if (!hasColumn(db, table, column)) {
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
] as const;

/** 当前 schema 版本（= 最新迁移版本；新库直接落位此版本） */
export const CURRENT_SCHEMA_VERSION = MIGRATIONS.length;
