//! Code mode V8 运行时核心实现。
//!
//! 本模块管理一个独立的 V8 isolate 线程，负责：
//! - 初始化 V8 platform 与 ICU 数据
//! - 加载用户代码 module 并驱动事件循环
//! - 在工具调用、定时器、终止命令之间切换
//! - 通过 mpsc channel 与调用方交换事件与命令

mod callbacks;
mod globals;
mod module_loader;
mod timers;
mod value;

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::panic::catch_unwind;
use std::sync::OnceLock;
use std::sync::mpsc as std_mpsc;
use std::thread;

use codex_code_mode_protocol::CodeModeToolKind;
use codex_code_mode_protocol::EnabledToolMetadata;
use codex_code_mode_protocol::ExecuteRequest;
use codex_code_mode_protocol::FunctionCallOutputContentItem;
use codex_code_mode_protocol::enabled_tool_metadata;
use codex_protocol::ToolName;
use serde_json::Value as JsonValue;
use tokio::sync::mpsc;

use crate::TaskFailureHandler;

/// 用于触发运行时退出的特殊字符串（不暴露给用户代码）。
const EXIT_SENTINEL: &str = "__codex_code_mode_exit__";

/// 由调用方发送给 V8 运行时线程的命令。
#[derive(Debug)]
pub(crate) enum RuntimeCommand {
    /// 工具调用结果，用于 resolve 对应的 Promise。
    ToolResponse { id: String, result: JsonValue },
    /// 工具调用错误，用于 reject 对应的 Promise。
    ToolError { id: String, error_text: String },
    /// 触发指定 ID 的定时器回调。
    TimeoutFired { id: u64 },
    /// 观察运行时的 pending frontier（用于 `execute_to_pending` 等场景）。
    ObservePendingFrontier,
    /// 终止当前 cell 的执行。
    Terminate,
}

/// pending 模式：V8 运行时进入 pending 状态后如何处理后续命令。
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum PendingRuntimeMode {
    /// 测试用：直接接收下一条命令（不暂停）。
    #[cfg(test)]
    Continue,
    /// 暂停直至收到 [`RuntimeControlCommand::Resume`] / `Continue` / `Terminate`。
    PauseUntilResumed,
}

/// 控制命令，用于在 pending 状态下推进或终止运行时。
#[derive(Debug)]
pub(crate) enum RuntimeControlCommand {
    /// 接收下一条普通命令后继续 pending。
    Continue,
    /// 立即恢复事件循环，继续处理后续命令。
    Resume,
    /// 终止当前 cell。
    Terminate,
}

/// V8 运行时向调用方发送的事件。
#[derive(Debug)]
pub(crate) enum RuntimeEvent {
    /// cell 已启动（module 已加载但尚未执行）。
    Started,
    /// 运行时进入 pending 状态，等待外部命令推进。
    Pending,
    /// 运行时产出一条内容项（文本或图片）。
    ContentItem(FunctionCallOutputContentItem),
    /// 运行时请求让出（yield）控制权。
    YieldRequested,
    /// 运行时发起一次工具调用，等待调用方响应。
    ToolCall {
        id: String,
        name: ToolName,
        kind: CodeModeToolKind,
        input: Option<JsonValue>,
    },
    /// 运行时发起一次通知（如流式输出）。
    Notify {
        call_id: String,
        text: String,
    },
    /// cell 执行完成，包含 stored_value 写入与可选错误信息。
    Result {
        stored_value_writes: HashMap<String, JsonValue>,
        error_text: Option<String>,
    },
    /// V8 运行时线程发生 panic。
    ThreadPanicked,
}

