//! Turn 级状态与活跃 turn 元数据骨架。
//!
//! 本模块定义了与单次 turn 相关的可变状态、任务句柄以及 mailbox 投递阶段等数据结构。

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use tokio_util::task::AbortOnDropHandle;

use codex_extension_api::ExtensionData;
use codex_protocol::dynamic_tools::DynamicToolResponse;
use codex_protocol::protocol::TurnEnvironmentSelection;
use codex_protocol::request_permissions::RequestPermissionProfile;
use codex_protocol::request_permissions::RequestPermissionsResponse;
use codex_protocol::request_user_input::RequestUserInputResponse;
use codex_rmcp_client::ElicitationResponse;
use codex_sandboxing::policy_transforms::merge_permission_profiles;
use rmcp::model::RequestId;
use tokio::sync::oneshot;

use crate::agent::control::AgentExecutionGuard;
use crate::session::TurnInputQueue;
use crate::session::turn_context::TurnContext;
use crate::tasks::AnySessionTask;
use codex_protocol::models::AdditionalPermissionProfile;
use codex_protocol::protocol::ReviewDecision;
use codex_protocol::protocol::TokenUsage;

/// 当前正在运行的 turn 的元数据。
pub(crate) struct ActiveTurn {
    /// 当前 turn 关联的运行中任务（若有）。
    pub(crate) task: Option<RunningTask>,
    /// 当前 turn 的可变状态，使用 `Arc<Mutex<...>>` 以便跨任务共享。
    pub(crate) turn_state: Arc<Mutex<TurnState>>,
}

/// 控制 mailbox 投递是否仍应被并入当前 turn。
///
/// 状态机说明：
/// - turn 启动时处于 `CurrentTurn`，因此已排队的子 agent mail 可以加入该 turn 的下一次
///   model request。
/// - 一旦记录到对用户可见的终止输出，则切换到 `NextTurn`，让晚到的子 agent mail 保持
///   排队状态，而不是延长已经显示的回答。
/// - 如果同一任务之后又获得同 turn 的工作（例如被引导的用户提示，或在未标记的 preamble
///   之后发起的工具调用），则重新打开 `CurrentTurn`，使待处理的子 agent mail 排入该
///   后续请求中。
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum MailboxDeliveryPhase {
    /// 当前 turn 仍可消费新到的 mailbox 消息。
    #[default]
    CurrentTurn,
    /// 当前 turn 已经发出了可见的最终回答文本；mailbox 消息应保留排队等待下一个 turn。
    NextTurn,
}

impl Default for ActiveTurn {
    fn default() -> Self {
        Self {
            task: None,
            turn_state: Arc::new(Mutex::new(TurnState::default())),
        }
    }
}

/// 任务种类枚举，用于区分不同类型的 session task。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TaskKind {
    /// 常规用户 turn 任务。
    Regular,
    /// 评审（review）任务。
    Review,
    /// 上下文压缩（compact）任务。
    Compact,
}

/// 运行中的 session task 句柄，封装了任务执行所需的所有上下文与同步原语。
pub(crate) struct RunningTask {
    /// 任务完成通知器，任务结束时通过它唤醒等待者。
    pub(crate) done: Arc<Notify>,
    /// 任务种类。
    pub(crate) kind: TaskKind,
    /// 任务对象本身（trait object）。
    pub(crate) task: Arc<dyn AnySessionTask>,
    /// 任务的取消令牌。
    pub(crate) cancellation_token: CancellationToken,
    /// 任务的 join handle，drop 时会自动 abort 任务。
    pub(crate) handle: AbortOnDropHandle<()>,
    /// 该任务对应的 turn 上下文。
    pub(crate) turn_context: Arc<TurnContext>,
    /// 该任务对应的 turn 级扩展数据。
    pub(crate) turn_extension_data: Arc<ExtensionData>,
    /// 可选的 agent 执行守卫，drop 时会释放 agent 执行槽位。
    pub(crate) _agent_execution_guard: Option<AgentExecutionGuard>,
    /// 任务结束时记录的计时器，用于捕获完整的 turn 持续时间。
    pub(crate) _timer: Option<codex_otel::Timer>,
}

