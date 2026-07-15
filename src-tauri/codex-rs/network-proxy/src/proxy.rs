//! 网络代理主入口模块。
//!
//! 提供 [`NetworkProxy`] 与 [`NetworkProxyBuilder`] 用于构建和运行 HTTP/SOCKS5 代理：
//! - 预留 loopback 监听端口（Windows 上使用托管端口，失败时回退到临时端口）
//! - 生成子进程环境变量（HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY 等）
//! - 维护按 environment_id 隔离的代理实例，支持多环境并行使用
//! - 暴露 [`NetworkProxyHandle`] 用于 await 与 shutdown
//!
//! 同时导出供 OS 沙箱使用的便携上下文 [`ManagedNetworkSandboxContext`] 与
//! [`PreparedManagedNetwork`]，确保沙箱规则与代理端口保持同步。

use crate::config;
use crate::credential_broker::BROKERED_CREDENTIALS_ENV_KEY;
use crate::credential_broker::CREDENTIAL_BROKER_ACTIVE_ENV_KEY;
use crate::http_proxy;
use crate::network_policy::NetworkPolicyDecider;
use crate::runtime::BlockedRequestObserver;
use crate::runtime::ConfigState;
use crate::runtime::unix_socket_permissions_supported;
use crate::socks5;
use crate::state::NetworkProxyState;
use anyhow::Context;
use anyhow::Result;
use clap::Parser;
use codex_utils_absolute_path::AbsolutePathBuf;
use serde::Deserialize;
use serde::Serialize;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::net::TcpListener as StdTcpListener;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::RwLock;
use tokio::task::JoinHandle;
use tracing::warn;

/// CLI 入口参数：当前命令未暴露任何选项，仅作为 clap 解析的占位。
#[derive(Debug, Clone, Parser)]
#[command(name = "codex-network-proxy", about = "Codex network sandbox proxy")]
pub struct Args {}

/// 预留的 loopback 监听器集合（线程安全包装）。
///
/// 用于在代理启动前抢占端口，避免子进程在代理就绪前发起连接。
/// 通过 `Mutex<Option<...>>` 支持一次性取出语义。
#[derive(Debug)]
struct ReservedListeners {
    /// HTTP 代理监听器
    http: Mutex<Option<StdTcpListener>>,
    /// SOCKS5 代理监听器（未启用 SOCKS5 时为 None）
    socks: Mutex<Option<StdTcpListener>>,
}

impl ReservedListeners {
    /// 创建新的预留监听器集合。
    fn new(http: StdTcpListener, socks: Option<StdTcpListener>) -> Self {
        Self {
            http: Mutex::new(Some(http)),
            socks: Mutex::new(socks),
        }
    }

    /// 一次性取出 HTTP 监听器（后续调用返回 None）。
    /// 锁中毒时使用内部值兜底，保证不阻塞代理启动。
    fn take_http(&self) -> Option<StdTcpListener> {
        let mut guard = self
            .http
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.take()
    }

    /// 一次性取出 SOCKS5 监听器（后续调用返回 None）。
    fn take_socks(&self) -> Option<StdTcpListener> {
        let mut guard = self
            .socks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.take()
    }
}

/// 预留监听器集合的值语义包装：在移交所有权前用于查询本地地址。
struct ReservedListenerSet {
    /// HTTP 代理监听器
    http_listener: StdTcpListener,
    /// SOCKS5 代理监听器
    socks_listener: Option<StdTcpListener>,
}

impl ReservedListenerSet {
    /// 创建新的监听器集合。
    fn new(http_listener: StdTcpListener, socks_listener: Option<StdTcpListener>) -> Self {
        Self {
            http_listener,
            socks_listener,
        }
    }

    /// 读取 HTTP 代理本地地址。
    fn http_addr(&self) -> Result<SocketAddr> {
        self.http_listener
            .local_addr()
            .context("failed to read reserved HTTP proxy address")
    }

    /// 读取 SOCKS5 代理本地地址；未启用 SOCKS5 时返回传入的默认地址。
    fn socks_addr(&self, default_addr: SocketAddr) -> Result<SocketAddr> {
        self.socks_listener
            .as_ref()
            .map_or(Ok(default_addr), |listener| {
                listener
                    .local_addr()
                    .context("failed to read reserved SOCKS5 proxy address")
            })
    }

    /// 将监听器移交为线程安全的 [`ReservedListeners`]，供异步任务后续取用。
    fn into_reserved_listeners(self) -> Arc<ReservedListeners> {
        Arc::new(ReservedListeners::new(
            self.http_listener,
            self.socks_listener,
        ))
    }
}

/// 网络代理构建器：以链式调用方式配置 [`NetworkProxy`]。
///
/// 默认 `managed_by_codex = true`，即由 Codex 托管监听 loopback 临时端口；
/// 若设为 false，则使用调用者显式传入的地址（用于非 Codex 托管场景）。
#[derive(Clone)]
pub struct NetworkProxyBuilder {
    /// 共享的代理状态（必填）
    state: Option<Arc<NetworkProxyState>>,
    /// 调用者指定的 HTTP 代理地址（非 Codex 托管时使用）
    http_addr: Option<SocketAddr>,
    /// 调用者指定的 SOCKS5 代理地址（非 Codex 托管时使用）
    socks_addr: Option<SocketAddr>,
    /// 是否由 Codex 托管端口分配
    managed_by_codex: bool,
    /// 可选的网络策略决策器
    policy_decider: Option<Arc<dyn NetworkPolicyDecider>>,
    /// 可选的被阻塞请求观察者
    blocked_request_observer: Option<Arc<dyn BlockedRequestObserver>>,
}

impl Default for NetworkProxyBuilder {
    fn default() -> Self {
        Self {
            state: None,
            http_addr: None,
            socks_addr: None,
            managed_by_codex: true,
            policy_decider: None,
            blocked_request_observer: None,
        }
    }
}

impl NetworkProxyBuilder {
    /// 设置共享的代理状态（必填）。
    pub fn state(mut self, state: Arc<NetworkProxyState>) -> Self {
        self.state = Some(state);
        self
    }

    /// 设置 HTTP 代理地址（仅当 `managed_by_codex = false` 时生效）。
    pub fn http_addr(mut self, addr: SocketAddr) -> Self {
        self.http_addr = Some(addr);
        self
    }

    /// 设置 SOCKS5 代理地址（仅当 `managed_by_codex = false` 时生效）。
    pub fn socks_addr(mut self, addr: SocketAddr) -> Self {
        self.socks_addr = Some(addr);
        self
    }

    /// 设置是否由 Codex 托管端口分配（默认 true）。
    pub fn managed_by_codex(mut self, managed_by_codex: bool) -> Self {
        self.managed_by_codex = managed_by_codex;
        self
    }

    /// 设置网络策略决策器（值语义，内部会包装为 `Arc`）。
    pub fn policy_decider<D>(mut self, decider: D) -> Self
    where
        D: NetworkPolicyDecider,
    {
        self.policy_decider = Some(Arc::new(decider));
        self
    }

    /// 设置网络策略决策器（已包装为 `Arc`）。
    pub fn policy_decider_arc(mut self, decider: Arc<dyn NetworkPolicyDecider>) -> Self {
        self.policy_decider = Some(decider);
        self
    }

    /// 设置被阻塞请求观察者（值语义）。
    pub fn blocked_request_observer<O>(mut self, observer: O) -> Self
    where
        O: BlockedRequestObserver,
    {
        self.blocked_request_observer = Some(Arc::new(observer));
        self
    }

    /// 设置被阻塞请求观察者（已包装为 `Arc`）。
    pub fn blocked_request_observer_arc(
        mut self,
        observer: Arc<dyn BlockedRequestObserver>,
    ) -> Self {
        self.blocked_request_observer = Some(observer);
        self
    }