/// 启动一个新的 V8 运行时线程并返回命令通道与 isolate 句柄。
///
/// 参数：
/// - `stored_values`：跨 cell 持久化的键值对。
/// - `request`：执行请求，包含工具调用 ID、可用工具列表与源码。
/// - `event_tx`：用于接收运行时事件的发送端。
/// - `pending_mode`：pending 状态下的行为模式。
/// - `task_failure_handler`：可选的失败回调，用于上报线程 panic 等致命错误。
///
/// 返回 `(command_tx, control_tx, isolate_handle)`：
/// - `command_tx`：向运行时发送 [`RuntimeCommand`]。
/// - `control_tx`：向运行时发送 [`RuntimeControlCommand`]。
/// - `isolate_handle`：可用于从外部强制终止 V8 isolate。
pub(crate) fn spawn_runtime(
    stored_values: HashMap<String, JsonValue>,
    request: ExecuteRequest,
    event_tx: mpsc::UnboundedSender<RuntimeEvent>,
    pending_mode: PendingRuntimeMode,
    task_failure_handler: Option<TaskFailureHandler>,
) -> Result<
    (
        std_mpsc::Sender<RuntimeCommand>,
        std_mpsc::Sender<RuntimeControlCommand>,
        v8::IsolateHandle,
    ),
    String,
> {
    initialize_v8()?;

    let (command_tx, command_rx) = std_mpsc::channel();
    let (control_tx, control_rx) = std_mpsc::channel();
    let runtime_command_tx = command_tx.clone();
    let (isolate_handle_tx, isolate_handle_rx) = std_mpsc::sync_channel(1);
    let enabled_tools = request
        .enabled_tools
        .iter()
        .map(enabled_tool_metadata)
        .collect::<Vec<_>>();
    let config = RuntimeConfig {
        tool_call_id: request.tool_call_id,
        enabled_tools,
        source: request.source,
        stored_values,
    };

    spawn_supervised_runtime_thread(event_tx.clone(), task_failure_handler, move || {
        run_runtime(
            config,
            event_tx,
            command_rx,
            control_rx,
            pending_mode,
            isolate_handle_tx,
            runtime_command_tx,
        );
    });

    let isolate_handle = isolate_handle_rx
        .recv()
        .map_err(|_| "failed to initialize code mode runtime".to_string())?;
    Ok((command_tx, control_tx, isolate_handle))
}

/// 在独立线程中启动运行时，并通过 `catch_unwind` 捕获 panic。
///
/// panic 时调用 `task_failure_handler`（若存在）并发出 [`RuntimeEvent::ThreadPanicked`]。
fn spawn_supervised_runtime_thread(
    event_tx: mpsc::UnboundedSender<RuntimeEvent>,
    task_failure_handler: Option<TaskFailureHandler>,
    runtime: impl FnOnce() + Send + 'static,
) {
    thread::spawn(move || {
        if catch_unwind(AssertUnwindSafe(runtime)).is_err() {
            if let Some(task_failure_handler) = task_failure_handler {
                task_failure_handler("code-mode V8 runtime thread panicked".to_string());
            }
            let _ = event_tx.send(RuntimeEvent::ThreadPanicked);
        }
    });
}

#[derive(Clone)]
struct RuntimeConfig {
    tool_call_id: String,
    enabled_tools: Vec<EnabledToolMetadata>,
    source: String,
    stored_values: HashMap<String, JsonValue>,
}

/// V8 isolate scope 内的全局状态，通过 [`v8::HandleScope::set_slot`] 关联到 scope。
pub(super) struct RuntimeState {
    /// 事件发送端，用于将运行时事件传回调用方。
    pub(super) event_tx: mpsc::UnboundedSender<RuntimeEvent>,
    /// 等待响应的工具调用 Promise 集合，按工具调用 ID 索引。
    pub(super) pending_tool_calls: HashMap<String, v8::Global<v8::PromiseResolver>>,
    /// 已调度的定时器集合，按 timeout ID 索引。
    pub(super) pending_timeouts: HashMap<u64, timers::ScheduledTimeout>,
    /// 跨 cell 持久化的 stored_value 当前值。
    pub(super) stored_values: HashMap<String, JsonValue>,
    /// 本次 cell 执行期间累计写入的 stored_value（执行完成后会一次性提交给调用方）。
    pub(super) stored_value_writes: HashMap<String, JsonValue>,
    /// 当前 cell 启用工具的元数据列表。
    pub(super) enabled_tools: Vec<EnabledToolMetadata>,
    /// 下一个工具调用 ID（单调递增）。
    pub(super) next_tool_call_id: u64,
    /// 下一个定时器 ID（单调递增）。
    pub(super) next_timeout_id: u64,
    /// 当前 cell 的 tool_call_id（用于关联到外部调用）。
    pub(super) tool_call_id: String,
    /// 用于向 V8 线程发送命令的发送端。
    pub(super) runtime_command_tx: std_mpsc::Sender<RuntimeCommand>,
    /// 是否已请求退出（用于在循环中检测终止）。
    pub(super) exit_requested: bool,
}

