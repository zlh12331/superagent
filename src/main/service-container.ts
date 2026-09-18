// src/main/service-container.ts
// ServiceContainer：应用单例统一生命周期管理入口
// 设计文档 §4.1 分层架构 / §7.6 生命周期管理
//
// 设计目标：
// 1. 集中持有核心服务实例（IAgentService / IFileService / ISearchService
//    / IToolRegistry / IPermissionService / IToolExecutor），统一对外暴露获取接口
// 2. 应用退出时统一清理（替代 index.ts 中分散的 cleanup 调用）
// 3. 测试隔离时统一 reset（避免每个测试手动调用各模块 reset）
// 4. 支持依赖注入：IPC handler 通过容器获取服务实例，而非直接 import 模块级单例
//
// dispose 顺序（反向依赖，先停依赖方再停被依赖方）：
//   1.  cronService.stop()          停止定时调度（fire 会触发 agent 回合，最先停）
//   2.  GoalService.unmount()       解除回合监听（P1 新增 unmount，此前泄漏）
//   3.  ImAgentBridge.unmount()     解除 IM 消息订阅（P1 新增 unmount）
//   4.  ImService.stopAll()         停止 IM 渠道长连接
//   5.  RemoteControl.release()     解除命令桥接订阅 + 停 HTTP 监听/UDP 发现广播
//   6.  AgentService.dispose()      中断活跃 agent 对话（drain 完成后再收下层）
//   6.5 markInterruptedOnShutdown   退出善后：残留 running 回合标 interrupted
//       （消除"干净退出留 stale running"窗口，须在 closeDb 前落库）
//   7.  MCPService.stopAll()        停止所有 MCP server 子进程
//   8.  lspManager.disposeAll()     关闭全部 language server（drain 后收，活跃回合仍需）
//   9.  PermissionService.dispose() reject 所有 pending 审批 Promise
//  10.  agentAskService.dispose()   清理 pending 提问
//  11.  FileService.dispose()       关闭所有 chokidar watcher
//  12.  SearchService.dispose()     终止活跃的 ripgrep 子进程
//  13.  TerminalService.dispose()   kill 所有 pty 进程
//  14.  GitService / CodebaseService.dispose()（no-op，保持一致性）
//  15.  SessionService（resetSessionService，不关 db，由 resetDb 单独处理）
//  16.  MemoryHub.stop()            sidecar 异步收尾（fire-and-forget）
//  17.  UpdateService.dispose()     更新事件收尾
//  17.5 BrowserPreview.dispose()    销毁预览 WebContentsView（窗口先关则安全跳过）
//  18.  resetAIProvider()           清理 AI Provider 缓存
//  19.  closeDb()                   关闭 SQLite 连接（必须最后）
//
// P1 修复：
// - 每步经 runStep 独立 try/catch：单服务清理失败不再跳过后续清理，
//   避免 PTY/ripgrep/chokidar 句柄残留为孤儿进程（退出路径必须可靠）
//
// 注意：
// - ToolRegistry / ToolExecutor / PermissionService 是 class（非模块级单例），
//   由 ServiceContainer 直接 new，无需 reset 函数
// - AppConfig 无需 dispose（纯内存对象，进程退出即回收）
// - 各模块内部已处理 null 检查，本模块无需重复判空
// - 幂等：多次调用 disposeServices 安全

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
// electron-updater 是 CJS 包：ESM 下 named import 运行时失败（cjs-module-lexer 无法静态分析），
// 必须默认导入后解构（Node ESM 对 CJS 的 default = module.exports，可靠）
import electronUpdater from 'electron-updater';

const { autoUpdater, CancellationToken } = electronUpdater;

/** 取消令牌工厂（UpdateService 自持 token 以支持"取消下载"） */
const createUpdateToken = (): InstanceType<typeof CancellationToken> => new CancellationToken();

import { resetConfigCache } from './config';
import { agentAskService } from './infra/ai/agent/agent-ask-service';
import { AgentService, type IAgentService } from './infra/ai/agent/agent-service';
import { initSubagentManager } from './infra/ai/agent/subagent-manager';
import { taskService } from './infra/ai/agent/task-service';
import {
  type ConcurrencyGate,
  createConcurrencyGate,
  DEFAULT_MAX_CONCURRENT_TURNS,
} from './infra/ai/agent-runtime/concurrency-gate';
import { cronService } from './infra/ai/cron-service';
import { GoalJudge } from './infra/ai/knowledge/goal-judge';
import { GoalService } from './infra/ai/knowledge/goal-service';
import type { LlmClient } from './infra/ai/llm-client';
import { llmClient, resetAIProvider, runtimeModelStore } from './infra/ai/llm-client/ai-provider';
import { type IMCPService, MCPService } from './infra/ai/mcp';
import { gitSummaryProviderFrom } from './infra/ai/prompt/dynamic-context';
import type { IPromptService } from './infra/ai/prompt/prompt-service';
import { PromptService } from './infra/ai/prompt/prompt-service';
import { registerBuiltinTools } from './infra/ai/tools';
import { CommandClassifier } from './infra/ai/tools/command-classifier';
import type { IPermissionService } from './infra/ai/tools/permission-service';
import { PermissionService } from './infra/ai/tools/permission-service';
import type { IToolExecutor } from './infra/ai/tools/tool-executor';
import { ToolExecutor } from './infra/ai/tools/tool-executor';
import type { IToolRegistry } from './infra/ai/tools/tool-registry';
import { ToolRegistry } from './infra/ai/tools/tool-registry';
import {
  BrowserPreviewService,
  type IBrowserPreviewService,
} from './infra/browser/preview-service';
import type { ICodebaseService } from './infra/codebase/codebase-service';
import { getCodebaseService, resetCodebaseService } from './infra/codebase/codebase-service';
import type { IFileService } from './infra/file/file-service';
import { getFileService, resetFileService } from './infra/file/file-service';
import type { IGitService } from './infra/git/git-service';
import { getGitService, resetGitService } from './infra/git/git-service';
import { ImAgentBridge } from './infra/im/im-agent-bridge';
import { ImService } from './infra/im/im-service';
import { readLsServerOverrides } from './infra/lsp/ls-settings';
import { LspServerManager } from './infra/lsp/lsp-server-manager';
import { resolveDistillLlmConfig } from './infra/memory-hub/llm-config';
import { createDeferredMemoryPort, MemoryHubService } from './infra/memory-hub/memory-hub-service';
import type { MemoryPort } from './infra/memory-hub/types';
import { RemoteAgentBridge } from './infra/remote/remote-agent-bridge';
import { type IRemoteControlService, RemoteControlService } from './infra/remote/remote-control';
import type { ISearchService } from './infra/search/search-service';
import { getSearchService, resetSearchService } from './infra/search/search-service';
import { readApprovalModeSync } from './infra/storage/approval-pref';
import { closeDb, resetDb } from './infra/storage/db';
import type { ISessionService } from './infra/storage/session-service';
import { getSessionService, resetSessionService } from './infra/storage/session-service';
import type { ITerminalService } from './infra/terminal/terminal-service';
import { getTerminalService, resetTerminalService } from './infra/terminal/terminal-service';
import { type IUpdateService, UpdateService } from './infra/update/update-service';
import { clearCrashMarker, hasCrashMarker, logger } from './utils/logger';

