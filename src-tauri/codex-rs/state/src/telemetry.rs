//! SQLite 启动与回退相关的低基数 telemetry sink。
//!
//! 该模块定义 [`DbTelemetry`] trait 与若干记录函数，用于在 SQLite 启动、
//! 迁移、回填或回退时输出低基数指标。指标投递失败不应影响数据库行为。

use std::borrow::Cow;
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;

use crate::DB_FALLBACK_METRIC;
use crate::DB_INIT_DURATION_METRIC;
use crate::DB_INIT_METRIC;
use tracing::debug;

/// SQLite 启动与回退 telemetry 的低基数 sink trait。
///
/// 实现应在本地吞掉投递失败，数据库行为不得依赖于 telemetry 是否成功导出。
pub trait DbTelemetry: Send + Sync + 'static {
    fn counter(&self, name: &str, inc: i64, tags: &[(&str, &str)]);
    fn record_duration(&self, name: &str, duration: Duration, tags: &[(&str, &str)]);
}

/// 进程级 telemetry sink 句柄。
pub type DbTelemetryHandle = Arc<dyn DbTelemetry>;

static PROCESS_DB_TELEMETRY: OnceLock<DbTelemetryHandle> = OnceLock::new();

/// 安装进程级 SQLite telemetry sink。
///
/// 启动拥有者应在 OTEL 初始化后调用一次。底层 DB 路径会使用已注册的 sink，
/// 除非显式提供 sink。重复安装会被忽略并保留首个已安装的 sink。
///
/// # 参数
/// - `telemetry`: telemetry sink 句柄
///
/// # 返回值
/// 首次安装返回 `true`；若已有 sink 则返回 `false`。
pub fn install_process_db_telemetry(telemetry: DbTelemetryHandle) -> bool {
    if PROCESS_DB_TELEMETRY.set(telemetry).is_ok() {
        true
    } else {
        debug!("process SQLite telemetry sink already installed; ignoring duplicate install");
        false
    }
}

/// 运行时 DB 类型枚举，用于 telemetry tag。
#[derive(Clone, Copy)]
pub(crate) enum DbKind {
    State,
    Logs,
    Goals,
    Memories,
}

impl DbKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::State => "state",
            Self::Logs => "logs",
            Self::Goals => "goals",
            Self::Memories => "memories",
        }
    }
}

/// 记录一次 DB 初始化结果（含状态、阶段、DB kind、错误分类）。
pub(crate) fn record_init_result<T>(
    telemetry: Option<&dyn DbTelemetry>,
    db: DbKind,
    phase: &'static str,
    duration: Duration,
    result: &anyhow::Result<T>,
) {
    let outcome = DbOutcomeTags::from_result(result);
    let tags = [
        ("status", outcome.status),
        ("phase", phase),
        ("db", db.as_str()),
        ("error", outcome.error),
    ];
    record_counter(telemetry, DB_INIT_METRIC, &tags);
    record_duration(telemetry, DB_INIT_DURATION_METRIC, duration, &tags);
}

/// 记录回填闸门的一次结果与耗时。
pub fn record_backfill_gate(
    telemetry: Option<&dyn DbTelemetry>,
    duration: Duration,
    result: &anyhow::Result<()>,
) {
    record_init_result(telemetry, DbKind::State, "backfill_gate", duration, result);
}

/// 记录一次 DB 回退事件。
///
/// # 参数
/// - `caller`: 调用方标识
/// - `reason`: 回退原因
/// - `telemetry_override`: 可选的显式 telemetry sink
pub fn record_fallback(
    caller: &'static str,
    reason: &'static str,
    telemetry_override: Option<&dyn DbTelemetry>,
) {
    record_counter(
        telemetry_override,
        DB_FALLBACK_METRIC,
        &[("caller", caller), ("reason", reason)],
    );
}

fn record_counter(telemetry: Option<&dyn DbTelemetry>, name: &str, tags: &[(&str, &str)]) {
    if let Some(telemetry) = resolve_telemetry(telemetry) {
        telemetry.counter(name, /*inc*/ 1, tags);
    }
}

fn record_duration(
    telemetry: Option<&dyn DbTelemetry>,
    name: &str,
    duration: Duration,
    tags: &[(&str, &str)],
) {
    if let Some(telemetry) = resolve_telemetry(telemetry) {
        telemetry.record_duration(name, duration, tags);
    }
}

fn resolve_telemetry(telemetry: Option<&dyn DbTelemetry>) -> Option<&dyn DbTelemetry> {
    telemetry.or_else(|| PROCESS_DB_TELEMETRY.get().map(AsRef::as_ref))
}

/// DB 操作结果的低基数 tag 集合。
struct DbOutcomeTags {
    status: &'static str,
    error: &'static str,
}

impl DbOutcomeTags {
    fn from_result<T>(result: &anyhow::Result<T>) -> Self {
        match result {
            Ok(_) => Self {
                status: "success",
                error: "none",
            },
            Err(err) => Self {
                status: "failed",
                error: classify_error(err),
            },
        }
    }
}

fn classify_error(err: &anyhow::Error) -> &'static str {
    for cause in err.chain() {
        if let Some(sqlx_err) = cause.downcast_ref::<sqlx::Error>() {
            return classify_sqlx_error(sqlx_err);
        }
        if cause
            .downcast_ref::<sqlx::migrate::MigrateError>()
            .is_some()
        {
            return "migration";
        }
        if cause.downcast_ref::<serde_json::Error>().is_some() {
            return "serde";
        }
        if cause.downcast_ref::<std::io::Error>().is_some() {
            return "io";
        }
    }
    "unknown"
}

fn classify_sqlx_error(err: &sqlx::Error) -> &'static str {
    match err {
        sqlx::Error::Database(database_error) => {
            let code = database_error
                .code()
                .unwrap_or(Cow::Borrowed("none"))
                .to_string();
            classify_sqlite_code(code.as_str())
        }
        sqlx::Error::PoolTimedOut => "pool_timeout",
        sqlx::Error::Io(_) => "io",
        sqlx::Error::ColumnDecode { source, .. } if source.is::<serde_json::Error>() => "serde",
        sqlx::Error::Decode(source) if source.is::<serde_json::Error>() => "serde",
        _ => "unknown",
    }
}

fn classify_sqlite_code(code: &str) -> &'static str {
    // SQLite 结果码见 https://www.sqlite.org/rescode.html。
    // 扩展码在低字节保留主码。
    let primary_code = code.parse::<i32>().ok().map(|code| code & 0xff);
    match primary_code {
        Some(5) => "busy",
        Some(6) => "locked",
        Some(8) => "readonly",
        Some(10) => "io",
        Some(11) => "corrupt",
        Some(13) => "full",
        Some(14) => "cantopen",
        Some(17) => "schema",
        Some(19) => "constraint",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn classifies_extended_sqlite_codes() {
        assert_eq!(classify_sqlite_code("5"), "busy");
        assert_eq!(classify_sqlite_code("6"), "locked");
        assert_eq!(classify_sqlite_code("2067"), "constraint");
    }
}
