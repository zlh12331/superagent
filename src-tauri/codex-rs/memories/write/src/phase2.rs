//! Phase 2（consolidation）实现。
//!
//! 该模块按严格步骤顺序执行 memory Phase 2：claim 全局 Phase 2 锁、同步 workspace
//! 输入、计算 workspace diff、生成 consolidation agent 配置、spawn agent 并处理心跳与
//! 完成回调。

use crate::build_consolidation_prompt;
use crate::memory_root;
use crate::metrics::MEMORY_PHASE_TWO_E2E_MS;
use crate::metrics::MEMORY_PHASE_TWO_INPUT;
use crate::metrics::MEMORY_PHASE_TWO_JOBS;
use crate::metrics::MEMORY_PHASE_TWO_TOKEN_USAGE;
use crate::prune_old_extension_resources;
use crate::rebuild_raw_memories_file_from_memories;
use crate::runtime::MemoryStartupContext;
use crate::runtime::SpawnedConsolidationAgent;
use crate::sync_rollout_summaries_from_memories;
use crate::workspace::memory_workspace_diff;
use crate::workspace::prepare_memory_workspace;
use crate::workspace::reset_memory_workspace_baseline;
use crate::workspace::write_workspace_diff;
use codex_config::Constrained;
use codex_core::config::Config;
use codex_features::Feature;
use codex_model_provider::ModelProvider;
use codex_protocol::ThreadId;
use codex_protocol::protocol::AgentStatus;
use codex_protocol::protocol::AskForApproval;
use codex_protocol::protocol::SandboxPolicy;
use codex_protocol::protocol::TokenUsage;
use codex_protocol::user_input::UserInput;
use codex_state::Stage1Output;
use codex_state::StateRuntime;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

/// Phase 2 任务 claim 信息，包含 ownership token 与输入 watermark。
#[derive(Debug, Clone, Default)]
struct Claim {
    /// 全局 Phase 2 任务的 ownership token。
    token: String,
    /// 当前 claim 对应的输入 watermark（用于增量推进）。
    watermark: i64,
}

/// Phase 2 dispatch 计数器。
#[derive(Debug, Clone, Default)]
struct Counters {
    /// 输入 raw memory 数量。
    input: i64,
}

