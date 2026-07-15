//! 协议核心模型类型定义。
//!
//! 包含 sandbox 权限、文件系统权限、permission profile、response item、
//! content item、function call 等核心类型。这些类型构成 Codex 协议的基础
//! 数据模型，被其他模块广泛引用。

use std::collections::HashMap;
use std::io;
use std::num::NonZeroUsize;
use std::path::Path;

use codex_utils_image::PromptImageMode;
use codex_utils_image::data_url_from_bytes;
use codex_utils_image::load_for_prompt_bytes;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::ser::Serializer;
use ts_rs::TS;

use crate::permissions::FileSystemAccessMode;
use crate::permissions::FileSystemPath;
use crate::permissions::FileSystemSandboxEntry;
use crate::permissions::FileSystemSandboxKind;
use crate::permissions::FileSystemSandboxPolicy;
use crate::permissions::FileSystemSpecialPath;
use crate::permissions::NetworkSandboxPolicy;
use crate::protocol::SandboxPolicy;
use crate::user_input::UserInput;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_image::ImageProcessingError;
use codex_utils_path_uri::PathUri;
use schemars::JsonSchema;

use crate::mcp::CallToolResult;

/// 控制单条 shell 类 tool 调用请求的 sandbox 覆盖行为。
#[derive(
    Debug, Clone, Copy, Default, Eq, Hash, PartialEq, Serialize, Deserialize, JsonSchema, TS,
)]
#[serde(rename_all = "snake_case")]
pub enum SandboxPermissions {
    /// 沿用 turn 配置的 sandbox 策略，不做覆盖。
    #[default]
    UseDefault,
    /// 请求在 sandbox 外执行。
    RequireEscalated,
    /// 请求留在 sandbox 内，但仅为本条命令放宽权限。
    WithAdditionalPermissions,
}

impl SandboxPermissions {
    /// 是否要求完全脱离 sandbox 执行（即 `RequireEscalated`）。
    pub fn requires_escalated_permissions(self) -> bool {
        matches!(self, SandboxPermissions::RequireEscalated)
    }

    /// 是否请求了除 `UseDefault` 之外的显式单命令覆盖。
    pub fn requests_sandbox_override(self) -> bool {
        !matches!(self, SandboxPermissions::UseDefault)
    }

    /// 是否使用 sandbox 内单命令权限放宽流程。
    pub fn uses_additional_permissions(self) -> bool {
        matches!(self, SandboxPermissions::WithAdditionalPermissions)
    }
}

#[derive(Debug, Clone, Eq, Hash, PartialEq, JsonSchema, TS)]
pub struct FileSystemPermissions<PathType = AbsolutePathBuf> {
    pub entries: Vec<FileSystemSandboxEntry<PathType>>,
    pub glob_scan_max_depth: Option<NonZeroUsize>,
}

impl From<FileSystemPermissions<AbsolutePathBuf>> for FileSystemPermissions<PathUri> {
    fn from(value: FileSystemPermissions<AbsolutePathBuf>) -> Self {
        FileSystemPermissions {
            entries: value
                .entries
                .into_iter()
                .map(FileSystemSandboxEntry::<PathUri>::from)
                .collect(),
            glob_scan_max_depth: value.glob_scan_max_depth,
        }
    }
}

impl TryFrom<FileSystemPermissions<PathUri>> for FileSystemPermissions<AbsolutePathBuf> {
    type Error = io::Error;

    fn try_from(value: FileSystemPermissions<PathUri>) -> Result<Self, Self::Error> {
        Ok(FileSystemPermissions {
            entries: value
                .entries
                .into_iter()
                .map(FileSystemSandboxEntry::<AbsolutePathBuf>::try_from)
                .collect::<io::Result<_>>()?,
            glob_scan_max_depth: value.glob_scan_max_depth,
        })
    }
}

impl<PathType> Default for FileSystemPermissions<PathType> {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            glob_scan_max_depth: None,
        }
    }
}

pub type LegacyReadWriteRoots<PathType = AbsolutePathBuf> =
    (Option<Vec<PathType>>, Option<Vec<PathType>>);
impl<PathType> FileSystemPermissions<PathType> {
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn from_read_write_roots(
        read: Option<Vec<PathType>>,
        write: Option<Vec<PathType>>,
    ) -> Self {
        let mut entries = Vec::new();
        if let Some(read) = read {
            entries.extend(read.into_iter().map(|path| FileSystemSandboxEntry {
                path: FileSystemPath::Path { path },
                access: FileSystemAccessMode::Read,
            }));
        }
        if let Some(write) = write {
            entries.extend(write.into_iter().map(|path| FileSystemSandboxEntry {
                path: FileSystemPath::Path { path },
                access: FileSystemAccessMode::Write,
            }));
        }
        Self {
            entries,
            glob_scan_max_depth: None,
        }
    }

    pub fn explicit_path_entries(&self) -> impl Iterator<Item = (&PathType, FileSystemAccessMode)> {
        self.entries.iter().filter_map(|entry| match &entry.path {
            FileSystemPath::Path { path } => Some((path, entry.access)),
            FileSystemPath::GlobPattern { .. } | FileSystemPath::Special { .. } => None,
        })
    }

    pub fn legacy_read_write_roots(&self) -> Option<LegacyReadWriteRoots<PathType>>
    where
        PathType: Clone,
    {
        self.as_legacy_permissions()
            .map(|legacy| (legacy.read, legacy.write))
    }

    fn as_legacy_permissions(&self) -> Option<LegacyFileSystemPermissions<PathType>>
    where
        PathType: Clone,
    {
        if self.glob_scan_max_depth.is_some() {
            return None;
        }

        let mut read = Vec::new();
        let mut write = Vec::new();

        for entry in &self.entries {
            let FileSystemPath::Path { path } = &entry.path else {
                return None;
            };
            match entry.access {
                FileSystemAccessMode::Read => read.push(path.clone()),
                FileSystemAccessMode::Write => write.push(path.clone()),
                FileSystemAccessMode::Deny => return None,
            }
        }

        Some(LegacyFileSystemPermissions {
            read: (!read.is_empty()).then_some(read),
            write: (!write.is_empty()).then_some(write),
        })
    }
}

#[derive(Debug, Clone, Default, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(bound(deserialize = "PathType: Deserialize<'de>"))]
struct LegacyFileSystemPermissions<PathType = AbsolutePathBuf> {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    read: Option<Vec<PathType>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    write: Option<Vec<PathType>>,
}

#[derive(Debug, Clone, Default, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(bound(deserialize = "PathType: Deserialize<'de>"))]
struct CanonicalFileSystemPermissions<PathType = AbsolutePathBuf> {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    entries: Vec<FileSystemSandboxEntry<PathType>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    glob_scan_max_depth: Option<NonZeroUsize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum FileSystemPermissionsDe<PathType = AbsolutePathBuf> {
    Canonical(CanonicalFileSystemPermissions<PathType>),
    Legacy(LegacyFileSystemPermissions<PathType>),
}

impl<PathType> Serialize for FileSystemPermissions<PathType>
where
    PathType: Clone + Serialize,
{
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        if let Some(legacy) = self.as_legacy_permissions() {
            legacy.serialize(serializer)
        } else {
            CanonicalFileSystemPermissions {
                entries: self.entries.clone(),
                glob_scan_max_depth: self.glob_scan_max_depth,
            }
            .serialize(serializer)
        }
    }
}

impl<'de, PathType> Deserialize<'de> for FileSystemPermissions<PathType>
where
    PathType: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        match FileSystemPermissionsDe::deserialize(deserializer)? {
            FileSystemPermissionsDe::Canonical(CanonicalFileSystemPermissions {
                entries,
                glob_scan_max_depth,
            }) => Ok(Self {
                entries,
                glob_scan_max_depth,
            }),
            FileSystemPermissionsDe::Legacy(LegacyFileSystemPermissions { read, write }) => {
                Ok(Self::from_read_write_roots(read, write))
            }
        }
    }
}

#[derive(Debug, Clone, Default, Eq, Hash, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
pub struct NetworkPermissions {
    pub enabled: Option<bool>,
}

impl NetworkPermissions {
    pub fn is_empty(&self) -> bool {
        self.enabled.is_none()
    }
}

/// 部分权限覆盖层，用于单命令请求和已批准的 session / turn 授权。
#[derive(Debug, Clone, Default, Eq, Hash, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
pub struct AdditionalPermissionProfile {
    /// 网络权限覆盖。
    pub network: Option<NetworkPermissions>,
    /// 文件系统权限覆盖。
    pub file_system: Option<FileSystemPermissions>,
}

impl AdditionalPermissionProfile {
    /// 是否未包含任何权限覆盖。
    pub fn is_empty(&self) -> bool {
        self.network.is_none() && self.file_system.is_none()
    }
}

/// sandbox 执行方式。
#[derive(
    Debug, Clone, Copy, Default, Eq, Hash, PartialEq, Serialize, Deserialize, JsonSchema, TS,
)]
#[serde(rename_all = "snake_case")]
pub enum SandboxEnforcement {
    /// Codex 负责为此 profile 构建 sandbox。
    #[default]
    Managed,
    /// 不应用外部文件系统 sandbox。
    Disabled,
    /// 文件系统隔离由外部调用方负责。
    External,
}

impl SandboxEnforcement {
    pub fn from_legacy_sandbox_policy(sandbox_policy: &SandboxPolicy) -> Self {
        match sandbox_policy {
            SandboxPolicy::DangerFullAccess => Self::Disabled,
            SandboxPolicy::ExternalSandbox { .. } => Self::External,
            SandboxPolicy::ReadOnly { .. } | SandboxPolicy::WorkspaceWrite { .. } => Self::Managed,
        }
    }
}

/// 由 Codex 负责 sandbox 构建的 profile 的文件系统权限。
#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type")]
pub enum ManagedFileSystemPermissions<PathType = AbsolutePathBuf> {
    /// 按列出的条目应用受管文件系统 sandbox。
    #[serde(rename_all = "snake_case")]
    #[ts(rename_all = "snake_case")]
    Restricted {
        /// sandbox 条目列表。
        entries: Vec<FileSystemSandboxEntry<PathType>>,
        /// glob 扫描的最大深度（可选）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        glob_scan_max_depth: Option<NonZeroUsize>,
    },
    /// 应用允许所有文件系统访问的受管 sandbox。
    Unrestricted,
}

impl From<ManagedFileSystemPermissions<AbsolutePathBuf>> for ManagedFileSystemPermissions<PathUri> {
    fn from(value: ManagedFileSystemPermissions<AbsolutePathBuf>) -> Self {
        match value {
            ManagedFileSystemPermissions::Restricted {
                entries,
                glob_scan_max_depth,
            } => ManagedFileSystemPermissions::Restricted {
                entries: entries
                    .into_iter()
                    .map(FileSystemSandboxEntry::<PathUri>::from)
                    .collect(),
                glob_scan_max_depth,
            },
            ManagedFileSystemPermissions::Unrestricted => {
                ManagedFileSystemPermissions::Unrestricted
            }
        }
    }
}

impl TryFrom<ManagedFileSystemPermissions<PathUri>>
    for ManagedFileSystemPermissions<AbsolutePathBuf>
{
    type Error = io::Error;

    fn try_from(value: ManagedFileSystemPermissions<PathUri>) -> Result<Self, Self::Error> {
        Ok(match value {
            ManagedFileSystemPermissions::Restricted {
                entries,
                glob_scan_max_depth,
            } => ManagedFileSystemPermissions::Restricted {
                entries: entries
                    .into_iter()
                    .map(FileSystemSandboxEntry::<AbsolutePathBuf>::try_from)
                    .collect::<io::Result<_>>()?,
                glob_scan_max_depth,
            },
            ManagedFileSystemPermissions::Unrestricted => {
                ManagedFileSystemPermissions::Unrestricted
            }
        })
    }
}

impl ManagedFileSystemPermissions {
    fn from_sandbox_policy(file_system_sandbox_policy: &FileSystemSandboxPolicy) -> Self {
        match file_system_sandbox_policy.kind {
            FileSystemSandboxKind::Restricted => Self::Restricted {
                entries: file_system_sandbox_policy.entries.clone(),
                glob_scan_max_depth: file_system_sandbox_policy
                    .glob_scan_max_depth
                    .and_then(NonZeroUsize::new),
            },
            FileSystemSandboxKind::Unrestricted => Self::Unrestricted,
            FileSystemSandboxKind::ExternalSandbox => unreachable!(
                "external filesystem policies are represented by PermissionProfile::External"
            ),
        }
    }

    pub fn to_sandbox_policy(&self) -> FileSystemSandboxPolicy {
        match self {
            Self::Restricted {
                entries,
                glob_scan_max_depth,
            } => FileSystemSandboxPolicy {
                kind: FileSystemSandboxKind::Restricted,
                glob_scan_max_depth: glob_scan_max_depth.map(usize::from),
                entries: entries.clone(),
            },
            Self::Unrestricted => FileSystemSandboxPolicy::unrestricted(),
        }
    }
}

/// 内置只读权限 profile 的保留标识符。
pub const BUILT_IN_PERMISSION_PROFILE_READ_ONLY: &str = ":read-only";

/// 内置 workspace-write 权限 profile 的保留标识符。
pub const BUILT_IN_PERMISSION_PROFILE_WORKSPACE: &str = ":workspace";

/// 内置完全访问权限 profile 的保留标识符。
pub const BUILT_IN_PERMISSION_PROFILE_DANGER_FULL_ACCESS: &str = ":danger-full-access";

