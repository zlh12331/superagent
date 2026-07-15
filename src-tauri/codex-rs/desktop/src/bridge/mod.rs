//! Codex runtime bridge 层。
//!
//! 本模块将 codex-rs API 变更与应用程序其余部分隔离。
//! 所有与 codex-rs 的交互都通过本 bridge 进行，因此 codex-rs 内部的变更
//! 只需在此处更新，无需修改命令处理器或前端。
//!
//! ## 子模块
//!
//! | 模块        | 职责                                                    |
//! |-------------|---------------------------------------------------------|
//! | `runtime`   | In-process codex-rs 生命周期（start/stop/event loop） |
//! | `event`     | 事件类型转换（codex-rs → Tauri emit）                 |
//! | `approval`  | Server request / 审批流程                              |
//! | `mapper`    | 纯映射函数：codex-rs 类型 → 应用类型                 |
//! | `trait`     | `CodexClientHandle` 抽象：用于依赖注入                 |
//!
//! ## 状态
//!
//! 已完成全部 bridge 层实现：
//! - `runtime` — init_app_server + 事件循环 + graceful shutdown（含 thread/unsubscribe）
//! - `event` — InProcessServerEvent → Tauri emit + approval 注册 + TurnCompleted backfill
//! - `approval` — pending request 存储 + respond/reject + clear
//! - `mapper` — 纯映射函数（request_id_of / is_approval_request / is_turn_completed）
//! - `trait_def` — CodexClientHandle async trait + blanket impl for InProcessClientSender
//! - `request` — send_request + send_request_with_timeout（30s 默认超时）

pub mod approval;
pub mod event;
pub mod mapper;
pub mod request;
pub mod runtime;
// trait_def 仅用于测试（依赖注入 + mockall），
// async-trait 是 dev-dependency，不能在主构建中使用
#[cfg(test)]
pub mod trait_def;
