//! Function tool 重导出模块。
//!
//! 透传 [`codex_tools::FunctionCallError`] 给 codex-core 内部使用,
//! 避免在每个使用点直接引用 codex-tools crate,降低耦合。

pub use codex_tools::FunctionCallError;
