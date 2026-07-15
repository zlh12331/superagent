//! 跨平台沙箱管理器：选择、构造并变换宿主原生沙箱命令。
//!
//! 本模块是 Codex 沙箱体系的编排中枢，负责：
//! - 根据当前平台与权限策略选择具体的沙箱实现（macOS Seatbelt / Linux Landlock+Bubblewrap
//!   / Windows restricted token / None）
//! - 将上层传入的 [`SandboxCommand`] 与权限配置变换为可执行的 [`SandboxExecRequest`]
//! - 提供 legacy `SandboxPolicy` 兼容视图，便于既有调用方平滑迁移
//!
//! 设计上严格遵循“在执行边界之前保留 `PathUri`、之后才转 native 路径”的原则，
//! 以便 transport/orchestration 层不受平台细节污染。

#[cfg(target_os = "linux")]
use crate::bwrap::WSL1_BWRAP_WARNING;
#[cfg(target_os = "linux")]
use crate::bwrap::is_wsl1;
use crate::landlock::CODEX_LINUX_SANDBOX_ARG0;
use crate::landlock::allow_network_for_proxy;
use crate::landlock::create_linux_sandbox_command_args_for_permission_profile;
use crate::policy_transforms::effective_permission_profile;
use crate::policy_transforms::should_require_platform_sandbox;
#[cfg(target_os = "windows")]
use crate::resolve_windows_elevated_filesystem_overrides;
#[cfg(target_os = "windows")]
use crate::resolve_windows_restricted_token_filesystem_overrides;
#[cfg(target_os = "windows")]
use crate::windows_sandbox_uses_elevated_backend;
use codex_network_proxy::ManagedNetworkSandboxContext;
use codex_network_proxy::NetworkProxy;
use codex_protocol::config_types::WindowsSandboxLevel;
use codex_protocol::models::AdditionalPermissionProfile;
use codex_protocol::models::PermissionProfile;
use codex_protocol::permissions::FileSystemSandboxPolicy;
use codex_protocol::permissions::NetworkSandboxPolicy;
use codex_protocol::protocol::SandboxPolicy;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_path_uri::PathUri;
use std::collections::HashMap;
use std::ffi::OsString;
use std::io;
use std::path::Path;

/// Windows 沙箱 wrapper 启动时需要从父进程继承的环境变量白名单。
#[cfg(target_os = "windows")]
const WINDOWS_SANDBOX_WRAPPER_SETUP_ENV_ALLOWLIST: &[&str] = &["USERNAME", "USERPROFILE"];

/// 当前宿主支持的沙箱实现类型。
///
/// 由 [`get_platform_sandbox`] 在编译期根据 target_os 推断，运行期再结合
/// `windows_sandbox_level` 等开关最终确定。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxType {
    /// 不使用任何沙箱；命令直接在宿主环境中执行。
    None,
    /// macOS 下的 Seatbelt（sandbox-exec）实现。
    MacosSeatbelt,
    /// Linux 下的 Landlock + seccomp（可选 Bubblewrap）实现。
    LinuxSeccomp,
    /// Windows 下的 restricted token / elevated 沙箱实现。
    WindowsRestrictedToken,
}

impl SandboxType {
    /// 返回用于埋点上报的短字符串标识。
    pub fn as_metric_tag(self) -> &'static str {
        match self {
            SandboxType::None => "none",
            SandboxType::MacosSeatbelt => "seatbelt",
            SandboxType::LinuxSeccomp => "seccomp",
            SandboxType::WindowsRestrictedToken => "windows_sandbox",
        }
    }
}

/// 调用方对“是否启用沙箱”的偏好。
///
/// 由 [`SandboxManager::should_sandbox`] 解释：`Require` 强制启用，`Forbid` 强制禁用，
/// `Auto` 则根据权限策略与网络需求自动判断。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxablePreference {
    /// 自动判断：根据权限策略推导是否需要沙箱。
    Auto,
    /// 强制启用沙箱，即便权限策略本身并不要求。
    Require,
    /// 强制禁用沙箱。
    Forbid,
}

/// 根据当前编译目标平台返回原生沙箱类型。
///
/// - macOS 总是返回 `Some(MacosSeatbelt)`
/// - Linux 总是返回 `Some(LinuxSeccomp)`
/// - Windows 仅在 `windows_sandbox_enabled` 为真时返回
///   `Some(WindowsRestrictedToken)`，否则返回 `None`
/// - 其他平台一律返回 `None`
pub fn get_platform_sandbox(windows_sandbox_enabled: bool) -> Option<SandboxType> {
    if cfg!(target_os = "macos") {
        Some(SandboxType::MacosSeatbelt)
    } else if cfg!(target_os = "linux") {
        Some(SandboxType::LinuxSeccomp)
    } else if cfg!(target_os = "windows") {
        if windows_sandbox_enabled {
            Some(SandboxType::WindowsRestrictedToken)
        } else {
            None
        }
    } else {
        None
    }
}

