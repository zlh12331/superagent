//! 网络代理配置数据结构模块。
//!
//! 定义用户配置文件中 `[network]` 段对应的强类型结构，包括：
//! - HTTP/SOCKS5 代理监听地址
//! - 域名级允许/拒绝策略（`NetworkDomainPermission`）
//! - Unix socket 允许列表
//! - MITM 与凭据代理开关
//! - 网络模式（`Limited` / `Full`）
//!
//! 同时提供地址解析、bind 地址回环夹紧、unix socket 路径校验等工具函数。

use anyhow::Context;
use anyhow::Result;
use anyhow::bail;
use codex_utils_absolute_path::AbsolutePathBuf;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;
use std::collections::BTreeMap;
use std::net::IpAddr;
use std::net::SocketAddr;
use std::path::Path;
use tracing::warn;
use url::Url;

use crate::mitm_hook::MitmHookConfig;

/// 网络代理配置的根结构，对应 `[network]` 段。
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct NetworkProxyConfig {
    /// 实际的网络代理设置
    #[serde(default)]
    pub network: NetworkProxySettings,
}

impl NetworkProxyConfig {
    /// 设置凭据代理开关，并自动启用 MITM（凭据代理依赖 MITM 拦截）。
    pub fn set_credential_broker_enabled(&mut self, enabled: bool) {
        self.network.credential_broker = enabled;
        self.network.mitm |= enabled;
    }
}

/// 域名权限枚举。
///
/// 变体顺序编码了重复模式的实际优先级：
/// `None < Allow < Deny`，因此当条目冲突时 deny 胜出。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum NetworkDomainPermission {
    /// 无显式权限
    None,
    /// 允许访问
    Allow,
    /// 拒绝访问
    Deny,
}

/// 单条域名权限条目：包含模式字符串与权限。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkDomainPermissionEntry {
    /// 域名匹配模式（如 "example.com" 或 "*.example.com"）
    pub pattern: String,
    /// 该模式对应的权限
    pub permission: NetworkDomainPermission,
}

/// 域名权限集合，可包含多条条目，序列化为 map 形式。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NetworkDomainPermissions {
    /// 原始条目列表（可能包含重复模式，运行时通过 [`effective_entries`] 合并）
    pub entries: Vec<NetworkDomainPermissionEntry>,
}

impl Serialize for NetworkDomainPermissions {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.effective_entries()
            .into_iter()
            .map(|entry| (entry.pattern, entry.permission))
            .collect::<BTreeMap<_, _>>()
            .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for NetworkDomainPermissions {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let entries = BTreeMap::<String, NetworkDomainPermission>::deserialize(deserializer)?
            .into_iter()
            .map(|(pattern, permission)| NetworkDomainPermissionEntry {
                pattern,
                permission,
            })
            .collect();
        Ok(Self { entries })
    }
}

impl NetworkDomainPermissions {
    /// 计算去重后的有效条目列表：相同模式取最高优先级权限。
    fn effective_entries(&self) -> Vec<NetworkDomainPermissionEntry> {
        let mut order = Vec::new();
        let mut effective_permissions = BTreeMap::new();

        for entry in &self.entries {
            if !effective_permissions.contains_key(&entry.pattern) {
                order.push(entry.pattern.clone());
            }

            let permission = effective_permissions
                .entry(entry.pattern.clone())
                .or_insert(entry.permission);
            if entry.permission > *permission {
                *permission = entry.permission;
            }
        }

        order
            .into_iter()
            .filter_map(|pattern| {
                effective_permissions.remove(&pattern).map(|permission| {
                    NetworkDomainPermissionEntry {
                        pattern,
                        permission,
                    }
                })
            })
            .collect()
    }
}

/// Unix socket 权限枚举。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NetworkUnixSocketPermission {
    /// 允许通过代理访问该 socket
    Allow,
    /// 拒绝通过代理访问该 socket
    Deny,
}

/// Unix socket 权限集合，序列化为 map（key 为路径）。
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct NetworkUnixSocketPermissions {
    /// 按路径索引的权限表
    #[serde(flatten)]
    pub entries: BTreeMap<String, NetworkUnixSocketPermission>,
}

