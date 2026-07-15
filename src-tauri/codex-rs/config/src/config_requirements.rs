use codex_protocol::config_types::ApprovalsReviewer;
use codex_protocol::config_types::SandboxMode;
use codex_protocol::config_types::WebSearchMode;
use codex_protocol::models::PermissionProfile;
use codex_protocol::openai_models::ReasoningEffort;
use codex_protocol::protocol::AskForApproval;
use codex_utils_absolute_path::AbsolutePathBuf;
use serde::Deserialize;
use serde::Serialize;
use serde::de::Error as _;
use serde::de::value::Error as ValueDeserializerError;
use serde::de::value::StrDeserializer;
use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;
use wildmatch::WildMatchPattern;

use super::requirements_exec_policy::RequirementsExecPolicy;
use super::requirements_exec_policy::RequirementsExecPolicyToml;
use crate::Constrained;
use crate::ConstraintError;
use crate::ManagedHooksRequirementsToml;
use crate::mcp_requirements::McpServerRequirement;
use crate::mcp_types::AppToolApproval;
use crate::permissions_toml::PermissionProfileToml;
use crate::types::WindowsSandboxModeToml;

/// requirements 层中某个字段值的来源标记，用于诊断与错误消息。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequirementSource {
    /// 来源未知（默认值）。
    Unknown,
    /// macOS managed preferences（MDM）来源。
    MdmManagedPreferences {
        /// MDM application domain（如 `com.openai.codex`）。
        domain: String,
        /// MDM key（如 `requirements_toml_base64`）。
        key: String,
    },
    /// 多个 requirements 层共同贡献了最终值。来源按高优先级在前存储，
    /// 与错误消息中展示的顺序一致。
    Composite {
        /// 按高优先级在前排列的来源列表。
        sources: Vec<RequirementSource>,
    },
    /// 后端下发的企业管理层。`id` 是稳定的后端标识符；
    /// `name` 是面向管理员的显示名称。
    EnterpriseManaged {
        /// 稳定的后端标识符。
        id: String,
        /// 面向管理员的显示名称。
        name: String,
    },
    /// 系统 `requirements.toml` 文件来源。
    SystemRequirementsToml {
        /// `requirements.toml` 文件的绝对路径。
        file: AbsolutePathBuf,
    },
    /// legacy `managed_config.toml` 文件来源。
    LegacyManagedConfigTomlFromFile {
        /// `managed_config.toml` 文件的绝对路径。
        file: AbsolutePathBuf,
    },
    /// legacy `managed_config.toml`（MDM）来源。
    LegacyManagedConfigTomlFromMdm,
}

impl RequirementSource {
    /// 把多个来源合成一个 `Composite`，自动展平嵌套的 `Composite` 并去重。
    ///
    /// - 空迭代器返回 `Unknown`。
    /// - 单一来源直接返回该来源。
    /// - 多个来源返回 `Composite { sources }`。
    pub fn composite(sources: impl IntoIterator<Item = RequirementSource>) -> Self {
        let mut flattened = Vec::new();
        for source in sources {
            source.append_to_composite(&mut flattened);
        }

        match flattened.len() {
            0 => RequirementSource::Unknown,
            1 => flattened.remove(0),
            _ => RequirementSource::Composite { sources: flattened },
        }
    }

    /// 把 `self` 展平追加到 `flattened`，跳过重复项。
    fn append_to_composite(self, flattened: &mut Vec<RequirementSource>) {
        match self {
            RequirementSource::Composite { sources } => {
                for source in sources {
                    source.append_to_composite(flattened);
                }
            }
            source => {
                if !flattened.contains(&source) {
                    flattened.push(source);
                }
            }
        }
    }
}

impl fmt::Display for RequirementSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RequirementSource::Unknown => write!(f, "<unspecified>"),
            RequirementSource::MdmManagedPreferences { domain, key } => {
                write!(f, "MDM {domain}:{key}")
            }
            RequirementSource::Composite { sources } => {
                write!(f, "requirements layers: ")?;
                for (index, source) in sources.iter().enumerate() {
                    if index > 0 {
                        write!(f, ", ")?;
                    }
                    write!(f, "{source}")?;
                }
                Ok(())
            }
            RequirementSource::EnterpriseManaged { id, name } => {
                write!(f, "enterprise-managed requirements {name} ({id})")
            }
            RequirementSource::SystemRequirementsToml { file } => {
                write!(f, "{}", file.as_path().display())
            }
            RequirementSource::LegacyManagedConfigTomlFromFile { file } => {
                write!(f, "{}", file.as_path().display())
            }
            RequirementSource::LegacyManagedConfigTomlFromMdm => {
                write!(f, "MDM managed_config.toml (legacy)")
            }
        }
    }
}

/// 带来源标记的受约束值。
///
/// 把 `Constrained<T>` 与可选的 `RequirementSource` 配对，便于在约束校验
/// 失败时给出有意义的错误消息。
#[derive(Debug, Clone, PartialEq)]
pub struct ConstrainedWithSource<T> {
    /// 受约束的值。
    pub value: Constrained<T>,
    /// 该值的来源标记，`None` 表示来源未知。
    pub source: Option<RequirementSource>,
}

impl<T> ConstrainedWithSource<T> {
    /// 构造一个带来源的受约束值。
    pub fn new(value: Constrained<T>, source: Option<RequirementSource>) -> Self {
        Self { value, source }
    }
}

impl<T> std::ops::Deref for ConstrainedWithSource<T> {
    type Target = Constrained<T>;

    fn deref(&self) -> &Self::Target {
        &self.value
    }
}

impl<T> std::ops::DerefMut for ConstrainedWithSource<T> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.value
    }
}

/// [`ConfigRequirementsToml`] 在反序列化与规范化后的归一化形式。
#[derive(Debug, Clone, PartialEq)]
pub struct ConfigRequirements {
    /// 受约束的审批策略。
    pub approval_policy: ConstrainedWithSource<AskForApproval>,
    /// 受约束的审批审阅者。
    pub approvals_reviewer: ConstrainedWithSource<ApprovalsReviewer>,
    /// 受约束的权限 profile。
    pub permission_profile: ConstrainedWithSource<PermissionProfile>,
    /// 受约束的 Windows sandbox 模式。
    pub windows_sandbox_mode: ConstrainedWithSource<Option<WindowsSandboxModeToml>>,
    /// 受约束的 web 搜索模式。
    pub web_search_mode: ConstrainedWithSource<WebSearchMode>,
    /// 是否仅允许 managed hooks。
    pub allow_managed_hooks_only: Option<Sourced<bool>>,
    /// 是否允许 appshots。
    pub allow_appshots: Option<Sourced<bool>>,
    /// 是否允许远程控制。
    pub allow_remote_control: Option<Sourced<bool>>,
    /// computer use 的 requirements 配置。
    pub computer_use: Option<Sourced<ComputerUseRequirementsToml>>,
    /// feature 级别的 requirements 配置。
    pub feature_requirements: Option<Sourced<FeatureRequirementsToml>>,
    /// managed hooks 的受约束配置。
    pub managed_hooks: Option<ConstrainedWithSource<ManagedHooksRequirementsToml>>,
    /// MCP server 的 requirements 配置。
    pub mcp_servers: Option<Sourced<BTreeMap<String, McpServerRequirement>>>,
    /// plugin 的 requirements 配置。
    pub plugins: Option<Sourced<BTreeMap<String, PluginRequirementsToml>>>,
    /// marketplace 的 requirements 配置。
    pub marketplaces: Option<Sourced<MarketplaceRequirementsToml>>,
    /// 执行策略（exec policy）。
    pub exec_policy: Option<Sourced<RequirementsExecPolicy>>,
    /// 数据驻留约束。
    pub enforce_residency: ConstrainedWithSource<Option<ResidencyRequirement>>,
    /// 从 requirements 派生的 managed 网络约束。
    pub network: Option<Sourced<NetworkConstraints>>,
    /// 从 requirements 派生的 managed 文件系统约束。
    pub filesystem: Option<Sourced<FilesystemConstraints>>,
    /// managed guardian 策略配置的来源（当配置了时）。
    pub guardian_policy_config_source: Option<RequirementSource>,
}

impl Default for ConfigRequirements {
    fn default() -> Self {
        Self {
            approval_policy: ConstrainedWithSource::new(
                Constrained::allow_any_from_default(),
                /*source*/ None,
            ),
            approvals_reviewer: ConstrainedWithSource::new(
                Constrained::allow_any_from_default(),
                /*source*/ None,
            ),
            permission_profile: ConstrainedWithSource::new(
                Constrained::allow_any(PermissionProfile::read_only()),
                /*source*/ None,
            ),
            windows_sandbox_mode: ConstrainedWithSource::new(
                Constrained::allow_any(/*initial_value*/ None),
                /*source*/ None,
            ),
            web_search_mode: ConstrainedWithSource::new(
                Constrained::allow_any(WebSearchMode::Cached),
                /*source*/ None,
            ),
            allow_managed_hooks_only: None,
            allow_appshots: None,
            allow_remote_control: None,
            computer_use: None,
            feature_requirements: None,
            managed_hooks: None,
            mcp_servers: None,
            plugins: None,
            marketplaces: None,
            exec_policy: None,
            enforce_residency: ConstrainedWithSource::new(
                Constrained::allow_any(/*initial_value*/ None),
                /*source*/ None,
            ),
            network: None,
            filesystem: None,
            guardian_policy_config_source: None,
        }
    }
}

impl ConfigRequirements {
    /// 返回 exec policy 的来源标记（若已配置）。
    pub fn exec_policy_source(&self) -> Option<&RequirementSource> {
        self.exec_policy.as_ref().map(|policy| &policy.source)
    }
}

/// 单个 plugin 的 requirements TOML 配置。
///
/// 当前仅承载该 plugin 名下的 MCP server requirements；
/// 后续可按需扩展更多 plugin 级别的约束字段。
#[derive(Deserialize, Debug, Clone, Default, PartialEq, Eq)]
pub struct PluginRequirementsToml {
    /// 该 plugin 允许的 MCP server 需求映射表，键为 server 名称。
    pub mcp_servers: Option<BTreeMap<String, McpServerRequirement>>,
}

/// marketplace 的 requirements TOML 配置。
///
/// 用于限制 plugin/marketplace 仅可来自一组受信任的来源。
#[derive(Deserialize, Debug, Clone, Default, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MarketplaceRequirementsToml {
    /// 是否启用"仅允许白名单来源"策略。
    pub restrict_to_allowed_sources: Option<bool>,
    /// 受信任来源的白名单，键为来源标识。
    #[serde(default)]
    pub allowed_sources: BTreeMap<String, MarketplaceAllowedSourceToml>,
}

impl MarketplaceRequirementsToml {
    /// 当所有字段均为空时返回 `true`。
    pub fn is_empty(&self) -> bool {
        self.restrict_to_allowed_sources.is_none() && self.allowed_sources.is_empty()
    }
}

/// 原始 marketplace 来源规则。
///
/// 各字段的最终含义在 requirements 组合之后才会被解释；
/// 例如 `source` 决定按 `url`/`host_pattern`/`path` 中的哪一个进行匹配。
#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MarketplaceAllowedSourceToml {
    /// 来源类型（Git / HostPattern / Local）。
    pub source: Option<MarketplaceAllowedSourceKind>,
    /// Git 仓库 URL（`source = "git"` 时使用）。
    pub url: Option<String>,
    /// Git 引用名（如 tag 或 commit），对应 TOML 中的 `ref` 字段。
    #[serde(rename = "ref")]
    pub ref_name: Option<String>,
    /// 主机通配符模式（`source = "host_pattern"` 时使用）。
    pub host_pattern: Option<String>,
    /// 本地路径（`source = "local"` 时使用）。
    pub path: Option<PathBuf>,
}

/// marketplace 来源的类型分类。
#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MarketplaceAllowedSourceKind {
    /// Git 仓库来源。
    Git,
    /// 主机通配符来源。
    HostPattern,
    /// 本地路径来源。
    Local,
}

impl PluginRequirementsToml {
    /// 当 `mcp_servers` 为空或不存在时返回 `true`。
    pub fn is_empty(&self) -> bool {
        self.mcp_servers.as_ref().is_none_or(BTreeMap::is_empty)
    }
}

/// 网络域名权限表，键为域名通配符模式，值为允许/拒绝策略。
///
/// 使用 `flatten` 序列化，因此 TOML 中直接以 `[experimental_network.domains]`
/// 表的形式呈现，每个键值对即一条域名规则。
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq)]
pub struct NetworkDomainPermissionsToml {
    /// 域名通配符模式到权限的映射。
    #[serde(flatten)]
    pub entries: BTreeMap<String, NetworkDomainPermissionToml>,
}

impl NetworkDomainPermissionsToml {
    /// 当权限表为空时返回 `true`。
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 返回所有 `Allow` 域名模式列表；若没有则返回 `None`。
    pub fn allowed_domains(&self) -> Option<Vec<String>> {
        let allowed_domains: Vec<String> = self
            .entries
            .iter()
            .filter(|(_, permission)| matches!(permission, NetworkDomainPermissionToml::Allow))
            .map(|(pattern, _)| pattern.clone())
            .collect();
        (!allowed_domains.is_empty()).then_some(allowed_domains)
    }

    /// 返回所有 `Deny` 域名模式列表；若没有则返回 `None`。
    pub fn denied_domains(&self) -> Option<Vec<String>> {
        let denied_domains: Vec<String> = self
            .entries
            .iter()
            .filter(|(_, permission)| matches!(permission, NetworkDomainPermissionToml::Deny))
            .map(|(pattern, _)| pattern.clone())
            .collect();
        (!denied_domains.is_empty()).then_some(denied_domains)
    }
}

/// 单个域名的网络访问权限。
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum NetworkDomainPermissionToml {
    /// 允许访问。
    Allow,
    /// 拒绝访问。
    Deny,
}

impl std::fmt::Display for NetworkDomainPermissionToml {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let permission = match self {
            Self::Allow => "allow",
            Self::Deny => "deny",
        };
        f.write_str(permission)
    }
}

/// Unix domain socket 权限表，键为 socket 路径，值为允许/拒绝策略。
///
/// 与 [`NetworkDomainPermissionsToml`] 类似，使用 `flatten` 序列化，
/// 在 TOML 中以 `[experimental_network.unix_sockets]` 表呈现。
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq)]
pub struct NetworkUnixSocketPermissionsToml {
    /// socket 路径到权限的映射。
    #[serde(flatten)]
    pub entries: BTreeMap<String, NetworkUnixSocketPermissionToml>,
}

impl NetworkUnixSocketPermissionsToml {
    /// 当权限表为空时返回 `true`。
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 返回所有 `Allow` 的 Unix socket 路径列表。
    pub fn allow_unix_sockets(&self) -> Vec<String> {
        self.entries
            .iter()
            .filter(|(_, permission)| matches!(permission, NetworkUnixSocketPermissionToml::Allow))
            .map(|(path, _)| path.clone())
            .collect()
    }
}

/// 单个 Unix socket 的访问权限。
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum NetworkUnixSocketPermissionToml {
    /// 允许访问。
    Allow,
    /// 拒绝访问。
    Deny,
}

impl std::fmt::Display for NetworkUnixSocketPermissionToml {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let permission = match self {
            Self::Allow => "allow",
            Self::Deny => "deny",
        };
        f.write_str(permission)
    }
}

/// `experimental_network` 段的 requirements TOML 表征。
///
/// 该结构同时支持规范化的 `domains`/`unix_sockets` 形式和 legacy 的
/// `allowed_domains`/`denied_domains`/`allow_unix_sockets` 列表形式，
/// 在反序列化时把后者归一化为前者。
#[derive(Serialize, Debug, Clone, Default, PartialEq, Eq)]
pub struct NetworkRequirementsToml {
    /// 是否启用网络沙箱。
    pub enabled: Option<bool>,
    /// HTTP 代理端口。
    pub http_port: Option<u16>,
    /// SOCKS 代理端口。
    pub socks_port: Option<u16>,
    /// 是否允许使用上游代理。
    pub allow_upstream_proxy: Option<bool>,
    /// 危险选项：是否允许非 loopback 代理。
    pub dangerously_allow_non_loopback_proxy: Option<bool>,
    /// 危险选项：是否允许所有 Unix socket。
    pub dangerously_allow_all_unix_sockets: Option<bool>,
    /// 域名级权限映射表。
    pub domains: Option<NetworkDomainPermissionsToml>,
    /// 当为 `true` 时，managed 网络强制生效期间仅遵守 managed 的
    /// `allowed_domains`，用户自定义的白名单条目将被忽略。
    pub managed_allowed_domains_only: Option<bool>,
    /// Unix socket 权限映射表。
    pub unix_sockets: Option<NetworkUnixSocketPermissionsToml>,
    /// 是否允许绑定本地端口。
    pub allow_local_binding: Option<bool>,
}

