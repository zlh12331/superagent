//! 权限配置合并与派生模块。
//!
//! 提供 [`AdditionalPermissionProfile`] 的规范化、合并与交集运算，以及从
//! [`PermissionProfile`] 派生运行时文件系统/网络沙箱策略的能力。
//!
//! 核心流程：
//! 1. [`normalize_additional_permissions`]：规范化附加权限（去重、canonicalize 路径）
//! 2. [`merge_permission_profiles`]：将 base 与额外权限合并（并集语义）
//! 3. [`intersect_permission_profiles`]：将请求权限与授予权限取交集（最小特权语义）
//! 4. [`effective_permission_profile`]：合并 base profile 与附加权限，生成最终运行时 profile

use codex_protocol::models::AdditionalPermissionProfile;
use codex_protocol::models::FileSystemPermissions;
use codex_protocol::models::NetworkPermissions;
use codex_protocol::models::PermissionProfile;
use codex_protocol::permissions::FileSystemAccessMode;
use codex_protocol::permissions::FileSystemPath;
use codex_protocol::permissions::FileSystemSandboxEntry;
use codex_protocol::permissions::FileSystemSandboxKind;
use codex_protocol::permissions::FileSystemSandboxPolicy;
use codex_protocol::permissions::FileSystemSpecialPath;
use codex_protocol::permissions::NetworkSandboxPolicy;
use codex_protocol::permissions::ReadDenyMatcher;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_absolute_path::canonicalize_preserving_symlinks;
use std::num::NonZeroUsize;
use std::path::Path;
use std::path::PathBuf;

/// 规范化附加权限配置。
///
/// - 网络权限为空时移除
/// - 文件系统权限仅支持 `Deny` 访问模式的 glob 条目，其他访问模式的 glob 将报错
/// - 对具体路径进行 `canonicalize_preserving_symlinks` 以保留符号链接语义
/// - 去重相同的条目
pub fn normalize_additional_permissions(
    additional_permissions: AdditionalPermissionProfile,
) -> Result<AdditionalPermissionProfile, String> {
    let network = additional_permissions
        .network
        .filter(|network| !network.is_empty());
    let file_system = match additional_permissions.file_system {
        Some(file_system) => {
            let mut entries = Vec::with_capacity(file_system.entries.len());
            let glob_scan_max_depth = file_system.glob_scan_max_depth;
            for entry in file_system.entries {
                if matches!(&entry.path, FileSystemPath::GlobPattern { .. })
                    && entry.access != FileSystemAccessMode::Deny
                {
                    return Err(
                        "glob file system permissions only support deny-read entries".to_string(),
                    );
                }
                let path = match entry.path {
                    FileSystemPath::Path { path } => FileSystemPath::Path {
                        path: canonicalize_preserving_symlinks(path.as_path())
                            .ok()
                            .and_then(|path| AbsolutePathBuf::from_absolute_path(path).ok())
                            .unwrap_or(path),
                    },
                    FileSystemPath::GlobPattern { pattern } => {
                        FileSystemPath::GlobPattern { pattern }
                    }
                    FileSystemPath::Special { value } => FileSystemPath::Special { value },
                };
                let normalized_entry = FileSystemSandboxEntry {
                    path,
                    access: entry.access,
                };
                if !entries.contains(&normalized_entry) {
                    entries.push(normalized_entry);
                }
            }
            let file_system = FileSystemPermissions {
                entries,
                glob_scan_max_depth,
            };
            (!file_system.is_empty()).then_some(file_system)
        }
        None => None,
    };
    Ok(AdditionalPermissionProfile {
        network,
        file_system,
    })
}

