//! Linux 沙箱助手入口模块。
//!
//! 在 Linux 上，`codex-linux-sandbox` 会应用：
//! - 进程内限制（`no_new_privs` + seccomp），以及
//! - bubblewrap 用于文件系统隔离。
#[cfg(target_os = "linux")]
mod bazel_bwrap;
#[cfg(target_os = "linux")]
mod bundled_bwrap;
#[cfg(target_os = "linux")]
mod bwrap;
#[cfg(target_os = "linux")]
mod exec_util;
#[cfg(target_os = "linux")]
mod landlock;
#[cfg(target_os = "linux")]
mod launcher;
#[cfg(target_os = "linux")]
mod linux_run_main;
#[cfg(target_os = "linux")]
mod proxy_routing;

/// Linux 沙箱的 main 入口。仅在 Linux 上有效，在其他平台上会 panic。
#[cfg(target_os = "linux")]
pub fn run_main() -> ! {
    linux_run_main::run_main();
}

/// 非 Linux 平台的 main 入口桩函数，调用时直接 panic。
#[cfg(not(target_os = "linux"))]
pub fn run_main() -> ! {
    panic!("codex-linux-sandbox is only supported on Linux");
}
