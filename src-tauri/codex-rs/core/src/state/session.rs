//! 会话级可变状态（session-wide mutable state）。
//!
//! 本模块定义并维护跨 turn 持久化的会话状态，包括历史上下文管理、令牌与速率限制快照、
//! 自动压缩窗口（auto-compact window）、连接器选择（connector selection）等。

use codex_protocol::models::AdditionalPermissionProfile;
use codex_protocol::models::ResponseItem;
use codex_sandboxing::policy_transforms::merge_permission_profiles;
use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;

use super::AdditionalContextStore;
use super::auto_compact_window::AutoCompactWindow;
use super::auto_compact_window::AutoCompactWindowIds;
use super::auto_compact_window::AutoCompactWindowSnapshot;
use crate::context_manager::ContextManager;
use crate::session::PreviousTurnSettings;
use crate::session::session::SessionConfiguration;
use crate::session::time_reminder::CurrentTimeReminderState;
use crate::session_startup_prewarm::SessionStartupPrewarmHandle;
use codex_protocol::protocol::RateLimitSnapshot;
use codex_protocol::protocol::TokenUsage;
use codex_protocol::protocol::TokenUsageInfo;
use codex_protocol::protocol::TurnContextItem;
use codex_utils_output_truncation::TruncationPolicy;

/// 持久化、会话级的状态集合。
///
/// 早期实现中这些字段直接存储在 `Session` 上，现已迁移至本结构以降低 `Session` 的复杂度。
pub(crate) struct SessionState {
    pub(crate) session_configuration: SessionConfiguration,
    /// 会话历史上下文管理器，负责维护与模型的对话项序列。
    pub(crate) history: ContextManager,
    /// 最近一次观测到的速率限制（rate limit）快照。
    pub(crate) latest_rate_limits: Option<RateLimitSnapshot>,
    /// 标记服务端是否在响应中包含 reasoning 内容。
    pub(crate) server_reasoning_included: bool,
    /// 已经提示过用户的 MCP 依赖名称集合，避免重复提示。
    pub(crate) mcp_dependency_prompted: HashSet<String>,
    /// 附加上下文存储，可在标准 history 之外注入额外上下文项。
    pub(crate) additional_context: AdditionalContextStore,
    /// 最近一次常规用户 turn 所使用的设置；用于后续常规 turn 的
    /// 模型/实时模式处理（包括 resume 或 `/compact` 之后的全上下文重新注入）。
    previous_turn_settings: Option<PreviousTurnSettings>,
    /// 当前活跃 auto-compaction 窗口的运行时记账状态。
    auto_compact_window: AutoCompactWindow,
    /// 会话初始化期间准备好的启动预热（prewarm）句柄。
    pub(crate) startup_prewarm: Option<SessionStartupPrewarmHandle>,
    /// 当前时间提醒的会话级状态。
    pub(crate) current_time_reminder: CurrentTimeReminderState,
    /// 当前激活的 connector 选择集合。
    pub(crate) active_connector_selection: HashSet<String>,
    /// 待处理的会话启动来源队列，等待 hook 处理消费。
    pub(crate) pending_session_start_sources: VecDeque<codex_hooks::SessionStartSource>,
    /// 按 environment ID 索引的已授予权限配置。
    granted_permissions_by_environment_id: HashMap<String, AdditionalPermissionProfile>,
    /// 标记下一个 turn 是否为该会话的第一个 turn。
    next_turn_is_first: bool,
}

impl SessionState {
    /// 创建一个新的会话状态，沿用早期 `State::default()` 的语义。
    #[cfg(test)]
    pub(crate) fn new(session_configuration: SessionConfiguration) -> Self {
        Self::new_with_auto_compact_window_ids(
            session_configuration,
            AutoCompactWindowIds::new_initial(),
        )
    }

    /// 创建一个新的会话状态，并显式指定 auto-compact 窗口的初始 ID 集合。
    pub(crate) fn new_with_auto_compact_window_ids(
        session_configuration: SessionConfiguration,
        auto_compact_window_ids: AutoCompactWindowIds,
    ) -> Self {
        let history = ContextManager::new();
        Self {
            session_configuration,
            history,
            latest_rate_limits: None,
            server_reasoning_included: false,
            mcp_dependency_prompted: HashSet::new(),
            additional_context: AdditionalContextStore::default(),
            previous_turn_settings: None,
            auto_compact_window: AutoCompactWindow::new_with_ids(auto_compact_window_ids),
            startup_prewarm: None,
            current_time_reminder: CurrentTimeReminderState::default(),
            active_connector_selection: HashSet::new(),
            pending_session_start_sources: VecDeque::new(),
            granted_permissions_by_environment_id: HashMap::new(),
            next_turn_is_first: true,
        }
    }

    // ===== History 相关辅助方法 =====

    /// 记录一批响应项到会话历史中，按指定截断策略处理。
    pub(crate) fn record_items<I>(&mut self, items: I, policy: TruncationPolicy)
    where
        I: IntoIterator,
        I::Item: std::ops::Deref<Target = ResponseItem>,
    {
        self.history.record_items(items, policy);
    }

