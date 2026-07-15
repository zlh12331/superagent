use crate::AgentJob;
use crate::AgentJobCreateParams;
use crate::AgentJobItem;
use crate::AgentJobItemCreateParams;
use crate::AgentJobItemStatus;
use crate::AgentJobProgress;
use crate::AgentJobStatus;
use crate::GOALS_DB_FILENAME;
use crate::LOGS_DB_FILENAME;
use crate::LogEntry;
use crate::LogQuery;
use crate::LogRow;
use crate::MEMORIES_DB_FILENAME;
use crate::STATE_DB_FILENAME;
use crate::SortKey;
use crate::ThreadMetadata;
use crate::ThreadMetadataBuilder;
use crate::ThreadsPage;
use crate::apply_rollout_item;
use crate::migrations::repair_legacy_recency_migration_version;
use crate::migrations::runtime_goals_migrator;
use crate::migrations::runtime_logs_migrator;
use crate::migrations::runtime_memories_migrator;
use crate::migrations::runtime_state_migrator;
use crate::model::AgentJobRow;
use crate::model::ThreadRow;
use crate::model::anchor_from_item;
use crate::model::datetime_to_epoch_millis;
use crate::model::datetime_to_epoch_seconds;
use crate::model::epoch_millis_to_datetime;
use crate::paths::file_modified_time_utc;
use crate::telemetry::DbKind;
use crate::telemetry::DbTelemetry;
use chrono::DateTime;
use chrono::Utc;
use codex_protocol::ThreadId;
use codex_protocol::protocol::RolloutItem;
use log::LevelFilter;
use serde_json::Value;
use sqlx::ConnectOptions;
use sqlx::QueryBuilder;
use sqlx::Row;
use sqlx::Sqlite;
use sqlx::SqliteConnection;
use sqlx::SqlitePool;
use sqlx::migrate::Migrator;
use sqlx::sqlite::SqliteAutoVacuum;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::sqlite::SqliteJournalMode;
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::sqlite::SqliteSynchronous;
use std::collections::BTreeSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicI64;
use std::time::Duration;
use std::time::Instant;
use tracing::warn;

mod agent_jobs;
mod backfill;
mod external_agent_config_imports;
mod goals;
mod logs;
mod memories;
mod recovery;
mod remote_control;
#[cfg(test)]
mod test_support;
mod threads;

pub use external_agent_config_imports::ExternalAgentConfigImportDetailsRecord;
pub use external_agent_config_imports::ExternalAgentConfigImportFailureRecord;
pub use external_agent_config_imports::ExternalAgentConfigImportHistoryRecord;
pub use external_agent_config_imports::ExternalAgentConfigImportSuccessRecord;
pub use goals::GoalAccountingMode;
pub use goals::GoalAccountingOutcome;
pub use goals::GoalStore;
pub use goals::GoalUpdate;
pub use memories::MemoryStore;
pub use recovery::RuntimeDbBackup;
pub use recovery::backup_runtime_db_for_fresh_start;
pub use recovery::is_sqlite_corruption_error;
pub use recovery::runtime_db_path_for_corruption_error;
pub use recovery::sqlite_error_detail_is_corruption;
pub use recovery::sqlite_error_detail_is_lock;
pub use remote_control::RemoteControlEnrollmentRecord;
pub use threads::ThreadFilterOptions;

// "Partition" 指保留日志内容的桶，每个桶上限 10 MiB：
// - 每个 non-null thread_id 对应一个桶
// - 每个 threadless（thread_id IS NULL）但 non-null process_uuid 对应一个桶
// - threadless 且 process_uuid IS NULL 的所有行共用一个桶
// 该预算统计每行已持久化的渲染日志正文加上非正文 metadata，
// 而不是所有 SQLite 列字节总和的精确值。
const LOG_PARTITION_SIZE_LIMIT_BYTES: i64 = 10 * 1024 * 1024;
const LOG_PARTITION_ROW_LIMIT: i64 = 1_000;

/// 单个运行时 SQLite DB 的描述信息（标签、文件名、kind、阶段名）。
#[derive(Clone, Copy)]
struct RuntimeDbSpec {
    label: &'static str,
    filename: &'static str,
    kind: DbKind,
    open_phase: &'static str,
    migrate_phase: &'static str,
}

