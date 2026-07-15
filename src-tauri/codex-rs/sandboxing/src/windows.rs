//! Windows 沙箱后端的文件系统覆盖（overrides）解析逻辑。
//!
//! 该模块根据权限配置（permission profile）与沙箱等级（restricted-token / elevated）
//! 计算出 Windows 沙箱在启动时需要应用的文件系统覆盖项，包括可读根、可写根、
//! 拒绝读取路径与拒绝写入路径。当现有权限配置无法由 Windows 沙箱直接强制执行时，
//! 返回错误，调用方应拒绝在无沙箱的情况下运行。

use std::collections::BTreeSet;
use std::path::Path;
use std::path::PathBuf;

use codex_protocol::config_types::WindowsSandboxLevel;
use codex_protocol::models::PermissionProfile;
use codex_protocol::permissions::FileSystemSandboxPolicy;
use codex_protocol::protocol::WritableRoot;
use codex_utils_absolute_path::AbsolutePathBuf;

use crate::SandboxType;
use crate::compatibility_sandbox_policy_for_permission_profile;

/// Windows 沙箱后端使用的文件系统覆盖项。
///
/// 提升权限（elevated）的 Windows 后端会消费额外的 deny-read 路径以及显式的
/// read/write roots，用于 setup/refresh 阶段。
/// 未提升权限的 restricted-token 后端仅消费基于旧版 `WorkspaceWrite` 允许集合
/// 之上的额外 deny-write carveouts。
/// read-root 覆盖叠加在 elevated 启动路径所需的基线 helper roots 之上；
/// 启用了平台默认值的拆分策略会显式通过该字段携带此信息。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsSandboxFilesystemOverrides {
    /// 当需要替换默认可读根时使用；为 `None` 表示沿用 baseline。
    pub read_roots_override: Option<Vec<PathBuf>>,
    /// 当 `read_roots_override` 不为 `None` 时，是否包含平台默认可读根。
    pub read_roots_include_platform_defaults: bool,
    /// 当需要替换默认可写根时使用；为 `None` 表示沿用 baseline。
    pub write_roots_override: Option<Vec<PathBuf>>,
    /// 在默认规则之上额外拒绝读取的绝对路径列表。
    pub additional_deny_read_paths: Vec<AbsolutePathBuf>,
    /// 在默认规则之上额外拒绝写入的绝对路径列表。
    pub additional_deny_write_paths: Vec<AbsolutePathBuf>,
}

/// 判断在给定沙箱等级与代理强制策略下是否应使用 elevated 后端。
///
/// Windows 防火墙强制策略绑定到 logon-user 沙箱身份，
/// 因此即便配置为默认的 restricted-token 沙箱，proxy-enforced 会话也必须使用 elevated 后端。
pub fn windows_sandbox_uses_elevated_backend(
    sandbox_level: WindowsSandboxLevel,
    proxy_enforced: bool,
) -> bool {
    // Windows 防火墙强制策略与 logon-user 沙箱身份绑定，
    // 因此 proxy-enforced 会话即便配置为默认 restricted-token 沙箱，
    // 也必须使用 elevated 后端。
    proxy_enforced || matches!(sandbox_level, WindowsSandboxLevel::Elevated)
}

/// 判断给定权限配置是否能由 Windows restricted-token 沙箱直接强制执行。
///
/// 当权限配置为 `Managed` 且文件系统策略不授予完整磁盘写入权限时返回 `true`；
/// `Disabled` 与 `External` 始终返回 `false`。
pub fn permission_profile_supports_windows_restricted_token_sandbox(
    permission_profile: &PermissionProfile,
) -> bool {
    match permission_profile {
        PermissionProfile::Managed { file_system, .. } => {
            !file_system.to_sandbox_policy().has_full_disk_write_access()
        }
        PermissionProfile::Disabled | PermissionProfile::External { .. } => false,
    }
}

/// 返回当前配置无法由 Windows restricted-token 沙箱强制执行的原因（若存在）。
///
/// 根据沙箱等级分发到 elevated 或 restricted-token 的覆盖解析函数，
/// 并将其 `Err` 转为 `Some(String)` 返回。
pub fn unsupported_windows_restricted_token_sandbox_reason(
    sandbox: SandboxType,
    permission_profile: &PermissionProfile,
    sandbox_policy_cwd: &AbsolutePathBuf,
    windows_sandbox_level: WindowsSandboxLevel,
) -> Option<String> {
    if windows_sandbox_level == WindowsSandboxLevel::Elevated {
        resolve_windows_elevated_filesystem_overrides(
            sandbox,
            permission_profile,
            sandbox_policy_cwd,
            windows_sandbox_level == WindowsSandboxLevel::Elevated,
        )
        .err()
    } else {
        resolve_windows_restricted_token_filesystem_overrides(
            sandbox,
            permission_profile,
            sandbox_policy_cwd,
            windows_sandbox_level,
        )
        .err()
    }
}

