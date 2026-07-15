//! `[permissions]` 表的 TOML schema 与 profile 继承解析。
//!
//! 本模块定义 `config.toml` 中 `[permissions.<profile_name>]` 表的结构，
//! 包括 workspace roots、filesystem、network 三类权限。支持通过 `extends`
//! 字段实现 profile 继承，父 profile 的字段在子 profile 之前合并，
//! 子 profile 的键覆盖父 profile 的同名键。
//!
//! 网络权限中的域名匹配会通过 `normalize_host` 进行规范化（如去除尾部点、
//! 转小写），确保不同写法的相同域名被视为相等。

use std::collections::BTreeMap;

use crate::merge::merge_toml_values;
use codex_network_proxy::InjectedHeaderConfig;
use codex_network_proxy::MitmHookActionsConfig;
use codex_network_proxy::MitmHookBodyConfig;
use codex_network_proxy::MitmHookConfig;
use codex_network_proxy::MitmHookMatchConfig;
use codex_network_proxy::NetworkDomainPermission as ProxyNetworkDomainPermission;
use codex_network_proxy::NetworkMode;
use codex_network_proxy::NetworkProxyConfig;
use codex_network_proxy::NetworkUnixSocketPermission as ProxyNetworkUnixSocketPermission;
use codex_network_proxy::normalize_host;
use codex_protocol::permissions::FileSystemAccessMode;
use indexmap::IndexMap;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use thiserror::Error;
use toml::Value as TomlValue;

/// `[permissions]` 表的根容器，使用 flatten 将具名 profile 收集到 map。
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq, JsonSchema)]
pub struct PermissionsToml {
    /// 具名 profile 列表，键为 profile 名称。
    #[serde(flatten)]
    pub entries: BTreeMap<String, PermissionProfileToml>,
}

impl PermissionsToml {
    /// 返回是否没有任何 profile 定义。
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 解析 `profile_name` 及其所有 `extends` 祖先，合并为单个 TOML profile。
    ///
    /// 父 profile 先于子 profile 合并，因此子 profile 的键会覆盖父 profile
    /// 的同名键。返回的 profile 保留所选 profile 的声明元数据（如 `description`
    /// 与 `extends`）。
    ///
    /// `parent_profile` 回调用于查找不在当前 `PermissionsToml` 中的父 profile
    /// （如内置 profile `:read_only`）。
    ///
    /// # Errors
    /// - `UndefinedProfile`: `profile_name` 不存在且无 `referenced_by`
    /// - `UndefinedParent`: `extends` 引用的 profile 不存在
    /// - `UnsupportedBuiltInParent`: `extends` 引用了不支持的内置 profile
    /// - `Cycle`: `extends` 链中出现循环
    /// - `SerializeProfileToml` / `DeserializeProfileToml`: 合并过程中的序列化/反序列化错误
    pub fn resolve_profile<F>(
        &self,
        profile_name: &str,
        mut parent_profile: F,
    ) -> Result<PermissionProfileToml, PermissionProfileResolutionError>
    where
        F: FnMut(&str) -> Option<PermissionProfileToml>,
    {
        let mut profile_names = Vec::new();
        let mut profiles = Vec::new();
        let mut next_profile_name = profile_name.to_string();
        let mut referenced_by: Option<String> = None;

        loop {
            if let Some(cycle_start) = profile_names
                .iter()
                .position(|name| name == &next_profile_name)
            {
                let cycle = profile_names[cycle_start..]
                    .iter()
                    .cloned()
                    .chain(std::iter::once(next_profile_name))
                    .collect::<Vec<_>>();
                return Err(PermissionProfileResolutionError::Cycle { cycle });
            }

            let profile = self
                .entries
                .get(&next_profile_name)
                .cloned()
                .or_else(|| parent_profile(&next_profile_name))
                .ok_or_else(|| {
                    referenced_by.as_deref().map_or_else(
                        || PermissionProfileResolutionError::UndefinedProfile {
                            profile_name: next_profile_name.clone(),
                        },
                        |referenced_by| {
                            if next_profile_name.starts_with(':') {
                                PermissionProfileResolutionError::UnsupportedBuiltInParent {
                                    profile_name: referenced_by.to_string(),
                                    parent_profile_name: next_profile_name.clone(),
                                }
                            } else {
                                PermissionProfileResolutionError::UndefinedParent {
                                    profile_name: referenced_by.to_string(),
                                    parent_profile_name: next_profile_name.clone(),
                                }
                            }
                        },
                    )
                })?;
            let parent_profile_name = profile.extends.clone();

            profile_names.push(next_profile_name.clone());

            if let Some(parent_profile_name) = parent_profile_name {
                profiles.push(profile);
                referenced_by = Some(next_profile_name);
                next_profile_name = parent_profile_name;
                continue;
            }

            let profile = profiles
                .into_iter()
                .rev()
                .try_fold(profile, merge_permission_profiles)?;
            return Ok(profile);
        }
    }
}