/// 在指定权限 profile 的基础上额外追加 managed MITM CA 证书的可读根。
///
/// 当 Codex 启用了托管网络代理（managed network proxy）时，沙箱需要能读取
/// 该代理使用的根证书 bundle，否则 TLS 握手会失败。本函数将此 bundle 路径
/// 注入到 file system sandbox policy 的可读根列表中。
///
/// - `permission_profile`：原始权限 profile
/// - `managed_mitm_ca_trust_bundle_path`：MITM CA bundle 路径；为 `None` 时直接返回原 profile
/// - `sandbox_policy_cwd`：用于解析相对路径的沙箱策略 cwd
pub fn with_managed_mitm_ca_readable_root(
    permission_profile: PermissionProfile,
    managed_mitm_ca_trust_bundle_path: Option<&AbsolutePathBuf>,
    sandbox_policy_cwd: &Path,
) -> PermissionProfile {
    let Some(managed_mitm_ca_trust_bundle_path) = managed_mitm_ca_trust_bundle_path else {
        return permission_profile;
    };
    let (file_system_sandbox_policy, network_sandbox_policy) =
        permission_profile.to_runtime_permissions();
    let file_system_sandbox_policy = file_system_sandbox_policy.with_additional_readable_roots(
        sandbox_policy_cwd,
        std::slice::from_ref(managed_mitm_ca_trust_bundle_path),
    );
    PermissionProfile::from_runtime_permissions_with_enforcement(
        permission_profile.enforcement(),
        &file_system_sandbox_policy,
        network_sandbox_policy,
    )
}

/// 上层传入的、尚未经过沙箱变换的原始命令描述。
///
/// 该结构在 transport 层与 sandbox manager 之间流转，cwd 仍以 [`PathUri`]
/// 形式保留，避免过早绑定到 native 路径。
#[derive(Debug)]
pub struct SandboxCommand {
    /// 待执行的可执行程序（可能是解释器或 wrapper）。
    pub program: OsString,
    /// 传给程序的命令行参数。
    pub args: Vec<String>,
    /// 命令的 cwd，仍以 `PathUri` 表示。
    pub cwd: PathUri,
    /// 启动子进程时需要注入的环境变量。
    pub env: HashMap<String, String>,
    /// 托管网络代理上下文（仅在启用了 managed network 时存在）。
    pub managed_network: Option<ManagedNetworkSandboxContext>,
    /// 该命令所需的额外权限 profile（叠加到基础 profile 之上）。
    pub additional_permissions: Option<AdditionalPermissionProfile>,
}

/// 由 [`SandboxManager::transform`] 校验 URI 输入之后生成的宿主原生启动请求。
///
/// 该结构只能在执行边界（exec-server 或 app-server 等价位置）构造；
/// orchestration 与 transport 代码应保留 [`PathUri`] 值，直到创建本请求时才
/// 转换为 native 路径。
#[derive(Debug)]
pub struct SandboxExecRequest {
    /// 最终要执行的命令行（程序 + 参数，可能已被沙箱 wrapper 包裹）。
    pub command: Vec<String>,
    /// 命令的 cwd（仍以 `PathUri` 表示，便于日志脱敏与跨平台处理）。
    pub cwd: PathUri,
    /// 沙箱策略使用的 cwd（可能与 `cwd` 不同）。
    pub sandbox_policy_cwd: PathUri,
    /// 子进程环境变量。
    pub env: HashMap<String, String>,
    /// 网络代理配置（可选）。
    pub network: Option<NetworkProxy>,
    /// 网络环境标识（用于多环境区分）。
    pub network_environment_id: Option<String>,
    /// 最终采用的沙箱类型。
    pub sandbox: SandboxType,
    /// Windows 沙箱等级（仅 Windows 平台使用）。
    pub windows_sandbox_level: WindowsSandboxLevel,
    /// 是否使用独立桌面（仅 Windows elevated 沙箱使用）。
    pub windows_sandbox_private_desktop: bool,
    /// 生效的权限 profile。
    pub permission_profile: PermissionProfile,
    /// 生效的文件系统沙箱策略。
    pub file_system_sandbox_policy: FileSystemSandboxPolicy,
    /// 生效的网络沙箱策略。
    pub network_sandbox_policy: NetworkSandboxPolicy,
    /// 可选的 arg0 覆盖（用于沙箱可执行文件伪装自身名字）。
    pub arg0: Option<String>,
}

