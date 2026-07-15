//! Skills 扩展主实现模块。
//!
//! 该模块实现了 skills 扩展的核心 `SkillsExtension` 结构体，并为其实现 5 个
//! contributor trait 以参与会话生命周期：
//! - `ThreadLifecycleContributor`：管理 thread 级状态的初始化
//! - `ConfigContributor`：响应配置变更并更新 thread 状态
//! - `ContextContributor`：贡献 thread 上下文和 world state section
//! - `ToolContributor`：提供 skills/list 和 skills/read 工具
//! - `TurnInputContributor`：处理用户输入，提取 skill mention 并注入主 prompt
//!
//! 该扩展是 skills 系统的编排中心，协调多个 provider、缓存、渲染和工具模块。

use std::sync::Arc;

use codex_core_skills::HostSkillsSnapshot;
use codex_core_skills::injection::InjectedHostSkillPrompts;
use codex_exec_server::LOCAL_ENVIRONMENT_ID;
use codex_extension_api::ConfigContributor;
use codex_extension_api::ContextContributor;
use codex_extension_api::ContextualUserFragment;
use codex_extension_api::ExtensionData;
use codex_extension_api::ExtensionEventSink;
use codex_extension_api::ExtensionFuture;
use codex_extension_api::ExtensionRegistryBuilder;
use codex_extension_api::PromptFragment;
use codex_extension_api::ThreadLifecycleContributor;
use codex_extension_api::ThreadStartInput;
use codex_extension_api::ToolCall;
use codex_extension_api::ToolContributor;
use codex_extension_api::ToolExecutor;
use codex_extension_api::TurnInputContext;
use codex_extension_api::TurnInputContributor;
use codex_extension_api::WorldStateContributionInput;
use codex_extension_api::WorldStateSectionContribution;
use codex_mcp::McpResourceClient;
use codex_protocol::openai_models::ModelInfo;
use codex_protocol::protocol::Event;
use codex_protocol::protocol::EventMsg;
use codex_protocol::protocol::WarningEvent;

use crate::SkillsExtensionConfig;
use crate::catalog::SkillCatalog;
use crate::catalog::SkillCatalogEntry;
use crate::catalog::SkillReadResult;
use crate::catalog::SkillSourceKind;
use crate::fragments::SkillInstructions;
use crate::provider::HostSkillProvider;
use crate::provider::SkillListQuery;
use crate::provider::SkillReadRequest;
use crate::render::MAX_SKILL_NAME_BYTES;
use crate::render::MAX_SKILL_PATH_BYTES;
use crate::render::available_skills_fragment;
use crate::render::truncate_main_prompt_contents;
use crate::render::truncate_utf8_to_bytes;
use crate::selection::collect_explicit_skill_mentions;
use crate::sources::SkillProviders;
use crate::state::ExecutorSkillsStepState;
use crate::state::SkillsThreadState;
use crate::state::SkillsTurnState;
use crate::tools::skill_tools;
use crate::world_state::executor_skills_world_state_section;

/// Skills 扩展主结构体，持有 provider 集合、事件 sink 和配置提取函数。
///
/// 泛型参数 `C` 表示宿主配置类型，通过 `config_from_host` 闭包从该类型提取
/// skills 扩展自身的配置。
struct SkillsExtension<C> {
    /// 已注册的 skill provider 集合
    providers: SkillProviders,
    /// 事件 sink，用于向宿主发送警告等事件
    event_sink: Arc<dyn ExtensionEventSink>,
    /// 从宿主配置中提取 skills 扩展配置的闭包
    config_from_host: Arc<dyn Fn(&C) -> SkillsExtensionConfig + Send + Sync>,
}

impl<C> ThreadLifecycleContributor<C> for SkillsExtension<C>
where
    C: Send + Sync + 'static,
{
    /// 在 thread 启动时初始化 thread 级状态。
    ///
    /// 判断 orchestrator skills 是否可用（当存在非本地环境时可用），
    /// 并将 `SkillsThreadState` 插入 thread store。
    fn on_thread_start<'a>(&'a self, input: ThreadStartInput<'a, C>) -> ExtensionFuture<'a, ()> {
        Box::pin(async move {
            // 当存在非本地环境时，orchestrator skills 可用
            let orchestrator_skills_available = !input
                .environments
                .iter()
                .any(|environment| environment.environment_id == LOCAL_ENVIRONMENT_ID);
            input.thread_store.insert(SkillsThreadState::new(
                (self.config_from_host)(input.config),
                orchestrator_skills_available,
            ));
        })
    }
}

