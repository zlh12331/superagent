//! 认证层出站代理（proxy）配置适配器。
//!
//! 将客户端层的 `OutboundProxyConfig` 适配到认证模块使用，
//! 避免 `codex-login` 直接依赖 `codex-client` 的具体实现。

use codex_client::OutboundProxyConfig;

/// 认证层使用的代理路由配置适配器。
///
/// [`AuthConfig`](crate::AuthConfig) 持有此配置，端点解析与平台细节
/// 仍保留在 client 层，这里只透出认证调用所需的极简接口。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthRouteConfig {
    route_config: OutboundProxyConfig,
}

impl AuthRouteConfig {
    /// 创建一个尊重系统代理设置的 [`AuthRouteConfig`]。
    pub fn respect_system_proxy() -> Self {
        Self {
            route_config: OutboundProxyConfig::respect_system_proxy(),
        }
    }

    /// 返回内部 `OutboundProxyConfig` 的不可变引用。
    pub(crate) fn route_config(&self) -> &OutboundProxyConfig {
        &self.route_config
    }
}
