//! 配置 layer（层）栈的核心数据结构。
//!
//! 本模块定义 codex-rs 配置系统的运行时状态模型，包括：
//! - `ConfigLoadOptions`: 用户面向的加载选项（不属于配置文档本身）
//! - `LoaderOverrides`: 加载器覆盖项（主要用于测试）
//! - `ConfigLayerEntry`: 单个配置层的完整条目（含原始 TOML、版本、禁用原因等）
//! - `ConfigLayerStack`: 配置层栈，按优先级从低到高排列，支持合并、查询与编辑
//!
//! 架构位置：位于 `config` crate 的核心，被 `loader` 模块构造，
//! 被 `Config` 类型消费以生成最终运行时配置。requirements 约束
//! 与普通配置层分开存储，便于独立查询与 API 暴露。

use crate::config_requirements::ConfigRequirements;
use crate::config_requirements::ConfigRequirementsToml;

use super::fingerprint::record_origins;
use super::fingerprint::version_for_toml;
use super::key_aliases::normalized_with_key_aliases;
use super::merge::merge_toml_values;
use crate::CloudConfigBundleLoader;
use crate::ConfigLayer;
use crate::ConfigLayerMetadata;
use crate::ConfigLayerSource;
use crate::ProfileV2Name;
use codex_utils_absolute_path::AbsolutePathBuf;
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use toml::Value as TomlValue;

/// 用户面向的配置加载行为，这些选项不属于配置文档本身。
///
/// 包含加载器覆盖、严格模式开关和云配置 bundle 加载器。
/// 这些选项影响配置如何被加载，但不被序列化到 `config.toml`。
#[derive(Debug, Default, Clone)]
pub struct ConfigLoadOptions {
    /// 加载器覆盖项，主要用于测试注入自定义配置路径。
    pub loader_overrides: LoaderOverrides,
    /// 是否启用严格配置校验（拒绝未知字段）。
    pub strict_config: bool,
    /// 云配置 bundle 的加载器配置。
    pub cloud_config_bundle: CloudConfigBundleLoader,
}

impl From<LoaderOverrides> for ConfigLoadOptions {
    fn from(loader_overrides: LoaderOverrides) -> Self {
        Self {
            loader_overrides,
            strict_config: false,
            cloud_config_bundle: CloudConfigBundleLoader::default(),
        }
    }
}

/// 加载器覆盖项，覆盖受管配置输入（主要用于测试）。
///
/// 每个字段为 `None` 时使用默认路径；为 `Some` 时使用指定路径或行为。
/// macOS 专属字段通过 `#[cfg(target_os = "macos")]` 条件编译控制。
#[derive(Debug, Default, Clone)]
pub struct LoaderOverrides {
    /// 用户配置文件路径覆盖。
    pub user_config_path: Option<AbsolutePathBuf>,
    /// 用户配置 profile 名称覆盖。
    pub user_config_profile: Option<ProfileV2Name>,
    /// 受管配置文件路径覆盖（MDM/企业管理）。
    pub managed_config_path: Option<PathBuf>,
    /// 系统配置文件路径覆盖。
    pub system_config_path: Option<PathBuf>,
    /// 系统需求文件路径覆盖。
    pub system_requirements_path: Option<PathBuf>,
    /// 是否忽略受管 requirements。
    pub ignore_managed_requirements: bool,
    /// 是否忽略用户配置。
    pub ignore_user_config: bool,
    /// 是否忽略用户与项目级的 execpolicy `.rules` 文件。
    pub ignore_user_and_project_exec_policy_rules: bool,
    //TODO(gt): 为该字段添加 macos_ 前缀并移除 target_os 检查。
    /// macOS MDM preferences 的 base64 编码覆盖（仅 macOS）。
    #[cfg(target_os = "macos")]
    pub managed_preferences_base64: Option<String>,
    /// macOS 受管配置 requirements 的 base64 编码覆盖。
    pub macos_managed_config_requirements_base64: Option<String>,
}

impl LoaderOverrides {
    /// 返回忽略主机受管配置的覆盖项。
    ///
    /// 用于测试场景：仅加载仓库控制的配置 fixture，避免主机 MDM 或
    /// 系统配置干扰测试结果。所有受管路径指向临时目录下的空文件。
    pub fn without_managed_config_for_tests() -> Self {
        let base = std::env::temp_dir().join("codex-config-tests");
        Self {
            user_config_path: None,
            user_config_profile: None,
            managed_config_path: Some(base.join("managed_config.toml")),
            system_config_path: Some(base.join("config.toml")),
            system_requirements_path: Some(base.join("requirements.toml")),
            ignore_managed_requirements: false,
            ignore_user_config: false,
            ignore_user_and_project_exec_policy_rules: false,
            #[cfg(target_os = "macos")]
            managed_preferences_base64: Some(String::new()),
            macos_managed_config_requirements_base64: Some(String::new()),
        }
    }

