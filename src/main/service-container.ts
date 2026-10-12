// service-container.ts：主进程服务容器（组合根）——20 个 lazy accessor 按反向依赖装配、
// dispose 善后链（顺序敏感：cron 先停，DB 最后关）、崩溃恢复。导出单例 serviceContainer
// 边界：agentAskService 与 cronService 是模块级单例 import 直引，不经容器管理
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater, CancellationToken } = electronUpdater;

// electron-updater 的 CancellationToken 是一次性语义：每次更新检查必须用全新实例，
// 复用已取消的 token 会让后续所有检查被永久取消——故传工厂而非实例
const createUpdateToken = (): InstanceType<typeof CancellationToken> => new CancellationToken();

import { resetConfigCache } from './config';
import { agentAskService } from './infra/ai/agent/agent-ask-service';
import { AgentService, type IAgentService } from './infra/ai/agent/agent-service';
import { cronService } from './infra/ai/agent/cron-service';
import { initSubagentManager } from './infra/ai/agent/subagent-manager';
import { taskService } from './infra/ai/agent/task-service';
import {
  createConcurrencyGate,
  DEFAULT_MAX_CONCURRENT_PER_PROVIDER,
} from './infra/ai/agent-runtime/concurrency-gate';
import { GoalJudge } from './infra/ai/knowledge/goal-judge';
import { GoalService } from './infra/ai/knowledge/goal-service';
import type { LlmClient } from './infra/ai/llm-client';
import {
  llmClient,
  resetAIProvider,
  runtimeModelStore,
  setRateLimitBridge,
} from './infra/ai/llm-client/ai-provider';
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
import { readRemoteBindScope } from './infra/storage/remote-pref';
import type { ISessionService } from './infra/storage/session-service';
import { getSessionService, resetSessionService } from './infra/storage/session-service';
import type { ITerminalService } from './infra/terminal/terminal-service';
import { getTerminalService, resetTerminalService } from './infra/terminal/terminal-service';
import { type IUpdateService, UpdateService } from './infra/update/update-service';
import { clearCrashMarker, hasCrashMarker, logger } from './utils/logger';

// 记忆引擎（vendored 上游）的定位：打包态用 resources 内 bundle 产物；dev 优先找仓库内
// 构建产物，再退 MEMORY_HUB_ROOT 环境变量；均无则 undefined（引擎走默认定位，功能降级）
function resolveMemoryHubRoot(): string | undefined {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'memory-hub');
  }
  const localArtifact = join(app.getAppPath(), 'resources', 'memory-hub');
  if (existsSync(join(localArtifact, 'src', 'gateway', 'server.ts'))) {
    return localArtifact;
  }
  return process.env['MEMORY_HUB_ROOT'];
}

class ServiceContainer {
  // ConcurrencyGate 不做 accessor：无重依赖、构造廉价，直接初始化为 readonly 字段
  private readonly concurrencyGate = createConcurrencyGate(DEFAULT_MAX_CONCURRENT_PER_PROVIDER);

  constructor() {
    // 限流接缝：llmClient（模块级单例）观测到 429 → gate 冷却；side query 经 modelGate 等冷却。
    // 窄接口结构化匹配（ConcurrencyGate ⊇ RateLimitGate），单例不反向 import 容器（防环）
    setRateLimitBridge(this.concurrencyGate);
  }

  private cronUnsubscribe: (() => void) | null = null;
  private cronInitialized = false;

  // ───── 惰性单例字段：null = 未构造，首次 get* 才实例化；set* 仅供测试注入替换 ─────

  private fileService: IFileService | null = null;
  private searchService: ISearchService | null = null;
  private sessionService: ISessionService | null = null;
  private gitService: IGitService | null = null;
  private codebaseService: ICodebaseService | null = null;
  private terminalService: ITerminalService | null = null;

  private toolRegistry: IToolRegistry | null = null;
  private permissionService: IPermissionService | null = null;
  private toolExecutor: IToolExecutor | null = null;
  private mcpService: IMCPService | null = null;
  private promptService: IPromptService | null = null;
  private agentService: IAgentService | null = null;
  private goalService: GoalService | null = null;
  private memoryHub: MemoryHubService | null = null;
  private lspManager: LspServerManager | null = null;

  private imService: ImService | null = null;
  private imBridge: ImAgentBridge | null = null;
  private remoteControlService: IRemoteControlService | null = null;
  private remoteAgentBridge: RemoteAgentBridge | null = null;

  private subagentsInitialized = false;
  private updateService: IUpdateService | null = null;
  private browserPreviewService: IBrowserPreviewService | null = null;

