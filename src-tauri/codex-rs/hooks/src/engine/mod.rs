//! Hook 引擎核心模块。
//!
//! 该模块负责实际运行命令式 hook：发现 handler、分发给定事件、
//! 解析命令输出，并在必要时对超长输出执行溢出落盘。
//! 引擎被 [`registry::Hooks`](crate::registry::Hooks) 持有并通过它对外暴露。

pub(crate) mod command_runner;
pub(crate) mod discovery;
pub(crate) mod dispatcher;
pub(crate) mod output_parser;
pub(crate) mod schema_loader;

use crate::events::compact::PostCompactRequest;
use crate::events::compact::PreCompactOutcome;
use crate::events::compact::PreCompactRequest;
use crate::events::compact::StatelessHookOutcome;
use crate::events::permission_request::PermissionRequestOutcome;
use crate::events::permission_request::PermissionRequestRequest;
use crate::events::post_tool_use::PostToolUseOutcome;
use crate::events::post_tool_use::PostToolUseRequest;
use crate::events::pre_tool_use::PreToolUseOutcome;
use crate::events::pre_tool_use::PreToolUseRequest;
use crate::events::session_start::SessionStartOutcome;
use crate::events::session_start::SessionStartRequest;
use crate::events::stop::StopOutcome;
use crate::events::stop::StopRequest;
use crate::events::user_prompt_submit::UserPromptSubmitOutcome;
use crate::events::user_prompt_submit::UserPromptSubmitRequest;
use crate::output_spill::HookOutputSpiller;
use codex_config::ConfigLayerStack;
use codex_plugin::PluginHookSource;
use codex_protocol::ThreadId;
use codex_protocol::protocol::HookEventName;
use codex_protocol::protocol::HookHandlerType;
use codex_protocol::protocol::HookRunSummary;
use codex_protocol::protocol::HookSource;
use codex_protocol::protocol::HookTrustStatus;
use codex_utils_absolute_path::AbsolutePathBuf;
use std::collections::HashMap;

/// 执行命令式 hook 时使用的 shell 配置。
#[derive(Debug, Clone)]
pub(crate) struct CommandShell {
    /// shell 可执行程序路径或名称。
    pub program: String,
    /// 传给 shell 的额外参数。
    pub args: Vec<String>,
}

/// 已被发现的单个命令式 hook handler 配置。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ConfiguredHandler {
    /// 该 handler 对应的事件类型。
    pub event_name: codex_protocol::protocol::HookEventName,
    /// 用于匹配工具或触发器的 matcher 表达式。
    pub matcher: Option<String>,
    /// 实际要执行的 shell 命令字符串。
    pub command: String,
    /// 单次执行的超时时间（秒）。
    pub timeout_sec: u64,
    /// 执行期间向用户展示的状态消息。
    pub status_message: Option<String>,
    /// 该 handler 来源的文件路径。
    pub source_path: AbsolutePathBuf,
    /// 该 handler 的来源分类。
    pub source: HookSource,
    /// 用于排序的全局展示顺序。
    pub display_order: i64,
    /// 执行命令时附加的环境变量。
    pub env: HashMap<String, String>,
}

impl ConfiguredHandler {
    /// 构造该 handler 的运行 ID，由事件标签、顺序与来源路径拼接而成。
    pub fn run_id(&self) -> String {
        format!(
            "{}:{}:{}",
            self.event_name_label(),
            self.display_order,
            self.source_path.display()
        )
    }

    /// 返回该 handler 事件类型对应的 kebab-case 标签。
    fn event_name_label(&self) -> &'static str {
        match self.event_name {
            codex_protocol::protocol::HookEventName::PreToolUse => "pre-tool-use",
            codex_protocol::protocol::HookEventName::PermissionRequest => "permission-request",
            codex_protocol::protocol::HookEventName::PostToolUse => "post-tool-use",
            codex_protocol::protocol::HookEventName::PreCompact => "pre-compact",
            codex_protocol::protocol::HookEventName::PostCompact => "post-compact",
            codex_protocol::protocol::HookEventName::SessionStart => "session-start",
            codex_protocol::protocol::HookEventName::UserPromptSubmit => "user-prompt-submit",
            codex_protocol::protocol::HookEventName::SubagentStart => "subagent-start",
            codex_protocol::protocol::HookEventName::SubagentStop => "subagent-stop",
            codex_protocol::protocol::HookEventName::Stop => "stop",
        }
    }
}