    /// 返回禁用主机 MDM、从 `managed_config_path` 加载受管配置的覆盖项。
    /// 系统 requirements 从同目录下的 `requirements.toml` fixture 加载。
    ///
    /// 用于测试场景：提供显式的受管配置 fixture 进行测试。
    pub fn with_managed_config_path_for_tests(managed_config_path: PathBuf) -> Self {
        let system_requirements_path = managed_config_path.with_file_name("requirements.toml");
        Self {
            user_config_path: None,
            user_config_profile: None,
            managed_config_path: Some(managed_config_path),
            system_requirements_path: Some(system_requirements_path),
            ..Self::without_managed_config_for_tests()
        }
    }

    /// 返回用户配置文件路径，若未覆盖则解析 `$CODEX_HOME/config.toml`。
    ///
    /// # 参数
    /// - `codex_home`: codex 主目录，用于在未覆盖时解析默认路径
    ///
    /// # Errors
    /// 当默认路径无法解析为绝对路径时返回 `io::Error`。
    pub fn user_config_path(&self, codex_home: &Path) -> std::io::Result<AbsolutePathBuf> {
        match self.user_config_path.as_ref() {
            Some(path) => Ok(path.clone()),
            None => Ok(AbsolutePathBuf::resolve_path_against_base(
                crate::CONFIG_TOML_FILE,
                codex_home,
            )),
        }
    }
}

/// 配置层栈中的单个条目，包含来源、配置值、版本与可选的原始 TOML。
///
/// `raw_toml` 保留原始文本用于格式保留编辑（toml_edit），
/// `disabled_reason` 标记该层是否被禁用及原因。
#[derive(Debug, Clone, PartialEq)]
pub struct ConfigLayerEntry {
    /// 该层的来源标识（System/User/Project/MDM 等）。
    pub name: ConfigLayerSource,
    /// 已解析的 TOML 配置值。
    pub config: TomlValue,
    /// 该层的配置指纹版本（基于 canonical JSON 的 SHA-256）。
    pub version: String,
    /// 禁用原因。`Some` 表示该层被禁用，`None` 表示启用。
    pub disabled_reason: Option<String>,
    /// 原始 TOML 文本及其基目录，用于格式保留编辑。
    raw_toml: Option<RawTomlLayer>,
    /// Hook 配置文件夹覆盖（用于 Git worktree 场景）。
    hooks_config_folder_override: Option<AbsolutePathBuf>,
}

/// 原始 TOML 层的内部表示，保留文本与基目录。
#[derive(Debug, Clone, PartialEq)]
struct RawTomlLayer {
    /// 原始 TOML 文本内容。
    contents: String,
    /// 该 TOML 文件的基目录（用于解析相对路径）。
    base_dir: AbsolutePathBuf,
}

impl ConfigLayerEntry {
    /// 创建一个新的启用配置层条目，不保留原始 TOML。
    ///
    /// 版本由 `version_for_toml` 计算。
    pub fn new(name: ConfigLayerSource, config: TomlValue) -> Self {
        let version = version_for_toml(&config);
        Self {
            name,
            config,
            version,
            disabled_reason: None,
            raw_toml: None,
            hooks_config_folder_override: None,
        }
    }

    /// 创建一个新的启用配置层条目，同时保留原始 TOML 文本与基目录。
    ///
    /// 适用于需要格式保留编辑的场景（如用户配置层）。
    pub fn new_with_raw_toml(
        name: ConfigLayerSource,
        config: TomlValue,
        raw_toml: String,
        raw_toml_base_dir: AbsolutePathBuf,
    ) -> Self {
        let version = version_for_toml(&config);
        Self {
            name,
            config,
            version,
            disabled_reason: None,
            raw_toml: Some(RawTomlLayer {
                contents: raw_toml,
                base_dir: raw_toml_base_dir,
            }),
            hooks_config_folder_override: None,
        }
    }

