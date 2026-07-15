//! 网络代理配置状态与约束校验模块。
//!
//! 提供以下能力：
//! - 从用户配置构建运行时 [`ConfigState`]（编译允许/拒绝列表、加载 MITM 状态）
//! - 基于 [`NetworkProxyConstraints`] 校验用户配置是否在托管策略允许范围内
//! - 反序列化部分配置（`PartialNetworkConfig`）用于配置合并

use crate::config::NetworkDomainPermissions;
use crate::config::NetworkMode;
use crate::config::NetworkProxyConfig;
use crate::config::NetworkUnixSocketPermissions;
use crate::mitm::MitmState;
use crate::mitm::MitmUpstreamConfig;
use crate::mitm_hook::MitmHookConfig;
use crate::mitm_hook::compile_mitm_hooks;
use crate::mitm_hook::validate_mitm_hook_config;
use crate::policy::DomainPattern;
use crate::policy::compile_allowlist_globset;
use crate::policy::compile_denylist_globset;
use crate::policy::is_global_wildcard_domain_pattern;
use crate::runtime::ConfigState;
use serde::Deserialize;
use std::collections::HashSet;
use std::sync::Arc;

pub use crate::runtime::BlockedRequest;
pub use crate::runtime::BlockedRequestArgs;
pub use crate::runtime::NetworkProxyAuditMetadata;
pub use crate::runtime::NetworkProxyState;
#[cfg(test)]
pub(crate) use crate::runtime::network_proxy_state_for_policy;

/// 托管策略约束：定义用户配置允许的取值上限。
///
/// 每个字段为 `None` 表示该字段不受托管策略约束；为 `Some` 表示
/// 用户配置的对应字段必须满足约束（如不允许超过指定值）。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct NetworkProxyConstraints {
    /// 是否允许启用网络代理
    pub enabled: Option<bool>,
    /// 允许的最大网络模式（受限 vs 完全）
    pub mode: Option<NetworkMode>,
    /// 是否允许使用上游代理
    pub allow_upstream_proxy: Option<bool>,
    /// 是否允许监听非回环地址
    pub dangerously_allow_non_loopback_proxy: Option<bool>,
    /// 是否允许访问所有 Unix socket
    pub dangerously_allow_all_unix_sockets: Option<bool>,
    /// 托管的允许域名列表
    pub allowed_domains: Option<Vec<String>>,
    /// 是否允许在允许列表基础上扩展（true=可添加更多，false=必须严格匹配）
    pub allowlist_expansion_enabled: Option<bool>,
    /// 托管的拒绝域名列表
    pub denied_domains: Option<Vec<String>>,
    /// 是否允许在拒绝列表基础上扩展
    pub denylist_expansion_enabled: Option<bool>,
    /// 托管的允许 Unix socket 路径列表
    pub allow_unix_sockets: Option<Vec<String>>,
    /// 是否允许子进程绑定本地端口
    pub allow_local_binding: Option<bool>,
}

/// 部分网络代理配置（用于反序列化合并）。
#[derive(Debug, Clone, Deserialize)]
pub struct PartialNetworkProxyConfig {
    /// 实际的网络配置片段
    #[serde(default)]
    pub network: PartialNetworkConfig,
}

/// 部分网络配置：所有字段可选，用于配置合并。
#[derive(Debug, Default, Clone, Deserialize)]
pub struct PartialNetworkConfig {
    /// 是否启用网络代理
    pub enabled: Option<bool>,
    /// 网络访问模式
    pub mode: Option<NetworkMode>,
    /// 是否允许使用上游代理
    pub allow_upstream_proxy: Option<bool>,
    /// 是否允许监听非回环地址
    pub dangerously_allow_non_loopback_proxy: Option<bool>,
    /// 是否允许访问所有 Unix socket
    pub dangerously_allow_all_unix_sockets: Option<bool>,
    /// 域名权限规则
    #[serde(default)]
    pub domains: Option<NetworkDomainPermissions>,
    /// Unix socket 权限规则
    #[serde(default)]
    pub unix_sockets: Option<NetworkUnixSocketPermissions>,
    /// 是否允许子进程绑定本地端口
    pub allow_local_binding: Option<bool>,
    /// 是否启用 MITM TLS 解密
    pub mitm: Option<bool>,
    /// 是否启用凭据代理
    pub credential_broker: Option<bool>,
    /// 是否允许以明文形式注入凭据
    pub dangerously_allow_plaintext_credential_injection: Option<bool>,
    /// MITM 钩子配置列表
    #[serde(default)]
    pub mitm_hooks: Option<Vec<MitmHookConfig>>,
}

