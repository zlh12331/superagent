//! 工具路由器实现。
//!
//! `ToolRouter` 负责将模型产生的工具调用（`ResponseItem`）解析为 `ToolCall`，
//! 然后通过 `ToolRegistry` 分发到具体的 handler。它同时管理模型可见的工具规格列表。

use crate::function_tool::FunctionCallError;
use crate::session::session::Session;
use crate::session::step_context::StepContext;
use crate::tools::context::SharedTurnDiffTracker;
use crate::tools::context::ToolInvocation;
use crate::tools::context::ToolPayload;
use crate::tools::handlers::ToolSearchHandlerCache;
use crate::tools::registry::AnyToolResult;
use crate::tools::registry::ToolArgumentDiffConsumer;
use crate::tools::registry::ToolRegistry;
use crate::tools::spec_plan::build_tool_router;
use codex_mcp::ToolInfo;
use codex_protocol::dynamic_tools::DynamicToolSpec;
use codex_protocol::models::ResponseItem;
use codex_protocol::models::SearchToolCallParams;
use codex_tools::DiscoverableTool;
use codex_tools::ToolCall as ExtensionToolCall;
use codex_tools::ToolExecutor;
use codex_tools::ToolName;
use codex_tools::ToolSpec;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use tokio_util::sync::CancellationToken;
use tracing::instrument;

pub use crate::tools::context::ToolCallSource;

/// 一次工具调用的结构化表示。
#[derive(Clone, Debug, PartialEq)]
pub struct ToolCall {
    /// 工具名称（含可选 namespace）。
    pub tool_name: ToolName,
    /// 工具调用 ID。
    pub call_id: String,
    /// 调用 payload。
    pub payload: ToolPayload,
}

/// 工具路由器，封装工具注册表与模型可见的工具规格列表。
pub struct ToolRouter {
    registry: ToolRegistry,
    model_visible_specs: Vec<ToolSpec>,
}

/// 构造 `ToolRouter` 所需的参数集合。
pub(crate) struct ToolRouterParams<'a> {
    /// MCP 工具列表（可选）。
    pub(crate) mcp_tools: Option<Vec<ToolInfo>>,
    /// 延迟加载的 MCP 工具列表（可选）。
    pub(crate) deferred_mcp_tools: Option<Vec<ToolInfo>>,
    /// 工具建议候选（可选）。
    pub(crate) tool_suggest_candidates: Option<ToolSuggestCandidates>,
    /// 扩展工具执行器集合。
    pub(crate) extension_tool_executors: Vec<Arc<dyn ToolExecutor<ExtensionToolCall>>>,
    /// 动态工具规格切片。
    pub(crate) dynamic_tools: &'a [DynamicToolSpec],
}

/// 工具建议的展示方式。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ToolSuggestPresentation {
    /// 以工具列表形式展示。
    ListTool,
    /// 以推荐上下文形式展示。
    RecommendationContext,
}

/// 工具建议候选集合。
#[derive(Clone, Debug)]
pub(crate) struct ToolSuggestCandidates {
    /// 候选工具列表。
    pub(crate) tools: Vec<DiscoverableTool>,
    /// 展示方式。
    pub(crate) presentation: ToolSuggestPresentation,
}

impl ToolRouter {
    /// 根据当前 step 上下文与参数构造 `ToolRouter`。
    pub(crate) fn from_context(
        step_context: &StepContext,
        params: ToolRouterParams<'_>,
        tool_search_handler_cache: &ToolSearchHandlerCache,
    ) -> Self {
        build_tool_router(step_context, params, tool_search_handler_cache)
    }

    /// 由已有注册表与模型可见规格列表直接组装 `ToolRouter`。
    pub(crate) fn from_parts(registry: ToolRegistry, model_visible_specs: Vec<ToolSpec>) -> Self {
        Self {
            registry,
            model_visible_specs,
        }
    }

    /// 返回模型可见的工具规格列表（克隆）。
    pub fn model_visible_specs(&self) -> Vec<ToolSpec> {
        self.model_visible_specs.clone()
    }

    /// 返回所有已注册工具名（仅用于测试）。
    #[cfg(test)]
    pub(crate) fn registered_tool_names_for_test(&self) -> Vec<ToolName> {
        self.registry.tool_names_for_test()
    }

    /// 返回指定工具的 exposure（仅用于测试）。
    #[cfg(test)]
    pub(crate) fn tool_exposure_for_test(
        &self,
        name: &ToolName,
    ) -> Option<crate::tools::registry::ToolExposure> {
        self.registry.tool_exposure(name)
    }

    /// 为指定工具创建参数 diff 消费者（若支持）。
    pub(crate) fn create_diff_consumer(
        &self,
        tool_name: &ToolName,
    ) -> Option<Box<dyn ToolArgumentDiffConsumer>> {
        self.registry.create_diff_consumer(tool_name)
    }

    /// 判断给定工具调用是否支持并行调用。
    pub fn tool_supports_parallel(&self, call: &ToolCall) -> bool {
        self.registry
            .supports_parallel_tool_calls(&call.tool_name)
            .unwrap_or(false)
    }

