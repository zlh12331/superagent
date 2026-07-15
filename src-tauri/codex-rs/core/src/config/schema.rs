//! 配置 schema 模块。
//!
//! 该模块作为 `codex-config` 中 schema 工具的薄封装,
//! 提供 JSON Schema 的生成、规范化与写入能力,
//! 供 `bin/config_schema.rs` 等工具生成对外发布的 schema 文件。

use codex_config::schema::canonicalize;
use codex_config::schema::config_schema_json;
use codex_config::schema::write_config_schema;

#[cfg(test)]
#[path = "schema_tests.rs"]
mod tests;
