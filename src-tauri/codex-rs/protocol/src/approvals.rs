//! 审批相关协议类型。
//!
//! 定义与命令执行审批、网络访问审批、MCP elicitation、Guardian 风险评估等
//! 相关的协议类型。这些类型在协议层用于在 Agent 与客户端之间传递审批请求
//! 与决策结果。

use crate::mcp::RequestId;
use crate::models::AdditionalPermissionProfile;
use crate::models::PermissionProfile;
use crate::parse_command::ParsedCommand;
use crate::protocol::FileChange;
use crate::protocol::ReviewDecision;
use crate::request_permissions::RequestPermissionProfile;
use codex_utils_absolute_path::AbsolutePathBuf;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::path::PathBuf;
use ts_rs::TS;

/// 完全解析后的权限，用于重新运行被拦截的子进程。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedPermissionProfile {
    /// 已解析的权限 profile。
    pub permission_profile: PermissionProfile,
}

/// 权限升级方式。
///
/// 表示审批通过后对当前 turn 权限的两种升级方式：合并或替换。
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EscalationPermissions {
    /// 与当前 turn 权限合并的附加权限。
    AdditionalPermissionProfile(AdditionalPermissionProfile),
    /// 完全解析后的权限，替换当前 turn 权限。
    ResolvedPermissionProfile(ResolvedPermissionProfile),
}

/// 提议的 execpolicy 修改：允许以指定前缀开头的命令。
///
/// `command` token 序列将作为 execpolicy `prefix_rule(..., decision="allow")`
/// 加入规则，使 Agent 后续可跳过该前缀命令的审批。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(transparent)]
#[ts(type = "Array<string>")]
pub struct ExecPolicyAmendment {
    /// 命令前缀 token 序列。
    pub command: Vec<String>,
}

impl ExecPolicyAmendment {
    /// 由 token 序列构造 `ExecPolicyAmendment`。
    pub fn new(command: Vec<String>) -> Self {
        Self { command }
    }

    /// 返回命令前缀 token 切片。
    pub fn command(&self) -> &[String] {
        &self.command
    }
}

impl From<Vec<String>> for ExecPolicyAmendment {
    fn from(command: Vec<String>) -> Self {
        Self { command }
    }
}

/// 网络审批协议类型。
///
/// 标识触发网络审批的协议，便于 Guardian 做差异化决策。
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum NetworkApprovalProtocol {
    // TODO(viyatb): Add websocket protocol variants when managed proxy policy
    // decisions expose websocket traffic as a distinct approval context.
    /// HTTP 协议。
    Http,
    /// HTTPS 协议（CONNECT 隧道）。
    #[serde(alias = "https_connect", alias = "http-connect")]
    Https,
    /// SOCKS5 over TCP。
    Socks5Tcp,
    /// SOCKS5 over UDP。
    Socks5Udp,
}

/// 网络审批上下文。
///
/// 描述一次网络访问审批请求的目标主机与协议。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
pub struct NetworkApprovalContext {
    /// 目标主机名。
    pub host: String,
    /// 网络协议。
    pub protocol: NetworkApprovalProtocol,
}

/// 网络策略规则动作。
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum NetworkPolicyRuleAction {
    /// 允许。
    Allow,
    /// 拒绝。
    Deny,
}

/// Guardian 风险等级。
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "lowercase")]
pub enum GuardianRiskLevel {
    /// 低风险。
    Low,
    /// 中风险。
    Medium,
    /// 高风险。
    High,
    /// 严重风险。
    Critical,
}

/// 用户授权等级。
///
/// 表示用户对 Agent 操作的授权程度，影响 Guardian 决策。
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "lowercase")]
pub enum GuardianUserAuthorization {
    /// 未知授权等级。
    Unknown,
    /// 低授权。
    Low,
    /// 中授权。
    Medium,
    /// 高授权。
    High,
}

/// Guardian 审核方返回的最终允许 / 拒绝结果。
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "lowercase")]
pub enum GuardianAssessmentOutcome {
    /// 允许。
    Allow,
    /// 拒绝。
    Deny,
}

/// Guardian 评估状态。
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum GuardianAssessmentStatus {
    /// 评估进行中。
    InProgress,
    /// 已批准。
    Approved,
    /// 已拒绝。
    Denied,
    /// 评估超时。
    TimedOut,
    /// 评估中止。
    Aborted,
}

/// Guardian 评估决策来源。
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum GuardianAssessmentDecisionSource {
    /// 由 Agent 决策。
    Agent,
}

