//! Web search 扩展 crate 入口模块。
//!
//! 该 crate 实现了独立的 web 搜索功能，作为 codex 扩展系统集成到会话中。
//! 通过 Responses API 的 web 搜索工具，模型可以在回答用户问题时
//! 实时搜索互联网获取最新信息。
//!
//! 子模块：
//! - `extension`：扩展注册和 contributor 实现
//! - `history`：构建搜索请求的对话历史
//! - `output`：搜索结果输出封装
//! - `schema`：搜索命令的 JSON Schema 生成
//! - `tool`：web 搜索工具实现

// 子模块声明
mod extension;
mod history;
mod output;
mod schema;
mod tool;

// 对外公开 install 函数
pub use extension::install;