/// 单个 turn 的可变状态。
#[derive(Default)]
pub(crate) struct TurnState {
    /// 待处理的审批请求映射，按 key 索引审批响应发送端。
    pending_approvals: HashMap<String, oneshot::Sender<ReviewDecision>>,
    /// 待处理的权限请求映射。
    pending_request_permissions: HashMap<String, PendingRequestPermissions>,
    /// 待处理的用户输入请求映射。
    pending_user_input: HashMap<String, oneshot::Sender<RequestUserInputResponse>>,
    /// 待处理的 elicitation 请求映射，按 (server_name, request_id) 索引。
    pending_elicitations: HashMap<(String, RequestId), oneshot::Sender<ElicitationResponse>>,
    /// 待处理的动态工具请求映射。
    pending_dynamic_tools: HashMap<String, oneshot::Sender<DynamicToolResponse>>,
    /// 待处理的输入队列。
    pub(crate) pending_input: TurnInputQueue,
    /// mailbox 投递阶段状态。
    mailbox_delivery_phase: MailboxDeliveryPhase,
    /// 按 environment ID 索引的已授予权限配置。
    granted_permissions_by_environment_id: HashMap<String, AdditionalPermissionProfile>,
    /// 是否启用严格自动评审模式。
    strict_auto_review_enabled: bool,
    /// 当前 turn 内的工具调用次数。
    pub(crate) tool_calls: u64,
    /// 当前 turn 是否包含 memory citation。
    pub(crate) has_memory_citation: bool,
    /// turn 开始时的令牌用量快照，用于计算 turn 内增量。
    pub(crate) token_usage_at_turn_start: TokenUsage,
}

/// 待处理的权限请求条目。
pub(crate) struct PendingRequestPermissions {
    /// 用于回传响应的 oneshot 发送端。
    pub(crate) tx_response: oneshot::Sender<RequestPermissionsResponse>,
    /// 用户请求的权限 profile。
    pub(crate) requested_permissions: RequestPermissionProfile,
    /// 该请求对应的环境选择。
    pub(crate) environment: TurnEnvironmentSelection,
}

impl TurnState {
    /// 插入一个待处理的审批请求，返回该 key 之前已存在的发送端（如有）。
    pub(crate) fn insert_pending_approval(
        &mut self,
        key: String,
        tx: oneshot::Sender<ReviewDecision>,
    ) -> Option<oneshot::Sender<ReviewDecision>> {
        self.pending_approvals.insert(key, tx)
    }

    /// 移除并返回指定 key 的待处理审批请求发送端。
    pub(crate) fn remove_pending_approval(
        &mut self,
        key: &str,
    ) -> Option<oneshot::Sender<ReviewDecision>> {
        self.pending_approvals.remove(key)
    }

    /// 清除所有待处理的等待者（审批、权限请求、用户输入、elicitation、动态工具）。
    /// 通常在 turn 结束或中止时调用。
    pub(crate) fn clear_pending_waiters(&mut self) {
        self.pending_approvals.clear();
        self.pending_request_permissions.clear();
        self.pending_user_input.clear();
        self.pending_elicitations.clear();
        self.pending_dynamic_tools.clear();
    }

    /// 插入一个待处理的权限请求条目，返回该 key 之前已存在的条目（如有）。
    pub(crate) fn insert_pending_request_permissions(
        &mut self,
        key: String,
        pending_request_permissions: PendingRequestPermissions,
    ) -> Option<PendingRequestPermissions> {
        self.pending_request_permissions
            .insert(key, pending_request_permissions)
    }

    /// 移除并返回指定 key 的待处理权限请求条目。
    pub(crate) fn remove_pending_request_permissions(
        &mut self,
        key: &str,
    ) -> Option<PendingRequestPermissions> {
        self.pending_request_permissions.remove(key)
    }

