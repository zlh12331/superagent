//! Web search 扩展主实现模块。
//!
//! 该模块定义了 `WebSearchExtension`，负责将 web 搜索能力以 extension 的形式接入
//! codex 的执行流程。扩展实现了以下三个 contributor trait：
//! - [`ThreadLifecycleContributor`]：在 thread 启动时根据当前配置构建
//!   [`WebSearchExtensionConfig`] 并存入 thread store
//! - [`ConfigContributor`]：当配置发生变化时刷新 thread store 中的扩展配置
//! - [`ToolContributor`]：根据 thread store 中的配置决定是否暴露 `web.run` 工具
//!
//! 扩展通过 [`install`] 函数注册到 [`ExtensionRegistryBuilder`]，由调用方在初始化时调用。

use std::sync::Arc;

use codex_api::AllowedCaller;
use codex_api::ApproximateLocation;
use codex_api::ExternalWebAccess;
use codex_api::ExternalWebAccessMode;
use codex_api::LocationType;
use codex_api::SearchContextSize;
use codex_api::SearchFilters;
use codex_api::SearchSettings;
use codex_core::config::Config;
use codex_extension_api::ConfigContributor;
use codex_extension_api::ExtensionData;
use codex_extension_api::ExtensionFuture;
use codex_extension_api::ExtensionRegistryBuilder;
use codex_extension_api::ThreadLifecycleContributor;
use codex_extension_api::ThreadStartInput;
use codex_extension_api::ToolContributor;
use codex_login::AuthManager;
use codex_model_provider::create_model_provider;
use codex_model_provider_info::ModelProviderInfo;
use codex_protocol::config_types::WebSearchContextSize;
use codex_protocol::config_types::WebSearchMode;

use crate::tool::WebSearchTool;

/// Web search 扩展本体。
///
/// 仅持有 [`AuthManager`] 用于在构建工具时创建 model provider。
/// 其余配置（可用性、provider 信息、搜索设置）在 thread 启动时
/// 通过 [`WebSearchExtensionConfig`] 存入 thread store，避免在 extension 中持有
/// 与 thread 相关的可变状态。
#[derive(Clone)]
struct WebSearchExtension {
    /// 共享的认证管理器，用于创建 model provider
    auth_manager: Arc<AuthManager>,
}

/// Web search 扩展在每个 thread 上的配置快照。
///
/// 由当前 [`Config`] 派生而来，存入 thread store 供后续 tool 贡献使用。
#[derive(Clone)]
struct WebSearchExtensionConfig {
    /// 是否对外提供 web 搜索能力（取决于 provider 类型与搜索模式）
    available: bool,
    /// 当前 thread 使用的 model provider 信息
    provider: ModelProviderInfo,
    /// 透传给搜索 API 的搜索设置（位置、上下文大小、过滤等）
    settings: SearchSettings,
}

impl From<&Config> for WebSearchExtensionConfig {
    /// 从全局配置构建扩展配置。
    ///
    /// 可用性判断：provider 必须是 OpenAI 或使用 OpenAI actor 授权，
    /// 且 web search 模式不为 [`WebSearchMode::Disabled`]。
    fn from(config: &Config) -> Self {
        let web_search_mode = config.web_search_mode.value();
        Self {
            // Core 在每轮基于 feature flag 或 model metadata 选择该 executor
            available: (config.model_provider.is_openai()
                || config.model_provider.uses_openai_actor_authorization())
                && web_search_mode != WebSearchMode::Disabled,
            provider: config.model_provider.clone(),
            settings: search_settings(config, web_search_mode),
        }
    }
}

/// 根据全局配置与 web search 模式构建 [`SearchSettings`]。
///
/// 将 codex 配置中的 user_location、search_context_size、filters 映射为
/// 搜索 API 所需的设置项，并固定 `allowed_callers` 为 `Direct`、
/// `external_web_access` 由模式决定。
///
/// # 参数
/// - `config`：全局配置
/// - `web_search_mode`：当前 web search 模式
fn search_settings(config: &Config, web_search_mode: WebSearchMode) -> SearchSettings {
    let web_search_config = config.web_search_config.as_ref();
    SearchSettings {
        user_location: web_search_config
            .and_then(|config| config.user_location.as_ref())
            .map(|location| ApproximateLocation {
                r#type: LocationType::Approximate,
                country: location.country.clone(),
                region: location.region.clone(),
                city: location.city.clone(),
                timezone: location.timezone.clone(),
            }),
        search_context_size: web_search_config
            .and_then(|config| config.search_context_size)
            .map(|size| match size {
                WebSearchContextSize::Low => SearchContextSize::Low,
                WebSearchContextSize::Medium => SearchContextSize::Medium,
                WebSearchContextSize::High => SearchContextSize::High,
            }),
        filters: web_search_config
            .and_then(|config| config.filters.as_ref())
            .map(|filters| SearchFilters {
                allowed_domains: filters.allowed_domains.clone(),
                blocked_domains: None,
            }),
        allowed_callers: Some(vec![AllowedCaller::Direct]),
        external_web_access: Some(external_web_access_for_mode(web_search_mode)),
        ..Default::default()
    }
}

/// 将 codex 的 [`WebSearchMode`] 映射为搜索 API 的 [`ExternalWebAccess`]。
///
/// 映射规则：
/// - `Disabled` / `Cached` → 不允许外部 web 访问（`Boolean(false)`）
/// - `Indexed` → 仅允许索引模式访问（`Mode(Indexed)`）
/// - `Live` → 允许外部 web 访问（`Boolean(true)`）
///
/// # 参数
/// - `web_search_mode`：codex 配置中的 web search 模式
fn external_web_access_for_mode(web_search_mode: WebSearchMode) -> ExternalWebAccess {
    match web_search_mode {
        WebSearchMode::Disabled | WebSearchMode::Cached => ExternalWebAccess::Boolean(false),
        WebSearchMode::Indexed => ExternalWebAccess::Mode(ExternalWebAccessMode::Indexed),
        WebSearchMode::Live => ExternalWebAccess::Boolean(true),
    }
}

