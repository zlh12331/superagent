//! 会话级 telemetry 记录器。
//!
//! [`SessionTelemetry`] 封装会话级 metadata 与 metrics 客户端，
//! 提供对话、API 请求、工具调用、SSE/WebSocket 事件等 telemetry 记录接口。

use crate::TelemetryAuthMode;
use crate::ToolDecisionSource;
use crate::events::shared::log_and_trace_event;
use crate::events::shared::log_event;
use crate::events::shared::trace_event;
use crate::metrics::API_CALL_COUNT_METRIC;
use crate::metrics::API_CALL_DURATION_METRIC;
use crate::metrics::MetricsClient;
use crate::metrics::MetricsConfig;
use crate::metrics::MetricsError;
use crate::metrics::PLUGIN_INSTALL_ELICITATION_SENT_METRIC;
use crate::metrics::PLUGIN_INSTALL_SUGGESTION_METRIC;
use crate::metrics::RESPONSES_API_ENGINE_IAPI_TBT_DURATION_METRIC;
use crate::metrics::RESPONSES_API_ENGINE_IAPI_TTFT_DURATION_METRIC;
use crate::metrics::RESPONSES_API_ENGINE_SERVICE_TBT_DURATION_METRIC;
use crate::metrics::RESPONSES_API_ENGINE_SERVICE_TTFT_DURATION_METRIC;
use crate::metrics::RESPONSES_API_INFERENCE_TIME_DURATION_METRIC;
use crate::metrics::RESPONSES_API_OVERHEAD_DURATION_METRIC;
use crate::metrics::Result as MetricsResult;
use crate::metrics::SSE_EVENT_COUNT_METRIC;
use crate::metrics::SSE_EVENT_DURATION_METRIC;
use crate::metrics::STARTUP_PHASE_DURATION_METRIC;
use crate::metrics::SessionMetricTagValues;
use crate::metrics::TOOL_CALL_COUNT_METRIC;
use crate::metrics::TOOL_CALL_DURATION_METRIC;
use crate::metrics::TURN_TTFT_DURATION_METRIC;
use crate::metrics::WEBSOCKET_EVENT_COUNT_METRIC;
use crate::metrics::WEBSOCKET_EVENT_DURATION_METRIC;
use crate::metrics::WEBSOCKET_REQUEST_COUNT_METRIC;
use crate::metrics::WEBSOCKET_REQUEST_DURATION_METRIC;
use crate::metrics::runtime_metrics::RuntimeMetricsSummary;
use crate::metrics::timer::Timer;
use crate::provider::OtelProvider;
use crate::sanitize_metric_tag_value;
use codex_api::AgentIdentityTelemetry;
use codex_api::ApiError;
use codex_api::ResponseEvent;
use codex_protocol::ThreadId;
use codex_protocol::config_types::ReasoningSummary;
use codex_protocol::models::ResponseItem;
use codex_protocol::openai_models::ReasoningEffort;
use codex_protocol::protocol::AskForApproval;
use codex_protocol::protocol::ReviewDecision;
use codex_protocol::protocol::SandboxPolicy;
use codex_protocol::protocol::SessionSource;
use codex_protocol::user_input::UserInput;
use eventsource_stream::Event as StreamEvent;
use eventsource_stream::EventStreamError as StreamError;
use opentelemetry_sdk::metrics::data::ResourceMetrics;
use reqwest::Error;
use reqwest::Response;
use std::borrow::Cow;
use std::future::Future;
use std::time::Duration;
use std::time::Instant;
use tokio::time::error::Elapsed;
use tracing::Span;

const SSE_UNKNOWN_KIND: &str = "unknown";
const WEBSOCKET_UNKNOWN_KIND: &str = "unknown";
const RESPONSES_WEBSOCKET_TIMING_KIND: &str = "responsesapi.websocket_timing";
const RESPONSES_WEBSOCKET_TIMING_METRICS_FIELD: &str = "timing_metrics";
const RESPONSES_API_OVERHEAD_FIELD: &str = "responses_duration_excl_engine_and_client_tool_time_ms";
const RESPONSES_API_INFERENCE_FIELD: &str = "engine_service_total_ms";
const RESPONSES_API_ENGINE_IAPI_TTFT_FIELD: &str = "engine_iapi_ttft_total_ms";
const RESPONSES_API_ENGINE_SERVICE_TTFT_FIELD: &str = "engine_service_ttft_total_ms";
const RESPONSES_API_ENGINE_IAPI_TBT_FIELD: &str = "engine_iapi_tbt_across_engine_calls_ms";
const RESPONSES_API_ENGINE_SERVICE_TBT_FIELD: &str = "engine_service_tbt_across_engine_calls_ms";

fn trace_field_value<'a>(fields: &'a [(&str, &str)], key: &str) -> Option<&'a str> {
    fields
        .iter()
        .find_map(|(field_key, value)| (*field_key == key).then_some(*value))
}

/// 认证环境相关的 telemetry metadata，记录各类 API key 环境变量的存在性。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AuthEnvTelemetryMetadata {
    /// `OPENAI_API_KEY` 环境变量是否存在。
    pub openai_api_key_env_present: bool,
    /// `CODEX_API_KEY` 环境变量是否存在。
    pub codex_api_key_env_present: bool,
    /// `CODEX_API_KEY` 是否被启用。
    pub codex_api_key_env_enabled: bool,
    /// provider 环境变量名（可选）。
    pub provider_env_key_name: Option<String>,
    /// provider 环境变量是否存在（可选）。
    pub provider_env_key_present: Option<bool>,
    /// 是否存在 refresh token URL 覆盖。
    pub refresh_token_url_override_present: bool,
}

/// 会话级 telemetry metadata，描述一次会话的上下文信息。
#[derive(Debug, Clone)]
pub struct SessionTelemetryMetadata {
    /// 会话（conversation）ID。
    pub(crate) conversation_id: ThreadId,
    /// 认证模式字符串。
    pub(crate) auth_mode: Option<String>,
    /// 认证环境 metadata。
    pub(crate) auth_env: AuthEnvTelemetryMetadata,
    /// 账户 ID（可选）。
    pub(crate) account_id: Option<String>,
    /// 账户邮箱（可选）。
    pub(crate) account_email: Option<String>,
    /// 发起方标识。
    pub(crate) originator: String,
    /// 服务名（可选）。
    pub(crate) service_name: Option<String>,
    /// 会话来源。
    pub(crate) session_source: String,
    /// 模型名。
    pub(crate) model: String,
    /// 模型 slug。
    pub(crate) slug: String,
    /// 服务层级（可选）。
    pub(crate) service_tier: Option<String>,
    /// 模型推理强度（可选）。
    pub(crate) model_reasoning_effort: Option<String>,
    /// 是否记录用户 prompt 内容。
    pub(crate) log_user_prompts: bool,
    /// 应用版本号。
    pub(crate) app_version: &'static str,
    /// 终端类型。
    pub(crate) terminal_type: String,
}

/// 会话级 telemetry 记录器，持有 metadata 与可选的 metrics 客户端。
#[derive(Debug, Clone)]
pub struct SessionTelemetry {
    /// 会话级 metadata。
    pub(crate) metadata: SessionTelemetryMetadata,
    /// metrics 客户端（可选）。
    pub(crate) metrics: Option<MetricsClient>,
    /// 是否在 metrics 中使用 metadata 标签。
    pub(crate) metrics_use_metadata_tags: bool,
}