/// 单个权限 profile 的 TOML 表示。
///
/// 通过 `extends` 字段引用父 profile 实现继承；`workspace_roots`、
/// `filesystem`、`network` 三类权限分别配置。
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct PermissionProfileToml {
    /// 人类可读的 profile 描述。
    pub description: Option<String>,
    /// 父 profile 名称（支持内置 profile 如 `:read_only`）。
    pub extends: Option<String>,
    /// workspace 根目录权限配置。
    pub workspace_roots: Option<WorkspaceRootsToml>,
    /// 文件系统权限配置。
    pub filesystem: Option<FilesystemPermissionsToml>,
    /// 网络权限配置。
    pub network: Option<NetworkToml>,
}

/// `resolve_profile` 过程中可能发生的错误。
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PermissionProfileResolutionError {
    /// `default_permissions` 引用了未定义的 profile。
    #[error("default_permissions refers to undefined profile `{profile_name}`")]
    UndefinedProfile { profile_name: String },
    /// profile 通过 `extends` 引用了未定义的父 profile。
    #[error(
        "permissions profile `{profile_name}` extends undefined profile `{parent_profile_name}`"
    )]
    UndefinedParent {
        profile_name: String,
        parent_profile_name: String,
    },
    /// profile 通过 `extends` 引用了不支持的内置 profile（以 `:` 开头）。
    #[error(
        "permissions profile `{profile_name}` cannot extend unsupported built-in profile `{parent_profile_name}`"
    )]
    UnsupportedBuiltInParent {
        profile_name: String,
        parent_profile_name: String,
    },
    /// `extends` 链中出现循环引用。
    #[error(
        "permissions profile inheritance cycle detected: {}",
        cycle.join(" -> ")
    )]
    Cycle { cycle: Vec<String> },
    /// 合并 profile 时序列化失败。
    #[error("failed to serialize permissions profile while resolving inheritance: {source}")]
    SerializeProfileToml {
        #[source]
        source: toml::ser::Error,
    },
    /// 合并 profile 后反序列化失败。
    #[error(
        "failed to deserialize merged permissions profile while resolving inheritance: {source}"
    )]
    DeserializeProfileToml {
        #[source]
        source: toml::de::Error,
    },
}