/// 网络代理设置：完整描述一个 codex 进程的网络行为。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct NetworkProxySettings {
    /// 是否启用网络代理
    #[serde(default)]
    pub enabled: bool,
    /// HTTP 代理监听地址
    #[serde(default = "default_proxy_url")]
    pub proxy_url: String,
    /// 是否启用 SOCKS5 代理
    pub enable_socks5: bool,
    /// SOCKS5 代理监听地址
    #[serde(default = "default_socks_url")]
    pub socks_url: String,
    /// 是否启用 SOCKS5 UDP 转发
    pub enable_socks5_udp: bool,
    /// 是否允许使用上游代理
    pub allow_upstream_proxy: bool,
    /// 危险选项：允许监听非回环地址（暴露给网络）
    #[serde(default)]
    pub dangerously_allow_non_loopback_proxy: bool,
    /// 危险选项：允许访问所有 Unix socket（不限于白名单）
    #[serde(default)]
    pub dangerously_allow_all_unix_sockets: bool,
    /// 网络访问模式
    #[serde(default)]
    pub mode: NetworkMode,
    /// 域名权限规则
    #[serde(default)]
    pub domains: Option<NetworkDomainPermissions>,
    /// Unix socket 权限规则
    #[serde(default)]
    pub unix_sockets: Option<NetworkUnixSocketPermissions>,
    /// 是否允许子进程绑定本地端口
    pub allow_local_binding: bool,
    /// 是否启用 MITM TLS 解密
    #[serde(default)]
    pub mitm: bool,
    /// 是否启用凭据代理（自动注入 token）
    #[serde(default)]
    pub credential_broker: bool,
    /// 危险选项：允许以明文形式注入凭据（不推荐）
    #[serde(default)]
    pub dangerously_allow_plaintext_credential_injection: bool,
    /// MITM 钩子配置列表（按匹配条件注入 header/body）
    #[serde(default)]
    pub mitm_hooks: Vec<MitmHookConfig>,
}

impl Default for NetworkProxySettings {
    fn default() -> Self {
        Self {
            enabled: false,
            proxy_url: default_proxy_url(),
            enable_socks5: true,
            socks_url: default_socks_url(),
            enable_socks5_udp: true,
            allow_upstream_proxy: true,
            dangerously_allow_non_loopback_proxy: false,
            dangerously_allow_all_unix_sockets: false,
            mode: NetworkMode::default(),
            domains: None,
            unix_sockets: None,
            allow_local_binding: false,
            mitm: false,
            credential_broker: false,
            dangerously_allow_plaintext_credential_injection: false,
            mitm_hooks: Vec::new(),
        }
    }
}

impl NetworkProxySettings {
    /// 返回所有允许（Allow）的域名模式列表，若为空则返回 `None`。
    pub fn allowed_domains(&self) -> Option<Vec<String>> {
        self.domain_entries(NetworkDomainPermission::Allow)
    }

    /// 返回所有拒绝（Deny）的域名模式列表，若为空则返回 `None`。
    pub fn denied_domains(&self) -> Option<Vec<String>> {
        self.domain_entries(NetworkDomainPermission::Deny)
    }

    /// 返回指定权限的域名模式列表。
    fn domain_entries(&self, permission: NetworkDomainPermission) -> Option<Vec<String>> {
        self.domains
            .as_ref()
            .map(|domains| {
                domains
                    .effective_entries()
                    .iter()
                    .filter(|entry| entry.permission == permission)
                    .map(|entry| entry.pattern.clone())
                    .collect()
            })
            .filter(|entries: &Vec<String>| !entries.is_empty())
    }