    /// 创建一个被禁用的配置层条目，附带禁用原因。
    ///
    /// 禁用层保留在栈中但不参与合并，用于诊断与报告。
    pub fn new_disabled(
        name: ConfigLayerSource,
        config: TomlValue,
        disabled_reason: impl Into<String>,
    ) -> Self {
        let version = version_for_toml(&config);
        Self {
            name,
            config,
            version,
            disabled_reason: Some(disabled_reason.into()),
            raw_toml: None,
            hooks_config_folder_override: None,
        }
    }

    /// 返回该层是否被禁用。
    pub fn is_disabled(&self) -> bool {
        self.disabled_reason.is_some()
    }

    /// 返回原始 TOML 文本（若保留）。
    pub fn raw_toml(&self) -> Option<&str> {
        self.raw_toml
            .as_ref()
            .map(|raw_toml| raw_toml.contents.as_str())
    }

    /// 返回原始 TOML 的基目录（若保留）。
    pub fn raw_toml_base_dir(&self) -> Option<&AbsolutePathBuf> {
        self.raw_toml.as_ref().map(|raw_toml| &raw_toml.base_dir)
    }

    /// 设置 Hook 配置文件夹覆盖，返回新的条目（builder 模式）。
    pub(crate) fn with_hooks_config_folder_override(
        mut self,
        hooks_config_folder_override: Option<AbsolutePathBuf>,
    ) -> Self {
        self.hooks_config_folder_override = hooks_config_folder_override;
        self
    }

    /// 返回该层的元数据（来源名称与版本），用于 origins 追踪。
    pub fn metadata(&self) -> ConfigLayerMetadata {
        ConfigLayerMetadata {
            name: self.name.clone(),
            version: self.version.clone(),
        }
    }

    /// 将该条目转换为简化的 `ConfigLayer`（用于序列化与 API 暴露）。
    ///
    /// TOML 值会被序列化为 JSON 值；序列化失败时使用 `Null` 兜底。
    pub fn as_layer(&self) -> ConfigLayer {
        ConfigLayer {
            name: self.name.clone(),
            version: self.version.clone(),
            config: serde_json::to_value(&self.config).unwrap_or(JsonValue::Null),
            disabled_reason: self.disabled_reason.clone(),
        }
    }

    // 获取与该配置层关联的 `.codex/` 文件夹（若存在）。
    pub fn config_folder(&self) -> Option<AbsolutePathBuf> {
        match &self.name {
            ConfigLayerSource::Mdm { .. } => None,
            ConfigLayerSource::System { file } => file.parent(),
            ConfigLayerSource::EnterpriseManaged { .. } => None,
            ConfigLayerSource::User { file, .. } => file.parent(),
            ConfigLayerSource::Project { dot_codex_folder } => Some(dot_codex_folder.clone()),
            ConfigLayerSource::SessionFlags => None,
            ConfigLayerSource::LegacyManagedConfigTomlFromFile { .. } => None,
            ConfigLayerSource::LegacyManagedConfigTomlFromMdm => None,
        }
    }

    /// 返回用于 Hook 声明的 `.codex/` 文件夹。
    ///
    /// 项目层通常使用自身的配置文件夹。但链接式 Git worktree
    /// 可以将 Hook 发现指向根 checkout 中对应的文件夹，
    /// 而项目配置的其余部分仍来自 worktree。
    pub fn hooks_config_folder(&self) -> Option<AbsolutePathBuf> {
        self.hooks_config_folder_override
            .clone()
            .or_else(|| self.config_folder())
    }
}

/// 配置层栈的迭代顺序枚举。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigLayerStackOrdering {
    /// 从最低优先级（base）到最高优先级（top）。
    LowestPrecedenceFirst,
    /// 从最高优先级（top）到最低优先级（base）。
    HighestPrecedenceFirst,
}

/// 配置层栈，按优先级从低到高排列。
///
/// 后入栈的层（更高优先级）覆盖先入栈的层（更低优先级）。
/// requirements 约束单独存储，不参与普通层的合并，
/// 但会在派生 `Config` 时被强制执行。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ConfigLayerStack {
    /// 层列表，从最低优先级（base）到最高优先级（top）排列，
    /// 后入栈的条目覆盖先入栈的条目。
    layers: Vec<ConfigLayerEntry>,

    /// `layers` 中活动用户配置层的索引（若存在）。
    ///
    /// 当 profile 配置激活时，可能存在多个用户层：基础
    /// `$CODEX_HOME/config.toml` 层 + profile 覆盖层。
    /// 该索引指向最高优先级的用户层，因为它是 profile 感知编辑的
    /// 可写目标。
    user_layer_index: Option<usize>,

    /// 从层中派生 `Config` 时必须强制执行的约束。
    requirements: ConfigRequirements,

    /// 从 requirements.toml/MDM/legacy 源加载的原始 requirements 数据。
    /// 保留原始 allow-list 以便通过 API 暴露。
    requirements_toml: ConfigRequirementsToml,

    /// execpolicy 是否应跳过用户与项目配置层文件夹中的 `.rules` 文件。
    ignore_user_and_project_exec_policy_rules: bool,

    /// 构建该栈时发现的启动警告。
    ///
    /// `None` 表示加载器未检查栈级警告；
    /// `Some(vec![])` 表示已检查但无可报告内容。
    startup_warnings: Option<Vec<String>>,
}

