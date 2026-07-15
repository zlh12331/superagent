//! 受管 MCP server requirements（要求）的匹配器与反序列化逻辑。
//!
//! 本模块定义 `requirements.toml` 中 `[mcp_servers.<name>]` 表的 schema，
//! 支持三种匹配形式：
//! - `Identity`：精确匹配 command 或 URL（向后兼容的契约）
//! - `Command`：基于可执行文件名与参数匹配器（exact/prefix/regex）匹配 stdio server
//! - `Url`：基于 URL 匹配器匹配 StreamableHttp server
//!
//! 这些匹配器在受管场景下使用，确保用户配置中的 MCP server 符合管理员约束。

use crate::mcp_types::McpServerConfig;
use crate::mcp_types::McpServerTransportConfig;
use regex_lite::Regex;
use serde::Deserialize;

/// MCP server 的身份标识，用于精确匹配。
///
/// `Command` 变体匹配 stdio server 的可执行文件名；`Url` 变体匹配
/// StreamableHttp server 的 URL。
#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(untagged)]
pub enum McpServerIdentity {
    /// 基于 command 字符串的精确匹配。
    Command { command: String },
    /// 基于 URL 字符串的精确匹配。
    Url { url: String },
}

/// 受管 MCP server 匹配器可用的字符串匹配操作。
///
/// 通过 `match` tag 区分三种匹配模式，序列化为 `match = "exact|prefix|regex"`。
#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "match", rename_all = "snake_case", deny_unknown_fields)]
pub enum McpServerValueMatcher {
    /// 精确匹配：候选字符串必须等于 `value`。
    Exact { value: String },
    /// 前缀匹配：候选字符串必须以 `value` 开头。
    Prefix { value: String },
    /// 正则匹配：候选字符串必须完整匹配 `expression`（自动添加 `\A(?:...)\z` 锚点）。
    Regex { expression: String },
}

impl McpServerValueMatcher {
    /// 将正则表达式编译为完整匹配形式（`\A(?:...)\z`）。
    ///
    /// 用于确保 `Regex` 匹配器只在候选字符串完全匹配时返回 true，
    /// 而不是部分匹配。
    fn compile_full_regex(expression: &str) -> Result<Regex, String> {
        Regex::new(&format!(r"\A(?:{expression})\z")).map_err(|err| {
            format!("regex `{expression}` cannot be used for full-value matching: {err}")
        })
    }

    /// 校验当前匹配器配置是否合法。
    ///
    /// 仅 `Regex` 变体需要校验：先验证原始表达式可编译，再验证完整匹配形式可编译。
    fn validate(&self) -> Result<(), String> {
        let Self::Regex { expression } = self else {
            return Ok(());
        };

        Regex::new(expression).map_err(|err| format!("invalid regex `{expression}`: {err}"))?;
        Self::compile_full_regex(expression).map(|_| ())
    }

    /// 判断 `candidate` 是否匹配当前匹配器。
    ///
    /// - `Exact`：精确相等
    /// - `Prefix`：`candidate` 以 `value` 开头
    /// - `Regex`：完整匹配（`\A(?:...)\z`）
    fn matches(&self, candidate: &str) -> bool {
        match self {
            Self::Exact { value } => candidate == value,
            Self::Prefix { value } => candidate.starts_with(value),
            Self::Regex { expression } => Self::compile_full_regex(expression)
                .ok()
                .is_some_and(|regex| regex.is_match(candidate)),
        }
    }
}

/// 基于 command 的 MCP server 匹配器。
///
/// `executable` 精确匹配可执行文件名；`args` 列表按位置匹配参数，
/// 每个参数使用独立的 `McpServerValueMatcher`，长度必须与候选 server 的参数数量一致。
#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct McpServerCommandMatcher {
    /// 可执行文件名（精确匹配）。
    pub executable: String,
    /// 参数匹配器列表，按位置一一对应。
    pub args: Vec<McpServerValueMatcher>,
}