/// 将父 profile 与子 profile 合并为单个 TOML profile。
///
/// 合并前会清空父 profile 的 `description` 与 `extends` 字段，因为这些
/// 元数据应来自被选中的 profile 声明，而非继承的父 profile。
///
/// 若父子 profile 都定义了 `network.domains`，先对两者的域名进行规范化
/// （`normalize_host`），确保合并后不会出现重复键。
fn merge_permission_profiles(
    mut parent: PermissionProfileToml,
    mut child: PermissionProfileToml,
) -> Result<PermissionProfileToml, PermissionProfileResolutionError> {
    let merges_network_domains = parent
        .network
        .as_ref()
        .and_then(|network| network.domains.as_ref())
        .is_some()
        && child
            .network
            .as_ref()
            .and_then(|network| network.domains.as_ref())
            .is_some();

    // description 与继承元数据属于被选中 profile 的声明，
    // 因此父 profile 不应填充这些字段。
    parent.description = None;
    parent.extends = None;

    if merges_network_domains {
        normalize_profile_network_domains(&mut parent);
        normalize_profile_network_domains(&mut child);
    }

    let mut merged = TomlValue::try_from(parent)
        .map_err(|source| PermissionProfileResolutionError::SerializeProfileToml { source })?;
    let child = TomlValue::try_from(child)
        .map_err(|source| PermissionProfileResolutionError::SerializeProfileToml { source })?;
    merge_toml_values(&mut merged, &child);
    merged
        .try_into()
        .map_err(|source| PermissionProfileResolutionError::DeserializeProfileToml { source })
}

/// 规范化 profile 中所有网络域名的匹配模式。
///
/// 通过 `normalize_host` 将域名转换为规范形式（如去除尾部点、转小写），
/// 确保合并时不同写法的相同域名不会产生重复键。
fn normalize_profile_network_domains(profile: &mut PermissionProfileToml) {
    let Some(domains) = profile
        .network
        .as_mut()
        .and_then(|network| network.domains.as_mut())
    else {
        return;
    };

    let entries = std::mem::take(&mut domains.entries);
    domains.entries = entries
        .into_iter()
        .map(|(pattern, permission)| (normalize_host(&pattern), permission))
        .collect();
}

/// workspace 根目录权限配置。
///
/// 键为路径，值为 `true` 表示启用该根目录，`false` 表示禁用。
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq, JsonSchema)]
pub struct WorkspaceRootsToml {
    /// 路径到启用状态的映射。
    #[serde(flatten)]
    pub entries: BTreeMap<String, bool>,
}

impl WorkspaceRootsToml {
    /// 返回所有启用（值为 `true`）的根目录路径迭代器。
    pub fn enabled_roots(&self) -> impl Iterator<Item = &String> {
        self.entries
            .iter()
            .filter_map(|(path, enabled)| (*enabled).then_some(path))
    }
}

/// 文件系统权限配置。
///
/// `glob_scan_max_depth` 限制 glob 模式展开的最大深度；
/// `entries` 为路径到权限的映射，支持简单与作用域两种形式。
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq, JsonSchema)]
pub struct FilesystemPermissionsToml {
    /// glob 模式展开的最大深度，用于在 sandbox 启动前快照 glob 匹配项的平台。
    /// 最小值为 1。
    #[schemars(range(min = 1))]
    pub glob_scan_max_depth: Option<usize>,
    /// 路径到权限的映射。
    #[serde(flatten)]
    pub entries: BTreeMap<String, FilesystemPermissionToml>,
}

impl FilesystemPermissionsToml {
    /// 返回是否没有任何文件系统权限条目。
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// 单个路径的文件系统权限。
///
/// `Access` 变体为简单的全局访问模式；`Scoped` 变体为按作用域
/// （如 `read`、`write`）配置的访问模式映射。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema)]
#[serde(untagged)]
pub enum FilesystemPermissionToml {
    /// 全局访问模式（如 `"read"`、`"read-write"`）。
    Access(FileSystemAccessMode),
    /// 按作用域配置的访问模式映射。
    Scoped(BTreeMap<String, FileSystemAccessMode>),
}

/// 网络域名权限配置。
///
/// 键为域名匹配模式，值为 `Allow` 或 `Deny`。
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq, JsonSchema)]
pub struct NetworkDomainPermissionsToml {
    /// 域名模式到权限的映射。
    #[serde(flatten)]
    pub entries: BTreeMap<String, NetworkDomainPermissionToml>,
}

