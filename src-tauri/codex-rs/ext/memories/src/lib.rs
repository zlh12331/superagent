//! Memories extension crate。
//!
//! 该 crate 提供 Codex 的 memories（记忆）读写工具集，包括：
//!
//! - **add_ad_hoc_note**：创建临时记忆笔记
//! - **list**：列出 memories store 下的文件和目录
//! - **read**：按路径读取 memory 文件
//! - **search**：在 memory 文件中搜索子串匹配
//!
//! ## 架构
//!
//! - [`backend`](backend) 模块定义存储接口 trait `MemoriesBackend`
//! - [`local`](local) 模块提供基于文件系统的本地实现
//! - [`tools`](tools) 模块将 backend 操作封装为 Responses API 工具
//! - [`extension`](extension) 模块将所有能力注册为 extension contributor
//! - [`prompts`](prompts) 模块构建注入 developer instructions 的 prompt
//! - [`metrics`](metrics) 模块记录工具调用遥测指标
//! - [`schema`](schema) 模块生成工具的 JSON Schema

// 内部子模块声明
mod backend;
mod extension;
mod local;
mod metrics;
mod prompts;
mod schema;
mod tools;

// 对外公开的 install 入口
pub use extension::install;

/// list 工具的默认最大结果数。
pub(crate) const DEFAULT_LIST_MAX_RESULTS: usize = 2_000;
/// list 工具的最大结果数上限。
pub(crate) const MAX_LIST_RESULTS: usize = 2_000;
/// search 工具的默认最大结果数。
pub(crate) const DEFAULT_SEARCH_MAX_RESULTS: usize = 200;
/// search 工具的最大结果数上限。
pub(crate) const MAX_SEARCH_RESULTS: usize = 200;
/// read 工具的默认最大 token 数。
pub(crate) const DEFAULT_READ_MAX_TOKENS: usize = 20_000;
/// memory tool developer instructions 中 memory_summary 的 token 截断上限。
pub(crate) const MEMORY_TOOL_DEVELOPER_INSTRUCTIONS_SUMMARY_TOKEN_LIMIT: usize = 2_500;

/// memories 工具的命名空间标识符。
pub(crate) const MEMORY_TOOLS_NAMESPACE: &str = "memories";
/// add_ad_hoc_note 工具名称。
pub(crate) const ADD_AD_HOC_NOTE_TOOL_NAME: &str = "add_ad_hoc_note";
/// list 工具名称。
pub(crate) const LIST_TOOL_NAME: &str = "list";
/// read 工具名称。
pub(crate) const READ_TOOL_NAME: &str = "read";
/// search 工具名称。
pub(crate) const SEARCH_TOOL_NAME: &str = "search";

#[cfg(test)]
mod tests;
