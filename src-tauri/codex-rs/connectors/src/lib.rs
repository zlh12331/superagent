//! ChatGPT connectors 集成模块。
//!
//! 本 crate 负责 ChatGPT connectors 目录的拉取、合并、缓存与快照管理。
//! 核心能力包括：
//! - 从 ChatGPT 后端分页拉取 connector 目录（含 workspace 级别）
//! - 合并重复 connector 条目并规范化名称、描述、安装 URL 等字段
//! - 提供内存 + 磁盘两级缓存，支持 TTL 过期与强制刷新
//! - 暴露 connector 工具策略评估、插件配置解析等公共 API
//!
//! 核心类型：
//! - [`ConnectorDirectoryCacheKey`]：目录缓存键，唯一标识一个缓存条目
//! - [`DirectoryListResponse`] / [`DirectoryApp`]：后端列表响应的反序列化类型
//! - [`list_all_connectors_with_options`]：拉取并合并全部 connector 的主入口
//! - [`cached_directory_connectors`]：仅从缓存读取 connector 列表（不触发网络请求）

use std::collections::HashMap;
use std::future::Future;
use std::sync::LazyLock;
use std::sync::Mutex as StdMutex;
use std::time::Duration;
use std::time::Instant;

use serde::Deserialize;
use serde::Serialize;

/// 公开子模块：connector 可访问性判断与过滤。
pub mod accessible;
mod app_info;
mod app_tool_policy;
mod directory_cache;
/// 公开子模块：connector 过滤逻辑。
pub mod filter;
/// 公开子模块：connector 合并逻辑。
pub mod merge;
/// 公开子模块：connector 元数据。
pub mod metadata;
mod plugin_config;
mod snapshot;

/// Connector 品牌信息（分类、开发者、网站、隐私政策、服务条款等）。
pub use app_info::AppBranding;
/// Connector 应用信息，包含名称、描述、图标、品牌、元数据等。
pub use app_info::AppInfo;
/// Connector 应用元数据（审核信息、分类、截图、版本等）。
pub use app_info::AppMetadata;
/// Connector 应用审核信息。
pub use app_info::AppReview;
/// Connector 应用截图。
pub use app_info::AppScreenshot;
/// Connector 工具策略，定义单个 connector 的工具访问规则。
pub use app_tool_policy::AppToolPolicy;
/// Connector 工具策略评估器，用于运行时判断工具是否被允许。
pub use app_tool_policy::AppToolPolicyEvaluator;
/// Connector 工具策略输入。
pub use app_tool_policy::AppToolPolicyInput;
/// 判断指定 connector 是否处于启用状态。
pub use app_tool_policy::app_is_enabled;
/// 从配置层栈中解析出全部 connector 的工具策略配置。
pub use app_tool_policy::apps_config_from_layer_stack;
/// Connector 目录缓存上下文，封装缓存键与磁盘路径。
pub use directory_cache::ConnectorDirectoryCacheContext;
/// 解析插件形式的 connector 应用配置。
pub use plugin_config::parse_plugin_app_config;
/// 解析插件 connector 配置中的单个值。
pub use plugin_config::parse_plugin_app_config_value;
/// Connector 快照，记录某一时刻的 connector 完整状态。
pub use snapshot::ConnectorSnapshot;
/// 插件 connector 的来源标识。
pub use snapshot::PluginConnectorSource;

/// Connector 目录缓存的默认 TTL（1 小时）。
pub const CONNECTORS_CACHE_TTL: Duration = Duration::from_secs(3600);

/// Connector 目录缓存的键。
///
/// 由 ChatGPT base URL、账号 ID、用户 ID 以及是否为 workspace 账号共同组成，
/// 用于在内存与磁盘缓存中唯一标识一个 connector 目录条目。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectorDirectoryCacheKey {
    chatgpt_base_url: String,
    account_id: Option<String>,
    chatgpt_user_id: Option<String>,
    is_workspace_account: bool,
}