    /// 返回所有允许访问的 Unix socket 路径列表。
    pub fn allow_unix_sockets(&self) -> Vec<String> {
        self.unix_sockets
            .as_ref()
            .map(|unix_sockets| {
                unix_sockets
                    .entries
                    .iter()
                    .filter(|(_, permission)| {
                        matches!(permission, NetworkUnixSocketPermission::Allow)
                    })
                    .map(|(path, _)| path.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 设置允许访问的域名列表（替换已有的 Allow 条目，保留 Deny 条目）。
    pub fn set_allowed_domains(&mut self, allowed_domains: Vec<String>) {
        self.set_domain_entries(allowed_domains, NetworkDomainPermission::Allow);
    }

    /// 设置拒绝访问的域名列表（替换已有的 Deny 条目，保留 Allow 条目）。
    pub fn set_denied_domains(&mut self, denied_domains: Vec<String>) {
        self.set_domain_entries(denied_domains, NetworkDomainPermission::Deny);
    }

    /// 插入或更新单条域名权限。
    ///
    /// `normalize` 用于将主机名归一化（如去掉末尾点），避免重复条目。
    pub fn upsert_domain_permission(
        &mut self,
        host: String,
        permission: NetworkDomainPermission,
        normalize: impl Fn(&str) -> String,
    ) {
        let mut domains = self.domains.take().unwrap_or_default();
        let normalized_host = normalize(&host);
        domains
            .entries
            .retain(|entry| normalize(&entry.pattern) != normalized_host);
        domains.entries.push(NetworkDomainPermissionEntry {
            pattern: host,
            permission,
        });
        self.domains = (!domains.entries.is_empty()).then_some(domains);
    }

    /// 设置允许访问的 Unix socket 路径列表（替换 Allow 条目）。
    pub fn set_allow_unix_sockets(&mut self, allow_unix_sockets: Vec<String>) {
        self.set_unix_socket_entries(allow_unix_sockets, NetworkUnixSocketPermission::Allow);
    }

    /// 内部辅助：替换指定权限的域名条目。
    fn set_domain_entries(&mut self, entries: Vec<String>, permission: NetworkDomainPermission) {
        let mut domains = self.domains.take().unwrap_or_default();
        domains
            .entries
            .retain(|entry| entry.permission != permission);
        for entry in entries {
            if !domains
                .entries
                .iter()
                .any(|existing| existing.pattern == entry && existing.permission == permission)
            {
                domains.entries.push(NetworkDomainPermissionEntry {
                    pattern: entry,
                    permission,
                });
            }
        }
        self.domains = (!domains.entries.is_empty()).then_some(domains);
    }

    /// 内部辅助：替换指定权限的 Unix socket 条目。
    fn set_unix_socket_entries(
        &mut self,
        entries: Vec<String>,
        permission: NetworkUnixSocketPermission,
    ) {
        let mut unix_sockets = self.unix_sockets.take().unwrap_or_default();
        unix_sockets
            .entries
            .retain(|_, existing| *existing != permission);
        for entry in entries {
            unix_sockets.entries.insert(entry, permission);
        }
        self.unix_sockets = (!unix_sockets.entries.is_empty()).then_some(unix_sockets);
    }
}

/// 网络访问模式。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum NetworkMode {
    /// 受限（只读）访问：HTTP 仅允许 GET/HEAD/OPTIONS。
    /// HTTPS CONNECT 在未启用 MITM 时被阻止，以便代理能对内部请求执行方法策略。
    /// SOCKS5 UDP 和非 HTTPS 的 SOCKS5 TCP 在受限模式下始终被阻止。
    Limited,
    /// 完全网络访问：允许所有 HTTP 方法，HTTPS CONNECT 直接隧道转发。
    /// MITM 钩子当前不会使 full 模式进入 MITM。
    #[default]
    Full,
}

impl NetworkMode {
    /// 判断当前模式是否允许指定的 HTTP 方法。
    pub fn allows_method(self, method: &str) -> bool {
        match self {
            Self::Full => true,
            Self::Limited => matches!(method, "GET" | "HEAD" | "OPTIONS"),
        }
    }
}

/// HTTP 代理默认监听地址。
fn default_proxy_url() -> String {
    "http://127.0.0.1:3128".to_string()
}

/// SOCKS5 代理默认监听地址。
fn default_socks_url() -> String {
    "http://127.0.0.1:8081".to_string()
}

/// 将非回环 bind 地址夹紧到回环地址，除非显式允许非回环绑定。
fn clamp_non_loopback(
    addr: SocketAddr,
    allow_non_loopback: bool,
    name: &str,
    override_setting_name: &str,
) -> SocketAddr {
    if addr.ip().is_loopback() {
        return addr;
    }

    if allow_non_loopback {
        warn!("DANGEROUS: {name} listening on non-loopback address {addr}");
        return addr;
    }

    warn!(
        "{name} requested non-loopback bind ({addr}); clamping to 127.0.0.1:{port} (set {override_setting_name} to override)",
        port = addr.port()
    );
    SocketAddr::from(([127, 0, 0, 1], addr.port()))
}

/// 对 HTTP 与 SOCKS5 代理的 bind 地址进行安全夹紧。
///
/// 默认强制回环；若启用 unix socket 代理，则即使开启非回环也强制回环
/// （避免外部网络通过代理桥接到本地守护进程）。
pub(crate) fn clamp_bind_addrs(
    http_addr: SocketAddr,
    socks_addr: SocketAddr,
    cfg: &NetworkProxySettings,
) -> (SocketAddr, SocketAddr) {
    let http_addr = clamp_non_loopback(
        http_addr,
        cfg.dangerously_allow_non_loopback_proxy,
        "HTTP proxy",
        "dangerously_allow_non_loopback_proxy",
    );
    let socks_addr = clamp_non_loopback(
        socks_addr,
        cfg.dangerously_allow_non_loopback_proxy,
        "SOCKS5 proxy",
        "dangerously_allow_non_loopback_proxy",
    );
    if cfg.allow_unix_sockets().is_empty() && !cfg.dangerously_allow_all_unix_sockets {
        return (http_addr, socks_addr);
    }

    // `x-unix-socket` 是有意设计的本地逃逸通道。若代理对外暴露，
    // 可能成为远程攻击者访问本地守护进程（如 docker.sock）的桥梁。
    // 为避免误用，启用 unix socket 代理时强制回环绑定。
    if cfg.dangerously_allow_non_loopback_proxy && !http_addr.ip().is_loopback() {
        warn!(
            "unix socket proxying is enabled; ignoring dangerously_allow_non_loopback_proxy and clamping HTTP proxy to loopback"
        );
    }
    if cfg.dangerously_allow_non_loopback_proxy && !socks_addr.ip().is_loopback() {
        warn!(
            "unix socket proxying is enabled; ignoring dangerously_allow_non_loopback_proxy and clamping SOCKS5 proxy to loopback"
        );
    }
    (
        SocketAddr::from(([127, 0, 0, 1], http_addr.port())),
        SocketAddr::from(([127, 0, 0, 1], socks_addr.port())),
    )
}

/// 解析后的运行时配置：HTTP 与 SOCKS5 代理实际监听地址。
pub struct RuntimeConfig {
    /// HTTP 代理监听地址
    pub http_addr: SocketAddr,
    /// SOCKS5 代理监听地址
    pub socks_addr: SocketAddr,
}

/// Unix 风格的绝对路径（用于跨平台表示 unix socket 路径）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UnixStyleAbsolutePath(String);

impl UnixStyleAbsolutePath {
    /// 解析 Unix 风格绝对路径（以 `/` 开头）。
    fn parse(value: &str) -> Option<Self> {
        value.starts_with('/').then(|| Self(value.to_string()))
    }
}

/// 校验后的 Unix socket 路径：区分平台原生路径与 Unix 风格路径。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ValidatedUnixSocketPath {
    /// 平台原生绝对路径（如 Windows 的 `C:\...`）
    Native(AbsolutePathBuf),
    /// Unix 风格绝对路径（如 `/var/run/docker.sock`）
    UnixStyleAbsolute(UnixStyleAbsolutePath),
}

impl ValidatedUnixSocketPath {
    /// 解析并校验 unix socket 路径，必须是绝对路径。
    pub(crate) fn parse(socket_path: &str) -> Result<Self> {
        let path = Path::new(socket_path);
        if path.is_absolute() {
            let path = AbsolutePathBuf::from_absolute_path(path)
                .with_context(|| format!("failed to normalize unix socket path {socket_path:?}"))?;
            return Ok(Self::Native(path));
        }

        if let Some(path) = UnixStyleAbsolutePath::parse(socket_path) {
            return Ok(Self::UnixStyleAbsolute(path));
        }

        bail!("expected an absolute path, got {socket_path:?}");
    }
}

/// 校验配置中所有 allow_unix_sockets 条目都是合法的绝对路径。
pub(crate) fn validate_unix_socket_allowlist_paths(cfg: &NetworkProxyConfig) -> Result<()> {
    for (index, socket_path) in cfg.network.allow_unix_sockets().iter().enumerate() {
        ValidatedUnixSocketPath::parse(socket_path)
            .with_context(|| format!("invalid network.allow_unix_sockets[{index}]"))?;
    }
    Ok(())
}

/// 从配置解析运行时监听地址，并应用 bind 地址夹紧。
pub fn resolve_runtime(cfg: &NetworkProxyConfig) -> Result<RuntimeConfig> {
    validate_unix_socket_allowlist_paths(cfg)?;

    let http_addr = resolve_addr(&cfg.network.proxy_url, /*default_port*/ 3128)
        .with_context(|| format!("invalid network.proxy_url: {}", cfg.network.proxy_url))?;
    let socks_addr = resolve_addr(&cfg.network.socks_url, /*default_port*/ 8081)
        .with_context(|| format!("invalid network.socks_url: {}", cfg.network.socks_url))?;
    let (http_addr, socks_addr) = clamp_bind_addrs(http_addr, socks_addr, &cfg.network);

    Ok(RuntimeConfig {
        http_addr,
        socks_addr,
    })
}

/// 解析 URL 字符串为 SocketAddr，将 `localhost` 映射为 `127.0.0.1`。
///
/// 无法解析为 IP 字面量的主机名会回退到 `127.0.0.1`，因为代理不允许
/// 通过主机名访问外部 DNS（避免 DNS 重绑定攻击）。
fn resolve_addr(url: &str, default_port: u16) -> Result<SocketAddr> {
    let addr_parts = parse_host_port(url, default_port)?;
    let host = if addr_parts.host.eq_ignore_ascii_case("localhost") {
        "127.0.0.1".to_string()
    } else {
        addr_parts.host
    };
    match host.parse::<IpAddr>() {
        Ok(ip) => Ok(SocketAddr::new(ip, addr_parts.port)),
        Err(_) => Ok(SocketAddr::from(([127, 0, 0, 1], addr_parts.port))),
    }
}

/// 将网络地址字符串格式化为 `host:port` 形式（IPv6 自动加方括号）。
///
/// 解析失败时回退为输入字符串 + 默认端口。
pub fn host_and_port_from_network_addr(value: &str, default_port: u16) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return "<missing>".to_string();
    }

