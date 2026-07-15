//! 工具注册表与调度核心实现。
//!
//! 本模块定义了本地工具的运行时契约（`CoreToolRuntime`）、工具注册表（`ToolRegistry`）
//! 以及工具调用调度流程，包括 pre/post hooks、遥测、生命周期通知与 dispatch trace。

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

use crate::function_tool::FunctionCallError;
use crate::hook_runtime::PreToolUseHookResult;
use crate::hook_runtime::record_additional_contexts;
use crate::hook_runtime::run_post_tool_use_hooks;
use crate::hook_runtime::run_pre_tool_use_hooks;
use crate::memory_usage::emit_metric_for_tool_read;
use crate::sandbox_tags::permission_profile_policy_tag;
use crate::sandbox_tags::permission_profile_sandbox_tag;
use crate::session::turn_context::TurnContext;
use crate::tools::context::FunctionToolOutput;
use crate::tools::context::ToolInvocation;
use crate::tools::context::ToolOutput;
use crate::tools::context::ToolPayload;
use crate::tools::flat_tool_name;
use crate::tools::handlers::multi_agents_spec::MULTI_AGENT_V1_NAMESPACE;
use crate::tools::hook_names::HookToolName;
use crate::tools::lifecycle::notify_tool_finish;
use crate::tools::lifecycle::notify_tool_start;
use crate::tools::tool_dispatch_trace::ToolDispatchTrace;
use crate::util::error_or_panic;
use codex_extension_api::ToolCallOutcome;
use codex_protocol::models::FunctionCallOutputPayload;
use codex_protocol::models::ResponseInputItem;
use codex_protocol::protocol::EventMsg;
use codex_rollout::state_db;
use codex_tools::ToolName;
use codex_tools::ToolSearchInfo;
use codex_tools::ToolSpec;
use futures::future::BoxFuture;
use serde_json::Value;
use tracing::instrument;

