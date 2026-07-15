//! 只读状态数据库诊断查询模块。
//!
//! 提供 [`read_thread_state_audit_rows`] 用于在不创建、迁移或修复 state DB 的前提下，
//! 读取持久化的 thread 行数据，便于诊断与审计。

use anyhow::Result;
use log::LevelFilter;
use sqlx::ConnectOptions;
use sqlx::Row;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::sqlite::SqlitePoolOptions;
use std::path::Path;
use std::path::PathBuf;

/// 只读 state DB 审计使用的最小化 thread 元数据。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadStateAuditRow {
    /// thread ID。
    pub id: String,
    /// rollout 文件路径。
    pub rollout_path: PathBuf,
    /// 是否已归档。
    pub archived: bool,
    /// 会话来源。
    pub source: String,
    /// 模型 provider ID。
    pub model_provider: String,
}

/// 从 state DB 读取持久化的 thread 行，不创建、迁移或修复数据库。
///
/// 该函数以只读模式打开 SQLite 文件，适用于诊断工具或审计场景，
/// 不会触发任何写入操作或 schema 升级。
///
/// # 参数
/// - `path`: state DB 文件路径
///
/// # 返回值
/// 返回 [`ThreadStateAuditRow`] 列表；若读取失败则返回 `Err`。
pub async fn read_thread_state_audit_rows(path: &Path) -> Result<Vec<ThreadStateAuditRow>> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .read_only(true)
        .log_statements(LevelFilter::Off);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await?;
    let rows = sqlx::query(
        r#"
SELECT id, rollout_path, archived, source, model_provider
FROM threads
        "#,
    )
    .fetch_all(&pool)
    .await?;
    pool.close().await;

    rows.into_iter()
        .map(|row| {
            let archived: i64 = row.try_get("archived")?;
            Ok(ThreadStateAuditRow {
                id: row.try_get("id")?,
                rollout_path: PathBuf::from(row.try_get::<String, _>("rollout_path")?),
                archived: archived != 0,
                source: row.try_get("source")?,
                model_provider: row.try_get("model_provider")?,
            })
        })
        .collect()
}
