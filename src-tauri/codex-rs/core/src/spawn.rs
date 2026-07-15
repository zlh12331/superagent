//! 进程生成(spawn)模块。
//!
//! 负责按 exec 参数与沙箱设置生成子进程,确保构造 [`Command`] / [`Child`] 时
//! 使用的参数与环境变量严格遵守配置。
//!
//! # 与其他模块的关系
//! - [`crate::exec`] 与 [`crate::tools`] 通过 [`SpawnChildRequest`] 描述子进程需求;
//! - 本模块调用 [`NetworkProxy::apply_to_env`] 注入网络代理设置;
//! - 在 Unix 上通过 `pre_exec` 设置进程组与 parent-death signal,
//!   确保 Codex 进程退出时子进程能够被一并清理。

use codex_network_proxy::NetworkProxy;
use codex_utils_absolute_path::AbsolutePathBuf;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::process::Child;
use tokio::process::Command;
use tracing::trace;

use codex_protocol::permissions::NetworkSandboxPolicy;

/// 实验性环境变量,在以下两个条件同时满足时设为非空值:
///
/// 1. 该进程由 Codex 作为 shell tool 调用的一部分生成;
/// 2. 该次 tool 调用的 [`NetworkSandboxPolicy`] 为受限状态。
///
/// 未来可能合并为统一的沙箱属性环境变量,因此该变量名可能变更。
pub const CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR: &str = "CODEX_SANDBOX_NETWORK_DISABLED";

/// 标识进程运行在沙箱之下的环境变量。
///
/// 当前在 macOS 上取值为 `"seatbelt"`,未来为支持更多沙箱机制与配置可能变更。
pub const CODEX_SANDBOX_ENV_VAR: &str = "CODEX_SANDBOX";

/// 子进程的 stdio 处理策略。
#[derive(Debug, Clone, Copy)]
pub enum StdioPolicy {
    /// 为 shell tool 调用重定向 stdio(stdin 设为 null,stdout/stderr 管道化)。
    RedirectForShellTool,
    /// 继承父进程的 stdin / stdout / stderr。
    Inherit,
}

/// 生成子进程所需的全部参数。
///
/// # 设计说明
/// 目前将 [`NetworkSandboxPolicy`] 作为参数传入,是为了决定是否设置
/// [`CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR`] 环境变量。
pub(crate) struct SpawnChildRequest<'a> {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub arg0: Option<&'a str>,
    pub cwd: AbsolutePathBuf,
    pub network_sandbox_policy: NetworkSandboxPolicy,
    pub network: Option<&'a NetworkProxy>,
    pub stdio_policy: StdioPolicy,
    pub env: HashMap<String, String>,
}

/// 异步生成子进程。
///
/// # 步骤
/// 1. 构造 [`Command`] 并设置 arg0 / args / cwd;
/// 2. 应用网络代理 env,清空环境变量后显式注入给定 env;
/// 3. 若网络被禁,设置 [`CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR`];
/// 4. 在 Unix 上通过 `pre_exec` 设置进程组分离与 parent-death signal;
/// 5. 按 [`StdioPolicy`] 配置 stdio,最终 spawn 出 [`Child`]。
pub(crate) async fn spawn_child_async(request: SpawnChildRequest<'_>) -> std::io::Result<Child> {
    let SpawnChildRequest {
        program,
        args,
        arg0,
        cwd,
        network_sandbox_policy,
        network,
        stdio_policy,
        mut env,
    } = request;

    trace!(
        "spawn_child_async: {program:?} {args:?} {arg0:?} {cwd:?} {network_sandbox_policy:?} {stdio_policy:?} {env:?}"
    );

    let mut cmd = Command::new(&program);
    #[cfg(unix)]
    cmd.arg0(arg0.map_or_else(|| program.to_string_lossy().to_string(), String::from));
    cmd.args(args);
    cmd.current_dir(cwd);
    if let Some(network) = network {
        network.apply_to_env(&mut env);
    }
    // 先清空环境变量,再显式注入,避免父进程的非预期变量泄露给子进程。
    cmd.env_clear();
    cmd.envs(env);

    if !network_sandbox_policy.is_enabled() {
        cmd.env(CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR, "1");
    }

    // 当 Codex 进程死亡(包括被 SIGKILL 杀死)时,
    // 期望作为 shell tool 调用一部分生成的子进程也被一并终止。

    #[cfg(unix)]
    unsafe {
        let detach_from_tty = matches!(stdio_policy, StdioPolicy::RedirectForShellTool);
        #[cfg(target_os = "linux")]
        let parent_pid = libc::getpid();
        cmd.pre_exec(move || {
            if detach_from_tty {
                codex_utils_pty::process_group::detach_from_tty()?;
            }

            // 依赖 prctl(2),仅在 Linux 上有效。
            #[cfg(target_os = "linux")]
            {
                // 该 prctl 调用等价于"当我的当前父进程死亡时,向我发送 SIGTERM"。
                codex_utils_pty::process_group::set_parent_death_signal(parent_pid)?;
            }
            Ok(())
        });
    }

    match stdio_policy {
        StdioPolicy::RedirectForShellTool => {
            // 不为 stdin 创建文件描述符,否则部分命令可能因等待输入而永久挂起。
            // 例如 ripgrep 有一个启发式判断,会尝试从 stdin 读取,
            // 详见:https://github.com/BurntSushi/ripgrep/blob/e2362d4d5185d02fa857bf381e7bd52e66fafc73/crates/core/flags/hiargs.rs#L1101-L1103
            cmd.stdin(Stdio::null());

            cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        }
        StdioPolicy::Inherit => {
            // 继承父进程的 stdin / stdout / stderr。
            cmd.stdin(Stdio::inherit())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit());
        }
    }

    cmd.kill_on_drop(true).spawn()
}