    /// 构建并返回 [`NetworkProxy`]。
    ///
    /// 若 `managed_by_codex = true`，会预留 loopback 临时端口；Windows 上
    /// 优先使用托管端口，失败时回退到临时端口。最后会对绑定地址再次执行
    /// `clamp_bind_addrs`，确保 unix-socket 代理仅监听 loopback。
    pub async fn build(self) -> Result<NetworkProxy> {
        let state = self.state.ok_or_else(|| {
            anyhow::anyhow!(
                "NetworkProxyBuilder requires a state; supply one via builder.state(...)"
            )
        })?;
        state
            .set_blocked_request_observer(self.blocked_request_observer.clone())
            .await;
        let current_cfg = state.current_cfg().await?;
        let (requested_http_addr, requested_socks_addr, reserved_listeners) = if self
            .managed_by_codex
        {
            let runtime = config::resolve_runtime(&current_cfg)?;
            #[cfg(target_os = "windows")]
            let (managed_http_addr, managed_socks_addr) = config::clamp_bind_addrs(
                runtime.http_addr,
                runtime.socks_addr,
                &current_cfg.network,
            );
            #[cfg(target_os = "windows")]
            let reserved = reserve_windows_managed_listeners(
                managed_http_addr,
                managed_socks_addr,
                current_cfg.network.enable_socks5,
            )
            .context("reserve managed loopback proxy listeners")?;
            #[cfg(not(target_os = "windows"))]
            let reserved = reserve_loopback_ephemeral_listeners(current_cfg.network.enable_socks5)
                .context("reserve managed loopback proxy listeners")?;
            let http_addr = reserved.http_addr()?;
            let socks_addr = reserved.socks_addr(runtime.socks_addr)?;
            (
                http_addr,
                socks_addr,
                Some(reserved.into_reserved_listeners()),
            )
        } else {
            let runtime = config::resolve_runtime(&current_cfg)?;
            (
                self.http_addr.unwrap_or(runtime.http_addr),
                self.socks_addr.unwrap_or(runtime.socks_addr),
                None,
            )
        };

        // Reapply bind clamping for caller overrides so unix-socket proxying stays loopback-only.
        // 对调用者传入的地址再次执行绑定收敛，确保 unix-socket 代理仅监听 loopback。
        let (http_addr, socks_addr) = config::clamp_bind_addrs(
            requested_http_addr,
            requested_socks_addr,
            &current_cfg.network,
        );

        Ok(NetworkProxy {
            state,
            http_addr,
            socks_addr,
            socks_enabled: current_cfg.network.enable_socks5,
            socks5_udp_enabled: current_cfg.network.enable_socks5_udp,
            runtime_settings: Arc::new(RwLock::new(NetworkProxyRuntimeSettings::from_config(
                &current_cfg,
            )?)),
            reserved_listeners,
            policy_decider: self.policy_decider,
            environment_proxies: Arc::new(Mutex::new(HashMap::new())),
        })
    }
}

/// 预留 HTTP 与可选的 SOCKS5 loopback 临时端口监听器。
///
/// 操作系统会自动分配可用端口（端口 0），调用方随后通过 `local_addr()` 读取实际端口。
fn reserve_loopback_ephemeral_listeners(
    reserve_socks_listener: bool,
) -> Result<ReservedListenerSet> {
    let http_listener =
        reserve_loopback_ephemeral_listener().context("reserve HTTP proxy listener")?;
    let socks_listener = if reserve_socks_listener {
        Some(reserve_loopback_ephemeral_listener().context("reserve SOCKS5 proxy listener")?)
    } else {
        None
    };
    Ok(ReservedListenerSet::new(http_listener, socks_listener))
}

/// Windows 专用：尝试绑定托管端口；若端口被占用，则回退到临时端口。
#[cfg(target_os = "windows")]
fn reserve_windows_managed_listeners(
    http_addr: SocketAddr,
    socks_addr: SocketAddr,
    reserve_socks_listener: bool,
) -> Result<ReservedListenerSet> {
    let http_addr = windows_managed_loopback_addr(http_addr);
    let socks_addr = windows_managed_loopback_addr(socks_addr);

    match try_reserve_windows_managed_listeners(http_addr, socks_addr, reserve_socks_listener) {
        Ok(listeners) => Ok(listeners),
        Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => {
            warn!("managed Windows proxy ports are busy; falling back to ephemeral loopback ports");
            reserve_loopback_ephemeral_listeners(reserve_socks_listener)
                .context("reserve fallback loopback proxy listeners")
        }
        Err(err) => Err(err).context("reserve Windows managed proxy listeners"),
    }
}

/// Windows 专用：尝试绑定到指定的托管端口（非临时端口）。
#[cfg(target_os = "windows")]
fn try_reserve_windows_managed_listeners(
    http_addr: SocketAddr,
    socks_addr: SocketAddr,
    reserve_socks_listener: bool,
) -> std::io::Result<ReservedListenerSet> {
    let http_listener = StdTcpListener::bind(http_addr)?;
    let socks_listener = if reserve_socks_listener {
        Some(StdTcpListener::bind(socks_addr)?)
    } else {
        None
    };
    Ok(ReservedListenerSet::new(http_listener, socks_listener))
}

/// Windows 专用：将任意地址收敛为 `127.0.0.1:<port>`，确保托管代理仅监听 loopback。
#[cfg(target_os = "windows")]
fn windows_managed_loopback_addr(addr: SocketAddr) -> SocketAddr {
    if !addr.ip().is_loopback() {
        warn!(
            "managed Windows proxies must bind to loopback; clamping {addr} to 127.0.0.1:{}",
            addr.port()
        );
    }
    SocketAddr::from(([127, 0, 0, 1], addr.port()))
}

/// 绑定一个 loopback 临时端口（端口 0），由操作系统自动分配可用端口。
fn reserve_loopback_ephemeral_listener() -> Result<StdTcpListener> {
    StdTcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .context("bind loopback ephemeral port")
}

/// 运行时设置快照：从配置派生，用于环境变量生成与沙箱上下文构建。
#[derive(Debug, Clone, PartialEq, Eq)]
struct NetworkProxyRuntimeSettings {
    /// 是否允许子进程绑定本地端口
    allow_local_binding: bool,
    /// 允许的 Unix socket 路径列表
    allow_unix_sockets: Arc<[String]>,
    /// 是否允许所有 Unix socket（危险选项）
    dangerously_allow_all_unix_sockets: bool,
    /// MITM CA 信任包路径（仅启用 MITM 时存在）
    mitm_ca_trust_bundle: Option<crate::certs::ManagedMitmCaTrustBundle>,
}

impl NetworkProxyRuntimeSettings {
    /// 从网络代理配置派生运行时设置。
    ///
    /// 若启用 MITM，会读取进程环境中的 CA 配置并加载托管信任包。
    fn from_config(config: &config::NetworkProxyConfig) -> Result<Self> {
        let mitm_ca_trust_bundle = if config.network.mitm {
            let env = crate::certs::ca_env_from_process();
            Some(crate::certs::managed_ca_trust_bundle(&env)?)
        } else {
            None
        };
        Ok(Self {
            allow_local_binding: config.network.allow_local_binding,
            allow_unix_sockets: config.network.allow_unix_sockets().into(),
            dangerously_allow_all_unix_sockets: config.network.dangerously_allow_all_unix_sockets,
            mitm_ca_trust_bundle,
        })
    }
}

/// 单个 environment_id 对应的代理地址对。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct EnvironmentProxyAddrs {
    /// HTTP 代理地址
    http_addr: SocketAddr,
    /// SOCKS5 代理地址
    socks_addr: SocketAddr,
}

/// 便携的托管网络事实：供 OS 沙箱使用，与具体平台无关。
///
/// 序列化为 camelCase 以便跨语言（如 TypeScript）消费。
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedNetworkSandboxContext {
    /// 沙箱内命令可连接的 loopback 代理端口列表。
    #[serde(default)]
    pub loopback_ports: Vec<u16>,
    /// 是否允许命令绑定本地 socket 并交换 loopback 流量。
    #[serde(default)]
    pub allow_local_binding: bool,
}

/// 针对单次命令启动准备的环境特定托管网络设置。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreparedManagedNetwork {
    /// 应用托管代理变量后的完整命令环境。
    pub env: HashMap<String, String>,
    /// 与命令环境匹配的便携沙箱输入。
    pub sandbox_context: ManagedNetworkSandboxContext,
}

/// 单个 environment_id 对应的运行中代理实例。
struct EnvironmentProxy {
    /// 代理监听地址对
    addrs: EnvironmentProxyAddrs,
    /// HTTP 代理异步任务句柄
    http_task: JoinHandle<Result<()>>,
    /// SOCKS5 代理异步任务句柄（未启用时为 None）
    socks_task: Option<JoinHandle<Result<()>>>,
}

