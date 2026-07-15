//! Thread 作用域配置加载器与类型定义。
//!
//! 本模块定义 thread 级别的配置加载抽象，支持 session 与 user 两种来源。
//! 加载器仅负责获取与解析自身拥有的来源，不应用优先级或合并规则；
//! 调用方负责将返回的来源解析为有效的运行时配置。

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

use crate::ConfigLayerSource;
use codex_model_provider_info::ModelProviderInfo;
use codex_utils_absolute_path::AbsolutePathBuf;
use thiserror::Error;
use toml::Value as TomlValue;

use crate::ConfigLayerEntry;

mod remote;

pub use remote::RemoteThreadConfigLoader;

/// 加载 thread 作用域配置时传给实现方的上下文。
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ThreadConfigContext {
    /// 当前 thread 的标识符。
    pub thread_id: Option<String>,
    /// 当前工作目录。
    pub cwd: Option<AbsolutePathBuf>,
}

/// 由启动或管理 session 的服务拥有的配置值。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SessionThreadConfig {
    /// 选定的 model provider 名称。
    pub model_provider: Option<String>,
    /// 自定义 model provider 信息映射。
    pub model_providers: HashMap<String, ModelProviderInfo>,
    /// feature 开关映射。
    pub features: BTreeMap<String, bool>,
}

/// 由已认证用户拥有的配置值。
///
/// 当前无 TOML 支持的字段。当未来新增字段时，应折叠到已有的 user 层，
/// 而非新增 `ConfigLayerSource` 变体。
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct UserThreadConfig {}

/// 带来源标记的 typed config 负载。
#[derive(Clone, Debug, PartialEq)]
pub enum ThreadConfigSource {
    /// 来自 session 的配置。
    Session(SessionThreadConfig),
    /// 来自用户的配置。
    User(UserThreadConfig),
}

/// thread 配置加载失败时的稳定分类码。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ThreadConfigLoadErrorCode {
    /// 鉴权失败。
    Auth,
    /// 请求超时。
    Timeout,
    /// 解析失败。
    Parse,
    /// 请求失败（非鉴权、非超时）。
    RequestFailed,
    /// 内部错误。
    Internal,
}

/// thread 配置加载错误，携带分类码、HTTP 状态码与人类可读消息。
#[derive(Clone, Debug, Eq, Error, PartialEq)]
#[error("{message}")]
pub struct ThreadConfigLoadError {
    code: ThreadConfigLoadErrorCode,
    message: String,
    status_code: Option<u16>,
}

impl ThreadConfigLoadError {
    /// 构造一个新的加载错误。
    pub fn new(
        code: ThreadConfigLoadErrorCode,
        status_code: Option<u16>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            status_code,
        }
    }

    /// 返回错误分类码。
    pub fn code(&self) -> ThreadConfigLoadErrorCode {
        self.code
    }

    /// 返回 HTTP 状态码（若来自 HTTP 响应）。
    pub fn status_code(&self) -> Option<u16> {
        self.status_code
    }
}

/// 为新 thread 加载 typed config 来源的 trait。
///
/// 实现方应仅获取自身拥有的来源特定配置，返回 typed 负载，
/// 不应用优先级或合并规则。调用方负责将返回的来源解析为有效的
/// 运行时配置。
pub trait ThreadConfigLoader: Send + Sync {
    /// 加载来源特定的 typed 配置。
    ///
    /// 实现方应保持此方法聚焦于获取与解析自身拥有的来源。
    /// 大多数调用方应使用 [`Self::load_config_layers`]，
    /// 使优先级与合并通过普通配置层栈继续处理。
    fn load(
        &self,
        context: ThreadConfigContext,
    ) -> ThreadConfigLoaderFuture<'_, Vec<ThreadConfigSource>>;

    /// 加载来源特定配置并转换为 `ConfigLayerEntry` 列表。
    ///
    /// 默认实现调用 `load` 并将每个来源转换为层条目。
    /// 优先级与合并通过普通配置层栈继续处理。
    fn load_config_layers(
        &self,
        context: ThreadConfigContext,
    ) -> ThreadConfigLoaderFuture<'_, Vec<ConfigLayerEntry>> {
        Box::pin(async move {
            let sources = self.load(context).await?;
            sources
                .into_iter()
                .map(thread_config_source_to_layer)
                .collect::<Result<Vec<_>, _>>()
                .map(|layers| layers.into_iter().flatten().collect())
        })
    }
}

/// `ThreadConfigLoader::load` 返回的 boxed future 类型。
pub type ThreadConfigLoaderFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, ThreadConfigLoadError>> + Send + 'a>>;

/// 基于静态 typed 来源集合的加载器。
///
/// 适用于测试或来源在构造时已确定的场景。`load` 直接返回构造时传入的来源副本。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StaticThreadConfigLoader {
    sources: Vec<ThreadConfigSource>,
}

impl StaticThreadConfigLoader {
    /// 构造一个静态加载器，携带给定的来源列表。
    pub fn new(sources: Vec<ThreadConfigSource>) -> Self {
        Self { sources }
    }
}

impl ThreadConfigLoader for StaticThreadConfigLoader {
    fn load(
        &self,
        _context: ThreadConfigContext,
    ) -> ThreadConfigLoaderFuture<'_, Vec<ThreadConfigSource>> {
        Box::pin(async { Ok(self.sources.clone()) })
    }
}

/// 无外部 thread 配置来源时使用的空操作加载器。
///
/// `load` 始终返回空来源列表。
#[derive(Clone, Debug, Default)]
pub struct NoopThreadConfigLoader;