impl NetworkDomainPermissionsToml {
    /// 返回是否没有任何域名权限条目。
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 返回所有 `Allow` 域名模式列表，无允许项时返回 `None`。
    pub fn allowed_domains(&self) -> Option<Vec<String>> {
        let allowed_domains: Vec<String> = self
            .entries
            .iter()
            .filter(|(_, permission)| matches!(permission, NetworkDomainPermissionToml::Allow))
            .map(|(pattern, _)| pattern.clone())
            .collect();
        (!allowed_domains.is_empty()).then_some(allowed_domains)
    }

    /// 返回所有 `Deny` 域名模式列表，无拒绝项时返回 `None`。
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

/// 单个域名的网络权限决策。
#[derive(
    Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, JsonSchema,
)]
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

/// Unix socket 权限配置。
///
/// 键为 socket 路径，值为 `Allow` 或 `Deny`。
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq, JsonSchema)]
pub struct NetworkUnixSocketPermissionsToml {
    /// socket 路径到权限的映射。
    #[serde(flatten)]
    pub entries: BTreeMap<String, NetworkUnixSocketPermissionToml>,
}

impl NetworkUnixSocketPermissionsToml {
    /// 返回是否没有任何 Unix socket 权限条目。
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

/// 单个 Unix socket 的权限决策。
#[derive(
    Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, JsonSchema,
)]
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

/// `[permissions.<name>.network]` 表的完整网络配置。
///
/// 涵盖网络启用开关、代理、SOCKS5、域名权限、Unix socket 权限、
/// MITM hook 等所有网络相关字段。
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct NetworkToml {
    /// 是否启用网络访问。
    pub enabled: Option<bool>,
    /// HTTP 代理 URL。
    pub proxy_url: Option<String>,
    /// 是否启用 SOCKS5 代理。
    pub enable_socks5: Option<bool>,
    /// SOCKS5 代理 URL。
    pub socks_url: Option<String>,
    /// 是否启用 SOCKS5 UDP 转发。
    pub enable_socks5_udp: Option<bool>,
    /// 是否允许上游代理。
    pub allow_upstream_proxy: Option<bool>,
    /// 危险选项：允许非 loopback 代理。
    pub dangerously_allow_non_loopback_proxy: Option<bool>,
    /// 危险选项：允许所有 Unix socket。
    pub dangerously_allow_all_unix_sockets: Option<bool>,
    /// 网络模式（`Limited` 或 `Full`）。
    #[schemars(with = "Option<NetworkModeSchema>")]
    pub mode: Option<NetworkMode>,
    /// 域名权限配置。
    pub domains: Option<NetworkDomainPermissionsToml>,
    /// Unix socket 权限配置。
    pub unix_sockets: Option<NetworkUnixSocketPermissionsToml>,
    /// 是否允许本地绑定。
    pub allow_local_binding: Option<bool>,
    /// MITM hook 配置。
    pub mitm: Option<NetworkMitmToml>,
}

/// MITM（中间人）hook 配置。
///
/// `hooks` 定义匹配规则与触发的 action；`actions` 定义 action 的具体操作
/// （如剥离/注入 header）。两者通过 action 名称关联。
#[derive(Serialize, Debug, Clone, Default, PartialEq, Eq, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct NetworkMitmToml {
    /// hook 名称到 hook 配置的映射（保持插入顺序）。
    #[schemars(with = "Option<BTreeMap<String, NetworkMitmHookToml>>")]
    pub hooks: Option<IndexMap<String, NetworkMitmHookToml>>,
    /// action 名称到 action 配置的映射（保持插入顺序）。
    #[schemars(with = "Option<BTreeMap<String, NetworkMitmActionToml>>")]
    pub actions: Option<IndexMap<String, NetworkMitmActionToml>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NetworkMitmTomlUnchecked {
    pub hooks: Option<IndexMap<String, NetworkMitmHookToml>>,
    pub actions: Option<IndexMap<String, NetworkMitmActionToml>>,
}

