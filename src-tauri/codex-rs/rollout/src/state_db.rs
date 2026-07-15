use crate::config::RolloutConfig;
use crate::config::RolloutConfigView;
use crate::list::Cursor;
use crate::list::SortDirection;
use crate::list::ThreadSortKey;
use crate::metadata;
use crate::sqlite_metrics;
use anyhow::Context;
use chrono::DateTime;
use chrono::Utc;
use codex_protocol::ThreadId;
use codex_protocol::protocol::RolloutItem;
use codex_protocol::protocol::SessionSource;
pub use codex_state::LogEntry;
use codex_state::ThreadMetadataBuilder;
use codex_utils_path::normalize_for_path_comparison;
use serde_json::Value;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;
use tracing::info;
use tracing::warn;

/// 面向核心的 SQLite 状态运行时句柄。
pub type StateDbHandle = Arc<codex_state::StateRuntime>;

#[cfg(not(test))]
const STARTUP_BACKFILL_POLL_INTERVAL: Duration = Duration::from_secs(1);
#[cfg(test)]
const STARTUP_BACKFILL_POLL_INTERVAL: Duration = Duration::from_millis(10);
#[cfg(not(test))]
const STARTUP_BACKFILL_WAIT_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(test)]
const STARTUP_BACKFILL_WAIT_TIMEOUT: Duration = Duration::from_secs(2);

/// 初始化用于 thread 状态持久化的状态运行时。
///
/// 这是本地状态的进程入口：打开 SQLite 支持的运行时，
/// 按需执行 rollout 元数据回填（backfill），并返回已初始化的句柄。
///
/// # 参数
/// - `config`: 配置视图引用
///
/// # 返回值
/// 返回初始化后的 [`StateDbHandle`]；若初始化失败则返回 `None`。
pub async fn init(config: &impl RolloutConfigView) -> Option<StateDbHandle> {
    let config = RolloutConfig::from_view(config);
    match try_init_with_roots(
        config.codex_home,
        config.sqlite_home,
        config.model_provider_id,
    )
    .await
    {
        Ok(runtime) => Some(runtime),
        Err(err) => {
            emit_startup_warning(&format!("failed to initialize state runtime: {err:#}"));
            None
        }
    }
}

/// 初始化状态运行时并将初始化错误返回给调用方。
///
/// 除非调用方需要在 tracing 或 UI 设置完成后暴露具体失败原因，
/// 否则应优先使用 [`init`]。
///
/// # 参数
/// - `config`: 配置视图引用
///
/// # 返回值
/// 返回初始化后的 [`StateDbHandle`]；若失败则返回 `Err`。
pub async fn try_init(config: &impl RolloutConfigView) -> anyhow::Result<StateDbHandle> {
    let config = RolloutConfig::from_view(config);
    try_init_with_roots(
        config.codex_home,
        config.sqlite_home,
        config.model_provider_id,
    )
    .await
}

async fn try_init_with_roots(
    codex_home: PathBuf,
    sqlite_home: PathBuf,
    default_model_provider_id: String,
) -> anyhow::Result<StateDbHandle> {
    try_init_with_roots_inner(
        codex_home,
        sqlite_home,
        default_model_provider_id,
        /*backfill_lease_seconds*/ None,
    )
    .await
}

#[cfg(test)]
async fn try_init_with_roots_and_backfill_lease(
    codex_home: PathBuf,
    sqlite_home: PathBuf,
    default_model_provider_id: String,
    backfill_lease_seconds: i64,
) -> anyhow::Result<StateDbHandle> {
    try_init_with_roots_inner(
        codex_home,
        sqlite_home,
        default_model_provider_id,
        Some(backfill_lease_seconds),
    )
    .await
}

async fn try_init_with_roots_inner(
    codex_home: PathBuf,
    sqlite_home: PathBuf,
    default_model_provider_id: String,
    backfill_lease_seconds: Option<i64>,
) -> anyhow::Result<StateDbHandle> {
    let runtime =
        codex_state::StateRuntime::init(sqlite_home.clone(), default_model_provider_id.clone())
            .await
            .with_context(|| {
                format!(
                    "failed to initialize state runtime at {}",
                    sqlite_home.display()
                )
            })?;
    let backfill_gate_started = Instant::now();
    let backfill_gate_result = wait_for_backfill_gate(
        runtime.as_ref(),
        codex_home.as_path(),
        default_model_provider_id.as_str(),
        backfill_lease_seconds,
    )
    .await;
    codex_state::record_backfill_gate(
        /*telemetry*/ None,
        backfill_gate_started.elapsed(),
        &backfill_gate_result,
    );
    if let Err(err) = backfill_gate_result {
        runtime.close().await;
        return Err(err);
    }
    Ok(runtime)
}