/// 沙箱变换的入参集合。
///
/// 将多个可选字段打包在一起，使调用点保持自文档化。
pub struct SandboxTransformRequest<'a> {
    /// 待变换的原始命令。
    pub command: SandboxCommand,
    /// 基础权限 profile 的引用。
    pub permissions: &'a PermissionProfile,
    /// 目标沙箱类型。
    pub sandbox: SandboxType,
    /// 是否强制启用 managed network（即便权限策略未要求）。
    pub enforce_managed_network: bool,
    /// 网络环境标识（可选）。
    pub environment_id: Option<&'a str>,
    // TODO(viyatb): 评估将此字段改为 Option<Arc<NetworkProxy>>，
    // 以便在 runtime/sandbox 流水线中显式表达共享所有权。
    /// 网络代理引用（可选）。
    pub network: Option<&'a NetworkProxy>,
    /// 沙箱策略 cwd 的引用。
    pub sandbox_policy_cwd: &'a PathUri,
    /// codex-linux-sandbox 可执行文件路径（仅 Linux 使用）。
    pub codex_linux_sandbox_exe: Option<&'a Path>,
    /// 是否使用 legacy Landlock 实现。
    pub use_legacy_landlock: bool,
    /// Windows 沙箱等级。
    pub windows_sandbox_level: WindowsSandboxLevel,
    /// 是否使用独立桌面（Windows）。
    pub windows_sandbox_private_desktop: bool,
}

/// 直接 spawn 场景下的沙箱变换入参。
///
/// Direct-spawn 调用方不会在后续运行平台专属 launcher，因此返回的命令必须
/// 内联编码所需的沙箱 wrapper（例如 Windows 的 restricted token wrapper）。
pub struct SandboxDirectSpawnTransformRequest<'a> {
    /// 基础变换请求。
    pub transform: SandboxTransformRequest<'a>,
    /// 工作区根目录列表（用于沙箱可写范围授权）。
    pub workspace_roots: &'a [AbsolutePathBuf],
    /// Windows 沙箱代理设置模式。
    pub windows_sandbox_proxy_settings_mode: codex_windows_sandbox::WindowsSandboxProxySettingsMode,
}

// TODO(anp): 待本模块的 PathUri 迁移完成后，重新审视此 preparation 类型。
// 内部中间结构：在 native 路径解析完毕、但尚未拼装最终命令前的“待执行”状态。
struct PendingSandboxedExecRequest {
    /// 命令 cwd 的 native 绝对路径。
    native_command_cwd: AbsolutePathBuf,
    /// 沙箱策略 cwd 的 native 绝对路径。
    native_sandbox_policy_cwd: AbsolutePathBuf,
    /// 已合并额外权限与 MITM CA 可读根后的生效权限 profile。
    effective_permission_profile: PermissionProfile,
    /// 由生效 profile 派生的文件系统策略。
    effective_file_system_policy: FileSystemSandboxPolicy,
    /// 由生效 profile 派生的网络策略。
    effective_network_policy: NetworkSandboxPolicy,
}

impl PendingSandboxedExecRequest {
    fn new(
        command_cwd: &PathUri,
        sandbox_policy_cwd: &PathUri,
        effective_permission_profile: PermissionProfile,
        managed_mitm_ca_trust_bundle_path: Option<&AbsolutePathBuf>,
    ) -> Result<Self, SandboxTransformError> {
        // TODO(anp): 将 PathUri → native 路径的转换下沉到各平台沙箱实现中，
        // 让本模块保持纯逻辑编排。
        let native_command_cwd = command_cwd.to_abs_path().map_err(|source| {
            SandboxTransformError::InvalidCommandCwd {
                cwd: command_cwd.clone(),
                source,
            }
        })?;
        let native_sandbox_policy_cwd = sandbox_policy_cwd.to_abs_path().map_err(|source| {
            SandboxTransformError::InvalidSandboxPolicyCwd {
                cwd: sandbox_policy_cwd.clone(),
                source,
            }
        })?;
        let effective_permission_profile = with_managed_mitm_ca_readable_root(
            effective_permission_profile,
            managed_mitm_ca_trust_bundle_path,
            native_sandbox_policy_cwd.as_path(),
        );
        let (effective_file_system_policy, effective_network_policy) =
            effective_permission_profile.to_runtime_permissions();
        Ok(Self {
            native_command_cwd,
            native_sandbox_policy_cwd,
            effective_permission_profile,
            effective_file_system_policy,
            effective_network_policy,
        })
    }
}

