//! 文件系统抽象与操作模块。
//!
//! 本 crate 提供跨平台的文件系统访问抽象，支持本地与远程环境。
//! 核心能力包括：
//! - 文件/目录的读写、创建、删除、复制等基础操作
//! - 有界递归遍历（walk），支持符号链接跟随与多重限制
//! - 沙箱上下文管理，基于权限配置控制文件系统访问范围
//! - 流式读取（分块返回，避免大文件内存溢出）
//!
//! 核心类型：
//! - [`ExecutorFileSystem`]：文件系统操作 trait，抽象本地与远程实现
//! - [`FileSystemSandboxContext`]：沙箱上下文，封装权限配置与工作目录
//! - [`WalkOptions`] / [`WalkOutcome`]：递归遍历的选项与结果

mod find_up;

/// 向上查找祖先文件时的错误处理策略。
pub use find_up::FindUpErrorPolicy;
/// 从当前目录向上查找最近的带有标记文件的祖先目录。
pub use find_up::find_nearest_ancestor_with_markers;
/// 从当前目录向上查找最近的带有标记文件的原生祖先目录。
pub use find_up::find_nearest_native_ancestor_with_markers;

use bytes::Bytes;
use codex_protocol::config_types::WindowsSandboxLevel;
use codex_protocol::models::ManagedFileSystemPermissions;
use codex_protocol::models::PermissionProfile;
use codex_protocol::models::SandboxEnforcement;
use codex_protocol::permissions::FileSystemPath;
use codex_protocol::permissions::FileSystemSandboxKind;
use codex_protocol::permissions::FileSystemSandboxPolicy;
use codex_protocol::permissions::FileSystemSpecialPath;
use codex_protocol::permissions::NetworkSandboxPolicy;
use codex_protocol::protocol::SandboxPolicy;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_path_uri::PathUri;
use futures::Stream;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::future::Future;
use std::io;
use std::path::Path;
use std::pin::Pin;
use std::task::Context;
use std::task::Poll;

/// [`ExecutorFileSystem::read_file_stream`] 返回的单个数据块的最大大小。
pub const FILE_READ_CHUNK_SIZE: usize = 1024 * 1024;
const MAX_WALK_DEPTH: usize = 64;
const MAX_WALK_DIRECTORIES: usize = 10_000;
const MAX_WALK_ENTRIES: usize = 50_000;
const MAX_WALK_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const WALK_RESPONSE_ITEM_OVERHEAD_BYTES: usize = 64;

/// 创建目录时的选项。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CreateDirectoryOptions {
    /// 是否递归创建父目录。
    pub recursive: bool,
}

/// 删除文件/目录时的选项。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RemoveOptions {
    /// 是否递归删除目录内容。
    pub recursive: bool,
    /// 是否忽略不存在的文件（force 语义）。
    pub force: bool,
}

/// 复制文件/目录时的选项。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CopyOptions {
    /// 是否递归复制目录内容。
    pub recursive: bool,
}

/// 文件或目录的元数据信息。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileMetadata {
    /// 是否为目录。
    pub is_directory: bool,
    /// 是否为普通文件。
    pub is_file: bool,
    /// 是否为符号链接。
    pub is_symlink: bool,
    /// 文件大小（字节）。
    pub size: u64,
    /// 创建时间（毫秒时间戳）。
    pub created_at_ms: i64,
    /// 修改时间（毫秒时间戳）。
    pub modified_at_ms: i64,
}

/// 目录读取返回的单个条目。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadDirectoryEntry {
    /// 文件名。
    pub file_name: String,
    /// 是否为目录。
    pub is_directory: bool,
    /// 是否为普通文件。
    pub is_file: bool,
}

/// 递归遍历的限制范围。
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkOptions {
    /// 相对于根目录的最大遍历深度。
    pub max_depth: usize,
    /// 最大可遍历的目录数（含根目录）。
    pub max_directories: usize,
    /// 最大可检视的目录条目数。
    pub max_entries: usize,
    /// 是否跟随目录符号链接。
    pub follow_directory_symlinks: bool,
}

/// 遍历返回的文件系统条目类型。
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WalkEntryKind {
    /// 目录。
    Directory,
    /// 文件。
    File,
}

/// 遍历返回的单个条目。
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkEntry {
    /// 条目路径。
    pub path: PathUri,
    /// 条目类型。
    pub kind: WalkEntryKind,
}

/// 遍历过程中无法检视的后代条目错误记录。
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkError {
    /// 产生错误的路径。
    pub path: PathUri,
    /// 错误描述信息。
    pub message: String,
}