async fn wait_for_backfill_gate(
    runtime: &codex_state::StateRuntime,
    codex_home: &Path,
    default_model_provider_id: &str,
    backfill_lease_seconds: Option<i64>,
) -> anyhow::Result<()> {
    let wait_started = Instant::now();
    let mut reported_wait = false;
    loop {
        let backfill_state = runtime.get_backfill_state().await.map_err(|err| {
            anyhow::anyhow!(
                "failed to read backfill state at {}: {err}",
                codex_home.display()
            )
        })?;
        if backfill_state.status == codex_state::BackfillStatus::Complete {
            return Ok(());
        }

        if let Some(backfill_lease_seconds) = backfill_lease_seconds {
            metadata::backfill_sessions_with_lease(
                runtime,
                codex_home,
                default_model_provider_id,
                backfill_lease_seconds,
            )
            .await;
        } else {
            metadata::backfill_sessions(runtime, codex_home, default_model_provider_id).await;
        }
        let backfill_state = runtime.get_backfill_state().await.map_err(|err| {
            anyhow::anyhow!(
                "failed to read backfill state at {} after startup backfill: {err}",
                codex_home.display()
            )
        })?;
        if backfill_state.status == codex_state::BackfillStatus::Complete {
            return Ok(());
        }
        if wait_started.elapsed() >= STARTUP_BACKFILL_WAIT_TIMEOUT {
            return Err(anyhow::anyhow!(
                "timed out waiting for state db backfill at {} after {:?} (status: {})",
                codex_home.display(),
                STARTUP_BACKFILL_WAIT_TIMEOUT,
                backfill_state.status.as_str()
            ));
        }

        let message = format!(
            "state db backfill is {} at {}; waiting up to {:?} before retrying startup initialization",
            backfill_state.status.as_str(),
            codex_home.display(),
            STARTUP_BACKFILL_WAIT_TIMEOUT,
        );
        if reported_wait {
            info!("{message}");
        } else {
            emit_startup_warning(&message);
            reported_wait = true;
        }
        tokio::time::sleep(STARTUP_BACKFILL_POLL_INTERVAL).await;
    }
}

fn emit_startup_warning(message: &str) {
    warn!("{message}");
    if !tracing::dispatcher::has_been_set() {
        #[allow(clippy::print_stderr)]
        {
            eprintln!("{message}");
        }
    }
}

/// 若 DB 已存在且启动回填已完成，则打开 DB。
///
/// 与 [`init`] 不同，该辅助函数不会执行 rollout 回填。
/// 它适用于非拥有上下文中的可选本地读取，例如远程 app-server 模式。
///
/// # 参数
/// - `config`: 配置视图引用
///
/// # 返回值
/// 返回 [`StateDbHandle`]；若 DB 不存在或回填未完成则返回 `None`。
pub async fn get_state_db(config: &impl RolloutConfigView) -> Option<StateDbHandle> {
    let state_path = codex_state::state_db_path(config.sqlite_home());
    if !tokio::fs::try_exists(&state_path).await.unwrap_or(false) {
        codex_state::record_fallback(
            "get_state_db",
            "db_unavailable",
            /*telemetry_override*/ None,
        );
        return None;
    }
    let runtime = match codex_state::StateRuntime::init(
        config.sqlite_home().to_path_buf(),
        config.model_provider_id().to_string(),
    )
    .await
    {
        Ok(runtime) => runtime,
        Err(_) => {
            codex_state::record_fallback(
                "get_state_db",
                "db_error",
                /*telemetry_override*/ None,
            );
            return None;
        }
    };
    require_backfill_complete(runtime, config.sqlite_home()).await
}

/// 构造一个由 OTEL metrics client 支持的 SQLite 遥测记录器。
///
/// # 参数
/// - `otel`: 可选的 OTEL metrics client
///
/// # 返回值
/// 返回一个闭包，用于记录 SQLite 指标。
pub fn sqlite_telemetry_recorder(
    metrics: codex_otel::MetricsClient,
    originator: &str,
) -> codex_state::DbTelemetryHandle {
    sqlite_metrics::recorder(metrics, originator)
}