/// 合并两份附加权限配置（并集语义）。
///
/// - 网络权限：任一来源启用即启用
/// - 文件系统权限：合并条目并去重，glob 扫描深度取两侧约束性更强者
/// - 合并结果为空时返回 `None`
pub fn merge_permission_profiles(
    base: Option<&AdditionalPermissionProfile>,
    permissions: Option<&AdditionalPermissionProfile>,
) -> Option<AdditionalPermissionProfile> {
    let Some(permissions) = permissions else {
        return base.cloned();
    };

    match base {
        Some(base) => {
            let network = match (base.network.as_ref(), permissions.network.as_ref()) {
                (
                    Some(NetworkPermissions {
                        enabled: Some(true),
                    }),
                    _,
                )
                | (
                    _,
                    Some(NetworkPermissions {
                        enabled: Some(true),
                    }),
                ) => Some(NetworkPermissions {
                    enabled: Some(true),
                }),
                _ => None,
            };
            let file_system = match (base.file_system.as_ref(), permissions.file_system.as_ref()) {
                (Some(base), Some(permissions)) => Some(FileSystemPermissions {
                    entries: merge_permission_entries(&base.entries, &permissions.entries),
                    glob_scan_max_depth: merge_glob_scan_max_depth(
                        &base.entries,
                        base.glob_scan_max_depth.map(usize::from),
                        &permissions.entries,
                        permissions.glob_scan_max_depth.map(usize::from),
                    )
                    .and_then(NonZeroUsize::new),
                })
                .filter(|file_system| !file_system.is_empty()),
                (Some(base), None) => Some(base.clone()),
                (None, Some(permissions)) => Some(permissions.clone()),
                (None, None) => None,
            };

            Some(AdditionalPermissionProfile {
                network,
                file_system,
            })
            .filter(|permissions| !permissions.is_empty())
        }
        None => Some(permissions.clone()).filter(|permissions| !permissions.is_empty()),
    }
}

/// 将请求权限与授予权限取交集（最小特权语义）。
///
/// - 文件系统：仅保留 granted 中落在 requested 允许范围内的条目，
///   同时保留两侧对已接受授予条目构成约束的 deny 条目
/// - 网络：仅当 requested 与 granted 均启用时才启用
pub fn intersect_permission_profiles(
    requested: AdditionalPermissionProfile,
    granted: AdditionalPermissionProfile,
    cwd: &Path,
) -> AdditionalPermissionProfile {
    let file_system = requested
        .file_system
        .map(|requested_file_system| {
            let granted_file_system = granted.file_system.unwrap_or_default();
            let requested_policy =
                FileSystemSandboxPolicy::restricted(requested_file_system.entries.clone());
            let requested_read_deny_matcher = ReadDenyMatcher::new(&requested_policy, cwd);
            let mut accepted_entries = Vec::new();
            for entry in granted_file_system.entries.iter().filter(|entry| {
                granted_file_system_entry_within_request(
                    &requested_file_system,
                    &requested_policy,
                    requested_read_deny_matcher.as_ref(),
                    entry,
                    cwd,
                )
            }) {
                let entry = materialize_cwd_dependent_entry(entry, cwd);
                if !accepted_entries.contains(&entry) {
                    accepted_entries.push(entry);
                }
            }
            let mut entries = accepted_entries.clone();
            let requested_retained_deny_entries = retain_constraining_deny_entries(
                &requested_file_system.entries,
                &accepted_entries,
                cwd,
                &mut entries,
            );
            let granted_retained_deny_entries = retain_constraining_deny_entries(
                &granted_file_system.entries,
                &accepted_entries,
                cwd,
                &mut entries,
            );
            FileSystemPermissions {
                glob_scan_max_depth: merge_glob_scan_max_depth(
                    &requested_retained_deny_entries,
                    requested_file_system.glob_scan_max_depth.map(usize::from),
                    &granted_retained_deny_entries,
                    granted_file_system.glob_scan_max_depth.map(usize::from),
                )
                .and_then(NonZeroUsize::new),
                entries,
            }
        })
        .filter(|file_system| !file_system.is_empty());
    let network = match (requested.network, granted.network) {
        (
            Some(NetworkPermissions {
                enabled: Some(true),
            }),
            Some(NetworkPermissions {
                enabled: Some(true),
            }),
        ) => Some(NetworkPermissions {
            enabled: Some(true),
        }),
        _ => None,
    };

    AdditionalPermissionProfile {
        network,
        file_system,
    }
}

/// 合并两侧的 glob 扫描深度，取约束性更强者。
///
/// 任一侧为 `Unbounded` 时结果为 `None`（表示无界）；
/// 两侧均有界时取较大值；仅一侧有界时取该值。
fn merge_glob_scan_max_depth(
    left_entries: &[FileSystemSandboxEntry],
    left_depth: Option<usize>,
    right_entries: &[FileSystemSandboxEntry],
    right_depth: Option<usize>,
) -> Option<usize> {
    let left_depth = effective_glob_scan_depth(left_entries, left_depth);
    let right_depth = effective_glob_scan_depth(right_entries, right_depth);

    match (left_depth, right_depth) {
        (Some(GlobScanDepth::Unbounded), _) | (_, Some(GlobScanDepth::Unbounded)) => None,
        (Some(GlobScanDepth::Bounded(left)), Some(GlobScanDepth::Bounded(right))) => {
            Some(left.max(right))
        }
        (Some(GlobScanDepth::Bounded(depth)), None)
        | (None, Some(GlobScanDepth::Bounded(depth))) => Some(depth),
        (None, None) => None,
    }
}

