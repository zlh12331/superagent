// src/main/app/service-container.ts
// ServiceContainer：应用单例统一清理与重置入口
// 设计文档 §4.1 分层架构 / §7.6 生命周期管理
//
// 设计目标：
// 1. 应用退出时统一清理（替代 index.ts 中分散的 cleanup 调用）
// 2. 测试隔离时统一 reset（避免每个测试手动调用各模块 reset）
// 3. 不破坏各模块现有 API（getXxxClient 仍可用，本模块仅聚合调用）
//
// dispose 顺序（反向依赖，先停依赖方再停被依赖方）：
//   StreamBridge.abortAll   中断活跃流（依赖 webContents + OpenAI stream）
//   resetOpenAIClient        清理 DeepSeek 客户端缓存（无连接池，仅清空引用）
//
// 注意：
// - 数据库相关清理（Prisma/PG 子进程/Ollama/Embedding）已随数据库层一并删除
// - AppConfig 无需 dispose（纯内存对象，进程退出即回收）
// - 各模块内部已处理 null 检查，本模块无需重复判空
// - 幂等：多次调用 disposeServices 安全

import { resetConfigCache } from '../config';
import { resetOpenAIClient } from '../infra/ai/openai-client';
import { getStreamBridge, resetStreamBridge } from '../infra/ai/stream-bridge';
import { logger } from '../utils/logger';

/**
 * 应用退出时统一清理所有服务
 *
 * 顺序按反向依赖：先中断流式响应，再清理 AI 客户端缓存。
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
export async function disposeServices(): Promise<void> {
  logger.info({}, '开始清理应用服务');

  // 1. 中断所有活跃流式响应（避免 webContents 销毁后继续推送导致 isDestroyed 异常）
  try {
    await getStreamBridge().abortAll();
  } catch (err) {
    logger.error({ error: err }, '中断流式响应失败');
  }

  // 2. 清理 OpenAI Client 缓存（DeepSeek 客户端无连接池，仅清空引用让 GC 回收）
  resetOpenAIClient();

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
export function resetServices(): void {
  resetStreamBridge();
  resetOpenAIClient();
  resetConfigCache();
}