/// 从用户配置构建运行时配置状态。
///
/// 步骤：
/// 1. 校验 unix socket 允许列表路径合法
/// 2. 校验凭据代理依赖 MITM
/// 3. 编译允许/拒绝列表的 GlobSet
/// 4. 编译 MITM 钩子
/// 5. 若启用 MITM，加载 CA 并构建 [`MitmState`]
pub fn build_config_state(
    config: NetworkProxyConfig,
    constraints: NetworkProxyConstraints,
) -> anyhow::Result<ConfigState> {
    crate::config::validate_unix_socket_allowlist_paths(&config)?;
    anyhow::ensure!(
        !config.network.credential_broker || config.network.mitm,
        "network.credential_broker requires network.mitm = true"
    );
    let allowed_domains = config.network.allowed_domains().unwrap_or_default();
    let denied_domains = config.network.denied_domains().unwrap_or_default();
    validate_non_global_wildcard_domain_patterns("network.denied_domains", &denied_domains)
        .map_err(NetworkProxyConstraintError::into_anyhow)?;
    let deny_set = compile_denylist_globset(&denied_domains)?;
    let allow_set = compile_allowlist_globset(&allowed_domains)?;
    let mitm_hooks = compile_mitm_hooks(&config)?;
    let mitm = if config.network.mitm {
        Some(Arc::new(MitmState::new(MitmUpstreamConfig {
            allow_upstream_proxy: config.network.allow_upstream_proxy,
            allow_local_binding: config.network.allow_local_binding,
        })?))
    } else {
        None
    };
    Ok(ConfigState {
        config,
        allow_set,
        deny_set,
        mitm,
        mitm_hooks,
        constraints,
        blocked: std::collections::VecDeque::new(),
        blocked_total: 0,
    })
}