/// 触发 Guardian 评估的命令来源。
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum GuardianCommandSource {
    /// 来自 shell。
    Shell,
    /// 来自统一执行通道。
    UnifiedExec,
}

/// Guardian 评估的具体动作。
///
/// 描述待评估的具体操作（命令执行、补丁应用、网络访问、MCP 工具调用、
/// 权限请求等），序列化为带 `type` tag 的对象。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum GuardianAssessmentAction {
    /// shell 命令评估。
    Command {
        source: GuardianCommandSource,
        command: String,
        cwd: AbsolutePathBuf,
    },
    /// execve 直接执行评估。
    Execve {
        source: GuardianCommandSource,
        program: String,
        argv: Vec<String>,
        cwd: AbsolutePathBuf,
    },
    /// 补丁应用评估。
    ApplyPatch {
        cwd: AbsolutePathBuf,
        files: Vec<AbsolutePathBuf>,
    },
    /// 网络访问评估。
    NetworkAccess {
        target: String,
        host: String,
        protocol: NetworkApprovalProtocol,
        port: u16,
    },
    /// MCP 工具调用评估。
    McpToolCall {
        server: String,
        tool_name: String,
        connector_id: Option<String>,
        connector_name: Option<String>,
        tool_title: Option<String>,
    },
    /// 权限请求评估。
    RequestPermissions {
        reason: Option<String>,
        permissions: RequestPermissionProfile,
    },
}

/// 网络策略修改建议。
///
/// 提议对指定主机添加 allow / deny 规则。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
pub struct NetworkPolicyAmendment {
    /// 目标主机名。
    pub host: String,
    /// 规则动作。
    pub action: NetworkPolicyRuleAction,
}

/// Guardian 评估事件。
///
/// 描述一次 Guardian 评估的完整生命周期信息，包括 ID、状态、风险等级、
/// 决策结果及关联的动作详情。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, TS)]
pub struct GuardianAssessmentEvent {
    /// 本次评估生命周期的稳定标识。
    pub id: String,
    /// 被审核的 thread item ID（若评估对应到具体 item）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub target_item_id: Option<String>,
    /// 该评估所属的 turn ID。`#[serde(default)]` 用于向后兼容。
    #[serde(default)]
    pub turn_id: String,
    /// 评估开始时间（毫秒时间戳）。
    #[serde(default)]
    #[ts(type = "number")]
    pub started_at_ms: i64,
    /// 评估完成时间（毫秒时间戳，评估进行中为 `None`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub completed_at_ms: Option<i64>,
    /// 评估状态。
    pub status: GuardianAssessmentStatus,
    /// 粗粒度风险标签；评估进行中时为 `None`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub risk_level: Option<GuardianRiskLevel>,
    /// 用户对所审核操作的直接授权程度。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub user_authorization: Option<GuardianUserAuthorization>,
    /// 最终评估的人类可读说明；评估进行中时为 `None`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rationale: Option<String>,
    /// 产生最终决策的来源。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub decision_source: Option<GuardianAssessmentDecisionSource>,
    /// 被审核的规范 action 载荷。
    pub action: GuardianAssessmentAction,
}

/// 命令执行审批请求事件。
///
/// 当 Agent 需要执行一条命令但当前权限不足时，通过此事件向客户端请求审批。
/// 客户端根据事件中的命令、工作目录、提议的规则修改等信息决定是否批准。
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct ExecApprovalRequestEvent {
    /// 关联的命令执行 item 的标识符。
    pub call_id: String,
    /// 本次审批回调的标识符。
    ///
    /// 缺省时审批针对命令 item 本身（`call_id`）。当通过 execve 拦截触发
    /// 子命令审批时，此字段用于区分不同的子审批。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub approval_id: Option<String>,
    /// 该命令所属的 turn ID。`#[serde(default)]` 用于向后兼容。
    #[serde(default)]
    pub turn_id: String,
    /// 命令将运行的环境 ID。
    #[serde(
        default,
        rename = "environmentId",
        alias = "environment_id",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    #[ts(rename = "environmentId")]
    pub environment_id: Option<String>,
    /// 审批请求发起时间（毫秒时间戳）。
    #[ts(type = "number")]
    pub started_at_ms: i64,
    /// 待执行的命令 token 序列。
    pub command: Vec<String>,
    /// 命令的工作目录。
    pub cwd: AbsolutePathBuf,
    /// 可选的审批理由（例如：重试但不使用 sandbox）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// 可选的网络上下文，用于审批被拦截的网络请求。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub network_approval_context: Option<NetworkApprovalContext>,
    /// 提议的 execpolicy 修改，批准后可允许后续相同前缀的命令直接执行。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub proposed_execpolicy_amendment: Option<ExecPolicyAmendment>,
    /// 提议的网络策略修改（例如：未来允许或拒绝该主机）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub proposed_network_policy_amendments: Option<Vec<NetworkPolicyAmendment>>,
    /// 本次命令请求的附加文件系统权限。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub additional_permissions: Option<AdditionalPermissionProfile>,
    /// 客户端可向用户展示的候选决策列表（按顺序）。
    ///
    /// 缺省时，客户端应根据本请求的其他字段派生默认决策集合（见
    /// [`ExecApprovalRequestEvent::default_available_decisions`]）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub available_decisions: Option<Vec<ReviewDecision>>,
    /// 解析后的命令结构，供客户端展示。
    pub parsed_cmd: Vec<ParsedCommand>,
}