impl ConnectorDirectoryCacheKey {
    /// 创建一个新的缓存键。
    ///
    /// - `chatgpt_base_url`：ChatGPT 后端基地址。
    /// - `account_id`：当前账号 ID（可选）。
    /// - `chatgpt_user_id`：ChatGPT 用户 ID（可选）。
    /// - `is_workspace_account`：是否为 workspace 账号。
    pub fn new(
        chatgpt_base_url: String,
        account_id: Option<String>,
        chatgpt_user_id: Option<String>,
        is_workspace_account: bool,
    ) -> Self {
        Self {
            chatgpt_base_url,
            account_id,
            chatgpt_user_id,
            is_workspace_account,
        }
    }
}

#[derive(Clone)]
struct CachedConnectorDirectory {
    key: ConnectorDirectoryCacheKey,
    expires_at: Instant,
    connectors: Vec<AppInfo>,
}

static CONNECTOR_DIRECTORY_CACHE: LazyLock<StdMutex<Option<CachedConnectorDirectory>>> =
    LazyLock::new(|| StdMutex::new(None));

/// ChatGPT connector 目录列表的单页响应。
///
/// 由后端 `/connectors/directory/list` 接口返回，包含当前页的 connector 列表
/// 以及用于获取下一页的 `next_token`（分页游标）。
#[derive(Debug, Deserialize)]
pub struct DirectoryListResponse {
    apps: Vec<DirectoryApp>,
    #[serde(alias = "nextToken")]
    next_token: Option<String>,
}

/// ChatGPT connector 目录中的单个应用条目。
///
/// 该类型是后端返回的原始反序列化形态，后续会经由
/// [`directory_app_to_app_info`] 转换为 [`AppInfo`] 供上层使用。
#[derive(Debug, Deserialize, Clone)]
pub struct DirectoryApp {
    id: String,
    name: String,
    description: Option<String>,
    #[serde(alias = "appMetadata")]
    app_metadata: Option<AppMetadata>,
    branding: Option<AppBranding>,
    labels: Option<HashMap<String, String>>,
    #[serde(alias = "logoUrl")]
    logo_url: Option<String>,
    #[serde(alias = "logoUrlDark")]
    logo_url_dark: Option<String>,
    #[serde(alias = "iconAssets")]
    icon_assets: Option<HashMap<String, String>>,
    #[serde(alias = "iconDarkAssets")]
    icon_dark_assets: Option<HashMap<String, String>>,
    #[serde(alias = "distributionChannel")]
    distribution_channel: Option<String>,
    visibility: Option<String>,
}

/// 仅从缓存中读取 connector 列表，不触发任何网络请求。
///
/// 依次检查内存缓存和磁盘缓存。若内存未命中但磁盘命中，
/// 会将磁盘中的 connector 列表回填到内存缓存（TTL 为零，表示立即过期）。
///
/// 返回 `None` 表示内存与磁盘缓存均未命中。
pub fn cached_directory_connectors(
    cache_context: &ConnectorDirectoryCacheContext,
) -> Option<Vec<AppInfo>> {
    if let Some(cached_connectors) = cached_directory_connectors_in_memory(&cache_context.cache_key)
    {
        return Some(cached_connectors);
    }

    let directory_cache::CachedConnectorDirectoryDiskLoad::Hit { connectors } =
        directory_cache::load_cached_directory_connectors_from_disk(cache_context)
    else {
        return None;
    };
    write_cached_directory_connectors_in_memory(
        cache_context.cache_key.clone(),
        &connectors,
        Duration::ZERO,
    );
    Some(connectors)
}

fn cached_directory_connectors_in_memory(
    cache_key: &ConnectorDirectoryCacheKey,
) -> Option<Vec<AppInfo>> {
    let cache_guard = CONNECTOR_DIRECTORY_CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    cache_guard
        .as_ref()
        .filter(|cached| cached.key == *cache_key)
        .map(|cached| cached.connectors.clone())
}

