//! 插件（plugin）共享模型模块。
//!
//! 该 crate 定义了插件包的共享数据模型、源 provider、标识符与遥测摘要。
//! 核心能力包括：
//! - 插件加载结果（load outcome）与已加载插件（`LoadedPlugin`）模型；
//! - 插件清单（manifest）解析；
//! - 插件标识符（`PluginId`）校验；
//! - 插件源 provider 抽象与已解析插件（`ResolvedPlugin`）；
//! - 插件能力摘要（`PluginCapabilitySummary`）与遥测元数据；
//! - 应用连接器（app connector）声明与去重。
//!
//! 核心类型：[`PluginId`]、[`LoadedPlugin`]、[`ResolvedPlugin`]、
//! [`PluginCapabilitySummary`]、[`PluginTelemetryMetadata`]。

use std::collections::HashSet;

/// 将插件 skill 路径转换为 mention 语法字符串。
pub use codex_utils_plugins::mention_syntax;
/// 根据 skill 路径派生插件命名空间。
pub use codex_utils_plugins::plugin_namespace_for_skill_path;

mod load_outcome;
/// 插件清单（manifest）解析与数据模型模块。
pub mod manifest;
mod plugin_id;
mod provider;

use codex_config::HookEventsToml;
use codex_utils_absolute_path::AbsolutePathBuf;
/// 已生效的 skill 根路径集合。
pub use load_outcome::EffectiveSkillRoots;
/// 已加载的插件实例。
pub use load_outcome::LoadedPlugin;
/// 插件加载结果（成功或失败）。
pub use load_outcome::PluginLoadOutcome;
/// 生成对 prompt 安全的插件描述文本（剔除可能影响模型行为的危险内容）。
pub use load_outcome::prompt_safe_plugin_description;
/// 插件本地标识符类型。
pub use plugin_id::PluginId;
/// 插件标识符解析/校验错误。
pub use plugin_id::PluginIdError;
/// 校验插件命名段（segment）是否合法。
pub use plugin_id::validate_plugin_segment;
/// 插件源 provider 抽象，描述如何定位与获取插件资源。
pub use provider::PluginProvider;
/// 插件资源定位信息（如 URL、路径等）。
pub use provider::PluginResourceLocator;
/// 已解析（定位完成）的插件实例。
pub use provider::ResolvedPlugin;
/// 插件解析错误。
pub use provider::ResolvedPluginError;
/// 已解析的插件来源位置。
pub use provider::ResolvedPluginLocation;

/// 应用连接器（app connector）标识符。
///
/// 每个 app connector 拥有唯一的字符串 ID，用于在插件能力中声明该插件
/// 可对接的外部应用。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct AppConnectorId(pub String);

/// 应用声明：描述插件所声明的单个外部应用对接信息。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppDeclaration {
    /// 应用展示名称。
    pub name: String,
    /// 对应的 app connector 标识符。
    pub connector_id: AppConnectorId,
    /// 可选的应用分类标签。
    pub category: Option<String>,
}

/// 从应用声明集合中提取去重后的 app connector ID 列表。
///
/// 保持首次出现的顺序，重复的 `connector_id` 仅保留第一次。
pub fn app_connector_ids_from_declarations<'a>(
    app_declarations: impl IntoIterator<Item = &'a AppDeclaration>,
) -> Vec<AppConnectorId> {
    let mut connector_ids = Vec::new();
    let mut seen_connector_ids = HashSet::new();
    for app in app_declarations {
        if seen_connector_ids.insert(&app.connector_id) {
            connector_ids.push(app.connector_id.clone());
        }
    }
    connector_ids
}

/// 插件能力摘要：描述插件对外暴露的能力集合。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PluginCapabilitySummary {
    /// 插件在配置中的名称。
    pub config_name: String,
    /// 插件的展示名称。
    pub display_name: String,
    /// 可选的插件描述文本。
    pub description: Option<String>,
    /// 该插件是否提供 skills。
    pub has_skills: bool,
    /// 该插件声明的 MCP server 名称列表。
    pub mcp_server_names: Vec<String>,
    /// 该插件声明的 app connector ID 列表。
    pub app_connector_ids: Vec<AppConnectorId>,
}

/// 插件 hook 来源信息：描述单个 hook 的源文件位置与所属插件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginHookSource {
    /// 所属插件标识符。
    pub plugin_id: PluginId,
    /// 插件根目录。
    pub plugin_root: AbsolutePathBuf,
    /// 插件数据根目录（用于写入派生数据）。
    pub plugin_data_root: AbsolutePathBuf,
    /// hook 源文件的绝对路径。
    pub source_path: AbsolutePathBuf,
    /// hook 源文件相对于插件根目录的相对路径。
    pub source_relative_path: String,
    /// 该源文件声明的 hook 事件集合。
    pub hooks: HookEventsToml,
}

/// 插件遥测元数据：用于上报插件相关遥测事件时携带的标识与能力信息。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginTelemetryMetadata {
    /// 本地插件标识符，由 Codex 配置与插件缓存使用（已解析时存在）。
    pub plugin_id: Option<PluginId>,
    /// 远程插件的后端标识符（可选）。
    pub remote_plugin_id: Option<String>,
    /// 插件能力摘要（已解析时存在）。
    pub capability_summary: Option<PluginCapabilitySummary>,
}