impl ExecApprovalRequestEvent {
    /// 返回生效的审批 ID。
    ///
    /// 优先使用 `approval_id`，缺省时回退到 `call_id`。
    pub fn effective_approval_id(&self) -> String {
        self.approval_id
            .clone()
            .unwrap_or_else(|| self.call_id.clone())
    }

    /// 返回生效的候选决策列表。
    ///
    /// `available_decisions` 是新字段，旧版发送方可能不填充，此时回退到
    /// [`Self::default_available_decisions`] 派生的默认集合。
    pub fn effective_available_decisions(&self) -> Vec<ReviewDecision> {
        // available_decisions 是新字段，旧版发送方可能不填充，
        // 缺省时回退到旧版默认逻辑。
        match &self.available_decisions {
            Some(decisions) => decisions.clone(),
            None => Self::default_available_decisions(
                self.network_approval_context.as_ref(),
                self.proposed_execpolicy_amendment.as_ref(),
                self.proposed_network_policy_amendments.as_deref(),
                self.additional_permissions.as_ref(),
            ),
        }
    }

    /// 根据请求字段派生默认候选决策集合。
    ///
    /// 派生规则：
    /// - 有网络审批上下文：`Approved` + `ApprovedForSession` + 可能的网络策略修改 + `Abort`
    /// - 有附加权限请求：`Approved` + `Abort`
    /// - 其他：`Approved` + 可能的 execpolicy 修改 + `Abort`
    pub fn default_available_decisions(
        network_approval_context: Option<&NetworkApprovalContext>,
        proposed_execpolicy_amendment: Option<&ExecPolicyAmendment>,
        proposed_network_policy_amendments: Option<&[NetworkPolicyAmendment]>,
        additional_permissions: Option<&AdditionalPermissionProfile>,
    ) -> Vec<ReviewDecision> {
        if network_approval_context.is_some() {
            let mut decisions = vec![ReviewDecision::Approved, ReviewDecision::ApprovedForSession];
            if let Some(amendment) = proposed_network_policy_amendments.and_then(|amendments| {
                amendments
                    .iter()
                    .find(|amendment| amendment.action == NetworkPolicyRuleAction::Allow)
            }) {
                decisions.push(ReviewDecision::NetworkPolicyAmendment {
                    network_policy_amendment: amendment.clone(),
                });
            }
            decisions.push(ReviewDecision::Abort);
            return decisions;
        }

        if additional_permissions.is_some() {
            return vec![ReviewDecision::Approved, ReviewDecision::Abort];
        }

        let mut decisions = vec![ReviewDecision::Approved];
        if let Some(prefix) = proposed_execpolicy_amendment {
            decisions.push(ReviewDecision::ApprovedExecpolicyAmendment {
                proposed_execpolicy_amendment: prefix.clone(),
            });
        }
        decisions.push(ReviewDecision::Abort);
        decisions
    }
}

/// MCP elicitation 请求的载荷形式。
///
/// 表示 server 向用户请求信息的方式，可能是表单、OpenAI 表单或 URL 跳转。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, TS)]
#[serde(tag = "mode", rename_all = "snake_case")]
#[ts(tag = "mode")]
pub enum ElicitationRequest {
    /// 标准表单形式的 elicitation。
    Form {
        /// server 自定义的 `_meta` 扩展字段。
        #[serde(rename = "_meta", default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "_meta")]
        meta: Option<JsonValue>,
        /// 展示给用户的消息文本。
        message: String,
        /// 请求填写的表单 JSON Schema。
        requested_schema: JsonValue,
    },
    /// OpenAI 表单形式的 elicitation。
    #[serde(rename = "openai/form")]
    #[ts(rename = "openai/form")]
    OpenAiForm {
        /// server 自定义的 `_meta` 扩展字段。
        #[serde(rename = "_meta", default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "_meta")]
        meta: Option<JsonValue>,
        /// 展示给用户的消息文本。
        message: String,
        /// 请求填写的表单 JSON Schema。
        requested_schema: JsonValue,
    },
    /// URL 跳转形式的 elicitation，引导用户访问外部地址完成流程。
    Url {
        /// server 自定义的 `_meta` 扩展字段。
        #[serde(rename = "_meta", default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "_meta")]
        meta: Option<JsonValue>,
        /// 展示给用户的消息文本。
        message: String,
        /// 用户需访问的 URL。
        url: String,
        /// 本次 elicitation 的标识符，用于关联后续响应。
        elicitation_id: String,
    },
}