fn unexpired_directory_connectors_in_memory(
    cache_key: &ConnectorDirectoryCacheKey,
) -> Option<Vec<AppInfo>> {
    let cache_guard = CONNECTOR_DIRECTORY_CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let cached = cache_guard.as_ref()?;
    if cached.key == *cache_key && Instant::now() < cached.expires_at {
        return Some(cached.connectors.clone());
    }
    None
}

/// 拉取并合并全部 ChatGPT connector，支持缓存与强制刷新。
///
/// # 参数
///
/// - `cache_context`：缓存上下文，提供缓存键与磁盘路径。
/// - `is_workspace_account`：是否为 workspace 账号；为 `true` 时会额外拉取
///   workspace 级别的 connector 列表并与目录列表合并。
/// - `force_refetch`：是否强制跳过内存缓存并重新拉取。
/// - `fetch_page`：由调用方提供的分页拉取闭包，接收路径并返回单页响应。
///
/// # 缓存策略
///
/// 若 `force_refetch` 为 `false` 且内存缓存未过期，直接返回缓存结果。
/// 否则发起网络请求，拉取完成后将结果写入内存与磁盘缓存。
///
/// # 合并逻辑
///
/// 同一 connector 可能同时出现在目录列表和 workspace 列表中，
/// 本函数会按 `id` 去重并合并字段（名称、描述、图标、品牌等取非空值）。
pub async fn list_all_connectors_with_options<F, Fut>(
    cache_context: ConnectorDirectoryCacheContext,
    is_workspace_account: bool,
    force_refetch: bool,
    mut fetch_page: F,
) -> anyhow::Result<Vec<AppInfo>>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = anyhow::Result<DirectoryListResponse>>,
{
    if !force_refetch
        && let Some(cached_connectors) =
            unexpired_directory_connectors_in_memory(&cache_context.cache_key)
    {
        return Ok(cached_connectors);
    }

    let mut apps = list_directory_connectors(&mut fetch_page).await?;
    if is_workspace_account {
        apps.extend(list_workspace_connectors(&mut fetch_page).await?);
    }

    let mut connectors = merge_directory_apps(apps)
        .into_iter()
        .map(directory_app_to_app_info)
        .collect::<Vec<_>>();
    for connector in &mut connectors {
        let install_url = match connector.install_url.take() {
            Some(install_url) => install_url,
            None => connector_install_url(&connector.name, &connector.id),
        };
        connector.name = normalize_connector_name(&connector.name, &connector.id);
        connector.description = normalize_connector_value(connector.description.as_deref());
        connector.install_url = Some(install_url);
        connector.is_accessible = false;
    }
    connectors.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.id.cmp(&right.id))
    });
    write_cached_directory_connectors(&cache_context, &connectors);
    Ok(connectors)
}

fn write_cached_directory_connectors(
    cache_context: &ConnectorDirectoryCacheContext,
    connectors: &[AppInfo],
) {
    write_cached_directory_connectors_in_memory(
        cache_context.cache_key.clone(),
        connectors,
        CONNECTORS_CACHE_TTL,
    );
    directory_cache::write_cached_directory_connectors_to_disk(cache_context, connectors);
}

fn write_cached_directory_connectors_in_memory(
    cache_key: ConnectorDirectoryCacheKey,
    connectors: &[AppInfo],
    ttl: Duration,
) {
    let mut cache_guard = CONNECTOR_DIRECTORY_CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    *cache_guard = Some(CachedConnectorDirectory {
        key: cache_key,
        expires_at: Instant::now() + ttl,
        connectors: connectors.to_vec(),
    });
}

async fn list_directory_connectors<F, Fut>(fetch_page: &mut F) -> anyhow::Result<Vec<DirectoryApp>>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = anyhow::Result<DirectoryListResponse>>,
{
    let mut apps = Vec::new();
    let mut next_token: Option<String> = None;
    loop {
        let path = match next_token.as_deref() {
            Some(token) => {
                let encoded_token = urlencoding::encode(token);
                format!("/connectors/directory/list?token={encoded_token}&external_logos=true")
            }
            None => "/connectors/directory/list?external_logos=true".to_string(),
        };
        let response = fetch_page(path).await?;
        apps.extend(
            response
                .apps
                .into_iter()
                .filter(|app| !is_hidden_directory_app(app)),
        );
        next_token = response
            .next_token
            .map(|token| token.trim().to_string())
            .filter(|token| !token.is_empty());
        if next_token.is_none() {
            break;
        }
    }
    Ok(apps)
}