/// 工具遥测标签集合，键为静态字符串，值为动态字符串。
pub(crate) type ToolTelemetryTags = Vec<(&'static str, String)>;

pub use codex_tools::ToolExecutor;
pub use codex_tools::ToolExposure;

/// 本地执行工具的类型化运行时契约。
///
/// 实现者提供共享的 `ToolExecutor` 行为，以及可选的 core 端元数据：
/// hooks、遥测、工具搜索与参数 diff 等。
pub(crate) trait CoreToolRuntime: ToolExecutor<ToolInvocation> {
    /// 判断给定 payload 是否与该工具的种类匹配。
    ///
    /// 默认实现接受 `Function` 与 `ToolSearch` 两种 payload。
    fn matches_kind(&self, payload: &ToolPayload) -> bool {
        matches!(
            payload,
            ToolPayload::Function { .. } | ToolPayload::ToolSearch { .. }
        )
    }

    /// 取消时是否应等待 handler 完成 teardown，再向 host 返回 aborted 响应。
    fn waits_for_runtime_cancellation(&self) -> bool {
        false
    }

    /// 返回当前 invocation 的遥测标签。
    fn telemetry_tags<'a>(
        &'a self,
        _invocation: &'a ToolInvocation,
    ) -> BoxFuture<'a, ToolTelemetryTags> {
        Box::pin(async { Vec::new() })
    }

    /// 构造 post-tool-use hook 所需的 payload（若适用）。
    ///
    /// 默认实现基于 `Function` payload 构造，并尝试从工具输出中提取 hook 响应。
    fn post_tool_use_payload(
        &self,
        invocation: &ToolInvocation,
        result: &dyn ToolOutput,
    ) -> Option<PostToolUsePayload> {
        let ToolPayload::Function { arguments } = &invocation.payload else {
            return None;
        };

        Some(PostToolUsePayload {
            tool_name: function_hook_tool_name(invocation),
            tool_use_id: result.post_tool_use_id(&invocation.call_id),
            tool_input: result
                .post_tool_use_input(&invocation.payload)
                .unwrap_or_else(|| function_hook_tool_input(arguments)),
            tool_response: result
                .post_tool_use_response(&invocation.call_id, &invocation.payload)
                .or_else(|| {
                    // 大多数 function tool 可以将面向模型的输出作为 hook 响应。
                    // 输出具有更稳定 hook 契约的工具应在上面的 post_tool_use_response 中覆写。
                    let ResponseInputItem::FunctionCallOutput {
                        output: FunctionCallOutputPayload { body, .. },
                        ..
                    } = result.to_response_item(&invocation.call_id, &invocation.payload)
                    else {
                        return None;
                    };

                    serde_json::to_value(body).ok()
                })?,
        })
    }

    /// 构造 pre-tool-use hook 所需的 payload（若适用）。
    fn pre_tool_use_payload(&self, invocation: &ToolInvocation) -> Option<PreToolUsePayload> {
        let ToolPayload::Function { arguments } = &invocation.payload else {
            return None;
        };

        Some(PreToolUsePayload {
            tool_name: function_hook_tool_name(invocation),
            tool_input: function_hook_tool_input(arguments),
        })
    }

    /// 用 hook 返回的 `tool_input` 重建工具调用。
    ///
    /// 启用输入重写 hook 的工具应反转其 `pre_tool_use_payload` 暴露的稳定 hook 契约。
    fn with_updated_hook_input(
        &self,
        invocation: ToolInvocation,
        updated_input: Value,
    ) -> Result<ToolInvocation, FunctionCallError> {
        let ToolPayload::Function { .. } = &invocation.payload else {
            return Err(FunctionCallError::RespondToModel(
                "hook input rewrite received unsupported function tool payload".to_string(),
            ));
        };

        let arguments = serde_json::to_string(&updated_input).map_err(|err| {
            FunctionCallError::RespondToModel(format!(
                "failed to serialize rewritten {} arguments: {err}",
                flat_tool_name(&invocation.tool_name)
            ))
        })?;
        Ok(ToolInvocation {
            payload: ToolPayload::Function { arguments },
            ..invocation
        })
    }

    /// 创建可选的流式参数 diff 消费者。
    fn create_diff_consumer(&self) -> Option<Box<dyn ToolArgumentDiffConsumer>> {
        None
    }
}

/// 消费工具调用的流式参数 diff，并基于部分工具输入发出协议事件。
pub(crate) trait ToolArgumentDiffConsumer: Send {
    /// 消费下一次参数 diff，可能返回一个需要发送的事件。
    fn consume_diff(&mut self, turn: &TurnContext, call_id: String, diff: &str)
    -> Option<EventMsg>;

    /// 在工具调用完成前结束 diff 消费，可能返回一个终结事件。
    fn finish(&mut self) -> Result<Option<EventMsg>, FunctionCallError> {
        Ok(None)
    }
}

/// 任意工具调用的统一结果封装。
pub(crate) struct AnyToolResult {
    /// 工具调用 ID。
    pub(crate) call_id: String,
    /// 触发调用的 payload。
    pub(crate) payload: ToolPayload,
    /// 工具输出结果（trait object）。
    pub(crate) result: Box<dyn ToolOutput>,
    /// 可选的 post-tool-use payload（若适用）。
    pub(crate) post_tool_use_payload: Option<PostToolUsePayload>,
}

impl AnyToolResult {
    /// 将结果转换为模型可见的 `ResponseInputItem`。
    pub(crate) fn into_response(self) -> ResponseInputItem {
        let Self {
            call_id,
            payload,
            result,
            ..
        } = self;
        result.to_response_item(&call_id, &payload)
    }

    /// 返回 code mode 视角的结果（JSON value）。
    pub(crate) fn code_mode_result(self) -> serde_json::Value {
        let Self {
            payload, result, ..
        } = self;
        result.code_mode_result(&payload)
    }
}

/// 包装原始输出并在响应中暴露 hook 反馈消息的模型可见输出。
struct PostToolUseFeedbackOutput {
    original: Box<dyn ToolOutput>,
    model_visible: FunctionToolOutput,
}

