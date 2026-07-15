//! 配置层 I/O：从磁盘与 MDM 读取 managed config 层。
//!
//! 本模块负责从文件系统（如 `/etc/codex/managed_config.toml`）与
//! macOS managed preferences（MDM）读取受管配置层，统一封装为
//! `LoadedConfigLayers` 返回给上层。

#[cfg(target_os = "macos")]
use super::macos::ManagedAdminConfigLayer;
#[cfg(target_os = "macos")]
use super::macos::load_managed_admin_config_layer;
use crate::config_toml::ConfigToml;
use crate::diagnostics::config_error_from_toml;
use crate::diagnostics::io_error_from_config_error;
use crate::state::LoaderOverrides;
use crate::strict_config::config_error_from_ignored_toml_value_fields;
use codex_file_system::ExecutorFileSystem;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_absolute_path::AbsolutePathBufGuard;
use codex_utils_path_uri::PathUri;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use toml::Value as TomlValue;

/// Unix 平台下 managed config 的默认系统路径。
#[cfg(unix)]
const CODEX_MANAGED_CONFIG_SYSTEM_PATH: &str = "/etc/codex/managed_config.toml";

/// 从磁盘文件读取的 managed config。
#[derive(Debug, Clone)]
pub(super) struct MangedConfigFromFile {
    /// 已解析的 TOML 值。
    pub managed_config: TomlValue,
    /// 文件绝对路径。
    pub file: AbsolutePathBuf,
}

/// 从 MDM 读取的 managed config（仅 macOS）。
#[derive(Debug, Clone)]
pub(super) struct ManagedConfigFromMdm {
    /// 已解析的 TOML 值。
    pub managed_config: TomlValue,
    /// 原始 TOML 文本（用于诊断）。
    pub raw_toml: String,
}

/// 已加载的 managed config 层集合。
#[derive(Debug, Clone)]
pub(super) struct LoadedConfigLayers {
    /// 从文件（如 `/etc/codex/managed_config.toml`）读取的 managed config。
    pub managed_config: Option<MangedConfigFromFile>,
    /// 从 managed preferences（MDM）读取的 managed config（仅 macOS）。
    pub managed_config_from_mdm: Option<ManagedConfigFromMdm>,
}

/// 加载 managed config 层的内部实现。
///
/// 同时处理文件来源与 macOS MDM 来源。`overrides.managed_config_path`
/// 可覆盖默认文件路径；`overrides.managed_preferences_base64`（仅 macOS）
/// 可覆盖 MDM 读取的 base64 内容，便于测试。
///
/// # Errors
/// - 文件读取失败（且非 `NotFound`）
/// - TOML 解析失败
/// - 严格模式下未知字段校验失败
pub(super) async fn load_config_layers_internal(
    fs: &dyn ExecutorFileSystem,
    codex_home: &Path,
    overrides: LoaderOverrides,
    strict_config: bool,
) -> io::Result<LoadedConfigLayers> {
    #[cfg(target_os = "macos")]
    let LoaderOverrides {
        managed_config_path,
        managed_preferences_base64,
        ..
    } = overrides;

    #[cfg(not(target_os = "macos"))]
    let LoaderOverrides {
        managed_config_path,
        ..
    } = overrides;

    let managed_config_path = AbsolutePathBuf::from_absolute_path(
        managed_config_path.unwrap_or_else(|| managed_config_default_path(codex_home)),
    )?;

    let managed_config = read_config_from_path(
        fs,
        &managed_config_path,
        /*log_missing_as_info*/ false,
        strict_config,
    )
    .await?
    .map(|loaded| MangedConfigFromFile {
        managed_config: loaded,
        file: managed_config_path.clone(),
    });

    #[cfg(target_os = "macos")]
    let managed_preferences = load_managed_admin_config_layer(
        managed_preferences_base64.as_deref(),
        strict_config,
        codex_home,
    )
    .await?
    .map(map_managed_admin_layer);

    #[cfg(not(target_os = "macos"))]
    let managed_preferences = None;

    Ok(LoadedConfigLayers {
        managed_config,
        managed_config_from_mdm: managed_preferences,
    })
}

