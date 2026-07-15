//! Guardian extension 模块。
//!
//! 该模块实现 [`GuardianExtension`]，负责在 thread 启动时捕获
//! guardian 子代理的 fork 上下文，并提供 spawn subagent 的代理方法。
//!
//! Guardian 子代理通常用于代码审查、安全检查等场景，从主 thread fork 出来
//! 执行独立任务后返回结果。

use std::sync::Arc;

use codex_core::config::Config;
use codex_extension_api::AgentSpawnFuture;
use codex_extension_api::AgentSpawner;
use codex_extension_api::ExtensionFuture;
use codex_extension_api::ExtensionRegistryBuilder;
use codex_extension_api::ThreadLifecycleContributor;
use codex_extension_api::ThreadStartInput;
use codex_protocol::ThreadId;

/// Guardian extension，由 host 在构造时注入依赖。
///
/// 泛型 `S` 为 agent spawner，负责实际创建 guardian 子代理。
#[derive(Clone, Debug)]
pub struct GuardianExtension<S> {
    /// host 提供的 agent spawn 辅助器
    agent_spawner: S,
}

impl<S> GuardianExtension<S> {
    /// 创建 guardian extension，传入 host 提供的 agent spawn 辅助器。
    pub fn new(agent_spawner: S) -> Self {
        Self { agent_spawner }
    }

    /// 委托一次 guardian 子代理 spawn 请求给 host 辅助器。
    ///
    /// # 泛型
    /// - `R`：spawn 请求类型
    ///
    /// # 返回
    /// 返回 `AgentSpawnFuture`，解析为 spawned agent 或错误。
    pub fn spawn_subagent<'a, R>(
        &'a self,
        forked_from_thread_id: ThreadId,
        request: R,
    ) -> AgentSpawnFuture<'a, <S as AgentSpawner<R>>::Spawned, <S as AgentSpawner<R>>::Error>
    where
        S: AgentSpawner<R>,
    {
        self.agent_spawner
            .spawn_subagent(forked_from_thread_id, request)
    }
}

/// Thread 级 guardian 状态，在 host 启动 thread 时捕获。
///
/// 记录该 thread 的 guardian 子代理默认应从哪个 thread fork。
#[derive(Clone, Copy, Debug)]
pub struct GuardianThreadContext {
    /// guardian 子代理默认 fork 的源 thread ID
    forked_from_thread_id: ThreadId,
}

impl GuardianThreadContext {
    /// 返回 guardian 子代理默认应 fork 的源 thread ID。
    pub fn forked_from_thread_id(&self) -> ThreadId {
        self.forked_from_thread_id
    }
}

impl<S> ThreadLifecycleContributor<Config> for GuardianExtension<S>
where
    S: Send + Sync,
{
    /// thread 启动时：捕获 thread ID 作为 guardian 子代理的默认 fork 源。
    fn on_thread_start<'a>(
        &'a self,
        input: ThreadStartInput<'a, Config>,
    ) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            let Ok(forked_from_thread_id) = ThreadId::from_string(input.thread_store.level_id())
            else {
                return;
            };
            input.thread_store.insert(GuardianThreadContext {
                forked_from_thread_id,
            });
        })
    }
}

/// 安装 guardian contributors 到 extension registry。
///
/// 注册 `ThreadLifecycleContributor` 以捕获每个 thread 的 fork 上下文。
pub fn install<S>(registry: &mut ExtensionRegistryBuilder<Config>, agent_spawner: S)
where
    S: Send + Sync + 'static,
{
    registry.thread_lifecycle_contributor(Arc::new(GuardianExtension::new(agent_spawner)));
}