/**
 * 解析记忆引擎（上游 TencentDB-Agent-Memory · MemoryCore）根目录：
 * - 打包环境：process.resourcesPath/memory-hub（prepare-memory-hub.mjs 生成的运行目录）
 * - dev 环境：项目内的 resources/memory-hub（`pnpm prepare:memory-hub` 产出，与生产同源）；
 *   未生成时回退到环境变量 MEMORY_HUB_ROOT
 * 均不可用时返回 undefined，由 MemoryHubService 内部降级为空实现。
 */
function resolveMemoryHubRoot(): string | undefined {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'memory-hub');
  }
  // dev：优先用项目内构建产物（与打包产物同构，避免"dev 可用 prod 不可用"的偏差）
  const localArtifact = join(app.getAppPath(), 'resources', 'memory-hub');
  if (existsSync(join(localArtifact, 'src', 'gateway', 'server.ts'))) {
    return localArtifact;
  }
  // 逃生口：显式指定其他上游目录（测试 / 临时验证）
  return process.env['MEMORY_HUB_ROOT'];
}

/**
 * 服务容器：持有应用核心服务实例
 *
 * - 集中管理生命周期（dispose 时统一中断/重置）
 * - 未来扩展支持服务替换（如多 LLM provider 路由）
 */
class ServiceContainer {
  /**
   * 并发公平调度门（多会话共享执行槽位）
   *
   * 全局唯一实例：agent 回合共用同一上限，FIFO 先来先得（平均分配）。
   * 会话并发超过上限时排队等待，避免打满供应商 API 触发 429。
   */
  private readonly concurrencyGate: ConcurrencyGate = createConcurrencyGate(
    DEFAULT_MAX_CONCURRENT_TURNS,
  );

  /** cron 触发订阅取消函数（initCronScheduler 注册，dispose 释放） */
  private cronUnsubscribe: (() => void) | null = null;
  /** cron 调度是否已初始化（幂等标记） */
  private cronInitialized = false;

  // ─── 服务实例缓存（全部懒初始化；按域分组，声明顺序与初始化顺序无关） ───

  // 存储与查询域
  /** FileService（生产 get 单例；测试 set 注入 mock） */
  private fileService: IFileService | null = null;
  /** SearchService（生产 get 单例；测试 set 注入 mock） */
  private searchService: ISearchService | null = null;
  /** SessionService（内部不持有 DB 连接，getDb() 动态获取） */
  private sessionService: ISessionService | null = null;
  private gitService: IGitService | null = null;
  private codebaseService: ICodebaseService | null = null;
  private terminalService: ITerminalService | null = null;

  // AI 域
  /** ToolRegistry：容器直接 new（非模块单例），首次访问时注册全部内置工具 */
  private toolRegistry: IToolRegistry | null = null;
  /** PermissionService：dispose 时 rejectAllPendingApprovals 防内存泄漏 */
  private permissionService: IPermissionService | null = null;
  /** ToolExecutor：依赖 ToolRegistry + PermissionService，无外部资源 */
  private toolExecutor: IToolExecutor | null = null;
  /** MCPService：依赖 ToolRegistry（register/unregister 管理 MCP 工具） */
  private mcpService: IMCPService | null = null;
  private promptService: IPromptService | null = null;
  /** AgentService：依赖 ToolRegistry/ToolExecutor/Prompt/Session/Llm/ConcurrencyGate/Permission */
  private agentService: IAgentService | null = null;
  /** GoalService：挂载回合监听（mount），dispose/reset 时 unmount */
  private goalService: GoalService | null = null;
  /** MemoryHub sidecar（上游记忆引擎） */
  private memoryHub: MemoryHubService | null = null;
  private lspManager: LspServerManager | null = null;

  // 通信域
  private imService: ImService | null = null;
  /** IM → Agent 桥接（挂载后订阅渠道消息） */
  private imBridge: ImAgentBridge | null = null;
  /** 远程控制（LAN HTTP 入口 + UDP 发现广播） */
  private remoteControlService: IRemoteControlService | null = null;
  /** 远程命令 → Agent 桥接（无头执行） */
  private remoteAgentBridge: RemoteAgentBridge | null = null;

