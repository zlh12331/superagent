import type { IpcResponse } from '@code-agent/shared/preload';
import { type IpcRendererEvent, ipcRenderer } from 'electron';

/**
 * 调用主进程 IPC handler（请求-响应模式）
 *
 * 自动生成 traceId 并作为第三个参数传入主进程。
 * 主进程 wrap() 会优先使用渲染层传入的 traceId，否则自动生成
 * （见 src/main/utils/wrap.ts §4.7 traceId 贯穿）。
 *
 * traceId 贯穿链路：渲染层 → IPC → 主进程日志，
 * 用于关联一次完整请求的所有日志和错误堆栈，便于排查问题。
 *
 * @typeParam T 响应数据类型（由调用方根据 IpcRequestMap 推断）
 * @param channel IPC channel 名（从 IPC_CHANNELS 常量获取）
 * @param input 请求入参（void channel 时省略）
 * @returns IpcResponse<T>：成功 `{ data }` / 失败 `{ error }`（discriminated union）
 */
export async function invoke<T>(channel: string, input?: unknown): Promise<IpcResponse<T>> {
  const traceId = crypto.randomUUID();
  return ipcRenderer.invoke(channel, input, traceId) as Promise<IpcResponse<T>>;
}

/**
 * 订阅主进程推送的事件（流式 chunk / 状态变更等）
 *
 * 返回 unsubscribe 函数，调用方必须在组件卸载时调用以移除监听器，
 * 否则会造成内存泄漏（设计文档 §4.9 unsubscribe 模式）。
 *
 * 内部通过包装回调实现：
 * 1. 不向渲染层暴露 IpcRendererEvent（Electron Security #17），
 *    只把 payload 透传给业务回调
 * 2. 保留 handler 引用，unsubscribe 时精确移除该监听器
 *    （若用匿名函数则无法移除，导致泄漏）
 *
 * @typeParam T 事件 payload 类型（由调用方根据 IpcEventMap 推断）
 * @param channel 事件 channel 名（从 IPC_CHANNELS 常量获取）
 * @param callback 事件回调（接收 payload）
 * @returns unsubscribe 函数（无参，调用后移除监听器）
 *
 * @example
 * ```ts
 * const unsubscribe = api.chat.onStreamChunk((chunk) => {
 *   console.log(chunk);
 * });
 * // 组件卸载时
 * unsubscribe();
 * ```
 */
export function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => {
    callback(payload);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}