impl ConfigLayerStack {
    /// 创建新的配置层栈。
    ///
    /// 会调用 `verify_layer_ordering` 校验层顺序的正确性。
    ///
    /// # 参数
    /// - `layers`: 按优先级从低到高排列的配置层
    /// - `requirements`: 已解析的 requirements 约束
    /// - `requirements_toml`: 原始 requirements TOML 数据
    ///
    /// # Errors
    /// 当层顺序不正确时返回 `io::Error`（`InvalidData`）。
    pub fn new(
        layers: Vec<ConfigLayerEntry>,
        requirements: ConfigRequirements,
        requirements_toml: ConfigRequirementsToml,
    ) -> std::io::Result<Self> {
        let user_layer_index = verify_layer_ordering(&layers)?;
        Ok(Self {
            layers,
            user_layer_index,
            requirements,
            requirements_toml,
            ignore_user_and_project_exec_policy_rules: false,
            startup_warnings: None,
        })
    }

    /// 设置是否忽略用户与项目级 execpolicy `.rules` 文件，返回新栈（builder 模式）。
    pub fn with_user_and_project_exec_policy_rules_ignored(
        mut self,
        ignore_user_and_project_exec_policy_rules: bool,
    ) -> Self {
        self.ignore_user_and_project_exec_policy_rules = ignore_user_and_project_exec_policy_rules;
        self
    }

    /// 返回是否忽略用户与项目级 execpolicy `.rules` 文件。
    pub fn ignore_user_and_project_exec_policy_rules(&self) -> bool {
        self.ignore_user_and_project_exec_policy_rules
    }

    /// 设置启动警告列表，返回新栈（builder 模式）。
    pub(crate) fn with_startup_warnings(mut self, startup_warnings: Vec<String>) -> Self {
        self.startup_warnings = Some(startup_warnings);
        self
    }

    /// 返回启动警告切片。`None` 表示未检查，`Some(&[])` 表示已检查无警告。
    pub fn startup_warnings(&self) -> Option<&[String]> {
        self.startup_warnings.as_deref()
    }

    /// 返回活动的原始用户配置层（若存在）。
    ///
    /// 不会合并其他配置层或应用任何 requirements。当 profile-v2 层激活时，
    /// 返回该 profile 层而非基础 `$CODEX_HOME/config.toml` 层，
    /// 因为活动层是 profile 感知编辑的可写目标。
    pub fn get_active_user_layer(&self) -> Option<&ConfigLayerEntry> {
        self.user_layer_index
            .and_then(|index| self.layers.get(index))
    }

    /// 返回活动用户配置文件路径（若存在）。
    pub fn get_user_config_file(&self) -> Option<&AbsolutePathBuf> {
        let layer = self.get_active_user_layer()?;
        let ConfigLayerSource::User { file, .. } = &layer.name else {
            return None;
        };
        Some(file)
    }

    /// 按指定顺序返回所有用户配置层。
    ///
    /// 当 profile-v2 激活时：
    /// - `LowestPrecedenceFirst`: 基础用户配置在前，profile 覆盖在后
    /// - `HighestPrecedenceFirst`: profile 覆盖在前，基础用户配置在后
    pub fn get_user_layers(
        &self,
        ordering: ConfigLayerStackOrdering,
        include_disabled: bool,
    ) -> Vec<&ConfigLayerEntry> {
        self.get_layers(ordering, include_disabled)
            .into_iter()
            .filter(|layer| matches!(layer.name, ConfigLayerSource::User { .. }))
            .collect()
    }

