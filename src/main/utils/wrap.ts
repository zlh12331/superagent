import { randomUUID } from 'node:crypto';
import { AppError, ErrorCode, type IpcError, type IpcResponse } from '@code-agent/shared/main';
import { BrowserWindow, ipcMain, type WebContents } from 'electron';
import type { ZodType } from 'zod';
import { reportError } from './error-report';
import { logger } from './logger';

const TRACE_ID_PATTERN = /^[\w-]{8,64}$/;

function isAllowedSenderUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'file:') {
      return parsed.pathname.endsWith('/renderer/index.html');
    }
    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    if (devUrl !== undefined && devUrl.length > 0) {
      return parsed.origin === new URL(devUrl).origin;
    }
    return false;
  } catch {
    return false;
  }
}

export interface IpcHandlerContext {
  readonly traceId: string;
  readonly sender: WebContents;
}

// biome-ignore lint/style/useNamingConvention: TInput/TOutput 为 TS 泛型惯例，描述入参/出参类型
export function wrap<TInput, TOutput>(
  channel: string,
  schema: ZodType<TInput> | null,
  handler: (input: TInput, ctx: IpcHandlerContext) => Promise<TOutput>,
  resSchema?: ZodType<TOutput>,
): void {
  ipcMain.handle(channel, async (evt, input: unknown, incomingTraceId?: string) => {
    const traceId =
      typeof incomingTraceId === 'string' && TRACE_ID_PATTERN.test(incomingTraceId)
        ? incomingTraceId
        : randomUUID();
    const ctx: IpcHandlerContext = { traceId, sender: evt.sender };

    const win = BrowserWindow.fromWebContents(evt.sender);
    if (win === null || !isAllowedSenderUrl(evt.sender.getURL())) {
      logger.error({ traceId, channel, senderUrl: evt.sender.getURL() }, 'IPC sender 无效');
      const error = new AppError(ErrorCode.IPC_SENDER_INVALID).toIpcError();
      return { error } satisfies IpcResponse<TOutput>;
    }

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
      if (input !== undefined) {
        logger.warn({ traceId, channel }, 'IPC 无参方法收到非 undefined 入参');
        const error = new AppError(ErrorCode.INVALID_INPUT, '该方法不接受入参').toIpcError();
        return { error } satisfies IpcResponse<TOutput>;
      }
      parsedInput = undefined as TInput;
    }

    const startTime = performance.now();
    try {
      logger.info({ traceId, channel }, 'IPC 请求开始');
      let data = await handler(parsedInput, ctx);
      if (resSchema !== undefined) {
        const parsedRes = resSchema.safeParse(data);
        if (!parsedRes.success) {
          logger.error(
            { traceId, channel, issues: parsedRes.error.issues },
            'IPC 响应契约校验失败',
          );
          const error = new AppError(ErrorCode.INVALID_RESPONSE, undefined, parsedRes.error, {
            issues: parsedRes.error.issues,
          }).toIpcError();
          return { error } satisfies IpcResponse<TOutput>;
        }
        data = parsedRes.data as typeof data;
      }
      const durationMs = Math.round(performance.now() - startTime);
      logger.info({ traceId, channel, durationMs }, 'IPC 请求成功');
      return { data } satisfies IpcResponse<TOutput>;
    } catch (error: unknown) {
      const ipcError = toIpcError(error);
      const durationMs = Math.round(performance.now() - startTime);
      logger.error(
        { traceId, channel, errorCode: ipcError.code, durationMs },
        'IPC 请求失败',
        error,
      );
      reportError(error, { tags: { channel, traceId, errorCode: ipcError.code } });
      return { error: ipcError } satisfies IpcResponse<TOutput>;
    }
  });
}

function toIpcError(error: unknown): IpcError {
  if (error instanceof AppError) {
    return error.toIpcError();
  }
  const wrapped = new AppError(ErrorCode.INTERNAL_ERROR, undefined, error);
  return wrapped.toIpcError();
}
