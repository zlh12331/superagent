//! Codex 的云端托管配置（cloud-hosted configuration）数据。
//!
//! 本 crate 负责云端下发配置数据的传输、缓存与刷新行为；
//! 解析与组合逻辑仍保留在 `codex-config` crate 中。

mod backend;
mod bundle_loader;
mod cache;
mod metrics;
mod service;
mod validation;

/// 构建默认的云端配置 bundle 加载器，使用进程内默认存储后端。
pub use bundle_loader::cloud_config_bundle_loader;
/// 构建云端配置 bundle 加载器，允许调用方注入自定义存储后端。
pub use bundle_loader::cloud_config_bundle_loader_for_storage;