impl ThreadConfigLoader for NoopThreadConfigLoader {
    fn load(
        &self,
        _context: ThreadConfigContext,
    ) -> ThreadConfigLoaderFuture<'_, Vec<ThreadConfigSource>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

/// 将 `ThreadConfigSource` 转换为 `ConfigLayerEntry`。
///
/// - `Session` 来源转换为 `SessionFlags` 层；空表时返回 `None`
/// - `User` 来源当前无 TOML 字段，始终返回 `None`
fn thread_config_source_to_layer(
    source: ThreadConfigSource,
) -> Result<Option<ConfigLayerEntry>, ThreadConfigLoadError> {
    match source {
        ThreadConfigSource::Session(config) => {
            let config = session_thread_config_to_toml(config)?;
            if is_empty_table(&config) {
                Ok(None)
            } else {
                Ok(Some(ConfigLayerEntry::new(
                    ConfigLayerSource::SessionFlags,
                    config,
                )))
            }
        }
        // UserThreadConfig 当前无 TOML 支持的字段。
        // 当未来新增字段时，应折叠到已有的 user 层，
        // 而非新增 ConfigLayerSource 变体。
        ThreadConfigSource::User(_config) => Ok(None),
    }
}

/// 判断 TOML 值是否为空表。
fn is_empty_table(config: &TomlValue) -> bool {
    config.as_table().is_some_and(toml::map::Map::is_empty)
}

/// 将 `SessionThreadConfig` 序列化为 TOML 值。
///
/// 仅写入 `Some(_)` 或非空字段：
/// - `model_provider`: 单个字符串
/// - `model_providers`: 非空时序列化为表
/// - `features`: 非空时序列化为布尔值表
fn session_thread_config_to_toml(
    config: SessionThreadConfig,
) -> Result<TomlValue, ThreadConfigLoadError> {
    let mut table = toml::map::Map::new();

    if let Some(model_provider) = config.model_provider {
        table.insert(
            "model_provider".to_string(),
            TomlValue::String(model_provider),
        );
    }

    if !config.model_providers.is_empty() {
        let model_providers = TomlValue::try_from(config.model_providers).map_err(|err| {
            ThreadConfigLoadError::new(
                ThreadConfigLoadErrorCode::Parse,
                /*status_code*/ None,
                format!("failed to convert session model providers to config TOML: {err}"),
            )
        })?;
        table.insert("model_providers".to_string(), model_providers);
    }

    if !config.features.is_empty() {
        let features = config
            .features
            .into_iter()
            .map(|(feature, enabled)| (feature, TomlValue::Boolean(enabled)))
            .collect();
        table.insert("features".to_string(), TomlValue::Table(features));
    }

    Ok(TomlValue::Table(table))
}

#[cfg(test)]
mod tests {
    use codex_model_provider_info::ModelProviderInfo;
    use codex_model_provider_info::WireApi;
    use pretty_assertions::assert_eq;

    use super::*;

    #[tokio::test]
    async fn loader_returns_session_and_user_sources() {
        let loader = StaticThreadConfigLoader::new(vec![
            ThreadConfigSource::Session(SessionThreadConfig {
                model_provider: Some("local".to_string()),
                model_providers: HashMap::from([("local".to_string(), test_provider("local"))]),
                features: BTreeMap::from([("plugins".to_string(), false)]),
            }),
            ThreadConfigSource::User(UserThreadConfig::default()),
        ]);

        let sources = loader
            .load(ThreadConfigContext {
                thread_id: Some("thread-1".to_string()),
                ..Default::default()
            })
            .await
            .expect("thread config loads");

        assert_eq!(
            sources,
            vec![
                ThreadConfigSource::Session(SessionThreadConfig {
                    model_provider: Some("local".to_string()),
                    model_providers: HashMap::from([("local".to_string(), test_provider("local"))]),
                    features: BTreeMap::from([("plugins".to_string(), false)]),
                }),
                ThreadConfigSource::User(UserThreadConfig::default()),
            ]
        );
    }

    #[tokio::test]
    async fn loader_translates_sources_to_config_layers() {
        let loader = StaticThreadConfigLoader::new(vec![
            ThreadConfigSource::User(UserThreadConfig::default()),
            ThreadConfigSource::Session(SessionThreadConfig {
                model_provider: Some("local".to_string()),
                model_providers: HashMap::from([("local".to_string(), test_provider("local"))]),
                features: BTreeMap::from([("plugins".to_string(), false)]),
            }),
        ]);
        let layers = loader
            .load_config_layers(ThreadConfigContext {
                cwd: Some(
                    AbsolutePathBuf::from_absolute_path_checked(
                        std::env::temp_dir().join("project"),
                    )
                    .expect("absolute cwd"),
                ),
                ..Default::default()
            })
            .await
            .expect("thread config layers load");

        assert_eq!(
            layers,
            vec![ConfigLayerEntry::new(
                ConfigLayerSource::SessionFlags,
                toml::toml! {
                    model_provider = "local"

                    [model_providers.local]
                    name = "local"
                    base_url = "http://127.0.0.1:8061/api/codex"
                    wire_api = "responses"
                    requires_openai_auth = false
                    supports_websockets = true

                    [features]
                    plugins = false
                }
                .into()
            )]
        );
    }

    fn test_provider(name: &str) -> ModelProviderInfo {
        ModelProviderInfo {
            name: name.to_string(),
            base_url: Some("http://127.0.0.1:8061/api/codex".to_string()),
            env_key: None,
            env_key_instructions: None,
            experimental_bearer_token: None,
            auth: None,
            aws: None,
            wire_api: WireApi::Responses,
            query_params: None,
            http_headers: None,
            env_http_headers: None,
            request_max_retries: None,
            stream_max_retries: None,
            stream_idle_timeout_ms: None,
            websocket_connect_timeout_ms: None,
            requires_openai_auth: false,
            supports_websockets: true,
        }
    }
}
