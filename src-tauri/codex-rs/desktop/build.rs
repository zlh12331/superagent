//! Tauri 构建脚本。
//!
//! 执行三项任务：
//!
//! 1. **Tauri build**——`tauri_build::try_build()` 配合
//!    `WindowsAttributes::new_without_app_manifest()` 处理 Tauri 专属的
//!    资源生成（图标、capabilities、版本信息）。我们禁用 tauri-build
//!    自带的 manifest 嵌入，以避免重复 manifest 资源（见第 2 步）。
//!
//! 2. **Windows manifest**——`embed_resource::compile_for_everything()` 通过
//!    `cargo:rustc-link-arg` 将 Common-Controls v6 manifest 嵌入到所有目标
//!    （二进制、测试二进制等）。
//!
//!    这修复了 Windows 上的 `cargo test`：tauri-build 内部使用
//!    `embed_resource::compile()`，输出 `cargo:rustc-link-arg-bins`
//!    （仅二进制目标）。测试二进制无 manifest，因 comctl32.dll v5 缺少
//!    Tauri/WebView2 依赖所需的入口点而崩溃
//!    （STATUS_ENTRYPOINT_NOT_FOUND 0xc0000139）。
//!
//!    通过禁用 tauri-build 的 manifest 并用 `compile_for_everything()`
//!    嵌入自己的 manifest，所有目标都能获得 manifest 而无重复资源冲突。
//!
//! 3. **Sentry DSN**——读取前端 `.env` 文件提取 `VITE_SENTRY_DSN`，
//!    并通过 `cargo:rustc-env` 将其设置为编译期环境变量（`SENTRY_DSN`）。
//!    Rust `sentry` crate 在 `lib.rs` 中通过 `option_env!("SENTRY_DSN")`
//!    在编译期消费。这样 DSN 配置在前端（`@sentry/react`）和 Rust 后端
//!    （`sentry` crate）保持单点配置（`.env`）。

// 构建脚本（build.rs）中 .expect()/.unwrap() 是标准实践：
// 构建失败时 panic 会立即停止编译，这是预期行为。
// 放宽 workspace 的 expect_used/unwrap_used deny 规则。
#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::fs;
use std::path::PathBuf;

/// Build script 入口 — 在 Cargo 编译包之前执行。
///
/// 按 3 个步骤顺序执行（任一步骤失败都会 panic 终止构建）：
///
/// 1. **Tauri build**：调用 `tauri_build::try_build()` 生成 Tauri 资源
///    （图标、capabilities、版本信息），但禁用其自带的 Windows manifest
///    嵌入以避免资源重复（见第 2 步）；
/// 2. **Windows manifest**（仅 Windows）：通过 `embed_resource::compile_for_everything()`
///    将 Common-Controls v6 manifest 嵌入所有目标（二进制、测试、bench），
///    修复 `cargo test` 因缺少 manifest 导致的崩溃；
/// 3. **Sentry DSN**：读取前端 `.env` 文件提取 `VITE_SENTRY_DSN`，
///    通过 `cargo:rustc-env` 设为编译期环境变量供 Rust `sentry` crate 消费。
///
/// # 重新构建触发
///
/// - `.env` 文件变更通过 `cargo:rerun-if-changed` 显式声明；
/// - 其他 Tauri 资源（如图标）由 `tauri_build` 内部管理。
fn main() {
    // 1. Tauri build——编译资源时不带 manifest（我们在第 2 步自行嵌入，
    //    以覆盖所有目标，包括测试二进制）。
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
    )
    .expect("failed to run tauri-build");

    // 2. 将 Windows manifest（Common-Controls v6）嵌入所有目标。
    //    compile_for_everything() 输出 cargo:rustc-link-arg，适用于
    //    二进制、测试二进制、bench 和 example。
    //    非 Windows 平台为 no-op（返回 NotWindows）。
    #[cfg(target_os = "windows")]
    embed_resource::compile_for_everything("app-manifest.rc", embed_resource::NONE)
        .manifest_required()
        .unwrap();

    // 3. 读取 .env 配置 Sentry DSN。
    let env_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .expect("should have project root above codex-rs/desktop/")
        .join(".env");

    if !env_path.exists() {
        println!(
            "cargo:warning=No .env file found at {}, Sentry DSN not configured",
            env_path.display()
        );
        return;
    }

    // .env 变更时重新构建——Cargo 默认只监视包内文件；
    // .env 位于父目录，否则会被忽略，导致编辑后 DSN 值过期。
    println!("cargo:rerun-if-changed={}", env_path.display());

    let content = match fs::read_to_string(&env_path) {
        Ok(c) => c,
        Err(e) => {
            println!("cargo:warning=Failed to read .env file: {e}");
            return;
        }
    };

    // 解析简单 KEY=VALUE 格式（忽略注释和空行）
    for line in content.lines() {
        let line = line.trim();

        // 跳过注释和空行
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        // 查找 KEY=VALUE 分隔符
        if let Some((key, value)) = line.split_once('=') {
            let key = key.trim();
            let value = value.trim();
            // 移除两端引号（如 KEY="value" → value）
            let value = value
                .strip_prefix('"')
                .and_then(|v| v.strip_suffix('"'))
                .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
                .unwrap_or(value);

            // 将 VITE_SENTRY_DSN 映射为 SENTRY_DSN，供 Rust sentry crate 使用
            if key == "VITE_SENTRY_DSN" && !value.is_empty() {
                // 设为编译期 env var——在 lib.rs 中通过
                // `option_env!("SENTRY_DSN")` 消费（非运行时 env::var）。
                println!("cargo:rustc-env=SENTRY_DSN={value}");
                println!("cargo:warning=Sentry DSN configured from .env file");
                return;
            }
        }
    }

    println!("cargo:warning=Sentry DSN not found in .env — crash reporting disabled");
}
