//! memories 启动期任务入口。
//!
//! 该模块根据 session 类型与 feature flag 决定是否启动 memory 流水线，
//! 并按顺序触发 Phase 1 与 Phase 2。

use crate::extensions::seed_extension_instructions;
use crate::guard;
use crate::memory_root;
use crate::metrics::MEMORY_STARTUP;
use crate::phase1;
use crate::phase2;
use crate::runtime::MemoryStartupContext;
use codex_core::CodexThread;
use codex_core::ThreadManager;
use codex_core::config::Config;
use codex_features::Feature;
use codex_login::AuthManager;
use codex_protocol::ThreadId;
use codex_protocol::protocol::SessionSource;
use std::sync::Arc;
use tracing::warn;

/// 为符合条件的 root session 启动异步 memory 流水线。
///
/// 跳过条件：
/// - ephemeral session（临时会话）
/// - 未启用 `MemoryTool` feature
/// - subagent session（非 root agent）
pub fn start_memories_startup_task(
    thread_manager: Arc<ThreadManager>,
    auth_manager: Arc<AuthManager>,
    thread_id: ThreadId,
    thread: Arc<CodexThread>,
    config: Arc<Config>,
    source: &SessionSource,
) {
    // 跳过 ephemeral、未启用 MemoryTool 或 subagent session。
    if config.ephemeral
        || !config.features.enabled(Feature::MemoryTool)
        || source.is_non_root_agent()
    {
        return;
    }

    let context = Arc::new(MemoryStartupContext::new(
        thread_manager,
        Arc::clone(&auth_manager),
        thread_id,
        thread,
        config.as_ref(),
        source.clone(),
    ));

    // state db 不可用时跳过整个流水线。
    if context.state_db().is_none() {
        warn!("state db unavailable for memories startup pipeline; skipping");
        return;
    }

    tokio::spawn(async move {
        let root = memory_root(&config.codex_home);
        // 创建 memories 根目录。
        if let Err(err) = tokio::fs::create_dir_all(&root).await {
            warn!("failed creating memories root: {err}");
            return;
        }
        // 注入 extension instructions 默认文件。
        if let Err(err) = seed_extension_instructions(&root).await {
            warn!("failed seeding memory extension instructions: {err}");
        }

        // 先修剪过期 memory 以控制 DB 体积。该操作不消耗 token，可在 quota 检查前执行。
        phase1::prune(context.as_ref(), &config).await;

        // 限流检查：剩余配额不足时跳过本次启动。
        if !guard::rate_limits_ok(&auth_manager, &config).await {
            context.counter(
                MEMORY_STARTUP,
                /*inc*/ 1,
                &[("status", "skipped_rate_limit")],
            );
            return;
        }

        // 依次执行 Phase 1 与 Phase 2。
        phase1::run(Arc::clone(&context), Arc::clone(&config)).await;
        phase2::run(context, config).await;
    });
}