/// 沙箱变换过程中可能发生的错误。
#[derive(Debug)]
pub enum SandboxTransformError {
    /// 命令 cwd URI 无法在当前宿主解析为 native 路径。
    InvalidCommandCwd {
        /// 原始 cwd URI。
        cwd: PathUri,
        /// 底层 IO 错误。
        source: io::Error,
    },
    /// 沙箱策略 cwd URI 无法在当前宿主解析为 native 路径。
    InvalidSandboxPolicyCwd {
        /// 原始 cwd URI。
        cwd: PathUri,
        /// 底层 IO 错误。
        source: io::Error,
    },
    /// 未提供 codex-linux-sandbox 可执行文件路径（仅 Linux）。
    MissingLinuxSandboxExecutable,
    /// 准备环境网络代理失败。
    EnvironmentNetworkProxy(String),
    /// 当前为 WSL1 内核，不支持 Bubblewrap（仅 Linux）。
    #[cfg(target_os = "linux")]
    Wsl1UnsupportedForBubblewrap,
    /// 当前平台非 macOS，无法使用 Seatbelt 沙箱。
    #[cfg(not(target_os = "macos"))]
    SeatbeltUnavailable,
    /// Windows 沙箱准备阶段失败。
    #[cfg(target_os = "windows")]
    WindowsSandboxPreparation(String),
}

impl std::fmt::Display for SandboxTransformError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidCommandCwd { cwd, source } => {
                write!(
                    f,
                    "command cwd URI `{cwd}` is not valid on this host: {source}"
                )
            }
            Self::InvalidSandboxPolicyCwd { cwd, source } => write!(
                f,
                "sandbox policy cwd URI `{cwd}` is not valid on this host: {source}"
            ),
            Self::MissingLinuxSandboxExecutable => {
                write!(f, "missing codex-linux-sandbox executable path")
            }
            Self::EnvironmentNetworkProxy(err) => {
                write!(f, "failed to prepare environment network proxy: {err}")
            }
            #[cfg(target_os = "linux")]
            Self::Wsl1UnsupportedForBubblewrap => write!(f, "{WSL1_BWRAP_WARNING}"),
            #[cfg(not(target_os = "macos"))]
            Self::SeatbeltUnavailable => write!(f, "seatbelt sandbox is only available on macOS"),
            #[cfg(target_os = "windows")]
            Self::WindowsSandboxPreparation(err) => {
                write!(f, "failed to prepare windows sandbox wrapper: {err}")
            }
        }
    }
}

impl std::error::Error for SandboxTransformError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::InvalidCommandCwd { source, .. }
            | Self::InvalidSandboxPolicyCwd { source, .. } => Some(source),
            Self::MissingLinuxSandboxExecutable => None,
            Self::EnvironmentNetworkProxy(_) => None,
            #[cfg(target_os = "linux")]
            Self::Wsl1UnsupportedForBubblewrap => None,
            #[cfg(not(target_os = "macos"))]
            Self::SeatbeltUnavailable => None,
            #[cfg(target_os = "windows")]
            Self::WindowsSandboxPreparation(_) => None,
        }
    }
}

/// 沙箱管理器：负责根据平台与权限策略选择并构造具体的沙箱命令。
///
/// 该结构是无状态的，所有决策都基于传入参数，便于在多处共享单例。
#[derive(Default)]
pub struct SandboxManager;

impl SandboxManager {
    /// 构造一个新的沙箱管理器。
    pub fn new() -> Self {
        Self
    }

    /// 根据权限策略与偏好选择初始沙箱类型。
    ///
    /// - `file_system_policy`：文件系统沙箱策略
    /// - `network_policy`：网络沙箱策略
    /// - `pref`：调用方偏好（Auto / Require / Forbid）
    /// - `windows_sandbox_level`：Windows 沙箱等级
    /// - `has_managed_network_requirements`：是否存在托管网络需求
    ///
    /// 返回值：若需要沙箱则返回平台原生类型，否则返回 `SandboxType::None`。
    pub fn select_initial(
        &self,
        file_system_policy: &FileSystemSandboxPolicy,
        network_policy: NetworkSandboxPolicy,
        pref: SandboxablePreference,
        windows_sandbox_level: WindowsSandboxLevel,
        has_managed_network_requirements: bool,
    ) -> SandboxType {
        if self.should_sandbox(
            file_system_policy,
            network_policy,
            pref,
            has_managed_network_requirements,
        ) {
            get_platform_sandbox(windows_sandbox_level != WindowsSandboxLevel::Disabled)
                .unwrap_or(SandboxType::None)
        } else {
            SandboxType::None
        }
    }

