//! 规则定义模块，定义 execpolicy 的核心匹配原语。
//!
//! 包含：
//! - [`PatternToken`] / [`PrefixPattern`]：命令 token 的匹配模式
//! - [`PrefixRule`]：基于前缀的命令规则
//! - [`NetworkRule`] / [`NetworkRuleProtocol`]：网络访问规则
//! - [`Rule`] trait / [`RuleRef`]：规则的多态抽象
//! - [`RuleMatch`]：规则匹配结果
//! - [`validate_match_examples`] / [`validate_not_match_examples`]：编译期示例校验

use crate::decision::Decision;
use crate::error::Error;
use crate::error::Result;
use crate::policy::MatchOptions;
use crate::policy::Policy;
use codex_utils_absolute_path::AbsolutePathBuf;
use serde::Deserialize;
use serde::Serialize;
use shlex::try_join;
use std::any::Any;
use std::fmt::Debug;
use std::sync::Arc;

/// 匹配单个命令 token，可以是固定字符串，也可以是若干允许的备选值之一。
///
/// 用于 [`PrefixPattern`] 的后续 token 列表，支持前缀匹配时的多选一语义。
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PatternToken {
    /// 固定字符串，需与命令 token 完全相等。
    Single(String),
    /// 备选值列表，命令 token 命中其中任意一个即视为匹配。
    Alts(Vec<String>),
}

impl PatternToken {
    fn matches(&self, token: &str) -> bool {
        match self {
            Self::Single(expected) => expected == token,
            Self::Alts(alternatives) => alternatives.iter().any(|alt| alt == token),
        }
    }

    pub fn alternatives(&self) -> &[String] {
        match self {
            Self::Single(expected) => std::slice::from_ref(expected),
            Self::Alts(alternatives) => alternatives,
        }
    }
}

/// 命令前缀匹配器，支持在后续 token 中使用备选匹配项。
///
/// 第一个 token 固定不变，因为策略中以第一个 token 作为索引键（见 [`crate::policy::Policy`]）。
/// `rest` 中的每个 [`PatternToken`] 可以是固定字符串或备选列表。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrefixPattern {
    /// 命令的第一个 token，用作策略索引键。
    pub first: Arc<str>,
    /// 第一个 token 之后的匹配模式序列。
    pub rest: Arc<[PatternToken]>,
}

impl PrefixPattern {
    /// 尝试用此前缀模式匹配命令 token 序列。
    ///
    /// 当且仅当命令长度不小于模式长度、首 token 与 `first` 相等、且后续每个 token
    /// 都被对应的 [`PatternToken`] 匹配时，返回匹配到的前缀切片；否则返回 `None`。
    pub fn matches_prefix(&self, cmd: &[String]) -> Option<Vec<String>> {
        let pattern_length = self.rest.len() + 1;
        if cmd.len() < pattern_length || cmd[0] != self.first.as_ref() {
            return None;
        }

        for (pattern_token, cmd_token) in self.rest.iter().zip(&cmd[1..pattern_length]) {
            if !pattern_token.matches(cmd_token) {
                return None;
            }
        }

        Some(cmd[..pattern_length].to_vec())
    }
}

/// 一条规则对某条命令的匹配结果。
///
/// 序列化为 camelCase JSON 供 CLI 输出和前端消费。
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuleMatch {
    /// 命中了某条 [`PrefixRule`]，记录匹配到的前缀及决策。
    PrefixRuleMatch {
        /// 实际匹配到的前缀 token 列表。
        #[serde(rename = "matchedPrefix")]
        matched_prefix: Vec<String>,
        /// 该规则的决策（Allow / Prompt / Forbidden）。
        decision: Decision,
        /// 当通过 host_executable 解析命中时，记录解析后的绝对路径；否则为 `None`。
        #[serde(rename = "resolvedProgram", skip_serializing_if = "Option::is_none")]
        resolved_program: Option<AbsolutePathBuf>,
        /// 该规则存在的可选理由说明。
        ///
        /// 可用于任意决策，在不同上下文中展示（例如 prompt 原因或拒绝消息）。
        #[serde(skip_serializing_if = "Option::is_none")]
        justification: Option<String>,
    },
    /// 未命中任何显式规则，由启发式回退函数给出的决策。
    HeuristicsRuleMatch {
        /// 触发回退的原始命令 token 列表。
        command: Vec<String>,
        /// 启发式回退给出的决策。
        decision: Decision,
    },
}

impl RuleMatch {
    /// 返回此匹配结果关联的决策。
    pub fn decision(&self) -> Decision {
        match self {
            Self::PrefixRuleMatch { decision, .. } => *decision,
            Self::HeuristicsRuleMatch { decision, .. } => *decision,
        }
    }

