//! 存储无关的线程（thread）持久化接口。
//!
//! 应用层应将 [`codex_protocol::ThreadId`] 视为唯一的持久化线程句柄。
//! 各实现负责将该 ID 解析为本地 rollout 文件、RPC 请求或任何其他后端存储。
//!
//! 核心类型：[`ThreadStore`]、[`LocalThreadStore`]、[`InMemoryThreadStore`]、
//! [`LiveThread`]。

mod error;
mod in_memory;
mod live_thread;
mod local;
mod store;
mod thread_metadata_sync;
mod types;

/// 线程存储错误类型。
pub use error::ThreadStoreError;
/// 线程存储操作结果类型别名。
pub use error::ThreadStoreResult;
/// 内存线程存储实现（主要用于测试）。
pub use in_memory::InMemoryThreadStore;
/// 内存线程存储调用记录（用于测试断言）。
pub use in_memory::InMemoryThreadStoreCalls;
/// 活跃线程句柄：代表一个正在运行的线程。
pub use live_thread::LiveThread;
/// 活跃线程初始化守卫：在线程初始化期间持有，确保初始化互斥。
pub use live_thread::LiveThreadInitGuard;
/// 本地线程存储实现：基于磁盘 rollout 文件。
pub use local::LocalThreadStore;
/// 本地线程存储配置。
pub use local::LocalThreadStoreConfig;
/// 线程存储抽象 trait：定义线程持久化的核心操作。
pub use store::ThreadStore;
/// `ThreadStore` 方法返回的 future 类型别名。
pub use store::ThreadStoreFuture;
/// 追加线程条目的参数。
pub use types::AppendThreadItemsParams;
/// 归档线程的参数。
pub use types::ArchiveThreadParams;
/// 可清空的字段标识。
pub use types::ClearableField;
/// 创建线程的参数。
pub use types::CreateThreadParams;
/// 删除线程的参数。
pub use types::DeleteThreadParams;
/// 线程额外配置（extra config）。
pub use types::ExtraConfig;
/// Git 信息补丁：用于更新线程关联的 Git 元数据。
pub use types::GitInfoPatch;
/// 单页条目（item）结果。
pub use types::ItemPage;
/// 列举条目的参数。
pub use types::ListItemsParams;
/// 列举线程的参数。
pub use types::ListThreadsParams;
/// 列举 turn 的参数。
pub use types::ListTurnsParams;
/// 加载线程历史的参数。
pub use types::LoadThreadHistoryParams;
/// 按 rollout 路径读取线程的参数。
pub use types::ReadThreadByRolloutPathParams;
/// 读取线程的参数。
pub use types::ReadThreadParams;
/// 恢复线程的参数。
pub use types::ResumeThreadParams;
/// 搜索线程的参数。
pub use types::SearchThreadsParams;
/// 排序方向（升序/降序）。
pub use types::SortDirection;
/// 已存储的线程数据。
pub use types::StoredThread;
/// 已存储的线程历史。
pub use types::StoredThreadHistory;
/// 已存储的线程条目。
pub use types::StoredThreadItem;
/// 线程搜索结果。
pub use types::StoredThreadSearchResult;
/// 已存储的 turn 数据。
pub use types::StoredTurn;
/// 已存储的 turn 错误信息。
pub use types::StoredTurnError;
/// 已存储的 turn 条目视图。
pub use types::StoredTurnItemsView;
/// 已存储的 turn 状态。
pub use types::StoredTurnStatus;
/// 线程元数据补丁：用于部分更新线程元数据。
pub use types::ThreadMetadataPatch;
/// 单页线程结果。
pub use types::ThreadPage;
/// 线程持久化元数据。
pub use types::ThreadPersistenceMetadata;
/// 线程关系过滤器。
pub use types::ThreadRelationFilter;
/// 线程搜索分页结果。
pub use types::ThreadSearchPage;
/// 线程排序键。
pub use types::ThreadSortKey;
/// 单页 turn 结果。
pub use types::TurnPage;
/// 更新线程元数据的参数。
pub use types::UpdateThreadMetadataParams;
