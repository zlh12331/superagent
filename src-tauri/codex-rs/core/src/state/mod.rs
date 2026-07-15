//! Session 状态管理模块。
//!
//! 定义 session 级与 turn 级的状态结构,包括:
//! - [`SessionState`]:session 级状态;
//! - [`ActiveTurn`] / [`TurnState`]:turn 级状态;
//! - [`SessionServices`]:session 共享服务;
//! - [`AdditionalContextStore`]:额外 context 存储;
//! - [`AutoCompactWindowSnapshot`]:auto compact 滑动窗口。

mod additional_context;
mod auto_compact_window;
mod service;
mod session;
mod turn;

pub(crate) use additional_context::AdditionalContextStore;
pub(crate) use auto_compact_window::AutoCompactWindowIds;
pub(crate) use auto_compact_window::AutoCompactWindowSnapshot;
pub(crate) use service::SessionServices;
pub(crate) use session::SessionState;
pub(crate) use turn::ActiveTurn;
pub(crate) use turn::MailboxDeliveryPhase;
pub(crate) use turn::PendingRequestPermissions;
pub(crate) use turn::RunningTask;
pub(crate) use turn::TaskKind;
pub(crate) use turn::TurnState;
