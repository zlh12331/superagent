//! Codex prompt 模板与指令文本集合。
//!
//! 该 crate 集中维护了 Codex 各场景下使用的 prompt 片段、系统指令与渲染函数，
//! 包括 apply-patch 工具说明、会话压缩（compact）prompt、目标（goals）续写
//! prompt、权限指令、实时（realtime）后端 prompt、审查（review）流程 prompt 等。
//!
//! 核心导出：[`APPLY_PATCH_TOOL_INSTRUCTIONS`]、[`SUMMARIZATION_PROMPT`]、
//! [`PermissionsInstructions`]、[`REVIEW_PROMPT`]。

mod apply_patch;
mod compact;
mod goals;
mod permissions_instructions;
mod realtime;
mod review_exit;
mod review_request;

/// apply-patch 工具的使用说明文本，注入到模型工具定义中。
pub use apply_patch::APPLY_PATCH_TOOL_INSTRUCTIONS;
/// 会话压缩（compact）阶段所用的摘要 prompt。
pub use compact::SUMMARIZATION_PROMPT;
/// 摘要内容的前缀文本。
pub use compact::SUMMARY_PREFIX;
/// 预算耗尽时提示模型的 prompt 片段。
pub use goals::budget_limit_prompt;
/// 目标续写 prompt：引导模型继续完成未完成的目标。
pub use goals::continuation_prompt;
/// 目标更新时提示模型的 prompt 片段。
pub use goals::objective_updated_prompt;
/// 权限指令封装类型，描述向模型传达的权限边界。
pub use permissions_instructions::PermissionsInstructions;
/// 实时（realtime）后端系统 prompt。
pub use realtime::BACKEND_PROMPT;
/// 实时会话结束时的指令文本。
pub use realtime::END_INSTRUCTIONS;
/// 实时会话开始时的指令文本。
pub use realtime::START_INSTRUCTIONS;
/// 渲染审查退出（被中断）时的提示文本。
pub use review_exit::render_review_exit_interrupted;
/// 渲染审查退出（成功完成）时的提示文本。
pub use review_exit::render_review_exit_success;
/// 审查流程的 prompt 模板。
pub use review_request::REVIEW_PROMPT;
/// 已解析的审查请求，包含渲染 prompt 所需的全部上下文。
pub use review_request::ResolvedReviewRequest;
/// 解析审查请求并生成 `ResolvedReviewRequest`。
pub use review_request::resolve_review_request;
/// 渲染审查 prompt 文本。
pub use review_request::review_prompt;
/// 面向用户的审查提示文案。
pub use review_request::user_facing_hint;