/// 有界遍历收集的条目与可恢复错误。
#[derive(Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkOutcome {
    /// 成功遍历的条目列表。
    pub entries: Vec<WalkEntry>,
    /// 遍历过程中产生的可恢复错误列表。
    pub errors: Vec<WalkError>,
    /// 是否因达到限制而被截断。
    pub truncated: bool,
}

/// 文件系统沙箱上下文，封装权限配置、工作目录与平台沙箱参数。
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSystemSandboxContext {
    /// 权限配置（基于 PathUri 的 PermissionProfile）。
    pub permissions: PermissionProfile<PathUri>,
    /// 当前工作目录（可选）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<PathUri>,
    /// workspace 根目录列表。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub workspace_roots: Vec<PathUri>,
    /// Windows 沙箱级别。
    pub windows_sandbox_level: WindowsSandboxLevel,
    /// 是否使用 Windows 沙箱私有桌面。
    #[serde(default)]
    pub windows_sandbox_private_desktop: bool,
    /// 是否使用旧版 Landlock（仅 Linux）。
    #[serde(default)]
    pub use_legacy_landlock: bool,
}

impl FileSystemSandboxContext {
    /// 从旧版沙箱策略构建沙箱上下文。
    ///
    /// 旧版策略投影会物化原生根路径，因此在接收主机边界处进行转换，
    /// 同时在结果沙箱上下文中保留 URI 表示。
    pub fn from_legacy_sandbox_policy(
        sandbox_policy: SandboxPolicy,
        cwd: PathUri,
    ) -> io::Result<Self> {
        // 旧版策略投影会物化原生根路径，因此在接收主机边界处进行转换，
        // 同时在结果沙箱上下文中保留 URI 表示。
        let native_cwd = cwd.to_abs_path()?;
        let file_system_sandbox_policy =
            FileSystemSandboxPolicy::from_legacy_sandbox_policy_for_cwd(
                &sandbox_policy,
                &native_cwd,
            );
        let permissions =
            PermissionProfile::<AbsolutePathBuf>::from_runtime_permissions_with_enforcement(
                SandboxEnforcement::from_legacy_sandbox_policy(&sandbox_policy),
                &file_system_sandbox_policy,
                NetworkSandboxPolicy::from(&sandbox_policy),
            );
        Ok(Self::from_permission_profile_with_cwd(permissions, cwd))
    }

    /// 从权限配置构建沙箱上下文（不设置工作目录）。
    pub fn from_permission_profile(permissions: PermissionProfile<AbsolutePathBuf>) -> Self {
        Self::from_permissions_and_cwd(permissions, /*cwd*/ None)
    }

    /// 从权限配置和工作目录构建沙箱上下文。
    pub fn from_permission_profile_with_cwd(
        permissions: PermissionProfile<AbsolutePathBuf>,
        cwd: PathUri,
    ) -> Self {
        Self::from_permissions_and_cwd(permissions, Some(cwd))
    }

    fn from_permissions_and_cwd(
        permissions: PermissionProfile<AbsolutePathBuf>,
        cwd: Option<PathUri>,
    ) -> Self {
        Self {
            permissions: permissions.into(),
            cwd,
            workspace_roots: Vec::new(),
            windows_sandbox_level: WindowsSandboxLevel::Disabled,
            windows_sandbox_private_desktop: false,
            use_legacy_landlock: false,
        }
    }

    /// 判断当前沙箱上下文是否应在沙箱中运行。
    ///
    /// 当文件系统策略为受限模式且不具备全盘写入权限时返回 `true`。
    /// 对于其他主机的沙箱上下文，始终返回 `true`（不选择非沙箱文件系统）。
    pub fn should_run_in_sandbox(&self) -> bool {
        let Ok(permissions) =
            PermissionProfile::<AbsolutePathBuf>::try_from(self.permissions.clone())
        else {
            // 其他主机的沙箱上下文不得选择非沙箱文件系统。
            return true;
        };
        let file_system_policy = permissions.file_system_sandbox_policy();
        matches!(file_system_policy.kind, FileSystemSandboxKind::Restricted)
            && !file_system_policy.has_full_disk_write_access()
    }

