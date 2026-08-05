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

/** memory:clear 入参 zod schema */
export const MemoryClearReqSchema = z.object({
  sessionId: z.string().min(1),
});

/** memory:clear 响应 payload */
export interface MemoryClearRes {
  readonly ok: boolean;
}
