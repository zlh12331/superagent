// register.ts：IPC handler 统一注册器——遍历 shared 的 IPC_DEFINITIONS 定义表，
// 对每个 request 通道做 wrap（sender 校验 + zod 契约 + traceId，见 utils/wrap）
// 启动期强断言：handler 缺失或响应 schema 缺失直接抛错拒启（契约闭环不靠约定）
import type { InferHandlers } from '@code-agent/shared/main';
import { IPC_DEFINITIONS } from '@code-agent/shared/main';
import { logger } from '../utils/logger';
import type { IpcHandlerContext } from '../utils/wrap';
import { wrap } from '../utils/wrap';

/**
 * 注册全部 IPC handler（index.ts 启动序列调用，传入按域组装的 handler 对象）
 *
 * @param handlers 形状由 InferHandlers 从定义表推导——缺方法/多方法都会编译期报错
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