    /// 对于 `PrefixRuleMatch` 变体，将 `resolved_program` 设置为给定绝对路径；
    /// 对于 `HeuristicsRuleMatch` 变体，原样返回。
    pub fn with_resolved_program(self, resolved_program: &AbsolutePathBuf) -> Self {
        match self {
            Self::PrefixRuleMatch {
                matched_prefix,
                decision,
                justification,
                ..
            } => Self::PrefixRuleMatch {
                matched_prefix,
                decision,
                resolved_program: Some(resolved_program.clone()),
                justification,
            },
            other => other,
        }
    }
}

/// 基于前缀匹配的命令规则，是 execpolicy 中最常见的规则类型。
///
/// 当命令的前缀匹配 `pattern` 时，按 `decision` 给出执行决策。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrefixRule {
    /// 前缀匹配模式。
    pub pattern: PrefixPattern,
    /// 命中时的执行决策。
    pub decision: Decision,
    /// 规则的可选理由说明，用于在提示或拒绝消息中展示。
    pub justification: Option<String>,
}

/// 网络规则支持的协议类型。
///
/// 对应策略文件中 `network_rule` 的 `protocol` 字段。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NetworkRuleProtocol {
    /// 明文 HTTP。
    Http,
    /// HTTPS（含 CONNECT 隧道）。
    Https,
    /// SOCKS5 over TCP。
    Socks5Tcp,
    /// SOCKS5 over UDP。
    Socks5Udp,
}

impl NetworkRuleProtocol {
    /// 将策略文件中的字符串解析为协议枚举。
    ///
    /// 兼容历史别名：`https_connect` 和 `http-connect` 均映射到 [`Self::Https`]。
    ///
    /// # Errors
    /// 当输入不是 `http` / `https` / `https_connect` / `http-connect` / `socks5_tcp` / `socks5_udp` 时返回 [`Error::InvalidRule`]。
    pub fn parse(raw: &str) -> Result<Self> {
        match raw {
            "http" => Ok(Self::Http),
            "https" | "https_connect" | "http-connect" => Ok(Self::Https),
            "socks5_tcp" => Ok(Self::Socks5Tcp),
            "socks5_udp" => Ok(Self::Socks5Udp),
            other => Err(Error::InvalidRule(format!(
                "network_rule protocol must be one of http, https, socks5_tcp, socks5_udp (got {other})"
            ))),
        }
    }

    /// 返回该协议在策略文件中的规范字符串表示。
    pub fn as_policy_string(self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::Https => "https",
            Self::Socks5Tcp => "socks5_tcp",
            Self::Socks5Udp => "socks5_udp",
        }
    }
}

/// 网络访问规则，按主机 + 协议给出决策。
///
/// 用于控制 Agent 对特定主机的网络访问权限。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NetworkRule {
    /// 规范化后的主机名或 IP 字面量（小写、无端口、无通配符）。
    pub host: String,
    /// 适用协议。
    pub protocol: NetworkRuleProtocol,
    /// 命中时的执行决策。
    pub decision: Decision,
    /// 规则的可选理由说明。
    pub justification: Option<String>,
}

/// 规范化网络规则的主机字段。
///
/// 处理步骤：
/// 1. 去除首尾空白；
/// 2. 拒绝包含 scheme（`://`）、路径（`/`）、查询（`?`）、片段（`#`）的输入；
/// 3. 解析并剥离端口（支持 `[ipv6]:port` 括号形式和 `host:port` 形式）；
/// 4. 去除尾部 `.` 并转小写；
/// 5. 拒绝空主机、通配符（`*`）和含空白字符的主机。
///
/// # Errors
/// 当输入违反上述任一约束时返回 [`Error::InvalidRule`]。
pub(crate) fn normalize_network_rule_host(raw: &str) -> Result<String> {
    let mut host = raw.trim();
    if host.is_empty() {
        return Err(Error::InvalidRule(
            "network_rule host cannot be empty".to_string(),
        ));
    }
    if host.contains("://") || host.contains('/') || host.contains('?') || host.contains('#') {
        return Err(Error::InvalidRule(
            "network_rule host must be a hostname or IP literal (without scheme or path)"
                .to_string(),
        ));
    }

    if let Some(stripped) = host.strip_prefix('[') {
        let Some((inside, rest)) = stripped.split_once(']') else {
            return Err(Error::InvalidRule(
                "network_rule host has an invalid bracketed IPv6 literal".to_string(),
            ));
        };
        let port_ok = rest
            .strip_prefix(':')
            .is_some_and(|port| !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()));
        if !rest.is_empty() && !port_ok {
            return Err(Error::InvalidRule(format!(
                "network_rule host contains an unsupported suffix: {raw}"
            )));
        }
        host = inside;
    } else if host.matches(':').count() == 1
        && let Some((candidate, port)) = host.rsplit_once(':')
        && !candidate.is_empty()
        && !port.is_empty()
        && port.chars().all(|c| c.is_ascii_digit())
    {
        host = candidate;
    }

    let normalized = host.trim_end_matches('.').trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return Err(Error::InvalidRule(
            "network_rule host cannot be empty".to_string(),
        ));
    }
    if normalized.contains('*') {
        return Err(Error::InvalidRule(
            "network_rule host must be a specific host; wildcards are not allowed".to_string(),
        ));
    }
    if normalized.chars().any(char::is_whitespace) {
        return Err(Error::InvalidRule(
            "network_rule host cannot contain whitespace".to_string(),
        ));
    }

    Ok(normalized)
}

