//! 文件系统与网络 sandbox 权限策略。
//!
//! 定义 sandbox 的访问模式、特殊路径 token、文件系统条目与策略对象，以及
//! 旧版 [`SandboxPolicy`] 与新版 [`FileSystemSandboxPolicy`] 之间的转换逻辑。
//! 这些类型用于在协议层描述一次会话或命令的访问范围。

use std::collections::HashSet;
use std::ffi::OsStr;
use std::io;
use std::path::Path;
use std::path::PathBuf;

use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_absolute_path::canonicalize_preserving_symlinks;
use codex_utils_path_uri::PathUri;
use globset::GlobBuilder;
use globset::GlobMatcher;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use strum_macros::Display;
use tracing::error;
use ts_rs::TS;

use crate::protocol::NetworkAccess;
use crate::protocol::SandboxPolicy;
use crate::protocol::WritableRoot;

/// 受保护的 `.git` 元数据目录名。
const PROTECTED_METADATA_GIT_PATH_NAME: &str = ".git";
/// 受保护的 `.agents` 元数据目录名。
const PROTECTED_METADATA_AGENTS_PATH_NAME: &str = ".agents";
/// 受保护的 `.codex` 元数据目录名。
const PROTECTED_METADATA_CODEX_PATH_NAME: &str = ".codex";

/// 在 writable roots 下仍受保护的顶层 workspace 元数据路径名列表。
pub const PROTECTED_METADATA_PATH_NAMES: &[&str] = &[
    PROTECTED_METADATA_GIT_PATH_NAME,
    PROTECTED_METADATA_AGENTS_PATH_NAME,
    PROTECTED_METADATA_CODEX_PATH_NAME,
];

/// 判断给定路径 basename 是否为受保护的 workspace 元数据名。
pub fn is_protected_metadata_name(name: &OsStr) -> bool {
    PROTECTED_METADATA_PATH_NAMES
        .iter()
        .any(|metadata_name| name == OsStr::new(metadata_name))
}

/// 判断给定路径 basename 是否为受保护的元数据目录名（仅 `.agents` 与 `.codex`）。
pub fn is_protected_metadata_directory_name(name: &OsStr) -> bool {
    name == OsStr::new(PROTECTED_METADATA_AGENTS_PATH_NAME)
        || name == OsStr::new(PROTECTED_METADATA_CODEX_PATH_NAME)
}

/// 当 Agent 对 `path` 的写入应被拦截时，返回受保护的 workspace 元数据名。
///
/// 调用方在执行写入前应调用此函数进行预检。
pub fn forbidden_agent_metadata_write(
    path: &Path,
    cwd: &Path,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
) -> Option<&'static str> {
    if !matches!(
        file_system_sandbox_policy.kind,
        FileSystemSandboxKind::Restricted
    ) {
        return None;
    }

    let target = resolve_candidate_path(path, cwd)?;
    let (protected_metadata_path, metadata_name) =
        metadata_child_of_writable_root(file_system_sandbox_policy, target.as_path(), cwd)?;
    if has_explicit_write_entry_for_metadata_path(
        file_system_sandbox_policy,
        &protected_metadata_path,
        target.as_path(),
        cwd,
    ) {
        return None;
    }

    if !file_system_sandbox_policy.can_write_path_with_cwd(target.as_path(), cwd) {
        return Some(metadata_name);
    }

    None
}

/// 网络 sandbox 策略。
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Display, Default, JsonSchema, TS,
)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case")]
pub enum NetworkSandboxPolicy {
    /// 默认：网络访问受限。
    #[default]
    Restricted,
    /// 网络访问启用。
    Enabled,
}

impl NetworkSandboxPolicy {
    /// 是否为 `Enabled`。
    pub fn is_enabled(self) -> bool {
        matches!(self, NetworkSandboxPolicy::Enabled)
    }
}

/// 文件系统条目的访问模式。
///
/// 当两条同等具体的条目指向同一路径时，按冲突优先级而非能力范围比较：
/// `deny` 优先于 `write`，`write` 优先于 `read`。
#[derive(
    Debug,
    Clone,
    Copy,
    Hash,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Serialize,
    Deserialize,
    Display,
    JsonSchema,
    TS,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase")]
pub enum FileSystemAccessMode {
    /// 只读。
    Read,
    /// 可读写。
    Write,
    /// 拒绝访问（`none` 是为兼容性临时保留的旧版输入别名）。
    #[serde(alias = "none")]
    Deny,
}

impl FileSystemAccessMode {
    /// 是否可读（非 `Deny` 即可读）。
    pub fn can_read(self) -> bool {
        !matches!(self, FileSystemAccessMode::Deny)
    }

    /// 是否可写（仅 `Write` 可写）。
    pub fn can_write(self) -> bool {
        matches!(self, FileSystemAccessMode::Write)
    }
}

/// 文件系统 sandbox 的特殊路径 token。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(tag = "kind")]
pub enum FileSystemSpecialPath {
    /// 文件系统根目录。
    Root,
    /// 最小可访问集合（平台默认只读路径）。
    Minimal,
    /// 当前项目根（可附加子路径）。
    #[serde(alias = "current_working_directory")]
    ProjectRoots {
        /// 项目根下的相对子路径（可选）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        subpath: Option<PathBuf>,
    },
    /// 系统临时目录。
    Tmpdir,
    /// `/tmp` 目录。
    SlashTmp,
    /// 警告：`:special_path` token 属于配置兼容性的一部分。
    /// 不要让旧版运行时拒绝新引入的 token。
    /// 新的解析器支持应为增量式，未知值必须能被表示出来，使来自更新版本
    /// Codex 的配置以 warn-and-ignore 方式降级，而非加载失败。
    /// Codex 0.112.0 曾在此处拒绝未知值，破坏了新配置的前向兼容性。
    /// 保留未来的 special-path token，使旧版运行时可以忽略它们，
    /// 而不是拒绝由更新版本生成的配置。
    Unknown {
        /// 未知 token 的原始字符串。
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        subpath: Option<PathBuf>,
    },
}

impl FileSystemSpecialPath {
    /// 构造 `ProjectRoots` 特殊路径。
    pub fn project_roots(subpath: Option<PathBuf>) -> Self {
        Self::ProjectRoots { subpath }
    }

    /// 构造 `Unknown` 特殊路径。
    pub fn unknown(path: impl Into<String>, subpath: Option<PathBuf>) -> Self {
        Self::Unknown {
            path: path.into(),
            subpath,
        }
    }
}

/// 文件系统 sandbox 条目，由路径与访问模式组成。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, TS)]
pub struct FileSystemSandboxEntry<PathType = AbsolutePathBuf> {
    /// 条目路径。
    pub path: FileSystemPath<PathType>,
    /// 访问模式。
    pub access: FileSystemAccessMode,
}

impl From<FileSystemSandboxEntry<AbsolutePathBuf>> for FileSystemSandboxEntry<PathUri> {
    fn from(value: FileSystemSandboxEntry<AbsolutePathBuf>) -> Self {
        FileSystemSandboxEntry {
            path: value.path.into(),
            access: value.access,
        }
    }
}

impl TryFrom<FileSystemSandboxEntry<PathUri>> for FileSystemSandboxEntry<AbsolutePathBuf> {
    type Error = io::Error;

    fn try_from(value: FileSystemSandboxEntry<PathUri>) -> Result<Self, Self::Error> {
        Ok(FileSystemSandboxEntry {
            path: value.path.try_into()?,
            access: value.access,
        })
    }
}

/// 文件系统 sandbox 类型。
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Display, Default, JsonSchema, TS,
)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case")]
pub enum FileSystemSandboxKind {
    /// 受限（按条目精确控制）。
    #[default]
    Restricted,
    /// 不受限制（允许全盘访问）。
    Unrestricted,
    /// 文件系统隔离由外部 sandbox 负责。
    ExternalSandbox,
}

/// 文件系统 sandbox 策略。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
pub struct FileSystemSandboxPolicy {
    /// sandbox 类型。
    pub kind: FileSystemSandboxKind,
    /// glob 扫描的最大深度（可选）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub glob_scan_max_depth: Option<usize>,
    /// 条目列表。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub entries: Vec<FileSystemSandboxEntry>,
}

/// 解析后的文件系统条目（内部使用）。
#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedFileSystemEntry {
    path: AbsolutePathBuf,
    access: FileSystemAccessMode,
}

/// 文件系统策略的语义签名，用于等价性比较（内部使用）。
#[derive(Debug, Clone, PartialEq, Eq)]
struct FileSystemSemanticSignature {
    has_full_disk_read_access: bool,
    has_full_disk_write_access: bool,
    include_platform_defaults: bool,
    readable_roots: Vec<AbsolutePathBuf>,
    writable_roots: Vec<WritableRoot>,
    unreadable_roots: Vec<AbsolutePathBuf>,
    unreadable_globs: Vec<String>,
}

/// 文件系统 sandbox 策略中 read-deny 条目的运行时匹配器。
pub struct ReadDenyMatcher {
    /// 拒绝读取的根路径候选（含规范化与符号链接变体）。
    denied_candidates: Vec<Vec<PathBuf>>,
    /// 拒绝读取的 glob 匹配器列表。
    deny_read_matchers: Vec<GlobMatcher>,
    /// 是否存在无效的 glob 模式。
    invalid_pattern: bool,
}

impl ReadDenyMatcher {
    /// 由精确 deny-read 根与 deny-read glob 条目构建匹配器。
    ///
    /// 当策略不包含 deny-read 限制时返回 `None`，调用方可据此跳过
    /// read-deny 检查而无需分配匹配器状态。`cwd` 用于在匹配前解析
    /// cwd 相关的策略路径与特殊路径。
    pub fn new(file_system_sandbox_policy: &FileSystemSandboxPolicy, cwd: &Path) -> Option<Self> {
        match Self::build(
            file_system_sandbox_policy,
            cwd,
            InvalidDenyReadGlobBehavior::FailClosed,
        ) {
            Ok(matcher) => matcher,
            Err(_) => unreachable!("fail-closed glob handling does not return errors"),
        }
    }

    /// 为必须拒绝畸形 glob 模式的调用方构建匹配器。
    ///
    /// 运行时 read 检查对畸形 deny 模式采用 fail-closed 策略。host 侧的
    /// 路径展开工作应改用此构造函数，使一处笔误无法在执行开始前扩大
    /// 其可变更路径集合。
    pub fn try_new(
        file_system_sandbox_policy: &FileSystemSandboxPolicy,
        cwd: &Path,
    ) -> Result<Option<Self>, String> {
        Self::build(
            file_system_sandbox_policy,
            cwd,
            InvalidDenyReadGlobBehavior::ReturnError,
        )
    }

    fn build(
        file_system_sandbox_policy: &FileSystemSandboxPolicy,
        cwd: &Path,
        invalid_glob_behavior: InvalidDenyReadGlobBehavior,
    ) -> Result<Option<Self>, String> {
        if !file_system_sandbox_policy.has_denied_read_restrictions() {
            return Ok(None);
        }

        // 精确根以所有能低成本推导出的有意义的路径拼写形式存储。
        // 这使直接 tool 检查能同时捕获符号链接路径与其 canonical 目标，
        // 而无需修改策略条目本身。
        let denied_candidates = file_system_sandbox_policy
            .get_unreadable_roots_with_cwd(cwd)
            .into_iter()
            .map(|path| normalized_and_canonical_candidates(path.as_path()))
            .collect();
        // 模式条目保持为策略级 glob。它们在读取时由此处匹配，
        // 而不是被快照到启动时的文件系统状态。
        let mut invalid_pattern = false;
        let mut deny_read_matchers = Vec::new();
        for pattern in file_system_sandbox_policy.get_unreadable_globs_with_cwd(cwd) {
            match build_glob_matcher(&pattern) {
                Ok(matcher) => deny_read_matchers.push(matcher),
                Err(err) => match invalid_glob_behavior {
                    InvalidDenyReadGlobBehavior::FailClosed => invalid_pattern = true,
                    InvalidDenyReadGlobBehavior::ReturnError => {
                        return Err(format!("invalid deny-read glob pattern `{pattern}`: {err}"));
                    }
                },
            }
        }
        Ok(Some(Self {
            denied_candidates,
            deny_read_matchers,
            invalid_pattern,
        }))
    }

    /// 判断 `path` 是否被构建此匹配器时使用的策略拒绝读取。
    pub fn is_read_denied(&self, path: &Path) -> bool {
        if self.invalid_pattern {
            // 直接 tool 读取对畸形 deny 模式 fail-closed。
            // 静默 allow 会使配置笔误变成策略绕过。
            return true;
        }

        // 在评估 glob 匹配器之前，先用每种候选拼写检查精确根。
        // 精确条目是子树拒绝；glob 条目按模式编译器的路径分隔符规则匹配。
        let path_candidates = normalized_and_canonical_candidates(path);
        if self.denied_candidates.iter().any(|denied_candidates| {
            path_candidates.iter().any(|candidate| {
                denied_candidates.iter().any(|denied_candidate| {
                    candidate == denied_candidate || candidate.starts_with(denied_candidate)
                })
            })
        }) {
            return true;
        }

        self.deny_read_matchers.iter().any(|matcher| {
            path_candidates
                .iter()
                .any(|candidate| matcher.is_match(candidate))
        })
    }
}

/// 畸形 deny-read glob 模式的处理方式（内部使用）。
#[derive(Clone, Copy)]
enum InvalidDenyReadGlobBehavior {
    /// Fail-closed：将匹配器标记为无效，所有读取均视为被拒绝。
    FailClosed,
    /// 返回错误。
    ReturnError,
}

/// 文件系统路径条目，可以是绝对路径、glob 模式或特殊路径 token。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type")]
pub enum FileSystemPath<PathType = AbsolutePathBuf> {
    /// 精确路径。
    Path {
        /// 路径值。
        path: PathType,
    },
    /// git 风格的 glob 模式。模式条目目前仅支持
    /// [`FileSystemAccessMode::Deny`]。
    GlobPattern {
        /// glob 模式字符串。
        pattern: String,
    },
    /// 特殊路径 token。
    Special {
        /// 特殊路径值。
        value: FileSystemSpecialPath,
    },
}

impl From<FileSystemPath<AbsolutePathBuf>> for FileSystemPath<PathUri> {
    fn from(value: FileSystemPath<AbsolutePathBuf>) -> Self {
        match value {
            FileSystemPath::Path { path } => FileSystemPath::Path {
                path: PathUri::from_abs_path(&path),
            },
            FileSystemPath::GlobPattern { pattern } => FileSystemPath::GlobPattern { pattern },
            FileSystemPath::Special { value } => FileSystemPath::Special { value },
        }
    }
}