/// 一次会话、turn 或命令的规范活动运行时权限。
#[derive(Debug, Clone, Eq, PartialEq, Serialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type")]
pub enum PermissionProfile<PathType = AbsolutePathBuf> {
    /// Codex 负责为此 profile 构建 sandbox。
    #[serde(rename_all = "snake_case")]
    #[ts(rename_all = "snake_case")]
    Managed {
        /// 受管文件系统权限。
        file_system: ManagedFileSystemPermissions<PathType>,
        /// 网络 sandbox 策略。
        network: NetworkSandboxPolicy,
    },
    /// 不应用外部 sandbox。
    Disabled,
    /// 文件系统隔离由外部调用方负责。
    #[serde(rename_all = "snake_case")]
    #[ts(rename_all = "snake_case")]
    External {
        /// 网络 sandbox 策略。
        network: NetworkSandboxPolicy,
    },
}

impl From<PermissionProfile<AbsolutePathBuf>> for PermissionProfile<PathUri> {
    fn from(value: PermissionProfile<AbsolutePathBuf>) -> Self {
        match value {
            PermissionProfile::Managed {
                file_system,
                network,
            } => PermissionProfile::Managed {
                file_system: file_system.into(),
                network,
            },
            PermissionProfile::Disabled => PermissionProfile::Disabled,
            PermissionProfile::External { network } => PermissionProfile::External { network },
        }
    }
}

impl TryFrom<PermissionProfile<PathUri>> for PermissionProfile<AbsolutePathBuf> {
    type Error = io::Error;

    fn try_from(value: PermissionProfile<PathUri>) -> Result<Self, Self::Error> {
        Ok(match value {
            PermissionProfile::Managed {
                file_system,
                network,
            } => PermissionProfile::Managed {
                file_system: file_system.try_into()?,
                network,
            },
            PermissionProfile::Disabled => PermissionProfile::Disabled,
            PermissionProfile::External { network } => PermissionProfile::External { network },
        })
    }
}

/// 描述生成当前活动 `PermissionProfile` 的命名或隐式内置权限 profile 元数据。
///
/// 运行时必须遵循 `PermissionProfile` 本身；此 sidecar 仅供客户端展示稳定的
/// profile 标识，而无需从已编译的权限集合中反向推导名称。
#[derive(Debug, Clone, Eq, PartialEq, Deserialize, Serialize, JsonSchema, TS)]
pub struct ActivePermissionProfile {
    /// 来自 `default_permissions` 或隐式内置默认值的 profile 标识符，
    /// 例如 `:workspace` 或用户自定义的 `[permissions.<id>]` profile。
    pub id: String,

    /// 来自所选权限 profile `extends` 设置的可选父 profile 标识符。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub extends: Option<String>,
}

impl ActivePermissionProfile {
    /// 由 ID 构造 `ActivePermissionProfile`。
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            extends: None,
        }
    }

    /// 返回内置 read-only profile 对应的 `ActivePermissionProfile`。
    pub fn read_only() -> Self {
        Self::new(BUILT_IN_PERMISSION_PROFILE_READ_ONLY)
    }
}

impl<PathType> Default for PermissionProfile<PathType> {
    fn default() -> Self {
        Self::Managed {
            file_system: ManagedFileSystemPermissions::Restricted {
                entries: Vec::new(),
                glob_scan_max_depth: None,
            },
            network: NetworkSandboxPolicy::Restricted,
        }
    }
}

impl PermissionProfile {
    /// 受管 read-only 文件系统访问，配合受限的网络访问策略。
    pub fn read_only() -> Self {
        let file_system = FileSystemSandboxPolicy::read_only();
        Self::Managed {
            file_system: ManagedFileSystemPermissions::from_sandbox_policy(&file_system),
            network: NetworkSandboxPolicy::Restricted,
        }
    }

    /// 受管 workspace-write 文件系统访问，配合受限的网络访问策略。
    ///
    /// 返回的 profile 含符号化的 `:workspace_roots` 条目，必须在执行前
    /// 针对当前权限根进行解析。
    pub fn workspace_write() -> Self {
        Self::workspace_write_with(
            &[],
            NetworkSandboxPolicy::Restricted,
            /*exclude_tmpdir_env_var*/ false,
            /*exclude_slash_tmp*/ false,
        )
    }

    /// 受管 workspace-write 文件系统访问，直接套用旧版
    /// `sandbox_workspace_write` 的可调参数。
    ///
    /// 返回的 profile 含符号化的 `:workspace_roots` 条目，必须在执行前
    /// 针对当前权限根进行解析。
    pub fn workspace_write_with(
        writable_roots: &[AbsolutePathBuf],
        network: NetworkSandboxPolicy,
        exclude_tmpdir_env_var: bool,
        exclude_slash_tmp: bool,
    ) -> Self {
        let file_system = FileSystemSandboxPolicy::workspace_write(
            writable_roots,
            exclude_tmpdir_env_var,
            exclude_slash_tmp,
        );
        Self::Managed {
            file_system: ManagedFileSystemPermissions::from_sandbox_policy(&file_system),
            network,
        }
    }

    pub fn materialize_project_roots_with_workspace_roots(
        self,
        workspace_roots: &[AbsolutePathBuf],
    ) -> Self {
        match self {
            Self::Managed {
                file_system,
                network,
            } => {
                let file_system = file_system
                    .to_sandbox_policy()
                    .materialize_project_roots_with_workspace_roots(workspace_roots);
                Self::Managed {
                    file_system: ManagedFileSystemPermissions::from_sandbox_policy(&file_system),
                    network,
                }
            }
            Self::Disabled => Self::Disabled,
            Self::External { network } => Self::External { network },
        }
    }

    pub fn from_runtime_permissions(
        file_system_sandbox_policy: &FileSystemSandboxPolicy,
        network_sandbox_policy: NetworkSandboxPolicy,
    ) -> Self {
        let enforcement = match file_system_sandbox_policy.kind {
            FileSystemSandboxKind::Restricted | FileSystemSandboxKind::Unrestricted => {
                SandboxEnforcement::Managed
            }
            FileSystemSandboxKind::ExternalSandbox => SandboxEnforcement::External,
        };
        Self::from_runtime_permissions_with_enforcement(
            enforcement,
            file_system_sandbox_policy,
            network_sandbox_policy,
        )
    }

    pub fn from_runtime_permissions_with_enforcement(
        enforcement: SandboxEnforcement,
        file_system_sandbox_policy: &FileSystemSandboxPolicy,
        network_sandbox_policy: NetworkSandboxPolicy,
    ) -> Self {
        match file_system_sandbox_policy.kind {
            FileSystemSandboxKind::ExternalSandbox => Self::External {
                network: network_sandbox_policy,
            },
            FileSystemSandboxKind::Unrestricted if enforcement == SandboxEnforcement::Disabled => {
                Self::Disabled
            }
            FileSystemSandboxKind::Restricted | FileSystemSandboxKind::Unrestricted => {
                Self::Managed {
                    file_system: ManagedFileSystemPermissions::from_sandbox_policy(
                        file_system_sandbox_policy,
                    ),
                    network: network_sandbox_policy,
                }
            }
        }
    }

    pub fn from_legacy_sandbox_policy(sandbox_policy: &SandboxPolicy) -> Self {
        Self::from_runtime_permissions_with_enforcement(
            SandboxEnforcement::from_legacy_sandbox_policy(sandbox_policy),
            &FileSystemSandboxPolicy::from(sandbox_policy),
            NetworkSandboxPolicy::from(sandbox_policy),
        )
    }

    pub fn from_legacy_sandbox_policy_for_cwd(sandbox_policy: &SandboxPolicy, cwd: &Path) -> Self {
        Self::from_runtime_permissions_with_enforcement(
            SandboxEnforcement::from_legacy_sandbox_policy(sandbox_policy),
            &FileSystemSandboxPolicy::from_legacy_sandbox_policy_for_cwd(sandbox_policy, cwd),
            NetworkSandboxPolicy::from(sandbox_policy),
        )
    }

    pub fn enforcement(&self) -> SandboxEnforcement {
        match self {
            Self::Managed { .. } => SandboxEnforcement::Managed,
            Self::Disabled => SandboxEnforcement::Disabled,
            Self::External { .. } => SandboxEnforcement::External,
        }
    }

    pub fn file_system_sandbox_policy(&self) -> FileSystemSandboxPolicy {
        match self {
            Self::Managed { file_system, .. } => file_system.to_sandbox_policy(),
            Self::Disabled => FileSystemSandboxPolicy::unrestricted(),
            Self::External { .. } => FileSystemSandboxPolicy::external_sandbox(),
        }
    }

    pub fn network_sandbox_policy(&self) -> NetworkSandboxPolicy {
        match self {
            Self::Managed { network, .. } | Self::External { network } => *network,
            Self::Disabled => NetworkSandboxPolicy::Enabled,
        }
    }

    pub fn to_legacy_sandbox_policy(&self, cwd: &Path) -> io::Result<SandboxPolicy> {
        match self {
            Self::Managed {
                file_system,
                network,
            } => file_system
                .to_sandbox_policy()
                .to_legacy_sandbox_policy(*network, cwd),
            Self::Disabled => Ok(SandboxPolicy::DangerFullAccess),
            Self::External { network } => Ok(SandboxPolicy::ExternalSandbox {
                network_access: if network.is_enabled() {
                    crate::protocol::NetworkAccess::Enabled
                } else {
                    crate::protocol::NetworkAccess::Restricted
                },
            }),
        }
    }

