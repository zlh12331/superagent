//! requirements 层的组合（composition）。
//!
//! requirements 层的组合顺序与 config 层一致：低优先级在前，高优先级在后。
//! 大多数字段使用与 config 相同的 TOML 合并策略——低优先级层提供默认值，
//! 高优先级层覆盖标量/列表值，并对表做递归扩展。
//!
//! 少量字段具有领域特定语义，直接用 TOML 替换会破坏其语义：
//! - `remote_sandbox_config` 在每层内独立评估后再合并。
//! - `rules.prefix_rules` 高优先级层先追加。
//! - `hooks` 高优先级层的事件组先追加，并对活跃 managed-dir 冲突 fail closed。
//! - `permissions.filesystem.deny_read` 跨层做高优先级在前的并集。

use crate::ConfigRequirementsToml;
use crate::ConfigRequirementsWithSources;
use crate::RequirementSource;
use crate::Sourced;
use crate::merge::merge_toml_values;
use std::cell::OnceCell;
use std::io;
use thiserror::Error;
use toml::Value as TomlValue;

use super::hooks::HookDirectoryField;
use super::hooks::HookMergeState;
use super::layer::ComposableRequirementsLayer;
use super::layer::RequirementsLayerEntry;
use super::permissions::DenyReadMergeState;

/// requirements 层组合过程中可能发生的错误。
#[derive(Debug, Error, PartialEq, Eq)]
pub enum RequirementsCompositionError {
    /// 单层 TOML 解析失败。
    #[error("failed to parse requirements layer {layer_source}: {message}")]
    Parse {
        /// 解析失败层的来源标记。
        layer_source: RequirementSource,
        /// 解析错误消息。
        message: String,
    },
    /// 多层合并后的 TOML 反序列化为 `ConfigRequirementsToml` 失败。
    #[error("failed to parse merged requirements: {message}")]
    ComposedParse {
        /// 反序列化错误消息。
        message: String,
    },
    /// 两个层在某个领域特定字段上发生冲突（如 managed_dir 冲突）。
    #[error(
        "failed to compose requirements field `{field}` between {existing_source} and {incoming_source}: {message}"
    )]
    Conflict {
        /// 发生冲突的字段名。
        field: String,
        /// 既有值的来源。
        existing_source: RequirementSource,
        /// 新值的来源。
        incoming_source: RequirementSource,
        /// 冲突描述消息。
        message: String,
    },
}

impl From<RequirementsCompositionError> for io::Error {
    fn from(error: RequirementsCompositionError) -> Self {
        io::Error::new(io::ErrorKind::InvalidData, error)
    }
}

/// 把多层 requirements 组合为最终的 `ConfigRequirementsWithSources`。
///
/// 使用默认的 hostname 解析器（`crate::host_name`）。当所有层都不含
/// `remote_sandbox_config` 时，hostname 不会被解析。
///
/// # Errors
/// - 任一层 TOML 解析失败时返回 `RequirementsCompositionError::Parse`。
/// - 合并后 TOML 反序列化失败时返回 `RequirementsCompositionError::ComposedParse`。
/// - 领域特定字段冲突时返回 `RequirementsCompositionError::Conflict`。
pub fn compose_requirements(
    layers: impl IntoIterator<Item = RequirementsLayerEntry>,
) -> Result<Option<ConfigRequirementsWithSources>, RequirementsCompositionError> {
    compose_requirements_with_hostname_resolver(layers, crate::host_name)
}

/// 测试辅助：为指定 hostname 组合多层 requirements。
#[cfg(test)]
pub(super) fn compose_requirements_for_hostname(
    layers: impl IntoIterator<Item = RequirementsLayerEntry>,
    hostname: Option<&str>,
) -> Result<Option<ConfigRequirementsWithSources>, RequirementsCompositionError> {
    let hostname = hostname.map(str::to_string);
    compose_requirements_with_hostname_resolver_and_hook_directory(
        layers,
        move || hostname.clone(),
        HookDirectoryField::current_platform(),
    )
}

/// 测试辅助：为指定 hostname 与 hook 目录字段组合多层 requirements。
#[cfg(test)]
pub(super) fn compose_requirements_for_hostname_and_hook_directory(
    layers: impl IntoIterator<Item = RequirementsLayerEntry>,
    hostname: Option<&str>,
    hook_directory_field: HookDirectoryField,
) -> Result<Option<ConfigRequirementsWithSources>, RequirementsCompositionError> {
    let hostname = hostname.map(str::to_string);
    compose_requirements_with_hostname_resolver_and_hook_directory(
        layers,
        move || hostname.clone(),
        hook_directory_field,
    )
}

/// 使用自定义 hostname 解析器组合多层 requirements（当前平台 hook 字段）。
fn compose_requirements_with_hostname_resolver(
    layers: impl IntoIterator<Item = RequirementsLayerEntry>,
    hostname_resolver: impl Fn() -> Option<String>,
) -> Result<Option<ConfigRequirementsWithSources>, RequirementsCompositionError> {
    compose_requirements_with_hostname_resolver_and_hook_directory(
        layers,
        hostname_resolver,
        HookDirectoryField::current_platform(),
    )
}