impl TryFrom<FileSystemPath<PathUri>> for FileSystemPath<AbsolutePathBuf> {
    type Error = io::Error;

    fn try_from(value: FileSystemPath<PathUri>) -> Result<Self, Self::Error> {
        Ok(match value {
            FileSystemPath::Path { path } => FileSystemPath::Path {
                path: path.to_abs_path()?,
            },
            FileSystemPath::GlobPattern { pattern } => FileSystemPath::GlobPattern { pattern },
            FileSystemPath::Special { value } => FileSystemPath::Special { value },
        })
    }
}

/// 项目根 glob 模式前缀。
const PROJECT_ROOTS_GLOB_PATTERN_PREFIX: &str = "codex-project-roots://";

/// 构造一个匹配项目根下 `subpath` 的 glob 模式字符串。
pub fn project_roots_glob_pattern(subpath: &Path) -> String {
    format!("{PROJECT_ROOTS_GLOB_PATTERN_PREFIX}{}", subpath.display())
}

/// 返回 read-only 文件系统 sandbox 条目（允许读取文件系统根）。
fn read_only_file_system_entries() -> Vec<FileSystemSandboxEntry> {
    vec![FileSystemSandboxEntry {
        path: FileSystemPath::Special {
            value: FileSystemSpecialPath::Root,
        },
        access: FileSystemAccessMode::Read,
    }]
}

impl Default for FileSystemSandboxPolicy {
    fn default() -> Self {
        Self::read_only()
    }
}

impl FileSystemSandboxPolicy {
    /// 返回 read-only 策略。
    pub fn read_only() -> Self {
        Self::restricted(read_only_file_system_entries())
    }

    /// 返回 unrestricted 策略。
    pub fn unrestricted() -> Self {
        Self {
            kind: FileSystemSandboxKind::Unrestricted,
            glob_scan_max_depth: None,
            entries: Vec::new(),
        }
    }

    /// 返回 external-sandbox 策略。
    pub fn external_sandbox() -> Self {
        Self {
            kind: FileSystemSandboxKind::ExternalSandbox,
            glob_scan_max_depth: None,
            entries: Vec::new(),
        }
    }

    /// 由条目列表构造受限策略。
    pub fn restricted(entries: Vec<FileSystemSandboxEntry>) -> Self {
        Self {
            kind: FileSystemSandboxKind::Restricted,
            glob_scan_max_depth: None,
            entries,
        }
    }

    /// 判断是否存在满足 `predicate` 的根访问条目。
    fn has_root_access(&self, predicate: impl Fn(FileSystemAccessMode) -> bool) -> bool {
        matches!(self.kind, FileSystemSandboxKind::Restricted)
            && self.entries.iter().any(|entry| {
                matches!(
                    &entry.path,
                    FileSystemPath::Special { value }
                        if matches!(value, FileSystemSpecialPath::Root) && predicate(entry.access)
                )
            })
    }

    /// 是否存在 deny-read 限制条目。
    pub fn has_denied_read_restrictions(&self) -> bool {
        matches!(self.kind, FileSystemSandboxKind::Restricted)
            && self
                .entries
                .iter()
                .any(|entry| entry.access == FileSystemAccessMode::Deny)
    }

    /// 由旧版 [`SandboxPolicy`] 构造文件系统策略，保留 `existing` 中的
    /// 显式 deny-read 条目。
    pub fn from_legacy_sandbox_policy_preserving_deny_entries(
        sandbox_policy: &SandboxPolicy,
        cwd: &Path,
        existing: &Self,
    ) -> Self {
        let mut rebuilt = Self::from_legacy_sandbox_policy_for_cwd(sandbox_policy, cwd);
        if !matches!(rebuilt.kind, FileSystemSandboxKind::Restricted) {
            return rebuilt;
        }
        rebuilt.glob_scan_max_depth = existing.glob_scan_max_depth;

        for deny_entry in existing
            .entries
            .iter()
            .filter(|entry| entry.access == FileSystemAccessMode::Deny)
        {
            if !rebuilt.entries.iter().any(|entry| entry == deny_entry) {
                rebuilt.entries.push(deny_entry.clone());
            }
        }

        rebuilt
    }

