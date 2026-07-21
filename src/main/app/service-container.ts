// src/main/app/service-container.ts
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
//   6. resetAIProvider()           清理 AI Provider 缓存（无连接池，仅清空引用）
//
// 注意：
// - 数据库相关清理（Prisma/PG 子进程/Ollama/Embedding）已随数据库层一并删除
// - StreamBridge 已随 Vercel AI SDK v7 迁移一并删除（chat-service 内置 abort 管理）
// - ToolRegistry / ToolExecutor / PermissionService 是 class（非模块级单例），
//   由 ServiceContainer 直接 new，无需 reset 函数
// - AppConfig 无需 dispose（纯内存对象，进程退出即回收）
// - 各模块内部已处理 null 检查，本模块无需重复判空
// - 幂等：多次调用 disposeServices 安全

import { resetConfigCache } from '../config';
import { AgentService, type IAgentService } from '../infra/agent/agent-service';
import type { IPermissionService } from '../infra/agent/permission-service';
import { PermissionService } from '../infra/agent/permission-service';
import type { IToolExecutor } from '../infra/agent/tool-executor';
import { ToolExecutor } from '../infra/agent/tool-executor';
import type { IToolRegistry } from '../infra/agent/tool-registry';
import { ToolRegistry } from '../infra/agent/tool-registry';
import { registerBuiltinTools } from '../infra/agent/tools';
import { resetAIProvider } from '../infra/ai/ai-provider';
import type { IChatService } from '../infra/ai/chat-service';
import { getChatService, resetChatService } from '../infra/ai/chat-service';
import type { IFileService } from '../infra/file/file-service';
import { getFileService, resetFileService } from '../infra/file/file-service';
import type { ISearchService } from '../infra/search/search-service';
import { getSearchService, resetSearchService } from '../infra/search/search-service';
import { logger } from '../utils/logger';

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
      registerBuiltinTools(registry, this.getFileService(), this.getSearchService());
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

  // ─── AgentService（Code Agent 核心，多轮工具调用） ───

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
      this.agentService = new AgentService(this.getToolRegistry(), this.getToolExecutor());
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

    // 6. 清理 AI Provider 缓存（DeepSeek provider 无连接池，仅清空引用让 GC 回收）
    resetAIProvider();

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
    resetAIProvider();
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