    /// 判断当前请求是否需要沙箱，与宿主是否能提供具体实现无关。
    ///
    /// 决策规则：
    /// - `Forbid` → 一律不沙箱
    /// - `Require` → 一律沙箱
    /// - `Auto` → 交由 [`should_require_platform_sandbox`] 根据权限策略推导
    pub fn should_sandbox(
        &self,
        file_system_policy: &FileSystemSandboxPolicy,
        network_policy: NetworkSandboxPolicy,
        pref: SandboxablePreference,
        has_managed_network_requirements: bool,
    ) -> bool {
        match pref {
            SandboxablePreference::Forbid => false,
            SandboxablePreference::Require => true,
            SandboxablePreference::Auto => should_require_platform_sandbox(
                file_system_policy,
                network_policy,
                has_managed_network_requirements,
            ),
        }
    }

    /// 将一个 [`SandboxTransformRequest`] 变换为可直接执行的 [`SandboxExecRequest`]。
    ///
    /// 流程概要：
    /// 1. 解析额外权限与 MITM CA 可读根，得到生效权限 profile
    /// 2. 将 `PathUri` 转为 native 路径，构造 `PendingSandboxedExecRequest`
    /// 3. 按目标沙箱类型拼装 argv（Seatbelt / Linux / Windows 各自分支）
    /// 4. 对未沙箱的 exec-server 请求，保留 base profile 以便下游使用
    pub fn transform(
        &self,
        request: SandboxTransformRequest<'_>,
    ) -> Result<SandboxExecRequest, SandboxTransformError> {
        let SandboxTransformRequest {
            mut command,
            permissions,
            sandbox,
            enforce_managed_network,
            environment_id,
            network,
            sandbox_policy_cwd,
            codex_linux_sandbox_exe,
            use_legacy_landlock,
            windows_sandbox_level,
            windows_sandbox_private_desktop,
        } = request;
        #[cfg(target_os = "macos")]
        let managed_network = command.managed_network.as_ref();
        let additional_permissions = command.additional_permissions.take();
        let managed_mitm_ca_trust_bundle_path =
            network.and_then(NetworkProxy::managed_mitm_ca_trust_bundle_path);
        let base_effective_permission_profile =
            effective_permission_profile(permissions, additional_permissions.as_ref());
        let pending_sandboxed_request = PendingSandboxedExecRequest::new(
            &command.cwd,
            sandbox_policy_cwd,
            base_effective_permission_profile.clone(),
            managed_mitm_ca_trust_bundle_path.as_ref(),
        );
        let (base_file_system_policy, base_network_policy) =
            base_effective_permission_profile.to_runtime_permissions();
        let mut argv = Vec::with_capacity(1 + command.args.len());
        argv.push(command.program);
        argv.extend(command.args.into_iter().map(OsString::from));

        let (argv, arg0_override, pending_sandboxed_request) = match sandbox {
            SandboxType::None => (os_argv_to_strings(argv), None, None),
            #[cfg(target_os = "macos")]
            SandboxType::MacosSeatbelt => {
                use crate::seatbelt::CreateSeatbeltCommandArgsParams;
                use crate::seatbelt::MACOS_PATH_TO_SEATBELT_EXECUTABLE;
                use crate::seatbelt::create_seatbelt_command_args;

                let pending = pending_sandboxed_request?;
                let mut args = create_seatbelt_command_args(CreateSeatbeltCommandArgsParams {
                    command: os_argv_to_strings(argv),
                    file_system_sandbox_policy: &pending.effective_file_system_policy,
                    network_sandbox_policy: pending.effective_network_policy,
                    sandbox_policy_cwd: pending.native_sandbox_policy_cwd.as_path(),
                    enforce_managed_network,
                    managed_network,
                    environment_id,
                    network,
                    extra_allow_unix_sockets: &[],
                })
                .map_err(SandboxTransformError::EnvironmentNetworkProxy)?;
                let mut full_command = Vec::with_capacity(1 + args.len());
                full_command.push(MACOS_PATH_TO_SEATBELT_EXECUTABLE.to_string());
                full_command.append(&mut args);
                (full_command, None, Some(pending))
            }
            #[cfg(not(target_os = "macos"))]
            SandboxType::MacosSeatbelt => return Err(SandboxTransformError::SeatbeltUnavailable),
            SandboxType::LinuxSeccomp => {
                let pending = pending_sandboxed_request?;
                let exe = codex_linux_sandbox_exe
                    .ok_or(SandboxTransformError::MissingLinuxSandboxExecutable)?;
                let allow_proxy_network = allow_network_for_proxy(enforce_managed_network);
                #[cfg(target_os = "linux")]
                ensure_linux_bubblewrap_is_supported(
                    &pending.effective_file_system_policy,
                    use_legacy_landlock,
                    allow_proxy_network,
                    is_wsl1(),
                )?;
                let mut args = create_linux_sandbox_command_args_for_permission_profile(
                    os_argv_to_strings(argv),
                    pending.native_command_cwd.as_path(),
                    &pending.effective_permission_profile,
                    pending.native_sandbox_policy_cwd.as_path(),
                    use_legacy_landlock,
                    allow_proxy_network,
                );
                let mut full_command = Vec::with_capacity(1 + args.len());
                full_command.push(os_string_to_command_component(exe.as_os_str().to_owned()));
                full_command.append(&mut args);
                (
                    full_command,
                    Some(linux_sandbox_arg0_override(exe)),
                    Some(pending),
                )
            }
            #[cfg(target_os = "windows")]
            SandboxType::WindowsRestrictedToken => (
                os_argv_to_strings(argv),
                None,
                Some(pending_sandboxed_request?),
            ),
            #[cfg(not(target_os = "windows"))]
            SandboxType::WindowsRestrictedToken => (
                os_argv_to_strings(argv),
                None,
                Some(pending_sandboxed_request?),
            ),
        };

        // 未沙箱的 exec-server 请求可能携带无法在本地解析的外部 cwd，
        // 但其生效权限仍需保留。此时直接沿用 base profile 及其派生的运行时策略。
        let (permission_profile, file_system_sandbox_policy, network_sandbox_policy) =
            pending_sandboxed_request.map_or(
                (
                    base_effective_permission_profile,
                    base_file_system_policy,
                    base_network_policy,
                ),
                |pending| {
                    (
                        pending.effective_permission_profile,
                        pending.effective_file_system_policy,
                        pending.effective_network_policy,
                    )
                },
            );

        Ok(SandboxExecRequest {
            command: argv,
            cwd: command.cwd,
            sandbox_policy_cwd: sandbox_policy_cwd.clone(),
            env: command.env,
            network: network.cloned(),
            network_environment_id: environment_id.map(str::to_string),
            sandbox,
            windows_sandbox_level,
            windows_sandbox_private_desktop,
            permission_profile,
            file_system_sandbox_policy,
            network_sandbox_policy,
            arg0: arg0_override,
        })
    }