impl ToolOutput for PostToolUseFeedbackOutput {
    fn log_preview(&self) -> String {
        self.original.log_preview()
    }

    fn success_for_logging(&self) -> bool {
        self.original.success_for_logging()
    }

    fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem {
        self.model_visible.to_response_item(call_id, payload)
    }

    fn code_mode_result(&self, payload: &ToolPayload) -> Value {
        self.original.code_mode_result(payload)
    }
}

/// pre-tool-use hook 的 payload。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PreToolUsePayload {
    /// hook 端的工具名模型。
    ///
    /// 序列化到 hook stdin 的是规范名称，别名仅用于 matcher 兼容性。
    pub(crate) tool_name: HookToolName,
    /// 暴露在 `tool_input` 上的工具特定输入。
    ///
    /// Shell 类工具使用 `{ "command": ... }`，MCP 工具使用其解析后的 JSON 参数。
    pub(crate) tool_input: Value,
}

/// post-tool-use hook 的 payload。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PostToolUsePayload {
    /// hook 端的工具名模型。
    ///
    /// 序列化到 hook stdin 的是规范名称，别名仅用于 matcher 兼容性。
    pub(crate) tool_name: HookToolName,
    /// 暴露在 `tool_use_id` 上的原始 tool-use ID。
    pub(crate) tool_use_id: String,
    /// 暴露在 `tool_input` 上的工具特定输入。
    pub(crate) tool_input: Value,
    /// 暴露在 `tool_response` 上的工具结果。
    pub(crate) tool_response: Value,
}

/// 覆写 handler 的 exposure，返回新的 `Arc<dyn CoreToolRuntime>`。
/// 若 exposure 未发生变化，则原样返回 handler。
pub(crate) fn override_tool_exposure(
    handler: Arc<dyn CoreToolRuntime>,
    exposure: ToolExposure,
) -> Arc<dyn CoreToolRuntime> {
    if handler.exposure() == exposure {
        return handler;
    }

    Arc::new(ExposureOverride { handler, exposure })
}

/// 包装一个 handler 并覆写其 exposure 的实现。
struct ExposureOverride {
    handler: Arc<dyn CoreToolRuntime>,
    exposure: ToolExposure,
}

impl ToolExecutor<ToolInvocation> for ExposureOverride {
    fn tool_name(&self) -> ToolName {
        self.handler.tool_name()
    }

    fn spec(&self) -> ToolSpec {
        self.handler.spec()
    }

    fn exposure(&self) -> ToolExposure {
        self.exposure
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        self.exposure != ToolExposure::Hidden && self.handler.supports_parallel_tool_calls()
    }

    fn search_info(&self) -> Option<ToolSearchInfo> {
        self.handler.search_info()
    }

    fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_> {
        self.handler.handle(invocation)
    }
}

impl CoreToolRuntime for ExposureOverride {
    fn matches_kind(&self, payload: &ToolPayload) -> bool {
        self.handler.matches_kind(payload)
    }

    fn waits_for_runtime_cancellation(&self) -> bool {
        self.handler.waits_for_runtime_cancellation()
    }

    fn pre_tool_use_payload(&self, invocation: &ToolInvocation) -> Option<PreToolUsePayload> {
        self.handler.pre_tool_use_payload(invocation)
    }

    fn post_tool_use_payload(
        &self,
        invocation: &ToolInvocation,
        result: &dyn ToolOutput,
    ) -> Option<PostToolUsePayload> {
        self.handler.post_tool_use_payload(invocation, result)
    }

    fn with_updated_hook_input(
        &self,
        invocation: ToolInvocation,
        updated_input: Value,
    ) -> Result<ToolInvocation, FunctionCallError> {
        self.handler
            .with_updated_hook_input(invocation, updated_input)
    }

    fn telemetry_tags<'a>(
        &'a self,
        invocation: &'a ToolInvocation,
    ) -> BoxFuture<'a, ToolTelemetryTags> {
        self.handler.telemetry_tags(invocation)
    }

    fn create_diff_consumer(&self) -> Option<Box<dyn ToolArgumentDiffConsumer>> {
        self.handler.create_diff_consumer()
    }
}