/// 网络代理：封装 HTTP/SOCKS5 代理的共享状态、监听地址与按环境隔离的代理实例。
///
/// 通过 [`NetworkProxyBuilder`] 构建，调用 [`NetworkProxy::run`] 启动代理任务。
/// 同一 `NetworkProxy` 可为多个 environment_id 派生独立的代理实例，
/// 实现多环境并行使用同一份配置。
#[derive(Clone)]
pub struct NetworkProxy {
    /// 共享的代理状态
    state: Arc<NetworkProxyState>,
    /// 主 HTTP 代理监听地址
    http_addr: SocketAddr,
    /// 主 SOCKS5 代理监听地址
    socks_addr: SocketAddr,
    /// 是否启用 SOCKS5
    socks_enabled: bool,
    /// 是否启用 SOCKS5 UDP 转发
    socks5_udp_enabled: bool,
    /// 运行时设置快照（读写锁保护，支持热更新）
    runtime_settings: Arc<RwLock<NetworkProxyRuntimeSettings>>,
    /// 预留的监听器（Codex 托管模式下存在）
    reserved_listeners: Option<Arc<ReservedListeners>>,
    /// 网络策略决策器
    policy_decider: Option<Arc<dyn NetworkPolicyDecider>>,
    /// 按 environment_id 索引的独立代理实例映射
    environment_proxies: Arc<Mutex<HashMap<String, EnvironmentProxy>>>,
}

impl std::fmt::Debug for NetworkProxy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 避免打印内部状态（配置内容、派生的 GlobSet 等），这些可能产生大量日志
        // 且可能包含敏感路径。
        f.debug_struct("NetworkProxy")
            .field("http_addr", &self.http_addr)
            .field("socks_addr", &self.socks_addr)
            .finish_non_exhaustive()
    }
}

impl PartialEq for NetworkProxy {
    fn eq(&self, other: &Self) -> bool {
        self.http_addr == other.http_addr
            && self.socks_addr == other.socks_addr
            && self.runtime_settings() == other.runtime_settings()
    }
}

impl Eq for NetworkProxy {}

/// 需要清理的代理 URL 环境变量键名列表（含大小写变体与各包管理器专用变量）。
pub const PROXY_URL_ENV_KEYS: &[&str] = &[
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "WS_PROXY",
    "WSS_PROXY",
    "ALL_PROXY",
    "FTP_PROXY",
    "YARN_HTTP_PROXY",
    "YARN_HTTPS_PROXY",
    "NPM_CONFIG_HTTP_PROXY",
    "NPM_CONFIG_HTTPS_PROXY",
    "NPM_CONFIG_PROXY",
    "BUNDLE_HTTP_PROXY",
    "BUNDLE_HTTPS_PROXY",
    "PIP_PROXY",
    "DOCKER_HTTP_PROXY",
    "DOCKER_HTTPS_PROXY",
];

/// `ALL_PROXY` 环境变量键名（含大小写变体）。
pub const ALL_PROXY_ENV_KEYS: &[&str] = &["ALL_PROXY", "all_proxy"];
/// 标识 Codex 网络代理已激活的环境变量键名。
pub const PROXY_ACTIVE_ENV_KEY: &str = "CODEX_NETWORK_PROXY_ACTIVE";
/// 标识是否允许子进程绑定本地端口的环境变量键名。
pub const ALLOW_LOCAL_BINDING_ENV_KEY: &str = "CODEX_NETWORK_ALLOW_LOCAL_BINDING";
/// Electron `electron-get` 使用的代理开关环境变量键名。
const ELECTRON_GET_USE_PROXY_ENV_KEY: &str = "ELECTRON_GET_USE_PROXY";
/// Node.js 内置 HTTP 客户端使用的代理开关环境变量键名。
const NODE_USE_ENV_PROXY_ENV_KEY: &str = "NODE_USE_ENV_PROXY";
#[cfg(any(target_os = "macos", test))]
const GIT_SSH_COMMAND_ENV_KEY: &str = "GIT_SSH_COMMAND";
/// 需要在子进程环境中设置/清理的全部代理相关环境变量键名列表。
pub const PROXY_ENV_KEYS: &[&str] = &[
    PROXY_ACTIVE_ENV_KEY,
    CREDENTIAL_BROKER_ACTIVE_ENV_KEY,
    BROKERED_CREDENTIALS_ENV_KEY,
    ALLOW_LOCAL_BINDING_ENV_KEY,
    ELECTRON_GET_USE_PROXY_ENV_KEY,
    NODE_USE_ENV_PROXY_ENV_KEY,
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "YARN_HTTP_PROXY",
    "YARN_HTTPS_PROXY",
    "npm_config_http_proxy",
    "npm_config_https_proxy",
    "npm_config_proxy",
    "NPM_CONFIG_HTTP_PROXY",
    "NPM_CONFIG_HTTPS_PROXY",
    "NPM_CONFIG_PROXY",
    "BUNDLE_HTTP_PROXY",
    "BUNDLE_HTTPS_PROXY",
    "PIP_PROXY",
    "DOCKER_HTTP_PROXY",
    "DOCKER_HTTPS_PROXY",
    "WS_PROXY",
    "WSS_PROXY",
    "ws_proxy",
    "wss_proxy",
    "NO_PROXY",
    "no_proxy",
    "npm_config_noproxy",
    "NPM_CONFIG_NOPROXY",
    "YARN_NO_PROXY",
    "BUNDLE_NO_PROXY",
    "ALL_PROXY",
    "all_proxy",
    "FTP_PROXY",
    "ftp_proxy",
];

/// macOS 专用：`GIT_SSH_COMMAND` 环境变量键名（公开以供测试与外部清理使用）。
#[cfg(target_os = "macos")]
pub const PROXY_GIT_SSH_COMMAND_ENV_KEY: &str = GIT_SSH_COMMAND_ENV_KEY;

/// `FTP_PROXY` 环境变量键名（含大小写变体）。
const FTP_PROXY_ENV_KEYS: &[&str] = &["FTP_PROXY", "ftp_proxy"];
/// WebSocket 代理专用环境变量键名（`WS_PROXY`/`WSS_PROXY` 及小写变体）。
const WEBSOCKET_PROXY_ENV_KEYS: &[&str] = &["WS_PROXY", "WSS_PROXY", "ws_proxy", "wss_proxy"];

/// `NO_PROXY` 环境变量键名列表（含大小写变体与各包管理器专用变量）。
pub const NO_PROXY_ENV_KEYS: &[&str] = &[
    "NO_PROXY",
    "no_proxy",
    "npm_config_noproxy",
    "NPM_CONFIG_NOPROXY",
    "YARN_NO_PROXY",
    "BUNDLE_NO_PROXY",
];

/// `NO_PROXY` 默认值：包含 localhost、回环地址与三段私有 IP 段。
///
/// 刻意不包含主机名后缀，避免客户端本地解析内部名称而非让代理解析。
pub const DEFAULT_NO_PROXY_VALUE: &str = concat!(
    "localhost,127.0.0.1,::1,",
    "10.0.0.0/8,",
    "172.16.0.0/12,",
    "192.168.0.0/16"
);

/// macOS 专用：Codex 注入的 `GIT_SSH_COMMAND` 标记前缀，用于识别后续刷新。
#[cfg(target_os = "macos")]
pub const CODEX_PROXY_GIT_SSH_COMMAND_MARKER: &str = "CODEX_PROXY_GIT_SSH_COMMAND=1 ";
/// macOS 专用：Codex 注入的 `GIT_SSH_COMMAND` 前缀，使用 `nc` 通过 SOCKS5 代理 SSH。
#[cfg(target_os = "macos")]
const CODEX_PROXY_GIT_SSH_COMMAND_PREFIX: &str =
    "CODEX_PROXY_GIT_SSH_COMMAND=1 ssh -o ProxyCommand='nc -X 5 -x ";
/// macOS 专用：Codex 注入的 `GIT_SSH_COMMAND` 后缀。
#[cfg(target_os = "macos")]
const CODEX_PROXY_GIT_SSH_COMMAND_SUFFIX: &str = " %h %p'";

/// 读取代理 URL 环境变量值：优先匹配规范键名，其次尝试小写变体。
pub fn proxy_url_env_value<'a>(
    env: &'a HashMap<String, String>,
    canonical_key: &str,
) -> Option<&'a str> {
    if let Some(value) = env.get(canonical_key) {
        return Some(value.as_str());
    }
    let lower_key = canonical_key.to_ascii_lowercase();
    env.get(lower_key.as_str()).map(String::as_str)
}