/// 根据条目集合与显式深度计算有效 glob 扫描深度。
///
/// 若存在 deny + glob 条目，则使用显式深度（未设置则视为无界）；
/// 否则返回 `None`。
fn effective_glob_scan_depth(
    entries: &[FileSystemSandboxEntry],
    depth: Option<usize>,
) -> Option<GlobScanDepth> {
    entries
        .iter()
        .any(|entry| {
            entry.access == FileSystemAccessMode::Deny
                && matches!(&entry.path, FileSystemPath::GlobPattern { .. })
        })
        .then_some(match depth {
            Some(depth) => GlobScanDepth::Bounded(depth),
            None => GlobScanDepth::Unbounded,
        })
}

/// glob 扫描深度约束。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GlobScanDepth {
    /// 有界深度
    Bounded(usize),
    /// 无界（即用户未显式设置深度上限）
    Unbounded,
}

/// 判断已授予的文件系统条目是否落在请求权限允许的范围内。
///
/// - granted 条目不可读 → 不在范围内
/// - granted 条目路径被 requested 的 read-deny 匹配器命中 → 不在范围内
/// - granted 条目路径能被 requested 策略解析且访问权限覆盖 → 在范围内
/// - 否则按 requested 显式条目匹配判断
fn granted_file_system_entry_within_request(
    requested: &FileSystemPermissions,
    requested_policy: &FileSystemSandboxPolicy,
    requested_read_deny_matcher: Option<&ReadDenyMatcher>,
    granted_entry: &FileSystemSandboxEntry,
    cwd: &Path,
) -> bool {
    if !granted_entry.access.can_read() {
        return false;
    }

    if let Some(path) = resolve_permission_path(&granted_entry.path, cwd) {
        if requested_read_deny_matcher.is_some_and(|matcher| matcher.is_read_denied(path.as_path()))
        {
            return false;
        }
        return access_covers(
            requested_policy.resolve_access_with_cwd(path.as_path(), cwd),
            granted_entry.access,
        );
    }

    requested.entries.iter().any(|requested_entry| {
        access_covers(requested_entry.access, granted_entry.access)
            && requested_entry.path == granted_entry.path
    })
}

/// 保留对已接受授予条目构成约束的 deny 条目。
///
/// 遍历 source 中的 deny 条目，检查是否与 accepted 中的授予条目存在路径重叠；
/// 对构成约束的 deny 条目进行 cwd 物化后追加到 output，并返回保留的条目列表。
fn retain_constraining_deny_entries(
    source_entries: &[FileSystemSandboxEntry],
    accepted_entries: &[FileSystemSandboxEntry],
    cwd: &Path,
    output_entries: &mut Vec<FileSystemSandboxEntry>,
) -> Vec<FileSystemSandboxEntry> {
    let mut retained_entries = Vec::new();
    for entry in source_entries
        .iter()
        .filter(|entry| entry.access == FileSystemAccessMode::Deny)
    {
        if !deny_entry_constrains_accepted_grant(entry, accepted_entries, cwd) {
            continue;
        }
        let entry = materialize_cwd_dependent_entry(entry, cwd);
        if !output_entries.contains(&entry) {
            output_entries.push(entry.clone());
        }
        retained_entries.push(entry);
    }
    retained_entries
}

fn deny_entry_constrains_accepted_grant(
    deny_entry: &FileSystemSandboxEntry,
    accepted_entries: &[FileSystemSandboxEntry],
    cwd: &Path,
) -> bool {
    accepted_entries
        .iter()
        .filter(|entry| entry.access.can_read())
        .any(|entry| {
            let Some(grant_path) = resolve_permission_path(&entry.path, cwd) else {
                return false;
            };
            match &deny_entry.path {
                FileSystemPath::GlobPattern { pattern } => glob_static_prefix_path(pattern, cwd)
                    .is_some_and(|prefix| paths_overlap(prefix.as_path(), grant_path.as_path())),
                FileSystemPath::Path { .. } | FileSystemPath::Special { .. } => {
                    resolve_permission_path(&deny_entry.path, cwd).is_some_and(|deny_path| {
                        paths_overlap(deny_path.as_path(), grant_path.as_path())
                    })
                }
            }
        })
}

