import { z } from 'zod';

/**
 * devtools:open 请求 payload
 *
 * mode 字段说明：
 * - 'detach'：独立窗口（推荐，不占用应用主窗口空间）
 * - 'right'：停靠在主窗口右侧
 * - 'bottom'：停靠在主窗口底部
 *
 * schema 用 `.optional().transform(v => v ?? undefined)` 兼容 exactOptionalPropertyTypes：
 * 让 z.infer 推断为 `string | undefined`，与显式 `| undefined` 类型对齐
 */
export const OpenDevToolsReqSchema = z
  .object({
    mode: z.enum(['detach', 'right', 'bottom']).optional(),
  })
  .optional();

/** devtools:open 请求 payload TypeScript 类型 */
export type OpenDevToolsReq = z.infer<typeof OpenDevToolsReqSchema>;

/**
 * devtools:open 响应 payload
 */
export interface OpenDevToolsRes {
  /** 是否成功打开 DevTools（已打开时重复调用会聚焦原窗口，仍返回 true） */
  readonly ok: boolean;
  /** 实际使用的 mode（便于渲染层反馈用户） */
  readonly mode: 'detach' | 'right' | 'bottom';
}

/** devtools:open 响应 zod schema（R4：响应契约校验） */
export const OpenDevToolsResSchema = z.object({
  ok: z.boolean(),
  mode: z.enum(['detach', 'right', 'bottom']),
});