/// 校验用户配置是否满足托管策略约束。
///
/// 逐字段比对配置与约束：若用户配置超出约束上限则返回 [`NetworkProxyConstraintError`]。
/// 支持允许/拒绝列表的扩展模式（可添加更多条目 vs 必须严格匹配）。
pub fn validate_policy_against_constraints(
    config: &NetworkProxyConfig,
    constraints: &NetworkProxyConstraints,
) -> Result<(), NetworkProxyConstraintError> {
    fn invalid_value(
        field_name: &'static str,
        candidate: impl Into<String>,
        allowed: impl Into<String>,
    ) -> NetworkProxyConstraintError {
        NetworkProxyConstraintError::InvalidValue {
            field_name,
            candidate: candidate.into(),
            allowed: allowed.into(),
        }
    }

    fn validate<T>(
        candidate: T,
        validator: impl FnOnce(&T) -> Result<(), NetworkProxyConstraintError>,
    ) -> Result<(), NetworkProxyConstraintError> {
        validator(&candidate)
    }

    let enabled = config.network.enabled;
    let config_allowed_domains = config.network.allowed_domains().unwrap_or_default();
    let config_denied_domains = config.network.denied_domains().unwrap_or_default();
    let denied_domain_overrides: HashSet<String> = config_denied_domains
        .iter()
        .map(|entry| entry.to_ascii_lowercase())
        .collect();
    let config_allow_unix_sockets = config.network.allow_unix_sockets();
    validate_mitm_hook_config(config).map_err(invalid_mitm_hook_configuration)?;
    validate_non_global_wildcard_domain_patterns("network.denied_domains", &config_denied_domains)?;
    if let Some(max_enabled) = constraints.enabled {
        validate(enabled, move |candidate| {
            if *candidate && !max_enabled {
                Err(invalid_value(
                    "network.enabled",
                    "true",
                    "false (disabled by managed config)",
                ))
            } else {
                Ok(())
            }
        })?;
    }

    if let Some(max_mode) = constraints.mode {
        validate(config.network.mode, move |candidate| {
            if network_mode_rank(*candidate) > network_mode_rank(max_mode) {
                Err(invalid_value(
                    "network.mode",
                    format!("{candidate:?}"),
                    format!("{max_mode:?} or more restrictive"),
                ))
            } else {
                Ok(())
            }
        })?;
    }

    let allow_upstream_proxy = constraints.allow_upstream_proxy;
    validate(
        config.network.allow_upstream_proxy,
        move |candidate| match allow_upstream_proxy {
            Some(true) | None => Ok(()),
            Some(false) => {
                if *candidate {
                    Err(invalid_value(
                        "network.allow_upstream_proxy",
                        "true",
                        "false (disabled by managed config)",
                    ))
                } else {
                    Ok(())
                }
            }
        },
    )?;

    let allow_non_loopback_proxy = constraints.dangerously_allow_non_loopback_proxy;
    validate(
        config.network.dangerously_allow_non_loopback_proxy,
        move |candidate| match allow_non_loopback_proxy {
            Some(true) | None => Ok(()),
            Some(false) => {
                if *candidate {
                    Err(invalid_value(
                        "network.dangerously_allow_non_loopback_proxy",
                        "true",
                        "false (disabled by managed config)",
                    ))
                } else {
                    Ok(())
                }
            }
        },
    )?;

    let allow_all_unix_sockets = constraints
        .dangerously_allow_all_unix_sockets
        .unwrap_or(constraints.allow_unix_sockets.is_none());
    validate(
        config.network.dangerously_allow_all_unix_sockets,
        move |candidate| {
            if *candidate && !allow_all_unix_sockets {
                Err(invalid_value(
                    "network.dangerously_allow_all_unix_sockets",
                    "true",
                    "false (disabled by managed config)",
                ))
            } else {
                Ok(())
            }
        },
    )?;

    if let Some(allow_local_binding) = constraints.allow_local_binding {
        validate(config.network.allow_local_binding, move |candidate| {
            if *candidate && !allow_local_binding {
                Err(invalid_value(
                    "network.allow_local_binding",
                    "true",
                    "false (disabled by managed config)",
                ))
            } else {
                Ok(())
            }
        })?;
    }

    if let Some(allowed_domains) = &constraints.allowed_domains {
        validate_non_global_wildcard_domain_patterns("network.allowed_domains", allowed_domains)?;
        match constraints.allowlist_expansion_enabled {
            Some(true) => {
                let required_set: HashSet<String> = allowed_domains
                    .iter()
                    .map(|entry| entry.to_ascii_lowercase())
                    .collect();
                validate(config_allowed_domains, |candidate| {
                    let candidate_set: HashSet<String> = candidate
                        .iter()
                        .map(|entry| entry.to_ascii_lowercase())
                        .collect();
                    let missing: Vec<String> = required_set
                        .iter()
                        .filter(|entry| {
                            !candidate_set.contains(*entry)
                                && !denied_domain_overrides.contains(*entry)
                        })
                        .cloned()
                        .collect();
                    if missing.is_empty() {
                        Ok(())
                    } else {
                        Err(invalid_value(
                            "network.allowed_domains",
                            "missing managed allowed_domains entries",
                            format!("{missing:?}"),
                        ))
                    }
                })?;
            }
            Some(false) => {
                let required_set: HashSet<String> = allowed_domains
                    .iter()
                    .map(|entry| entry.to_ascii_lowercase())
                    .collect();
                validate(config_allowed_domains, |candidate| {
                    let candidate_set: HashSet<String> = candidate
                        .iter()
                        .map(|entry| entry.to_ascii_lowercase())
                        .collect();
                    let expected_set: HashSet<String> = required_set
                        .difference(&denied_domain_overrides)
                        .cloned()
                        .collect();
                    if candidate_set == expected_set {
                        Ok(())
                    } else {
                        Err(invalid_value(
                            "network.allowed_domains",
                            format!("{candidate:?}"),
                            "must match managed allowed_domains",
                        ))
                    }
                })?;
            }
            None => {
                let managed_patterns: Vec<DomainPattern> = allowed_domains
                    .iter()
                    .map(|entry| DomainPattern::parse_for_constraints(entry))
                    .collect();
                validate(config_allowed_domains, move |candidate| {
                    let mut invalid = Vec::new();
                    for entry in candidate {
                        let candidate_pattern = DomainPattern::parse_for_constraints(entry);
                        if !managed_patterns
                            .iter()
                            .any(|managed| managed.allows(&candidate_pattern))
                        {
                            invalid.push(entry.clone());
                        }
                    }
                    if invalid.is_empty() {
                        Ok(())
                    } else {
                        Err(invalid_value(
                            "network.allowed_domains",
                            format!("{invalid:?}"),
                            "subset of managed allowed_domains",
                        ))
                    }
                })?;
            }
        }
    }

    if let Some(denied_domains) = &constraints.denied_domains {
        validate_non_global_wildcard_domain_patterns("network.denied_domains", denied_domains)?;
        let required_set: HashSet<String> = denied_domains
            .iter()
            .map(|s| s.to_ascii_lowercase())
            .collect();
        match constraints.denylist_expansion_enabled {
            Some(false) => {
                validate(config_denied_domains, move |candidate| {
                    let candidate_set: HashSet<String> = candidate
                        .iter()
                        .map(|entry| entry.to_ascii_lowercase())
                        .collect();
                    if candidate_set == required_set {
                        Ok(())
                    } else {
                        Err(invalid_value(
                            "network.denied_domains",
                            format!("{candidate:?}"),
                            "must match managed denied_domains",
                        ))
                    }
                })?;
            }
            Some(true) | None => {
                validate(config_denied_domains, move |candidate| {
                    let candidate_set: HashSet<String> =
                        candidate.iter().map(|s| s.to_ascii_lowercase()).collect();
                    let missing: Vec<String> = required_set
                        .iter()
                        .filter(|entry| !candidate_set.contains(*entry))
                        .cloned()
                        .collect();
                    if missing.is_empty() {
                        Ok(())
                    } else {
                        Err(invalid_value(
                            "network.denied_domains",
                            "missing managed denied_domains entries",
                            format!("{missing:?}"),
                        ))
                    }
                })?;
            }
        }
    }

    if let Some(allow_unix_sockets) = &constraints.allow_unix_sockets {
        let allowed_set: HashSet<String> = allow_unix_sockets
            .iter()
            .map(|s| s.to_ascii_lowercase())
            .collect();
        validate(config_allow_unix_sockets, move |candidate| {
            let mut invalid = Vec::new();
            for entry in candidate {
                if !allowed_set.contains(&entry.to_ascii_lowercase()) {
                    invalid.push(entry.clone());
                }
            }
            if invalid.is_empty() {
                Ok(())
            } else {
                Err(invalid_value(
                    "network.allow_unix_sockets",
                    format!("{invalid:?}"),
                    "subset of managed allow_unix_sockets",
                ))
            }
        })?;
    }

    Ok(())
}