async fn require_backfill_complete(
    runtime: StateDbHandle,
    codex_home: &Path,
) -> Option<StateDbHandle> {
    match runtime.get_backfill_state().await {
        Ok(state) if state.status == codex_state::BackfillStatus::Complete => Some(runtime),
        Ok(state) => {
            warn!(
                "state db backfill not complete at {} (status: {})",
                codex_home.display(),
                state.status.as_str()
            );
            codex_state::record_fallback(
                "get_state_db",
                "backfill_incomplete",
                /*telemetry_override*/ None,
            );
            None
        }
        Err(err) => {
            warn!(
                "failed to read backfill state at {}: {err}",
                codex_home.display()
            );
            codex_state::record_fallback(
                "get_state_db",
                "db_error",
                /*telemetry_override*/ None,
            );
            None
        }
    }
}

fn cursor_to_anchor(cursor: Option<&Cursor>) -> Option<codex_state::Anchor> {
    let cursor = cursor?;
    let millis = cursor.timestamp().unix_timestamp_nanos() / 1_000_000;
    let millis = i64::try_from(millis).ok()?;
    let ts = chrono::DateTime::<Utc>::from_timestamp_millis(millis)?;
    Some(codex_state::Anchor {
        ts,
        id: cursor.thread_id(),
    })
}

/// 规范化工作目录路径，便于 state DB 中的一致性比较。
///
/// # 参数
/// - `cwd`: 原始工作目录路径
///
/// # 返回值
/// 返回规范化后的路径；若规范化失败则返回原始路径。
pub fn normalize_cwd_for_state_db(cwd: &Path) -> PathBuf {
    normalize_for_path_comparison(cwd).unwrap_or_else(|_| cwd.to_path_buf())
}

/// 从 SQLite 列出 thread ID，用于一致性校验，无需扫描 rollout 目录。
///
/// # 参数
/// - `state_db`: state DB 句柄
/// - `codex_home`: Codex 主目录
/// - `archived_only`: 是否仅列出已归档 thread
/// - `allowed_sources`: 允许的会话来源
/// - `model_providers`: 可选的模型 provider 过滤列表
/// - `cwd_filters`: 可选的工作目录过滤列表
/// - `default_provider`: 默认模型 provider ID
/// - `sort_key`: 排序键
/// - `direction`: 排序方向
/// - `limit`: 返回条数上限
///
/// # 返回值
/// 返回 thread ID 列表；若发生错误则返回 `Err`。
#[allow(clippy::too_many_arguments)]
pub async fn list_thread_ids_db(
    context: Option<&codex_state::StateRuntime>,
    codex_home: &Path,
    page_size: usize,
    cursor: Option<&Cursor>,
    sort_key: ThreadSortKey,
    allowed_sources: &[SessionSource],
    model_providers: Option<&[String]>,
    archived_only: bool,
    stage: &str,
) -> Option<Vec<ThreadId>> {
    let ctx = context?;
    if ctx.codex_home() != codex_home {
        warn!(
            "state db codex_home mismatch: expected {}, got {}",
            ctx.codex_home().display(),
            codex_home.display()
        );
    }

    let anchor = cursor_to_anchor(cursor);
    let allowed_sources: Vec<String> = allowed_sources
        .iter()
        .map(|value| match serde_json::to_value(value) {
            Ok(Value::String(s)) => s,
            Ok(other) => other.to_string(),
            Err(_) => String::new(),
        })
        .collect();
    let model_providers = model_providers.map(<[String]>::to_vec);
    match ctx
        .list_thread_ids(
            page_size,
            anchor.as_ref(),
            match sort_key {
                ThreadSortKey::CreatedAt => codex_state::SortKey::CreatedAt,
                ThreadSortKey::UpdatedAt => codex_state::SortKey::UpdatedAt,
                ThreadSortKey::RecencyAt => codex_state::SortKey::RecencyAt,
            },
            allowed_sources.as_slice(),
            model_providers.as_deref(),
            archived_only,
        )
        .await
    {
        Ok(ids) => Some(ids),
        Err(err) => {
            warn!("state db list_thread_ids failed during {stage}: {err}");
            None
        }
    }
}