    /// 当调用方替换策略的 allow 侧时，保留 `existing` 中的显式
    /// read-deny 规则。
    pub fn preserve_deny_read_restrictions_from(&mut self, existing: &Self) {
        let has_deny_read_entries = existing
            .entries
            .iter()
            .any(|entry| entry.access == FileSystemAccessMode::Deny);
        if matches!(self.kind, FileSystemSandboxKind::Unrestricted) && has_deny_read_entries {
            *self = Self::restricted(vec![FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::Root,
                },
                access: FileSystemAccessMode::Write,
            }]);
        }

        if !matches!(self.kind, FileSystemSandboxKind::Restricted) {
            return;
        }

        if self.glob_scan_max_depth.is_none() {
            self.glob_scan_max_depth = existing.glob_scan_max_depth;
        }

        for deny_entry in existing
            .entries
            .iter()
            .filter(|entry| entry.access == FileSystemAccessMode::Deny)
        {
            if !self.entries.iter().any(|entry| entry == deny_entry) {
                self.entries.push(deny_entry.clone());
            }
        }
    }

    /// 判断受限策略是否包含真正收窄了更宽泛的 `:root = write` 授权的条目。
    ///
    /// 此处不能仅看条目是否存在：对于同一目标，同等具体的 `write` 条目
    /// 在正常优先级规则下胜出，因此被遮蔽的 `read` 条目不应将策略从
    /// 全盘写入模式降级。
    fn has_write_narrowing_entries(&self) -> bool {
        matches!(self.kind, FileSystemSandboxKind::Restricted)
            && self.entries.iter().any(|entry| {
                if entry.access.can_write() {
                    return false;
                }

                match &entry.path {
                    FileSystemPath::Path { .. } => !self.has_same_target_write_override(entry),
                    FileSystemPath::GlobPattern { .. } => true,
                    FileSystemPath::Special { value } => match value {
                        FileSystemSpecialPath::Root => entry.access == FileSystemAccessMode::Deny,
                        FileSystemSpecialPath::Minimal | FileSystemSpecialPath::Unknown { .. } => {
                            false
                        }
                        _ => !self.has_same_target_write_override(entry),
                    },
                }
            })
    }

    /// 判断是否存在更高优先级的 `write` 条目指向与 `entry` 相同的目标，
    /// 从而使 `entry` 无法收窄有效写入权限。
    fn has_same_target_write_override(&self, entry: &FileSystemSandboxEntry) -> bool {
        self.entries.iter().any(|candidate| {
            candidate.access.can_write()
                && candidate.access > entry.access
                && file_system_paths_share_target(&candidate.path, &entry.path)
        })
    }

    /// 构造匹配 `WorkspaceWrite` 语义的文件系统策略，调用方无需先构造
    /// 旧版 [`SandboxPolicy`]。
    pub fn workspace_write(
        writable_roots: &[AbsolutePathBuf],
        exclude_tmpdir_env_var: bool,
        exclude_slash_tmp: bool,
    ) -> Self {
        let mut entries = vec![FileSystemSandboxEntry {
            path: FileSystemPath::Special {
                value: FileSystemSpecialPath::Root,
            },
            access: FileSystemAccessMode::Read,
        }];

        entries.push(FileSystemSandboxEntry {
            path: FileSystemPath::Special {
                value: FileSystemSpecialPath::project_roots(/*subpath*/ None),
            },
            access: FileSystemAccessMode::Write,
        });
        if !exclude_slash_tmp {
            entries.push(FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::SlashTmp,
                },
                access: FileSystemAccessMode::Write,
            });
        }
        if !exclude_tmpdir_env_var {
            entries.push(FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::Tmpdir,
                },
                access: FileSystemAccessMode::Write,
            });
        }
        entries.extend(
            writable_roots
                .iter()
                .cloned()
                .map(|path| FileSystemSandboxEntry {
                    path: FileSystemPath::Path { path },
                    access: FileSystemAccessMode::Write,
                }),
        );

        append_default_read_only_project_root_subpath_if_no_explicit_rule(&mut entries, ".git");
        append_default_read_only_project_root_subpath_if_no_explicit_rule(&mut entries, ".agents");
        append_default_read_only_project_root_subpath_if_no_explicit_rule(&mut entries, ".codex");
        for writable_root in writable_roots {
            for protected_path in default_read_only_subpaths_for_writable_root(
                writable_root,
                /*protect_missing_dot_codex*/ false,
            ) {
                append_default_read_only_path_if_no_explicit_rule(&mut entries, protected_path);
            }
        }

        FileSystemSandboxPolicy::restricted(entries)
    }

    /// 将旧版 sandbox 策略转换为等价的文件系统策略，并在指定 cwd 下解析
    /// cwd 敏感的旧版默认值。
    ///
    /// 旧版 `WorkspaceWrite` 策略可能列出位于已可写根之下的可读根。
    /// 这些路径在旧模型中是冗余的，在投影到拆分后的文件系统策略时
    /// 不应变成只读 carveout。
    pub fn from_legacy_sandbox_policy_for_cwd(sandbox_policy: &SandboxPolicy, cwd: &Path) -> Self {
        let mut file_system_policy = Self::from(sandbox_policy);
        if let SandboxPolicy::WorkspaceWrite { writable_roots, .. } = sandbox_policy {
            if let Ok(cwd_root) = AbsolutePathBuf::from_absolute_path(cwd) {
                for protected_path in default_read_only_subpaths_for_writable_root(
                    &cwd_root, /*protect_missing_dot_codex*/ true,
                ) {
                    append_default_read_only_path_if_no_explicit_rule(
                        &mut file_system_policy.entries,
                        protected_path,
                    );
                }
            }
            for writable_root in writable_roots {
                for protected_path in default_read_only_subpaths_for_writable_root(
                    writable_root,
                    /*protect_missing_dot_codex*/ false,
                ) {
                    append_default_read_only_path_if_no_explicit_rule(
                        &mut file_system_policy.entries,
                        protected_path,
                    );
                }
            }
        }

        file_system_policy
    }

    /// 判断文件系统读取是否不受限制。
    pub fn has_full_disk_read_access(&self) -> bool {
        match self.kind {
            FileSystemSandboxKind::Unrestricted | FileSystemSandboxKind::ExternalSandbox => true,
            FileSystemSandboxKind::Restricted => {
                self.has_root_access(FileSystemAccessMode::can_read)
                    && !self.has_denied_read_restrictions()
            }
        }
    }

    /// 判断文件系统写入是否不受限制。
    pub fn has_full_disk_write_access(&self) -> bool {
        match self.kind {
            FileSystemSandboxKind::Unrestricted | FileSystemSandboxKind::ExternalSandbox => true,
            FileSystemSandboxKind::Restricted => {
                self.has_root_access(FileSystemAccessMode::can_write)
                    && !self.has_write_narrowing_entries()
            }
        }
    }

    /// 判断是否应包含平台默认可读根。
    pub fn include_platform_defaults(&self) -> bool {
        !self.has_full_disk_read_access()
            && matches!(self.kind, FileSystemSandboxKind::Restricted)
            && self.entries.iter().any(|entry| {
                matches!(
                    &entry.path,
                    FileSystemPath::Special { value }
                        if matches!(value, FileSystemSpecialPath::Minimal)
                            && entry.access.can_read()
                )
            })
    }

    /// 在给定 `cwd` 下解析 `path` 的访问模式。
    pub fn resolve_access_with_cwd(&self, path: &Path, cwd: &Path) -> FileSystemAccessMode {
        match self.kind {
            FileSystemSandboxKind::Unrestricted | FileSystemSandboxKind::ExternalSandbox => {
                return FileSystemAccessMode::Write;
            }
            FileSystemSandboxKind::Restricted => {}
        }

        let Some(path) = resolve_candidate_path(path, cwd) else {
            return FileSystemAccessMode::Deny;
        };

        self.resolved_entries_with_cwd(cwd)
            .into_iter()
            .filter(|entry| path.as_path().starts_with(entry.path.as_path()))
            .max_by_key(resolved_entry_precedence)
            .map(|entry| entry.access)
            .unwrap_or(FileSystemAccessMode::Deny)
    }

    /// 在给定 `cwd` 下判断是否可读取 `path`。
    pub fn can_read_path_with_cwd(&self, path: &Path, cwd: &Path) -> bool {
        self.resolve_access_with_cwd(path, cwd).can_read()
    }

    /// 在给定 `cwd` 下判断是否可写入 `path`。
    pub fn can_write_path_with_cwd(&self, path: &Path, cwd: &Path) -> bool {
        if !self.resolve_access_with_cwd(path, cwd).can_write() {
            return false;
        }
        if self.has_full_disk_write_access() {
            return true;
        }
        !self.is_metadata_write_denied(path, cwd)
    }

    /// 判断写入 `path` 是否因受保护的元数据策略被拒绝（内部使用）。
    fn is_metadata_write_denied(&self, path: &Path, cwd: &Path) -> bool {
        if !matches!(self.kind, FileSystemSandboxKind::Restricted) {
            return false;
        }

        let Some(target) = resolve_candidate_path(path, cwd) else {
            return true;
        };
        let Some((protected_metadata_path, _)) =
            metadata_child_of_writable_root(self, target.as_path(), cwd)
        else {
            return false;
        };

        !has_explicit_write_entry_for_metadata_path(
            self,
            &protected_metadata_path,
            target.as_path(),
            cwd,
        )
    }

    /// 将符号化的 `:workspace_roots` 条目替换为按 `cwd` 解析后的绝对路径。
    ///
    /// 当一个持久化的权限 profile 需要在仅更新 cwd 的情况下继续存活，
    /// 且不希望将其项目根授权重新绑定到新的 cwd 时，使用此方法。
    pub fn materialize_project_roots_with_cwd(mut self, cwd: &Path) -> Self {
        let cwd = AbsolutePathBuf::from_absolute_path(cwd).ok();
        for entry in &mut self.entries {
            match &entry.path {
                FileSystemPath::Special {
                    value: FileSystemSpecialPath::ProjectRoots { .. },
                } => {
                    if let Some(path) = resolve_file_system_path(&entry.path, cwd.as_ref()) {
                        entry.path = FileSystemPath::Path { path };
                    }
                }
                FileSystemPath::GlobPattern { pattern } => {
                    if let (Some(cwd), Some(subpath)) =
                        (cwd.as_ref(), parse_project_roots_glob_pattern(pattern))
                    {
                        entry.path = FileSystemPath::GlobPattern {
                            pattern: resolve_project_roots_glob_pattern(subpath, cwd),
                        };
                    }
                }
                FileSystemPath::Special { value: _ } => {}
                FileSystemPath::Path { .. } => {}
            }
        }
        self
    }

    /// 将符号化的 `:workspace_roots` 条目替换为每个 workspace 根对应的
    /// 具体条目。
    pub fn materialize_project_roots_with_workspace_roots(
        mut self,
        workspace_roots: &[AbsolutePathBuf],
    ) -> Self {
        let mut entries = Vec::with_capacity(self.entries.len());
        for entry in self.entries {
            match entry.path {
                FileSystemPath::Special {
                    value: FileSystemSpecialPath::ProjectRoots { subpath },
                } => {
                    entries.extend(workspace_roots.iter().map(|root| FileSystemSandboxEntry {
                        path: FileSystemPath::Path {
                            path: match subpath.as_ref() {
                                Some(subpath) => AbsolutePathBuf::resolve_path_against_base(
                                    subpath,
                                    root.as_path(),
                                ),
                                None => root.clone(),
                            },
                        },
                        access: entry.access,
                    }));
                }
                FileSystemPath::GlobPattern { pattern } => {
                    if let Some(subpath) = parse_project_roots_glob_pattern(&pattern) {
                        entries.extend(workspace_roots.iter().map(|root| FileSystemSandboxEntry {
                            path: FileSystemPath::GlobPattern {
                                pattern: resolve_project_roots_glob_pattern(subpath, root),
                            },
                            access: entry.access,
                        }));
                    } else {
                        entries.push(FileSystemSandboxEntry {
                            path: FileSystemPath::GlobPattern { pattern },
                            access: entry.access,
                        });
                    }
                }
                FileSystemPath::Path { path } => {
                    entries.push(FileSystemSandboxEntry {
                        path: FileSystemPath::Path { path },
                        access: entry.access,
                    });
                }
                FileSystemPath::Special { value } => {
                    entries.push(FileSystemSandboxEntry {
                        path: FileSystemPath::Special { value },
                        access: entry.access,
                    });
                }
            }
        }
        self.entries = entries;
        self
    }

    /// 保留符号化的 `:workspace_roots` 条目，同时为每个提供的 workspace 根
    /// 追加具体条目。
    pub fn with_materialized_project_roots_for_workspace_roots(
        mut self,
        workspace_roots: &[AbsolutePathBuf],
    ) -> Self {
        let materialized = self
            .clone()
            .materialize_project_roots_with_workspace_roots(workspace_roots);
        for entry in materialized.entries {
            if !self.entries.contains(&entry) {
                self.entries.push(entry);
            }
        }
        self
    }

    /// 追加额外的可读根（若当前策略未授权读取）。
    pub fn with_additional_readable_roots(
        mut self,
        cwd: &Path,
        additional_readable_roots: &[AbsolutePathBuf],
    ) -> Self {
        if self.has_full_disk_read_access() {
            return self;
        }

        for path in additional_readable_roots {
            if self.can_read_path_with_cwd(path.as_path(), cwd) {
                continue;
            }

            self.entries.push(FileSystemSandboxEntry {
                path: FileSystemPath::Path { path: path.clone() },
                access: FileSystemAccessMode::Read,
            });
        }

        self
    }

    /// 追加额外的可写根（若当前策略未授权写入）。
    pub fn with_additional_writable_roots(
        mut self,
        cwd: &Path,
        additional_writable_roots: &[AbsolutePathBuf],
    ) -> Self {
        for path in additional_writable_roots {
            if self.can_write_path_with_cwd(path.as_path(), cwd) {
                continue;
            }

            self.entries.push(FileSystemSandboxEntry {
                path: FileSystemPath::Path { path: path.clone() },
                access: FileSystemAccessMode::Write,
            });
        }

        self
    }

    /// 使用旧版 `WorkspaceWrite` 行为追加根。
    ///
    /// 与 [`Self::with_additional_writable_roots`] 不同，此方法沿用旧版
    /// writable-roots 语义：即使根已通过 `:workspace_roots` 可写，仍追加
    /// 精确根，并为每个新根追加默认的只读保护子路径。
    pub fn with_additional_legacy_workspace_writable_roots(
        mut self,
        additional_writable_roots: &[AbsolutePathBuf],
    ) -> Self {
        if !matches!(self.kind, FileSystemSandboxKind::Restricted) {
            return self;
        }

        for path in additional_writable_roots {
            if !self.entries.iter().any(|entry| {
                entry.access.can_write()
                    && matches!(&entry.path, FileSystemPath::Path { path: existing } if existing == path)
            }) {
                self.entries.push(FileSystemSandboxEntry {
                    path: FileSystemPath::Path { path: path.clone() },
                    access: FileSystemAccessMode::Write,
                });
            }

            for protected_path in default_read_only_subpaths_for_writable_root(
                path, /*protect_missing_dot_codex*/ false,
            ) {
                append_default_read_only_path_if_no_explicit_rule(
                    &mut self.entries,
                    protected_path,
                );
            }
        }

        self
    }

    /// 判断此策略在给定 `cwd` 下是否需要直接运行时强制执行。
    pub fn needs_direct_runtime_enforcement(
        &self,
        network_policy: NetworkSandboxPolicy,
        cwd: &Path,
    ) -> bool {
        if !matches!(self.kind, FileSystemSandboxKind::Restricted) {
            return false;
        }

        let Ok(legacy_policy) = self.to_legacy_sandbox_policy(network_policy, cwd) else {
            return true;
        };

        if protected_metadata_names_need_direct_runtime_enforcement(self, &legacy_policy, cwd) {
            return true;
        }

        self.semantic_signature(cwd)
            != legacy_runtime_file_system_policy_for_cwd(&legacy_policy, cwd)
                .semantic_signature(cwd)
    }

    /// 判断两个策略在给定 `cwd` 下是否解析为相同的文件系统访问模型，
    /// 忽略无意义的条目顺序差异。
    pub fn is_semantically_equivalent_to(&self, other: &Self, cwd: &Path) -> bool {
        self.semantic_signature(cwd) == other.semantic_signature(cwd)
    }

    /// 返回按给定 `cwd` 解析后的显式可读根。
    pub fn get_readable_roots_with_cwd(&self, cwd: &Path) -> Vec<AbsolutePathBuf> {
        if self.has_full_disk_read_access() {
            return Vec::new();
        }

        dedup_absolute_paths(
            self.resolved_entries_with_cwd(cwd)
                .into_iter()
                .filter(|entry| entry.access.can_read())
                .filter(|entry| self.can_read_path_with_cwd(entry.path.as_path(), cwd))
                .map(|entry| entry.path)
                .collect(),
            /*normalize_effective_paths*/ true,
        )
    }

    /// 返回按给定 `cwd` 解析后的可写根及其只读 carveout。
    pub fn get_writable_roots_with_cwd(&self, cwd: &Path) -> Vec<WritableRoot> {
        if self.has_full_disk_write_access() {
            return Vec::new();
        }

        let resolved_entries = self.resolved_entries_with_cwd(cwd);
        let writable_entries: Vec<AbsolutePathBuf> = resolved_entries
            .iter()
            .filter(|entry| entry.access.can_write())
            .filter(|entry| self.can_write_path_with_cwd(entry.path.as_path(), cwd))
            .map(|entry| entry.path.clone())
            .collect();

        dedup_absolute_paths(
            writable_entries.clone(),
            /*normalize_effective_paths*/ true,
        )
        .into_iter()
        .map(|root| {
            // 文件系统根级策略保持其有效 canonical 形式，
            // 使根范围别名不会产生重复的顶层掩码。
            // 例如：将 `/var/...` 归一化到 `/` 下，而不是同时物化
            // `/var/...` 与 `/private/var/...`。
            // 可写根下的嵌套符号链接路径保持逻辑形式，
            // 使下游 sandbox 仍能绑定真实目标，同时在需要时掩码用户可见
            // 的符号链接 inode。
            let preserve_raw_carveout_paths = root.as_path().parent().is_some();
            let raw_writable_roots: Vec<&AbsolutePathBuf> = writable_entries
                .iter()
                .filter(|path| normalize_effective_absolute_path((*path).clone()) == root)
                .collect();
            let protected_metadata_names =
                protected_metadata_names_for_writable_root(self, &root, &raw_writable_roots, cwd);
            let protect_missing_dot_codex = AbsolutePathBuf::from_absolute_path(cwd)
                .ok()
                .is_some_and(|cwd| normalize_effective_absolute_path(cwd) == root);
            let mut read_only_subpaths: Vec<AbsolutePathBuf> =
                default_read_only_subpaths_for_writable_root(&root, protect_missing_dot_codex)
                    .into_iter()
                    .filter(|path| !has_explicit_resolved_path_entry(&resolved_entries, path))
                    .collect();
            // 更窄的显式非 write 条目从更宽的可写根中 carve out。
            // 更具体的 write 条目仍保持可写，因为它们作为独立的
            // WritableRoot 值出现并被独立检查。
            // 保留位于可写根下的符号链接路径组件，
            // 使下游 sandbox 仍能掩码符号链接 inode 本身。
            // 例如：若 `<root>/.codex -> <root>/decoy`，bwrap 仍需看到
            // `<root>/.codex`，而非仅解析后的 `<root>/decoy`。
            read_only_subpaths.extend(
                resolved_entries
                    .iter()
                    .filter(|entry| !entry.access.can_write())
                    .filter(|entry| !self.can_write_path_with_cwd(entry.path.as_path(), cwd))
                    .filter_map(|entry| {
                        let effective_path = normalize_effective_absolute_path(entry.path.clone());
                        // 当 carveout 本身位于此可写根之下时，保留字面 in-root
                        // 路径，即使沿符号链接解析会回到根或逃逸到根外。
                        // 下游 sandbox 需要该原始路径以掩码符号链接 inode 本身。
                        // 示例：
                        // - `<root>/linked-private -> <root>/decoy-private`
                        // - `<root>/linked-private -> /tmp/outside-private`
                        // - `<root>/alias-root -> <root>`
                        let raw_carveout_path = if preserve_raw_carveout_paths {
                            if entry.path == root {
                                None
                            } else if entry.path.as_path().starts_with(root.as_path()) {
                                Some(entry.path.clone())
                            } else {
                                raw_writable_roots.iter().find_map(|raw_root| {
                                    let suffix = entry
                                        .path
                                        .as_path()
                                        .strip_prefix(raw_root.as_path())
                                        .ok()?;
                                    if suffix.as_os_str().is_empty() {
                                        return None;
                                    }
                                    Some(root.join(suffix))
                                })
                            }
                        } else {
                            None
                        };

                        if let Some(raw_carveout_path) = raw_carveout_path {
                            return Some(raw_carveout_path);
                        }

                        if effective_path == root
                            || !effective_path.as_path().starts_with(root.as_path())
                        {
                            return None;
                        }

                        Some(effective_path)
                    }),
            );
            WritableRoot {
                protected_metadata_names,
                root,
                // 保留 `.git`、`.codex` 等字面 in-root 保护路径，
                // 使下游 sandbox 仍能检测并掩码符号链接本身，而非仅其
                // 解析后的目标。
                read_only_subpaths: dedup_absolute_paths(
                    read_only_subpaths,
                    /*normalize_effective_paths*/ false,
                ),
            }
        })
        .collect()
    }

    /// 返回按给定 `cwd` 解析后的显式不可读根。
    pub fn get_unreadable_roots_with_cwd(&self, cwd: &Path) -> Vec<AbsolutePathBuf> {
        if !matches!(self.kind, FileSystemSandboxKind::Restricted) {
            return Vec::new();
        }

        let root = AbsolutePathBuf::from_absolute_path(cwd)
            .ok()
            .map(|cwd| absolute_root_path_for_cwd(&cwd));

        dedup_absolute_paths(
            self.resolved_entries_with_cwd(cwd)
                .iter()
                .filter(|entry| entry.access == FileSystemAccessMode::Deny)
                .filter(|entry| !self.can_read_path_with_cwd(entry.path.as_path(), cwd))
                // 受限策略已在显式 allow 根之外拒绝读取，
                // 因此在此物化文件系统根会在下游 sandbox 最后应用 deny 掩码时
                // 抹掉更窄的可读 carveout。
                .filter(|entry| root.as_ref() != Some(&entry.path))
                .map(|entry| entry.path.clone())
                .collect(),
            /*normalize_effective_paths*/ true,
        )
    }

    /// 返回按给定 `cwd` 解析后的不可读 glob 模式列表。
    pub fn get_unreadable_globs_with_cwd(&self, cwd: &Path) -> Vec<String> {
        if !matches!(self.kind, FileSystemSandboxKind::Restricted) {
            return Vec::new();
        }

        let mut patterns = self
            .entries
            .iter()
            .filter(|entry| entry.access == FileSystemAccessMode::Deny)
            .filter_map(|entry| match &entry.path {
                FileSystemPath::GlobPattern { pattern } => {
                    Some(AbsolutePathBuf::resolve_path_against_base(pattern, cwd))
                }
                FileSystemPath::Path { .. } | FileSystemPath::Special { .. } => None,
            })
            .map(|pattern| pattern.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        patterns.sort();
        patterns.dedup();
        patterns
    }

    /// 将文件系统策略转换为旧版 [`SandboxPolicy`]。
    pub fn to_legacy_sandbox_policy(
        &self,
        network_policy: NetworkSandboxPolicy,
        cwd: &Path,
    ) -> io::Result<SandboxPolicy> {
        Ok(match self.kind {
            FileSystemSandboxKind::ExternalSandbox => SandboxPolicy::ExternalSandbox {
                network_access: if network_policy.is_enabled() {
                    NetworkAccess::Enabled
                } else {
                    NetworkAccess::Restricted
                },
            },
            FileSystemSandboxKind::Unrestricted => {
                if network_policy.is_enabled() {
                    SandboxPolicy::DangerFullAccess
                } else {
                    SandboxPolicy::ExternalSandbox {
                        network_access: NetworkAccess::Restricted,
                    }
                }
            }
            FileSystemSandboxKind::Restricted => {
                let cwd_absolute = AbsolutePathBuf::from_absolute_path(cwd).ok();
                let has_full_disk_write_access = self.has_full_disk_write_access();
                let mut workspace_root_writable = false;
                let mut writable_roots = Vec::new();
                let mut tmpdir_writable = false;
                let mut slash_tmp_writable = false;
                let mut unbridgeable_root_write = false;

                for entry in &self.entries {
                    match &entry.path {
                        FileSystemPath::GlobPattern { .. } => {}
                        FileSystemPath::Path { path } => {
                            if entry.access.can_write() {
                                if cwd_absolute.as_ref().is_some_and(|cwd| cwd == path) {
                                    workspace_root_writable = true;
                                } else {
                                    writable_roots.push(path.clone());
                                }
                            }
                        }
                        FileSystemPath::Special { value } => match value {
                            FileSystemSpecialPath::Root => match entry.access {
                                FileSystemAccessMode::Deny => {}
                                FileSystemAccessMode::Read => {}
                                FileSystemAccessMode::Write => {
                                    unbridgeable_root_write = true;
                                }
                            },
                            FileSystemSpecialPath::Minimal => {}
                            FileSystemSpecialPath::ProjectRoots { subpath } => {
                                if subpath.is_none() && entry.access.can_write() {
                                    workspace_root_writable = true;
                                } else if let Some(path) =
                                    resolve_file_system_special_path(value, cwd_absolute.as_ref())
                                    && entry.access.can_write()
                                {
                                    writable_roots.push(path);
                                }
                            }
                            FileSystemSpecialPath::Tmpdir => {
                                if entry.access.can_write() {
                                    tmpdir_writable = true;
                                }
                            }
                            FileSystemSpecialPath::SlashTmp => {
                                if entry.access.can_write() {
                                    slash_tmp_writable = true;
                                }
                            }
                            FileSystemSpecialPath::Unknown { .. } => {}
                        },
                    }
                }

                if has_full_disk_write_access {
                    return Ok(if network_policy.is_enabled() {
                        SandboxPolicy::DangerFullAccess
                    } else {
                        SandboxPolicy::ExternalSandbox {
                            network_access: NetworkAccess::Restricted,
                        }
                    });
                }

                if workspace_root_writable {
                    SandboxPolicy::WorkspaceWrite {
                        writable_roots: dedup_absolute_paths(
                            writable_roots,
                            /*normalize_effective_paths*/ false,
                        ),
                        network_access: network_policy.is_enabled(),
                        exclude_tmpdir_env_var: !tmpdir_writable,
                        exclude_slash_tmp: !slash_tmp_writable,
                    }
                } else if unbridgeable_root_write
                    || !writable_roots.is_empty()
                    || tmpdir_writable
                    || slash_tmp_writable
                {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "permissions profile requests filesystem writes outside the workspace root, which is not supported until the runtime enforces FileSystemSandboxPolicy directly",
                    ));
                } else {
                    SandboxPolicy::ReadOnly {
                        network_access: network_policy.is_enabled(),
                    }
                }
            }
        })
    }

    fn resolved_entries_with_cwd(&self, cwd: &Path) -> Vec<ResolvedFileSystemEntry> {
        let cwd_absolute = AbsolutePathBuf::from_absolute_path(cwd).ok();
        self.entries
            .iter()
            .filter_map(|entry| {
                resolve_entry_path(&entry.path, cwd_absolute.as_ref()).map(|path| {
                    ResolvedFileSystemEntry {
                        path,
                        access: entry.access,
                    }
                })
            })
            .collect()
    }

    fn semantic_signature(&self, cwd: &Path) -> FileSystemSemanticSignature {
        FileSystemSemanticSignature {
            has_full_disk_read_access: self.has_full_disk_read_access(),
            has_full_disk_write_access: self.has_full_disk_write_access(),
            include_platform_defaults: self.include_platform_defaults(),
            readable_roots: sorted_absolute_paths(self.get_readable_roots_with_cwd(cwd)),
            writable_roots: sorted_writable_roots(self.get_writable_roots_with_cwd(cwd)),
            unreadable_roots: sorted_absolute_paths(self.get_unreadable_roots_with_cwd(cwd)),
            unreadable_globs: self.get_unreadable_globs_with_cwd(cwd),
        }
    }
}