impl RuntimeDbSpec {
    fn path(self, codex_home: &Path) -> PathBuf {
        codex_home.join(self.filename)
    }
}

const STATE_DB: RuntimeDbSpec = RuntimeDbSpec {
    label: "state DB",
    filename: STATE_DB_FILENAME,
    kind: DbKind::State,
    open_phase: "open_state",
    migrate_phase: "migrate_state",
};

const LOGS_DB: RuntimeDbSpec = RuntimeDbSpec {
    label: "log DB",
    filename: LOGS_DB_FILENAME,
    kind: DbKind::Logs,
    open_phase: "open_logs",
    migrate_phase: "migrate_logs",
};

const GOALS_DB: RuntimeDbSpec = RuntimeDbSpec {
    label: "goals DB",
    filename: GOALS_DB_FILENAME,
    kind: DbKind::Goals,
    open_phase: "open_goals",
    migrate_phase: "migrate_goals",
};

const MEMORIES_DB: RuntimeDbSpec = RuntimeDbSpec {
    label: "memories DB",
    filename: MEMORIES_DB_FILENAME,
    kind: DbKind::Memories,
    open_phase: "open_memories",
    migrate_phase: "migrate_memories",
};

const RUNTIME_DBS: [RuntimeDbSpec; 4] = [STATE_DB, LOGS_DB, GOALS_DB, MEMORIES_DB];

/// 运行时 DB 的路径描述，包含可读 label 与绝对路径。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeDbPath {
    /// 可读 label（例如 "state DB"）。
    pub label: &'static str,
    /// DB 文件绝对路径。
    pub path: PathBuf,
}

/// State runtime：管理 thread 元数据、日志、goals 与 memories 的统一入口。
///
/// 持有四个 SQLite 连接池（state、logs、goals、memories），并维护
/// thread 的 updated_at 与 recency_at 原子计数器以避免热点 SQL 写入。
#[derive(Clone)]
pub struct StateRuntime {
    codex_home: PathBuf,
    default_provider: String,
    pool: Arc<sqlx::SqlitePool>,
    logs_pool: Arc<sqlx::SqlitePool>,
    thread_goals: GoalStore,
    memories: MemoryStore,
    thread_updated_at_millis: Arc<AtomicI64>,
    thread_recency_at_millis: Arc<AtomicI64>,
}

impl StateRuntime {
    /// 使用指定的 Codex 主目录和默认 provider 初始化 state runtime。
    ///
    /// 该函数会打开（并迁移）`codex_home` 下的 SQLite 数据库，
    /// 日志单独存放在一个文件中以减少与 state 主存储之间的锁竞争。
    ///
    /// # 参数
    /// - `codex_home`: Codex 主目录
    /// - `default_provider`: 默认模型 provider ID
    ///
    /// # 返回值
    /// 返回封装在 `Arc` 中的 [`StateRuntime`]；若初始化失败则返回 `Err`。
    pub async fn init(codex_home: PathBuf, default_provider: String) -> anyhow::Result<Arc<Self>> {
        Self::init_inner(
            codex_home,
            default_provider,
            /*telemetry_override*/ None,
        )
        .await
    }

    #[cfg(test)]
    pub(crate) async fn init_with_telemetry_for_tests(
        codex_home: PathBuf,
        default_provider: String,
        telemetry_override: &dyn DbTelemetry,
    ) -> anyhow::Result<Arc<Self>> {
        Self::init_inner(codex_home, default_provider, Some(telemetry_override)).await
    }