/// 从 SQLite 列出 thread 元数据，无需遍历 rollout 目录。
///
/// # 参数
/// - `context`: 可选的 state DB 运行时上下文
/// - `codex_home`: Codex 主目录
/// - `page_size`: 单页大小
/// - `cursor`: 可选的分页游标
/// - `sort_key`: 排序键
/// - `allowed_sources`: 允许的会话来源
/// - `model_providers`: 可选的模型 provider 过滤列表
/// - `cwd_filters`: 可选的工作目录过滤列表
/// - `default_provider`: 默认模型 provider ID
///
/// # 返回值
/// 返回 [`ThreadsPage`]；若发生错误则返回 `Err`。
#[allow(clippy::too_many_arguments)]
pub async fn list_threads_db(
    context: Option<&codex_state::StateRuntime>,
    codex_home: &Path,
    page_size: usize,
    cursor: Option<&Cursor>,
    sort_key: ThreadSortKey,
    sort_direction: SortDirection,
    allowed_sources: &[SessionSource],
    model_providers: Option<&[String]>,
    cwd_filters: Option<&[PathBuf]>,
    relation_filter: Option<codex_state::ThreadRelationFilter>,
    archived: bool,
    search_term: Option<&str>,
) -> Option<codex_state::ThreadsPage> {
    let ctx = context?;
    if ctx.codex_home() != codex_home {
        warn!(
            "state db codex_home mismatch: expected {}, got {}",
            ctx.codex_home().display(),
            codex_home.display()
        );
    }

    let anchor = cursor_to_anchor(cursor);
    let allowed_sources: Vec<String> = allowed_sources
        .iter()
        .map(|value| match serde_json::to_value(value) {
            Ok(Value::String(s)) => s,
            Ok(other) => other.to_string(),
            Err(_) => String::new(),
        })
        .collect();
    let model_providers = model_providers.map(<[String]>::to_vec);
    let normalized_cwd_filters = cwd_filters.map(|filters| {
        filters
            .iter()
            .map(|cwd| normalize_cwd_for_state_db(cwd))
            .collect::<Vec<_>>()
    });
    let filters = codex_state::ThreadFilterOptions {
        archived_only: archived,
        allowed_sources: allowed_sources.as_slice(),
        model_providers: model_providers.as_deref(),
        cwd_filters: normalized_cwd_filters.as_deref(),
        anchor: anchor.as_ref(),
        sort_key: match sort_key {
            ThreadSortKey::CreatedAt => codex_state::SortKey::CreatedAt,
            ThreadSortKey::UpdatedAt => codex_state::SortKey::UpdatedAt,
            ThreadSortKey::RecencyAt => codex_state::SortKey::RecencyAt,
        },
        sort_direction: match sort_direction {
            SortDirection::Asc => codex_state::SortDirection::Asc,
            SortDirection::Desc => codex_state::SortDirection::Desc,
        },
        search_term,
    };
    let page = match relation_filter {
        Some(relation_filter) => {
            ctx.list_threads_by_relation(page_size, relation_filter, filters)
                .await
        }
        None => ctx.list_threads(page_size, filters).await,
    };
    match page {
        Ok(mut page) => {
            // Relationship-filtered listings intentionally treat persisted state as authoritative.
            if relation_filter.is_some() {
                return Some(page);
            }
            let mut valid_items = Vec::with_capacity(page.items.len());
            for item in page.items {
                if let Some(existing_path) =
                    crate::compression::existing_rollout_path(item.rollout_path.as_path()).await
                {
                    let mut item = item;
                    item.rollout_path = existing_path;
                    valid_items.push(item);
                } else {
                    warn!(
                        "state db list_threads returned stale rollout path for thread {}: {}",
                        item.id,
                        item.rollout_path.display()
                    );
                    warn!("state db discrepancy during list_threads_db: stale_db_path_dropped");
                    let _ = ctx.delete_thread(item.id).await;
                }
            }
            page.items = valid_items;
            Some(page)
        }
        Err(err) => {
            warn!("state db list_threads failed: {err}");
            None
        }
    }
}

/// 通过 thread ID 在 SQLite 中查找对应的 rollout 路径。
///
/// # 参数
/// - `state_db`: state DB 句柄
/// - `thread_id`: thread ID
/// - `archived_only`: 是否仅查找已归档 thread
///
/// # 返回值
/// 返回 rollout 路径；若未找到则返回 `Ok(None)`；发生错误则返回 `Err`。
pub async fn find_rollout_path_by_id(
    context: Option<&codex_state::StateRuntime>,
    thread_id: ThreadId,
    archived_only: Option<bool>,
    stage: &str,
) -> Option<PathBuf> {
    let ctx = context?;
    ctx.find_rollout_path_by_id(thread_id, archived_only)
        .await
        .unwrap_or_else(|err| {
            warn!("state db find_rollout_path_by_id failed during {stage}: {err}");
            None
        })
}