impl From<&SandboxPolicy> for NetworkSandboxPolicy {
    fn from(value: &SandboxPolicy) -> Self {
        if value.has_full_network_access() {
            NetworkSandboxPolicy::Enabled
        } else {
            NetworkSandboxPolicy::Restricted
        }
    }
}

impl From<&SandboxPolicy> for FileSystemSandboxPolicy {
    fn from(value: &SandboxPolicy) -> Self {
        match value {
            SandboxPolicy::DangerFullAccess => FileSystemSandboxPolicy::unrestricted(),
            SandboxPolicy::ExternalSandbox { .. } => FileSystemSandboxPolicy::external_sandbox(),
            SandboxPolicy::ReadOnly { .. } => {
                FileSystemSandboxPolicy::restricted(vec![FileSystemSandboxEntry {
                    path: FileSystemPath::Special {
                        value: FileSystemSpecialPath::Root,
                    },
                    access: FileSystemAccessMode::Read,
                }])
            }
            SandboxPolicy::WorkspaceWrite {
                writable_roots,
                exclude_tmpdir_env_var,
                exclude_slash_tmp,
                ..
            } => FileSystemSandboxPolicy::workspace_write(
                writable_roots,
                *exclude_tmpdir_env_var,
                *exclude_slash_tmp,
            ),
        }
    }
}

fn resolve_file_system_path(
    path: &FileSystemPath,
    cwd: Option<&AbsolutePathBuf>,
) -> Option<AbsolutePathBuf> {
    match path {
        FileSystemPath::Path { path } => Some(path.clone()),
        FileSystemPath::GlobPattern { .. } => None,
        FileSystemPath::Special { value } => resolve_file_system_special_path(value, cwd),
    }
}

fn resolve_entry_path(
    path: &FileSystemPath,
    cwd: Option<&AbsolutePathBuf>,
) -> Option<AbsolutePathBuf> {
    match path {
        FileSystemPath::Special {
            value: FileSystemSpecialPath::Root,
        } => cwd.map(absolute_root_path_for_cwd),
        _ => resolve_file_system_path(path, cwd),
    }
}

fn parse_project_roots_glob_pattern(pattern: &str) -> Option<&Path> {
    pattern
        .strip_prefix(PROJECT_ROOTS_GLOB_PATTERN_PREFIX)
        .map(Path::new)
}

fn resolve_project_roots_glob_pattern(subpath: &Path, root: &AbsolutePathBuf) -> String {
    AbsolutePathBuf::resolve_path_against_base(subpath, root.as_path())
        .to_string_lossy()
        .into_owned()
}

fn resolve_candidate_path(path: &Path, cwd: &Path) -> Option<AbsolutePathBuf> {
    if path.is_absolute() {
        AbsolutePathBuf::from_absolute_path(path).ok()
    } else {
        Some(AbsolutePathBuf::from_absolute_path(cwd).ok()?.join(path))
    }
}

/// 判断两条配置路径在应用前缀匹配之前是否指向同一精确目标。
///
/// 此处故意比完整路径解析更窄：它只回答"在同一具体度下，一条条目能否
/// 遮蔽另一条？"这一 `has_write_narrowing_entries` 关心的问题。
fn file_system_paths_share_target(left: &FileSystemPath, right: &FileSystemPath) -> bool {
    match (left, right) {
        (FileSystemPath::Path { path: left }, FileSystemPath::Path { path: right }) => {
            left == right
        }
        (FileSystemPath::Special { value: left }, FileSystemPath::Special { value: right }) => {
            special_paths_share_target(left, right)
        }
        (FileSystemPath::Path { path }, FileSystemPath::Special { value })
        | (FileSystemPath::Special { value }, FileSystemPath::Path { path }) => {
            special_path_matches_absolute_path(value, path)
        }
        (
            FileSystemPath::GlobPattern { pattern: left },
            FileSystemPath::GlobPattern { pattern: right },
        ) => left == right,
        (FileSystemPath::GlobPattern { .. }, _) | (_, FileSystemPath::GlobPattern { .. }) => false,
    }
}

/// 比较指向同一具体目标的 special-path token，无需 cwd。
fn special_paths_share_target(left: &FileSystemSpecialPath, right: &FileSystemSpecialPath) -> bool {
    match (left, right) {
        (FileSystemSpecialPath::Root, FileSystemSpecialPath::Root)
        | (FileSystemSpecialPath::Minimal, FileSystemSpecialPath::Minimal)
        | (FileSystemSpecialPath::Tmpdir, FileSystemSpecialPath::Tmpdir)
        | (FileSystemSpecialPath::SlashTmp, FileSystemSpecialPath::SlashTmp) => true,
        (
            FileSystemSpecialPath::ProjectRoots { subpath: left },
            FileSystemSpecialPath::ProjectRoots { subpath: right },
        ) => left == right,
        (
            FileSystemSpecialPath::Unknown {
                path: left,
                subpath: left_subpath,
            },
            FileSystemSpecialPath::Unknown {
                path: right,
                subpath: right_subpath,
            },
        ) => left == right && left_subpath == right_subpath,
        _ => false,
    }
}

/// 当 cwd 无关的 special path 与绝对 `Path` 指向同一位置时进行匹配。
///
/// 此处故意只折叠那些在没有 cwd 时具体含义稳定的 special path，
/// 例如 `/` 与 `/tmp`。
fn special_path_matches_absolute_path(
    value: &FileSystemSpecialPath,
    path: &AbsolutePathBuf,
) -> bool {
    match value {
        FileSystemSpecialPath::Root => path.as_path().parent().is_none(),
        FileSystemSpecialPath::SlashTmp => path.as_path() == Path::new("/tmp"),
        _ => false,
    }
}

/// 对解析后的条目排序：最具体的路径优先，然后应用
/// [`FileSystemAccessMode`] 的访问 tie-breaker。
fn resolved_entry_precedence(entry: &ResolvedFileSystemEntry) -> (usize, FileSystemAccessMode) {
    let specificity = entry.path.as_path().components().count();
    (specificity, entry.access)
}

/// 返回给定 cwd 的文件系统根路径。
fn absolute_root_path_for_cwd(cwd: &AbsolutePathBuf) -> AbsolutePathBuf {
    let root = cwd
        .as_path()
        .ancestors()
        .last()
        .unwrap_or_else(|| panic!("cwd must have a filesystem root"));
    AbsolutePathBuf::from_absolute_path(root)
        .unwrap_or_else(|err| panic!("cwd root must be an absolute path: {err}"))
}

/// 返回路径的规范化与 canonical 候选列表。
fn normalized_and_canonical_candidates(path: &Path) -> Vec<PathBuf> {
    // 比较词法绝对形式与 canonical 目标（若存在）。
    // 缺失路径仍需要词法候选，使未来创建的被拒绝路径仍被直接 tool 检查拦截。
    let mut candidates = Vec::new();

    if let Ok(normalized) = AbsolutePathBuf::from_absolute_path(path) {
        push_unique(&mut candidates, normalized.to_path_buf());
    } else {
        push_unique(&mut candidates, path.to_path_buf());
    }

    if let Ok(canonical) = path.canonicalize()
        && let Ok(canonical_absolute) = AbsolutePathBuf::from_absolute_path(canonical)
    {
        push_unique(&mut candidates, canonical_absolute.to_path_buf());
    }

    candidates
}

/// 将候选路径加入列表，去重保留首次出现。
fn push_unique(candidates: &mut Vec<PathBuf>, candidate: PathBuf) {
    if !candidates.iter().any(|existing| existing == &candidate) {
        candidates.push(candidate);
    }
}

/// 由 glob 模式字符串构建匹配器。
fn build_glob_matcher(pattern: &str) -> Result<GlobMatcher, String> {
    // 将 `*` 与 `?` 限制在单个路径组件内，并将未闭合的 `[` 作为字面量保留，
    // 使匹配器行为与配置解析保持一致。
    GlobBuilder::new(pattern)
        .literal_separator(true)
        .allow_unclosed_class(true)
        .build()
        .map(|glob| glob.compile_matcher())
        .map_err(|err| err.to_string())
}

fn resolve_file_system_special_path(
    value: &FileSystemSpecialPath,
    cwd: Option<&AbsolutePathBuf>,
) -> Option<AbsolutePathBuf> {
    match value {
        FileSystemSpecialPath::Root
        | FileSystemSpecialPath::Minimal
        | FileSystemSpecialPath::Unknown { .. } => None,
        FileSystemSpecialPath::ProjectRoots { subpath } => {
            let cwd = cwd?;
            match subpath.as_ref() {
                Some(subpath) => Some(AbsolutePathBuf::resolve_path_against_base(
                    subpath,
                    cwd.as_path(),
                )),
                None => Some(cwd.clone()),
            }
        }
        FileSystemSpecialPath::Tmpdir => {
            let tmpdir = std::env::var_os("TMPDIR")?;
            if tmpdir.is_empty() {
                None
            } else {
                let tmpdir = AbsolutePathBuf::from_absolute_path(PathBuf::from(tmpdir)).ok()?;
                Some(tmpdir)
            }
        }
        FileSystemSpecialPath::SlashTmp => {
            #[allow(clippy::expect_used)]
            let slash_tmp = AbsolutePathBuf::from_absolute_path("/tmp").expect("/tmp is absolute");
            if !slash_tmp.as_path().is_dir() {
                return None;
            }
            Some(slash_tmp)
        }
    }
}

fn dedup_absolute_paths(
    paths: Vec<AbsolutePathBuf>,
    normalize_effective_paths: bool,
) -> Vec<AbsolutePathBuf> {
    let mut deduped = Vec::with_capacity(paths.len());
    let mut seen = HashSet::new();
    for path in paths {
        let dedup_path = if normalize_effective_paths {
            normalize_effective_absolute_path(path)
        } else {
            path
        };
        if seen.insert(dedup_path.to_path_buf()) {
            deduped.push(dedup_path);
        }
    }
    deduped
}

fn sorted_absolute_paths(mut paths: Vec<AbsolutePathBuf>) -> Vec<AbsolutePathBuf> {
    paths.sort_by(|left, right| left.as_path().cmp(right.as_path()));
    paths
}

fn sorted_writable_roots(mut roots: Vec<WritableRoot>) -> Vec<WritableRoot> {
    for root in &mut roots {
        root.read_only_subpaths =
            sorted_absolute_paths(std::mem::take(&mut root.read_only_subpaths));
        root.protected_metadata_names.sort();
        root.protected_metadata_names.dedup();
    }
    roots.sort_by(|left, right| left.root.as_path().cmp(right.root.as_path()));
    roots
}

