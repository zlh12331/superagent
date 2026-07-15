//! rollout(会话历史)模块。
//!
//! 该模块作为 `codex-rollout` crate 的薄封装,集中 re-export 与 rollout 持久化、
//! thread 列表查询、会话元数据读取相关的类型与函数。
//!
//! # 架构位置
//! 上层(TUI / app-server)通过本模块的 re-export 查询历史 thread、读取会话元数据,
//! 底层 session 在 turn 进行过程中通过 [`RolloutRecorder`] 将 turn 事件持久化到磁盘。
//!
//! # 配置桥接
//! 本模块还为 [`Config`] 实现了 [`codex_rollout::RolloutConfigView`],
//! 让 rollout 子系统能以 trait 对象的方式访问所需配置字段,避免直接依赖 `Config`。

use crate::config::Config;
pub use codex_rollout::ARCHIVED_SESSIONS_SUBDIR;
pub use codex_rollout::Cursor;
pub use codex_rollout::INTERACTIVE_SESSION_SOURCES;
pub use codex_rollout::RolloutRecorder;
pub use codex_rollout::RolloutRecorderParams;
pub use codex_rollout::SESSIONS_SUBDIR;
pub use codex_rollout::SessionMeta;
pub use codex_rollout::SortDirection;
pub use codex_rollout::ThreadItem;
pub use codex_rollout::ThreadSortKey;
pub use codex_rollout::ThreadsPage;
pub use codex_rollout::append_thread_name;
pub use codex_rollout::find_archived_thread_path_by_id_str;
#[deprecated(note = "use find_thread_path_by_id_str")]
pub use codex_rollout::find_conversation_path_by_id_str;
pub use codex_rollout::find_thread_meta_by_name_str;
pub use codex_rollout::find_thread_name_by_id;
pub use codex_rollout::find_thread_names_by_ids;
pub use codex_rollout::find_thread_path_by_id_str;
pub use codex_rollout::parse_cursor;
pub use codex_rollout::read_head_for_summary;
pub use codex_rollout::read_session_meta_line;
pub use codex_rollout::rollout_date_parts;

/// 为 [`Config`] 实现 rollout 子系统所需的配置视图。
///
/// 通过该 trait 实现,rollout 子系统可以在不直接依赖 `Config` 的情况下,
/// 以 trait 对象方式访问 codex_home、sqlite_home、cwd、model_provider_id 等字段。
impl codex_rollout::RolloutConfigView for Config {
    fn codex_home(&self) -> &std::path::Path {
        self.codex_home.as_path()
    }

    fn sqlite_home(&self) -> &std::path::Path {
        self.sqlite_home.as_path()
    }

    fn cwd(&self) -> &std::path::Path {
        self.cwd.as_path()
    }

    fn model_provider_id(&self) -> &str {
        self.model_provider_id.as_str()
    }

    fn generate_memories(&self) -> bool {
        self.memories.generate_memories
    }
}

/// 内部使用的 rollout 列表查询函数集合。
pub(crate) mod list {
    pub use codex_rollout::find_thread_path_by_id_str;
}

/// 测试用途的 rollout recorder re-export。
#[cfg(test)]
pub(crate) mod recorder {
    pub use codex_rollout::RolloutRecorder;
}

pub(crate) use crate::session_rollout_init_error::map_session_init_error;

/// rollout 截断(truncation)相关功能的内部 re-export。
pub(crate) mod truncation {
    pub(crate) use crate::thread_rollout_truncation::*;
}