#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct RawMcpServerCommandIdentity {
    command: McpServerCommandMatcher,
}

#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct RawMcpServerUrlIdentity {
    url: McpServerValueMatcher,
}

/// 对一个具名 MCP server 的要求。
///
/// `Identity` 变体保留已发布的精确匹配契约；`Command` 与 `Url` 变体是
/// 在 `identity` key 下接受的规范化 matcher 形式。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpServerRequirement {
    /// 精确匹配 command 或 URL（向后兼容）。
    Identity { identity: McpServerIdentity },
    /// 基于 command 的 matcher 匹配 stdio server。
    Command(McpServerCommandMatcher),
    /// 基于 URL 的 matcher 匹配 StreamableHttp server。
    Url(McpServerValueMatcher),
}

#[derive(Deserialize)]
struct RawMcpServerRequirement {
    identity: RawMcpServerIdentity,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RawMcpServerIdentity {
    Exact(McpServerIdentity),
    Command(RawMcpServerCommandIdentity),
    Url(RawMcpServerUrlIdentity),
}

impl<'de> Deserialize<'de> for McpServerRequirement {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let RawMcpServerRequirement { identity } =
            RawMcpServerRequirement::deserialize(deserializer)?;
        match identity {
            RawMcpServerIdentity::Exact(identity) => Ok(Self::Identity { identity }),
            RawMcpServerIdentity::Command(matcher) => Ok(Self::Command(matcher.command)),
            RawMcpServerIdentity::Url(matcher) => Ok(Self::Url(matcher.url)),
        }
    }
}

impl McpServerRequirement {
    /// 校验当前 requirement 的所有 matcher 是否合法。
    ///
    /// `Identity` 变体无需校验；`Command` 变体校验每个参数 matcher；
    /// `Url` 变体校验 URL matcher。
    pub(crate) fn validate(&self) -> Result<(), String> {
        match self {
            Self::Identity { .. } => Ok(()),
            Self::Command(matcher) => {
                for (index, arg) in matcher.args.iter().enumerate() {
                    arg.validate().map_err(|err| {
                        format!("invalid argument matcher at index {index}: {err}")
                    })?;
                }
                Ok(())
            }
            Self::Url(matcher) => matcher.validate(),
        }
    }

    /// 判断给定的 `server` 配置是否满足当前 requirement。
    ///
    /// 匹配规则：
    /// - `Identity::Command` 精确匹配 stdio server 的 command
    /// - `Identity::Url` 精确匹配 StreamableHttp server 的 url
    /// - `Command` matcher 要求 executable 精确匹配且参数列表逐位置匹配
    /// - `Url` matcher 要求 URL 完整匹配
    /// - transport 类型不对应时返回 false
    pub fn matches(&self, server: &McpServerConfig) -> bool {
        match (self, &server.transport) {
            (
                Self::Identity {
                    identity:
                        McpServerIdentity::Command {
                            command: want_command,
                        },
                },
                McpServerTransportConfig::Stdio {
                    command: got_command,
                    ..
                },
            ) => got_command == want_command,
            (
                Self::Identity {
                    identity: McpServerIdentity::Url { url: want_url },
                },
                McpServerTransportConfig::StreamableHttp { url: got_url, .. },
            ) => got_url == want_url,
            (Self::Command(matcher), McpServerTransportConfig::Stdio { command, args, .. }) => {
                matcher.executable == *command
                    && matcher.args.len() == args.len()
                    && matcher
                        .args
                        .iter()
                        .zip(args)
                        .all(|(matcher, arg)| matcher.matches(arg))
            }
            (Self::Url(matcher), McpServerTransportConfig::StreamableHttp { url, .. }) => {
                matcher.matches(url)
            }
            _ => false,
        }
    }
}

#[cfg(test)]
#[path = "mcp_requirements_tests.rs"]
mod tests;
