//! 按域组织的 Tauri 命令处理器。
//!
//! 每个子模块包含相关命令及其辅助函数。
//! 通过子模块导入特定命令（如 `commands::preferences::greet`）。

// tauri-template 基础命令
pub mod crash_report;
pub mod notifications;
pub mod preferences;
pub mod quick_pane;
pub mod recovery;
pub mod tray;

// codex-rs 业务命令（按域组织）
pub mod account;
pub mod approval;
pub mod command_exec;
pub mod config;
pub mod fs;
pub mod mcp;
pub mod plugin;
pub mod process;
pub mod thread;
pub mod turn;
