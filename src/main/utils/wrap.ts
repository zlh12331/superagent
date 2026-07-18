// src/main/utils/wrap.ts
// IPC handler 统一包装器
// 设计文档 §4.7（IPC sender 校验 + traceId 贯穿）、§7.4（错误处理流程）
//
// 职责：
// 1. sender 校验（防止跨窗口越权，Electron Security #17）
// 2. 自动生成 / 接收 traceId（贯穿渲染层 → IPC → 主进程日志 → Sentry）
// 3. zod schema 校验
// 4. try/catch + 错误分类 + Sentry 上报
// 5. 返回统一结构 { data } | { error }

import { randomUUID } from 'node:crypto';
import { AppError, ErrorCode, type IpcError, type IpcResponse } from '@novel-writer/shared';
import * as Sentry from '@sentry/electron/main';
import { BrowserWindow, ipcMain, type WebContents } from 'electron';
import type { ZodType } from 'zod';
import { logger } from './logger';

/**
 * IPC handler 上下文（main 进程专用）
 *
 * 注意：与 @novel-writer/shared 的 IpcContext 不同
 * - shared.IpcContext.sender 是 unknown（preload 注入用，渲染层访问）
 * - IpcHandlerContext.sender 是 WebContents（main 进程专用，可调用 webContents API）
 *
 * traceId 贯穿渲染层 → IPC → 主进程日志 → Sentry
 */
export interface IpcHandlerContext {
  /** 请求追踪 ID（贯穿链路） */
  readonly traceId: string;
  /** 发送方 WebContents（用于回推事件） */
  readonly sender: WebContents;
}

/**
 * 注册 IPC handler（带统一包装）
 *
 * @param channel IPC channel 名（从 IPC_CHANNELS 常量获取）
 * @param schema 入参的 zod schema（null 表示无入参）
 * @param handler 业务处理函数
 */
// biome-ignore lint/style/useNamingConvention: TInput/TOutput 为 TS 泛型惯例，描述入参/出参类型
export function wrap<TInput, TOutput>(
  channel: string,
  schema: ZodType<TInput> | null,
  handler: (input: TInput, ctx: IpcHandlerContext) => Promise<TOutput>,
): void {
  ipcMain.handle(channel, async (evt, input: unknown, incomingTraceId?: string) => {
    // 1. traceId 生成或复用（渲染层可显式传入）
    const traceId = incomingTraceId ?? randomUUID();
    const ctx: IpcHandlerContext = { traceId, sender: evt.sender };

    // 2. sender 校验（Electron Security #17）：防止跨窗口越权调用
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (win === null) {
      logger.error({ traceId, channel }, 'IPC sender 无效');
      const error = new AppError(ErrorCode.IPC_SENDER_INVALID).toIpcError();
      return { error } satisfies IpcResponse<TOutput>;
    }

    // 3. zod 校验（schema 为 null 时跳过，表示无入参）
    let parsedInput: TInput;
    if (schema !== null) {
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        logger.warn({ traceId, channel, issues: parsed.error.issues }, 'IPC 参数校验失败');
        const error = new AppError(ErrorCode.INVALID_INPUT, undefined, parsed.error, {
          issues: parsed.error.issues,
        }).toIpcError();
        return { error } satisfies IpcResponse<TOutput>;
      }
      parsedInput = parsed.data;
    } else {
      // schema 为 null，input 必须为 undefined
      parsedInput = undefined as TInput;
    }

    // 4. 执行 handler，所有日志自动携带 traceId
    try {
      logger.info({ traceId, channel }, 'IPC 请求开始');
      const data = await handler(parsedInput, ctx);
      logger.info({ traceId, channel }, 'IPC 请求成功');
      return { data } satisfies IpcResponse<TOutput>;
    } catch (error: unknown) {
      // 错误分类 + Sentry 上报
      const ipcError = toIpcError(error);
      logger.error({ traceId, channel }, 'IPC 请求失败', error);
      Sentry.captureException(error, { tags: { channel, traceId } });
      return { error: ipcError } satisfies IpcResponse<TOutput>;
    }
  });
}

/**
 * 将任意错误转换为 IpcError
 *
 * - AppError：直接调用 toIpcError()
 * - 其他 Error：包装为 INTERNAL_ERROR
 */
function toIpcError(error: unknown): IpcError {
  if (error instanceof AppError) {
    return error.toIpcError();
  }
  // 非 AppError 包装为内部错误
  const wrapped = new AppError(ErrorCode.INTERNAL_ERROR, undefined, error);
  return wrapped.toIpcError();
}