async fn list_workspace_connectors<F, Fut>(fetch_page: &mut F) -> anyhow::Result<Vec<DirectoryApp>>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = anyhow::Result<DirectoryListResponse>>,
{
    let response =
        fetch_page("/connectors/directory/list_workspace?external_logos=true".to_string()).await;
    match response {
        Ok(response) => Ok(response
            .apps
            .into_iter()
            .filter(|app| !is_hidden_directory_app(app))
            .collect()),
        Err(_) => Ok(Vec::new()),
    }
}

fn merge_directory_apps(apps: Vec<DirectoryApp>) -> Vec<DirectoryApp> {
    let mut merged: HashMap<String, DirectoryApp> = HashMap::new();
    for app in apps {
        if let Some(existing) = merged.get_mut(&app.id) {
            merge_directory_app(existing, app);
        } else {
            merged.insert(app.id.clone(), app);
        }
    }
    merged.into_values().collect()
}

fn merge_directory_app(existing: &mut DirectoryApp, incoming: DirectoryApp) {
    let DirectoryApp {
        id: _,
        name,
        description,
        app_metadata,
        branding,
        labels,
        logo_url,
        logo_url_dark,
        icon_assets,
        icon_dark_assets,
        distribution_channel,
        visibility: _,
    } = incoming;

    let incoming_name_is_empty = name.trim().is_empty();
    if existing.name.trim().is_empty() && !incoming_name_is_empty {
        existing.name = name;
    }

    let incoming_description_present = description
        .as_deref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    if incoming_description_present {
        existing.description = description;
    }

    if existing.logo_url.is_none() && logo_url.is_some() {
        existing.logo_url = logo_url;
    }
    if existing.logo_url_dark.is_none() && logo_url_dark.is_some() {
        existing.logo_url_dark = logo_url_dark;
    }
    if existing.icon_assets.as_ref().is_none_or(HashMap::is_empty)
        && icon_assets
            .as_ref()
            .is_some_and(|assets| !assets.is_empty())
    {
        existing.icon_assets = icon_assets;
    }
    if existing
        .icon_dark_assets
        .as_ref()
        .is_none_or(HashMap::is_empty)
        && icon_dark_assets
            .as_ref()
            .is_some_and(|assets| !assets.is_empty())
    {
        existing.icon_dark_assets = icon_dark_assets;
    }
    if existing.distribution_channel.is_none() && distribution_channel.is_some() {
        existing.distribution_channel = distribution_channel;
    }

    if let Some(incoming_branding) = branding {
        if let Some(existing_branding) = existing.branding.as_mut() {
            if existing_branding.category.is_none() && incoming_branding.category.is_some() {
                existing_branding.category = incoming_branding.category;
            }
            if existing_branding.developer.is_none() && incoming_branding.developer.is_some() {
                existing_branding.developer = incoming_branding.developer;
            }
            if existing_branding.website.is_none() && incoming_branding.website.is_some() {
                existing_branding.website = incoming_branding.website;
            }
            if existing_branding.privacy_policy.is_none()
                && incoming_branding.privacy_policy.is_some()
            {
                existing_branding.privacy_policy = incoming_branding.privacy_policy;
            }
            if existing_branding.terms_of_service.is_none()
                && incoming_branding.terms_of_service.is_some()
            {
                existing_branding.terms_of_service = incoming_branding.terms_of_service;
            }
            if !existing_branding.is_discoverable_app && incoming_branding.is_discoverable_app {
                existing_branding.is_discoverable_app = true;
            }
        } else {
            existing.branding = Some(incoming_branding);
        }
    }

    if let Some(incoming_app_metadata) = app_metadata {
        if let Some(existing_app_metadata) = existing.app_metadata.as_mut() {
            if existing_app_metadata.review.is_none() && incoming_app_metadata.review.is_some() {
                existing_app_metadata.review = incoming_app_metadata.review;
            }
            if existing_app_metadata.categories.is_none()
                && incoming_app_metadata.categories.is_some()
            {
                existing_app_metadata.categories = incoming_app_metadata.categories;
            }
            if existing_app_metadata.sub_categories.is_none()
                && incoming_app_metadata.sub_categories.is_some()
            {
                existing_app_metadata.sub_categories = incoming_app_metadata.sub_categories;
            }
            if existing_app_metadata.seo_description.is_none()
                && incoming_app_metadata.seo_description.is_some()
            {
                existing_app_metadata.seo_description = incoming_app_metadata.seo_description;
            }
            if existing_app_metadata.screenshots.is_none()
                && incoming_app_metadata.screenshots.is_some()
            {
                existing_app_metadata.screenshots = incoming_app_metadata.screenshots;
            }
            if existing_app_metadata.developer.is_none()
                && incoming_app_metadata.developer.is_some()
            {
                existing_app_metadata.developer = incoming_app_metadata.developer;
            }
            if existing_app_metadata.version.is_none() && incoming_app_metadata.version.is_some() {
                existing_app_metadata.version = incoming_app_metadata.version;
            }
            if existing_app_metadata.version_id.is_none()
                && incoming_app_metadata.version_id.is_some()
            {
                existing_app_metadata.version_id = incoming_app_metadata.version_id;
            }
            if existing_app_metadata.version_notes.is_none()
                && incoming_app_metadata.version_notes.is_some()
            {
                existing_app_metadata.version_notes = incoming_app_metadata.version_notes;
            }
            if existing_app_metadata.first_party_type.is_none()
                && incoming_app_metadata.first_party_type.is_some()
            {
                existing_app_metadata.first_party_type = incoming_app_metadata.first_party_type;
            }
            if existing_app_metadata.first_party_requires_install.is_none()
                && incoming_app_metadata.first_party_requires_install.is_some()
            {
                existing_app_metadata.first_party_requires_install =
                    incoming_app_metadata.first_party_requires_install;
            }
            if existing_app_metadata
                .show_in_composer_when_unlinked
                .is_none()
                && incoming_app_metadata
                    .show_in_composer_when_unlinked
                    .is_some()
            {
                existing_app_metadata.show_in_composer_when_unlinked =
                    incoming_app_metadata.show_in_composer_when_unlinked;
            }
        } else {
            existing.app_metadata = Some(incoming_app_metadata);
        }
    }

    if existing.labels.is_none() && labels.is_some() {
        existing.labels = labels;
    }
}

