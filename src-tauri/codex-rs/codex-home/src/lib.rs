//! codex 主目录用户指令提供者。
//!
//! 本 crate 负责从 codex 主目录（通常为 `~/.codex`）加载用户自定义指令，
//! 并将其作为上下文片段注入到模型可见的提示词中。

mod instructions;

/// 从 codex 主目录加载用户自定义指令的提供者。
pub use instructions::CodexHomeUserInstructionsProvider;