/// 反序列化用的中间结构，同时承载规范字段与 legacy 字段以便做互斥校验。
#[derive(Deserialize)]
struct RawNetworkRequirementsToml {
    enabled: Option<bool>,
    http_port: Option<u16>,
    socks_port: Option<u16>,
    allow_upstream_proxy: Option<bool>,
    dangerously_allow_non_loopback_proxy: Option<bool>,
    dangerously_allow_all_unix_sockets: Option<bool>,
    domains: Option<NetworkDomainPermissionsToml>,
    #[serde(default)]
    allowed_domains: Option<Vec<String>>,
    /// 当为 `true` 时，managed 网络强制生效期间仅遵守 managed 的
    /// `allowed_domains`，用户自定义的白名单条目将被忽略。
    managed_allowed_domains_only: Option<bool>,
    #[serde(default)]
    denied_domains: Option<Vec<String>>,
    unix_sockets: Option<NetworkUnixSocketPermissionsToml>,
    #[serde(default)]
    allow_unix_sockets: Option<Vec<String>>,
    allow_local_binding: Option<bool>,
}

impl<'de> Deserialize<'de> for NetworkRequirementsToml {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = RawNetworkRequirementsToml::deserialize(deserializer)?;
        let RawNetworkRequirementsToml {
            enabled,
            http_port,
            socks_port,
            allow_upstream_proxy,
            dangerously_allow_non_loopback_proxy,
            dangerously_allow_all_unix_sockets,
            domains,
            allowed_domains,
            managed_allowed_domains_only,
            denied_domains,
            unix_sockets,
            allow_unix_sockets,
            allow_local_binding,
        } = raw;

        if domains.is_some() && (allowed_domains.is_some() || denied_domains.is_some()) {
            return Err(D::Error::custom(
                "`experimental_network.domains` cannot be combined with legacy `allowed_domains` or `denied_domains`",
            ));
        }

        if unix_sockets.is_some() && allow_unix_sockets.is_some() {
            return Err(D::Error::custom(
                "`experimental_network.unix_sockets` cannot be combined with legacy `allow_unix_sockets`",
            ));
        }

        Ok(Self {
            enabled,
            http_port,
            socks_port,
            allow_upstream_proxy,
            dangerously_allow_non_loopback_proxy,
            dangerously_allow_all_unix_sockets,
            domains: domains
                .or_else(|| legacy_domain_permissions_from_lists(allowed_domains, denied_domains)),
            managed_allowed_domains_only,
            unix_sockets: unix_sockets
                .or_else(|| legacy_unix_socket_permissions_from_list(allow_unix_sockets)),
            allow_local_binding,
        })
    }
}

/// 把 legacy 的 `allowed_domains`/`denied_domains` 列表归一化为
/// 规范化的域名权限映射表。
///
/// legacy 列表归一化是有意"有损"的：显式的空 legacy 列表在转换为规范
/// 域名权限形态时会被视作未设置，从而避免无意义的空表覆盖更高优先级层。
fn legacy_domain_permissions_from_lists(
    allowed_domains: Option<Vec<String>>,
    denied_domains: Option<Vec<String>>,
) -> Option<NetworkDomainPermissionsToml> {
    let mut entries = BTreeMap::new();

    for pattern in allowed_domains.unwrap_or_default() {
        entries.insert(pattern, NetworkDomainPermissionToml::Allow);
    }

    for pattern in denied_domains.unwrap_or_default() {
        entries.insert(pattern, NetworkDomainPermissionToml::Deny);
    }

    (!entries.is_empty()).then_some(NetworkDomainPermissionsToml { entries })
}

/// 把 legacy 的 `allow_unix_sockets` 列表归一化为 socket 权限映射表。
fn legacy_unix_socket_permissions_from_list(
    allow_unix_sockets: Option<Vec<String>>,
) -> Option<NetworkUnixSocketPermissionsToml> {
    let entries = allow_unix_sockets
        .unwrap_or_default()
        .into_iter()
        .map(|path| (path, NetworkUnixSocketPermissionToml::Allow))
        .collect::<BTreeMap<_, _>>();

    (!entries.is_empty()).then_some(NetworkUnixSocketPermissionsToml { entries })
}

/// 从 requirements TOML 派生出的规范化网络约束。
///
/// 字段含义与 [`NetworkRequirementsToml`] 一致，但作为运行时约束使用，
/// 不再承载 legacy 列表字段。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct NetworkConstraints {
    /// 是否启用网络沙箱。
    pub enabled: Option<bool>,
    /// HTTP 代理端口。
    pub http_port: Option<u16>,
    /// SOCKS 代理端口。
    pub socks_port: Option<u16>,
    /// 是否允许使用上游代理。
    pub allow_upstream_proxy: Option<bool>,
    /// 危险选项：是否允许非 loopback 代理。
    pub dangerously_allow_non_loopback_proxy: Option<bool>,
    /// 危险选项：是否允许所有 Unix socket。
    pub dangerously_allow_all_unix_sockets: Option<bool>,
    /// 域名级权限映射表。
    pub domains: Option<NetworkDomainPermissionsToml>,
    /// 当为 `true` 时，managed 网络强制生效期间仅遵守 managed 的
    /// `allowed_domains`，用户自定义的白名单条目将被忽略。
    pub managed_allowed_domains_only: Option<bool>,
    /// Unix socket 权限映射表。
    pub unix_sockets: Option<NetworkUnixSocketPermissionsToml>,
    /// 是否允许绑定本地端口。
    pub allow_local_binding: Option<bool>,
}

impl<'de> Deserialize<'de> for NetworkConstraints {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let requirements = NetworkRequirementsToml::deserialize(deserializer)?;
        Ok(requirements.into())
    }
}

impl From<NetworkRequirementsToml> for NetworkConstraints {
    fn from(value: NetworkRequirementsToml) -> Self {
        let NetworkRequirementsToml {
            enabled,
            http_port,
            socks_port,
            allow_upstream_proxy,
            dangerously_allow_non_loopback_proxy,
            dangerously_allow_all_unix_sockets,
            domains,
            managed_allowed_domains_only,
            unix_sockets,
            allow_local_binding,
        } = value;
        Self {
            enabled,
            http_port,
            socks_port,
            allow_upstream_proxy,
            dangerously_allow_non_loopback_proxy,
            dangerously_allow_all_unix_sockets,
            domains,
            managed_allowed_domains_only,
            unix_sockets,
            allow_local_binding,
        }
    }
}

/// `permissions.filesystem` 段的 requirements TOML 表征。
///
/// 仅承载 requirements 级别的文件系统约束（当前只有 `deny_read`），
/// 不允许嵌套定义 permission profile，因此反序列化时对 `extends`、
/// `workspace_roots`、`filesystem`、`network`、`description` 等字段做
/// 显式拒绝以避免歧义。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FilesystemRequirementsToml {
    /// 拒绝读取的路径/glob 模式列表。
    pub deny_read: Option<Vec<FilesystemDenyReadPattern>>,
}

/// 反序列化中间结构，用于严格拒绝 profile 相关字段。
#[derive(Deserialize)]
struct RawFilesystemRequirementsToml {
    deny_read: Option<Vec<FilesystemDenyReadPattern>>,
    description: Option<serde::de::IgnoredAny>,
    extends: Option<serde::de::IgnoredAny>,
    workspace_roots: Option<serde::de::IgnoredAny>,
    filesystem: Option<serde::de::IgnoredAny>,
    network: Option<serde::de::IgnoredAny>,
}

impl<'de> Deserialize<'de> for FilesystemRequirementsToml {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = RawFilesystemRequirementsToml::deserialize(deserializer)?;
        let RawFilesystemRequirementsToml {
            deny_read,
            description,
            extends,
            workspace_roots,
            filesystem,
            network,
        } = raw;

        if description.is_some()
            || extends.is_some()
            || workspace_roots.is_some()
            || filesystem.is_some()
            || network.is_some()
        {
            return Err(D::Error::custom(
                "`permissions.filesystem` is reserved for requirements-level filesystem constraints and cannot define a profile",
            ));
        }

        Ok(Self { deny_read })
    }
}

/// `permissions` 段的 requirements TOML 表征。
///
/// `filesystem` 子段保留给 requirements 级别的文件系统约束，不能用于
/// 命名 profile；其余通过 `flatten` 收集为 permission profile 名到
/// profile 定义的映射。
#[derive(Deserialize, Debug, Clone, Default, PartialEq, Eq)]
pub struct PermissionsRequirementsToml {
    /// requirements 级别的文件系统约束。
    pub filesystem: Option<FilesystemRequirementsToml>,
    /// permission profile 名到 profile 定义的映射。
    ///
    /// 由于 legacy 原因，`filesystem` 仍保留给 requirements 级别的文件系统约束，
    /// 不能用于命名 profile。
    #[serde(default, flatten)]
    pub profiles: BTreeMap<String, PermissionProfileToml>,
}

/// 从 requirements 派生出的文件系统约束。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilesystemConstraints {
    /// 拒绝读取的路径/glob 模式列表。
    pub deny_read: Vec<FilesystemDenyReadPattern>,
}

impl From<PermissionsRequirementsToml> for FilesystemConstraints {
    fn from(value: PermissionsRequirementsToml) -> Self {
        let deny_read = value
            .filesystem
            .and_then(|filesystem| filesystem.deny_read)
            .unwrap_or_default();
        Self { deny_read }
    }
}

/// 拒绝读取的路径或 glob 模式。
///
/// 内部以规范化后的字符串存储：非 glob 输入会被解析为绝对路径；
/// 含 glob 元字符的输入会被切分为目录前缀（绝对路径）与 glob 后缀，
/// 然后重新拼合成标准形式。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct FilesystemDenyReadPattern(String);

impl FilesystemDenyReadPattern {
    /// 以字符串形式访问内部模式。
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// 当模式包含 glob 元字符（`*`/`?`/`[`）时返回 `true`。
    pub fn contains_glob(&self) -> bool {
        self.0.chars().any(is_glob_metacharacter)
    }

    /// 把用户输入解析为 [`FilesystemDenyReadPattern`]。
    ///
    /// - 不含 glob 元字符时，按绝对路径解析并存储其规范化形式。
    /// - 含 glob 元字符时，把输入拆分为目录前缀（绝对路径）与 glob 后缀，
    ///   重新拼合为标准形式。
    ///
    /// # Errors
    /// 当输入无法解析为绝对路径时返回错误描述字符串。
    pub fn from_input(input: &str) -> Result<Self, String> {
        if !input.chars().any(is_glob_metacharacter) {
            let path = deserialize_absolute_path(input)?;
            return Ok(Self(path.to_string_lossy().into_owned()));
        }

        let (directory_prefix, suffix) = split_glob_pattern(input);
        let normalized_prefix = if directory_prefix.is_empty() {
            deserialize_absolute_path(".")?
        } else {
            deserialize_absolute_path(directory_prefix)?
        };
        let normalized_prefix = normalized_prefix.to_string_lossy();
        let normalized = if suffix.is_empty() {
            normalized_prefix.into_owned()
        } else if normalized_prefix == "/" {
            format!("/{suffix}")
        } else {
            format!("{normalized_prefix}/{suffix}")
        };
        Ok(Self(normalized))
    }
}

impl From<AbsolutePathBuf> for FilesystemDenyReadPattern {
    fn from(value: AbsolutePathBuf) -> Self {
        Self(value.to_string_lossy().into_owned())
    }
}

impl<'de> Deserialize<'de> for FilesystemDenyReadPattern {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let input = String::deserialize(deserializer)?;
        Self::from_input(&input).map_err(D::Error::custom)
    }
}

/// 通过自定义 `StrDeserializer` 把字符串解析为 `AbsolutePathBuf`。
fn deserialize_absolute_path(input: &str) -> Result<AbsolutePathBuf, String> {
    AbsolutePathBuf::deserialize(StrDeserializer::<ValueDeserializerError>::new(input))
        .map_err(|err| err.to_string())
}

/// 把含 glob 元字符的模式切分为目录前缀与 glob 后缀。
///
/// 返回 `(directory_prefix, suffix)`：
/// - 若 glob 元字符前没有路径分隔符，则 `directory_prefix` 为空字符串。
/// - 若分隔符位于开头（Unix 根路径），则 `directory_prefix` 为 `"/"`。
fn split_glob_pattern(input: &str) -> (&str, &str) {
    let Some(first_glob) = input.find(is_glob_metacharacter) else {
        return ("", input);
    };
    let separator_index = input[..first_glob]
        .char_indices()
        .rev()
        .find(|(_, ch)| is_path_separator(*ch))
        .map(|(index, _)| index);

    match separator_index {
        Some(0) => ("/", &input[1..]),
        Some(index)
            if cfg!(windows)
                && index == 2
                && input.as_bytes().get(1) == Some(&b':')
                && input.as_bytes().get(2).is_some() =>
        {
            (&input[..=index], &input[index + 1..])
        }
        Some(index) => (&input[..index], &input[index + 1..]),
        None => ("", input),
    }
}

/// 判断字符是否为当前平台的路径分隔符。
fn is_path_separator(ch: char) -> bool {
    if cfg!(windows) {
        ch == '/' || ch == '\\'
    } else {
        ch == '/'
    }
}

/// 判断字符是否为 glob 元字符。
fn is_glob_metacharacter(ch: char) -> bool {
    matches!(ch, '*' | '?' | '[')
}

/// requirements 级别的 web 搜索模式约束。
///
/// 与 [`WebSearchMode`] 一一对应，但承载于 requirements 层以表达
/// "允许的搜索模式集合"语义。
#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum WebSearchModeRequirement {
    /// 禁用 web 搜索。
    Disabled,
    /// 仅使用缓存的搜索结果。
    Cached,
    /// 使用已索引的搜索结果。
    Indexed,
    /// 实时进行 web 搜索。
    Live,
}

impl From<WebSearchMode> for WebSearchModeRequirement {
    fn from(mode: WebSearchMode) -> Self {
        match mode {
            WebSearchMode::Disabled => WebSearchModeRequirement::Disabled,
            WebSearchMode::Cached => WebSearchModeRequirement::Cached,
            WebSearchMode::Indexed => WebSearchModeRequirement::Indexed,
            WebSearchMode::Live => WebSearchModeRequirement::Live,
        }
    }
}

impl From<WebSearchModeRequirement> for WebSearchMode {
    fn from(mode: WebSearchModeRequirement) -> Self {
        match mode {
            WebSearchModeRequirement::Disabled => WebSearchMode::Disabled,
            WebSearchModeRequirement::Cached => WebSearchMode::Cached,
            WebSearchModeRequirement::Indexed => WebSearchMode::Indexed,
            WebSearchModeRequirement::Live => WebSearchMode::Live,
        }
    }
}

impl fmt::Display for WebSearchModeRequirement {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WebSearchModeRequirement::Disabled => write!(f, "disabled"),
            WebSearchModeRequirement::Cached => write!(f, "cached"),
            WebSearchModeRequirement::Indexed => write!(f, "indexed"),
            WebSearchModeRequirement::Live => write!(f, "live"),
        }
    }
}

/// `computer_use` 段的 requirements TOML 表征。
#[derive(Deserialize, Debug, Clone, Default, PartialEq, Eq)]
pub struct ComputerUseRequirementsToml {
    /// 是否允许在锁屏状态下使用 computer use。
    pub allow_locked_computer_use: Option<bool>,
}

impl ComputerUseRequirementsToml {
    /// 当字段未设置时返回 `true`。
    pub fn is_empty(&self) -> bool {
        self.allow_locked_computer_use.is_none()
    }
}

/// `windows` 段的 requirements TOML 表征。
#[derive(Deserialize, Debug, Clone, Default, PartialEq, Eq)]
pub struct WindowsRequirementsToml {
    /// 允许的 Windows sandbox 实现列表（如 `elevated`、`unelevated`）。
    pub allowed_sandbox_implementations: Option<Vec<WindowsSandboxModeToml>>,
}

impl WindowsRequirementsToml {
    /// 当字段未设置时返回 `true`。
    pub fn is_empty(&self) -> bool {
        self.allowed_sandbox_implementations.is_none()
    }
}

/// `features` 段的 requirements TOML 表征。
///
/// 以 `flatten` 形式承载 feature 名到启用/禁用布尔值的映射。
#[derive(Deserialize, Debug, Clone, Default, PartialEq, Eq)]
pub struct FeatureRequirementsToml {
    /// feature 名到启用状态的映射（`true` 表示允许启用）。
    #[serde(flatten)]
    pub entries: BTreeMap<String, bool>,
}

