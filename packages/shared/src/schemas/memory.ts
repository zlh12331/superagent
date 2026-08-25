// packages/shared/src/schemas/memory.ts
// 记忆系统域（memory:list / clear）
// ──────────────────────────────────────────────
// 设计：记忆条目（fact/preference）绑定会话，跨会话召回注入
// ──────────────────────────────────────────────

import { z } from 'zod';

/** 记忆条目（memory:list 响应条目） */
export interface MemoryInfo {
  readonly id: number;
  readonly sessionId: string;
  readonly content: string;
  /** fact 事实 / preference 偏好 */
  readonly kind: string;
  readonly createdAt: number;
}

/** memory:list 入参 zod schema */
export const MemoryListReqSchema = z.object({
  /** 会话 id */
  sessionId: z.string().min(1),
});

/** memory:list 响应 payload */
export interface MemoryListRes {
  readonly memories: readonly MemoryInfo[];
}

/** memory:list 响应 zod schema（R3：响应契约校验） */
export const MemoryListResSchema = z.object({
  memories: z.array(
    z.object({
      id: z.number().int(),
      sessionId: z.string(),
      content: z.string(),
      kind: z.string(),
      createdAt: z.number().int(),
    }),
  ),
});

/** memory:clear 入参 zod schema */
export const MemoryClearReqSchema = z.object({
  sessionId: z.string().min(1),
});

/** memory:clear 响应 payload */
export interface MemoryClearRes {
  readonly ok: boolean;
  /** 实际删除的 L0 条数（上游无该能力/失败时省略或为 0） */
  readonly deletedCount?: number;
}

/** memory:clear 响应 zod schema（R3：响应契约校验） */
export const MemoryClearResSchema = z.object({
  ok: z.boolean(),
  deletedCount: z.number().int().optional(),
});
