//! Skill（技能）相关的配置类型，跨 crate 共享。
//!
//! 本模块定义 codex-rs 中 Skill 系统的配置 schema，包括：
//! - 单个 Skill 的选择器与启用状态（`SkillConfig`）
//! - Skill 子系统的聚合配置（`SkillsConfig`）
//! - 内置 Skill 包的启用开关（`BundledSkillsConfig`）
//!
//! 这些类型由 `config_toml` 在解析 `[skills]` 表时使用，并被运行时
//! Skill 加载器消费以决定哪些 Skill 可用、是否注入指令块。

use codex_utils_absolute_path::AbsolutePathBuf;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;

/// `BundledSkillsConfig.enabled` 字段的默认值函数：默认启用。
const fn default_enabled() -> bool {
    true
}

/// 单个 Skill 的配置项，用于按路径或名称选择并控制启用状态。
///
/// 选择器（`path` 与 `name`）至少应指定其一；同时指定时两者均需匹配。
/// `enabled` 控制该 Skill 是否被加载到运行时。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct SkillConfig {
    /// 基于路径的选择器（绝对路径或相对项目根的路径）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<AbsolutePathBuf>,
    /// 基于名称的选择器，匹配 Skill 的声明名称。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// 是否启用该 Skill。`false` 时该 Skill 不会被加载。
    pub enabled: bool,
}

/// Skill 子系统的聚合配置，对应 `config.toml` 中的 `[skills]` 表。
///
/// 包含内置 Skill 包开关、指令块注入开关以及用户自定义 Skill 列表。
/// 默认情况下内置 Skill 包启用、指令块注入不显式设置（由上层决定）。
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct SkillsConfig {
    /// 内置 Skill 包的启用配置。`None` 表示使用默认行为（启用）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundled: Option<BundledSkillsConfig>,

    /// 是否在 turn 中自动注入 skills 指令块。
    ///
    /// `None` 表示未显式配置，由上层默认策略决定；`Some(true)` 强制注入，
    /// `Some(false)` 强制关闭。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_instructions: Option<bool>,

    /// 用户自定义 Skill 配置列表。空列表时序列化时省略该字段。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub config: Vec<SkillConfig>,
}

/// 内置 Skill 包的启用配置，对应 `[skills.bundled]` 表。
///
/// 默认启用（`enabled = true`），确保开箱即用的 Skill 集合可用。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct BundledSkillsConfig {
    /// 是否启用内置 Skill 包。默认 `true`，调用 `default_enabled`。
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

impl Default for BundledSkillsConfig {
    fn default() -> Self {
        Self { enabled: true }
    }
}

impl TryFrom<toml::Value> for SkillsConfig {
    type Error = toml::de::Error;

    fn try_from(value: toml::Value) -> Result<Self, Self::Error> {
        SkillsConfig::deserialize(value)
    }
}
