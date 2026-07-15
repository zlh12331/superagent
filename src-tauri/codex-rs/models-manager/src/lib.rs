//! 模型管理器（models manager）crate 入口模块。
//!
//! 该 crate 负责模型目录的加载、缓存、预设（presets）管理以及协作模式
//! （collaboration mode）预设的维护。核心能力包括：
//! - 从内置 `models.json` 加载模型目录；
//! - 模型预设与协作模式预设的声明与管理；
//! - 模型 manager 的配置与运行时支持；
//! - 测试支持工具。
//!
//! 核心类型：[`ModelsManagerConfig`]、[`AuthMode`]。

/// 模型目录缓存模块（crate 内部使用）。
pub(crate) mod cache;
/// 协作模式预设模块：定义不同协作场景下的模型与参数组合。
pub mod collaboration_mode_presets;
/// models manager 配置定义模块（crate 内部使用）。
pub(crate) mod config;
/// 模型 manager 主逻辑模块：负责模型选择与切换。
pub mod manager;
/// 模型元信息模块：描述单个模型的能力与限制。
pub mod model_info;
/// 模型预设模块：定义预置的模型配置组合。
pub mod model_presets;
/// 测试支持模块：为单元测试与集成测试提供辅助工具。
pub mod test_support;

/// 认证模式类型重导出（来自 `codex_protocol`）。
pub use codex_protocol::auth::AuthMode;
/// models manager 配置类型重导出。
pub use config::ModelsManagerConfig;

/// 加载随 `codex-models-manager` 一起发布的内置模型目录。
///
/// 从 `models.json` 文件中反序列化得到 [`ModelsResponse`]。该文件在编译期
/// 通过 `include_str!` 嵌入二进制，因此运行时无需访问磁盘。
pub fn bundled_models_response()
-> std::result::Result<codex_protocol::openai_models::ModelsResponse, serde_json::Error> {
    serde_json::from_str(include_str!("../models.json"))
}

/// 将客户端版本字符串转换为完整版本号（如 "1.2.3-alpha.4" -> "1.2.3"）。
///
/// 仅取 `CARGO_PKG_VERSION` 的 major.minor.patch 三段，忽略预发布标识。
pub fn client_version_to_whole() -> String {
    format!(
        "{}.{}.{}",
        env!("CARGO_PKG_VERSION_MAJOR"),
        env!("CARGO_PKG_VERSION_MINOR"),
        env!("CARGO_PKG_VERSION_PATCH")
    )
}
