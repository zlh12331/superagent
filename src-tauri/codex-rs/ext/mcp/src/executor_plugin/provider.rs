//! Executor plugin MCP 声明加载器模块。
//!
//! 该模块实现 [`ExecutorPluginMcpProvider`]，负责从已解析的 executor plugin
//! 中加载其声明的 MCP server 配置。加载来源包括：
//!
//! - plugin manifest 中显式指定的 MCP server 配置路径
//! - plugin manifest 中内联的 MCP server 配置对象
//! - plugin 根目录下的默认 `.mcp.json` 文件（若存在）
//!
//! 加载结果会被解析为 `(server_name, McpServerConfig)` 元组列表，
//! 供 [`SelectedExecutorPluginMcpContributor`](super::SelectedExecutorPluginMcpContributor)
//! 投影到模型步骤中。

use codex_config::McpServerConfig;
use codex_core_plugins::ResolvedExecutorPlugin;
use codex_exec_server::ExecutorFileSystem;
use codex_mcp::parse_executor_plugin_mcp_config;
use codex_plugin::PluginResourceLocator;
use codex_plugin::ResolvedPlugin;
use codex_plugin::ResolvedPluginLocation;
use codex_plugin::manifest::PluginManifestMcpServers;
use codex_utils_path_uri::PathUri;
use codex_utils_path_uri::PathUriParseError;
use std::io;
use thiserror::Error;

/// plugin 根目录下的默认 MCP 配置文件名。
const DEFAULT_MCP_CONFIG_FILE: &str = ".mcp.json";

/// 从已解析的 executor plugin 加载 MCP 声明的 provider。
///
/// 该 provider 为零状态结构，仅作为方法分发载体，可自由复制。
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct ExecutorPluginMcpProvider;

/// 加载 executor plugin 的 MCP 声明时可能发生的错误。
///
/// 错误按失败阶段分类，便于上层根据 `plugin_id` 和 `path` 进行诊断与日志记录。
#[derive(Debug, Error)]
pub(super) enum ExecutorPluginMcpProviderError {
    /// 读取 MCP 配置文件失败（IO 错误，非 NotFound 场景）。
    #[error("failed to read MCP config for selected plugin `{plugin_id}` at `{path}`: {source}")]
    ReadConfig {
        /// 出错的 plugin ID（即 selected_root_id）
        plugin_id: String,
        /// 出错的配置文件路径
        path: PathUri,
        /// 原始 IO 错误
        #[source]
        source: io::Error,
    },
    /// 拼接默认 MCP 配置路径失败（路径解析错误）。
    #[error(
        "failed to resolve MCP config path `{relative_path}` below selected plugin `{plugin_id}` at `{root}`: {source}"
    )]
    InvalidConfigPath {
        /// 出错的 plugin ID
        plugin_id: String,
        /// plugin 根路径
        root: PathUri,
        /// 触发错误的相对路径片段
        relative_path: &'static str,
        /// 原始路径解析错误
        #[source]
        source: PathUriParseError,
    },
    /// 解析 MCP 配置内容失败（JSON 或语义错误）。
    #[error("failed to parse MCP config for selected plugin `{plugin_id}` at `{path}`: {source}")]
    ParseConfig {
        /// 出错的 plugin ID
        plugin_id: String,
        /// 出错的配置文件路径
        path: PathUri,
        /// 原始解析错误
        #[source]
        source: serde_json::Error,
    },
}

impl ExecutorPluginMcpProvider {
    /// 返回 `plugin` 声明的 MCP server 列表，绑定到其所属环境。
    ///
    /// # 参数
    /// - `plugin`：已解析的 executor plugin
    ///
    /// # 返回
    /// 成功时返回 `(server_name, McpServerConfig)` 元组列表；
    /// 失败时返回对应的 [`ExecutorPluginMcpProviderError`]。
    pub(super) async fn load(
        &self,
        plugin: &ResolvedExecutorPlugin,
    ) -> Result<Vec<(String, McpServerConfig)>, ExecutorPluginMcpProviderError> {
        let ResolvedPluginLocation::Environment { root, .. } = plugin.plugin().location();

        load_from_file_system(plugin.plugin(), root, plugin.file_system()).await
    }
}

