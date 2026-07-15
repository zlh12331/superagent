//! Skills extension 配置模块。
//!
//! 该模块定义 host 提供给 skills extension 的配置结构。

/// Host 提供给 skills extension 的配置。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillsExtensionConfig {
    /// 是否将 available-skills catalog 包含到模型上下文中。
    pub include_instructions: bool,
    /// 是否允许发现 bundled skills。
    pub bundled_skills_enabled: bool,
    /// 是否允许发现 orchestrator 拥有的 skills。
    pub orchestrator_skills_enabled: bool,
}