impl SessionTelemetry {
    /// 设置认证环境 telemetry metadata，返回修改后的实例（builder 模式）。
    pub fn with_auth_env(mut self, auth_env: AuthEnvTelemetryMetadata) -> Self {
        self.metadata.auth_env = auth_env;
        self
    }

    /// 设置模型名与 slug，返回修改后的实例（builder 模式）。
    pub fn with_model(mut self, model: &str, slug: &str) -> Self {
        self.metadata.model = model.to_owned();
        self.metadata.slug = slug.to_owned();
        self
    }

    /// 设置推理请求的 service tier 与 reasoning effort，返回修改后的实例（builder 模式）。
    pub fn with_inference_request(
        mut self,
        service_tier: Option<&str>,
        model_reasoning_effort: Option<&ReasoningEffort>,
    ) -> Self {
        self.metadata.service_tier = service_tier.map(str::to_owned);
        self.metadata.model_reasoning_effort = model_reasoning_effort.map(ToString::to_string);
        self
    }

    /// 设置 metrics 的 service name（会做标签值清洗），返回修改后的实例（builder 模式）。
    pub fn with_metrics_service_name(mut self, service_name: &str) -> Self {
        self.metadata.service_name = Some(sanitize_metric_tag_value(service_name));
        self
    }

    /// 绑定 metrics 客户端并启用 metadata 标签，返回修改后的实例（builder 模式）。
    pub fn with_metrics(mut self, metrics: MetricsClient) -> Self {
        self.metrics = Some(metrics);
        self.metrics_use_metadata_tags = true;
        self
    }

    /// 绑定 metrics 客户端但禁用 metadata 标签，返回修改后的实例（builder 模式）。
    pub fn with_metrics_without_metadata_tags(mut self, metrics: MetricsClient) -> Self {
        self.metrics = Some(metrics);
        self.metrics_use_metadata_tags = false;
        self
    }

    /// 根据 [`MetricsConfig`] 构建 metrics 客户端并绑定，返回修改后的实例（builder 模式）。
    pub fn with_metrics_config(self, config: MetricsConfig) -> MetricsResult<Self> {
        let metrics = MetricsClient::new(config)?;
        Ok(self.with_metrics(metrics))
    }

    /// 从 [`OtelProvider`] 中复用 metrics 客户端并绑定，返回修改后的实例（builder 模式）。
    pub fn with_provider_metrics(self, provider: &OtelProvider) -> Self {
        match provider.metrics() {
            Some(metrics) => self.with_metrics(metrics.clone()),
            None => self,
        }
    }

    /// 记录一个 counter 指标；若 metrics 客户端未启用则跳过。
    ///
    /// 参数：
    /// - `name`：指标名称。
    /// - `inc`：增量值。
    /// - `tags`：附加标签。
    pub fn counter(&self, name: &str, inc: i64, tags: &[(&str, &str)]) {
        let res: MetricsResult<()> = (|| {
            let Some(metrics) = &self.metrics else {
                return Ok(());
            };

            let tags = self.tags_with_metadata(tags)?;
            metrics.counter(name, inc, &tags)
        })();

        if let Err(e) = res {
            tracing::warn!("metrics counter [{name}] failed: {e}");
        }
    }

    /// 记录一个 histogram 指标；若 metrics 客户端未启用则跳过。
    ///
    /// 参数：
    /// - `name`：指标名称。
    /// - `value`：本次观测值。
    /// - `tags`：附加标签。
    pub fn histogram(&self, name: &str, value: i64, tags: &[(&str, &str)]) {
        let res: MetricsResult<()> = (|| {
            let Some(metrics) = &self.metrics else {
                return Ok(());
            };

            let tags = self.tags_with_metadata(tags)?;
            metrics.histogram(name, value, &tags)
        })();

        if let Err(e) = res {
            tracing::warn!("metrics histogram [{name}] failed: {e}");
        }
    }

    /// 记录一个 duration histogram 指标；若 metrics 客户端未启用则跳过。
    ///
    /// 参数：
    /// - `name`：指标名称。
    /// - `duration`：耗时。
    /// - `tags`：附加标签。
    pub fn record_duration(&self, name: &str, duration: Duration, tags: &[(&str, &str)]) {
        let res: MetricsResult<()> = (|| {
            let Some(metrics) = &self.metrics else {
                return Ok(());
            };

            let tags = self.tags_with_metadata(tags)?;
            metrics.record_duration(name, duration, &tags)
        })();

        if let Err(e) = res {
            tracing::warn!("metrics duration [{name}] failed: {e}");
        }
    }

    /// 记录一个粗粒度启动阶段，用于生产环境耗时分解。
    pub fn record_startup_phase(
        &self,
        phase: &'static str,
        duration: Duration,
        status: Option<&'static str>,
    ) {
        let tags = match status {
            Some(status) => vec![("phase", phase), ("status", status)],
            None => vec![("phase", phase)],
        };
        self.record_duration(STARTUP_PHASE_DURATION_METRIC, duration, &tags);
        log_and_trace_event!(
            self,
            common: {
                event.name = "codex.startup_phase",
                startup.phase = phase,
                startup.status = status,
                duration_ms = %duration.as_millis(),
            },
            log: {},
            trace: {},
        );
    }

    /// 记录首 token 耗时（TTFT），同时作为 metric 与生产 telemetry 事件。
    pub fn record_turn_ttft(&self, duration: Duration) {
        self.record_duration(TURN_TTFT_DURATION_METRIC, duration, &[]);
        log_and_trace_event!(
            self,
            common: {
                event.name = "codex.turn_ttft",
                duration_ms = %duration.as_millis(),
            },
            log: {},
            trace: {},
        );
    }

    /// 记录插件或连接器安装 elicitation 派发时刻。
    ///
    /// 参数：
    /// - `tool_type`：工具类型（如 plugin / connector）。
    /// - `tool_id`：工具唯一标识。
    /// - `tool_name`：工具可读名称。
    pub fn record_plugin_install_elicitation_sent(
        &self,
        tool_type: &str,
        tool_id: &str,
        tool_name: &str,
    ) {
        self.counter(
            PLUGIN_INSTALL_ELICITATION_SENT_METRIC,
            /*inc*/ 1,
            &[("tool_type", tool_type)],
        );
        log_and_trace_event!(
            self,
            common: {
                event.name = "codex.plugin_install_elicitation_sent",
                plugin_install.tool_type = tool_type,
                plugin_install.tool_id = tool_id,
                plugin_install.tool_name = tool_name,
            },
            log: {},
            trace: {},
        );
    }