  // 其他
  /** 子代理管理器已初始化标记（initSubagents 幂等） */
  private subagentsInitialized = false;
  private updateService: IUpdateService | null = null;
  /** 浏览器预览（WebContentsView 进程外预览，独立 session 分区） */
  private browserPreviewService: IBrowserPreviewService | null = null;

  /**
   * 获取 FileService 实例
   *
   * 首次调用延迟初始化为默认 FileService 实现（与 getFileService() 单例一致）。
   * 测试可通过 setFileService() 注入 mock 实例覆盖。
   */
  getFileService(): IFileService {
    if (this.fileService === null) {
      this.fileService = getFileService();
    }
    return this.fileService;
  }

  /**
   * 注入 FileService 实例（仅测试用）
   *
   * 用于测试用例隔离：注入 mock 实现，避免依赖真实文件系统。
   * 传 null 清空缓存，下次 getFileService() 会重新拿默认实现。
   */
  setFileService(service: IFileService | null): void {
    this.fileService = service;
  }

  /**
   * 获取 SearchService 实例
   *
   * 首次调用延迟初始化为默认 SearchService 实现（与 getSearchService() 单例一致）。
   * 测试可通过 setSearchService() 注入 mock 实例覆盖。
   */
  getSearchService(): ISearchService {
    if (this.searchService === null) {
      this.searchService = getSearchService();
    }
    return this.searchService;
  }

  /**
   * 注入 SearchService 实例（仅测试用）
   *
   * 用于测试用例隔离：注入 mock 实现，避免依赖真实 ripgrep 子进程。
   * 传 null 清空缓存，下次 getSearchService() 会重新拿默认实现。
   */
  setSearchService(service: ISearchService | null): void {
    this.searchService = service;
  }

  // ─── 工具系统（ToolRegistry / PermissionService / ToolExecutor） ───

  /**
   * 获取 ToolRegistry 实例
   *
   * 首次调用延迟初始化：
   * 1. new ToolRegistry() 创建空注册表
   * 2. 调用 registerBuiltinTools(registry, fileService, searchService) 注册全部内置工具
   *
   * 依赖 FileService + SearchService 实例：先确保已初始化。
   */
  getToolRegistry(): IToolRegistry {
    if (this.toolRegistry === null) {
      const registry = new ToolRegistry();
      // 注册全部内置工具（清单见 tools/index.ts registerBuiltinTools）
      // 依赖 FileService + SearchService 实例
      registerBuiltinTools(
        registry,
        this.getFileService(),
        this.getSearchService(),
        this.getTerminalService(),
        this.getGitService(),
        this.getMemoryPort(),
        this.getLspManager(),
        agentAskService,
        this.getPermissionService(),
        this.getCodebaseService(),
      );
      this.toolRegistry = registry;
    }
    return this.toolRegistry;
  }

  /**
   * 注入 ToolRegistry 实例（仅测试用）
   *
   * 传 null 清空缓存，下次 getToolRegistry() 会重新创建并注册内置工具。
   */
  setToolRegistry(registry: IToolRegistry | null): void {
    this.toolRegistry = registry;
  }

  /**
   * 获取 PermissionService 实例
   *
   * 首次调用延迟初始化为默认 PermissionService 实现。
   */
  getPermissionService(): IPermissionService {
    if (this.permissionService === null) {
      this.permissionService = new PermissionService(new CommandClassifier(this.getLlmClient()));
      // 启动时应用持久化审批模式（approval-pref.json，默认 ask）
      this.permissionService.setApprovalMode(readApprovalModeSync());
    }
    return this.permissionService;
  }

  /**
   * 注入 PermissionService 实例（仅测试用）
   *
   * 传 null 清空缓存，下次 getPermissionService() 会重新创建默认实现。
   */
  setPermissionService(service: IPermissionService | null): void {
    this.permissionService = service;
  }

  /**
   * 获取 ToolExecutor 实例
   *
   * 首次调用延迟初始化，注入 ToolRegistry + PermissionService 实例。
   */
  getToolExecutor(): IToolExecutor {
    if (this.toolExecutor === null) {
      this.toolExecutor = new ToolExecutor(this.getToolRegistry(), this.getPermissionService());
    }
    return this.toolExecutor;
  }

  /**
   * 注入 ToolExecutor 实例（仅测试用）
   *
   * 传 null 清空缓存，下次 getToolExecutor() 会重新创建并注入当前 registry + permissionService。
   */
  setToolExecutor(executor: IToolExecutor | null): void {
    this.toolExecutor = executor;
  }

  // ─── MCPService（多 MCP server 管理器） ───

  /**
   * 获取 MCPService 实例
   *
   * 首次调用延迟初始化，注入当前 ToolRegistry 实例。
   * MCPService 通过 ToolRegistry.register / unregister 管理 MCP 工具。
   */
  getMcpService(): IMCPService {
    if (this.mcpService === null) {
      this.mcpService = new MCPService(this.getToolRegistry());
    }
    return this.mcpService;
  }

  /**
   * 注入 MCPService 实例（仅测试用）
   *
   * 传 null 清空缓存，下次 getMcpService() 会重新创建并注入当前 ToolRegistry。
   */
  setMcpService(service: IMCPService | null): void {
    this.mcpService = service;
  }

  // ─── PromptService ───

  getPromptService(): IPromptService {
    if (this.promptService === null) {
      // 注入 git 状态查询：动态上下文的 {{gitBranch}}/{{gitStatus}} 由此变为真实值。
      // 闭包内延迟取 getGitService()：尊重测试经 setGitService() 注入的 mock；
      // 非 git 仓库时 status() 抛错，injectDynamicContext 会兜底为占位符。
      this.promptService = new PromptService({
        gitSummaryProvider: gitSummaryProviderFrom((workingDir) =>
          this.getGitService().status(workingDir),
        ),
      });
    }
    return this.promptService;
  }

