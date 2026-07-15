//! AGENTS.md 发现与缓存管理。
//!
//! 本模块为会话管理 AGENTS.md 文件的发现结果与缓存，
//! 当 environment 选择变化时自动重新加载。

use crate::agents_md::LoadedAgentsMd;
use crate::agents_md::load_project_instructions;
use crate::config::Config;
use crate::environment_selection::TurnEnvironmentSnapshot;
use codex_extension_api::UserInstructions;
use codex_protocol::protocol::TurnEnvironmentSelection;
use std::sync::Arc;
use tokio::sync::Mutex;

/// 管理会话级 AGENTS.md 发现的输入与缓存结果。
pub(crate) struct AgentsMdManager {
    /// 用户自定义指令文本（若为空则被过滤为 `None`）。
    user_instructions: Option<UserInstructions>,
    /// 发现结果缓存（受 Mutex 保护）。
    cache: Mutex<AgentsMdCache>,
}

/// AGENTS.md 发现结果缓存。
#[derive(Default)]
struct AgentsMdCache {
    /// 上次发现使用的 environment 选择列表。
    selections: Option<Vec<TurnEnvironmentSelection>>,
    /// 已加载的 AGENTS.md 内容。
    loaded: Option<Arc<LoadedAgentsMd>>,
}

impl AgentsMdManager {
    /// 创建一个新的 `AgentsMdManager`。
    ///
    /// 若 `user_instructions` 文本为空，则视为未提供。
    pub(crate) fn new(user_instructions: Option<UserInstructions>) -> Self {
        Self {
            user_instructions: user_instructions
                .filter(|instructions| !instructions.text.trim().is_empty()),
            cache: Mutex::new(AgentsMdCache::default()),
        }
    }

    /// 刷新缓存：当 environment 选择变化时重新加载 AGENTS.md。
    pub(crate) async fn refresh(&self, config: &Config, environments: &TurnEnvironmentSnapshot) {
        let selections = environments.to_selections();
        if self.cache.lock().await.selections.as_ref() == Some(&selections) {
            return;
        }

        let loaded =
            load_project_instructions(config, self.user_instructions.clone(), environments)
                .await
                .map(Arc::new);
        let mut cache = self.cache.lock().await;
        cache.selections = Some(selections);
        cache.loaded = loaded;
    }

    /// 获取已加载的 AGENTS.md 内容（若已缓存）。
    pub(crate) async fn get_loaded(&self) -> Option<Arc<LoadedAgentsMd>> {
        self.cache.lock().await.loaded.clone()
    }

    /// 获取用户自定义指令（克隆）。
    pub(crate) fn user_instructions(&self) -> Option<UserInstructions> {
        self.user_instructions.clone()
    }
}
