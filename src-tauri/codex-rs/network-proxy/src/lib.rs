//! 网络代理（network proxy）crate。
//!
//! 提供 Codex 的本地网络代理能力：包括 MITM TLS 解密、网络策略决策、
//! 凭据代理、HTTP/HTTPS/SOCKS5 代理支持以及运行时状态管理。该 crate
//! 作为 codex-core 的可选增强组件，被 codex-tui 与 codex-desktop 集成。
//!
//! 主要模块：
//! - [`certs`]：MITM CA 证书与信任束管理
//! - [`config`]：网络代理配置数据结构
//! - [`mitm`]：MITM 拦截与解密
//! - [`policy`] / [`network_policy`]：网络策略与决策
//! - [`proxy`]：代理服务器构建与生命周期
//! - [`runtime`]：运行时状态、配置热加载与请求拦截
//! - [`socks5`]：SOCKS5 代理支持
//! - [`state`]：网络代理状态与约束
//! - [`upstream`]：上游连接管理
//! - [`credential_broker`]：凭据代理（按 provider 注入 token）

#![deny(clippy::print_stdout, clippy::print_stderr)]

mod certs;
mod config;
mod connect_policy;
mod credential_broker;
mod http_proxy;
mod mitm;
mod mitm_hook;
mod native_certs;
mod network_policy;
mod policy;
mod proxy;
mod reasons;
mod responses;
mod runtime;
mod socks5;
mod state;
mod upstream;

pub use certs::CUSTOM_CA_ENV_KEYS;
pub use certs::is_managed_mitm_ca_trust_bundle_path;
pub use config::NetworkDomainPermission;
pub use config::NetworkDomainPermissionEntry;
pub use config::NetworkDomainPermissions;
pub use config::NetworkMode;
pub use config::NetworkProxyConfig;
pub use config::NetworkUnixSocketPermission;
pub use config::NetworkUnixSocketPermissions;
pub use config::host_and_port_from_network_addr;
pub use credential_broker::CREDENTIAL_BROKER_ACTIVE_ENV_KEY;
pub use credential_broker::brokered_credential_dummy_env_keys;
pub use credential_broker::brokered_credential_env_keys;
pub use mitm_hook::InjectedHeaderConfig;
pub use mitm_hook::MitmHookActionsConfig;
pub use mitm_hook::MitmHookBodyConfig;
pub use mitm_hook::MitmHookConfig;
pub use mitm_hook::MitmHookMatchConfig;
pub use network_policy::NetworkDecision;
pub use network_policy::NetworkDecisionSource;
pub use network_policy::NetworkPolicyDecider;
pub use network_policy::NetworkPolicyDeciderFuture;
pub use network_policy::NetworkPolicyDecision;
pub use network_policy::NetworkPolicyRequest;
pub use network_policy::NetworkPolicyRequestArgs;
pub use network_policy::NetworkProtocol;
pub use policy::normalize_host;
pub use proxy::ALL_PROXY_ENV_KEYS;
pub use proxy::ALLOW_LOCAL_BINDING_ENV_KEY;
pub use proxy::Args;
#[cfg(target_os = "macos")]
pub use proxy::CODEX_PROXY_GIT_SSH_COMMAND_MARKER;
pub use proxy::DEFAULT_NO_PROXY_VALUE;
pub use proxy::ManagedNetworkSandboxContext;
pub use proxy::NO_PROXY_ENV_KEYS;
pub use proxy::NetworkProxy;
pub use proxy::NetworkProxyBuilder;
pub use proxy::NetworkProxyHandle;
pub use proxy::PROXY_ACTIVE_ENV_KEY;
pub use proxy::PROXY_ENV_KEYS;
#[cfg(target_os = "macos")]
pub use proxy::PROXY_GIT_SSH_COMMAND_ENV_KEY;
pub use proxy::PROXY_URL_ENV_KEYS;
pub use proxy::PreparedManagedNetwork;
pub use proxy::has_proxy_url_env_vars;
pub use proxy::proxy_url_env_value;
pub use runtime::BlockedRequest;
pub use runtime::BlockedRequestArgs;
pub use runtime::BlockedRequestObserver;
pub use runtime::BlockedRequestObserverFuture;
pub use runtime::ConfigReloader;
pub use runtime::ConfigReloaderFuture;
pub use runtime::ConfigState;
pub use runtime::NetworkProxyState;
pub use state::NetworkProxyAuditMetadata;
pub use state::NetworkProxyConstraintError;
pub use state::NetworkProxyConstraints;
pub use state::PartialNetworkConfig;
pub use state::PartialNetworkProxyConfig;
pub use state::build_config_state;
pub use state::validate_policy_against_constraints;
