//! 基于 SQLite 的 rollout 元数据状态管理。
//!
//! 本 crate 故意保持精简与聚焦：从 JSONL rollout 中提取元数据，
//! 并将其镜像到本地 SQLite 数据库。回填编排与 rollout 扫描逻辑位于 `codex-core`。

const _: () = assert!(
    libsqlite3_sys::SQLITE_VERSION_NUMBER >= 3_051_003,
    "bundled SQLite must include the WAL-reset corruption fix",
);

mod audit;
mod extract;
pub mod log_db;
mod migrations;
mod model;
mod paths;
mod runtime;
mod telemetry;

pub use model::LogEntry;
pub use model::LogQuery;
pub use model::LogRow;
pub use model::Phase2JobClaimOutcome;
/// 首选入口：拥有配置与 metrics。
pub use runtime::StateRuntime;

pub use audit::ThreadStateAuditRow;
pub use audit::read_thread_state_audit_rows;
/// 低层存储引擎：适用于针对性测试。
///
/// 大多数消费者应优先使用 [`StateRuntime`]。
pub use extract::apply_rollout_item;
pub use extract::rollout_item_affects_thread_metadata;
pub use model::AgentJob;
pub use model::AgentJobCreateParams;
pub use model::AgentJobItem;
pub use model::AgentJobItemCreateParams;
pub use model::AgentJobItemStatus;
pub use model::AgentJobProgress;
pub use model::AgentJobStatus;
pub use model::Anchor;
pub use model::BackfillState;
pub use model::BackfillStats;
pub use model::BackfillStatus;
pub use model::DirectionalThreadSpawnEdgeStatus;
pub use model::ExtractionOutcome;
pub use model::SortDirection;
pub use model::SortKey;
pub use model::Stage1JobClaim;
pub use model::Stage1JobClaimOutcome;
pub use model::Stage1Output;
pub use model::Stage1StartupClaimParams;
pub use model::ThreadGoal;
pub use model::ThreadGoalStatus;
pub use model::ThreadMetadata;
pub use model::ThreadMetadataBuilder;
pub use model::ThreadRelationFilter;
pub use model::ThreadsPage;
pub use runtime::ExternalAgentConfigImportDetailsRecord;
pub use runtime::ExternalAgentConfigImportFailureRecord;
pub use runtime::ExternalAgentConfigImportHistoryRecord;
pub use runtime::ExternalAgentConfigImportSuccessRecord;
pub use runtime::GoalAccountingMode;
pub use runtime::GoalAccountingOutcome;
pub use runtime::GoalStore;
pub use runtime::GoalUpdate;
pub use runtime::MemoryStore;
pub use runtime::RemoteControlEnrollmentRecord;
pub use runtime::RuntimeDbBackup;
pub use runtime::RuntimeDbPath;
pub use runtime::ThreadFilterOptions;
pub use runtime::backup_runtime_db_for_fresh_start;
pub use runtime::goals_db_filename;
pub use runtime::goals_db_path;
pub use runtime::is_sqlite_corruption_error;
pub use runtime::logs_db_filename;
pub use runtime::logs_db_path;
pub use runtime::memories_db_filename;
pub use runtime::memories_db_path;
pub use runtime::runtime_db_path_for_corruption_error;
pub use runtime::runtime_db_paths;
pub use runtime::sqlite_error_detail_is_corruption;
pub use runtime::sqlite_error_detail_is_lock;
pub use runtime::sqlite_integrity_check;
pub use runtime::state_db_filename;
pub use runtime::state_db_path;
pub use telemetry::DbTelemetry;
pub use telemetry::DbTelemetryHandle;
pub use telemetry::install_process_db_telemetry;
pub use telemetry::record_backfill_gate;
pub use telemetry::record_fallback;

/// 用于覆盖 SQLite 状态数据库主目录的环境变量。
pub const SQLITE_HOME_ENV: &str = "CODEX_SQLITE_HOME";

/// logs 数据库文件名。
pub const LOGS_DB_FILENAME: &str = "logs_2.sqlite";
/// goals 数据库文件名。
pub const GOALS_DB_FILENAME: &str = "goals_1.sqlite";
/// memories 数据库文件名。
pub const MEMORIES_DB_FILENAME: &str = "memories_1.sqlite";
/// state 数据库文件名。
pub const STATE_DB_FILENAME: &str = "state_5.sqlite";

/// DB 操作过程中遇到的错误。Tags: [stage]
pub const DB_ERROR_METRIC: &str = "codex.db.error";
/// 回填过程相关指标。Tags: [status]
pub const DB_METRIC_BACKFILL: &str = "codex.db.backfill";
/// 回填耗时指标。Tags: [status]
pub const DB_METRIC_BACKFILL_DURATION_MS: &str = "codex.db.backfill.duration_ms";
/// SQLite 初始化尝试次数。Tags: [status, phase, db, error]
pub const DB_INIT_METRIC: &str = "codex.sqlite.init.count";
/// SQLite 初始化延迟。Tags: [status, phase, db, error]
pub const DB_INIT_DURATION_METRIC: &str = "codex.sqlite.init.duration_ms";
/// Rollout 回退尝试次数。Tags: [caller, reason]
pub const DB_FALLBACK_METRIC: &str = "codex.sqlite.fallback.count";
