//! Memories prompt 构建模块。
//!
//! 该模块负责构建注入 developer instructions 的 memory 读取路径 prompt。
//! prompt 内容来自 `templates/memories/read_path.md` 模板，包含
//! memories 根路径和 `memory_summary.md` 的摘要内容。
//!
//! ## 截断策略
//!
//! `memory_summary.md` 的内容会按
//! [`MEMORY_TOOL_DEVELOPER_INSTRUCTIONS_SUMMARY_TOKEN_LIMIT`](crate::MEMORY_TOOL_DEVELOPER_INSTRUCTIONS_SUMMARY_TOKEN_LIMIT)
//! 进行 token 截断，以避免 prompt 过长。

use crate::MEMORY_TOOL_DEVELOPER_INSTRUCTIONS_SUMMARY_TOKEN_LIMIT;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_output_truncation::TruncationPolicy;
use codex_utils_output_truncation::truncate_text;
use codex_utils_template::Template;
use std::sync::LazyLock;
use tokio::fs;

/// memory 读取路径 developer instructions 模板。
///
/// 从 `templates/memories/read_path.md` 内嵌文件解析而来。
static MEMORY_TOOL_DEVELOPER_INSTRUCTIONS_TEMPLATE: LazyLock<Template> = LazyLock::new(|| {
    parse_embedded_template(
        include_str!("../templates/memories/read_path.md"),
        "memories/read_path.md",
    )
});

/// 解析内嵌模板，解析失败时 panic（编译期嵌入的模板不应出错）。
fn parse_embedded_template(source: &'static str, template_name: &str) -> Template {
    match Template::parse(source) {
        Ok(template) => template,
        Err(err) => panic!("embedded template {template_name} is invalid: {err}"),
    }
}

/// 构建 memory 读取路径 prompt，注入到 developer instructions 中。
///
/// # 参数
/// - `codex_home`：Codex 主目录路径
///
/// # 流程
/// 1. 读取 `<codex_home>/memories/memory_summary.md` 文件
/// 2. 按 token 上限截断内容
/// 3. 用模板渲染 prompt（包含 `base_path` 和 `memory_summary` 变量）
///
/// # 返回
/// - `Some(String)`：成功渲染的 prompt 文本
/// - `None`：文件不存在或内容为空
pub(crate) async fn build_memory_tool_developer_instructions(
    codex_home: &AbsolutePathBuf,
) -> Option<String> {
    let base_path = codex_home.join("memories");
    let memory_summary_path = base_path.join("memory_summary.md");
    let memory_summary = fs::read_to_string(&memory_summary_path)
        .await
        .ok()?
        .trim()
        .to_string();
    let memory_summary = truncate_text(
        &memory_summary,
        TruncationPolicy::Tokens(MEMORY_TOOL_DEVELOPER_INSTRUCTIONS_SUMMARY_TOKEN_LIMIT),
    );
    if memory_summary.is_empty() {
        return None;
    }
    let base_path = base_path.display().to_string();
    MEMORY_TOOL_DEVELOPER_INSTRUCTIONS_TEMPLATE
        .render([
            ("base_path", base_path.as_str()),
            ("memory_summary", memory_summary.as_str()),
        ])
        .ok()
}

#[cfg(test)]
#[path = "prompts_tests.rs"]
mod tests;