/// 解析未提升权限（restricted-token）后端需要的文件系统覆盖项。
///
/// 仅当沙箱类型为 `WindowsRestrictedToken` 且未使用 elevated 后端时才会进行解析。
/// 当权限配置可以由 restricted-token 后端直接强制执行时返回 `Ok(None)`。
/// 当存在该后端无法强制执行的拆分策略时返回 `Err`，调用方应拒绝在无沙箱情况下运行。
pub fn resolve_windows_restricted_token_filesystem_overrides(
    sandbox: SandboxType,
    permission_profile: &PermissionProfile,
    sandbox_policy_cwd: &AbsolutePathBuf,
    windows_sandbox_level: WindowsSandboxLevel,
) -> std::result::Result<Option<WindowsSandboxFilesystemOverrides>, String> {
    if sandbox != SandboxType::WindowsRestrictedToken
        || windows_sandbox_level == WindowsSandboxLevel::Elevated
    {
        return Ok(None);
    }

    let (file_system_sandbox_policy, network_sandbox_policy) =
        permission_profile.to_runtime_permissions();

    let needs_direct_runtime_enforcement = file_system_sandbox_policy
        .needs_direct_runtime_enforcement(network_sandbox_policy, sandbox_policy_cwd);

    if permission_profile_supports_windows_restricted_token_sandbox(permission_profile)
        && !needs_direct_runtime_enforcement
    {
        return Ok(None);
    }

    if !permission_profile_supports_windows_restricted_token_sandbox(permission_profile) {
        let permission_profile_name = permission_profile_display_name(permission_profile);
        return Err(format!(
            "windows sandbox backend cannot enforce file_system={:?}, network={network_sandbox_policy:?}, permission_profile={permission_profile_name}; refusing to run unsandboxed",
            file_system_sandbox_policy.kind,
        ));
    }

    // restricted-token 后端仍可强制执行拆分写入限制，
    // 但其 WRITE_RESTRICTED token 不会让 capability SID 的 deny-read ACE
    // 参与读取访问检查。因此即使文件系统根目录仍可读，读取限制也必须由
    // elevated 后端处理。
    if !windows_policy_has_root_read_access(&file_system_sandbox_policy, sandbox_policy_cwd) {
        return Err(
            "windows unelevated restricted-token sandbox cannot enforce split filesystem read restrictions directly; refusing to run unsandboxed"
                .to_string(),
        );
    }

    let additional_deny_read_paths = codex_windows_sandbox::resolve_windows_deny_read_paths(
        &file_system_sandbox_policy,
        sandbox_policy_cwd,
    )?;
    if !additional_deny_read_paths.is_empty() {
        return Err(
            "windows unelevated restricted-token sandbox cannot enforce deny-read restrictions directly; refusing to run unsandboxed"
                .to_string(),
        );
    }

    let legacy_projection = compatibility_sandbox_policy_for_permission_profile(
        permission_profile,
        sandbox_policy_cwd.as_path(),
    );
    let legacy_writable_roots = legacy_projection.get_writable_roots_with_cwd(sandbox_policy_cwd);
    let split_writable_roots =
        file_system_sandbox_policy.get_writable_roots_with_cwd(sandbox_policy_cwd);
    let legacy_root_paths: BTreeSet<PathBuf> = legacy_writable_roots
        .iter()
        .map(|root| normalize_windows_override_path(root.root.as_path()))
        .collect::<std::result::Result<_, _>>()?;
    let split_root_paths: BTreeSet<PathBuf> = split_writable_roots
        .iter()
        .map(|root| normalize_windows_override_path(root.root.as_path()))
        .collect::<std::result::Result<_, _>>()?;

    if legacy_root_paths != split_root_paths {
        return Err(
            "windows unelevated restricted-token sandbox cannot enforce split writable root sets directly; refusing to run unsandboxed"
                .to_string(),
        );
    }

    for writable_root in &split_writable_roots {
        for read_only_subpath in &writable_root.read_only_subpaths {
            if split_writable_roots.iter().any(|candidate| {
                candidate.root.as_path() != writable_root.root.as_path()
                    && candidate
                        .root
                        .as_path()
                        .starts_with(read_only_subpath.as_path())
            }) {
                return Err(
                    "windows unelevated restricted-token sandbox cannot reopen writable descendants under read-only carveouts directly; refusing to run unsandboxed"
                        .to_string(),
                );
            }
        }
    }

    let mut additional_deny_write_paths = BTreeSet::new();
    for split_root in &split_writable_roots {
        let split_root_path = normalize_windows_override_path(split_root.root.as_path())?;
        let Some(legacy_root) = legacy_writable_roots.iter().find(|candidate| {
            normalize_windows_override_path(candidate.root.as_path())
                .is_ok_and(|candidate_path| candidate_path == split_root_path)
        }) else {
            return Err(
                "windows unelevated restricted-token sandbox cannot enforce split writable root sets directly; refusing to run unsandboxed"
                    .to_string(),
            );
        };

        for read_only_subpath in &split_root.read_only_subpaths {
            if !legacy_root
                .read_only_subpaths
                .iter()
                .any(|candidate| candidate == read_only_subpath)
            {
                additional_deny_write_paths.insert(normalize_windows_override_path(
                    read_only_subpath.as_path(),
                )?);
            }
        }
    }

    if additional_deny_read_paths.is_empty() && additional_deny_write_paths.is_empty() {
        return Ok(None);
    }

    Ok(Some(WindowsSandboxFilesystemOverrides {
        read_roots_override: None,
        read_roots_include_platform_defaults: false,
        write_roots_override: None,
        additional_deny_read_paths,
        additional_deny_write_paths: additional_deny_write_paths
            .into_iter()
            .map(|path| AbsolutePathBuf::from_absolute_path(path).map_err(|err| err.to_string()))
            .collect::<std::result::Result<_, _>>()?,
    }))
}

