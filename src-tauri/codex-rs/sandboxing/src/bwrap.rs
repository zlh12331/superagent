//! bubblewrap 系统安装探测与诊断模块。
//!
//! 在 Linux 上检测系统 PATH 中的 `bwrap` 是否可用、是否支持用户命名空间，
//! 并在缺失或不可用时生成面向用户的警告。WSL1 因不支持用户命名空间而被显式拒绝。
//! 这些诊断信息用于在启动时提示用户安装或修复 bubblewrap 环境。

use crate::policy_transforms::should_require_platform_sandbox;
use codex_protocol::models::PermissionProfile;
use std::io::ErrorKind;
use std::io::Read;
use std::os::fd::AsRawFd;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Output;
use std::process::Stdio;
use std::thread;
use std::time::Duration;
use std::time::Instant;

/// 系统 `bwrap` 可执行文件名。
const SYSTEM_BWRAP_PROGRAM: &str = "bwrap";
/// 系统 PATH 上找不到 `bwrap` 时展示的警告文案。
const MISSING_BWRAP_WARNING: &str = concat!(
    "Codex could not find bubblewrap on PATH. ",
    "Install bubblewrap with your OS package manager. ",
    "See the sandbox prerequisites: ",
    "https://developers.openai.com/codex/concepts/sandboxing#prerequisites. ",
    "Codex will use the bundled bubblewrap in the meantime."
);
/// 系统 `bwrap` 存在但无法创建用户命名空间时展示的警告文案。
const USER_NAMESPACE_WARNING: &str =
    "Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces.";
/// WSL1 不支持 bubblewrap 的警告文案（`pub(crate)` 供 manager 引用）。
pub(crate) const WSL1_BWRAP_WARNING: &str = concat!(
    "Codex's Linux sandbox uses bubblewrap, which is not supported on WSL1 ",
    "because WSL1 cannot create the required user namespaces. ",
    "Use WSL2 for sandboxed shell commands."
);
/// bubblewrap 创建用户命名空间失败时 stderr 中可能出现的关键字。
const USER_NAMESPACE_FAILURES: [&str; 4] = [
    "loopback: Failed RTM_NEWADDR",
    "loopback: Failed RTM_NEWLINK",
    "setting up uid map: Permission denied",
    "No permissions to create a new namespace",
];
/// 探测 `bwrap` 用户命名空间能力的最大等待时长。
const SYSTEM_BWRAP_PROBE_TIMEOUT: Duration = Duration::from_millis(500);
/// 探测期间轮询子进程状态的间隔。
const SYSTEM_BWRAP_PROBE_POLL_INTERVAL: Duration = Duration::from_millis(50);
/// 探测时最多读取的 stderr 字节数，避免无限读取。
const SYSTEM_BWRAP_PROBE_STDERR_LIMIT_BYTES: u64 = 64 * 1024;

/// 根据权限配置判断是否需要向用户展示系统 `bwrap` 的警告。
///
/// 仅当当前权限配置确实需要平台沙箱时才进行诊断，避免在禁用沙箱的场景下误报。
pub fn system_bwrap_warning(permission_profile: &PermissionProfile) -> Option<String> {
    if !should_warn_about_system_bwrap(permission_profile) {
        return None;
    }

    let system_bwrap_path = find_system_bwrap_in_path();
    system_bwrap_warning_for_path(system_bwrap_path.as_deref())
}

/// 判断当前权限配置是否需要平台沙箱（从而才需要诊断 `bwrap`）。
fn should_warn_about_system_bwrap(permission_profile: &PermissionProfile) -> bool {
    let (file_system_policy, network_policy) = permission_profile.to_runtime_permissions();
    should_require_platform_sandbox(
        &file_system_policy,
        network_policy,
        /*has_managed_network_requirements*/ false,
    )
}

/// 根据已定位的 `bwrap` 路径生成诊断警告（可能为 `None`）。
///
/// 优先级：WSL1 检测 > `bwrap` 缺失 > 用户命名空间不可用。
fn system_bwrap_warning_for_path(system_bwrap_path: Option<&Path>) -> Option<String> {
    if is_wsl1() {
        return Some(WSL1_BWRAP_WARNING.to_string());
    }

    let Some(system_bwrap_path) = system_bwrap_path else {
        return Some(MISSING_BWRAP_WARNING.to_string());
    };

    if !system_bwrap_has_user_namespace_access(system_bwrap_path, SYSTEM_BWRAP_PROBE_TIMEOUT) {
        return Some(USER_NAMESPACE_WARNING.to_string());
    }

    None
}

