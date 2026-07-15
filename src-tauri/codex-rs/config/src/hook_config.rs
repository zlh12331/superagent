//! Hook 配置类型。
//!
//! 定义 codex-rs hook 系统的 TOML 配置 schema：按事件类型（`PreToolUse`、
//! `PostToolUse`、`SessionStart` 等）分组的 matcher 与 handler。handler
//! 支持 `command`（执行命令）、`prompt`（提示用户）、`agent`（启动 agent）
//! 三种类型。
//!
//! 架构位置：用户/requirements 通过 `HooksFile` / `HooksToml` 声明 hook，
//! 运行时在各事件触发点按 matcher 匹配并执行对应 handler。

use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;

use codex_protocol::protocol::HookEventName;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;

/// 独立 hooks 文件（如 `~/.codex/hooks.json`）的根结构。
///
/// `description` 为人类可读说明；`hooks` 为按事件分组的 matcher 列表。
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HooksFile {
    /// 人类可读的文件描述。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// 按事件分组的 matcher 列表。
    #[serde(default)]
    pub hooks: HookEventsToml,
}

/// 嵌入到 `config.toml` 中的 hooks 配置。
///
/// `events` 通过 `flatten` 直接平铺到外层表；`state` 存储 hook 启用状态
/// 与受信 hash 等运行时元信息。
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct HooksToml {
    /// 按事件分组的 matcher 列表（平铺到外层）。
    #[serde(flatten)]
    pub events: HookEventsToml,
    /// hook 状态表：hook 标识 → 启用/受信 hash。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub state: BTreeMap<String, HookStateToml>,
}

/// 单个 hook 的运行时状态。
///
/// `enabled` 控制是否启用；`trusted_hash` 记录受信 hook 内容 hash，用于
/// 检测 hook 内容是否被篡改。
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct HookStateToml {
    /// 是否启用该 hook。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// 受信 hook 内容 hash。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trusted_hash: Option<String>,
}

/// 按事件类型分组的 matcher 列表。
///
/// 每个字段对应一个 hook 事件，值为该事件下的 `MatcherGroup` 列表。
/// 字段名通过 `#[serde(rename = ...)]` 映射到 TOML 中的 PascalCase key。
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct HookEventsToml {
    /// 工具调用前触发。
    #[serde(rename = "PreToolUse", default)]
    pub pre_tool_use: Vec<MatcherGroup>,
    /// 权限请求时触发。
    #[serde(rename = "PermissionRequest", default)]
    pub permission_request: Vec<MatcherGroup>,
    /// 工具调用后触发。
    #[serde(rename = "PostToolUse", default)]
    pub post_tool_use: Vec<MatcherGroup>,
    /// 上下文压缩前触发。
    #[serde(rename = "PreCompact", default)]
    pub pre_compact: Vec<MatcherGroup>,
    /// 上下文压缩后触发。
    #[serde(rename = "PostCompact", default)]
    pub post_compact: Vec<MatcherGroup>,
    /// 会话启动时触发。
    #[serde(rename = "SessionStart", default)]
    pub session_start: Vec<MatcherGroup>,
    /// 用户提交 prompt 时触发。
    #[serde(rename = "UserPromptSubmit", default)]
    pub user_prompt_submit: Vec<MatcherGroup>,
    /// 子 agent 启动时触发。
    #[serde(rename = "SubagentStart", default)]
    pub subagent_start: Vec<MatcherGroup>,
    /// 子 agent 停止时触发。
    #[serde(rename = "SubagentStop", default)]
    pub subagent_stop: Vec<MatcherGroup>,
    /// 会话停止时触发。
    #[serde(rename = "Stop", default)]
    pub stop: Vec<MatcherGroup>,
}

impl HookEventsToml {
    /// 是否所有事件都没有 matcher。
    pub fn is_empty(&self) -> bool {
        let Self {
            pre_tool_use,
            permission_request,
            post_tool_use,
            pre_compact,
            post_compact,
            session_start,
            user_prompt_submit,
            subagent_start,
            subagent_stop,
            stop,
        } = self;
        pre_tool_use.is_empty()
            && permission_request.is_empty()
            && post_tool_use.is_empty()
            && pre_compact.is_empty()
            && post_compact.is_empty()
            && session_start.is_empty()
            && user_prompt_submit.is_empty()
            && subagent_start.is_empty()
            && subagent_stop.is_empty()
            && stop.is_empty()
    }

