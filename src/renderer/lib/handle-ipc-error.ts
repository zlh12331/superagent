// src/renderer/lib/handle-ipc-error.ts
// IPC 错误统一处理
// 设计文档 §7.4 错误处理流程 / §7.10 用户友好提示
//
// 职责：
// 1. 从 unknown 错误中提取 IpcError（可能是 AppError 或裸 IpcError 对象）
// 2. 根据 ErrorCode 查询 ERROR_META 获取用户友好提示
// 3. 调 sonner toast.error 显示提示，可选操作建议按钮

import { AppError, ERROR_META, ErrorCode, type IpcError } from '@novel-writer/shared';
import { toast } from 'sonner';

/**
 * 从未知错误中提取 IpcError
 *
 * 渲染层 catch 到的 unknown 错误可能是：
 * 1. AppError 实例（unwrap 抛出）→ 调 toIpcError() 序列化
 * 2. 形似 IpcError 的对象（有 code 字段）→ 当 IpcError 用
 * 3. 其他错误 → 包装为 UNKNOWN
 */
function extractIpcError(err: unknown): IpcError {
  // AppError 实例：调 toIpcError() 还原 IPC 传输结构
  if (err instanceof AppError) {
    return err.toIpcError();
  }
  // 形似 IpcError 的对象：有 code 字段则当 IpcError 用
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const maybeErr = err as { code: unknown; message?: unknown; details?: unknown };
    if (typeof maybeErr.code === 'string') {
      const code = maybeErr.code as ErrorCode;
      const message =
        typeof maybeErr.message === 'string' ? maybeErr.message : ERROR_META[code].userMessage;
      // details 条件构造，避免 exactOptionalPropertyTypes 下显式传 undefined
      if (maybeErr.details !== undefined) {
        return { code, message, details: maybeErr.details };
      }
      return { code, message };
    }
  }
  // 其他错误：返回 UNKNOWN
  return {
    code: ErrorCode.UNKNOWN,
    message: err instanceof Error ? err.message : ERROR_META.UNKNOWN.userMessage,
  };
}

/**
 * 根据错误码提供操作建议（如 AI_API_KEY_MISSING → 跳转设置）
 *
 * 简化实现：仅处理几个关键错误码，其他返回 undefined
 * Phase 8 路由集成时再完善跳转方式（避免绕过 RR7）
 */
function getErrorAction(code: ErrorCode): { label: string; onClick: () => void } | undefined {
  switch (code) {
    case ErrorCode.AI_API_KEY_MISSING:
    case ErrorCode.AI_API_KEY_INVALID:
    case ErrorCode.OLLAMA_NOT_INSTALLED:
    case ErrorCode.OLLAMA_NOT_RUNNING:
    case ErrorCode.OLLAMA_MODEL_NOT_FOUND:
      return {
        label: '去设置',
        onClick: () => {
          // Phase 8 通过事件总线触发路由跳转到 /settings
        },
      };
    default:
      return undefined;
  }
}

/**
 * IPC 错误统一处理入口
 *
 * 调用场景：组件 catch 块中
 *
 * @example
 * try { await mutateAsync(...) } catch (err) { handleIpcError(err); }
 */
export function handleIpcError(err: unknown): void {
  const ipcError = extractIpcError(err);
  const meta = ERROR_META[ipcError.code];
  const action = getErrorAction(ipcError.code);
  // ExternalToast.action 是可选属性，exactOptionalPropertyTypes 下不能显式传 undefined
  // 使用条件构造对象，避免传 undefined 给可选属性
  if (action !== undefined) {
    toast.error(meta.userMessage, {
      description: ipcError.message,
      action,
    });
  } else {
    toast.error(meta.userMessage, {
      description: ipcError.message,
    });
  }
}
