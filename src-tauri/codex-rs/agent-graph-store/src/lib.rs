//! 存储-中立 的 父/子 拓扑结构，用于 thread spawn 出来的 agent。
//!
//! 本 crate 只描述 agent 之间"谁派生谁"的边（edge），不关心具体存储后端，
//! 这样可以在不同实现（本地内存、远端服务等）之间复用同一套类型与接口。

mod error;
mod local;
mod store;
mod types;

pub use error::AgentGraphStoreError;
pub use error::AgentGraphStoreResult;
pub use local::LocalAgentGraphStore;
pub use store::AgentGraphStore;
pub use store::AgentGraphStoreFuture;
pub use types::ThreadSpawnEdgeStatus;