  setPromptService(service: IPromptService | null): void {
    this.promptService = service;
  }

  // ─── AgentService ───

  /**
   * 获取 AgentService 实例
   *
   * 首次调用延迟初始化，注入当前 ToolRegistry + ToolExecutor 实例。
   * AgentService 内部通过 ToolRegistry.toAISDKTools(ctx, executeHook) 转换工具，
   * executeHook 注入 ToolExecutor.execute 作为权限检查 + 审批 + IPC 推送层。
   */
  getAgentService(): IAgentService {
    if (this.agentService === null) {
      this.agentService = new AgentService(
        this.getToolRegistry(),
        this.getToolExecutor(),
        this.getPromptService(),
        this.getSessionService(),
        // titleGenerator：LlmClient 鸭子匹配 ITitleGenerator（同签名 generateText）
        this.getLlmClient(),
        this.concurrencyGate,
        // 审批生命周期 → 回合状态机 waitingApproval（AgentService 依赖）
        this.getPermissionService(),
        // llmClient：工具入参自动修复引擎（SDK repairToolCall 钩子）
        this.getLlmClient(),
      );
    }
    return this.agentService;
  }

  /**
   * 初始化子代理管理器（run_subagent 工具依赖；幂等）
   */
  initSubagents(): void {
    if (!this.subagentsInitialized) {
      initSubagentManager(this.getAgentService());
      this.subagentsInitialized = true;
    }
  }

  /**
   * 获取记忆引擎端口（注册期同步可用；首次调用懒启动 sidecar）
   */
  getMemoryPort(): MemoryPort {
    return createDeferredMemoryPort(() => this.getMemoryHubService());
  }

  /**
   * 获取 MemoryHub sidecar 服务（上游 TencentDB-Agent-Memory 记忆引擎，懒启动）
   *
   * hubRoot 来源：
   * - 打包环境（app.isPackaged）：resources/memory-hub（prepare-memory-hub.mjs 生成的
   *   MemoryCore 运行目录，经 electron-builder extraResources 部署到 process.resourcesPath）
   * - dev 环境：环境变量 MEMORY_HUB_ROOT 指向上游源码目录
   * 未配置时服务内部降级为空实现（记忆功能静默不可用，不阻断应用）。
   */
  getMemoryHubService(): MemoryHubService {
    if (this.memoryHub === null) {
      this.memoryHub = new MemoryHubService({
        hubRoot: resolveMemoryHubRoot(),
        dataDir: join(app.getPath('userData'), 'memory-hub'),
        // 蒸馏 LLM：复用应用默认供应商 + keychain（协议不兼容/未配 Key 时优雅降级）
        llm: resolveDistillLlmConfig,
      });
    }
    return this.memoryHub;
  }
  /**
   * 获取 LSP 服务器管理器（懒加载：首次工具调用才创建）
   *
   * 用户覆盖来源：SQLite app_settings 的 `lsp.serverCommands`（按语言命令行，
   * 渲染层设置页写穿透；构造时读取一次，修改后重启应用生效）。
   */
  getLspManager(): LspServerManager {
    if (this.lspManager === null) {
      this.lspManager = new LspServerManager({ serverOverrides: readLsServerOverrides() });
    }
    return this.lspManager;
  }

  /**
   * 获取会话目标服务（延迟初始化 + 挂载回合监听）
   */
  getGoalService(): GoalService {
    if (this.goalService === null) {
      this.goalService = new GoalService(
        this.getAgentService(),
        new GoalJudge(this.getLlmClient()),
      );
      this.goalService.mount();
    }
    return this.goalService;
  }

  /**
   * 获取 IM 渠道服务（延迟初始化）
   */
  getImService(): ImService {
    if (this.imService === null) {
      this.imService = new ImService();
      // 挂载 IM → Agent 桥接（无头执行；审批模式受控）
      this.imBridge = new ImAgentBridge(
        this.imService,
        this.getAgentService(),
        this.getPermissionService(),
        this.getSessionService(),
      );
      this.imBridge.mount();
    }
    return this.imService;
  }

  /**
   * 初始化 IM 渠道（应用启动时调用）：已配置渠道自动连接
   */
  async initImChannels(): Promise<void> {
    await this.getImService().restore();
  }

  /**
   * 初始化定时任务调度（应用启动时调用；幂等；必须在 initDb 之后）
   *
   * 接线 cron-service 的三条生产链路（此前建成未接线，任务「能建不会跑」）：
   * - 触发动作：fire → 取会话 workingDir → 落触发 prompt 为用户消息 →
   *   startAgent 无头执行（无 webContents，推送跳过）
   * - 启动恢复：start() 从 sqlite 恢复全部启用任务
   * - 退出清理：dispose() 中 cronService.stop()（先于 AgentService 收尾）
   */
  initCronScheduler(): void {
    if (this.cronInitialized) {
      return;
    }
    this.cronInitialized = true;
    this.cronUnsubscribe = cronService.onFire((task) => this.runCronTurn(task));
    cronService.start();
  }