impl<C> ConfigContributor<C> for SkillsExtension<C>
where
    C: Send + Sync + 'static,
{
    /// 在配置变更时更新 thread 级状态中的 skills 配置。
    ///
    /// 若 thread 状态已存在则更新，否则创建新的 thread 状态（默认 orchestrator 可用）。
    fn on_config_changed(
        &self,
        _session_store: &ExtensionData,
        thread_store: &ExtensionData,
        _previous_config: &C,
        new_config: &C,
    ) {
        let next_config = (self.config_from_host)(new_config);
        if let Some(state) = thread_store.get::<SkillsThreadState>() {
            state.set_config(next_config);
        } else {
            let orchestrator_skills_available = true;
            thread_store.insert(SkillsThreadState::new(
                next_config,
                orchestrator_skills_available,
            ));
        }
    }
}

impl<C> ContextContributor for SkillsExtension<C>
where
    C: Send + Sync + 'static,
{
    /// 贡献 thread 级上下文，生成 available skills 的 prompt fragment。
    ///
    /// 仅在配置启用 `include_instructions` 时贡献。列出 host 和 bundled skills
    /// （不含 executor skills），并将警告通过 event_sink 发送。
    fn contribute_thread_context<'a>(
        &'a self,
        session_store: &'a ExtensionData,
        thread_store: &'a ExtensionData,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<PromptFragment>> + Send + 'a>> {
        Box::pin(async move {
            let Some(thread_state) = thread_store.get::<SkillsThreadState>() else {
                return Vec::new();
            };
            let config = thread_state.config();
            if !config.include_instructions {
                return Vec::new();
            }
            let catalog = self
                .list_skills(
                    SkillListQuery {
                        turn_id: thread_store.level_id().to_string(),
                        executor_roots: Vec::new(),
                        host_snapshot: None,
                        include_host_skills: false,
                        include_bundled_skills: config.bundled_skills_enabled,
                        include_orchestrator_skills: thread_state.orchestrator_skills_enabled(),
                        mcp_resources: session_store.get::<McpResourceClient>(),
                    },
                    &thread_state,
                )
                .await;
            for warning in &catalog.warnings {
                self.emit_warning(thread_store.level_id(), warning.clone());
            }
            let include_usage = thread_store
                .get::<ModelInfo>()
                .is_some_and(|model_info| model_info.include_skills_usage_instructions);
            available_skills_fragment(&catalog, include_usage)
                .map(|fragment| PromptFragment::developer_capability(fragment.render()))
                .into_iter()
                .collect()
        })
    }

    /// 贡献 world state section，展示 executor skills 的可用列表。
    ///
    /// 列出指定 executor roots 下的 skills（不含 orchestrator），将结果存入
    /// turn store 供后续 turn input 处理使用。
    fn contribute_world_state<'a>(
        &'a self,
        input: WorldStateContributionInput<'a>,
    ) -> ExtensionFuture<'a, Vec<WorldStateSectionContribution>> {
        Box::pin(async move {
            let Some(thread_state) = input.thread_store.get::<SkillsThreadState>() else {
                return Vec::new();
            };
            let config = thread_state.config();
            let catalog = thread_state
                .executor_catalog_snapshot(
                    &self.providers,
                    SkillListQuery {
                        turn_id: input.turn_id.to_string(),
                        executor_roots: input.ready_selected_capability_roots.to_vec(),
                        host_snapshot: None,
                        include_host_skills: false,
                        include_bundled_skills: config.bundled_skills_enabled,
                        include_orchestrator_skills: false,
                        mcp_resources: input.session_store.get::<McpResourceClient>(),
                    },
                )
                .await;
            input
                .turn_store
                .insert(ExecutorSkillsStepState(catalog.clone()));
            let include_usage = input
                .thread_store
                .get::<ModelInfo>()
                .is_some_and(|model_info| model_info.include_skills_usage_instructions);
            vec![executor_skills_world_state_section(
                &catalog,
                config.include_instructions,
                include_usage,
            )]
        })
    }
}

impl<C> ToolContributor for SkillsExtension<C>
where
    C: Send + Sync + 'static,
{
    /// 提供 skills 工具（list 和 read）。
    ///
    /// 仅在存在 orchestrator provider 且 orchestrator skills 启用时提供工具。
    fn tools(
        &self,
        session_store: &ExtensionData,
        thread_store: &ExtensionData,
    ) -> Vec<Arc<dyn ToolExecutor<ToolCall>>> {
        let Some(thread_state) = thread_store.get::<SkillsThreadState>() else {
            return Vec::new();
        };
        if !self.providers.has_orchestrator_provider()
            || !thread_state.orchestrator_skills_enabled()
        {
            return Vec::new();
        }

        skill_tools(
            self.providers.clone(),
            session_store.get::<McpResourceClient>(),
            thread_state,
        )
    }
}

