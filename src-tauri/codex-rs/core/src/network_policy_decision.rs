//! 网络策略决策转换。
//!
//! 本模块在 codex-network-proxy 的 `NetworkPolicyDecision`、codex-execpolicy 的
//! `ExecPolicyDecision` 以及 Codex 协议层的审批类型之间进行转换，
//! 并生成被阻断请求的可读错误消息。

use codex_execpolicy::Decision as ExecPolicyDecision;
use codex_execpolicy::NetworkRuleProtocol as ExecPolicyNetworkRuleProtocol;
use codex_network_proxy::BlockedRequest;
use codex_network_proxy::NetworkPolicyDecision;
use codex_protocol::approvals::NetworkApprovalContext;
use codex_protocol::approvals::NetworkApprovalProtocol;
use codex_protocol::approvals::NetworkPolicyAmendment;
use codex_protocol::approvals::NetworkPolicyRuleAction;
use codex_protocol::network_policy::NetworkPolicyDecisionPayload;

/// 网络策略规则修正项，用于将用户审批结果写回 execpolicy 规则集。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExecPolicyNetworkRuleAmendment {
    /// 网络协议（HTTP/HTTPS/SOCKS5 等）。
    pub protocol: ExecPolicyNetworkRuleProtocol,
    /// 策略决策（Allow/Forbidden）。
    pub decision: ExecPolicyDecision,
    /// 人类可读的修正理由。
    pub justification: String,
}

/// 将字符串解析为 `NetworkPolicyDecision`。
fn parse_network_policy_decision(value: &str) -> Option<NetworkPolicyDecision> {
    match value {
        "deny" => Some(NetworkPolicyDecision::Deny),
        "ask" => Some(NetworkPolicyDecision::Ask),
        _ => None,
    }
}

/// 从网络策略决策负载中提取审批上下文。
///
/// 仅当决策为 `Ask` 且包含有效的协议与主机时返回 `Some`。
pub(crate) fn network_approval_context_from_payload(
    payload: &NetworkPolicyDecisionPayload,
) -> Option<NetworkApprovalContext> {
    if !payload.is_ask_from_decider() {
        return None;
    }

    let protocol = payload.protocol?;

    let host = payload.host.as_deref()?.trim();
    if host.is_empty() {
        return None;
    }

    Some(NetworkApprovalContext {
        host: host.to_string(),
        protocol,
    })
}

/// 为被阻断的请求生成可读错误消息。
///
/// 仅当决策为 `Deny` 时返回 `Some`，否则返回 `None` 表示该请求未被拒绝。
pub(crate) fn denied_network_policy_message(blocked: &BlockedRequest) -> Option<String> {
    let decision = blocked
        .decision
        .as_deref()
        .and_then(parse_network_policy_decision);
    if decision != Some(NetworkPolicyDecision::Deny) {
        return None;
    }

    let host = blocked.host.trim();
    if host.is_empty() {
        return Some("Network access was blocked by policy.".to_string());
    }

    let detail = match blocked.reason.as_str() {
        "denied" => "domain is explicitly denied by policy and cannot be approved from this prompt",
        "not_allowed" => "domain is not on the allowlist for the current sandbox mode",
        "not_allowed_local" => "local/private network addresses are blocked by the sandbox policy",
        "method_not_allowed" => "request method is blocked by the current network mode",
        "proxy_disabled" => "network proxy is disabled",
        _ => "request is blocked by network policy",
    };

    Some(format!(
        "Network access to \"{host}\" was blocked: {detail}."
    ))
}

/// 将用户审批动作转换为 execpolicy 网络规则修正项。
///
/// 根据审批上下文中的协议和主机，结合修正动作（Allow/Deny），
/// 生成对应的 `ExecPolicyDecision` 和人类可读的理由文本。
pub(crate) fn execpolicy_network_rule_amendment(
    amendment: &NetworkPolicyAmendment,
    network_approval_context: &NetworkApprovalContext,
    host: &str,
) -> ExecPolicyNetworkRuleAmendment {
    let protocol = match network_approval_context.protocol {
        NetworkApprovalProtocol::Http => ExecPolicyNetworkRuleProtocol::Http,
        NetworkApprovalProtocol::Https => ExecPolicyNetworkRuleProtocol::Https,
        NetworkApprovalProtocol::Socks5Tcp => ExecPolicyNetworkRuleProtocol::Socks5Tcp,
        NetworkApprovalProtocol::Socks5Udp => ExecPolicyNetworkRuleProtocol::Socks5Udp,
    };
    let (decision, action_verb) = match amendment.action {
        NetworkPolicyRuleAction::Allow => (ExecPolicyDecision::Allow, "Allow"),
        NetworkPolicyRuleAction::Deny => (ExecPolicyDecision::Forbidden, "Deny"),
    };
    let protocol_label = match network_approval_context.protocol {
        NetworkApprovalProtocol::Http => "http",
        NetworkApprovalProtocol::Https => "https_connect",
        NetworkApprovalProtocol::Socks5Tcp => "socks5_tcp",
        NetworkApprovalProtocol::Socks5Udp => "socks5_udp",
    };
    let justification = format!("{action_verb} {protocol_label} access to {host}");

    ExecPolicyNetworkRuleAmendment {
        protocol,
        decision,
        justification,
    }
}

#[cfg(test)]
#[path = "network_policy_decision_tests.rs"]
mod tests;
