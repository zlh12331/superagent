// packages/shared/src/schemas/goal.ts
// 会话目标跟踪域（对齐 qwen /goal 语义的持久化收敛）
// ──────────────────────────────────────────────────────────────
// 设计：
// - 目标绑定会话：每会话一个 active 目标（新建覆盖旧，清除标记 aborted）
// - 回合结束后 GoalService 用 LLM 判定 condition 是否满足（goalJudge）
// - 状态机：active → completed（判定满足）/ aborted（用户清除）
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

/** 目标状态：active 进行中 / completed 判定满足 / aborted 用户清除 */
export const GoalStatus = {
  ACTIVE: 'active',
  COMPLETED: 'completed',
  ABORTED: 'aborted',
} as const;

export type GoalStatus = (typeof GoalStatus)[keyof typeof GoalStatus];

/** 会话目标（goal:list 响应条目） */
export interface GoalInfo {
  /** 会话 id */
  readonly sessionId: string;
  /** 目标条件描述 */
  readonly condition: string;
  /** 状态 */
  readonly status: GoalStatus;
  /** 已判定回合数 */
  readonly iterations: number;
  /** 最近判定理由（LLM 输出；无判定时为 null） */
  readonly lastReason: string | null;
  /** 创建时间 */
  readonly createdAt: number;
  /** 完成/清除时间（未结束为 null） */
  readonly finishedAt: number | null;
}

/** goal:create 入参 zod schema */
export const GoalCreateReqSchema = z.object({
  /** 目标会话 id */
  sessionId: z.string().min(1),
  /** 目标完成条件（如"修复 login 页面的 500 错误"） */
  condition: z.string().min(1).max(500),
});

/** goal:create 响应 payload */
export interface GoalCreateRes {
  readonly ok: boolean;
}

/** goal:list 入参 zod schema */
export const GoalListReqSchema = z.object({
  /** 会话 id（省略 = 全部会话） */
  sessionId: z
    .string()
    .min(1)
    .optional()
    .transform((v) => v ?? undefined),
});

/** goal:list 响应 payload */
export interface GoalListRes {
  readonly goals: readonly GoalInfo[];
}

/** goal:clear 入参 zod schema（清除指定会话目标 = 标记 aborted） */
export const GoalClearReqSchema = z.object({
  sessionId: z.string().min(1),
});

/** goal:clear 响应 payload */
export interface GoalClearRes {
  readonly ok: boolean;
}
