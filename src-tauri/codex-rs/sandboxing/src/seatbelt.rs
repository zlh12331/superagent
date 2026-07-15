//! macOS Seatbelt（sandbox-exec）沙箱策略生成器。
//!
//! 本模块负责根据文件系统/网络权限策略与代理配置，拼装出可直接传给
//! `/usr/bin/sandbox-exec` 的 SBPL（Seatbelt Policy Language）字符串。
//!
//! 主要职责：
//! - 将 `FileSystemSandboxPolicy` 的可读/可写根、排除子路径、受保护元数据
//!   转换为 `(allow file-read* / file-write* ...)` 规则与对应的 `-D` 参数
//! - 将 `NetworkSandboxPolicy` 与代理 loopback 端口、Unix domain socket 白名单
//!   转换为 `(allow network-*)` 规则
//! - 将 git 风格的 unreadable glob 转换为 anchored regex deny 规则
//! - 提供 legacy `SandboxPolicy` 兼容入口 [`create_seatbelt_command_args_for_legacy_policy`]

use codex_network_proxy::ManagedNetworkSandboxContext;
use codex_network_proxy::NetworkProxy;
use codex_network_proxy::PROXY_URL_ENV_KEYS;
use codex_network_proxy::has_proxy_url_env_vars;
use codex_network_proxy::proxy_url_env_value;
use codex_protocol::permissions::FileSystemSandboxPolicy;
use codex_protocol::permissions::NetworkSandboxPolicy;
use codex_protocol::permissions::PROTECTED_METADATA_PATH_NAMES;
use codex_protocol::protocol::SandboxPolicy;
use codex_protocol::protocol::WritableRoot;
use codex_utils_absolute_path::AbsolutePathBuf;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::path::Path;
use std::path::PathBuf;
use tracing::warn;
use url::Url;

const MACOS_SEATBELT_BASE_POLICY: &str = include_str!("seatbelt_base_policy.sbpl");
const MACOS_SEATBELT_NETWORK_POLICY: &str = include_str!("seatbelt_network_policy.sbpl");
const MACOS_RESTRICTED_READ_ONLY_PLATFORM_DEFAULTS: &str =
    include_str!("restricted_read_only_platform_defaults.sbpl");

/// 调用 `sandbox-exec` 时仅使用 `/usr/bin` 下的版本，防止攻击者通过 PATH
/// 注入恶意可执行文件。如果 `/usr/bin/sandbox-exec` 已被篡改，则攻击者
/// 实际上已拥有 root 权限。
pub const MACOS_PATH_TO_SEATBELT_EXECUTABLE: &str = "/usr/bin/sandbox-exec";

/// 判断主机名是否为 loopback（localhost / 127.0.0.1 / ::1）。
fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1"
}

/// 返回代理 scheme 的默认端口（无显式端口时使用）。
fn proxy_scheme_default_port(scheme: &str) -> u16 {
    match scheme {
        "https" => 443,
        "socks5" | "socks5h" | "socks4" | "socks4a" => 1080,
        _ => 80,
    }
}

/// 从环境变量中扫描所有指向 loopback 主机的代理 URL，汇总其端口集合。
fn proxy_loopback_ports_from_env(env: &HashMap<String, String>) -> Vec<u16> {
    let mut ports = BTreeSet::new();
    for key in PROXY_URL_ENV_KEYS {
        let Some(proxy_url) = proxy_url_env_value(env, key) else {
            continue;
        };
        let trimmed = proxy_url.trim();
        if trimmed.is_empty() {
            continue;
        }

        let candidate = if trimmed.contains("://") {
            trimmed.to_string()
        } else {
            format!("http://{trimmed}")
        };
        let Ok(parsed) = Url::parse(&candidate) else {
            continue;
        };
        let Some(host) = parsed.host_str() else {
            continue;
        };
        if !is_loopback_host(host) {
            continue;
        }

        let scheme = parsed.scheme().to_ascii_lowercase();
        let port = parsed
            .port()
            .unwrap_or_else(|| proxy_scheme_default_port(scheme.as_str()));
        ports.insert(port);
    }
    ports.into_iter().collect()
}