/// 解析 elevated（提升权限）后端需要的文件系统覆盖项。
///
/// 仅当沙箱类型为 `WindowsRestrictedToken` 且启用了 elevated 后端时才会进行解析。
/// 相比 restricted-token 后端，elevated 后端可以强制执行 deny-read、拆分可读根与可写根，
/// 但同样不能处理在只读 carveout 之下重新开放的写入子树。
pub fn resolve_windows_elevated_filesystem_overrides(
    sandbox: SandboxType,
    permission_profile: &PermissionProfile,
    sandbox_policy_cwd: &AbsolutePathBuf,
    use_windows_elevated_backend: bool,
) -> std::result::Result<Option<WindowsSandboxFilesystemOverrides>, String> {
    if sandbox != SandboxType::WindowsRestrictedToken || !use_windows_elevated_backend {
        return Ok(None);
    }

    let (file_system_sandbox_policy, network_sandbox_policy) =
        permission_profile.to_runtime_permissions();

    if !permission_profile_supports_windows_restricted_token_sandbox(permission_profile) {
        let permission_profile_name = permission_profile_display_name(permission_profile);
        return Err(format!(
            "windows sandbox backend cannot enforce file_system={:?}, network={network_sandbox_policy:?}, permission_profile={permission_profile_name}; refusing to run unsandboxed",
            file_system_sandbox_policy.kind,
        ));
    }

    let additional_deny_read_paths = codex_windows_sandbox::resolve_windows_deny_read_paths(
        &file_system_sandbox_policy,
        sandbox_policy_cwd,
    )?;

    let split_writable_roots =
        file_system_sandbox_policy.get_writable_roots_with_cwd(sandbox_policy_cwd);
    if has_reopened_writable_descendant(&split_writable_roots) {
        return Err(
            "windows elevated sandbox cannot reopen writable descendants under read-only carveouts directly; refusing to run unsandboxed"
                .to_string(),
        );
    }

    let needs_direct_runtime_enforcement = file_system_sandbox_policy
        .needs_direct_runtime_enforcement(network_sandbox_policy, sandbox_policy_cwd);
    let normalize_path = |path: PathBuf| dunce::canonicalize(&path).unwrap_or(path);
    let legacy_projection = compatibility_sandbox_policy_for_permission_profile(
        permission_profile,
        sandbox_policy_cwd.as_path(),
    );
    let legacy_writable_roots = legacy_projection.get_writable_roots_with_cwd(sandbox_policy_cwd);
    let legacy_root_paths: BTreeSet<PathBuf> = legacy_writable_roots
        .iter()
        .map(|root| normalize_path(root.root.to_path_buf()))
        .collect();
    let split_readable_roots: Vec<PathBuf> = file_system_sandbox_policy
        .get_readable_roots_with_cwd(sandbox_policy_cwd)
        .into_iter()
        .map(AbsolutePathBuf::into_path_buf)
        .map(&normalize_path)
        .collect();
    let split_root_paths: Vec<PathBuf> = split_writable_roots
        .iter()
        .map(|root| normalize_path(root.root.to_path_buf()))
        .collect();
    let split_root_path_set: BTreeSet<PathBuf> = split_root_paths.iter().cloned().collect();

    // `has_full_disk_read_access()` 在存在 deny-read 条目时故意返回 false。
    // 对于 Windows setup 覆盖而言，真正的问题是 baseline 是否仍从文件系统根目录读取，
    // 而只需在其上叠加额外的 deny ACL。
    let split_has_root_read_access =
        windows_policy_has_root_read_access(&file_system_sandbox_policy, sandbox_policy_cwd);
    let read_roots_override = if split_has_root_read_access {
        None
    } else {
        Some(split_readable_roots)
    };

    let write_roots_override = if split_root_path_set == legacy_root_paths {
        None
    } else {
        Some(split_root_paths)
    };

    let additional_deny_write_paths = if needs_direct_runtime_enforcement {
        let mut deny_paths = BTreeSet::new();
        for writable_root in &split_writable_roots {
            let writable_root_path = normalize_path(writable_root.root.to_path_buf());
            let legacy_root = legacy_writable_roots.iter().find(|candidate| {
                normalize_path(candidate.root.to_path_buf()) == writable_root_path
            });
            for read_only_subpath in &writable_root.read_only_subpaths {
                let read_only_subpath_suffix = read_only_subpath
                    .as_path()
                    .strip_prefix(writable_root.root.as_path())
                    .ok();
                let already_denied_by_legacy = legacy_root.is_some_and(|legacy_root| {
                    legacy_root.read_only_subpaths.iter().any(|candidate| {
                        candidate
                            .as_path()
                            .strip_prefix(legacy_root.root.as_path())
                            .ok()
                            == read_only_subpath_suffix
                    })
                });
                if !already_denied_by_legacy {
                    deny_paths.insert(normalize_path(read_only_subpath.to_path_buf()));
                }
            }
        }
        deny_paths
            .into_iter()
            .map(|path| AbsolutePathBuf::from_absolute_path(path).map_err(|err| err.to_string()))
            .collect::<std::result::Result<_, _>>()?
    } else {
        Vec::new()
    };

    if read_roots_override.is_none()
        && write_roots_override.is_none()
        && additional_deny_read_paths.is_empty()
        && additional_deny_write_paths.is_empty()
    {
        return Ok(None);
    }

    Ok(Some(WindowsSandboxFilesystemOverrides {
        read_roots_include_platform_defaults: read_roots_override.is_some()
            && file_system_sandbox_policy.include_platform_defaults(),
        read_roots_override,
        write_roots_override,
        additional_deny_read_paths,
        additional_deny_write_paths,
    }))
}