    /// 记录展示给用户的插件或连接器安装建议的处理结果。
    ///
    /// 参数：
    /// - `tool_type`：工具类型（如 plugin / connector）。
    /// - `tool_id`：工具唯一标识。
    /// - `tool_name`：工具可读名称。
    /// - `response_action`：用户响应动作（如 accept / decline / dismiss）。
    /// - `user_confirmed`：用户是否确认安装。
    /// - `completed`：安装是否已完成。
    pub fn record_plugin_install_suggestion(
        &self,
        tool_type: &str,
        tool_id: &str,
        tool_name: &str,
        response_action: &str,
        user_confirmed: bool,
        completed: bool,
    ) {
        let completed_tag = if completed { "true" } else { "false" };
        self.counter(
            PLUGIN_INSTALL_SUGGESTION_METRIC,
            /*inc*/ 1,
            &[
                ("tool_type", tool_type),
                ("response_action", response_action),
                ("completed", completed_tag),
            ],
        );
        log_and_trace_event!(
            self,
            common: {
                event.name = "codex.plugin_install_suggestion",
                plugin_install.tool_type = tool_type,
                plugin_install.tool_id = tool_id,
                plugin_install.tool_name = tool_name,
                plugin_install.response_action = response_action,
                plugin_install.user_confirmed = user_confirmed,
                plugin_install.completed = completed,
            },
            log: {},
            trace: {},
        );
    }

    /// 启动一个 [`Timer`]，drop 时自动记录耗时；若 metrics 客户端未启用则返回错误。
    ///
    /// 参数：
    /// - `name`：指标名称。
    /// - `tags`：附加标签。
    pub fn start_timer(&self, name: &str, tags: &[(&str, &str)]) -> Result<Timer, MetricsError> {
        let Some(metrics) = &self.metrics else {
            return Err(MetricsError::ExporterDisabled);
        };
        let tags = self.tags_with_metadata(tags)?;
        metrics.start_timer(name, &tags)
    }

    /// 关闭并刷新底层 metrics provider；若 metrics 客户端未启用则直接返回成功。
    pub fn shutdown_metrics(&self) -> MetricsResult<()> {
        let Some(metrics) = &self.metrics else {
            return Ok(());
        };
        metrics.shutdown()
    }

    /// 获取一次 metrics 快照；若 metrics 客户端未启用则返回错误。
    pub fn snapshot_metrics(&self) -> MetricsResult<ResourceMetrics> {
        let Some(metrics) = &self.metrics else {
            return Err(MetricsError::ExporterDisabled);
        };
        metrics.snapshot()
    }

    /// 采集并丢弃一次运行时 metrics 快照，用于重置 delta 累加器。
    pub fn reset_runtime_metrics(&self) {
        if self.metrics.is_none() {
            return;
        }
        if let Err(err) = self.snapshot_metrics() {
            tracing::debug!("runtime metrics reset skipped: {err}");
        }
    }

    /// 在 debug 快照可用时采集运行时 metrics 汇总。
    ///
    /// 返回值：
    /// - `Some(summary)`：采集成功且汇总非空。
    /// - `None`：metrics 客户端未启用、快照失败或汇总为空。
    pub fn runtime_metrics_summary(&self) -> Option<RuntimeMetricsSummary> {
        let snapshot = match self.snapshot_metrics() {
            Ok(snapshot) => snapshot,
            Err(_) => {
                return None;
            }
        };
        let summary = RuntimeMetricsSummary::from_snapshot(&snapshot);
        if summary.is_empty() {
            None
        } else {
            Some(summary)
        }
    }