impl FeatureRequirementsToml {
    /// 当映射为空时返回 `true`。
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// 单个 app 工具的 requirements TOML 表征。
#[derive(Deserialize, Debug, Clone, Default, PartialEq, Eq)]
pub struct AppToolRequirementToml {
    /// 该工具的审批模式。
    pub approval_mode: Option<AppToolApproval>,
}

impl AppToolRequirementToml {
    /// 当字段未设置时返回 `true`。
    pub fn is_empty(&self) -> bool {
        self.approval_mode.is_none()
    }
}

/// 单个 app 下所有工具的 requirements TOML 表征。
///
/// 以 `flatten` 形式承载工具名到工具 requirements 的映射。
#[derive(Deserialize, Debug, Clone, Default, PartialEq, Eq)]
pub struct AppToolsRequirementsToml {
    /// 工具名到工具 requirements 的映射。
    #[serde(default, flatten)]
    pub tools: BTreeMap<String, AppToolRequirementToml>,
}

impl AppToolsRequirementsToml {
    /// 当所有工具的 requirements 均为空时返回 `true`。
    pub fn is_empty(&self) -> bool {
        self.tools.values().all(AppToolRequirementToml::is_empty)
    }
}

/// 单个 app 的 requirements TOML 表征。
#[derive(Deserialize, Debug, Clone, Default, PartialEq, Eq)]
pub struct AppRequirementToml {
    /// 该 app 是否启用。
    pub enabled: Option<bool>,
    /// 该 app 下工具级别的 requirements。
    pub tools: Option<AppToolsRequirementsToml>,
}

impl AppRequirementToml {
    /// 当所有字段均为空时返回 `true`。
    pub fn is_empty(&self) -> bool {
        self.enabled.is_none()
            && self
                .tools
                .as_ref()
                .is_none_or(AppToolsRequirementsToml::is_empty)
    }
}

/// `apps` 段的 requirements TOML 表征。
///
/// 以 `flatten` 形式承载 app ID 到 app requirements 的映射。
#[derive(Deserialize, Debug, Clone, Default, PartialEq, Eq)]
pub struct AppsRequirementsToml {
    /// app ID 到 app requirements 的映射。
    #[serde(default, flatten)]
    pub apps: BTreeMap<String, AppRequirementToml>,
}

impl AppsRequirementsToml {
    /// 当所有 app 的 requirements 均为空时返回 `true`。
    pub fn is_empty(&self) -> bool {
        self.apps.values().all(AppRequirementToml::is_empty)
    }
}

/// 把来自较低优先级层的 app requirements 合并到已有的较高优先级集合中。
///
/// 该函数允许 managed 来源（如 Cloud/MDM）跨层强制禁用某些 app：
/// - `enabled` 字段：任一层显式设为 `Some(false)` 即视为禁用，
///   否则较高优先级的非空值优先，回退到较低优先级的非空值。
/// - 工具级 `approval_mode`：当较高优先级未设置时，才回退到较低优先级的值。
pub(crate) fn merge_app_requirements_descending(
    base: &mut AppsRequirementsToml,
    incoming: AppsRequirementsToml,
) {
    for (app_id, incoming_requirement) in incoming.apps {
        let base_requirement = base.apps.entry(app_id).or_default();
        let higher_precedence = base_requirement.enabled;
        let lower_precedence = incoming_requirement.enabled;
        base_requirement.enabled =
            if higher_precedence == Some(false) || lower_precedence == Some(false) {
                Some(false)
            } else {
                higher_precedence.or(lower_precedence)
            };

        let Some(incoming_tools) = incoming_requirement.tools else {
            continue;
        };
        let base_tools = base_requirement.tools.get_or_insert_with(Default::default);
        for (tool_name, incoming_tool) in incoming_tools.tools {
            let base_tool = base_tools.tools.entry(tool_name).or_default();
            if base_tool.approval_mode.is_none() {
                base_tool.approval_mode = incoming_tool.approval_mode;
            }
        }
    }
}

/// 从系统 `requirements.toml` 或 MDM 反序列化得到的 base config。
#[derive(Deserialize, Debug, Clone, Default, PartialEq)]
pub struct ConfigRequirementsToml {
    /// 允许的审批策略集合。
    pub allowed_approval_policies: Option<Vec<AskForApproval>>,
    /// 允许的审批审阅者集合。
    pub allowed_approvals_reviewers: Option<Vec<ApprovalsReviewer>>,
    /// 允许的 sandbox 模式集合。
    pub allowed_sandbox_modes: Option<Vec<SandboxModeRequirement>>,
    /// 允许的 permission profile 名到是否启用的映射。
    pub allowed_permission_profiles: Option<BTreeMap<String, bool>>,
    /// 默认的 permission profile 名。
    pub default_permissions: Option<String>,
    /// 远程 sandbox 配置列表（按主机模式匹配）。
    pub remote_sandbox_config: Option<Vec<RemoteSandboxConfigToml>>,
    /// 允许的 web 搜索模式集合。
    pub allowed_web_search_modes: Option<Vec<WebSearchModeRequirement>>,
    /// 是否仅允许 managed hooks。
    pub allow_managed_hooks_only: Option<bool>,
    /// 是否允许 appshots。
    pub allow_appshots: Option<bool>,
    /// 是否允许远程控制。
    pub allow_remote_control: Option<bool>,
    /// computer use 的 requirements 配置。
    pub computer_use: Option<ComputerUseRequirementsToml>,
    /// Windows 平台 requirements 配置。
    pub windows: Option<WindowsRequirementsToml>,
    /// feature 级别的 requirements 配置（TOML 中为 `features`，
    /// 亦接受 legacy 别名 `feature_requirements`）。
    #[serde(rename = "features", alias = "feature_requirements")]
    pub feature_requirements: Option<FeatureRequirementsToml>,
    /// managed hooks 的 requirements 配置。
    pub hooks: Option<ManagedHooksRequirementsToml>,
    /// MCP server 的 requirements 映射表。
    pub mcp_servers: Option<BTreeMap<String, McpServerRequirement>>,
    /// plugin 的 requirements 映射表。
    pub plugins: Option<BTreeMap<String, PluginRequirementsToml>>,
    /// marketplace 的 requirements 配置。
    pub marketplaces: Option<MarketplaceRequirementsToml>,
    /// app 级别的 requirements 配置。
    pub apps: Option<AppsRequirementsToml>,
    /// exec policy 的 requirements TOML 表征。
    pub rules: Option<RequirementsExecPolicyToml>,
    /// 数据驻留约束。
    pub enforce_residency: Option<ResidencyRequirement>,
    /// 网络相关 requirements（TOML 中为 `experimental_network`）。
    #[serde(rename = "experimental_network")]
    pub network: Option<NetworkRequirementsToml>,
    /// permissions 相关 requirements。
    pub permissions: Option<PermissionsRequirementsToml>,
    /// 模型相关 requirements。
    pub models: Option<ModelsRequirementsToml>,
    /// guardian 策略配置标识。
    pub guardian_policy_config: Option<String>,
}

/// 模型相关 requirements TOML 表征。
#[derive(Deserialize, Debug, Clone, Default, PartialEq, Eq)]
pub struct ModelsRequirementsToml {
    /// 新建 thread 时使用的模型默认值。
    pub new_thread: Option<NewThreadModelDefaultsToml>,
}

impl ModelsRequirementsToml {
    /// 当所有字段均为空时返回 `true`。
    fn is_empty(&self) -> bool {
        self.new_thread
            .as_ref()
            .is_none_or(NewThreadModelDefaultsToml::is_empty)
    }
}

/// 新建 thread 时使用的模型默认值。
#[derive(Deserialize, Debug, Clone, Default, PartialEq, Eq)]
pub struct NewThreadModelDefaultsToml {
    /// 默认模型名。
    pub model: Option<String>,
    /// 默认的推理强度。
    pub model_reasoning_effort: Option<ReasoningEffort>,
    /// 默认的 service tier。
    pub service_tier: Option<String>,
}

impl NewThreadModelDefaultsToml {
    /// 当所有字段均为空时返回 `true`。
    fn is_empty(&self) -> bool {
        self.model.is_none() && self.model_reasoning_effort.is_none() && self.service_tier.is_none()
    }
}

/// 远程 sandbox 配置项。
///
/// 当主机名匹配 `hostname_patterns` 中任一模式时，应用对应的
/// `allowed_sandbox_modes` 列表覆盖全局配置。
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct RemoteSandboxConfigToml {
    /// 主机名通配符模式列表。
    pub hostname_patterns: Vec<String>,
    /// 匹配主机时允许的 sandbox 模式集合。
    pub allowed_sandbox_modes: Vec<SandboxModeRequirement>,
}

/// 与该值关联的 requirements 来源标记，用于在错误消息中提示来源。
#[derive(Debug, Clone, PartialEq)]
pub struct Sourced<T> {
    /// 实际值。
    pub value: T,
    /// 该值的来源标记。
    pub source: RequirementSource,
}

impl<T> Sourced<T> {
    /// 构造一个带来源标记的值。
    pub fn new(value: T, source: RequirementSource) -> Self {
        Self { value, source }
    }
}

impl<T> std::ops::Deref for Sourced<T> {
    type Target = T;

    fn deref(&self) -> &Self::Target {
        &self.value
    }
}

/// 所有 requirements 字段均附带来源标记的组合体。
///
/// 每个 `Option<Sourced<T>>` 字段记录该 requirements 来自哪一层
/// `RequirementSource`，便于在约束校验失败或诊断时给出有意义的错误消息。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ConfigRequirementsWithSources {
    /// 允许的审批策略集合及其来源。
    pub allowed_approval_policies: Option<Sourced<Vec<AskForApproval>>>,
    /// 允许的审批审阅者集合及其来源。
    pub allowed_approvals_reviewers: Option<Sourced<Vec<ApprovalsReviewer>>>,
    /// 允许的 sandbox 模式集合及其来源。
    pub allowed_sandbox_modes: Option<Sourced<Vec<SandboxModeRequirement>>>,
    /// 允许的 permission profile 映射及其来源。
    pub allowed_permission_profiles: Option<Sourced<BTreeMap<String, bool>>>,
    /// 默认 permission profile 名及其来源。
    pub default_permissions: Option<Sourced<String>>,
    /// 允许的 web 搜索模式集合及其来源。
    pub allowed_web_search_modes: Option<Sourced<Vec<WebSearchModeRequirement>>>,
    /// 是否仅允许 managed hooks 及其来源。
    pub allow_managed_hooks_only: Option<Sourced<bool>>,
    /// 是否允许 appshots 及其来源。
    pub allow_appshots: Option<Sourced<bool>>,
    /// 是否允许远程控制及其来源。
    pub allow_remote_control: Option<Sourced<bool>>,
    /// computer use 配置及其来源。
    pub computer_use: Option<Sourced<ComputerUseRequirementsToml>>,
    /// Windows 平台配置及其来源。
    pub windows: Option<Sourced<WindowsRequirementsToml>>,
    /// feature 级别配置及其来源。
    pub feature_requirements: Option<Sourced<FeatureRequirementsToml>>,
    /// managed hooks 配置及其来源。
    pub hooks: Option<Sourced<ManagedHooksRequirementsToml>>,
    /// MCP server 映射表及其来源。
    pub mcp_servers: Option<Sourced<BTreeMap<String, McpServerRequirement>>>,
    /// plugin 映射表及其来源。
    pub plugins: Option<Sourced<BTreeMap<String, PluginRequirementsToml>>>,
    /// marketplace 配置及其来源。
    pub marketplaces: Option<Sourced<MarketplaceRequirementsToml>>,
    /// app 配置及其来源。
    pub apps: Option<Sourced<AppsRequirementsToml>>,
    /// exec policy 配置及其来源。
    pub rules: Option<Sourced<RequirementsExecPolicyToml>>,
    /// 数据驻留约束及其来源。
    pub enforce_residency: Option<Sourced<ResidencyRequirement>>,
    /// 网络配置及其来源。
    pub network: Option<Sourced<NetworkRequirementsToml>>,
    /// permissions 配置及其来源。
    pub permissions: Option<Sourced<PermissionsRequirementsToml>>,
    /// 模型配置及其来源。
    pub models: Option<Sourced<ModelsRequirementsToml>>,
    /// guardian 策略配置标识及其来源。
    pub guardian_policy_config: Option<Sourced<String>>,
}

impl ConfigRequirementsWithSources {
    /// 把另一层 `ConfigRequirementsToml` 中"已设置但本对象未设置"的字段
    /// 合并进来，并把对应来源标记为 `source`。
    ///
    /// - 对于普通字段，仅当本对象对应字段为 `None` 时才填入。
    /// - 对于 `apps` 字段，调用 [`merge_app_requirements_descending`]
    ///   进行跨层合并，允许低优先级层强制禁用 app。
    /// - 显式空字符串的 `guardian_policy_config` 会被视作未设置。
    pub fn merge_unset_fields(&mut self, source: RequirementSource, other: ConfigRequirementsToml) {
        // 对于 `other` 中每个为 `Some` 的字段，若 `self` 中对应字段为 `None`，
        // 则把 `other` 的值填入 `self`。
        macro_rules! fill_missing_take {
            ($base:expr, $other:expr, $source:expr, { $($field:ident),+ $(,)? }) => {
                $(
                    if $base.$field.is_none()
                        && let Some(value) = $other.$field.take()
                    {
                        $base.$field = Some(Sourced::new(value, $source.clone()));
                    }
                )+
            };
        }

        // 不使用 `..` 解构，以便向 `ConfigRequirementsToml` 添加字段时
        // 强制更新此合并逻辑。
        let ConfigRequirementsToml {
            allowed_approval_policies: _,
            allowed_approvals_reviewers: _,
            allowed_sandbox_modes: _,
            allowed_permission_profiles: _,
            default_permissions: _,
            remote_sandbox_config: _,
            allowed_web_search_modes: _,
            allow_managed_hooks_only: _,
            allow_appshots: _,
            allow_remote_control: _,
            computer_use: _,
            windows: _,
            feature_requirements: _,
            hooks: _,
            mcp_servers: _,
            plugins: _,
            marketplaces: _,
            apps: _,
            rules: _,
            enforce_residency: _,
            network: _,
            permissions: _,
            models: _,
            guardian_policy_config: _,
        } = &other;

        let mut other = other;
        if other
            .guardian_policy_config
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
        {
            other.guardian_policy_config = None;
        }
        fill_missing_take!(
            self,
            other,
            source,
            {
                allowed_approval_policies,
                allowed_approvals_reviewers,
                allowed_sandbox_modes,
                allowed_permission_profiles,
                default_permissions,
                allowed_web_search_modes,
                allow_managed_hooks_only,
                allow_appshots,
                allow_remote_control,
                computer_use,
                windows,
                feature_requirements,
                hooks,
                mcp_servers,
                plugins,
                marketplaces,
                rules,
                enforce_residency,
                network,
                permissions,
                models,
                guardian_policy_config,
            }
        );

        if let Some(incoming_apps) = other.apps.take() {
            if let Some(existing_apps) = self.apps.as_mut() {
                merge_app_requirements_descending(&mut existing_apps.value, incoming_apps);
            } else {
                self.apps = Some(Sourced::new(incoming_apps, source));
            }
        }
    }

    /// 把带来源标记的字段剥离为不带来源的 [`ConfigRequirementsToml`]。
    ///
    /// 注意：`remote_sandbox_config` 字段在转换后始终为 `None`，因为它
    /// 仅在 base config 反序列化时使用，不参与运行时约束。
    pub fn into_toml(self) -> ConfigRequirementsToml {
        let ConfigRequirementsWithSources {
            allowed_approval_policies,
            allowed_approvals_reviewers,
            allowed_sandbox_modes,
            allowed_permission_profiles,
            default_permissions,
            allowed_web_search_modes,
            allow_managed_hooks_only,
            allow_appshots,
            allow_remote_control,
            computer_use,
            windows,
            feature_requirements,
            hooks,
            mcp_servers,
            plugins,
            marketplaces,
            apps,
            rules,
            enforce_residency,
            network,
            permissions,
            models,
            guardian_policy_config,
        } = self;
        ConfigRequirementsToml {
            allowed_approval_policies: allowed_approval_policies.map(|sourced| sourced.value),
            allowed_approvals_reviewers: allowed_approvals_reviewers.map(|sourced| sourced.value),
            allowed_sandbox_modes: allowed_sandbox_modes.map(|sourced| sourced.value),
            allowed_permission_profiles: allowed_permission_profiles.map(|sourced| sourced.value),
            default_permissions: default_permissions.map(|sourced| sourced.value),
            remote_sandbox_config: None,
            allowed_web_search_modes: allowed_web_search_modes.map(|sourced| sourced.value),
            allow_managed_hooks_only: allow_managed_hooks_only.map(|sourced| sourced.value),
            allow_appshots: allow_appshots.map(|sourced| sourced.value),
            allow_remote_control: allow_remote_control.map(|sourced| sourced.value),
            computer_use: computer_use.map(|sourced| sourced.value),
            windows: windows.map(|sourced| sourced.value),
            feature_requirements: feature_requirements.map(|sourced| sourced.value),
            hooks: hooks.map(|sourced| sourced.value),
            mcp_servers: mcp_servers.map(|sourced| sourced.value),
            plugins: plugins.map(|sourced| sourced.value),
            marketplaces: marketplaces.map(|sourced| sourced.value),
            apps: apps.map(|sourced| sourced.value),
            rules: rules.map(|sourced| sourced.value),
            enforce_residency: enforce_residency.map(|sourced| sourced.value),
            network: network.map(|sourced| sourced.value),
            permissions: permissions.map(|sourced| sourced.value),
            models: models.map(|sourced| sourced.value),
            guardian_policy_config: guardian_policy_config.map(|sourced| sourced.value),
        }
    }
}

