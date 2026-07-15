//! 认证错误类型重导出。
//!
//! 将 `codex_protocol` 中定义的 token 刷新失败错误类型重新导出，
//! 供 `codex-login` crate 内部与外部调用方使用。

pub use codex_protocol::auth::RefreshTokenFailedError;
pub use codex_protocol::auth::RefreshTokenFailedReason;