/// 标记指定 thread 的 memory mode 已被污染。
///
/// # 参数
/// - `context`: 可选的 state DB 运行时上下文
/// - `thread_id`: thread ID
/// - `stage`: 调用阶段标识，用于日志
pub async fn mark_thread_memory_mode_polluted(
    context: Option<&codex_state::StateRuntime>,
    thread_id: ThreadId,
    stage: &str,
) {
    let Some(ctx) = context else {
        return;
    };
    if let Err(err) = ctx
        .memories()
        .mark_thread_memory_mode_polluted(thread_id)
        .await
    {
        warn!("memories db mark_thread_memory_mode_polluted failed during {stage}: {err}");
    }
}

/// 将 rollout item 协调写入 SQLite，必要时回退到扫描 rollout 文件。
///
/// # 参数
/// - `state_db`: 可选的 state DB 运行时上下文
/// - `rollout_path`: rollout 文件路径
/// - `thread_id`: thread ID
/// - `default_provider`: 默认模型 provider ID
///
/// # 返回值
/// 返回 `Ok(())` 表示成功；发生错误则返回 `Err`。
pub async fn reconcile_rollout(
    context: Option<&codex_state::StateRuntime>,
    rollout_path: &Path,
    default_provider: &str,
    builder: Option<&ThreadMetadataBuilder>,
    items: &[RolloutItem],
    archived_only: Option<bool>,
    new_thread_memory_mode: Option<&str>,
) {
    let Some(ctx) = context else {
        return;
    };
    if builder.is_some() || !items.is_empty() {
        apply_rollout_items(
            Some(ctx),
            rollout_path,
            default_provider,
            builder,
            items,
            "reconcile_rollout",
            new_thread_memory_mode,
            /*updated_at_override*/ None,
        )
        .await;
        return;
    }
    let outcome =
        match metadata::extract_metadata_from_rollout(rollout_path, default_provider).await {
            Ok(outcome) => outcome,
            Err(err) => {
                warn!(
                    "state db reconcile_rollout extraction failed {}: {err}",
                    rollout_path.display()
                );
                return;
            }
        };
    let mut metadata = outcome.metadata;
    let memory_mode = outcome.memory_mode.unwrap_or_else(|| "enabled".to_string());
    metadata.cwd = normalize_cwd_for_state_db(&metadata.cwd);
    if let Ok(Some(existing_metadata)) = ctx.get_thread(metadata.id).await {
        metadata.prefer_existing_git_info(&existing_metadata);
        metadata.prefer_existing_explicit_title(&existing_metadata);
    }
    match archived_only {
        Some(true) if metadata.archived_at.is_none() => {
            metadata.archived_at = Some(metadata.updated_at);
        }
        Some(false) => {
            metadata.archived_at = None;
        }
        Some(true) | None => {}
    }
    if let Err(err) = ctx.upsert_thread(&metadata).await {
        warn!(
            "state db reconcile_rollout upsert failed {}: {err}",
            rollout_path.display()
        );
        return;
    }
    if let Err(err) = ctx
        .set_thread_memory_mode(metadata.id, memory_mode.as_str())
        .await
    {
        warn!(
            "state db reconcile_rollout memory_mode update failed {}: {err}",
            rollout_path.display()
        );
    }
}

