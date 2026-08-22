// src/main/ipc/register.ts
// IPC handler 统一注册器：从定义表自动注册 + 编译期一致性保证
// ──────────────────────────────────────────────────────────────
// 职责：
// 1. 遍历 IPC_DEFINITIONS 的 request 方法，逐个 wrap(channel, schema, handler)
// 2. handlers 对象形状受 InferHandlers 约束：缺失任一方法 → 编译期报错
// 3. 运行时兜底：handler 缺失抛错（防类型绕过，如 as any）
//
// 与手写 registerXxxHandlers 的区别：
// - 手写：每个 handler 文件手动 wrap，channel/schema 从定义表取，但"有没有注册"
//   只能靠运行时发现（静默失败）
// - 本注册器：handler 对象缺方法编译期报错，注册循环统一执行，
//   新增 IPC 方法 = 定义表加一行 + 对应域 handler 加一个方法
// ──────────────────────────────────────────────────────────────

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
      // 事件方法无需注册（主进程 webContents.send 主动推送）
      if (def.kind !== 'request') {
        continue;
      }
      // 运行时兜底：类型约束被绕过（如 as any）时仍能发现缺失
      const handler = (handlers as Record<string, Record<string, unknown>>)[domain]?.[method];
      if (handler === undefined) {
        throw new Error(`IPC handler 缺失: ${domain}.${method} (${def.channel})`);
      }
      // P2 修复：响应契约必填断言——resSchema 此前实质可选，新方法漏配时
      // 「响应防漂移」静默失效。启动即抛错（而非运行期才发现）。
      if (def.resSchema === undefined) {
        throw new Error(`IPC 响应契约缺失: ${domain}.${method} (${def.channel})——resSchema 必填`);
      }
      // 复用 wrap：traceId 贯穿 / sender 校验 / zod 校验（入参 + 响应契约）/ 错误分类 / Sentry
      // P2 说明：此处 as never 是异构循环的固有成本——def.schema 是各方法 ZodType 的联合，
      // 无法为 wrap 推断单一 TInput/TOutput；编译期一致性由上方 InferHandlers
      // （handlers 对象形状）与 definitions.ts 的 meta↔definitions parity 检查保证。
      wrap(def.channel, def.schema, handler as never, def.resSchema as never);
      count += 1;
    }
  }

  logger.info({ count, durationMs: Date.now() - start }, 'IPC handler 注册完成（定义表驱动）');
}
