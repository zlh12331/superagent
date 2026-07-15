//! 网络代理运行时状态与策略执行模块。
//!
//! 核心类型：
//! - [`ConfigState`]：从配置派生的运行时状态（含编译后的 GlobSet、MITM 状态、阻塞队列）
//! - [`NetworkProxyState`]：对外暴露的共享状态，支持按需 reload、域名增删、主机策略评估
//! - [`BlockedRequest`]：被阻塞请求的审计记录
//! - [`ConfigReloader`] / [`BlockedRequestObserver`]：可插拔的配置重载与阻塞事件观察 trait
//!
//! 策略评估顺序：
//! 1. 显式拒绝（denylist）总是优先
//! 2. 本地/私有地址访问需显式 opt-in（SSRF 防御，含 DNS 重绑定防护）
//! 3. 允许列表（allowlist）匹配
//!
//! 同时提供 DNS 查询超时保护、blocked 事件环形缓冲、配置变更日志等能力。

use crate::config::NetworkDomainPermission;
use crate::config::NetworkMode;
use crate::config::NetworkProxyConfig;
use crate::config::ValidatedUnixSocketPath;
use crate::credential_broker::CredentialBroker;
use crate::mitm::MitmState;
use crate::mitm_hook::HookEvaluation;
use crate::mitm_hook::MitmHooksByHost;
use crate::mitm_hook::evaluate_mitm_hooks;
use crate::policy::Host;
use crate::policy::is_loopback_host;
use crate::policy::is_non_public_ip;
use crate::policy::normalize_host;
use crate::policy::unscoped_ip_literal;
use crate::reasons::REASON_DENIED;
use crate::reasons::REASON_NOT_ALLOWED;
use crate::reasons::REASON_NOT_ALLOWED_LOCAL;
use crate::state::NetworkProxyConstraintError;
use crate::state::NetworkProxyConstraints;
use crate::state::build_config_state;
use crate::state::validate_policy_against_constraints;
use anyhow::Context;
use anyhow::Result;
use codex_utils_absolute_path::AbsolutePathBuf;
use globset::GlobSet;
use serde::Serialize;
use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::future::Future;
use std::net::IpAddr;
use std::net::SocketAddr;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use time::OffsetDateTime;
use tokio::net::lookup_host;
use tokio::sync::RwLock;
use tokio::time::timeout;
use tracing::debug;
use tracing::info;
use tracing::warn;

/// 阻塞事件环形缓冲最大长度。
const MAX_BLOCKED_EVENTS: usize = 200;
/// DNS 查询超时：用于主机解析为本地/私有 IP 的防御性检查。
const DNS_LOOKUP_TIMEOUT: Duration = Duration::from_secs(2);
/// 阻塞事件日志前缀：用于从日志中检索策略违规记录。
const NETWORK_POLICY_VIOLATION_PREFIX: &str = "CODEX_NETWORK_POLICY_VIOLATION";

/// 审计元数据：附加到阻塞事件与策略决策日志中，便于关联到具体会话。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NetworkProxyAuditMetadata {
    /// 会话 ID
    pub conversation_id: Option<String>,
    /// 应用版本
    pub app_version: Option<String>,
    /// 用户账户 ID
    pub user_account_id: Option<String>,
    /// 认证模式
    pub auth_mode: Option<String>,
    /// 发起方标识
    pub originator: Option<String>,
    /// 用户邮箱
    pub user_email: Option<String>,
    /// 终端类型
    pub terminal_type: Option<String>,
    /// 模型名称
    pub model: Option<String>,
    /// 业务 slug
    pub slug: Option<String>,
}

/// 主机阻塞原因：用于审计日志与阻塞响应。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostBlockReason {
    /// 被显式拒绝列表匹配
    Denied,
    /// 不在允许列表中
    NotAllowed,
    /// 本地/私有地址且未显式允许
    NotAllowedLocal,
}

impl HostBlockReason {
    /// 返回原因对应的标准化字符串标识符。
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Denied => REASON_DENIED,
            Self::NotAllowed => REASON_NOT_ALLOWED,
            Self::NotAllowedLocal => REASON_NOT_ALLOWED_LOCAL,
        }
    }
}

impl std::fmt::Display for HostBlockReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 主机阻塞决策：允许或带原因的阻塞。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostBlockDecision {
    /// 允许通过
    Allowed,
    /// 阻塞，附带原因
    Blocked(HostBlockReason),
}

/// 被阻塞请求的审计记录：可序列化为 JSON 用于日志与遥测。
#[derive(Clone, Debug, Serialize)]
pub struct BlockedRequest {
    /// 目标主机
    pub host: String,
    /// 阻塞原因标识符
    pub reason: String,
    /// 客户端地址
    pub client: Option<String>,
    /// HTTP 方法（SOCKS5 场景为 None）
    pub method: Option<String>,
    /// 网络模式
    pub mode: Option<NetworkMode>,
    /// 协议（http/socks5/socks5-udp 等）
    pub protocol: String,
    /// 决策标识符（如 ask/deny）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision: Option<String>,
    /// 决策来源（如 proxy_state/mode_guard/decider）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// 目标端口
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// Unix 时间戳（秒）
    pub timestamp: i64,
}

/// 构造 [`BlockedRequest`] 的参数集合。
pub struct BlockedRequestArgs {
    /// 目标主机
    pub host: String,
    /// 阻塞原因标识符
    pub reason: String,
    /// 客户端地址
    pub client: Option<String>,
    /// HTTP 方法
    pub method: Option<String>,
    /// 网络模式
    pub mode: Option<NetworkMode>,
    /// 协议
    pub protocol: String,
    /// 决策标识符
    pub decision: Option<String>,
    /// 决策来源
    pub source: Option<String>,
    /// 目标端口
    pub port: Option<u16>,
}

impl BlockedRequest {
    /// 从参数构造审计记录，自动填充当前 Unix 时间戳。
    pub fn new(args: BlockedRequestArgs) -> Self {
        let BlockedRequestArgs {
            host,
            reason,
            client,
            method,
            mode,
            protocol,
            decision,
            source,
            port,
        } = args;
        Self {
            host,
            reason,
            client,
            method,
            mode,
            protocol,
            decision,
            source,
            port,
            timestamp: unix_timestamp(),
        }
    }
}

/// 将阻塞记录序列化为策略违规日志行（前缀 + JSON）。
///
/// 序列化失败时回退为 `host=`/`reason=` 的简化格式。
fn blocked_request_violation_log_line(entry: &BlockedRequest) -> String {
    match serde_json::to_string(entry) {
        Ok(json) => format!("{NETWORK_POLICY_VIOLATION_PREFIX} {json}"),
        Err(err) => {
            debug!("failed to serialize blocked request for violation log: {err}");
            format!(
                "{NETWORK_POLICY_VIOLATION_PREFIX} host={} reason={}",
                entry.host, entry.reason
            )
        }
    }
}

/// 运行时配置状态：从 [`NetworkProxyConfig`] 派生，包含编译后的 GlobSet、MITM 状态等。
#[derive(Clone)]
pub struct ConfigState {
    /// 原始网络代理配置
    pub config: NetworkProxyConfig,
    /// 编译后的允许列表 GlobSet
    pub allow_set: GlobSet,
    /// 编译后的拒绝列表 GlobSet
    pub deny_set: GlobSet,
    /// MITM 状态（启用 MITM 时存在）
    pub mitm: Option<Arc<MitmState>>,
    /// 按主机索引的 MITM 钩子映射
    pub mitm_hooks: MitmHooksByHost,
    /// 托管策略约束
    pub constraints: NetworkProxyConstraints,
    /// 被阻塞请求的环形缓冲（FIFO，超过 MAX_BLOCKED_EVENTS 时丢弃最旧条目）
    pub blocked: VecDeque<BlockedRequest>,
    /// 累计阻塞总数（不含已丢弃的条目）
    pub blocked_total: u64,
}

/// 配置重载器 trait：抽象配置来源（文件、内存、远程等）。
pub trait ConfigReloader: Send + Sync {
    /// 返回配置来源的人类可读描述（用于日志）。
    fn source_label(&self) -> String;

    /// 若检测到配置变更，返回新的 [`ConfigState`]；否则返回 `None`。
    fn maybe_reload(&self) -> ConfigReloaderFuture<'_, Option<ConfigState>>;

    /// 强制重载配置，无论是否检测到变更。
    fn reload_now(&self) -> ConfigReloaderFuture<'_, ConfigState>;
}

/// [`ConfigReloader`] 方法的返回 future 类型。
pub type ConfigReloaderFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;

/// 被阻塞请求观察者 trait：用于将阻塞事件转发到外部消费者。
pub trait BlockedRequestObserver: Send + Sync + 'static {
    /// 处理被阻塞请求。
    fn on_blocked_request(&self, request: BlockedRequest) -> BlockedRequestObserverFuture<'_>;
}

/// [`BlockedRequestObserver`] 方法的返回 future 类型。
pub type BlockedRequestObserverFuture<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;