/// cell promise 的完成状态。
pub(super) enum CompletionState {
    /// 仍在 pending，需要外部命令推进。
    Pending,
    /// 已完成，包含 stored_value 写入与可选错误信息。
    Completed {
        stored_value_writes: HashMap<String, JsonValue>,
        error_text: Option<String>,
    },
}

/// 初始化 V8 platform 与 ICU 数据（进程级单例）。
///
/// 多次调用安全：通过 [`OnceLock`] 保证只初始化一次。
fn initialize_v8() -> Result<(), String> {
    static PLATFORM: OnceLock<Result<v8::SharedRef<v8::Platform>, String>> = OnceLock::new();

    match PLATFORM.get_or_init(|| {
        v8::icu::set_common_data_77(deno_core_icudata::ICU_DATA)
            .map_err(|error_code| format!("failed to initialize ICU data: {error_code}"))?;
        let platform = v8::new_default_platform(0, false).make_shared();
        v8::V8::initialize_platform(platform.clone());
        v8::V8::initialize();
        Ok(platform)
    }) {
        Ok(_) => Ok(()),
        Err(error_text) => Err(error_text.clone()),
    }
}

/// V8 运行时线程主循环。
///
/// 流程：
/// 1. 创建 isolate 与 context，安装全局对象。
/// 2. 发出 `Started` 事件。
/// 3. 加载并评估用户 module，得到一个 pending promise。
/// 4. 若 promise 已完成，直接发送结果并退出。
/// 5. 否则进入命令循环：依次处理工具响应、错误、定时器、pending 观察，
///    每次处理后检查 promise 状态；若 promise 完成，发送结果并退出。
fn run_runtime(
    config: RuntimeConfig,
    event_tx: mpsc::UnboundedSender<RuntimeEvent>,
    command_rx: std_mpsc::Receiver<RuntimeCommand>,
    control_rx: std_mpsc::Receiver<RuntimeControlCommand>,
    pending_mode: PendingRuntimeMode,
    isolate_handle_tx: std_mpsc::SyncSender<v8::IsolateHandle>,
    runtime_command_tx: std_mpsc::Sender<RuntimeCommand>,
) {
    let isolate = &mut v8::Isolate::new(v8::CreateParams::default());
    let isolate_handle = isolate.thread_safe_handle();
    if isolate_handle_tx.send(isolate_handle).is_err() {
        return;
    }
    isolate.set_host_import_module_dynamically_callback(module_loader::dynamic_import_callback);

    v8::scope!(let scope, isolate);
    let context = v8::Context::new(scope, Default::default());
    let scope = &mut v8::ContextScope::new(scope, context);

    scope.set_slot(RuntimeState {
        event_tx: event_tx.clone(),
        pending_tool_calls: HashMap::new(),
        pending_timeouts: HashMap::new(),
        stored_values: config.stored_values,
        stored_value_writes: HashMap::new(),
        enabled_tools: config.enabled_tools,
        next_tool_call_id: 1,
        next_timeout_id: 1,
        tool_call_id: config.tool_call_id,
        runtime_command_tx,
        exit_requested: false,
    });

    if let Err(error_text) = globals::install_globals(scope) {
        send_result(&event_tx, HashMap::new(), Some(error_text));
        return;
    }

    let _ = event_tx.send(RuntimeEvent::Started);

    let pending_promise = match module_loader::evaluate_main_module(scope, &config.source) {
        Ok(pending_promise) => pending_promise,
        Err(error_text) => {
            capture_scope_send_error(scope, &event_tx, Some(error_text));
            return;
        }
    };

    match module_loader::completion_state(scope, pending_promise.as_ref()) {
        CompletionState::Completed {
            stored_value_writes,
            error_text,
        } => {
            send_result(&event_tx, stored_value_writes, error_text);
            return;
        }
        CompletionState::Pending => {}
    }

    let mut pending_promise = pending_promise;
    while let Some(command) =
        next_runtime_command(&event_tx, &command_rx, &control_rx, pending_mode)
    {
        match command {
            RuntimeCommand::Terminate => break,
            RuntimeCommand::ToolResponse { id, result } => {
                if let Err(error_text) =
                    module_loader::resolve_tool_response(scope, &id, Ok(result))
                {
                    capture_scope_send_error(scope, &event_tx, Some(error_text));
                    return;
                }
            }
            RuntimeCommand::ToolError { id, error_text } => {
                if let Err(runtime_error) =
                    module_loader::resolve_tool_response(scope, &id, Err(error_text))
                {
                    capture_scope_send_error(scope, &event_tx, Some(runtime_error));
                    return;
                }
            }
            RuntimeCommand::TimeoutFired { id } => {
                if let Err(runtime_error) = timers::invoke_timeout_callback(scope, id) {
                    capture_scope_send_error(scope, &event_tx, Some(runtime_error));
                    return;
                }
            }
            RuntimeCommand::ObservePendingFrontier => {}
        }

        scope.perform_microtask_checkpoint();
        match module_loader::completion_state(scope, pending_promise.as_ref()) {
            CompletionState::Completed {
                stored_value_writes,
                error_text,
            } => {
                send_result(&event_tx, stored_value_writes, error_text);
                return;
            }
            CompletionState::Pending => {}
        }

        if let Some(promise) = pending_promise.as_ref() {
            let promise = v8::Local::new(scope, promise);
            if promise.state() != v8::PromiseState::Pending {
                pending_promise = None;
            }
        }
    }
}

