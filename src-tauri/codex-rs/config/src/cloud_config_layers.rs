//! 云端下发的 config TOML 片段到配置栈层的转换。
//!
//! 后端片段按后端优先级顺序到达。本模块解析每个片段，将相对路径字段
//! 相对云配置基础目录解析，并按 `ConfigLayerStack` 顺序返回层。

use crate::ConfigLayerEntry;
use crate::ConfigLayerSource;
use crate::TomlValue;
use crate::config_toml::ConfigToml;
use crate::loader::resolve_relative_paths_in_config_toml;
use crate::strict_config::config_error_from_ignored_toml_value_fields_for_source_name;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_absolute_path::AbsolutePathBufGuard;
use serde::Deserialize;
use serde::Serialize;
use std::fmt;
use std::io;
use thiserror::Error;

/// 云配置 bundle 下发的单个 config 片段。
///
/// bundle 按最高优先级到最低优先级排序片段。本模块按栈顺序返回 config 层，
/// 调用方可直接将结果插入 system 与 user config 之间，无需重新排序。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CloudConfigFragment {
    /// 片段的稳定标识符。
    pub id: String,
    /// 管理员面向的显示名称。
    pub name: String,
    /// 原始 TOML 文本内容。
    pub contents: String,
}

impl CloudConfigFragment {
    /// 构造用于错误诊断的来源引用。
    fn source_ref(&self) -> CloudConfigFragmentSource {
        CloudConfigFragmentSource {
            id: self.id.clone(),
            name: self.name.clone(),
        }
    }
}

/// 云配置片段的来源引用，用于错误诊断与日志。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloudConfigFragmentSource {
    /// 片段的稳定标识符。
    pub id: String,
    /// 管理员面向的显示名称。
    pub name: String,
}

impl fmt::Display for CloudConfigFragmentSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.name, self.id)
    }
}

/// 云配置层处理错误。
#[derive(Debug, Error, PartialEq, Eq)]
pub enum CloudConfigLayerError {
    /// TOML 解析失败。
    #[error("failed to parse cloud config fragment {fragment}: {message}")]
    Parse {
        /// 出错的片段来源。
        fragment: CloudConfigFragmentSource,
        /// 错误消息。
        message: String,
    },
    /// 片段内容无效（如包含未知字段或路径解析失败）。
    #[error("invalid cloud config fragment {fragment}: {message}")]
    Invalid {
        /// 出错的片段来源。
        fragment: CloudConfigFragmentSource,
        /// 错误消息。
        message: String,
    },
}

/// 将云配置片段列表转换为 config 层条目（非严格模式）。
///
/// `base_dir` 用于解析片段中的相对路径。
///
/// # Errors
/// - `Parse`: TOML 解析失败
/// - `Invalid`: 路径解析失败
pub fn cloud_config_layers_from_fragments(
    fragments: impl IntoIterator<Item = CloudConfigFragment>,
    base_dir: &AbsolutePathBuf,
) -> Result<Vec<ConfigLayerEntry>, CloudConfigLayerError> {
    cloud_config_layers_from_fragments_impl(fragments, base_dir, /*strict_config*/ false)
}

/// 将云配置片段列表转换为 config 层条目（严格模式，检测未知字段）。
///
/// # Errors
/// - `Parse`: TOML 解析失败
/// - `Invalid`: 未知字段或路径解析失败
pub(crate) fn cloud_config_layers_from_fragments_strict(
    fragments: impl IntoIterator<Item = CloudConfigFragment>,
    base_dir: &AbsolutePathBuf,
) -> Result<Vec<ConfigLayerEntry>, CloudConfigLayerError> {
    cloud_config_layers_from_fragments_impl(fragments, base_dir, /*strict_config*/ true)
}

/// `cloud_config_layers_from_fragments` 与 `_strict` 的共享实现。
///
/// 处理流程：
/// 1. 解析每个片段的 TOML 内容
/// 2. 严格模式下校验未知字段
/// 3. 解析相对路径
/// 4. 反转层顺序（bundle 按最高优先级优先到达，而栈按最低优先级优先合并）
fn cloud_config_layers_from_fragments_impl(
    fragments: impl IntoIterator<Item = CloudConfigFragment>,
    base_dir: &AbsolutePathBuf,
    strict_config: bool,
) -> Result<Vec<ConfigLayerEntry>, CloudConfigLayerError> {
    let mut layers = Vec::new();
    for fragment in fragments {
        let source_ref = fragment.source_ref();
        let raw_toml = fragment.contents;
        let value: TomlValue =
            toml::from_str(&raw_toml).map_err(|err| CloudConfigLayerError::Parse {
                fragment: source_ref.clone(),
                message: err.to_string(),
            })?;
        if strict_config {
            validate_fragment_strictly(&source_ref, &raw_toml, &value, base_dir)?;
        }
        let resolved =
            resolve_relative_paths_in_config_toml(value, base_dir.as_path()).map_err(|err| {
                CloudConfigLayerError::Invalid {
                    fragment: source_ref.clone(),
                    message: err.to_string(),
                }
            })?;
        layers.push(ConfigLayerEntry::new_with_raw_toml(
            ConfigLayerSource::EnterpriseManaged {
                id: fragment.id,
                name: fragment.name,
            },
            resolved,
            raw_toml,
            base_dir.clone(),
        ));
    }

    // bundle 片段按最高优先级优先到达，
    // 而 ConfigLayerStack 按最低优先级到最高优先级合并，
    // 因此需要反转层顺序。
    layers.reverse();
    Ok(layers)
}

/// 严格模式下校验片段是否包含未知字段。
///
/// 通过 `AbsolutePathBufGuard` 设置基础目录，使相对路径校验与
/// 后续解析使用相同的路径语义。
fn validate_fragment_strictly(
    source_ref: &CloudConfigFragmentSource,
    raw_toml: &str,
    value: &TomlValue,
    base_dir: &AbsolutePathBuf,
) -> Result<(), CloudConfigLayerError> {
    let _guard = AbsolutePathBufGuard::new(base_dir.as_path());
    if let Some(config_error) = config_error_from_ignored_toml_value_fields_for_source_name::<
        ConfigToml,
    >(&source_ref.to_string(), raw_toml, value.clone())
    {
        return Err(CloudConfigLayerError::Invalid {
            fragment: source_ref.clone(),
            message: config_error.message,
        });
    }

    Ok(())
}

impl From<CloudConfigLayerError> for io::Error {
    fn from(error: CloudConfigLayerError) -> Self {
        io::Error::new(io::ErrorKind::InvalidData, error)
    }
}

#[cfg(test)]
#[path = "cloud_config_layers_tests.rs"]
mod tests;