/// 使用自定义 hostname 解析器与 hook 目录字段组合多层 requirements。
fn compose_requirements_with_hostname_resolver_and_hook_directory(
    layers: impl IntoIterator<Item = RequirementsLayerEntry>,
    hostname_resolver: impl Fn() -> Option<String>,
    hook_directory_field: HookDirectoryField,
) -> Result<Option<ConfigRequirementsWithSources>, RequirementsCompositionError> {
    // 对同一批层使用同一个 hostname 进行评估，但在没有层需要
    // remote_sandbox 匹配时保持 hostname 解析的惰性。
    let hostname = OnceCell::new();
    let cached_hostname_resolver = || hostname.get_or_init(&hostname_resolver).clone();
    let mut stack = RequirementsLayerStack::new(hook_directory_field);
    for layer in layers {
        stack.add_layer(layer, &cached_hostname_resolver)?;
    }
    stack.compose()
}

/// requirements 层栈的内部累积器。
struct RequirementsLayerStack {
    /// 已解析的可合并层列表（低优先级在前）。
    layers: Vec<ComposableRequirementsLayer>,
    /// 当前平台的活跃 hook 目录字段。
    hook_directory_field: HookDirectoryField,
}

impl RequirementsLayerStack {
    /// 构造一个空栈。
    fn new(hook_directory_field: HookDirectoryField) -> Self {
        Self {
            layers: Vec::new(),
            hook_directory_field,
        }
    }

    /// 添加一层并立即解析为 `ComposableRequirementsLayer`。
    ///
    /// # Errors
    /// 解析失败时返回 `RequirementsCompositionError::Parse`。
    fn add_layer(
        &mut self,
        layer: RequirementsLayerEntry,
        hostname_resolver: &dyn Fn() -> Option<String>,
    ) -> Result<(), RequirementsCompositionError> {
        self.layers.push(ComposableRequirementsLayer::from_entry(
            layer,
            hostname_resolver,
        )?);
        Ok(())
    }

    /// 把已添加的层组合为最终的 `ConfigRequirementsWithSources`。
    ///
    /// 步骤：
    /// 1. 常规 TOML 字段从低到高合并，再反序列化为 `ConfigRequirementsToml`。
    /// 2. 调用 `populate_merged_regular_fields_with_sources` 填充常规字段及其来源。
    /// 3. 领域特定字段从高到低合并（保持高优先级在前）：
    ///    - `rules` 走 `rules::merge`。
    ///    - `hooks` 走 `HookMergeState::merge`（活跃字段冲突 fail closed）。
    ///    - `permissions.filesystem.deny_read` 走 `DenyReadMergeState::merge`。
    /// 4. 写回领域特定字段，并在结果为空时返回 `None`。
    ///
    /// # Errors
    /// - 合并后 TOML 反序列化失败时返回 `RequirementsCompositionError::ComposedParse`。
    /// - hook 活跃字段冲突时返回 `RequirementsCompositionError::Conflict`。
    fn compose(
        self,
    ) -> Result<Option<ConfigRequirementsWithSources>, RequirementsCompositionError> {
        let Self {
            layers,
            hook_directory_field,
        } = self;

        let mut merged_toml = TomlValue::Table(toml::map::Map::new());
        for layer in &layers {
            merge_toml_values(&mut merged_toml, &layer.regular_toml);
        }

        let requirements: ConfigRequirementsToml =
            merged_toml.try_into().map_err(|err: toml::de::Error| {
                RequirementsCompositionError::ComposedParse {
                    message: err.to_string(),
                }
            })?;
        let mut output = ConfigRequirementsWithSources::default();
        populate_merged_regular_fields_with_sources(&mut output, requirements, &layers);
        let mut rules = None;
        let mut hooks = HookMergeState::new(hook_directory_field);
        let mut hooks_output = None;
        let mut deny_read = DenyReadMergeState::default();
        // 常规 TOML 字段像 config 一样从低到高合并。下面这些自定义字段
        // 是追加或并集语义，因此从高到低处理，使最终输出中保持优先级顺序可见。
        for layer in layers.iter().rev() {
            let domain_fields = &layer.domain_fields;
            super::rules::merge(&mut rules, domain_fields.rules.clone(), &layer.source);
            hooks.merge(
                &mut hooks_output,
                domain_fields.hooks.clone(),
                &layer.source,
            )?;
            deny_read.merge(domain_fields.permissions.clone(), &layer.source);
        }
        output.rules = rules;
        output.hooks = hooks_output;
        deny_read.apply_to(&mut output.permissions);

        let output_is_empty = output.clone().into_toml().is_empty();
        Ok((!output_is_empty).then_some(output))
    }
}