    /// 获取上一个 turn 的设置（克隆）。
    pub(crate) fn previous_turn_settings(&self) -> Option<PreviousTurnSettings> {
        self.previous_turn_settings.clone()
    }

    /// 设置上一个 turn 的设置；传入 `None` 表示清除。
    pub(crate) fn set_previous_turn_settings(
        &mut self,
        previous_turn_settings: Option<PreviousTurnSettings>,
    ) {
        self.previous_turn_settings = previous_turn_settings;
    }

    /// 设置下一个 turn 是否为该会话的第一个 turn。
    pub(crate) fn set_next_turn_is_first(&mut self, value: bool) {
        self.next_turn_is_first = value;
    }

    /// 取走并返回下一个 turn 是否为第一个 turn 的标记，调用后该标记会被重置为 `false`。
    pub(crate) fn take_next_turn_is_first(&mut self) -> bool {
        let is_first_turn = self.next_turn_is_first;
        self.next_turn_is_first = false;
        is_first_turn
    }

    /// 克隆整个会话历史上下文管理器。
    pub(crate) fn clone_history(&self) -> ContextManager {
        self.history.clone()
    }

    /// 用新的响应项列表替换当前历史，并更新引用上下文项。
    /// 同时会清除 auto-compact 窗口的 prefill 信息，因为历史已被替换。
    pub(crate) fn replace_history(
        &mut self,
        items: Vec<ResponseItem>,
        reference_context_item: Option<TurnContextItem>,
    ) {
        self.history.replace(items);
        self.history
            .set_reference_context_item(reference_context_item);
        self.auto_compact_window.clear_prefill();
    }

    /// 设置令牌使用信息。
    pub(crate) fn set_token_info(&mut self, info: Option<TokenUsageInfo>) {
        self.history.set_token_info(info);
    }

    /// 设置引用上下文项（reference context item）。
    // 修复：history.set_reference_context_item 需要 &mut self，因此这里也必须是 &mut self
    pub(crate) fn set_reference_context_item(&mut self, item: Option<TurnContextItem>) {
        self.history.set_reference_context_item(item);
    }

    /// 获取当前引用上下文项。
    pub(crate) fn reference_context_item(&self) -> Option<TurnContextItem> {
        self.history.reference_context_item()
    }

    // ===== 令牌/速率限制相关辅助方法 =====

    /// 根据最新的 `TokenUsage` 更新会话历史中的令牌信息。
    pub(crate) fn update_token_info_from_usage(
        &mut self,
        usage: &TokenUsage,
        model_context_window: Option<i64>,
    ) {
        self.history.update_token_info(usage, model_context_window);
    }

    /// 根据最新 usage 确保 auto-compact 窗口记录了服务端观测到的 prefill 值。
    pub(crate) fn ensure_auto_compact_window_server_prefill_from_usage(
        &mut self,
        usage: &TokenUsage,
    ) {
        self.auto_compact_window
            .ensure_server_observed_prefill_from_usage(usage);
    }

    /// 设置 auto-compact 窗口的估算 prefill 令牌数。
    pub(crate) fn set_auto_compact_window_estimated_prefill(&mut self, tokens: i64) {
        self.auto_compact_window.set_estimated_prefill(tokens);
    }

    /// 获取 auto-compact 窗口的当前快照。
    pub(crate) fn auto_compact_window_snapshot(&self) -> AutoCompactWindowSnapshot {
        self.auto_compact_window.snapshot()
    }

    /// 取走令牌预算提醒标记（一次性消费）。
    pub(crate) fn claim_token_budget_reminder(&mut self) -> bool {
        self.auto_compact_window.claim_token_budget_reminder()
    }

    /// 获取 auto-compact 窗口编号。
    pub(crate) fn auto_compact_window_number(&self) -> u64 {
        self.auto_compact_window.window_number()
    }

    /// 获取 auto-compact 窗口的 ID 集合。
    pub(crate) fn auto_compact_window_ids(&self) -> AutoCompactWindowIds {
        self.auto_compact_window.ids()
    }

    /// 恢复 auto-compact 窗口到指定编号与 ID 集合（用于 rollout 重建）。
    pub(crate) fn restore_auto_compact_window(
        &mut self,
        window_number: u64,
        ids: AutoCompactWindowIds,
    ) {
        self.auto_compact_window.restore(window_number, ids);
    }

    /// 推进到下一个 auto-compact 窗口，返回新窗口的编号与 ID 集合。
    pub(crate) fn advance_auto_compact_window(&mut self) -> (u64, AutoCompactWindowIds) {
        self.auto_compact_window.advance()
    }

    /// 请求开启一个新的上下文窗口。
    pub(crate) fn request_new_context_window(&mut self) {
        self.auto_compact_window.request_new_context_window();
    }

    /// 取走并消费“开启新上下文窗口”的请求标记。
    pub(crate) fn take_new_context_window_request(&mut self) -> bool {
        self.auto_compact_window.take_new_context_window_request()
    }