impl ElicitationRequest {
    /// 返回展示给用户的消息文本，无论何种形式。
    pub fn message(&self) -> &str {
        match self {
            Self::Form { message, .. }
            | Self::OpenAiForm { message, .. }
            | Self::Url { message, .. } => message,
        }
    }
}

/// MCP elicitation 请求事件。
///
/// 包装一条 [`ElicitationRequest`]，附带 server 名称、请求 ID 和可选的 turn ID，
/// 用于在客户端展示并收集用户输入。
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, JsonSchema, TS)]
pub struct ElicitationRequestEvent {
    /// 该 elicitation 所属的 turn ID（若已知）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub turn_id: Option<String>,
    /// 发起 elicitation 的 MCP server 名称。
    pub server_name: String,
    /// 请求 ID，用于关联后续响应。
    #[ts(type = "string | number")]
    pub id: RequestId,
    /// elicitation 请求载荷。
    pub request: ElicitationRequest,
}

/// 用户对 elicitation 请求的响应动作。
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "lowercase")]
pub enum ElicitationAction {
    /// 接受（提交表单内容）。
    Accept,
    /// 拒绝。
    Decline,
    /// 取消。
    Cancel,
}

/// 补丁应用审批请求事件。
///
/// 当 Agent 需要应用文件补丁但当前权限不足时，通过此事件向客户端请求审批。
/// 客户端根据变更内容、理由等信息决定是否批准。
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct ApplyPatchApprovalRequestEvent {
    /// 关联的 patch apply 调用的 Responses API call ID（若可用）。
    pub call_id: String,
    /// 该补丁所属的 turn ID。`#[serde(default)]` 用于向后兼容旧版发送方。
    #[serde(default)]
    pub turn_id: String,
    /// 审批请求发起时间（毫秒时间戳）。
    #[ts(type = "number")]
    pub started_at_ms: i64,
    /// 待应用的文件变更映射（路径 → 变更内容）。
    pub changes: HashMap<PathBuf, FileChange>,
    /// 可选的审批理由（例如：请求额外的写权限）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// 设置时，Agent 请求用户允许在本 session 剩余时间内对该根目录的写访问。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grant_root: Option<PathBuf>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_utils_absolute_path::test_support::PathBufExt;
    use codex_utils_absolute_path::test_support::test_path_buf;
    use pretty_assertions::assert_eq;

    #[test]
    fn guardian_assessment_action_deserializes_command_shape() {
        let action: GuardianAssessmentAction = serde_json::from_value(serde_json::json!({
            "type": "command",
            "source": "shell",
            "command": "rm -rf /tmp/guardian",
            "cwd": test_path_buf("/tmp"),
        }))
        .expect("guardian action");

        assert_eq!(
            action,
            GuardianAssessmentAction::Command {
                source: GuardianCommandSource::Shell,
                command: "rm -rf /tmp/guardian".to_string(),
                cwd: test_path_buf("/tmp").abs(),
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn guardian_assessment_action_round_trips_execve_shape() {
        let value = serde_json::json!({
            "type": "execve",
            "source": "shell",
            "program": "/bin/rm",
            "argv": ["/usr/bin/rm", "-f", "/tmp/file.sqlite"],
            "cwd": "/tmp",
        });
        let action: GuardianAssessmentAction =
            serde_json::from_value(value.clone()).expect("guardian action");

        assert_eq!(
            serde_json::to_value(&action).expect("serialize guardian action"),
            value
        );

        assert_eq!(
            action,
            GuardianAssessmentAction::Execve {
                source: GuardianCommandSource::Shell,
                program: "/bin/rm".to_string(),
                argv: vec![
                    "/usr/bin/rm".to_string(),
                    "-f".to_string(),
                    "/tmp/file.sqlite".to_string(),
                ],
                cwd: test_path_buf("/tmp").abs(),
            }
        );
    }
}