/// 判断环境变量中是否存在任何非空的代理 URL 变量。
pub fn has_proxy_url_env_vars(env: &HashMap<String, String>) -> bool {
    PROXY_URL_ENV_KEYS
        .iter()
        .any(|key| proxy_url_env_value(env, key).is_some_and(|value| !value.trim().is_empty()))
}

/// 将指定值写入多个环境变量键名（用于批量设置代理变量）。
fn set_env_keys(env: &mut HashMap<String, String>, keys: &[&str], value: &str) {
    for key in keys {
        env.insert((*key).to_string(), value.to_string());
    }
}

/// macOS 专用：构造通过 SOCKS5 代理 SSH 的 `GIT_SSH_COMMAND` 值。
#[cfg(target_os = "macos")]
fn codex_proxy_git_ssh_command(socks_addr: SocketAddr) -> String {
    format!("{CODEX_PROXY_GIT_SSH_COMMAND_PREFIX}{socks_addr}{CODEX_PROXY_GIT_SSH_COMMAND_SUFFIX}")
}

/// macOS 专用：判断给定命令是否为 Codex 注入的 `GIT_SSH_COMMAND`。
#[cfg(target_os = "macos")]
fn is_codex_proxy_git_ssh_command(command: &str) -> bool {
    command.starts_with(CODEX_PROXY_GIT_SSH_COMMAND_PREFIX)
        && command.ends_with(CODEX_PROXY_GIT_SSH_COMMAND_SUFFIX)
}

/// 将托管代理变量写入子进程环境：HTTP/SOCKS5 代理 URL、NO_PROXY、CA 信任包等。
///
/// - HTTP 客户端优先使用显式 HTTP 代理 URL（避免 SOCKS URL 兼容性问题）
/// - WebSocket 客户端对齐到 HTTP 代理端点
/// - NO_PROXY 保持 loopback 与私有 IP 段直连
/// - `ALL_PROXY` 与 `FTP_PROXY` 仅在启用 SOCKS5 时指向 SOCKS5，否则指向 HTTP
/// - macOS 下若启用 SOCKS5，会刷新之前 Codex 注入的 `GIT_SSH_COMMAND`
/// - MITM CA 信任包变量保留子进程作用域覆盖
fn apply_proxy_env_overrides(
    env: &mut HashMap<String, String>,
    http_addr: SocketAddr,
    socks_addr: SocketAddr,
    socks_enabled: bool,
    allow_local_binding: bool,
    mitm_ca_trust_bundle: Option<&crate::certs::ManagedMitmCaTrustBundle>,
) {
    let http_proxy_url = format!("http://{http_addr}");
    let socks_proxy_url = format!("socks5h://{socks_addr}");
    env.insert(PROXY_ACTIVE_ENV_KEY.to_string(), "1".to_string());
    env.insert(
        ALLOW_LOCAL_BINDING_ENV_KEY.to_string(),
        if allow_local_binding {
            "1".to_string()
        } else {
            "0".to_string()
        },
    );

    // HTTP-based clients are best served by explicit HTTP proxy URLs.
    // HTTP 客户端最适合使用显式 HTTP 代理 URL。
    set_env_keys(
        env,
        &[
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "http_proxy",
            "https_proxy",
            "YARN_HTTP_PROXY",
            "YARN_HTTPS_PROXY",
            "npm_config_http_proxy",
            "npm_config_https_proxy",
            "npm_config_proxy",
            "NPM_CONFIG_HTTP_PROXY",
            "NPM_CONFIG_HTTPS_PROXY",
            "NPM_CONFIG_PROXY",
            "BUNDLE_HTTP_PROXY",
            "BUNDLE_HTTPS_PROXY",
            "PIP_PROXY",
            "DOCKER_HTTP_PROXY",
            "DOCKER_HTTPS_PROXY",
        ],
        &http_proxy_url,
    );
    // Some websocket clients look for dedicated WS/WSS proxy environment variables instead of
    // HTTP(S)_PROXY. Keep them aligned with the managed HTTP proxy endpoint.
    // 部分 WebSocket 客户端查找专用的 WS/WSS 代理变量而非 HTTP(S)_PROXY，将其对齐到托管 HTTP 代理端点。
    set_env_keys(env, WEBSOCKET_PROXY_ENV_KEYS, &http_proxy_url);

    // Keep loopback and IP-literal private targets direct so local IPC/LAN access avoids the proxy.
    // Do not include hostname suffixes here: those can force clients to resolve internal names
    // locally instead of letting the proxy resolve them.
    // 保持 loopback 与 IP 字面量私有目标直连，避免本地 IPC/LAN 流量走代理。
    // 此处不包含主机名后缀：那会强制客户端本地解析内部名称，而非让代理解析。
    set_env_keys(env, NO_PROXY_ENV_KEYS, DEFAULT_NO_PROXY_VALUE);

    env.insert(
        ELECTRON_GET_USE_PROXY_ENV_KEY.to_string(),
        "true".to_string(),
    );
    // Node.js built-in HTTP clients only honor proxy environment variables when this is enabled.
    // Node.js 内置 HTTP 客户端仅在此开关启用时才读取代理环境变量。
    env.insert(NODE_USE_ENV_PROXY_ENV_KEY.to_string(), "1".to_string());

    // Keep HTTP_PROXY/HTTPS_PROXY as HTTP endpoints. A lot of clients break if
    // those vars contain SOCKS URLs. We only switch ALL_PROXY here.
    // 保持 HTTP_PROXY/HTTPS_PROXY 为 HTTP 端点：许多客户端在变量值为 SOCKS URL 时会出错，
    // 仅切换 ALL_PROXY。
    if socks_enabled {
        set_env_keys(env, ALL_PROXY_ENV_KEYS, &socks_proxy_url);
        set_env_keys(env, FTP_PROXY_ENV_KEYS, &socks_proxy_url);
    } else {
        set_env_keys(env, ALL_PROXY_ENV_KEYS, &http_proxy_url);
        set_env_keys(env, FTP_PROXY_ENV_KEYS, &http_proxy_url);
    }

    #[cfg(target_os = "macos")]
    if socks_enabled {
        // Preserve existing SSH wrappers (for example: Secretive/Teleport setups)
        // but refresh a previously injected Codex fallback so it cannot point
        // at a stale proxy port after the proxy is restarted.
        // 保留已存在的 SSH 包装器（如 Secretive/Teleport 设置），
        // 但刷新之前 Codex 注入的回退命令，避免代理重启后指向过期的代理端口。
        match env.get(GIT_SSH_COMMAND_ENV_KEY) {
            Some(command) if !is_codex_proxy_git_ssh_command(command) => {}
            _ => {
                env.insert(
                    GIT_SSH_COMMAND_ENV_KEY.to_string(),
                    codex_proxy_git_ssh_command(socks_addr),
                );
            }
        }
    }

    if let Some(mitm_ca_trust_bundle) = mitm_ca_trust_bundle {
        let managed_path = mitm_ca_trust_bundle.path.to_string_lossy().into_owned();
        for key in crate::certs::CUSTOM_CA_ENV_KEYS {
            if env
                .get(key)
                .filter(|value| !value.is_empty())
                .is_some_and(|value| {
                    value != &managed_path
                        && mitm_ca_trust_bundle.startup_env_values.get(key) != Some(value)
                })
            {
                // TODO(winston): Materialize policy-checked per-child bundles for readable
                // startup and command-scoped CA overrides. For now startup overrides are
                // replaced with the default bundle and later command-scoped overrides are
                // preserved, either of which can make intercepted TLS fail.
                // TODO(winston): 为可读的启动与命令作用域 CA 覆盖生成经策略校验的子进程专用信任包。
                // 当前启动覆盖会被默认信任包替换，后续命令作用域覆盖会被保留，
                // 两者都可能导致 TLS 拦截失败。
                continue;
            }
            env.insert(key.to_string(), managed_path.clone());
        }
    }
}

impl NetworkProxy {
    /// 创建默认构建器。
    pub fn builder() -> NetworkProxyBuilder {
        NetworkProxyBuilder::default()
    }

