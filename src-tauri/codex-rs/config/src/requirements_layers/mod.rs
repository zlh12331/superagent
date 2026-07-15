//! requirements 层的合并与组合。
//!
//! 本模块组织 requirements 层的解析、合并与组合逻辑。requirements 层
//! 与 config 层的合并顺序一致：低优先级在前，高优先级在后。大多数字段
//! 走与 config 相同的 TOML 合并策略（标量/列表覆盖，表递归扩展）；
//! 少量字段具有领域特定语义（参见 `stack` 模块的文档）。
//!
//! 重新导出：
//! - [`RequirementsLayerEntry`]：单层 requirements 的输入条目。
//! - [`compose_requirements`]：把多层 requirements 组合为最终结果。

mod hooks;
mod layer;
mod permissions;
mod rules;
mod stack;

pub use layer::RequirementsLayerEntry;
pub use stack::compose_requirements;