    async fn init_inner(
        codex_home: PathBuf,
        default_provider: String,
        telemetry_override: Option<&dyn DbTelemetry>,
    ) -> anyhow::Result<Arc<Self>> {
        tokio::fs::create_dir_all(&codex_home).await?;
        let state_migrator = runtime_state_migrator();
        let logs_migrator = runtime_logs_migrator();
        let goals_migrator = runtime_goals_migrator();
        let memories_migrator = runtime_memories_migrator();
        let state_path = STATE_DB.path(codex_home.as_path());
        let logs_path = LOGS_DB.path(codex_home.as_path());
        let goals_path = GOALS_DB.path(codex_home.as_path());
        let memories_path = MEMORIES_DB.path(codex_home.as_path());
        let pool = match open_state_sqlite(&state_path, &state_migrator, telemetry_override).await {
            Ok(db) => Arc::new(db),
            Err(err) => {
                warn!("failed to open state db at {}: {err}", state_path.display());
                return Err(err);
            }
        };
        let logs_pool = match open_logs_sqlite(&logs_path, &logs_migrator, telemetry_override).await
        {
            Ok(db) => Arc::new(db),
            Err(err) => {
                warn!("failed to open logs db at {}: {err}", logs_path.display());
                close_sqlite_pools(&[pool.as_ref()]).await;
                return Err(err);
            }
        };
        let goals_pool =
            match open_goals_sqlite(&goals_path, &goals_migrator, telemetry_override).await {
                Ok(db) => Arc::new(db),
                Err(err) => {
                    warn!("failed to open goals db at {}: {err}", goals_path.display());
                    close_sqlite_pools(&[pool.as_ref(), logs_pool.as_ref()]).await;
                    return Err(err);
                }
            };
        let memories_pool = match open_memories_sqlite(
            &memories_path,
            &memories_migrator,
            telemetry_override,
        )
        .await
        {
            Ok(db) => Arc::new(db),
            Err(err) => {
                warn!(
                    "failed to open memories db at {}: {err}",
                    memories_path.display()
                );
                close_sqlite_pools(&[pool.as_ref(), logs_pool.as_ref(), goals_pool.as_ref()]).await;
                return Err(err);
            }
        };
        let started = Instant::now();
        let backfill_state_result = ensure_backfill_state_row_in_pool(pool.as_ref()).await;
        crate::telemetry::record_init_result(
            telemetry_override,
            DbKind::State,
            "ensure_backfill_state",
            started.elapsed(),
            &backfill_state_result,
        );
        if let Err(err) = backfill_state_result {
            close_sqlite_pools(&[
                pool.as_ref(),
                logs_pool.as_ref(),
                goals_pool.as_ref(),
                memories_pool.as_ref(),
            ])
            .await;
            return Err(err);
        }
        let started = Instant::now();
        let thread_timestamp_millis_result: anyhow::Result<(Option<i64>, Option<i64>)> =
            sqlx::query_as(
                "SELECT MAX(threads.updated_at_ms), MAX(threads.recency_at_ms) FROM threads",
            )
            .fetch_one(pool.as_ref())
            .await
            .map_err(anyhow::Error::from);
        crate::telemetry::record_init_result(
            telemetry_override,
            DbKind::State,
            "post_init_query",
            started.elapsed(),
            &thread_timestamp_millis_result,
        );
        let (thread_updated_at_millis, thread_recency_at_millis) =
            match thread_timestamp_millis_result {
                Ok(value) => value,
                Err(err) => {
                    close_sqlite_pools(&[
                        pool.as_ref(),
                        logs_pool.as_ref(),
                        goals_pool.as_ref(),
                        memories_pool.as_ref(),
                    ])
                    .await;
                    return Err(err);
                }
            };
        let thread_updated_at_millis = thread_updated_at_millis.unwrap_or(0);
        let thread_recency_at_millis = thread_recency_at_millis.unwrap_or(0);
        let runtime = Arc::new(Self {
            thread_goals: GoalStore::new(Arc::clone(&goals_pool)),
            memories: MemoryStore::new(Arc::clone(&memories_pool), Arc::clone(&pool)),
            pool,
            logs_pool,
            codex_home,
            default_provider,
            thread_updated_at_millis: Arc::new(AtomicI64::new(thread_updated_at_millis)),
            thread_recency_at_millis: Arc::new(AtomicI64::new(thread_recency_at_millis)),
        });
        if let Err(err) = runtime.run_logs_startup_maintenance().await {
            warn!(
                "failed to run startup maintenance for logs db at {}: {err}",
                logs_path.display(),
            );
        }
        Ok(runtime)
    }

    /// 返回该 runtime 配置的 Codex 主目录。
    pub fn codex_home(&self) -> &Path {
        self.codex_home.as_path()
    }

    /// 返回 thread goals 存储。
    pub fn thread_goals(&self) -> &GoalStore {
        &self.thread_goals
    }

    /// 返回 memories 存储。
    pub fn memories(&self) -> &MemoryStore {
        &self.memories
    }

    /// 关闭所有 SQLite 连接池并等待未完成的 pool worker 退出。
    pub async fn close(&self) {
        self.memories.close().await;
        self.thread_goals.close().await;
        self.logs_pool.close().await;
        self.pool.close().await;
    }