fn normalize_effective_absolute_path(path: AbsolutePathBuf) -> AbsolutePathBuf {
    let raw_path = path.to_path_buf();
    for ancestor in raw_path.ancestors() {
        if std::fs::symlink_metadata(ancestor).is_err() {
            continue;
        }
        let Ok(normalized_ancestor) = canonicalize_preserving_symlinks(ancestor) else {
            continue;
        };
        let Ok(suffix) = raw_path.strip_prefix(ancestor) else {
            continue;
        };
        if let Ok(normalized_path) =
            AbsolutePathBuf::from_absolute_path(normalized_ancestor.join(suffix))
        {
            return normalized_path;
        }
    }
    path
}

pub(crate) fn default_read_only_subpaths_for_writable_root(
    writable_root: &AbsolutePathBuf,
    protect_missing_dot_codex: bool,
) -> Vec<AbsolutePathBuf> {
    let mut subpaths: Vec<AbsolutePathBuf> = Vec::new();
    let top_level_git = writable_root.join(PROTECTED_METADATA_GIT_PATH_NAME);
    // 此规则适用于典型仓库（目录形式 .git）、worktree/submodule
    // （文件形式 .git，含 gitdir 指针），以及 gitdir 即为 writable root
    // 本身的 bare repo。
    let top_level_git_is_file = top_level_git.as_path().is_file();
    let top_level_git_is_dir = top_level_git.as_path().is_dir();
    let should_protect_top_level = top_level_git_is_dir || top_level_git_is_file;
    if should_protect_top_level {
        if top_level_git_is_file
            && is_git_pointer_file(&top_level_git)
            && let Some(gitdir) = resolve_gitdir_from_file(&top_level_git)
        {
            subpaths.push(gitdir);
        }
        subpaths.push(top_level_git);
    }

    let top_level_agents = writable_root.join(PROTECTED_METADATA_AGENTS_PATH_NAME);
    if top_level_agents.as_path().is_dir() {
        subpaths.push(top_level_agents);
    }

    // 默认将 `.codex` 下的顶层项目元数据对 Agent 保持只读。
    // 对于 workspace 根本身，即使目录尚未存在也进行保护，使首次创建
    // 仍需经过受保护路径审批流程。
    let top_level_codex = writable_root.join(PROTECTED_METADATA_CODEX_PATH_NAME);
    if protect_missing_dot_codex || top_level_codex.as_path().is_dir() {
        subpaths.push(top_level_codex);
    }

    dedup_absolute_paths(subpaths, /*normalize_effective_paths*/ false)
}

/// 重建旧版 sandbox 运行时在指定 cwd 下强制执行的文件系统策略。
///
/// 与 [`FileSystemSandboxPolicy::from_legacy_sandbox_policy_for_cwd`] 不同，
/// 此函数故意不添加符号化的项目根元数据 carveout。旧版运行时展开仅在
/// `.git`/`.agents` 路径已存在时才保护它们，因此缺失路径的 carveout
/// 仍需通过直接 profile 强制执行。
fn legacy_runtime_file_system_policy_for_cwd(
    sandbox_policy: &SandboxPolicy,
    cwd: &Path,
) -> FileSystemSandboxPolicy {
    let SandboxPolicy::WorkspaceWrite {
        writable_roots,
        exclude_tmpdir_env_var,
        exclude_slash_tmp,
        ..
    } = sandbox_policy
    else {
        return FileSystemSandboxPolicy::from(sandbox_policy);
    };

    let mut entries = vec![
        FileSystemSandboxEntry {
            path: FileSystemPath::Special {
                value: FileSystemSpecialPath::Root,
            },
            access: FileSystemAccessMode::Read,
        },
        FileSystemSandboxEntry {
            path: FileSystemPath::Special {
                value: FileSystemSpecialPath::project_roots(/*subpath*/ None),
            },
            access: FileSystemAccessMode::Write,
        },
    ];

    if !*exclude_slash_tmp {
        entries.push(FileSystemSandboxEntry {
            path: FileSystemPath::Special {
                value: FileSystemSpecialPath::SlashTmp,
            },
            access: FileSystemAccessMode::Write,
        });
    }
    if !*exclude_tmpdir_env_var {
        entries.push(FileSystemSandboxEntry {
            path: FileSystemPath::Special {
                value: FileSystemSpecialPath::Tmpdir,
            },
            access: FileSystemAccessMode::Write,
        });
    }
    entries.extend(
        writable_roots
            .iter()
            .cloned()
            .map(|path| FileSystemSandboxEntry {
                path: FileSystemPath::Path { path },
                access: FileSystemAccessMode::Write,
            }),
    );

    if let Ok(cwd_root) = AbsolutePathBuf::from_absolute_path(cwd) {
        for protected_path in default_read_only_subpaths_for_writable_root(
            &cwd_root, /*protect_missing_dot_codex*/ true,
        ) {
            append_default_read_only_path_if_no_explicit_rule(&mut entries, protected_path);
        }
    }
    for writable_root in writable_roots {
        for protected_path in default_read_only_subpaths_for_writable_root(
            writable_root,
            /*protect_missing_dot_codex*/ false,
        ) {
            append_default_read_only_path_if_no_explicit_rule(&mut entries, protected_path);
        }
    }

    FileSystemSandboxPolicy::restricted(entries)
}

fn append_default_read_only_project_root_subpath_if_no_explicit_rule(
    entries: &mut Vec<FileSystemSandboxEntry>,
    subpath: impl Into<PathBuf>,
) {
    append_default_read_only_entry_if_no_explicit_rule(
        entries,
        FileSystemPath::Special {
            value: FileSystemSpecialPath::project_roots(Some(subpath.into())),
        },
    );
}

fn append_default_read_only_path_if_no_explicit_rule(
    entries: &mut Vec<FileSystemSandboxEntry>,
    path: AbsolutePathBuf,
) {
    append_default_read_only_entry_if_no_explicit_rule(entries, FileSystemPath::Path { path });
}

fn append_default_read_only_entry_if_no_explicit_rule(
    entries: &mut Vec<FileSystemSandboxEntry>,
    path: FileSystemPath,
) {
    if entries
        .iter()
        .any(|entry| file_system_paths_share_target(&entry.path, &path))
    {
        return;
    }

    entries.push(FileSystemSandboxEntry {
        path,
        access: FileSystemAccessMode::Read,
    });
}

fn has_explicit_resolved_path_entry(
    entries: &[ResolvedFileSystemEntry],
    path: &AbsolutePathBuf,
) -> bool {
    entries.iter().any(|entry| &entry.path == path)
}

fn metadata_path_name(name: &OsStr) -> Option<&'static str> {
    PROTECTED_METADATA_PATH_NAMES
        .iter()
        .copied()
        .find(|metadata_name| name == OsStr::new(metadata_name))
}

fn metadata_child_of_writable_root(
    policy: &FileSystemSandboxPolicy,
    target: &Path,
    cwd: &Path,
) -> Option<(AbsolutePathBuf, &'static str)> {
    policy
        .resolved_entries_with_cwd(cwd)
        .iter()
        .filter(|entry| entry.access.can_write())
        .filter_map(|entry| {
            let relative_path = target.strip_prefix(entry.path.as_path()).ok()?;
            let first_component = relative_path.components().next()?;
            let metadata_name = metadata_path_name(first_component.as_os_str())?;
            Some((entry.path.join(metadata_name), metadata_name))
        })
        .next()
}

fn protected_metadata_names_for_writable_root(
    policy: &FileSystemSandboxPolicy,
    root: &AbsolutePathBuf,
    raw_writable_roots: &[&AbsolutePathBuf],
    cwd: &Path,
) -> Vec<String> {
    let mut protected_names = Vec::new();
    for metadata_name in PROTECTED_METADATA_PATH_NAMES {
        let mut metadata_paths = vec![root.join(*metadata_name)];
        metadata_paths.extend(
            raw_writable_roots
                .iter()
                .map(|raw_root| raw_root.join(*metadata_name)),
        );

        if metadata_paths
            .iter()
            .all(|metadata_path| !policy.can_write_path_with_cwd(metadata_path.as_path(), cwd))
        {
            protected_names.push((*metadata_name).to_string());
        }
    }
    protected_names
}

fn protected_metadata_names_need_direct_runtime_enforcement(
    policy: &FileSystemSandboxPolicy,
    legacy_policy: &SandboxPolicy,
    cwd: &Path,
) -> bool {
    let legacy_roots = legacy_policy.get_writable_roots_with_cwd(cwd);
    policy
        .get_writable_roots_with_cwd(cwd)
        .into_iter()
        .any(|writable_root| {
            let Some(legacy_root) = legacy_roots
                .iter()
                .find(|candidate| candidate.root == writable_root.root)
            else {
                return !writable_root.protected_metadata_names.is_empty();
            };

            writable_root
                .protected_metadata_names
                .iter()
                .any(|metadata_name| {
                    let metadata_path = writable_root.root.join(metadata_name);
                    !legacy_root
                        .read_only_subpaths
                        .iter()
                        .any(|subpath| subpath == &metadata_path)
                })
        })
}

fn has_explicit_write_entry_for_metadata_path(
    policy: &FileSystemSandboxPolicy,
    protected_metadata_path: &AbsolutePathBuf,
    target: &Path,
    cwd: &Path,
) -> bool {
    policy.resolved_entries_with_cwd(cwd).iter().any(|entry| {
        entry.access.can_write()
            && target.starts_with(entry.path.as_path())
            && entry
                .path
                .as_path()
                .starts_with(protected_metadata_path.as_path())
    })
}

fn is_git_pointer_file(path: &AbsolutePathBuf) -> bool {
    path.as_path().is_file()
        && path.as_path().file_name() == Some(OsStr::new(PROTECTED_METADATA_GIT_PATH_NAME))
}