fn is_hidden_directory_app(app: &DirectoryApp) -> bool {
    matches!(app.visibility.as_deref(), Some("HIDDEN"))
}

fn directory_app_to_app_info(app: DirectoryApp) -> AppInfo {
    AppInfo {
        id: app.id,
        name: app.name,
        description: app.description,
        logo_url: app.logo_url,
        logo_url_dark: app.logo_url_dark,
        icon_assets: app.icon_assets,
        icon_dark_assets: app.icon_dark_assets,
        distribution_channel: app.distribution_channel,
        branding: app.branding,
        app_metadata: app.app_metadata,
        labels: app.labels,
        install_url: None,
        is_accessible: false,
        is_enabled: true,
        plugin_display_names: Vec::new(),
    }
}

fn connector_install_url(name: &str, connector_id: &str) -> String {
    let slug = connector_name_slug(name);
    format!("https://chatgpt.com/apps/{slug}/{connector_id}")
}

fn connector_name_slug(name: &str) -> String {
    let mut normalized = String::with_capacity(name.len());
    for character in name.chars() {
        if character.is_ascii_alphanumeric() {
            normalized.push(character.to_ascii_lowercase());
        } else {
            normalized.push('-');
        }
    }
    let normalized = normalized.trim_matches('-');
    if normalized.is_empty() {
        "app".to_string()
    } else {
        normalized.to_string()
    }
}