    /// 清空指定 SQLite 主目录下的 memories 数据库内容。
    ///
    /// # 参数
    /// - `sqlite_home`: SQLite 主目录
    ///
    /// # 返回值
    /// 若 memories DB 存在并已清空则返回 `Ok(true)`；若 DB 不存在则返回 `Ok(false)`。
    pub async fn clear_memory_data_in_sqlite_home(sqlite_home: &Path) -> anyhow::Result<bool> {
        let memories_path = MEMORIES_DB.path(sqlite_home);
        if !tokio::fs::try_exists(&memories_path).await? {
            return Ok(false);
        }

        let memories_migrator = runtime_memories_migrator();
        let pool = open_memories_sqlite(
            &memories_path,
            &memories_migrator,
            /*telemetry_override*/ None,
        )
        .await?;
        memories::clear_memory_data_in_pool(&pool).await?;
        pool.close().await;
        Ok(true)
    }
}

async fn close_sqlite_pools(pools: &[&SqlitePool]) {
    for pool in pools {
        pool.close().await;
    }
}

fn base_sqlite_options(path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(5))
        .log_statements(LevelFilter::Off)
}

async fn open_state_sqlite(
    path: &Path,
    migrator: &Migrator,
    telemetry_override: Option<&dyn DbTelemetry>,
) -> anyhow::Result<SqlitePool> {
    // 新建的 state DB 应使用 incremental auto-vacuum，但改造已存在的 DB
    // 需要执行完整 VACUUM。不要在进程启动阶段执行该操作：
    // 这属于维护工作，可能与前台 writer 产生竞争。
    open_sqlite(path, migrator, STATE_DB, telemetry_override).await
}

async fn open_logs_sqlite(
    path: &Path,
    migrator: &Migrator,
    telemetry_override: Option<&dyn DbTelemetry>,
) -> anyhow::Result<SqlitePool> {
    open_sqlite(path, migrator, LOGS_DB, telemetry_override).await
}

async fn open_goals_sqlite(
    path: &Path,
    migrator: &Migrator,
    telemetry_override: Option<&dyn DbTelemetry>,
) -> anyhow::Result<SqlitePool> {
    open_sqlite(path, migrator, GOALS_DB, telemetry_override).await
}

async fn open_memories_sqlite(
    path: &Path,
    migrator: &Migrator,
    telemetry_override: Option<&dyn DbTelemetry>,
) -> anyhow::Result<SqlitePool> {
    open_sqlite(path, migrator, MEMORIES_DB, telemetry_override).await
}

async fn open_sqlite(
    path: &Path,
    migrator: &Migrator,
    spec: RuntimeDbSpec,
    telemetry_override: Option<&dyn DbTelemetry>,
) -> anyhow::Result<SqlitePool> {
    let options = base_sqlite_options(path).auto_vacuum(SqliteAutoVacuum::Incremental);
    let started = Instant::now();
    let pool_result = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await
        .map_err(anyhow::Error::from);
    crate::telemetry::record_init_result(
        telemetry_override,
        spec.kind,
        spec.open_phase,
        started.elapsed(),
        &pool_result,
    );
    let pool = pool_result
        .map_err(|source| recovery::RuntimeDbInitError::new(spec.label, "open", path, source))?;
    let started = Instant::now();
    let migrate_result = async {
        if matches!(spec.kind, DbKind::State) {
            repair_legacy_recency_migration_version(&pool, migrator).await?;
        }
        migrator.run(&pool).await.map_err(anyhow::Error::from)
    }
    .await;
    crate::telemetry::record_init_result(
        telemetry_override,
        spec.kind,
        spec.migrate_phase,
        started.elapsed(),
        &migrate_result,
    );
    if let Err(source) = migrate_result {
        pool.close().await;
        return Err(recovery::RuntimeDbInitError::new(spec.label, "migrate", path, source).into());
    }
    Ok(pool)
}