  /** cron 触发 → 无头 agent 回合（会话已删除时仅告警，由用户手动清理任务） */
  private async runCronTurn(task: {
    readonly id: string;
    readonly sessionId: string;
    readonly description: string;
  }): Promise<void> {
    try {
      const session = await this.getSessionService().get(task.sessionId);
      // 抢占保护（2026-09-06 审计修复）：会话执行中跳过，否则 preemptExisting 会 abort 用户对话
      if (session.session.lastRunStatus === 'running') {
        logger.warn({ taskId: task.id }, '定时任务跳过：会话正在执行中');
        return;
      }
      const { workingDir } = session.session;
      const prompt = `【定时任务触发】${task.description}`;
      // 先落触发 prompt 为用户消息（与渲染层先 append 再 run 的时序一致，保证 transcript 完整）
      await this.getSessionService().appendMessage({
        sessionId: task.sessionId,
        messages: [{ role: 'user', content: prompt }],
      });
      await this.getAgentService().startAgent({
        messages: [{ role: 'user', content: prompt }],
        sessionId: task.sessionId,
        workingDir,
        systemPrompt: undefined,
        maxSteps: 20,
      });
      logger.info({ taskId: task.id, sessionId: task.sessionId }, '定时任务回合已执行');
    } catch (err: unknown) {
      logger.error({ error: err, taskId: task.id }, '定时任务回合执行失败');
    }
  }

  /**
   * 释放 IM 渠道（应用退出）
   *
   * P1 修复：仅收尾已存在的实例——此前经 getImService() 懒初始化，IM 从未启用时
   * 退出反而会在 teardown 路径凭空构建并挂载（mount 含 mkdirSync + onMessage 订阅）
   * 整套 IM 服务再立刻销毁；且 imBridge 置空前未 unmount（回合事件订阅残留）。
   * 顺序对齐 dispose() 主链：先停桥接订阅，再停渠道长连接。
   */
  async disposeImChannels(): Promise<void> {
    this.imBridge?.unmount();
    this.imBridge = null;
    if (this.imService !== null) {
      await this.imService.stopAll();
      this.imService = null;
    }
  }

  /**
   * 获取远程控制服务（延迟初始化）：LAN 直连 HTTP 命令入口 + UDP 发现广播。
   * 命令执行由 RemoteAgentBridge 订阅 onCommand 挂载（与 IM 桥接同款无头执行路径），
   * 本容器只管生命周期。
   */
  getRemoteControlService(): IRemoteControlService {
    if (this.remoteControlService === null) {
      this.remoteControlService = new RemoteControlService();
      this.remoteAgentBridge = new RemoteAgentBridge(
        this.remoteControlService,
        this.getAgentService(),
        this.getPermissionService(),
        this.getSessionService(),
      );
      this.remoteAgentBridge.mount();
    }
    return this.remoteControlService;
  }

  /**
   * 收尾远程控制（应用退出 / 测试隔离）
   *
   * 只在实例已存在时收尾：经 getter 懒初始化会在 teardown 路径凭空构造
   * 服务 + 桥接（mount 含 mkdirSync + 订阅）再立刻销毁——对齐 IM 的 P1 教训。
   * 顺序：先解除桥接订阅（不再接管新命令），再关闭 HTTP 监听与发现广播。
   */
  async releaseRemoteControl(): Promise<void> {
    this.remoteAgentBridge?.unmount();
    this.remoteAgentBridge = null;
    if (this.remoteControlService !== null) {
      await this.remoteControlService.stop();
      this.remoteControlService = null;
    }
  }

  /**
   * 统计数据保留：删除用量统计窗口外的 token_usage 行（启动时调用一次）
   */
  pruneExpiredUsage(): number {
    return this.getSessionService().pruneExpiredUsage();
  }

  /**
   * 重置 IM 渠道（仅测试用）
   */
  resetImChannels(): void {
    this.imService = null;
    this.imBridge = null;
  }

  /**
   * LLM 客户端（标题生成 / 结构化输出等 side query）
   */
  private getLlmClient(): LlmClient {
    return llmClient;
  }

  /**
   * 注入 AgentService 实例（仅测试用）
   *
   * 传 null 清空缓存，下次 getAgentService() 会重新创建并注入当前 registry + executor。
   */
  setAgentService(service: IAgentService | null): void {
    this.agentService = service;
  }

  // ─── TerminalService（node-pty 终端会话池） ───

  /**
   * 获取 TerminalService 实例
   *
   * 首次调用延迟初始化为默认 TerminalService 实现（与 getTerminalService() 单例一致）。
   * 测试可通过 setTerminalService() 注入 mock 实例覆盖。
   */
  getTerminalService(): ITerminalService {
    if (this.terminalService === null) {
      this.terminalService = getTerminalService();
    }
    return this.terminalService;
  }

  /**
   * 注入 TerminalService 实例（仅测试用）
   *
   * 用于测试用例隔离：注入 mock 实现，避免依赖真实 PTY 子进程。
   * 传 null 清空缓存，下次 getTerminalService() 会重新拿默认实现。
   */
  setTerminalService(service: ITerminalService | null): void {
    this.terminalService = service;
  }

  // ─── GitService（Git CLI 封装，只读查询） ───

  /**
   * 获取 GitService 实例
   *
   * 首次调用延迟初始化为默认 GitService 实现（与 getGitService() 单例一致）。
   * 测试可通过 setGitService() 注入 mock 实例覆盖。
   */
  getGitService(): IGitService {
    if (this.gitService === null) {
      this.gitService = getGitService();
    }
    return this.gitService;
  }

  /**
   * 注入 GitService 实例（仅测试用）
   *
   * 用于测试用例隔离：注入 mock 实现，避免依赖真实 git CLI。
   * 传 null 清空缓存，下次 getGitService() 会重新拿默认实现。
   */
  setGitService(service: IGitService | null): void {
    this.gitService = service;
  }

  // ─── CodebaseService（codegraph CLI 封装，代码智能查询） ───