    pub fn to_runtime_permissions(&self) -> (FileSystemSandboxPolicy, NetworkSandboxPolicy) {
        (
            self.file_system_sandbox_policy(),
            self.network_sandbox_policy(),
        )
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TaggedPermissionProfile<PathType = AbsolutePathBuf> {
    #[serde(rename_all = "snake_case")]
    Managed {
        file_system: ManagedFileSystemPermissions<PathType>,
        network: NetworkSandboxPolicy,
    },
    Disabled,
    #[serde(rename_all = "snake_case")]
    External {
        network: NetworkSandboxPolicy,
    },
}

impl<PathType> From<TaggedPermissionProfile<PathType>> for PermissionProfile<PathType> {
    fn from(value: TaggedPermissionProfile<PathType>) -> Self {
        match value {
            TaggedPermissionProfile::Managed {
                file_system,
                network,
            } => Self::Managed {
                file_system,
                network,
            },
            TaggedPermissionProfile::Disabled => Self::Disabled,
            TaggedPermissionProfile::External { network } => Self::External { network },
        }
    }
}

/// 写入 rollout 文件的旧版带 tag 形态，存在于 `PermissionProfile`
/// 显式表达 enforcement 之前的版本。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyPermissionProfile<PathType = AbsolutePathBuf> {
    network: Option<NetworkPermissions>,
    file_system: Option<FileSystemPermissions<PathType>>,
}

impl<PathType> From<LegacyPermissionProfile<PathType>> for PermissionProfile<PathType> {
    fn from(value: LegacyPermissionProfile<PathType>) -> Self {
        let file_system = value.file_system.map_or_else(
            || ManagedFileSystemPermissions::Restricted {
                entries: Vec::new(),
                glob_scan_max_depth: None,
            },
            |permissions| ManagedFileSystemPermissions::Restricted {
                entries: permissions.entries,
                glob_scan_max_depth: permissions.glob_scan_max_depth,
            },
        );
        let network_sandbox_policy = if value
            .network
            .as_ref()
            .and_then(|network| network.enabled)
            .unwrap_or(false)
        {
            NetworkSandboxPolicy::Enabled
        } else {
            NetworkSandboxPolicy::Restricted
        };
        Self::Managed {
            file_system,
            network: network_sandbox_policy,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum PermissionProfileDe<PathType = AbsolutePathBuf> {
    Tagged(TaggedPermissionProfile<PathType>),
    Legacy(LegacyPermissionProfile<PathType>),
}

impl<'de, PathType> Deserialize<'de> for PermissionProfile<PathType>
where
    PathType: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Ok(match PermissionProfileDe::deserialize(deserializer)? {
            PermissionProfileDe::Tagged(tagged) => tagged.into(),
            PermissionProfileDe::Legacy(legacy) => legacy.into(),
        })
    }
}

impl From<NetworkSandboxPolicy> for NetworkPermissions {
    fn from(value: NetworkSandboxPolicy) -> Self {
        Self {
            enabled: Some(value.is_enabled()),
        }
    }
}

impl From<&FileSystemSandboxPolicy> for FileSystemPermissions {
    fn from(value: &FileSystemSandboxPolicy) -> Self {
        let entries = match value.kind {
            FileSystemSandboxKind::Restricted => value.entries.clone(),
            FileSystemSandboxKind::Unrestricted | FileSystemSandboxKind::ExternalSandbox => {
                vec![FileSystemSandboxEntry {
                    path: FileSystemPath::Special {
                        value: FileSystemSpecialPath::Root,
                    },
                    access: FileSystemAccessMode::Write,
                }]
            }
        };
        Self {
            entries,
            glob_scan_max_depth: value.glob_scan_max_depth.and_then(NonZeroUsize::new),
        }
    }
}

impl From<&FileSystemPermissions> for FileSystemSandboxPolicy {
    fn from(value: &FileSystemPermissions) -> Self {
        let mut policy = FileSystemSandboxPolicy::restricted(value.entries.clone());
        policy.glob_scan_max_depth = value.glob_scan_max_depth.map(usize::from);
        policy
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ResponseInputItem {
    Message {
        role: String,
        content: Vec<ContentItem>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        phase: Option<MessagePhase>,
    },
    FunctionCallOutput {
        call_id: String,
        #[ts(as = "FunctionCallOutputBody")]
        #[schemars(with = "FunctionCallOutputBody")]
        output: FunctionCallOutputPayload,
    },
    McpToolCallOutput {
        call_id: String,
        output: CallToolResult,
    },
    CustomToolCallOutput {
        call_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        name: Option<String>,
        #[ts(as = "FunctionCallOutputBody")]
        #[schemars(with = "FunctionCallOutputBody")]
        output: FunctionCallOutputPayload,
    },
    ToolSearchOutput {
        call_id: String,
        status: String,
        execution: String,
        #[ts(type = "unknown[]")]
        tools: Vec<serde_json::Value>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentItem {
    InputText {
        text: String,
    },
    InputImage {
        image_url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        detail: Option<ImageDetail>,
    },
    OutputText {
        text: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentMessageInputContent {
    InputText { text: String },
    EncryptedContent { encrypted_content: String },
}

/// 当 Agent 消息完全由纯文本构成时，返回本地可读的文本内容。
pub fn plaintext_agent_message_content(content: &[AgentMessageInputContent]) -> Option<String> {
    let mut text_parts = Vec::with_capacity(content.len());
    for part in content {
        match part {
            AgentMessageInputContent::InputText { text } => text_parts.push(text.as_str()),
            AgentMessageInputContent::EncryptedContent { .. } => return None,
        }
    }

    let text = text_parts.join("\n");
    (!text.trim().is_empty()).then_some(text)
}

/// 图像在 prompt 中的细节级别。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "lowercase")]
pub enum ImageDetail {
    /// 由 model 自动选择细节级别。
    Auto,
    /// 低细节级别，节省 token。
    Low,
    /// 高细节级别，保留更多信息。
    High,
    /// 使用原始图像分辨率。
    Original,
}

/// 默认的图像细节级别。
pub const DEFAULT_IMAGE_DETAIL: ImageDetail = ImageDetail::High;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
/// 将 assistant 消息分类为中途评论或最终回答文本。
///
/// 不同 provider 对此字段的输出并不一致，调用方需将 `None` 视为"阶段未知"，
/// 并对旧版 model 保持兼容行为。
pub enum MessagePhase {
    /// turn 中途产生的 assistant 文本（例如开场白 / 进度叙述）。
    ///
    /// 在 turn 完成前可能还会有更多 tool 调用或 assistant 输出。
    Commentary,
    /// 当前 turn 中 assistant 的最终回答文本。
    FinalAnswer,
}

/// 内部 Responses API 透传元数据，会被复制到底层 chat 消息中。
///
/// Responses API 对此 payload 有强类型约束。未经 API 方确认并同步修改
/// Responses API 前，不得修改此结构。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, JsonSchema, TS)]
pub struct InternalChatMessageMetadataPassthrough {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub turn_id: Option<String>,
}

impl InternalChatMessageMetadataPassthrough {
    pub(crate) fn set_turn_id_if_missing(metadata: &mut Option<Self>, turn_id: &str) {
        if turn_id.is_empty()
            || metadata
                .as_ref()
                .and_then(|metadata| metadata.turn_id.as_deref())
                .is_some_and(|turn_id| !turn_id.is_empty())
        {
            return;
        }
        metadata.get_or_insert_with(Self::default).turn_id = Some(turn_id.to_string());
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ResponseItem {
    #[schemars(skip)]
    #[ts(skip)]
    AdditionalTools {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        role: String,
        tools: Vec<serde_json::Value>,
    },
    Message {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        id: Option<String>,
        role: String,
        content: Vec<ContentItem>,
        // 可选的输出消息阶段（例如 "commentary"、"final_answer"）。
        // 不同 provider/model 的支持程度不同，下游消费方在缺省时需保留
        // 兼容回退行为。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        phase: Option<MessagePhase>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        internal_chat_message_metadata_passthrough: Option<InternalChatMessageMetadataPassthrough>,
    },
    AgentMessage {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        id: Option<String>,
        author: String,
        recipient: String,
        content: Vec<AgentMessageInputContent>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        internal_chat_message_metadata_passthrough: Option<InternalChatMessageMetadataPassthrough>,
    },
    Reasoning {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        id: Option<String>,
        summary: Vec<ReasoningItemReasoningSummary>,
        #[serde(default, skip_serializing_if = "should_serialize_reasoning_content")]
        #[ts(optional)]
        content: Option<Vec<ReasoningItemContent>>,
        encrypted_content: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        internal_chat_message_metadata_passthrough: Option<InternalChatMessageMetadataPassthrough>,
    },
    LocalShellCall {
        /// 旧版 id 字段，仅为兼容旧 payload 而保留。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        id: Option<String>,
        /// 使用 Responses API 时设置。
        call_id: Option<String>,
        status: LocalShellStatus,
        action: LocalShellAction,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        internal_chat_message_metadata_passthrough: Option<InternalChatMessageMetadataPassthrough>,
    },
    FunctionCall {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        id: Option<String>,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        namespace: Option<String>,
        // Responses API 返回的 function call arguments 是一段包含 JSON 的字符串，
        // 而非已解析的对象。此处保留原始字符串，由 Session::handle_function_call
        // 负责解析为 Value。
        arguments: String,
        call_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        internal_chat_message_metadata_passthrough: Option<InternalChatMessageMetadataPassthrough>,
    },
    ToolSearchCall {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        id: Option<String>,
        call_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        status: Option<String>,
        execution: String,
        #[ts(type = "unknown")]
        arguments: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        internal_chat_message_metadata_passthrough: Option<InternalChatMessageMetadataPassthrough>,
    },
    // 注意：`function_call_output` 的 `output` 字段使用专用 payload 类型并采用
    // 自定义序列化。其 wire 形式可以是：
    //   - 纯字符串（`content`）
    //   - 结构化 content item 数组（`content_items`）
    // 该行为集中在 `FunctionCallOutputPayload` 中实现。
    FunctionCallOutput {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        id: Option<String>,
        call_id: String,
        #[ts(as = "FunctionCallOutputBody")]
        #[schemars(with = "FunctionCallOutputBody")]
        output: FunctionCallOutputPayload,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        internal_chat_message_metadata_passthrough: Option<InternalChatMessageMetadataPassthrough>,
    },
    CustomToolCall {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        status: Option<String>,

        call_id: String,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        namespace: Option<String>,
        input: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        internal_chat_message_metadata_passthrough: Option<InternalChatMessageMetadataPassthrough>,
    },
    // `custom_tool_call_output.output` 使用与 `function_call_output.output`
    // 相同的 wire 编码，使得 freeform tool 可以返回纯文本或结构化 content item。
    CustomToolCallOutput {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        id: Option<String>,
        call_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        name: Option<String>,
        #[ts(as = "FunctionCallOutputBody")]
        #[schemars(with = "FunctionCallOutputBody")]
        output: FunctionCallOutputPayload,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        internal_chat_message_metadata_passthrough: Option<InternalChatMessageMetadataPassthrough>,
    },
    ToolSearchOutput {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        id: Option<String>,
        call_id: Option<String>,
        status: String,
        execution: String,
        #[ts(type = "unknown[]")]
        tools: Vec<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        internal_chat_message_metadata_passthrough: Option<InternalChatMessageMetadataPassthrough>,
    },
    // 当 Agent 触发网络搜索时由 Responses API 发出。
    // 示例 payload（来自 SSE `response.output_item.done`）：
    // {
    //   "id":"ws_...",
    //   "type":"web_search_call",
    //   "status":"completed",
    //   "action": {"type":"search","query":"weather: San Francisco, CA"}
    // }
    WebSearchCall {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        status: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        action: Option<WebSearchAction>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        internal_chat_message_metadata_passthrough: Option<InternalChatMessageMetadataPassthrough>,
    },
    // 当 Agent 触发图像生成时由 Responses API 发出。
    // 示例 payload：
    // {
    //   "id":"ig_123",
    //   "type":"image_generation_call",
    //   "status":"completed",
    //   "revised_prompt":"A gray tabby cat hugging an otter...",
    //   "result":"..."
    // }
    ImageGenerationCall {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        id: Option<String>,
        status: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        revised_prompt: Option<String>,
        result: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        internal_chat_message_metadata_passthrough: Option<InternalChatMessageMetadataPassthrough>,
    },
    #[serde(alias = "compaction_summary")]
    Compaction {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        id: Option<String>,
        encrypted_content: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        internal_chat_message_metadata_passthrough: Option<InternalChatMessageMetadataPassthrough>,
    },
    // Compaction 触发器属于请求侧控制，不是持久化的 response item。
    CompactionTrigger {},
    ContextCompaction {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        encrypted_content: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        internal_chat_message_metadata_passthrough: Option<InternalChatMessageMetadataPassthrough>,
    },
    #[serde(other)]
    Other,
}

impl ResponseItem {
    /// 判断当前 item 是否为普通的 user-role 消息。
    pub fn is_user_message(&self) -> bool {
        matches!(self, Self::Message { role, .. } if role == "user")
    }

    /// 返回非空的 Responses API item ID，若不存在则返回 `None`。
    pub fn id(&self) -> Option<&str> {
        match self {
            Self::AdditionalTools { id, .. }
            | Self::Message { id, .. }
            | Self::AgentMessage { id, .. }
            | Self::LocalShellCall { id, .. }
            | Self::FunctionCall { id, .. }
            | Self::ToolSearchCall { id, .. }
            | Self::FunctionCallOutput { id, .. }
            | Self::CustomToolCall { id, .. }
            | Self::CustomToolCallOutput { id, .. }
            | Self::ToolSearchOutput { id, .. }
            | Self::WebSearchCall { id, .. }
            | Self::Reasoning { id, .. }
            | Self::ImageGenerationCall { id, .. }
            | Self::Compaction { id, .. }
            | Self::ContextCompaction { id, .. } => id.as_deref().filter(|id| !id.is_empty()),
            Self::CompactionTrigger { .. } | Self::Other => None,
        }
    }

    /// 为携带 ID 的变体设置或清空 Responses API item ID。
    pub fn set_id(&mut self, new_id: Option<String>) {
        match self {
            Self::AdditionalTools { id, .. }
            | Self::Message { id, .. }
            | Self::AgentMessage { id, .. }
            | Self::LocalShellCall { id, .. }
            | Self::FunctionCall { id, .. }
            | Self::ToolSearchCall { id, .. }
            | Self::FunctionCallOutput { id, .. }
            | Self::CustomToolCall { id, .. }
            | Self::CustomToolCallOutput { id, .. }
            | Self::ToolSearchOutput { id, .. }
            | Self::WebSearchCall { id, .. }
            | Self::Reasoning { id, .. }
            | Self::ImageGenerationCall { id, .. }
            | Self::Compaction { id, .. }
            | Self::ContextCompaction { id, .. } => *id = new_id,
            Self::CompactionTrigger { .. } | Self::Other => {}
        }
    }

    /// 返回此 item 上盖印的非空 turn ID，若不存在则返回 `None`。
    pub fn turn_id(&self) -> Option<&str> {
        self.internal_chat_message_metadata_passthrough()
            .and_then(|metadata| metadata.turn_id.as_deref())
            .filter(|turn_id| !turn_id.is_empty())
    }

    /// 当 item 不存在非空 turn ID 时，将其盖印为 `turn_id`。
    pub fn set_turn_id_if_missing(&mut self, turn_id: &str) {
        let Some(metadata) = self.internal_chat_message_metadata_passthrough_mut() else {
            return;
        };
        InternalChatMessageMetadataPassthrough::set_turn_id_if_missing(metadata, turn_id);
    }

    /// 在向不支持内部 chat message metadata 透传的 provider 发送前，
    /// 移除该透传元数据。
    pub fn clear_internal_chat_message_metadata_passthrough(&mut self) {
        if let Some(metadata) = self.internal_chat_message_metadata_passthrough_mut() {
            *metadata = None;
        }
    }

    fn internal_chat_message_metadata_passthrough(
        &self,
    ) -> Option<&InternalChatMessageMetadataPassthrough> {
        match self {
            Self::Message {
                internal_chat_message_metadata_passthrough: metadata,
                ..
            }
            | Self::AgentMessage {
                internal_chat_message_metadata_passthrough: metadata,
                ..
            }
            | Self::Reasoning {
                internal_chat_message_metadata_passthrough: metadata,
                ..
            }
            | Self::LocalShellCall {
                internal_chat_message_metadata_passthrough: metadata,
                ..
            }
            | Self::FunctionCall {
                internal_chat_message_metadata_passthrough: metadata,
                ..
            }
            | Self::ToolSearchCall {
                internal_chat_message_metadata_passthrough: metadata,
                ..
            }
            | Self::FunctionCallOutput {
                internal_chat_message_metadata_passthrough: metadata,
                ..
            }
            | Self::CustomToolCall {
                internal_chat_message_metadata_passthrough: metadata,
                ..
            }
            | Self::CustomToolCallOutput {
                internal_chat_message_metadata_passthrough: metadata,
                ..
            }
            | Self::ToolSearchOutput {
                internal_chat_message_metadata_passthrough: metadata,
                ..
            }
            | Self::WebSearchCall {
                internal_chat_message_metadata_passthrough: metadata,
                ..
            }
            | Self::ImageGenerationCall {
                internal_chat_message_metadata_passthrough: metadata,
                ..
            }
            | Self::Compaction {
                internal_chat_message_metadata_passthrough: metadata,
                ..
            }
            | Self::ContextCompaction {
                internal_chat_message_metadata_passthrough: metadata,
                ..
            } => metadata.as_ref(),
            Self::CompactionTrigger { .. } | Self::AdditionalTools { .. } | Self::Other => None,
        }
    }

    fn internal_chat_message_metadata_passthrough_mut(
        &mut self,
    ) -> Option<&mut Option<InternalChatMessageMetadataPassthrough>> {
        match self {
            Self::Message {
                internal_chat_message_metadata_passthrough: metadata,
                ..
            }
            | Self::AgentMessage {
                internal_chat_message_metadata_passthrough: metadata,
                ..
            }
            | Self::Reasoning {
                internal_chat_message_metadata_passthrough: metadata,
                ..
            }
            | Self::LocalShellCall {
                internal_chat_message_metadata_passthrough: metadata,
                ..
            }
            | Self::FunctionCall {
                internal_chat_message_metadata_passthrough: metadata,
                ..
            }
            | Self::ToolSearchCall {
                internal_chat_message_metadata_passthrough: metadata,
                ..
            }
            | Self::FunctionCallOutput {
                internal_chat_message_metadata_passthrough: metadata,
                ..
            }
            | Self::CustomToolCall {
                internal_chat_message_metadata_passthrough: metadata,
                ..
            }
            | Self::CustomToolCallOutput {
                internal_chat_message_metadata_passthrough: metadata,
                ..
            }
            | Self::ToolSearchOutput {
                internal_chat_message_metadata_passthrough: metadata,
                ..
            }
            | Self::WebSearchCall {
                internal_chat_message_metadata_passthrough: metadata,
                ..
            }
            | Self::ImageGenerationCall {
                internal_chat_message_metadata_passthrough: metadata,
                ..
            }
            | Self::Compaction {
                internal_chat_message_metadata_passthrough: metadata,
                ..
            }
            | Self::ContextCompaction {
                internal_chat_message_metadata_passthrough: metadata,
                ..
            } => Some(metadata),
            Self::CompactionTrigger { .. } | Self::AdditionalTools { .. } | Self::Other => None,
        }
    }
}

/// 默认的 base instructions 内容（来自 `prompts/base_instructions/default.md`）。
pub const BASE_INSTRUCTIONS_DEFAULT: &str = include_str!("prompts/base_instructions/default.md");

/// thread 中提供给 model 的 base instructions，对应 Responses API 的
/// `instructions` 字段。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema, TS)]
#[serde(rename = "base_instructions", rename_all = "snake_case")]
pub struct BaseInstructions {
    /// base instructions 文本内容。
    pub text: String,
}

impl Default for BaseInstructions {
    fn default() -> Self {
        Self {
            text: BASE_INSTRUCTIONS_DEFAULT.to_string(),
        }
    }
}

const MAX_RENDERED_PREFIXES: usize = 100;
const MAX_ALLOW_PREFIX_TEXT_BYTES: usize = 5000;
const TRUNCATED_MARKER: &str = "...\n[Some commands were truncated]";

pub fn format_allow_prefixes(prefixes: Vec<Vec<String>>) -> Option<String> {
    let mut truncated = false;
    if prefixes.len() > MAX_RENDERED_PREFIXES {
        truncated = true;
    }

    let mut prefixes = prefixes;
    prefixes.sort_by(|a, b| {
        a.len()
            .cmp(&b.len())
            .then_with(|| prefix_combined_str_len(a).cmp(&prefix_combined_str_len(b)))
            .then_with(|| a.cmp(b))
    });

    let full_text = prefixes
        .into_iter()
        .take(MAX_RENDERED_PREFIXES)
        .map(|prefix| format!("- {}", render_command_prefix(&prefix)))
        .collect::<Vec<_>>()
        .join("\n");

    // 截断到最后一个完整的 UTF-8 字符边界
    let mut output = full_text;
    let byte_idx = output
        .char_indices()
        .nth(MAX_ALLOW_PREFIX_TEXT_BYTES)
        .map(|(i, _)| i);
    if let Some(byte_idx) = byte_idx {
        truncated = true;
        output = output[..byte_idx].to_string();
    }

    if truncated {
        Some(format!("{output}{TRUNCATED_MARKER}"))
    } else {
        Some(output)
    }
}

fn prefix_combined_str_len(prefix: &[String]) -> usize {
    prefix.iter().map(String::len).sum()
}

fn render_command_prefix(prefix: &[String]) -> String {
    let tokens = prefix
        .iter()
        .map(|token| serde_json::to_string(token).unwrap_or_else(|_| format!("{token:?}")))
        .collect::<Vec<_>>()
        .join(", ");
    format!("[{tokens}]")
}

fn should_serialize_reasoning_content(content: &Option<Vec<ReasoningItemContent>>) -> bool {
    match content {
        Some(content) => !content
            .iter()
            .any(|c| matches!(c, ReasoningItemContent::ReasoningText { .. })),
        None => false,
    }
}

fn local_image_error_placeholder(
    path: &std::path::Path,
    error: impl std::fmt::Display,
) -> ContentItem {
    ContentItem::InputText {
        text: format!(
            "Codex could not read the local image at `{}`: {}",
            path.display(),
            error
        ),
    }
}

pub const VIEW_IMAGE_TOOL_NAME: &str = "view_image";

const IMAGE_OPEN_TAG: &str = "<image>";
const IMAGE_CLOSE_TAG: &str = "</image>";
const LOCAL_IMAGE_OPEN_TAG_PREFIX: &str = "<image name=";
const LOCAL_IMAGE_OPEN_TAG_SUFFIX: &str = ">";
const LOCAL_IMAGE_CLOSE_TAG: &str = IMAGE_CLOSE_TAG;

pub fn image_open_tag_text() -> String {
    IMAGE_OPEN_TAG.to_string()
}

pub fn image_close_tag_text() -> String {
    IMAGE_CLOSE_TAG.to_string()
}

pub fn local_image_label_text(label_number: usize) -> String {
    format!("[Image #{label_number}]")
}

pub fn local_image_open_tag_text_with_path(label_number: usize, path: &std::path::Path) -> String {
    let label = local_image_label_text(label_number);
    let path = path.display();
    format!("{LOCAL_IMAGE_OPEN_TAG_PREFIX}{label} path=\"{path}\"{LOCAL_IMAGE_OPEN_TAG_SUFFIX}")
}

pub fn is_local_image_open_tag_text(text: &str) -> bool {
    text.strip_prefix(LOCAL_IMAGE_OPEN_TAG_PREFIX)
        .is_some_and(|rest| rest.ends_with(LOCAL_IMAGE_OPEN_TAG_SUFFIX))
}

pub fn is_local_image_close_tag_text(text: &str) -> bool {
    is_image_close_tag_text(text)
}

pub fn is_image_open_tag_text(text: &str) -> bool {
    text == IMAGE_OPEN_TAG
}

pub fn is_image_close_tag_text(text: &str) -> bool {
    text == IMAGE_CLOSE_TAG
}

fn invalid_image_error_placeholder(
    path: &std::path::Path,
    error: impl std::fmt::Display,
) -> ContentItem {
    ContentItem::InputText {
        text: format!(
            "Image located at `{}` is invalid: {}",
            path.display(),
            error
        ),
    }
}

fn unsupported_image_error_placeholder(path: &std::path::Path, mime: &str) -> ContentItem {
    ContentItem::InputText {
        text: format!(
            "Codex cannot attach image at `{}`: unsupported image `{}`.",
            path.display(),
            mime
        ),
    }
}

pub fn local_image_content_items_with_label_number(
    path: &std::path::Path,
    file_bytes: Vec<u8>,
    label_number: Option<usize>,
    detail: ImageDetail,
) -> Vec<ContentItem> {
    let mode = match detail {
        ImageDetail::Original => PromptImageMode::Original,
        ImageDetail::Auto | ImageDetail::Low | ImageDetail::High => PromptImageMode::ResizeToFit,
    };

    match load_for_prompt_bytes(path, file_bytes, mode) {
        Ok(image) => local_image_content_items(path, image.into_data_url(), label_number, detail),
        Err(err) => match &err {
            ImageProcessingError::Read { .. }
            | ImageProcessingError::Encode { .. }
            | ImageProcessingError::InvalidDataUrl { .. }
            | ImageProcessingError::ImageTooLarge { .. } => {
                vec![local_image_error_placeholder(path, &err)]
            }
            ImageProcessingError::Decode { .. } if err.is_invalid_image() => {
                vec![invalid_image_error_placeholder(path, &err)]
            }
            ImageProcessingError::Decode { .. } => {
                vec![local_image_error_placeholder(path, &err)]
            }
            ImageProcessingError::UnsupportedImageFormat { mime } => {
                vec![unsupported_image_error_placeholder(path, mime)]
            }
        },
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalImagePreparation {
    Process,
    Defer,
}

fn local_image_content_items(
    path: &std::path::Path,
    image_url: String,
    label_number: Option<usize>,
    detail: ImageDetail,
) -> Vec<ContentItem> {
    let mut items = Vec::with_capacity(3);
    if let Some(label_number) = label_number {
        items.push(ContentItem::InputText {
            text: local_image_open_tag_text_with_path(label_number, path),
        });
    }
    items.push(ContentItem::InputImage {
        image_url,
        detail: Some(detail),
    });
    if label_number.is_some() {
        items.push(ContentItem::InputText {
            text: LOCAL_IMAGE_CLOSE_TAG.to_string(),
        });
    }
    items
}

impl From<ResponseInputItem> for ResponseItem {
    fn from(item: ResponseInputItem) -> Self {
        match item {
            ResponseInputItem::Message {
                role,
                content,
                phase,
            } => Self::Message {
                role,
                content,
                id: None,
                phase,
                internal_chat_message_metadata_passthrough: None,
            },
            ResponseInputItem::FunctionCallOutput { call_id, output } => Self::FunctionCallOutput {
                id: None,
                call_id,
                output,
                internal_chat_message_metadata_passthrough: None,
            },
            ResponseInputItem::McpToolCallOutput { call_id, output } => {
                let output = output.into_function_call_output_payload();
                Self::FunctionCallOutput {
                    id: None,
                    call_id,
                    output,
                    internal_chat_message_metadata_passthrough: None,
                }
            }
            ResponseInputItem::CustomToolCallOutput {
                call_id,
                name,
                output,
            } => Self::CustomToolCallOutput {
                id: None,
                call_id,
                name,
                output,
                internal_chat_message_metadata_passthrough: None,
            },
            ResponseInputItem::ToolSearchOutput {
                call_id,
                status,
                execution,
                tools,
            } => Self::ToolSearchOutput {
                call_id: Some(call_id),
                status,
                execution,
                tools,
                id: None,
                internal_chat_message_metadata_passthrough: None,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum LocalShellStatus {
    Completed,
    InProgress,
    Incomplete,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LocalShellAction {
    Exec(LocalShellExecAction),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema, TS)]
pub struct LocalShellExecAction {
    pub command: Vec<String>,
    pub timeout_ms: Option<u64>,
    pub working_directory: Option<String>,
    pub env: Option<HashMap<String, String>>,
    pub user: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[schemars(rename = "ResponsesApiWebSearchAction")]
pub enum WebSearchAction {
    Search {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        query: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        queries: Option<Vec<String>>,
    },
    OpenPage {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        url: Option<String>,
    },
    FindInPage {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pattern: Option<String>,
    },

    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ReasoningItemReasoningSummary {
    SummaryText { text: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ReasoningItemContent {
    ReasoningText { text: String },
    Text { text: String },
}

impl From<Vec<UserInput>> for ResponseInputItem {
    fn from(items: Vec<UserInput>) -> Self {
        Self::from_user_input(items, LocalImagePreparation::Process)
    }
}

impl ResponseInputItem {
    pub fn from_user_input(
        items: Vec<UserInput>,
        local_image_preparation: LocalImagePreparation,
    ) -> Self {
        let mut image_index = 0;
        Self::Message {
            role: "user".to_string(),
            content: items
                .into_iter()
                .flat_map(|c| match c {
                    UserInput::Text { text, .. } => vec![ContentItem::InputText { text }],
                    UserInput::Image {
                        image_url, detail, ..
                    } => {
                        image_index += 1;
                        let detail = detail.unwrap_or(DEFAULT_IMAGE_DETAIL);
                        vec![ContentItem::InputImage {
                            image_url,
                            detail: Some(detail),
                        }]
                    }
                    UserInput::LocalImage { path, detail, .. } => {
                        image_index += 1;
                        let detail = detail.unwrap_or(DEFAULT_IMAGE_DETAIL);
                        match std::fs::read(&path) {
                            Ok(file_bytes) => match local_image_preparation {
                                LocalImagePreparation::Process => {
                                    local_image_content_items_with_label_number(
                                        &path,
                                        file_bytes,
                                        Some(image_index),
                                        detail,
                                    )
                                }
                                LocalImagePreparation::Defer => local_image_content_items(
                                    &path,
                                    data_url_from_bytes("application/octet-stream", &file_bytes),
                                    Some(image_index),
                                    detail,
                                ),
                            },
                            Err(err) => vec![local_image_error_placeholder(&path, err)],
                        }
                    }
                    UserInput::Skill { .. } | UserInput::Mention { .. } => Vec::new(), // Tool bodies are injected later in core
                })
                .collect::<Vec<ContentItem>>(),
            phase: None,
        }
    }
}
/// 搜索 tool 调用参数。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
pub struct SearchToolCallParams {
    /// 搜索查询字符串。
    pub query: String,
    /// 结果数量上限（可选）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub limit: Option<usize>,
}

/// 当 `ResponseItem::FunctionCall` 的 `name` 为 `shell_command` 时，
/// `arguments` 字段应反序列化为此结构。
#[derive(Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
pub struct ShellCommandToolCallParams {
    /// 要执行的 shell 命令。
    pub command: String,
    /// 工作目录（可选）。
    pub workdir: Option<String>,

    /// 是否以 login shell 语义运行。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login: Option<bool>,
    /// 命令允许运行的最长时间（毫秒）。
    #[serde(alias = "timeout")]
    pub timeout_ms: Option<u64>,
    /// sandbox 权限覆盖。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sandbox_permissions: Option<SandboxPermissions>,
    /// 提议加入 execpolicy 的前缀规则 token 序列。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub prefix_rule: Option<Vec<String>>,
    /// 附加权限覆盖。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub additional_permissions: Option<AdditionalPermissionProfile>,
    /// 操作理由（可选）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub justification: Option<String>,
}

/// Responses API 兼容的 content item，可作为 tool call 的输出返回。
/// 这是 `ContentItem` 的子集，仅包含我们支持的 function call 输出类型。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FunctionCallOutputContentItem {
    // 注意：变体名不得修改，这些值会直接序列化后用于 Responses API。
    /// 纯文本内容。
    InputText {
        /// 文本内容。
        text: String,
    },
    // 注意：变体名不得修改，这些值会直接序列化后用于 Responses API。
    /// 图像内容。
    InputImage {
        /// 图像 URL（可以是 data URL）。
        image_url: String,
        /// 图像细节级别（可选）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        detail: Option<ImageDetail>,
    },
    /// 加密内容。
    EncryptedContent {
        /// 加密内容字符串。
        encrypted_content: String,
    },
}

/// 将结构化的 function-call 输出内容转换为纯文本，用于人类可读的展示场景。
///
/// 此转换是有意 lossy 的：
/// - 仅包含 `input_text` 条目
/// - 图像条目会被忽略
///
/// 调用方仍需要字符串表示时（例如 telemetry 预览或旧版仅支持字符串的输出
/// 路径）使用此 helper，同时保留原始的多模态 `content_items` 作为发送给
/// model 的权威 payload。
pub fn function_call_output_content_items_to_text(
    content_items: &[FunctionCallOutputContentItem],
) -> Option<String> {
    let text_segments = content_items
        .iter()
        .filter_map(|item| match item {
            FunctionCallOutputContentItem::InputText { text } if !text.trim().is_empty() => {
                Some(text.as_str())
            }
            FunctionCallOutputContentItem::InputText { .. }
            | FunctionCallOutputContentItem::InputImage { .. }
            | FunctionCallOutputContentItem::EncryptedContent { .. } => None,
        })
        .collect::<Vec<_>>();

    if text_segments.is_empty() {
        None
    } else {
        Some(text_segments.join("\n"))
    }
}

impl From<crate::dynamic_tools::DynamicToolCallOutputContentItem>
    for FunctionCallOutputContentItem
{
    fn from(item: crate::dynamic_tools::DynamicToolCallOutputContentItem) -> Self {
        match item {
            crate::dynamic_tools::DynamicToolCallOutputContentItem::InputText { text } => {
                Self::InputText { text }
            }
            crate::dynamic_tools::DynamicToolCallOutputContentItem::InputImage { image_url } => {
                Self::InputImage {
                    image_url,
                    detail: Some(DEFAULT_IMAGE_DETAIL),
                }
            }
        }
    }
}

/// 向 OpenAI 上报 tool call 结果时使用的 payload。
///
/// `body` 直接序列化为 `function_call_output.output` 的 wire 值；
/// `success` 仅作为内部元数据供下游处理使用。
#[derive(Debug, Default, Clone, PartialEq, JsonSchema, TS)]
pub struct FunctionCallOutputPayload {
    /// tool call 输出主体。
    pub body: FunctionCallOutputBody,
    /// 是否成功（内部元数据）。
    pub success: Option<bool>,
}

/// function call 输出主体，可以是纯文本或多模态 content item 列表。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema, TS)]
#[serde(untagged)]
pub enum FunctionCallOutputBody {
    /// 纯文本输出。
    Text(String),
    /// 多模态 content item 列表。
    ContentItems(Vec<FunctionCallOutputContentItem>),
}

impl FunctionCallOutputBody {
    /// 将 function-call 输出主体尽力转换为纯文本，用于人类可读的展示场景。
    ///
    /// 当 body 为 content item 列表时，此转换是有意 lossy 的：图像条目会被
    /// 丢弃，文本条目会用换行符连接。
    pub fn to_text(&self) -> Option<String> {
        match self {
            Self::Text(content) => Some(content.clone()),
            Self::ContentItems(items) => function_call_output_content_items_to_text(items),
        }
    }
}

impl Default for FunctionCallOutputBody {
    fn default() -> Self {
        Self::Text(String::new())
    }
}

impl FunctionCallOutputPayload {
    pub fn from_text(content: String) -> Self {
        Self {
            body: FunctionCallOutputBody::Text(content),
            success: None,
        }
    }

    pub fn from_content_items(content_items: Vec<FunctionCallOutputContentItem>) -> Self {
        Self {
            body: FunctionCallOutputBody::ContentItems(content_items),
            success: None,
        }
    }

    pub fn text_content(&self) -> Option<&str> {
        match &self.body {
            FunctionCallOutputBody::Text(content) => Some(content),
            FunctionCallOutputBody::ContentItems(_) => None,
        }
    }

    pub fn text_content_mut(&mut self) -> Option<&mut String> {
        match &mut self.body {
            FunctionCallOutputBody::Text(content) => Some(content),
            FunctionCallOutputBody::ContentItems(_) => None,
        }
    }

    pub fn content_items(&self) -> Option<&[FunctionCallOutputContentItem]> {
        match &self.body {
            FunctionCallOutputBody::Text(_) => None,
            FunctionCallOutputBody::ContentItems(items) => Some(items),
        }
    }

    pub fn content_items_mut(&mut self) -> Option<&mut Vec<FunctionCallOutputContentItem>> {
        match &mut self.body {
            FunctionCallOutputBody::Text(_) => None,
            FunctionCallOutputBody::ContentItems(items) => Some(items),
        }
    }
}

// `function_call_output.output` is encoded as either:
//   - an array of structured content items
//   - a plain string
impl Serialize for FunctionCallOutputPayload {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match &self.body {
            FunctionCallOutputBody::Text(content) => serializer.serialize_str(content),
            FunctionCallOutputBody::ContentItems(items) => items.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for FunctionCallOutputPayload {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let body = FunctionCallOutputBody::deserialize(deserializer)?;
        Ok(FunctionCallOutputPayload {
            body,
            success: None,
        })
    }
}

impl CallToolResult {
    pub fn from_result(result: Result<Self, String>) -> Self {
        match result {
            Ok(result) => result,
            Err(error) => Self::from_error_text(error),
        }
    }

    pub fn from_error_text(text: String) -> Self {
        Self {
            content: vec![serde_json::json!({
                "type": "text",
                "text": text,
            })],
            structured_content: None,
            is_error: Some(true),
            meta: None,
        }
    }

    pub fn success(&self) -> bool {
        self.is_error != Some(true)
    }

    pub fn as_function_call_output_payload(&self) -> FunctionCallOutputPayload {
        if let Some(structured_content) = &self.structured_content
            && !structured_content.is_null()
        {
            match serde_json::to_string(structured_content) {
                Ok(serialized_structured_content) => {
                    return FunctionCallOutputPayload {
                        body: FunctionCallOutputBody::Text(serialized_structured_content),
                        success: Some(self.success()),
                    };
                }
                Err(err) => {
                    return FunctionCallOutputPayload {
                        body: FunctionCallOutputBody::Text(err.to_string()),
                        success: Some(false),
                    };
                }
            }
        }

        let serialized_content = match serde_json::to_string(&self.content) {
            Ok(serialized_content) => serialized_content,
            Err(err) => {
                return FunctionCallOutputPayload {
                    body: FunctionCallOutputBody::Text(err.to_string()),
                    success: Some(false),
                };
            }
        };

        let content_items = convert_mcp_content_to_items(&self.content);

        let body = match content_items {
            Some(content_items) => FunctionCallOutputBody::ContentItems(content_items),
            None => FunctionCallOutputBody::Text(serialized_content),
        };

        FunctionCallOutputPayload {
            body,
            success: Some(self.success()),
        }
    }

    pub fn into_function_call_output_payload(self) -> FunctionCallOutputPayload {
        self.as_function_call_output_payload()
    }
}

fn convert_mcp_content_to_items(
    contents: &[serde_json::Value],
) -> Option<Vec<FunctionCallOutputContentItem>> {
    const CODEX_IMAGE_DETAIL_META_KEY: &str = "codex/imageDetail";

    #[derive(serde::Deserialize)]
    #[serde(tag = "type")]
    enum McpContent {
        #[serde(rename = "text")]
        Text { text: String },
        #[serde(rename = "image")]
        Image {
            data: String,
            #[serde(rename = "mimeType", alias = "mime_type")]
            mime_type: Option<String>,
            #[serde(rename = "_meta", default)]
            meta: Option<serde_json::Value>,
        },
        #[serde(other)]
        Unknown,
    }

    let mut saw_image = false;
    let mut items = Vec::with_capacity(contents.len());

    for content in contents {
        let item = match serde_json::from_value::<McpContent>(content.clone()) {
            Ok(McpContent::Text { text }) => FunctionCallOutputContentItem::InputText { text },
            Ok(McpContent::Image {
                data,
                mime_type,
                meta,
            }) => {
                saw_image = true;
                let image_url = if data.starts_with("data:") {
                    data
                } else {
                    let mime_type = mime_type.unwrap_or_else(|| "application/octet-stream".into());
                    format!("data:{mime_type};base64,{data}")
                };
                FunctionCallOutputContentItem::InputImage {
                    image_url,
                    detail: meta
                        .as_ref()
                        .and_then(serde_json::Value::as_object)
                        .and_then(|meta| meta.get(CODEX_IMAGE_DETAIL_META_KEY))
                        .and_then(serde_json::Value::as_str)
                        .and_then(|detail| match detail {
                            "auto" => Some(ImageDetail::Auto),
                            "low" => Some(ImageDetail::Low),
                            "high" => Some(ImageDetail::High),
                            "original" => Some(ImageDetail::Original),
                            _ => None,
                        })
                        .or(Some(DEFAULT_IMAGE_DETAIL)),
                }
            }
            Ok(McpContent::Unknown) | Err(_) => FunctionCallOutputContentItem::InputText {
                text: serde_json::to_string(content).unwrap_or_else(|_| "<content>".to_string()),
            },
        };
        items.push(item);
    }

    if saw_image { Some(items) } else { None }
}

// 为 payload 实现 Display，使调用方在日志记录或在测试中做简单子串检查时
// （现有测试对 output 调用 `.contains()`）可将其当作普通字符串处理。
// 对 `ContentItems` 变体，Display 输出 JSON 表示。

impl std::fmt::Display for FunctionCallOutputPayload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.body {
            FunctionCallOutputBody::Text(content) => f.write_str(content),
            FunctionCallOutputBody::ContentItems(items) => {
                let content = serde_json::to_string(items).unwrap_or_default();
                f.write_str(content.as_str())
            }
        }
    }
}

// （已将 event 映射逻辑移至 codex-core，避免 protocol 与 UI 事件耦合。）

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;
    use codex_execpolicy::Policy;
    use pretty_assertions::assert_eq;
    use std::path::PathBuf;
    use tempfile::tempdir;

    // 一个极小的合法 PNG（1x1），避免图像转换测试依赖跨 crate 的文件路径，
    // 这在 Bazel 沙盒化下会出问题。
    const TINY_PNG_BYTES: &[u8] = &[
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6,
        0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 11, 73, 68, 65, 84, 120, 156, 99, 96, 0, 2, 0, 0, 5, 0,
        1, 122, 94, 171, 63, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ];

    #[test]
    fn plaintext_agent_message_content_rejects_mixed_encrypted_content() {
        let content = vec![
            AgentMessageInputContent::InputText {
                text: "Message Type: MESSAGE\nPayload:\n".to_string(),
            },
            AgentMessageInputContent::EncryptedContent {
                encrypted_content: "encrypted-payload".to_string(),
            },
        ];

        assert_eq!(plaintext_agent_message_content(&content), None);
    }

    #[test]
    fn response_input_message_conversion_preserves_phase() {
        let item = ResponseItem::from(ResponseInputItem::Message {
            role: "assistant".to_string(),
            content: vec![ContentItem::OutputText {
                text: "still working".to_string(),
            }],
            phase: Some(MessagePhase::Commentary),
        });

        assert_eq!(
            item,
            ResponseItem::Message {
                id: None,
                role: "assistant".to_string(),
                content: vec![ContentItem::OutputText {
                    text: "still working".to_string(),
                }],
                phase: Some(MessagePhase::Commentary),
                internal_chat_message_metadata_passthrough: None,
            }
        );
    }

    #[test]
    fn response_item_passthrough_metadata_round_trips_and_stamps_turn_ids() -> Result<()> {
        let mut item =
            response_item_with_passthrough_metadata(Some(passthrough_metadata("turn-1")));
        let round_trip: ResponseItem = serde_json::from_value(serde_json::to_value(&item)?)?;
        assert_eq!(round_trip, item);

        let unknown_metadata: ResponseItem = serde_json::from_value(serde_json::json!({
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "hello"}],
            "internal_chat_message_metadata_passthrough": {
                "turn_id": "turn-1",
                "other": "ignored",
            },
        }))?;
        assert_eq!(unknown_metadata, item);

        item.set_turn_id_if_missing("turn-2");
        assert_eq!(item.turn_id(), Some("turn-1"));

        let mut empty_turn_id =
            response_item_with_passthrough_metadata(Some(passthrough_metadata("")));
        empty_turn_id.set_turn_id_if_missing("turn-1");
        assert_eq!(empty_turn_id.turn_id(), Some("turn-1"));

        let mut missing_turn_id = response_item_with_passthrough_metadata(
            /*internal_chat_message_metadata_passthrough*/ None,
        );
        missing_turn_id.set_turn_id_if_missing("");
        missing_turn_id.set_turn_id_if_missing("turn-1");
        assert_eq!(missing_turn_id.turn_id(), Some("turn-1"));

        let mut other = ResponseItem::Other;
        other.set_turn_id_if_missing("turn-1");
        assert_eq!(other.turn_id(), None);
        Ok(())
    }

    #[test]
    fn response_item_id_getter_and_setter() {
        let mut item = response_item_with_passthrough_metadata(
            /*internal_chat_message_metadata_passthrough*/ None,
        );
        assert_eq!(item.id(), None);

        item.set_id(Some("msg_test".to_string()));

        assert_eq!(item.id(), Some("msg_test"));

        item.set_id(/*new_id*/ None);

        assert_eq!(item.id(), None);

        let mut additional_tools = ResponseItem::AdditionalTools {
            id: None,
            role: "developer".to_string(),
            tools: Vec::new(),
        };
        additional_tools.set_id(Some("at_test".to_string()));
        assert_eq!(additional_tools.id(), Some("at_test"));
    }

    fn response_item_with_passthrough_metadata(
        internal_chat_message_metadata_passthrough: Option<InternalChatMessageMetadataPassthrough>,
    ) -> ResponseItem {
        ResponseItem::Message {
            id: None,
            role: "user".to_string(),
            content: vec![ContentItem::InputText {
                text: "hello".to_string(),
            }],
            phase: None,
            internal_chat_message_metadata_passthrough,
        }
    }

    fn passthrough_metadata(turn_id: &str) -> InternalChatMessageMetadataPassthrough {
        InternalChatMessageMetadataPassthrough {
            turn_id: Some(turn_id.to_string()),
        }
    }

    #[test]
    fn image_detail_roundtrips_all_wire_values() -> Result<()> {
        assert_eq!(
            serde_json::from_str::<ImageDetail>("\"auto\"")?,
            ImageDetail::Auto
        );
        assert_eq!(
            serde_json::from_str::<ImageDetail>("\"low\"")?,
            ImageDetail::Low
        );
        assert_eq!(serde_json::to_string(&ImageDetail::Auto)?, "\"auto\"");
        assert_eq!(serde_json::to_string(&ImageDetail::Low)?, "\"low\"");

        let content_item: ContentItem = serde_json::from_value(serde_json::json!({
            "type": "input_image",
            "image_url": "data:image/png;base64,abc",
            "detail": "auto",
        }))?;

        assert_eq!(
            content_item,
            ContentItem::InputImage {
                image_url: "data:image/png;base64,abc".to_string(),
                detail: Some(ImageDetail::Auto),
            }
        );

        Ok(())
    }

    #[test]
    fn sandbox_permissions_helpers_match_documented_semantics() {
        let cases = [
            (SandboxPermissions::UseDefault, false, false, false),
            (SandboxPermissions::RequireEscalated, true, true, false),
            (
                SandboxPermissions::WithAdditionalPermissions,
                false,
                true,
                true,
            ),
        ];

        for (
            sandbox_permissions,
            requires_escalated_permissions,
            requests_sandbox_override,
            uses_additional_permissions,
        ) in cases
        {
            assert_eq!(
                sandbox_permissions.requires_escalated_permissions(),
                requires_escalated_permissions
            );
            assert_eq!(
                sandbox_permissions.requests_sandbox_override(),
                requests_sandbox_override
            );
            assert_eq!(
                sandbox_permissions.uses_additional_permissions(),
                uses_additional_permissions
            );
        }
    }

    #[test]
    fn convert_mcp_content_to_items_preserves_data_urls() {
        let contents = vec![serde_json::json!({
            "type": "image",
            "data": "data:image/png;base64,Zm9v",
            "mimeType": "image/png",
        })];

        let items = convert_mcp_content_to_items(&contents).expect("expected image items");
        assert_eq!(
            items,
            vec![FunctionCallOutputContentItem::InputImage {
                image_url: "data:image/png;base64,Zm9v".to_string(),
                detail: Some(DEFAULT_IMAGE_DETAIL),
            }]
        );
    }

    #[test]
    fn response_item_parses_image_generation_call() {
        let item = serde_json::from_value::<ResponseItem>(serde_json::json!({
            "id": "ig_123",
            "type": "image_generation_call",
            "status": "completed",
            "revised_prompt": "A small blue square",
            "result": "Zm9v",
        }))
        .expect("image generation item should deserialize");

        assert_eq!(
            item,
            ResponseItem::ImageGenerationCall {
                id: Some("ig_123".to_string()),
                status: "completed".to_string(),
                revised_prompt: Some("A small blue square".to_string()),
                result: "Zm9v".to_string(),
                internal_chat_message_metadata_passthrough: None,
            }
        );
    }

    #[test]
    fn response_item_parses_image_generation_call_without_revised_prompt() {
        let item = serde_json::from_value::<ResponseItem>(serde_json::json!({
            "id": "ig_123",
            "type": "image_generation_call",
            "status": "completed",
            "result": "Zm9v",
        }))
        .expect("image generation item should deserialize");

        assert_eq!(
            item,
            ResponseItem::ImageGenerationCall {
                id: Some("ig_123".to_string()),
                status: "completed".to_string(),
                revised_prompt: None,
                result: "Zm9v".to_string(),
                internal_chat_message_metadata_passthrough: None,
            }
        );
    }

    #[test]
    fn additional_permission_profile_is_empty_when_all_fields_are_none() {
        assert_eq!(AdditionalPermissionProfile::default().is_empty(), true);
    }

    #[test]
    fn additional_permission_profile_is_not_empty_when_field_is_present_but_nested_empty() {
        let permission_profile = AdditionalPermissionProfile {
            network: Some(NetworkPermissions { enabled: None }),
            file_system: None,
        };
        assert_eq!(permission_profile.is_empty(), false);
    }

    #[test]
    fn permission_profile_round_trip_preserves_glob_scan_max_depth() {
        let mut file_system_sandbox_policy =
            FileSystemSandboxPolicy::restricted(vec![FileSystemSandboxEntry {
                path: FileSystemPath::GlobPattern {
                    pattern: "**/*.env".to_string(),
                },
                access: FileSystemAccessMode::Deny,
            }]);
        file_system_sandbox_policy.glob_scan_max_depth = Some(2);

        let permission_profile = PermissionProfile::from_runtime_permissions(
            &file_system_sandbox_policy,
            NetworkSandboxPolicy::Restricted,
        );

        assert_eq!(
            permission_profile.file_system_sandbox_policy(),
            file_system_sandbox_policy
        );
    }

    #[test]
    fn permission_profile_deserializes_legacy_rollout_shape() -> Result<()> {
        let legacy = serde_json::json!({
            "network": {
                "enabled": true,
            },
            "file_system": {
                "entries": [{
                    "path": {
                        "type": "special",
                        "value": {
                            "kind": "root",
                        },
                    },
                    "access": "write",
                }],
                "glob_scan_max_depth": 2,
            },
        });

        let permission_profile: PermissionProfile = serde_json::from_value(legacy)?;

        assert_eq!(
            permission_profile,
            PermissionProfile::Managed {
                file_system: ManagedFileSystemPermissions::Restricted {
                    entries: vec![FileSystemSandboxEntry {
                        path: FileSystemPath::Special {
                            value: FileSystemSpecialPath::Root,
                        },
                        access: FileSystemAccessMode::Write,
                    }],
                    glob_scan_max_depth: NonZeroUsize::new(2),
                },
                network: NetworkSandboxPolicy::Enabled,
            }
        );
        Ok(())
    }

    #[test]
    fn permission_profile_presets_match_legacy_defaults() {
        assert_eq!(
            PermissionProfile::read_only(),
            PermissionProfile::from_legacy_sandbox_policy(&SandboxPolicy::new_read_only_policy())
        );
        assert_eq!(
            PermissionProfile::workspace_write(),
            PermissionProfile::from_legacy_sandbox_policy(
                &SandboxPolicy::new_workspace_write_policy()
            )
        );
    }

    #[test]
    fn permission_profile_round_trip_preserves_disabled_sandbox() -> Result<()> {
        let cwd = tempdir()?;
        let permission_profile =
            PermissionProfile::from_legacy_sandbox_policy(&SandboxPolicy::DangerFullAccess);

        assert_eq!(permission_profile, PermissionProfile::Disabled);
        assert_eq!(
            permission_profile.to_legacy_sandbox_policy(cwd.path())?,
            SandboxPolicy::DangerFullAccess
        );
        assert_eq!(
            permission_profile.to_runtime_permissions(),
            (
                FileSystemSandboxPolicy::unrestricted(),
                NetworkSandboxPolicy::Enabled
            )
        );
        Ok(())
    }

    #[test]
    fn disabled_permission_profile_ignores_runtime_network_policy() {
        let permission_profile = PermissionProfile::from_runtime_permissions_with_enforcement(
            SandboxEnforcement::Disabled,
            &FileSystemSandboxPolicy::unrestricted(),
            NetworkSandboxPolicy::Restricted,
        );

        assert_eq!(permission_profile, PermissionProfile::Disabled);
    }

    #[test]
    fn permission_profile_from_runtime_permissions_preserves_external_sandbox() {
        let permission_profile = PermissionProfile::from_runtime_permissions(
            &FileSystemSandboxPolicy::external_sandbox(),
            NetworkSandboxPolicy::Restricted,
        );

        assert_eq!(
            permission_profile,
            PermissionProfile::External {
                network: NetworkSandboxPolicy::Restricted,
            }
        );
        assert_eq!(
            PermissionProfile::from_runtime_permissions_with_enforcement(
                SandboxEnforcement::Managed,
                &FileSystemSandboxPolicy::external_sandbox(),
                NetworkSandboxPolicy::Restricted,
            ),
            permission_profile,
        );
    }

    #[test]
    fn permission_profile_from_runtime_permissions_preserves_unrestricted_managed_network() {
        let permission_profile = PermissionProfile::from_runtime_permissions_with_enforcement(
            SandboxEnforcement::External,
            &FileSystemSandboxPolicy::unrestricted(),
            NetworkSandboxPolicy::Restricted,
        );

        assert_eq!(
            permission_profile,
            PermissionProfile::Managed {
                file_system: ManagedFileSystemPermissions::Unrestricted,
                network: NetworkSandboxPolicy::Restricted,
            },
            "the legacy ExternalSandbox projection must not hide a split unrestricted filesystem policy"
        );
        assert_eq!(
            permission_profile.to_runtime_permissions(),
            (
                FileSystemSandboxPolicy::unrestricted(),
                NetworkSandboxPolicy::Restricted,
            )
        );
    }

    #[test]
    fn permission_profile_round_trip_preserves_external_sandbox() -> Result<()> {
        let cwd = tempdir()?;
        let sandbox_policy = SandboxPolicy::ExternalSandbox {
            network_access: crate::protocol::NetworkAccess::Restricted,
        };
        let permission_profile = PermissionProfile::from_legacy_sandbox_policy(&sandbox_policy);

        assert_eq!(
            permission_profile,
            PermissionProfile::External {
                network: NetworkSandboxPolicy::Restricted,
            }
        );
        assert_eq!(
            permission_profile.to_legacy_sandbox_policy(cwd.path())?,
            sandbox_policy
        );
        assert_eq!(
            permission_profile.to_runtime_permissions(),
            (
                FileSystemSandboxPolicy::external_sandbox(),
                NetworkSandboxPolicy::Restricted
            )
        );
        Ok(())
    }

    #[test]
    fn file_system_permissions_with_glob_scan_depth_uses_canonical_json() -> Result<()> {
        let path = AbsolutePathBuf::try_from(PathBuf::from(if cfg!(windows) {
            r"C:\tmp\allowed"
        } else {
            "/tmp/allowed"
        }))
        .expect("absolute path");
        let file_system_permissions = FileSystemPermissions {
            entries: vec![FileSystemSandboxEntry {
                path: FileSystemPath::Path { path },
                access: FileSystemAccessMode::Read,
            }],
            glob_scan_max_depth: NonZeroUsize::new(2),
        };

        let serialized = serde_json::to_value(&file_system_permissions)?;

        assert_eq!(serialized.get("read"), None);
        assert_eq!(serialized.get("write"), None);
        assert_eq!(
            serialized.get("glob_scan_max_depth"),
            Some(&serde_json::json!(2))
        );
        assert!(serialized.get("entries").is_some());
        assert_eq!(
            serde_json::from_value::<FileSystemPermissions>(serialized)?,
            file_system_permissions
        );
        Ok(())
    }

    #[test]
    fn file_system_permissions_rejects_zero_glob_scan_depth() {
        serde_json::from_value::<FileSystemPermissions>(serde_json::json!({
            "entries": [],
            "glob_scan_max_depth": 0,
        }))
        .expect_err("zero glob scan depth should fail deserialization");
    }

    #[test]
    fn convert_mcp_content_to_items_builds_data_urls_when_missing_prefix() {
        let contents = vec![serde_json::json!({
            "type": "image",
            "data": "Zm9v",
            "mimeType": "image/png",
        })];

        let items = convert_mcp_content_to_items(&contents).expect("expected image items");
        assert_eq!(
            items,
            vec![FunctionCallOutputContentItem::InputImage {
                image_url: "data:image/png;base64,Zm9v".to_string(),
                detail: Some(DEFAULT_IMAGE_DETAIL),
            }]
        );
    }

    #[test]
    fn convert_mcp_content_to_items_returns_none_without_images() {
        let contents = vec![serde_json::json!({
            "type": "text",
            "text": "hello",
        })];

        assert_eq!(convert_mcp_content_to_items(&contents), None);
    }

    #[test]
    fn function_call_output_content_items_to_text_joins_text_segments() {
        let content_items = vec![
            FunctionCallOutputContentItem::InputText {
                text: "line 1".to_string(),
            },
            FunctionCallOutputContentItem::InputImage {
                image_url: "data:image/png;base64,AAA".to_string(),
                detail: Some(DEFAULT_IMAGE_DETAIL),
            },
            FunctionCallOutputContentItem::InputText {
                text: "line 2".to_string(),
            },
        ];

        let text = function_call_output_content_items_to_text(&content_items);
        assert_eq!(text, Some("line 1\nline 2".to_string()));
    }

    #[test]
    fn function_call_output_content_items_to_text_ignores_blank_text_and_images() {
        let content_items = vec![
            FunctionCallOutputContentItem::InputText {
                text: "   ".to_string(),
            },
            FunctionCallOutputContentItem::InputImage {
                image_url: "data:image/png;base64,AAA".to_string(),
                detail: Some(DEFAULT_IMAGE_DETAIL),
            },
            FunctionCallOutputContentItem::EncryptedContent {
                encrypted_content: "enc_opaque".to_string(),
            },
        ];

        let text = function_call_output_content_items_to_text(&content_items);
        assert_eq!(text, None);
    }

    #[test]
    fn function_call_output_body_to_text_returns_plain_text_content() {
        let body = FunctionCallOutputBody::Text("ok".to_string());
        let text = body.to_text();
        assert_eq!(text, Some("ok".to_string()));
    }

    #[test]
    fn function_call_output_body_to_text_uses_content_item_fallback() {
        let body = FunctionCallOutputBody::ContentItems(vec![
            FunctionCallOutputContentItem::InputText {
                text: "line 1".to_string(),
            },
            FunctionCallOutputContentItem::InputImage {
                image_url: "data:image/png;base64,AAA".to_string(),
                detail: Some(DEFAULT_IMAGE_DETAIL),
            },
        ]);

        let text = body.to_text();
        assert_eq!(text, Some("line 1".to_string()));
    }

    #[test]
    fn function_call_deserializes_optional_namespace() {
        let item: ResponseItem = serde_json::from_value(serde_json::json!({
            "type": "function_call",
            "name": "mcp__codex_apps__gmail_get_recent_emails",
            "namespace": "mcp__codex_apps__gmail",
            "arguments": "{\"top_k\":5}",
            "call_id": "call-1",
        }))
        .expect("function_call should deserialize");

        assert_eq!(
            item,
            ResponseItem::FunctionCall {
                id: None,
                name: "mcp__codex_apps__gmail_get_recent_emails".to_string(),
                namespace: Some("mcp__codex_apps__gmail".to_string()),
                arguments: "{\"top_k\":5}".to_string(),
                call_id: "call-1".to_string(),
                internal_chat_message_metadata_passthrough: None,
            }
        );
    }

    #[test]
    fn render_command_prefix_list_sorts_by_len_then_total_len_then_alphabetical() {
        let prefixes = vec![
            vec!["b".to_string(), "zz".to_string()],
            vec!["aa".to_string()],
            vec!["b".to_string()],
            vec!["a".to_string(), "b".to_string(), "c".to_string()],
            vec!["a".to_string()],
            vec!["b".to_string(), "a".to_string()],
        ];

        let output = format_allow_prefixes(prefixes).expect("rendered list");
        assert_eq!(
            output,
            r#"- ["a"]
- ["b"]
- ["aa"]
- ["b", "a"]
- ["b", "zz"]
- ["a", "b", "c"]"#
                .to_string(),
        );
    }

    #[test]
    fn render_command_prefix_list_limits_output_to_max_prefixes() {
        let prefixes = (0..(MAX_RENDERED_PREFIXES + 5))
            .map(|i| vec![format!("{i:03}")])
            .collect::<Vec<_>>();

        let output = format_allow_prefixes(prefixes).expect("rendered list");
        assert_eq!(output.ends_with(TRUNCATED_MARKER), true);
        eprintln!("output: {output}");
        assert_eq!(output.lines().count(), MAX_RENDERED_PREFIXES + 1);
    }

    #[test]
    fn format_allow_prefixes_limits_output() {
        let mut exec_policy = Policy::empty();
        for i in 0..200 {
            exec_policy
                .add_prefix_rule(
                    &[format!("tool-{i:03}"), "x".repeat(500)],
                    codex_execpolicy::Decision::Allow,
                )
                .expect("add rule");
        }

        let output =
            format_allow_prefixes(exec_policy.get_allowed_prefixes()).expect("formatted prefixes");
        assert!(
            output.len() <= MAX_ALLOW_PREFIX_TEXT_BYTES + TRUNCATED_MARKER.len(),
            "output length exceeds expected limit: {output}",
        );
    }

    #[test]
    fn serializes_success_as_plain_string() -> Result<()> {
        let item = ResponseInputItem::FunctionCallOutput {
            call_id: "call1".into(),
            output: FunctionCallOutputPayload::from_text("ok".into()),
        };

        let json = serde_json::to_string(&item)?;
        let v: serde_json::Value = serde_json::from_str(&json)?;

        // 成功场景 -> output 应为纯字符串
        assert_eq!(v.get("output").unwrap().as_str().unwrap(), "ok");
        Ok(())
    }

    #[test]
    fn serializes_failure_as_string() -> Result<()> {
        let item = ResponseInputItem::FunctionCallOutput {
            call_id: "call1".into(),
            output: FunctionCallOutputPayload {
                body: FunctionCallOutputBody::Text("bad".into()),
                success: Some(false),
            },
        };

        let json = serde_json::to_string(&item)?;
        let v: serde_json::Value = serde_json::from_str(&json)?;

        assert_eq!(v.get("output").unwrap().as_str().unwrap(), "bad");
        Ok(())
    }

    #[test]
    fn serializes_image_outputs_as_array() -> Result<()> {
        let call_tool_result = CallToolResult {
            content: vec![
                serde_json::json!({"type":"text","text":"caption"}),
                serde_json::json!({"type":"image","data":"BASE64","mimeType":"image/png"}),
            ],
            structured_content: None,
            is_error: Some(false),
            meta: None,
        };

        let payload = call_tool_result.into_function_call_output_payload();
        assert_eq!(payload.success, Some(true));
        let Some(items) = payload.content_items() else {
            panic!("expected content items");
        };
        let items = items.to_vec();
        assert_eq!(
            items,
            vec![
                FunctionCallOutputContentItem::InputText {
                    text: "caption".into(),
                },
                FunctionCallOutputContentItem::InputImage {
                    image_url: "data:image/png;base64,BASE64".into(),
                    detail: Some(DEFAULT_IMAGE_DETAIL),
                },
            ]
        );

        let item = ResponseInputItem::FunctionCallOutput {
            call_id: "call1".into(),
            output: payload,
        };

        let json = serde_json::to_string(&item)?;
        let v: serde_json::Value = serde_json::from_str(&json)?;

        let output = v.get("output").expect("output field");
        assert!(output.is_array(), "expected array output");

        Ok(())
    }

    #[test]
    fn serializes_custom_tool_image_outputs_as_array() -> Result<()> {
        let item = ResponseInputItem::CustomToolCallOutput {
            call_id: "call1".into(),
            name: None,
            output: FunctionCallOutputPayload::from_content_items(vec![
                FunctionCallOutputContentItem::InputImage {
                    image_url: "data:image/png;base64,BASE64".into(),
                    detail: Some(DEFAULT_IMAGE_DETAIL),
                },
            ]),
        };

        let json = serde_json::to_string(&item)?;
        let v: serde_json::Value = serde_json::from_str(&json)?;

        let output = v.get("output").expect("output field");
        assert!(output.is_array(), "expected array output");

        Ok(())
    }

    #[test]
    fn serializes_encrypted_function_output_content_as_array() -> Result<()> {
        let item = ResponseInputItem::FunctionCallOutput {
            call_id: "call1".into(),
            output: FunctionCallOutputPayload::from_content_items(vec![
                FunctionCallOutputContentItem::EncryptedContent {
                    encrypted_content: "enc_opaque".into(),
                },
            ]),
        };

        let json = serde_json::to_value(&item)?;
        assert_eq!(
            json,
            serde_json::json!({
                "type": "function_call_output",
                "call_id": "call1",
                "output": [
                    {
                        "type": "encrypted_content",
                        "encrypted_content": "enc_opaque",
                    }
                ],
            })
        );

        Ok(())
    }

    #[test]
    fn preserves_existing_image_data_urls() -> Result<()> {
        let call_tool_result = CallToolResult {
            content: vec![serde_json::json!({
                "type": "image",
                "data": "data:image/png;base64,BASE64",
                "mimeType": "image/png"
            })],
            structured_content: None,
            is_error: Some(false),
            meta: None,
        };

        let payload = call_tool_result.into_function_call_output_payload();
        let Some(items) = payload.content_items() else {
            panic!("expected content items");
        };
        let items = items.to_vec();
        assert_eq!(
            items,
            vec![FunctionCallOutputContentItem::InputImage {
                image_url: "data:image/png;base64,BASE64".into(),
                detail: Some(DEFAULT_IMAGE_DETAIL),
            }]
        );

        Ok(())
    }

    #[test]
    fn preserves_original_detail_metadata_on_mcp_images() -> Result<()> {
        let call_tool_result = CallToolResult {
            content: vec![serde_json::json!({
                "type": "image",
                "data": "BASE64",
                "mimeType": "image/png",
                "_meta": {
                    "codex/imageDetail": "original",
                },
            })],
            structured_content: None,
            is_error: Some(false),
            meta: None,
        };

        let payload = call_tool_result.into_function_call_output_payload();
        let Some(items) = payload.content_items() else {
            panic!("expected content items");
        };
        let items = items.to_vec();
        assert_eq!(
            items,
            vec![FunctionCallOutputContentItem::InputImage {
                image_url: "data:image/png;base64,BASE64".into(),
                detail: Some(ImageDetail::Original),
            }]
        );

        Ok(())
    }

    #[test]
    fn preserves_standard_detail_metadata_on_mcp_images() -> Result<()> {
        let call_tool_result = CallToolResult {
            content: vec![serde_json::json!({
                "type": "image",
                "data": "BASE64",
                "mimeType": "image/png",
                "_meta": {
                    "codex/imageDetail": "high",
                },
            })],
            structured_content: None,
            is_error: Some(false),
            meta: None,
        };

        let payload = call_tool_result.into_function_call_output_payload();
        let Some(items) = payload.content_items() else {
            panic!("expected content items");
        };
        let items = items.to_vec();
        assert_eq!(
            items,
            vec![FunctionCallOutputContentItem::InputImage {
                image_url: "data:image/png;base64,BASE64".into(),
                detail: Some(ImageDetail::High),
            }]
        );

        Ok(())
    }

    #[test]
    fn deserializes_array_payload_into_items() -> Result<()> {
        let json = r#"[
            {"type": "input_text", "text": "note"},
            {"type": "input_image", "image_url": "data:image/png;base64,XYZ"}
        ]"#;

        let payload: FunctionCallOutputPayload = serde_json::from_str(json)?;

        assert_eq!(payload.success, None);
        let expected_items = vec![
            FunctionCallOutputContentItem::InputText {
                text: "note".into(),
            },
            FunctionCallOutputContentItem::InputImage {
                image_url: "data:image/png;base64,XYZ".into(),
                detail: None,
            },
        ];
        assert_eq!(
            payload.body,
            FunctionCallOutputBody::ContentItems(expected_items.clone())
        );
        assert_eq!(
            serde_json::to_string(&payload)?,
            serde_json::to_string(&expected_items)?
        );

        Ok(())
    }

    #[test]
    fn deserializes_encrypted_array_payload_into_items() -> Result<()> {
        let json = r#"[
            {"type": "encrypted_content", "encrypted_content": "enc_opaque"}
        ]"#;

        let payload: FunctionCallOutputPayload = serde_json::from_str(json)?;
        let expected_items = vec![FunctionCallOutputContentItem::EncryptedContent {
            encrypted_content: "enc_opaque".into(),
        }];

        assert_eq!(payload.success, None);
        assert_eq!(
            payload.body,
            FunctionCallOutputBody::ContentItems(expected_items.clone())
        );
        assert_eq!(
            serde_json::to_string(&payload)?,
            serde_json::to_string(&expected_items)?
        );

        Ok(())
    }

    #[test]
    fn deserializes_compaction_alias() -> Result<()> {
        let json = r#"{"type":"compaction_summary","encrypted_content":"abc"}"#;

        let item: ResponseItem = serde_json::from_str(json)?;

        assert_eq!(
            item,
            ResponseItem::Compaction {
                id: None,
                encrypted_content: "abc".into(),
                internal_chat_message_metadata_passthrough: None,
            }
        );
        Ok(())
    }

    #[test]
    fn deserializes_context_compaction() -> Result<()> {
        let json = r#"{"type":"context_compaction","encrypted_content":"abc"}"#;

        let item: ResponseItem = serde_json::from_str(json)?;

        assert_eq!(
            item,
            ResponseItem::ContextCompaction {
                id: None,
                encrypted_content: Some("abc".into()),
                internal_chat_message_metadata_passthrough: None,
            }
        );
        Ok(())
    }

    #[test]
    fn serializes_compaction_trigger_without_payload() -> Result<()> {
        let item = ResponseItem::CompactionTrigger {};

        assert_eq!(
            serde_json::to_value(item)?,
            serde_json::json!({
                "type": "compaction_trigger",
            })
        );
        Ok(())
    }

    #[test]
    fn deserializes_compaction_trigger_without_payload() -> Result<()> {
        let json = r#"{"type":"compaction_trigger"}"#;

        let item: ResponseItem = serde_json::from_str(json)?;

        assert_eq!(item, ResponseItem::CompactionTrigger {});
        Ok(())
    }

    #[test]
    fn deserializes_legacy_ghost_snapshot_as_other() -> Result<()> {
        let json = r#"{
            "type":"ghost_snapshot",
            "ghost_commit":{
                "id":"ghost-1",
                "parent":null,
                "preexisting_untracked_files":[],
                "preexisting_untracked_dirs":[]
            }
        }"#;

        let item: ResponseItem = serde_json::from_str(json)?;

        assert_eq!(item, ResponseItem::Other);
        Ok(())
    }

    #[test]
    fn roundtrips_web_search_call_actions() -> Result<()> {
        let cases = vec![
            (
                r#"{
                    "type": "web_search_call",
                    "status": "completed",
                    "action": {
                        "type": "search",
                        "query": "weather seattle",
                        "queries": ["weather seattle", "seattle weather now"]
                    }
                }"#,
                None,
                Some(WebSearchAction::Search {
                    query: Some("weather seattle".into()),
                    queries: Some(vec!["weather seattle".into(), "seattle weather now".into()]),
                }),
                Some("completed".into()),
            ),
            (
                r#"{
                    "type": "web_search_call",
                    "status": "open",
                    "action": {
                        "type": "open_page",
                        "url": "https://example.com"
                    }
                }"#,
                None,
                Some(WebSearchAction::OpenPage {
                    url: Some("https://example.com".into()),
                }),
                Some("open".into()),
            ),
            (
                r#"{
                    "type": "web_search_call",
                    "status": "in_progress",
                    "action": {
                        "type": "find_in_page",
                        "url": "https://example.com/docs",
                        "pattern": "installation"
                    }
                }"#,
                None,
                Some(WebSearchAction::FindInPage {
                    url: Some("https://example.com/docs".into()),
                    pattern: Some("installation".into()),
                }),
                Some("in_progress".into()),
            ),
            (
                r#"{
                    "type": "web_search_call",
                    "status": "in_progress",
                    "id": "ws_partial"
                }"#,
                Some("ws_partial".into()),
                None,
                Some("in_progress".into()),
            ),
        ];

        for (json_literal, expected_id, expected_action, expected_status) in cases {
            let parsed: ResponseItem = serde_json::from_str(json_literal)?;
            let expected = ResponseItem::WebSearchCall {
                id: expected_id.clone(),
                status: expected_status.clone(),
                action: expected_action.clone(),
                internal_chat_message_metadata_passthrough: None,
            };
            assert_eq!(parsed, expected);

            let serialized = serde_json::to_value(&parsed)?;
            let expected_serialized: serde_json::Value = serde_json::from_str(json_literal)?;
            assert_eq!(serialized, expected_serialized);
        }

        Ok(())
    }

    #[test]
    fn serializes_image_user_input_without_tags() -> Result<()> {
        let image_url = "data:image/png;base64,abc".to_string();

        let item = ResponseInputItem::from(vec![UserInput::Image {
            image_url: image_url.clone(),
            detail: None,
        }]);

        match item {
            ResponseInputItem::Message { content, .. } => {
                let expected = vec![ContentItem::InputImage {
                    image_url,
                    detail: Some(DEFAULT_IMAGE_DETAIL),
                }];
                assert_eq!(content, expected);
            }
            other => panic!("expected message response but got {other:?}"),
        }

        Ok(())
    }

    #[test]
    fn image_user_input_preserves_requested_detail() -> Result<()> {
        let image_url = "data:image/png;base64,abc".to_string();

        let item = ResponseInputItem::from(vec![UserInput::Image {
            image_url: image_url.clone(),
            detail: Some(ImageDetail::Original),
        }]);

        match item {
            ResponseInputItem::Message { content, .. } => {
                assert_eq!(
                    content.first(),
                    Some(&ContentItem::InputImage {
                        image_url,
                        detail: Some(ImageDetail::Original),
                    })
                );
            }
            other => panic!("expected message response but got {other:?}"),
        }

        Ok(())
    }

    #[test]
    fn tool_search_call_roundtrips() -> Result<()> {
        let parsed: ResponseItem = serde_json::from_str(
            r#"{
                "type": "tool_search_call",
                "call_id": "search-1",
                "execution": "client",
                "arguments": {
                    "query": "calendar create",
                    "limit": 1
                }
            }"#,
        )?;

        assert_eq!(
            parsed,
            ResponseItem::ToolSearchCall {
                id: None,
                call_id: Some("search-1".to_string()),
                status: None,
                execution: "client".to_string(),
                arguments: serde_json::json!({
                    "query": "calendar create",
                    "limit": 1,
                }),
                internal_chat_message_metadata_passthrough: None,
            }
        );

        assert_eq!(
            serde_json::to_value(&parsed)?,
            serde_json::json!({
                "type": "tool_search_call",
                "call_id": "search-1",
                "execution": "client",
                "arguments": {
                    "query": "calendar create",
                    "limit": 1,
                }
            })
        );

        Ok(())
    }

    #[test]
    fn tool_search_output_roundtrips() -> Result<()> {
        let input = ResponseInputItem::ToolSearchOutput {
            call_id: "search-1".to_string(),
            status: "completed".to_string(),
            execution: "client".to_string(),
            tools: vec![serde_json::json!({
                "type": "function",
                "name": "mcp__codex_apps__calendar_create_event",
                "description": "Create a calendar event.",
                "defer_loading": true,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"}
                    },
                    "required": ["title"],
                    "additionalProperties": false,
                }
            })],
        };
        assert_eq!(
            ResponseItem::from(input.clone()),
            ResponseItem::ToolSearchOutput {
                id: None,
                call_id: Some("search-1".to_string()),
                status: "completed".to_string(),
                execution: "client".to_string(),
                tools: vec![serde_json::json!({
                    "type": "function",
                    "name": "mcp__codex_apps__calendar_create_event",
                    "description": "Create a calendar event.",
                    "defer_loading": true,
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string"}
                        },
                        "required": ["title"],
                        "additionalProperties": false,
                    }
                })],
                internal_chat_message_metadata_passthrough: None,
            }
        );

        assert_eq!(
            serde_json::to_value(input)?,
            serde_json::json!({
                "type": "tool_search_output",
                "call_id": "search-1",
                "status": "completed",
                "execution": "client",
                "tools": [{
                    "type": "function",
                    "name": "mcp__codex_apps__calendar_create_event",
                    "description": "Create a calendar event.",
                    "defer_loading": true,
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string"}
                        },
                        "required": ["title"],
                        "additionalProperties": false,
                    }
                }]
            })
        );