impl<O: BlockedRequestObserver + ?Sized> BlockedRequestObserver for Arc<O> {
    fn on_blocked_request(&self, request: BlockedRequest) -> BlockedRequestObserverFuture<'_> {
        Box::pin(async move { (**self).on_blocked_request(request).await })
    }
}

impl<F, Fut> BlockedRequestObserver for F
where
    F: Fn(BlockedRequest) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    fn on_blocked_request(&self, request: BlockedRequest) -> BlockedRequestObserverFuture<'_> {
        Box::pin((self)(request))
    }
}

/// 网络代理共享状态：封装 [`ConfigState`]、配置重载器、阻塞观察者与凭据代理。
///
/// 对外提供主机策略评估、域名增删、配置 reload、阻塞记录等能力。
/// 所有读写均通过 `RwLock` 保护，支持并发访问。
pub struct NetworkProxyState {
    /// 当前配置状态（读写锁保护）
    state: Arc<RwLock<ConfigState>>,
    /// 配置重载器
    reloader: Arc<dyn ConfigReloader>,
    /// 被阻塞请求观察者（可选，运行时可替换）
    blocked_request_observer: Arc<RwLock<Option<Arc<dyn BlockedRequestObserver>>>>,
    /// 凭据代理
    credential_broker: CredentialBroker,
    /// 审计元数据
    audit_metadata: NetworkProxyAuditMetadata,
}

/// 主机对 MITM 的需求等级。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HostMitmRequirement {
    /// 不需要 MITM
    None,
    /// 需要 TLS（用于凭据代理等场景）
    Tls,
    /// 始终需要 MITM（主机配置了 MITM 钩子）
    Always,
}

impl std::fmt::Debug for NetworkProxyState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 避免打印内部状态（配置内容、派生的 GlobSet 等），这些可能产生大量日志
        // 且可能包含敏感路径。
        f.debug_struct("NetworkProxyState").finish_non_exhaustive()
    }
}

impl Clone for NetworkProxyState {
    fn clone(&self) -> Self {
        Self {
            state: self.state.clone(),
            reloader: self.reloader.clone(),
            blocked_request_observer: self.blocked_request_observer.clone(),
            credential_broker: self.credential_broker.clone(),
            audit_metadata: self.audit_metadata.clone(),
        }
    }
}

impl NetworkProxyState {
    pub fn with_reloader(state: ConfigState, reloader: Arc<dyn ConfigReloader>) -> Self {
        Self::with_reloader_and_audit_metadata(
            state,
            reloader,
            NetworkProxyAuditMetadata::default(),
        )
    }

    pub fn with_reloader_and_blocked_observer(
        state: ConfigState,
        reloader: Arc<dyn ConfigReloader>,
        blocked_request_observer: Option<Arc<dyn BlockedRequestObserver>>,
    ) -> Self {
        Self::with_reloader_and_audit_metadata_and_blocked_observer(
            state,
            reloader,
            NetworkProxyAuditMetadata::default(),
            blocked_request_observer,
        )
    }

    pub fn with_reloader_and_audit_metadata(
        state: ConfigState,
        reloader: Arc<dyn ConfigReloader>,
        audit_metadata: NetworkProxyAuditMetadata,
    ) -> Self {
        Self::with_reloader_and_audit_metadata_and_blocked_observer(
            state,
            reloader,
            audit_metadata,
            /*blocked_request_observer*/ None,
        )
    }

    pub fn with_reloader_and_audit_metadata_and_blocked_observer(
        state: ConfigState,
        reloader: Arc<dyn ConfigReloader>,
        audit_metadata: NetworkProxyAuditMetadata,
        blocked_request_observer: Option<Arc<dyn BlockedRequestObserver>>,
    ) -> Self {
        Self {
            credential_broker: CredentialBroker::new(state.config.network.credential_broker),
            state: Arc::new(RwLock::new(state)),
            reloader,
            blocked_request_observer: Arc::new(RwLock::new(blocked_request_observer)),
            audit_metadata,
        }
    }

    pub async fn set_blocked_request_observer(
        &self,
        blocked_request_observer: Option<Arc<dyn BlockedRequestObserver>>,
    ) {
        let mut observer = self.blocked_request_observer.write().await;
        *observer = blocked_request_observer;
    }

    pub fn audit_metadata(&self) -> &NetworkProxyAuditMetadata {
        &self.audit_metadata
    }

    pub fn virtualize_child_credentials(&self, env: &mut HashMap<String, String>) {
        self.credential_broker.virtualize_child_env(env);
    }

    pub fn inject_request_credentials(&self, host: &str, headers: &mut rama_http::HeaderMap) {
        self.credential_broker.inject_request_headers(host, headers);
    }

    pub async fn plaintext_credential_injection_enabled(&self) -> Result<bool> {
        self.reload_if_needed().await?;
        let guard = self.state.read().await;
        Ok(guard
            .config
            .network
            .dangerously_allow_plaintext_credential_injection)
    }

    pub async fn current_cfg(&self) -> Result<NetworkProxyConfig> {
        // Callers treat `NetworkProxyState` as a live view of policy. We reload-on-demand so edits to
        // `config.toml` (including Codex-managed writes) take effect without a restart.
        // 调用方将 `NetworkProxyState` 视为策略的实时视图。我们按需 reload，
        // 使得对 `config.toml` 的修改（包括 Codex 托管写入）无需重启即可生效。
        self.reload_if_needed().await?;
        let guard = self.state.read().await;
        Ok(guard.config.clone())
    }

    pub async fn current_patterns(&self) -> Result<(Vec<String>, Vec<String>)> {
        self.reload_if_needed().await?;
        let guard = self.state.read().await;
        Ok((
            guard.config.network.allowed_domains().unwrap_or_default(),
            guard.config.network.denied_domains().unwrap_or_default(),
        ))
    }

    pub async fn enabled(&self) -> Result<bool> {
        self.reload_if_needed().await?;
        let guard = self.state.read().await;
        Ok(guard.config.network.enabled)
    }

    pub async fn force_reload(&self) -> Result<()> {
        let previous_cfg = {
            let guard = self.state.read().await;
            guard.config.clone()
        };

        match self.reloader.reload_now().await {
            Ok(mut new_state) => {
                self.ensure_credential_broker_enablement_unchanged(&new_state)?;
                // Policy changes are operationally sensitive; logging diffs makes changes traceable
                // without needing to dump full config blobs (which can include unrelated settings).
                // 策略变更在运维上较为敏感；记录 diff 使变更可追溯，
                // 而无需打印完整配置（可能包含无关设置）。
                log_policy_changes(&previous_cfg, &new_state.config);
                {
                    let mut guard = self.state.write().await;
                    new_state.blocked = guard.blocked.clone();
                    *guard = new_state;
                }
                let source = self.reloader.source_label();
                info!("reloaded config from {source}");
                Ok(())
            }
            Err(err) => {
                let source = self.reloader.source_label();
                warn!("failed to reload config from {source}: {err}; keeping previous config");
                Err(err)
            }
        }
    }

    pub async fn replace_config_state(&self, mut new_state: ConfigState) -> Result<()> {
        self.reload_if_needed().await?;
        self.ensure_credential_broker_enablement_unchanged(&new_state)?;
        let mut guard = self.state.write().await;
        log_policy_changes(&guard.config, &new_state.config);
        new_state.blocked = guard.blocked.clone();
        new_state.blocked_total = guard.blocked_total;
        *guard = new_state;
        info!("updated network proxy config state");
        Ok(())
    }

    pub async fn host_blocked(&self, host: &str, port: u16) -> Result<HostBlockDecision> {
        self.reload_if_needed().await?;
        let host = match Host::parse(host) {
            Ok(host) => host,
            Err(_) => return Ok(HostBlockDecision::Blocked(HostBlockReason::NotAllowed)),
        };
        let (deny_set, allow_set, allow_local_binding, allowed_domains) = {
            let guard = self.state.read().await;
            let allowed_domains = guard.config.network.allowed_domains();
            (
                guard.deny_set.clone(),
                guard.allow_set.clone(),
                guard.config.network.allow_local_binding,
                allowed_domains,
            )
        };
        let allowed_domains_empty = allowed_domains.is_none();
        let allowed_domains = allowed_domains.unwrap_or_default();

        let host_str = host.as_str();

        // Decision order matters:
        //  1) explicit deny always wins
        //  2) local/private networking is opt-in (defense-in-depth)
        //  3) allowlist is enforced when configured
        // 决策顺序至关重要：
        //  1) 显式拒绝总是优先
        //  2) 本地/私有网络访问需显式 opt-in（深度防御）
        //  3) 配置了允许列表时强制执行
        if globset_matches_host_or_unscoped(&deny_set, host_str) {
            return Ok(HostBlockDecision::Blocked(HostBlockReason::Denied));
        }

        let is_allowlisted = globset_matches_host_or_unscoped(&allow_set, host_str);
        if !allow_local_binding {
            // If the intent is "prevent access to local/internal networks", we must not rely solely
            // on string checks like `localhost` / `127.0.0.1`. Attackers can use DNS rebinding or
            // public suffix services that map hostnames onto private IPs.
            //
            // We therefore do a best-effort DNS + IP classification check before allowing the
            // request. Explicit local/loopback literals are allowed only when explicitly
            // allowlisted; hostnames that resolve to local/private IPs are blocked even if
            // allowlisted.
            // 若意图是"阻止访问本地/内部网络"，不能仅依赖 `localhost`/`127.0.0.1` 等字符串检查。
            // 攻击者可使用 DNS 重绑定或公共后缀服务将主机名映射到私有 IP。
            //
            // 因此在允许请求前执行尽力而为的 DNS + IP 分类检查。
            // 显式的本地/回环字面量仅在显式允许时才放行；
            // 解析到本地/私有 IP 的主机名即使被允许也会被阻塞。
            let local_literal = {
                let host_no_scope = unscoped_ip_literal(host_str).unwrap_or(host_str);
                if is_loopback_host(&host) {
                    true
                } else if let Ok(ip) = host_no_scope.parse::<IpAddr>() {
                    is_non_public_ip(ip)
                } else {
                    false
                }
            };

            if local_literal {
                if !is_explicit_local_allowlisted(&allowed_domains, &host) {
                    return Ok(HostBlockDecision::Blocked(HostBlockReason::NotAllowedLocal));
                }
            } else if host_resolves_to_non_public_ip(
                host_str,
                port,
                DNS_LOOKUP_TIMEOUT,
                |host, port| async move {
                    lookup_host((host.as_str(), port))
                        .await
                        .map(Iterator::collect)
                },
            )
            .await
            {
                return Ok(HostBlockDecision::Blocked(HostBlockReason::NotAllowedLocal));
            }
        }

        if allowed_domains_empty || !is_allowlisted {
            Ok(HostBlockDecision::Blocked(HostBlockReason::NotAllowed))
        } else {
            Ok(HostBlockDecision::Allowed)
        }
    }