impl ThreadLifecycleContributor<Config> for WebSearchExtension {
    /// thread 启动时构建并存储扩展配置。
    ///
    /// 将基于当前配置派生的 [`WebSearchExtensionConfig`] 插入 thread store，
    /// 供后续 tool 贡献阶段读取。
    fn on_thread_start<'a>(
        &'a self,
        input: ThreadStartInput<'a, Config>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            input
                .thread_store
                .insert(WebSearchExtensionConfig::from(input.config));
        })
    }
}

impl ConfigContributor<Config> for WebSearchExtension {
    /// 配置变化时刷新 thread store 中的扩展配置。
    ///
    /// 仅更新 thread store，session store 与 previous_config 不参与本扩展逻辑。
    fn on_config_changed(
        &self,
        _session_store: &ExtensionData,
        thread_store: &ExtensionData,
        _previous_config: &Config,
        new_config: &Config,
    ) {
        thread_store.insert(WebSearchExtensionConfig::from(new_config));
    }
}

impl ToolContributor for WebSearchExtension {
    /// 贡献 web 搜索工具。
    ///
    /// 流程：
    /// 1. 从 thread store 读取 [`WebSearchExtensionConfig`]，若不存在则返回空
    /// 2. 若配置标记为不可用（`available == false`），返回空
    /// 3. 否则构造一个 [`WebSearchTool`] 并返回
    ///
    /// 工具使用当前 session 的 level_id 作为 session_id，
    /// 并通过 `create_model_provider` 基于 provider 信息与 auth_manager 构造 provider。
    fn tools(
        &self,
        session_store: &ExtensionData,
        thread_store: &ExtensionData,
    ) -> Vec<Arc<dyn codex_extension_api::ToolExecutor<codex_extension_api::ToolCall>>> {
        let Some(config) = thread_store.get::<WebSearchExtensionConfig>() else {
            return Vec::new();
        };
        if !config.available {
            return Vec::new();
        }

        vec![Arc::new(WebSearchTool {
            session_id: session_store.level_id().to_string(),
            provider: create_model_provider(
                config.provider.clone(),
                Some(self.auth_manager.clone()),
            ),
            settings: config.settings.clone(),
        })]
    }
}

/// 注册 web search 扩展到 extension registry。
///
/// 将同一个 [`WebSearchExtension`] 实例分别注册为 thread lifecycle、config、tool
/// 三类 contributor。
///
/// # 参数
/// - `registry`：扩展注册器
/// - `auth_manager`：共享的认证管理器，供工具创建 model provider 时使用
pub fn install(registry: &mut ExtensionRegistryBuilder<Config>, auth_manager: Arc<AuthManager>) {
    let extension = Arc::new(WebSearchExtension { auth_manager });
    registry.thread_lifecycle_contributor(extension.clone());
    registry.config_contributor(extension.clone());
    registry.tool_contributor(extension);
}

#[cfg(test)]
mod tests {
    use codex_extension_api::ExtensionData;
    use codex_extension_api::ExtensionRegistryBuilder;
    use codex_extension_api::ToolName;
    use codex_login::CodexAuth;
    use codex_model_provider_info::ModelProviderInfo;
    use pretty_assertions::assert_eq;

    use super::AuthManager;
    use super::Config;
    use super::WebSearchExtensionConfig;
    use super::external_web_access_for_mode;
    use super::install;
    use crate::tool::RUN_TOOL_NAME;
    use crate::tool::WEB_NAMESPACE;
    use codex_api::ExternalWebAccess;
    use codex_api::ExternalWebAccessMode;
    use codex_protocol::config_types::WebSearchMode;

    #[test]
    fn external_web_access_preserves_legacy_values_until_indexed() {
        assert_eq!(
            [
                WebSearchMode::Disabled,
                WebSearchMode::Cached,
                WebSearchMode::Indexed,
                WebSearchMode::Live,
            ]
            .map(external_web_access_for_mode),
            [
                ExternalWebAccess::Boolean(false),
                ExternalWebAccess::Boolean(false),
                ExternalWebAccess::Mode(ExternalWebAccessMode::Indexed),
                ExternalWebAccess::Boolean(true),
            ]
        );
    }

    #[test]
    fn installed_extension_contributes_web_run_when_enabled() {
        let mut builder = ExtensionRegistryBuilder::<Config>::new();
        install(
            &mut builder,
            AuthManager::from_auth_for_testing(CodexAuth::from_api_key("dummy")),
        );
        let registry = builder.build();
        let session_store = ExtensionData::new("session");
        let thread_store = ExtensionData::new("11111111-1111-4111-8111-111111111111");
        thread_store.insert(WebSearchExtensionConfig {
            available: true,
            provider: ModelProviderInfo::create_openai_provider(/*base_url*/ None),
            settings: Default::default(),
        });

        let tool_names = registry
            .tool_contributors()
            .iter()
            .flat_map(|contributor| contributor.tools(&session_store, &thread_store))
            .map(|tool| (tool.tool_name(), tool.supports_parallel_tool_calls()))
            .collect::<Vec<_>>();

        assert_eq!(
            tool_names,
            vec![(ToolName::namespaced(WEB_NAMESPACE, RUN_TOOL_NAME), true)]
        );
    }
}
