//! 单层 requirements 的解析与领域字段抽取。
//!
//! 本模块负责把外部传入的 [`RequirementsLayerEntry`] 解析为可参与合并的
//! [`ComposableRequirementsLayer`]，包括：
//! - 把字符串/`TomlValue` 形式的 TOML 解析为常规 TOML 值与强类型
//!   `ConfigRequirementsToml` 两份表示。
//! - 在该层内独立评估 `remote_sandbox_config`（按需延迟解析 hostname），
//!   并把评估结果写回到 `allowed_sandbox_modes`。
//! - 剥离走领域特定合并路径的字段（`rules`、`hooks`、
//!   `permissions.filesystem.deny_read`），避免它们再次进入常规 TOML 合并。

use crate::ConfigRequirementsToml;
use crate::ManagedHooksRequirementsToml;
use crate::RequirementSource;
use crate::RequirementsExecPolicyToml;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_absolute_path::AbsolutePathBufGuard;
use toml::Value as TomlValue;

use super::stack::RequirementsCompositionError;

/// 外部传入的单层 requirements 条目。
///
/// 持有该层的来源标记、原始 TOML（字符串或已解析值两种形式）以及可选的
/// 基础目录（用于相对路径解析）。通过 [`from_toml`] / [`from_toml_value`]
/// 构造，并可用 [`with_base_dir`] 设置基础目录。
#[derive(Clone, Debug)]
pub struct RequirementsLayerEntry {
    /// 该层的来源标记，用于诊断与错误消息。
    pub(super) source: RequirementSource,
    /// 该层的 TOML 内容，支持字符串与已解析值两种形式。
    toml: RequirementsLayerToml,
    /// 该层的基础目录，用于相对路径解析；`None` 表示不启用 base_dir guard。
    base_dir: Option<AbsolutePathBuf>,
}

impl RequirementsLayerEntry {
    /// 从 TOML 字符串构造一层 requirements。
    pub fn from_toml(source: RequirementSource, contents: impl Into<String>) -> Self {
        Self {
            source,
            toml: RequirementsLayerToml::String(contents.into()),
            base_dir: None,
        }
    }

    /// 从已解析的 `TomlValue` 构造一层 requirements。
    pub fn from_toml_value(source: RequirementSource, value: TomlValue) -> Self {
        Self {
            source,
            toml: RequirementsLayerToml::Value(value),
            base_dir: None,
        }
    }

    /// 设置该层的基础目录（builder 风格）。
    ///
    /// 在解析期间会通过 `AbsolutePathBufGuard` 把该目录作为相对路径的基准，
    /// 与正常加载时的路径语义保持一致。
    pub fn with_base_dir(mut self, base_dir: AbsolutePathBuf) -> Self {
        self.base_dir = Some(base_dir);
        self
    }
}

/// requirements 层 TOML 的内部表示形式。
#[derive(Clone, Debug)]
enum RequirementsLayerToml {
    /// 未解析的 TOML 字符串。
    String(String),
    /// 已解析的 TOML 值。
    Value(TomlValue),
}

/// 已解析、可参与合并的单层 requirements。
///
/// 拆分为常规 TOML 字段（走 TOML 合并）与领域特定字段（走自定义合并）
/// 两部分，由 `stack::compose` 在合并阶段分别处理。
#[derive(Clone, Debug)]
pub(super) struct ComposableRequirementsLayer {
    /// 该层的来源标记。
    pub(super) source: RequirementSource,
    /// 走常规 TOML 合并的字段（已剥离领域特定字段）。
    pub(super) regular_toml: TomlValue,
    /// 走自定义合并路径的领域特定字段。
    pub(super) domain_fields: DomainMergedRequirementsFields,
}

impl ComposableRequirementsLayer {
    /// 把 [`RequirementsLayerEntry`] 解析为可合并的形式。
    ///
    /// 步骤：
    /// 1. 在 `base_dir` guard 作用下解析 TOML 字符串/值，得到常规 TOML
    ///    与 `ConfigRequirementsToml` 两份表示。
    /// 2. 仅当该层包含 `remote_sandbox_config` 时才解析 hostname（DNS 可能阻塞）。
    /// 3. 在该层内评估 `remote_sandbox_config` 并把结果写回
    ///    `allowed_sandbox_modes`。
    /// 4. 剥离领域特定字段（`rules`、`hooks`、`permissions.filesystem.deny_read`）。
    ///
    /// # Errors
    /// - TOML 解析失败时返回 `RequirementsCompositionError::Parse`。
    /// - `remote_sandbox_config` 物化失败时返回
    ///   `RequirementsCompositionError::ComposedParse`。
    pub(super) fn from_entry(
        layer: RequirementsLayerEntry,
        hostname_resolver: &dyn Fn() -> Option<String>,
    ) -> Result<Self, RequirementsCompositionError> {
        let RequirementsLayerEntry {
            source,
            toml,
            base_dir,
        } = layer;
        let (mut regular_toml, mut requirements) = {
            let _guard = base_dir
                .as_ref()
                .map(|base_dir| AbsolutePathBufGuard::new(base_dir.as_path()));
            let regular_toml = parse_layer_toml(&toml, &source)?;
            let requirements = parse_layer_requirements(&toml, &source)?;
            (regular_toml, requirements)
        };

        // hostname 解析由配置驱动，可能因 DNS 阻塞，因此仅在该层包含
        // 基于 hostname 的 sandbox 选择器时才解析。
        let hostname = requirements
            .remote_sandbox_config
            .as_ref()
            .and_then(|_| hostname_resolver());
        requirements.apply_remote_sandbox_config(hostname.as_deref());
        materialize_remote_sandbox_config(&mut regular_toml, &requirements)?;
        strip_special_fields(&mut regular_toml);

        Ok(Self {
            source,
            regular_toml,
            domain_fields: DomainMergedRequirementsFields {
                rules: requirements.rules,
                hooks: requirements.hooks,
                permissions: requirements.permissions,
            },
        })
    }
}

