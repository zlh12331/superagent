//! State DB bridge 模块。
//!
//! 作为 codex-core 对 [`codex_rollout::state_db`] 的薄封装层,
//! 屏蔽底层 rollout crate 的细节,向 core 内部暴露统一的
//! state database 初始化入口与 handle 类型。
//!
//! 这样设计是为了隔离 rollout 存储层的 API 变化,
//! 遵循项目"低耦合高内聚"原则。

use codex_rollout::state_db as rollout_state_db;
pub use codex_rollout::state_db::StateDbHandle;

use crate::config::Config;

pub async fn init_state_db(config: &Config) -> Option<StateDbHandle> {
    rollout_state_db::init(config).await
}