  getFileService(): IFileService {
    if (this.fileService === null) {
      this.fileService = getFileService();
    }
    return this.fileService;
  }

  setFileService(service: IFileService | null): void {
    this.fileService = service;
  }

  getSearchService(): ISearchService {
    if (this.searchService === null) {
      this.searchService = getSearchService();
    }
    return this.searchService;
  }

  setSearchService(service: ISearchService | null): void {
    this.searchService = service;
  }

  /** 工具注册表：首次构造时注册全部内置工具（file/search/terminal/git/memory/lsp/ask/permission/codebase 全部先行就绪） */
  getToolRegistry(): IToolRegistry {
    if (this.toolRegistry === null) {
      const registry = new ToolRegistry();
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

  setToolRegistry(registry: IToolRegistry | null): void {
    this.toolRegistry = registry;
  }

  /** 权限服务：构造即读持久化审批模式（approval-pref），后续 mode:set 才会变更 */
  getPermissionService(): IPermissionService {
    if (this.permissionService === null) {
      this.permissionService = new PermissionService(new CommandClassifier(this.getLlmClient()));
      this.permissionService.setApprovalMode(readApprovalModeSync());
    }
    return this.permissionService;
  }

  setPermissionService(service: IPermissionService | null): void {
    this.permissionService = service;
  }

  getToolExecutor(): IToolExecutor {
    if (this.toolExecutor === null) {
      this.toolExecutor = new ToolExecutor(this.getToolRegistry(), this.getPermissionService());
    }
    return this.toolExecutor;
  }

  setToolExecutor(executor: IToolExecutor | null): void {
    this.toolExecutor = executor;
  }

  getMcpService(): IMCPService {
    if (this.mcpService === null) {
      this.mcpService = new MCPService(this.getToolRegistry());
    }
    return this.mcpService;
  }

  setMcpService(service: IMCPService | null): void {
    this.mcpService = service;
  }

  getPromptService(): IPromptService {
    if (this.promptService === null) {
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

  /** Agent 服务：回合执行核心，注入注册表/执行器/提示词/会话/LLM/并发门/权限 8 依赖 */
  getAgentService(): IAgentService {
    if (this.agentService === null) {
      this.agentService = new AgentService(
        this.getToolRegistry(),
        this.getToolExecutor(),
        this.getPromptService(),
        this.getSessionService(),
        this.getLlmClient(),
        this.concurrencyGate,
        this.getPermissionService(),
        this.getLlmClient(),
      );
    }
    return this.agentService;
  }

  /** 子代理管理器接线（幂等；依赖 AgentService 就绪，启动序列在 initImChannels 前调用） */
  initSubagents(): void {
    if (!this.subagentsInitialized) {
      initSubagentManager(this.getAgentService());
      this.subagentsInitialized = true;
    }
  }

  /**
   * 记忆写入口（deferred 模式）：引擎未启动时是占位空实现，首次真实写入才拉起引擎子进程——
   * 记忆是旁路能力，引擎崩溃/未配置都不能阻塞主流程
   */
  getMemoryPort(): MemoryPort {
    return createDeferredMemoryPort(() => this.getMemoryHubService());
  }

  /** 记忆引擎宿主服务（utilityProcess 子进程管理 + HTTP 协议适配） */
  getMemoryHubService(): MemoryHubService {
    if (this.memoryHub === null) {
      this.memoryHub = new MemoryHubService({
        hubRoot: resolveMemoryHubRoot(),
        dataDir: join(app.getPath('userData'), 'memory-hub'),
        llm: resolveDistillLlmConfig,
      });
    }
    return this.memoryHub;
  }
  getLspManager(): LspServerManager {
    if (this.lspManager === null) {
      this.lspManager = new LspServerManager({ serverOverrides: readLsServerOverrides() });
    }
    return this.lspManager;
  }

  /** 目标服务：构造即 mount（订阅回合事件推进目标状态） */
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

  /** IM 服务：构造即挂 agent 桥（渠道消息 → Agent 回合）；渠道连接由 initImChannels 显式恢复 */
  getImService(): ImService {
    if (this.imService === null) {
      this.imService = new ImService();
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

  /** 恢复持久化的 IM 渠道连接（启动序列显式调用；返回的 Promise 由退出链排水等待） */
  async initImChannels(): Promise<void> {
    await this.getImService().restore();
  }

  /** 定时任务调度接线（幂等）：订阅 onFire → 触发会话回合，start() 启动时钟 */
  initCronScheduler(): void {
    if (this.cronInitialized) {
      return;
    }
    this.cronInitialized = true;
    this.cronUnsubscribe = cronService.onFire((task) => this.runCronTurn(task));
    cronService.start();
  }

  // 定时触发即跑一回合：会话仍在 running 时跳过（防上一回合未完叠发）；步骤上限收紧到 20
  private async runCronTurn(task: {
    readonly id: string;
    readonly sessionId: string;
    readonly description: string;
  }): Promise<void> {
    try {
      const session = await this.getSessionService().get(task.sessionId, {
        includeMessages: false,
      });
      if (session.session.lastRunStatus === 'running') {
        logger.warn({ taskId: task.id }, '定时任务跳过：会话正在执行中');
        return;
      }
      const { workingDir } = session.session;
      const prompt = `【定时任务触发】${task.description}`;
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

  async disposeImChannels(): Promise<void> {
    this.imBridge?.unmount();
    this.imBridge = null;
    if (this.imService !== null) {
      await this.imService.stopAll();
      this.imService = null;
    }
  }

  /** 远程控制服务：构造即挂 agent 桥；bindScope 来自 remote-pref（loopback/局域网） */
  getRemoteControlService(): IRemoteControlService {
    if (this.remoteControlService === null) {
      this.remoteControlService = new RemoteControlService({
        bindScope: readRemoteBindScope(),
      });
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

  async releaseRemoteControl(): Promise<void> {
    this.remoteAgentBridge?.unmount();
    this.remoteAgentBridge = null;
    if (this.remoteControlService !== null) {
      await this.remoteControlService.stop();
      this.remoteControlService = null;
    }
  }

  pruneExpiredUsage(): number {
    return this.getSessionService().pruneExpiredUsage();
  }

  resetImChannels(): void {
    this.imService = null;
    this.imBridge = null;
  }

  private getLlmClient(): LlmClient {
    return llmClient;
  }

  setAgentService(service: IAgentService | null): void {
    this.agentService = service;
  }

  getTerminalService(): ITerminalService {
    if (this.terminalService === null) {
      this.terminalService = getTerminalService();
    }
    return this.terminalService;
  }

  setTerminalService(service: ITerminalService | null): void {
    this.terminalService = service;
  }

  getGitService(): IGitService {
    if (this.gitService === null) {
      this.gitService = getGitService();
    }
    return this.gitService;
  }

  setGitService(service: IGitService | null): void {
    this.gitService = service;
  }

  getCodebaseService(): ICodebaseService {
    if (this.codebaseService === null) {
      this.codebaseService = getCodebaseService();
    }
    return this.codebaseService;
  }

  setCodebaseService(service: ICodebaseService | null): void {
    this.codebaseService = service;
  }

  getSessionService(): ISessionService {
    if (this.sessionService === null) {
      this.sessionService = getSessionService();
    }
    return this.sessionService;
  }

  setSessionService(service: ISessionService | null): void {
    this.sessionService = service;
  }

  /**
   * 退出善后链：顺序敏感——cron 停表 → goal/im/remote 摘桥 → agentService drain →
   * 残留 running 标 interrupted → MCP/LSP/权限/基础设施逐层关闭 → AI provider 重置 → **最后关 DB**
   * 单步失败收集到 failures 继续走（createDisposeStep），确保一个卡死服务不拖垮整条链
   */
  async dispose(): Promise<void> {
    logger.info({}, '开始清理应用服务');

    const failures: string[] = [];
    const runStep = createDisposeStep(failures);

    await runStep('cronService.stop', () => {
      this.cronUnsubscribe?.();
      this.cronUnsubscribe = null;
      this.cronInitialized = false;
      cronService.stop();
    });

    await runStep('goalService.unmount', async () => {
      this.goalService?.unmount();
      this.goalService = null;
    });
    await runStep('imBridge.unmount', async () => {
      this.imBridge?.unmount();
      this.imBridge = null;
    });

    await runStep('imService.stopAll', async () => {
      if (this.imService !== null) {
        await this.imService.stopAll();
      }
      this.imService = null;
    });

    await runStep('remoteControl.release', async () => {
      await this.releaseRemoteControl();
    });

    await runStep('agentService.dispose', async () => {
      if (this.agentService !== null) {
        await this.agentService.dispose();
      }
      this.agentService = null;
    });

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

    await runStep('mcpService.stopAll', async () => {
      if (this.mcpService !== null) {
        await this.mcpService.stopAll();
      }
      this.mcpService = null;
    });

    await runStep('lspManager.disposeAll', async () => {
      await this.lspManager?.disposeAll();
      this.lspManager = null;
    });

    await runStep('permissionService.dispose', async () => {
      this.permissionService?.dispose();
      this.permissionService = null;
      this.toolExecutor = null;
      this.toolRegistry = null;
    });

    await runStep('agentAskService.dispose', () => {
      agentAskService.dispose();
    });

    await runStep('fileService.dispose', async () => {
      if (this.fileService !== null) {
        await this.fileService.dispose();
      }
      resetFileService();
      this.fileService = null;
    });

    await runStep('searchService.dispose', async () => {
      if (this.searchService !== null) {
        await this.searchService.dispose();
      }
      resetSearchService();
      this.searchService = null;
    });

    await runStep('terminalService.dispose', async () => {
      if (this.terminalService !== null) {
        await this.terminalService.dispose();
      }
      resetTerminalService();
      this.terminalService = null;
    });

    await runStep('gitService.dispose', async () => {
      if (this.gitService !== null) {
        await this.gitService.dispose();
      }
      resetGitService();
      this.gitService = null;
    });

    await runStep('codebaseService.dispose', async () => {
      if (this.codebaseService !== null) {
        await this.codebaseService.dispose();
      }
      resetCodebaseService();
      this.codebaseService = null;
    });

    await runStep('sessionService.dispose', async () => {
      if (this.sessionService !== null) {
        await this.sessionService.dispose();
      }
      resetSessionService();
      this.sessionService = null;
    });

    this.promptService = null;

    await runStep('memoryHub.stop', async () => {
      if (this.memoryHub !== null) {
        await this.memoryHub.stop();
      }
      this.memoryHub = null;
    });

    await runStep('updateService.dispose', () => {
      this.updateService?.dispose();
      this.updateService = null;
    });

    await runStep('browserPreview.dispose', () => {
      this.browserPreviewService?.dispose();
      this.browserPreviewService = null;
    });

    await runStep('resetAIProvider', () => {
      resetAIProvider();
    });

    await runStep('closeDb', async () => {
      await closeDb();
    });

    if (failures.length > 0) {
      logger.error({ failures }, '应用服务清理完成（部分失败）');
    } else {
      logger.info({}, '应用服务清理完成');
    }
  }

  /** 更新服务：electron-updater 实例注入（isPackaged 探针 + token 工厂由这里给定） */
  getUpdateService(): IUpdateService {
    if (this.updateService === null) {
      this.updateService = new UpdateService(autoUpdater, () => app.isPackaged, createUpdateToken);
    }
    return this.updateService;
  }

  /** 浏览器预览（WebContentsView 独立分区）：挂在首个存活窗口上，与渲染层 iframe 无关 */
  getBrowserPreviewService(): IBrowserPreviewService {
    if (this.browserPreviewService === null) {
      this.browserPreviewService = new BrowserPreviewService({
        getWindow: () => BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ?? null,
      });
    }
    return this.browserPreviewService;
  }

  hasRunningAgentTurns(): boolean {
    return this.agentService?.hasActiveSessions() ?? false;
  }

  reset(): void {
    this.agentService = null;
    this.permissionService = null;
    this.toolExecutor = null;
    this.toolRegistry = null;
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
    void this.releaseRemoteControl();
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
    resetSessionService();
    this.sessionService = null;
    this.promptService = null;
    this.updateService = null;
    this.browserPreviewService?.dispose();
    this.browserPreviewService = null;
    resetAIProvider();
    resetDb();
    resetConfigCache();
  }
}

// 释放单例：disposeServices 只做 dispose 不做单例重置——退出路径专属；
// reset() 是测试用全量重置（含 DB/config 缓存），生产代码不得调用
export const serviceContainer = new ServiceContainer();

// dispose 单步包装：失败记名继续，返回收集器供 dispose 汇总日志
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

/** 启动序列调用：加载运行时模型仓库（用户已配置的自定义模型） */
export async function initRuntimeModels(): Promise<void> {
  await runtimeModelStore.loadAll();
}

/**
 * 崩溃恢复：无条件把残留 running 会话标 interrupted（不依赖崩溃标记——强杀/断电没有标记可查），
 * running 任务标 failed；finally 清崩溃标记
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
    const failedTasks = taskService.markAllRunningFailed();
    if (failedTasks > 0) {
      logger.info({ failedTasks }, '崩溃恢复：残留 running 任务已标记为 failed');
    }
  } finally {
    clearCrashMarker();
  }
}

export async function disposeServices(): Promise<void> {
  await serviceContainer.dispose();
}

export function hasRunningAgentTurns(): boolean {
  return serviceContainer.hasRunningAgentTurns();
}
