//! Unified Exec：带审批与沙箱的交互式进程执行模块。
//!
//! 职责：
//! - 管理交互式进程（创建、复用、带容量上限的输出缓冲）。
//! - 使用共享的 ToolOrchestrator 在单一描述性流程中处理审批、沙箱选择与重试语义。
//! - 从经沙箱转换的 `ExecRequest` 派生 PTY；若沙箱拒绝，
//!   在策略允许时回退到无沙箱重试（依赖缓存，无需再次提示用户）。
//! - 使用共享的 `is_likely_sandbox_denied` 启发式判断，保持拒绝消息与其他 exec 路径一致。
//!
//! 流程概览（打开进程）：
//! 1) 构造一个最小请求 `{ command, cwd }`。
//! 2) Orchestrator：审批（bypass/cache/prompt）→ 选择沙箱 → 运行。
//! 3) Runtime：将 `SandboxTransformRequest` 转换为 `ExecRequest` → 派生 PTY。
//! 4) 若被拒绝，orchestrator 以 `SandboxType::None` 重试。
//! 5) 返回进程句柄，附带流式输出与元数据。
//!
//! 这样可将策略逻辑与用户交互集中管理，而 PTY/进程相关逻辑隔离在本模块内。
//! 实现拆分如下：
//! - `process.rs`：PTY 进程生命周期与输出缓冲。
//! - `process_state.rs`：本地与远程进程共享的退出/失败状态。
//! - `process_manager.rs`：编排（审批、沙箱、复用）与请求处理。

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Weak;

use codex_network_proxy::NetworkProxy;
use codex_protocol::models::AdditionalPermissionProfile;
use codex_tools::UnifiedExecShellMode;
use codex_utils_output_truncation::TruncationPolicy;
use codex_utils_path_uri::PathUri;
use rand::Rng;
use rand::rng;
use tokio::sync::Mutex;

use crate::sandboxing::SandboxPermissions;
use crate::session::session::Session;
use crate::session::turn_context::TurnContext;
use crate::session::turn_context::TurnEnvironment;
use crate::shell::ShellType;
use crate::tools::network_approval::DeferredNetworkApproval;

mod async_watcher;
mod errors;
mod head_tail_buffer;
mod process;
mod process_manager;
mod process_state;

/// 设置测试用确定性进程 ID（仅测试调用）。
pub(crate) fn set_deterministic_process_ids_for_tests(enabled: bool) {
    process_manager::set_deterministic_process_ids_for_tests(enabled);
}

pub(crate) use errors::UnifiedExecError;
pub(crate) use process::NoopSpawnLifecycle;
#[cfg(unix)]
pub(crate) use process::SpawnLifecycle;
pub(crate) use process::SpawnLifecycleHandle;
pub(crate) use process::UnifiedExecProcess;

/// exec 调用最小 yield 时间（毫秒）。
pub(crate) const MIN_YIELD_TIME_MS: u64 = 250;
/// Windows 上 exec 调用 yield 时间的下限（毫秒）。
pub(crate) const WINDOWS_INITIAL_EXEC_YIELD_TIME_FLOOR_MS: u64 = 2_000;
/// 空 `write_stdin` 的最小 yield 时间（毫秒）。
pub(crate) const MIN_EMPTY_YIELD_TIME_MS: u64 = 5_000;
/// exec 调用最大 yield 时间（毫秒）。
pub(crate) const MAX_YIELD_TIME_MS: u64 = 30_000;
/// 后台终端默认最大超时时间（毫秒）。
pub(crate) const DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS: u64 = 300_000;
/// 默认最大输出 token 数。
pub(crate) const DEFAULT_MAX_OUTPUT_TOKENS: usize = 10_000;
/// unified exec 输出最大字节数（1 MiB）。
pub(crate) const UNIFIED_EXEC_OUTPUT_MAX_BYTES: usize = 1024 * 1024; // 1 MiB
/// unified exec 输出最大 token 数（按 4 字节/token 估算）。
pub(crate) const UNIFIED_EXEC_OUTPUT_MAX_TOKENS: usize = UNIFIED_EXEC_OUTPUT_MAX_BYTES / 4;
/// 同时允许的最大 unified exec 进程数。
pub(crate) const MAX_UNIFIED_EXEC_PROCESSES: usize = 64;

/// unified exec 调用上下文，携带会话、turn 与 call ID。
pub(crate) struct UnifiedExecContext {
    /// 当前会话句柄。
    pub session: Arc<Session>,
    /// 当前 turn 上下文。
    pub turn: Arc<TurnContext>,
    /// 工具调用 ID。
    pub call_id: String,
}

impl UnifiedExecContext {
    /// 创建一个新的 `UnifiedExecContext`。
    pub fn new(session: Arc<Session>, turn: Arc<TurnContext>, call_id: String) -> Self {
        Self {
            session,
            turn,
            call_id,
        }
    }
}

