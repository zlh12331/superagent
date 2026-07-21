// src/main/app/service-container.ts
// ServiceContainer：应用单例统一生命周期管理入口
// 设计文档 §4.1 分层架构 / §7.6 生命周期管理
//
// 设计目标：
// 1. 集中持有核心服务实例（如 IChatService），统一对外暴露获取接口
// 2. 应用退出时统一清理（替代 index.ts 中分散的 cleanup 调用）
// 3. 测试隔离时统一 reset（避免每个测试手动调用各模块 reset）
// 4. 支持依赖注入：IPC handler 通过容器获取服务实例，而非直接 import 模块级单例
//
// dispose 顺序（反向依赖，先停依赖方再停被依赖方）：
//   ChatService.abortAll          中断活跃对话（依赖 streamText + webContents）
//   resetChatService              清空 ChatService 单例缓存
//   resetAIProvider                清理 AI Provider 缓存（无连接池，仅清空引用）
//
// 注意：
// - 数据库相关清理（Prisma/PG 子进程/Ollama/Embedding）已随数据库层一并删除
// - StreamBridge 已随 Vercel AI SDK v7 迁移一并删除（chat-service 内置 abort 管理）
// - AppConfig 无需 dispose（纯内存对象，进程退出即回收）
// - 各模块内部已处理 null 检查，本模块无需重复判空
// - 幂等：多次调用 disposeServices 安全

import { resetConfigCache } from '../config';
import { resetAIProvider } from '../infra/ai/ai-provider';
import type { IChatService } from '../infra/ai/chat-service';
import { getChatService, resetChatService } from '../infra/ai/chat-service';
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
   * 应用退出时统一清理所有服务
   *
   * 顺序按反向依赖：先优雅关闭 ChatService（中断 + 等待 stream 真正完成），再清理 AI Provider 缓存。
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

    // 2. 清理 AI Provider 缓存（DeepSeek provider 无连接池，仅清空引用让 GC 回收）
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
