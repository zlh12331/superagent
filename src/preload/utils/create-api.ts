import type { IpcMeta } from '@code-agent/shared/preload';
import type { IpcApi } from '@code-agent/shared/renderer';
import { invoke, subscribe } from './ipc-bridge';

/**
 * 从 IPC 元数据表自动生成 window.api 对象
 *
 * @param meta IPC 元数据表（IPC_META）
 * @returns IpcApi 实现（由类型系统保证形状与定义表一致）
 *
 * @example
 * ```ts
 * const api = createIpcApi(IPC_META);
 * contextBridge.exposeInMainWorld('api', api);
 * ```
 */
export function createIpcApi(meta: IpcMeta): IpcApi {
  const api: Record<string, Record<string, unknown>> = {};

  for (const [domain, methods] of Object.entries(meta)) {
    const domainApi: Record<string, unknown> = {};
    api[domain] = domainApi;
    for (const [method, def] of Object.entries(methods)) {
      if (def.kind === 'request') {
        domainApi[method] = (input: unknown) => invoke(def.channel, input);
      } else {
        domainApi[method] = (callback: (payload: unknown) => void) =>
          subscribe(def.channel, callback);
      }
    }
  }

  return api as unknown as IpcApi;
}
