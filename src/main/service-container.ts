// src/main/service-container.ts
// ServiceContainer：应用单例统一生命周期管理入口
// 设计文档 §4.1 分层架构 / §7.6 生命周期管理
//
// 设计目标：
// 1. 集中持有核心服务实例（IChatService / IAgentService / IFileService / ISearchService
//    / IToolRegistry / IPermissionService / IToolExecutor），统一对外暴露获取接口
// 2. 应用退出时统一清理（替代 index.ts 中分散的 cleanup 调用）
// 3. 测试隔离时统一 reset（避免每个测试手动调用各模块 reset）
// 4. 支持依赖注入：IPC handler 通过容器获取服务实例，而非直接 import 模块级单例
//
// dispose 顺序（反向依赖，先停依赖方再停被依赖方）：
//   1. ChatService.dispose()       中断活跃对话（依赖 streamText + webContents）
//      resetChatService()          清空 ChatService 模块级单例缓存
//   2. AgentService.dispose()      中断活跃 agent 对话（依赖 streamText + tools + ToolExecutor）
//      AgentService 依赖 ToolExecutor（已注入到 executeHook 闭包），
//      必须在 PermissionService.dispose 之前停止，否则 ToolExecutor 会访问已释放的 pending Map
//   3. PermissionService.dispose() reject 所有 pending 审批 Promise
//      ToolExecutor                无外部资源（仅协调层），无需 dispose
//      ToolRegistry                无外部资源（仅 Map），无需 dispose
//   4. FileService.dispose()       关闭所有 chokidar watcher（释放 fs 监听句柄）
//      resetFileService()          清空 FileService 模块级单例缓存
//   5. SearchService.dispose()     终止活跃的 ripgrep 子进程（释放 spawn 句柄）
//      resetSearchService()        清空 SearchService 模块级单例缓存
//   6. TerminalService.dispose()   kill 所有 pty 进程（释放 node-pty 句柄）
//      resetTerminalService()      清空 TerminalService 模块级单例缓存
//   7. GitService                  无外部资源（每次调用 spawn 子进程在请求结束时退出）
//      resetGitService()           清空 GitService 模块级单例缓存
//   8. CodebaseService             无外部资源（每次调用 spawn codegraph 子进程在请求结束时退出）
//      resetCodebaseService()      清空 CodebaseService 模块级单例缓存
//   9. SessionService              无外部资源（db 由 closeDb 单独关闭）
//      resetSessionService()       清空 SessionService 模块级单例缓存
//  10. resetAIProvider()           清理 AI Provider 缓存（无连接池，仅清空引用）
//  11. closeDb()                    关闭 SQLite 连接（必须最后调用，避免 SessionService 后续访问已关闭的 db）
//
// 注意：
// - StreamBridge 已随 Vercel AI SDK v7 迁移一并删除（chat-service 内置 abort 管理）
// - ToolRegistry / ToolExecutor / PermissionService 是 class（非模块级单例），
//   由 ServiceContainer 直接 new，无需 reset 函数
// - AppConfig 无需 dispose（纯内存对象，进程退出即回收）
// - 各模块内部已处理 null 检查，本模块无需重复判空
// - 幂等：多次调用 disposeServices 安全

