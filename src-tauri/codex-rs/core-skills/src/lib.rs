//! Skills（技能）系统核心模块。
//!
//! 本 crate 实现 codex 的技能加载、解析、渲染与调用机制。技能是可复用的
//! 提示词模板，用户可通过 `@skill-name` 等方式在对话中显式引用，
//! 也可由系统根据上下文隐式注入。
//!
//! 主要能力：
//! - 从本地文件系统与远程市场加载技能定义
//! - 解析技能元数据与配置规则
//! - 将可用技能渲染为模型可读的文本
//! - 处理技能调用与隐式触发检测

// ========== 子模块声明 ==========

/// 技能配置规则模块，定义技能的配置约束与校验逻辑。
pub mod config_rules;
/// 技能注入模块，负责将技能内容注入到模型上下文中。
pub mod injection;
pub(crate) mod invocation_utils;
/// 技能加载器模块，从各来源加载技能定义。
pub mod loader;
mod mention_counts;
/// 技能数据模型模块，定义技能的元数据与错误类型。
pub mod model;
/// 远程技能模块，处理远程市场的技能加载与同步。
pub mod remote;
/// 技能渲染模块，将技能列表渲染为模型可读文本。
pub mod render;
mod root_loader;
/// 技能服务模块，提供技能加载与查询的统一入口。
pub mod service;
mod skill_instructions;
/// 系统技能模块，定义内置的系统级技能。
pub mod system;

// ========== 重导出 ==========

pub(crate) use invocation_utils::build_implicit_skill_path_indexes;
/// 检测命令文本中是否包含隐式技能调用。
pub use invocation_utils::detect_implicit_skill_invocation_for_command;
/// 构建技能名称的引用计数统计。
pub use mention_counts::build_skill_name_counts;
/// 宿主技能快照，包含当前会话可用的全部技能。
pub use model::HostSkillsSnapshot;
/// 技能加载/调用错误。
pub use model::SkillError;
/// 技能加载结果，表示成功或失败及其原因。
pub use model::SkillLoadOutcome;
/// 技能元数据，描述技能的名称、描述、参数等信息。
pub use model::SkillMetadata;
/// 技能策略，定义技能的启用/禁用与可见性规则。
pub use model::SkillPolicy;
/// 根据产品类型过滤技能加载结果。
pub use model::filter_skill_load_outcome_for_product;
/// 可用技能集合，用于渲染模型可读的技能列表。
pub use render::AvailableSkills;
/// 使用绝对路径调用技能的说明文本。
pub use render::SKILLS_HOW_TO_USE_WITH_ABSOLUTE_PATHS;
/// 使用别名调用技能的说明文本。
pub use render::SKILLS_HOW_TO_USE_WITH_ALIASES;
/// 使用绝对路径时技能列表的引导文本。
pub use render::SKILLS_INTRO_WITH_ABSOLUTE_PATHS;
/// 技能元数据预算，限制渲染到上下文中的元数据总量。
pub use render::SkillMetadataBudget;
/// 技能渲染报告，记录本次渲染的统计信息。
pub use render::SkillRenderReport;
/// 构建可用技能集合。
pub use render::build_available_skills;
/// 默认的技能元数据预算。
pub use render::default_skill_metadata_budget;
/// 渲染可用技能列表的正文文本。
pub use render::render_available_skills_body;
/// 插件技能快照，包含来自插件的技能。
pub use root_loader::PluginSkillSnapshots;
/// 技能加载输入，描述加载技能所需的参数。
pub use service::SkillsLoadInput;
/// 技能服务，提供技能加载与查询的统一 API。
pub use service::SkillsService;
/// 技能指令，包含技能的提示词内容。
pub use skill_instructions::SkillInstructions;
