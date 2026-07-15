//! Cloud config bundle（云配置包）的领域模型与共享内存加载器。
//!
//! 后端 bundle 将云端下发的 config 与 requirements 片段按来源桶分组。
//! [`CloudConfigBundleLayers`] 将这些原始桶转换为层条目，同时保留每个桶
//! 的插入语义（如优先级顺序）。

use crate::CloudConfigFragment;
use crate::ConfigLayerEntry;
use crate::RequirementSource;
use crate::RequirementsLayerEntry;
use crate::cloud_config_layers::CloudConfigLayerError;
use crate::cloud_config_layers::cloud_config_layers_from_fragments_strict;
use crate::cloud_config_layers_from_fragments;
use codex_utils_absolute_path::AbsolutePathBuf;
use futures::future::BoxFuture;
use futures::future::FutureExt;
use futures::future::Shared;
use serde::Deserialize;
use serde::Serialize;
use std::fmt;
use std::future::Future;
use thiserror::Error;

/// 从后端获取的云配置包，包含 config 与 requirements 两类片段。
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct CloudConfigBundle {
    /// config.toml 片段桶。
    pub config_toml: CloudConfigTomlBundle,
    /// requirements.toml 片段桶。
    pub requirements_toml: CloudRequirementsTomlBundle,
}

impl CloudConfigBundle {
    /// 返回是否 config 与 requirements 桶都为空。
    pub fn is_empty(&self) -> bool {
        let CloudConfigBundle {
            config_toml,
            requirements_toml,
        } = self;
        let CloudConfigTomlBundle {
            enterprise_managed: config_enterprise_managed,
        } = config_toml;
        let CloudRequirementsTomlBundle {
            enterprise_managed: requirements_enterprise_managed,
        } = requirements_toml;

        config_enterprise_managed.is_empty() && requirements_enterprise_managed.is_empty()
    }
}

/// config.toml 片段桶，按来源分类。
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct CloudConfigTomlBundle {
    /// 企业受管来源的 config 片段列表。
    pub enterprise_managed: Vec<CloudConfigFragment>,
}

/// requirements.toml 片段桶，按来源分类。
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct CloudRequirementsTomlBundle {
    /// 企业受管来源的 requirements 片段列表。
    pub enterprise_managed: Vec<CloudRequirementsFragment>,
}

/// 单个 requirements 片段，携带标识与原始 TOML 内容。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CloudRequirementsFragment {
    /// 片段的稳定标识符。
    pub id: String,
    /// 管理员面向的显示名称。
    pub name: String,
    /// 原始 TOML 文本内容。
    pub contents: String,
}

/// 云配置包转换为语义层桶后的结果。
///
/// 这不是最终的配置栈。调用方仍需决定每个桶相对于
/// local/system/user 层的插入位置。
#[derive(Clone, Debug)]
pub struct CloudConfigBundleLayers {
    /// 企业受管 config 层，按 `ConfigLayerStack` 顺序排列。
    pub enterprise_managed_config: Vec<ConfigLayerEntry>,
    /// 企业受管 requirements 层，按 requirements 层合并顺序排列。
    pub enterprise_managed_requirements: Vec<RequirementsLayerEntry>,
}

impl CloudConfigBundleLayers {
    /// 从 bundle 转换为层桶（非严格模式）。
    ///
    /// `base_dir` 用于解析片段中的相对路径。
    ///
    /// # Errors
    /// 透传 `cloud_config_layers_from_fragments` 的解析错误。
    pub fn from_bundle(
        bundle: CloudConfigBundle,
        base_dir: &AbsolutePathBuf,
    ) -> Result<Self, CloudConfigLayerError> {
        Self::from_bundle_impl(bundle, base_dir, /*strict_config*/ false)
    }

    /// 从 bundle 转换为层桶（严格模式，检测未知字段）。
    ///
    /// # Errors
    /// 透传 `cloud_config_layers_from_fragments_strict` 的解析或校验错误。
    pub fn from_bundle_strict_config(
        bundle: CloudConfigBundle,
        base_dir: &AbsolutePathBuf,
    ) -> Result<Self, CloudConfigLayerError> {
        Self::from_bundle_impl(bundle, base_dir, /*strict_config*/ true)
    }