pub(super) async fn ensure_backfill_state_row_in_pool(
    pool: &sqlx::SqlitePool,
) -> anyhow::Result<()> {
    // 提前检查操作是否会无效，避免在热点启动路径上无谓地等待 SQLite writer。
    if sqlx::query_scalar::<_, i64>("SELECT 1 FROM backfill_state WHERE id = 1")
        .fetch_optional(pool)
        .await?
        .is_some()
    {
        return Ok(());
    }

    sqlx::query(
        r#"
INSERT INTO backfill_state (id, status, last_watermark, last_success_at, updated_at)
VALUES (?, ?, NULL, NULL, ?)
ON CONFLICT(id) DO NOTHING
            "#,
    )
    .bind(1_i64)
    .bind(crate::BackfillStatus::Pending.as_str())
    .bind(Utc::now().timestamp())
    .execute(pool)
    .await?;
    Ok(())
}

/// 返回 state DB 的文件名。
pub fn state_db_filename() -> String {
    STATE_DB.filename.to_string()
}

/// 返回 state DB 在指定 Codex 主目录下的完整路径。
pub fn state_db_path(codex_home: &Path) -> PathBuf {
    STATE_DB.path(codex_home)
}

/// 返回 logs DB 的文件名。
pub fn logs_db_filename() -> String {
    LOGS_DB.filename.to_string()
}

/// 返回 logs DB 在指定 Codex 主目录下的完整路径。
pub fn logs_db_path(codex_home: &Path) -> PathBuf {
    LOGS_DB.path(codex_home)
}

/// 返回 goals DB 的文件名。
pub fn goals_db_filename() -> String {
    GOALS_DB.filename.to_string()
}

/// 返回 goals DB 在指定 Codex 主目录下的完整路径。
pub fn goals_db_path(codex_home: &Path) -> PathBuf {
    GOALS_DB.path(codex_home)
}

/// 返回 memories DB 的文件名。
pub fn memories_db_filename() -> String {
    MEMORIES_DB.filename.to_string()
}

/// 返回 memories DB 在指定 Codex 主目录下的完整路径。
pub fn memories_db_path(codex_home: &Path) -> PathBuf {
    MEMORIES_DB.path(codex_home)
}

/// 返回所有运行时 DB（state/logs/goals/memories）在指定 Codex 主目录下的路径列表。
pub fn runtime_db_paths(codex_home: &Path) -> Vec<RuntimeDbPath> {
    RUNTIME_DBS
        .iter()
        .map(|spec| RuntimeDbPath {
            label: spec.label,
            path: spec.path(codex_home),
        })
        .collect()
}

