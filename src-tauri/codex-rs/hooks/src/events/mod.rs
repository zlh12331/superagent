//! Hook 事件模块集合。
//!
//! 每个子模块对应一类钩子事件，提供请求/结果类型以及 preview/run 函数。
//! [`common`] 提供跨事件复用的辅助函数与子代理上下文类型。

pub(crate) mod common;
pub mod compact;
pub mod permission_request;
pub mod post_tool_use;
pub mod pre_tool_use;
pub mod session_start;
pub mod stop;
pub mod user_prompt_submit;