/// 从命令通道获取下一条命令，必要时发出 `Pending` 事件并按 pending 模式等待控制命令。
fn next_runtime_command(
    event_tx: &mpsc::UnboundedSender<RuntimeEvent>,
    command_rx: &std_mpsc::Receiver<RuntimeCommand>,
    control_rx: &std_mpsc::Receiver<RuntimeControlCommand>,
    pending_mode: PendingRuntimeMode,
) -> Option<RuntimeCommand> {
    loop {
        match command_rx.try_recv() {
            Ok(command) => return Some(command),
            Err(std_mpsc::TryRecvError::Disconnected) => return None,
            Err(std_mpsc::TryRecvError::Empty) => {}
        }

        let _ = event_tx.send(RuntimeEvent::Pending);
        match pending_mode {
            #[cfg(test)]
            PendingRuntimeMode::Continue => return command_rx.recv().ok(),
            PendingRuntimeMode::PauseUntilResumed => match control_rx.recv().ok()? {
                RuntimeControlCommand::Continue => return command_rx.recv().ok(),
                RuntimeControlCommand::Resume => continue,
                RuntimeControlCommand::Terminate => return Some(RuntimeCommand::Terminate),
            },
        }
    }
}

/// 从 scope 中提取已写入的 stored_value，并发送结果事件。
fn capture_scope_send_error(
    scope: &mut v8::PinScope<'_, '_>,
    event_tx: &mpsc::UnboundedSender<RuntimeEvent>,
    error_text: Option<String>,
) {
    let stored_value_writes = scope
        .get_slot::<RuntimeState>()
        .map(|state| state.stored_value_writes.clone())
        .unwrap_or_default();

    send_result(event_tx, stored_value_writes, error_text);
}

