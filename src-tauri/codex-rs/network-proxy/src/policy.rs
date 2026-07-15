//! 网络策略与主机名归一化模块。
//!
//! 提供主机名解析、归一化、回环/非公网 IP 判定、域名通配符模式编译等能力。
//! 主要用于网络代理的允许/拒绝列表匹配，以及 SSRF 防御（拒绝访问本地/私有地址）。
//!
//! 支持的域名模式：
//! - 精确匹配：`example.com`
//! - 子域匹配：`*.example.com`（仅匹配子域，不含 apex）
//! - 全量匹配：`**.example.com`（匹配 apex 与所有子域）
//! - 全局通配符：`*`（仅在允许列表中可用）

#[cfg(test)]
use crate::config::NetworkMode;
use anyhow::Context;
use anyhow::Result;
use anyhow::bail;
use anyhow::ensure;
use globset::GlobBuilder;
use globset::GlobSet;
use globset::GlobSetBuilder;
use std::collections::HashSet;
use std::net::IpAddr;
use std::net::Ipv4Addr;
use std::net::Ipv6Addr;
use url::Host as UrlHost;

/// 归一化后的主机字符串，用于策略匹配。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Host(String);

impl Host {
    /// 解析并归一化主机字符串，空字符串会返回错误。
    pub fn parse(input: &str) -> Result<Self> {
        let normalized = normalize_host(input);
        ensure!(!normalized.is_empty(), "host is empty");
        Ok(Self(normalized))
    }

    /// 返回归一化后的主机字符串。
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// 判断主机是否为回环主机名或 IP 字面量。
pub fn is_loopback_host(host: &Host) -> bool {
    let host = host.as_str();
    let host = unscoped_ip_literal(host).unwrap_or(host);
    if host == "localhost" {
        return true;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return ip.is_loopback();
    }
    false
}

/// 判断 IP 是否为非公网地址（私有、回环、链路本地等），用于 SSRF 防御。
pub fn is_non_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_non_public_ipv4(ip),
        IpAddr::V6(ip) => is_non_public_ipv6(ip),
    }
}

/// 判断 IPv4 是否为非公网地址。
fn is_non_public_ipv4(ip: Ipv4Addr) -> bool {
    // 优先使用标准库的分类辅助函数：它们比手写范围检查更清晰地表达意图。
    // 部分非公网范围（如 CGNAT 与 TEST-NET 块）尚未被稳定版 stdlib 覆盖，
    // 因此回退到 CIDR 检查。
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_broadcast()
        || ipv4_in_cidr(ip, [0, 0, 0, 0], /*prefix*/ 8) // "this network" (RFC 1122)
        || ipv4_in_cidr(ip, [100, 64, 0, 0], /*prefix*/ 10) // CGNAT (RFC 6598)
        || ipv4_in_cidr(ip, [192, 0, 0, 0], /*prefix*/ 24) // IETF Protocol Assignments (RFC 6890)
        || ipv4_in_cidr(ip, [192, 0, 2, 0], /*prefix*/ 24) // TEST-NET-1 (RFC 5737)
        || ipv4_in_cidr(ip, [198, 18, 0, 0], /*prefix*/ 15) // Benchmarking (RFC 2544)
        || ipv4_in_cidr(ip, [198, 51, 100, 0], /*prefix*/ 24) // TEST-NET-2 (RFC 5737)
        || ipv4_in_cidr(ip, [203, 0, 113, 0], /*prefix*/ 24) // TEST-NET-3 (RFC 5737)
        || ipv4_in_cidr(ip, [240, 0, 0, 0], /*prefix*/ 4) // Reserved (RFC 6890)
}

/// 判断 IPv4 是否位于指定 CIDR 范围内。
fn ipv4_in_cidr(ip: Ipv4Addr, base: [u8; 4], prefix: u8) -> bool {
    let ip = u32::from(ip);
    let base = u32::from(Ipv4Addr::from(base));
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    (ip & mask) == (base & mask)
}

/// 判断 IPv6 是否为非公网地址。
fn is_non_public_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4() {
        return is_non_public_ipv4(v4) || ip.is_loopback();
    }
    // 为防御 SSRF，将所有非全局可路由地址视为 "本地"。具体包括：
    //  - `::1` 回环
    //  - `fc00::/7` 唯一本地地址（RFC 4193）
    //  - `fe80::/10` 链路本地
    //  - `::` 未指定
    //  - 多播范围
    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_unique_local()
        || ip.is_unicast_link_local()
}

