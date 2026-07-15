//! 配置层来源（provenance）的类型定义。
//!
//! 本模块定义 codex-rs 配置系统中每一层的来源标识、优先级比较
//! 与元数据结构。`ConfigLayerSource` 标识一个配置层的出处
//! （System/User/Project/MDM/EnterpriseManaged 等），
//! `ConfigLayerMetadata` 附带版本信息用于 origins 追踪。

use codex_utils_absolute_path::AbsolutePathBuf;
use serde_json::Value as JsonValue;

/// 有效 Codex 配置中某一层的来源标识。
///
/// 每个变体对应一种配置来源，携带必要的定位信息（如文件路径、
/// MDM domain/key 等）。层的优先级通过 [`Self::precedence`] 比较。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigLayerSource {
    /// 由 MDM（移动设备管理）下发的受管偏好配置。
    Mdm { domain: String, key: String },
    /// 从文件加载的主机级配置（如 `/etc/codex/config.toml`）。
    System { file: AbsolutePathBuf },
    /// 由企业云 bundle 下发的配置。
    EnterpriseManaged { id: String, name: String },
    /// 用户配置，可选地通过选定的 profile 增强。
    User {
        file: AbsolutePathBuf,
        profile: Option<String>,
    },
    /// 从项目的 `.codex` 目录加载的配置。
    Project { dot_codex_folder: AbsolutePathBuf },
    /// 当前会话通过命令行 flag 提供的覆盖。
    SessionFlags,
    /// 从文件加载的 legacy 受管配置（`managed_config.toml`）。
    LegacyManagedConfigTomlFromFile { file: AbsolutePathBuf },
    /// 由 MDM 下发的 legacy 受管配置。
    LegacyManagedConfigTomlFromMdm,
}

impl ConfigLayerSource {
    /// 返回该层的优先级数值。
    ///
    /// 数值越高，优先级越高：来自高优先级层的设置覆盖来自低优先级层的设置。
    /// User 层在有 profile 时优先级 +1（21 vs 20），使 profile 覆盖能
    /// 叠加在基础用户配置之上。
    pub fn precedence(&self) -> i16 {
        match self {
            ConfigLayerSource::Mdm { .. } => 0,
            ConfigLayerSource::System { .. } => 10,
            ConfigLayerSource::EnterpriseManaged { .. } => 15,
            ConfigLayerSource::User { profile, .. } => {
                if profile.is_some() {
                    21
                } else {
                    20
                }
            }
            ConfigLayerSource::Project { .. } => 25,
            ConfigLayerSource::SessionFlags => 30,
            ConfigLayerSource::LegacyManagedConfigTomlFromFile { .. } => 40,
            ConfigLayerSource::LegacyManagedConfigTomlFromMdm => 50,
        }
    }
}

/// 按 [`ConfigLayerSource`] 的优先级比较，`A < B` 表示层 A 的设置
/// 会被层 B 的设置覆盖。
impl PartialOrd for ConfigLayerSource {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.precedence().cmp(&other.precedence()))
    }
}

/// 配置层的身份与版本信息。
///
/// 用于 origins 追踪：记录每个配置字段来自哪一层及其版本。
#[derive(Debug, Clone, PartialEq)]
pub struct ConfigLayerMetadata {
    /// 该层的来源标识。
    pub name: ConfigLayerSource,
    /// 该层的配置指纹版本（基于 canonical JSON 的 SHA-256）。
    pub version: String,
}

/// 一个已物化的配置层及其来源。
///
/// `config` 以 JSON 值形式存储（已从 TOML 转换），便于跨语言序列化。
#[derive(Debug, Clone, PartialEq)]
pub struct ConfigLayer {
    /// 该层的来源标识。
    pub name: ConfigLayerSource,
    /// 该层的配置指纹版本。
    pub version: String,
    /// 已序列化为 JSON 的配置值。
    pub config: JsonValue,
    /// 禁用原因。`Some` 表示该层被禁用，`None` 表示启用。
    pub disabled_reason: Option<String>,
}

/// 将 `ConfigLayerSource` 格式化为人类可读的字符串。
///
/// 用于日志、诊断信息与 UI 展示。`config_toml_file` 参数用于
/// Project 层的输出，表示该层对应的配置文件名（如 `config.toml`）。
pub fn format_config_layer_source(source: &ConfigLayerSource, config_toml_file: &str) -> String {
    match source {
        ConfigLayerSource::Mdm { domain, key } => {
            format!("MDM ({domain}:{key})")
        }
        ConfigLayerSource::System { file } => {
            format!("system ({})", file.as_path().display())
        }
        ConfigLayerSource::EnterpriseManaged { id, name } => {
            format!("enterprise-managed ({name}, {id})")
        }
        ConfigLayerSource::User { file, .. } => {
            format!("user ({})", file.as_path().display())
        }
        ConfigLayerSource::Project { dot_codex_folder } => {
            format!(
                "project ({}/{config_toml_file})",
                dot_codex_folder.as_path().display()
            )
        }
        ConfigLayerSource::SessionFlags => "session-flags".to_string(),
        ConfigLayerSource::LegacyManagedConfigTomlFromFile { file } => {
            format!("legacy managed_config.toml ({})", file.as_path().display())
        }
        ConfigLayerSource::LegacyManagedConfigTomlFromMdm => {
            "legacy managed_config.toml (MDM)".to_string()
        }
    }
}