    /// 返回主 HTTP 代理监听地址。
    pub fn http_addr(&self) -> SocketAddr {
        self.http_addr
    }

    /// 返回主 SOCKS5 代理监听地址。
    pub fn socks_addr(&self) -> SocketAddr {
        self.socks_addr
    }

    /// 读取当前生效的网络代理配置（会触发按需 reload）。
    pub async fn current_cfg(&self) -> Result<config::NetworkProxyConfig> {
        self.state.current_cfg().await
    }

    /// 向允许列表添加域名。
    pub async fn add_allowed_domain(&self, host: &str) -> Result<()> {
        self.state.add_allowed_domain(host).await
    }

    /// 向拒绝列表添加域名。
    pub async fn add_denied_domain(&self, host: &str) -> Result<()> {
        self.state.add_denied_domain(host).await
    }

    /// 返回是否允许子进程绑定本地端口。
    pub fn allow_local_binding(&self) -> bool {
        self.runtime_settings().allow_local_binding
    }

    /// 返回允许的 Unix socket 路径列表。
    pub fn allow_unix_sockets(&self) -> Arc<[String]> {
        self.runtime_settings().allow_unix_sockets
    }

    /// 返回是否允许所有 Unix socket（危险选项）。
    pub fn dangerously_allow_all_unix_sockets(&self) -> bool {
        self.runtime_settings().dangerously_allow_all_unix_sockets
    }

    /// 返回生成的 MITM CA 信任包路径，供子进程沙箱暴露给 TLS 客户端。
    pub fn managed_mitm_ca_trust_bundle_path(&self) -> Option<AbsolutePathBuf> {
        self.runtime_settings()
            .mitm_ca_trust_bundle
            .and_then(|bundle| {
                AbsolutePathBuf::from_absolute_path(bundle.path)
                    .map_err(|err| warn!("managed MITM CA trust bundle path is invalid: {err}"))
                    .ok()
            })
    }

    /// 基于指定地址对准备子进程环境与沙箱上下文。
    fn prepare_for_addrs(
        &self,
        mut env: HashMap<String, String>,
        addrs: EnvironmentProxyAddrs,
    ) -> PreparedManagedNetwork {
        let runtime_settings = self.runtime_settings();
        // Enforce proxying for child processes. Proxy endpoint values are always rewritten;
        // managed MITM CA vars preserve child-scoped overrides after proxy startup.
        // 强制子进程走代理：代理端点值总是被重写；
        // 托管 MITM CA 变量保留代理启动后的子进程作用域覆盖。
        apply_proxy_env_overrides(
            &mut env,
            addrs.http_addr,
            addrs.socks_addr,
            self.socks_enabled,
            runtime_settings.allow_local_binding,
            runtime_settings.mitm_ca_trust_bundle.as_ref(),
        );
        self.state.virtualize_child_credentials(&mut env);
        let mut loopback_ports = [
            Some(addrs.http_addr),
            self.socks_enabled.then_some(addrs.socks_addr),
        ]
        .into_iter()
        .flatten()
        .filter(|addr| addr.ip().is_loopback())
        .map(|addr| addr.port())
        .collect::<Vec<_>>();
        loopback_ports.sort_unstable();
        loopback_ports.dedup();
        PreparedManagedNetwork {
            env,
            sandbox_context: ManagedNetworkSandboxContext {
                loopback_ports,
                allow_local_binding: runtime_settings.allow_local_binding,
            },
        }
    }

    /// 将代理变量写入环境（使用主代理地址）。
    fn apply_to_env_for_addrs(
        &self,
        env: &mut HashMap<String, String>,
        addrs: EnvironmentProxyAddrs,
    ) {
        let prepared = self.prepare_for_addrs(std::mem::take(env), addrs);
        *env = prepared.env;
    }

    /// 将代理变量写入环境（使用主代理地址）。
    pub fn apply_to_env(&self, env: &mut HashMap<String, String>) {
        self.apply_to_env_for_addrs(
            env,
            EnvironmentProxyAddrs {
                http_addr: self.http_addr,
                socks_addr: self.socks_addr,
            },
        );
    }

    /// 将代理变量写入环境（按 environment_id 选择对应代理实例地址）。
    pub fn apply_to_env_for_environment(
        &self,
        env: &mut HashMap<String, String>,
        environment_id: &str,
    ) -> Result<()> {
        let addrs = self.environment_proxy_addrs(environment_id)?;
        self.apply_to_env_for_addrs(env, addrs);
        Ok(())
    }

    /// 将代理变量写入环境：environment_id 为 None 时使用主代理地址。
    pub fn apply_to_env_for_optional_environment(
        &self,
        env: &mut HashMap<String, String>,
        environment_id: Option<&str>,
    ) -> Result<()> {
        match environment_id {
            Some(environment_id) => self.apply_to_env_for_environment(env, environment_id),
            None => {
                self.apply_to_env(env);
                Ok(())
            }
        }
    }

    /// 应用环境特定的代理设置，并返回与之匹配的便携沙箱投影（同一运行时配置快照）。
    pub fn prepare_for_optional_environment(
        &self,
        env: HashMap<String, String>,
        environment_id: Option<&str>,
    ) -> Result<PreparedManagedNetwork> {
        let addrs = match environment_id {
            Some(environment_id) => self.environment_proxy_addrs(environment_id)?,
            None => EnvironmentProxyAddrs {
                http_addr: self.http_addr,
                socks_addr: self.socks_addr,
            },
        };
        Ok(self.prepare_for_addrs(env, addrs))
    }

    /// 获取或创建指定 environment_id 对应的代理实例地址。
    ///
    /// 若该 environment_id 首次请求，会预留新的 loopback 临时端口并启动对应的
    /// HTTP/SOCKS5 代理任务；后续请求直接返回缓存地址。
    fn environment_proxy_addrs(&self, environment_id: &str) -> Result<EnvironmentProxyAddrs> {
        let mut proxies = self
            .environment_proxies
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(proxy) = proxies.get(environment_id) {
            return Ok(proxy.addrs);
        }

        let runtime = tokio::runtime::Handle::try_current().with_context(|| {
            format!("failed to create network proxy for environment `{environment_id}`")
        })?;
        let listeners =
            reserve_loopback_ephemeral_listeners(self.socks_enabled).with_context(|| {
                format!("failed to reserve network proxy for environment `{environment_id}`")
            })?;
        let http_addr = listeners.http_addr().with_context(|| {
            format!("failed to read HTTP proxy address for environment `{environment_id}`")
        })?;
        let socks_addr = listeners.socks_addr(self.socks_addr).with_context(|| {
            format!("failed to read SOCKS proxy address for environment `{environment_id}`")
        })?;
        let addrs = EnvironmentProxyAddrs {
            http_addr,
            socks_addr,
        };
        let ReservedListenerSet {
            http_listener,
            socks_listener,
        } = listeners;

        let environment_id = environment_id.to_string();
        let http_state = self.state.clone();
        let http_decider = self.policy_decider.clone();
        let http_environment_id = Some(environment_id.clone());
        let http_task = runtime.spawn(async move {
            http_proxy::run_http_proxy_with_std_listener(
                http_state,
                http_listener,
                http_decider,
                http_environment_id,
            )
            .await
        });

        let socks_task = if self.socks_enabled {
            let socks_state = self.state.clone();
            let socks_decider = self.policy_decider.clone();
            let socks_environment_id = Some(environment_id.clone());
            let socks5_udp_enabled = self.socks5_udp_enabled;
            socks_listener.map(|listener| {
                runtime.spawn(async move {
                    socks5::run_socks5_with_std_listener(
                        socks_state,
                        listener,
                        socks_decider,
                        socks_environment_id,
                        socks5_udp_enabled,
                    )
                    .await
                })
            })
        } else {
            None
        };

        proxies.insert(
            environment_id,
            EnvironmentProxy {
                addrs,
                http_task,
                socks_task,
            },
        );
        Ok(addrs)
    }