/// 汇总代理相关的策略输入，供生成 Seatbelt 网络规则使用。
#[derive(Debug, Default)]
struct ProxyPolicyInputs {
    /// 代理监听的 loopback 端口列表。
    ports: Vec<u16>,
    /// 是否存在代理配置（环境变量形式）。
    has_proxy_config: bool,
    /// 是否允许子进程绑定本地端口。
    allow_local_binding: bool,
    /// Unix domain socket 策略。
    unix_domain_socket_policy: UnixDomainSocketPolicy,
}

/// Unix domain socket 的访问策略。
///
/// 让 allow-all 与 allowlist 两种模式互斥，避免携带被忽略的状态字段。
#[derive(Debug, Clone)]
enum UnixDomainSocketPolicy {
    /// 允许所有 Unix domain socket 访问。
    AllowAll,
    /// 仅允许指定路径列表中的 socket。
    Restricted { allowed: Vec<AbsolutePathBuf> },
}

impl Default for UnixDomainSocketPolicy {
    fn default() -> Self {
        Self::Restricted { allowed: vec![] }
    }
}

/// 单个 Unix socket 路径参数（带索引，用于生成 `-D` 参数键）。
#[derive(Debug, Clone)]
struct UnixSocketPathParam {
    /// 该 socket 在参数列表中的索引。
    index: usize,
    /// 规范化后的 socket 路径。
    path: AbsolutePathBuf,
}

/// 根据 managed network 与可选的 `NetworkProxy` 推导出 [`ProxyPolicyInputs`]。
///
/// - `managed_network`：托管网络代理上下文（优先级最高）
/// - `network`：用户配置的 `NetworkProxy`（用于从环境变量中提取 loopback 端口）
/// - `environment_id`：网络环境标识（多环境代理时使用）
/// - `extra_allow_unix_sockets`：额外允许的 Unix socket 路径
///
/// 返回值：构造好的 `ProxyPolicyInputs`，或环境变量注入失败时的错误字符串。
fn proxy_policy_inputs(
    managed_network: Option<&ManagedNetworkSandboxContext>,
    network: Option<&NetworkProxy>,
    environment_id: Option<&str>,
    extra_allow_unix_sockets: &[AbsolutePathBuf],
) -> Result<ProxyPolicyInputs, String> {
    let extra_allowed = extra_allow_unix_sockets
        .iter()
        .filter_map(|socket_path| normalize_path_for_sandbox(socket_path.as_path()))
        .collect::<Vec<_>>();

    let unix_domain_socket_policy = match network {
        Some(network) if network.dangerously_allow_all_unix_sockets() => {
            UnixDomainSocketPolicy::AllowAll
        }
        Some(network) => {
            let mut allowed = network
                .allow_unix_sockets()
                .iter()
                .filter_map(|socket_path| {
                    match normalize_path_for_sandbox(Path::new(socket_path)) {
                        Some(path) => Some(path),
                        None => {
                            warn!(
                                "ignoring network.allow_unix_sockets entry because it could not be normalized: {socket_path}"
                            );
                            None
                        }
                    }
                })
                .collect::<Vec<_>>();
            allowed.extend(extra_allowed);
            UnixDomainSocketPolicy::Restricted { allowed }
        }
        None => UnixDomainSocketPolicy::Restricted {
            allowed: extra_allowed,
        },
    };
    if let Some(managed_network) = managed_network {
        return Ok(ProxyPolicyInputs {
            ports: managed_network.loopback_ports.clone(),
            has_proxy_config: true,
            allow_local_binding: managed_network.allow_local_binding,
            unix_domain_socket_policy,
        });
    }
    match network {
        Some(network) => {
            let mut env = HashMap::new();
            network
                .apply_to_env_for_optional_environment(&mut env, environment_id)
                .map_err(|err| err.to_string())?;
            Ok(ProxyPolicyInputs {
                ports: proxy_loopback_ports_from_env(&env),
                has_proxy_config: has_proxy_url_env_vars(&env),
                allow_local_binding: network.allow_local_binding(),
                unix_domain_socket_policy,
            })
        }
        None => Ok(ProxyPolicyInputs {
            unix_domain_socket_policy,
            ..Default::default()
        }),
    }
}