/// 工具注册表，按 `ToolName` 索引 handler。
pub struct ToolRegistry {
    tools: HashMap<ToolName, Arc<dyn CoreToolRuntime>>,
}

impl ToolRegistry {
    fn new(tools: HashMap<ToolName, Arc<dyn CoreToolRuntime>>) -> Self {
        Self { tools }
    }

    /// 从迭代器构造注册表，遇到重名工具会触发错误或 panic。
    #[instrument(level = "trace", skip_all)]
    pub(crate) fn from_tools(tools: impl IntoIterator<Item = Arc<dyn CoreToolRuntime>>) -> Self {
        let mut tools_by_name = HashMap::new();
        for tool in tools {
            let name = tool.tool_name();
            if tools_by_name.contains_key(&name) {
                error_or_panic(format!("tool {name} already registered"));
                continue;
            }
            tools_by_name.insert(name, tool);
        }
        Self::new(tools_by_name)
    }

    /// 创建一个空的注册表（仅用于测试）。
    #[cfg(test)]
    pub(crate) fn empty_for_test() -> Self {
        Self::new(HashMap::new())
    }

    /// 创建一个仅包含单个 handler 的注册表（仅用于测试）。
    #[cfg(test)]
    pub(crate) fn with_handler_for_test<T>(handler: Arc<T>) -> Self
    where
        T: CoreToolRuntime + 'static,
    {
        let name = handler.tool_name();
        Self::new(HashMap::from([(name, handler as Arc<dyn CoreToolRuntime>)]))
    }

    /// 按名称获取工具 handler 的克隆。
    fn tool(&self, name: &ToolName) -> Option<Arc<dyn CoreToolRuntime>> {
        self.tools.get(name).map(Arc::clone)
    }

    /// 返回所有已注册工具名（仅用于测试）。
    #[cfg(test)]
    pub(crate) fn tool_names_for_test(&self) -> Vec<ToolName> {
        let mut names = self.tools.keys().cloned().collect::<Vec<_>>();
        names.sort();
        names
    }

    /// 返回指定工具的 exposure（仅用于测试）。
    #[cfg(test)]
    pub(crate) fn tool_exposure(&self, name: &ToolName) -> Option<ToolExposure> {
        self.tools.get(name).map(|tool| tool.exposure())
    }

    /// 创建指定工具的参数 diff 消费者（若该工具支持）。
    pub(crate) fn create_diff_consumer(
        &self,
        name: &ToolName,
    ) -> Option<Box<dyn ToolArgumentDiffConsumer>> {
        self.tool(name)?.create_diff_consumer()
    }

    /// 返回指定工具是否支持并行工具调用。
    pub(crate) fn supports_parallel_tool_calls(&self, name: &ToolName) -> Option<bool> {
        let tool = self.tool(name)?;
        Some(tool.supports_parallel_tool_calls())
    }

    /// 返回指定工具是否等待 runtime cancellation 完成。
    pub(crate) fn waits_for_runtime_cancellation(&self, name: &ToolName) -> Option<bool> {
        let tool = self.tool(name)?;
        Some(tool.waits_for_runtime_cancellation())
    }

    /// 分发一次工具调用，无 terminal outcome 标记。
    #[allow(dead_code)]
    pub(crate) async fn dispatch_any(
        &self,
        invocation: ToolInvocation,
    ) -> Result<AnyToolResult, FunctionCallError> {
        self.dispatch_any_with_terminal_outcome(invocation, /*terminal_outcome_reached*/ None)
            .await
    }

