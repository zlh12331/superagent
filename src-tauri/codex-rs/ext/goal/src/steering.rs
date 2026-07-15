//! Goal steering prompt 渲染模块。
//!
//! 该模块负责将 goal 状态渲染为 steering prompt，注入到活跃 turn 中，
//! 引导模型按 goal 约束推进工作。
//!
//! ## Steering 类型
//!
//! - **continuation**：idle continuation 启动时注入，告知模型当前 goal 与剩余预算
//! - **budget_limit**：goal 进入 BudgetLimited 状态时注入，提示预算耗尽
//! - **objective_updated**：外部修改 objective 时注入，告知模型新 objective

use codex_core::context::ContextualUserFragment;
use codex_core::context::InternalContextSource;
use codex_core::context::InternalModelContextFragment;
use codex_protocol::models::ResponseItem;
use codex_protocol::protocol::ThreadGoal;
use codex_utils_template::Template;
use std::sync::LazyLock;

/// continuation steering prompt 模板（goals/continuation.md）。
static CONTINUATION_PROMPT_TEMPLATE: LazyLock<Template> = LazyLock::new(|| {
    parse_embedded_template(
        include_str!("../templates/goals/continuation.md"),
        "goals/continuation.md",
    )
});

/// budget_limit steering prompt 模板（goals/budget_limit.md）。
static BUDGET_LIMIT_PROMPT_TEMPLATE: LazyLock<Template> = LazyLock::new(|| {
    parse_embedded_template(
        include_str!("../templates/goals/budget_limit.md"),
        "goals/budget_limit.md",
    )
});

/// objective_updated steering prompt 模板（goals/objective_updated.md）。
static OBJECTIVE_UPDATED_PROMPT_TEMPLATE: LazyLock<Template> = LazyLock::new(|| {
    parse_embedded_template(
        include_str!("../templates/goals/objective_updated.md"),
        "goals/objective_updated.md",
    )
});

/// 解析内嵌的模板文件，失败时 panic（编译期已固定，不应失败）。
fn parse_embedded_template(source: &'static str, template_name: &str) -> Template {
    match Template::parse(source) {
        Ok(template) => template,
        Err(err) => panic!("embedded template {template_name} is invalid: {err}"),
    }
}

/// 构造 BudgetLimited 状态的 steering item。
pub(crate) fn budget_limit_steering_item(goal: &ThreadGoal) -> ResponseItem {
    goal_context_input_item(budget_limit_prompt(goal))
}

/// 构造 objective 更新后的 steering item。
pub(crate) fn objective_updated_steering_item(goal: &ThreadGoal) -> ResponseItem {
    goal_context_input_item(objective_updated_prompt(goal))
}

/// 构造 idle continuation 的 steering item。
pub(crate) fn continuation_steering_item(goal: &ThreadGoal) -> ResponseItem {
    goal_context_input_item(continuation_prompt(goal))
}

/// 将 prompt 字符串包装为 goal context input ResponseItem。
fn goal_context_input_item(prompt: String) -> ResponseItem {
    ContextualUserFragment::into(InternalModelContextFragment::new(
        InternalContextSource::from_static("goal"),
        prompt,
    ))
}

/// 渲染 continuation steering prompt。
///
/// 模板变量：objective、tokens_used、token_budget、remaining_tokens。
fn continuation_prompt(goal: &ThreadGoal) -> String {
    let objective = escape_xml_text(&goal.objective);
    let tokens_used = goal.tokens_used.to_string();
    let token_budget = goal
        .token_budget
        .map(|budget| budget.to_string())
        .unwrap_or_else(|| "none".to_string());
    let remaining_tokens = goal
        .token_budget
        .map(|budget| (budget - goal.tokens_used).max(0).to_string())
        .unwrap_or_else(|| "unbounded".to_string());

    CONTINUATION_PROMPT_TEMPLATE
        .render([
            ("objective", objective.as_str()),
            ("tokens_used", tokens_used.as_str()),
            ("token_budget", token_budget.as_str()),
            ("remaining_tokens", remaining_tokens.as_str()),
        ])
        .unwrap_or_else(|err| {
            panic!("embedded goals/continuation.md template failed to render: {err}")
        })
}

/// 渲染 budget_limit steering prompt。
///
/// 模板变量：objective、time_used_seconds、tokens_used、token_budget。
fn budget_limit_prompt(goal: &ThreadGoal) -> String {
    let objective = escape_xml_text(&goal.objective);
    let time_used_seconds = goal.time_used_seconds.to_string();
    let tokens_used = goal.tokens_used.to_string();
    let token_budget = goal
        .token_budget
        .map(|budget| budget.to_string())
        .unwrap_or_else(|| "none".to_string());

    BUDGET_LIMIT_PROMPT_TEMPLATE
        .render([
            ("objective", objective.as_str()),
            ("time_used_seconds", time_used_seconds.as_str()),
            ("tokens_used", tokens_used.as_str()),
            ("token_budget", token_budget.as_str()),
        ])
        .unwrap_or_else(|err| {
            panic!("embedded goals/budget_limit.md template failed to render: {err}")
        })
}

/// 渲染 objective_updated steering prompt。
///
/// 模板变量：objective、tokens_used、token_budget、remaining_tokens。
fn objective_updated_prompt(goal: &ThreadGoal) -> String {
    let objective = escape_xml_text(&goal.objective);
    let tokens_used = goal.tokens_used.to_string();
    let (token_budget, remaining_tokens) = match goal.token_budget {
        Some(token_budget) => (
            token_budget.to_string(),
            (token_budget - goal.tokens_used).max(0).to_string(),
        ),
        None => ("none".to_string(), "unknown".to_string()),
    };

    OBJECTIVE_UPDATED_PROMPT_TEMPLATE
        .render([
            ("objective", objective.as_str()),
            ("tokens_used", tokens_used.as_str()),
            ("token_budget", token_budget.as_str()),
            ("remaining_tokens", remaining_tokens.as_str()),
        ])
        .unwrap_or_else(|err| {
            panic!("embedded goals/objective_updated.md template failed to render: {err}")
        })
}

/// 转义 XML 文本内容（&、<、>）。
fn escape_xml_text(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