    /// 替换配置状态：更新网络配置并同步运行时设置。
    ///
    /// 注意：`enabled`、`proxy_url`、`socks_url`、`enable_socks5`、`enable_socks5_udp`
    /// 等字段在代理运行期间不可变更，会触发错误。
    pub async fn replace_config_state(&self, new_state: ConfigState) -> Result<()> {
        let current_cfg = self.state.current_cfg().await?;
        anyhow::ensure!(
            new_state.config.network.enabled == current_cfg.network.enabled,
            "cannot update network.enabled on a running proxy"
        );
        anyhow::ensure!(
            new_state.config.network.proxy_url == current_cfg.network.proxy_url,
            "cannot update network.proxy_url on a running proxy"
        );
        anyhow::ensure!(
            new_state.config.network.socks_url == current_cfg.network.socks_url,
            "cannot update network.socks_url on a running proxy"
        );
        anyhow::ensure!(
            new_state.config.network.enable_socks5 == current_cfg.network.enable_socks5,
            "cannot update network.enable_socks5 on a running proxy"
        );
        anyhow::ensure!(
            new_state.config.network.enable_socks5_udp == current_cfg.network.enable_socks5_udp,
            "cannot update network.enable_socks5_udp on a running proxy"
        );

        let settings = NetworkProxyRuntimeSettings::from_config(&new_state.config)?;
        self.state.replace_config_state(new_state).await?;
        let mut guard = self
            .runtime_settings
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *guard = settings;
        Ok(())
    }

    fn runtime_settings(&self) -> NetworkProxyRuntimeSettings {
        self.runtime_settings
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// 启动 HTTP 与 SOCKS5 代理任务，返回 [`NetworkProxyHandle`] 用于 await/shutdown。
    ///
    /// 若 `network.enabled = false`，直接返回 noop 句柄。
    /// 若平台不支持 unix socket 权限，会发出告警。
    pub async fn run(&self) -> Result<NetworkProxyHandle> {
        let current_cfg = self.state.current_cfg().await?;
        if !current_cfg.network.enabled {
            warn!("network.enabled is false; skipping proxy listeners");
            return Ok(NetworkProxyHandle::noop());
        }

        if !unix_socket_permissions_supported() {
            warn!(
                "allowUnixSockets and dangerouslyAllowAllUnixSockets are macOS-only; requests will be rejected on this platform"
            );
        }

        let reserved_listeners = self.reserved_listeners.as_ref();
        let http_listener = reserved_listeners.and_then(|listeners| listeners.take_http());
        let socks_listener = reserved_listeners.and_then(|listeners| listeners.take_socks());

        let http_state = self.state.clone();
        let http_decider = self.policy_decider.clone();
        let http_addr = self.http_addr;
        let http_task = tokio::spawn(async move {
            match http_listener {
                Some(listener) => {
                    http_proxy::run_http_proxy_with_std_listener(
                        http_state,
                        listener,
                        http_decider,
                        /*environment_id*/ None,
                    )
                    .await
                }
                None => {
                    http_proxy::run_http_proxy(
                        http_state,
                        http_addr,
                        http_decider,
                        /*environment_id*/ None,
                    )
                    .await
                }
            }
        });

        let socks_task = if current_cfg.network.enable_socks5 {
            let socks_state = self.state.clone();
            let socks_decider = self.policy_decider.clone();
            let socks_addr = self.socks_addr;
            let enable_socks5_udp = current_cfg.network.enable_socks5_udp;
            Some(tokio::spawn(async move {
                match socks_listener {
                    Some(listener) => {
                        socks5::run_socks5_with_std_listener(
                            socks_state,
                            listener,
                            socks_decider,
                            /*environment_id*/ None,
                            enable_socks5_udp,
                        )
                        .await
                    }
                    None => {
                        socks5::run_socks5(
                            socks_state,
                            socks_addr,
                            socks_decider,
                            /*environment_id*/ None,
                            enable_socks5_udp,
                        )
                        .await
                    }
                }
            }))
        } else {
            None
        };

        Ok(NetworkProxyHandle {
            http_task: Some(http_task),
            socks_task,
            environment_proxies: self.environment_proxies.clone(),
            completed: false,
        })
    }
}

/// 网络代理任务句柄：持有 HTTP/SOCKS5 代理与按环境隔离代理的异步任务，
/// 支持 await 完成或主动 shutdown。
///
/// Drop 时会自动 abort 所有任务，避免任务泄漏。
pub struct NetworkProxyHandle {
    /// HTTP 代理异步任务
    http_task: Option<JoinHandle<Result<()>>>,
    /// SOCKS5 代理异步任务（未启用时为 None）
    socks_task: Option<JoinHandle<Result<()>>>,
    /// 按 environment_id 索引的代理实例映射（用于 shutdown 时 abort）
    environment_proxies: Arc<Mutex<HashMap<String, EnvironmentProxy>>>,
    /// 是否已完成（已完成时 Drop 不再 abort）
    completed: bool,
}

impl NetworkProxyHandle {
    /// 创建 noop 句柄：不持有任何真实任务，立即完成。
    fn noop() -> Self {
        Self {
            http_task: Some(tokio::spawn(async { Ok(()) })),
            socks_task: None,
            environment_proxies: Arc::new(Mutex::new(HashMap::new())),
            completed: true,
        }
    }

    /// 等待所有代理任务完成（HTTP 优先，SOCKS5 其次），并清理环境代理。
    pub async fn wait(mut self) -> Result<()> {
        let http_task = self.http_task.take().context("missing http proxy task")?;
        let socks_task = self.socks_task.take();
        let http_result = http_task.await;
        let socks_result = match socks_task {
            Some(task) => Some(task.await),
            None => None,
        };
        self.completed = true;
        abort_environment_proxies(self.environment_proxies.clone()).await;
        http_result??;
        if let Some(socks_result) = socks_result {
            socks_result??;
        }
        Ok(())
    }

    /// 主动 shutdown：abort HTTP/SOCKS5 与所有环境代理任务。
    pub async fn shutdown(mut self) -> Result<()> {
        abort_tasks(self.http_task.take(), self.socks_task.take()).await;
        abort_environment_proxies(self.environment_proxies.clone()).await;
        self.completed = true;
        Ok(())
    }
}

/// Abort 单个任务（若存在）。
async fn abort_task(task: Option<JoinHandle<Result<()>>>) {
    if let Some(task) = task {
        task.abort();
        let _ = task.await;
    }
}

/// Abort HTTP 与 SOCKS5 任务。
async fn abort_tasks(
    http_task: Option<JoinHandle<Result<()>>>,
    socks_task: Option<JoinHandle<Result<()>>>,
) {
    abort_task(http_task).await;
    abort_task(socks_task).await;
}

/// Abort 所有按环境隔离的代理任务。
async fn abort_environment_proxies(
    environment_proxies: Arc<Mutex<HashMap<String, EnvironmentProxy>>>,
) {
    let proxies = {
        let mut guard = environment_proxies
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.drain().map(|(_, proxy)| proxy).collect::<Vec<_>>()
    };
    for proxy in proxies {
        abort_task(Some(proxy.http_task)).await;
        abort_task(proxy.socks_task).await;
    }
}

impl Drop for NetworkProxyHandle {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        let http_task = self.http_task.take();
        let socks_task = self.socks_task.take();
        let environment_proxies = self.environment_proxies.clone();
        tokio::spawn(async move {
            abort_tasks(http_task, socks_task).await;
            abort_environment_proxies(environment_proxies).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::NetworkProxySettings;
    use crate::state::network_proxy_state_for_policy;
    use pretty_assertions::assert_eq;
    use std::net::IpAddr;
    use std::net::Ipv4Addr;
    use std::path::Path;

    #[tokio::test]
    async fn managed_proxy_builder_uses_loopback_ports() {
        let http_listener = StdTcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).unwrap();
        let http_addr = http_listener.local_addr().unwrap();
        let socks_listener = StdTcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).unwrap();
        let socks_addr = socks_listener.local_addr().unwrap();
        drop(http_listener);
        drop(socks_listener);

        let state = Arc::new(network_proxy_state_for_policy(NetworkProxySettings {
            proxy_url: format!("http://{http_addr}"),
            socks_url: format!("http://{socks_addr}"),
            ..NetworkProxySettings::default()
        }));
        let proxy = match NetworkProxy::builder().state(state).build().await {
            Ok(proxy) => proxy,
            Err(err) => {
                if err
                    .chain()
                    .any(|cause| cause.to_string().contains("Operation not permitted"))
                {
                    return;
                }
                panic!("failed to build managed proxy: {err:#}");
            }
        };

        assert!(proxy.http_addr.ip().is_loopback());
        assert!(proxy.socks_addr.ip().is_loopback());
        #[cfg(target_os = "windows")]
        {
            assert_eq!(proxy.http_addr, http_addr);
            assert_eq!(proxy.socks_addr, socks_addr);
        }
        #[cfg(not(target_os = "windows"))]
        {
            assert_ne!(proxy.http_addr.port(), 0);
            assert_ne!(proxy.socks_addr.port(), 0);
        }
    }