import { resetConfigCache } from './config';
import { AgentService, type IAgentService } from './infra/ai/agent-service';
import { resetAIProvider } from './infra/ai/ai-provider';
import type { IChatService } from './infra/ai/chat-service';
import { getChatService, resetChatService } from './infra/ai/chat-service';
import { type IMCPService, MCPService } from './infra/ai/mcp';
import type { IPermissionService } from './infra/ai/permission-service';
import { PermissionService } from './infra/ai/permission-service';
import type { IToolExecutor } from './infra/ai/tool-executor';
import { ToolExecutor } from './infra/ai/tool-executor';
import type { IToolRegistry } from './infra/ai/tool-registry';
import { ToolRegistry } from './infra/ai/tool-registry';
import { registerBuiltinTools } from './infra/ai/tools';
import type { IPromptService } from './infra/ai/prompt/prompt-service';
import { PromptService } from './infra/ai/prompt/prompt-service';
import type { ICodebaseService } from './infra/codebase/codebase-service';
import { getCodebaseService, resetCodebaseService } from './infra/codebase/codebase-service';
import type { IFileService } from './infra/file/file-service';
import { getFileService, resetFileService } from './infra/file/file-service';
import type { IGitService } from './infra/git/git-service';
import { getGitService, resetGitService } from './infra/git/git-service';
import type { ISearchService } from './infra/search/search-service';
import { getSearchService, resetSearchService } from './infra/search/search-service';
import { closeDb, resetDb } from './infra/storage/db';
import type { ISessionService } from './infra/storage/session-service';
import { getSessionService, resetSessionService } from './infra/storage/session-service';
import type { ITerminalService } from './infra/terminal/terminal-service';
import { getTerminalService, resetTerminalService } from './infra/terminal/terminal-service';
import { logger } from './utils/logger';

/**
 * 服务容器：持有应用核心服务实例
 *
 * 通过 `serviceContainer.getChatService()` 获取服务实例，
 * 而非直接 import 模块级 getChatService()，便于：
 * - 集中管理生命周期（dispose 时统一中断/重置）
 * - 测试时通过 setChatService 注入 mock 实现
 * - 未来扩展支持服务替换（如多 LLM provider 路由）
 */
class ServiceContainer {
  /**
   * ChatService 实例缓存
   *
   * 设计：内部按 IChatService 接口持有，首次访问时延迟初始化。
   * - 生产环境：通过 getChatService() 拿到默认 ChatService 实现
   * - 测试环境：通过 setChatService() 注入 mock 实现，绕过真实 streamText
   *
   * 缓存值与 getChatService() 模块级单例保持一致：
   * 调用 setChatService(null) 或 reset() 后，下次 getChatService() 会重新拿默认实现。
   */
  private chatService: IChatService | null = null;

  /**
   * 获取 ChatService 实例
   *
   * 首次调用延迟初始化为默认 ChatService 实现（与 getChatService() 单例一致）。
   * 测试可通过 setChatService() 注入 mock 实现覆盖。
   */
  getChatService(): IChatService {
    if (this.chatService === null) {
      this.chatService = getChatService();
    }
    return this.chatService;
  }

  /**
   * 注入 ChatService 实例（仅测试用）
   *
   * 用于测试用例隔离：注入 mock 实现，避免依赖真实 streamText / 网络。
   * 传 null 清空缓存，下次 getChatService() 会重新拿默认实现。
   */
  setChatService(service: IChatService | null): void {
    this.chatService = service;
  }

  /**
   * FileService 实例缓存
   *
   * 设计与 ChatService 一致：
   * - 生产环境：通过 getFileService() 拿到默认 FileService 实现（基于 chokidar v5）
   * - 测试环境：通过 setFileService() 注入 mock 实现，避免依赖真实文件系统
   *
   * 缓存值与 getFileService() 模块级单例保持一致：
   * 调用 setFileService(null) 或 reset() 后，下次 getFileService() 会重新拿默认实现。
   */
  private fileService: IFileService | null = null;

  /**
   * SearchService 实例缓存
   *
   * 设计与 ChatService 一致：
   * - 生产环境：通过 getSearchService() 拿到默认 SearchService 实现（基于 @vscode/ripgrep）
   * - 测试环境：通过 setSearchService() 注入 mock 实现，避免依赖真实 ripgrep 子进程
   *
   * 缓存值与 getSearchService() 模块级单例保持一致：
   * 调用 setSearchService(null) 或 reset() 后，下次 getSearchService() 会重新拿默认实现。
   */
  private searchService: ISearchService | null = null;

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
   * ToolRegistry 实例缓存
   *
   * 设计：由 ServiceContainer 直接 new ToolRegistry（class 实现，非模块级单例）。
   * - 首次访问时延迟初始化，并调用 registerBuiltinTools 注册 5 个内置工具
   *   （read_file / write_file / list_directory / grep / glob）
   * - 测试可通过 setToolRegistry() 注入 mock 实现（如空注册表或预填充工具）
   *
   * 依赖：FileService + SearchService 实例（用于工具工厂创建）
   * 初始化顺序：必须先 getFileService / getSearchService，再初始化 ToolRegistry
   */
  private toolRegistry: IToolRegistry | null = null;

