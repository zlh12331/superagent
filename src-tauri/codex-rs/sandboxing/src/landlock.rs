//! Linux 沙箱命令行参数生成模块。
//!
//! 将 [`PermissionProfile`] 转换为 `codex-linux-sandbox` 助手的 CLI 调用参数。
//! 实际沙箱化由助手执行（默认 bubblewrap + seccomp），详见 `docs/linux_sandbox.md`。

use codex_protocol::models::PermissionProfile;
use std::path::Path;

/// 当 Codex 可执行文件自调用为 Linux 沙箱助手时使用的 `argv[0]` 基名。
pub const CODEX_LINUX_SANDBOX_ARG0: &str = "codex-linux-sandbox";

/// 根据是否启用托管网络，决定是否向 Linux 沙箱助手请求代理专属网络。
///
/// 启用托管网络时请求 bubblewrap 隔离的网络命名空间走代理路由；
/// 未启用时保持既有行为不变。
pub fn allow_network_for_proxy(enforce_managed_network: bool) -> bool {
    // When managed network requirements are active, request proxy-only
    // networking from the Linux sandbox helper. Without managed requirements,
    // preserve existing behavior.
    // 启用托管网络时，向 Linux 沙箱助手请求代理专属网络；
    // 未启用时保持既有行为。
    enforce_managed_network
}

/// 将权限配置转换为 `codex-linux-sandbox` 的 CLI 调用参数。
///
/// 助手解析这些参数后执行实际沙箱化（默认 bubblewrap + seccomp）。
/// profile JSON 标志位于特性标志之前，确保 argv 顺序与助手的 CLI 形态一致。
/// Linux 语义详见 `docs/linux_sandbox.md`。
#[allow(clippy::too_many_arguments)]
pub fn create_linux_sandbox_command_args_for_permission_profile(
    command: Vec<String>,
    command_cwd: &Path,
    permission_profile: &PermissionProfile,
    sandbox_policy_cwd: &Path,
    use_legacy_landlock: bool,
    allow_network_for_proxy: bool,
) -> Vec<String> {
    let permission_profile_json = serde_json::to_string(permission_profile)
        .unwrap_or_else(|err| panic!("failed to serialize permission profile: {err}"));
    let sandbox_policy_cwd = sandbox_policy_cwd
        .to_str()
        .unwrap_or_else(|| panic!("cwd must be valid UTF-8"))
        .to_string();
    let command_cwd = command_cwd
        .to_str()
        .unwrap_or_else(|| panic!("command cwd must be valid UTF-8"))
        .to_string();

    let mut linux_cmd: Vec<String> = vec![
        "--sandbox-policy-cwd".to_string(),
        sandbox_policy_cwd,
        "--command-cwd".to_string(),
        command_cwd,
        "--permission-profile".to_string(),
        permission_profile_json,
    ];
    // Proxy-only networking requires bubblewrap's isolated network namespace.
    // 代理专属网络需要 bubblewrap 的隔离网络命名空间。
    if use_legacy_landlock && !allow_network_for_proxy {
        linux_cmd.push("--use-legacy-landlock".to_string());
    }
    if allow_network_for_proxy {
        linux_cmd.push("--allow-network-for-proxy".to_string());
    }
    linux_cmd.push("--".to_string());
    linux_cmd.extend(command);
    linux_cmd
}

/// 将沙箱 cwd 与执行选项转换为 `codex-linux-sandbox` 的 CLI 调用参数。
#[cfg_attr(not(test), allow(dead_code))]
fn create_linux_sandbox_command_args(
    command: Vec<String>,
    command_cwd: &Path,
    sandbox_policy_cwd: &Path,
    use_legacy_landlock: bool,
    allow_network_for_proxy: bool,
) -> Vec<String> {
    let command_cwd = command_cwd
        .to_str()
        .unwrap_or_else(|| panic!("command cwd must be valid UTF-8"))
        .to_string();
    let sandbox_policy_cwd = sandbox_policy_cwd
        .to_str()
        .unwrap_or_else(|| panic!("cwd must be valid UTF-8"))
        .to_string();

    let mut linux_cmd: Vec<String> = vec![
        "--sandbox-policy-cwd".to_string(),
        sandbox_policy_cwd,
        "--command-cwd".to_string(),
        command_cwd,
    ];
    // Proxy-only networking requires bubblewrap's isolated network namespace.
    // 代理专属网络需要 bubblewrap 的隔离网络命名空间。
    if use_legacy_landlock && !allow_network_for_proxy {
        linux_cmd.push("--use-legacy-landlock".to_string());
    }
    if allow_network_for_proxy {
        linux_cmd.push("--allow-network-for-proxy".to_string());
    }

    // Separator so that command arguments starting with `-` are not parsed as
    // options of the helper itself.
    // 分隔符：确保以 `-` 开头的命令参数不被解析为助手自身的选项。
    linux_cmd.push("--".to_string());

    // Append the original tool command.
    // 追加原始工具命令。
    linux_cmd.extend(command);

    linux_cmd
}

#[cfg(test)]
#[path = "landlock_tests.rs"]
mod tests;