    /// 判断给定工具是否需要等待 runtime cancellation 完成。
    pub fn tool_waits_for_runtime_cancellation(&self, call: &ToolCall) -> bool {
        self.registry
            .waits_for_runtime_cancellation(&call.tool_name)
            .unwrap_or(false)
    }

    /// 将一个 `ResponseItem` 解析为 `ToolCall`（若它代表工具调用）。
    ///
    /// 支持 `FunctionCall`、`ToolSearchCall`（仅 `client` 执行）与 `CustomToolCall`。
    /// 其他类型返回 `Ok(None)`。
    #[instrument(level = "trace", skip_all, err)]
    pub fn build_tool_call(item: ResponseItem) -> Result<Option<ToolCall>, FunctionCallError> {
        match item {
            ResponseItem::FunctionCall {
                name,
                namespace,
                arguments,
                call_id,
                ..
            } => {
                let tool_name = ToolName::new(namespace, name);
                Ok(Some(ToolCall {
                    tool_name,
                    call_id,
                    payload: ToolPayload::Function { arguments },
                }))
            }
            ResponseItem::ToolSearchCall {
                call_id: Some(call_id),
                execution,
                arguments,
                ..
            } if execution == "client" => {
                let arguments: SearchToolCallParams =
                    serde_json::from_value(arguments).map_err(|err| {
                        FunctionCallError::RespondToModel(format!(
                            "failed to parse tool_search arguments: {err}"
                        ))
                    })?;
                Ok(Some(ToolCall {
                    tool_name: ToolName::plain("tool_search"),
                    call_id,
                    payload: ToolPayload::ToolSearch { arguments },
                }))
            }
            // 非 client 执行的 ToolSearchCall 不视为本地工具调用。
            ResponseItem::ToolSearchCall { .. } => Ok(None),
            ResponseItem::CustomToolCall {
                name,
                namespace,
                input,
                call_id,
                ..
            } => Ok(Some(ToolCall {
                tool_name: ToolName::new(namespace, name),
                call_id,
                payload: ToolPayload::Custom { input },
            })),
            _ => Ok(None),
        }
    }

    /// 分发一次工具调用，无 terminal outcome 标记。
    #[allow(dead_code)]
    #[instrument(level = "trace", skip_all, err)]
    pub async fn dispatch_tool_call_with_code_mode_result(
        &self,
        session: Arc<Session>,
        step_context: Arc<StepContext>,
        cancellation_token: CancellationToken,
        tracker: SharedTurnDiffTracker,
        call: ToolCall,
        source: ToolCallSource,
    ) -> Result<AnyToolResult, FunctionCallError> {
        self.dispatch_tool_call_with_code_mode_result_inner(
            session,
            step_context,
            cancellation_token,
            tracker,
            call,
            source,
            /*terminal_outcome_reached*/ None,
        )
        .await
    }

    /// 分发一次工具调用，并传入 terminal outcome 标记，
    /// 用于在终态达成后抑制后续 lifecycle 通知。
    #[instrument(level = "trace", skip_all, err)]
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn dispatch_tool_call_with_terminal_outcome(
        &self,
        session: Arc<Session>,
        step_context: Arc<StepContext>,
        cancellation_token: CancellationToken,
        tracker: SharedTurnDiffTracker,
        call: ToolCall,
        source: ToolCallSource,
        terminal_outcome_reached: Arc<AtomicBool>,
    ) -> Result<AnyToolResult, FunctionCallError> {
        self.dispatch_tool_call_with_code_mode_result_inner(
            session,
            step_context,
            cancellation_token,
            tracker,
            call,
            source,
            Some(terminal_outcome_reached),
        )
        .await
    }

    /// 分发工具调用的内部实现，构造 `ToolInvocation` 后委托给 `ToolRegistry`。
    #[allow(clippy::too_many_arguments)]
    async fn dispatch_tool_call_with_code_mode_result_inner(
        &self,
        session: Arc<Session>,
        step_context: Arc<StepContext>,
        cancellation_token: CancellationToken,
        tracker: SharedTurnDiffTracker,
        call: ToolCall,
        source: ToolCallSource,
        terminal_outcome_reached: Option<Arc<AtomicBool>>,
    ) -> Result<AnyToolResult, FunctionCallError> {
        let ToolCall {
            tool_name,
            call_id,
            payload,
        } = call;

        // 在 handler 迁移完成前，将 legacy ToolInvocation.turn 字段绑定到同一个请求状态。
        let turn = Arc::clone(&step_context.turn);
        let invocation = ToolInvocation {
            session,
            turn,
            step_context,
            cancellation_token,
            tracker,
            call_id,
            tool_name,
            source,
            payload,
        };

        self.registry
            .dispatch_any_with_terminal_outcome(invocation, terminal_outcome_reached)
            .await
    }
}

/// 收集会话中所有扩展贡献的工具执行器。
#[instrument(level = "trace", skip_all)]
pub(crate) fn extension_tool_executors(
    session: &Session,
) -> Vec<Arc<dyn ToolExecutor<ExtensionToolCall>>> {
    session
        .services
        .extensions
        .tool_contributors()
        .iter()
        .flat_map(|contributor| {
            contributor.tools(
                &session.services.session_extension_data,
                &session.services.thread_extension_data,
            )
        })
        .collect()
}

#[cfg(test)]
#[path = "router_tests.rs"]
mod tests;
