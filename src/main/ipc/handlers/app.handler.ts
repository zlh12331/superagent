// src/main/ipc/handlers/app.handler.ts
// 应用级 IPC handler（薄层）
// 设计文档 §4.1 分层架构 / §5.3 完整 Channel 清单 / §7.9 健康监控
//
// 职责：
// 1. 注册 app 域 2 个 channel 的 handler（getStatus / openExternal）
// 2. getStatus：实时读取 pgController + ollamaController 状态 + 测试 Prisma 连接
// 3. openExternal：限制 http/https 协议，防止 file:// 等危险协议
//
// 注意：
// - getStatus 不缓存，每次请求实时读取（保证准确性）
// - ollamaModelReady 暂为 false（后续阶段集成 ensureModelPulled 后更新）
// - openExternal 的 url 校验：z.string().url() + refine 限制 http/https

import { IPC_CHANNELS } from '@novel-writer/shared';
import { shell } from 'electron';
import { z } from 'zod';
import { getPgController } from '../../app/db-init';
import { getOllamaController } from '../../infra/ai/ollama-controller';
import { testPrismaConnection } from '../../infra/prisma/client';
import { wrap } from '../../utils/wrap';

/**
 * 注册 app 域 IPC handler
 *
 * 2 个 channel：
 * - app:getStatus     → 读取 PG / Ollama / DB 状态
 * - app:openExternal  → 打开外部链接（限制 http/https）
 */
export function registerAppHandlers(): void {
  // 获取应用状态（health check）
  //
  // 返回结构：
  // - pgStatus：PG 子进程状态（pg 未初始化时为 'stopped'）
  // - ollamaStatus：Ollama 子进程状态
  // - ollamaModelReady：嵌入模型是否就绪（暂为 false，后续阶段集成）
  // - dbConnected：Prisma 连接是否正常（异常时降级为 false，不抛错）
  wrap(IPC_CHANNELS.APP_GET_STATUS, null, async () => {
    const pg = getPgController();
    const ollama = getOllamaController();
    return {
      pgStatus: pg?.getStatus() ?? 'stopped',
      ollamaStatus: ollama.getStatus(),
      // 后续阶段集成 ensureModelPulled 后更新
      ollamaModelReady: false,
      // testPrismaConnection 失败时降级为 false（不抛错，避免影响状态查询）
      dbConnected: await testPrismaConnection().catch(() => false),
    };
  });

  // 打开外部链接（限制 http/https 协议）
  //
  // 安全考虑：
  // - z.string().url() 校验合法 URL 格式
  // - refine 限制协议为 http/https，防止 file:// / javascript:// 等危险协议
  // - shell.openExternal 由 Electron 调用系统默认浏览器打开
  wrap(
    IPC_CHANNELS.APP_OPEN_EXTERNAL,
    z.object({
      url: z
        .string()
        .url()
        .refine((u) => u.startsWith('http://') || u.startsWith('https://'), {
          message: '只允许 http/https 协议',
        }),
    }),
    async (input) => {
      await shell.openExternal(input.url);
      return { ok: true };
    },
  );
}
