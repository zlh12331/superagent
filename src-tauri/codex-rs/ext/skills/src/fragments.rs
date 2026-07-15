//! Skills prompt fragment 模块。
//!
//! 该模块定义注入到模型上下文的两种 contextual user fragment：
//!
//! - [`AvailableSkillsInstructions`]：available skills 列表（developer 角色）
//! - [`SkillInstructions`]：单个 skill 的 main prompt 内容（user 角色）

use codex_core_skills::SKILLS_HOW_TO_USE_WITH_ABSOLUTE_PATHS;
use codex_core_skills::render_available_skills_body;
use codex_extension_api::ContextualUserFragment;
use codex_protocol::protocol::SKILLS_INSTRUCTIONS_CLOSE_TAG;
use codex_protocol::protocol::SKILLS_INSTRUCTIONS_OPEN_TAG;

/// Available skills 列表 fragment，注入到 developer 角色上下文。
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AvailableSkillsInstructions {
    /// skill 行列表
    skill_lines: Vec<String>,
}

impl AvailableSkillsInstructions {
    /// 从 skill 行列表构造 fragment。
    ///
    /// # 参数
    /// - `skill_lines`：skill 描述行列表
    /// - `include_skills_usage_instructions`：是否追加 skills 使用说明
    pub(crate) fn from_skill_lines(
        mut skill_lines: Vec<String>,
        include_skills_usage_instructions: bool,
    ) -> Self {
        if include_skills_usage_instructions {
            skill_lines.push("### How to use skills".to_string());
            skill_lines.push(SKILLS_HOW_TO_USE_WITH_ABSOLUTE_PATHS.to_string());
        }
        Self { skill_lines }
    }
}

impl ContextualUserFragment for AvailableSkillsInstructions {
    fn role(&self) -> &'static str {
        "developer"
    }

    fn markers(&self) -> (&'static str, &'static str) {
        Self::type_markers()
    }

    fn type_markers() -> (&'static str, &'static str) {
        (SKILLS_INSTRUCTIONS_OPEN_TAG, SKILLS_INSTRUCTIONS_CLOSE_TAG)
    }

    fn body(&self) -> String {
        render_available_skills_body(&[], &self.skill_lines)
    }
}

/// 单个 skill 的 main prompt 内容 fragment，注入到 user 角色上下文。
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SkillInstructions {
    /// skill 名称
    pub(crate) name: String,
    /// skill 路径
    pub(crate) path: String,
    /// skill main prompt 内容
    pub(crate) contents: String,
}

impl ContextualUserFragment for SkillInstructions {
    fn role(&self) -> &'static str {
        "user"
    }

    fn markers(&self) -> (&'static str, &'static str) {
        Self::type_markers()
    }

    fn type_markers() -> (&'static str, &'static str) {
        ("<skill>", "</skill>")
    }

    fn body(&self) -> String {
        let name = &self.name;
        let path = &self.path;
        let contents = &self.contents;
        format!("\n<name>{name}</name>\n<path>{path}</path>\n{contents}\n")
    }
}
