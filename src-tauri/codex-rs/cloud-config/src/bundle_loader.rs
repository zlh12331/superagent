use crate::backend::BackendBundleClient;
use crate::service::CLOUD_CONFIG_BUNDLE_TIMEOUT;
use crate::service::CloudConfigBundleService;
use codex_config::CloudConfigBundleLoadError;
use codex_config::CloudConfigBundleLoadErrorCode;
use codex_config::CloudConfigBundleLoader;
use codex_config::types::AuthCredentialsStoreMode;
use codex_login::AuthKeyringBackendKind;
use codex_login::AuthManager;
use codex_login::AuthRouteConfig;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use tokio::task::JoinHandle;

/// 进程级单例：用于持有后台缓存刷新任务句柄。
///
/// 重复调用 [`cloud_config_bundle_loader`] 时，会终止旧任务再启动新任务，
/// 避免多个刷新循环并存。
fn refresher_task_slot() -> &'static Mutex<Option<JoinHandle<()>>> {
    static REFRESHER_TASK: OnceLock<Mutex<Option<JoinHandle<()>>>> = OnceLock::new();
    REFRESHER_TASK.get_or_init(|| Mutex::new(None))
}

/// 构建默认的云端配置 bundle 加载器。
///
/// 流程：
/// 1. 创建 [`CloudConfigBundleService`]，绑定 [`BackendBundleClient`] 与默认超时。
/// 2. 启动一个 tokio task 执行启动期加载（受超时约束）。
/// 3. 启动一个后台 task 周期性刷新缓存；重复调用时会终止旧的刷新 task。
/// 4. 返回 [`CloudConfigBundleLoader`]，调用方通过其 await 启动期加载结果。
pub fn cloud_config_bundle_loader(
    auth_manager: Arc<AuthManager>,
    chatgpt_base_url: String,
    codex_home: PathBuf,
) -> CloudConfigBundleLoader {
    let service = CloudConfigBundleService::new(
        auth_manager,
        Arc::new(BackendBundleClient::new(chatgpt_base_url)),
        codex_home,
        CLOUD_CONFIG_BUNDLE_TIMEOUT,
    );
    let refresh_service = service.clone();
    let task = tokio::spawn(async move { service.load_startup_bundle_with_timeout().await });
    let refresh_task =
        tokio::spawn(async move { refresh_service.refresh_cache_in_background().await });
    let mut refresher_guard = refresher_task_slot().lock().unwrap_or_else(|err| {
        tracing::warn!("cloud config bundle refresher task slot was poisoned");
        err.into_inner()
    });
    if let Some(existing_task) = refresher_guard.replace(refresh_task) {
        existing_task.abort();
    }
    CloudConfigBundleLoader::new(async move {
        task.await.map_err(|err| {
            tracing::error!(error = %err, "Cloud config bundle task failed");
            CloudConfigBundleLoadError::new(
                CloudConfigBundleLoadErrorCode::Internal,
                /*status_code*/ None,
                format!("cloud config bundle load failed: {err}"),
            )
        })?
    })
}

/// 为存储层场景构建云端配置 bundle 加载器。
///
/// 与 [`cloud_config_bundle_loader`] 的区别在于：本函数会先基于给定的存储参数
/// 构建一个共享的 [`AuthManager`]，然后再委托给 [`cloud_config_bundle_loader`]。
///
/// 参数：
/// - `codex_home`：用户主目录，用于缓存与凭据存储。
/// - `enable_codex_api_key_env`：是否允许从环境变量读取 Codex API key。
/// - `credentials_store_mode`：凭据存储模式（keyring 或文件）。
/// - `keyring_backend_kind`：keyring 后端类型（平台相关）。
/// - `chatgpt_base_url`：ChatGPT backend 基础 URL。
/// - `auth_route_config`：可选的鉴权路由配置。
pub async fn cloud_config_bundle_loader_for_storage(
    codex_home: PathBuf,
    enable_codex_api_key_env: bool,
    credentials_store_mode: AuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
    chatgpt_base_url: String,
    auth_route_config: Option<AuthRouteConfig>,
) -> CloudConfigBundleLoader {
    let auth_manager = AuthManager::shared(
        codex_home.clone(),
        enable_codex_api_key_env,
        credentials_store_mode,
        /*forced_chatgpt_workspace_id*/ None,
        Some(chatgpt_base_url.clone()),
        keyring_backend_kind,
        auth_route_config,
    )
    .await;
    cloud_config_bundle_loader(auth_manager, chatgpt_base_url, codex_home)
}