        Ok(())
    }

    #[test]
    fn tool_search_server_items_allow_null_call_id() -> Result<()> {
        let parsed_call: ResponseItem = serde_json::from_str(
            r#"{
                "type": "tool_search_call",
                "execution": "server",
                "call_id": null,
                "status": "completed",
                "arguments": {
                    "paths": ["crm"]
                }
            }"#,
        )?;
        assert_eq!(
            parsed_call,
            ResponseItem::ToolSearchCall {
                id: None,
                call_id: None,
                status: Some("completed".to_string()),
                execution: "server".to_string(),
                arguments: serde_json::json!({
                    "paths": ["crm"],
                }),
                internal_chat_message_metadata_passthrough: None,
            }
        );

        let parsed_output: ResponseItem = serde_json::from_str(
            r#"{
                "type": "tool_search_output",
                "execution": "server",
                "call_id": null,
                "status": "completed",
                "tools": []
            }"#,
        )?;
        assert_eq!(
            parsed_output,
            ResponseItem::ToolSearchOutput {
                id: None,
                call_id: None,
                status: "completed".to_string(),
                execution: "server".to_string(),
                tools: vec![],
                internal_chat_message_metadata_passthrough: None,
            }
        );

        Ok(())
    }

    #[test]
    fn mixed_remote_and_local_images_share_label_sequence() -> Result<()> {
        let image_url = "data:image/png;base64,abc".to_string();
        let dir = tempdir()?;
        let local_path = dir.path().join("local.png");
        std::fs::write(&local_path, TINY_PNG_BYTES)?;

        let item = ResponseInputItem::from(vec![
            UserInput::Image {
                image_url: image_url.clone(),
                detail: None,
            },
            UserInput::LocalImage {
                path: local_path.clone(),
                detail: None,
            },
        ]);

        match item {
            ResponseInputItem::Message { content, .. } => {
                assert_eq!(
                    content.first(),
                    Some(&ContentItem::InputImage {
                        image_url,
                        detail: Some(DEFAULT_IMAGE_DETAIL),
                    })
                );
                assert_eq!(
                    content.get(1),
                    Some(&ContentItem::InputText {
                        text: local_image_open_tag_text_with_path(
                            /*label_number*/ 2,
                            &local_path
                        ),
                    })
                );
                assert!(matches!(
                    content.get(2),
                    Some(ContentItem::InputImage { .. })
                ));
                assert_eq!(
                    content.get(3),
                    Some(&ContentItem::InputText {
                        text: image_close_tag_text(),
                    })
                );
            }
            other => panic!("expected message response but got {other:?}"),
        }

        Ok(())
    }

    #[test]
    fn local_image_open_tag_preserves_path() {
        assert_eq!(
            local_image_open_tag_text_with_path(
                /*label_number*/ 1,
                std::path::Path::new(r#"/tmp/a&"<b>.png"#),
            ),
            r#"<image name=[Image #1] path="/tmp/a&"<b>.png">"#
        );
    }

    #[test]
    fn local_image_user_input_preserves_requested_detail() -> Result<()> {
        let dir = tempdir()?;
        let local_path = dir.path().join("local.png");
        std::fs::write(&local_path, TINY_PNG_BYTES)?;

        let item = ResponseInputItem::from(vec![UserInput::LocalImage {
            path: local_path,
            detail: Some(ImageDetail::Original),
        }]);

        match item {
            ResponseInputItem::Message { content, .. } => {
                assert!(matches!(
                    content.get(1),
                    Some(ContentItem::InputImage {
                        detail: Some(ImageDetail::Original),
                        ..
                    })
                ));
            }
            other => panic!("expected message response but got {other:?}"),
        }

        Ok(())
    }

    #[test]
    fn local_image_read_error_adds_placeholder() -> Result<()> {
        let dir = tempdir()?;
        let missing_path = dir.path().join("missing-image.png");

        let item = ResponseInputItem::from(vec![UserInput::LocalImage {
            path: missing_path.clone(),
            detail: None,
        }]);

        match item {
            ResponseInputItem::Message { content, .. } => {
                assert_eq!(content.len(), 1);
                match &content[0] {
                    ContentItem::InputText { text } => {
                        let display_path = missing_path.display().to_string();
                        assert!(
                            text.contains(&display_path),
                            "placeholder should mention missing path: {text}"
                        );
                        assert!(
                            text.contains("could not read"),
                            "placeholder should mention read issue: {text}"
                        );
                    }
                    other => panic!("expected placeholder text but found {other:?}"),
                }
            }
            other => panic!("expected message response but got {other:?}"),
        }

        Ok(())
    }

    #[test]
    fn local_image_non_image_adds_placeholder() -> Result<()> {
        let dir = tempdir()?;
        let json_path = dir.path().join("example.json");
        std::fs::write(&json_path, br#"{"hello":"world"}"#)?;

        let item = ResponseInputItem::from(vec![UserInput::LocalImage {
            path: json_path.clone(),
            detail: None,
        }]);

        match item {
            ResponseInputItem::Message { content, .. } => {
                assert_eq!(content.len(), 1);
                match &content[0] {
                    ContentItem::InputText { text } => {
                        assert!(
                            text.contains("unsupported image `application/json`"),
                            "placeholder should mention unsupported image MIME: {text}"
                        );
                        assert!(
                            text.contains(&json_path.display().to_string()),
                            "placeholder should mention path: {text}"
                        );
                    }
                    other => panic!("expected placeholder text but found {other:?}"),
                }
            }
            other => panic!("expected message response but got {other:?}"),
        }

        Ok(())
    }

    #[test]
    fn local_image_unsupported_image_format_adds_placeholder() -> Result<()> {
        let dir = tempdir()?;
        let svg_path = dir.path().join("example.svg");
        std::fs::write(
            &svg_path,
            br#"<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>"#,
        )?;

        let item = ResponseInputItem::from(vec![UserInput::LocalImage {
            path: svg_path.clone(),
            detail: None,
        }]);

        match item {
            ResponseInputItem::Message { content, .. } => {
                assert_eq!(content.len(), 1);
                let expected = format!(
                    "Codex cannot attach image at `{}`: unsupported image `image/svg+xml`.",
                    svg_path.display()
                );
                match &content[0] {
                    ContentItem::InputText { text } => assert_eq!(text, &expected),
                    other => panic!("expected placeholder text but found {other:?}"),
                }
            }
            other => panic!("expected message response but got {other:?}"),
        }

        Ok(())
    }
}
