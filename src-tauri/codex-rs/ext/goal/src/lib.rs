//! `/goal` 特性扩展 crate。
//!
//! 该 crate 实现了 codex 的 "goal"（目标）功能，允许用户为 thread（会话）
//! 设置持久化的目标，并对 token 与时间用量进行预算追踪与状态机管理。
//!
//! ## 核心模块
//!
//! - [`accounting`]：管理 goal 的计费状态机，包括 turn 级别与 idle 级别的
//!   token/time 增量计量。
//! - [`analytics`]：发射 goal 相关的遥测事件（创建、状态变更、清理等）。
//! - [`api`]：对外暴露的 goal service API，供外部（如 UI/CLI）查询与修改 goal。
//! - [`events`]：将 goal 变更包装为 codex protocol 事件并发出。
//! - [`extension`]：goal extension 主实现，注册多个 contributor trait。
//! - [`metrics`]：记录 goal 状态机相关的 OTel 指标。
//! - [`runtime`]：每 thread 一个的 runtime handle，承载计费与状态推进逻辑。
//! - [`spec`]：Responses API 工具定义（get/create/update goal）。
//! - [`steering`]：goal steering prompt 渲染（continuation/budget_limit/objective_updated）。
//! - [`tool`]：goal 工具执行器实现，处理来自模型的工具调用。

// 内部子模块声明
mod accounting;
mod analytics;
mod api;
mod events;
mod extension;
mod metrics;
mod runtime;
mod spec;
mod steering;
mod tool;

// 对外公开的类型 re-export
pub use api::GoalObjectiveUpdate;
pub use api::GoalService;
pub use api::GoalServiceError;
pub use api::GoalSetOutcome;
pub use api::GoalSetRequest;
pub use api::GoalTokenBudgetUpdate;
pub use extension::GoalExtension;
pub use extension::GoalExtensionConfig;
pub use extension::install_with_backend;
pub use runtime::GoalRuntimeHandle;
pub use runtime::PreviousGoalSnapshot;
pub use spec::CREATE_GOAL_TOOL_NAME;
pub use spec::GET_GOAL_TOOL_NAME;
pub use spec::UPDATE_GOAL_TOOL_NAME;
pub use tool::CreateGoalRequest;