    /// 插入一个待处理的用户输入请求，返回该 key 之前已存在的发送端（如有）。
    pub(crate) fn insert_pending_user_input(
        &mut self,
        key: String,
        tx: oneshot::Sender<RequestUserInputResponse>,
    ) -> Option<oneshot::Sender<RequestUserInputResponse>> {
        self.pending_user_input.insert(key, tx)
    }

    /// 移除并返回指定 key 的待处理用户输入请求发送端。
    pub(crate) fn remove_pending_user_input(
        &mut self,
        key: &str,
    ) -> Option<oneshot::Sender<RequestUserInputResponse>> {
        self.pending_user_input.remove(key)
    }

    /// 插入一个待处理的 elicitation 请求，返回该 (server_name, request_id) 之前
    /// 已存在的发送端（如有）。
    pub(crate) fn insert_pending_elicitation(
        &mut self,
        server_name: String,
        request_id: RequestId,
        tx: oneshot::Sender<ElicitationResponse>,
    ) -> Option<oneshot::Sender<ElicitationResponse>> {
        self.pending_elicitations
            .insert((server_name, request_id), tx)
    }

    /// 移除并返回指定 (server_name, request_id) 的待处理 elicitation 请求发送端。
    pub(crate) fn remove_pending_elicitation(
        &mut self,
        server_name: &str,
        request_id: &RequestId,
    ) -> Option<oneshot::Sender<ElicitationResponse>> {
        self.pending_elicitations
            .remove(&(server_name.to_string(), request_id.clone()))
    }

    /// 插入一个待处理的动态工具请求，返回该 key 之前已存在的发送端（如有）。
    pub(crate) fn insert_pending_dynamic_tool(
        &mut self,
        key: String,
        tx: oneshot::Sender<DynamicToolResponse>,
    ) -> Option<oneshot::Sender<DynamicToolResponse>> {
        self.pending_dynamic_tools.insert(key, tx)
    }

    /// 移除并返回指定 key 的待处理动态工具请求发送端。
    pub(crate) fn remove_pending_dynamic_tool(
        &mut self,
        key: &str,
    ) -> Option<oneshot::Sender<DynamicToolResponse>> {
        self.pending_dynamic_tools.remove(key)
    }

    /// 标记当前 turn 接受 mailbox 投递。
    pub(crate) fn accept_mailbox_delivery_for_current_turn(&mut self) {
        self.set_mailbox_delivery_phase(MailboxDeliveryPhase::CurrentTurn);
    }

    /// 返回当前 turn 是否接受 mailbox 投递。
    pub(crate) fn accepts_mailbox_delivery_for_current_turn(&self) -> bool {
        self.mailbox_delivery_phase == MailboxDeliveryPhase::CurrentTurn
    }

    /// 设置 mailbox 投递阶段。
    pub(crate) fn set_mailbox_delivery_phase(&mut self, phase: MailboxDeliveryPhase) {
        self.mailbox_delivery_phase = phase;
    }

    /// 记录针对指定 environment 的已授予权限，并与现有权限合并。
    pub(crate) fn record_granted_permissions(
        &mut self,
        environment_id: &str,
        permissions: AdditionalPermissionProfile,
    ) {
        let granted_permissions = merge_permission_profiles(
            self.granted_permissions_by_environment_id
                .get(environment_id),
            Some(&permissions),
        );
        if let Some(granted_permissions) = granted_permissions {
            self.granted_permissions_by_environment_id
                .insert(environment_id.to_string(), granted_permissions);
        }
    }

    /// 获取指定 environment 的已授予权限配置（克隆）。
    pub(crate) fn granted_permissions(
        &self,
        environment_id: &str,
    ) -> Option<AdditionalPermissionProfile> {
        self.granted_permissions_by_environment_id
            .get(environment_id)
            .cloned()
    }

    /// 启用严格自动评审模式。
    pub(crate) fn enable_strict_auto_review(&mut self) {
        self.strict_auto_review_enabled = true;
    }

    /// 返回是否已启用严格自动评审模式。
    pub(crate) fn strict_auto_review_enabled(&self) -> bool {
        self.strict_auto_review_enabled
    }
}