    /// 分发一次工具调用，并支持传入 terminal outcome 标记，
    /// 用于在终态达成后抑制后续的 lifecycle 通知。
    ///
    // 注意：这里有意在 await 期间持有非 Send 类型，以保证 turn 计数的原子性。
    #[expect(
        clippy::await_holding_invalid_type,
        reason = "tool dispatch must keep active-turn accounting atomic"
    )]
    pub(crate) async fn dispatch_any_with_terminal_outcome(
        &self,
        mut invocation: ToolInvocation,
        terminal_outcome_reached: Option<Arc<AtomicBool>>,
    ) -> Result<AnyToolResult, FunctionCallError> {
        let tool_name = invocation.tool_name.clone();
        let tool_name_flat = flat_tool_name(&tool_name);
        let call_id_owned = invocation.call_id.clone();
        let otel = invocation.turn.session_telemetry.clone();
        let base_tool_result_tags = [
            (
                "sandbox",
                permission_profile_sandbox_tag(
                    &invocation.turn.permission_profile,
                    invocation.turn.windows_sandbox_level,
                    invocation.turn.network.is_some(),
                ),
            ),
            (
                "sandbox_policy",
                permission_profile_policy_tag(
                    &invocation.turn.permission_profile,
                    #[allow(deprecated)]
                    invocation.turn.cwd.as_path(),
                ),
            ),
        ];

        // 在调用工具前递增当前 turn 的工具调用计数。
        {
            let mut active = invocation.session.active_turn.lock().await;
            if let Some(active_turn) = active.as_mut() {
                let mut turn_state = active_turn.turn_state.lock().await;
                turn_state.tool_calls = turn_state.tool_calls.saturating_add(1);
            }
        }

        let dispatch_trace = ToolDispatchTrace::start(&invocation);
        let tool = match self.tool(&tool_name) {
            Some(tool) => tool,
            None => {
                // 未注册的工具，记录失败并返回错误。
                let message = unsupported_tool_call_message(&invocation.payload, &tool_name);
                let log_payload = invocation.payload.log_payload();
                otel.tool_result_with_tags(
                    tool_name_flat.as_ref(),
                    &call_id_owned,
                    log_payload.as_ref(),
                    Duration::ZERO,
                    /*success*/ false,
                    &message,
                    &base_tool_result_tags,
                    /*extra_trace_fields*/ &[],
                );
                let err = FunctionCallError::RespondToModel(message);
                dispatch_trace.record_failed(&err);
                return Err(err);
            }
        };

        let telemetry_tags = tool.telemetry_tags(&invocation).await;
        let mut tool_result_tags =
            Vec::with_capacity(base_tool_result_tags.len() + telemetry_tags.len());
        let mut extra_trace_fields = Vec::new();
        tool_result_tags.extend_from_slice(&base_tool_result_tags);
        for (key, value) in &telemetry_tags {
            if matches!(*key, "mcp_server" | "mcp_server_origin") {
                extra_trace_fields.push((*key, value.as_str()));
            } else {
                tool_result_tags.push((*key, value.as_str()));
            }
        }
        // 校验 payload 与工具种类是否匹配。
        if !tool.matches_kind(&invocation.payload) {
            let message = format!("tool {tool_name} invoked with incompatible payload");
            let log_payload = invocation.payload.log_payload();
            otel.tool_result_with_tags(
                tool_name_flat.as_ref(),
                &call_id_owned,
                log_payload.as_ref(),
                Duration::ZERO,
                /*success*/ false,
                &message,
                &tool_result_tags,
                &extra_trace_fields,
            );
            let err = FunctionCallError::Fatal(message);
            dispatch_trace.record_failed(&err);
            return Err(err);
        }

        notify_tool_start(&invocation).await;

        // 执行 pre-tool-use hooks，可能阻止调用或重写输入。
        if let Some(pre_tool_use_payload) = tool.pre_tool_use_payload(&invocation) {
            match run_pre_tool_use_hooks(
                &invocation.session,
                &invocation.turn,
                invocation.call_id.clone(),
                &pre_tool_use_payload.tool_name,
                &pre_tool_use_payload.tool_input,
            )
            .await
            {
                PreToolUseHookResult::Blocked(message) => {
                    let err = FunctionCallError::RespondToModel(message);
                    dispatch_trace.record_failed(&err);
                    notify_tool_finish_if_unclaimed(
                        &invocation,
                        terminal_outcome_reached.as_deref(),
                        ToolCallOutcome::Blocked,
                    )
                    .await;
                    return Err(err);
                }
                PreToolUseHookResult::Continue {
                    updated_input: Some(updated_input),
                } => match tool.with_updated_hook_input(invocation.clone(), updated_input) {
                    Ok(updated_invocation) => {
                        invocation = updated_invocation;
                    }
                    Err(err) => {
                        dispatch_trace.record_failed(&err);
                        notify_tool_finish_if_unclaimed(
                            &invocation,
                            terminal_outcome_reached.as_deref(),
                            ToolCallOutcome::Failed {
                                handler_executed: false,
                            },
                        )
                        .await;
                        return Err(err);
                    }
                },
                PreToolUseHookResult::Continue {
                    updated_input: None,
                } => {}
            }
        }

        let response_cell = tokio::sync::Mutex::new(None);
        let invocation_for_tool = invocation.clone();
        let log_payload = invocation.payload.log_payload();

        // 在遥测包装下执行工具 handler。
        let result = otel
            .log_tool_result_with_tags(
                tool_name_flat.as_ref(),
                &call_id_owned,
                log_payload.as_ref(),
                &tool_result_tags,
                &extra_trace_fields,
                || {
                    let tool = tool.clone();
                    let response_cell = &response_cell;
                    async move {
                        match handle_any_tool(tool.as_ref(), invocation_for_tool).await {
                            Ok(result) => {
                                let preview = result.result.log_preview();
                                let success = result.result.success_for_logging();
                                let mut guard = response_cell.lock().await;
                                *guard = Some(result);
                                Ok((preview, success))
                            }
                            Err(err) => Err(err),
                        }
                    }
                },
            )
            .await;
        let success = match &result {
            Ok((_, success)) => *success,
            Err(_) => false,
        };
        emit_metric_for_tool_read(&invocation, success);
        let post_tool_use_payload = if success {
            let guard = response_cell.lock().await;
            guard
                .as_ref()
                .and_then(|result| result.post_tool_use_payload.clone())
        } else {
            None
        };
        // 若有 post-tool-use payload，则运行 post hooks。
        let post_tool_use_outcome = if let Some(post_tool_use_payload) = post_tool_use_payload {
            Some(
                run_post_tool_use_hooks(
                    &invocation.session,
                    &invocation.turn,
                    post_tool_use_payload.tool_use_id,
                    post_tool_use_payload.tool_name.name().to_string(),
                    post_tool_use_payload.tool_name.matcher_aliases().to_vec(),
                    post_tool_use_payload.tool_input,
                    post_tool_use_payload.tool_response,
                )
                .await,
            )
        } else {
            None
        };
        if let Some(outcome) = &post_tool_use_outcome {
            record_additional_contexts(
                &invocation.session,
                &invocation.turn,
                outcome.additional_contexts.clone(),
            )
            .await;
        }

        // PostToolUse 阻断的是结果，而不是已完成的工具执行本身。
        let lifecycle_outcome = match &result {
            Ok(_) => {
                let guard = response_cell.lock().await;
                match guard.as_ref() {
                    Some(result) => ToolCallOutcome::Completed {
                        success: result.result.success_for_logging(),
                    },
                    None => ToolCallOutcome::Failed {
                        handler_executed: true,
                    },
                }
            }
            Err(_) => ToolCallOutcome::Failed {
                handler_executed: true,
            },
        };
        notify_tool_finish_if_unclaimed(
            &invocation,
            terminal_outcome_reached.as_deref(),
            lifecycle_outcome,
        )
        .await;

        match result {
            Ok(_) => {
                let mut guard = response_cell.lock().await;
                let mut result = guard.take().ok_or_else(|| {
                    FunctionCallError::Fatal("tool produced no output".to_string())
                })?;
                if let Some(outcome) = post_tool_use_outcome {
                    if outcome.should_block {
                        // PostToolUse hook 阻断了结果，转换为面向模型的错误。
                        let message = outcome.feedback_message.unwrap_or_else(|| {
                            "PostToolUse hook blocked the tool result".to_string()
                        });
                        let err = FunctionCallError::RespondToModel(message);
                        dispatch_trace.record_failed(&err);
                        return Err(err);
                    }
                    if let Some(feedback_message) = outcome.feedback_message {
                        // hook 提供了反馈消息，覆盖模型可见输出。
                        result.result = Box::new(PostToolUseFeedbackOutput {
                            original: result.result,
                            model_visible: FunctionToolOutput::from_text(
                                feedback_message,
                                /*success*/ None,
                            ),
                        });
                    }
                }
                dispatch_trace.record_completed(
                    &invocation,
                    &result.call_id,
                    &result.payload,
                    result.result.as_ref(),
                );
                Ok(result)
            }
            Err(err) => {
                dispatch_trace.record_failed(&err);
                Err(err)
            }
        }
    }
}