/// 按严格步骤顺序执行 memory Phase 2（consolidation）。
///
/// 该函数代表了 consolidation 阶段的线性流程：
/// 1. claim 全局 Phase 2 锁
/// 2. 准备 memory workspace（git baseline）
/// 3. 构造 consolidation agent 配置
/// 4. 加载 stage-1 输出
/// 5. 同步 workspace 输入
/// 6. 计算 workspace diff
/// 7. 写入 diff 文件
/// 8. spawn consolidation agent
/// 9. 异步处理 agent 完成回调
/// 10. 上报 dispatch 指标
pub async fn run(context: Arc<MemoryStartupContext>, config: Arc<Config>) {
    let phase_two_e2e_timer = context.start_timer(MEMORY_PHASE_TWO_E2E_MS);

    let Some(db) = context.state_db() else {
        // 理论上不应发生。
        return;
    };
    let root = memory_root(&config.codex_home);
    let max_raw_memories = config.memories.max_raw_memories_for_consolidation;
    let max_unused_days = config.memories.max_unused_days;

    // 1. 在触碰 memory workspace 之前先 claim 全局 Phase 2 锁。
    let claim = match job::claim(context.as_ref(), db.as_ref()).await {
        Ok(claim) => claim,
        Err(e) => {
            context.counter(MEMORY_PHASE_TWO_JOBS, /*inc*/ 1, &[("status", e)]);
            return;
        }
    };

    // 2. 确保 memories root 存在 git baseline 仓库。
    if let Err(err) = prepare_memory_workspace(&root).await {
        tracing::error!("failed preparing memory workspace: {err}");
        job::failed(
            context.as_ref(),
            db.as_ref(),
            &claim,
            "failed_prepare_workspace",
        )
        .await;
        return;
    }

    // 3. 构造 consolidation agent 使用的受限配置。
    let Some(agent_config) = agent::get_config(config.as_ref(), context.provider()) else {
        // 无法获取配置时无法继续 consolidation。
        tracing::error!("failed to get agent config");
        job::failed(
            context.as_ref(),
            db.as_ref(),
            &claim,
            "failed_sandbox_policy",
        )
        .await;
        return;
    };

    // 4. 加载 DB 中的 Phase 2 输入。
    let raw_memories = match db
        .memories()
        .get_phase2_input_selection(max_raw_memories, max_unused_days)
        .await
    {
        Ok(raw_memories) => raw_memories,
        Err(err) => {
            tracing::error!("failed to list stage1 outputs from global: {err}");
            job::failed(
                context.as_ref(),
                db.as_ref(),
                &claim,
                "failed_load_stage1_outputs",
            )
            .await;
            return;
        }
    };
    let raw_memory_count = raw_memories.len();
    let new_watermark = get_watermark(claim.watermark, &raw_memories);

    // 5. 同步当前输入到 memory workspace。
    if let Err(err) = sync_phase2_workspace_inputs(&root, &raw_memories).await {
        tracing::error!("failed syncing phase2 workspace inputs: {err}");
        job::failed(
            context.as_ref(),
            db.as_ref(),
            &claim,
            "failed_sync_workspace_inputs",
        )
        .await;
        return;
    }

    // 6. 通过 git 判断同步后的 workspace 是否真的有变化。
    let workspace_diff = match memory_workspace_diff(&root).await {
        Ok(diff) => diff,
        Err(err) => {
            tracing::error!("failed checking memory workspace changes: {err}");
            job::failed(
                context.as_ref(),
                db.as_ref(),
                &claim,
                "failed_workspace_status",
            )
            .await;
            return;
        }
    };
    if !workspace_diff.has_changes() {
        tracing::error!("Phase 2 no changes");
        // 仅在文件系统同步完成后再检查。
        job::succeed(
            context.as_ref(),
            db.as_ref(),
            &claim,
            new_watermark,
            &raw_memories,
            "succeeded_no_workspace_changes",
        )
        .await;
        return;
    }

    // 7. 将 diff 持久化，供 consolidation agent 检查。
    if let Err(err) = write_workspace_diff(&root, &workspace_diff).await {
        tracing::error!("failed writing memory workspace diff file: {err}");
        job::failed(
            context.as_ref(),
            db.as_ref(),
            &claim,
            "failed_workspace_diff_file",
        )
        .await;
        return;
    }

    // 8. spawn consolidation agent。
    let prompt = agent::get_prompt(&root);
    let agent = match context
        .spawn_consolidation_agent(agent_config, prompt)
        .await
    {
        Ok(agent) => agent,
        Err(err) => {
            tracing::error!("failed to spawn global memory consolidation agent: {err}");
            job::failed(context.as_ref(), db.as_ref(), &claim, "failed_spawn_agent").await;
            return;
        }
    };

    // 9. 异步处理 agent 完成、心跳与 baseline 重置。
    agent::handle(
        Arc::clone(&context),
        claim,
        new_watermark,
        raw_memories.clone(),
        root,
        agent,
        phase_two_e2e_timer,
    );

    // 10. 上报 dispatch 指标。
    let counters = Counters {
        input: raw_memory_count as i64,
    };
    emit_metrics(context.as_ref(), counters);
}

/// 同步 Phase 2 workspace 输入：rollout summaries、raw memories 文件、extension 修剪。
async fn sync_phase2_workspace_inputs(
    root: &Path,
    raw_memories: &[Stage1Output],
) -> std::io::Result<()> {
    let raw_memory_count = raw_memories.len();
    sync_rollout_summaries_from_memories(root, raw_memories, raw_memory_count).await?;
    rebuild_raw_memories_file_from_memories(root, raw_memories, raw_memory_count).await?;
    prune_old_extension_resources(root).await;
    Ok(())
}

/// Phase 2 任务 claim / 失败 / 成功 相关操作。
mod job {
    use super::*;

    /// 尝试 claim 全局 Phase 2 任务。
    ///
    /// 返回 `Ok(Claim)` 表示成功获取锁；返回 `Err(&'static str)` 表示被跳过原因。
    pub(super) async fn claim(
        context: &MemoryStartupContext,
        db: &StateRuntime,
    ) -> Result<Claim, &'static str> {
        let claim = db
            .memories()
            .try_claim_global_phase2_job(context.thread_id(), crate::stage_two::JOB_LEASE_SECONDS)
            .await
            .map_err(|e| {
                tracing::error!("failed to claim job: {e}");
                "failed_claim"
            })?;
        let (token, watermark) = match claim {
            codex_state::Phase2JobClaimOutcome::Claimed {
                ownership_token,
                input_watermark,
            } => {
                context.counter(
                    MEMORY_PHASE_TWO_JOBS,
                    /*inc*/ 1,
                    &[("status", "claimed")],
                );
                (ownership_token, input_watermark)
            }
            codex_state::Phase2JobClaimOutcome::SkippedRetryUnavailable => {
                return Err("skipped_retry_unavailable");
            }
            codex_state::Phase2JobClaimOutcome::SkippedCooldown => {
                return Err("skipped_cooldown");
            }
            codex_state::Phase2JobClaimOutcome::SkippedRunning => return Err("skipped_running"),
        };