    /// 启动一个新的上下文窗口：推进窗口编号并清除 prefill。
    /// 返回新窗口的编号与 ID 集合。
    pub(crate) fn start_new_context_window(&mut self) -> (u64, AutoCompactWindowIds) {
        let window = self.auto_compact_window.advance();
        self.auto_compact_window.clear_prefill();
        window
    }

    /// 获取当前令牌使用信息。
    pub(crate) fn token_info(&self) -> Option<TokenUsageInfo> {
        self.history.token_info()
    }

    /// 更新速率限制快照，对缺失字段进行合并以保留上次快照的有效信息。
    pub(crate) fn set_rate_limits(&mut self, snapshot: RateLimitSnapshot) {
        self.latest_rate_limits = Some(merge_rate_limit_fields(
            self.latest_rate_limits.as_ref(),
            snapshot,
        ));
    }

    /// 同时获取令牌使用信息与速率限制快照。
    pub(crate) fn token_info_and_rate_limits(
        &self,
    ) -> (Option<TokenUsageInfo>, Option<RateLimitSnapshot>) {
        (self.token_info(), self.latest_rate_limits.clone())
    }

    /// 标记令牌用量已达上下文窗口上限。
    pub(crate) fn set_token_usage_full(&mut self, context_window: i64) {
        self.history.set_token_usage_full(context_window);
    }

    /// 获取累计的令牌用量总数；若 `server_reasoning_included` 为 `true`，
    /// 则将服务端 reasoning 令牌纳入统计。
    pub(crate) fn get_total_token_usage(&self, server_reasoning_included: bool) -> i64 {
        self.history
            .get_total_token_usage(server_reasoning_included)
    }

    /// 设置服务端是否在响应中包含 reasoning 内容。
    pub(crate) fn set_server_reasoning_included(&mut self, included: bool) {
        self.server_reasoning_included = included;
    }

    /// 返回服务端是否在响应中包含 reasoning 内容。
    pub(crate) fn server_reasoning_included(&self) -> bool {
        self.server_reasoning_included
    }

    /// 记录已向用户提示过的 MCP 依赖名称，避免重复提示。
    pub(crate) fn record_mcp_dependency_prompted<I>(&mut self, names: I)
    where
        I: IntoIterator<Item = String>,
    {
        self.mcp_dependency_prompted.extend(names);
    }

    /// 返回已提示过的 MCP 依赖名称集合（克隆）。
    pub(crate) fn mcp_dependency_prompted(&self) -> HashSet<String> {
        self.mcp_dependency_prompted.clone()
    }

    /// 设置会话启动预热句柄。
    pub(crate) fn set_session_startup_prewarm(
        &mut self,
        startup_prewarm: SessionStartupPrewarmHandle,
    ) {
        self.startup_prewarm = Some(startup_prewarm);
    }

    /// 取走会话启动预热句柄（一次性消费）。
    pub(crate) fn take_session_startup_prewarm(&mut self) -> Option<SessionStartupPrewarmHandle> {
        self.startup_prewarm.take()
    }

    /// 将指定 connector ID 加入当前激活选择集，并返回合并后的完整选择集。
    pub(crate) fn merge_connector_selection<I>(&mut self, connector_ids: I) -> HashSet<String>
    where
        I: IntoIterator<Item = String>,
    {
        self.active_connector_selection.extend(connector_ids);
        self.active_connector_selection.clone()
    }

    /// 返回会话状态中跟踪的当前 connector 选择集。
    pub(crate) fn get_connector_selection(&self) -> HashSet<String> {
        self.active_connector_selection.clone()
    }

    /// 清除当前所有跟踪的 connector 选择。
    pub(crate) fn clear_connector_selection(&mut self) {
        self.active_connector_selection.clear();
    }

    /// 将一个待处理的会话启动来源入队，等待后续 hook 消费。
    pub(crate) fn queue_pending_session_start_source(
        &mut self,
        value: codex_hooks::SessionStartSource,
    ) {
        self.pending_session_start_sources.push_back(value);
    }

    /// 出队一个待处理的会话启动来源（FIFO）。
    pub(crate) fn take_pending_session_start_source(
        &mut self,
    ) -> Option<codex_hooks::SessionStartSource> {
        self.pending_session_start_sources.pop_front()
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
}

// 部分新快照可能不包含 credits 或 plan 信息。
// 当缺失时，从上一次快照中保留这些字段。对于 `limit_id`，缺失值视为默认的 `"codex"` 桶。
fn merge_rate_limit_fields(
    previous: Option<&RateLimitSnapshot>,
    mut snapshot: RateLimitSnapshot,
) -> RateLimitSnapshot {
    if snapshot.limit_id.is_none() {
        snapshot.limit_id = Some("codex".to_string());
    }
    if snapshot.credits.is_none() {
        snapshot.credits = previous.and_then(|prior| prior.credits.clone());
    }
    if snapshot.individual_limit.is_none() {
        snapshot.individual_limit = previous.and_then(|prior| prior.individual_limit.clone());
    }
    if snapshot.plan_type.is_none() {
        snapshot.plan_type = previous.and_then(|prior| prior.plan_type);
    }
    snapshot
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
