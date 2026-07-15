//! Agent 路径类型与解析逻辑。
//!
//! 本模块定义了 [`AgentPath`]——一种用于在多 Agent 树形结构中唯一定位某个 Agent
//! 的路径类型。路径必须为绝对路径（以 `/root` 开头，或为特殊路径 `/morpheus`），
//! 通过 `join` 可构造子路径，通过 `resolve` 可按相对/绝对引用解析到目标 Agent。
//!
//! 该类型是协议层表达"哪个 Agent 正在交互"的核心标识，序列化为字符串形式以便
//! 跨进程传递。

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::fmt;
use std::ops::Deref;
use std::str::FromStr;
use ts_rs::TS;

/// Agent 在多 Agent 树中的绝对路径。
///
/// 不变量：
/// - 必须以 `/root` 开头，或为特殊路径 `/morpheus`；
/// - 不以 `/` 结尾；
/// - 每个路径段仅由小写字母、数字、下划线组成；
/// - 路径段不能为 `root`、`.` 或 `..`（保留名称）。
///
/// 通过 `try_from` / `from_string` 构造时会执行上述校验，违反不变量将返回错误。
#[derive(
    Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema, TS,
)]
#[serde(try_from = "String", into = "String")]
#[schemars(with = "String")]
#[ts(type = "string")]
pub struct AgentPath(String);

impl AgentPath {
    /// 根 Agent 的路径常量。
    pub const ROOT: &str = "/root";
    /// Morpheus 特殊 Agent 的路径常量。
    pub const MORPHEUS: &str = "/morpheus";
    const ROOT_SEGMENT: &str = "root";

    /// 构造根 Agent 路径 `/root`。
    pub fn root() -> Self {
        Self(Self::ROOT.to_string())
    }

    /// 构造 Morpheus 特殊 Agent 路径 `/morpheus`。
    pub fn morpheus() -> Self {
        Self(Self::MORPHEUS.to_string())
    }

    /// 从字符串构造 `AgentPath`，校验通过后返回。
    ///
    /// # Errors
    /// 当字符串不符合路径不变量（见类型文档）时返回描述性错误。
    pub fn from_string(path: String) -> Result<Self, String> {
        validate_absolute_path(path.as_str())?;
        Ok(Self(path))
    }

    /// 以 `&str` 形式访问底层路径字符串。
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }

    /// 判断是否为根 Agent 路径。
    pub fn is_root(&self) -> bool {
        self.as_str() == Self::ROOT
    }

    /// 返回路径最后一段作为 Agent 的可读名称。
    ///
    /// 例如 `/root/researcher` 的名称为 `researcher`；根路径返回 `root`。
    pub fn name(&self) -> &str {
        if self.is_root() {
            return Self::ROOT_SEGMENT;
        }
        self.as_str()
            .rsplit('/')
            .next()
            .filter(|segment| !segment.is_empty())
            .unwrap_or(Self::ROOT_SEGMENT)
    }

    /// 在当前路径下追加一个子 Agent 名称，构造子路径。
    ///
    /// # Errors
    /// 当 `agent_name` 不满足段命名规则时返回错误。
    pub fn join(&self, agent_name: &str) -> Result<Self, String> {
        validate_agent_name(agent_name)?;
        Self::from_string(format!("{self}/{agent_name}"))
    }

    /// 依据引用字符串解析出目标 Agent 路径。
    ///
    /// 支持三种引用形式：
    /// - 空字符串：报错；
    /// - `/root`：返回根路径；
    /// - 以 `/` 开头的绝对路径：直接作为绝对路径解析；
    /// - 其他：视为相对引用，附加到当前路径之后解析。
    ///
    /// # Errors
    /// 当引用为空或不符合路径不变量时返回错误。
    pub fn resolve(&self, reference: &str) -> Result<Self, String> {
        if reference.is_empty() {
            return Err("agent path must not be empty".to_string());
        }
        if reference == Self::ROOT {
            return Ok(Self::root());
        }
        if reference.starts_with('/') {
            return Self::try_from(reference);
        }

        validate_relative_reference(reference)?;
        Self::from_string(format!("{self}/{reference}"))
    }
}

impl TryFrom<String> for AgentPath {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::from_string(value)
    }
}

impl TryFrom<&str> for AgentPath {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Self::from_string(value.to_string())
    }
}

