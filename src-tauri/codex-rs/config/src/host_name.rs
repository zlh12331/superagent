//! 进程级缓存的主机名获取工具。
//!
//! 提供 `host_name()` 用于获取本机规范主机名（优先 FQDN，回退到内核
//! hostname）。结果在进程内通过 `LazyLock` 缓存，首次调用在 Unix 上可能
//! 触发阻塞式 DNS 解析。
//!
//! 用途：远程 sandbox requirements 通过 DNS 名匹配远程主机，因此需要
//! 规范化的 FQDN 进行主机分类（best-effort，非设备身份认证）。

#[cfg(unix)]
use dns_lookup::AddrInfoHints;
#[cfg(unix)]
use dns_lookup::getaddrinfo;
use std::sync::LazyLock;
#[cfg(windows)]
use winapi_util::sysinfo::ComputerNameKind;
#[cfg(windows)]
use winapi_util::sysinfo::get_computer_name;

static HOST_NAME: LazyLock<Option<String>> = LazyLock::new(compute_host_name);

/// 返回进程缓存的规范主机名；优先 FQDN，回退到规范化后的内核 hostname。
///
/// 在 Unix 上首次调用可能执行阻塞 DNS 解析；后续调用直接返回缓存值。
pub fn host_name() -> Option<String> {
    HOST_NAME.clone()
}

/// 计算规范主机名：先取内核 hostname 并规范化，再尝试解析其 FQDN。
///
/// 优先返回 FQDN；若本地解析器无法给出 DNS 合格名，则回退到清理后的
/// 内核 hostname，确保总有非 `None` 结果（除非内核 hostname 为空）。
fn compute_host_name() -> Option<String> {
    let kernel_hostname = gethostname::gethostname();
    let kernel_hostname = normalize_host_name(&kernel_hostname.to_string_lossy())?;

    // 远程 sandbox requirements 通过 DNS 名定位远程主机，因此优先使用
    // 本地解析器提供的规范 FQDN。这是 best-effort 主机分类，非设备认证。
    if let Some(fqdn) = local_fqdn_for_hostname(&kernel_hostname) {
        return Some(fqdn);
    }

    // 部分机器仅有短主机名，或解析器配置不返回 AI_CANONNAME。此时回退到
    // 清理后的内核 hostname，避免返回 None 而中断匹配流程。
    Some(kernel_hostname)
}

/// 规范化主机名：去首尾空白、去尾部点号、转小写；空串返回 `None`。
fn normalize_host_name(hostname: &str) -> Option<String> {
    let hostname = hostname.trim().trim_end_matches('.');
    (!hostname.is_empty()).then(|| hostname.to_ascii_lowercase())
}

/// 在 Unix 上通过 `getaddrinfo` + `AI_CANONNAME` 解析主机名对应的 FQDN。
///
/// 仅接受含点的 DNS 合格名作为 FQDN 候选，因为 `getaddrinfo` 在无 FQDN
/// 时可能把短主机名作为 canonname 返回。
#[cfg(unix)]
fn local_fqdn_for_hostname(hostname: &str) -> Option<String> {
    let hints = AddrInfoHints {
        flags: libc::AI_CANONNAME,
        ..AddrInfoHints::default()
    };

    getaddrinfo(Some(hostname), /*service*/ None, Some(hints))
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|addr| addr.canonname)
        // getaddrinfo 在无 FQDN 时可能返回短主机名作为 canonname；
        // 仅 DNS 合格名（含点）才视为 FQDN 结果。
        .find_map(|hostname| normalize_fqdn_candidate(&hostname))
}

/// 在 Windows 上通过 `GetComputerName` (PhysicalDnsFullyQualified) 取 FQDN。
#[cfg(windows)]
fn local_fqdn_for_hostname(_hostname: &str) -> Option<String> {
    get_computer_name(ComputerNameKind::PhysicalDnsFullyQualified)
        .ok()
        .and_then(|hostname| hostname.into_string().ok())
        .and_then(|hostname| normalize_fqdn_candidate(&hostname))
}

/// 非 Unix/Windows 平台不支持 FQDN 解析，始终返回 `None`。
#[cfg(not(any(unix, windows)))]
fn local_fqdn_for_hostname(_hostname: &str) -> Option<String> {
    None
}

/// 规范化 FQDN 候选：先按 `normalize_host_name` 清理，再要求含点（DNS 合格）。
fn normalize_fqdn_candidate(hostname: &str) -> Option<String> {
    normalize_host_name(hostname).filter(|hostname| hostname.contains('.'))
}

#[cfg(test)]
mod tests {
    use super::normalize_fqdn_candidate;
    use pretty_assertions::assert_eq;

    #[test]
    fn normalize_fqdn_candidate_accepts_dns_qualified_name() {
        assert_eq!(
            normalize_fqdn_candidate("runner-01.ci.example.com"),
            Some("runner-01.ci.example.com".to_string())
        );
    }

    #[test]
    fn normalize_fqdn_candidate_rejects_short_name() {
        assert_eq!(normalize_fqdn_candidate("runner-01"), None);
    }

    #[test]
    fn normalize_fqdn_candidate_trims_trailing_dot_and_normalizes_case() {
        assert_eq!(
            normalize_fqdn_candidate("RUNNER-01.CI.EXAMPLE.COM."),
            Some("runner-01.ci.example.com".to_string())
        );
    }
}