fn glob_static_prefix_path(pattern: &str, cwd: &Path) -> Option<AbsolutePathBuf> {
    let resolved_pattern = AbsolutePathBuf::resolve_path_against_base(pattern, cwd);
    let resolved_pattern = resolved_pattern.as_path().to_string_lossy();
    let prefix = match resolved_pattern.find(['*', '?', '[', ']']) {
        Some(0) => return None,
        Some(index) => {
            let prefix = &resolved_pattern[..index];
            if prefix.ends_with(std::path::MAIN_SEPARATOR)
                || prefix.ends_with('/')
                || prefix.ends_with('\\')
            {
                Path::new(prefix)
            } else {
                Path::new(prefix).parent()?
            }
        }
        None => Path::new(resolved_pattern.as_ref()),
    };
    AbsolutePathBuf::from_absolute_path(prefix).ok()
}

fn paths_overlap(left: &Path, right: &Path) -> bool {
    left.starts_with(right) || right.starts_with(left)
}

fn access_covers(requested: FileSystemAccessMode, granted: FileSystemAccessMode) -> bool {
    match granted {
        FileSystemAccessMode::Read => requested.can_read(),
        FileSystemAccessMode::Write => requested.can_write(),
        FileSystemAccessMode::Deny => false,
    }
}

/// 将依赖 cwd 的条目物化为绝对路径形式。
///
/// - `ProjectRoots` 特殊路径：解析为 cwd（或其子路径）
/// - `GlobPattern`：将模式解析为基于 cwd 的绝对路径
/// - 其他路径：保持不变
fn materialize_cwd_dependent_entry(
    entry: &FileSystemSandboxEntry,
    cwd: &Path,
) -> FileSystemSandboxEntry {
    match &entry.path {
        FileSystemPath::Special {
            value: FileSystemSpecialPath::ProjectRoots { .. },
        } => resolve_permission_path(&entry.path, cwd)
            .map(|path| FileSystemSandboxEntry {
                path: FileSystemPath::Path { path },
                access: entry.access,
            })
            .unwrap_or_else(|| entry.clone()),
        FileSystemPath::GlobPattern { pattern } => FileSystemSandboxEntry {
            path: FileSystemPath::GlobPattern {
                pattern: AbsolutePathBuf::resolve_path_against_base(pattern, cwd)
                    .to_string_lossy()
                    .into_owned(),
            },
            access: entry.access,
        },
        FileSystemPath::Path { .. } | FileSystemPath::Special { .. } => entry.clone(),
    }
}

fn resolve_permission_path(path: &FileSystemPath, cwd: &Path) -> Option<AbsolutePathBuf> {
    match path {
        FileSystemPath::Path { path } => Some(path.clone()),
        FileSystemPath::GlobPattern { .. } => None,
        FileSystemPath::Special { value } => match value {
            FileSystemSpecialPath::Root => {
                let root = cwd.ancestors().last()?;
                AbsolutePathBuf::from_absolute_path(root).ok()
            }
            FileSystemSpecialPath::ProjectRoots { subpath } => {
                let cwd = AbsolutePathBuf::from_absolute_path(cwd).ok()?;
                Some(match subpath {
                    Some(subpath) => {
                        AbsolutePathBuf::resolve_path_against_base(subpath, cwd.as_path())
                    }
                    None => cwd,
                })
            }
            FileSystemSpecialPath::Tmpdir => {
                let tmpdir = std::env::var_os("TMPDIR")?;
                if tmpdir.is_empty() {
                    None
                } else {
                    AbsolutePathBuf::from_absolute_path(PathBuf::from(tmpdir)).ok()
                }
            }
            FileSystemSpecialPath::SlashTmp => AbsolutePathBuf::from_absolute_path("/tmp")
                .ok()
                .filter(|path| path.as_path().is_dir()),
            FileSystemSpecialPath::Minimal | FileSystemSpecialPath::Unknown { .. } => None,
        },
    }
}

fn merge_permission_entries(
    base: &[FileSystemSandboxEntry],
    permissions: &[FileSystemSandboxEntry],
) -> Vec<FileSystemSandboxEntry> {
    let mut merged = Vec::with_capacity(base.len() + permissions.len());
    for entry in base.iter().chain(permissions.iter()) {
        if !merged.contains(entry) {
            merged.push(entry.clone());
        }
    }
    merged
}

