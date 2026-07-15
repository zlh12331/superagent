//! 命令解析与安全检查工具集，供 Codex 各 crate 共享使用。
//!
//! 该 crate 提供跨 shell（bash、powershell）的命令解析、shell 检测与
//! 命令安全判定能力。核心导出：[`is_dangerous_command`]、[`is_safe_command`]。

/// Shell 检测模块：识别当前环境所使用的 shell。
pub mod shell_detect;

/// Bash 命令解析模块。
pub mod bash;
/// 命令安全检查模块（crate 内部使用）。
pub(crate) mod command_safety;
/// 命令解析模块：将命令字符串解析为结构化表示。
pub mod parse_command;
/// PowerShell 命令解析模块。
pub mod powershell;

/// 判断给定命令是否为危险命令。
pub use command_safety::is_dangerous_command;
/// 判断给定命令是否为安全命令。
pub use command_safety::is_safe_command;