fn send_result(
    event_tx: &mpsc::UnboundedSender<RuntimeEvent>,
    stored_value_writes: HashMap<String, JsonValue>,
    error_text: Option<String>,
) {
    let _ = event_tx.send(RuntimeEvent::Result {
        stored_value_writes,
        error_text,
    });
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::time::Duration;

    use pretty_assertions::assert_eq;
    use tokio::sync::mpsc;

    use super::ExecuteRequest;
    use super::PendingRuntimeMode;
    use super::RuntimeCommand;
    use super::RuntimeControlCommand;
    use super::RuntimeEvent;
    use super::spawn_runtime;
    use super::spawn_supervised_runtime_thread;
    use crate::FunctionCallOutputContentItem;

    fn execute_request(source: &str) -> ExecuteRequest {
        ExecuteRequest {
            tool_call_id: "call_1".to_string(),
            enabled_tools: Vec::new(),
            source: source.to_string(),
            yield_time_ms: Some(1),
            max_output_tokens: None,
        }
    }

    #[tokio::test]
    async fn runtime_thread_panic_before_initialization_is_reported_directly() {
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        drop(event_rx);
        let (failure_tx, mut failure_rx) = mpsc::unbounded_channel();
        spawn_supervised_runtime_thread(
            event_tx,
            Some(std::sync::Arc::new(move |reason| {
                let _ = failure_tx.send(reason);
            })),
            || panic!("runtime thread panic probe"),
        );

        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), failure_rx.recv())
                .await
                .expect("runtime failure timeout")
                .expect("runtime failure"),
            "code-mode V8 runtime thread panicked"
        );
    }

    #[tokio::test]
    async fn runtime_thread_panic_is_forwarded_without_owner_supervision() {
        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        spawn_supervised_runtime_thread(
            event_tx,
            /*task_failure_handler*/ None,
            || panic!("runtime thread panic probe"),
        );

        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(1), event_rx.recv())
                .await
                .expect("runtime panic event timeout"),
            Some(RuntimeEvent::ThreadPanicked)
        ));
    }

    #[tokio::test]
    async fn terminate_execution_stops_cpu_bound_module() {
        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let (_runtime_tx, _runtime_control_tx, runtime_terminate_handle) = spawn_runtime(
            HashMap::new(),
            execute_request("while (true) {}"),
            event_tx,
            PendingRuntimeMode::Continue,
            /*task_failure_handler*/ None,
        )
        .unwrap();

        let started_event = tokio::time::timeout(Duration::from_secs(1), event_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(started_event, RuntimeEvent::Started));

        assert!(runtime_terminate_handle.terminate_execution());

        let result_event = tokio::time::timeout(Duration::from_secs(1), event_rx.recv())
            .await
            .unwrap()
            .unwrap();
        let RuntimeEvent::Result { error_text, .. } = result_event else {
            panic!("expected runtime result after termination");
        };
        assert!(error_text.is_some());

        assert!(
            tokio::time::timeout(Duration::from_secs(1), event_rx.recv())
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn pending_mode_freezes_runtime_commands_until_resume() {
        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let (runtime_tx, runtime_control_tx, _runtime_terminate_handle) = spawn_runtime(
            HashMap::new(),
            execute_request(
                r#"
await new Promise((resolve) => setTimeout(resolve, 60_000));
text("after");
await new Promise(() => {});
"#,
            ),
            event_tx,
            PendingRuntimeMode::PauseUntilResumed,
            /*task_failure_handler*/ None,
        )
        .unwrap();

        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(1), event_rx.recv())
                .await
                .unwrap()
                .unwrap(),
            RuntimeEvent::Started
        ));
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(1), event_rx.recv())
                .await
                .unwrap()
                .unwrap(),
            RuntimeEvent::Pending
        ));

        runtime_tx
            .send(RuntimeCommand::TimeoutFired { id: 1 })
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), event_rx.recv())
                .await
                .is_err()
        );

        runtime_control_tx
            .send(RuntimeControlCommand::Resume)
            .unwrap();

        let content_event = tokio::time::timeout(Duration::from_secs(1), event_rx.recv())
            .await
            .unwrap()
            .unwrap();
        let RuntimeEvent::ContentItem(FunctionCallOutputContentItem::InputText { text }) =
            content_event
        else {
            panic!("expected resumed runtime output");
        };
        assert_eq!(text, "after");
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(1), event_rx.recv())
                .await
                .unwrap()
                .unwrap(),
            RuntimeEvent::Pending
        ));

        runtime_control_tx
            .send(RuntimeControlCommand::Terminate)
            .unwrap();
    }
}
