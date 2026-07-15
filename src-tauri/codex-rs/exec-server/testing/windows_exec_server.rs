//! 用于跨平台测试的最小化 Windows exec-server 测试夹具（fixture）。
//!
//! 将该 wrapper 单独维护，可以避免依赖完整 Codex 二进制的 Windows 交叉编译
//! 产物——目前 Bazel 构建图尚未支持该交叉编译。仅链接 exec-server 也使得
//! 基于 Wine 的测试在迭代时显著更快。

use codex_exec_server::ExecServerRuntimePaths;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let current_exe = std::env::current_exe()?;
    // 该 fixture 始终是一个 Windows 可执行文件，因此它既不会调用、也不需要
    // 单独的 Linux sandbox 二进制。
    let runtime_paths =
        ExecServerRuntimePaths::new(current_exe, /*codex_linux_sandbox_exe*/ None)?;
    codex_exec_server::run_main("ws://127.0.0.1:0", runtime_paths).await
}
