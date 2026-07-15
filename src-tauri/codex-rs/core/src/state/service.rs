use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use crate::SkillsService;
use crate::agent::AgentControl;
use crate::agents_md_manager::AgentsMdManager;
use crate::attestation::AttestationProvider;
use crate::client::ModelClient;
use crate::config::NetworkProxyAuditMetadata;
use crate::config::StartedNetworkProxy;
use crate::current_time::TimeProvider;
use crate::environment_selection::ThreadEnvironments;
use crate::exec_policy::ExecPolicyManager;
use crate::guardian::GuardianRejection;
use crate::guardian::GuardianRejectionCircuitBreaker;
use crate::mcp::McpManager;
use crate::session::McpRuntimeSnapshot;
use crate::tools::code_mode::CodeModeService;
use crate::tools::handlers::ToolSearchHandlerCache;
use crate::tools::network_approval::NetworkApprovalService;
use crate::tools::sandboxing::ApprovalStore;
use crate::unified_exec::UnifiedExecProcessManager;
use anyhow::Result;
use arc_swap::ArcSwap;
use arc_swap::ArcSwapOption;
use codex_analytics::AnalyticsEventsClient;
use codex_core_plugins::PluginsManager;
use codex_extension_api::ExtensionData;
use codex_extension_api::ExtensionDataInit;
use codex_extension_api::ExtensionRegistry;
use codex_hooks::Hooks;
use codex_login::AuthManager;
use codex_mcp::McpConfig;
use codex_mcp::McpConnectionManager;
use codex_mcp::McpRuntimeContext;
use codex_models_manager::manager::SharedModelsManager;
use codex_otel::SessionTelemetry;
use codex_protocol::capabilities::SelectedCapabilityRoot;
use codex_rollout::state_db::StateDbHandle;
use codex_rollout_trace::ThreadTraceContext;
use codex_thread_store::LiveThread;
use codex_thread_store::ThreadStore;
use std::path::PathBuf;
use tokio::runtime::Handle;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

/// 会话级服务集合，聚合了一个会话生命周期内需要的全部运行时组件。
///
/// 该结构持有 MCP 连接管理器、模型客户端、工具审批存储、网络代理、扩展注册表等核心组件，
/// 供会话期间的各个 turn 共享使用。所有字段均为 `pub(crate)`，仅在 crate 内可见。
pub(crate) struct SessionServices {
    /// 旧版扩展资源客户端使用的最新 MCP 连接管理器镜像，针对早于 runtime snapshot 机制的调用方。
    pub(crate) mcp_connection_manager: Arc<ArcSwap<McpConnectionManager>>,
    /// 最新原子化发布的 MCP 配置与管理器配对（runtime snapshot）。
    pub(crate) mcp_runtime: ArcSwapOption<McpRuntimeSnapshot>,
    /// 序列化由环境驱动的 runtime 重建操作，避免并发重建导致状态不一致。
    pub(crate) mcp_projection_lock: Mutex<()>,
    /// MCP 启动过程的取消令牌，用于在重启或关闭时中断启动流程。
    pub(crate) mcp_startup_cancellation_token: Mutex<CancellationToken>,
    /// 统一执行（unified_exec）进程管理器，负责长生命周期子进程的复用与调度。
    pub(crate) unified_exec_manager: UnifiedExecProcessManager,
    /// 可选的 zsh 可执行路径（仅 Unix 使用），用于 shell 快照与 execve 包装。
    #[cfg_attr(not(unix), allow(dead_code))]
    pub(crate) shell_zsh_path: Option<PathBuf>,
    /// 主 execve 包装器可执行文件路径（仅 Unix 使用）。
    #[cfg_attr(not(unix), allow(dead_code))]
    pub(crate) main_execve_wrapper_exe: Option<PathBuf>,
    /// 分析事件客户端，用于上报会话级的遥测数据。
    pub(crate) analytics_events_client: AnalyticsEventsClient,
    /// Hooks 集合，使用 `ArcSwap` 以支持运行时热更新。
    pub(crate) hooks: ArcSwap<Hooks>,
    /// 当前 rollout 线程的追踪上下文，用于 OpenTelemetry 链路追踪。
    pub(crate) rollout_thread_trace: ThreadTraceContext,
    /// 用户首选 shell 的共享句柄。
    pub(crate) user_shell: Arc<crate::shell::Shell>,
    /// 是否向用户展示 agent 的原始推理内容（reasoning）。
    pub(crate) show_raw_agent_reasoning: bool,
    /// 执行策略管理器，决定命令是否被允许执行以及执行方式。
    pub(crate) exec_policy: Arc<ExecPolicyManager>,
    /// 认证管理器，负责 OAuth 等登录态维护。
    pub(crate) auth_manager: Arc<AuthManager>,
    /// 模型管理器（共享句柄），提供模型元数据查询与切换能力。
    pub(crate) models_manager: SharedModelsManager,
    /// 会话级遥测句柄。
    pub(crate) session_telemetry: SessionTelemetry,
    /// 工具审批存储，序列化访问以避免竞态。
    pub(crate) tool_approvals: Mutex<ApprovalStore>,
    /// Guardian 拒绝记录映射，按目标键索引。
    pub(crate) guardian_rejections: Mutex<HashMap<String, GuardianRejection>>,
    /// Guardian 拒绝的熔断器，防止在短时间内重复触发相同的拒绝。
    pub(crate) guardian_rejection_circuit_breaker: Mutex<GuardianRejectionCircuitBreaker>,
    /// 当前会话绑定的 Tokio runtime 句柄。
    pub(crate) runtime_handle: Handle,
    /// Skills 服务，负责技能加载与调度。
    pub(crate) skills_service: Arc<SkillsService>,
    /// AGENTS.md 管理器，负责项目说明文件的解析与缓存。
    pub(crate) agents_md_manager: Arc<AgentsMdManager>,
    /// 插件管理器，负责插件发现、加载与生命周期管理。
    pub(crate) plugins_manager: Arc<PluginsManager>,
    /// MCP 管理器，封装 MCP 工具/资源的高级调用接口。
    pub(crate) mcp_manager: Arc<McpManager>,
    /// 扩展注册表，按当前 `Config` 类型参数化。
    pub(crate) extensions: Arc<ExtensionRegistry<crate::config::Config>>,
    /// 会话级扩展数据，跨 turn 共享。
    pub(crate) session_extension_data: ExtensionData,
    /// 线程级扩展数据，单个 rollout 线程内共享。
    pub(crate) thread_extension_data: ExtensionData,
    /// 标记当前会话是否支持 OpenAI 表单形式的 elicitation。
    pub(crate) supports_openai_form_elicitation: AtomicBool,
    /// 当前线程的原始 capability 选择项。每个 model step 在使用前会基于其当前
    /// executor 环境对这些选择项进行解析。
    pub(crate) selected_capability_roots: Vec<SelectedCapabilityRoot>,
    /// MCP 线程初始化数据，用于新线程扩展数据初始化。
    pub(crate) mcp_thread_init: ExtensionDataInit,
    /// Agent 控制器，提供子 agent 的 spawn / wait / 消息收发等能力。
    pub(crate) agent_control: AgentControl,
    /// 已启动的网络代理（若有），使用 `ArcSwapOption` 支持热替换。
    pub(crate) network_proxy: ArcSwapOption<StartedNetworkProxy>,
    /// 网络代理审计元数据，用于日志与合规追踪。
    pub(crate) network_proxy_audit_metadata: NetworkProxyAuditMetadata,
    /// 是否已配置受管网络要求（managed network requirements）。
    pub(crate) managed_network_requirements_configured: bool,
    /// 网络审批服务，用于处理网络访问请求的审批流。
    pub(crate) network_approval: Arc<NetworkApprovalService>,
    /// 可选的 state DB 句柄，用于持久化 rollout 状态。
    pub(crate) state_db: Option<StateDbHandle>,
    /// 当前活跃的线程句柄（若有）。
    pub(crate) live_thread: Option<LiveThread>,
    /// 线程存储后端，负责线程列表与历史线程的存取。
    pub(crate) thread_store: Arc<dyn ThreadStore>,
    /// 可选的 attestation provider，用于签名/校验关键操作。
    pub(crate) attestation_provider: Option<Arc<dyn AttestationProvider>>,
    /// 时间提供者，便于测试注入虚拟时钟。
    pub(crate) time_provider: Arc<dyn TimeProvider>,
    /// 会话级共享的模型客户端，跨 turn 复用。
    pub(crate) model_client: ModelClient,
    /// Code mode 服务，负责代码执行模式的协调。
    pub(crate) code_mode_service: CodeModeService,
    /// 工具搜索 handler 缓存，加速工具发现流程。
    pub(crate) tool_search_handler_cache: ToolSearchHandlerCache,
    /// 当前线程的环境集合（包含可用沙箱、网络等环境）。
    pub(crate) turn_environments: Arc<ThreadEnvironments>,
}