/// 在未被 terminal outcome 标记占用的情况下，发送工具完成通知。
/// 返回 `true` 表示通知已发送，`false` 表示已被占用而未发送。
async fn notify_tool_finish_if_unclaimed(
    invocation: &ToolInvocation,
    terminal_outcome_reached: Option<&AtomicBool>,
    outcome: ToolCallOutcome,
) -> bool {
    if terminal_outcome_reached.is_some_and(|reached| reached.swap(true, Ordering::AcqRel)) {
        return false;
    }

    notify_tool_finish(invocation, outcome).await;
    true
}

/// 执行任意工具 handler 并封装结果为 `AnyToolResult`。
async fn handle_any_tool(
    tool: &dyn CoreToolRuntime,
    invocation: ToolInvocation,
) -> Result<AnyToolResult, FunctionCallError> {
    let call_id = invocation.call_id.clone();
    let payload = invocation.payload.clone();
    let output = tool.handle(invocation.clone()).await?;
    // 若输出包含外部上下文且配置要求在外部上下文出现时禁用 memory，则标记 thread memory 被污染。
    if output.contains_external_context()
        && invocation.turn.config.memories.disable_on_external_context
    {
        state_db::mark_thread_memory_mode_polluted(
            invocation.session.services.state_db.as_deref(),
            invocation.session.thread_id,
            "tool_output",
        )
        .await;
    }
    let post_tool_use_payload =
        CoreToolRuntime::post_tool_use_payload(tool, &invocation, output.as_ref());
    Ok(AnyToolResult {
        call_id,
        payload,
        result: output,
        post_tool_use_payload,
    })
}