/// 单个 MITM hook 的配置。
///
/// `host`、`methods`、`path_prefixes`、`query`、`headers`、`body` 共同
/// 构成请求匹配条件；`action` 列表引用要触发的 action 名称。
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct NetworkMitmHookToml {
    /// 目标 host。
    pub host: String,
    /// 匹配的 HTTP 方法列表。
    pub methods: Vec<String>,
    /// 匹配的路径前缀列表。
    pub path_prefixes: Vec<String>,
    /// 匹配的 query 参数（键到值列表）。
    #[serde(default)]
    pub query: BTreeMap<String, Vec<String>>,
    /// 匹配的 header（键到值列表）。
    #[serde(default)]
    pub headers: BTreeMap<String, Vec<String>>,
    /// 匹配的 body 配置。
    #[schemars(with = "Option<MitmHookBodyConfigSchema>")]
    pub body: Option<MitmHookBodyConfig>,
    /// 触发的 action 名称列表。
    pub action: Vec<String>,
}

/// JSON Schema 中网络模式的表示（`limited` 或 `full`）。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum NetworkModeSchema {
    /// 受限模式。
    Limited,
    /// 完全模式。
    Full,
}

/// MITM action 配置。
///
/// 一个 action 定义了对请求的一组操作：剥离指定 header、注入指定 header。
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq, JsonSchema)]
#[serde(default)]
pub struct NetworkMitmActionToml {
    /// 要剥离的请求 header 名称列表。
    pub strip_request_headers: Vec<String>,
    /// 要注入的请求 header 列表。
    pub inject_request_headers: Vec<NetworkMitmInjectedHeaderToml>,
}

/// 注入的 header 配置。
///
/// 支持从环境变量或文件读取 secret 值，并可指定前缀。
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq, JsonSchema)]
#[serde(default)]
pub struct NetworkMitmInjectedHeaderToml {
    /// header 名称。
    pub name: String,
    /// 从环境变量读取 secret 值。
    pub secret_env_var: Option<String>,
    /// 从文件读取 secret 值。
    pub secret_file: Option<String>,
    /// secret 值的前缀。
    pub prefix: Option<String>,
}

/// MITM hook body 配置的 JSON Schema 包装类型。
///
/// 使用 `serde_json::Value` 透传任意 JSON 结构，因为 body 匹配规则
/// 是动态的，无法用静态类型表达。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema)]
#[serde(transparent)]
struct MitmHookBodyConfigSchema(pub serde_json::Value);

impl<'de> Deserialize<'de> for NetworkMitmToml {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let unchecked = NetworkMitmTomlUnchecked::deserialize(deserializer)?;
        let mitm = Self {
            hooks: unchecked.hooks,
            actions: unchecked.actions,
        };
        mitm.validate_action_definitions()
            .map_err(serde::de::Error::custom)?;
        Ok(mitm)
    }
}

impl NetworkMitmToml {
    /// 校验所有 action 与 hook 的定义是否合法。
    ///
    /// - 每个 action 必须至少定义一个操作（剥离或注入 header）
    /// - 每个 hook 的 `action` 列表不能为空
    ///
    /// # Errors
    /// 返回错误字符串描述具体问题。
    pub fn validate_action_definitions(&self) -> Result<(), String> {
        if let Some(actions) = self.actions.as_ref() {
            for (action_name, action) in actions {
                if action.is_empty() {
                    return Err(format!(
                        "network.mitm.actions.{action_name} must define at least one operation"
                    ));
                }
            }
        }

        let Some(hooks) = self.hooks.as_ref() else {
            return Ok(());
        };

        for (hook_name, hook) in hooks {
            if hook.action.is_empty() {
                return Err(format!(
                    "network.mitm.hooks.{hook_name}.action must not be empty"
                ));
            }
        }

        Ok(())
    }