/// 将路径规范化为沙箱可用的绝对路径形式。
///
/// 优先尝试 `canonicalize` 以解析符号链接；若失败则退回非 canonical 的绝对路径。
fn normalize_path_for_sandbox(path: &Path) -> Option<AbsolutePathBuf> {
    // `AbsolutePathBuf::from_absolute_path()` 会以当前工作目录为基准解析相对路径，
    // 因此这里显式拒绝相对路径，避免静默接受相对条目。
    if !path.is_absolute() {
        return None;
    }

    let absolute_path = AbsolutePathBuf::from_absolute_path(path).ok()?;
    let normalized_path = absolute_path
        .as_path()
        .canonicalize()
        .ok()
        .and_then(|canonical_path| AbsolutePathBuf::from_absolute_path(canonical_path).ok());
    normalized_path.or(Some(absolute_path))
}

/// 从代理策略中收集去重后的 Unix socket 路径参数列表。
fn unix_socket_path_params(proxy: &ProxyPolicyInputs) -> Vec<UnixSocketPathParam> {
    let mut deduped_paths: BTreeMap<String, AbsolutePathBuf> = BTreeMap::new();
    let UnixDomainSocketPolicy::Restricted { allowed } = &proxy.unix_domain_socket_policy else {
        return vec![];
    };
    for path in allowed {
        deduped_paths
            .entry(path.to_string_lossy().to_string())
            .or_insert_with(|| path.clone());
    }

    deduped_paths
        .into_values()
        .enumerate()
        .map(|(index, path)| UnixSocketPathParam { index, path })
        .collect()
}

/// 生成 Unix socket 路径参数的 `-D` 键名（如 `UNIX_SOCKET_PATH_0`）。
fn unix_socket_path_param_key(index: usize) -> String {
    format!("UNIX_SOCKET_PATH_{index}")
}

/// 将 Unix socket 路径参数转换为 `(key, path)` 二元组列表，供拼装 `-D` 参数使用。
fn unix_socket_dir_params(proxy: &ProxyPolicyInputs) -> Vec<(String, PathBuf)> {
    unix_socket_path_params(proxy)
        .into_iter()
        .map(|param| {
            (
                unix_socket_path_param_key(param.index),
                param.path.into_path_buf(),
            )
        })
        .collect()
}

/// 生成 Unix socket 的 Seatbelt 策略行。
///
/// 返回的字符串若非空则以换行结尾，调用方可直接拼到更大的策略块末尾。
fn unix_socket_policy(proxy: &ProxyPolicyInputs) -> String {
    let socket_params = unix_socket_path_params(proxy);
    let has_unix_socket_access = matches!(
        proxy.unix_domain_socket_policy,
        UnixDomainSocketPolicy::AllowAll
    ) || !socket_params.is_empty();
    if !has_unix_socket_access {
        return String::new();
    }

    let mut policy = String::new();
    policy.push_str("(allow system-socket (socket-domain AF_UNIX))\n");
    if matches!(
        proxy.unix_domain_socket_policy,
        UnixDomainSocketPolicy::AllowAll
    ) {
        // AllowAll 模式保持真正的宽松语义；加路径限定看起来更窄，
        // 但在 macOS 上并没有明确的行为收益。
        policy.push_str("(allow network-bind (local unix-socket))\n");
        policy.push_str("(allow network-outbound (remote unix-socket))\n");
        return policy;
    }

    for param in socket_params {
        let key = unix_socket_path_param_key(param.index);
        // 使用 subpath 限定，使白名单覆盖被授权目录下创建的 socket。
        policy.push_str(&format!(
            "(allow network-bind (local unix-socket (subpath (param \"{key}\"))))\n"
        ));
        policy.push_str(&format!(
            "(allow network-outbound (remote unix-socket (subpath (param \"{key}\"))))\n"
        ));
    }
    policy
}

/// 基于_legacy_ `SandboxPolicy` 生成动态网络策略字符串。
#[cfg_attr(not(test), allow(dead_code))]
fn dynamic_network_policy(
    sandbox_policy: &SandboxPolicy,
    enforce_managed_network: bool,
    proxy: &ProxyPolicyInputs,
) -> String {
    dynamic_network_policy_for_network(
        NetworkSandboxPolicy::from(sandbox_policy),
        enforce_managed_network,
        proxy,
    )
}

