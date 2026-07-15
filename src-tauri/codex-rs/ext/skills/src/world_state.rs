//! World state section 贡献模块。
//!
//! 该模块负责生成 executor skills 的 world state section，用于在对话中
//! 展示当前可用的执行环境 skills 列表。
//!
//! World state section 的更新策略：
//! - 当 body 和 includeInstructions 与上一轮相同时，不重复输出（返回 `None`）
//! - 当无 skills 可用且 include_instructions 为 true 时，输出"无可用 skills"提示
//! - 当 include_instructions 为 false 时，输出"不自动列出"提示
//! - 使用 legacy matcher 和 retained fragment matcher 确保旧版本兼容性

use codex_extension_api::ContextualUserFragment;
use codex_extension_api::PreviousWorldStateSection;
use codex_extension_api::RenderedWorldStateFragment;
use codex_extension_api::WorldStateSectionContribution;
use codex_protocol::protocol::SKILLS_INSTRUCTIONS_CLOSE_TAG;
use codex_protocol::protocol::SKILLS_INSTRUCTIONS_OPEN_TAG;
use serde_json::json;

use crate::catalog::SkillCatalog;
use crate::render::available_skills_fragment;

/// World state section 的唯一标识
pub(crate) const SKILLS_WORLD_STATE_ID: &str = "skills";
/// 无 executor skills 时的提示文本
const NO_EXECUTOR_SKILLS_BODY: &str =
    "\n## Skills update\nNo selected-environment skills are currently available.\n";
/// 不自动列出 executor skills 时的提示文本
const HIDDEN_EXECUTOR_SKILLS_BODY: &str = "\n## Skills update\nSelected-environment skills are not listed automatically. Explicit skill mentions can still be resolved when available.\n";

/// 生成 executor skills 的 world state section 贡献。
///
/// # 参数
/// - `catalog`：executor skills 目录
/// - `include_instructions`：是否包含 instructions 内容
/// - `include_skills_usage_instructions`：是否包含使用说明
///
/// # 返回
/// 返回一个 `WorldStateSectionContribution`，其渲染回调会根据上一轮的状态
/// 决定是否输出内容（避免重复）。
pub(crate) fn executor_skills_world_state_section(
    catalog: &SkillCatalog,
    include_instructions: bool,
    include_skills_usage_instructions: bool,
) -> WorldStateSectionContribution {
    // 生成当前轮的 body（若 include_instructions 为 true）
    let body = if include_instructions {
        available_skills_fragment(catalog, include_skills_usage_instructions)
            .map(|fragment| fragment.body())
    } else {
        None
    };
    // 快照用于比较和 retained matcher
    let snapshot = json!({
        "body": body,
        "includeInstructions": include_instructions,
    });
    let retained_body = body.clone();

    let contribution =
        WorldStateSectionContribution::new(SKILLS_WORLD_STATE_ID, snapshot, move |previous| {
            let previous_is_absent = matches!(&previous, PreviousWorldStateSection::Absent);
            // 若与上一轮完全相同，不重复输出
            if let PreviousWorldStateSection::Known(previous) = &previous {
                let previous_body = previous.get("body").and_then(serde_json::Value::as_str);
                let previous_include_instructions = previous
                    .get("includeInstructions")
                    .and_then(serde_json::Value::as_bool);
                if previous_body == body.as_deref()
                    && previous_include_instructions == Some(include_instructions)
                {
                    return None;
                }
            }

            // 根据情况选择输出内容
            let body = match body.as_deref() {
                Some(body) => body,
                None if previous_is_absent => return None,
                None if !include_instructions => HIDDEN_EXECUTOR_SKILLS_BODY,
                None => NO_EXECUTOR_SKILLS_BODY,
            };
            Some(RenderedWorldStateFragment::new(
                "developer",
                (SKILLS_INSTRUCTIONS_OPEN_TAG, SKILLS_INSTRUCTIONS_CLOSE_TAG),
                body,
            ))
        })
        // 旧版本兼容匹配器：匹配以 skills instructions 标签开头的 developer 消息
        .with_legacy_matcher(|role, text| {
            role == "developer"
                && text.trim_start().starts_with(SKILLS_INSTRUCTIONS_OPEN_TAG)
                && text.trim_end().ends_with(SKILLS_INSTRUCTIONS_CLOSE_TAG)
        });
    // 若有 body 内容，添加 retained fragment 匹配器
    match retained_body {
        Some(body) => contribution.with_retained_fragment_matcher(move |role, text| {
            role == "developer" && text.contains(&body)
        }),
        None => contribution,
    }
}