  /**
   * 获取 CodebaseService 实例
   *
   * 首次调用延迟初始化为默认 CodebaseService 实现（与 getCodebaseService() 单例一致）。
   * 测试可通过 setCodebaseService() 注入 mock 实例覆盖。
   */
  getCodebaseService(): ICodebaseService {
    if (this.codebaseService === null) {
      this.codebaseService = getCodebaseService();
    }
    return this.codebaseService;
  }

  /**
   * 注入 CodebaseService 实例（仅测试用）
   *
   * 用于测试用例隔离：注入 mock 实现，避免依赖真实 codegraph CLI。
   * 传 null 清空缓存，下次 getCodebaseService() 会重新拿默认实现。
   */
  setCodebaseService(service: ICodebaseService | null): void {
    this.codebaseService = service;
  }

  // ─── SessionService（SQLite 持久化，会话历史存储） ───

  /**
   * 获取 SessionService 实例
   *
   * 首次调用延迟初始化为默认 SessionService 实现（与 getSessionService() 单例一致）。
   * 测试可通过 setSessionService() 注入 mock 实例覆盖。
   */
  getSessionService(): ISessionService {
    if (this.sessionService === null) {
      this.sessionService = getSessionService();
    }
    return this.sessionService;
  }

  /**
   * 注入 SessionService 实例（仅测试用）
   *
   * 用于测试用例隔离：注入 mock 实现，避免依赖真实 SQLite。
   * 传 null 清空缓存，下次 getSessionService() 会重新拿默认实现。
   */
  setSessionService(service: ISessionService | null): void {
    this.sessionService = service;
  }