    pub async fn record_blocked(&self, entry: BlockedRequest) -> Result<()> {
        self.reload_if_needed().await?;
        let blocked_for_observer = entry.clone();
        let blocked_request_observer = self.blocked_request_observer.read().await.clone();
        let violation_line = blocked_request_violation_log_line(&entry);
        let host = entry.host.clone();
        let reason = entry.reason.clone();
        let decision = entry.decision.clone();
        let source = entry.source.clone();
        let protocol = entry.protocol.clone();
        let port = entry.port;
        let (total, buffered) = {
            let mut guard = self.state.write().await;
            guard.blocked.push_back(entry);
            guard.blocked_total = guard.blocked_total.saturating_add(1);
            let total = guard.blocked_total;
            while guard.blocked.len() > MAX_BLOCKED_EVENTS {
                guard.blocked.pop_front();
            }
            (total, guard.blocked.len())
        };
        debug!(
            "recorded blocked request telemetry (\
             total={total}, host={host}, reason={reason}, \
             decision={decision:?}, source={source:?}, \
             protocol={protocol}, port={port:?}, buffered={buffered})"
        );
        debug!("{violation_line}");

        if let Some(observer) = blocked_request_observer {
            observer.on_blocked_request(blocked_for_observer).await;
        }
        Ok(())
    }

    /// Returns a snapshot of buffered blocked-request entries without consuming
    /// them.
    /// 返回缓冲的被阻塞请求快照（不消耗条目）。
    pub async fn blocked_snapshot(&self) -> Result<Vec<BlockedRequest>> {
        self.reload_if_needed().await?;
        let guard = self.state.read().await;
        Ok(guard.blocked.iter().cloned().collect())
    }

    /// Drain and return the buffered blocked-request entries in FIFO order.
    /// 按 FIFO 顺序取出并返回缓冲的被阻塞请求条目。
    pub async fn drain_blocked(&self) -> Result<Vec<BlockedRequest>> {
        self.reload_if_needed().await?;
        let blocked = {
            let mut guard = self.state.write().await;
            std::mem::take(&mut guard.blocked)
        };
        Ok(blocked.into_iter().collect())
    }

    pub async fn is_unix_socket_allowed(&self, path: &str) -> Result<bool> {
        self.reload_if_needed().await?;
        if !unix_socket_permissions_supported() {
            return Ok(false);
        }

        // We only support absolute unix socket paths (a relative path would be ambiguous with
        // respect to the proxy process's CWD and can lead to confusing allowlist behavior).
        // 仅支持绝对路径的 unix socket：相对路径会因代理进程的 CWD 不同而产生歧义，
        // 导致允许列表行为混乱。
        let requested_path = Path::new(path);
        if !requested_path.is_absolute() {
            return Ok(false);
        }

        let guard = self.state.read().await;
        if guard.config.network.dangerously_allow_all_unix_sockets {
            return Ok(true);
        }

        // Normalize the path while keeping the absolute-path requirement explicit.
        // 在保持绝对路径要求的前提下归一化路径。
        let requested_abs = match AbsolutePathBuf::from_absolute_path(requested_path) {
            Ok(path) => path,
            Err(_) => return Ok(false),
        };
        let requested_canonical = std::fs::canonicalize(requested_abs.as_path()).ok();
        for allowed in &guard.config.network.allow_unix_sockets() {
            let allowed_path = match ValidatedUnixSocketPath::parse(allowed) {
                Ok(ValidatedUnixSocketPath::Native(path)) => path,
                Ok(ValidatedUnixSocketPath::UnixStyleAbsolute(_)) => continue,
                Err(err) => {
                    warn!("ignoring invalid network.allow_unix_sockets entry at runtime: {err:#}");
                    continue;
                }
            };

            if allowed_path.as_path() == requested_abs.as_path() {
                return Ok(true);
            }

            // Best-effort canonicalization to reduce surprises with symlinks.
            // If canonicalization fails (e.g., socket not created yet), fall back to raw comparison.
            // 尽力而为的规范化以减少符号链接导致的意外。
            // 若规范化失败（如 socket 尚未创建），回退到原始比较。
            let Some(requested_canonical) = &requested_canonical else {
                continue;
            };
            if let Ok(allowed_canonical) = std::fs::canonicalize(allowed_path.as_path())
                && &allowed_canonical == requested_canonical
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub async fn method_allowed(&self, method: &str) -> Result<bool> {
        self.reload_if_needed().await?;
        let guard = self.state.read().await;
        Ok(guard.config.network.mode.allows_method(method))
    }

    pub async fn allow_upstream_proxy(&self) -> Result<bool> {
        self.reload_if_needed().await?;
        let guard = self.state.read().await;
        Ok(guard.config.network.allow_upstream_proxy)
    }

    pub async fn allow_local_binding(&self) -> Result<bool> {
        self.reload_if_needed().await?;
        let guard = self.state.read().await;
        Ok(guard.config.network.allow_local_binding)
    }

    pub async fn network_mode(&self) -> Result<NetworkMode> {
        self.reload_if_needed().await?;
        let guard = self.state.read().await;
        Ok(guard.config.network.mode)
    }

    pub async fn set_network_mode(&self, mode: NetworkMode) -> Result<()> {
        loop {
            self.reload_if_needed().await?;
            let (candidate, constraints) = {
                let guard = self.state.read().await;
                let mut candidate = guard.config.clone();
                candidate.network.mode = mode;
                (candidate, guard.constraints.clone())
            };

            validate_policy_against_constraints(&candidate, &constraints)
                .map_err(NetworkProxyConstraintError::into_anyhow)
                .context("network.mode constrained by managed config")?;

            let mut guard = self.state.write().await;
            if guard.constraints != constraints {
                drop(guard);
                continue;
            }
            guard.config.network.mode = mode;
            info!("updated network mode to {mode:?}");
            return Ok(());
        }
    }

    pub async fn mitm_state(&self) -> Result<Option<Arc<MitmState>>> {
        self.reload_if_needed().await?;
        let guard = self.state.read().await;
        Ok(guard.mitm.clone())
    }

    pub(crate) async fn evaluate_mitm_hook_request(
        &self,
        host: &str,
        req: &rama_http::Request,
    ) -> Result<HookEvaluation> {
        self.reload_if_needed().await?;
        let guard = self.state.read().await;
        Ok(evaluate_mitm_hooks(&guard.mitm_hooks, host, req))
    }

    pub(crate) async fn host_mitm_requirement(&self, host: &str) -> Result<HostMitmRequirement> {
        self.reload_if_needed().await?;
        let normalized_host = normalize_host(host);
        let host_has_mitm_hooks = {
            let guard = self.state.read().await;
            guard.mitm_hooks.contains_key(&normalized_host)
        };
        Ok(if host_has_mitm_hooks {
            HostMitmRequirement::Always
        } else if self.credential_broker.host_requires_mitm(&normalized_host) {
            HostMitmRequirement::Tls
        } else {
            HostMitmRequirement::None
        })
    }

    pub async fn add_allowed_domain(&self, host: &str) -> Result<()> {
        self.update_domain_list(host, DomainListKind::Allow).await
    }

    pub async fn add_denied_domain(&self, host: &str) -> Result<()> {
        self.update_domain_list(host, DomainListKind::Deny).await
    }

    async fn update_domain_list(&self, host: &str, target: DomainListKind) -> Result<()> {
        let host = Host::parse(host).context("invalid network host")?;
        let normalized_host = host.as_str().to_string();
        let list_name = target.list_name();
        let constraint_field = target.constraint_field();

        loop {
            self.reload_if_needed().await?;
            let (previous_cfg, constraints, blocked, blocked_total) = {
                let guard = self.state.read().await;
                (
                    guard.config.clone(),
                    guard.constraints.clone(),
                    guard.blocked.clone(),
                    guard.blocked_total,
                )
            };

            let mut candidate = previous_cfg.clone();
            let target_entries = target.entries(&candidate.network);
            let opposite_entries = target.opposite_entries(&candidate.network);
            let target_contains = target_entries
                .iter()
                .any(|entry| normalize_host(entry) == normalized_host);
            let opposite_contains = opposite_entries
                .iter()
                .any(|entry| normalize_host(entry) == normalized_host);
            if target_contains && !opposite_contains {
                return Ok(());
            }

            candidate.network.upsert_domain_permission(
                normalized_host.clone(),
                target.permission(),
                normalize_host,
            );

            validate_policy_against_constraints(&candidate, &constraints)
                .map_err(NetworkProxyConstraintError::into_anyhow)
                .with_context(|| format!("{constraint_field} constrained by managed config"))?;

            let mut new_state = build_config_state(candidate.clone(), constraints.clone())
                .with_context(|| format!("failed to compile updated network {list_name}"))?;
            new_state.blocked = blocked;
            new_state.blocked_total = blocked_total;

            let mut guard = self.state.write().await;
            if guard.constraints != constraints || guard.config != previous_cfg {
                drop(guard);
                continue;
            }

            log_policy_changes(&guard.config, &candidate);
            *guard = new_state;
            info!("updated network {list_name} with {normalized_host}");
            return Ok(());
        }
    }

    async fn reload_if_needed(&self) -> Result<()> {
        match self.reloader.maybe_reload().await? {
            None => Ok(()),
            Some(mut new_state) => {
                self.ensure_credential_broker_enablement_unchanged(&new_state)?;
                let (previous_cfg, blocked, blocked_total) = {
                    let guard = self.state.read().await;
                    (
                        guard.config.clone(),
                        guard.blocked.clone(),
                        guard.blocked_total,
                    )
                };
                log_policy_changes(&previous_cfg, &new_state.config);
                new_state.blocked = blocked;
                new_state.blocked_total = blocked_total;
                {
                    let mut guard = self.state.write().await;
                    *guard = new_state;
                }
                let source = self.reloader.source_label();
                info!("reloaded config from {source}");
                Ok(())
            }
        }
    }

    fn ensure_credential_broker_enablement_unchanged(&self, new_state: &ConfigState) -> Result<()> {
        anyhow::ensure!(
            self.credential_broker.enabled() == new_state.config.network.credential_broker,
            "network.credential_broker cannot change while the proxy is running"
        );
        Ok(())
    }
}

/// 域名列表类型：区分允许列表与拒绝列表，用于增删操作的泛化处理。
#[derive(Clone, Copy)]
enum DomainListKind {
    /// 允许列表
    Allow,
    /// 拒绝列表
    Deny,
}

impl DomainListKind {
    /// 返回列表的人类可读名称（用于日志）。
    fn list_name(self) -> &'static str {
        match self {
            Self::Allow => "allowlist",
            Self::Deny => "denylist",
        }
    }

    /// 返回对应的托管策略约束字段名。
    fn constraint_field(self) -> &'static str {
        match self {
            Self::Allow => "network.allowed_domains",
            Self::Deny => "network.denied_domains",
        }
    }

