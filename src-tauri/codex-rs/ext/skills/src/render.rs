//! Prompt 渲染模块。
//!
//! 该模块负责将 skill 目录条目渲染为 prompt fragment，并对内容进行截断
//! 以控制 prompt 大小。包含以下功能：
//! - 生成 available skills 列表的 prompt fragment
//! - 截断 skill 描述到指定字符数
//! - 截断主 prompt 内容到指定字节数
//! - 截断 UTF-8 字符串到指定字节数（保证字符边界安全）
//!
//! 截断策略：
//! - available skills 列表限制为 `MAX_AVAILABLE_SKILLS_BYTES` 字节
//! - 主 prompt 内容限制为 `MAX_MAIN_PROMPT_BYTES` 字节
//! - 目录描述限制为 `MAX_CATALOG_SKILL_DESCRIPTION_CHARS` 字符

use std::borrow::Cow;

use codex_utils_string::take_bytes_at_char_boundary;

use crate::catalog::SkillCatalog;
use crate::catalog::SkillCatalogEntry;
use crate::catalog::SkillSourceKind;
use crate::fragments::AvailableSkillsInstructions;

/// available skills 列表的最大字节数
const MAX_AVAILABLE_SKILLS_BYTES: usize = 8_000;
/// 主 prompt 内容的最大字节数
const MAX_MAIN_PROMPT_BYTES: usize = 8_000;
/// 目录中 skill 描述的最大字符数
const MAX_CATALOG_SKILL_DESCRIPTION_CHARS: usize = 1_024;
/// 截断描述时添加的后缀
const TRUNCATED_SKILL_DESCRIPTION_SUFFIX: &str = "...";
/// skill 名称的最大字节数（供 fragment 渲染使用）
pub(crate) const MAX_SKILL_NAME_BYTES: usize = 256;
/// skill 路径的最大字节数（供 fragment 渲染使用）
pub(crate) const MAX_SKILL_PATH_BYTES: usize = 1_024;

/// 生成 available skills 列表的 prompt fragment。
///
/// # 参数
/// - `catalog`：skill 目录
/// - `include_skills_usage_instructions`：是否包含使用说明
///
/// # 返回
/// 返回 `Some(fragment)` 当存在至少一个可见的 skill 条目，否则返回 `None`。
///
/// # 流程
/// 1. 遍历目录中启用且 prompt 可见的条目
/// 2. 为每个条目渲染一行，优先使用 short_description
/// 3. 累计字节数，超出限制的条目计入 omitted 计数
/// 4. 若有 omitted 条目，在末尾追加提示行
#[tracing::instrument(
    level = "trace",
    skip_all,
    fields(catalog_entry_count = catalog.entries.len())
)]
pub(crate) fn available_skills_fragment(
    catalog: &SkillCatalog,
    include_skills_usage_instructions: bool,
) -> Option<AvailableSkillsInstructions> {
    let mut total_bytes = 0usize;
    let mut omitted = 0usize;
    let mut skill_lines = Vec::new();

    for entry in catalog
        .entries
        .iter()
        .filter(|entry| entry.enabled && entry.prompt_visible)
    {
        // 优先使用 short_description，回退到 description
        let description = entry
            .short_description
            .as_deref()
            .unwrap_or(entry.description.as_str());
        let description = truncate_catalog_skill_description(description);
        let line = render_skill_line(entry, description.as_ref());
        let next_bytes = total_bytes.saturating_add(line.len());
        if next_bytes > MAX_AVAILABLE_SKILLS_BYTES {
            omitted = omitted.saturating_add(1);
            continue;
        }
        total_bytes = next_bytes;
        skill_lines.push(line);
    }

    if skill_lines.is_empty() {
        return None;
    }
    if omitted > 0 {
        let skill_word = if omitted == 1 { "skill" } else { "skills" };
        skill_lines.push(format!(
            "- {omitted} additional {skill_word} omitted from this bounded skills list."
        ));
    }

    Some(AvailableSkillsInstructions::from_skill_lines(
        skill_lines,
        include_skills_usage_instructions,
    ))
}

/// 截断 skill 描述到最大字符数，超出时添加省略号后缀。
///
/// 若描述长度未超过限制，直接返回借用引用；否则返回截断后的Owned 字符串。
pub(crate) fn truncate_catalog_skill_description(description: &str) -> Cow<'_, str> {
    if description
        .char_indices()
        .nth(MAX_CATALOG_SKILL_DESCRIPTION_CHARS)
        .is_none()
    {
        return Cow::Borrowed(description);
    }

    // 预留后缀的空间，截取前缀部分
    let prefix_chars = MAX_CATALOG_SKILL_DESCRIPTION_CHARS
        .saturating_sub(TRUNCATED_SKILL_DESCRIPTION_SUFFIX.chars().count());
    let prefix_end = description
        .char_indices()
        .nth(prefix_chars)
        .map_or(description.len(), |(index, _)| index);
    let mut truncated = description[..prefix_end].to_string();
    truncated.push_str(TRUNCATED_SKILL_DESCRIPTION_SUFFIX);
    Cow::Owned(truncated)
}

/// 渲染单个 skill 条目为列表行。
///
/// 输出格式：`- {name}: {description} ({locator_kind}: {path})`，
/// 若描述为空则省略描述部分。
fn render_skill_line(entry: &SkillCatalogEntry, description: &str) -> String {
    let locator_kind = match &entry.authority.kind {
        SkillSourceKind::Host => "file",
        SkillSourceKind::Executor => "environment resource",
        SkillSourceKind::Orchestrator => "orchestrator resource",
        SkillSourceKind::Custom(_) => "custom resource",
    };
    let name = entry.name.as_str();
    let path = entry.rendered_path();
    if description.is_empty() {
        format!("- {name}: ({locator_kind}: {path})")
    } else {
        format!("- {name}: {description} ({locator_kind}: {path})")
    }
}

/// 截断主 prompt 内容到最大字节数。
///
/// # 返回
/// 返回元组 `(截断后的内容, 是否发生了截断)`。
pub(crate) fn truncate_main_prompt_contents(contents: &str) -> (String, bool) {
    truncate_utf8_to_bytes(contents, MAX_MAIN_PROMPT_BYTES)
}

/// 将 UTF-8 字符串截断到不超过指定字节数，保证在字符边界处截断。
///
/// # 参数
/// - `contents`：待截断的字符串
/// - `max_bytes`：最大字节数
///
/// # 返回
/// 返回元组 `(截断后的内容, 是否发生了截断)`。
pub(crate) fn truncate_utf8_to_bytes(contents: &str, max_bytes: usize) -> (String, bool) {
    let truncated = take_bytes_at_char_boundary(contents, max_bytes);
    (truncated.to_string(), truncated.len() < contents.len())
}