fn normalize_connector_name(name: &str, connector_id: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        connector_id.to_string()
    } else {
        trimmed.to_string()
    }
}

fn normalize_connector_value(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;
    use tempfile::TempDir;

    static CONNECTOR_DIRECTORY_CACHE_TEST_LOCK: LazyLock<tokio::sync::Mutex<()>> =
        LazyLock::new(|| tokio::sync::Mutex::new(()));

    fn cache_key(id: &str) -> ConnectorDirectoryCacheKey {
        ConnectorDirectoryCacheKey::new(
            "https://chatgpt.example".to_string(),
            Some(format!("account-{id}")),
            Some(format!("user-{id}")),
            /*is_workspace_account*/ true,
        )
    }

    fn cache_context(codex_home: &TempDir, id: &str) -> ConnectorDirectoryCacheContext {
        ConnectorDirectoryCacheContext::new(codex_home.path().to_path_buf(), cache_key(id))
    }

    fn clear_directory_memory_cache() {
        let mut cache_guard = CONNECTOR_DIRECTORY_CACHE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *cache_guard = None;
    }

    fn app(id: &str, name: &str) -> DirectoryApp {
        DirectoryApp {
            id: id.to_string(),
            name: name.to_string(),
            description: None,
            app_metadata: None,
            branding: None,
            labels: None,
            logo_url: None,
            logo_url_dark: None,
            icon_assets: None,
            icon_dark_assets: None,
            distribution_channel: None,
            visibility: None,
        }
    }

    #[test]
    fn directory_app_icon_assets_reach_app_info() -> anyhow::Result<()> {
        let response: DirectoryListResponse = serde_json::from_value(serde_json::json!({
            "apps": [{
                "id": "alpha",
                "name": "Alpha",
                "icon_assets": {},
                "icon_dark_assets": {}
            }, {
                "id": "alpha",
                "name": "",
                "icon_assets": {
                    "256_square": "https://example.com/alpha-square.png"
                },
                "icon_dark_assets": {
                    "256_square": "https://example.com/alpha-square-dark.png"
                }
            }],
            "next_token": null
        }))?;

        let app_info = directory_app_to_app_info(merge_directory_apps(response.apps).remove(0));

        assert_eq!(
            serde_json::to_value(app_info)?,
            serde_json::json!({
                "id": "alpha",
                "name": "Alpha",
                "description": null,
                "logoUrl": null,
                "logoUrlDark": null,
                "iconAssets": {
                    "256_square": "https://example.com/alpha-square.png"
                },
                "iconDarkAssets": {
                    "256_square": "https://example.com/alpha-square-dark.png"
                },
                "distributionChannel": null,
                "branding": null,
                "appMetadata": null,
                "labels": null,
                "installUrl": null,
                "isAccessible": false,
                "isEnabled": true,
                "pluginDisplayNames": []
            })
        );
        Ok(())
    }

    #[tokio::test]
    #[expect(
        clippy::await_holding_invalid_type,
        reason = "test serializes access to the shared connector cache for its full duration"
    )]
    async fn list_all_connectors_uses_shared_directory_cache() -> anyhow::Result<()> {
        let _cache_guard = CONNECTOR_DIRECTORY_CACHE_TEST_LOCK.lock().await;

        let calls = Arc::new(AtomicUsize::new(0));
        let call_counter = Arc::clone(&calls);
        let codex_home = TempDir::new()?;
        let cache_context = cache_context(&codex_home, "shared");

        let first = list_all_connectors_with_options(
            cache_context.clone(),
            /*is_workspace_account*/ false,
            /*force_refetch*/ false,
            move |_path| {
                let call_counter = Arc::clone(&call_counter);
                async move {
                    call_counter.fetch_add(1, Ordering::SeqCst);
                    Ok(DirectoryListResponse {
                        apps: vec![app("alpha", "Alpha")],
                        next_token: None,
                    })
                }
            },
        )
        .await?;

        let second = list_all_connectors_with_options(
            cache_context,
            /*is_workspace_account*/ false,
            /*force_refetch*/ false,
            move |_path| async move {
                anyhow::bail!("cache should have been used");
            },
        )
        .await?;

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(first, second);
        Ok(())
    }

    #[tokio::test]
    #[expect(
        clippy::await_holding_invalid_type,
        reason = "test serializes access to the shared connector cache for its full duration"
    )]
    async fn list_all_connectors_merges_and_normalizes_directory_apps() -> anyhow::Result<()> {
        let _cache_guard = CONNECTOR_DIRECTORY_CACHE_TEST_LOCK.lock().await;

        let codex_home = TempDir::new()?;
        let cache_context = cache_context(&codex_home, "merged");
        let calls = Arc::new(AtomicUsize::new(0));
        let call_counter = Arc::clone(&calls);

        let connectors = list_all_connectors_with_options(
            cache_context,
            /*is_workspace_account*/ true,
            /*force_refetch*/ true,
            move |path| {
                let call_counter = Arc::clone(&call_counter);
                async move {
                    call_counter.fetch_add(1, Ordering::SeqCst);
                    if path.starts_with("/connectors/directory/list_workspace") {
                        Ok(DirectoryListResponse {
                            apps: vec![
                                DirectoryApp {
                                    description: Some("Merged description".to_string()),
                                    branding: Some(AppBranding {
                                        category: Some("calendar".to_string()),
                                        developer: None,
                                        website: None,
                                        privacy_policy: None,
                                        terms_of_service: None,
                                        is_discoverable_app: true,
                                    }),
                                    ..app("alpha", "")
                                },
                                DirectoryApp {
                                    visibility: Some("HIDDEN".to_string()),
                                    ..app("hidden", "Hidden")
                                },
                            ],
                            next_token: None,
                        })
                    } else {
                        Ok(DirectoryListResponse {
                            apps: vec![app("alpha", " Alpha "), app("beta", "Beta")],
                            next_token: None,
                        })
                    }
                }
            },
        )
        .await?;

        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(connectors.len(), 2);
        assert_eq!(connectors[0].id, "alpha");
        assert_eq!(connectors[0].name, "Alpha");
        assert_eq!(
            connectors[0].description.as_deref(),
            Some("Merged description")
        );
        assert_eq!(
            connectors[0].install_url.as_deref(),
            Some("https://chatgpt.com/apps/alpha/alpha")
        );
        assert_eq!(
            connectors[0]
                .branding
                .as_ref()
                .and_then(|branding| branding.category.as_deref()),
            Some("calendar")
        );
        assert_eq!(connectors[1].id, "beta");
        assert_eq!(connectors[1].name, "Beta");
        Ok(())
    }

    #[tokio::test]
    #[expect(
        clippy::await_holding_invalid_type,
        reason = "test serializes access to the shared connector cache for its full duration"
    )]
    async fn cached_directory_connectors_reads_directory_disk_cache() -> anyhow::Result<()> {
        let _cache_guard = CONNECTOR_DIRECTORY_CACHE_TEST_LOCK.lock().await;

        let codex_home = TempDir::new()?;
        let cache_context = cache_context(&codex_home, "disk");
        let calls = Arc::new(AtomicUsize::new(0));
        let call_counter = Arc::clone(&calls);

        let first = list_all_connectors_with_options(
            cache_context.clone(),
            /*is_workspace_account*/ false,
            /*force_refetch*/ false,
            move |_path| {
                let call_counter = Arc::clone(&call_counter);
                async move {
                    call_counter.fetch_add(1, Ordering::SeqCst);
                    Ok(DirectoryListResponse {
                        apps: vec![app("alpha", "Alpha")],
                        next_token: None,
                    })
                }
            },
        )
        .await?;

        clear_directory_memory_cache();

        let second = cached_directory_connectors(&cache_context).expect("disk cache should load");

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(first, second);
        Ok(())
    }

    #[tokio::test]
    #[expect(
        clippy::await_holding_invalid_type,
        reason = "test serializes access to the shared connector cache for its full duration"
    )]
    async fn list_all_connectors_refreshes_when_only_directory_disk_cache_exists()
    -> anyhow::Result<()> {
        let _cache_guard = CONNECTOR_DIRECTORY_CACHE_TEST_LOCK.lock().await;

        let codex_home = TempDir::new()?;
        let cache_context = cache_context(&codex_home, "disk-refresh");
        let calls = Arc::new(AtomicUsize::new(0));
        let call_counter = Arc::clone(&calls);

        list_all_connectors_with_options(
            cache_context.clone(),
            /*is_workspace_account*/ false,
            /*force_refetch*/ false,
            move |_path| {
                let call_counter = Arc::clone(&call_counter);
                async move {
                    call_counter.fetch_add(1, Ordering::SeqCst);
                    Ok(DirectoryListResponse {
                        apps: vec![app("alpha", "Alpha")],
                        next_token: None,
                    })
                }
            },
        )
        .await?;

        clear_directory_memory_cache();
        let mut cached_expected = directory_app_to_app_info(app("alpha", "Alpha"));
        cached_expected.install_url = Some(connector_install_url(
            &cached_expected.name,
            &cached_expected.id,
        ));
        assert_eq!(
            cached_directory_connectors(&cache_context),
            Some(vec![cached_expected])
        );
        let refreshed_calls = Arc::clone(&calls);

        let refreshed = list_all_connectors_with_options(
            cache_context,
            /*is_workspace_account*/ false,
            /*force_refetch*/ false,
            move |_path| {
                let call_counter = Arc::clone(&refreshed_calls);
                async move {
                    call_counter.fetch_add(1, Ordering::SeqCst);
                    Ok(DirectoryListResponse {
                        apps: vec![app("beta", "Beta")],
                        next_token: None,
                    })
                }
            },
        )
        .await?;

        let mut expected = directory_app_to_app_info(app("beta", "Beta"));
        expected.install_url = Some(connector_install_url(&expected.name, &expected.id));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(refreshed, vec![expected]);
        Ok(())
    }

    #[tokio::test]
    async fn cached_directory_connectors_drops_stale_disk_schema() -> anyhow::Result<()> {
        let _cache_guard = CONNECTOR_DIRECTORY_CACHE_TEST_LOCK.lock().await;

        clear_directory_memory_cache();
        let codex_home = TempDir::new()?;
        let cache_context = cache_context(&codex_home, "stale-schema");
        let cache_path = cache_context.cache_path();
        std::fs::create_dir_all(cache_path.parent().expect("cache parent"))?;
        std::fs::write(
            &cache_path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "schema_version": 0,
                "connectors": [],
            }))?,
        )?;

        assert_eq!(cached_directory_connectors(&cache_context), None);
        assert!(!cache_path.exists());
        Ok(())
    }

    #[tokio::test]
    async fn list_directory_connectors_omits_tier_for_all_pages() -> anyhow::Result<()> {
        let requested_paths: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let paths = Arc::clone(&requested_paths);

        let apps = list_directory_connectors(&mut move |path| {
            let paths = Arc::clone(&paths);
            async move {
                paths
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push(path.clone());
                if path == "/connectors/directory/list?external_logos=true" {
                    Ok(DirectoryListResponse {
                        apps: vec![app("alpha", "Alpha")],
                        next_token: Some("page 2".to_string()),
                    })
                } else {
                    assert_eq!(
                        path,
                        "/connectors/directory/list?token=page%202&external_logos=true"
                    );
                    Ok(DirectoryListResponse {
                        apps: vec![app("beta", "Beta")],
                        next_token: None,
                    })
                }
            }
        })
        .await?;

        assert_eq!(
            apps.iter().map(|app| app.id.as_str()).collect::<Vec<_>>(),
            vec!["alpha", "beta"]
        );
        assert_eq!(
            requested_paths
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .as_slice(),
            &[
                "/connectors/directory/list?external_logos=true".to_string(),
                "/connectors/directory/list?token=page%202&external_logos=true".to_string(),
            ]
        );
        Ok(())
    }
}