/// 基于运行时 `NetworkSandboxPolicy` 生成动态网络策略字符串。
///
/// 决策逻辑：
/// 1. 若存在代理端口/代理配置/enforce_managed_network/受限网络下有 Unix socket 需求，
///    则生成“受限网络策略”：仅允许 loopback 绑定、DNS、代理端口与 Unix socket。
/// 2. 若存在代理配置但无法推断出 loopback 端点，则返回空字符串（fail closed）。
/// 3. 若 enforce_managed_network 但无可用代理端点，同样返回空字符串（fail closed）。
/// 4. 若网络策略启用且无代理配置，返回全网络放行策略。
/// 5. 否则返回空字符串（网络完全禁用）。
fn dynamic_network_policy_for_network(
    network_policy: NetworkSandboxPolicy,
    enforce_managed_network: bool,
    proxy: &ProxyPolicyInputs,
) -> String {
    let has_some_unix_socket_access = match &proxy.unix_domain_socket_policy {
        UnixDomainSocketPolicy::AllowAll => true,
        UnixDomainSocketPolicy::Restricted { allowed } => !allowed.is_empty(),
    };
    let should_use_restricted_network_policy = !proxy.ports.is_empty()
        || proxy.has_proxy_config
        || enforce_managed_network
        || (!network_policy.is_enabled() && has_some_unix_socket_access);
    if should_use_restricted_network_policy {
        let mut policy = String::new();
        if proxy.allow_local_binding {
            policy.push_str("; allow local binding and loopback traffic\n");
            policy.push_str("(allow network-bind (local ip \"*:*\"))\n");
            policy.push_str("(allow network-inbound (local ip \"localhost:*\"))\n");
            policy.push_str("(allow network-outbound (remote ip \"localhost:*\"))\n");
        }
        if proxy.allow_local_binding && !proxy.ports.is_empty() {
            policy.push_str("; allow DNS lookups while application traffic remains proxy-routed\n");
            policy.push_str("(allow network-outbound (remote ip \"*:53\"))\n");
        }
        for port in &proxy.ports {
            policy.push_str(&format!(
                "(allow network-outbound (remote ip \"localhost:{port}\"))\n"
            ));
        }
        let unix_socket_policy = unix_socket_policy(proxy);
        if !unix_socket_policy.is_empty() {
            policy.push_str("; allow unix domain sockets for local IPC\n");
            policy.push_str(&unix_socket_policy);
        }
        return format!("{policy}{MACOS_SEATBELT_NETWORK_POLICY}");
    }

    if proxy.has_proxy_config {
        // 存在代理配置但无法推断出任何有效的 loopback 端点。
        // fail closed，避免在代理强制的会话中静默放宽网络访问。
        return String::new();
    }

    if enforce_managed_network {
        // 托管网络需求已启用但没有可用的代理端点。
        // fail closed，禁止网络访问。
        return String::new();
    }

    if network_policy.is_enabled() {
        // 未配置代理环境变量：保留既有的全网络放行行为。
        let mut policy = String::from("(allow network-outbound)\n(allow network-inbound)\n");
        let unix_socket_policy = unix_socket_policy(proxy);
        if !unix_socket_policy.is_empty() {
            policy.push_str("; allow unix domain sockets for local IPC\n");
            policy.push_str(&unix_socket_policy);
        }
        format!("{policy}{MACOS_SEATBELT_NETWORK_POLICY}")
    } else {
        String::new()
    }
}

/// 返回根目录 `/` 的 `AbsolutePathBuf`，失败则 panic（理论上不会发生）。
fn root_absolute_path() -> AbsolutePathBuf {
    match AbsolutePathBuf::from_absolute_path(Path::new("/")) {
        Ok(path) => path,
        Err(err) => panic!("root path must be absolute: {err}"),
    }
}

/// 描述一个可访问根目录及其排除项与受保护元数据名称。
#[derive(Debug, Clone)]
struct SeatbeltAccessRoot {
    /// 根目录路径。
    root: AbsolutePathBuf,
    /// 需要从可访问范围中排除的子路径列表。
    excluded_subpaths: Vec<AbsolutePathBuf>,
    /// 需要保护的元数据文件名（如 `.codex`），禁止在该根下创建/写入。
    protected_metadata_names: Vec<String>,
}