impl<C> TurnInputContributor for SkillsExtension<C>
where
    C: Send + Sync + 'static,
{
    /// 处理用户输入，提取显式 skill mention 并注入对应的主 prompt。
    ///
    /// 流程概述：
    /// 1. 列出所有可用 skills（host + bundled + executor + orchestrator）
    /// 2. 从用户输入中提取显式 skill mention（通过 @mention 或 skill:// 路径）
    /// 3. 读取每个选中 skill 的主 prompt 并截断到限制以内
    /// 4. 生成 available skills fragment（仅含 host 和 bundled skills）
    /// 5. 将结果存入 turn store 并返回 fragments
    fn contribute<'a>(
        &'a self,
        input: TurnInputContext,
        session_store: &'a ExtensionData,
        thread_store: &'a ExtensionData,
        turn_store: &'a ExtensionData,
    ) -> ExtensionFuture<'a, Vec<Box<dyn ContextualUserFragment + Send>>> {
        Box::pin(async move {
            let Some(thread_state) = thread_store.get::<SkillsThreadState>() else {
                return Vec::new();
            };

            let config = thread_state.config();
            let host_snapshot = turn_store.get::<HostSkillsSnapshot>();
            let query = SkillListQuery {
                turn_id: input.turn_id.clone(),
                executor_roots: Vec::new(),
                host_snapshot: host_snapshot.clone(),
                include_host_skills: true,
                include_bundled_skills: config.bundled_skills_enabled,
                include_orchestrator_skills: thread_state.orchestrator_skills_enabled(),
                mcp_resources: session_store.get::<McpResourceClient>(),
            };
            let mut catalog = self.list_skills(query, &thread_state).await;
            if let Some(executor_skills) = turn_store.get::<ExecutorSkillsStepState>() {
                catalog.extend(executor_skills.0.clone());
            }
            for warning in &catalog.warnings {
                self.emit_warning(&input.turn_id, warning.clone());
            }

            // 从用户输入中提取显式 skill mention
            let selected_entries = collect_explicit_skill_mentions(&input.user_input, &catalog);
            let mut fragments: Vec<Box<dyn ContextualUserFragment + Send>> = Vec::new();
            if config.include_instructions {
                // available skills fragment 仅展示 host 和 bundled skills，
                // executor 和 orchestrator skills 通过 world state 或工具调用访问
                let mut turn_catalog = catalog.clone();
                turn_catalog.entries.retain(|entry| {
                    entry.authority.kind != SkillSourceKind::Executor
                        && entry.authority.kind != SkillSourceKind::Orchestrator
                });
                let include_usage = thread_store
                    .get::<ModelInfo>()
                    .is_some_and(|model_info| model_info.include_skills_usage_instructions);
                if let Some(fragment) = available_skills_fragment(&turn_catalog, include_usage) {
                    fragments.push(Box::new(fragment));
                }
            }

            let mut warnings = catalog.warnings.clone();
            let mut main_prompts_injected = false;
            let mut injected_host_skill_prompts = InjectedHostSkillPrompts::default();
            for entry in &selected_entries {
                match self
                    .read_main_prompt(entry, host_snapshot.clone(), session_store, &thread_state)
                    .await
                {
                    Ok(read_result) => {
                        // 截断主 prompt 内容到限制以内
                        let (contents, truncated) =
                            truncate_main_prompt_contents(read_result.contents.as_str());
                        if truncated {
                            let warning = format!(
                                "Skill `{}` exceeded the main prompt context limit and was truncated.",
                                entry.name
                            );
                            self.emit_warning(&input.turn_id, warning.clone());
                            warnings.push(warning);
                        }
                        let fragment = SkillInstructions {
                            name: truncate_utf8_to_bytes(&entry.name, MAX_SKILL_NAME_BYTES).0,
                            path: truncate_utf8_to_bytes(
                                entry.rendered_path(),
                                MAX_SKILL_PATH_BYTES,
                            )
                            .0,
                            contents,
                        };
                        fragments.push(Box::new(fragment));
                        main_prompts_injected = true;
                        // 记录已注入的 host skill 路径，供后续去重使用
                        if entry.authority.kind == SkillSourceKind::Host {
                            injected_host_skill_prompts.insert_path(entry.main_prompt.as_str());
                        }
                    }
                    Err(message) => {
                        let warning = format!("Failed to load skill `{}`: {message}", entry.name);
                        self.emit_warning(&input.turn_id, warning.clone());
                        warnings.push(warning);
                    }
                }
            }

            // 对于非 host 来源但名称匹配 host skill 的选中条目，
            // 也注入对应的 host skill prompt 路径以支持去重
            if let Some(host_snapshot) = &host_snapshot {
                for entry in selected_entries
                    .iter()
                    .filter(|entry| entry.authority.kind != SkillSourceKind::Host)
                {
                    for host_skill in host_snapshot
                        .outcome()
                        .skills
                        .iter()
                        .filter(|host_skill| host_skill.name == entry.name)
                    {
                        injected_host_skill_prompts
                            .insert_path(host_skill.path_to_skills_md.to_string_lossy());
                    }
                }
            }

            turn_store.insert(SkillsTurnState {
                catalog,
                selected_entries,
                warnings,
                main_prompts_injected,
            });
            if !injected_host_skill_prompts.is_empty() {
                turn_store.insert(injected_host_skill_prompts);
            }

            fragments
        })
    }
}