    /// 返回对应的域名权限。
    fn permission(self) -> NetworkDomainPermission {
        match self {
            Self::Allow => NetworkDomainPermission::Allow,
            Self::Deny => NetworkDomainPermission::Deny,
        }
    }

    /// 返回该列表类型的当前条目。
    fn entries(self, network: &crate::config::NetworkProxySettings) -> Vec<String> {
        match self {
            Self::Allow => network.allowed_domains().unwrap_or_default(),
            Self::Deny => network.denied_domains().unwrap_or_default(),
        }
    }

    /// 返回对侧列表类型的当前条目（如 Allow 返回 deny 条目）。
    fn opposite_entries(self, network: &crate::config::NetworkProxySettings) -> Vec<String> {
        match self {
            Self::Allow => network.denied_domains().unwrap_or_default(),
            Self::Deny => network.allowed_domains().unwrap_or_default(),
        }
    }
}

/// 判断当前平台是否支持 unix socket 权限控制。
///
/// 目前仅 macOS 支持，其他平台请求会被拒绝。
pub(crate) fn unix_socket_permissions_supported() -> bool {
    cfg!(target_os = "macos")
}

/// 判断主机是否解析为非公网 IP（用于 SSRF 防御）。
///
/// - 若主机为 IP 字面量，直接判定
/// - 否则执行 DNS 查询（带超时），若任一解析结果为非公网 IP 则返回 true
/// - DNS 查询失败或超时也返回 true（保守策略）
async fn host_resolves_to_non_public_ip<F, Fut>(
    host: &str,
    port: u16,
    lookup_timeout: Duration,
    lookup: F,
) -> bool
where
    F: FnOnce(String, u16) -> Fut,
    Fut: Future<Output = std::io::Result<Vec<SocketAddr>>>,
{
    if let Ok(ip) = host.parse::<IpAddr>() {
        return is_non_public_ip(ip);
    }

    // Block the request if this DNS lookup fails. We resolve the hostname again when we connect,
    // so a failed check here does not prove the destination is public.
    // 若 DNS 查询失败则阻塞请求。我们在连接时会再次解析主机名，
    // 因此此处检查失败并不证明目标是公网地址。
    let addrs = match timeout(lookup_timeout, lookup(host.to_string(), port)).await {
        Ok(Ok(addrs)) => addrs,
        Ok(Err(err)) => {
            debug!(
                "blocking host because DNS lookup failed during local/private IP check (host={host}, port={port}): {err}"
            );
            return true;
        }
        Err(_) => {
            debug!(
                "blocking host because DNS lookup timed out during local/private IP check (host={host}, port={port})"
            );
            return true;
        }
    };

    for addr in addrs {
        if is_non_public_ip(addr.ip()) {
            return true;
        }
    }

    false
}

/// 记录允许/拒绝列表的变更日志（仅记录增量与删除，不打印完整列表）。
fn log_policy_changes(previous: &NetworkProxyConfig, next: &NetworkProxyConfig) {
    let previous_allowed_domains = previous.network.allowed_domains().unwrap_or_default();
    let next_allowed_domains = next.network.allowed_domains().unwrap_or_default();
    log_domain_list_changes(
        "allowlist",
        &previous_allowed_domains,
        &next_allowed_domains,
    );
    let previous_denied_domains = previous.network.denied_domains().unwrap_or_default();
    let next_denied_domains = next.network.denied_domains().unwrap_or_default();
    log_domain_list_changes("denylist", &previous_denied_domains, &next_denied_domains);
}

/// 记录单个域名列表的增量与删除日志。
///
/// 按原始顺序遍历，仅记录首次出现的新增或删除条目，保持日志可读性。
fn log_domain_list_changes(list_name: &str, previous: &[String], next: &[String]) {
    let previous_set: HashSet<String> = previous
        .iter()
        .map(|entry| entry.to_ascii_lowercase())
        .collect();
    let next_set: HashSet<String> = next
        .iter()
        .map(|entry| entry.to_ascii_lowercase())
        .collect();

    let added = next_set
        .difference(&previous_set)
        .cloned()
        .collect::<HashSet<_>>();
    let removed = previous_set
        .difference(&next_set)
        .cloned()
        .collect::<HashSet<_>>();

    let mut seen_next = HashSet::new();
    for entry in next {
        let key = entry.to_ascii_lowercase();
        if seen_next.insert(key.clone()) && added.contains(&key) {
            info!("config entry added to {list_name}: {entry}");
        }
    }

    let mut seen_previous = HashSet::new();
    for entry in previous {
        let key = entry.to_ascii_lowercase();
        if seen_previous.insert(key.clone()) && removed.contains(&key) {
            info!("config entry removed from {list_name}: {entry}");
        }
    }
}

/// 判断 GlobSet 是否匹配主机（含去除 scope id 的 IP 字面量回退）。
fn globset_matches_host_or_unscoped(set: &GlobSet, host: &str) -> bool {
    set.is_match(host) || unscoped_ip_literal(host).is_some_and(|ip| set.is_match(ip))
}

/// 判断主机是否被显式允许为本地地址（非通配符模式）。
///
/// 用于 `allow_local_binding = false` 时，允许用户显式允许 `localhost`/`127.0.0.1` 等。
fn is_explicit_local_allowlisted(allowed_domains: &[String], host: &Host) -> bool {
    let normalized_host = host.as_str();
    let unscoped_host = unscoped_ip_literal(normalized_host);
    allowed_domains.iter().any(|pattern| {
        let pattern = pattern.trim();
        // 通配符模式不视为显式允许
        if pattern == "*" || pattern.starts_with("*.") || pattern.starts_with("**.") {
            return false;
        }
        if pattern.contains('*') || pattern.contains('?') {
            return false;
        }
        let normalized_pattern = normalize_host(pattern);
        normalized_pattern == normalized_host
            || unscoped_host.is_some_and(|ip| normalized_pattern == ip)
    })
}