/// 从文件系统加载 plugin 的 MCP server 声明。
///
/// # 参数
/// - `plugin`：已解析的 plugin
/// - `plugin_root`：plugin 的根路径
/// - `file_system`：plugin 所属环境的文件系统接口
///
/// # 流程
/// 1. 根据 manifest 中的 `paths.mcp_servers` 字段决定加载来源：
///    - `Path` 变体：从指定路径读取 MCP 配置文件
///    - `Object` 变体：直接使用 manifest 中内联的配置对象
///    - `None`：回退到 plugin 根目录下的默认 `.mcp.json` 文件
///      （若文件不存在则返回空列表，不视为错误）
/// 2. 调用 [`parse_executor_plugin_mcp_config`] 解析配置内容
/// 3. 对解析过程中产生的非致命错误（如单个 server 声明无效）记录警告日志
/// 4. 返回有效的 server 列表
///
/// # 返回
/// 成功时返回 `(server_name, McpServerConfig)` 元组列表。
async fn load_from_file_system(
    plugin: &ResolvedPlugin,
    plugin_root: &PathUri,
    file_system: &dyn ExecutorFileSystem,
) -> Result<Vec<(String, McpServerConfig)>, ExecutorPluginMcpProviderError> {
    let ResolvedPluginLocation::Environment { environment_id, .. } = plugin.location();
    let plugin_id = plugin.selected_root_id();
    let (contents, config_path) = match plugin.manifest().paths.mcp_servers.as_ref() {
        // 情况 1：manifest 指定了 MCP 配置文件路径
        Some(PluginManifestMcpServers::Path(PluginResourceLocator::Environment {
            path,
            ..
        })) => {
            (
                file_system
                    .read_file_text(path, /*sandbox*/ None)
                    .await
                    .map_err(|source| ExecutorPluginMcpProviderError::ReadConfig {
                        plugin_id: plugin_id.to_string(),
                        path: path.clone(),
                        source,
                    })?,
                path.clone(),
            )
        }
        // 情况 2：manifest 内联了 MCP 配置对象
        Some(PluginManifestMcpServers::Object(object_config)) => {
            let PluginResourceLocator::Environment { path, .. } = plugin.manifest_path();
            (object_config.clone(), path.clone())
        }
        // 情况 3：manifest 未声明 MCP 配置，回退到默认 .mcp.json
        None => {
            let config_path = plugin_root
                .join(DEFAULT_MCP_CONFIG_FILE)
                .map_err(|source| ExecutorPluginMcpProviderError::InvalidConfigPath {
                    plugin_id: plugin_id.to_string(),
                    root: plugin_root.clone(),
                    relative_path: DEFAULT_MCP_CONFIG_FILE,
                    source,
                })?;
            let contents = match file_system
                .read_file_text(&config_path, /*sandbox*/ None)
                .await
            {
                Ok(contents) => contents,
                // 默认配置文件不存在时返回空列表，不视为错误
                Err(source) if source.kind() == io::ErrorKind::NotFound => {
                    return Ok(Vec::new());
                }
                Err(source) => {
                    return Err(ExecutorPluginMcpProviderError::ReadConfig {
                        plugin_id: plugin_id.to_string(),
                        path: config_path.clone(),
                        source,
                    });
                }
            };
            (contents, config_path)
        }
    };
    // 解析 MCP 配置内容
    let parsed = parse_executor_plugin_mcp_config(plugin_root, &contents, environment_id).map_err(
        |source| ExecutorPluginMcpProviderError::ParseConfig {
            plugin_id: plugin_id.to_string(),
            path: config_path,
            source,
        },
    )?;

    // 对解析过程中发现的无效 server 声明记录警告（不阻断加载）
    for error in parsed.errors {
        tracing::warn!(
            plugin = plugin_id,
            server = error.name,
            error = error.message,
            "ignoring invalid executor plugin MCP server"
        );
    }

    Ok(parsed.servers.into_iter().collect())
}

#[cfg(test)]
#[path = "provider_tests.rs"]
mod tests;