impl SessionServices {
    /// 安装 MCP 连接管理器，并在验证必需服务器之前完成发布，
    /// 以便启动期间的 elicitation 能通过会话自身的管理器解析，
    /// 而验证过程可以等待 elicitation 结果完成。
    pub(crate) async fn install_mcp_connection_manager(
        &self,
        config: Arc<McpConfig>,
        runtime_context: McpRuntimeContext,
        available_environment_ids: Vec<String>,
        manager: McpConnectionManager,
    ) -> Result<()> {
        let runtime =
            self.publish_mcp_runtime(config, runtime_context, available_environment_ids, manager);
        runtime.manager().validate_required_servers().await
    }

    /// 原子地发布最新的 MCP runtime snapshot，同时更新旧版镜像与 snapshot。
    ///
    /// 调用此方法后，所有 model-scoped 消费者都将观察到同一个 manager 实例。
    pub(crate) fn publish_mcp_runtime(
        &self,
        config: Arc<McpConfig>,
        runtime_context: McpRuntimeContext,
        available_environment_ids: Vec<String>,
        manager: McpConnectionManager,
    ) -> Arc<McpRuntimeSnapshot> {
        let manager = Arc::new(manager);
        // 先为旧版资源客户端发布 manager。一旦配对的 snapshot 可见，
        // 所有 model-scoped 消费者都将观察到同一个 manager。
        self.mcp_connection_manager.store(Arc::clone(&manager));
        let runtime = Arc::new(McpRuntimeSnapshot::new(
            config,
            manager,
            runtime_context,
            available_environment_ids,
        ));
        self.mcp_runtime.store(Some(Arc::clone(&runtime)));
        runtime
    }

    /// 获取最新已发布的 MCP runtime snapshot。
    ///
    /// # Panics
    /// 若尚未安装 runtime，将触发 `unreachable!`，因为协议要求在处理任何请求前必须完成安装。
    pub(crate) fn latest_mcp_runtime(&self) -> Arc<McpRuntimeSnapshot> {
        let Some(runtime) = self.mcp_runtime.load_full() else {
            unreachable!("MCP runtime must be installed before handling requests");
        };
        runtime
    }
}