/// 走自定义合并路径的领域特定字段集合。
///
/// 这些字段不进入常规 TOML 合并，而是由 `stack` 模块按各自的语义
/// （append、union 等）合并，以便保留优先级顺序或实现 fail closed 行为。
#[derive(Clone, Debug)]
pub(super) struct DomainMergedRequirementsFields {
    /// `rules` 字段：跨层按高优先级在前追加。
    pub(super) rules: Option<RequirementsExecPolicyToml>,
    /// `hooks` 字段：跨层 append，managed_dir 走 fail closed。
    pub(super) hooks: Option<ManagedHooksRequirementsToml>,
    /// `permissions.filesystem.deny_read`：跨层去重并集。
    pub(super) permissions: Option<crate::config_requirements::PermissionsRequirementsToml>,
}

/// 把 TOML 字符串/值解析为常规 `TomlValue`。
///
/// # Errors
/// TOML 解析失败时返回 `RequirementsCompositionError::Parse`。
fn parse_layer_toml(
    toml: &RequirementsLayerToml,
    source: &RequirementSource,
) -> Result<TomlValue, RequirementsCompositionError> {
    match toml {
        RequirementsLayerToml::String(contents) => {
            toml::from_str(contents).map_err(|err: toml::de::Error| {
                RequirementsCompositionError::Parse {
                    layer_source: source.clone(),
                    message: err.to_string(),
                }
            })
        }
        RequirementsLayerToml::Value(value) => Ok(value.clone()),
    }
}

/// 把 TOML 字符串/值解析为强类型 `ConfigRequirementsToml`。
///
/// # Errors
/// TOML 解析或反序列化失败时返回 `RequirementsCompositionError::Parse`。
fn parse_layer_requirements(
    toml: &RequirementsLayerToml,
    source: &RequirementSource,
) -> Result<ConfigRequirementsToml, RequirementsCompositionError> {
    match toml {
        RequirementsLayerToml::String(contents) => {
            toml::from_str(contents).map_err(|err: toml::de::Error| {
                RequirementsCompositionError::Parse {
                    layer_source: source.clone(),
                    message: err.to_string(),
                }
            })
        }
        RequirementsLayerToml::Value(value) => {
            value.clone().try_into().map_err(|err: toml::de::Error| {
                RequirementsCompositionError::Parse {
                    layer_source: source.clone(),
                    message: err.to_string(),
                }
            })
        }
    }
}

/// 把该层 `remote_sandbox_config` 的评估结果物化到 `allowed_sandbox_modes`。
///
/// 先从 `layer_toml` 移除 `remote_sandbox_config`，再把 `requirements`
/// 中已评估的 `allowed_sandbox_modes` 序列化后写回 `layer_toml`。
///
/// # Errors
/// 序列化 `allowed_sandbox_modes` 为 `TomlValue` 失败时返回
/// `RequirementsCompositionError::ComposedParse`。
fn materialize_remote_sandbox_config(
    layer_toml: &mut TomlValue,
    requirements: &ConfigRequirementsToml,
) -> Result<(), RequirementsCompositionError> {
    remove_top_level_field(layer_toml, "remote_sandbox_config");
    let Some(allowed_sandbox_modes) = requirements.allowed_sandbox_modes.as_ref() else {
        return Ok(());
    };
    let Some(table) = layer_toml.as_table_mut() else {
        return Ok(());
    };
    table.insert(
        "allowed_sandbox_modes".to_string(),
        toml_value_from_serializable(allowed_sandbox_modes)?,
    );
    Ok(())
}

/// 把可序列化值转换为 `TomlValue`。
///
/// # Errors
/// 转换失败时返回 `RequirementsCompositionError::ComposedParse`。
fn toml_value_from_serializable<T: serde::Serialize>(
    value: T,
) -> Result<TomlValue, RequirementsCompositionError> {
    TomlValue::try_from(value).map_err(|err| RequirementsCompositionError::ComposedParse {
        message: err.to_string(),
    })
}

/// 从 `layer_toml` 剥离走领域特定合并路径的字段。
///
/// 移除顶层 `rules`、`hooks`，以及嵌套的
/// `permissions.filesystem.deny_read`（含空表清理）。
fn strip_special_fields(layer_toml: &mut TomlValue) {
    remove_top_level_field(layer_toml, "rules");
    remove_top_level_field(layer_toml, "hooks");
    remove_nested_field_and_prune_empty(layer_toml, &["permissions", "filesystem", "deny_read"]);
}

/// 从 TOML 表中移除顶层字段，返回被移除的值。
fn remove_top_level_field(value: &mut TomlValue, key: &str) -> Option<TomlValue> {
    value.as_table_mut()?.remove(key)
}

/// 按路径递归移除嵌套字段，并在移除后清理空表。
///
/// 路径以 `&[&str]` 形式给出，例如 `["permissions", "filesystem", "deny_read"]`。
/// 当移除后某个中间表为空时，会一并从父表移除，避免留下空表污染合并结果。
fn remove_nested_field_and_prune_empty(value: &mut TomlValue, path: &[&str]) -> Option<TomlValue> {
    let (key, remaining) = path.split_first()?;
    let table = value.as_table_mut()?;
    if remaining.is_empty() {
        return table.remove(*key);
    }

    let removed = table
        .get_mut(*key)
        .and_then(|child| remove_nested_field_and_prune_empty(child, remaining));
    if table
        .get(*key)
        .and_then(TomlValue::as_table)
        .is_some_and(toml::map::Map::is_empty)
    {
        table.remove(*key);
    }
    removed
}