    /// 校验所有 hook 引用的 action 是否已定义。
    ///
    /// 先调用 `validate_action_definitions` 校验基本定义，再检查每个 hook
    /// 的 `action` 列表中引用的 action 名称是否存在于 `actions_by_name`。
    ///
    /// # Errors
    /// 返回错误字符串描述具体问题。
    pub fn validate_action_references(
        &self,
        actions_by_name: &IndexMap<String, NetworkMitmActionToml>,
    ) -> Result<(), String> {
        self.validate_action_definitions()?;

        let Some(hooks) = self.hooks.as_ref() else {
            return Ok(());
        };

        for (hook_name, hook) in hooks {
            for action_name in &hook.action {
                if !actions_by_name.contains_key(action_name) {
                    return Err(format!(
                        "network.mitm.hooks.{hook_name}.action references undefined action `{action_name}`"
                    ));
                }
            }
        }

        Ok(())
    }

    /// 将 hook 配置转换为运行时 `MitmHookConfig` 列表。
    ///
    /// `actions_by_name` 为 `None` 时，所有 hook 的 action 操作为空。
    pub fn to_runtime_hooks(
        &self,
        actions_by_name: Option<&IndexMap<String, NetworkMitmActionToml>>,
    ) -> Vec<MitmHookConfig> {
        self.hooks
            .as_ref()
            .map(|hooks| {
                hooks
                    .values()
                    .map(|hook| hook.to_runtime(actions_by_name))
                    .collect()
            })
            .unwrap_or_default()
    }
}

impl NetworkMitmActionToml {
    /// 返回该 action 是否没有任何操作（既不剥离也不注入 header）。
    pub fn is_empty(&self) -> bool {
        self.strip_request_headers.is_empty() && self.inject_request_headers.is_empty()
    }
}

impl NetworkToml {
    /// 将当前 TOML 配置覆盖应用到已有的 `NetworkProxyConfig`。
    ///
    /// 仅覆盖 `Some(_)` 字段；`None` 字段保持 `config` 中的原值不变。
    /// 域名与 Unix socket 权限采用 upsert 语义，相同键会被覆盖。
    pub fn apply_to_network_proxy_config(&self, config: &mut NetworkProxyConfig) {
        if let Some(enabled) = self.enabled {
            config.network.enabled = enabled;
        }
        if let Some(proxy_url) = self.proxy_url.as_ref() {
            config.network.proxy_url = proxy_url.clone();
        }
        if let Some(enable_socks5) = self.enable_socks5 {
            config.network.enable_socks5 = enable_socks5;
        }
        if let Some(socks_url) = self.socks_url.as_ref() {
            config.network.socks_url = socks_url.clone();
        }
        if let Some(enable_socks5_udp) = self.enable_socks5_udp {
            config.network.enable_socks5_udp = enable_socks5_udp;
        }
        if let Some(allow_upstream_proxy) = self.allow_upstream_proxy {
            config.network.allow_upstream_proxy = allow_upstream_proxy;
        }
        if let Some(dangerously_allow_non_loopback_proxy) =
            self.dangerously_allow_non_loopback_proxy
        {
            config.network.dangerously_allow_non_loopback_proxy =
                dangerously_allow_non_loopback_proxy;
        }
        if let Some(dangerously_allow_all_unix_sockets) = self.dangerously_allow_all_unix_sockets {
            config.network.dangerously_allow_all_unix_sockets = dangerously_allow_all_unix_sockets;
        }
        if let Some(mode) = self.mode {
            config.network.mode = mode;
        }
        if let Some(domains) = self.domains.as_ref() {
            overlay_network_domain_permissions(config, domains);
        }
        if let Some(unix_sockets) = self.unix_sockets.as_ref() {
            let mut proxy_unix_sockets = config.network.unix_sockets.take().unwrap_or_default();
            for (path, permission) in &unix_sockets.entries {
                let permission = match permission {
                    NetworkUnixSocketPermissionToml::Allow => {
                        ProxyNetworkUnixSocketPermission::Allow
                    }
                    NetworkUnixSocketPermissionToml::Deny => ProxyNetworkUnixSocketPermission::Deny,
                };
                proxy_unix_sockets.entries.insert(path.clone(), permission);
            }
            config.network.unix_sockets =
                (!proxy_unix_sockets.entries.is_empty()).then_some(proxy_unix_sockets);
        }
        if let Some(allow_local_binding) = self.allow_local_binding {
            config.network.allow_local_binding = allow_local_binding;
        }
        if let Some(mitm) = self.mitm.as_ref() {
            config.network.mitm_hooks = mitm.to_runtime_hooks(mitm.actions.as_ref());
        }
        config.network.mitm =
            config.network.mode == NetworkMode::Limited || !config.network.mitm_hooks.is_empty();
    }