        Ok(Claim { token, watermark })
    }

    /// 标记 Phase 2 任务失败，并尝试通过 fallback 路径更新状态。
    pub(super) async fn failed(
        context: &MemoryStartupContext,
        db: &StateRuntime,
        claim: &Claim,
        reason: &'static str,
    ) {
        context.counter(MEMORY_PHASE_TWO_JOBS, /*inc*/ 1, &[("status", reason)]);
        // 若 owned 标记失败，则尝试 unowned 路径兜底。
        if matches!(
            db.memories()
                .mark_global_phase2_job_failed(
                    &claim.token,
                    reason,
                    crate::stage_two::JOB_RETRY_DELAY_SECONDS,
                )
                .await,
            Ok(false)
        ) {
            let _ = db
                .memories()
                .mark_global_phase2_job_failed_if_unowned(
                    &claim.token,
                    reason,
                    crate::stage_two::JOB_RETRY_DELAY_SECONDS,
                )
                .await;
        }
    }

    /// 标记 Phase 2 任务成功并推进 watermark。
    ///
    /// 返回 DB 更新是否成功。
    pub(super) async fn succeed(
        context: &MemoryStartupContext,
        db: &StateRuntime,
        claim: &Claim,
        completion_watermark: i64,
        selected_outputs: &[codex_state::Stage1Output],
        reason: &'static str,
    ) -> bool {
        context.counter(MEMORY_PHASE_TWO_JOBS, /*inc*/ 1, &[("status", reason)]);
        db.memories()
            .mark_global_phase2_job_succeeded(&claim.token, completion_watermark, selected_outputs)
            .await
            .unwrap_or(false)
    }
}

/// consolidation agent 配置构造、prompt 构造与运行时处理。
mod agent {
    use super::*;
    use tracing::warn;

    /// 构造 consolidation agent 使用的受限 [`Config`]。
    ///
    /// 关键约束：
    /// - ephemeral = true，避免反馈回 Phase 1。
    /// - 关闭 memory 生成与使用、apps、plugins、collab 等 feature。
    /// - sandbox 仅允许写入 memory root，禁用网络。
    /// - approval policy 设为 Never。
    pub(super) fn get_config(config: &Config, provider: &dyn ModelProvider) -> Option<Config> {
        let root = memory_root(&config.codex_home);
        let mut agent_config = config.clone();

        agent_config.cwd = root.clone();
        // consolidation 线程绝不能反馈回 Phase 1 memory 生成。
        agent_config.ephemeral = true;
        agent_config.memories.generate_memories = false;
        agent_config.memories.use_memories = false;
        agent_config.include_apps_instructions = false;
        agent_config.mcp_servers = Constrained::allow_only(HashMap::new());
        // 审批策略：从不请求审批。
        agent_config.permissions.approval_policy = Constrained::allow_only(AskForApproval::Never);
        // consolidation 作为内部 worker 运行，禁止递归委派。
        let _ = agent_config.features.disable(Feature::SpawnCsv);
        let _ = agent_config.features.disable(Feature::Collab);
        let _ = agent_config.features.disable(Feature::MemoryTool);
        let _ = agent_config.features.disable(Feature::Apps);
        let _ = agent_config.features.disable(Feature::Plugins);
        let _ = agent_config
            .features
            .disable(Feature::SkillMcpDependencyInstall);

        // sandbox 策略：仅允许写入 memory root，禁用网络。
        let writable_roots = vec![root];
        let consolidation_sandbox_policy = SandboxPolicy::WorkspaceWrite {
            writable_roots,
            network_access: false,
            exclude_tmpdir_env_var: true,
            exclude_slash_tmp: true,
        };
        agent_config
            .permissions
            .set_legacy_sandbox_policy(consolidation_sandbox_policy, agent_config.cwd.as_path())
            .ok()?;

        // 模型选择：优先配置显式指定，否则使用 provider 推荐。
        agent_config.model = Some(
            config
                .memories
                .consolidation_model
                .clone()
                .unwrap_or_else(|| provider.memory_consolidation_preferred_model().to_string()),
        );
        agent_config.model_reasoning_effort = Some(crate::stage_two::REASONING_EFFORT);

        Some(agent_config)
    }