    /// 直接 spawn 场景下的沙箱变换入口。
    ///
    /// 在 Windows 上会额外查找 codex_home 并调用 [`transform_for_direct_spawn_with_codex_home`]，
    /// 将 Windows 沙箱 wrapper 内联到最终命令中；其他平台直接委托给 [`transform`]。
    pub fn transform_for_direct_spawn(
        &self,
        request: SandboxDirectSpawnTransformRequest<'_>,
    ) -> Result<SandboxExecRequest, SandboxTransformError> {
        #[cfg(target_os = "windows")]
        {
            let codex_home = codex_utils_home_dir::find_codex_home()
                .map_err(|err| SandboxTransformError::WindowsSandboxPreparation(err.to_string()))?;
            self.transform_for_direct_spawn_with_codex_home(request, codex_home.as_path())
        }

        #[cfg(not(target_os = "windows"))]
        {
            self.transform(request.transform)
        }
    }

    /// Windows 专属：在已知 codex_home 的情况下执行 direct-spawn 变换。
    ///
    /// 先调用 [`transform`] 得到基础请求，再针对 Windows 沙箱类型调用
    /// [`wrap_windows_sandbox_exec_request_for_direct_spawn`] 将 wrapper 参数内联。
    #[cfg(target_os = "windows")]
    fn transform_for_direct_spawn_with_codex_home(
        &self,
        request: SandboxDirectSpawnTransformRequest<'_>,
        codex_home: &Path,
    ) -> Result<SandboxExecRequest, SandboxTransformError> {
        let workspace_roots = request.workspace_roots;
        let proxy_settings_mode = request.windows_sandbox_proxy_settings_mode;
        let mut request = self.transform(request.transform)?;
        if request.sandbox == SandboxType::WindowsRestrictedToken {
            wrap_windows_sandbox_exec_request_for_direct_spawn(
                &mut request,
                workspace_roots,
                codex_home,
                proxy_settings_mode,
            )?;
        }
        Ok(request)
    }
}

