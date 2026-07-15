//! Shell 权限提升（escalation）模块。
//!
//! 该 crate 在 Unix 平台上提供 shell 命令的权限提升能力，包括：
//! - 权限提升策略（`EscalationPolicy`）与决策（`EscalationDecision`）；
//! - 权限提升会话（`EscalationSession`）与服务端（`EscalateServer`）；
//! - shell 命令执行器（`ShellCommandExecutor`）与执行参数/结果；
//! - 通过 `execve` 包装的入口函数（`main_execve_wrapper` 等）。
//!
//! 所有导出项仅在 Unix 平台可用（`#[cfg(unix)]`）。
//!
//! 核心类型：[`EscalationPolicy`]、[`EscalationSession`]、[`ShellCommandExecutor`]。

#[cfg(unix)]
mod unix;

/// 权限提升 socket 所用的环境变量名。
#[cfg(unix)]
pub use unix::ESCALATE_SOCKET_ENV_VAR;
/// 权限提升动作枚举。
#[cfg(unix)]
pub use unix::EscalateAction;
/// 权限提升服务端，负责接收并处理提升请求。
#[cfg(unix)]
pub use unix::EscalateServer;
/// 权限提升决策：是否允许执行某命令。
#[cfg(unix)]
pub use unix::EscalationDecision;
/// 权限提升执行结果记录。
#[cfg(unix)]
pub use unix::EscalationExecution;
/// 权限提升权限描述。
#[cfg(unix)]
pub use unix::EscalationPermissions;
/// 权限提升策略：决定哪些操作需要提升权限。
#[cfg(unix)]
pub use unix::EscalationPolicy;
/// `EscalationPolicy` 相关 future 类型别名。
#[cfg(unix)]
pub use unix::EscalationPolicyFuture;
/// 权限提升会话：管理与单个客户端的提升交互生命周期。
#[cfg(unix)]
pub use unix::EscalationSession;
/// 执行参数：描述待执行命令的详细信息。
#[cfg(unix)]
pub use unix::ExecParams;
/// 执行结果：命令执行后的返回信息。
#[cfg(unix)]
pub use unix::ExecResult;
/// 已准备就绪的执行句柄。
#[cfg(unix)]
pub use unix::PreparedExec;
/// 已解析的权限配置文件。
#[cfg(unix)]
pub use unix::ResolvedPermissionProfile;
/// Shell 命令执行器：在权限提升上下文中执行 shell 命令。
#[cfg(unix)]
pub use unix::ShellCommandExecutor;
/// `ShellCommandExecutor` 相关 future 类型别名。
#[cfg(unix)]
pub use unix::ShellCommandExecutorFuture;
/// 计时器：用于测量命令执行耗时。
#[cfg(unix)]
pub use unix::Stopwatch;
/// `execve` 包装的主入口函数。
#[cfg(unix)]
pub use unix::main_execve_wrapper;
/// 运行 shell 权限提升 `execve` 包装器的入口函数。
#[cfg(unix)]
pub use unix::run_shell_escalation_execve_wrapper;