/// 返回当前 UTC 时间的 Unix 时间戳（秒）。
fn unix_timestamp() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

#[cfg(test)]
pub(crate) fn network_proxy_state_for_policy(
    mut network: crate::config::NetworkProxySettings,
) -> NetworkProxyState {
    network.enabled = true;
    let config = NetworkProxyConfig { network };
    let state = ConfigState {
        allow_set: crate::policy::compile_allowlist_globset(
            &config.network.allowed_domains().unwrap_or_default(),
        )
        .unwrap(),
        blocked: VecDeque::new(),
        blocked_total: 0,
        config: config.clone(),
        constraints: NetworkProxyConstraints::default(),
        deny_set: crate::policy::compile_denylist_globset(
            &config.network.denied_domains().unwrap_or_default(),
        )
        .unwrap(),
        mitm: None,
        mitm_hooks: crate::mitm_hook::compile_mitm_hooks(&config).unwrap(),
    };

    NetworkProxyState::with_reloader(state, Arc::new(NoopReloader))
}

#[cfg(test)]
struct NoopReloader;

#[cfg(test)]
impl ConfigReloader for NoopReloader {
    fn source_label(&self) -> String {
        "test config state".to_string()
    }

    fn maybe_reload(&self) -> ConfigReloaderFuture<'_, Option<ConfigState>> {
        Box::pin(async { Ok(None) })
    }

    fn reload_now(&self) -> ConfigReloaderFuture<'_, ConfigState> {
        Box::pin(async { Err(anyhow::anyhow!("force reload is not supported in tests")) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::config::NetworkProxyConfig;
    use crate::config::NetworkProxySettings;
    use crate::policy::compile_allowlist_globset;
    use crate::policy::compile_denylist_globset;
    use crate::state::NetworkProxyConstraints;
    use crate::state::build_config_state;
    use crate::state::validate_policy_against_constraints;
    use pretty_assertions::assert_eq;

    #[derive(Clone)]
    struct StaticReloader {
        state: ConfigState,
    }

    impl ConfigReloader for StaticReloader {
        fn source_label(&self) -> String {
            "static test reloader".to_string()
        }

        fn maybe_reload(&self) -> ConfigReloaderFuture<'_, Option<ConfigState>> {
            let state = self.state.clone();
            Box::pin(async move { Ok(Some(state)) })
        }

        fn reload_now(&self) -> ConfigReloaderFuture<'_, ConfigState> {
            let state = self.state.clone();
            Box::pin(async move { Ok(state) })
        }
    }

    fn strings(entries: &[&str]) -> Vec<String> {
        entries.iter().map(|entry| (*entry).to_string()).collect()
    }

    fn network_settings(allowed_domains: &[&str], denied_domains: &[&str]) -> NetworkProxySettings {
        let mut network = NetworkProxySettings::default();
        if !allowed_domains.is_empty() {
            network.set_allowed_domains(strings(allowed_domains));
        }
        if !denied_domains.is_empty() {
            network.set_denied_domains(strings(denied_domains));
        }
        network
    }

    fn network_settings_with_unix_sockets(
        allowed_domains: &[&str],
        denied_domains: &[&str],
        unix_sockets: &[String],
    ) -> NetworkProxySettings {
        let mut network = network_settings(allowed_domains, denied_domains);
        if !unix_sockets.is_empty() {
            network.set_allow_unix_sockets(unix_sockets.to_vec());
        }
        network
    }

    #[tokio::test]
    async fn reload_rejects_credential_broker_enablement_changes() {
        let initial_state = build_config_state(
            NetworkProxyConfig::default(),
            NetworkProxyConstraints::default(),
        )
        .unwrap();
        let mut reloaded_state = initial_state.clone();
        reloaded_state
            .config
            .set_credential_broker_enabled(/*enabled*/ true);
        let state = NetworkProxyState::with_reloader(
            initial_state,
            Arc::new(StaticReloader {
                state: reloaded_state,
            }),
        );

        let err = state
            .force_reload()
            .await
            .expect_err("credential broker enablement should require a proxy restart");
        let mut env = HashMap::from([("OPENAI_API_KEY".to_string(), "sk-real".to_string())]);
        state.virtualize_child_credentials(&mut env);

        assert!(
            format!("{err:#}")
                .contains("network.credential_broker cannot change while the proxy is running"),
            "unexpected error: {err:#}"
        );
        assert_eq!(env["OPENAI_API_KEY"], "sk-real");
        assert!(!state.credential_broker.enabled());
    }

    #[tokio::test]
    async fn host_blocked_denied_wins_over_allowed() {
        let state =
            network_proxy_state_for_policy(network_settings(&["example.com"], &["example.com"]));

        assert_eq!(
            state
                .host_blocked("example.com", /*port*/ 80)
                .await
                .unwrap(),
            HostBlockDecision::Blocked(HostBlockReason::Denied)
        );
    }

    #[tokio::test]
    async fn host_blocked_requires_allowlist_match() {
        let state = network_proxy_state_for_policy(network_settings(&["example.com"], &[]));

        assert_eq!(
            state
                .host_blocked("example.com", /*port*/ 80)
                .await
                .unwrap(),
            HostBlockDecision::Allowed
        );
        assert_eq!(
            // Use a public IP literal to avoid relying on ambient DNS behavior (some networks
            // resolve unknown hostnames to private IPs, which would trigger `not_allowed_local`).
            state.host_blocked("8.8.8.8", /*port*/ 80).await.unwrap(),
            HostBlockDecision::Blocked(HostBlockReason::NotAllowed)
        );
    }

    #[tokio::test]
    async fn add_allowed_domain_removes_matching_deny_entry() {
        let state = network_proxy_state_for_policy(network_settings(&[], &["example.com"]));

        state.add_allowed_domain("ExAmPlE.CoM").await.unwrap();

        let (allowed, denied) = state.current_patterns().await.unwrap();
        assert_eq!(allowed, vec!["example.com".to_string()]);
        assert!(denied.is_empty());
        assert_eq!(
            state
                .host_blocked("example.com", /*port*/ 80)
                .await
                .unwrap(),
            HostBlockDecision::Allowed
        );
    }

    #[tokio::test]
    async fn add_denied_domain_removes_matching_allow_entry() {
        let state = network_proxy_state_for_policy(network_settings(&["example.com"], &[]));

        state.add_denied_domain("EXAMPLE.COM").await.unwrap();

        let (allowed, denied) = state.current_patterns().await.unwrap();
        assert!(allowed.is_empty());
        assert_eq!(denied, vec!["example.com".to_string()]);
        assert_eq!(
            state
                .host_blocked("example.com", /*port*/ 80)
                .await
                .unwrap(),
            HostBlockDecision::Blocked(HostBlockReason::Denied)
        );
    }

    #[tokio::test]
    async fn add_denied_domain_forces_block_with_global_wildcard_allowlist() {
        let state = network_proxy_state_for_policy(network_settings(&["*"], &[]));

        assert_eq!(
            // Use a public IP literal to avoid relying on ambient DNS behavior.
            state.host_blocked("8.8.8.8", /*port*/ 80).await.unwrap(),
            HostBlockDecision::Allowed
        );

        state.add_denied_domain("8.8.8.8").await.unwrap();

        let (allowed, denied) = state.current_patterns().await.unwrap();
        assert_eq!(allowed, vec!["*".to_string()]);
        assert_eq!(denied, vec!["8.8.8.8".to_string()]);
        assert_eq!(
            state.host_blocked("8.8.8.8", /*port*/ 80).await.unwrap(),
            HostBlockDecision::Blocked(HostBlockReason::Denied)
        );
    }

    #[tokio::test]
    async fn add_allowed_domain_succeeds_when_managed_baseline_allows_expansion() {
        let config = NetworkProxyConfig {
            network: {
                let mut network = network_settings(&["managed.example.com"], &[]);
                network.enabled = true;
                network
            },
        };
        let constraints = NetworkProxyConstraints {
            allowed_domains: Some(vec!["managed.example.com".to_string()]),
            allowlist_expansion_enabled: Some(true),
            ..NetworkProxyConstraints::default()
        };
        let state = NetworkProxyState::with_reloader(
            build_config_state(config, constraints).unwrap(),
            Arc::new(NoopReloader),
        );

        state.add_allowed_domain("user.example.com").await.unwrap();

        let (allowed, denied) = state.current_patterns().await.unwrap();
        assert_eq!(
            allowed,
            vec![
                "managed.example.com".to_string(),
                "user.example.com".to_string()
            ]
        );
        assert!(denied.is_empty());
    }

    #[tokio::test]
    async fn add_allowed_domain_rejects_expansion_when_managed_baseline_is_fixed() {
        let config = NetworkProxyConfig {
            network: {
                let mut network = network_settings(&["managed.example.com"], &[]);
                network.enabled = true;
                network
            },
        };
        let constraints = NetworkProxyConstraints {
            allowed_domains: Some(vec!["managed.example.com".to_string()]),
            allowlist_expansion_enabled: Some(false),
            ..NetworkProxyConstraints::default()
        };
        let state = NetworkProxyState::with_reloader(
            build_config_state(config, constraints).unwrap(),
            Arc::new(NoopReloader),
        );

        let err = state
            .add_allowed_domain("user.example.com")
            .await
            .expect_err("managed baseline should reject allowlist expansion");

        assert!(
            format!("{err:#}").contains("network.allowed_domains constrained by managed config"),
            "unexpected error: {err:#}"
        );
    }

    #[tokio::test]
    async fn add_denied_domain_rejects_expansion_when_managed_baseline_is_fixed() {
        let config = NetworkProxyConfig {
            network: {
                let mut network = network_settings(&[], &["managed.example.com"]);
                network.enabled = true;
                network
            },
        };
        let constraints = NetworkProxyConstraints {
            denied_domains: Some(vec!["managed.example.com".to_string()]),
            denylist_expansion_enabled: Some(false),
            ..NetworkProxyConstraints::default()
        };
        let state = NetworkProxyState::with_reloader(
            build_config_state(config, constraints).unwrap(),
            Arc::new(NoopReloader),
        );

        let err = state
            .add_denied_domain("user.example.com")
            .await
            .expect_err("managed baseline should reject denylist expansion");

        assert!(
            format!("{err:#}").contains("network.denied_domains constrained by managed config"),
            "unexpected error: {err:#}"
        );
    }

    #[tokio::test]
    async fn blocked_snapshot_does_not_consume_entries() {
        let state = network_proxy_state_for_policy(NetworkProxySettings::default());

        state
            .record_blocked(BlockedRequest::new(BlockedRequestArgs {
                host: "google.com".to_string(),
                reason: "not_allowed".to_string(),
                client: None,
                method: Some("GET".to_string()),
                mode: None,
                protocol: "http".to_string(),
                decision: Some("ask".to_string()),
                source: Some("decider".to_string()),
                port: Some(80),
            }))
            .await
            .expect("entry should be recorded");

        let snapshot = state
            .blocked_snapshot()
            .await
            .expect("snapshot should succeed");
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].host, "google.com");
        assert_eq!(snapshot[0].decision.as_deref(), Some("ask"));

        let drained = state
            .drain_blocked()
            .await
            .expect("drain should include snapshot entry");
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0].host, snapshot[0].host);
        assert_eq!(drained[0].reason, snapshot[0].reason);
        assert_eq!(drained[0].decision, snapshot[0].decision);
        assert_eq!(drained[0].source, snapshot[0].source);
        assert_eq!(drained[0].port, snapshot[0].port);
    }

    #[tokio::test]
    async fn drain_blocked_returns_buffered_window() {
        let state = network_proxy_state_for_policy(NetworkProxySettings::default());

        for idx in 0..(MAX_BLOCKED_EVENTS + 5) {
            state
                .record_blocked(BlockedRequest::new(BlockedRequestArgs {
                    host: format!("example{idx}.com"),
                    reason: "not_allowed".to_string(),
                    client: None,
                    method: Some("GET".to_string()),
                    mode: None,
                    protocol: "http".to_string(),
                    decision: Some("ask".to_string()),
                    source: Some("decider".to_string()),
                    port: Some(80),
                }))
                .await
                .expect("entry should be recorded");
        }

        let blocked = state.drain_blocked().await.expect("drain should succeed");
        assert_eq!(blocked.len(), MAX_BLOCKED_EVENTS);
        assert_eq!(blocked[0].host, "example5.com");
    }

    #[test]
    fn blocked_request_violation_log_line_serializes_payload() {
        let entry = BlockedRequest {
            host: "google.com".to_string(),
            reason: "not_allowed".to_string(),
            client: Some("127.0.0.1".to_string()),
            method: Some("GET".to_string()),
            mode: Some(NetworkMode::Full),
            protocol: "http".to_string(),
            decision: Some("ask".to_string()),
            source: Some("decider".to_string()),
            port: Some(80),
            timestamp: 1_735_689_600,
        };

        assert_eq!(
            blocked_request_violation_log_line(&entry),
            r#"CODEX_NETWORK_POLICY_VIOLATION {"host":"google.com","reason":"not_allowed","client":"127.0.0.1","method":"GET","mode":"full","protocol":"http","decision":"ask","source":"decider","port":80,"timestamp":1735689600}"#
        );
    }

    #[tokio::test]
    async fn host_blocked_subdomain_wildcards_exclude_apex() {
        let state = network_proxy_state_for_policy(network_settings(&["*.openai.com"], &[]));

        assert_eq!(
            state
                .host_blocked("api.openai.com", /*port*/ 80)
                .await
                .unwrap(),
            HostBlockDecision::Allowed
        );
        assert_eq!(
            state.host_blocked("openai.com", /*port*/ 80).await.unwrap(),
            HostBlockDecision::Blocked(HostBlockReason::NotAllowed)
        );
    }

    #[tokio::test]
    async fn host_blocked_global_wildcard_allowlist_allows_public_hosts_except_denylist() {
        let state = network_proxy_state_for_policy(network_settings(&["*"], &["evil.example"]));

        assert_eq!(
            state
                .host_blocked("example.com", /*port*/ 80)
                .await
                .unwrap(),
            HostBlockDecision::Allowed
        );
        assert_eq!(
            state
                .host_blocked("api.openai.com", /*port*/ 443)
                .await
                .unwrap(),
            HostBlockDecision::Allowed
        );
        assert_eq!(
            state
                .host_blocked("evil.example", /*port*/ 80)
                .await
                .unwrap(),
            HostBlockDecision::Blocked(HostBlockReason::Denied)
        );
    }

    #[tokio::test]
    async fn host_blocked_rejects_loopback_when_local_binding_disabled() {
        let state = network_proxy_state_for_policy(network_settings(&["example.com"], &[]));

        assert_eq!(
            state.host_blocked("127.0.0.1", /*port*/ 80).await.unwrap(),
            HostBlockDecision::Blocked(HostBlockReason::NotAllowedLocal)
        );
        assert_eq!(
            state.host_blocked("localhost", /*port*/ 80).await.unwrap(),
            HostBlockDecision::Blocked(HostBlockReason::NotAllowedLocal)
        );
    }

    #[tokio::test]
    async fn host_blocked_allows_loopback_when_explicitly_allowlisted_and_local_binding_disabled() {
        let state = network_proxy_state_for_policy(network_settings(&["localhost"], &[]));

        assert_eq!(
            state.host_blocked("localhost", /*port*/ 80).await.unwrap(),
            HostBlockDecision::Allowed
        );
    }

    #[tokio::test]
    async fn host_blocked_allows_private_ip_literal_when_explicitly_allowlisted() {
        let state = network_proxy_state_for_policy(network_settings(&["10.0.0.1"], &[]));

        assert_eq!(
            state.host_blocked("10.0.0.1", /*port*/ 80).await.unwrap(),
            HostBlockDecision::Allowed
        );
    }

    #[tokio::test]
    async fn host_blocked_rejects_scoped_ipv6_literal_when_not_allowlisted() {
        let state = network_proxy_state_for_policy(network_settings(&["example.com"], &[]));

        assert_eq!(
            state
                .host_blocked("fe80::1%lo0", /*port*/ 80)
                .await
                .unwrap(),
            HostBlockDecision::Blocked(HostBlockReason::NotAllowedLocal)
        );
    }

    #[tokio::test]
    async fn host_blocked_allows_scoped_ipv6_literal_when_explicitly_allowlisted() {
        let state = network_proxy_state_for_policy(network_settings(&["fe80::1"], &[]));

        assert_eq!(
            state
                .host_blocked("fe80::1%lo0", /*port*/ 80)
                .await
                .unwrap(),
            HostBlockDecision::Allowed
        );
    }

    #[tokio::test]
    async fn host_blocked_requires_exact_scoped_ipv6_allowlist_match() {
        let state = network_proxy_state_for_policy(NetworkProxySettings {
            allow_local_binding: true,
            ..network_settings(&["fe80::1%eth0"], &[])
        });

        assert_eq!(
            state
                .host_blocked("fe80::1%eth0", /*port*/ 80)
                .await
                .unwrap(),
            HostBlockDecision::Allowed
        );
        assert_eq!(
            state
                .host_blocked("fe80::1%eth1", /*port*/ 80)
                .await
                .unwrap(),
            HostBlockDecision::Blocked(HostBlockReason::NotAllowed)
        );
    }

    #[tokio::test]
    async fn host_blocked_denies_scoped_ipv6_literal_before_local_binding() {
        let state = network_proxy_state_for_policy(NetworkProxySettings {
            allow_local_binding: true,
            ..network_settings(&["*"], &["fd00::1"])
        });

        for host in ["fd00::1%eth0", "[fd00::1%eth0]", "[fd00::1%25eth0]"] {
            assert_eq!(
                state.host_blocked(host, /*port*/ 80).await.unwrap(),
                HostBlockDecision::Blocked(HostBlockReason::Denied),
                "host should be denied after normalization: {host}"
            );
        }
    }

    #[tokio::test]
    async fn host_blocked_requires_exact_scoped_ipv6_denylist_match() {
        let state = network_proxy_state_for_policy(NetworkProxySettings {
            allow_local_binding: true,
            ..network_settings(&["*"], &["fd00::1%eth0"])
        });

        assert_eq!(
            state
                .host_blocked("fd00::1%eth0", /*port*/ 80)
                .await
                .unwrap(),
            HostBlockDecision::Blocked(HostBlockReason::Denied)
        );
        assert_eq!(
            state
                .host_blocked("fd00::1%eth1", /*port*/ 80)
                .await
                .unwrap(),
            HostBlockDecision::Allowed
        );
    }

    #[tokio::test]
    async fn host_blocked_rejects_private_ip_literals_when_local_binding_disabled() {
        let state = network_proxy_state_for_policy(network_settings(&["example.com"], &[]));

        assert_eq!(
            state.host_blocked("10.0.0.1", /*port*/ 80).await.unwrap(),
            HostBlockDecision::Blocked(HostBlockReason::NotAllowedLocal)
        );
    }

    #[tokio::test]
    async fn host_blocked_rejects_loopback_when_allowlist_empty() {
        let state = network_proxy_state_for_policy(NetworkProxySettings::default());

        assert_eq!(
            state.host_blocked("127.0.0.1", /*port*/ 80).await.unwrap(),
            HostBlockDecision::Blocked(HostBlockReason::NotAllowedLocal)
        );
    }

    #[tokio::test]
    async fn host_blocked_rejects_allowlisted_hostname_when_dns_lookup_fails() {
        let mut network = NetworkProxySettings::default();
        network.set_allowed_domains(vec!["does-not-resolve.invalid".to_string()]);
        let state = network_proxy_state_for_policy(network);

        assert_eq!(
            state
                .host_blocked("does-not-resolve.invalid", /*port*/ 80)
                .await
                .unwrap(),
            HostBlockDecision::Blocked(HostBlockReason::NotAllowedLocal)
        );
    }

    #[tokio::test]
    async fn host_resolves_to_non_public_ip_blocks_on_dns_lookup_timeout() {
        let blocked = host_resolves_to_non_public_ip(
            "slow.example",
            /*port*/ 80,
            Duration::from_millis(1),
            |_host, _port| async {
                std::future::pending::<std::io::Result<Vec<SocketAddr>>>().await
            },
        )
        .await;

        assert!(blocked);
    }

    #[tokio::test]
    async fn host_resolves_to_non_public_ip_blocks_on_dns_lookup_error() {
        let blocked = host_resolves_to_non_public_ip(
            "error.example",
            /*port*/ 80,
            Duration::from_millis(10),
            |_host, _port| async {
                Err::<Vec<SocketAddr>, std::io::Error>(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "forced failure",
                ))
            },
        )
        .await;

        assert!(blocked);
    }

    #[tokio::test]
    async fn host_resolves_to_non_public_ip_blocks_private_resolution() {
        let blocked = host_resolves_to_non_public_ip(
            "local.example",
            /*port*/ 80,
            Duration::from_millis(10),
            |_host, _port| async { Ok(vec!["127.0.0.1:80".parse().unwrap()]) },
        )
        .await;

        assert!(blocked);
    }

    #[tokio::test]
    async fn host_resolves_to_non_public_ip_allows_public_resolution() {
        let blocked = host_resolves_to_non_public_ip(
            "public.example",
            /*port*/ 80,
            Duration::from_millis(10),
            |_host, _port| async { Ok(vec!["8.8.8.8:80".parse().unwrap()]) },
        )
        .await;

        assert!(!blocked);
    }

    #[test]
    fn validate_policy_against_constraints_disallows_widening_allowed_domains() {
        let constraints = NetworkProxyConstraints {
            allowed_domains: Some(vec!["example.com".to_string()]),
            ..NetworkProxyConstraints::default()
        };

        let config = NetworkProxyConfig {
            network: {
                let mut network = network_settings(&["example.com", "evil.com"], &[]);
                network.enabled = true;
                network
            },
        };

        assert!(validate_policy_against_constraints(&config, &constraints).is_err());
    }

    #[test]
    fn validate_policy_against_constraints_allows_expanding_allowed_domains_when_enabled() {
        let constraints = NetworkProxyConstraints {
            allowed_domains: Some(vec!["example.com".to_string()]),
            allowlist_expansion_enabled: Some(true),
            ..NetworkProxyConstraints::default()
        };

        let config = NetworkProxyConfig {
            network: {
                let mut network = network_settings(&["example.com", "api.openai.com"], &[]);
                network.enabled = true;
                network
            },
        };

        assert!(validate_policy_against_constraints(&config, &constraints).is_ok());
    }

    #[test]
    fn validate_policy_against_constraints_disallows_widening_mode() {
        let constraints = NetworkProxyConstraints {
            mode: Some(NetworkMode::Limited),
            ..NetworkProxyConstraints::default()
        };

        let config = NetworkProxyConfig {
            network: NetworkProxySettings {
                enabled: true,
                mode: NetworkMode::Full,
                ..NetworkProxySettings::default()
            },
        };

        assert!(validate_policy_against_constraints(&config, &constraints).is_err());
    }

    #[test]
    fn validate_policy_against_constraints_allows_narrowing_wildcard_allowlist() {
        let constraints = NetworkProxyConstraints {
            allowed_domains: Some(vec!["*.example.com".to_string()]),
            ..NetworkProxyConstraints::default()
        };

        let config = NetworkProxyConfig {
            network: {
                let mut network = network_settings(&["api.example.com"], &[]);
                network.enabled = true;
                network
            },
        };

        assert!(validate_policy_against_constraints(&config, &constraints).is_ok());
    }

    #[test]
    fn validate_policy_against_constraints_rejects_widening_wildcard_allowlist() {
        let constraints = NetworkProxyConstraints {
            allowed_domains: Some(vec!["*.example.com".to_string()]),
            ..NetworkProxyConstraints::default()
        };

        let config = NetworkProxyConfig {
            network: {
                let mut network = network_settings(&["**.example.com"], &[]);
                network.enabled = true;
                network
            },
        };

        assert!(validate_policy_against_constraints(&config, &constraints).is_err());
    }

    #[test]
    fn validate_policy_against_constraints_rejects_global_wildcard_in_managed_allowlist() {
        let constraints = NetworkProxyConstraints {
            allowed_domains: Some(vec!["*".to_string()]),
            ..NetworkProxyConstraints::default()
        };

        let config = NetworkProxyConfig {
            network: {
                let mut network = network_settings(&["api.example.com"], &[]);
                network.enabled = true;
                network
            },
        };

        assert!(validate_policy_against_constraints(&config, &constraints).is_err());
    }

    #[test]
    fn validate_policy_against_constraints_rejects_bracketed_global_wildcard_in_managed_allowlist()
    {
        let constraints = NetworkProxyConstraints {
            allowed_domains: Some(vec!["[*]".to_string()]),
            ..NetworkProxyConstraints::default()
        };

        let config = NetworkProxyConfig {
            network: {
                let mut network = network_settings(&["api.example.com"], &[]);
                network.enabled = true;
                network
            },
        };

        assert!(validate_policy_against_constraints(&config, &constraints).is_err());
    }

    #[test]
    fn validate_policy_against_constraints_rejects_double_wildcard_bracketed_global_wildcard_in_managed_allowlist()
     {
        let constraints = NetworkProxyConstraints {
            allowed_domains: Some(vec!["**.[*]".to_string()]),
            ..NetworkProxyConstraints::default()
        };

        let config = NetworkProxyConfig {
            network: {
                let mut network = network_settings(&["api.example.com"], &[]);
                network.enabled = true;
                network
            },
        };

        assert!(validate_policy_against_constraints(&config, &constraints).is_err());
    }

    #[test]
    fn validate_policy_against_constraints_requires_managed_denied_domains_entries() {
        let constraints = NetworkProxyConstraints {
            denied_domains: Some(vec!["evil.com".to_string()]),
            ..NetworkProxyConstraints::default()
        };

        let config = NetworkProxyConfig {
            network: NetworkProxySettings {
                enabled: true,
                ..NetworkProxySettings::default()
            },
        };

        assert!(validate_policy_against_constraints(&config, &constraints).is_err());
    }

    #[test]
    fn validate_policy_against_constraints_disallows_expanding_denied_domains_when_fixed() {
        let constraints = NetworkProxyConstraints {
            denied_domains: Some(vec!["evil.com".to_string()]),
            denylist_expansion_enabled: Some(false),
            ..NetworkProxyConstraints::default()
        };

        let config = NetworkProxyConfig {
            network: {
                let mut network = network_settings(&[], &["evil.com", "more-evil.com"]);
                network.enabled = true;
                network
            },
        };

        assert!(validate_policy_against_constraints(&config, &constraints).is_err());
    }

    #[test]
    fn validate_policy_against_constraints_disallows_enabling_when_managed_disabled() {
        let constraints = NetworkProxyConstraints {
            enabled: Some(false),
            ..NetworkProxyConstraints::default()
        };

        let config = NetworkProxyConfig {
            network: NetworkProxySettings {
                enabled: true,
                ..NetworkProxySettings::default()
            },
        };

        assert!(validate_policy_against_constraints(&config, &constraints).is_err());
    }

    #[test]
    fn validate_policy_against_constraints_disallows_allow_local_binding_when_managed_disabled() {
        let constraints = NetworkProxyConstraints {
            allow_local_binding: Some(false),
            ..NetworkProxyConstraints::default()
        };

        let config = NetworkProxyConfig {
            network: NetworkProxySettings {
                enabled: true,
                allow_local_binding: true,
                ..NetworkProxySettings::default()
            },
        };

        assert!(validate_policy_against_constraints(&config, &constraints).is_err());
    }

    #[test]
    fn validate_policy_against_constraints_disallows_allow_all_unix_sockets_without_managed_opt_in()
    {
        let constraints = NetworkProxyConstraints {
            dangerously_allow_all_unix_sockets: Some(false),
            ..NetworkProxyConstraints::default()
        };

        let config = NetworkProxyConfig {
            network: NetworkProxySettings {
                enabled: true,
                dangerously_allow_all_unix_sockets: true,
                ..NetworkProxySettings::default()
            },
        };

        assert!(validate_policy_against_constraints(&config, &constraints).is_err());
    }

    #[test]
    fn validate_policy_against_constraints_disallows_allow_all_unix_sockets_when_allowlist_is_managed()
     {
        let constraints = NetworkProxyConstraints {
            allow_unix_sockets: Some(vec!["/tmp/allowed.sock".to_string()]),
            ..NetworkProxyConstraints::default()
        };

        let config = NetworkProxyConfig {
            network: NetworkProxySettings {
                enabled: true,
                dangerously_allow_all_unix_sockets: true,
                ..NetworkProxySettings::default()
            },
        };

        assert!(validate_policy_against_constraints(&config, &constraints).is_err());
    }

    #[test]
    fn validate_policy_against_constraints_allows_allow_all_unix_sockets_with_managed_opt_in() {
        let constraints = NetworkProxyConstraints {
            dangerously_allow_all_unix_sockets: Some(true),
            ..NetworkProxyConstraints::default()
        };

        let config = NetworkProxyConfig {
            network: NetworkProxySettings {
                enabled: true,
                dangerously_allow_all_unix_sockets: true,
                ..NetworkProxySettings::default()
            },
        };

        assert!(validate_policy_against_constraints(&config, &constraints).is_ok());
    }

    #[test]
    fn validate_policy_against_constraints_allows_allow_all_unix_sockets_when_unmanaged() {
        let constraints = NetworkProxyConstraints::default();

        let config = NetworkProxyConfig {
            network: NetworkProxySettings {
                enabled: true,
                dangerously_allow_all_unix_sockets: true,
                ..NetworkProxySettings::default()
            },
        };

        assert!(validate_policy_against_constraints(&config, &constraints).is_ok());
    }

    #[test]
    fn compile_globset_is_case_insensitive() {
        let patterns = vec!["ExAmPle.CoM".to_string()];
        let set = compile_denylist_globset(&patterns).unwrap();
        assert!(set.is_match("example.com"));
        assert!(set.is_match("EXAMPLE.COM"));
    }

    #[test]
    fn compile_globset_excludes_apex_for_subdomain_patterns() {
        let patterns = vec!["*.openai.com".to_string()];
        let set = compile_denylist_globset(&patterns).unwrap();
        assert!(set.is_match("api.openai.com"));
        assert!(!set.is_match("openai.com"));
        assert!(!set.is_match("evilopenai.com"));
    }

    #[test]
    fn compile_globset_includes_apex_for_double_wildcard_patterns() {
        let patterns = vec!["**.openai.com".to_string()];
        let set = compile_denylist_globset(&patterns).unwrap();
        assert!(set.is_match("openai.com"));
        assert!(set.is_match("api.openai.com"));
        assert!(!set.is_match("evilopenai.com"));
    }

    #[test]
    fn compile_globset_rejects_global_wildcard() {
        let patterns = vec!["*".to_string()];
        assert!(compile_denylist_globset(&patterns).is_err());
    }

    #[test]
    fn compile_globset_allows_global_wildcard_when_enabled() {
        let patterns = vec!["*".to_string()];
        let set = compile_allowlist_globset(&patterns).unwrap();
        assert!(set.is_match("example.com"));
        assert!(set.is_match("api.openai.com"));
        assert!(set.is_match("localhost"));
    }

    #[test]
    fn compile_globset_rejects_bracketed_global_wildcard() {
        let patterns = vec!["[*]".to_string()];
        assert!(compile_denylist_globset(&patterns).is_err());
    }

    #[test]
    fn compile_globset_rejects_double_wildcard_bracketed_global_wildcard() {
        let patterns = vec!["**.[*]".to_string()];
        assert!(compile_denylist_globset(&patterns).is_err());
    }

    #[test]
    fn compile_globset_dedupes_patterns_without_changing_behavior() {
        let patterns = vec!["example.com".to_string(), "example.com".to_string()];
        let set = compile_denylist_globset(&patterns).unwrap();
        assert!(set.is_match("example.com"));
        assert!(set.is_match("EXAMPLE.COM"));
        assert!(!set.is_match("not-example.com"));
    }

    #[test]
    fn compile_globset_rejects_invalid_patterns() {
        let patterns = vec!["[".to_string()];
        assert!(compile_denylist_globset(&patterns).is_err());
    }

    #[test]
    fn build_config_state_allows_global_wildcard_allowed_domains() {
        let config = NetworkProxyConfig {
            network: {
                let mut network = network_settings(&["*"], &[]);
                network.enabled = true;
                network
            },
        };

        assert!(build_config_state(config, NetworkProxyConstraints::default()).is_ok());
    }

    #[test]
    fn build_config_state_allows_bracketed_global_wildcard_allowed_domains() {
        let config = NetworkProxyConfig {
            network: {
                let mut network = network_settings(&["[*]"], &[]);
                network.enabled = true;
                network
            },
        };

        assert!(build_config_state(config, NetworkProxyConstraints::default()).is_ok());
    }

    #[test]
    fn build_config_state_rejects_global_wildcard_denied_domains() {
        let config = NetworkProxyConfig {
            network: {
                let mut network = network_settings(&["example.com"], &["*"]);
                network.enabled = true;
                network
            },
        };

        assert!(build_config_state(config, NetworkProxyConstraints::default()).is_err());
    }

    #[test]
    fn build_config_state_rejects_bracketed_global_wildcard_denied_domains() {
        let config = NetworkProxyConfig {
            network: {
                let mut network = network_settings(&["example.com"], &["[*]"]);
                network.enabled = true;
                network
            },
        };

        assert!(build_config_state(config, NetworkProxyConstraints::default()).is_err());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn unix_socket_allowlist_is_respected_on_macos() {
        let socket_path = "/tmp/example.sock".to_string();
        let state = network_proxy_state_for_policy(network_settings_with_unix_sockets(
            &["example.com"],
            &[],
            std::slice::from_ref(&socket_path),
        ));

        assert!(state.is_unix_socket_allowed(&socket_path).await.unwrap());
        assert!(
            !state
                .is_unix_socket_allowed("/tmp/not-allowed.sock")
                .await
                .unwrap()
        );
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn unix_socket_allowlist_resolves_symlinks() {
        use std::os::unix::fs::symlink;
        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let dir = temp_dir.path();

        let real = dir.join("real.sock");
        let link = dir.join("link.sock");

        // The allowlist mechanism is path-based; for test purposes we don't need an actual unix
        // domain socket. Any filesystem entry works for canonicalization.
        std::fs::write(&real, b"not a socket").unwrap();
        symlink(&real, &link).unwrap();

        let real_s = real.to_str().unwrap().to_string();
        let link_s = link.to_str().unwrap().to_string();

        let state = network_proxy_state_for_policy(network_settings_with_unix_sockets(
            &["example.com"],
            &[],
            std::slice::from_ref(&real_s),
        ));

        assert!(state.is_unix_socket_allowed(&link_s).await.unwrap());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn unix_socket_allow_all_flag_bypasses_allowlist() {
        let state = network_proxy_state_for_policy({
            let mut network = network_settings(&["example.com"], &[]);
            network.dangerously_allow_all_unix_sockets = true;
            network
        });

        assert!(state.is_unix_socket_allowed("/tmp/any.sock").await.unwrap());
        assert!(!state.is_unix_socket_allowed("relative.sock").await.unwrap());
    }

    #[cfg(not(target_os = "macos"))]
    #[tokio::test]
    async fn unix_socket_allowlist_is_rejected_on_non_macos() {
        let socket_path = "/tmp/example.sock".to_string();
        let state = network_proxy_state_for_policy({
            let mut network = network_settings_with_unix_sockets(
                &["example.com"],
                &[],
                std::slice::from_ref(&socket_path),
            );
            network.dangerously_allow_all_unix_sockets = true;
            network
        });

        assert!(!state.is_unix_socket_allowed(&socket_path).await.unwrap());
    }
}