/// 对外暴露的单个 hook 条目，包含运行时与持久化所需的信息。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookListEntry {
    /// 持久化配置 state 的 key。
    pub key: String,
    /// 事件类型。
    pub event_name: HookEventName,
    /// handler 类型（command / prompt / agent）。
    pub handler_type: HookHandlerType,
    /// matcher 表达式。
    pub matcher: Option<String>,
    /// 命令字符串（仅 command handler 有）。
    pub command: Option<String>,
    /// 超时时间（秒）。
    pub timeout_sec: u64,
    /// 状态消息。
    pub status_message: Option<String>,
    /// 来源文件路径。
    pub source_path: AbsolutePathBuf,
    /// 来源分类。
    pub source: HookSource,
    /// 所属插件 ID（若来自插件）。
    pub plugin_id: Option<String>,
    /// 全局展示顺序。
    pub display_order: i64,
    /// 是否启用。
    pub enabled: bool,
    /// 是否为 managed 来源。
    pub is_managed: bool,
    /// 当前内容的哈希值，用于信任校验。
    pub current_hash: String,
    /// 信任状态。
    pub trust_status: HookTrustStatus,
}

/// 命令式 hook 执行引擎。
#[derive(Clone)]
pub(crate) struct ClaudeHooksEngine {
    /// 已发现的 handler 集合。
    handlers: Vec<ConfiguredHandler>,
    /// 加载阶段收集到的警告。
    warnings: Vec<String>,
    /// 执行 hook 时使用的 shell。
    shell: CommandShell,
    /// 用于处理超长输出的 spiller。
    output_spiller: HookOutputSpiller,
}

impl ClaudeHooksEngine {
    /// 构造引擎实例。
    ///
    /// 当 `enabled` 为 `false` 时返回空引擎；否则会触发 schema 初始化并
    /// 通过 [`discovery`] 收集 handler。
    pub(crate) fn new(
        enabled: bool,
        bypass_hook_trust: bool,
        config_layer_stack: Option<&ConfigLayerStack>,
        plugin_hook_sources: Vec<PluginHookSource>,
        plugin_hook_load_warnings: Vec<String>,
        shell: CommandShell,
    ) -> Self {
        if !enabled {
            return Self {
                handlers: Vec::new(),
                warnings: Vec::new(),
                shell,
                output_spiller: HookOutputSpiller::new(),
            };
        }

        let _ = schema_loader::generated_hook_schemas();
        let discovered = discovery::discover_handlers(
            config_layer_stack,
            plugin_hook_sources,
            plugin_hook_load_warnings,
            bypass_hook_trust,
        );
        Self {
            handlers: discovered.handlers,
            warnings: discovered.warnings,
            shell,
            output_spiller: HookOutputSpiller::new(),
        }
    }

    /// 返回加载阶段收集到的警告切片。
    pub(crate) fn warnings(&self) -> &[String] {
        &self.warnings
    }

    /// 预览 SessionStart 事件下匹配的 handler。
    pub(crate) fn preview_session_start(
        &self,
        request: &SessionStartRequest,
    ) -> Vec<HookRunSummary> {
        crate::events::session_start::preview(&self.handlers, request)
    }

    /// 预览 PreToolUse 事件下匹配的 handler。
    pub(crate) fn preview_pre_tool_use(&self, request: &PreToolUseRequest) -> Vec<HookRunSummary> {
        crate::events::pre_tool_use::preview(&self.handlers, request)
    }

    /// 预览 PermissionRequest 事件下匹配的 handler。
    pub(crate) fn preview_permission_request(
        &self,
        request: &PermissionRequestRequest,
    ) -> Vec<HookRunSummary> {
        crate::events::permission_request::preview(&self.handlers, request)
    }

    /// 预览 PostToolUse 事件下匹配的 handler。
    pub(crate) fn preview_post_tool_use(
        &self,
        request: &PostToolUseRequest,
    ) -> Vec<HookRunSummary> {
        crate::events::post_tool_use::preview(&self.handlers, request)
    }

    /// 实际运行 SessionStart 钩子，并对附加上下文执行溢出处理。
    pub(crate) async fn run_session_start(
        &self,
        request: SessionStartRequest,
        turn_id: Option<String>,
    ) -> SessionStartOutcome {
        let session_id = request.session_id;
        let mut outcome =
            crate::events::session_start::run(&self.handlers, &self.shell, request, turn_id).await;
        outcome.additional_contexts = self
            .maybe_spill_texts(session_id, outcome.additional_contexts)
            .await;
        outcome
    }

    /// 实际运行 PreToolUse 钩子，并对附加上下文执行溢出处理。
    pub(crate) async fn run_pre_tool_use(&self, request: PreToolUseRequest) -> PreToolUseOutcome {
        let session_id = request.session_id;
        let mut outcome =
            crate::events::pre_tool_use::run(&self.handlers, &self.shell, request).await;
        outcome.additional_contexts = self
            .maybe_spill_texts(session_id, outcome.additional_contexts)
            .await;
        outcome
    }