  /**
   * 应用退出时统一清理所有服务
   *
   * 顺序按反向依赖（先停依赖方再停被依赖方）：
   * 1. ChatService   中断活跃对话（P3-10：等待 stream 真正完成，避免 IPC send 丢失）
   * 2. FileService   关闭所有 chokidar watcher（释放 fs 监听句柄，避免进程不退出）
   * 3. SearchService 终止活跃的 ripgrep 子进程（释放 spawn 句柄）
   * 4. AI Provider   清空引用（无连接池，仅让 GC 回收）
   *
   * P3-10 改造：
   * - 旧实现调用 abortAll() 仅同步触发 abort 信号，streamText 协程可能仍在 reader.read() 等待
   * - 新实现调用 dispose() 等待所有活跃 stream 真正进入 finally 块（带 3s 超时兜底）
   * - 避免进程退出时正在进行的 IPC send 丢失 / 渲染层 loading 状态卡死
   *
   * 幂等：多次调用安全（各模块内部已处理 null 检查）。
   *
   * @example
   * ```ts
   * // main/index.ts before-quit 事件
   * app.on('before-quit', async (event) => {
   *   event.preventDefault();
   *   await disposeServices();
   *   app.exit(0);
   * });
   * ```
   */
  async dispose(): Promise<void> {
    logger.info({}, '开始清理应用服务');

    // P1 修复：每步独立异常隔离——单个服务 dispose 抛错不再跳过后续清理，
    // 否则 PTY/ripgrep/chokidar 句柄会残留为孤儿进程（退出路径必须可靠）。
    const failures: string[] = [];
    const runStep = createDisposeStep(failures);

    // 1.8 停止定时任务调度（fire 会触发 agent 回合，必须最先停——
    //     先于桥接卸载与 AgentService drain，防半拆解容器再起新回合）
    await runStep('cronService.stop', () => {
      this.cronUnsubscribe?.();
      this.cronUnsubscribe = null;
      this.cronInitialized = false;
      cronService.stop();
    });

    // 1.9 先停 agent 回合的依赖方（桥接/渠道/远程控制）：drain 窗口内到达的
    //     IM/远程命令不得再发起新回合（S14 修复：此前卸载晚于 agent drain）
    await runStep('goalService.unmount', async () => {
      this.goalService?.unmount();
      this.goalService = null;
    });
    await runStep('imBridge.unmount', async () => {
      this.imBridge?.unmount();
      this.imBridge = null;
    });

    // 1.10 停止 IM 渠道长连接（QQ/微信/钉钉/Telegram/飞书/企微 webhook 收尾）
    await runStep('imService.stopAll', async () => {
      if (this.imService !== null) {
        await this.imService.stopAll();
      }
      this.imService = null;
    });

    // 1.11 收尾远程控制：解除命令桥接订阅 + 停止 HTTP 监听与 UDP 发现广播
    await runStep('remoteControl.release', async () => {
      await this.releaseRemoteControl();
    });

    // 优雅关闭 AgentService（P4：中断 + 等待活跃 agent stream 真正完成）
    //    AgentService 依赖 ToolExecutor（已注入到 executeHook 闭包），
    //    必须在 PermissionService.dispose 之前停止
    await runStep('agentService.dispose', async () => {
      if (this.agentService !== null) {
        await this.agentService.dispose();
      }
      this.agentService = null;
    });

    // 1.12 退出善后：把仍在 running 的回合标记为 interrupted
    //     agentService.dispose 已 drain（正常路径 stream finally 已 markIdle），
    //     但 3s 超时强清的 stream 协程仍悬挂 → DB 残留 running。
    //     此步消除"干净退出却留 stale running、依赖下次启动 recoverFromCrash
    //     才纠正"的窗口（退出后外部工具/备份脚本读到的一律是终态）。
    //     幂等：markAllInterrupted 只影响 last_run_status='running' 的行；
    //     必须在 sessionService.dispose / closeDb 之前（此后无人再写 sessions 表）。
    await runStep('markInterruptedOnShutdown', async () => {
      if (this.sessionService !== null) {
        const interrupted = await this.sessionService.markAllInterrupted();
        if (interrupted > 0) {
          logger.info(
            { interrupted },
            '退出善后：未收尾回合已标记为 interrupted（下次启动可恢复）',
          );
        }
      }
    });

    // 2.5 关闭 MCPService（停止所有 MCP server 子进程）
    await runStep('mcpService.stopAll', async () => {
      if (this.mcpService !== null) {
        await this.mcpService.stopAll();
      }
      this.mcpService = null;
    });

    // 2.6 关闭全部 language server（S14 修复：移到 agent drain 之后——
    //     drain 窗口内活跃回合的 LSP 工具调用仍需可用）
    await runStep('lspManager.disposeAll', async () => {
      await this.lspManager?.disposeAll();
      this.lspManager = null;
    });

    // 3. 清理 PermissionService（reject 所有 pending 审批 Promise，避免内存泄漏）
    //    ToolExecutor 与 ToolRegistry 无外部资源（仅 Map / 协调层），无需 dispose
    await runStep('permissionService.dispose', async () => {
      this.permissionService?.dispose();
      this.permissionService = null;
      this.toolExecutor = null;
      this.toolRegistry = null;
    });

    // 3.5 Agent 提问 pending 清理（agentAskService 为模块单例，dispose 幂等）
    await runStep('agentAskService.dispose', () => {
      agentAskService.dispose();
    });

    // 4. 关闭 FileService 所有 watcher（释放 chokidar fs 监听句柄）
    await runStep('fileService.dispose', async () => {
      if (this.fileService !== null) {
        await this.fileService.dispose();
      }
      resetFileService();
      this.fileService = null;
    });

    // 5. 终止 SearchService 活跃子进程（释放 ripgrep spawn 句柄）
    await runStep('searchService.dispose', async () => {
      if (this.searchService !== null) {
        await this.searchService.dispose();
      }
      resetSearchService();
      this.searchService = null;
    });

    // 6. kill 所有 TerminalService 活跃 pty 进程（释放 node-pty 句柄）
    await runStep('terminalService.dispose', async () => {
      if (this.terminalService !== null) {
        await this.terminalService.dispose();
      }
      resetTerminalService();
      this.terminalService = null;
    });

    // 7. GitService 无外部资源，dispose 是 no-op，但保持一致性便于未来扩展
    await runStep('gitService.dispose', async () => {
      if (this.gitService !== null) {
        await this.gitService.dispose();
      }
      resetGitService();
      this.gitService = null;
    });

    // 8. CodebaseService 无外部资源，dispose 是 no-op，但保持一致性便于未来扩展
    await runStep('codebaseService.dispose', async () => {
      if (this.codebaseService !== null) {
        await this.codebaseService.dispose();
      }
      resetCodebaseService();
      this.codebaseService = null;
    });

    // 9. SessionService 无外部资源（db 由 closeDb 单独关闭），必须在 closeDb 之前
    await runStep('sessionService.dispose', async () => {
      if (this.sessionService !== null) {
        await this.sessionService.dispose();
      }
      resetSessionService();
      this.sessionService = null;
    });

    // 10. PromptService 无外部资源，清空引用即可
    this.promptService = null;

    // 10.2 停止 MemoryHub sidecar 子进程（上游记忆引擎）
    await runStep('memoryHub.stop', async () => {
      if (this.memoryHub !== null) {
        await this.memoryHub.stop();
      }
      this.memoryHub = null;
    });

    // 10.5 UpdateService 无外部资源（事件随进程退出释放），清空引用即可
    await runStep('updateService.dispose', () => {
      this.updateService?.dispose();
      this.updateService = null;
    });

    // 10.6 销毁浏览器预览 WebContentsView（独立 session 分区随对象回收；
    //      窗口先于容器 dispose 关闭时，内部按 isDestroyed 安全跳过）
    await runStep('browserPreview.dispose', () => {
      this.browserPreviewService?.dispose();
      this.browserPreviewService = null;
    });

    // 11. 清理 AI Provider 缓存（DeepSeek provider 无连接池，仅清空引用让 GC 回收）
    await runStep('resetAIProvider', () => {
      resetAIProvider();
    });

    // 11.5 关闭 SQLite 连接（必须最后调用，避免 SessionService 后续访问已关闭的 db）
    await runStep('closeDb', async () => {
      await closeDb();
    });

    if (failures.length > 0) {
      logger.error({ failures }, '应用服务清理完成（部分失败）');
    } else {
      logger.info({}, '应用服务清理完成');
    }
  }

  /**
   * 获取 UpdateService 实例
   *
   * 首次调用延迟初始化：注入 electron-updater 的 autoUpdater、打包状态判断与取消
   * 令牌工厂（electron-updater 未暴露取消 API，下载由 UpdateService 自持 token
   * 才能取消）。打包环境（app.isPackaged）才有 app-update.yml 更新源。
   */
  getUpdateService(): IUpdateService {
    if (this.updateService === null) {
      this.updateService = new UpdateService(autoUpdater, () => app.isPackaged, createUpdateToken);
    }
    return this.updateService;
  }

  /**
   * 获取浏览器预览服务实例
   *
   * 首次调用延迟初始化：视图在渲染层推送视口/导航时才真正创建（懒加载）。
   * 窗口来源走 BrowserWindow.getAllWindows（单窗口应用取首个存活窗口），
   * 与 UpdateService 的事件广播模式一致，避免容器持有窗口引用。
   */
  getBrowserPreviewService(): IBrowserPreviewService {
    if (this.browserPreviewService === null) {
      this.browserPreviewService = new BrowserPreviewService({
        getWindow: () => BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ?? null,
      });
    }
    return this.browserPreviewService;
  }