/// 将路径规范化为可用于 Windows 沙箱覆盖项的绝对路径形式。
fn normalize_windows_override_path(path: &Path) -> std::result::Result<PathBuf, String> {
    AbsolutePathBuf::from_absolute_path(dunce::simplified(path))
        .map(AbsolutePathBuf::into_path_buf)
        .map_err(|err| err.to_string())
}

/// 判断文件系统策略在给定工作目录下是否仍可读取文件系统根目录。
fn windows_policy_has_root_read_access(
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    cwd: &AbsolutePathBuf,
) -> bool {
    let Some(root) = cwd.as_path().ancestors().last() else {
        return false;
    };
    file_system_sandbox_policy.can_read_path_with_cwd(root, cwd.as_path())
}

/// 返回权限配置的可读名称，用于错误信息中。
fn permission_profile_display_name(permission_profile: &PermissionProfile) -> &'static str {
    match permission_profile {
        PermissionProfile::Managed { .. } => "Managed",
        PermissionProfile::Disabled => "Disabled",
        PermissionProfile::External { .. } => "External",
    }
}

/// 判断给定可写根集合中是否存在“在只读 carveout 之下重新开放的写入子树”。
///
/// 这种结构在 Windows 沙箱下无法直接强制执行，需要在更早阶段拒绝。
fn has_reopened_writable_descendant(writable_roots: &[WritableRoot]) -> bool {
    writable_roots.iter().any(|writable_root| {
        writable_root
            .read_only_subpaths
            .iter()
            .any(|read_only_subpath| {
                writable_roots.iter().any(|candidate| {
                    candidate.root.as_path() != writable_root.root.as_path()
                        && candidate
                            .root
                            .as_path()
                            .starts_with(read_only_subpath.as_path())
                })
            })
    })
}