    #[tokio::test]
    async fn non_codex_managed_proxy_builder_uses_configured_ports() {
        let settings = NetworkProxySettings {
            proxy_url: "http://127.0.0.1:43128".to_string(),
            socks_url: "http://127.0.0.1:48081".to_string(),
            ..NetworkProxySettings::default()
        };
        let state = Arc::new(network_proxy_state_for_policy(settings));
        let proxy = NetworkProxy::builder()
            .state(state)
            .managed_by_codex(/*managed_by_codex*/ false)
            .build()
            .await
            .unwrap();

        assert_eq!(
            proxy.http_addr,
            "127.0.0.1:43128".parse::<SocketAddr>().unwrap()
        );
        assert_eq!(
            proxy.socks_addr,
            "127.0.0.1:48081".parse::<SocketAddr>().unwrap()
        );
    }

    #[tokio::test]
    async fn prepare_for_environment_keeps_env_and_sandbox_ports_in_sync() -> Result<()> {
        let state = Arc::new(network_proxy_state_for_policy(
            NetworkProxySettings::default(),
        ));
        let proxy = NetworkProxy::builder().state(state).build().await?;
        let handle = proxy.run().await?;

        let base_env = HashMap::from([("PRESERVED".to_string(), "value".to_string())]);
        let local = proxy.prepare_for_optional_environment(base_env.clone(), Some("local"))?;
        let remote = proxy.prepare_for_optional_environment(HashMap::new(), Some("remote"))?;

        assert_eq!(
            local.env.get("PRESERVED").map(String::as_str),
            Some("value")
        );
        assert_ne!(local.env.get("HTTP_PROXY"), remote.env.get("HTTP_PROXY"));
        assert_ne!(
            local.env.get("HTTP_PROXY"),
            Some(&format!("http://{}", proxy.http_addr()))
        );
        assert_ne!(
            remote.env.get("HTTP_PROXY"),
            Some(&format!("http://{}", proxy.http_addr()))
        );
        for prepared in [&local, &remote] {
            let http_port = prepared
                .env
                .get("HTTP_PROXY")
                .and_then(|value| value.strip_prefix("http://"))
                .and_then(|value| value.parse::<SocketAddr>().ok())
                .map(|addr| addr.port())
                .expect("managed HTTP proxy address");
            let socks_port = prepared
                .env
                .get("ALL_PROXY")
                .and_then(|value| value.strip_prefix("socks5h://"))
                .and_then(|value| value.parse::<SocketAddr>().ok())
                .map(|addr| addr.port())
                .expect("managed SOCKS proxy address");
            let mut expected_ports = vec![http_port, socks_port];
            expected_ports.sort_unstable();
            expected_ports.dedup();
            assert_eq!(
                prepared.sandbox_context,
                ManagedNetworkSandboxContext {
                    loopback_ports: expected_ports,
                    allow_local_binding: false,
                }
            );
        }
        let mut legacy_env = base_env;
        proxy.apply_to_env_for_environment(&mut legacy_env, "local")?;
        assert_eq!(legacy_env, local.env);

        handle.shutdown().await?;
        Ok(())
    }

    #[tokio::test]
    async fn managed_proxy_builder_does_not_reserve_socks_listener_when_disabled() {
        let settings = NetworkProxySettings {
            enable_socks5: false,
            proxy_url: "http://127.0.0.1:43128".to_string(),
            socks_url: "http://127.0.0.1:43129".to_string(),
            ..NetworkProxySettings::default()
        };
        let state = Arc::new(network_proxy_state_for_policy(settings));
        let proxy = match NetworkProxy::builder().state(state).build().await {
            Ok(proxy) => proxy,
            Err(err) => {
                if err
                    .chain()
                    .any(|cause| cause.to_string().contains("Operation not permitted"))
                {
                    return;
                }
                panic!("failed to build managed proxy: {err:#}");
            }
        };

        assert!(proxy.http_addr.ip().is_loopback());
        assert_ne!(proxy.http_addr.port(), 0);
        assert_eq!(
            proxy.socks_addr,
            "127.0.0.1:43129".parse::<SocketAddr>().unwrap()
        );
        assert!(
            proxy
                .reserved_listeners
                .as_ref()
                .expect("managed builder should reserve listeners")
                .take_socks()
                .is_none()
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_managed_loopback_addr_clamps_non_loopback_inputs() {
        assert_eq!(
            windows_managed_loopback_addr("0.0.0.0:3128".parse::<SocketAddr>().unwrap()),
            "127.0.0.1:3128".parse::<SocketAddr>().unwrap()
        );
        assert_eq!(
            windows_managed_loopback_addr("[::]:8081".parse::<SocketAddr>().unwrap()),
            "127.0.0.1:8081".parse::<SocketAddr>().unwrap()
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn reserve_windows_managed_listeners_falls_back_when_http_port_is_busy() {
        let occupied = StdTcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).unwrap();
        let busy_port = occupied.local_addr().unwrap().port();

        let reserved = reserve_windows_managed_listeners(
            SocketAddr::from(([127, 0, 0, 1], busy_port)),
            SocketAddr::from(([127, 0, 0, 1], 48081)),
            /*reserve_socks_listener*/ false,
        )
        .unwrap();

        assert!(reserved.socks_listener.is_none());
        assert!(
            reserved
                .http_listener
                .local_addr()
                .unwrap()
                .ip()
                .is_loopback()
        );
        assert_ne!(
            reserved.http_listener.local_addr().unwrap().port(),
            busy_port
        );
    }

    #[test]
    fn proxy_url_env_value_resolves_lowercase_aliases() {
        let mut env = HashMap::new();
        env.insert(
            "http_proxy".to_string(),
            "http://127.0.0.1:3128".to_string(),
        );

        assert_eq!(
            proxy_url_env_value(&env, "HTTP_PROXY"),
            Some("http://127.0.0.1:3128")
        );
    }

    #[test]
    fn has_proxy_url_env_vars_detects_lowercase_aliases() {
        let mut env = HashMap::new();
        env.insert(
            "all_proxy".to_string(),
            "socks5h://127.0.0.1:8081".to_string(),
        );

        assert_eq!(has_proxy_url_env_vars(&env), true);
    }

    #[test]
    fn has_proxy_url_env_vars_detects_websocket_proxy_keys() {
        let mut env = HashMap::new();
        env.insert("wss_proxy".to_string(), "http://127.0.0.1:3128".to_string());

        assert_eq!(has_proxy_url_env_vars(&env), true);
    }

    #[test]
    fn apply_proxy_env_overrides_sets_common_tool_vars() {
        let mut env = HashMap::new();
        apply_proxy_env_overrides(
            &mut env,
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3128),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 8081),
            /*socks_enabled*/ true,
            /*allow_local_binding*/ false,
            /*mitm_ca_trust_bundle*/ None,
        );

        assert_eq!(
            env.get("HTTP_PROXY"),
            Some(&"http://127.0.0.1:3128".to_string())
        );
        assert_eq!(
            env.get("WS_PROXY"),
            Some(&"http://127.0.0.1:3128".to_string())
        );
        assert_eq!(
            env.get("WSS_PROXY"),
            Some(&"http://127.0.0.1:3128".to_string())
        );
        assert_eq!(
            env.get("npm_config_proxy"),
            Some(&"http://127.0.0.1:3128".to_string())
        );
        assert_eq!(
            env.get("ALL_PROXY"),
            Some(&"socks5h://127.0.0.1:8081".to_string())
        );
        assert_eq!(
            env.get("FTP_PROXY"),
            Some(&"socks5h://127.0.0.1:8081".to_string())
        );
        assert_eq!(
            env.get("NO_PROXY"),
            Some(&DEFAULT_NO_PROXY_VALUE.to_string())
        );
        let no_proxy = env.get("NO_PROXY").expect("NO_PROXY should be set");
        assert!(no_proxy.contains("10.0.0.0/8"));
        assert!(no_proxy.contains("172.16.0.0/12"));
        assert!(no_proxy.contains("192.168.0.0/16"));
        assert!(!no_proxy.contains("169.254.0.0/16"));
        assert_eq!(env.get(PROXY_ACTIVE_ENV_KEY), Some(&"1".to_string()));
        assert_eq!(env.get(ALLOW_LOCAL_BINDING_ENV_KEY), Some(&"0".to_string()));
        assert_eq!(
            env.get(ELECTRON_GET_USE_PROXY_ENV_KEY),
            Some(&"true".to_string())
        );
        assert_eq!(env.get(NODE_USE_ENV_PROXY_ENV_KEY), Some(&"1".to_string()));
        #[cfg(target_os = "macos")]
        assert_eq!(
            env.get(GIT_SSH_COMMAND_ENV_KEY),
            Some(
                &"CODEX_PROXY_GIT_SSH_COMMAND=1 ssh -o ProxyCommand='nc -X 5 -x 127.0.0.1:8081 %h %p'"
                    .to_string()
            )
        );
        #[cfg(not(target_os = "macos"))]
        assert_eq!(env.get(GIT_SSH_COMMAND_ENV_KEY), None);
    }

    #[test]
    fn apply_proxy_env_overrides_sets_only_expected_env_keys() {
        let mut env = HashMap::new();
        apply_proxy_env_overrides(
            &mut env,
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3128),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 8081),
            /*socks_enabled*/ true,
            /*allow_local_binding*/ false,
            /*mitm_ca_trust_bundle*/ None,
        );

