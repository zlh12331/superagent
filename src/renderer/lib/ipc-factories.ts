import type { IpcResponse } from '@code-agent/shared/renderer';

/** 成功响应（{ data: T }） */
export function ipcOk<T>(data: T): IpcResponse<T> {
  return { data };
}

/** 错误响应（{ error: { code, message } }；code 串由调用方保证合法 ErrorCode） */
export function ipcErr(code: string, message: string): IpcResponse<never> {
  return { error: { code, message } } as IpcResponse<never>;
}