/// 规范化主机名：去首尾空白、去除尾部点、转小写；空结果返回 `None`。
fn normalize_hostname(hostname: &str) -> Option<String> {
    let hostname = hostname.trim().trim_end_matches('.');
    (!hostname.is_empty()).then(|| hostname.to_ascii_lowercase())
}

/// 判断主机名是否匹配任一通配符模式（大小写不敏感）。
fn hostname_matches_any_pattern(hostname: &str, patterns: &[String]) -> bool {
    patterns.iter().any(|pattern| {
        normalize_hostname(pattern)
            .map(|pattern| WildMatchPattern::<'*', '?'>::new_case_insensitive(&pattern))
            .is_some_and(|pattern| pattern.matches(hostname))
    })
}

/// requirements 级别的 sandbox 模式约束。
///
/// 当前 `external-sandbox` 在 `config.toml` 中不被支持，但可通过编程
/// 方式（如内部 API）使用。
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq)]
pub enum SandboxModeRequirement {
    /// 只读 sandbox。
    #[serde(rename = "read-only")]
    ReadOnly,

    /// 工作区可写 sandbox。
    #[serde(rename = "workspace-write")]
    WorkspaceWrite,

    /// 完全访问（危险）sandbox。
    #[serde(rename = "danger-full-access")]
    DangerFullAccess,

    /// 外部 sandbox（如 Apple Sandbox 或其他第三方隔离机制）。
    #[serde(rename = "external-sandbox")]
    ExternalSandbox,
}

impl From<SandboxMode> for SandboxModeRequirement {
    fn from(mode: SandboxMode) -> Self {
        match mode {
            SandboxMode::ReadOnly => SandboxModeRequirement::ReadOnly,
            SandboxMode::WorkspaceWrite => SandboxModeRequirement::WorkspaceWrite,
            SandboxMode::DangerFullAccess => SandboxModeRequirement::DangerFullAccess,
        }
    }
}

/// 数据驻留约束。
///
/// 当前仅支持 `us`，表示数据须驻留美国。
#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ResidencyRequirement {
    /// 数据须驻留美国。
    Us,
}

impl ConfigRequirementsToml {
    /// 根据主机名应用 `remote_sandbox_config` 中匹配的 sandbox 模式覆盖。
    ///
    /// 若 `hostname` 为 `None` 或不匹配任何模式，则不做任何更改。
    pub fn apply_remote_sandbox_config(&mut self, hostname: Option<&str>) {
        let Some(remote_sandbox_config) = self.remote_sandbox_config.as_ref() else {
            return;
        };
        let Some(hostname) = hostname.and_then(normalize_hostname) else {
            return;
        };
        let Some(matched_config) = remote_sandbox_config
            .iter()
            .find(|config| hostname_matches_any_pattern(&hostname, &config.hostname_patterns))
        else {
            return;
        };
        self.allowed_sandbox_modes = Some(matched_config.allowed_sandbox_modes.clone());
    }

    /// 当所有字段均为空时返回 `true`。
    pub fn is_empty(&self) -> bool {
        self.allowed_approval_policies.is_none()
            && self.allowed_approvals_reviewers.is_none()
            && self.allowed_sandbox_modes.is_none()
            && self.allowed_permission_profiles.is_none()
            && self.default_permissions.is_none()
            && self.remote_sandbox_config.is_none()
            && self.allowed_web_search_modes.is_none()
            && self.allow_managed_hooks_only.is_none()
            && self.allow_appshots.is_none()
            && self.allow_remote_control.is_none()
            && self
                .computer_use
                .as_ref()
                .is_none_or(ComputerUseRequirementsToml::is_empty)
            && self
                .windows
                .as_ref()
                .is_none_or(WindowsRequirementsToml::is_empty)
            && self
                .feature_requirements
                .as_ref()
                .is_none_or(FeatureRequirementsToml::is_empty)
            && self
                .hooks
                .as_ref()
                .is_none_or(ManagedHooksRequirementsToml::is_empty)
            && self.mcp_servers.is_none()
            && self
                .plugins
                .as_ref()
                .is_none_or(|plugins| plugins.values().all(PluginRequirementsToml::is_empty))
            && self
                .marketplaces
                .as_ref()
                .is_none_or(MarketplaceRequirementsToml::is_empty)
            && self
                .apps
                .as_ref()
                .is_none_or(AppsRequirementsToml::is_empty)
            && self.rules.is_none()
            && self.enforce_residency.is_none()
            && self.network.is_none()
            && self.permissions.is_none()
            && self
                .models
                .as_ref()
                .is_none_or(ModelsRequirementsToml::is_empty)
            && self
                .guardian_policy_config
                .as_deref()
                .is_none_or(|value| value.trim().is_empty())
    }
}

/// 校验一组 MCP server requirements 中的每个 server。
///
/// 校验失败时返回 `ConstraintError::McpServerRequirementParse`，
/// 错误信息中会带上 `plugin_name`（若提供）与来源标记。
fn validate_mcp_server_requirements(
    requirements: &BTreeMap<String, McpServerRequirement>,
    source: &RequirementSource,
    plugin_name: Option<&str>,
) -> Result<(), ConstraintError> {
    for (server_name, requirement) in requirements {
        requirement
            .validate()
            .map_err(|reason| ConstraintError::McpServerRequirementParse {
                server_name: plugin_name
                    .map(|plugin_name| format!("{plugin_name}/{server_name}"))
                    .unwrap_or_else(|| server_name.clone()),
                requirement_source: source.clone(),
                reason,
            })?;
    }
    Ok(())
}

impl TryFrom<ConfigRequirementsWithSources> for ConfigRequirements {
    type Error = ConstraintError;

    fn try_from(toml: ConfigRequirementsWithSources) -> Result<Self, Self::Error> {
        // profile catalog 的选择保留在 `ConfigRequirementsToml` 上，用于
        // config 加载与 requirements API 投影。managed 的 new-thread 默认值
        // 也保留在那里，因为它们是初始化值，不是运行时约束。
        let ConfigRequirementsWithSources {
            allowed_approval_policies,
            allowed_approvals_reviewers,
            allowed_sandbox_modes,
            allowed_permission_profiles: _,
            default_permissions: _,
            allowed_web_search_modes,
            allow_managed_hooks_only,
            allow_appshots,
            allow_remote_control,
            computer_use,
            windows,
            feature_requirements,
            hooks,
            mcp_servers,
            plugins,
            marketplaces,
            apps: _apps,
            rules,
            enforce_residency,
            network,
            permissions,
            models: _,
            guardian_policy_config,
        } = toml;

        if let Some(requirements) = &mcp_servers {
            validate_mcp_server_requirements(
                &requirements.value,
                &requirements.source,
                /*plugin_name*/ None,
            )?;
        }
        if let Some(plugin_requirements) = &plugins {
            for (plugin_name, plugin) in &plugin_requirements.value {
                if let Some(requirements) = &plugin.mcp_servers {
                    validate_mcp_server_requirements(
                        requirements,
                        &plugin_requirements.source,
                        Some(plugin_name),
                    )?;
                }
            }
        }

        let approval_policy = match allowed_approval_policies {
            Some(Sourced {
                value: policies,
                source: requirement_source,
            }) => {
                let Some(initial_value) = policies.first().copied() else {
                    return Err(ConstraintError::empty_field("allowed_approval_policies"));
                };

                let requirement_source_for_error = requirement_source.clone();
                let constrained = Constrained::new(initial_value, move |candidate| {
                    if policies.contains(candidate) {
                        Ok(())
                    } else {
                        Err(ConstraintError::InvalidValue {
                            field_name: "approval_policy",
                            candidate: format!("{candidate:?}"),
                            allowed: format!("{policies:?}"),
                            requirement_source: requirement_source_for_error.clone(),
                        })
                    }
                })?;
                ConstrainedWithSource::new(constrained, Some(requirement_source))
            }
            None => ConstrainedWithSource::new(
                Constrained::allow_any_from_default(),
                /*source*/ None,
            ),
        };

        let approvals_reviewer = match allowed_approvals_reviewers {
            Some(Sourced {
                value: reviewers,
                source: requirement_source,
            }) => {
                let Some(initial_value) = reviewers.first().copied() else {
                    return Err(ConstraintError::empty_field("allowed_approvals_reviewers"));
                };

                let requirement_source_for_error = requirement_source.clone();
                let constrained = Constrained::new(initial_value, move |candidate| {
                    if reviewers.contains(candidate) {
                        Ok(())
                    } else {
                        Err(ConstraintError::InvalidValue {
                            field_name: "approvals_reviewer",
                            candidate: format!("{candidate:?}"),
                            allowed: format!("{reviewers:?}"),
                            requirement_source: requirement_source_for_error.clone(),
                        })
                    }
                })?;
                ConstrainedWithSource::new(constrained, Some(requirement_source))
            }
            None => ConstrainedWithSource::new(
                Constrained::allow_any_from_default(),
                /*source*/ None,
            ),
        };

        let default_permission_profile = PermissionProfile::read_only();
        let permission_profile = match allowed_sandbox_modes {
            Some(Sourced {
                value: modes,
                source: requirement_source,
            }) => {
                if !modes.contains(&SandboxModeRequirement::ReadOnly) {
                    return Err(ConstraintError::InvalidValue {
                        field_name: "allowed_sandbox_modes",
                        candidate: format!("{modes:?}"),
                        allowed: "must include 'read-only' to allow any PermissionProfile"
                            .to_string(),
                        requirement_source,
                    });
                };

                let requirement_source_for_error = requirement_source.clone();
                let constrained = Constrained::new(default_permission_profile, move |candidate| {
                    let mode = sandbox_mode_requirement_for_permission_profile(candidate);
                    if modes.contains(&mode) {
                        Ok(())
                    } else {
                        Err(ConstraintError::InvalidValue {
                            field_name: "sandbox_mode",
                            candidate: format!("{mode:?}"),
                            allowed: format!("{modes:?}"),
                            requirement_source: requirement_source_for_error.clone(),
                        })
                    }
                })?;
                ConstrainedWithSource::new(constrained, Some(requirement_source))
            }
            None => ConstrainedWithSource::new(
                Constrained::allow_any(default_permission_profile),
                /*source*/ None,
            ),
        };
        let windows_sandbox_mode = match windows {
            Some(Sourced {
                value:
                    WindowsRequirementsToml {
                        allowed_sandbox_implementations: Some(implementations),
                    },
                source: requirement_source,
            }) => {
                if implementations.is_empty() {
                    return Err(ConstraintError::empty_field(
                        "windows.allowed_sandbox_implementations",
                    ));
                }
                // 当两种 Windows sandbox 实现都被允许时，优先选择 elevated。
                let initial_value = if implementations.contains(&WindowsSandboxModeToml::Elevated) {
                    WindowsSandboxModeToml::Elevated
                } else {
                    WindowsSandboxModeToml::Unelevated
                };

                let requirement_source_for_error = requirement_source.clone();
                let constrained =
                    Constrained::new(Some(initial_value), move |candidate| match candidate {
                        Some(candidate) if implementations.contains(candidate) => Ok(()),
                        _ => Err(ConstraintError::InvalidValue {
                            field_name: "windows.sandbox",
                            candidate: format!("{candidate:?}"),
                            allowed: format!("{implementations:?}"),
                            requirement_source: requirement_source_for_error.clone(),
                        }),
                    })?;
                ConstrainedWithSource::new(constrained, Some(requirement_source))
            }
            Some(_) | None => ConstrainedWithSource::new(
                Constrained::allow_any(/*initial_value*/ None),
                /*source*/ None,
            ),
        };
        let exec_policy = match rules {
            Some(Sourced { value, source }) => {
                let policy = value.to_requirements_policy().map_err(|err| {
                    ConstraintError::ExecPolicyParse {
                        requirement_source: source.clone(),
                        reason: err.to_string(),
                    }
                })?;
                Some(Sourced::new(policy, source))
            }
            None => None,
        };
        let web_search_mode = match allowed_web_search_modes {
            Some(Sourced {
                value: modes,
                source: requirement_source,
            }) => {
                let mut accepted = modes.into_iter().collect::<std::collections::BTreeSet<_>>();
                accepted.insert(WebSearchModeRequirement::Disabled);
                let allowed_for_error = format!(
                    "{:?}",
                    accepted
                        .iter()
                        .copied()
                        .map(WebSearchMode::from)
                        .collect::<Vec<_>>()
                );

                let initial_value = if accepted.contains(&WebSearchModeRequirement::Cached) {
                    WebSearchMode::Cached
                } else if accepted.contains(&WebSearchModeRequirement::Indexed) {
                    WebSearchMode::Indexed
                } else if accepted.contains(&WebSearchModeRequirement::Live) {
                    WebSearchMode::Live
                } else {
                    WebSearchMode::Disabled
                };
                let requirement_source_for_error = requirement_source.clone();
                let constrained = Constrained::new(initial_value, move |candidate| {
                    if accepted.contains(&(*candidate).into()) {
                        Ok(())
                    } else {
                        Err(ConstraintError::InvalidValue {
                            field_name: "web_search_mode",
                            candidate: format!("{candidate:?}"),
                            allowed: allowed_for_error.clone(),
                            requirement_source: requirement_source_for_error.clone(),
                        })
                    }
                })?;
                ConstrainedWithSource::new(constrained, Some(requirement_source))
            }
            None => ConstrainedWithSource::new(
                Constrained::allow_any(WebSearchMode::Cached),
                /*source*/ None,
            ),
        };
        let feature_requirements =
            feature_requirements.filter(|requirements| !requirements.value.is_empty());
        let managed_hooks = hooks
            .filter(|managed_hooks| managed_hooks.value.handler_count() > 0)
            .map(|sourced_hooks| {
                let Sourced {
                    value,
                    source: requirement_source,
                } = sourced_hooks;
                let allowed = value;
                let allowed_for_error = format!("{allowed:?}");
                let requirement_source_for_error = requirement_source.clone();
                let constrained = Constrained::new(allowed.clone(), move |candidate| {
                    if candidate == &allowed {
                        Ok(())
                    } else {
                        Err(ConstraintError::InvalidValue {
                            field_name: "hooks",
                            candidate: format!("{candidate:?}"),
                            allowed: allowed_for_error.clone(),
                            requirement_source: requirement_source_for_error.clone(),
                        })
                    }
                })?;
                Ok(ConstrainedWithSource::new(
                    constrained,
                    Some(requirement_source),
                ))
            })
            .transpose()?;

        let enforce_residency = match enforce_residency {
            Some(Sourced {
                value: residency,
                source: requirement_source,
            }) => {
                let required = Some(residency);
                let requirement_source_for_error = requirement_source.clone();
                let constrained = Constrained::new(required, move |candidate| {
                    if candidate == &required {
                        Ok(())
                    } else {
                        Err(ConstraintError::InvalidValue {
                            field_name: "enforce_residency",
                            candidate: format!("{candidate:?}"),
                            allowed: format!("{required:?}"),
                            requirement_source: requirement_source_for_error.clone(),
                        })
                    }
                })?;
                ConstrainedWithSource::new(constrained, Some(requirement_source))
            }
            None => ConstrainedWithSource::new(
                Constrained::allow_any(/*initial_value*/ None),
                /*source*/ None,
            ),
        };
        let network = network.map(|sourced_network| {
            let Sourced { value, source } = sourced_network;
            Sourced::new(NetworkConstraints::from(value), source)
        });
        let filesystem = permissions.map(|sourced_permissions| {
            let Sourced { value, source } = sourced_permissions;
            Sourced::new(FilesystemConstraints::from(value), source)
        });
        let guardian_policy_config_source = guardian_policy_config.map(|sourced| sourced.source);
        Ok(ConfigRequirements {
            approval_policy,
            approvals_reviewer,
            permission_profile,
            windows_sandbox_mode,
            web_search_mode,
            allow_managed_hooks_only,
            allow_appshots,
            allow_remote_control,
            computer_use,
            feature_requirements,
            managed_hooks,
            mcp_servers,
            plugins,
            marketplaces,
            exec_policy,
            enforce_residency,
            network,
            filesystem,
            guardian_policy_config_source,
        })
    }
}