    /// 判断权限配置是否依赖于工作目录。
    ///
    /// 当存在相对路径的 glob 模式或 ProjectRoots 特殊路径时返回 `true`。
    pub fn has_cwd_dependent_permissions(&self) -> bool {
        match &self.permissions {
            PermissionProfile::Managed {
                file_system: ManagedFileSystemPermissions::Restricted { entries, .. },
                ..
            } => entries.iter().any(|entry| match &entry.path {
                FileSystemPath::GlobPattern { pattern } => !Path::new(pattern).is_absolute(),
                FileSystemPath::Special {
                    value: FileSystemSpecialPath::ProjectRoots { .. },
                } => true,
                FileSystemPath::Path { .. } | FileSystemPath::Special { .. } => false,
            }),
            PermissionProfile::Managed {
                file_system: ManagedFileSystemPermissions::Unrestricted,
                ..
            }
            | PermissionProfile::Disabled
            | PermissionProfile::External { .. } => false,
        }
    }

    /// 若权限配置不依赖工作目录，则清除 `cwd` 与 `workspace_roots`。
    pub fn drop_cwd_if_unused(mut self) -> Self {
        if !self.has_cwd_dependent_permissions() {
            self.cwd = None;
            self.workspace_roots.clear();
        }
        self
    }
}

/// 文件系统操作的结果类型别名。
pub type FileSystemResult<T> = io::Result<T>;

/// [`ExecutorFileSystem`] 操作返回的 Future 类型。
pub type ExecutorFileSystemFuture<'a, T> =
    Pin<Box<dyn Future<Output = FileSystemResult<T>> + Send + 'a>>;

/// 从 [`ExecutorFileSystem`] 读取的不可变数据块流。
pub struct FileSystemReadStream {
    inner: Pin<Box<dyn Stream<Item = FileSystemResult<Bytes>> + Send + 'static>>,
}

impl FileSystemReadStream {
    /// 包装一个文件系统字节流。
    pub fn new(stream: impl Stream<Item = FileSystemResult<Bytes>> + Send + 'static) -> Self {
        Self {
            inner: Box::pin(stream),
        }
    }
}

impl Stream for FileSystemReadStream {
    type Item = FileSystemResult<Bytes>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.inner.as_mut().poll_next(cx)
    }
}

/// 抽象文件系统访问 trait，供可能运行在本地或远程环境中的组件使用。
pub trait ExecutorFileSystem: Send + Sync {
    /// 规范化（canonicalize）此文件系统中的路径。
    fn canonicalize<'a>(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, PathUri>;

    /// 读取文件的全部内容到内存。
    fn read_file<'a>(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<u8>>;

    /// 以流的方式读取文件，每个数据块不超过 [`FILE_READ_CHUNK_SIZE`]。
    fn read_file_stream<'a>(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileSystemReadStream>;

    /// 读取文件并解码为 UTF-8 文本。
    fn read_file_text<'a>(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, String> {
        Box::pin(async move {
            let bytes = self.read_file(path, sandbox).await?;
            String::from_utf8(bytes).map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))
        })
    }

    /// 将内容写入文件。
    fn write_file<'a>(
        &'a self,
        path: &'a PathUri,
        contents: Vec<u8>,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>;

    /// 创建目录。
    fn create_directory<'a>(
        &'a self,
        path: &'a PathUri,
        create_directory_options: CreateDirectoryOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>;

    /// 获取文件/目录的元数据。
    fn get_metadata<'a>(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata>;

    /// 列出目录内容。
    fn read_directory<'a>(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<ReadDirectoryEntry>>;

    /// 递归列出后代条目，可选择是否跟随目录符号链接。
    fn walk<'a>(
        &'a self,
        path: &'a PathUri,
        options: WalkOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, WalkOutcome> {
        self.walk_via_directory_reads(path, options, sandbox)
    }

    /// 使用基础文件系统操作执行有界遍历。
    ///
    /// 拥有优化遍历传输的实现可将其作为兼容性回退方案。
    fn walk_via_directory_reads<'a>(
        &'a self,
        path: &'a PathUri,
        options: WalkOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, WalkOutcome> {
        Box::pin(walk_via_directory_reads(self, path, options, sandbox))
    }

    /// 删除文件/目录。
    fn remove<'a>(
        &'a self,
        path: &'a PathUri,
        remove_options: RemoveOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>;

    /// 复制文件/目录。
    fn copy<'a>(
        &'a self,
        source_path: &'a PathUri,
        destination_path: &'a PathUri,
        copy_options: CopyOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>;
}

