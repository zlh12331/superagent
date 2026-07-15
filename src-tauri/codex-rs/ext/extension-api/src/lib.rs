//! Extension API 公共入口。
//!
//! 该 crate 汇总 extension 系统各子模块的公共类型与 trait，作为 extension 开发者
//! 与宿主之间的稳定 API 表面。子模块包括：
//! - [`capabilities`]：extension 运行时能力（如 agent spawner、response injector）。
//! - [`contributors`]：extension 贡献点（如 tool、prompt、context、lifecycle 贡献）。
//! - [`registry`]：extension 注册表与构建器。
//! - [`state`]：extension 共享状态。
//! - [`user_instructions`]：用户指令加载。

mod capabilities;
mod contributors;
mod registry;
mod state;
mod user_instructions;

pub use capabilities::AgentSpawnFuture;
pub use capabilities::AgentSpawner;
pub use capabilities::ExtensionEventSink;
pub use capabilities::NoopExtensionEventSink;
pub use capabilities::NoopResponseItemInjector;
pub use capabilities::ResponseItemInjectionFuture;
pub use capabilities::ResponseItemInjector;
pub use codex_context_fragments::ContextualUserFragment;
pub use codex_protocol::models::ResponseItem;
pub use codex_tools::ConversationHistory;
pub use codex_tools::ExtensionTurnItem;
pub use codex_tools::FunctionCallError;
pub use codex_tools::JsonToolOutput;
pub use codex_tools::NoopTurnItemEmitter;
pub use codex_tools::ResponsesApiTool;
pub use codex_tools::ToolCall;
pub use codex_tools::ToolEnvironment;
pub use codex_tools::ToolExecutor;
pub use codex_tools::ToolExecutorFuture;
pub use codex_tools::ToolName;
pub use codex_tools::ToolOutput;
pub use codex_tools::ToolPayload;
pub use codex_tools::ToolSpec;
pub use codex_tools::TurnItemEmissionFuture;
pub use codex_tools::TurnItemEmitter;
pub use codex_tools::parse_tool_input_schema;
pub use codex_tools::parse_tool_input_schema_without_compaction;
pub use contributors::ApprovalReviewContributor;
pub use contributors::ConfigContributor;
pub use contributors::ContextContributor;
pub use contributors::ExtensionFuture;
pub use contributors::McpServerContribution;
pub use contributors::McpServerContributionContext;
pub use contributors::McpServerContributor;
pub use contributors::PreviousWorldStateSection;
pub use contributors::PromptFragment;
pub use contributors::PromptSlot;
pub use contributors::RenderedWorldStateFragment;
pub use contributors::ThreadIdleInput;
pub use contributors::ThreadLifecycleContributor;
pub use contributors::ThreadResumeInput;
pub use contributors::ThreadStartInput;
pub use contributors::ThreadStopInput;
pub use contributors::TokenUsageContributor;
pub use contributors::ToolCallOutcome;
pub use contributors::ToolCallSource;
pub use contributors::ToolContributor;
pub use contributors::ToolFinishInput;
pub use contributors::ToolLifecycleContributor;
pub use contributors::ToolLifecycleFuture;
pub use contributors::ToolStartInput;
pub use contributors::TurnAbortInput;
pub use contributors::TurnContextContributionInput;
pub use contributors::TurnErrorInput;
pub use contributors::TurnInputContext;
pub use contributors::TurnInputContributor;
pub use contributors::TurnInputEnvironment;
pub use contributors::TurnItemContributor;
pub use contributors::TurnLifecycleContributor;
pub use contributors::TurnStartInput;
pub use contributors::TurnStopInput;
pub use contributors::WorldStateContributionInput;
pub use contributors::WorldStateSectionContribution;
pub use registry::ExtensionRegistry;
pub use registry::ExtensionRegistryBuilder;
pub use registry::empty_extension_registry;
pub use state::ExtensionData;
pub use state::ExtensionDataInit;
pub use user_instructions::LoadUserInstructionsFuture;
pub use user_instructions::LoadedUserInstructions;
pub use user_instructions::UserInstructions;
pub use user_instructions::UserInstructionsProvider;