/// Windows 专属：将 direct-spawn 的 exec 请求包裹一层 Windows 沙箱 wrapper。
///
/// 调用后 `request.command` 会被替换为 `[helper, wrapper_args...]`，并把
/// `request.sandbox` 重置为 `None`（因为 wrapper 已内联了沙箱逻辑）。
#[cfg(target_os = "windows")]
fn wrap_windows_sandbox_exec_request_for_direct_spawn(
    request: &mut SandboxExecRequest,
    workspace_roots: &[AbsolutePathBuf],
    codex_home: &Path,
    proxy_settings_mode: codex_windows_sandbox::WindowsSandboxProxySettingsMode,
) -> Result<(), SandboxTransformError> {
    // TODO(anp): 让 PathUri 一路贯穿 Windows 沙箱 wrapper 边界，避免此处提前转 native。
    let native_cwd =
        request
            .cwd
            .to_abs_path()
            .map_err(|source| SandboxTransformError::InvalidCommandCwd {
                cwd: request.cwd.clone(),
                source,
            })?;
    let native_sandbox_policy_cwd = request.sandbox_policy_cwd.to_abs_path().map_err(|source| {
        SandboxTransformError::InvalidSandboxPolicyCwd {
            cwd: request.sandbox_policy_cwd.clone(),
            source,
        }
    })?;
    let Some(program) = request.command.first_mut() else {
        return Err(SandboxTransformError::WindowsSandboxPreparation(
            "sandbox command was empty".to_string(),
        ));
    };
    let source = std::path::PathBuf::from(&program);
    let helper = codex_windows_sandbox::resolve_exe_for_launch(source.as_path(), codex_home);
    *program = helper.to_string_lossy().into_owned();

    let inner_command = std::mem::take(&mut request.command);
    let proxy_enforced = request.network.is_some();
    let use_elevated =
        windows_sandbox_uses_elevated_backend(request.windows_sandbox_level, proxy_enforced);
    let overrides = if use_elevated {
        resolve_windows_elevated_filesystem_overrides(
            request.sandbox,
            &request.permission_profile,
            &native_sandbox_policy_cwd,
            use_elevated,
        )
    } else {
        resolve_windows_restricted_token_filesystem_overrides(
            request.sandbox,
            &request.permission_profile,
            &native_sandbox_policy_cwd,
            request.windows_sandbox_level,
        )
    }
    .map_err(SandboxTransformError::WindowsSandboxPreparation)?;
    let empty_paths: &[AbsolutePathBuf] = &[];
    let read_roots_override = overrides
        .as_ref()
        .and_then(|overrides| overrides.read_roots_override.as_deref());
    let read_roots_include_platform_defaults = overrides
        .as_ref()
        .is_some_and(|overrides| overrides.read_roots_include_platform_defaults);
    let write_roots_override = overrides
        .as_ref()
        .and_then(|overrides| overrides.write_roots_override.as_deref());
    let deny_read_paths_override = overrides.as_ref().map_or(empty_paths, |overrides| {
        overrides.additional_deny_read_paths.as_slice()
    });
    let deny_write_paths_override = overrides.as_ref().map_or(empty_paths, |overrides| {
        overrides.additional_deny_write_paths.as_slice()
    });
    let mut wrapper_args =
        codex_windows_sandbox::create_windows_sandbox_command_args_for_permission_profile(
            inner_command,
            &native_cwd,
            workspace_roots,
            &request.env,
            &request.permission_profile,
            request.windows_sandbox_level,
            request.windows_sandbox_private_desktop,
            proxy_enforced,
            proxy_settings_mode,
            read_roots_override,
            read_roots_include_platform_defaults,
            write_roots_override,
            deny_read_paths_override,
            deny_write_paths_override,
            codex_home,
        );

    request.command = Vec::with_capacity(1 + wrapper_args.len());
    request.command.push(source.to_string_lossy().into_owned());
    request.command.append(&mut wrapper_args);
    request.sandbox = SandboxType::None;
    request.arg0 = None;
    add_windows_sandbox_wrapper_setup_env(&mut request.env);
    Ok(())
}

/// 从当前进程环境变量中提取白名单变量并注入到子进程 env 中。
#[cfg(target_os = "windows")]
fn add_windows_sandbox_wrapper_setup_env(env: &mut HashMap<String, String>) {
    add_windows_sandbox_wrapper_setup_env_from_vars(env, std::env::vars_os());
}

/// 从给定变量集合中提取白名单变量并注入到子进程 env 中。
///
/// 仅保留 [`WINDOWS_SANDBOX_WRAPPER_SETUP_ENV_ALLOWLIST`] 中的变量，并覆盖已有同名键，
/// 以保证 wrapper 启动时能拿到正确的 `USERNAME` / `USERPROFILE`。
#[cfg(target_os = "windows")]
fn add_windows_sandbox_wrapper_setup_env_from_vars(
    env: &mut HashMap<String, String>,
    vars: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) {
    for (key, value) in vars {
        let key = key.to_string_lossy().into_owned();
        if !WINDOWS_SANDBOX_WRAPPER_SETUP_ENV_ALLOWLIST
            .iter()
            .any(|allowed| key.eq_ignore_ascii_case(allowed))
        {
            continue;
        }
        env.retain(|existing, _| !existing.eq_ignore_ascii_case(&key));
        env.insert(key, value.to_string_lossy().into_owned());
    }
}