  /**
   * PermissionService 实例缓存
   *
   * 设计：由 ServiceContainer 直接 new PermissionService（class 实现）。
   * - 首次访问时延迟初始化
   * - 测试可通过 setPermissionService() 注入 mock 实现
   * - dispose 时调用 rejectAllPendingApprovals，避免内存泄漏
   */
  private permissionService: IPermissionService | null = null;

  /**
   * ToolExecutor 实例缓存
   *
   * 设计：由 ServiceContainer 直接 new ToolExecutor（class 实现，依赖 ToolRegistry + PermissionService）。
   * - 首次访问时延迟初始化，注入 toolRegistry + permissionService
   * - 测试可通过 setToolExecutor() 注入 mock 实现
   * - ToolExecutor 无外部资源（仅协调层），dispose 时无需调用
   */
  private toolExecutor: IToolExecutor | null = null;

  /**
   * 获取 ToolRegistry 实例
   *
   * 首次调用延迟初始化：
   * 1. new ToolRegistry() 创建空注册表
   * 2. 调用 registerBuiltinTools(registry, fileService, searchService) 注册 5 个内置工具
   *
   * 依赖 FileService + SearchService 实例：先确保已初始化。
   */
  getToolRegistry(): IToolRegistry {
    if (this.toolRegistry === null) {
      const registry = new ToolRegistry();
      // 注册 5 个内置工具（read_file / write_file / list_directory / grep / glob）
      // 依赖 FileService + SearchService 实例
      registerBuiltinTools(
        registry,
        this.getFileService(),
        this.getSearchService(),
        this.getTerminalService(),
        this.getGitService(),
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
      this.permissionService = new PermissionService();
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
   * MCPService 实例缓存
   *
   * 设计：由 ServiceContainer 直接 new MCPService（class 实现，依赖 IToolRegistry）。
   * - 首次访问时延迟初始化，注入当前 ToolRegistry 实例
   * - 测试可通过 setMcpService() 注入 mock 实现（不依赖真实子进程）
   * - dispose 时调用 stopAll()，关闭所有 MCP server 子进程
   *
   * 依赖顺序：必须先 getToolRegistry，再初始化 MCPService
   * （MCPService 通过 ToolRegistry.register / unregister 管理 MCP 工具）
   */
  private mcpService: IMCPService | null = null;

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
  private promptService: IPromptService | null = null;

  getPromptService(): IPromptService {
    if (this.promptService === null) {
      this.promptService = new PromptService();
    }
    return this.promptService;
  }

  setPromptService(service: IPromptService | null): void {
    this.promptService = service;
  }

  // ─── AgentService ───

  /**
   * AgentService 实例缓存
   *
   * 设计：由 ServiceContainer 直接 new AgentService（class 实现，依赖 ToolRegistry + ToolExecutor）。
   * - 首次访问时延迟初始化，注入 toolRegistry + toolExecutor 实例
   * - 测试可通过 setAgentService() 注入 mock 实现（不依赖真实 streamText）
   * - dispose 时调用 AgentService.dispose() 等待活跃 stream 真正完成
   *
   * 依赖顺序：必须先 getToolRegistry / getToolExecutor，再初始化 AgentService
   */
  private agentService: IAgentService | null = null;

  /**
   * 获取 AgentService 实例
   *
   * 首次调用延迟初始化，注入当前 ToolRegistry + ToolExecutor 实例。
   * AgentService 内部通过 ToolRegistry.toAISDKTools(ctx, executeHook) 转换工具，
   * executeHook 注入 ToolExecutor.execute 作为权限检查 + 审批 + IPC 推送层。
   */
  getAgentService(): IAgentService {
    if (this.agentService === null) {
      this.agentService = new AgentService(this.getToolRegistry(), this.getToolExecutor(), this.getPromptService());
    }
    return this.agentService;
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
   * TerminalService 实例缓存
   *
   * 设计与 ChatService / FileService 一致：
   * - 生产环境：通过 getTerminalService() 拿到默认 TerminalService 实现（基于 node-pty）
   * - 测试环境：通过 setTerminalService() 注入 mock 实现，避免依赖真实 PTY 子进程
   *
   * 缓存值与 getTerminalService() 模块级单例保持一致：
   * 调用 setTerminalService(null) 或 reset() 后，下次 getTerminalService() 会重新拿默认实现。
   */
  private terminalService: ITerminalService | null = null;

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
   * GitService 实例缓存
   *
   * 设计与 ChatService / FileService 一致：
   * - 生产环境：通过 getGitService() 拿到默认 GitService 实现（基于 child_process.spawn('git')）
   * - 测试环境：通过 setGitService() 注入 mock 实现，避免依赖真实 git CLI
   *
   * 缓存值与 getGitService() 模块级单例保持一致：
   * 调用 setGitService(null) 或 reset() 后，下次 getGitService() 会重新拿默认实现。
   */
  private gitService: IGitService | null = null;

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
   * CodebaseService 实例缓存
   *
   * 设计与 ChatService / FileService / GitService 一致：
   * - 生产环境：通过 getCodebaseService() 拿到默认 CodebaseService 实现
   *   （基于 child_process.spawn('codegraph')）
   * - 测试环境：通过 setCodebaseService() 注入 mock 实现，避免依赖真实 codegraph CLI
   *
   * 缓存值与 getCodebaseService() 模块级单例保持一致：
   * 调用 setCodebaseService(null) 或 reset() 后，下次 getCodebaseService() 会重新拿默认实现。
   */
  private codebaseService: ICodebaseService | null = null;

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
   * SessionService 实例缓存
   *
   * 设计与 ChatService / FileService / GitService 一致：
   * - 生产环境：通过 getSessionService() 拿到默认 SessionService 实现（基于 drizzle + better-sqlite3）
   * - 测试环境：通过 setSessionService() 注入 mock 实现，避免依赖真实 SQLite
   *
   * 缓存值与 getSessionService() 模块级单例保持一致：
   * 调用 setSessionService(null) 或 reset() 后，下次 getSessionService() 会重新拿默认实现。
   *
   * 注意：SessionService 内部不持有 DB 连接（通过 getDb() 动态获取），
   * db 实例由 initDb() 在应用启动时创建，由 closeDb() 在 dispose 中关闭。
   */
  private sessionService: ISessionService | null = null;

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

    // 1. 优雅关闭 ChatService（P3-10：中断 + 等待 stream 真正完成）
    //    通过容器持有的实例调用（可能为测试注入的 mock），与生产路径一致
    //    dispose 内部会先 abortAll 再 await 所有活跃 stream Promise
    if (this.chatService !== null) {
      await this.chatService.dispose();
    }
    // 同时重置模块级单例（若 ServiceContainer 缓存为空但模块单例仍存活，也需中断）
    // resetChatService 内部会调用 abortAll（幂等，已 abort 过的不会重复触发）
    resetChatService();
    this.chatService = null;

    // 2. 优雅关闭 AgentService（P4：中断 + 等待活跃 agent stream 真正完成）
    //    AgentService 依赖 ToolExecutor（已注入到 executeHook 闭包），
    //    必须在 PermissionService.dispose 之前停止，否则 ToolExecutor 会访问已释放的 pending Map
    //    dispose 内部会先 abortAll 再 await 所有活跃 stream Promise（带 3s 超时兜底）
    if (this.agentService !== null) {
      await this.agentService.dispose();
    }
    this.agentService = null;

    // 2.5 关闭 MCPService（停止所有 MCP server 子进程）
    //     必须在 AgentService 停止后调用（避免活跃 agent 调用已停止的 MCP 工具）
    //     必须在 ToolRegistry 清空之前调用（MCPService 内部会 unregister 工具，再 close client）
    //     MCP server 子进程不关闭会导致进程退出延迟（stdio 子进程会保留在系统进程列表）
    if (this.mcpService !== null) {
      await this.mcpService.stopAll();
    }
    this.mcpService = null;

    // 3. 清理 PermissionService（reject 所有 pending 审批 Promise，避免内存泄漏）
    //    ToolExecutor 与 ToolRegistry 无外部资源（仅 Map / 协调层），无需 dispose
    if (this.permissionService !== null) {
      this.permissionService.dispose();
    }
    this.permissionService = null;
    this.toolExecutor = null;
    this.toolRegistry = null;

    // 4. 关闭 FileService 所有 watcher（释放 chokidar fs 监听句柄）
    //    watcher 句柄不释放会导致进程无法退出（Node.js 事件循环不空）
    if (this.fileService !== null) {
      await this.fileService.dispose();
    }
    resetFileService();
    this.fileService = null;

    // 5. 终止 SearchService 活跃子进程（释放 ripgrep spawn 句柄）
    //    子进程不释放会导致进程退出延迟（Node.js 会等待所有子进程退出）
    if (this.searchService !== null) {
      await this.searchService.dispose();
    }
    resetSearchService();
    this.searchService = null;

    // 6. kill 所有 TerminalService 活跃 pty 进程（释放 node-pty 句柄）
    //    pty 进程不 kill 会导致子进程持续运行（PowerShell/bash 会保留在系统进程列表）
    if (this.terminalService !== null) {
      await this.terminalService.dispose();
    }
    resetTerminalService();
    this.terminalService = null;

    // 7. GitService 无外部资源（每次调用 spawn 子进程在请求结束时退出），
    //    dispose 是 no-op，但保持一致性便于未来扩展（如长连接 git daemon）
    if (this.gitService !== null) {
      await this.gitService.dispose();
    }
    resetGitService();
    this.gitService = null;

    // 8. CodebaseService 无外部资源（每次调用 spawn codegraph 子进程在请求结束时退出），
    //    dispose 是 no-op，但保持一致性便于未来扩展（如缓存查询结果）
    if (this.codebaseService !== null) {
      await this.codebaseService.dispose();
    }
    resetCodebaseService();
    this.codebaseService = null;

    // 9. SessionService 无外部资源（db 由 closeDb 单独关闭）
    //    dispose 是 no-op，但保持一致性便于未来扩展（如查询缓存）
    //    必须在 closeDb 之前调用，避免清空引用后仍有未完成的 DB 访问
    if (this.sessionService !== null) {
      await this.sessionService.dispose();
    }
    resetSessionService();
    this.sessionService = null;

    // 10. PromptService 无外部资源（仅 DB），清空引用即可
    this.promptService = null;

    // 11. 清理 AI Provider 缓存（DeepSeek provider 无连接池，仅清空引用让 GC 回收）
    resetAIProvider();

    // 11. 关闭 SQLite 连接（必须最后调用，避免 SessionService 后续访问已关闭的 db）
    //    better-sqlite3 同步关闭，WAL 文件会自动 checkpoint
    closeDb();

    logger.info({}, '应用服务清理完成');
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
    resetChatService();
    this.chatService = null;
    // AgentService 无模块级单例，直接清空 ServiceContainer 缓存引用
    this.agentService = null;
    // 工具系统无模块级单例，直接清空 ServiceContainer 缓存引用
    this.permissionService = null;
    this.toolExecutor = null;
    this.toolRegistry = null;
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
    resetAIProvider();
    // 关闭并重置 SQLite 连接（必须最后调用，避免 SessionService 后续访问已关闭的 db）
    resetDb();
    resetConfigCache();
  }
}

/** 应用级单例 ServiceContainer */
export const serviceContainer = new ServiceContainer();

/**
 * 应用退出时统一清理所有服务（兼容旧 API）
 *
 * 内部委托给 serviceContainer.dispose()，保留旧导出避免上层大改。
 */
export async function disposeServices(): Promise<void> {
  await serviceContainer.dispose();
}

/**
 * 重置所有服务缓存（仅测试用，兼容旧 API）
 *
 * 内部委托给 serviceContainer.reset()，保留旧导出避免上层大改。
 */
export function resetServices(): void {
  serviceContainer.reset();
}
