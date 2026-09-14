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
import { AppError, ErrorCode, type IpcError, type IpcResponse } from '@code-agent/shared/main';
import { BrowserWindow, ipcMain, type WebContents } from 'electron';
import type { ZodType } from 'zod';
import { reportError } from './error-report';
import { logger } from './logger';

/** 外部传入 traceId 的合法形状：8-64 位字母数字/连字符/下划线（UUID 与测试 id 均命中；拒绝换行/引号/空白） */
const TRACE_ID_PATTERN = /^[\w-]{8,64}$/;

/**
 * P2 加固：sender 来源 URL 白名单
 *
 * - prod：仅应用自身入口页（file://…/renderer/index.html）
 * - dev：electron-vite dev server 同源（ELECTRON_RENDERER_URL，如 http://localhost:5173）
 *
 * 防止同进程内其他 BrowserWindow / webview 借道调用 IPC。
 */
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

/**
 * IPC handler 上下文（main 进程专用）
 *
 * 注意：与 @code-agent/shared 的 IpcContext 不同
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
 * @param resSchema 响应契约 schema（可选；存在时校验 handler 返回，防手写 Res 接口漂移）
 */
// biome-ignore lint/style/useNamingConvention: TInput/TOutput 为 TS 泛型惯例，描述入参/出参类型
export function wrap<TInput, TOutput>(
  channel: string,
  schema: ZodType<TInput> | null,
  handler: (input: TInput, ctx: IpcHandlerContext) => Promise<TOutput>,
  resSchema?: ZodType<TOutput>,
): void {
  ipcMain.handle(channel, async (evt, input: unknown, incomingTraceId?: string) => {
    // 1. traceId 生成或复用（渲染层可显式传入）
    // P2 加固：校验外部 traceId 形状（preload 传 crypto.randomUUID()）——
    // 此前任意字符串（超长/换行/控制字符）可原样进入结构化日志与 Sentry tags（日志注入面）
    const traceId =
      typeof incomingTraceId === 'string' && TRACE_ID_PATTERN.test(incomingTraceId)
        ? incomingTraceId
        : randomUUID();
    const ctx: IpcHandlerContext = { traceId, sender: evt.sender };

    // 2. sender 校验（Electron Security #17）：防止跨窗口越权调用
    // P2 加固：除「属于应用窗口」外，再校验来源 URL 属于应用自身页面
    // （dev: electron-vite dev server；prod: file:// 应用入口），防其他窗口借道
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (win === null || !isAllowedSenderUrl(evt.sender.getURL())) {
      logger.error({ traceId, channel, senderUrl: evt.sender.getURL() }, 'IPC sender 无效');
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
      // P2 修复：此前静默放行任意 input，「无参方法」契约名存实亡——
      // 渲染层 bug 传参不会被发现。现在非 undefined 一律 INVALID_INPUT 拒绝。
      if (input !== undefined) {
        logger.warn({ traceId, channel }, 'IPC 无参方法收到非 undefined 入参');
        const error = new AppError(ErrorCode.INVALID_INPUT, '该方法不接受入参').toIpcError();
        return { error } satisfies IpcResponse<TOutput>;
      }
      parsedInput = undefined as TInput;
    }

    // 4. 执行 handler，所有日志自动携带 traceId
    const startTime = performance.now();
    try {
      logger.info({ traceId, channel }, 'IPC 请求开始');
      let data = await handler(parsedInput, ctx);
      // 4.5 响应契约校验（resSchema 存在时）：防手写 Res 接口与 handler 实际返回漂移
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
        // P0 收口：zod 默认 strip 未声明字段——必须回写 parsedRes.data 才算
        // 边界生效，否则校验只是"检查"：handler 返回的多余字段（实证：
        // mcp:list config 的 headers/env，schema 未声明）原样越过契约到渲染层。
        // typeof data 断言：handler 返回值实际不会是 Promise（TOutput 非嵌套）。
        data = parsedRes.data as typeof data;
      }
      const durationMs = Math.round(performance.now() - startTime);
      logger.info({ traceId, channel, durationMs }, 'IPC 请求成功');
      return { data } satisfies IpcResponse<TOutput>;
    } catch (error: unknown) {
      // 错误分类 + 统一上报出口（本地结构化日志；后端可回插，见 error-report.ts）
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