/// 命令规则的抽象 trait，所有具体规则类型（如 [`PrefixRule`]）均需实现。
///
/// 通过 `as_any` 提供 downcast 能力，以便在需要时获取具体类型。
pub trait Rule: Any + Debug + Send + Sync {
    /// 返回此规则索引所用的程序名（命令首 token）。
    fn program(&self) -> &str;

    /// 尝试将命令与此规则匹配，命中时返回 [`RuleMatch`]，否则返回 `None`。
    fn matches(&self, cmd: &[String]) -> Option<RuleMatch>;

    /// 返回 `&dyn Any` 以支持 downcast 到具体规则类型。
    fn as_any(&self) -> &dyn Any;
}

/// 规则的共享引用类型，使用 trait object + `Arc` 实现所有权共享。
pub type RuleRef = Arc<dyn Rule>;

impl Rule for PrefixRule {
    fn program(&self) -> &str {
        self.pattern.first.as_ref()
    }

    fn matches(&self, cmd: &[String]) -> Option<RuleMatch> {
        self.pattern
            .matches_prefix(cmd)
            .map(|matched_prefix| RuleMatch::PrefixRuleMatch {
                matched_prefix,
                decision: self.decision,
                resolved_program: None,
                justification: self.justification.clone(),
            })
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

/// 逐条校验每个正向示例是否被至少一条规则命中，若有示例未命中则返回错误。
///
/// 用于策略文件中 `prefix_rule(..., match=[...])` 的编译期校验，
/// 确保规则定义确实能匹配作者期望的命令示例。
///
/// # Errors
/// 当存在未被任何规则命中的示例时，返回 [`Error::ExampleDidNotMatch`]。
pub(crate) fn validate_match_examples(
    policy: &Policy,
    rules: &[RuleRef],
    matches: &[Vec<String>],
) -> Result<()> {
    let mut unmatched_examples = Vec::new();
    let options = MatchOptions {
        resolve_host_executables: true,
    };

    for example in matches {
        if !policy
            .matches_for_command_with_options(example, /*heuristics_fallback*/ None, &options)
            .is_empty()
        {
            continue;
        }

        unmatched_examples.push(
            try_join(example.iter().map(String::as_str))
                .unwrap_or_else(|_| "unable to render example".to_string()),
        );
    }

    if unmatched_examples.is_empty() {
        Ok(())
    } else {
        Err(Error::ExampleDidNotMatch {
            rules: rules.iter().map(|rule| format!("{rule:?}")).collect(),
            examples: unmatched_examples,
            location: None,
        })
    }
}

/// 逐条校验每个反向示例是否不被任何规则命中，若有示例被命中则返回错误。
///
/// 用于策略文件中 `prefix_rule(..., not_match=[...])` 的编译期校验，
/// 确保规则定义不会意外匹配作者期望排除的命令示例。
///
/// # Errors
/// 当存在被某条规则命中的反向示例时，返回 [`Error::ExampleDidMatch`]。
pub(crate) fn validate_not_match_examples(
    policy: &Policy,
    _rules: &[RuleRef],
    not_matches: &[Vec<String>],
) -> Result<()> {
    let options = MatchOptions {
        resolve_host_executables: true,
    };

    for example in not_matches {
        if let Some(rule) = policy
            .matches_for_command_with_options(example, /*heuristics_fallback*/ None, &options)
            .first()
        {
            return Err(Error::ExampleDidMatch {
                rule: format!("{rule:?}"),
                example: try_join(example.iter().map(String::as_str))
                    .unwrap_or_else(|_| "unable to render example".to_string()),
                location: None,
            });
        }
    }

    Ok(())
}
