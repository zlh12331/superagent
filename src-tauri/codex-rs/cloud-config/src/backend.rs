use codex_backend_client::Client as BackendClient;
use codex_backend_client::ConfigBundleResponse;
use codex_backend_client::DeliveredTomlFragment;
use codex_config::CloudConfigBundle;
use codex_config::CloudConfigFragment;
use codex_config::CloudConfigTomlBundle;
use codex_config::CloudRequirementsFragment;
use codex_config::CloudRequirementsTomlBundle;
use codex_login::CodexAuth;
use std::future::Future;

/// 可重试失败的具体种类。
///
/// 用于在 service 层决定是否进行退避重试以及上报哪种状态码指标。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RetryableFailureKind {
    /// 后端 client 初始化失败（例如构造 reqwest client 失败）。
    BackendClientInit,
    /// 请求已发出但返回了可重试的错误，可携带 HTTP 状态码。
    Request { status_code: Option<u16> },
}

impl RetryableFailureKind {
    /// 返回该失败种类对应的 HTTP 状态码（若存在）。
    pub(crate) fn status_code(self) -> Option<u16> {
        match self {
            Self::BackendClientInit => None,
            Self::Request { status_code } => status_code,
        }
    }
}

/// 从后端请求 bundle 时可能产生的错误。
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum BundleRequestError {
    /// 可重试错误，由 service 层根据退避策略重试。
    Retryable(RetryableFailureKind),
    /// 鉴权失败（401 类响应），需要触发 token 刷新或要求用户重新登录。
    Unauthorized {
        status_code: Option<u16>,
        message: String,
    },
}

/// 从后端拉取一份云端配置 bundle。
///
/// 实现应原样返回后端选择的 bundle，将校验、缓存以及 config/requirements
/// 解析决策交给 service 层处理，从而保持 backend 实现的可替换性。
pub(crate) trait BundleClient: Send + Sync {
    fn get_bundle(
        &self,
        auth: &CodexAuth,
    ) -> impl Future<Output = Result<CloudConfigBundle, BundleRequestError>> + Send;
}

/// 基于 `codex_backend_client` 的默认 backend 实现。
pub(crate) struct BackendBundleClient {
    base_url: String,
}

impl BackendBundleClient {
    /// 创建一个指向指定 base URL 的 backend client。
    pub(crate) fn new(base_url: String) -> Self {
        Self { base_url }
    }
}

impl BundleClient for BackendBundleClient {
    async fn get_bundle(&self, auth: &CodexAuth) -> Result<CloudConfigBundle, BundleRequestError> {
        let client = BackendClient::from_auth(self.base_url.clone(), auth)
            .inspect_err(|err| {
                tracing::warn!(
                    error = %err,
                    "Failed to construct backend client for cloud config bundle"
                );
            })
            .map_err(|_| BundleRequestError::Retryable(RetryableFailureKind::BackendClientInit))?;

        let response = client
            .get_config_bundle()
            .await
            .inspect_err(|err| {
                tracing::warn!(error = %err, "Failed to fetch cloud config bundle");
            })
            .map_err(|err| {
                let status_code = err.status().map(|status| status.as_u16());
                if err.is_unauthorized() {
                    BundleRequestError::Unauthorized {
                        status_code,
                        message: err.to_string(),
                    }
                } else {
                    BundleRequestError::Retryable(RetryableFailureKind::Request { status_code })
                }
            })?;

        Ok(bundle_from_response(response))
    }
}

/// 将 backend 响应转换为 [`CloudConfigBundle`]，仅保留 enterprise_managed 片段。
pub(crate) fn bundle_from_response(response: ConfigBundleResponse) -> CloudConfigBundle {
    let config_toml = response
        .config_toml
        .flatten()
        .map(|config_toml| *config_toml)
        .and_then(|config_toml| config_toml.enterprise_managed.flatten())
        .unwrap_or_default()
        .into_iter()
        .map(config_fragment_from_delivered)
        .collect();
    let requirements_toml = response
        .requirements_toml
        .flatten()
        .map(|requirements_toml| *requirements_toml)
        .and_then(|requirements_toml| requirements_toml.enterprise_managed.flatten())
        .unwrap_or_default()
        .into_iter()
        .map(requirements_fragment_from_delivered)
        .collect();

    CloudConfigBundle {
        config_toml: CloudConfigTomlBundle {
            enterprise_managed: config_toml,
        },
        requirements_toml: CloudRequirementsTomlBundle {
            enterprise_managed: requirements_toml,
        },
    }
}

fn config_fragment_from_delivered(fragment: DeliveredTomlFragment) -> CloudConfigFragment {
    CloudConfigFragment {
        id: fragment.id,
        name: fragment.name,
        contents: fragment.contents,
    }
}

fn requirements_fragment_from_delivered(
    fragment: DeliveredTomlFragment,
) -> CloudRequirementsFragment {
    CloudRequirementsFragment {
        id: fragment.id,
        name: fragment.name,
        contents: fragment.contents,
    }
}
