import type { InferHandlers } from '@code-agent/shared/main';
import { IPC_DEFINITIONS } from '@code-agent/shared/main';
import { logger } from '../utils/logger';
import type { IpcHandlerContext } from '../utils/wrap';
import { wrap } from '../utils/wrap';

/**
 * 注册全部 IPC handler
 *
 * @param handlers 按域组织的 handler 实现对象
 *                 类型约束：必须覆盖定义表所有 request 方法（缺失编译期报错）
 *
 * @example
 * ```ts
 * registerIpcHandlers({
 *   app: appHandlers,
 *   chat: chatHandlers,
 *   // ... 15 个域
 * });
 * ```
 */
export function registerIpcHandlers(
  handlers: InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>,
): void {
  const start = Date.now();
  let count = 0;

  for (const [domain, methods] of Object.entries(IPC_DEFINITIONS)) {
    for (const [method, def] of Object.entries(methods)) {
      if (def.kind !== 'request') {
        continue;
      }
      const handler = (handlers as Record<string, Record<string, unknown>>)[domain]?.[method];
      if (handler === undefined) {
        throw new Error(`IPC handler 缺失: ${domain}.${method} (${def.channel})`);
      }
      if (def.resSchema === undefined) {
        throw new Error(`IPC 响应契约缺失: ${domain}.${method} (${def.channel})——resSchema 必填`);
      }
      wrap(def.channel, def.schema, handler as never, def.resSchema as never);
      count += 1;
    }
  }

  logger.info({ count, durationMs: Date.now() - start }, 'IPC handler 注册完成（定义表驱动）');
}
