// packages/shared/src/schemas/memory.ts
// 记忆系统域（memory:list / clear / clearAll / status）
// ──────────────────────────────────────────────
// 设计：记忆条目绑定会话；capture 自动记录 + recall 跨会话召回。
// 用户可控：enabled 开关（关闭后不捕获新记忆、不注入召回）；
// 状态可见：status 暴露引擎配置/运行/健康与数据量。
// ──────────────────────────────────────────────

import { z } from 'zod';

/** 记忆条目（memory:list 响应条目） */
export interface MemoryInfo {
  readonly id: number;
  readonly sessionId: string;
  readonly content: string;
  /** 引擎记录类型（对话记录为 'conversation'） */
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

/** memory:clearAll 入参 zod schema（无入参：清空全部会话记忆） */
export const MemoryClearAllReqSchema = z.object({});

/** memory:clearAll 响应 payload */
export interface MemoryClearAllRes {
  readonly ok: boolean;
  /** 清除的会话数 */
  readonly clearedSessions: number;
  /** 实际删除的 L0 条数 */
  readonly deletedCount: number;
  /** 失败/部分失败时的说明 */
  readonly message?: string;
}

/** memory:clearAll 响应 zod schema（R3：响应契约校验） */
export const MemoryClearAllResSchema = z.object({
  ok: z.boolean(),
  clearedSessions: z.number().int().nonnegative(),
  deletedCount: z.number().int().nonnegative(),
  message: z.string().optional(),
});

/** memory:status 入参 zod schema（无入参） */
export const MemoryStatusReqSchema = z.object({});

/**
 * 引擎状态（memory:status 响应 payload）
 *
 * 不触发引擎启动（打开设置页不应有副作用）：running=false 时不探测健康，
 * healthy 报 false——"未运行"与"运行但不健康"由 running 区分。
 */
export interface MemoryStatusRes {
  /** 用户开关（关闭后不捕获新记忆、不注入召回） */
  readonly enabled: boolean;
  /** 引擎是否随包提供（hubRoot 可解析到上游入口） */
  readonly available: boolean;
  /** sidecar 进程是否已启动 */
  readonly running: boolean;
  /** 运行中时 /health 是否通过（未运行时恒 false） */
  readonly healthy: boolean;
  /** 已有记忆数据的会话数（读审计镜像统计，不触发引擎） */
  readonly sessionCount: number;
  /** L0 记录总数 */
  readonly recordCount: number;
}

/** memory:status 响应 zod schema（R3：响应契约校验） */
export const MemoryStatusResSchema = z.object({
  enabled: z.boolean(),
  available: z.boolean(),
  running: z.boolean(),
  healthy: z.boolean(),
  sessionCount: z.number().int().nonnegative(),
  recordCount: z.number().int().nonnegative(),
});