impl<C> SkillsExtension<C> {
    /// 列出当前 turn 可用的 skills。
    ///
    /// 先列出非 orchestrator 来源的 skills，再按需列出 orchestrator skills
    /// （使用 thread 级缓存避免重复发现）。
    #[tracing::instrument(level = "trace", skip_all)]
    async fn list_skills(
        &self,
        mut query: SkillListQuery,
        thread_state: &SkillsThreadState,
    ) -> SkillCatalog {
        let include_orchestrator_skills = query.include_orchestrator_skills;
        let orchestrator_query = query.clone();
        let mcp_resources = orchestrator_query.mcp_resources.clone();
        query.include_orchestrator_skills = false;

        let mut catalog = self.providers.list_for_turn(query).await;
        if include_orchestrator_skills {
            let orchestrator_catalog = thread_state
                .orchestrator_catalog_snapshot(
                    mcp_resources.as_deref(),
                    self.providers
                        .list_orchestrator_for_turn(orchestrator_query),
                )
                .await;
            catalog.extend(orchestrator_catalog);
        }
        catalog
    }

    /// 读取指定 skill 条目的主 prompt。
    ///
    /// 通过 thread 级状态路由到正确的 provider，orchestrator 来源使用缓存。
    #[tracing::instrument(level = "trace", skip_all, fields(skill = %entry.name))]
    async fn read_main_prompt(
        &self,
        entry: &SkillCatalogEntry,
        host_snapshot: Option<Arc<HostSkillsSnapshot>>,
        session_store: &ExtensionData,
        thread_state: &SkillsThreadState,
    ) -> Result<SkillReadResult, String> {
        thread_state
            .read_skill(
                &self.providers,
                SkillReadRequest {
                    authority: entry.authority.clone(),
                    package: entry.id.clone(),
                    resource: entry.main_prompt.clone(),
                    host_snapshot,
                    mcp_resources: session_store.get::<McpResourceClient>(),
                },
            )
            .await
            .map_err(|err| err.message)
    }

    /// 通过 event sink 发送警告事件。
    fn emit_warning(&self, turn_id: &str, message: String) {
        self.event_sink.emit(Event {
            id: turn_id.to_string(),
            msg: EventMsg::Warning(WarningEvent { message }),
        });
    }
}

/// 安装 skills 扩展，使用默认的 host provider。
///
/// # 参数
/// - `registry`：扩展注册构建器
/// - `config_from_host`：从宿主配置提取 skills 扩展配置的闭包
pub fn install<C>(
    registry: &mut ExtensionRegistryBuilder<C>,
    config_from_host: impl Fn(&C) -> SkillsExtensionConfig + Send + Sync + 'static,
) where
    C: Send + Sync + 'static,
{
    install_with_providers(
        registry,
        SkillProviders::new().with_host_provider(Arc::new(HostSkillProvider::new())),
        config_from_host,
    );
}

/// 安装 skills 扩展，使用自定义的 provider 集合。
///
/// # 参数
/// - `registry`：扩展注册构建器
/// - `providers`：已配置好的 skill provider 集合
/// - `config_from_host`：从宿主配置提取 skills 扩展配置的闭包
pub fn install_with_providers<C>(
    registry: &mut ExtensionRegistryBuilder<C>,
    providers: SkillProviders,
    config_from_host: impl Fn(&C) -> SkillsExtensionConfig + Send + Sync + 'static,
) where
    C: Send + Sync + 'static,
{
    let extension = Arc::new(SkillsExtension {
        providers,
        event_sink: registry.event_sink(),
        config_from_host: Arc::new(config_from_host),
    });
    registry.thread_lifecycle_contributor(extension.clone());
    registry.config_contributor(extension.clone());
    registry.prompt_contributor(extension.clone());
    registry.turn_input_contributor(extension.clone());
    registry.tool_contributor(extension);
}
