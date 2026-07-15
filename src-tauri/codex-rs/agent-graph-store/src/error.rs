/// Result type returned by agent graph store operations.
pub type AgentGraphStoreResult<T> = Result<T, AgentGraphStoreError>;

/// Error type shared by agent graph store implementations.
#[derive(Debug, thiserror::Error)]
pub enum AgentGraphStoreError {
    /// 调用方提供了无效的请求数据。
    /// 通常表示请求参数缺失、类型不匹配或违反了 store 的不变量约束。
    #[error("invalid agent graph store request: {message}")]
    InvalidRequest {
        /// 面向用户的无效请求说明文本。
        message: String,
    },

    /// Catch-all for implementation failures that do not fit a more specific category.
    #[error("agent graph store internal error: {message}")]
    Internal {
        /// User-facing explanation of the implementation failure.
        message: String,
    },
}