    fn tags_with_metadata<'a>(
        &'a self,
        tags: &'a [(&'a str, &'a str)],
    ) -> MetricsResult<Vec<(&'a str, &'a str)>> {
        let mut merged = self.metadata_tag_refs()?;
        merged.extend(tags.iter().copied());
        Ok(merged)
    }

    fn metadata_tag_refs(&self) -> MetricsResult<Vec<(&str, &str)>> {
        if !self.metrics_use_metadata_tags {
            return Ok(Vec::new());
        }
        SessionMetricTagValues {
            auth_mode: self.metadata.auth_mode.as_deref(),
            session_source: self.metadata.session_source.as_str(),
            originator: self.metadata.originator.as_str(),
            service_name: self.metadata.service_name.as_deref(),
            model: self.metadata.model.as_str(),
            app_version: self.metadata.app_version,
        }
        .into_tags()
    }

    /// 创建一个会话级 telemetry 记录器。
    ///
    /// 参数：
    /// - `conversation_id`：会话 ID。
    /// - `model`：模型名。
    /// - `slug`：模型 slug。
    /// - `account_id`：账户 ID（可选）。
    /// - `account_email`：账户邮箱（可选）。
    /// - `auth_mode`：认证模式（可选）。
    /// - `originator`：发起方标识。
    /// - `log_user_prompts`：是否记录用户 prompt 内容。
    /// - `terminal_type`：终端类型。
    /// - `session_source`：会话来源。
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        conversation_id: ThreadId,
        model: &str,
        slug: &str,
        account_id: Option<String>,
        account_email: Option<String>,
        auth_mode: Option<TelemetryAuthMode>,
        originator: String,
        log_user_prompts: bool,
        terminal_type: String,
        session_source: SessionSource,
    ) -> SessionTelemetry {
        Self {
            metadata: SessionTelemetryMetadata {
                conversation_id,
                auth_mode: auth_mode.map(|m| m.to_string()),
                auth_env: AuthEnvTelemetryMetadata::default(),
                account_id,
                account_email,
                originator: sanitize_metric_tag_value(originator.as_str()),
                service_name: None,
                session_source: session_source.to_string(),
                model: model.to_owned(),
                slug: slug.to_owned(),
                service_tier: None,
                model_reasoning_effort: None,
                log_user_prompts,
                app_version: env!("CARGO_PKG_VERSION"),
                terminal_type,
            },
            metrics: crate::metrics::global(),
            metrics_use_metadata_tags: true,
        }
    }

    /// 记录一次 Responses API 事件到指定 span 上。
    ///
    /// 根据事件类型在 span 上记录 `otel.name`、`from`、`tool_name`、token usage
    /// 等字段，便于在分布式 trace 中检索。
    ///
    /// 参数：
    /// - `handle_responses_span`：承载响应处理事件的目标 span。
    /// - `event`：Responses API 事件。
    pub fn record_responses(&self, handle_responses_span: &Span, event: &ResponseEvent) {
        handle_responses_span.record("otel.name", SessionTelemetry::responses_type(event));

        match event {
            ResponseEvent::OutputItemDone(item) => {
                handle_responses_span.record("from", "output_item_done");
                if let ResponseItem::FunctionCall { name, .. } = item {
                    handle_responses_span.record("tool_name", name.as_str());
                }
            }
            ResponseEvent::OutputItemAdded(item) => {
                handle_responses_span.record("from", "output_item_added");
                if let ResponseItem::FunctionCall { name, .. } = item {
                    handle_responses_span.record("tool_name", name.as_str());
                }
            }
            ResponseEvent::Completed {
                token_usage: Some(token_usage),
                ..
            } => {
                handle_responses_span.record("gen_ai.usage.input_tokens", token_usage.input_tokens);
                handle_responses_span.record(
                    "gen_ai.usage.cache_read.input_tokens",
                    token_usage.cached_input(),
                );
                handle_responses_span
                    .record("gen_ai.usage.output_tokens", token_usage.output_tokens);
                handle_responses_span.record(
                    "codex.usage.reasoning_output_tokens",
                    token_usage.reasoning_output_tokens,
                );
                handle_responses_span.record("codex.usage.total_tokens", token_usage.total_tokens);
            }
            _ => {}
        }
    }

    /// 记录一次会话开始事件，包含 provider、reasoning、context、approval、sandbox 等上下文。
    ///
    /// 参数：
    /// - `provider_name`：provider 名称。
    /// - `reasoning_effort`：推理强度（可选）。
    /// - `reasoning_summary`：推理摘要策略。
    /// - `context_window`：上下文窗口大小（可选）。
    /// - `auto_compact_token_limit`：自动压缩的 token 阈值（可选）。
    /// - `approval_policy`：审批策略。
    /// - `sandbox_policy`：沙箱策略。
    /// - `mcp_servers`：MCP server 名称列表。
    #[allow(clippy::too_many_arguments)]
    pub fn conversation_starts(
        &self,
        provider_name: &str,
        reasoning_effort: Option<ReasoningEffort>,
        reasoning_summary: ReasoningSummary,
        context_window: Option<i64>,
        auto_compact_token_limit: Option<i64>,
        approval_policy: AskForApproval,
        sandbox_policy: SandboxPolicy,
        mcp_servers: Vec<&str>,
    ) {
        log_and_trace_event!(
            self,
            common: {
                event.name = "codex.conversation_starts",
                provider_name = %provider_name,
                auth.env_openai_api_key_present = self.metadata.auth_env.openai_api_key_env_present,
                auth.env_codex_api_key_present = self.metadata.auth_env.codex_api_key_env_present,
                auth.env_codex_api_key_enabled = self.metadata.auth_env.codex_api_key_env_enabled,
                auth.env_provider_key_name = self.metadata.auth_env.provider_env_key_name.as_deref(),
                auth.env_provider_key_present = self.metadata.auth_env.provider_env_key_present,
                auth.env_refresh_token_url_override_present = self.metadata.auth_env.refresh_token_url_override_present,
                reasoning_effort = reasoning_effort.as_ref().map(ToString::to_string),
                reasoning_summary = %reasoning_summary,
                context_window = context_window,
                auto_compact_token_limit = auto_compact_token_limit,
                approval_policy = %approval_policy,
                sandbox_policy = %sandbox_policy,
            },
            log: {
                mcp_servers = mcp_servers.join(", "),
            },
            trace: {
                mcp_server_count = mcp_servers.len() as i64,
            },
        );
    }

    /// 执行一次 HTTP 请求并自动记录 API 调用耗时与状态。
    ///
    /// 参数：
    /// - `attempt`：当前重试序号（从 0 开始）。
    /// - `f`：执行实际请求的 future 工厂。
    ///
    /// 返回原始的 [`Response`] 或 [`Error`]，不修改请求结果。
    pub async fn log_request<F, Fut>(&self, attempt: u64, f: F) -> Result<Response, Error>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Response, Error>>,
    {
        let start = Instant::now();
        let response = f().await;
        let duration = start.elapsed();

        let (status, error) = match &response {
            Ok(response) => (Some(response.status().as_u16()), None),
            Err(error) => (error.status().map(|s| s.as_u16()), Some(error.to_string())),
        };
        self.record_api_request(
            attempt,
            status,
            error.as_deref(),
            duration,
            /*auth_header_attached*/ false,
            /*auth_header_name*/ None,
            /*retry_after_unauthorized*/ false,
            /*recovery_mode*/ None,
            /*recovery_phase*/ None,
            "unknown",
            /*request_id*/ None,
            /*cf_ray*/ None,
            /*auth_error*/ None,
            /*auth_error_code*/ None,
            /*agent_identity_telemetry*/ None,
        );

        response
    }

    /// 记录一次 API 请求的耗时、状态与认证相关信息。
    ///
    /// 会同时更新 counter / duration metric 与生产 telemetry 事件，
    /// 便于追踪认证失败、重试、恢复等场景。
    ///
    /// 参数：
    /// - `attempt`：当前重试序号。
    /// - `status`：HTTP 状态码（可选）。
    /// - `error`：错误消息（可选）。
    /// - `duration`：请求耗时。
    /// - `auth_header_attached`：是否附加了认证 header。
    /// - `auth_header_name`：认证 header 名称（可选）。
    /// - `retry_after_unauthorized`：是否在未授权后重试。
    /// - `recovery_mode`：恢复模式（可选）。
    /// - `recovery_phase`：恢复阶段（可选）。
    /// - `endpoint`：请求端点。
    /// - `request_id`：请求 ID（可选）。
    /// - `cf_ray`：Cloudflare ray ID（可选）。
    /// - `auth_error`：认证错误消息（可选）。
    /// - `auth_error_code`：认证错误码（可选）。
    /// - `agent_identity_telemetry`：agent 身份 telemetry（可选）。
    #[allow(clippy::too_many_arguments)]
    pub fn record_api_request(
        &self,
        attempt: u64,
        status: Option<u16>,
        error: Option<&str>,
        duration: Duration,
        auth_header_attached: bool,
        auth_header_name: Option<&str>,
        retry_after_unauthorized: bool,
        recovery_mode: Option<&str>,
        recovery_phase: Option<&str>,
        endpoint: &str,
        request_id: Option<&str>,
        cf_ray: Option<&str>,
        auth_error: Option<&str>,
        auth_error_code: Option<&str>,
        agent_identity_telemetry: Option<&AgentIdentityTelemetry>,
    ) {
        let success = status.is_some_and(|code| (200..=299).contains(&code)) && error.is_none();
        let success_str = if success { "true" } else { "false" };
        let status_str = status
            .map(|code| code.to_string())
            .unwrap_or_else(|| "none".to_string());
        self.counter(
            API_CALL_COUNT_METRIC,
            /*inc*/ 1,
            &[("status", status_str.as_str()), ("success", success_str)],
        );
        self.record_duration(
            API_CALL_DURATION_METRIC,
            duration,
            &[("status", status_str.as_str()), ("success", success_str)],
        );
        log_and_trace_event!(
            self,
            common: {
                event.name = "codex.api_request",
                duration_ms = %duration.as_millis(),
                http.response.status_code = status,
                error.message = error,
                attempt = attempt,
                auth.header_attached = auth_header_attached,
                auth.header_name = auth_header_name,
                auth.retry_after_unauthorized = retry_after_unauthorized,
                auth.recovery_mode = recovery_mode,
                auth.recovery_phase = recovery_phase,
                endpoint = endpoint,
                auth.env_openai_api_key_present = self.metadata.auth_env.openai_api_key_env_present,
                auth.env_codex_api_key_present = self.metadata.auth_env.codex_api_key_env_present,
                auth.env_codex_api_key_enabled = self.metadata.auth_env.codex_api_key_env_enabled,
                auth.env_provider_key_name = self.metadata.auth_env.provider_env_key_name.as_deref(),
                auth.env_provider_key_present = self.metadata.auth_env.provider_env_key_present,
                auth.env_refresh_token_url_override_present = self.metadata.auth_env.refresh_token_url_override_present,
                auth.request_id = request_id,
                auth.cf_ray = cf_ray,
                auth.error = auth_error,
                auth.error_code = auth_error_code,
                auth.agent_id = agent_identity_telemetry.map(|metadata| metadata.agent_id.as_str()),
                auth.task_id = agent_identity_telemetry.map(|metadata| metadata.task_id.as_str()),
            },
            log: {},
            trace: {},
        );
    }

    /// 记录一次 WebSocket 连接建立事件，包含耗时、状态与认证信息。
    ///
    /// 参数：
    /// - `duration`：连接建立耗时。
    /// - `status`：HTTP 升级状态码（可选）。
    /// - `error`：错误消息（可选）。
    /// - `auth_header_attached`：是否附加了认证 header。
    /// - `auth_header_name`：认证 header 名称（可选）。
    /// - `retry_after_unauthorized`：是否在未授权后重试。
    /// - `recovery_mode`：恢复模式（可选）。
    /// - `recovery_phase`：恢复阶段（可选）。
    /// - `endpoint`：连接端点。
    /// - `connection_reused`：是否复用已有连接。
    /// - `request_id`：请求 ID（可选）。
    /// - `cf_ray`：Cloudflare ray ID（可选）。
    /// - `auth_error`：认证错误消息（可选）。
    /// - `auth_error_code`：认证错误码（可选）。
    /// - `agent_identity_telemetry`：agent 身份 telemetry（可选）。
    #[allow(clippy::too_many_arguments)]
    pub fn record_websocket_connect(
        &self,
        duration: Duration,
        status: Option<u16>,
        error: Option<&str>,
        auth_header_attached: bool,
        auth_header_name: Option<&str>,
        retry_after_unauthorized: bool,
        recovery_mode: Option<&str>,
        recovery_phase: Option<&str>,
        endpoint: &str,
        connection_reused: bool,
        request_id: Option<&str>,
        cf_ray: Option<&str>,
        auth_error: Option<&str>,
        auth_error_code: Option<&str>,
        agent_identity_telemetry: Option<&AgentIdentityTelemetry>,
    ) {
        let success = error.is_none()
            && status
                .map(|code| (200..=299).contains(&code))
                .unwrap_or(true);
        let success_str = if success { "true" } else { "false" };
        log_and_trace_event!(
            self,
            common: {
                event.name = "codex.websocket_connect",
                duration_ms = %duration.as_millis(),
                http.response.status_code = status,
                success = success_str,
                error.message = error,
                auth.header_attached = auth_header_attached,
                auth.header_name = auth_header_name,
                auth.retry_after_unauthorized = retry_after_unauthorized,
                auth.recovery_mode = recovery_mode,
                auth.recovery_phase = recovery_phase,
                endpoint = endpoint,
                auth.env_openai_api_key_present = self.metadata.auth_env.openai_api_key_env_present,
                auth.env_codex_api_key_present = self.metadata.auth_env.codex_api_key_env_present,
                auth.env_codex_api_key_enabled = self.metadata.auth_env.codex_api_key_env_enabled,
                auth.env_provider_key_name = self.metadata.auth_env.provider_env_key_name.as_deref(),
                auth.env_provider_key_present = self.metadata.auth_env.provider_env_key_present,
                auth.env_refresh_token_url_override_present = self.metadata.auth_env.refresh_token_url_override_present,
                auth.connection_reused = connection_reused,
                auth.request_id = request_id,
                auth.cf_ray = cf_ray,
                auth.error = auth_error,
                auth.error_code = auth_error_code,
                auth.agent_id = agent_identity_telemetry.map(|metadata| metadata.agent_id.as_str()),
                auth.task_id = agent_identity_telemetry.map(|metadata| metadata.task_id.as_str()),
            },
            log: {},
            trace: {},
        );
    }

    /// 记录一次 WebSocket 请求的耗时与结果。
    ///
    /// 参数：
    /// - `duration`：请求耗时。
    /// - `error`：错误消息（可选）。
    /// - `connection_reused`：是否复用已有连接。
    /// - `agent_identity_telemetry`：agent 身份 telemetry（可选）。
    pub fn record_websocket_request(
        &self,
        duration: Duration,
        error: Option<&str>,
        connection_reused: bool,
        agent_identity_telemetry: Option<&AgentIdentityTelemetry>,
    ) {
        let success_str = if error.is_none() { "true" } else { "false" };
        self.counter(
            WEBSOCKET_REQUEST_COUNT_METRIC,
            /*inc*/ 1,
            &[("success", success_str)],
        );
        self.record_duration(
            WEBSOCKET_REQUEST_DURATION_METRIC,
            duration,
            &[("success", success_str)],
        );
        log_and_trace_event!(
            self,
            common: {
                event.name = "codex.websocket_request",
                duration_ms = %duration.as_millis(),
                success = success_str,
                error.message = error,
                auth.env_openai_api_key_present = self.metadata.auth_env.openai_api_key_env_present,
                auth.env_codex_api_key_present = self.metadata.auth_env.codex_api_key_env_present,
                auth.env_codex_api_key_enabled = self.metadata.auth_env.codex_api_key_env_enabled,
                auth.env_provider_key_name = self.metadata.auth_env.provider_env_key_name.as_deref(),
                auth.env_provider_key_present = self.metadata.auth_env.provider_env_key_present,
                auth.env_refresh_token_url_override_present = self.metadata.auth_env.refresh_token_url_override_present,
                auth.connection_reused = connection_reused,
                auth.agent_id = agent_identity_telemetry.map(|metadata| metadata.agent_id.as_str()),
                auth.task_id = agent_identity_telemetry.map(|metadata| metadata.task_id.as_str()),
            },
            log: {},
            trace: {},
        );
    }

    /// 记录一次认证恢复事件，用于追踪认证失败后的恢复流程。
    ///
    /// 参数：
    /// - `mode`：恢复模式。
    /// - `step`：恢复步骤。
    /// - `outcome`：恢复结果。
    /// - `request_id`：关联的请求 ID（可选）。
    /// - `cf_ray`：Cloudflare ray ID（可选）。
    /// - `auth_error`：原始认证错误消息（可选）。
    /// - `auth_error_code`：原始认证错误码（可选）。
    /// - `recovery_reason`：恢复触发原因（可选）。
    /// - `auth_state_changed`：认证状态是否发生变化（可选）。
    #[allow(clippy::too_many_arguments)]
    pub fn record_auth_recovery(
        &self,
        mode: &str,
        step: &str,
        outcome: &str,
        request_id: Option<&str>,
        cf_ray: Option<&str>,
        auth_error: Option<&str>,
        auth_error_code: Option<&str>,
        recovery_reason: Option<&str>,
        auth_state_changed: Option<bool>,
    ) {
        log_and_trace_event!(
            self,
            common: {
                event.name = "codex.auth_recovery",
                auth.mode = mode,
                auth.step = step,
                auth.outcome = outcome,
                auth.request_id = request_id,
                auth.cf_ray = cf_ray,
                auth.error = auth_error,
                auth.error_code = auth_error_code,
                auth.recovery_reason = recovery_reason,
                auth.state_changed = auth_state_changed,
            },
            log: {},
            trace: {},
        );
    }

    /// 记录一次 WebSocket 事件，根据消息类型分类并采集计数与耗时。
    ///
    /// 参数：
    /// - `result`：WebSocket 接收结果（消息 / 错误 / 关闭）。
    /// - `duration`：本次事件处理耗时。
    ///
    /// 当消息为 `responsesapi.websocket_timing` 类型时，会额外解析
    /// timing_metrics 字段并记录 Responses API 耗时分解指标。
    pub fn record_websocket_event(
        &self,
        result: &Result<
            Option<
                Result<
                    tokio_tungstenite::tungstenite::Message,
                    tokio_tungstenite::tungstenite::Error,
                >,
            >,
            ApiError,
        >,
        duration: Duration,
    ) {
        let mut kind = None;
        let mut success = true;

        match result {
            Ok(Some(Ok(message))) => match message {
                tokio_tungstenite::tungstenite::Message::Text(text) => {
                    match serde_json::from_str::<serde_json::Value>(text) {
                        Ok(value) => {
                            kind = value
                                .get("type")
                                .and_then(|value| value.as_str())
                                .map(std::string::ToString::to_string);
                            if kind.as_deref() == Some(RESPONSES_WEBSOCKET_TIMING_KIND) {
                                self.record_responses_websocket_timing_metrics(&value);
                            }
                            if kind.as_deref() == Some("response.failed") {
                                success = false;
                            }
                        }
                        Err(_) => {
                            kind = Some("parse_error".to_string());
                            success = false;
                        }
                    }
                }
                tokio_tungstenite::tungstenite::Message::Ping(_)
                | tokio_tungstenite::tungstenite::Message::Pong(_) => {
                    return;
                }
                tokio_tungstenite::tungstenite::Message::Binary(_)
                | tokio_tungstenite::tungstenite::Message::Close(_)
                | tokio_tungstenite::tungstenite::Message::Frame(_) => {
                    success = false;
                }
            },
            Ok(Some(Err(_))) | Ok(None) | Err(_) => {
                success = false;
            }
        }

        let kind_str = kind.as_deref().unwrap_or(WEBSOCKET_UNKNOWN_KIND);
        let success_str = if success { "true" } else { "false" };
        let tags = [("kind", kind_str), ("success", success_str)];
        self.counter(WEBSOCKET_EVENT_COUNT_METRIC, /*inc*/ 1, &tags);
        self.record_duration(WEBSOCKET_EVENT_DURATION_METRIC, duration, &tags);
    }

    /// 记录一次 SSE 流式事件，根据事件类型与解析结果分类采集。
    ///
    /// 参数：
    /// - `response`：SSE 接收结果，可能是事件、错误或超时。
    /// - `duration`：本次事件接收耗时。
    ///
    /// `response.completed` 事件解析失败会通过 [`see_event_completed_failed`]
    /// 单独记录；`response.failed` 与解析错误会通过 [`sse_event_failed`] 记录。
    pub fn log_sse_event<E>(
        &self,
        response: &Result<Option<Result<StreamEvent, StreamError<E>>>, Elapsed>,
        duration: Duration,
    ) where
        E: std::fmt::Display,
    {
        match response {
            Ok(Some(Ok(sse))) => {
                if sse.data.trim() == "[DONE]" {
                    self.sse_event(&sse.event, duration);
                } else {
                    match serde_json::from_str::<serde_json::Value>(&sse.data) {
                        Ok(error) if sse.event == "response.failed" => {
                            self.sse_event_failed(Some(&sse.event), duration, &error);
                        }
                        Ok(content) if sse.event == "response.output_item.done" => {
                            match serde_json::from_value::<ResponseItem>(content) {
                                Ok(_) => self.sse_event(&sse.event, duration),
                                Err(_) => {
                                    self.sse_event_failed(
                                        Some(&sse.event),
                                        duration,
                                        &"failed to parse response.output_item.done",
                                    );
                                }
                            };
                        }
                        Ok(_) => {
                            self.sse_event(&sse.event, duration);
                        }
                        Err(error) => {
                            self.sse_event_failed(Some(&sse.event), duration, &error);
                        }
                    }
                }
            }
            Ok(Some(Err(error))) => {
                self.sse_event_failed(/*kind*/ None, duration, error);
            }
            Ok(None) => {}
            Err(_) => {
                self.sse_event_failed(
                    /*kind*/ None,
                    duration,
                    &"idle timeout waiting for SSE",
                );
            }
        }
    }

    fn sse_event(&self, kind: &str, duration: Duration) {
        self.counter(
            SSE_EVENT_COUNT_METRIC,
            /*inc*/ 1,
            &[("kind", kind), ("success", "true")],
        );
        self.record_duration(
            SSE_EVENT_DURATION_METRIC,
            duration,
            &[("kind", kind), ("success", "true")],
        );
        log_event!(
            self,
            event.name = "codex.sse_event",
            event.kind = %kind,
            duration_ms = %duration.as_millis(),
        );
    }

    /// 记录一次失败的 SSE 事件，更新 counter、duration metric 并输出日志与 trace。
    ///
    /// 参数：
    /// - `kind`：事件类型（可选；缺失时使用 `unknown`）。
    /// - `duration`：本次事件耗时。
    /// - `error`：错误信息（实现 [`Display`](std::fmt::Display)）。
    pub fn sse_event_failed<T>(&self, kind: Option<&String>, duration: Duration, error: &T)
    where
        T: std::fmt::Display,
    {
        let kind_str = kind.map_or(SSE_UNKNOWN_KIND, String::as_str);
        self.counter(
            SSE_EVENT_COUNT_METRIC,
            /*inc*/ 1,
            &[("kind", kind_str), ("success", "false")],
        );
        self.record_duration(
            SSE_EVENT_DURATION_METRIC,
            duration,
            &[("kind", kind_str), ("success", "false")],
        );
        match kind {
            Some(kind) => log_event!(
                self,
                event.name = "codex.sse_event",
                event.kind = %kind,
                duration_ms = %duration.as_millis(),
                error.message = %error,
            ),
            None => log_event!(
                self,
                event.name = "codex.sse_event",
                duration_ms = %duration.as_millis(),
                error.message = %error,
            ),
        }
        trace_event!(
            self,
            event.name = "codex.sse_event",
            event.kind = %kind_str,
            duration_ms = %duration.as_millis(),
            error.message = %error,
        );
    }

    /// 记录 `response.completed` SSE 事件解析失败的 telemetry 事件。
    ///
    /// 参数：
    /// - `error`：解析失败的错误信息。
    pub fn see_event_completed_failed<T>(&self, error: &T)
    where
        T: std::fmt::Display,
    {
        log_and_trace_event!(
            self,
            common: {
                event.name = "codex.sse_event",
                event.kind = %"response.completed",
                error.message = %error,
            },
            log: {},
            trace: {},
        );
    }

    /// 记录 `response.completed` SSE 事件成功完成的 telemetry，包含 token 使用量。
    ///
    /// 参数：
    /// - `input_token_count`：输入 token 数量。
    /// - `output_token_count`：输出 token 数量。
    /// - `cached_token_count`：缓存命中 token 数量（可选）。
    /// - `reasoning_token_count`：推理 token 数量（可选）。
    /// - `tool_token_count`：工具调用 token 数量。
    pub fn sse_event_completed(
        &self,
        input_token_count: i64,
        output_token_count: i64,
        cached_token_count: Option<i64>,
        reasoning_token_count: Option<i64>,
        tool_token_count: i64,
    ) {
        log_and_trace_event!(
            self,
            common: {
                event.name = "codex.sse_event",
                event.kind = %"response.completed",
                input_token_count = %input_token_count,
                output_token_count = %output_token_count,
                cached_token_count = cached_token_count,
                reasoning_token_count = reasoning_token_count,
                tool_token_count = %tool_token_count,
                service_tier = self.metadata.service_tier.as_deref(),
                model_reasoning_effort = self.metadata.model_reasoning_effort.as_deref(),
            },
            log: {},
            trace: {},
        );
    }

    /// 记录一次用户输入 prompt 事件，统计文本、图片等输入数量与长度。
    ///
    /// 当 `log_user_prompts` 为 `false` 时，prompt 内容会被替换为 `[REDACTED]`，
    /// 但仍记录长度与输入类型计数。
    ///
    /// 参数：
    /// - `items`：用户输入项切片。
    pub fn user_prompt(&self, items: &[UserInput]) {
        let prompt = items
            .iter()
            .flat_map(|item| match item {
                UserInput::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>();
        let text_input_count = items
            .iter()
            .filter(|item| matches!(item, UserInput::Text { .. }))
            .count();
        let image_input_count = items
            .iter()
            .filter(|item| matches!(item, UserInput::Image { .. }))
            .count();
        let local_image_input_count = items
            .iter()
            .filter(|item| matches!(item, UserInput::LocalImage { .. }))
            .count();

        let prompt_to_log = if self.metadata.log_user_prompts {
            prompt.as_str()
        } else {
            "[REDACTED]"
        };

        log_event!(
            self,
            event.name = "codex.user_prompt",
            prompt_length = %prompt.chars().count(),
            prompt = %prompt_to_log,
        );
        trace_event!(
            self,
            event.name = "codex.user_prompt",
            prompt_length = %prompt.chars().count(),
            text_input_count = text_input_count as i64,
            image_input_count = image_input_count as i64,
            local_image_input_count = local_image_input_count as i64,
        );
    }

    /// 记录一次工具决策事件（如批准、拒绝、修改等）。
    ///
    /// 参数：
    /// - `tool_name`：工具名称。
    /// - `call_id`：调用 ID。
    /// - `decision`：审批决策。
    /// - `source`：决策来源（用户 / 自动 / hook 等）。
    pub fn tool_decision(
        &self,
        tool_name: &str,
        call_id: &str,
        decision: &ReviewDecision,
        source: ToolDecisionSource,
    ) {
        log_event!(
            self,
            event.name = "codex.tool_decision",
            tool_name = %tool_name,
            call_id = %call_id,
            decision = %decision.clone().to_string().to_lowercase(),
            source = %source.to_string(),
        );
    }

    /// 记录一次沙箱执行结果事件，包含初始与升级后的耗时。
    ///
    /// 参数：
    /// - `tool_name`：工具名称。
    /// - `call_id`：调用 ID。
    /// - `outcome`：沙箱执行结果（如 success / failure / timeout）。
    /// - `initial_duration`：初始耗时。
    /// - `escalated_duration`：升级后的耗时（可选，例如提权后重新执行）。
    pub fn sandbox_outcome(
        &self,
        tool_name: &str,
        call_id: &str,
        outcome: &str,
        initial_duration: Duration,
        escalated_duration: Option<Duration>,
    ) {
        let initial_duration_ms = initial_duration.as_millis().min(i64::MAX as u128) as i64;
        let escalated_duration_ms =
            escalated_duration.map(|duration| duration.as_millis().min(i64::MAX as u128) as i64);
        log_event!(
            self,
            event.name = "codex.sandbox_outcome",
            tool_name = %tool_name,
            call_id = %call_id,
            outcome = %outcome,
            initial_duration_ms = initial_duration_ms,
            escalated_duration_ms = escalated_duration_ms,
        );
        trace_event!(
            self,
            event.name = "codex.sandbox_outcome",
            tool_name = %tool_name,
            call_id = %call_id,
            outcome = %outcome,
            initial_duration_ms = initial_duration_ms,
            escalated_duration_ms = escalated_duration_ms,
        );
    }

    /// 执行一次工具调用并自动记录其结果与耗时。
    ///
    /// 在调用 `f` 前后采集耗时，无论成功或失败都会记录到 metric 与 telemetry。
    ///
    /// 参数：
    /// - `tool_name`：工具名称。
    /// - `call_id`：调用 ID。
    /// - `arguments`：工具入参（字符串形式）。
    /// - `extra_tags`：附加 metric 标签。
    /// - `extra_trace_fields`：附加 trace 字段。
    /// - `f`：执行实际工具调用的 future 工厂。
    ///
    /// 返回值：
    /// - 成功：`(preview, success)`。
    /// - 失败：错误对象（已记录到 telemetry）。
    #[allow(clippy::too_many_arguments)]
    pub async fn log_tool_result_with_tags<F, Fut, E>(
        &self,
        tool_name: &str,
        call_id: &str,
        arguments: &str,
        extra_tags: &[(&str, &str)],
        extra_trace_fields: &[(&str, &str)],
        f: F,
    ) -> Result<(String, bool), E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<(String, bool), E>>,
        E: std::fmt::Display,
    {
        let start = Instant::now();
        let result = f().await;
        let duration = start.elapsed();

        let (output, success) = match &result {
            Ok((preview, success)) => (Cow::Borrowed(preview.as_str()), *success),
            Err(error) => (Cow::Owned(error.to_string()), false),
        };

        self.tool_result_with_tags(
            tool_name,
            call_id,
            arguments,
            duration,
            success,
            output.as_ref(),
            extra_tags,
            extra_trace_fields,
        );

        result
    }

    /// 记录一次工具调用失败事件（在工具尚未执行就被拒绝时使用）。
    ///
    /// 参数：
    /// - `tool_name`：工具名称。
    /// - `error`：失败原因。
    pub fn log_tool_failed(&self, tool_name: &str, error: &str) {
        log_event!(
            self,
            event.name = "codex.tool_result",
            tool_name = %tool_name,
            duration_ms = %Duration::ZERO.as_millis(),
            success = %false,
            output = %error,
            mcp_server = "",
            mcp_server_origin = "",
        );
        trace_event!(
            self,
            event.name = "codex.tool_result",
            tool_name = %tool_name,
            duration_ms = %Duration::ZERO.as_millis(),
            success = %false,
            output_length = error.len() as i64,
            output_line_count = error.lines().count() as i64,
            tool_origin = %"builtin",
            error.message = %error,
        );
    }

    /// 记录一次工具调用的结果指标与 telemetry 事件。
    ///
    /// 会同时更新 counter（[`TOOL_CALL_COUNT_METRIC`]）、duration histogram
    /// （[`TOOL_CALL_DURATION_METRIC`]）以及 log/trace 事件。
    ///
    /// 参数：
    /// - `tool_name`：工具名称。
    /// - `call_id`：调用 ID。
    /// - `arguments`：工具入参（字符串形式）。
    /// - `duration`：本次调用耗时。
    /// - `success`：调用是否成功。
    /// - `output`：输出预览文本。
    /// - `extra_tags`：附加 metric 标签。
    /// - `extra_trace_fields`：附加 trace 字段，用于解析 `mcp_server` 等信息。
    #[allow(clippy::too_many_arguments)]
    pub fn tool_result_with_tags(
        &self,
        tool_name: &str,
        call_id: &str,
        arguments: &str,
        duration: Duration,
        success: bool,
        output: &str,
        extra_tags: &[(&str, &str)],
        extra_trace_fields: &[(&str, &str)],
    ) {
        let success_str = if success { "true" } else { "false" };
        let mut tags = Vec::with_capacity(2 + extra_tags.len());
        tags.push(("tool", tool_name));
        tags.push(("success", success_str));
        tags.extend_from_slice(extra_tags);
        self.counter(TOOL_CALL_COUNT_METRIC, /*inc*/ 1, &tags);
        self.record_duration(TOOL_CALL_DURATION_METRIC, duration, &tags);
        let mcp_server = trace_field_value(extra_trace_fields, "mcp_server").unwrap_or("");
        let mcp_server_origin =
            trace_field_value(extra_trace_fields, "mcp_server_origin").unwrap_or("");
        log_event!(
            self,
            event.name = "codex.tool_result",
            tool_name = %tool_name,
            call_id = %call_id,
            arguments = %arguments,
            duration_ms = %duration.as_millis(),
            success = %success_str,
            output = %output,
            mcp_server = %mcp_server,
            mcp_server_origin = %mcp_server_origin,
        );
        trace_event!(
            self,
            event.name = "codex.tool_result",
            tool_name = %tool_name,
            call_id = %call_id,
            duration_ms = %duration.as_millis(),
            success = %success_str,
            arguments_length = arguments.len() as i64,
            output_length = output.len() as i64,
            output_line_count = output.lines().count() as i64,
            tool_origin = if mcp_server.is_empty() { "builtin" } else { "mcp" },
            mcp_tool = !mcp_server.is_empty(),
        );
    }

    fn record_responses_websocket_timing_metrics(&self, value: &serde_json::Value) {
        let timing_metrics = value.get(RESPONSES_WEBSOCKET_TIMING_METRICS_FIELD);

        let overhead_value =
            timing_metrics.and_then(|value| value.get(RESPONSES_API_OVERHEAD_FIELD));
        if let Some(duration) = duration_from_ms_value(overhead_value) {
            self.record_duration(RESPONSES_API_OVERHEAD_DURATION_METRIC, duration, &[]);
        }

        let inference_value =
            timing_metrics.and_then(|value| value.get(RESPONSES_API_INFERENCE_FIELD));
        if let Some(duration) = duration_from_ms_value(inference_value) {
            self.record_duration(RESPONSES_API_INFERENCE_TIME_DURATION_METRIC, duration, &[]);
        }

        let engine_iapi_ttft_value =
            timing_metrics.and_then(|value| value.get(RESPONSES_API_ENGINE_IAPI_TTFT_FIELD));
        if let Some(duration) = duration_from_ms_value(engine_iapi_ttft_value) {
            self.record_duration(
                RESPONSES_API_ENGINE_IAPI_TTFT_DURATION_METRIC,
                duration,
                &[],
            );
        }

        let engine_service_ttft_value =
            timing_metrics.and_then(|value| value.get(RESPONSES_API_ENGINE_SERVICE_TTFT_FIELD));
        if let Some(duration) = duration_from_ms_value(engine_service_ttft_value) {
            self.record_duration(
                RESPONSES_API_ENGINE_SERVICE_TTFT_DURATION_METRIC,
                duration,
                &[],
            );
        }

        let engine_iapi_tbt_value =
            timing_metrics.and_then(|value| value.get(RESPONSES_API_ENGINE_IAPI_TBT_FIELD));
        if let Some(duration) = duration_from_ms_value(engine_iapi_tbt_value) {
            self.record_duration(RESPONSES_API_ENGINE_IAPI_TBT_DURATION_METRIC, duration, &[]);
        }

        let engine_service_tbt_value =
            timing_metrics.and_then(|value| value.get(RESPONSES_API_ENGINE_SERVICE_TBT_FIELD));
        if let Some(duration) = duration_from_ms_value(engine_service_tbt_value) {
            self.record_duration(
                RESPONSES_API_ENGINE_SERVICE_TBT_DURATION_METRIC,
                duration,
                &[],
            );
        }
    }

    fn responses_type(event: &ResponseEvent) -> String {
        match event {
            ResponseEvent::Created => "created".into(),
            ResponseEvent::OutputItemDone(item) | ResponseEvent::OutputItemAdded(item) => {
                SessionTelemetry::responses_item_type(item)
            }
            ResponseEvent::Completed { .. } => "completed".into(),
            ResponseEvent::OutputTextDelta(_) => "text_delta".into(),
            ResponseEvent::ToolCallInputDelta { .. } => "tool_input_delta".into(),
            ResponseEvent::ReasoningSummaryDelta { .. } => "reasoning_summary_delta".into(),
            ResponseEvent::ReasoningContentDelta { .. } => "reasoning_content_delta".into(),
            ResponseEvent::ReasoningSummaryPartAdded { .. } => {
                "reasoning_summary_part_added".into()
            }
            ResponseEvent::ServerModel(_) => "server_model".into(),
            ResponseEvent::ModelVerifications(_) => "model_verifications".into(),
            ResponseEvent::TurnModerationMetadata(_) => "turn_moderation_metadata".into(),
            ResponseEvent::SafetyBuffering(_) => "safety_buffering".into(),
            ResponseEvent::ServerReasoningIncluded(_) => "server_reasoning_included".into(),
            ResponseEvent::RateLimits(_) => "rate_limits".into(),
            ResponseEvent::ModelsEtag(_) => "models_etag".into(),
        }
    }

    fn responses_item_type(item: &ResponseItem) -> String {
        match item {
            ResponseItem::AdditionalTools { .. } => "additional_tools".into(),
            ResponseItem::Message { role, .. } => format!("message_from_{role}"),
            ResponseItem::AgentMessage { .. } => "agent_message".into(),
            ResponseItem::Reasoning { .. } => "reasoning".into(),
            ResponseItem::LocalShellCall { .. } => "local_shell_call".into(),
            ResponseItem::FunctionCall { .. } => "function_call".into(),
            ResponseItem::ToolSearchCall { .. } => "tool_search_call".into(),
            ResponseItem::FunctionCallOutput { .. } => "function_call_output".into(),
            ResponseItem::ToolSearchOutput { .. } => "tool_search_output".into(),
            ResponseItem::CustomToolCall { .. } => "custom_tool_call".into(),
            ResponseItem::CustomToolCallOutput { .. } => "custom_tool_call_output".into(),
            ResponseItem::WebSearchCall { .. } => "web_search_call".into(),
            ResponseItem::ImageGenerationCall { .. } => "image_generation_call".into(),
            ResponseItem::Compaction { .. } => "compaction".into(),
            ResponseItem::CompactionTrigger { .. } => "compaction_trigger".into(),
            ResponseItem::ContextCompaction { .. } => "context_compaction".into(),
            ResponseItem::Other => "other".into(),
        }
    }
}

fn duration_from_ms_value(value: Option<&serde_json::Value>) -> Option<Duration> {
    let value = value?;
    let ms = value
        .as_f64()
        .or_else(|| value.as_i64().map(|v| v as f64))
        .or_else(|| value.as_u64().map(|v| v as f64))?;
    if !ms.is_finite() || ms < 0.0 {
        return None;
    }
    let clamped = ms.min(u64::MAX as f64);
    Some(Duration::from_millis(clamped.round() as u64))
}
