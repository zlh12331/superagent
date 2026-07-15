//! agent(子代理)子系统模块。
//!
//! 集中管理多 agent 场景下的子代理注册、角色定义、状态追踪与控制流。
//!
//! # 子模块
//! - [`agent_resolver`]:根据用户提及或上下文解析要使用的 agent。
//! - [`control`]:agent 的执行控制(`AgentControl`)。
//! - [`registry`]:agent 注册表,提供 spawn 深度限制等查询。
//! - [`role`]:agent 角色定义。
//! - [`status`]:基于事件推导 agent 状态。
//!
//! # 与其他模块的关系
//! 上层 session 在多 agent 模式下通过本模块派生子 thread,
//! 并通过 [`AgentStatus`] 与 [`AgentControl`] 与之交互。

pub(crate) mod agent_resolver;
pub(crate) mod control;
mod registry;
pub(crate) mod role;
pub(crate) mod status;

pub(crate) use codex_protocol::protocol::AgentStatus;
pub(crate) use control::AgentControl;
pub(crate) use registry::exceeds_thread_spawn_depth_limit;
pub(crate) use registry::next_thread_spawn_depth;
pub(crate) use status::agent_status_from_event;
