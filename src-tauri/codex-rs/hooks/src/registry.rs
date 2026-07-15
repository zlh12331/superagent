//! Hooks 注册表与对外 API。
//!
//! [`Hooks`] 是上层调用 Codex 钩子系统的入口，内部组合了
//! [`ClaudeHooksEngine`](crate::engine::ClaudeHooksEngine) 和旧版
//! notify 钩子。该模块同时暴露 [`list_hooks`] 用于在不启动引擎的
//! 情况下枚举已发现的 handler。

use codex_config::ConfigLayerStack;
use codex_plugin::PluginHookSource;
use tokio::process::Command;

use crate::engine::ClaudeHooksEngine;
use crate::engine::CommandShell;
use crate::engine::HookListEntry;
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
use crate::types::Hook;
use crate::types::HookEvent;
use crate::types::HookPayload;
use crate::types::HookResponse;

/// 构造 [`Hooks`] 所需的全部配置。
#[derive(Default, Clone)]
pub struct HooksConfig {
    /// 旧版 notify 钩子的 argv，第一个元素为可执行程序。
    pub legacy_notify_argv: Option<Vec<String>>,
    /// 是否启用 hook 特性总开关。
    pub feature_enabled: bool,
    /// 是否跳过 hook 信任校验（仅供内部测试或显式信任场景使用）。
    pub bypass_hook_trust: bool,
    /// 用于发现与解析 hook 的配置层栈。
    pub config_layer_stack: Option<ConfigLayerStack>,
    /// 来自插件 bundle 的 hook 来源。
    pub plugin_hook_sources: Vec<PluginHookSource>,
    /// 插件 hook 加载过程中产生的警告信息。
    pub plugin_hook_load_warnings: Vec<String>,
    /// 执行命令式 hook 时使用的 shell 程序。
    pub shell_program: Option<String>,
    /// 传给 shell 的额外参数。
    pub shell_args: Vec<String>,
}

/// [`list_hooks`] 的返回结果，包含已发现的 hook 列表与加载警告。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HookListOutcome {
    /// 已发现的 hook 条目。
    pub hooks: Vec<HookListEntry>,
    /// 加载过程中收集到的非致命警告。
    pub warnings: Vec<String>,
}

/// 钩子系统的对外入口，组合了引擎与旧版 notify 钩子。
#[derive(Clone)]
pub struct Hooks {
    /// `AfterAgent` 事件触发的旧版 notify 钩子列表。
    after_agent: Vec<Hook>,
    /// 负责命令式钩子发现与执行的核心引擎。
    engine: ClaudeHooksEngine,
}

impl Default for Hooks {
    fn default() -> Self {
        Self::new(HooksConfig::default())
    }
}

impl Hooks {
    /// 根据配置构造一个新的 [`Hooks`] 实例。
    ///
    /// 当配置中存在有效的 `legacy_notify_argv` 时，会注册一个对应的
    /// [`notify_hook`](crate::notify_hook) 到 `AfterAgent` 事件。
    pub fn new(config: HooksConfig) -> Self {
        let after_agent = config
            .legacy_notify_argv
            .filter(|argv| !argv.is_empty() && !argv[0].is_empty())
            .map(crate::notify_hook)
            .into_iter()
            .collect();
        let engine = ClaudeHooksEngine::new(
            config.feature_enabled,
            config.bypass_hook_trust,
            config.config_layer_stack.as_ref(),
            config.plugin_hook_sources,
            config.plugin_hook_load_warnings,
            CommandShell {
                program: config.shell_program.unwrap_or_default(),
                args: config.shell_args,
            },
        );
        Self {
            after_agent,
            engine,
        }
    }

    /// 返回引擎启动阶段收集到的警告信息切片。
    pub fn startup_warnings(&self) -> &[String] {
        self.engine.warnings()
    }

    /// 根据事件类型返回对应的内置 hook 列表。
    fn hooks_for_event(&self, hook_event: &HookEvent) -> &[Hook] {
        match hook_event {
            HookEvent::AfterAgent { .. } => &self.after_agent,
        }
    }

    /// 同步分发一个钩子负载到匹配的内置 hook，返回每个钩子的响应。
    ///
    /// 任一 hook 返回需要中止的结果时，后续 hook 不再执行。
    pub async fn dispatch(&self, hook_payload: HookPayload) -> Vec<HookResponse> {
        let hooks = self.hooks_for_event(&hook_payload.hook_event);
        let mut outcomes = Vec::with_capacity(hooks.len());
        for hook in hooks {
            let outcome = hook.execute(&hook_payload).await;
            let should_abort_operation = outcome.result.should_abort_operation();
            outcomes.push(outcome);
            if should_abort_operation {
                break;
            }
        }

        outcomes
    }

    /// 预览 SessionStart 事件下将匹配的 handler，不实际执行。
    pub fn preview_session_start(
        &self,
        request: &SessionStartRequest,
    ) -> Vec<codex_protocol::protocol::HookRunSummary> {
        self.engine.preview_session_start(request)
    }