/// 通过运行 `bwrap --unshare-user --unshare-net ... /bin/true` 探测用户命名空间可用性。
///
/// 在 `timeout` 内轮询子进程状态，超时则视为可用（保守策略，避免阻塞启动）。
/// 探测失败但 stderr 不包含已知用户命名空间失败关键字时也视为可用。
fn system_bwrap_has_user_namespace_access(system_bwrap_path: &Path, timeout: Duration) -> bool {
    let mut child = match Command::new(system_bwrap_path)
        .args([
            "--unshare-user",
            "--unshare-net",
            "--ro-bind",
            "/",
            "/",
            "/bin/true",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return true,
    };

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stderr = child.stderr.take().map_or_else(Vec::new, |stderr| {
                    let fd = stderr.as_raw_fd();
                    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
                    if flags < 0
                        || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
                    {
                        return Vec::new();
                    }

                    let mut bytes = Vec::new();
                    let mut stderr = stderr.take(SYSTEM_BWRAP_PROBE_STDERR_LIMIT_BYTES);
                    if let Err(err) = stderr.read_to_end(&mut bytes)
                        && err.kind() != ErrorKind::WouldBlock
                    {
                        return bytes;
                    }
                    bytes
                });
                let output = Output {
                    status,
                    stdout: Vec::new(),
                    stderr,
                };
                return output.status.success() || !is_user_namespace_failure(&output);
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return true;
                }
                thread::sleep(SYSTEM_BWRAP_PROBE_POLL_INTERVAL);
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return true;
            }
        }
    }
}

/// 通过读取 `/proc/version` 判断当前是否运行在 WSL1 上。
pub(crate) fn is_wsl1() -> bool {
    std::fs::read_to_string("/proc/version")
        .is_ok_and(|proc_version| proc_version_indicates_wsl1(&proc_version))
}

/// 解析 `/proc/version` 内容，判断是否为 WSL1。
///
/// 优先匹配 `wsl<digit>` 形式的版本标记；若未找到显式版本，
/// 则在包含 `microsoft` 但不包含 `microsoft-standard` 时判定为 WSL1。
fn proc_version_indicates_wsl1(proc_version: &str) -> bool {
    let proc_version = proc_version.to_ascii_lowercase();
    let mut remaining = proc_version.as_str();
    while let Some(marker) = remaining.find("wsl") {
        let version_start = marker + "wsl".len();
        let version_digits: String = remaining[version_start..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        if let Ok(version) = version_digits.parse::<u32>() {
            return version == 1;
        }
        remaining = &remaining[version_start..];
    }

    proc_version.contains("microsoft") && !proc_version.contains("microsoft-standard")
}

/// 检查探测输出是否包含已知的用户命名空间失败关键字。
fn is_user_namespace_failure(output: &Output) -> bool {
    let stderr = String::from_utf8_lossy(&output.stderr);
    USER_NAMESPACE_FAILURES
        .iter()
        .any(|failure| stderr.contains(failure))
}

/// 在系统 PATH 中查找 `bwrap` 可执行文件。
///
/// 排除位于当前工作目录下的匹配项，防止执行用户工作区内的同名文件。
pub fn find_system_bwrap_in_path() -> Option<PathBuf> {
    let search_path = std::env::var_os("PATH")?;
    let cwd = std::env::current_dir().ok()?;
    find_system_bwrap_in_search_paths(std::env::split_paths(&search_path), &cwd)
}

/// 在给定搜索路径集合中查找 `bwrap`，跳过当前工作目录下的匹配项。
fn find_system_bwrap_in_search_paths(
    search_paths: impl IntoIterator<Item = PathBuf>,
    cwd: &Path,
) -> Option<PathBuf> {
    let search_path = std::env::join_paths(search_paths).ok()?;
    let cwd = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let cwd_is_root = cwd.parent().is_none();
    which::which_in_all(SYSTEM_BWRAP_PROGRAM, Some(search_path), &cwd)
        .ok()?
        .find_map(|path| {
            let path = std::fs::canonicalize(path).ok()?;
            if !cwd_is_root && path.starts_with(&cwd) {
                None
            } else {
                Some(path)
            }
        })
}

#[cfg(test)]
#[path = "bwrap_tests.rs"]
mod tests;