fn invalid_mitm_hook_configuration(err: anyhow::Error) -> NetworkProxyConstraintError {
    NetworkProxyConstraintError::InvalidValue {
        field_name: "network.mitm_hooks",
        candidate: err.to_string(),
        allowed: "valid MITM hook configuration".to_string(),
    }
}

fn validate_non_global_wildcard_domain_patterns(
    field_name: &'static str,
    patterns: &[String],
) -> Result<(), NetworkProxyConstraintError> {
    if let Some(pattern) = patterns
        .iter()
        .find(|pattern| is_global_wildcard_domain_pattern(pattern))
    {
        return Err(NetworkProxyConstraintError::InvalidValue {
            field_name,
            candidate: pattern.trim().to_string(),
            allowed: "exact hosts or scoped wildcards like *.example.com or **.example.com"
                .to_string(),
        });
    }
    Ok(())
}

/// 网络代理约束校验错误。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NetworkProxyConstraintError {
    /// 字段值超出托管策略允许的范围
    #[error("invalid value for {field_name}: {candidate} (allowed {allowed})")]
    InvalidValue {
        /// 字段名
        field_name: &'static str,
        /// 用户配置的候选值
        candidate: String,
        /// 允许的取值描述
        allowed: String,
    },
}

impl NetworkProxyConstraintError {
    /// 将约束错误转换为 `anyhow::Error`，便于在返回 `anyhow::Result` 的上下文中传播。
    pub fn into_anyhow(self) -> anyhow::Error {
        anyhow::anyhow!(self)
    }
}

/// 网络模式的安全等级排序：值越小表示越受限。
fn network_mode_rank(mode: NetworkMode) -> u8 {
    match mode {
        NetworkMode::Limited => 0,
        NetworkMode::Full => 1,
    }
}

#[cfg(test)]
mod tests {}
