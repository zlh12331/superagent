#![allow(clippy::unwrap_used, clippy::expect_used)]

// 重新导出生成的 OpenAPI models。
// regen 脚本会填充 `src/models/*.rs` 并写入 `src/models/mod.rs`。
// 本模块刻意不包含任何 hand-written types，所有类型均由脚本生成，以保证与
// OpenAPI 规范的一致性。
pub mod models;