/// 归一化主机字符串：去除空白、端口、方括号，并转小写。
pub fn normalize_host(host: &str) -> String {
    let host = host.trim();
    if host.starts_with('[')
        && let Some(end) = host.find(']')
    {
        return normalize_dns_host_or_ip_literal(&host[1..end]);
    }

    // 代理栈通常会传入不含端口的主机名，但此处仍做防御性处理：
    // 当仅含一个 `:` 时剥离 `:port`。
    if host.bytes().filter(|b| *b == b':').count() == 1 {
        let host = host.split(':').next().unwrap_or_default();
        return normalize_dns_host_or_ip_literal(host);
    }

    // 避免破坏未加方括号的 IPv6 字面量；同时去除末尾点，
    // 使完全限定域名与其无点变体被同等对待。
    normalize_dns_host_or_ip_literal(host)
}

/// 归一化 DNS 主机名或 IP 字面量：转小写、去末尾点、规范化 IP 字面量。
fn normalize_dns_host_or_ip_literal(host: &str) -> String {
    let host = host.to_ascii_lowercase();
    let host = host.trim_end_matches('.');
    if let Some(ip) = normalize_ip_literal(host) {
        return ip;
    }
    host.to_string()
}

/// 去除 IPv6 字面量的 scope id（如 `fe80::1%lo0` -> `fe80::1`），用于回环判断。
pub(crate) fn unscoped_ip_literal(host: &str) -> Option<&str> {
    let (ip, _) = host.split_once('%')?;
    ip.parse::<IpAddr>().ok()?;
    Some(ip)
}

/// 规范化 IP 字面量：处理 `%25`（URL 编码的 `%`）与 `%` 分隔的 scope id。
fn normalize_ip_literal(host: &str) -> Option<String> {
    if host.parse::<IpAddr>().is_ok() {
        return Some(host.to_string());
    }
    for delimiter in ["%25", "%"] {
        if let Some((ip, scope)) = host.split_once(delimiter)
            && ip.parse::<IpAddr>().is_ok()
        {
            return Some(format!("{ip}%{scope}"));
        }
    }
    None
}

/// 归一化域名通配符模式：剥离前后空白、归一化剩余部分。
fn normalize_pattern(pattern: &str) -> String {
    let pattern = pattern.trim();
    if pattern == "*" {
        return "*".to_string();
    }

    let (prefix, remainder) = if let Some(domain) = pattern.strip_prefix("**.") {
        ("**.", domain)
    } else if let Some(domain) = pattern.strip_prefix("*.") {
        ("*.", domain)
    } else {
        ("", pattern)
    };

    let remainder = normalize_host(remainder);
    if prefix.is_empty() {
        remainder
    } else {
        format!("{prefix}{remainder}")
    }
}

/// 判断模式是否为全局通配符（`*`，匹配所有主机）。
pub(crate) fn is_global_wildcard_domain_pattern(pattern: &str) -> bool {
    let normalized = normalize_pattern(pattern);
    expand_domain_pattern(&normalized)
        .iter()
        .any(|candidate| candidate == "*")
}

/// 编译时的全局通配符策略：允许或拒绝。
#[derive(Clone, Copy, PartialEq, Eq)]
enum GlobalWildcard {
    /// 允许全局通配符（用于 allowlist 编译）
    Allow,
    /// 拒绝全局通配符（用于 denylist 编译，防止误封全部域名）
    Reject,
}

/// 编译允许列表的 GlobSet。
pub(crate) fn compile_allowlist_globset(patterns: &[String]) -> Result<GlobSet> {
    compile_globset_with_policy(patterns, GlobalWildcard::Allow)
}

/// 编译拒绝列表的 GlobSet。
pub(crate) fn compile_denylist_globset(patterns: &[String]) -> Result<GlobSet> {
    compile_globset_with_policy(patterns, GlobalWildcard::Reject)
}