    /// 构造 consolidation agent 的初始 user input prompt。
    pub(super) fn get_prompt(root: &Path) -> Vec<UserInput> {
        let prompt = build_consolidation_prompt(root);
        vec![UserInput::Text {
            text: prompt,
            text_elements: vec![],
        }]
    }

    /// 异步处理 agent 运行：轮询状态、心跳、完成后重置 baseline。
    ///
    /// 该函数在独立 tokio task 中执行，不阻塞主流程。
    #[allow(clippy::too_many_arguments)]
    pub(super) fn handle(
        context: Arc<MemoryStartupContext>,
        claim: Claim,
        new_watermark: i64,
        selected_outputs: Vec<codex_state::Stage1Output>,
        memory_root: codex_utils_absolute_path::AbsolutePathBuf,
        agent: SpawnedConsolidationAgent,
        phase_two_e2e_timer: Option<codex_otel::Timer>,
    ) {
        let Some(db) = context.state_db() else {
            return;
        };

        tokio::spawn(async move {
            let _phase_two_e2e_timer = phase_two_e2e_timer;
            let SpawnedConsolidationAgent { thread_id, thread } = agent;

            // 轮询 agent 直到获得最终状态。
            let final_status =
                loop_agent(db.clone(), claim.token.clone(), thread_id, &thread).await;

            if matches!(final_status, AgentStatus::Completed(_)) {
                // 完成后上报 token usage。
                if let Some(token_usage) = thread
                    .token_usage_info()
                    .await
                    .map(|info| info.total_token_usage)
                {
                    emit_token_usage_metrics(context.as_ref(), &token_usage);
                }
                // 重置 workspace baseline 前必须再次确认仍持有锁。
                let still_owns_lock = match db
                    .memories()
                    .heartbeat_global_phase2_job(
                        &claim.token,
                        crate::stage_two::JOB_LEASE_SECONDS,
                    )
                    .await
                    .inspect_err(|err| {
                        tracing::error!(
                            "failed confirming global memory consolidation ownership before resetting workspace baseline: {err}"
                        );
                    }) {
                    Ok(true) => true,
                    Ok(false) => {
                        tracing::error!(
                            "lost global memory consolidation ownership before resetting workspace baseline"
                        );
                        false
                    }
                    Err(_) => {
                        job::failed(context.as_ref(), &db, &claim, "failed_confirm_ownership")
                            .await;
                        false
                    }
                };
                if still_owns_lock {
                    // 重置 baseline；失败则标记任务失败。
                    if let Err(err) = reset_memory_workspace_baseline(&memory_root).await {
                        tracing::error!("failed resetting memory workspace baseline: {err}");
                        job::failed(context.as_ref(), &db, &claim, "failed_workspace_commit").await;
                    } else if !job::succeed(
                        context.as_ref(),
                        &db,
                        &claim,
                        new_watermark,
                        &selected_outputs,
                        "succeeded",
                    )
                    .await
                    {
                        tracing::error!(
                            "failed marking global memory consolidation job succeeded after resetting workspace baseline"
                        );
                    }
                }
            } else {
                // 非完成状态：标记任务失败。
                job::failed(context.as_ref(), &db, &claim, "failed_agent").await;
            }

            // 异步清理 consolidation agent，避免资源泄漏。
            let cleanup_context = Arc::clone(&context);
            tokio::spawn(async move {
                if let Err(err) = cleanup_context
                    .shutdown_consolidation_agent(SpawnedConsolidationAgent { thread_id, thread })
                    .await
                {
                    warn!(
                        "failed to auto-close global memory consolidation agent {thread_id}: {err}"
                    );
                }
            });
        });
    }