    /// `from_bundle` 与 `from_bundle_strict_config` 的共享实现。
    ///
    /// 使用穷尽解构确保新增 bundle 桶时强制显式选择如何转换为层数据。
    fn from_bundle_impl(
        bundle: CloudConfigBundle,
        base_dir: &AbsolutePathBuf,
        strict_config: bool,
    ) -> Result<Self, CloudConfigLayerError> {
        // 保持解构穷尽，确保新增 bundle 桶时强制显式选择如何转换为层数据。
        let CloudConfigBundle {
            config_toml:
                CloudConfigTomlBundle {
                    enterprise_managed: config_enterprise_managed,
                },
            requirements_toml:
                CloudRequirementsTomlBundle {
                    enterprise_managed: requirements_enterprise_managed,
                },
        } = bundle;

        let enterprise_managed_config = if strict_config {
            cloud_config_layers_from_fragments_strict(config_enterprise_managed, base_dir)?
        } else {
            cloud_config_layers_from_fragments(config_enterprise_managed, base_dir)?
        };

        let mut enterprise_managed_requirements = requirements_enterprise_managed
            .into_iter()
            .map(|fragment| {
                RequirementsLayerEntry::from_toml(
                    RequirementSource::EnterpriseManaged {
                        id: fragment.id,
                        name: fragment.name,
                    },
                    fragment.contents,
                )
                .with_base_dir(base_dir.clone())
            })
            .collect::<Vec<_>>();
        // bundle 片段按最高优先级优先到达，
        // 而 requirements 层按最低优先级到最高优先级合并，
        // 因此需要反转顺序。
        enterprise_managed_requirements.reverse();

        Ok(Self {
            enterprise_managed_config,
            enterprise_managed_requirements,
        })
    }
}

/// 云配置包加载错误的稳定分类码。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CloudConfigBundleLoadErrorCode {
    /// 鉴权失败。
    Auth,
    /// 请求超时。
    Timeout,
    /// 请求失败（非鉴权、非超时）。
    RequestFailed,
    /// bundle 内容无效。
    InvalidBundle,
    /// 内部错误。
    Internal,
}

/// 云配置包加载错误，携带分类码、HTTP 状态码与人类可读消息。
#[derive(Clone, Debug, Eq, Error, PartialEq)]
#[error("{message}")]
pub struct CloudConfigBundleLoadError {
    code: CloudConfigBundleLoadErrorCode,
    message: String,
    status_code: Option<u16>,
}

impl CloudConfigBundleLoadError {
    /// 构造一个新的加载错误。
    pub fn new(
        code: CloudConfigBundleLoadErrorCode,
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
    pub fn code(&self) -> CloudConfigBundleLoadErrorCode {
        self.code
    }

    /// 返回 HTTP 状态码（若来自 HTTP 响应）。
    pub fn status_code(&self) -> Option<u16> {
        self.status_code
    }
}

/// 云配置包加载器，封装一次共享的异步加载 future。
///
/// 通过 `Shared` future 允许多个调用方等待同一次加载结果，
/// 避免重复请求后端。
#[derive(Clone)]
pub struct CloudConfigBundleLoader {
    fut: Shared<BoxFuture<'static, Result<Option<CloudConfigBundle>, CloudConfigBundleLoadError>>>,
}

impl CloudConfigBundleLoader {
    /// 构造一个加载器，封装给定的 future。
    ///
    /// future 会被装箱并共享化，使多次 `get` 调用复用同一次加载。
    pub fn new<F>(fut: F) -> Self
    where
        F: Future<Output = Result<Option<CloudConfigBundle>, CloudConfigBundleLoadError>>
            + Send
            + 'static,
    {
        Self {
            fut: fut.boxed().shared(),
        }
    }

    /// 等待加载完成并返回结果。
    ///
    /// 多次调用会复用同一个底层 future，不会触发重复加载。
    pub async fn get(&self) -> Result<Option<CloudConfigBundle>, CloudConfigBundleLoadError> {
        self.fut.clone().await
    }
}

impl fmt::Debug for CloudConfigBundleLoader {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CloudConfigBundleLoader").finish()
    }
}

impl Default for CloudConfigBundleLoader {
    fn default() -> Self {
        // 默认加载器立即返回 `Ok(None)`，表示无云配置可用。
        Self::new(async { Ok(None) })
    }
}

#[cfg(test)]
#[path = "cloud_config_bundle_tests.rs"]
mod tests;