    /// 基于当前 TOML 配置构造一个全新的 `NetworkProxyConfig`。
    ///
    /// 等价于以默认 `NetworkProxyConfig` 为起点调用 `apply_to_network_proxy_config`。
    pub fn to_network_proxy_config(&self) -> NetworkProxyConfig {
        let mut config = NetworkProxyConfig::default();
        self.apply_to_network_proxy_config(&mut config);
        config
    }
}

impl NetworkMitmHookToml {
    /// 将当前 hook 配置转换为运行时 `MitmHookConfig`。
    ///
    /// `actions_by_name` 为 `None` 时返回的 hook 的 action 操作为空；
    /// 为 `Some(_)` 时按 `self.action` 列表引用的 action 名称聚合操作。
    fn to_runtime(
        &self,
        actions_by_name: Option<&IndexMap<String, NetworkMitmActionToml>>,
    ) -> MitmHookConfig {
        MitmHookConfig {
            host: self.host.clone(),
            matcher: MitmHookMatchConfig {
                methods: self.methods.clone(),
                path_prefixes: self.path_prefixes.clone(),
                query: self.query.clone(),
                headers: self.headers.clone(),
                body: self.body.clone(),
            },
            actions: self.selected_actions(actions_by_name),
        }
    }

    /// 聚合当前 hook 引用的所有 action 的操作。
    ///
    /// 按 `self.action` 列表顺序，从 `actions_by_name` 中查找每个 action，
    /// 将其 `strip_request_headers` 与 `inject_request_headers` 追加到结果中。
    fn selected_actions(
        &self,
        actions_by_name: Option<&IndexMap<String, NetworkMitmActionToml>>,
    ) -> MitmHookActionsConfig {
        let Some(actions_by_name) = actions_by_name else {
            return MitmHookActionsConfig::default();
        };

        let mut selected = MitmHookActionsConfig::default();
        for action_name in &self.action {
            if let Some(action) = actions_by_name.get(action_name) {
                selected
                    .strip_request_headers
                    .extend(action.strip_request_headers.clone());
                selected.inject_request_headers.extend(
                    action
                        .inject_request_headers
                        .iter()
                        .map(NetworkMitmInjectedHeaderToml::to_runtime),
                );
            }
        }
        selected
    }
}

impl NetworkMitmInjectedHeaderToml {
    /// 转换为运行时 `InjectedHeaderConfig`。
    fn to_runtime(&self) -> InjectedHeaderConfig {
        InjectedHeaderConfig {
            name: self.name.clone(),
            secret_env_var: self.secret_env_var.clone(),
            secret_file: self.secret_file.clone(),
            prefix: self.prefix.clone(),
        }
    }
}

/// 将 `domains` 中的域名权限覆盖应用到 `config`。
///
/// 对每个域名模式，通过 `normalize_host` 规范化后调用
/// `upsert_domain_permission` 插入或更新权限。
pub fn overlay_network_domain_permissions(
    config: &mut NetworkProxyConfig,
    domains: &NetworkDomainPermissionsToml,
) {
    for (pattern, permission) in &domains.entries {
        let permission = match permission {
            NetworkDomainPermissionToml::Allow => ProxyNetworkDomainPermission::Allow,
            NetworkDomainPermissionToml::Deny => ProxyNetworkDomainPermission::Deny,
        };
        config
            .network
            .upsert_domain_permission(pattern.clone(), permission, normalize_host);
    }
}
