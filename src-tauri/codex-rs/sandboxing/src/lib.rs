//! 跨平台命令沙箱化模块。
//!
//! 将外部命令执行包装进 OS 原生沙箱，按权限配置限制文件系统与网络访问：
//! - macOS：使用 [`seatbelt`](seatbelt) 模块生成 `sandbox-exec` 策略
//! - Linux：使用 [`landlock`] 与 [`bwrap`] 模块生成 `codex-linux-sandbox` 调用参数
//! - Windows：通过 [`windows`] 模块计算 restricted-token / elevated 后端所需的文件系统覆盖
//!
//! 核心入口为 [`manager::SandboxManager`]，负责依据 [`SandboxType`] 与
//! [`SandboxablePreference`] 选择平台沙箱并生成 [`SandboxExecRequest`]。
//! [`denial`] 模块根据退出码与输出关键字判定命令是否被沙箱拒绝。

#[cfg(target_os = "linux")]
mod bwrap;
mod denial;
pub mod landlock;
mod manager;
pub mod policy_transforms;
#[cfg(target_os = "macos")]
pub mod seatbelt;
mod windows;

#[cfg(target_os = "linux")]
pub use bwrap::find_system_bwrap_in_path;
#[cfg(target_os = "linux")]
pub use bwrap::system_bwrap_warning;
pub use codex_windows_sandbox::WindowsSandboxProxySettingsMode;
pub use denial::is_likely_sandbox_denied;
pub use manager::SandboxCommand;
pub use manager::SandboxDirectSpawnTransformRequest;
pub use manager::SandboxExecRequest;
pub use manager::SandboxManager;
pub use manager::SandboxTransformError;
pub use manager::SandboxTransformRequest;
pub use manager::SandboxType;
pub use manager::SandboxablePreference;
pub use manager::compatibility_sandbox_policy_for_permission_profile;
pub use manager::get_platform_sandbox;
pub use manager::with_managed_mitm_ca_readable_root;
pub use windows::WindowsSandboxFilesystemOverrides;
pub use windows::permission_profile_supports_windows_restricted_token_sandbox;
pub use windows::resolve_windows_elevated_filesystem_overrides;
pub use windows::resolve_windows_restricted_token_filesystem_overrides;
pub use windows::unsupported_windows_restricted_token_sandbox_reason;
pub use windows::windows_sandbox_uses_elevated_backend;

use codex_protocol::error::CodexErr;

/// 非 Linux 平台的 `system_bwrap_warning` 占位实现。
///
/// bubblewrap 仅在 Linux 上使用，其他平台直接返回 `None`，
/// 与 [`bwrap::system_bwrap_warning`](crate::bwrap::system_bwrap_warning) 保持签名一致。
#[cfg(not(target_os = "linux"))]
pub fn system_bwrap_warning(
    _permission_profile: &codex_protocol::models::PermissionProfile,
) -> Option<String> {
    None
}

/// 将 [`SandboxTransformError`] 映射为协议层 [`CodexErr`]，供跨进程错误传递使用。
impl From<SandboxTransformError> for CodexErr {
    fn from(err: SandboxTransformError) -> Self {
        match err {
            error @ SandboxTransformError::InvalidCommandCwd { .. }
            | error @ SandboxTransformError::InvalidSandboxPolicyCwd { .. } => {
                CodexErr::InvalidRequest(error.to_string())
            }
            SandboxTransformError::MissingLinuxSandboxExecutable => {
                CodexErr::LandlockSandboxExecutableNotProvided
            }
            SandboxTransformError::EnvironmentNetworkProxy(message) => {
                CodexErr::UnsupportedOperation(message)
            }
            #[cfg(target_os = "linux")]
            SandboxTransformError::Wsl1UnsupportedForBubblewrap => {
                CodexErr::UnsupportedOperation(crate::bwrap::WSL1_BWRAP_WARNING.to_string())
            }
            #[cfg(not(target_os = "macos"))]
            SandboxTransformError::SeatbeltUnavailable => CodexErr::UnsupportedOperation(
                "seatbelt sandbox is only available on macOS".to_string(),
            ),
            #[cfg(target_os = "windows")]
            SandboxTransformError::WindowsSandboxPreparation(message) => {
                CodexErr::UnsupportedOperation(message)
            }
        }
    }
}