        for key in env.keys() {
            let is_managed_git_ssh_key =
                cfg!(target_os = "macos") && key == GIT_SSH_COMMAND_ENV_KEY;
            assert!(
                PROXY_ENV_KEYS.contains(&key.as_str()) || is_managed_git_ssh_key,
                "proxy env writer set unexpected key: {key}"
            );
        }
    }

    #[test]
    fn apply_proxy_env_overrides_sets_mitm_ca_trust_bundle_vars() {
        let mut env = HashMap::new();
        let mitm_ca_trust_bundle_path = Path::new("/tmp/codex-proxy/ca-bundle.pem");
        let mitm_ca_trust_bundle = crate::certs::ManagedMitmCaTrustBundle {
            path: mitm_ca_trust_bundle_path.to_path_buf(),
            startup_env_values: HashMap::new(),
        };
        apply_proxy_env_overrides(
            &mut env,
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3128),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 8081),
            /*socks_enabled*/ true,
            /*allow_local_binding*/ false,
            Some(&mitm_ca_trust_bundle),
        );

        for key in crate::certs::CUSTOM_CA_ENV_KEYS {
            assert_eq!(
                env.get(key),
                Some(&mitm_ca_trust_bundle_path.display().to_string())
            );
        }
    }

    #[test]
    fn apply_proxy_env_overrides_preserves_command_scoped_mitm_ca_override() {
        let command_ca_bundle_path = "/tmp/command-ca.pem".to_string();
        let mut env = HashMap::from([(
            "REQUESTS_CA_BUNDLE".to_string(),
            command_ca_bundle_path.clone(),
        )]);
        let mitm_ca_trust_bundle_path = Path::new("/tmp/codex-proxy/ca-bundle.pem");
        let mitm_ca_trust_bundle = crate::certs::ManagedMitmCaTrustBundle {
            path: mitm_ca_trust_bundle_path.to_path_buf(),
            startup_env_values: HashMap::new(),
        };

        apply_proxy_env_overrides(
            &mut env,
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3128),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 8081),
            /*socks_enabled*/ true,
            /*allow_local_binding*/ false,
            Some(&mitm_ca_trust_bundle),
        );

        assert_eq!(env.get("REQUESTS_CA_BUNDLE"), Some(&command_ca_bundle_path));
        assert_eq!(
            env.get("SSL_CERT_FILE"),
            Some(&mitm_ca_trust_bundle_path.display().to_string())
        );
    }

    #[test]
    fn apply_proxy_env_overrides_uses_http_for_all_proxy_without_socks() {
        let mut env = HashMap::new();
        apply_proxy_env_overrides(
            &mut env,
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3128),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 8081),
            /*socks_enabled*/ false,
            /*allow_local_binding*/ true,
            /*mitm_ca_trust_bundle*/ None,
        );

        assert_eq!(
            env.get("ALL_PROXY"),
            Some(&"http://127.0.0.1:3128".to_string())
        );
        assert_eq!(env.get(ALLOW_LOCAL_BINDING_ENV_KEY), Some(&"1".to_string()));
    }

    #[test]
    fn apply_proxy_env_overrides_uses_plain_http_proxy_url() {
        let mut env = HashMap::new();
        apply_proxy_env_overrides(
            &mut env,
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3128),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 8081),
            /*socks_enabled*/ true,
            /*allow_local_binding*/ false,
            /*mitm_ca_trust_bundle*/ None,
        );

        assert_eq!(
            env.get("HTTP_PROXY"),
            Some(&"http://127.0.0.1:3128".to_string())
        );
        assert_eq!(
            env.get("HTTPS_PROXY"),
            Some(&"http://127.0.0.1:3128".to_string())
        );
        assert_eq!(
            env.get("WS_PROXY"),
            Some(&"http://127.0.0.1:3128".to_string())
        );
        assert_eq!(
            env.get("WSS_PROXY"),
            Some(&"http://127.0.0.1:3128".to_string())
        );
        assert_eq!(
            env.get("ALL_PROXY"),
            Some(&"socks5h://127.0.0.1:8081".to_string())
        );
        #[cfg(target_os = "macos")]
        assert_eq!(
            env.get(GIT_SSH_COMMAND_ENV_KEY),
            Some(
                &"CODEX_PROXY_GIT_SSH_COMMAND=1 ssh -o ProxyCommand='nc -X 5 -x 127.0.0.1:8081 %h %p'"
                    .to_string()
            )
        );
        #[cfg(not(target_os = "macos"))]
        assert_eq!(env.get(GIT_SSH_COMMAND_ENV_KEY), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn apply_proxy_env_overrides_preserves_existing_git_ssh_command() {
        let mut env = HashMap::new();
        env.insert(
            GIT_SSH_COMMAND_ENV_KEY.to_string(),
            "ssh -o ProxyCommand='tsh proxy ssh --cluster=dev %r@%h:%p'".to_string(),
        );
        apply_proxy_env_overrides(
            &mut env,
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3128),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 8081),
            /*socks_enabled*/ true,
            /*allow_local_binding*/ false,
            /*mitm_ca_trust_bundle*/ None,
        );

        assert_eq!(
            env.get(GIT_SSH_COMMAND_ENV_KEY),
            Some(&"ssh -o ProxyCommand='tsh proxy ssh --cluster=dev %r@%h:%p'".to_string())
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn apply_proxy_env_overrides_preserves_unmarked_git_ssh_command_with_proxy_shape() {
        let mut env = HashMap::new();
        env.insert(
            GIT_SSH_COMMAND_ENV_KEY.to_string(),
            "ssh -o ProxyCommand='nc -X 5 -x 127.0.0.1:8081 %h %p'".to_string(),
        );
        apply_proxy_env_overrides(
            &mut env,
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3128),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 48081),
            /*socks_enabled*/ true,
            /*allow_local_binding*/ false,
            /*mitm_ca_trust_bundle*/ None,
        );

        assert_eq!(
            env.get(GIT_SSH_COMMAND_ENV_KEY),
            Some(&"ssh -o ProxyCommand='nc -X 5 -x 127.0.0.1:8081 %h %p'".to_string())
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn apply_proxy_env_overrides_refreshes_previous_codex_proxy_git_ssh_command() {
        let mut env = HashMap::new();
        env.insert(
            GIT_SSH_COMMAND_ENV_KEY.to_string(),
            codex_proxy_git_ssh_command(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 8081)),
        );

        apply_proxy_env_overrides(
            &mut env,
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 43128),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 48081),
            /*socks_enabled*/ true,
            /*allow_local_binding*/ false,
            /*mitm_ca_trust_bundle*/ None,
        );

        assert_eq!(
            env.get(GIT_SSH_COMMAND_ENV_KEY),
            Some(&codex_proxy_git_ssh_command(SocketAddr::new(
                IpAddr::V4(Ipv4Addr::LOCALHOST),
                48081,
            )))
        );
    }
}