/// 按指定全局通配符策略编译 GlobSet。
fn compile_globset_with_policy(
    patterns: &[String],
    global_wildcard: GlobalWildcard,
) -> Result<GlobSet> {
    let mut builder = GlobSetBuilder::new();
    let mut seen = HashSet::new();
    for pattern in patterns {
        if global_wildcard == GlobalWildcard::Reject && is_global_wildcard_domain_pattern(pattern) {
            bail!(
                "unsupported global wildcard domain pattern \"*\"; use exact hosts or scoped wildcards like *.example.com or **.example.com"
            );
        }
        let pattern = normalize_pattern(pattern);
        // 支持的域名模式：
        // - "example.com"：精确匹配主机
        // - "*.example.com"：匹配任意子域（不含 apex）
        // - "**.example.com"：匹配 apex 与任意子域
        // - "*"：匹配所有主机（仅在 allowlist 编译时显式启用）
        for candidate in expand_domain_pattern(&pattern) {
            if !seen.insert(candidate.clone()) {
                continue;
            }
            let glob = GlobBuilder::new(&candidate)
                .case_insensitive(true)
                .build()
                .with_context(|| format!("invalid glob pattern: {candidate}"))?;
            builder.add(glob);
        }
    }
    Ok(builder.build()?)
}

/// 解析后的域名模式：用于约束比较。
#[derive(Debug, Clone)]
pub(crate) enum DomainPattern {
    /// 匹配 apex 与所有子域（`**.example.com`）
    ApexAndSubdomains(String),
    /// 仅匹配子域（`*.example.com`）
    SubdomainsOnly(String),
    /// 精确匹配（`example.com`）
    Exact(String),
}

impl DomainPattern {
    /// 解析策略模式用于约束比较。
    ///
    /// glob 语法的校验在构建 GlobSet 时完成；此处仅解码通配符前缀，
    /// 以保持约束检查的轻量。
    pub(crate) fn parse(input: &str) -> Self {
        let input = input.trim();
        if input.is_empty() {
            return Self::Exact(String::new());
        }
        if let Some(domain) = input.strip_prefix("**.") {
            Self::parse_domain(domain, Self::ApexAndSubdomains)
        } else if let Some(domain) = input.strip_prefix("*.") {
            Self::parse_domain(domain, Self::SubdomainsOnly)
        } else {
            Self::Exact(input.to_string())
        }
    }

    /// 解析策略模式用于约束比较，并通过 `url` crate 校验域名部分合法性。
    pub(crate) fn parse_for_constraints(input: &str) -> Self {
        let input = input.trim();
        if input.is_empty() {
            return Self::Exact(String::new());
        }
        if let Some(domain) = input.strip_prefix("**.") {
            return Self::ApexAndSubdomains(parse_domain_for_constraints(domain));
        }
        if let Some(domain) = input.strip_prefix("*.") {
            return Self::SubdomainsOnly(parse_domain_for_constraints(domain));
        }
        Self::Exact(parse_domain_for_constraints(input))
    }

    /// 内部辅助：解析域名部分并应用构造器。
    fn parse_domain(domain: &str, build: impl FnOnce(String) -> Self) -> Self {
        let domain = domain.trim();
        if domain.is_empty() {
            return Self::Exact(String::new());
        }
        build(domain.to_string())
    }

    /// 判断当前模式是否允许（包含）候选模式。
    pub(crate) fn allows(&self, candidate: &DomainPattern) -> bool {
        match self {
            DomainPattern::Exact(domain) => match candidate {
                DomainPattern::Exact(candidate) => domain_eq(candidate, domain),
                _ => false,
            },
            DomainPattern::SubdomainsOnly(domain) => match candidate {
                DomainPattern::Exact(candidate) => is_strict_subdomain(candidate, domain),
                DomainPattern::SubdomainsOnly(candidate) => {
                    is_subdomain_or_equal(candidate, domain)
                }
                DomainPattern::ApexAndSubdomains(candidate) => {
                    is_strict_subdomain(candidate, domain)
                }
            },
            DomainPattern::ApexAndSubdomains(domain) => match candidate {
                DomainPattern::Exact(candidate) => is_subdomain_or_equal(candidate, domain),
                DomainPattern::SubdomainsOnly(candidate) => {
                    is_subdomain_or_equal(candidate, domain)
                }
                DomainPattern::ApexAndSubdomains(candidate) => {
                    is_subdomain_or_equal(candidate, domain)
                }
            },
        }
    }
}