    let parts = match parse_host_port(trimmed, default_port) {
        Ok(parts) => parts,
        Err(_) => {
            return format_host_and_port(trimmed, default_port);
        }
    };

    format_host_and_port(&parts.host, parts.port)
}

/// 格式化 `host:port`，IPv6 字面量自动加方括号。
fn format_host_and_port(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// 解析后的 socket 地址组成：主机与端口。
#[derive(Debug, Clone, PartialEq, Eq)]
struct SocketAddressParts {
    /// 主机名或 IP 字面量
    host: String,
    /// 端口号
    port: u16,
}

/// 解析 `host:port`、`scheme://host:port/path`、IPv6 字面量等多种形式。
fn parse_host_port(url: &str, default_port: u16) -> Result<SocketAddressParts> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        bail!("missing host in network proxy address: {url}");
    }

    // 避免将未加方括号的 IPv6 字面量（如 "2001:db8::1"）误判为带 scheme 的 URL
    if matches!(trimmed.parse::<IpAddr>(), Ok(IpAddr::V6(_))) && !trimmed.starts_with('[') {
        return Ok(SocketAddressParts {
            host: trimmed.to_string(),
            port: default_port,
        });
    }

    // 优先使用标准 URL 解析器处理 URL 风格输入；缺失 scheme 时补 http://
    // 以便仍能接受裸 host:port 输入
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    if let Ok(parsed) = Url::parse(&candidate)
        && let Some(host) = parsed.host_str()
    {
        let host = host.trim_matches(|c| c == '[' || c == ']');
        if host.is_empty() {
            bail!("missing host in network proxy address: {url}");
        }
        return Ok(SocketAddressParts {
            host: host.to_string(),
            port: parsed.port().unwrap_or(default_port),
        });
    }

    parse_host_port_fallback(trimmed, default_port)
}