    /// 预览 PreToolUse 事件下将匹配的 handler。
    pub fn preview_pre_tool_use(
        &self,
        request: &PreToolUseRequest,
    ) -> Vec<codex_protocol::protocol::HookRunSummary> {
        self.engine.preview_pre_tool_use(request)
    }

    /// 预览 PermissionRequest 事件下将匹配的 handler。
    pub fn preview_permission_request(
        &self,
        request: &PermissionRequestRequest,
    ) -> Vec<codex_protocol::protocol::HookRunSummary> {
        self.engine.preview_permission_request(request)
    }

    /// 预览 PostToolUse 事件下将匹配的 handler。
    pub fn preview_post_tool_use(
        &self,
        request: &PostToolUseRequest,
    ) -> Vec<codex_protocol::protocol::HookRunSummary> {
        self.engine.preview_post_tool_use(request)
    }

    /// 实际运行 SessionStart 钩子。
    pub async fn run_session_start(
        &self,
        request: SessionStartRequest,
        turn_id: Option<String>,
    ) -> SessionStartOutcome {
        self.engine.run_session_start(request, turn_id).await
    }

    /// 实际运行 PreToolUse 钩子。
    pub async fn run_pre_tool_use(&self, request: PreToolUseRequest) -> PreToolUseOutcome {
        self.engine.run_pre_tool_use(request).await
    }

    /// 实际运行 PermissionRequest 钩子。
    pub async fn run_permission_request(
        &self,
        request: PermissionRequestRequest,
    ) -> PermissionRequestOutcome {
        self.engine.run_permission_request(request).await
    }

    /// 实际运行 PostToolUse 钩子。
    pub async fn run_post_tool_use(&self, request: PostToolUseRequest) -> PostToolUseOutcome {
        self.engine.run_post_tool_use(request).await
    }

    /// 预览 PreCompact 事件下将匹配的 handler。
    pub fn preview_pre_compact(
        &self,
        request: &PreCompactRequest,
    ) -> Vec<codex_protocol::protocol::HookRunSummary> {
        self.engine.preview_pre_compact(request)
    }

    /// 实际运行 PreCompact 钩子。
    pub async fn run_pre_compact(&self, request: PreCompactRequest) -> PreCompactOutcome {
        self.engine.run_pre_compact(request).await
    }

    /// 预览 PostCompact 事件下将匹配的 handler。
    pub fn preview_post_compact(
        &self,
        request: &PostCompactRequest,
    ) -> Vec<codex_protocol::protocol::HookRunSummary> {
        self.engine.preview_post_compact(request)
    }

    /// 实际运行 PostCompact 钩子。
    pub async fn run_post_compact(&self, request: PostCompactRequest) -> StatelessHookOutcome {
        self.engine.run_post_compact(request).await
    }

    /// 预览 UserPromptSubmit 事件下将匹配的 handler。
    pub fn preview_user_prompt_submit(
        &self,
        request: &UserPromptSubmitRequest,
    ) -> Vec<codex_protocol::protocol::HookRunSummary> {
        self.engine.preview_user_prompt_submit(request)
    }

    /// 实际运行 UserPromptSubmit 钩子。
    pub async fn run_user_prompt_submit(
        &self,
        request: UserPromptSubmitRequest,
    ) -> UserPromptSubmitOutcome {
        self.engine.run_user_prompt_submit(request).await
    }

    /// 预览 Stop 事件下将匹配的 handler。
    pub fn preview_stop(
        &self,
        request: &StopRequest,
    ) -> Vec<codex_protocol::protocol::HookRunSummary> {
        self.engine.preview_stop(request)
    }

    /// 实际运行 Stop 钩子。
    pub async fn run_stop(&self, request: StopRequest) -> StopOutcome {
        self.engine.run_stop(request).await
    }
}

/// 列出当前配置下可发现的所有 handler，但不实际运行它们。
///
/// 当特性未启用时直接返回空结果。
pub fn list_hooks(config: HooksConfig) -> HookListOutcome {
    if !config.feature_enabled {
        return HookListOutcome::default();
    }

    let discovered = crate::engine::discovery::discover_handlers(
        config.config_layer_stack.as_ref(),
        config.plugin_hook_sources,
        config.plugin_hook_load_warnings,
        config.bypass_hook_trust,
    );
    HookListOutcome {
        hooks: discovered.hook_entries,
        warnings: discovered.warnings,
    }
}

/// 将 argv 拆分为程序名与参数，构造一个 [`tokio::process::Command`]。
///
/// 第一个元素作为可执行程序，其余作为参数。若 argv 为空或程序名为空，
/// 返回 `None`。
pub fn command_from_argv(argv: &[String]) -> Option<Command> {
    let (program, args) = argv.split_first()?;
    if program.is_empty() {
        return None;
    }
    let mut command = Command::new(program);
    command.args(args);
    Some(command)
}
