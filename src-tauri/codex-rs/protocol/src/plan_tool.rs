//! 计划工具（plan tool）相关类型。
//!
//! 定义 `update_plan` 工具的参数类型，对应 codex-vscode/todo-mcp 中的实现。
//! 这些类型用于在协议层传递 plan 步骤及其状态。

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

// Types for the TODO tool arguments matching codex-vscode/todo-mcp/src/main.rs
// 与 codex-vscode/todo-mcp/src/main.rs 对应的 TODO 工具参数类型。
/// 计划步骤状态。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    /// 待处理。
    Pending,
    /// 进行中。
    InProgress,
    /// 已完成。
    Completed,
}

/// 单个计划步骤条目。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PlanItemArg {
    /// 步骤描述文本。
    pub step: String,
    /// 步骤状态。
    pub status: StepStatus,
}

/// `update_plan` 工具的参数。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct UpdatePlanArgs {
    /// Arguments for the `update_plan` todo/checklist tool (not plan mode).
    ///
    /// `update_plan`（todo / checklist 工具，非 plan mode）的可选说明文本。
    #[serde(default)]
    pub explanation: Option<String>,
    /// 计划步骤列表。
    pub plan: Vec<PlanItemArg>,
}
