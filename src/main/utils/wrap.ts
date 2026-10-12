// wrap.ts：IPC handler 统一包装——sender 白名单校验、入参/响应 zod 契约、traceId 贯穿、
// 错误归一为 IpcError。定义表体系（ipc/register.ts）对全部 request 通道套用本包装
import { randomUUID } from 'node:crypto';
import { AppError, ErrorCode, type IpcError, type IpcResponse } from '@code-agent/shared/main';
import { BrowserWindow, ipcMain, type WebContents } from 'electron';
import type { ZodType } from 'zod';
import { reportError } from './error-report';
import { logger } from './logger';

// 渲染层可自带 traceId 贯穿请求日志，但须过白名单（防任意串进日志）；不合规格则重新生成
const TRACE_ID_PATTERN = /^[\w-]{8,64}$/;

// sender 来源白名单：打包态只认产物 index.html，dev 只认 dev server origin——
// 防其他 webContents（预览/外来 iframe）调用本应用 IPC
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

/** handler 执行上下文：贯穿日志的 traceId + 发起方 webContents */
export interface IpcHandlerContext {
  readonly traceId: string;
  readonly sender: WebContents;
}

/**
 * 注册一个被包装的 IPC handler：sender 校验 → 入参 zod 校验（无参方法收到入参即拒）→
 * 执行 → 响应 zod 校验 → { data } / { error }；任何异常归一为 IpcError 并 reportError
 *
 * 全程 traceId 贯穿请求日志（开始/成功/失败同 id 可串联）；TInput/TOutput 为 TS 泛型惯例命名
 */
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

// 非 AppError 的裸异常包装成 INTERNAL_ERROR：内部错误细节只进日志，
// 渲染层拿到的是稳定错误码 + 脱敏消息
function toIpcError(error: unknown): IpcError {
  if (error instanceof AppError) {
    return error.toIpcError();
  }
  const wrapped = new AppError(ErrorCode.INTERNAL_ERROR, undefined, error);
  return wrapped.toIpcError();
}