async fn walk_via_directory_reads<F: ExecutorFileSystem + ?Sized>(
    file_system: &F,
    root: &PathUri,
    options: WalkOptions,
    sandbox: Option<&FileSystemSandboxContext>,
) -> FileSystemResult<WalkOutcome> {
    if options.max_directories == 0 || options.max_entries == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "filesystem walk limits must be greater than zero",
        ));
    }
    if options.max_depth > MAX_WALK_DEPTH
        || options.max_directories > MAX_WALK_DIRECTORIES
        || options.max_entries > MAX_WALK_ENTRIES
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "filesystem walk limits exceed maximums: depth={MAX_WALK_DEPTH}, directories={MAX_WALK_DIRECTORIES}, entries={MAX_WALK_ENTRIES}"
            ),
        ));
    }

    let root_metadata = file_system.get_metadata(root, sandbox).await?;
    if !root_metadata.is_directory
        || (root_metadata.is_symlink && !options.follow_directory_symlinks)
    {
        return Ok(WalkOutcome::default());
    }

    let root_identity = if options.follow_directory_symlinks {
        file_system.canonicalize(root, sandbox).await?
    } else {
        root.clone()
    };
    let mut outcome = WalkOutcome::default();
    let mut queue = VecDeque::from([(root.clone(), 0usize)]);
    let mut visited_directories = HashSet::from([root_identity]);
    let mut directory_count = 1usize;
    let mut entry_count = 0usize;
    let mut response_bytes = 0usize;

    while let Some((directory, depth)) = queue.pop_front() {
        let mut entries = match file_system.read_directory(&directory, sandbox).await {
            Ok(entries) => entries,
            Err(error) => {
                if !push_walk_error(
                    &mut outcome,
                    &mut response_bytes,
                    directory,
                    error.to_string(),
                ) {
                    return Ok(outcome);
                }
                continue;
            }
        };
        entries.sort_by(|left, right| left.file_name.cmp(&right.file_name));

        for entry in entries {
            if entry_count == options.max_entries {
                outcome.truncated = true;
                return Ok(outcome);
            }
            entry_count += 1;

            let path = match directory.join(&entry.file_name) {
                Ok(path) => path,
                Err(error) => {
                    if !push_walk_error(
                        &mut outcome,
                        &mut response_bytes,
                        directory.clone(),
                        error.to_string(),
                    ) {
                        return Ok(outcome);
                    }
                    continue;
                }
            };
            let metadata = match file_system.get_metadata(&path, sandbox).await {
                Ok(metadata) => metadata,
                Err(error) => {
                    if !push_walk_error(&mut outcome, &mut response_bytes, path, error.to_string())
                    {
                        return Ok(outcome);
                    }
                    continue;
                }
            };
            if metadata.is_symlink && (!options.follow_directory_symlinks || !metadata.is_directory)
            {
                continue;
            }

            let kind = if metadata.is_directory {
                WalkEntryKind::Directory
            } else if metadata.is_file {
                WalkEntryKind::File
            } else {
                continue;
            };
            if !reserve_walk_response_bytes(
                &mut outcome,
                &mut response_bytes,
                path.to_string().len(),
            ) {
                return Ok(outcome);
            }
            outcome.entries.push(WalkEntry {
                path: path.clone(),
                kind,
            });

            if kind == WalkEntryKind::Directory && depth < options.max_depth {
                let directory_identity = if options.follow_directory_symlinks {
                    match file_system.canonicalize(&path, sandbox).await {
                        Ok(path) => path,
                        Err(error) => {
                            if !push_walk_error(
                                &mut outcome,
                                &mut response_bytes,
                                path,
                                error.to_string(),
                            ) {
                                return Ok(outcome);
                            }
                            continue;
                        }
                    }
                } else {
                    path.clone()
                };
                if !visited_directories.insert(directory_identity) {
                    continue;
                }
                if directory_count == options.max_directories {
                    outcome.truncated = true;
                } else {
                    directory_count += 1;
                    queue.push_back((path, depth + 1));
                }
            }
        }
    }

    Ok(outcome)
}

fn push_walk_error(
    outcome: &mut WalkOutcome,
    response_bytes: &mut usize,
    path: PathUri,
    message: String,
) -> bool {
    let item_bytes = path.to_string().len().saturating_add(message.len());
    if !reserve_walk_response_bytes(outcome, response_bytes, item_bytes) {
        return false;
    }
    outcome.errors.push(WalkError { path, message });
    true
}

fn reserve_walk_response_bytes(
    outcome: &mut WalkOutcome,
    response_bytes: &mut usize,
    content_bytes: usize,
) -> bool {
    let item_bytes = content_bytes.saturating_add(WALK_RESPONSE_ITEM_OVERHEAD_BYTES);
    let Some(total_bytes) = response_bytes.checked_add(item_bytes) else {
        outcome.truncated = true;
        return false;
    };
    if total_bytes > MAX_WALK_RESPONSE_BYTES {
        outcome.truncated = true;
        return false;
    }
    *response_bytes = total_bytes;
    true
}