/// 解析域名部分用于约束比较，剥离末尾点与方括号，并通过 `url` crate 校验。
fn parse_domain_for_constraints(domain: &str) -> String {
    let domain = domain.trim().trim_end_matches('.');
    if domain.is_empty() {
        return String::new();
    }
    let host = if domain.starts_with('[') && domain.ends_with(']') {
        &domain[1..domain.len().saturating_sub(1)]
    } else {
        domain
    };
    // 含通配符或百分号的输入不通过 url crate 校验，直接返回原值
    if host.contains('*') || host.contains('?') || host.contains('%') {
        return domain.to_string();
    }
    match UrlHost::parse(host) {
        Ok(host) => host.to_string(),
        Err(_) => String::new(),
    }
}

/// 将域名模式展开为具体的 glob 候选列表。
fn expand_domain_pattern(pattern: &str) -> Vec<String> {
    match DomainPattern::parse(pattern) {
        DomainPattern::Exact(domain) => vec![domain],
        DomainPattern::SubdomainsOnly(domain) => {
            vec![format!("?*.{domain}")]
        }
        DomainPattern::ApexAndSubdomains(domain) => {
            vec![domain.clone(), format!("?*.{domain}")]
        }
    }
}

/// 归一化域名：去末尾点 + 转小写。
fn normalize_domain(domain: &str) -> String {
    domain.trim_end_matches('.').to_ascii_lowercase()
}

/// 判断两个域名是否相等（归一化后比较）。
fn domain_eq(left: &str, right: &str) -> bool {
    normalize_domain(left) == normalize_domain(right)
}

/// 判断 child 是否为 parent 的子域或相等。
fn is_subdomain_or_equal(child: &str, parent: &str) -> bool {
    let child = normalize_domain(child);
    let parent = normalize_domain(parent);
    if child == parent {
        return true;
    }
    child.ends_with(&format!(".{parent}"))
}