fn merge_file_system_policy_with_additional_permissions(
    file_system_policy: &FileSystemSandboxPolicy,
    additional_permissions: &FileSystemPermissions,
) -> FileSystemSandboxPolicy {
    match file_system_policy.kind {
        FileSystemSandboxKind::Restricted => {
            let mut merged_policy = file_system_policy.clone();
            for entry in &additional_permissions.entries {
                if !merged_policy.entries.contains(entry) {
                    merged_policy.entries.push(entry.clone());
                }
            }
            merged_policy.glob_scan_max_depth = merge_glob_scan_max_depth(
                &file_system_policy.entries,
                file_system_policy.glob_scan_max_depth,
                &additional_permissions.entries,
                additional_permissions.glob_scan_max_depth.map(usize::from),
            );
            merged_policy
        }
        FileSystemSandboxKind::Unrestricted | FileSystemSandboxKind::ExternalSandbox => {
            file_system_policy.clone()
        }
    }
}

/// 计算合并附加权限后的有效文件系统沙箱策略。
///
/// 若附加权限不包含文件系统条目，直接返回原始策略；
/// 否则在 `Restricted` 模式下合并条目并取约束性更强的 glob 扫描深度。
pub fn effective_file_system_sandbox_policy(
    file_system_policy: &FileSystemSandboxPolicy,
    additional_permissions: Option<&AdditionalPermissionProfile>,
) -> FileSystemSandboxPolicy {
    let Some(additional_permissions) = additional_permissions else {
        return file_system_policy.clone();
    };

    let Some(file_system_permissions) = additional_permissions.file_system.as_ref() else {
        return file_system_policy.clone();
    };
    if file_system_permissions.is_empty() {
        file_system_policy.clone()
    } else {
        merge_file_system_policy_with_additional_permissions(
            file_system_policy,
            file_system_permissions,
        )
    }
}

fn merge_network_access(
    base_network_access: bool,
    additional_permissions: &AdditionalPermissionProfile,
) -> bool {
    base_network_access
        || additional_permissions
            .network
            .as_ref()
            .and_then(|network| network.enabled)
            .unwrap_or(false)
}

/// 计算合并附加权限后的有效网络沙箱策略。
///
/// - base 启用或附加权限启用网络 → `Enabled`
/// - 存在附加权限但未启用网络 → `Restricted`
/// - 无附加权限 → 保持原始策略
pub fn effective_network_sandbox_policy(
    network_policy: NetworkSandboxPolicy,
    additional_permissions: Option<&AdditionalPermissionProfile>,
) -> NetworkSandboxPolicy {
    if additional_permissions
        .is_some_and(|permissions| merge_network_access(network_policy.is_enabled(), permissions))
    {
        NetworkSandboxPolicy::Enabled
    } else if additional_permissions.is_some() {
        NetworkSandboxPolicy::Restricted
    } else {
        network_policy
    }
}

/// 合并 base profile 与附加权限，生成最终运行时 [`PermissionProfile`]。
///
/// 同时合并文件系统与网络策略，保持原始 enforcement 设置。
pub fn effective_permission_profile(
    permission_profile: &PermissionProfile,
    additional_permissions: Option<&AdditionalPermissionProfile>,
) -> PermissionProfile {
    let (file_system_policy, network_policy) = permission_profile.to_runtime_permissions();
    let effective_file_system_policy =
        effective_file_system_sandbox_policy(&file_system_policy, additional_permissions);
    let effective_network_policy =
        effective_network_sandbox_policy(network_policy, additional_permissions);
    PermissionProfile::from_runtime_permissions_with_enforcement(
        permission_profile.enforcement(),
        &effective_file_system_policy,
        effective_network_policy,
    )
}

/// 判断当前权限配置是否需要平台沙箱（独立于主机是否能提供具体实现）。
///
/// - 托管网络需求 → 需要
/// - 网络禁用 → 仅当文件系统策略非 `ExternalSandbox` 时需要
/// - 网络启用 + `Restricted` 文件系统 → 仅当非全盘写权限时需要
/// - 网络启用 + `Unrestricted` / `ExternalSandbox` → 不需要
pub fn should_require_platform_sandbox(
    file_system_policy: &FileSystemSandboxPolicy,
    network_policy: NetworkSandboxPolicy,
    has_managed_network_requirements: bool,
) -> bool {
    if has_managed_network_requirements {
        return true;
    }

    if !network_policy.is_enabled() {
        return !matches!(
            file_system_policy.kind,
            FileSystemSandboxKind::ExternalSandbox
        );
    }

    match file_system_policy.kind {
        FileSystemSandboxKind::Restricted => !file_system_policy.has_full_disk_write_access(),
        FileSystemSandboxKind::Unrestricted | FileSystemSandboxKind::ExternalSandbox => false,
    }
}

#[cfg(test)]
#[path = "policy_transforms_tests.rs"]
mod tests;