    /// 实际运行 PermissionRequest 钩子。
    pub(crate) async fn run_permission_request(
        &self,
        request: PermissionRequestRequest,
    ) -> PermissionRequestOutcome {
        crate::events::permission_request::run(&self.handlers, &self.shell, request).await
    }

    /// 实际运行 PostToolUse 钩子，并对附加上下文与反馈消息执行溢出处理。
    pub(crate) async fn run_post_tool_use(
        &self,
        request: PostToolUseRequest,
    ) -> PostToolUseOutcome {
        let session_id = request.session_id;
        let mut outcome =
            crate::events::post_tool_use::run(&self.handlers, &self.shell, request).await;
        outcome.additional_contexts = self
            .maybe_spill_texts(session_id, outcome.additional_contexts)
            .await;
        outcome.feedback_message = self
            .maybe_spill_text(session_id, outcome.feedback_message)
            .await;
        outcome
    }

    /// 预览 PreCompact 事件下匹配的 handler。
    pub(crate) fn preview_pre_compact(&self, request: &PreCompactRequest) -> Vec<HookRunSummary> {
        crate::events::compact::preview_pre(&self.handlers, request)
    }

    /// 实际运行 PreCompact 钩子。
    pub(crate) async fn run_pre_compact(&self, request: PreCompactRequest) -> PreCompactOutcome {
        crate::events::compact::run_pre(&self.handlers, &self.shell, request).await
    }

    /// 预览 PostCompact 事件下匹配的 handler。
    pub(crate) fn preview_post_compact(&self, request: &PostCompactRequest) -> Vec<HookRunSummary> {
        crate::events::compact::preview_post(&self.handlers, request)
    }

    /// 实际运行 PostCompact 钩子。
    pub(crate) async fn run_post_compact(
        &self,
        request: PostCompactRequest,
    ) -> StatelessHookOutcome {
        crate::events::compact::run_post(&self.handlers, &self.shell, request).await
    }

    /// 预览 UserPromptSubmit 事件下匹配的 handler。
    pub(crate) fn preview_user_prompt_submit(
        &self,
        request: &UserPromptSubmitRequest,
    ) -> Vec<HookRunSummary> {
        crate::events::user_prompt_submit::preview(&self.handlers, request)
    }

    /// 实际运行 UserPromptSubmit 钩子，并对附加上下文执行溢出处理。
    pub(crate) async fn run_user_prompt_submit(
        &self,
        request: UserPromptSubmitRequest,
    ) -> UserPromptSubmitOutcome {
        let session_id = request.session_id;
        let mut outcome =
            crate::events::user_prompt_submit::run(&self.handlers, &self.shell, request).await;
        outcome.additional_contexts = self
            .maybe_spill_texts(session_id, outcome.additional_contexts)
            .await;
        outcome
    }

    /// 预览 Stop 事件下匹配的 handler。
    pub(crate) fn preview_stop(&self, request: &StopRequest) -> Vec<HookRunSummary> {
        crate::events::stop::preview(&self.handlers, request)
    }

    /// 实际运行 Stop 钩子，并对 continuation fragment 执行溢出处理。
    pub(crate) async fn run_stop(&self, request: StopRequest) -> StopOutcome {
        let session_id = request.session_id;
        let mut outcome = crate::events::stop::run(&self.handlers, &self.shell, request).await;
        outcome.continuation_fragments = self
            .maybe_spill_prompt_fragments(session_id, outcome.continuation_fragments)
            .await;
        outcome
    }

    /// 对一组文本执行溢出处理。
    async fn maybe_spill_texts(&self, session_id: ThreadId, texts: Vec<String>) -> Vec<String> {
        self.output_spiller
            .maybe_spill_texts(session_id, texts)
            .await
    }

    /// 对单个可选文本执行溢出处理。
    async fn maybe_spill_text(&self, session_id: ThreadId, text: Option<String>) -> Option<String> {
        match text {
            Some(text) => Some(self.output_spiller.maybe_spill_text(session_id, text).await),
            None => None,
        }
    }

    /// 对一组 prompt fragment 执行溢出处理。
    async fn maybe_spill_prompt_fragments(
        &self,
        session_id: ThreadId,
        fragments: Vec<codex_protocol::items::HookPromptFragment>,
    ) -> Vec<codex_protocol::items::HookPromptFragment> {
        self.output_spiller
            .maybe_spill_prompt_fragments(session_id, fragments)
            .await
    }
}

#[cfg(test)]
#[path = "mod_tests.rs"]
mod tests;