/// exec 命令请求结构，携带执行所需的全部参数。
#[derive(Debug)]
pub(crate) struct ExecCommandRequest {
    /// 命令参数列表。
    pub command: Vec<String>,
    /// shell 类型。
    pub shell_type: ShellType,
    /// hook 命令字符串。
    pub hook_command: String,
    /// 进程 ID。
    pub process_id: i32,
    /// yield 时间（毫秒）。
    pub yield_time_ms: u64,
    /// 最大输出 token 数。
    pub max_output_tokens: Option<usize>,
    /// 工作目录。
    pub cwd: PathUri,
    /// 沙箱工作目录。
    pub sandbox_cwd: PathUri,
    /// turn environment。
    pub turn_environment: TurnEnvironment,
    /// shell 模式。
    pub shell_mode: UnifiedExecShellMode,
    /// 网络代理配置。
    pub network: Option<NetworkProxy>,
    /// 是否使用 TTY。
    pub tty: bool,
    /// 沙箱权限。
    pub sandbox_permissions: SandboxPermissions,
    /// 附加权限 profile。
    pub additional_permissions: Option<AdditionalPermissionProfile>,
    /// 附加权限是否已预批准。
    pub additional_permissions_preapproved: bool,
    /// 调用理由。
    pub justification: Option<String>,
    /// 前缀规则。
    pub prefix_rule: Option<Vec<String>>,
}

/// write_stdin 请求结构。
#[derive(Debug)]
pub(crate) struct WriteStdinRequest<'a> {
    /// 目标进程 ID。
    pub process_id: i32,
    /// 待写入的输入文本。
    pub input: &'a str,
    /// yield 时间（毫秒）。
    pub yield_time_ms: u64,
    /// 最大输出 token 数。
    pub max_output_tokens: Option<usize>,
    /// 输出截断策略。
    pub truncation_policy: TruncationPolicy,
}

/// 进程存储，管理活跃进程与已保留的进程 ID。
#[derive(Default)]
pub(crate) struct ProcessStore {
    /// 进程 ID 到进程条目的映射。
    processes: HashMap<i32, ProcessEntry>,
    /// 已保留但尚未正式注册的进程 ID 集合。
    reserved_process_ids: HashSet<i32>,
}

impl ProcessStore {
    /// 移除并返回指定进程的条目。
    fn remove(&mut self, process_id: i32) -> Option<ProcessEntry> {
        self.reserved_process_ids.remove(&process_id);
        self.processes.remove(&process_id)
    }
}

/// unified exec 进程管理器，封装进程存储与 write_stdin 超时配置。
pub(crate) struct UnifiedExecProcessManager {
    /// 进程存储（受 Mutex 保护）。
    process_store: Mutex<ProcessStore>,
    /// write_stdin 的最大 yield 时间（毫秒）。
    max_write_stdin_yield_time_ms: u64,
}

impl UnifiedExecProcessManager {
    /// 创建一个新的 `UnifiedExecProcessManager`。
    ///
    /// `max_write_stdin_yield_time_ms` 会被钳制到至少 `MIN_EMPTY_YIELD_TIME_MS`。
    pub(crate) fn new(max_write_stdin_yield_time_ms: u64) -> Self {
        Self {
            process_store: Mutex::new(ProcessStore::default()),
            max_write_stdin_yield_time_ms: max_write_stdin_yield_time_ms
                .max(MIN_EMPTY_YIELD_TIME_MS),
        }
    }
}

impl Default for UnifiedExecProcessManager {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS)
    }
}

/// 进程条目，存储进程句柄与相关元数据。
struct ProcessEntry {
    /// 进程句柄。
    process: Arc<UnifiedExecProcess>,
    /// 发起该进程的工具调用 ID。
    call_id: String,
    /// 进程 ID。
    process_id: i32,
    /// 工作目录。
    cwd: PathUri,
    /// 标记初始 exec 命令是否仍活跃的原子标志。
    initial_exec_command_active: Arc<std::sync::atomic::AtomicBool>,
    /// hook 命令字符串。
    hook_command: String,
    /// 是否使用 TTY。
    pub(crate) tty: bool,
    /// 延迟网络审批句柄。
    network_approval: Option<DeferredNetworkApproval>,
    /// 会话弱引用（避免阻止会话释放）。
    session: Weak<Session>,
    /// 最近一次使用时间。
    last_used: tokio::time::Instant,
}

/// 将 yield 时间钳制到 `[MIN_YIELD_TIME_MS, MAX_YIELD_TIME_MS]` 区间。
///
/// Windows 上额外应用 `WINDOWS_INITIAL_EXEC_YIELD_TIME_FLOOR_MS` 下限。
pub(crate) fn clamp_yield_time(yield_time_ms: u64) -> u64 {
    let yield_time_ms = if cfg!(windows) {
        yield_time_ms.max(WINDOWS_INITIAL_EXEC_YIELD_TIME_FLOOR_MS)
    } else {
        yield_time_ms
    };
    yield_time_ms.clamp(MIN_YIELD_TIME_MS, MAX_YIELD_TIME_MS)
}

/// 解析最大 token 数，未指定时使用 `DEFAULT_MAX_OUTPUT_TOKENS`。
pub(crate) fn resolve_max_tokens(max_tokens: Option<usize>) -> usize {
    max_tokens.unwrap_or(DEFAULT_MAX_OUTPUT_TOKENS)
}

/// 生成 6 位十六进制 chunk ID（用于输出分块标识）。
pub(crate) fn generate_chunk_id() -> String {
    let mut rng = rng();
    (0..6)
        .map(|_| format!("{:x}", rng.random_range(0..16)))
        .collect()
}

#[cfg(test)]
#[cfg(unix)]
#[path = "process_tests.rs"]
mod process_tests;
#[cfg(test)]
#[cfg(unix)]
#[path = "mod_tests.rs"]
mod tests;
