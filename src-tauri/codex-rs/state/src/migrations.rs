//! SQLite 数据库迁移定义与运行时迁移器构造。
//!
//! 本模块加载各 SQLite 数据库（state、logs、goals、memories）的迁移脚本，
//! 并提供运行时迁移器以容忍"数据库已被更新版本迁移"的情形，
//! 便于新旧 Codex 二进制并行运行。

use std::borrow::Cow;

use sqlx::SqlitePool;
use sqlx::migrate::Migrator;

/// state DB 的迁移器（编译期嵌入 `./migrations` 目录）。
pub(crate) static STATE_MIGRATOR: Migrator = sqlx::migrate!("./migrations");
/// logs DB 的迁移器（编译期嵌入 `./logs_migrations` 目录）。
pub(crate) static LOGS_MIGRATOR: Migrator = sqlx::migrate!("./logs_migrations");
/// goals DB 的迁移器（编译期嵌入 `./goals_migrations` 目录）。
pub(crate) static GOALS_MIGRATOR: Migrator = sqlx::migrate!("./goals_migrations");
/// memories DB 的迁移器（编译期嵌入 `./memory_migrations` 目录）。
pub(crate) static MEMORIES_MIGRATOR: Migrator = sqlx::migrate!("./memory_migrations");

/// 允许较旧的 Codex 二进制打开已被较新二进制迁移过的数据库。
///
/// 该函数会忽略已应用但版本号高于当前嵌入迁移集的迁移项。
/// 已知的迁移版本仍会通过 checksum 校验，因此本函数只放宽
/// "数据库版本领先于当前二进制"的情形。
fn runtime_migrator(base: &'static Migrator) -> Migrator {
    Migrator {
        migrations: Cow::Borrowed(base.migrations.as_ref()),
        ignore_missing: true,
        locking: base.locking,
        no_tx: base.no_tx,
        table_name: base.table_name.clone(),
        create_schemas: base.create_schemas.clone(),
    }
}

/// 构造 state DB 的运行时迁移器。
pub(crate) fn runtime_state_migrator() -> Migrator {
    runtime_migrator(&STATE_MIGRATOR)
}

/// 构造 logs DB 的运行时迁移器。
pub(crate) fn runtime_logs_migrator() -> Migrator {
    runtime_migrator(&LOGS_MIGRATOR)
}

/// 构造 goals DB 的运行时迁移器。
pub(crate) fn runtime_goals_migrator() -> Migrator {
    runtime_migrator(&GOALS_MIGRATOR)
}

/// 构造 memories DB 的运行时迁移器。
pub(crate) fn runtime_memories_migrator() -> Migrator {
    runtime_migrator(&MEMORIES_MIGRATOR)
}

/// 修复历史遗留的 recency migration 版本号。
///
/// 早期版本将 recency migration 误登记为版本 38，后续修正为版本 39。
/// 本函数在确认 checksum 一致且目标版本不存在时，将旧版本号更新为新版本号，
/// 避免重复迁移或版本冲突。
///
/// # 参数
/// - `pool`: SQLite 连接池
/// - `migrator`: 当前迁移器引用
///
/// # 返回值
/// 成功返回 `Ok(())`；若发生 SQL 错误则返回 `Err`。
pub(crate) async fn repair_legacy_recency_migration_version(
    pool: &SqlitePool,
    migrator: &Migrator,
) -> anyhow::Result<()> {
    let Some(recency_migration) = migrator
        .migrations
        .iter()
        .find(|migration| migration.version == 39)
    else {
        return Ok(());
    };
    let migrations_table_exists = sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'",
    )
    .fetch_optional(pool)
    .await?
    .is_some();
    if !migrations_table_exists {
        return Ok(());
    }

    sqlx::query(
        r#"
UPDATE _sqlx_migrations
SET version = ?, description = ?
WHERE version = ?
  AND checksum = ?
  AND NOT EXISTS (
      SELECT 1 FROM _sqlx_migrations WHERE version = ?
  )
        "#,
    )
    .bind(recency_migration.version)
    .bind(recency_migration.description.as_ref())
    .bind(38_i64)
    .bind(recency_migration.checksum.as_ref())
    .bind(recency_migration.version)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
#[path = "migrations_tests.rs"]
mod tests;