/// 在文件系统回退成功后修复 thread 的 rollout 路径。
///
/// # 参数
/// - `state_db`: 可选的 state DB 运行时上下文
/// - `thread_id`: thread ID（可选）
/// - `archived_only`: 是否仅查找已归档 thread
/// - `found_path`: 文件系统中实际找到的路径
pub async fn read_repair_rollout_path(
    context: Option<&codex_state::StateRuntime>,
    thread_id: Option<ThreadId>,
    archived_only: Option<bool>,
    rollout_path: &Path,
) {
    let Some(ctx) = context else {
        return;
    };

    // Fast path: update an existing metadata row in place, but avoid writes when
    // read-repair computes no effective change.
    let mut saw_existing_metadata = false;
    if let Some(thread_id) = thread_id
        && let Ok(Some(metadata)) = ctx.get_thread(thread_id).await
    {
        saw_existing_metadata = true;
        let mut repaired = metadata.clone();
        repaired.rollout_path = rollout_path.to_path_buf();
        repaired.cwd = normalize_cwd_for_state_db(&repaired.cwd);
        match archived_only {
            Some(true) if repaired.archived_at.is_none() => {
                repaired.archived_at = Some(repaired.updated_at);
            }
            Some(false) => {
                repaired.archived_at = None;
            }
            Some(true) | None => {}
        }
        if repaired == metadata {
            return;
        }
        warn!("state db discrepancy during read_repair_rollout_path: upsert_needed (fast path)");
        if let Err(err) = ctx.upsert_thread(&repaired).await {
            warn!(
                "state db read-repair upsert failed for {}: {err}",
                rollout_path.display()
            );
        } else {
            return;
        }
    }

    // Slow path: when the row is missing/unreadable (or direct upsert failed),
    // rebuild metadata from rollout contents and reconcile it into SQLite.
    if !saw_existing_metadata {
        warn!("state db discrepancy during read_repair_rollout_path: upsert_needed (slow path)");
    }
    let default_provider = crate::list::read_session_meta_line(rollout_path)
        .await
        .ok()
        .and_then(|meta| meta.meta.model_provider)
        .unwrap_or_default();
    reconcile_rollout(
        Some(ctx),
        rollout_path,
        default_provider.as_str(),
        /*builder*/ None,
        &[],
        archived_only,
        /*new_thread_memory_mode*/ None,
    )
    .await;
}

/// 将 rollout item 增量应用到 SQLite。
///
/// # 参数
/// - `context`: 可选的 state DB 运行时上下文
/// - `rollout_path`: rollout 文件路径
/// - `items`: rollout item 切片
/// - `default_provider`: 默认模型 provider ID
/// - `stage`: 调用阶段标识，用于日志
/// - `builder`: 可选的 thread 元数据构造器
/// - `new_thread_memory_mode`: 可选的新 thread memory mode
/// - `updated_at_override`: 可选的 updated_at 覆盖值
///
/// # 返回值
/// 返回 `Ok(())` 表示成功；发生错误则返回 `Err`。
#[allow(clippy::too_many_arguments)]
pub async fn apply_rollout_items(
    context: Option<&codex_state::StateRuntime>,
    rollout_path: &Path,
    default_provider: &str,
    builder: Option<&ThreadMetadataBuilder>,
    items: &[RolloutItem],
    stage: &str,
    new_thread_memory_mode: Option<&str>,
    updated_at_override: Option<DateTime<Utc>>,
) {
    let Some(ctx) = context else {
        return;
    };
    let mut builder = match builder {
        Some(builder) => builder.clone(),
        None => match metadata::builder_from_items(items, rollout_path) {
            Some(builder) => builder,
            None => {
                warn!(
                    "state db apply_rollout_items missing builder during {stage}: {}",
                    rollout_path.display()
                );
                warn!("state db discrepancy during apply_rollout_items: {stage}, missing_builder");
                return;
            }
        },
    };
    if builder.model_provider.is_none() {
        builder.model_provider = Some(default_provider.to_string());
    }
    builder.rollout_path = rollout_path.to_path_buf();
    builder.cwd = normalize_cwd_for_state_db(&builder.cwd);
    if let Err(err) = ctx
        .apply_rollout_items(&builder, items, new_thread_memory_mode, updated_at_override)
        .await
    {
        warn!(
            "state db apply_rollout_items failed during {stage} for {}: {err}",
            rollout_path.display()
        );
    }
}

/// 更新指定 thread 的 `updated_at` 时间戳。
///
/// # 参数
/// - `context`: 可选的 state DB 运行时上下文
/// - `thread_id`: 可选的 thread ID
/// - `updated_at`: 新的 `updated_at` 时间戳
/// - `stage`: 调用阶段标识，用于日志
///
/// # 返回值
/// 返回 `true` 表示更新成功；否则返回 `false`。
pub async fn touch_thread_updated_at(
    context: Option<&codex_state::StateRuntime>,
    thread_id: Option<ThreadId>,
    updated_at: DateTime<Utc>,
    stage: &str,
) -> bool {
    let Some(ctx) = context else {
        return false;
    };
    let Some(thread_id) = thread_id else {
        return false;
    };
    ctx.touch_thread_updated_at(thread_id, updated_at)
        .await
        .unwrap_or_else(|err| {
            warn!("state db touch_thread_updated_at failed during {stage} for {thread_id}: {err}");
            false
        })
}

#[cfg(test)]
#[path = "state_db_tests.rs"]
mod tests;