    /// 统计所有事件下 handler 的总数。
    pub fn handler_count(&self) -> usize {
        let Self {
            pre_tool_use,
            permission_request,
            post_tool_use,
            pre_compact,
            post_compact,
            session_start,
            user_prompt_submit,
            subagent_start,
            subagent_stop,
            stop,
        } = self;
        [
            pre_tool_use,
            permission_request,
            post_tool_use,
            pre_compact,
            post_compact,
            session_start,
            user_prompt_submit,
            subagent_start,
            subagent_stop,
            stop,
        ]
        .into_iter()
        .flatten()
        .map(|group| group.hooks.len())
        .sum()
    }

    /// 转换为 `(HookEventName, Vec<MatcherGroup>)` 数组，便于按事件遍历。
    pub fn into_matcher_groups(self) -> [(HookEventName, Vec<MatcherGroup>); 10] {
        [
            (HookEventName::PreToolUse, self.pre_tool_use),
            (HookEventName::PermissionRequest, self.permission_request),
            (HookEventName::PostToolUse, self.post_tool_use),
            (HookEventName::PreCompact, self.pre_compact),
            (HookEventName::PostCompact, self.post_compact),
            (HookEventName::SessionStart, self.session_start),
            (HookEventName::UserPromptSubmit, self.user_prompt_submit),
            (HookEventName::SubagentStart, self.subagent_start),
            (HookEventName::SubagentStop, self.subagent_stop),
            (HookEventName::Stop, self.stop),
        ]
    }
}

/// 单个 matcher 组：一个可选 matcher 模式 + 一组 handler。
///
/// `matcher` 为 None 时匹配该事件下的所有触发；非 None 时按工具名/模式匹配。
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct MatcherGroup {
    /// 匹配模式（如工具名）；None 表示全匹配。
    #[serde(default)]
    pub matcher: Option<String>,
    /// 该 matcher 下的 handler 列表。
    #[serde(default)]
    pub hooks: Vec<HookHandlerConfig>,
}

/// Hook handler 配置，按 `type` 标签区分为三种变体。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type")]
pub enum HookHandlerConfig {
    /// 执行 shell 命令的 handler。
    #[serde(rename = "command")]
    Command {
        /// 默认命令（非 Windows）。
        command: String,
        /// Windows 平台专用命令，覆盖 `command`。
        #[serde(default, rename = "commandWindows", alias = "command_windows")]
        command_windows: Option<String>,
        /// 超时时间（秒）。
        #[serde(default, rename = "timeout")]
        timeout_sec: Option<u64>,
        /// 是否异步执行（不阻塞主流程）。
        #[serde(default)]
        r#async: bool,
        /// 运行时显示的状态消息。
        #[serde(default, rename = "statusMessage")]
        status_message: Option<String>,
    },
    /// 向用户发送提示的 handler。
    #[serde(rename = "prompt")]
    Prompt {},
    /// 启动子 agent 的 handler。
    #[serde(rename = "agent")]
    Agent {},
}

/// requirements 中声明的受管 hook 配置。
///
/// `managed_dir` 指定受管 hook 脚本目录（按平台区分）；`hooks` 为按事件
/// 分组的 matcher 列表，结构与用户 hook 一致。
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManagedHooksRequirementsToml {
    /// 非 Windows 平台的受管 hook 目录。
    pub managed_dir: Option<PathBuf>,
    /// Windows 平台的受管 hook 目录。
    pub windows_managed_dir: Option<PathBuf>,
    /// 按事件分组的 matcher 列表。
    #[serde(flatten)]
    pub hooks: HookEventsToml,
}

impl ManagedHooksRequirementsToml {
    /// 是否既无受管目录也无 hook。
    pub fn is_empty(&self) -> bool {
        let Self {
            managed_dir,
            windows_managed_dir,
            hooks,
        } = self;
        managed_dir.is_none() && windows_managed_dir.is_none() && hooks.is_empty()
    }

    /// 统计 handler 总数（委托给 `hooks`）。
    pub fn handler_count(&self) -> usize {
        self.hooks.handler_count()
    }

    /// 返回当前平台的受管 hook 目录。
    ///
    /// Windows 上返回 `windows_managed_dir`，其他平台返回 `managed_dir`。
    pub fn managed_dir_for_current_platform(&self) -> Option<&Path> {
        #[cfg(windows)]
        {
            self.windows_managed_dir.as_deref()
        }

        #[cfg(not(windows))]
        {
            self.managed_dir.as_deref()
        }
    }
}

#[cfg(test)]
#[path = "hooks_tests.rs"]
mod tests;