/// 判断 child 是否为 parent 的严格子域（不相等）。
fn is_strict_subdomain(child: &str, parent: &str) -> bool {
    let child = normalize_domain(child);
    let parent = normalize_domain(parent);
    child != parent && child.ends_with(&format!(".{parent}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    use pretty_assertions::assert_eq;

    #[test]
    fn method_allowed_full_allows_everything() {
        assert!(NetworkMode::Full.allows_method("GET"));
        assert!(NetworkMode::Full.allows_method("POST"));
        assert!(NetworkMode::Full.allows_method("CONNECT"));
    }

    #[test]
    fn method_allowed_limited_allows_only_safe_methods() {
        assert!(NetworkMode::Limited.allows_method("GET"));
        assert!(NetworkMode::Limited.allows_method("HEAD"));
        assert!(NetworkMode::Limited.allows_method("OPTIONS"));
        assert!(!NetworkMode::Limited.allows_method("POST"));
        assert!(!NetworkMode::Limited.allows_method("CONNECT"));
    }

    #[test]
    fn compile_globset_normalizes_trailing_dots() {
        let set = compile_denylist_globset(&["Example.COM.".to_string()]).unwrap();

        assert_eq!(true, set.is_match("example.com"));
        assert_eq!(false, set.is_match("api.example.com"));
    }

    #[test]
    fn compile_globset_normalizes_wildcards() {
        let set = compile_denylist_globset(&["*.Example.COM.".to_string()]).unwrap();

        assert_eq!(true, set.is_match("api.example.com"));
        assert_eq!(false, set.is_match("example.com"));
    }

    #[test]
    fn compile_globset_supports_mid_label_wildcards() {
        let set = compile_denylist_globset(&["region*.v2.argotunnel.com".to_string()]).unwrap();

        assert_eq!(true, set.is_match("region1.v2.argotunnel.com"));
        assert_eq!(true, set.is_match("region.v2.argotunnel.com"));
        assert_eq!(false, set.is_match("xregion1.v2.argotunnel.com"));
        assert_eq!(false, set.is_match("foo.region1.v2.argotunnel.com"));
    }

    #[test]
    fn compile_globset_normalizes_apex_and_subdomains() {
        let set = compile_denylist_globset(&["**.Example.COM.".to_string()]).unwrap();

        assert_eq!(true, set.is_match("example.com"));
        assert_eq!(true, set.is_match("api.example.com"));
    }

    #[test]
    fn compile_globset_normalizes_bracketed_ipv6_literals() {
        let set = compile_denylist_globset(&["[::1]".to_string()]).unwrap();

        assert_eq!(true, set.is_match("::1"));
    }

    #[test]
    fn compile_globset_preserves_scoped_ipv6_literals() {
        let set = compile_denylist_globset(&["[fe80::1%25lo0]".to_string()]).unwrap();

        assert_eq!(true, set.is_match("fe80::1%lo0"));
        assert_eq!(false, set.is_match("fe80::1%lo1"));
        assert_eq!(false, set.is_match("fe80::1"));
    }

    #[test]
    fn is_loopback_host_handles_localhost_variants() {
        assert!(is_loopback_host(&Host::parse("localhost").unwrap()));
        assert!(is_loopback_host(&Host::parse("localhost.").unwrap()));
        assert!(is_loopback_host(&Host::parse("LOCALHOST").unwrap()));
        assert!(!is_loopback_host(&Host::parse("notlocalhost").unwrap()));
    }

    #[test]
    fn is_loopback_host_handles_ip_literals() {
        assert!(is_loopback_host(&Host::parse("127.0.0.1").unwrap()));
        assert!(is_loopback_host(&Host::parse("::1").unwrap()));
        assert!(!is_loopback_host(&Host::parse("1.2.3.4").unwrap()));
    }

    #[test]
    fn is_non_public_ip_rejects_private_and_loopback_ranges() {
        assert!(is_non_public_ip("127.0.0.1".parse().unwrap()));
        assert!(is_non_public_ip("10.0.0.1".parse().unwrap()));
        assert!(is_non_public_ip("192.168.0.1".parse().unwrap()));
        assert!(is_non_public_ip("100.64.0.1".parse().unwrap()));
        assert!(is_non_public_ip("192.0.0.1".parse().unwrap()));
        assert!(is_non_public_ip("192.0.2.1".parse().unwrap()));
        assert!(is_non_public_ip("198.18.0.1".parse().unwrap()));
        assert!(is_non_public_ip("198.51.100.1".parse().unwrap()));
        assert!(is_non_public_ip("203.0.113.1".parse().unwrap()));
        assert!(is_non_public_ip("240.0.0.1".parse().unwrap()));
        assert!(is_non_public_ip("0.1.2.3".parse().unwrap()));
        assert!(!is_non_public_ip("8.8.8.8".parse().unwrap()));

        assert!(is_non_public_ip("::ffff:127.0.0.1".parse().unwrap()));
        assert!(is_non_public_ip("::ffff:10.0.0.1".parse().unwrap()));
        assert!(!is_non_public_ip("::ffff:8.8.8.8".parse().unwrap()));

        assert!(is_non_public_ip("::1".parse().unwrap()));
        assert!(is_non_public_ip("fe80::1".parse().unwrap()));
        assert!(is_non_public_ip("fc00::1".parse().unwrap()));
    }

    #[test]
    fn normalize_host_lowercases_and_trims() {
        assert_eq!(normalize_host("  ExAmPlE.CoM  "), "example.com");
    }

    #[test]
    fn normalize_host_strips_port_for_host_port() {
        assert_eq!(normalize_host("example.com:1234"), "example.com");
    }

    #[test]
    fn normalize_host_preserves_unbracketed_ipv6() {
        assert_eq!(normalize_host("2001:db8::1"), "2001:db8::1");
    }

    #[test]
    fn normalize_host_strips_trailing_dot() {
        assert_eq!(normalize_host("example.com."), "example.com");
        assert_eq!(normalize_host("ExAmPlE.CoM."), "example.com");
    }

    #[test]
    fn normalize_host_strips_trailing_dot_with_port() {
        assert_eq!(normalize_host("example.com.:443"), "example.com");
    }

    #[test]
    fn normalize_host_strips_brackets_for_ipv6() {
        assert_eq!(normalize_host("[::1]"), "::1");
        assert_eq!(normalize_host("[::1]:443"), "::1");
    }

    #[test]
    fn normalize_host_preserves_ipv6_scope_ids() {
        assert_eq!(normalize_host("fe80::1%lo0"), "fe80::1%lo0");
        assert_eq!(normalize_host("[fe80::1%lo0]"), "fe80::1%lo0");
        assert_eq!(normalize_host("[fe80::1%25lo0]"), "fe80::1%lo0");
    }
}