fn resolve_gitdir_from_file(dot_git: &AbsolutePathBuf) -> Option<AbsolutePathBuf> {
    let contents = match std::fs::read_to_string(dot_git.as_path()) {
        Ok(contents) => contents,
        Err(err) => {
            error!(
                "Failed to read {path} for gitdir pointer: {err}",
                path = dot_git.as_path().display()
            );
            return None;
        }
    };

    let trimmed = contents.trim();
    let (_, gitdir_raw) = match trimmed.split_once(':') {
        Some((prefix, gitdir_raw)) if prefix.trim() == "gitdir" => (prefix, gitdir_raw),
        Some(_) => {
            error!(
                "Expected {path} to contain a gitdir pointer, but it did not match `gitdir: <path>`.",
                path = dot_git.as_path().display()
            );
            return None;
        }
        None => {
            error!(
                "Expected {path} to contain a gitdir pointer, but it did not match `gitdir: <path>`.",
                path = dot_git.as_path().display()
            );
            return None;
        }
    };
    let gitdir_raw = gitdir_raw.trim();
    if gitdir_raw.is_empty() {
        error!(
            "Expected {path} to contain a gitdir pointer, but it was empty.",
            path = dot_git.as_path().display()
        );
        return None;
    }
    let base = match dot_git.as_path().parent() {
        Some(base) => base,
        None => {
            error!(
                "Unable to resolve parent directory for {path}.",
                path = dot_git.as_path().display()
            );
            return None;
        }
    };
    let gitdir_path = AbsolutePathBuf::resolve_path_against_base(gitdir_raw, base);
    if !gitdir_path.as_path().exists() {
        error!(
            "Resolved gitdir path {path} does not exist.",
            path = gitdir_path.as_path().display()
        );
        return None;
    }
    Some(gitdir_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    #[cfg(unix)]
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    #[cfg(unix)]
    const SYMLINKED_TMPDIR_TEST_ENV: &str = "CODEX_PROTOCOL_TEST_SYMLINKED_TMPDIR";

    #[cfg(unix)]
    fn symlink_dir(original: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(original, link)
    }

    #[test]
    fn unknown_special_paths_are_ignored_by_legacy_bridge() -> std::io::Result<()> {
        let policy = FileSystemSandboxPolicy::restricted(vec![
            FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::Root,
                },
                access: FileSystemAccessMode::Read,
            },
            FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::unknown(
                        ":future_special_path",
                        /*subpath*/ None,
                    ),
                },
                access: FileSystemAccessMode::Write,
            },
        ]);

        let sandbox_policy = policy.to_legacy_sandbox_policy(
            NetworkSandboxPolicy::Restricted,
            Path::new("/tmp/workspace"),
        )?;

        assert_eq!(
            sandbox_policy,
            SandboxPolicy::ReadOnly {
                network_access: false,
            }
        );
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn writable_roots_proactively_protect_missing_dot_codex() {
        let cwd = TempDir::new().expect("tempdir");
        let expected_root = AbsolutePathBuf::from_absolute_path(
            cwd.path().canonicalize().expect("canonicalize cwd"),
        )
        .expect("absolute canonical root");
        let expected_dot_codex = expected_root.join(".codex");

        let policy = FileSystemSandboxPolicy::restricted(vec![FileSystemSandboxEntry {
            path: FileSystemPath::Special {
                value: FileSystemSpecialPath::project_roots(/*subpath*/ None),
            },
            access: FileSystemAccessMode::Write,
        }]);

        let writable_roots = policy.get_writable_roots_with_cwd(cwd.path());
        assert_eq!(writable_roots.len(), 1);
        assert_eq!(writable_roots[0].root, expected_root);
        assert!(
            writable_roots[0]
                .read_only_subpaths
                .contains(&expected_dot_codex)
        );
    }

    #[test]
    fn legacy_workspace_write_projection_preserves_symbolic_project_root() {
        let policy = SandboxPolicy::WorkspaceWrite {
            writable_roots: Vec::new(),
            network_access: false,
            exclude_tmpdir_env_var: true,
            exclude_slash_tmp: true,
        };

        assert_eq!(
            FileSystemSandboxPolicy::from(&policy),
            FileSystemSandboxPolicy::restricted(vec![
                FileSystemSandboxEntry {
                    path: FileSystemPath::Special {
                        value: FileSystemSpecialPath::Root,
                    },
                    access: FileSystemAccessMode::Read,
                },
                FileSystemSandboxEntry {
                    path: FileSystemPath::Special {
                        value: FileSystemSpecialPath::project_roots(/*subpath*/ None),
                    },
                    access: FileSystemAccessMode::Write,
                },
                FileSystemSandboxEntry {
                    path: FileSystemPath::Special {
                        value: FileSystemSpecialPath::project_roots(Some(".git".into())),
                    },
                    access: FileSystemAccessMode::Read,
                },
                FileSystemSandboxEntry {
                    path: FileSystemPath::Special {
                        value: FileSystemSpecialPath::project_roots(Some(".agents".into())),
                    },
                    access: FileSystemAccessMode::Read,
                },
                FileSystemSandboxEntry {
                    path: FileSystemPath::Special {
                        value: FileSystemSpecialPath::project_roots(Some(".codex".into())),
                    },
                    access: FileSystemAccessMode::Read,
                },
            ])
        );
    }

    #[test]
    fn legacy_current_working_directory_special_path_deserializes_as_project_roots()
    -> serde_json::Result<()> {
        let value = serde_json::json!({
            "kind": "current_working_directory",
        });

        let special_path = serde_json::from_value::<FileSystemSpecialPath>(value)?;
        assert_eq!(
            special_path,
            FileSystemSpecialPath::project_roots(/*subpath*/ None)
        );
        assert_eq!(
            serde_json::to_value(&special_path)?,
            serde_json::json!({
                "kind": "project_roots",
            })
        );
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn writable_roots_skip_default_dot_codex_when_explicit_user_rule_exists() {
        let cwd = TempDir::new().expect("tempdir");
        let expected_root = AbsolutePathBuf::from_absolute_path(
            cwd.path().canonicalize().expect("canonicalize cwd"),
        )
        .expect("absolute canonical root");
        let explicit_dot_codex = expected_root.join(".codex");

        let policy = FileSystemSandboxPolicy::restricted(vec![
            FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::project_roots(/*subpath*/ None),
                },
                access: FileSystemAccessMode::Write,
            },
            FileSystemSandboxEntry {
                path: FileSystemPath::Path {
                    path: explicit_dot_codex.clone(),
                },
                access: FileSystemAccessMode::Write,
            },
        ]);

        let writable_roots = policy.get_writable_roots_with_cwd(cwd.path());
        let workspace_root = writable_roots
            .iter()
            .find(|root| root.root == expected_root)
            .expect("workspace writable root");
        assert!(
            !workspace_root
                .protected_metadata_names
                .contains(&".codex".to_string()),
            "explicit .codex rule should remove the metadata-name protection"
        );
        assert!(
            !workspace_root
                .read_only_subpaths
                .contains(&explicit_dot_codex),
            "explicit .codex rule should win over the default protected carveout"
        );
        assert!(
            policy.can_write_path_with_cwd(
                explicit_dot_codex.join("config.toml").as_path(),
                cwd.path()
            )
        );
    }

    #[test]
    fn filesystem_policy_blocks_protected_metadata_path_writes_by_default() {
        let cwd = TempDir::new().expect("tempdir");
        let dot_git_config = cwd.path().join(".git").join("config");
        let dot_agents_config = cwd.path().join(".agents").join("config");
        let dot_codex_config = cwd.path().join(".codex").join("config.toml");
        let root = AbsolutePathBuf::from_absolute_path(cwd.path()).expect("absolute cwd");
        let file_system_policy =
            FileSystemSandboxPolicy::restricted(vec![FileSystemSandboxEntry {
                path: FileSystemPath::Path { path: root },
                access: FileSystemAccessMode::Write,
            }]);

        assert!(!file_system_policy.can_write_path_with_cwd(&dot_git_config, cwd.path()));
        assert!(!file_system_policy.can_write_path_with_cwd(&dot_agents_config, cwd.path()));
        assert!(!file_system_policy.can_write_path_with_cwd(&dot_codex_config, cwd.path()));

        let writable_roots = file_system_policy.get_writable_roots_with_cwd(cwd.path());
        assert_eq!(writable_roots.len(), 1);
        assert_eq!(
            writable_roots[0].protected_metadata_names,
            vec![
                ".git".to_string(),
                ".agents".to_string(),
                ".codex".to_string(),
            ]
        );
        assert!(!writable_roots[0].is_path_writable(&dot_git_config));
        assert!(!writable_roots[0].is_path_writable(&dot_agents_config));
        assert!(!writable_roots[0].is_path_writable(&dot_codex_config));
    }

    #[test]
    fn legacy_workspace_write_projection_accepts_relative_cwd() {
        let relative_cwd = Path::new("workspace");
        let expected_root = AbsolutePathBuf::from_absolute_path(
            std::env::current_dir()
                .expect("current dir")
                .join(relative_cwd),
        )
        .expect("absolute root");
        let policy = SandboxPolicy::WorkspaceWrite {
            writable_roots: vec![],
            network_access: false,
            exclude_tmpdir_env_var: true,
            exclude_slash_tmp: true,
        };

        let file_system_policy =
            FileSystemSandboxPolicy::from_legacy_sandbox_policy_for_cwd(&policy, relative_cwd);

        let mut expected_entries = vec![
            FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::Root,
                },
                access: FileSystemAccessMode::Read,
            },
            FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::project_roots(/*subpath*/ None),
                },
                access: FileSystemAccessMode::Write,
            },
        ];
        expected_entries.extend(PROTECTED_METADATA_PATH_NAMES.iter().map(|name| {
            FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::project_roots(Some((*name).into())),
                },
                access: FileSystemAccessMode::Read,
            }
        }));
        expected_entries.extend(
            default_read_only_subpaths_for_writable_root(
                &expected_root,
                /*protect_missing_dot_codex*/ true,
            )
            .into_iter()
            .map(|path| FileSystemSandboxEntry {
                path: FileSystemPath::Path { path },
                access: FileSystemAccessMode::Read,
            }),
        );

        assert_eq!(
            file_system_policy,
            FileSystemSandboxPolicy::restricted(expected_entries)
        );
        assert_eq!(
            forbidden_agent_metadata_write(
                Path::new(".git/config"),
                relative_cwd,
                &file_system_policy,
            ),
            Some(".git")
        );
        assert!(
            !file_system_policy
                .can_write_path_with_cwd(Path::new(".codex/config.toml"), relative_cwd,)
        );
        assert!(
            !file_system_policy.can_write_path_with_cwd(
                Path::new(".agents/skills/example/SKILL.md"),
                relative_cwd,
            )
        );
    }

    #[cfg(unix)]
    #[test]
    fn effective_runtime_roots_preserve_symlinked_paths() {
        let cwd = TempDir::new().expect("tempdir");
        let real_root = cwd.path().join("real");
        let link_root = cwd.path().join("link");
        let blocked = real_root.join("blocked");
        let codex_dir = real_root.join(".codex");

        fs::create_dir_all(&blocked).expect("create blocked");
        fs::create_dir_all(&codex_dir).expect("create .codex");
        symlink_dir(&real_root, &link_root).expect("create symlinked root");

        let link_root =
            AbsolutePathBuf::from_absolute_path(&link_root).expect("absolute symlinked root");
        let link_blocked = link_root.join("blocked");
        let expected_root = link_root.clone();
        let expected_blocked = link_blocked.clone();
        let expected_codex = link_root.join(".codex");

        let policy = FileSystemSandboxPolicy::restricted(vec![
            FileSystemSandboxEntry {
                path: FileSystemPath::Path { path: link_root },
                access: FileSystemAccessMode::Write,
            },
            FileSystemSandboxEntry {
                path: FileSystemPath::Path { path: link_blocked },
                access: FileSystemAccessMode::Deny,
            },
        ]);

        assert_eq!(
            policy.get_unreadable_roots_with_cwd(cwd.path()),
            vec![expected_blocked.clone()]
        );

        let writable_roots = policy.get_writable_roots_with_cwd(cwd.path());
        assert_eq!(writable_roots.len(), 1);
        assert_eq!(writable_roots[0].root, expected_root);
        assert!(
            writable_roots[0]
                .read_only_subpaths
                .contains(&expected_blocked)
        );
        assert!(
            writable_roots[0]
                .read_only_subpaths
                .contains(&expected_codex)
        );
    }

    #[cfg(unix)]
    #[test]
    fn project_roots_special_path_preserves_symlinked_root() {
        let cwd = TempDir::new().expect("tempdir");
        let real_root = cwd.path().join("real");
        let link_root = cwd.path().join("link");
        let blocked = real_root.join("blocked");
        let agents_dir = real_root.join(".agents");
        let codex_dir = real_root.join(".codex");

        fs::create_dir_all(&blocked).expect("create blocked");
        fs::create_dir_all(&agents_dir).expect("create .agents");
        fs::create_dir_all(&codex_dir).expect("create .codex");
        symlink_dir(&real_root, &link_root).expect("create symlinked cwd");

        let link_blocked =
            AbsolutePathBuf::from_absolute_path(link_root.join("blocked")).expect("link blocked");
        let expected_root =
            AbsolutePathBuf::from_absolute_path(&link_root).expect("absolute symlinked root");
        let expected_blocked = link_blocked.clone();
        let expected_agents = expected_root.join(".agents");
        let expected_codex = expected_root.join(".codex");

        let policy = FileSystemSandboxPolicy::restricted(vec![
            FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::Minimal,
                },
                access: FileSystemAccessMode::Read,
            },
            FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::project_roots(/*subpath*/ None),
                },
                access: FileSystemAccessMode::Write,
            },
            FileSystemSandboxEntry {
                path: FileSystemPath::Path { path: link_blocked },
                access: FileSystemAccessMode::Deny,
            },
        ]);

        assert_eq!(
            policy.get_readable_roots_with_cwd(&link_root),
            vec![expected_root.clone()]
        );
        assert_eq!(
            policy.get_unreadable_roots_with_cwd(&link_root),
            vec![expected_blocked.clone()]
        );

        let writable_roots = policy.get_writable_roots_with_cwd(&link_root);
        assert_eq!(writable_roots.len(), 1);
        assert_eq!(writable_roots[0].root, expected_root);
        assert!(
            writable_roots[0]
                .read_only_subpaths
                .contains(&expected_blocked)
        );
        assert!(
            writable_roots[0]
                .read_only_subpaths
                .contains(&expected_agents)
        );
        assert!(
            writable_roots[0]
                .read_only_subpaths
                .contains(&expected_codex)
        );
    }

    #[cfg(unix)]
    #[test]
    fn writable_roots_preserve_symlinked_protected_subpaths() {
        let cwd = TempDir::new().expect("tempdir");
        let root = cwd.path().join("root");
        let decoy = root.join("decoy-codex");
        let dot_codex = root.join(".codex");
        fs::create_dir_all(&decoy).expect("create decoy");
        symlink_dir(&decoy, &dot_codex).expect("create .codex symlink");

        let root = AbsolutePathBuf::from_absolute_path(&root).expect("absolute root");
        let expected_dot_codex = AbsolutePathBuf::from_absolute_path(
            root.as_path()
                .canonicalize()
                .expect("canonicalize root")
                .join(".codex"),
        )
        .expect("absolute .codex symlink");
        let unexpected_decoy =
            AbsolutePathBuf::from_absolute_path(decoy.canonicalize().expect("canonicalize decoy"))
                .expect("absolute canonical decoy");

        let policy = FileSystemSandboxPolicy::restricted(vec![FileSystemSandboxEntry {
            path: FileSystemPath::Path { path: root },
            access: FileSystemAccessMode::Write,
        }]);

        let writable_roots = policy.get_writable_roots_with_cwd(cwd.path());
        assert_eq!(writable_roots.len(), 1);
        assert_eq!(
            writable_roots[0].read_only_subpaths,
            vec![expected_dot_codex]
        );
        assert!(
            !writable_roots[0]
                .read_only_subpaths
                .contains(&unexpected_decoy)
        );
    }

    #[cfg(unix)]
    #[test]
    fn writable_roots_preserve_explicit_symlinked_carveouts_under_symlinked_roots() {
        let cwd = TempDir::new().expect("tempdir");
        let real_root = cwd.path().join("real");
        let link_root = cwd.path().join("link");
        let decoy = real_root.join("decoy-private");
        let linked_private = real_root.join("linked-private");
        fs::create_dir_all(&decoy).expect("create decoy");
        symlink_dir(&real_root, &link_root).expect("create symlinked root");
        symlink_dir(&decoy, &linked_private).expect("create linked-private symlink");

        let link_root =
            AbsolutePathBuf::from_absolute_path(&link_root).expect("absolute symlinked root");
        let link_private = link_root.join("linked-private");
        let expected_root = link_root.clone();
        let expected_linked_private = link_private.clone();
        let unexpected_decoy =
            AbsolutePathBuf::from_absolute_path(decoy.canonicalize().expect("canonicalize decoy"))
                .expect("absolute canonical decoy");

        let policy = FileSystemSandboxPolicy::restricted(vec![
            FileSystemSandboxEntry {
                path: FileSystemPath::Path { path: link_root },
                access: FileSystemAccessMode::Write,
            },
            FileSystemSandboxEntry {
                path: FileSystemPath::Path { path: link_private },
                access: FileSystemAccessMode::Deny,
            },
        ]);

        let writable_roots = policy.get_writable_roots_with_cwd(cwd.path());
        assert_eq!(writable_roots.len(), 1);
        assert_eq!(writable_roots[0].root, expected_root);
        assert_eq!(
            writable_roots[0].read_only_subpaths,
            vec![expected_linked_private]
        );
        assert!(
            !writable_roots[0]
                .read_only_subpaths
                .contains(&unexpected_decoy)
        );
    }

    #[cfg(unix)]
    #[test]
    fn writable_roots_preserve_explicit_symlinked_carveouts_that_escape_root() {
        let cwd = TempDir::new().expect("tempdir");
        let real_root = cwd.path().join("real");
        let link_root = cwd.path().join("link");
        let decoy = cwd.path().join("outside-private");
        let linked_private = real_root.join("linked-private");
        fs::create_dir_all(&decoy).expect("create decoy");
        fs::create_dir_all(&real_root).expect("create real root");
        symlink_dir(&real_root, &link_root).expect("create symlinked root");
        symlink_dir(&decoy, &linked_private).expect("create linked-private symlink");

        let link_root =
            AbsolutePathBuf::from_absolute_path(&link_root).expect("absolute symlinked root");
        let link_private = link_root.join("linked-private");
        let expected_root = link_root.clone();
        let expected_linked_private = link_private.clone();
        let unexpected_decoy =
            AbsolutePathBuf::from_absolute_path(decoy.canonicalize().expect("canonicalize decoy"))
                .expect("absolute canonical decoy");

        let policy = FileSystemSandboxPolicy::restricted(vec![
            FileSystemSandboxEntry {
                path: FileSystemPath::Path { path: link_root },
                access: FileSystemAccessMode::Write,
            },
            FileSystemSandboxEntry {
                path: FileSystemPath::Path { path: link_private },
                access: FileSystemAccessMode::Deny,
            },
        ]);

        let writable_roots = policy.get_writable_roots_with_cwd(cwd.path());
        assert_eq!(writable_roots.len(), 1);
        assert_eq!(writable_roots[0].root, expected_root);
        assert_eq!(
            writable_roots[0].read_only_subpaths,
            vec![expected_linked_private]
        );
        assert!(
            !writable_roots[0]
                .read_only_subpaths
                .contains(&unexpected_decoy)
        );
    }

    #[cfg(unix)]
    #[test]
    fn writable_roots_preserve_explicit_symlinked_carveouts_that_alias_root() {
        let cwd = TempDir::new().expect("tempdir");
        let root = cwd.path().join("root");
        let alias = root.join("alias-root");
        fs::create_dir_all(&root).expect("create root");
        symlink_dir(&root, &alias).expect("create alias symlink");

        let root = AbsolutePathBuf::from_absolute_path(&root).expect("absolute root");
        let alias = root.join("alias-root");
        let expected_root = AbsolutePathBuf::from_absolute_path(
            root.as_path().canonicalize().expect("canonicalize root"),
        )
        .expect("absolute canonical root");
        let expected_alias = expected_root.join("alias-root");

        let policy = FileSystemSandboxPolicy::restricted(vec![
            FileSystemSandboxEntry {
                path: FileSystemPath::Path { path: root },
                access: FileSystemAccessMode::Write,
            },
            FileSystemSandboxEntry {
                path: FileSystemPath::Path { path: alias },
                access: FileSystemAccessMode::Deny,
            },
        ]);

        let writable_roots = policy.get_writable_roots_with_cwd(cwd.path());
        assert_eq!(writable_roots.len(), 1);
        assert_eq!(writable_roots[0].root, expected_root);
        assert_eq!(writable_roots[0].read_only_subpaths, vec![expected_alias]);
    }

    #[cfg(unix)]
    #[test]
    fn tmpdir_special_path_preserves_symlinked_tmpdir() {
        if std::env::var_os(SYMLINKED_TMPDIR_TEST_ENV).is_none() {
            let output = std::process::Command::new(std::env::current_exe().expect("test binary"))
                .env(SYMLINKED_TMPDIR_TEST_ENV, "1")
                .arg("--exact")
                .arg("permissions::tests::tmpdir_special_path_preserves_symlinked_tmpdir")
                .output()
                .expect("run tmpdir subprocess test");

            assert!(
                output.status.success(),
                "tmpdir subprocess test failed\nstdout:\n{}\nstderr:\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }

        let cwd = TempDir::new().expect("tempdir");
        let real_tmpdir = cwd.path().join("real-tmpdir");
        let link_tmpdir = cwd.path().join("link-tmpdir");
        let blocked = real_tmpdir.join("blocked");
        let codex_dir = real_tmpdir.join(".codex");

        fs::create_dir_all(&blocked).expect("create blocked");
        fs::create_dir_all(&codex_dir).expect("create .codex");
        symlink_dir(&real_tmpdir, &link_tmpdir).expect("create symlinked tmpdir");

        let link_blocked =
            AbsolutePathBuf::from_absolute_path(link_tmpdir.join("blocked")).expect("link blocked");
        let expected_root =
            AbsolutePathBuf::from_absolute_path(&link_tmpdir).expect("absolute symlinked tmpdir");
        let expected_blocked = link_blocked.clone();
        let expected_codex = expected_root.join(".codex");

        unsafe {
            std::env::set_var("TMPDIR", &link_tmpdir);
        }

        let policy = FileSystemSandboxPolicy::restricted(vec![
            FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::Tmpdir,
                },
                access: FileSystemAccessMode::Write,
            },
            FileSystemSandboxEntry {
                path: FileSystemPath::Path { path: link_blocked },
                access: FileSystemAccessMode::Deny,
            },
        ]);

        assert_eq!(
            policy.get_unreadable_roots_with_cwd(cwd.path()),
            vec![expected_blocked.clone()]
        );

        let writable_roots = policy.get_writable_roots_with_cwd(cwd.path());
        assert_eq!(writable_roots.len(), 1);
        assert_eq!(writable_roots[0].root, expected_root);
        assert!(
            writable_roots[0]
                .read_only_subpaths
                .contains(&expected_blocked)
        );
        assert!(
            writable_roots[0]
                .read_only_subpaths
                .contains(&expected_codex)
        );
    }

    #[test]
    fn resolve_access_with_cwd_uses_most_specific_entry() {
        let cwd = TempDir::new().expect("tempdir");
        let docs = AbsolutePathBuf::resolve_path_against_base("docs", cwd.path());
        let docs_private = AbsolutePathBuf::resolve_path_against_base("docs/private", cwd.path());
        let docs_private_public =
            AbsolutePathBuf::resolve_path_against_base("docs/private/public", cwd.path());
        let policy = FileSystemSandboxPolicy::restricted(vec![
            FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::project_roots(/*subpath*/ None),
                },
                access: FileSystemAccessMode::Write,
            },
            FileSystemSandboxEntry {
                path: FileSystemPath::Path { path: docs.clone() },
                access: FileSystemAccessMode::Read,
            },
            FileSystemSandboxEntry {
                path: FileSystemPath::Path {
                    path: docs_private.clone(),
                },
                access: FileSystemAccessMode::Deny,
            },
            FileSystemSandboxEntry {
                path: FileSystemPath::Path {
                    path: docs_private_public.clone(),
                },
                access: FileSystemAccessMode::Write,
            },
        ]);

        assert_eq!(
            policy.resolve_access_with_cwd(cwd.path(), cwd.path()),
            FileSystemAccessMode::Write
        );
        assert_eq!(
            policy.resolve_access_with_cwd(docs.as_path(), cwd.path()),
            FileSystemAccessMode::Read
        );
        assert_eq!(
            policy.resolve_access_with_cwd(docs_private.as_path(), cwd.path()),
            FileSystemAccessMode::Deny
        );
        assert_eq!(
            policy.resolve_access_with_cwd(docs_private_public.as_path(), cwd.path()),
            FileSystemAccessMode::Write
        );
    }

    #[test]
    fn split_only_nested_carveouts_need_direct_runtime_enforcement() {
        let cwd = TempDir::new().expect("tempdir");
        let docs = AbsolutePathBuf::resolve_path_against_base("docs", cwd.path());
        let policy = FileSystemSandboxPolicy::restricted(vec![
            FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::project_roots(/*subpath*/ None),
                },
                access: FileSystemAccessMode::Write,
            },
            FileSystemSandboxEntry {
                path: FileSystemPath::Path { path: docs },
                access: FileSystemAccessMode::Read,
            },
        ]);

        assert!(
            policy.needs_direct_runtime_enforcement(NetworkSandboxPolicy::Restricted, cwd.path(),)
        );

        let legacy_workspace_write = legacy_runtime_file_system_policy_for_cwd(
            &SandboxPolicy::new_workspace_write_policy(),
            cwd.path(),
        );
        assert!(
            legacy_workspace_write
                .needs_direct_runtime_enforcement(NetworkSandboxPolicy::Restricted, cwd.path(),),
            "metadata-name protections must stay in the direct enforcement path even when legacy concrete read-only paths match"
        );
    }

    #[test]
    fn legacy_projection_runtime_enforcement_ignores_entry_order() {
        let cwd = TempDir::new().expect("tempdir");
        let legacy_policy = SandboxPolicy::WorkspaceWrite {
            writable_roots: Vec::new(),
            network_access: false,
            exclude_tmpdir_env_var: true,
            exclude_slash_tmp: true,
        };
        let legacy_order = legacy_runtime_file_system_policy_for_cwd(&legacy_policy, cwd.path());
        let mut reordered_entries = legacy_order.entries.clone();
        reordered_entries.reverse();
        let reordered = FileSystemSandboxPolicy::restricted(reordered_entries);

        assert!(
            legacy_order.is_semantically_equivalent_to(&reordered, cwd.path()),
            "entry order should not affect filesystem semantics"
        );
        assert_eq!(
            legacy_order
                .needs_direct_runtime_enforcement(NetworkSandboxPolicy::Restricted, cwd.path()),
            reordered
                .needs_direct_runtime_enforcement(NetworkSandboxPolicy::Restricted, cwd.path()),
            "entry order should not affect direct-enforcement classification"
        );
    }

    #[test]
    fn missing_symbolic_metadata_carveouts_need_direct_runtime_enforcement() {
        let cwd = TempDir::new().expect("tempdir");
        let legacy_policy = SandboxPolicy::WorkspaceWrite {
            writable_roots: Vec::new(),
            network_access: false,
            exclude_tmpdir_env_var: true,
            exclude_slash_tmp: true,
        };

        let profile_projection =
            FileSystemSandboxPolicy::from_legacy_sandbox_policy_for_cwd(&legacy_policy, cwd.path());
        assert!(
            profile_projection
                .needs_direct_runtime_enforcement(NetworkSandboxPolicy::Restricted, cwd.path()),
            "symbolic .git/.agents carveouts protect missing paths that legacy sandboxes cannot represent"
        );

        let legacy_runtime_projection =
            legacy_runtime_file_system_policy_for_cwd(&legacy_policy, cwd.path());
        assert!(
            legacy_runtime_projection
                .needs_direct_runtime_enforcement(NetworkSandboxPolicy::Restricted, cwd.path()),
            "metadata-name protections are outside the legacy SandboxPolicy writable-root contract"
        );
    }

    #[test]
    fn root_write_with_read_only_child_is_not_full_disk_write() {
        let cwd = TempDir::new().expect("tempdir");
        let docs = AbsolutePathBuf::resolve_path_against_base("docs", cwd.path());
        let policy = FileSystemSandboxPolicy::restricted(vec![
            FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::Root,
                },
                access: FileSystemAccessMode::Write,
            },
            FileSystemSandboxEntry {
                path: FileSystemPath::Path { path: docs.clone() },
                access: FileSystemAccessMode::Read,
            },
        ]);

        assert!(!policy.has_full_disk_write_access());
        assert_eq!(
            policy.resolve_access_with_cwd(docs.as_path(), cwd.path()),
            FileSystemAccessMode::Read
        );
        assert!(
            policy.needs_direct_runtime_enforcement(NetworkSandboxPolicy::Restricted, cwd.path(),)
        );
        assert!(
            policy
                .to_legacy_sandbox_policy(NetworkSandboxPolicy::Restricted, cwd.path())
                .is_err()
        );
    }

    #[test]
    fn root_deny_does_not_materialize_as_unreadable_root() {
        let cwd = TempDir::new().expect("tempdir");
        let docs = AbsolutePathBuf::resolve_path_against_base("docs", cwd.path());
        let expected_docs = AbsolutePathBuf::from_absolute_path(
            canonicalize_preserving_symlinks(cwd.path())
                .expect("canonicalize cwd")
                .join("docs"),
        )
        .expect("canonical docs");
        let policy = FileSystemSandboxPolicy::restricted(vec![
            FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::Root,
                },
                access: FileSystemAccessMode::Deny,
            },
            FileSystemSandboxEntry {
                path: FileSystemPath::Path { path: docs.clone() },
                access: FileSystemAccessMode::Read,
            },
        ]);

        assert_eq!(
            policy.resolve_access_with_cwd(docs.as_path(), cwd.path()),
            FileSystemAccessMode::Read
        );
        assert_eq!(
            policy.get_readable_roots_with_cwd(cwd.path()),
            vec![expected_docs]
        );
        assert!(policy.get_unreadable_roots_with_cwd(cwd.path()).is_empty());
    }

    #[test]
    fn duplicate_root_deny_prevents_full_disk_write_access() {
        let cwd = TempDir::new().expect("tempdir");
        let root = AbsolutePathBuf::from_absolute_path(cwd.path())
            .map(|cwd| absolute_root_path_for_cwd(&cwd))
            .expect("resolve filesystem root");
        let policy = FileSystemSandboxPolicy::restricted(vec![
            FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::Root,
                },
                access: FileSystemAccessMode::Write,
            },
            FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::Root,
                },
                access: FileSystemAccessMode::Deny,
            },
        ]);

        assert!(!policy.has_full_disk_write_access());
        assert_eq!(
            policy.resolve_access_with_cwd(root.as_path(), cwd.path()),
            FileSystemAccessMode::Deny
        );
    }

    #[test]
    fn same_specificity_write_override_keeps_full_disk_write_access() {
        let cwd = TempDir::new().expect("tempdir");
        let docs = AbsolutePathBuf::resolve_path_against_base("docs", cwd.path());
        let policy = FileSystemSandboxPolicy::restricted(vec![
            FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::Root,
                },
                access: FileSystemAccessMode::Write,
            },
            FileSystemSandboxEntry {
                path: FileSystemPath::Path { path: docs.clone() },
                access: FileSystemAccessMode::Read,
            },
            FileSystemSandboxEntry {
                path: FileSystemPath::Path { path: docs.clone() },
                access: FileSystemAccessMode::Write,
            },
        ]);

        assert!(policy.has_full_disk_write_access());
        assert_eq!(
            policy.resolve_access_with_cwd(docs.as_path(), cwd.path()),
            FileSystemAccessMode::Write
        );
    }

    #[test]
    fn with_additional_readable_roots_skips_existing_effective_access() {
        let cwd = TempDir::new().expect("tempdir");
        let cwd_root = AbsolutePathBuf::from_absolute_path(cwd.path()).expect("absolute cwd");
        let policy = FileSystemSandboxPolicy::restricted(vec![FileSystemSandboxEntry {
            path: FileSystemPath::Special {
                value: FileSystemSpecialPath::project_roots(/*subpath*/ None),
            },
            access: FileSystemAccessMode::Read,
        }]);

        let actual = policy
            .clone()
            .with_additional_readable_roots(cwd.path(), std::slice::from_ref(&cwd_root));

        assert_eq!(actual, policy);
    }

    #[test]
    fn with_additional_writable_roots_skips_existing_effective_access() {
        let cwd = TempDir::new().expect("tempdir");
        let cwd_root = AbsolutePathBuf::from_absolute_path(cwd.path()).expect("absolute cwd");
        let policy = FileSystemSandboxPolicy::restricted(vec![FileSystemSandboxEntry {
            path: FileSystemPath::Special {
                value: FileSystemSpecialPath::project_roots(/*subpath*/ None),
            },
            access: FileSystemAccessMode::Write,
        }]);

        let actual = policy
            .clone()
            .with_additional_writable_roots(cwd.path(), std::slice::from_ref(&cwd_root));

        assert_eq!(actual, policy);
    }

    #[test]
    fn with_additional_writable_roots_adds_new_root() {
        let temp_dir = TempDir::new().expect("tempdir");
        let cwd = temp_dir.path().join("workspace");
        let extra = AbsolutePathBuf::from_absolute_path(temp_dir.path().join("extra"))
            .expect("resolve extra root");
        let policy = FileSystemSandboxPolicy::restricted(vec![FileSystemSandboxEntry {
            path: FileSystemPath::Special {
                value: FileSystemSpecialPath::project_roots(/*subpath*/ None),
            },
            access: FileSystemAccessMode::Write,
        }]);

        let actual = policy.with_additional_writable_roots(&cwd, std::slice::from_ref(&extra));

        assert_eq!(
            actual,
            FileSystemSandboxPolicy::restricted(vec![
                FileSystemSandboxEntry {
                    path: FileSystemPath::Special {
                        value: FileSystemSpecialPath::project_roots(/*subpath*/ None),
                    },
                    access: FileSystemAccessMode::Write,
                },
                FileSystemSandboxEntry {
                    path: FileSystemPath::Path { path: extra },
                    access: FileSystemAccessMode::Write,
                },
            ])
        );
    }

    #[test]
    fn materialize_project_roots_with_workspace_roots_expands_exact_and_glob_entries() {
        let temp_dir = TempDir::new().expect("tempdir");
        let first = AbsolutePathBuf::from_absolute_path(temp_dir.path().join("first"))
            .expect("resolve first root");
        let second = AbsolutePathBuf::from_absolute_path(temp_dir.path().join("second"))
            .expect("resolve second root");
        let policy = FileSystemSandboxPolicy::restricted(vec![
            FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::project_roots(/*subpath*/ None),
                },
                access: FileSystemAccessMode::Write,
            },
            FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::project_roots(Some(".git".into())),
                },
                access: FileSystemAccessMode::Read,
            },
            FileSystemSandboxEntry {
                path: FileSystemPath::GlobPattern {
                    pattern: project_roots_glob_pattern(Path::new("**/*.env")),
                },
                access: FileSystemAccessMode::Deny,
            },
        ]);

        let actual =
            policy.materialize_project_roots_with_workspace_roots(&[first.clone(), second.clone()]);

        assert_eq!(
            actual,
            FileSystemSandboxPolicy::restricted(vec![
                FileSystemSandboxEntry {
                    path: FileSystemPath::Path {
                        path: first.clone(),
                    },
                    access: FileSystemAccessMode::Write,
                },
                FileSystemSandboxEntry {
                    path: FileSystemPath::Path {
                        path: second.clone(),
                    },
                    access: FileSystemAccessMode::Write,
                },
                FileSystemSandboxEntry {
                    path: FileSystemPath::Path {
                        path: first.join(".git"),
                    },
                    access: FileSystemAccessMode::Read,
                },
                FileSystemSandboxEntry {
                    path: FileSystemPath::Path {
                        path: second.join(".git"),
                    },
                    access: FileSystemAccessMode::Read,
                },
                FileSystemSandboxEntry {
                    path: FileSystemPath::GlobPattern {
                        pattern: AbsolutePathBuf::resolve_path_against_base(
                            "**/*.env",
                            first.as_path(),
                        )
                        .to_string_lossy()
                        .into_owned(),
                    },
                    access: FileSystemAccessMode::Deny,
                },
                FileSystemSandboxEntry {
                    path: FileSystemPath::GlobPattern {
                        pattern: AbsolutePathBuf::resolve_path_against_base(
                            "**/*.env",
                            second.as_path(),
                        )
                        .to_string_lossy()
                        .into_owned(),
                    },
                    access: FileSystemAccessMode::Deny,
                },
            ])
        );
    }

    #[test]
    fn materialize_project_roots_with_cwd_expands_symbolic_glob_entries() {
        let cwd = TempDir::new().expect("tempdir");
        let policy = FileSystemSandboxPolicy::restricted(vec![FileSystemSandboxEntry {
            path: FileSystemPath::GlobPattern {
                pattern: project_roots_glob_pattern(Path::new("**/*.env")),
            },
            access: FileSystemAccessMode::Deny,
        }]);

        let actual = policy.materialize_project_roots_with_cwd(cwd.path());

        assert_eq!(
            actual,
            FileSystemSandboxPolicy::restricted(vec![FileSystemSandboxEntry {
                path: FileSystemPath::GlobPattern {
                    pattern: AbsolutePathBuf::resolve_path_against_base("**/*.env", cwd.path())
                        .to_string_lossy()
                        .into_owned(),
                },
                access: FileSystemAccessMode::Deny,
            }])
        );
    }

    #[test]
    fn with_additional_legacy_workspace_writable_roots_protects_metadata() {
        let temp_dir = TempDir::new().expect("tempdir");
        let extra = AbsolutePathBuf::from_absolute_path(temp_dir.path().join("extra"))
            .expect("resolve extra root");
        std::fs::create_dir_all(extra.join(".git")).expect("create .git dir");
        let policy = FileSystemSandboxPolicy::restricted(vec![FileSystemSandboxEntry {
            path: FileSystemPath::Special {
                value: FileSystemSpecialPath::project_roots(/*subpath*/ None),
            },
            access: FileSystemAccessMode::Write,
        }]);

        let actual =
            policy.with_additional_legacy_workspace_writable_roots(std::slice::from_ref(&extra));

        assert_eq!(
            actual,
            FileSystemSandboxPolicy::restricted(vec![
                FileSystemSandboxEntry {
                    path: FileSystemPath::Special {
                        value: FileSystemSpecialPath::project_roots(/*subpath*/ None),
                    },
                    access: FileSystemAccessMode::Write,
                },
                FileSystemSandboxEntry {
                    path: FileSystemPath::Path {
                        path: extra.clone()
                    },
                    access: FileSystemAccessMode::Write,
                },
                FileSystemSandboxEntry {
                    path: FileSystemPath::Path {
                        path: extra.join(".git")
                    },
                    access: FileSystemAccessMode::Read,
                },
            ])
        );
    }

    #[test]
    fn file_system_access_mode_orders_by_conflict_precedence() {
        assert!(FileSystemAccessMode::Write > FileSystemAccessMode::Read);
        assert!(FileSystemAccessMode::Deny > FileSystemAccessMode::Write);
    }

    #[test]
    fn legacy_bridge_preserves_explicit_deny_entries() {
        let denied = AbsolutePathBuf::try_from("/tmp/private").expect("absolute path");
        let existing = FileSystemSandboxPolicy::restricted(vec![FileSystemSandboxEntry {
            path: FileSystemPath::Path {
                path: denied.clone(),
            },
            access: FileSystemAccessMode::Deny,
        }]);

        let rebuilt = FileSystemSandboxPolicy::from_legacy_sandbox_policy_preserving_deny_entries(
            &SandboxPolicy::new_workspace_write_policy(),
            Path::new("/tmp/workspace"),
            &existing,
        );

        assert!(
            rebuilt.entries.iter().any(|entry| {
                entry.path
                    == FileSystemPath::Path {
                        path: denied.clone(),
                    }
                    && entry.access == FileSystemAccessMode::Deny
            }),
            "expected explicit deny entry to be preserved"
        );
    }

    #[test]
    fn preserving_deny_entries_keeps_unrestricted_policy_enforceable() {
        let deny_entry = unreadable_glob_entry("/tmp/project/**/*.env".to_string());
        let mut existing = FileSystemSandboxPolicy::restricted(vec![deny_entry.clone()]);
        existing.glob_scan_max_depth = Some(2);
        let mut replacement = FileSystemSandboxPolicy::unrestricted();

        replacement.preserve_deny_read_restrictions_from(&existing);

        let mut expected = FileSystemSandboxPolicy::restricted(vec![
            FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::Root,
                },
                access: FileSystemAccessMode::Write,
            },
            deny_entry,
        ]);
        expected.glob_scan_max_depth = Some(2);
        assert_eq!(replacement, expected);
    }

    fn deny_policy(path: &Path) -> FileSystemSandboxPolicy {
        FileSystemSandboxPolicy::restricted(vec![FileSystemSandboxEntry {
            path: FileSystemPath::Path {
                path: AbsolutePathBuf::try_from(path).expect("absolute deny path"),
            },
            access: FileSystemAccessMode::Deny,
        }])
    }

    fn unreadable_glob_entry(pattern: String) -> FileSystemSandboxEntry {
        FileSystemSandboxEntry {
            path: FileSystemPath::GlobPattern { pattern },
            access: FileSystemAccessMode::Deny,
        }
    }

    fn default_policy_with_unreadable_glob(pattern: String) -> FileSystemSandboxPolicy {
        let mut policy = FileSystemSandboxPolicy::default();
        policy.entries.push(unreadable_glob_entry(pattern));
        policy
    }

    fn is_read_denied(
        path: &Path,
        file_system_sandbox_policy: &FileSystemSandboxPolicy,
        cwd: &Path,
    ) -> bool {
        ReadDenyMatcher::new(file_system_sandbox_policy, cwd)
            .is_some_and(|matcher| matcher.is_read_denied(path))
    }

    #[test]
    fn exact_path_and_descendants_are_denied() {
        let temp = TempDir::new().expect("tempdir");
        let denied_dir = temp.path().join("denied");
        let nested = denied_dir.join("nested.txt");
        std::fs::create_dir_all(&denied_dir).expect("create denied dir");
        std::fs::write(&nested, "secret").expect("write secret");

        let policy = deny_policy(&denied_dir);
        assert!(is_read_denied(&denied_dir, &policy, temp.path()));
        assert!(is_read_denied(&nested, &policy, temp.path()));
        assert!(!is_read_denied(
            &temp.path().join("other.txt"),
            &policy,
            temp.path()
        ));
    }

    #[cfg(unix)]
    #[test]
    fn canonical_target_matches_denied_symlink_alias() {
        let temp = TempDir::new().expect("tempdir");
        let real_dir = temp.path().join("real");
        let alias_dir = temp.path().join("alias");
        std::fs::create_dir_all(&real_dir).expect("create real dir");
        symlink_dir(&real_dir, &alias_dir).expect("symlink alias");

        let secret = real_dir.join("secret.txt");
        std::fs::write(&secret, "secret").expect("write secret");
        let alias_secret = alias_dir.join("secret.txt");

        let policy = deny_policy(&real_dir);
        assert!(is_read_denied(&alias_secret, &policy, temp.path()));
    }

    #[test]
    fn literal_patterns_and_globs_are_denied() {
        let temp = TempDir::new().expect("tempdir");
        let literal = temp.path().join("private");
        let other = temp.path().join("notes.txt");
        std::fs::create_dir_all(&literal).expect("create literal dir");
        std::fs::write(&other, "notes").expect("write notes");

        let mut policy = deny_policy(&literal);
        policy.entries.push(unreadable_glob_entry(format!(
            "{}/**/*.txt",
            temp.path().display()
        )));

        assert!(is_read_denied(&literal, &policy, temp.path()));
        assert!(is_read_denied(&other, &policy, temp.path()));
    }

    #[test]
    fn glob_patterns_deny_matching_paths() {
        let temp = TempDir::new().expect("tempdir");
        let denied = temp.path().join("private").join("secret1.txt");
        std::fs::create_dir_all(denied.parent().expect("parent")).expect("create parent");
        std::fs::write(&denied, "secret").expect("write secret");

        let policy = default_policy_with_unreadable_glob(format!(
            "{}/private/secret?.txt",
            temp.path().display()
        ));

        assert!(is_read_denied(&denied, &policy, temp.path()));
    }

    #[test]
    fn glob_patterns_do_not_cross_path_separators() {
        let temp = TempDir::new().expect("tempdir");
        let matching = temp.path().join("app").join("file42.txt");
        let nested = temp.path().join("app").join("nested").join("file42.txt");
        let short = temp.path().join("app").join("file4.txt");
        let letters = temp.path().join("app").join("fileab.txt");
        std::fs::create_dir_all(nested.parent().expect("parent")).expect("create parent");
        std::fs::write(&matching, "secret").expect("write matching");
        std::fs::write(&nested, "secret").expect("write nested");
        std::fs::write(&short, "secret").expect("write short");
        std::fs::write(&letters, "secret").expect("write letters");

        let policy = default_policy_with_unreadable_glob(format!(
            "{}/*/file[0-9]?.txt",
            temp.path().display()
        ));

        assert!(is_read_denied(&matching, &policy, temp.path()));
        assert!(!is_read_denied(&nested, &policy, temp.path()));
        assert!(!is_read_denied(&short, &policy, temp.path()));
        assert!(!is_read_denied(&letters, &policy, temp.path()));
    }

    #[test]
    fn globstar_patterns_deny_root_and_nested_matches() {
        let temp = TempDir::new().expect("tempdir");
        let root_env = temp.path().join(".env");
        let nested_env = temp.path().join("app").join(".env");
        let other = temp.path().join("app").join("notes.txt");
        std::fs::create_dir_all(nested_env.parent().expect("parent")).expect("create parent");
        std::fs::write(&root_env, "secret").expect("write root env");
        std::fs::write(&nested_env, "secret").expect("write nested env");
        std::fs::write(&other, "notes").expect("write notes");

        let policy =
            default_policy_with_unreadable_glob(format!("{}/**/*.env", temp.path().display()));

        assert!(is_read_denied(&root_env, &policy, temp.path()));
        assert!(is_read_denied(&nested_env, &policy, temp.path()));
        assert!(!is_read_denied(&other, &policy, temp.path()));
    }

    #[test]
    fn unclosed_character_classes_match_literal_brackets() {
        let temp = TempDir::new().expect("tempdir");
        let bracket_file = temp.path().join("[");
        let other = temp.path().join("notes.txt");
        std::fs::write(&bracket_file, "secret").expect("write bracket file");
        std::fs::write(&other, "notes").expect("write notes");
        let policy = default_policy_with_unreadable_glob(format!("{}/[", temp.path().display()));

        assert!(is_read_denied(&bracket_file, &policy, temp.path()));
        assert!(!is_read_denied(&other, &policy, temp.path()));
    }
}