    /// 返回仅来自启用用户层的合并配置。
    ///
    /// 当 profile 配置激活时，包含基础用户配置 + profile 覆盖配置。
    pub fn effective_user_config(&self) -> Option<TomlValue> {
        let user_layers = self.get_user_layers(
            ConfigLayerStackOrdering::LowestPrecedenceFirst,
            /*include_disabled*/ false,
        );
        if user_layers.is_empty() {
            return None;
        }

        let mut merged = TomlValue::Table(toml::map::Map::new());
        for layer in user_layers {
            merge_toml_values(&mut merged, &layer.config);
        }
        Some(merged)
    }

    /// 返回 requirements 约束的引用。
    pub fn requirements(&self) -> &ConfigRequirements {
        &self.requirements
    }

    /// 返回原始 requirements TOML 数据的引用。
    pub fn requirements_toml(&self) -> &ConfigRequirementsToml {
        &self.requirements_toml
    }

    /// 创建新栈，将指定值注入为一个用户层。
    ///
    /// 若同文件的用户层已存在，则替换；否则按优先级规则插入到合适位置。
    /// 当栈同时有基础与 profile-v2 用户层时，仅更新文件路径匹配
    /// `config_toml` 的那一层。
    pub fn with_user_config(&self, config_toml: &AbsolutePathBuf, user_config: TomlValue) -> Self {
        let profile = self.layers.iter().find_map(|layer| match &layer.name {
            ConfigLayerSource::User { file, profile } if file == config_toml => profile
                .as_deref()
                .and_then(|profile| profile.parse::<ProfileV2Name>().ok()),
            _ => None,
        });
        self.with_user_config_profile(config_toml, profile.as_ref(), user_config)
    }

    /// 创建新栈，将指定值与 profile 注入为一个用户层。
    ///
    /// 与 [`with_user_config`](Self::with_user_config) 的区别在于显式指定 profile。
    pub fn with_user_config_profile(
        &self,
        config_toml: &AbsolutePathBuf,
        profile: Option<&ProfileV2Name>,
        user_config: TomlValue,
    ) -> Self {
        let user_layer = ConfigLayerEntry::new(
            ConfigLayerSource::User {
                file: config_toml.clone(),
                profile: profile.map(ToString::to_string),
            },
            user_config,
        );

        let mut layers = self.layers.clone();
        // 移除同文件的已有用户层（若存在）。
        if let Some(index) = layers.iter().position(|layer| {
            matches!(
                &layer.name,
                ConfigLayerSource::User { file, .. } if file == config_toml
            )
        }) {
            layers.remove(index);
        }
        // 按优先级插入到正确位置：找到首个优先级更高的层，插入到其前。
        match layers
            .iter()
            .position(|layer| layer.name.precedence() > user_layer.name.precedence())
        {
            Some(index) => layers.insert(index, user_layer),
            None => layers.push(user_layer),
        }
        // 更新 user_layer_index：从后往前找最后一个用户层。
        let user_layer_index = layers.iter().enumerate().rev().find_map(|(index, layer)| {
            if matches!(layer.name, ConfigLayerSource::User { .. }) {
                Some(index)
            } else {
                None
            }
        });
        Self {
            layers,
            user_layer_index,
            requirements: self.requirements.clone(),
            requirements_toml: self.requirements_toml.clone(),
            ignore_user_and_project_exec_policy_rules: self
                .ignore_user_and_project_exec_policy_rules,
            startup_warnings: self.startup_warnings.clone(),
        }
    }

    /// 返回新栈，从 `other` 复制用户层，保留本栈所有非用户层。
    ///
    /// 用于在不影响受管/系统层的情况下切换用户配置。
    pub fn with_user_layer_from(&self, other: &Self) -> Self {
        let user_layers = other
            .layers
            .iter()
            .filter(|layer| matches!(layer.name, ConfigLayerSource::User { .. }))
            .cloned()
            .collect::<Vec<_>>();
        let mut layers = self
            .layers
            .iter()
            .filter(|layer| !matches!(layer.name, ConfigLayerSource::User { .. }))
            .cloned()
            .collect::<Vec<_>>();
        for user_layer in user_layers {
            match layers
                .iter()
                .position(|layer| layer.name.precedence() > user_layer.name.precedence())
            {
                Some(index) => layers.insert(index, user_layer),
                None => layers.push(user_layer),
            }
        }
        let user_layer_index = layers.iter().enumerate().rev().find_map(|(index, layer)| {
            if matches!(layer.name, ConfigLayerSource::User { .. }) {
                Some(index)
            } else {
                None
            }
        });
        Self {
            layers,
            user_layer_index,
            requirements: self.requirements.clone(),
            requirements_toml: self.requirements_toml.clone(),
            ignore_user_and_project_exec_policy_rules: self
                .ignore_user_and_project_exec_policy_rules,
            startup_warnings: self.startup_warnings.clone(),
        }
    }