/// 将一个权限 profile 转换为 legacy [`SandboxPolicy`] 视图，供兼容旧调用方使用。
///
/// 优先尝试 `to_legacy_sandbox_policy`；若失败则回退到基于运行时权限的
/// [`compatibility_workspace_write_policy`]。
pub fn compatibility_sandbox_policy_for_permission_profile(
    permissions: &PermissionProfile,
    cwd: &Path,
) -> SandboxPolicy {
    permissions
        .to_legacy_sandbox_policy(cwd)
        .unwrap_or_else(|_| {
            let (file_system_policy, network_policy) = permissions.to_runtime_permissions();
            compatibility_workspace_write_policy(file_system_policy, network_policy, cwd)
        })
}

/// 基于运行时文件系统/网络策略构造 legacy `WorkspaceWrite` 策略。
///
/// 会自动排除 cwd 本身（避免重复授权）、检测 `TMPDIR` 与 `/tmp` 是否可写，
/// 以决定是否在策略中排除它们。
fn compatibility_workspace_write_policy(
    file_system_policy: FileSystemSandboxPolicy,
    network_policy: NetworkSandboxPolicy,
    cwd: &Path,
) -> SandboxPolicy {
    let cwd_abs = AbsolutePathBuf::from_absolute_path(cwd).ok();
    let writable_roots = file_system_policy
        .get_writable_roots_with_cwd(cwd)
        .into_iter()
        .map(|root| root.root)
        .filter(|root| cwd_abs.as_ref() != Some(root))
        .collect();
    let tmpdir_writable = std::env::var_os("TMPDIR")
        .filter(|tmpdir| !tmpdir.is_empty())
        .and_then(|tmpdir| {
            AbsolutePathBuf::from_absolute_path(std::path::PathBuf::from(tmpdir)).ok()
        })
        .is_some_and(|tmpdir| file_system_policy.can_write_path_with_cwd(tmpdir.as_path(), cwd));
    let slash_tmp = Path::new("/tmp");
    let slash_tmp_writable = slash_tmp.is_absolute()
        && slash_tmp.is_dir()
        && file_system_policy.can_write_path_with_cwd(slash_tmp, cwd);

    SandboxPolicy::WorkspaceWrite {
        writable_roots,
        network_access: network_policy.is_enabled(),
        exclude_tmpdir_env_var: !tmpdir_writable,
        exclude_slash_tmp: !slash_tmp_writable,
    }
}

/// 检查当前 Linux 环境是否支持 Bubblewrap（仅 Linux）。
///
/// 当需要网络代理或非 legacy Landlock 且非全盘可写时，必须依赖 Bubblewrap；
/// WSL1 不支持 Bubblewrap，此时返回 `Wsl1UnsupportedForBubblewrap` 错误。
#[cfg(target_os = "linux")]
fn ensure_linux_bubblewrap_is_supported(
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    use_legacy_landlock: bool,
    allow_network_for_proxy: bool,
    is_wsl1: bool,
) -> Result<(), SandboxTransformError> {
    let requires_bubblewrap = allow_network_for_proxy
        || (!use_legacy_landlock && !file_system_sandbox_policy.has_full_disk_write_access());
    if is_wsl1 && requires_bubblewrap {
        return Err(SandboxTransformError::Wsl1UnsupportedForBubblewrap);
    }

    Ok(())
}

/// 将 `Vec<OsString>` 转为 `Vec<String>`，无法精确转换的项使用 `to_string_lossy`。
fn os_argv_to_strings(argv: Vec<OsString>) -> Vec<String> {
    argv.into_iter()
        .map(os_string_to_command_component)
        .collect()
}

/// 将单个 `OsString` 转为 `String`，无法精确转换时退回 lossy 表示。
fn os_string_to_command_component(value: OsString) -> String {
    value
        .into_string()
        .unwrap_or_else(|value| value.to_string_lossy().into_owned())
}

/// 返回 Linux 沙箱可执行文件的 arg0 覆盖值。
///
/// 若 exe 文件名已经是 `CODEX_LINUX_SANDBOX_ARG0`，则使用其完整路径作为 arg0；
/// 否则统一使用 `CODEX_LINUX_SANDBOX_ARG0` 常量字符串。
fn linux_sandbox_arg0_override(exe: &Path) -> String {
    if exe.file_name().and_then(|name| name.to_str()) == Some(CODEX_LINUX_SANDBOX_ARG0) {
        os_string_to_command_component(exe.as_os_str().to_owned())
    } else {
        CODEX_LINUX_SANDBOX_ARG0.to_string()
    }
}

#[cfg(test)]
#[path = "manager_tests.rs"]
mod tests;
