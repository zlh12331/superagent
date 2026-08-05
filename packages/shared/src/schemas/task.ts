// packages/shared/src/schemas/task.ts
// 任务状态机域（task:list）
// ──────────────────────────────────────────────
// 设计：任务条目（委派工作单元），会话级注册表提供
// ──────────────────────────────────────────────

import { z } from 'zod';

/** 任务条目（task:list 响应条目） */
export interface TaskInfo {
  readonly id: string;
  readonly sessionId: string;
  /** agent 子代理 / shell 后台命令 */
  readonly kind: string;
  readonly description: string;
  /** pending / running / completed / failed / cancelled */
  readonly status: string;
  readonly startTime: number;
  readonly endTime: number | null;
}

/** task:list 入参 zod schema */
export const TaskListReqSchema = z.object({
  /** 会话 id（省略 = 全部会话） */
  sessionId: z
    .string()
    .min(1)
    .optional()
    .transform((v) => v ?? undefined),
});

/** task:list 响应 payload */
export interface TaskListRes {
  readonly tasks: readonly TaskInfo[];
}