    /// 返回合并后的配置层视图。
    ///
    /// 仅合并普通配置层。Requirements 单独组合与追踪。
    pub fn effective_config(&self) -> TomlValue {
        let mut merged = TomlValue::Table(toml::map::Map::new());
        for layer in self.get_layers(
            ConfigLayerStackOrdering::LowestPrecedenceFirst,
            /*include_disabled*/ false,
        ) {
            merge_toml_values(&mut merged, &layer.config);
        }
        merged
    }

    /// 返回合并后配置层视图中各字段的来源。
    ///
    /// Requirement 源单独追踪，不包含在此结果中。
    pub fn origins(&self) -> HashMap<String, ConfigLayerMetadata> {
        let mut origins = HashMap::new();
        let mut path = Vec::new();

        for layer in self.get_layers(
            ConfigLayerStackOrdering::LowestPrecedenceFirst,
            /*include_disabled*/ false,
        ) {
            let config = normalized_with_key_aliases(&layer.config, &[]);
            record_origins(&config, &layer.metadata(), &mut path, &mut origins);
        }

        origins
    }

    /// 返回从最高优先级到最低优先级的配置层。
    ///
    /// Requirement 源单独追踪，不包含在此结果中。
    pub fn layers_high_to_low(&self) -> Vec<&ConfigLayerEntry> {
        self.get_layers(
            ConfigLayerStackOrdering::HighestPrecedenceFirst,
            /*include_disabled*/ false,
        )
    }

    /// 按指定优先级顺序返回配置层。
    ///
    /// # 参数
    /// - `ordering`: 迭代顺序
    /// - `include_disabled`: 是否包含被禁用的层
    ///
    /// Requirement 源单独追踪，不包含在此结果中。
    pub fn get_layers(
        &self,
        ordering: ConfigLayerStackOrdering,
        include_disabled: bool,
    ) -> Vec<&ConfigLayerEntry> {
        let mut layers: Vec<&ConfigLayerEntry> = self
            .layers
            .iter()
            .filter(|layer| include_disabled || !layer.is_disabled())
            .collect();
        if ordering == ConfigLayerStackOrdering::HighestPrecedenceFirst {
            layers.reverse();
        }
        layers
    }
}

/// 校验配置层的优先级顺序是否正确，返回活动用户配置层的索引（若存在）。
///
/// 校验两个不变量：
/// 1. 所有层按优先级单调递增（`is_sorted`）
/// 2. 项目层从根到 cwd 排列（不允许交叉或反向）
///
/// 允许多个用户层，以便 profile 覆盖层叠加在基础用户配置之上。
///
/// # Errors
/// 当层顺序不正确时返回 `io::Error`（`InvalidData`）。
fn verify_layer_ordering(layers: &[ConfigLayerEntry]) -> std::io::Result<Option<usize>> {
    if !layers.iter().map(|layer| &layer.name).is_sorted() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "config layers are not in correct precedence order",
        ));
    }

    // 前面的检查已确保 `layers` 按优先级排序，现在进一步校验
    // 项目层是否从根到 cwd 排列。允许多个用户层，以便 profile
    // 覆盖层能叠加在基础用户配置之上。
    let mut user_layer_index: Option<usize> = None;
    let mut previous_project_dot_codex_folder: Option<&AbsolutePathBuf> = None;
    for (index, layer) in layers.iter().enumerate() {
        if matches!(layer.name, ConfigLayerSource::User { .. }) {
            user_layer_index = Some(index);
        }

        if let ConfigLayerSource::Project {
            dot_codex_folder: current_project_dot_codex_folder,
        } = &layer.name
        {
            if let Some(previous) = previous_project_dot_codex_folder {
                let Some(parent) = previous.as_path().parent() else {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "project layer has no parent directory",
                    ));
                };
                // 当前项目文件夹必须是前一个项目文件夹的子目录，
                // 否则视为顺序错误。
                if previous == current_project_dot_codex_folder
                    || !current_project_dot_codex_folder
                        .as_path()
                        .ancestors()
                        .any(|ancestor| ancestor == parent)
                {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "project layers are not ordered from root to cwd",
                    ));
                }
            }
            previous_project_dot_codex_folder = Some(current_project_dot_codex_folder);
        }
    }

    Ok(user_layer_index)
}

#[cfg(test)]
#[path = "state_tests.rs"]
mod tests;