    /// 轮询 agent 状态，并定期发送心跳以维持 Phase 2 锁。
    ///
    /// 返回 agent 的最终 [`AgentStatus`]。
    async fn loop_agent(
        db: Arc<StateRuntime>,
        token: String,
        thread_id: ThreadId,
        thread: &codex_core::CodexThread,
    ) -> AgentStatus {
        // 心跳间隔，用于维持 Phase 2 任务锁。
        let mut heartbeat_interval =
            tokio::time::interval(Duration::from_secs(crate::stage_two::JOB_HEARTBEAT_SECONDS));
        heartbeat_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // 状态轮询间隔（1 秒）。
        let mut status_poll_interval = tokio::time::interval(Duration::from_secs(1));
        status_poll_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let session_termination = thread.wait_until_terminated();
        tokio::pin!(session_termination);

        loop {
            let status = thread.agent_status().await;
            if is_final_agent_status(&status) {
                break status;
            }

            tokio::select! {
                // session 提前终止：尝试取最终状态，否则标记 Errored。
                _ = &mut session_termination => {
                    let status = thread.agent_status().await;
                    if is_final_agent_status(&status) {
                        break status;
                    }
                    tracing::warn!(
                        "memory consolidation agent {thread_id} exited before final status; last status was {status:?}"
                    );
                    break AgentStatus::Errored(format!(
                        "memory consolidation agent exited before final status: {status:?}"
                    ));
                }
                _ = status_poll_interval.tick() => {
                }
                // 心跳：维持 Phase 2 锁；失败或失锁则终止。
                _ = heartbeat_interval.tick() => {
                    match db
                        .memories()
                        .heartbeat_global_phase2_job(
                            &token,
                            crate::stage_two::JOB_LEASE_SECONDS,
                        )
                        .await
                    {
                        Ok(true) => {}
                        Ok(false) => {
                            tracing::warn!(
                                "lost global phase-2 ownership during heartbeat for memory consolidation agent {thread_id}"
                            );
                            break AgentStatus::Errored(
                                "lost global phase-2 ownership during heartbeat".to_string(),
                            );
                        }
                        Err(err) => {
                            tracing::warn!(
                                "phase-2 heartbeat update failed for memory consolidation agent {thread_id}: {err}"
                            );
                            break AgentStatus::Errored(format!(
                                "phase-2 heartbeat update failed: {err}"
                            ));
                        }
                    }
                }
            }
        }
    }
}

/// 计算 Phase 2 任务完成后的新 watermark。
///
/// 取 claim 时 watermark 与所有 raw memory 中最大 `source_updated_at` 的较大值。
pub(super) fn get_watermark(
    claimed_watermark: i64,
    latest_memories: &[codex_state::Stage1Output],
) -> i64 {
    latest_memories
        .iter()
        .map(|memory| memory.source_updated_at.timestamp())
        .max()
        .unwrap_or(claimed_watermark)
        .max(claimed_watermark)
}

/// 判断 agent 状态是否为终态（非 PendingInit / Running / Interrupted）。
fn is_final_agent_status(status: &AgentStatus) -> bool {
    !matches!(
        status,
        AgentStatus::PendingInit | AgentStatus::Running | AgentStatus::Interrupted
    )
}

/// 上报 Phase 2 dispatch 指标。
fn emit_metrics(context: &MemoryStartupContext, counters: Counters) {
    if counters.input > 0 {
        context.counter(MEMORY_PHASE_TWO_INPUT, counters.input, &[]);
    }

    context.counter(
        MEMORY_PHASE_TWO_JOBS,
        /*inc*/ 1,
        &[("status", "agent_spawned")],
    );
}

/// 上报 Phase 2 token usage histogram。
fn emit_token_usage_metrics(context: &MemoryStartupContext, token_usage: &TokenUsage) {
    context.histogram(
        MEMORY_PHASE_TWO_TOKEN_USAGE,
        token_usage.total_tokens.max(0),
        &[("token_type", "total")],
    );
    context.histogram(
        MEMORY_PHASE_TWO_TOKEN_USAGE,
        token_usage.input_tokens.max(0),
        &[("token_type", "input")],
    );
    context.histogram(
        MEMORY_PHASE_TWO_TOKEN_USAGE,
        token_usage.cached_input(),
        &[("token_type", "cached_input")],
    );
    context.histogram(
        MEMORY_PHASE_TWO_TOKEN_USAGE,
        token_usage.output_tokens.max(0),
        &[("token_type", "output")],
    );
    context.histogram(
        MEMORY_PHASE_TWO_TOKEN_USAGE,
        token_usage.reasoning_output_tokens.max(0),
        &[("token_type", "reasoning_output")],
    );
}