/// 根据 permission profile 推导其对应的 sandbox 模式约束。
///
/// 映射规则：
/// - `Disabled` → `DangerFullAccess`
/// - `External` → `ExternalSandbox`
/// - `Managed`：依据 file system policy 进一步判断：
///   - 拥有全盘写权限 → `DangerFullAccess`
///   - 任一 entry 可写 → `WorkspaceWrite`
///   - 否则 → `ReadOnly`
pub fn sandbox_mode_requirement_for_permission_profile(
    permission_profile: &PermissionProfile,
) -> SandboxModeRequirement {
    match permission_profile {
        PermissionProfile::Disabled => SandboxModeRequirement::DangerFullAccess,
        PermissionProfile::External { .. } => SandboxModeRequirement::ExternalSandbox,
        PermissionProfile::Managed { .. } => {
            let file_system_policy = permission_profile.file_system_sandbox_policy();
            if file_system_policy.has_full_disk_write_access() {
                SandboxModeRequirement::DangerFullAccess
            } else if file_system_policy
                .entries
                .iter()
                .any(|entry| entry.access.can_write())
            {
                SandboxModeRequirement::WorkspaceWrite
            } else {
                SandboxModeRequirement::ReadOnly
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::HookEventsToml;
    use crate::McpServerCommandMatcher;
    use crate::McpServerIdentity;
    use crate::McpServerValueMatcher;
    use anyhow::Result;
    use codex_execpolicy::Decision;
    use codex_execpolicy::Evaluation;
    use codex_execpolicy::RuleMatch;
    use codex_protocol::permissions::NetworkSandboxPolicy;
    use codex_utils_absolute_path::AbsolutePathBuf;
    use codex_utils_absolute_path::AbsolutePathBufGuard;
    use pretty_assertions::assert_eq;
    use toml::from_str;

    fn tokens(cmd: &[&str]) -> Vec<String> {
        cmd.iter().map(std::string::ToString::to_string).collect()
    }

    fn system_requirements_toml_file_for_test() -> Result<AbsolutePathBuf> {
        Ok(AbsolutePathBuf::try_from(
            std::env::temp_dir().join("requirements.toml"),
        )?)
    }

    #[test]
    fn composite_requirement_source_flattens_and_deduplicates_sources() {
        let mdm_source = RequirementSource::MdmManagedPreferences {
            domain: "com.openai.codex".to_string(),
            key: "requirements_toml_base64".to_string(),
        };
        let legacy_source = RequirementSource::LegacyManagedConfigTomlFromMdm;

        assert_eq!(
            RequirementSource::composite([
                mdm_source.clone(),
                RequirementSource::composite([legacy_source.clone(), mdm_source.clone()]),
            ]),
            RequirementSource::Composite {
                sources: vec![mdm_source, legacy_source],
            }
        );
    }

    fn with_unknown_source(toml: ConfigRequirementsToml) -> ConfigRequirementsWithSources {
        let ConfigRequirementsToml {
            allowed_approval_policies,
            allowed_approvals_reviewers,
            allowed_sandbox_modes,
            allowed_permission_profiles,
            default_permissions,
            remote_sandbox_config: _,
            allowed_web_search_modes,
            allow_managed_hooks_only,
            allow_appshots,
            allow_remote_control,
            computer_use,
            windows,
            feature_requirements,
            hooks,
            mcp_servers,
            plugins,
            marketplaces,
            apps,
            rules,
            enforce_residency,
            network,
            permissions,
            models,
            guardian_policy_config,
        } = toml;
        ConfigRequirementsWithSources {
            allowed_approval_policies: allowed_approval_policies
                .map(|value| Sourced::new(value, RequirementSource::Unknown)),
            allowed_approvals_reviewers: allowed_approvals_reviewers
                .map(|value| Sourced::new(value, RequirementSource::Unknown)),
            allowed_sandbox_modes: allowed_sandbox_modes
                .map(|value| Sourced::new(value, RequirementSource::Unknown)),
            allowed_permission_profiles: allowed_permission_profiles
                .map(|value| Sourced::new(value, RequirementSource::Unknown)),
            default_permissions: default_permissions
                .map(|value| Sourced::new(value, RequirementSource::Unknown)),
            allowed_web_search_modes: allowed_web_search_modes
                .map(|value| Sourced::new(value, RequirementSource::Unknown)),
            allow_managed_hooks_only: allow_managed_hooks_only
                .map(|value| Sourced::new(value, RequirementSource::Unknown)),
            allow_appshots: allow_appshots
                .map(|value| Sourced::new(value, RequirementSource::Unknown)),
            allow_remote_control: allow_remote_control
                .map(|value| Sourced::new(value, RequirementSource::Unknown)),
            computer_use: computer_use.map(|value| Sourced::new(value, RequirementSource::Unknown)),
            windows: windows.map(|value| Sourced::new(value, RequirementSource::Unknown)),
            feature_requirements: feature_requirements
                .map(|value| Sourced::new(value, RequirementSource::Unknown)),
            hooks: hooks.map(|value| Sourced::new(value, RequirementSource::Unknown)),
            mcp_servers: mcp_servers.map(|value| Sourced::new(value, RequirementSource::Unknown)),
            plugins: plugins.map(|value| Sourced::new(value, RequirementSource::Unknown)),
            marketplaces: marketplaces.map(|value| Sourced::new(value, RequirementSource::Unknown)),
            apps: apps.map(|value| Sourced::new(value, RequirementSource::Unknown)),
            rules: rules.map(|value| Sourced::new(value, RequirementSource::Unknown)),
            enforce_residency: enforce_residency
                .map(|value| Sourced::new(value, RequirementSource::Unknown)),
            network: network.map(|value| Sourced::new(value, RequirementSource::Unknown)),
            permissions: permissions.map(|value| Sourced::new(value, RequirementSource::Unknown)),
            models: models.map(|value| Sourced::new(value, RequirementSource::Unknown)),
            guardian_policy_config: guardian_policy_config
                .map(|value| Sourced::new(value, RequirementSource::Unknown)),
        }
    }

    #[test]
    fn deserialize_allow_managed_hooks_only() -> Result<()> {
        let requirements: ConfigRequirementsToml = from_str(
            r#"
                allow_managed_hooks_only = true
            "#,
        )?;

        assert_eq!(requirements.allow_managed_hooks_only, Some(true));
        assert!(!requirements.is_empty());
        Ok(())
    }

    #[test]
    fn allow_managed_hooks_only_false_is_still_configured() -> Result<()> {
        let requirements: ConfigRequirementsToml = from_str(
            r#"
                allow_managed_hooks_only = false
            "#,
        )?;

        assert_eq!(requirements.allow_managed_hooks_only, Some(false));
        assert!(!requirements.is_empty());
        Ok(())
    }

    #[test]
    fn deserialize_managed_permission_profiles() -> Result<()> {
        let requirements: ConfigRequirementsToml = from_str(
            r#"
                default_permissions = "managed-standard"

                [allowed_permission_profiles]
                managed-standard = true
                managed-build = true

                [permissions.managed-standard]
                extends = ":workspace"

                [permissions.managed-build]
                extends = "managed-standard"
            "#,
        )?;

        assert_eq!(
            requirements.allowed_permission_profiles,
            Some(BTreeMap::from([
                ("managed-build".to_string(), true),
                ("managed-standard".to_string(), true),
            ]))
        );
        assert_eq!(
            requirements.default_permissions,
            Some("managed-standard".to_string())
        );
        let permissions = requirements
            .permissions
            .as_ref()
            .expect("managed permission profiles");
        assert!(permissions.profiles.contains_key("managed-standard"));
        assert!(
            permissions
                .profiles
                .get("managed-build")
                .and_then(|profile| profile.extends.as_deref())
                .is_some()
        );
        assert!(!requirements.is_empty());
        Ok(())
    }

    #[test]
    fn deserialize_allow_appshots() -> Result<()> {
        let requirements: ConfigRequirementsToml = from_str(
            r#"
                allow_appshots = true
            "#,
        )?;

        assert_eq!(requirements.allow_appshots, Some(true));
        assert!(!requirements.is_empty());
        Ok(())
    }

    #[test]
    fn filesystem_requirements_table_cannot_define_a_permission_profile() {
        let err = from_str::<ConfigRequirementsToml>(
            r#"
                [permissions.filesystem]
                extends = ":workspace"
            "#,
        )
        .expect_err("filesystem requirements cannot define a permission profile");

        assert!(
            err.to_string().contains(
                "`permissions.filesystem` is reserved for requirements-level filesystem constraints and cannot define a profile"
            ),
            "unexpected error: {err:#}"
        );
    }

    #[test]
    fn allow_appshots_false_is_still_configured() -> Result<()> {
        let requirements: ConfigRequirementsToml = from_str(
            r#"
                allow_appshots = false
            "#,
        )?;

        assert_eq!(requirements.allow_appshots, Some(false));
        assert!(!requirements.is_empty());
        Ok(())
    }

    #[test]
    fn allow_remote_control_false_is_still_configured() -> Result<()> {
        let requirements: ConfigRequirementsToml = from_str(
            r#"
                allow_remote_control = false
            "#,
        )?;

        assert_eq!(requirements.allow_remote_control, Some(false));
        assert!(!requirements.is_empty());
        Ok(())
    }

    #[test]
    fn deserialize_computer_use_requirements() -> Result<()> {
        let requirements: ConfigRequirementsToml = from_str(
            r#"
                [computer_use]
                allow_locked_computer_use = false
            "#,
        )?;

        assert_eq!(
            requirements.computer_use,
            Some(ComputerUseRequirementsToml {
                allow_locked_computer_use: Some(false),
            })
        );
        assert!(!requirements.is_empty());
        Ok(())
    }

    #[test]
    fn deserialize_new_thread_model_defaults() -> Result<()> {
        let requirements: ConfigRequirementsToml = from_str(
            r#"
                [models.new_thread]
                model = "managed-model"
                model_reasoning_effort = "medium"
                service_tier = "fast"
            "#,
        )?;

        assert_eq!(
            requirements.models,
            Some(ModelsRequirementsToml {
                new_thread: Some(NewThreadModelDefaultsToml {
                    model: Some("managed-model".to_string()),
                    model_reasoning_effort: Some(ReasoningEffort::Medium),
                    service_tier: Some("fast".to_string()),
                }),
            })
        );
        assert!(!requirements.is_empty());
        Ok(())
    }

    #[test]
    fn merge_unset_fields_copies_every_field_and_sets_sources() {
        let mut target = ConfigRequirementsWithSources::default();
        let source = RequirementSource::LegacyManagedConfigTomlFromMdm;

        let allowed_approval_policies = vec![AskForApproval::UnlessTrusted, AskForApproval::Never];
        let allowed_approvals_reviewers =
            vec![ApprovalsReviewer::AutoReview, ApprovalsReviewer::User];
        let allowed_sandbox_modes = vec![
            SandboxModeRequirement::WorkspaceWrite,
            SandboxModeRequirement::DangerFullAccess,
        ];
        let allowed_web_search_modes = vec![
            WebSearchModeRequirement::Cached,
            WebSearchModeRequirement::Live,
        ];
        let feature_requirements = FeatureRequirementsToml {
            entries: BTreeMap::from([("personality".to_string(), true)]),
        };
        let computer_use = ComputerUseRequirementsToml {
            allow_locked_computer_use: Some(false),
        };
        let models = ModelsRequirementsToml {
            new_thread: Some(NewThreadModelDefaultsToml {
                model: Some("managed-model".to_string()),
                model_reasoning_effort: Some(ReasoningEffort::Medium),
                service_tier: Some("fast".to_string()),
            }),
        };
        let enforce_residency = ResidencyRequirement::Us;
        let enforce_source = source.clone();
        let guardian_policy_config = "Use the company-managed guardian policy.".to_string();

        // Intentionally constructed without `..Default::default()` so adding a new field to
        // `ConfigRequirementsToml` forces this test to be updated.
        let other = ConfigRequirementsToml {
            allowed_approval_policies: Some(allowed_approval_policies.clone()),
            allowed_approvals_reviewers: Some(allowed_approvals_reviewers.clone()),
            allowed_sandbox_modes: Some(allowed_sandbox_modes.clone()),
            allowed_permission_profiles: Some(BTreeMap::from([("managed".to_string(), true)])),
            default_permissions: Some("managed".to_string()),
            remote_sandbox_config: None,
            allowed_web_search_modes: Some(allowed_web_search_modes.clone()),
            allow_managed_hooks_only: Some(true),
            allow_appshots: Some(false),
            allow_remote_control: Some(false),
            computer_use: Some(computer_use.clone()),
            windows: None,
            feature_requirements: Some(feature_requirements.clone()),
            hooks: None,
            mcp_servers: None,
            plugins: None,
            marketplaces: None,
            apps: None,
            rules: None,
            enforce_residency: Some(enforce_residency),
            network: None,
            permissions: None,
            models: Some(models.clone()),
            guardian_policy_config: Some(guardian_policy_config.clone()),
        };

        target.merge_unset_fields(source.clone(), other);

        assert_eq!(
            target,
            ConfigRequirementsWithSources {
                allowed_approval_policies: Some(Sourced::new(
                    allowed_approval_policies,
                    source.clone()
                )),
                allowed_approvals_reviewers: Some(Sourced::new(
                    allowed_approvals_reviewers,
                    source.clone(),
                )),
                allowed_sandbox_modes: Some(Sourced::new(allowed_sandbox_modes, source.clone(),)),
                allowed_permission_profiles: Some(Sourced::new(
                    BTreeMap::from([("managed".to_string(), true)]),
                    source.clone(),
                )),
                default_permissions: Some(Sourced::new("managed".to_string(), source.clone(),)),
                allowed_web_search_modes: Some(Sourced::new(
                    allowed_web_search_modes,
                    enforce_source.clone(),
                )),
                allow_managed_hooks_only: Some(Sourced::new(
                    /*value*/ true,
                    enforce_source.clone(),
                )),
                allow_appshots: Some(Sourced::new(/*value*/ false, enforce_source.clone(),)),
                allow_remote_control: Some(Sourced::new(
                    /*value*/ false,
                    enforce_source.clone(),
                )),
                computer_use: Some(Sourced::new(computer_use, enforce_source.clone())),
                windows: None,
                feature_requirements: Some(Sourced::new(
                    feature_requirements,
                    enforce_source.clone(),
                )),
                hooks: None,
                mcp_servers: None,
                plugins: None,
                marketplaces: None,
                apps: None,
                rules: None,
                enforce_residency: Some(Sourced::new(enforce_residency, enforce_source)),
                network: None,
                permissions: None,
                models: Some(Sourced::new(models, source.clone())),
                guardian_policy_config: Some(Sourced::new(guardian_policy_config, source)),
            }
        );
    }

    #[test]
    fn merge_unset_fields_fills_missing_values() -> Result<()> {
        let source: ConfigRequirementsToml = from_str(
            r#"
                allowed_approval_policies = ["on-request"]
            "#,
        )?;

        let source_location = RequirementSource::MdmManagedPreferences {
            domain: "com.codex".to_string(),
            key: "allowed_approval_policies".to_string(),
        };

        let mut empty_target = ConfigRequirementsWithSources::default();
        empty_target.merge_unset_fields(source_location.clone(), source);
        assert_eq!(
            empty_target,
            ConfigRequirementsWithSources {
                allowed_approval_policies: Some(Sourced::new(
                    vec![AskForApproval::OnRequest],
                    source_location,
                )),
                allowed_approvals_reviewers: None,
                allowed_sandbox_modes: None,
                allowed_permission_profiles: None,
                default_permissions: None,
                allowed_web_search_modes: None,
                allow_managed_hooks_only: None,
                allow_appshots: None,
                allow_remote_control: None,
                computer_use: None,
                windows: None,
                feature_requirements: None,
                hooks: None,
                mcp_servers: None,
                plugins: None,
                marketplaces: None,
                apps: None,
                rules: None,
                enforce_residency: None,
                network: None,
                permissions: None,
                models: None,
                guardian_policy_config: None,
            }
        );
        Ok(())
    }

    #[test]
    fn merge_unset_fields_does_not_overwrite_existing_values() -> Result<()> {
        let existing_source = RequirementSource::LegacyManagedConfigTomlFromMdm;
        let mut populated_target = ConfigRequirementsWithSources::default();
        let populated_requirements: ConfigRequirementsToml = from_str(
            r#"
                allowed_approval_policies = ["never"]
            "#,
        )?;
        populated_target.merge_unset_fields(existing_source.clone(), populated_requirements);

        let source: ConfigRequirementsToml = from_str(
            r#"
                allowed_approval_policies = ["on-request"]
            "#,
        )?;
        let source_location = RequirementSource::MdmManagedPreferences {
            domain: "com.codex".to_string(),
            key: "allowed_approval_policies".to_string(),
        };
        populated_target.merge_unset_fields(source_location, source);

        assert_eq!(
            populated_target,
            ConfigRequirementsWithSources {
                allowed_approval_policies: Some(Sourced::new(
                    vec![AskForApproval::Never],
                    existing_source,
                )),
                allowed_approvals_reviewers: None,
                allowed_sandbox_modes: None,
                allowed_permission_profiles: None,
                default_permissions: None,
                allowed_web_search_modes: None,
                allow_managed_hooks_only: None,
                allow_appshots: None,
                allow_remote_control: None,
                computer_use: None,
                windows: None,
                feature_requirements: None,
                hooks: None,
                mcp_servers: None,
                plugins: None,
                marketplaces: None,
                apps: None,
                rules: None,
                enforce_residency: None,
                network: None,
                permissions: None,
                models: None,
                guardian_policy_config: None,
            }
        );
        Ok(())
    }

    #[test]
    fn merge_unset_fields_ignores_blank_guardian_override() {
        let mut target = ConfigRequirementsWithSources::default();
        target.merge_unset_fields(
            RequirementSource::LegacyManagedConfigTomlFromMdm,
            ConfigRequirementsToml {
                guardian_policy_config: Some("   \n\t".to_string()),
                ..Default::default()
            },
        );
        target.merge_unset_fields(
            RequirementSource::SystemRequirementsToml {
                file: system_requirements_toml_file_for_test()
                    .expect("system requirements.toml path"),
            },
            ConfigRequirementsToml {
                guardian_policy_config: Some("Use the system guardian policy.".to_string()),
                ..Default::default()
            },
        );

        assert_eq!(
            target.guardian_policy_config,
            Some(Sourced::new(
                "Use the system guardian policy.".to_string(),
                RequirementSource::SystemRequirementsToml {
                    file: system_requirements_toml_file_for_test()
                        .expect("system requirements.toml path"),
                },
            )),
        );
    }

    #[test]
    fn deserialize_guardian_policy_config() -> Result<()> {
        let requirements: ConfigRequirementsToml = from_str(
            r#"
guardian_policy_config = """
Use the cloud-managed guardian policy.
"""
"#,
        )?;

        assert_eq!(
            requirements.guardian_policy_config.as_deref(),
            Some("Use the cloud-managed guardian policy.\n")
        );
        Ok(())
    }

    #[test]
    fn blank_guardian_policy_config_is_empty() -> Result<()> {
        let requirements: ConfigRequirementsToml = from_str(
            r#"
guardian_policy_config = """

"""
"#,
        )?;

        assert!(requirements.is_empty());
        Ok(())
    }

    #[test]
    fn allowed_approvals_reviewers_is_not_empty() -> Result<()> {
        let requirements: ConfigRequirementsToml = from_str(
            r#"
allowed_approvals_reviewers = ["user"]
"#,
        )?;

        assert!(!requirements.is_empty());
        Ok(())
    }

    #[test]
    fn deserialize_filesystem_deny_read_requirements() -> Result<()> {
        let deny_read_0 = if cfg!(windows) {
            r"C:\Users\alice\.gitconfig"
        } else {
            "/home/alice/.gitconfig"
        };
        let deny_read_1 = if cfg!(windows) {
            r"C:\Users\alice\.ssh"
        } else {
            "/home/alice/.ssh"
        };
        let toml_str = format!(
            r#"
            [permissions.filesystem]
            deny_read = [{deny_read_0:?}, {deny_read_1:?}]
        "#
        );

        let config: ConfigRequirementsToml = from_str(&toml_str)?;
        let requirements: ConfigRequirements = with_unknown_source(config).try_into()?;

        assert_eq!(
            requirements.filesystem,
            Some(Sourced::new(
                FilesystemConstraints {
                    deny_read: vec![
                        AbsolutePathBuf::from_absolute_path(deny_read_0)?.into(),
                        AbsolutePathBuf::from_absolute_path(deny_read_1)?.into(),
                    ],
                },
                RequirementSource::Unknown,
            ))
        );

        Ok(())
    }

    #[test]
    fn deserialize_filesystem_deny_read_glob_requirements() -> Result<()> {
        let temp_dir = std::env::temp_dir();
        let _guard = AbsolutePathBufGuard::new(&temp_dir);
        let config: ConfigRequirementsToml = from_str(
            r#"
            [permissions.filesystem]
            deny_read = ["./private/**/*.txt"]
        "#,
        )?;
        let requirements: ConfigRequirements = with_unknown_source(config).try_into()?;

        assert_eq!(
            requirements.filesystem,
            Some(Sourced::new(
                FilesystemConstraints {
                    deny_read: vec![
                        FilesystemDenyReadPattern::from_input("./private/**/*.txt")
                            .expect("normalize glob pattern"),
                    ],
                },
                RequirementSource::Unknown,
            ))
        );
        Ok(())
    }

    #[test]
    fn deserialize_apps_requirements() -> Result<()> {
        let toml_str = r#"
            [apps.connector_123123]
            enabled = false
        "#;
        let requirements: ConfigRequirementsToml = from_str(toml_str)?;

        assert_eq!(
            requirements.apps,
            Some(AppsRequirementsToml {
                apps: BTreeMap::from([(
                    "connector_123123".to_string(),
                    AppRequirementToml {
                        enabled: Some(false),
                        tools: None,
                    },
                )]),
            })
        );
        Ok(())
    }

    #[test]
    fn deserialize_apps_tool_requirements() -> Result<()> {
        let toml_str = r#"
            [apps.connector_123123.tools."calendar/list_events"]
            approval_mode = "approve"
        "#;
        let requirements: ConfigRequirementsToml = from_str(toml_str)?;

        assert_eq!(
            requirements.apps,
            Some(AppsRequirementsToml {
                apps: BTreeMap::from([(
                    "connector_123123".to_string(),
                    AppRequirementToml {
                        enabled: None,
                        tools: Some(AppToolsRequirementsToml {
                            tools: BTreeMap::from([(
                                "calendar/list_events".to_string(),
                                AppToolRequirementToml {
                                    approval_mode: Some(AppToolApproval::Approve),
                                },
                            )]),
                        }),
                    },
                )]),
            })
        );
        Ok(())
    }

    fn apps_requirements(entries: &[(&str, Option<bool>)]) -> AppsRequirementsToml {
        AppsRequirementsToml {
            apps: entries
                .iter()
                .map(|(app_id, enabled)| {
                    (
                        (*app_id).to_string(),
                        AppRequirementToml {
                            enabled: *enabled,
                            tools: None,
                        },
                    )
                })
                .collect(),
        }
    }

    fn app_tool_requirements(
        app_id: &str,
        tool_name: &str,
        approval_mode: AppToolApproval,
    ) -> AppsRequirementsToml {
        AppsRequirementsToml {
            apps: BTreeMap::from([(
                app_id.to_string(),
                AppRequirementToml {
                    enabled: None,
                    tools: Some(AppToolsRequirementsToml {
                        tools: BTreeMap::from([(
                            tool_name.to_string(),
                            AppToolRequirementToml {
                                approval_mode: Some(approval_mode),
                            },
                        )]),
                    }),
                },
            )]),
        }
    }

    #[test]
    fn merge_app_requirements_descending_unions_distinct_apps() {
        let mut merged = apps_requirements(&[("connector_high", Some(false))]);
        let lower = apps_requirements(&[("connector_low", Some(true))]);

        merge_app_requirements_descending(&mut merged, lower);

        assert_eq!(
            merged,
            apps_requirements(&[
                ("connector_high", Some(false)),
                ("connector_low", Some(true))
            ]),
        );
    }

    #[test]
    fn merge_app_requirements_descending_prefers_false_from_lower_precedence() {
        let mut merged = apps_requirements(&[("connector_123123", Some(true))]);
        let lower = apps_requirements(&[("connector_123123", Some(false))]);

        merge_app_requirements_descending(&mut merged, lower);

        assert_eq!(
            merged,
            apps_requirements(&[("connector_123123", Some(false))]),
        );
    }

    #[test]
    fn merge_app_requirements_descending_keeps_higher_true_when_lower_is_unset() {
        let mut merged = apps_requirements(&[("connector_123123", Some(true))]);
        let lower = apps_requirements(&[("connector_123123", None)]);

        merge_app_requirements_descending(&mut merged, lower);

        assert_eq!(
            merged,
            apps_requirements(&[("connector_123123", Some(true))]),
        );
    }

    #[test]
    fn merge_app_requirements_descending_uses_lower_value_when_higher_missing() {
        let mut merged = apps_requirements(&[]);
        let lower = apps_requirements(&[("connector_123123", Some(true))]);

        merge_app_requirements_descending(&mut merged, lower);

        assert_eq!(
            merged,
            apps_requirements(&[("connector_123123", Some(true))]),
        );
    }

    #[test]
    fn merge_app_requirements_descending_preserves_higher_false_when_lower_missing_app() {
        let mut merged = apps_requirements(&[("connector_123123", Some(false))]);
        let lower = apps_requirements(&[]);

        merge_app_requirements_descending(&mut merged, lower);

        assert_eq!(
            merged,
            apps_requirements(&[("connector_123123", Some(false))]),
        );
    }

    #[test]
    fn merge_app_requirements_descending_preserves_higher_tool_approval_mode() {
        let mut merged = app_tool_requirements(
            "connector_123123",
            "calendar/list_events",
            AppToolApproval::Approve,
        );
        let lower = app_tool_requirements(
            "connector_123123",
            "calendar/list_events",
            AppToolApproval::Prompt,
        );

        merge_app_requirements_descending(&mut merged, lower);

        assert_eq!(
            merged,
            app_tool_requirements(
                "connector_123123",
                "calendar/list_events",
                AppToolApproval::Approve,
            )
        );
    }

    #[test]
    fn merge_app_requirements_descending_uses_lower_tool_approval_when_higher_missing() {
        let mut merged = apps_requirements(&[("connector_123123", None)]);
        let lower = app_tool_requirements(
            "connector_123123",
            "calendar/list_events",
            AppToolApproval::Approve,
        );

        merge_app_requirements_descending(&mut merged, lower);

        assert_eq!(
            merged,
            app_tool_requirements(
                "connector_123123",
                "calendar/list_events",
                AppToolApproval::Approve,
            )
        );
    }

    #[test]
    fn merge_unset_fields_merges_apps_across_sources_with_enabled_evaluation() {
        let higher_source = RequirementSource::LegacyManagedConfigTomlFromMdm;
        let lower_source = RequirementSource::MdmManagedPreferences {
            domain: "com.openai.codex".to_string(),
            key: "requirements_toml_base64".to_string(),
        };
        let mut target = ConfigRequirementsWithSources::default();

        target.merge_unset_fields(
            higher_source.clone(),
            ConfigRequirementsToml {
                apps: Some(apps_requirements(&[
                    ("connector_high", Some(true)),
                    ("connector_shared", Some(true)),
                ])),
                ..Default::default()
            },
        );
        target.merge_unset_fields(
            lower_source,
            ConfigRequirementsToml {
                apps: Some(apps_requirements(&[
                    ("connector_low", Some(false)),
                    ("connector_shared", Some(false)),
                ])),
                ..Default::default()
            },
        );

        let apps = target.apps.expect("apps should be present");
        assert_eq!(
            apps.value,
            apps_requirements(&[
                ("connector_high", Some(true)),
                ("connector_low", Some(false)),
                ("connector_shared", Some(false)),
            ])
        );
        assert_eq!(apps.source, higher_source);
    }

    #[test]
    fn merge_unset_fields_apps_empty_higher_source_does_not_block_lower_disables() {
        let mut target = ConfigRequirementsWithSources::default();

        target.merge_unset_fields(
            RequirementSource::LegacyManagedConfigTomlFromMdm,
            ConfigRequirementsToml {
                apps: Some(apps_requirements(&[])),
                ..Default::default()
            },
        );
        target.merge_unset_fields(
            RequirementSource::LegacyManagedConfigTomlFromMdm,
            ConfigRequirementsToml {
                apps: Some(apps_requirements(&[("connector_123123", Some(false))])),
                ..Default::default()
            },
        );

        assert_eq!(
            target.apps.map(|apps| apps.value),
            Some(apps_requirements(&[("connector_123123", Some(false))])),
        );
    }

    #[test]
    fn constraint_error_includes_requirement_source() -> Result<()> {
        let source: ConfigRequirementsToml = from_str(
            r#"
                allowed_approval_policies = ["on-request"]
                allowed_approvals_reviewers = ["auto_review"]
                allowed_sandbox_modes = ["read-only"]
            "#,
        )?;

        let requirements_toml_file = system_requirements_toml_file_for_test()?;
        let source_location = RequirementSource::SystemRequirementsToml {
            file: requirements_toml_file,
        };

        let mut target = ConfigRequirementsWithSources::default();
        target.merge_unset_fields(source_location.clone(), source);
        let requirements = ConfigRequirements::try_from(target)?;

        assert_eq!(
            requirements.approval_policy.can_set(&AskForApproval::Never),
            Err(ConstraintError::InvalidValue {
                field_name: "approval_policy",
                candidate: "Never".into(),
                allowed: "[OnRequest]".into(),
                requirement_source: source_location.clone(),
            })
        );
        assert_eq!(
            requirements
                .permission_profile
                .can_set(&PermissionProfile::Disabled),
            Err(ConstraintError::InvalidValue {
                field_name: "sandbox_mode",
                candidate: "DangerFullAccess".into(),
                allowed: "[ReadOnly]".into(),
                requirement_source: source_location.clone(),
            })
        );
        assert_eq!(
            requirements
                .approvals_reviewer
                .can_set(&ApprovalsReviewer::User),
            Err(ConstraintError::InvalidValue {
                field_name: "approvals_reviewer",
                candidate: "User".into(),
                allowed: "[AutoReview]".into(),
                requirement_source: source_location,
            })
        );

        Ok(())
    }

    #[test]
    fn constraint_error_includes_composite_requirement_source() -> Result<()> {
        let source: ConfigRequirementsToml = from_str(
            r#"
                allowed_approval_policies = ["on-request"]
            "#,
        )?;

        let source_location = RequirementSource::composite([
            RequirementSource::MdmManagedPreferences {
                domain: "com.openai.codex".to_string(),
                key: "requirements_toml_base64".to_string(),
            },
            RequirementSource::LegacyManagedConfigTomlFromMdm,
        ]);

        let mut target = ConfigRequirementsWithSources::default();
        target.merge_unset_fields(source_location.clone(), source);
        let requirements = ConfigRequirements::try_from(target)?;

        assert_eq!(
            requirements.approval_policy.can_set(&AskForApproval::Never),
            Err(ConstraintError::InvalidValue {
                field_name: "approval_policy",
                candidate: "Never".into(),
                allowed: "[OnRequest]".into(),
                requirement_source: source_location,
            })
        );

        Ok(())
    }

    #[test]
    fn constrained_fields_store_requirement_source() -> Result<()> {
        let source: ConfigRequirementsToml = from_str(
            r#"
                allowed_approval_policies = ["on-request"]
                allowed_approvals_reviewers = ["auto_review"]
                allowed_sandbox_modes = ["read-only"]
                allowed_web_search_modes = ["cached"]
                enforce_residency = "us"
                [features]
                personality = true
            "#,
        )?;

        let source_location = RequirementSource::LegacyManagedConfigTomlFromMdm;
        let mut target = ConfigRequirementsWithSources::default();
        target.merge_unset_fields(source_location.clone(), source);
        let requirements = ConfigRequirements::try_from(target)?;

        assert_eq!(
            requirements.approval_policy.source,
            Some(source_location.clone())
        );
        assert_eq!(
            requirements.approvals_reviewer.source,
            Some(source_location.clone())
        );
        assert_eq!(
            requirements.permission_profile.source,
            Some(source_location.clone())
        );
        assert_eq!(
            requirements.web_search_mode.source,
            Some(source_location.clone())
        );
        assert_eq!(
            requirements
                .feature_requirements
                .as_ref()
                .map(|requirements| requirements.source.clone()),
            Some(source_location.clone())
        );
        assert_eq!(requirements.enforce_residency.source, Some(source_location));

        Ok(())
    }

    #[test]
    fn deserialize_allowed_approval_policies() -> Result<()> {
        let toml_str = r#"
            allowed_approval_policies = ["untrusted", "on-request"]
        "#;
        let config: ConfigRequirementsToml = from_str(toml_str)?;
        let requirements: ConfigRequirements = with_unknown_source(config).try_into()?;

        assert_eq!(
            requirements.approval_policy.value(),
            AskForApproval::UnlessTrusted,
            "currently, there is no way to specify the default value for approval policy in the toml, so it picks the first allowed value"
        );
        assert!(
            requirements
                .approval_policy
                .can_set(&AskForApproval::UnlessTrusted)
                .is_ok()
        );
        assert!(
            requirements
                .approval_policy
                .can_set(&AskForApproval::OnRequest)
                .is_ok()
        );
        assert_eq!(
            requirements.approval_policy.can_set(&AskForApproval::Never),
            Err(ConstraintError::InvalidValue {
                field_name: "approval_policy",
                candidate: "Never".into(),
                allowed: "[UnlessTrusted, OnRequest]".into(),
                requirement_source: RequirementSource::Unknown,
            })
        );
        assert!(
            requirements
                .permission_profile
                .can_set(&PermissionProfile::read_only())
                .is_ok()
        );

        Ok(())
    }

    #[test]
    fn deserialize_allowed_approvals_reviewers() -> Result<()> {
        let toml_str = r#"
            allowed_approvals_reviewers = ["auto_review", "user"]
        "#;
        let config: ConfigRequirementsToml = from_str(toml_str)?;
        let requirements: ConfigRequirements = with_unknown_source(config).try_into()?;

        assert_eq!(
            requirements.approvals_reviewer.value(),
            ApprovalsReviewer::AutoReview,
            "currently, there is no way to specify the default value for approvals reviewer in the toml, so it picks the first allowed value"
        );
        assert!(
            requirements
                .approvals_reviewer
                .can_set(&ApprovalsReviewer::AutoReview)
                .is_ok()
        );
        assert!(
            requirements
                .approvals_reviewer
                .can_set(&ApprovalsReviewer::User)
                .is_ok()
        );

        Ok(())
    }

    #[test]
    fn deserialize_allowed_windows_sandbox_implementations() -> Result<()> {
        let toml_str = r#"
            [windows]
            allowed_sandbox_implementations = ["elevated"]
        "#;
        let config: ConfigRequirementsToml = from_str(toml_str)?;
        let requirements: ConfigRequirements = with_unknown_source(config).try_into()?;

        assert_eq!(
            requirements.windows_sandbox_mode.value(),
            Some(WindowsSandboxModeToml::Elevated)
        );
        assert!(
            requirements
                .windows_sandbox_mode
                .can_set(&Some(WindowsSandboxModeToml::Elevated))
                .is_ok()
        );
        assert!(
            requirements
                .windows_sandbox_mode
                .can_set(&Some(WindowsSandboxModeToml::Unelevated))
                .is_err()
        );
        assert!(requirements.windows_sandbox_mode.can_set(&None).is_err());

        Ok(())
    }

    #[test]
    fn empty_allowed_windows_sandbox_implementations_is_rejected() -> Result<()> {
        let toml_str = r#"
            [windows]
            allowed_sandbox_implementations = []
        "#;
        let config: ConfigRequirementsToml = from_str(toml_str)?;

        assert_eq!(
            ConfigRequirements::try_from(with_unknown_source(config)),
            Err(ConstraintError::EmptyField {
                field_name: "windows.allowed_sandbox_implementations".to_string(),
            })
        );

        Ok(())
    }

    #[test]
    fn allowed_windows_sandbox_implementations_prefer_elevated_fallback() -> Result<()> {
        let toml_str = r#"
            [windows]
            allowed_sandbox_implementations = ["unelevated", "elevated"]
        "#;
        let config: ConfigRequirementsToml = from_str(toml_str)?;
        let requirements: ConfigRequirements = with_unknown_source(config).try_into()?;

        assert_eq!(
            requirements.windows_sandbox_mode.value(),
            Some(WindowsSandboxModeToml::Elevated)
        );

        Ok(())
    }

    #[test]
    fn deserialize_legacy_allowed_approvals_reviewer() -> Result<()> {
        let toml_str = r#"
            allowed_approvals_reviewers = ["guardian_subagent", "user"]
        "#;
        let config: ConfigRequirementsToml = from_str(toml_str)?;
        let requirements: ConfigRequirements = with_unknown_source(config).try_into()?;

        assert_eq!(
            requirements.approvals_reviewer.value(),
            ApprovalsReviewer::AutoReview
        );

        Ok(())
    }

    #[test]
    fn empty_allowed_approvals_reviewers_is_rejected() -> Result<()> {
        let toml_str = r#"
            allowed_approvals_reviewers = []
        "#;
        let config: ConfigRequirementsToml = from_str(toml_str)?;
        let err = ConfigRequirements::try_from(with_unknown_source(config))
            .expect_err("empty approvals reviewer allow-list should be rejected");

        assert_eq!(
            err,
            ConstraintError::EmptyField {
                field_name: "allowed_approvals_reviewers".to_string(),
            }
        );

        Ok(())
    }

    #[test]
    fn deserialize_allowed_sandbox_modes() -> Result<()> {
        let toml_str = r#"
            allowed_sandbox_modes = ["read-only", "workspace-write"]
        "#;
        let config: ConfigRequirementsToml = from_str(toml_str)?;
        let requirements: ConfigRequirements = with_unknown_source(config).try_into()?;

        let root = if cfg!(windows) { "C:\\repo" } else { "/repo" };
        assert!(
            requirements
                .permission_profile
                .can_set(&PermissionProfile::read_only())
                .is_ok()
        );
        let workspace_write_profile = PermissionProfile::workspace_write_with(
            &[AbsolutePathBuf::from_absolute_path(root)?],
            NetworkSandboxPolicy::Restricted,
            /*exclude_tmpdir_env_var*/ false,
            /*exclude_slash_tmp*/ false,
        );
        assert!(
            requirements
                .permission_profile
                .can_set(&workspace_write_profile)
                .is_ok()
        );
        assert_eq!(
            requirements
                .permission_profile
                .can_set(&PermissionProfile::Disabled),
            Err(ConstraintError::InvalidValue {
                field_name: "sandbox_mode",
                candidate: "DangerFullAccess".into(),
                allowed: "[ReadOnly, WorkspaceWrite]".into(),
                requirement_source: RequirementSource::Unknown,
            })
        );
        assert_eq!(
            requirements
                .permission_profile
                .can_set(&PermissionProfile::External {
                    network: NetworkSandboxPolicy::Restricted,
                }),
            Err(ConstraintError::InvalidValue {
                field_name: "sandbox_mode",
                candidate: "ExternalSandbox".into(),
                allowed: "[ReadOnly, WorkspaceWrite]".into(),
                requirement_source: RequirementSource::Unknown,
            })
        );

        Ok(())
    }

    #[test]
    fn deserialize_remote_sandbox_config_requires_hostname_patterns_list() -> Result<()> {
        let toml_str = r#"
            [[remote_sandbox_config]]
            hostname_patterns = ["*.org", "runner-??.ci"]
            allowed_sandbox_modes = ["read-only", "workspace-write"]
        "#;
        let config: ConfigRequirementsToml = from_str(toml_str)?;

        assert_eq!(
            config.remote_sandbox_config,
            Some(vec![RemoteSandboxConfigToml {
                hostname_patterns: vec!["*.org".to_string(), "runner-??.ci".to_string()],
                allowed_sandbox_modes: vec![
                    SandboxModeRequirement::ReadOnly,
                    SandboxModeRequirement::WorkspaceWrite,
                ],
            }])
        );

        let err = from_str::<ConfigRequirementsToml>(
            r#"
                [[remote_sandbox_config]]
                hostname_patterns = "*.org"
                allowed_sandbox_modes = ["read-only"]
            "#,
        )
        .expect_err("hostname_patterns should be list-only");
        assert!(
            err.to_string().contains("invalid type: string"),
            "unexpected error: {err}"
        );

        Ok(())
    }

    #[test]
    fn remote_sandbox_config_first_match_overrides_top_level() -> Result<()> {
        let source = RequirementSource::LegacyManagedConfigTomlFromMdm;
        let mut requirements_toml: ConfigRequirementsToml = from_str(
            r#"
                allowed_sandbox_modes = ["read-only"]

                [[remote_sandbox_config]]
                hostname_patterns = ["build-*.example.com"]
                allowed_sandbox_modes = ["read-only", "workspace-write"]

                [[remote_sandbox_config]]
                hostname_patterns = ["build-01.example.com"]
                allowed_sandbox_modes = ["read-only", "danger-full-access"]
            "#,
        )?;
        requirements_toml.apply_remote_sandbox_config(Some("BUILD-01.EXAMPLE.COM."));
        let mut requirements_with_sources = ConfigRequirementsWithSources::default();
        requirements_with_sources.merge_unset_fields(source.clone(), requirements_toml);

        assert_eq!(
            requirements_with_sources
                .allowed_sandbox_modes
                .as_ref()
                .map(|sourced| sourced.value.clone()),
            Some(vec![
                SandboxModeRequirement::ReadOnly,
                SandboxModeRequirement::WorkspaceWrite,
            ])
        );

        let requirements = ConfigRequirements::try_from(requirements_with_sources)?;
        let root = if cfg!(windows) { "C:\\repo" } else { "/repo" };
        let workspace_write_profile = PermissionProfile::workspace_write_with(
            &[AbsolutePathBuf::from_absolute_path(root)?],
            NetworkSandboxPolicy::Restricted,
            /*exclude_tmpdir_env_var*/ false,
            /*exclude_slash_tmp*/ false,
        );
        assert!(
            requirements
                .permission_profile
                .can_set(&workspace_write_profile)
                .is_ok()
        );
        assert_eq!(
            requirements
                .permission_profile
                .can_set(&PermissionProfile::Disabled),
            Err(ConstraintError::InvalidValue {
                field_name: "sandbox_mode",
                candidate: "DangerFullAccess".into(),
                allowed: "[ReadOnly, WorkspaceWrite]".into(),
                requirement_source: source,
            })
        );

        Ok(())
    }

    #[test]
    fn remote_sandbox_config_non_match_preserves_top_level() -> Result<()> {
        let mut requirements_toml: ConfigRequirementsToml = from_str(
            r#"
                allowed_sandbox_modes = ["read-only"]

                [[remote_sandbox_config]]
                hostname_patterns = ["build-*.example.com"]
                allowed_sandbox_modes = ["read-only", "workspace-write"]
            "#,
        )?;
        requirements_toml.apply_remote_sandbox_config(Some("laptop.example.com"));
        let mut requirements_with_sources = ConfigRequirementsWithSources::default();
        requirements_with_sources.merge_unset_fields(RequirementSource::Unknown, requirements_toml);
        let requirements = ConfigRequirements::try_from(requirements_with_sources)?;

        assert_eq!(
            requirements
                .permission_profile
                .can_set(&PermissionProfile::Disabled),
            Err(ConstraintError::InvalidValue {
                field_name: "sandbox_mode",
                candidate: "DangerFullAccess".into(),
                allowed: "[ReadOnly]".into(),
                requirement_source: RequirementSource::Unknown,
            })
        );

        Ok(())
    }

    #[test]
    fn remote_sandbox_config_does_not_override_higher_precedence_sandbox_modes() -> Result<()> {
        let high_source = RequirementSource::LegacyManagedConfigTomlFromMdm;
        let mut high_precedence: ConfigRequirementsToml = from_str(
            r#"
                allowed_sandbox_modes = ["read-only"]
            "#,
        )?;
        high_precedence.apply_remote_sandbox_config(Some("runner-01.ci.example.com"));

        let mut low_precedence: ConfigRequirementsToml = from_str(
            r#"
                [[remote_sandbox_config]]
                hostname_patterns = ["runner-*.ci.example.com"]
                allowed_sandbox_modes = ["read-only", "workspace-write"]
            "#,
        )?;
        low_precedence.apply_remote_sandbox_config(Some("runner-01.ci.example.com"));

        let mut requirements_with_sources = ConfigRequirementsWithSources::default();
        requirements_with_sources.merge_unset_fields(high_source.clone(), high_precedence);
        requirements_with_sources.merge_unset_fields(RequirementSource::Unknown, low_precedence);
        let requirements = ConfigRequirements::try_from(requirements_with_sources)?;

        assert_eq!(
            requirements
                .permission_profile
                .can_set(&PermissionProfile::workspace_write()),
            Err(ConstraintError::InvalidValue {
                field_name: "sandbox_mode",
                candidate: "WorkspaceWrite".into(),
                allowed: "[ReadOnly]".into(),
                requirement_source: high_source,
            })
        );

        Ok(())
    }

    #[test]
    fn deserialize_allowed_web_search_modes() -> Result<()> {
        let toml_str = r#"
            allowed_web_search_modes = ["cached"]
        "#;
        let config: ConfigRequirementsToml = from_str(toml_str)?;
        let requirements: ConfigRequirements = with_unknown_source(config).try_into()?;

        assert_eq!(requirements.web_search_mode.value(), WebSearchMode::Cached);
        assert!(
            requirements
                .web_search_mode
                .can_set(&WebSearchMode::Disabled)
                .is_ok()
        );
        assert_eq!(
            requirements.web_search_mode.can_set(&WebSearchMode::Live),
            Err(ConstraintError::InvalidValue {
                field_name: "web_search_mode",
                candidate: "Live".into(),
                allowed: "[Disabled, Cached]".into(),
                requirement_source: RequirementSource::Unknown,
            })
        );
        assert!(
            requirements
                .web_search_mode
                .can_set(&WebSearchMode::Cached)
                .is_ok()
        );

        Ok(())
    }

    #[test]
    fn allowed_web_search_modes_supports_indexed() -> Result<()> {
        let config: ConfigRequirementsToml = from_str(
            r#"
                allowed_web_search_modes = ["indexed"]
            "#,
        )?;
        let requirements: ConfigRequirements = with_unknown_source(config).try_into()?;

        assert_eq!(requirements.web_search_mode.value(), WebSearchMode::Indexed);
        for mode in [WebSearchMode::Disabled, WebSearchMode::Indexed] {
            assert!(requirements.web_search_mode.can_set(&mode).is_ok());
        }
        for mode in [WebSearchMode::Cached, WebSearchMode::Live] {
            assert_eq!(
                requirements.web_search_mode.can_set(&mode),
                Err(ConstraintError::InvalidValue {
                    field_name: "web_search_mode",
                    candidate: format!("{mode:?}"),
                    allowed: "[Disabled, Indexed]".into(),
                    requirement_source: RequirementSource::Unknown,
                })
            );
        }

        Ok(())
    }

    #[test]
    fn allowed_web_search_modes_allows_disabled() -> Result<()> {
        let toml_str = r#"
            allowed_web_search_modes = ["disabled"]
        "#;
        let config: ConfigRequirementsToml = from_str(toml_str)?;
        let requirements: ConfigRequirements = with_unknown_source(config).try_into()?;

        assert_eq!(
            requirements.web_search_mode.value(),
            WebSearchMode::Disabled
        );
        assert!(
            requirements
                .web_search_mode
                .can_set(&WebSearchMode::Disabled)
                .is_ok()
        );
        assert_eq!(
            requirements.web_search_mode.can_set(&WebSearchMode::Cached),
            Err(ConstraintError::InvalidValue {
                field_name: "web_search_mode",
                candidate: "Cached".into(),
                allowed: "[Disabled]".into(),
                requirement_source: RequirementSource::Unknown,
            })
        );
        Ok(())
    }

    #[test]
    fn allowed_web_search_modes_empty_restricts_to_disabled() -> Result<()> {
        let toml_str = r#"
            allowed_web_search_modes = []
        "#;
        let config: ConfigRequirementsToml = from_str(toml_str)?;
        let requirements: ConfigRequirements = with_unknown_source(config).try_into()?;

        assert_eq!(
            requirements.web_search_mode.value(),
            WebSearchMode::Disabled
        );
        assert!(
            requirements
                .web_search_mode
                .can_set(&WebSearchMode::Disabled)
                .is_ok()
        );
        assert_eq!(
            requirements.web_search_mode.can_set(&WebSearchMode::Cached),
            Err(ConstraintError::InvalidValue {
                field_name: "web_search_mode",
                candidate: "Cached".into(),
                allowed: "[Disabled]".into(),
                requirement_source: RequirementSource::Unknown,
            })
        );
        Ok(())
    }

    #[test]
    fn deserialize_feature_requirements() -> Result<()> {
        let toml_str = r#"
            [features]
            apps = false
            personality = true
        "#;
        let config: ConfigRequirementsToml = from_str(toml_str)?;
        let requirements: ConfigRequirements = with_unknown_source(config).try_into()?;

        assert_eq!(
            requirements.feature_requirements,
            Some(Sourced::new(
                FeatureRequirementsToml {
                    entries: BTreeMap::from([
                        ("apps".to_string(), false),
                        ("personality".to_string(), true),
                    ]),
                },
                RequirementSource::Unknown,
            ))
        );

        Ok(())
    }

    #[test]
    fn deserialize_managed_hooks_requirements() -> Result<()> {
        let toml_str = r#"
managed_dir = "/enterprise/hooks"
windows_managed_dir = 'C:\enterprise\hooks'

[[PreToolUse]]
matcher = "^Bash$"

[[PreToolUse.hooks]]
type = "command"
command = "python3 /enterprise/hooks/pre.py"
timeout = 10
statusMessage = "checking"
        "#;
        let hooks: ManagedHooksRequirementsToml = from_str(toml_str)?;

        assert_eq!(
            hooks.managed_dir.as_deref(),
            Some(std::path::Path::new("/enterprise/hooks"))
        );
        assert_eq!(hooks.handler_count(), 1);
        assert_eq!(hooks.hooks.pre_tool_use.len(), 1);
        Ok(())
    }

    #[test]
    fn merge_unset_fields_does_not_overwrite_existing_hooks() -> Result<()> {
        let mut target = ConfigRequirementsWithSources::default();
        target.merge_unset_fields(
            RequirementSource::LegacyManagedConfigTomlFromMdm,
            from_str::<ConfigRequirementsToml>(
                r#"
[hooks]
managed_dir = "/cloud/hooks"

[[hooks.PreToolUse]]
matcher = "^Bash$"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "python3 /cloud/hooks/pre.py"
                "#,
            )?,
        );
        target.merge_unset_fields(
            RequirementSource::SystemRequirementsToml {
                file: system_requirements_toml_file_for_test()?,
            },
            from_str::<ConfigRequirementsToml>(
                r#"
[hooks]
managed_dir = "/system/hooks"

[[hooks.PreToolUse]]
matcher = "^Bash$"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "python3 /system/hooks/pre.py"
                "#,
            )?,
        );

        assert_eq!(
            target
                .hooks
                .as_ref()
                .and_then(|hooks| hooks.value.managed_dir.as_ref())
                .map(std::path::PathBuf::as_path),
            Some(std::path::Path::new("/cloud/hooks"))
        );
        assert_eq!(
            target.hooks.as_ref().map(|hooks| hooks.source.clone()),
            Some(RequirementSource::LegacyManagedConfigTomlFromMdm)
        );
        Ok(())
    }

    #[test]
    fn managed_hooks_constraint_rejects_drift() -> Result<()> {
        let config: ConfigRequirementsToml = from_str(
            r#"
[hooks]
managed_dir = "/enterprise/hooks"

[[hooks.PreToolUse]]
matcher = "^Bash$"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "python3 /enterprise/hooks/pre.py"
            "#,
        )?;
        let requirements: ConfigRequirements = with_unknown_source(config).try_into()?;
        let mut managed_hooks = requirements
            .managed_hooks
            .expect("expected managed hooks requirements");

        let err = managed_hooks
            .set(ManagedHooksRequirementsToml {
                managed_dir: Some(std::path::PathBuf::from("/other/hooks")),
                windows_managed_dir: None,
                hooks: HookEventsToml::default(),
            })
            .expect_err("managed hooks should reject drift");

        assert!(matches!(
            err,
            ConstraintError::InvalidValue {
                field_name: "hooks",
                requirement_source: RequirementSource::Unknown,
                ..
            }
        ));
        Ok(())
    }

    #[test]
    fn network_requirements_are_preserved_as_constraints_with_source() -> Result<()> {
        let toml_str = r#"
            [experimental_network]
            enabled = true
            allow_upstream_proxy = false
            dangerously_allow_all_unix_sockets = true
            managed_allowed_domains_only = true
            allow_local_binding = false

            [experimental_network.domains]
            "api.example.com" = "allow"
            "*.openai.com" = "allow"
            "blocked.example.com" = "deny"

            [experimental_network.unix_sockets]
            "/tmp/example.sock" = "allow"
            "/tmp/blocked.sock" = "deny"
        "#;

        let source = RequirementSource::LegacyManagedConfigTomlFromMdm;
        let mut requirements_with_sources = ConfigRequirementsWithSources::default();
        requirements_with_sources.merge_unset_fields(source.clone(), from_str(toml_str)?);

        let requirements = ConfigRequirements::try_from(requirements_with_sources)?;
        let sourced_network = requirements
            .network
            .expect("network requirements should be preserved as constraints");

        assert_eq!(sourced_network.source, source);
        assert_eq!(sourced_network.value.enabled, Some(true));
        assert_eq!(sourced_network.value.allow_upstream_proxy, Some(false));
        assert_eq!(
            sourced_network.value.dangerously_allow_all_unix_sockets,
            Some(true)
        );
        assert_eq!(
            sourced_network.value.domains.as_ref(),
            Some(&NetworkDomainPermissionsToml {
                entries: BTreeMap::from([
                    (
                        "*.openai.com".to_string(),
                        NetworkDomainPermissionToml::Allow,
                    ),
                    (
                        "api.example.com".to_string(),
                        NetworkDomainPermissionToml::Allow,
                    ),
                    (
                        "blocked.example.com".to_string(),
                        NetworkDomainPermissionToml::Deny,
                    ),
                ]),
            })
        );
        assert_eq!(
            sourced_network.value.managed_allowed_domains_only,
            Some(true)
        );
        assert_eq!(
            sourced_network.value.unix_sockets.as_ref(),
            Some(&NetworkUnixSocketPermissionsToml {
                entries: BTreeMap::from([
                    (
                        "/tmp/blocked.sock".to_string(),
                        NetworkUnixSocketPermissionToml::Deny,
                    ),
                    (
                        "/tmp/example.sock".to_string(),
                        NetworkUnixSocketPermissionToml::Allow,
                    ),
                ]),
            })
        );
        assert_eq!(sourced_network.value.allow_local_binding, Some(false));

        Ok(())
    }

    #[test]
    fn legacy_network_requirements_are_preserved_as_constraints_with_source() -> Result<()> {
        let toml_str = r#"
            [experimental_network]
            enabled = true
            allow_upstream_proxy = false
            dangerously_allow_all_unix_sockets = true
            allowed_domains = ["api.example.com", "*.openai.com"]
            managed_allowed_domains_only = true
            denied_domains = ["blocked.example.com"]
            allow_unix_sockets = ["/tmp/example.sock"]
            allow_local_binding = false
        "#;

        let source = RequirementSource::LegacyManagedConfigTomlFromMdm;
        let mut requirements_with_sources = ConfigRequirementsWithSources::default();
        requirements_with_sources.merge_unset_fields(source.clone(), from_str(toml_str)?);

        let requirements = ConfigRequirements::try_from(requirements_with_sources)?;
        let sourced_network = requirements
            .network
            .expect("network requirements should be preserved as constraints");

        assert_eq!(sourced_network.source, source);
        assert_eq!(sourced_network.value.enabled, Some(true));
        assert_eq!(sourced_network.value.allow_upstream_proxy, Some(false));
        assert_eq!(
            sourced_network.value.dangerously_allow_all_unix_sockets,
            Some(true)
        );
        assert_eq!(
            sourced_network.value.domains.as_ref(),
            Some(&NetworkDomainPermissionsToml {
                entries: BTreeMap::from([
                    (
                        "*.openai.com".to_string(),
                        NetworkDomainPermissionToml::Allow,
                    ),
                    (
                        "api.example.com".to_string(),
                        NetworkDomainPermissionToml::Allow,
                    ),
                    (
                        "blocked.example.com".to_string(),
                        NetworkDomainPermissionToml::Deny,
                    ),
                ]),
            })
        );
        assert_eq!(
            sourced_network.value.managed_allowed_domains_only,
            Some(true)
        );
        assert_eq!(
            sourced_network.value.unix_sockets.as_ref(),
            Some(&NetworkUnixSocketPermissionsToml {
                entries: BTreeMap::from([(
                    "/tmp/example.sock".to_string(),
                    NetworkUnixSocketPermissionToml::Allow,
                )]),
            })
        );
        assert_eq!(sourced_network.value.allow_local_binding, Some(false));

        Ok(())
    }

    #[test]
    fn mixed_legacy_and_canonical_network_requirements_are_rejected() {
        let err = from_str::<ConfigRequirementsToml>(
            r#"
                [experimental_network]
                allowed_domains = ["api.example.com"]

                [experimental_network.domains]
                "*.openai.com" = "allow"
            "#,
        )
        .expect_err("mixed network domain shapes should fail");

        assert!(
            err.to_string()
                .contains("`experimental_network.domains` cannot be combined"),
            "unexpected error: {err:#}"
        );

        let err = from_str::<ConfigRequirementsToml>(
            r#"
                [experimental_network]
                allow_unix_sockets = ["/tmp/example.sock"]

                [experimental_network.unix_sockets]
                "/tmp/another.sock" = "allow"
            "#,
        )
        .expect_err("mixed network unix socket shapes should fail");

        assert!(
            err.to_string()
                .contains("`experimental_network.unix_sockets` cannot be combined"),
            "unexpected error: {err:#}"
        );
    }

    #[test]
    fn network_permission_containers_project_allowed_and_denied_entries() {
        let domains = NetworkDomainPermissionsToml {
            entries: BTreeMap::from([
                (
                    "*.openai.com".to_string(),
                    NetworkDomainPermissionToml::Allow,
                ),
                (
                    "api.example.com".to_string(),
                    NetworkDomainPermissionToml::Allow,
                ),
                (
                    "blocked.example.com".to_string(),
                    NetworkDomainPermissionToml::Deny,
                ),
            ]),
        };
        let unix_sockets = NetworkUnixSocketPermissionsToml {
            entries: BTreeMap::from([
                (
                    "/tmp/example.sock".to_string(),
                    NetworkUnixSocketPermissionToml::Allow,
                ),
                (
                    "/tmp/ignored.sock".to_string(),
                    NetworkUnixSocketPermissionToml::Deny,
                ),
            ]),
        };

        assert_eq!(
            domains.allowed_domains(),
            Some(vec![
                "*.openai.com".to_string(),
                "api.example.com".to_string()
            ])
        );
        assert_eq!(
            domains.denied_domains(),
            Some(vec!["blocked.example.com".to_string()])
        );
        assert_eq!(
            NetworkDomainPermissionsToml {
                entries: BTreeMap::from([(
                    "api.example.com".to_string(),
                    NetworkDomainPermissionToml::Allow,
                )]),
            }
            .denied_domains(),
            None
        );
        assert_eq!(
            unix_sockets.allow_unix_sockets(),
            vec!["/tmp/example.sock".to_string()]
        );
    }

    #[test]
    fn deserialize_mcp_server_requirements() -> Result<()> {
        let toml_str = r#"
            [mcp_servers.docs]
            description = "ignored legacy field"

            [mcp_servers.docs.identity]
            command = "codex-mcp"

            [mcp_servers.remote.identity]
            url = "https://example.com/mcp"
        "#;
        let requirements: ConfigRequirements =
            with_unknown_source(from_str(toml_str)?).try_into()?;

        assert_eq!(
            requirements.mcp_servers,
            Some(Sourced::new(
                BTreeMap::from([
                    (
                        "docs".to_string(),
                        McpServerRequirement::Identity {
                            identity: McpServerIdentity::Command {
                                command: "codex-mcp".to_string(),
                            },
                        },
                    ),
                    (
                        "remote".to_string(),
                        McpServerRequirement::Identity {
                            identity: McpServerIdentity::Url {
                                url: "https://example.com/mcp".to_string(),
                            },
                        },
                    ),
                ]),
                RequirementSource::Unknown,
            ))
        );
        Ok(())
    }

    #[test]
    fn deserialize_mcp_server_matcher_requirements() -> Result<()> {
        let toml_str = r#"
            [mcp_servers.internal_mcp_proxy.identity]
            command = { executable = "company-cli", args = [
                { match = "exact", value = "mcp" },
                { match = "exact", value = "proxy" },
                { match = "exact", value = "--server" },
                { match = "regex", expression = '^https://[A-Za-z0-9-]+\.mcp\.internal\.example\.com(?::443)?(?:/.*)?$' },
            ] }
        "#;
        let requirements: ConfigRequirements =
            with_unknown_source(from_str(toml_str)?).try_into()?;

        assert_eq!(
            requirements.mcp_servers,
            Some(Sourced::new(
                BTreeMap::from([(
                    "internal_mcp_proxy".to_string(),
                    McpServerRequirement::Command(McpServerCommandMatcher {
                        executable: "company-cli".to_string(),
                        args: vec![
                            McpServerValueMatcher::Exact {
                                value: "mcp".to_string(),
                            },
                            McpServerValueMatcher::Exact {
                                value: "proxy".to_string(),
                            },
                            McpServerValueMatcher::Exact {
                                value: "--server".to_string(),
                            },
                            McpServerValueMatcher::Regex {
                                expression: r"^https://[A-Za-z0-9-]+\.mcp\.internal\.example\.com(?::443)?(?:/.*)?$"
                                    .to_string(),
                            },
                        ],
                    }),
                )]),
                RequirementSource::Unknown,
            ))
        );
        Ok(())
    }

    #[test]
    fn invalid_mcp_server_requirement_regex_reports_the_server_name_and_source() -> Result<()> {
        let toml_str = r#"
            [mcp_servers.broken_rule.identity]
            url = { match = "regex", expression = "[" }
        "#;

        let err = ConfigRequirements::try_from(with_unknown_source(from_str(toml_str)?))
            .expect_err("invalid matcher regex should fail requirements normalization");
        let ConstraintError::McpServerRequirementParse {
            server_name,
            requirement_source,
            reason,
        } = err
        else {
            panic!("unexpected error: {err:?}");
        };

        assert_eq!(server_name, "broken_rule");
        assert_eq!(requirement_source, RequirementSource::Unknown);
        assert!(reason.contains("invalid regex `[`"), "{reason}");
        Ok(())
    }

    #[test]
    fn deserialize_plugin_mcp_server_requirements() -> Result<()> {
        let toml_str = r#"
            [plugins."sample@test".mcp_servers.sample.identity]
            command = "sample-mcp"

            [plugins."remote@test".mcp_servers.remote.identity]
            url = "https://example.com/mcp"
        "#;
        let requirements: ConfigRequirements =
            with_unknown_source(from_str(toml_str)?).try_into()?;

        assert_eq!(
            requirements.plugins,
            Some(Sourced::new(
                BTreeMap::from([
                    (
                        "remote@test".to_string(),
                        PluginRequirementsToml {
                            mcp_servers: Some(BTreeMap::from([(
                                "remote".to_string(),
                                McpServerRequirement::Identity {
                                    identity: McpServerIdentity::Url {
                                        url: "https://example.com/mcp".to_string(),
                                    },
                                },
                            )])),
                        },
                    ),
                    (
                        "sample@test".to_string(),
                        PluginRequirementsToml {
                            mcp_servers: Some(BTreeMap::from([(
                                "sample".to_string(),
                                McpServerRequirement::Identity {
                                    identity: McpServerIdentity::Command {
                                        command: "sample-mcp".to_string(),
                                    },
                                },
                            )])),
                        },
                    ),
                ]),
                RequirementSource::Unknown,
            ))
        );
        Ok(())
    }

    #[test]
    fn deserialize_plugin_mcp_server_matcher_requirement() -> Result<()> {
        let toml_str = r#"
            [plugins."sample@test".mcp_servers.internal_proxy.identity]
            command = { executable = "company-cli", args = [
                { match = "exact", value = "mcp" },
                { match = "regex", expression = '^https://[a-z]+\.example\.com$' },
            ] }
        "#;
        let requirements: ConfigRequirements =
            with_unknown_source(from_str(toml_str)?).try_into()?;

        assert_eq!(
            requirements.plugins,
            Some(Sourced::new(
                BTreeMap::from([(
                    "sample@test".to_string(),
                    PluginRequirementsToml {
                        mcp_servers: Some(BTreeMap::from([(
                            "internal_proxy".to_string(),
                            McpServerRequirement::Command(McpServerCommandMatcher {
                                executable: "company-cli".to_string(),
                                args: vec![
                                    McpServerValueMatcher::Exact {
                                        value: "mcp".to_string(),
                                    },
                                    McpServerValueMatcher::Regex {
                                        expression: r"^https://[a-z]+\.example\.com$".to_string(),
                                    },
                                ],
                            }),
                        )])),
                    },
                )]),
                RequirementSource::Unknown,
            ))
        );
        Ok(())
    }

    #[test]
    fn invalid_plugin_mcp_server_regex_reports_plugin_and_server_name() -> Result<()> {
        let toml_str = r#"
            [plugins."sample@test".mcp_servers.broken_rule.identity]
            url = { match = "regex", expression = "[" }
        "#;

        let err = ConfigRequirements::try_from(with_unknown_source(from_str(toml_str)?))
            .expect_err("invalid plugin MCP regex should fail requirements normalization");
        let ConstraintError::McpServerRequirementParse {
            server_name,
            requirement_source,
            reason,
        } = err
        else {
            panic!("unexpected error: {err:?}");
        };

        assert_eq!(server_name, "sample@test/broken_rule");
        assert_eq!(requirement_source, RequirementSource::Unknown);
        assert!(reason.contains("invalid regex `[`"), "{reason}");
        Ok(())
    }

    #[test]
    fn deserialize_exec_policy_requirements() -> Result<()> {
        let toml_str = r#"
            [rules]
            prefix_rules = [
                { pattern = [{ token = "rm" }], decision = "forbidden" },
            ]
        "#;
        let config: ConfigRequirementsToml = from_str(toml_str)?;
        let requirements: ConfigRequirements = with_unknown_source(config).try_into()?;
        let policy = requirements.exec_policy.expect("exec policy").value;

        assert_eq!(
            policy.as_ref().check(&tokens(&["rm", "-rf"]), &|_| {
                panic!("rule should match so heuristic should not be called");
            }),
            Evaluation {
                decision: Decision::Forbidden,
                matched_rules: vec![RuleMatch::PrefixRuleMatch {
                    matched_prefix: tokens(&["rm"]),
                    decision: Decision::Forbidden,
                    resolved_program: None,
                    justification: None,
                }],
            }
        );

        Ok(())
    }

    #[test]
    fn exec_policy_error_includes_requirement_source() -> Result<()> {
        let toml_str = r#"
            [rules]
            prefix_rules = [
                { pattern = [{ token = "rm" }] },
            ]
        "#;
        let config: ConfigRequirementsToml = from_str(toml_str)?;
        let requirements_toml_file = system_requirements_toml_file_for_test()?;
        let source_location = RequirementSource::SystemRequirementsToml {
            file: requirements_toml_file,
        };

        let mut requirements_with_sources = ConfigRequirementsWithSources::default();
        requirements_with_sources.merge_unset_fields(source_location.clone(), config);
        let err = ConfigRequirements::try_from(requirements_with_sources)
            .expect_err("invalid exec policy");

        assert_eq!(
            err,
            ConstraintError::ExecPolicyParse {
                requirement_source: source_location,
                reason: "rules prefix_rule at index 0 is missing a decision".to_string(),
            }
        );

        Ok(())
    }
}