/// 根据 invocation 构造 hook 端的工具名。
/// 特殊处理 `spawn_agent`（在 multi-agent v1 namespace 下时）使用预定义别名。
fn function_hook_tool_name(invocation: &ToolInvocation) -> HookToolName {
    if invocation.tool_name.name == "spawn_agent"
        && matches!(
            invocation.tool_name.namespace.as_deref(),
            None | Some(MULTI_AGENT_V1_NAMESPACE)
        )
    {
        return HookToolName::spawn_agent();
    }

    HookToolName::new(flat_tool_name(&invocation.tool_name).into_owned())
}

/// 将 function tool 的参数字符串解析为 JSON value。
/// 空字符串解析为空对象；解析失败则原样作为字符串返回。
fn function_hook_tool_input(arguments: &str) -> Value {
    if arguments.trim().is_empty() {
        return Value::Object(serde_json::Map::new());
    }

    serde_json::from_str(arguments).unwrap_or_else(|_| Value::String(arguments.to_string()))
}

/// 生成“不支持的调用”错误消息。
fn unsupported_tool_call_message(payload: &ToolPayload, tool_name: &ToolName) -> String {
    match payload {
        ToolPayload::Custom { .. } => format!("unsupported custom tool call: {tool_name}"),
        _ => format!("unsupported call: {tool_name}"),
    }
}
#[cfg(test)]
#[path = "registry_tests.rs"]
mod tests;