/// URL 解析失败时的回退解析器：手动切分 scheme、userinfo、host、port。
fn parse_host_port_fallback(input: &str, default_port: u16) -> Result<SocketAddressParts> {
    let without_scheme = input
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(input);
    let host_port = without_scheme.split('/').next().unwrap_or(without_scheme);
    let host_port = host_port
        .rsplit_once('@')
        .map(|(_, rest)| rest)
        .unwrap_or(host_port);

    // 处理带方括号的 IPv6 字面量：[host]:port
    if host_port.starts_with('[')
        && let Some(end) = host_port.find(']')
    {
        let host = &host_port[1..end];
        let port = host_port[end + 1..]
            .strip_prefix(':')
            .and_then(|port| port.parse::<u16>().ok())
            .unwrap_or(default_port);
        if host.is_empty() {
            bail!("missing host in network proxy address: {input}");
        }
        return Ok(SocketAddressParts {
            host: host.to_string(),
            port,
        });
    }

    // 仅当只含一个 `:` 时才按 `host:port` 处理，避免误判未加方括号的
    // IPv6 地址为 `host:port`。
    if host_port.bytes().filter(|b| *b == b':').count() == 1
        && let Some((host, port)) = host_port.rsplit_once(':')
    {
        if host.is_empty() {
            bail!("missing host in network proxy address: {input}");
        }
        return Ok(SocketAddressParts {
            host: host.to_string(),
            port: port.parse::<u16>().ok().unwrap_or(default_port),
        });
    }

    if host_port.is_empty() {
        bail!("missing host in network proxy address: {input}");
    }
    Ok(SocketAddressParts {
        host: host_port.to_string(),
        port: default_port,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use pretty_assertions::assert_eq;

    fn settings_with_unix_sockets(unix_sockets: &[&str]) -> NetworkProxySettings {
        let mut settings = NetworkProxySettings::default();
        if !unix_sockets.is_empty() {
            settings.set_allow_unix_sockets(
                unix_sockets
                    .iter()
                    .map(|path| (*path).to_string())
                    .collect(),
            );
        }
        settings
    }

    #[test]
    fn network_proxy_settings_default_matches_local_use_baseline() {
        assert_eq!(
            NetworkProxySettings::default(),
            NetworkProxySettings {
                enabled: false,
                proxy_url: "http://127.0.0.1:3128".to_string(),
                enable_socks5: true,
                socks_url: "http://127.0.0.1:8081".to_string(),
                enable_socks5_udp: true,
                allow_upstream_proxy: true,
                dangerously_allow_non_loopback_proxy: false,
                dangerously_allow_all_unix_sockets: false,
                mode: NetworkMode::Full,
                domains: None,
                unix_sockets: None,
                allow_local_binding: false,
                mitm: false,
                credential_broker: false,
                dangerously_allow_plaintext_credential_injection: false,
                mitm_hooks: Vec::new(),
            }
        );
    }

    #[test]
    fn partial_network_config_uses_struct_defaults_for_missing_fields() {
        let config: NetworkProxyConfig = serde_json::from_str(
            r#"{
                "network": {
                    "enabled": true
                }
            }"#,
        )
        .unwrap();
        let expected = NetworkProxySettings {
            enabled: true,
            ..NetworkProxySettings::default()
        };

        assert_eq!(config.network, expected);
    }

    #[test]
    fn set_allowed_domains_preserves_existing_deny_for_same_pattern() {
        let mut settings = NetworkProxySettings::default();
        settings.set_denied_domains(vec!["example.com".to_string()]);

        settings.set_allowed_domains(vec!["example.com".to_string()]);

        assert_eq!(settings.allowed_domains(), None);
        assert_eq!(
            settings.denied_domains(),
            Some(vec!["example.com".to_string()])
        );
    }

    #[test]
    fn network_domain_permissions_serialize_to_effective_map_shape() {
        let mut settings = NetworkProxySettings::default();
        settings.set_denied_domains(vec!["example.com".to_string()]);
        settings.set_allowed_domains(vec!["example.com".to_string()]);
        let config = NetworkProxyConfig { network: settings };

        let value = serde_json::to_value(&config).unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "network": {
                    "enabled": false,
                    "proxy_url": "http://127.0.0.1:3128",
                    "enable_socks5": true,
                    "socks_url": "http://127.0.0.1:8081",
                    "enable_socks5_udp": true,
                    "allow_upstream_proxy": true,
                    "dangerously_allow_non_loopback_proxy": false,
                    "dangerously_allow_all_unix_sockets": false,
                    "mode": "full",
                    "domains": {
                        "example.com": "deny",
                    },
                    "unix_sockets": null,
                    "allow_local_binding": false,
                    "mitm": false,
                    "credential_broker": false,
                    "dangerously_allow_plaintext_credential_injection": false,
                    "mitm_hooks": [],
                }
            })
        );
    }

    #[test]
    fn parse_host_port_defaults_for_empty_string() {
        assert!(parse_host_port("", /*default_port*/ 1234).is_err());
    }

    #[test]
    fn parse_host_port_defaults_for_whitespace() {
        assert!(parse_host_port("   ", /*default_port*/ 5555).is_err());
    }

    #[test]
    fn parse_host_port_parses_host_port_without_scheme() {
        assert_eq!(
            parse_host_port("127.0.0.1:8080", /*default_port*/ 3128).unwrap(),
            SocketAddressParts {
                host: "127.0.0.1".to_string(),
                port: 8080,
            }
        );
    }

    #[test]
    fn parse_host_port_parses_host_port_with_scheme_and_path() {
        assert_eq!(
            parse_host_port(
                "http://example.com:8080/some/path",
                /*default_port*/ 3128
            )
            .unwrap(),
            SocketAddressParts {
                host: "example.com".to_string(),
                port: 8080,
            }
        );
    }

    #[test]
    fn parse_host_port_strips_userinfo() {
        assert_eq!(
            parse_host_port(
                "http://user:pass@host.example:5555",
                /*default_port*/ 3128
            )
            .unwrap(),
            SocketAddressParts {
                host: "host.example".to_string(),
                port: 5555,
            }
        );
    }

    #[test]
    fn parse_host_port_parses_ipv6_with_brackets() {
        assert_eq!(
            parse_host_port("http://[::1]:9999", /*default_port*/ 3128).unwrap(),
            SocketAddressParts {
                host: "::1".to_string(),
                port: 9999,
            }
        );
    }

    #[test]
    fn parse_host_port_does_not_treat_unbracketed_ipv6_as_host_port() {
        assert_eq!(
            parse_host_port("2001:db8::1", /*default_port*/ 3128).unwrap(),
            SocketAddressParts {
                host: "2001:db8::1".to_string(),
                port: 3128,
            }
        );
    }

    #[test]
    fn parse_host_port_falls_back_to_default_port_when_port_is_invalid() {
        assert_eq!(
            parse_host_port("example.com:notaport", /*default_port*/ 3128).unwrap(),
            SocketAddressParts {
                host: "example.com".to_string(),
                port: 3128,
            }
        );
    }

    #[test]
    fn host_and_port_from_network_addr_defaults_for_empty_string() {
        assert_eq!(
            host_and_port_from_network_addr("", /*default_port*/ 1234),
            "<missing>"
        );
    }

    #[test]
    fn host_and_port_from_network_addr_formats_ipv6() {
        assert_eq!(
            host_and_port_from_network_addr("http://[::1]:8080", /*default_port*/ 3128),
            "[::1]:8080"
        );
    }

    #[test]
    fn resolve_addr_maps_localhost_to_loopback() {
        assert_eq!(
            resolve_addr("localhost", /*default_port*/ 3128).unwrap(),
            "127.0.0.1:3128".parse::<SocketAddr>().unwrap()
        );
    }

    #[test]
    fn resolve_addr_parses_ip_literals() {
        assert_eq!(
            resolve_addr("1.2.3.4", /*default_port*/ 80).unwrap(),
            "1.2.3.4:80".parse::<SocketAddr>().unwrap()
        );
    }

    #[test]
    fn resolve_addr_parses_ipv6_literals() {
        assert_eq!(
            resolve_addr("http://[::1]:8080", /*default_port*/ 3128).unwrap(),
            "[::1]:8080".parse::<SocketAddr>().unwrap()
        );
    }

    #[test]
    fn resolve_addr_falls_back_to_loopback_for_hostnames() {
        assert_eq!(
            resolve_addr("http://example.com:5555", /*default_port*/ 3128).unwrap(),
            "127.0.0.1:5555".parse::<SocketAddr>().unwrap()
        );
    }

    #[test]
    fn clamp_bind_addrs_allows_non_loopback_when_enabled() {
        let cfg = NetworkProxySettings {
            dangerously_allow_non_loopback_proxy: true,
            ..Default::default()
        };
        let http_addr = "0.0.0.0:3128".parse::<SocketAddr>().unwrap();
        let socks_addr = "0.0.0.0:8081".parse::<SocketAddr>().unwrap();

        let (http_addr, socks_addr) = clamp_bind_addrs(http_addr, socks_addr, &cfg);

        assert_eq!(http_addr, "0.0.0.0:3128".parse::<SocketAddr>().unwrap());
        assert_eq!(socks_addr, "0.0.0.0:8081".parse::<SocketAddr>().unwrap());
    }

    #[test]
    fn clamp_bind_addrs_forces_loopback_when_unix_sockets_enabled() {
        let cfg = {
            let mut settings = settings_with_unix_sockets(&["/tmp/docker.sock"]);
            settings.dangerously_allow_non_loopback_proxy = true;
            settings
        };
        let http_addr = "0.0.0.0:3128".parse::<SocketAddr>().unwrap();
        let socks_addr = "0.0.0.0:8081".parse::<SocketAddr>().unwrap();

        let (http_addr, socks_addr) = clamp_bind_addrs(http_addr, socks_addr, &cfg);

        assert_eq!(http_addr, "127.0.0.1:3128".parse::<SocketAddr>().unwrap());
        assert_eq!(socks_addr, "127.0.0.1:8081".parse::<SocketAddr>().unwrap());
    }

    #[test]
    fn clamp_bind_addrs_forces_loopback_when_all_unix_sockets_enabled() {
        let cfg = NetworkProxySettings {
            dangerously_allow_non_loopback_proxy: true,
            dangerously_allow_all_unix_sockets: true,
            ..Default::default()
        };
        let http_addr = "0.0.0.0:3128".parse::<SocketAddr>().unwrap();
        let socks_addr = "0.0.0.0:8081".parse::<SocketAddr>().unwrap();

        let (http_addr, socks_addr) = clamp_bind_addrs(http_addr, socks_addr, &cfg);

        assert_eq!(http_addr, "127.0.0.1:3128".parse::<SocketAddr>().unwrap());
        assert_eq!(socks_addr, "127.0.0.1:8081".parse::<SocketAddr>().unwrap());
    }

    #[test]
    fn resolve_runtime_rejects_relative_allow_unix_sockets_entries() {
        let cfg = NetworkProxyConfig {
            network: settings_with_unix_sockets(&["relative.sock"]),
        };

        let err = match resolve_runtime(&cfg) {
            Ok(runtime) => panic!(
                "relative allow_unix_sockets should fail, but resolve_runtime succeeded: {:?}",
                runtime.http_addr
            ),
            Err(err) => err,
        };
        assert!(
            err.to_string().contains("network.allow_unix_sockets[0]"),
            "error should point at the invalid allow_unix_sockets entry: {err:#}"
        );
    }

    #[test]
    fn resolve_runtime_accepts_unix_style_absolute_allow_unix_sockets_entries() {
        let cfg = NetworkProxyConfig {
            network: settings_with_unix_sockets(&["/private/tmp/example.sock"]),
        };

        assert!(
            resolve_runtime(&cfg).is_ok(),
            "unix-style absolute allow_unix_sockets entry should be accepted"
        );
    }
}
