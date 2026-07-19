// src/main/__tests__/helpers/mock-wrap.ts
// wrap mock 共享工具
// 供所有 handler 测试文件使用，捕获 wrap 注册的 channel + schema + handler
//
// 使用模式：
// ```ts
// import { type WrapRegistration, findRegistration } from '../../__tests__/helpers/mock-wrap';
//
// const { registrations } = vi.hoisted(() => ({
//   registrations: [] as WrapRegistration[],
// }));
//
// vi.mock('../../utils/wrap', () => ({
//   wrap: (channel: string, schema: unknown, handler: unknown) => {
//     registrations.push({ channel, schema, handler });
//   },
// }));
//
// // 在测试中提取 handler 回调
// const handler = findRegistration(registrations, IPC_CHANNELS.PROJECT_CREATE).handler;
// const result = await handler({ name: 'test' }, mockCtx);
// ```

/** wrap 注册记录 */
export interface WrapRegistration {
  /** IPC channel 名 */
  readonly channel: string;
  /** zod schema（null 表示无入参） */
  readonly schema: unknown;
  /** handler 回调函数 */
  readonly handler: (input: unknown, ctx: unknown) => Promise<unknown>;
}

/**
 * 按 channel 名查找注册记录
 *
 * @param registrations 注册记录数组
 * @param channel IPC channel 名
 * @returns 匹配的注册记录
 * @throws Error channel 未注册
 */
export function findRegistration(
  registrations: WrapRegistration[],
  channel: string,
): WrapRegistration {
  const reg = registrations.find((r) => r.channel === channel);
  if (reg === undefined) {
    throw new Error(`Channel ${channel} not registered in wrap mock`);
  }
  return reg;
}

/**
 * 按 channel 名获取 handler 回调
 *
 * findRegistration 的便捷封装，直接返回 handler 函数
 */
export function getHandler(
  registrations: WrapRegistration[],
  channel: string,
): WrapRegistration['handler'] {
  return findRegistration(registrations, channel).handler;
}

/**
 * 获取 mock IPC handler 上下文
 *
 * handler 回调的第二个参数 ctx: IpcHandlerContext
 * 测试中只需要 traceId 和 sender 字段
 */
export function createMockCtx(): { traceId: string; sender: unknown } {
  return {
    traceId: 'test-trace-id',
    sender: { isDestroyed: () => false },
  };
}
