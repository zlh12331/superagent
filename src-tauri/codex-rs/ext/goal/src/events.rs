//! Goal 事件发射器模块。
//!
//! 该模块将 goal 状态变更包装为 codex protocol 事件，并通过
//! [`ExtensionEventSink`] 发射到 codex 事件流，供前端/CLI 监听。

use std::sync::Arc;

use codex_extension_api::ExtensionEventSink;
use codex_protocol::protocol::Event;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::ThreadGoal;
use codex_protocol::protocol::ThreadGoalUpdatedEvent;

/// Goal 事件发射器，封装 extension event sink。
#[derive(Clone)]
pub(crate) struct GoalEventEmitter {
    /// 事件 sink，由 host 提供的具体实现
    sink: Arc<dyn ExtensionEventSink>,
}

impl GoalEventEmitter {
    /// 创建一个新的 `GoalEventEmitter` 实例。
    pub(crate) fn new(sink: Arc<dyn ExtensionEventSink>) -> Self {
        Self { sink }
    }

    /// 发射 `ThreadGoalUpdated` 事件。
    ///
    /// # 参数
    /// - `event_id`：事件 ID（通常由调用方根据上下文生成，如 `"{turn_id}:turn-stop"`）
    /// - `turn_id`：关联的 turn ID（idle 状态下为 `None`）
    /// - `goal`：最新的 goal 状态
    pub(crate) fn thread_goal_updated(
        &self,
        event_id: impl Into<String>,
        turn_id: Option<String>,
        goal: ThreadGoal,
    ) {
        self.sink.emit(Event {
            id: event_id.into(),
            msg: EventMsg::ThreadGoalUpdated(ThreadGoalUpdatedEvent {
                thread_id: goal.thread_id,
                turn_id,
                goal,
            }),
        });
    }
}