impl From<AgentPath> for String {
    fn from(value: AgentPath) -> Self {
        value.0
    }
}

impl FromStr for AgentPath {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::try_from(s)
    }
}

impl AsRef<str> for AgentPath {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl Deref for AgentPath {
    type Target = str;

    fn deref(&self) -> &Self::Target {
        self.as_str()
    }
}

impl fmt::Display for AgentPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 校验单个 Agent 名称段是否符合命名规则。
///
/// 规则：非空；不能为 `root`、`.` 或 `..`；不能包含 `/`；
/// 仅允许小写字母、数字与下划线。
fn validate_agent_name(agent_name: &str) -> Result<(), String> {
    if agent_name.is_empty() {
        return Err("agent_name must not be empty".to_string());
    }
    if agent_name == AgentPath::ROOT_SEGMENT {
        return Err("agent_name `root` is reserved".to_string());
    }
    if agent_name == "." || agent_name == ".." {
        return Err(format!("agent_name `{agent_name}` is reserved"));
    }
    if agent_name.contains('/') {
        return Err("agent_name must not contain `/`".to_string());
    }
    if !agent_name
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
    {
        return Err(
            "agent_name must use only lowercase letters, digits, and underscores".to_string(),
        );
    }
    Ok(())
}

/// 校验绝对 Agent 路径。
///
/// 接受 `/morpheus` 或以 `/root` 开头、各段合法、不以 `/` 结尾的路径。
fn validate_absolute_path(path: &str) -> Result<(), String> {
    if path == AgentPath::MORPHEUS {
        return Ok(());
    }

    let Some(stripped) = path.strip_prefix('/') else {
        return Err("absolute agent paths must start with `/root` or be `/morpheus`".to_string());
    };
    let mut segments = stripped.split('/');
    let Some(root) = segments.next() else {
        return Err("absolute agent path must not be empty".to_string());
    };
    if root != AgentPath::ROOT_SEGMENT {
        return Err("absolute agent paths must start with `/root` or be `/morpheus`".to_string());
    }
    if stripped.ends_with('/') {
        return Err("absolute agent path must not end with `/`".to_string());
    }
    for segment in segments {
        validate_agent_name(segment)?;
    }
    Ok(())
}

/// 校验相对引用（不含前导 `/`）。
///
/// 要求不以 `/` 结尾，且每一段均通过 `validate_agent_name` 校验。
fn validate_relative_reference(reference: &str) -> Result<(), String> {
    if reference.ends_with('/') {
        return Err("relative agent path must not end with `/`".to_string());
    }
    for segment in reference.split('/') {
        validate_agent_name(segment)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::AgentPath;
    use pretty_assertions::assert_eq;

    #[test]
    fn root_has_expected_name() {
        let root = AgentPath::root();
        assert_eq!(root.as_str(), AgentPath::ROOT);
        assert_eq!(root.name(), "root");
        assert!(root.is_root());
    }

    #[test]
    fn morpheus_has_expected_name() {
        let morpheus = AgentPath::morpheus();
        assert_eq!(morpheus.as_str(), AgentPath::MORPHEUS);
        assert_eq!(morpheus.name(), "morpheus");
        assert!(!morpheus.is_root());
    }

    #[test]
    fn join_builds_child_paths() {
        let root = AgentPath::root();
        let child = root.join("researcher").expect("child path");
        assert_eq!(child.as_str(), "/root/researcher");
        assert_eq!(child.name(), "researcher");
    }

    #[test]
    fn resolve_supports_relative_and_absolute_references() {
        let current = AgentPath::try_from("/root/researcher").expect("path");
        assert_eq!(
            current.resolve("worker").expect("relative path"),
            AgentPath::try_from("/root/researcher/worker").expect("path")
        );
        assert_eq!(
            current.resolve("/root/other").expect("absolute path"),
            AgentPath::try_from("/root/other").expect("path")
        );
    }

    #[test]
    fn invalid_names_and_paths_are_rejected() {
        assert_eq!(
            AgentPath::root().join("BadName"),
            Err("agent_name must use only lowercase letters, digits, and underscores".to_string())
        );
        assert_eq!(
            AgentPath::try_from("/not-root"),
            Err("absolute agent paths must start with `/root` or be `/morpheus`".to_string())
        );
        assert_eq!(
            AgentPath::root().resolve("../sibling"),
            Err("agent_name `..` is reserved".to_string())
        );
    }
}