/// 将 macOS managed admin config 层映射为 `ManagedConfigFromMdm`。
#[cfg(target_os = "macos")]
fn map_managed_admin_layer(layer: ManagedAdminConfigLayer) -> ManagedConfigFromMdm {
    let ManagedAdminConfigLayer { config, raw_toml } = layer;
    ManagedConfigFromMdm {
        managed_config: config,
        raw_toml,
    }
}

/// 从给定路径读取配置文件并解析为 `TomlValue`。
///
/// 文件不存在时返回 `Ok(None)`。`log_missing_as_info` 控制未找到文件时
/// 是记录 info 级还是 debug 级日志。严格模式下会校验未知字段。
///
/// # Errors
/// - 文件读取失败（且非 `NotFound`）
/// - TOML 解析失败
/// - 严格模式下未知字段校验失败
pub(super) async fn read_config_from_path(
    fs: &dyn ExecutorFileSystem,
    path: &AbsolutePathBuf,
    log_missing_as_info: bool,
    strict_config: bool,
) -> io::Result<Option<TomlValue>> {
    let path_uri = PathUri::from_abs_path(path);
    match fs.read_file_text(&path_uri, /*sandbox*/ None).await {
        Ok(contents) => match toml::from_str::<TomlValue>(&contents) {
            Ok(value) => {
                if strict_config {
                    validate_config_toml_strictly(path, &contents, &value)?;
                }
                Ok(Some(value))
            }
            Err(err) => {
                tracing::error!("Failed to parse {}: {err}", path.as_path().display());
                let config_error = config_error_from_toml(path.as_path(), &contents, err.clone());
                Err(io_error_from_config_error(
                    io::ErrorKind::InvalidData,
                    config_error,
                    Some(err),
                ))
            }
        },
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            if log_missing_as_info {
                tracing::info!("{} not found, using defaults", path.as_path().display());
            } else {
                tracing::debug!("{} not found", path.as_path().display());
            }
            Ok(None)
        }
        Err(err) => {
            tracing::error!("Failed to read {}: {err}", path.as_path().display());
            Err(err)
        }
    }
}

/// 严格模式下校验 config TOML 是否包含未知字段。
///
/// 使用 `AbsolutePathBufGuard` 设置文件父目录作为基础目录，
/// 使相对路径校验与正常加载使用相同的路径语义。
///
/// # Errors
/// - 文件无父目录
/// - 存在未知字段时返回 `InvalidData` 错误
fn validate_config_toml_strictly(
    path: &AbsolutePathBuf,
    contents: &str,
    value: &TomlValue,
) -> io::Result<()> {
    let Some(base_dir) = path.as_path().parent() else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Config file {} has no parent directory", path.display()),
        ));
    };
    let _guard = AbsolutePathBufGuard::new(base_dir);
    if let Some(config_error) = config_error_from_ignored_toml_value_fields::<ConfigToml>(
        path.as_path(),
        contents,
        value.clone(),
    ) {
        return Err(io_error_from_config_error(
            io::ErrorKind::InvalidData,
            config_error,
            /*source*/ None,
        ));
    }

    Ok(())
}

/// 返回 managed config 的默认路径。
///
/// - Unix：`/etc/codex/managed_config.toml`
/// - 非 Unix（如 Windows）：`<codex_home>/managed_config.toml`
pub(super) fn managed_config_default_path(codex_home: &Path) -> PathBuf {
    #[cfg(unix)]
    {
        let _ = codex_home;
        PathBuf::from(CODEX_MANAGED_CONFIG_SYSTEM_PATH)
    }

    #[cfg(not(unix))]
    {
        codex_home.join("managed_config.toml")
    }
}