/// 构造一段 Seatbelt 访问策略（`(allow ...)`）及其对应的 `-D` 参数。
///
/// - `action`：SBPL 动作名，如 `file-read*` 或 `file-write*`
/// - `param_prefix`：`-D` 参数键的前缀（如 `WRITABLE_ROOT`、`READABLE_ROOT`）
/// - `roots`：可访问根列表
///
/// 返回值：(策略字符串, 参数二元组列表)；若 `roots` 为空则返回空策略与空列表。
fn build_seatbelt_access_policy(
    action: &str,
    param_prefix: &str,
    roots: Vec<SeatbeltAccessRoot>,
) -> (String, Vec<(String, PathBuf)>) {
    let mut policy_components = Vec::new();
    let mut params = Vec::new();

    for (index, access_root) in roots.into_iter().enumerate() {
        let root =
            normalize_path_for_sandbox(access_root.root.as_path()).unwrap_or(access_root.root);
        let root_param = format!("{param_prefix}_{index}");
        params.push((root_param.clone(), root.clone().into_path_buf()));

        if access_root.excluded_subpaths.is_empty()
            && access_root.protected_metadata_names.is_empty()
        {
            policy_components.push(format!("(subpath (param \"{root_param}\"))"));
            continue;
        }

        let mut require_parts = vec![format!("(subpath (param \"{root_param}\"))")];
        for (excluded_index, excluded_subpath) in
            access_root.excluded_subpaths.into_iter().enumerate()
        {
            let excluded_subpath =
                normalize_path_for_sandbox(excluded_subpath.as_path()).unwrap_or(excluded_subpath);
            let excluded_param = format!("{param_prefix}_{index}_EXCLUDED_{excluded_index}");
            params.push((excluded_param.clone(), excluded_subpath.into_path_buf()));
            // 同时排除精确路径与其下的所有内容。
            // 仅用 `subpath` 会留下一道缝隙：首次创建受保护目录本身（如 `mkdir .codex`）
            // 不会被拒绝，因此这里额外加上 `literal` 限定。
            require_parts.push(format!(
                "(require-not (literal (param \"{excluded_param}\")))"
            ));
            require_parts.push(format!(
                "(require-not (subpath (param \"{excluded_param}\")))"
            ));
        }
        for metadata_name in access_root.protected_metadata_names {
            let regex =
                seatbelt_protected_metadata_name_regex(&root, &metadata_name).replace('"', "\\\"");
            require_parts.push(format!(r#"(require-not (regex #"{regex}"))"#));
        }
        policy_components.push(format!("(require-all {} )", require_parts.join(" ")));
    }

    if policy_components.is_empty() {
        (String::new(), Vec::new())
    } else {
        (
            format!("(allow {action}\n{}\n)", policy_components.join(" ")),
            params,
        )
    }
}

/// 生成匹配指定根目录下受保护元数据名称的 Seatbelt 正则。
///
/// 例如 root 为 `/Users/foo`、name 为 `.codex` 时，返回 `^/Users/foo/\.codex(/.*)?$`，
/// 匹配 `/Users/foo/.codex` 及其所有子路径。
fn seatbelt_protected_metadata_name_regex(root: &AbsolutePathBuf, name: &str) -> String {
    let mut root = root.to_string_lossy().to_string();
    while root.len() > 1 && root.ends_with('/') {
        root.pop();
    }
    let root = regex_lite::escape(&root);
    let name = regex_lite::escape(name);
    if root == "/" {
        format!(r#"^/{name}(/.*)?$"#)
    } else {
        format!(r#"^{root}/{name}(/.*)?$"#)
    }
}

/// 计算某个可写根下需要保护的元数据名称列表。
///
/// 先继承 `writable_root` 自带的 `protected_metadata_names`，再扫描
/// `PROTECTED_METADATA_PATH_NAMES` 中那些在该可写根下不可写的名称并追加。
fn protected_metadata_names_for_writable_root(
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    writable_root: &WritableRoot,
    cwd: &Path,
) -> Vec<String> {
    let mut names = writable_root.protected_metadata_names.clone();
    for name in PROTECTED_METADATA_PATH_NAMES {
        if names.iter().any(|existing| existing == name) {
            continue;
        }
        let path = writable_root.root.join(*name);
        if !file_system_sandbox_policy.can_write_path_with_cwd(path.as_path(), cwd) {
            names.push((*name).to_string());
        }
    }
    names
}

/// 构造针对 unreadable glob 的 Seatbelt deny 策略字符串。
///
/// Seatbelt 不能直接理解文件系统策略的 glob 语法，因此将每个 unreadable 模式
/// 转换为 anchored regex deny 规则，同时应用到 read 与 unlink-style write 上，
/// 避免被拒绝的路径通过破坏性文件操作被探测。
fn build_seatbelt_unreadable_glob_policy(
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    cwd: &Path,
) -> String {
    let unreadable_globs = file_system_sandbox_policy.get_unreadable_globs_with_cwd(cwd);
    if unreadable_globs.is_empty() {
        return String::new();
    }

    let mut policy_components = Vec::new();
    for pattern in unreadable_globs {
        let mut regexes = BTreeSet::new();
        if let Some(regex) = seatbelt_regex_for_unreadable_glob(&pattern) {
            regexes.insert(regex);
        }
        if let Some(pattern) = canonicalize_glob_static_prefix_for_sandbox(&pattern)
            && let Some(regex) = seatbelt_regex_for_unreadable_glob(&pattern)
        {
            regexes.insert(regex);
        }
        for regex in regexes {
            let regex = regex.replace('"', "\\\"");
            policy_components.push(format!(r#"(deny file-read* (regex #"{regex}"))"#));
            policy_components.push(format!(r#"(deny file-write-unlink (regex #"{regex}"))"#));
        }
    }

    policy_components.join("\n")
}

/// 将 glob 模式的静态前缀规范化（解析符号链接），返回规范化后的完整模式。
///
/// 若模式不含 glob 元字符，则返回规范化后的精确路径；若静态前缀为空则返回 `None`。
/// 仅在规范化后与原模式不同时返回 `Some`，避免重复处理。
fn canonicalize_glob_static_prefix_for_sandbox(pattern: &str) -> Option<String> {
    let first_glob_index = pattern
        .char_indices()
        .find_map(|(index, ch)| matches!(ch, '*' | '?' | '[' | ']').then_some(index));
    let Some(first_glob_index) = first_glob_index else {
        return normalize_path_for_sandbox(Path::new(pattern))
            .map(|path| path.to_string_lossy().to_string());
    };

    let static_prefix = &pattern[..first_glob_index];
    let prefix_end = if static_prefix.ends_with('/') {
        static_prefix.len() - 1
    } else {
        static_prefix.rfind('/').unwrap_or(0)
    };
    if prefix_end == 0 {
        return None;
    }

    let root = normalize_path_for_sandbox(Path::new(&pattern[..prefix_end]))?;
    let root = root.to_string_lossy();
    let suffix = &pattern[prefix_end..];
    let normalized_pattern = format!("{root}{suffix}");
    (normalized_pattern != pattern).then_some(normalized_pattern)
}

/// 将 git 风格的 glob 模式转换为 Seatbelt 可用的 anchored regex。
///
/// 转换规则：
/// - `*` 与 `?` 仅在单个路径组件内匹配
/// - `**/` 可消费零个或多个路径组件
/// - 闭合的字符类 `[...]` 保留为 regex 字符类
/// - 不含 glob 元字符的模式视为精确路径并匹配其子树
fn seatbelt_regex_for_unreadable_glob(pattern: &str) -> Option<String> {
    if pattern.is_empty() {
        return None;
    }

    let mut regex = String::from("^");
    let mut chars = pattern.chars().collect::<VecDeque<_>>();
    let mut saw_glob = false;

    while let Some(ch) = chars.pop_front() {
        match ch {
            '*' => {
                saw_glob = true;
                if chars.front() == Some(&'*') {
                    chars.pop_front();
                    if chars.front() == Some(&'/') {
                        chars.pop_front();
                        regex.push_str("(.*/)?");
                    } else {
                        regex.push_str(".*");
                    }
                } else {
                    regex.push_str("[^/]*");
                }
            }
            '?' => {
                saw_glob = true;
                regex.push_str("[^/]");
            }
            '[' => {
                saw_glob = true;
                let mut class = Vec::new();
                let mut closed = false;
                while let Some(class_ch) = chars.pop_front() {
                    if class_ch == ']' {
                        closed = true;
                        break;
                    }
                    class.push(class_ch);
                }
                if !closed {
                    regex.push_str("\\[");
                    for class_ch in class.into_iter().rev() {
                        chars.push_front(class_ch);
                    }
                    continue;
                }

                regex.push('[');
                let mut class_chars = class.into_iter();
                if let Some(first) = class_chars.next() {
                    match first {
                        '!' => regex.push('^'),
                        '^' => regex.push_str("\\^"),
                        _ => regex.push(first),
                    }
                }
                for class_ch in class_chars {
                    match class_ch {
                        '\\' => regex.push_str("\\\\"),
                        _ => regex.push(class_ch),
                    }
                }
                regex.push(']');
            }
            ']' => {
                saw_glob = true;
                regex.push_str("\\]");
            }
            _ => regex.push_str(&regex_lite::escape(&ch.to_string())),
        }
    }

    if !saw_glob {
        regex.push_str("(/.*)?");
    }
    regex.push('$');
    Some(regex)
}

/// 基于 legacy `SandboxPolicy` 构造 Seatbelt 命令参数（兼容入口）。
///
/// 内部先将 legacy 策略转换为 `FileSystemSandboxPolicy`，再委托给
/// [`create_seatbelt_command_args`]。
#[cfg_attr(not(test), allow(dead_code))]
fn create_seatbelt_command_args_for_legacy_policy(
    command: Vec<String>,
    sandbox_policy: &SandboxPolicy,
    sandbox_policy_cwd: &Path,
    enforce_managed_network: bool,
    network: Option<&NetworkProxy>,
) -> Result<Vec<String>, String> {
    let file_system_sandbox_policy = FileSystemSandboxPolicy::from_legacy_sandbox_policy_for_cwd(
        sandbox_policy,
        sandbox_policy_cwd,
    );
    create_seatbelt_command_args(CreateSeatbeltCommandArgsParams {
        command,
        file_system_sandbox_policy: &file_system_sandbox_policy,
        network_sandbox_policy: NetworkSandboxPolicy::from(sandbox_policy),
        sandbox_policy_cwd,
        enforce_managed_network,
        managed_network: None,
        environment_id: None,
        network,
        extra_allow_unix_sockets: &[],
    })
}

/// [`create_seatbelt_command_args`] 的入参集合。
#[derive(Debug)]
pub struct CreateSeatbeltCommandArgsParams<'a> {
    /// 待沙箱化的命令行（程序 + 参数）。
    pub command: Vec<String>,
    /// 文件系统沙箱策略引用。
    pub file_system_sandbox_policy: &'a FileSystemSandboxPolicy,
    /// 网络沙箱策略。
    pub network_sandbox_policy: NetworkSandboxPolicy,
    /// 沙箱策略 cwd。
    pub sandbox_policy_cwd: &'a Path,
    /// 是否强制启用 managed network。
    pub enforce_managed_network: bool,
    /// 托管网络代理上下文（可选）。
    pub managed_network: Option<&'a ManagedNetworkSandboxContext>,
    /// 网络环境标识（可选）。
    pub environment_id: Option<&'a str>,
    /// 用户配置的网络代理（可选）。
    pub network: Option<&'a NetworkProxy>,
    /// 额外允许的 Unix socket 路径列表。
    pub extra_allow_unix_sockets: &'a [AbsolutePathBuf],
}

/// 根据权限策略与代理配置，构造完整的 `sandbox-exec` 参数列表。
///
/// 返回的参数顺序为：`-p <policy> -D<key>=<value> ... -- <command>...`，
/// 可直接拼到 `MACOS_PATH_TO_SEATBELT_EXECUTABLE` 之后作为完整命令行。
pub fn create_seatbelt_command_args(
    args: CreateSeatbeltCommandArgsParams<'_>,
) -> Result<Vec<String>, String> {
    let CreateSeatbeltCommandArgsParams {
        command,
        file_system_sandbox_policy,
        network_sandbox_policy,
        sandbox_policy_cwd,
        enforce_managed_network,
        managed_network,
        environment_id,
        network,
        extra_allow_unix_sockets,
    } = args;

    let unreadable_roots =
        file_system_sandbox_policy.get_unreadable_roots_with_cwd(sandbox_policy_cwd);
    let (file_write_policy, file_write_dir_params) =
        if file_system_sandbox_policy.has_full_disk_write_access() {
            if unreadable_roots.is_empty() {
                // 据说这比 `(allow file-write*)` 更宽松。
                (
                    r#"(allow file-write* (regex #"^/"))"#.to_string(),
                    Vec::new(),
                )
            } else {
                build_seatbelt_access_policy(
                    "file-write*",
                    "WRITABLE_ROOT",
                    vec![SeatbeltAccessRoot {
                        root: root_absolute_path(),
                        excluded_subpaths: unreadable_roots.clone(),
                        protected_metadata_names: Vec::new(),
                    }],
                )
            }
        } else {
            build_seatbelt_access_policy(
                "file-write*",
                "WRITABLE_ROOT",
                file_system_sandbox_policy
                    .get_writable_roots_with_cwd(sandbox_policy_cwd)
                    .into_iter()
                    .map(|root| SeatbeltAccessRoot {
                        protected_metadata_names: protected_metadata_names_for_writable_root(
                            file_system_sandbox_policy,
                            &root,
                            sandbox_policy_cwd,
                        ),
                        root: root.root,
                        excluded_subpaths: root.read_only_subpaths,
                    })
                    .collect(),
            )
        };

    let (file_read_policy, file_read_dir_params) =
        if file_system_sandbox_policy.has_full_disk_read_access() {
            if unreadable_roots.is_empty() {
                (
                    "; allow read-only file operations\n(allow file-read*)".to_string(),
                    Vec::new(),
                )
            } else {
                let (policy, params) = build_seatbelt_access_policy(
                    "file-read*",
                    "READABLE_ROOT",
                    vec![SeatbeltAccessRoot {
                        root: root_absolute_path(),
                        excluded_subpaths: unreadable_roots,
                        protected_metadata_names: Vec::new(),
                    }],
                );
                (
                    format!("; allow read-only file operations\n{policy}"),
                    params,
                )
            }
        } else {
            let (policy, params) = build_seatbelt_access_policy(
                "file-read*",
                "READABLE_ROOT",
                file_system_sandbox_policy
                    .get_readable_roots_with_cwd(sandbox_policy_cwd)
                    .into_iter()
                    .map(|root| SeatbeltAccessRoot {
                        excluded_subpaths: unreadable_roots
                            .iter()
                            .filter(|path| path.as_path().starts_with(root.as_path()))
                            .cloned()
                            .collect(),
                        protected_metadata_names: Vec::new(),
                        root,
                    })
                    .collect(),
            );
            if policy.is_empty() {
                (String::new(), params)
            } else {
                (
                    format!("; allow read-only file operations\n{policy}"),
                    params,
                )
            }
        };

    let proxy = proxy_policy_inputs(
        managed_network,
        network,
        environment_id,
        extra_allow_unix_sockets,
    )?;
    let network_policy =
        dynamic_network_policy_for_network(network_sandbox_policy, enforce_managed_network, &proxy);

    let include_platform_defaults = file_system_sandbox_policy.include_platform_defaults();
    let deny_read_policy =
        build_seatbelt_unreadable_glob_policy(file_system_sandbox_policy, sandbox_policy_cwd);
    let mut policy_sections = vec![
        MACOS_SEATBELT_BASE_POLICY.to_string(),
        file_read_policy,
        file_write_policy,
        deny_read_policy,
        network_policy,
    ];
    if include_platform_defaults {
        policy_sections.push(MACOS_RESTRICTED_READ_ONLY_PLATFORM_DEFAULTS.to_string());
    }

    let full_policy = policy_sections.join("\n");

    let dir_params = [
        file_read_dir_params,
        file_write_dir_params,
        unix_socket_dir_params(&proxy),
    ]
    .concat();

    let mut seatbelt_args: Vec<String> = vec!["-p".to_string(), full_policy];
    let definition_args = dir_params
        .into_iter()
        .map(|(key, value): (String, PathBuf)| {
            format!("-D{key}={value}", value = value.to_string_lossy())
        });
    seatbelt_args.extend(definition_args);
    seatbelt_args.push("--".to_string());
    seatbelt_args.extend(command);
    Ok(seatbelt_args)
}

#[cfg(test)]
#[path = "seatbelt_tests.rs"]
mod tests;