/// 对已存在的 DB 文件执行 SQLite 内置的 integrity check。
///
/// 以只读模式打开 DB 并执行 `PRAGMA integrity_check`，返回所有诊断信息行。
///
/// # 参数
/// - `path`: DB 文件路径
///
/// # 返回值
/// 返回诊断信息行列表；若打开或查询失败则返回 `Err`。
pub async fn sqlite_integrity_check(path: &Path) -> anyhow::Result<Vec<String>> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .read_only(true)
        .log_statements(LevelFilter::Off);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await?;
    let rows = sqlx::query_scalar::<_, String>("PRAGMA integrity_check")
        .fetch_all(&pool)
        .await?;
    pool.close().await;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::StateRuntime;
    use super::open_state_sqlite;
    use super::runtime_state_migrator;
    use super::sqlite_integrity_check;
    use super::state_db_path;
    use super::test_support::unique_temp_dir;
    use crate::DB_INIT_METRIC;
    use crate::DbTelemetry;
    use crate::migrations::STATE_MIGRATOR;
    use pretty_assertions::assert_eq;
    use sqlx::SqlitePool;
    use sqlx::migrate::MigrateError;
    use sqlx::sqlite::SqliteConnectOptions;
    use std::collections::BTreeMap;
    use std::collections::BTreeSet;
    use std::path::Path;
    use std::sync::Mutex;

    #[derive(Default)]
    struct TestTelemetry {
        counters: Mutex<Vec<MetricEvent>>,
    }

    #[derive(Debug, Eq, PartialEq)]
    struct MetricEvent {
        name: String,
        tags: BTreeMap<String, String>,
    }

    impl TestTelemetry {
        fn counters(&self) -> Vec<MetricEvent> {
            self.counters
                .lock()
                .expect("telemetry lock")
                .iter()
                .map(|event| MetricEvent {
                    name: event.name.clone(),
                    tags: event.tags.clone(),
                })
                .collect()
        }
    }

    impl DbTelemetry for TestTelemetry {
        fn counter(&self, name: &str, _inc: i64, tags: &[(&str, &str)]) {
            self.counters
                .lock()
                .expect("telemetry lock")
                .push(MetricEvent {
                    name: name.to_string(),
                    tags: tags_to_map(tags),
                });
        }

        fn record_duration(
            &self,
            _name: &str,
            _duration: std::time::Duration,
            _tags: &[(&str, &str)],
        ) {
        }
    }

    fn tags_to_map(tags: &[(&str, &str)]) -> BTreeMap<String, String> {
        tags.iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    async fn open_db_pool(path: &Path) -> SqlitePool {
        SqlitePool::connect_with(
            SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(false),
        )
        .await
        .expect("open sqlite pool")
    }

    #[tokio::test]
    async fn sqlite_integrity_check_reports_ok_for_valid_db() {
        let codex_home = unique_temp_dir();
        tokio::fs::create_dir_all(&codex_home)
            .await
            .expect("create codex home");
        let path = state_db_path(codex_home.as_path());
        let pool = SqlitePool::connect_with(
            SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true),
        )
        .await
        .expect("open sqlite db");
        sqlx::query("CREATE TABLE sample (id INTEGER PRIMARY KEY)")
            .execute(&pool)
            .await
            .expect("create sample table");
        pool.close().await;

        let result = sqlite_integrity_check(&path)
            .await
            .expect("integrity check should run");

        assert_eq!(result, vec!["ok".to_string()]);
        let _ = tokio::fs::remove_dir_all(codex_home).await;
    }

    #[tokio::test]
    async fn open_state_sqlite_tolerates_newer_applied_migrations() {
        let codex_home = unique_temp_dir();
        tokio::fs::create_dir_all(&codex_home)
            .await
            .expect("create codex home");
        let state_path = state_db_path(codex_home.as_path());
        let pool = SqlitePool::connect_with(
            SqliteConnectOptions::new()
                .filename(&state_path)
                .create_if_missing(true),
        )
        .await
        .expect("open state db");
        STATE_MIGRATOR
            .run(&pool)
            .await
            .expect("apply current state schema");
        sqlx::query(
            "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(9_999_i64)
        .bind("future migration")
        .bind(true)
        .bind(vec![1_u8, 2, 3, 4])
        .bind(1_i64)
        .execute(&pool)
        .await
        .expect("insert future migration record");
        pool.close().await;

        let strict_pool = open_db_pool(state_path.as_path()).await;
        let strict_err = STATE_MIGRATOR
            .run(&strict_pool)
            .await
            .expect_err("strict migrator should reject newer applied migrations");
        assert!(matches!(strict_err, MigrateError::VersionMissing(9_999)));
        strict_pool.close().await;

        let tolerant_migrator = runtime_state_migrator();
        let tolerant_pool = open_state_sqlite(
            state_path.as_path(),
            &tolerant_migrator,
            /*telemetry_override*/ None,
        )
        .await
        .expect("runtime migrator should tolerate newer applied migrations");
        tolerant_pool.close().await;

        let _ = tokio::fs::remove_dir_all(codex_home).await;
    }

    #[tokio::test]
    async fn init_records_successful_sqlite_init_phases_to_explicit_telemetry() {
        let codex_home = unique_temp_dir();
        let telemetry = TestTelemetry::default();

        let runtime = StateRuntime::init_with_telemetry_for_tests(
            codex_home.clone(),
            "test-provider".to_string(),
            &telemetry,
        )
        .await
        .expect("state runtime should initialize");

        let phases = telemetry
            .counters()
            .into_iter()
            .filter(|event| event.name == DB_INIT_METRIC)
            .filter(|event| event.tags.get("status").map(String::as_str) == Some("success"))
            .filter_map(|event| event.tags.get("phase").cloned())
            .collect::<BTreeSet<_>>();
        let expected = [
            "open_state",
            "migrate_state",
            "open_logs",
            "migrate_logs",
            "open_goals",
            "migrate_goals",
            "open_memories",
            "migrate_memories",
            "ensure_backfill_state",
            "post_init_query",
        ]
        .into_iter()
        .map(str::to_string)
        .collect::<BTreeSet<_>>();
        assert_eq!(phases, expected);

        runtime.pool.close().await;
        runtime.logs_pool.close().await;
        let _ = tokio::fs::remove_dir_all(codex_home).await;
    }
}