  /**
   * 是否有 Agent 回合正在运行（关窗协商用）
   *
   * 窗口 close 事件的"运行中回合确认弹窗"判定依据：
   * - AgentService 未初始化（从未跑过回合）→ false，不打扰正常关闭
   * - 不触发懒初始化，只查询现有实例
   */
  hasRunningAgentTurns(): boolean {
    return this.agentService?.hasActiveSessions() ?? false;
  }

  /**
   * 重置所有服务缓存（仅测试用）
   *
   * 用于测试用例隔离：重置所有模块级单例缓存，让下一个测试用例重新初始化。
   *
   * 注意：
   * - 不调用 dispose（不停止外部服务），仅清空缓存引用
   * - 调用此函数前应确保已停止相关外部服务
   */
  reset(): void {
    // AgentService 无模块级单例，直接清空 ServiceContainer 缓存引用
    this.agentService = null;
    // 工具系统无模块级单例，直接清空 ServiceContainer 缓存引用
    this.permissionService = null;
    this.toolExecutor = null;
    this.toolRegistry = null;
    // P1 修复：补齐此前遗漏的服务——MCP 子进程停止、挂载解除、IM 渠道停止
    // reset 为同步 API：stopAll 为异步收尾，fire-and-forget 避免子进程/长连接在测试中泄漏
    // 定时任务调度停止（防测试间 cron 实例泄漏）
    this.cronUnsubscribe?.();
    this.cronUnsubscribe = null;
    this.cronInitialized = false;
    cronService.stop();
    void this.mcpService?.stopAll();
    this.mcpService = null;
    this.goalService?.unmount();
    this.goalService = null;
    this.imBridge?.unmount();
    this.imBridge = null;
    void this.imService?.stopAll();
    this.imService = null;
    // 远程控制：桥接订阅解除 + HTTP/UDP 收尾（异步 fire-and-forget，防端口泄漏）
    void this.releaseRemoteControl();
    // MemoryHub 子进程异步收尾（reset 为同步 API，fire-and-forget 防泄漏）
    void this.memoryHub?.stop();
    this.memoryHub = null;
    agentAskService.dispose();
    resetFileService();
    this.fileService = null;
    resetSearchService();
    this.searchService = null;
    resetTerminalService();
    this.terminalService = null;
    resetGitService();
    this.gitService = null;
    resetCodebaseService();
    this.codebaseService = null;
    // SessionService 模块级单例清理（不关闭 db，由 resetDb 单独处理）
    resetSessionService();
    this.sessionService = null;
    this.promptService = null;
    this.updateService = null;
    this.browserPreviewService?.dispose();
    this.browserPreviewService = null;
    resetAIProvider();
    // 关闭并重置 SQLite 连接（必须最后调用，避免 SessionService 后续访问已关闭的 db）
    resetDb();
    resetConfigCache();
  }
}

/** 应用级单例 ServiceContainer */
export const serviceContainer = new ServiceContainer();

/**
 * 构造 dispose 步骤执行器（独立异常隔离：单服务清理失败不阻断后续清理）
 *
 * 失败步骤名记录进 failures（dispose 末尾统一汇报），错误经 logger 落盘。
 */
function createDisposeStep(
  failures: string[],
): (name: string, fn: () => Promise<void> | void) => Promise<void> {
  return async (name, fn) => {
    try {
      await fn();
    } catch (error) {
      failures.push(name);
      logger.error(
        {
          step: name,
          error: error instanceof Error ? error.message : String(error),
        },
        '服务清理失败（继续后续清理）',
      );
    }
  };
}

/**
 * 启动时加载运行时模型（自定义模型注册到 ModelRegistry）
 *
 * 在 LLM 首次调用前调用（index.ts 启动流程中，与 recoverFromCrash 同阶段）。
 */
export async function initRuntimeModels(): Promise<void> {
  await runtimeModelStore.loadAll();
}

/**
 * 崩溃恢复（启动时调用）
 *
 * - 检测上次是否异常退出（userData/.crash-marker，uncaughtException 时写入）
 * - 把所有 running 残留会话标记为 interrupted（渲染层据此提示"上次回合已中断"）
 * - 清除崩溃标记
 */
export async function recoverFromCrash(): Promise<void> {
  const wasCrash = hasCrashMarker();
  if (wasCrash) {
    logger.warn({}, '检测到上次进程异常退出（崩溃标记），执行崩溃恢复');
  }
  try {
    const interrupted = await serviceContainer.getSessionService().markAllInterrupted();
    if (interrupted > 0 || wasCrash) {
      logger.info({ interrupted, wasCrash }, '崩溃恢复：残留 running 会话已标记为 interrupted');
    }
    // 2026-09-08 修复：tasks 表同样持久化 status，此前异常退出后残留 running
    // 任务在面板永久显示「运行中」。与 sessions 同阶段无条件修正。
    const failedTasks = taskService.markAllRunningFailed();
    if (failedTasks > 0) {
      logger.info({ failedTasks }, '崩溃恢复：残留 running 任务已标记为 failed');
    }
  } finally {
    clearCrashMarker();
  }
}

/**
 * 应用退出时统一清理所有服务（兼容旧 API）
 *
 * 内部委托给 serviceContainer.dispose()，保留旧导出避免上层大改。
 */
export async function disposeServices(): Promise<void> {
  await serviceContainer.dispose();
}

/**
 * 是否有 Agent 回合正在运行（关窗协商用）
 *
 * 窗口 close 事件的"运行中回合确认弹窗"判定依据：
 * - 未初始化 AgentService（从未跑过回合）→ false，不打扰正常关闭
 * - E2E / 特殊场景可用环境变量 CODE_AGENT_SKIP_CLOSE_GUARD=1 豁免协商
 */
export function hasRunningAgentTurns(): boolean {
  return serviceContainer.hasRunningAgentTurns();
}