/// 把合并后的常规字段及其来源填充到 `output`。
///
/// 使用 `set_sourced!` 宏：当字段值存在时，同时记录其值与通过
/// `source_for_top_level_keys` 推导出的来源标记。
fn populate_merged_regular_fields_with_sources(
    output: &mut ConfigRequirementsWithSources,
    requirements: ConfigRequirementsToml,
    layers: &[ComposableRequirementsLayer],
) {
    macro_rules! set_sourced {
        ($field:ident, $keys:expr) => {
            if let Some(value) = $field {
                output.$field = Some(Sourced::new(
                    value,
                    source_for_top_level_keys(layers, $keys),
                ));
            }
        };
    }

    // 显式 destructure 而不用 `..`，以便每个新增的 requirements 字段
    // 都必须决定是走常规 TOML 合并路径，还是走某个特殊的 merger。
    let ConfigRequirementsToml {
        allowed_approval_policies,
        allowed_approvals_reviewers,
        allowed_sandbox_modes,
        allowed_permission_profiles,
        default_permissions,
        remote_sandbox_config: _,
        allowed_web_search_modes,
        allow_managed_hooks_only,
        allow_appshots,
        allow_remote_control,
        computer_use,
        windows,
        feature_requirements,
        hooks: _,
        mcp_servers,
        plugins,
        marketplaces,
        apps,
        rules: _,
        enforce_residency,
        network,
        permissions,
        models,
        guardian_policy_config,
    } = requirements;

    set_sourced!(allowed_approval_policies, &["allowed_approval_policies"]);
    set_sourced!(
        allowed_approvals_reviewers,
        &["allowed_approvals_reviewers"]
    );
    set_sourced!(allowed_sandbox_modes, &["allowed_sandbox_modes"]);
    set_sourced!(
        allowed_permission_profiles,
        &["allowed_permission_profiles"]
    );
    set_sourced!(default_permissions, &["default_permissions"]);
    set_sourced!(allowed_web_search_modes, &["allowed_web_search_modes"]);
    set_sourced!(allow_managed_hooks_only, &["allow_managed_hooks_only"]);
    set_sourced!(allow_appshots, &["allow_appshots"]);
    set_sourced!(allow_remote_control, &["allow_remote_control"]);
    set_sourced!(computer_use, &["computer_use"]);
    set_sourced!(windows, &["windows"]);
    set_sourced!(feature_requirements, &["features", "feature_requirements"]);
    set_sourced!(mcp_servers, &["mcp_servers"]);
    set_sourced!(plugins, &["plugins"]);
    set_sourced!(marketplaces, &["marketplaces"]);
    set_sourced!(apps, &["apps"]);
    set_sourced!(enforce_residency, &["enforce_residency"]);
    set_sourced!(network, &["experimental_network"]);
    set_sourced!(permissions, &["permissions"]);
    set_sourced!(models, &["models"]);

    if let Some(guardian_policy_config) =
        guardian_policy_config.filter(|value| !value.trim().is_empty())
    {
        output.guardian_policy_config = Some(Sourced::new(
            guardian_policy_config,
            source_for_top_level_keys(layers, &["guardian_policy_config"]),
        ));
    }
}

/// 推导某个顶层字段在多层栈中的来源标记。
///
/// 依次检查每层的常规 TOML，找到所有提供了该字段（或别名键）的层，
/// 然后取最后一个（最高优先级）作为"获胜来源"。若获胜值是 table
/// 且有多个层贡献过 table，则返回 `RequirementSource::composite`，
/// 以反映该字段是跨层合并的结果。
fn source_for_top_level_keys(
    layers: &[ComposableRequirementsLayer],
    keys: &[&str],
) -> RequirementSource {
    let matching_layers = layers
        .iter()
        .filter_map(|layer| {
            top_level_value_for_keys(&layer.regular_toml, keys).map(|value| (&layer.source, value))
        })
        .collect::<Vec<_>>();
    let Some((winning_source, winning_value)) = matching_layers.last() else {
        return RequirementSource::Unknown;
    };
    let winning_source = (*winning_source).clone();

    if !winning_value.is_table() {
        return winning_source;
    }

    let table_sources = matching_layers
        .into_iter()
        .rev()
        .filter_map(|(source, value)| value.is_table().then_some(source.clone()))
        .collect::<Vec<_>>();
    if table_sources.len() > 1 {
        RequirementSource::composite(table_sources)
    } else {
        winning_source
    }
}

/// 在 TOML 表中按候选键列表查找第一个存在的顶层值。
fn top_level_value_for_keys<'a>(value: &'a TomlValue, keys: &[&str]) -> Option<&'a TomlValue> {
    let table = value.as_table()?;
    keys.iter().find_map(|key| table.get(*key))
}

/// 把 `incoming` 来源合并到 `existing`（不同则合成 composite）。
pub(super) fn merge_output_source(existing: &mut RequirementSource, incoming: &RequirementSource) {
    if existing != incoming {
        *existing = RequirementSource::composite([existing.clone(), incoming.clone()]);
    }
}

/// 构造一个领域特定字段的冲突错误。
pub(super) fn composition_conflict(
    field: String,
    existing_source: RequirementSource,
    incoming_source: RequirementSource,
    message: impl Into<String>,
) -> RequirementsCompositionError {
    RequirementsCompositionError::Conflict {
        field,
        existing_source,
        incoming_source,
        message: message.into(),
    }
}

#[cfg(test)]
#[path = "stack_tests.rs"]
mod tests;
