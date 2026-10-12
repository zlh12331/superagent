// goal.ts：目标域（goal:create / goal:list / goal:clear）契约单一真源——GoalStatus 值域、
// GoalInfo 条目与三个方法的入参/响应 zod schema（语义对齐 qwen /goal）。
// 边界：本文件只定契约；状态机与 LLM 判定在主进程 src/main/infra/ai/knowledge/goal-service.ts，
// 每会话至多一个 active 目标（新建覆盖旧、清除标记 aborted）。

import { z } from 'zod';

/** 目标状态：completed / aborted 是收敛后的终态，不再回到 active（GoalService.evaluate 只挑 active 行判定） */
export const GoalStatus = {
  ACTIVE: 'active', // 进行中（每会话至多一个；每回合结束由 goal-judge 判定是否满足）
  COMPLETED: 'completed', // 判定满足（met=true）
  ABORTED: 'aborted', // 判定不可能达成（impossible）、用户清除，或新建目标时被覆盖
} as const;

/** GoalStatus 的联合字面量类型（由同名常量对象派生：'active' | 'completed' | 'aborted'） */
export type GoalStatus = (typeof GoalStatus)[keyof typeof GoalStatus];

/** 会话目标（goal:list 响应条目；库表 goals 的业务投影） */
export interface GoalInfo {
  /** 会话 id（外键关联 sessions.id——目标只能挂在已有会话上） */
  readonly sessionId: string;
  /** 目标条件描述（用户原始输入；长度上限见 GoalCreateReqSchema） */
  readonly condition: string;
  /** 状态 */
  readonly status: GoalStatus;
  /** 已判定回合数（每回合结束判定即 +1，无论判定结果） */
  readonly iterations: number;
  /** 最近判定理由（LLM 输出；无判定时为 null） */
  readonly lastReason: string | null;
  /** 创建时间（Unix 毫秒时间戳） */
  readonly createdAt: number;
  /** 离开 active 的时间（完成 / 清除 / 被新目标覆盖）；仍进行中为 null */
  readonly finishedAt: number | null;
}

/**
 * goal:create 入参 zod schema
 */
export const GoalCreateReqSchema = z.object({
  /** 目标会话 id（目标外键挂在会话上——会话不存在时插入被外键拒绝） */
  sessionId: z.string().min(1),
  /**
   * 目标完成条件（如"修复 login 页面的 500 错误"）。
   *
   * 上限 500 是 condition 的唯一长度门禁（goals.condition 列本身无约束）；该文本原样
   * 拼入 goal-judge 的判定提示词，故长度即每回合判定调用成本的增量。
   */
  condition: z.string().min(1).max(500),
});

/**
 * goal:create 响应 payload
 *
 * ok 恒为 true：唯一失败路径（会话不存在等）由 handler 抛错、经 IpcResponse.error 上报，不返回 ok:false。
 */
export interface GoalCreateRes {
  readonly ok: boolean;
}

/**
 * goal:list 入参 zod schema
 *
 * 用 `.optional().transform(v => v ?? undefined)` 而非裸 `.optional()`（本仓可选入参的
 * 统一写法，先例 packages/shared/src/schemas/agent.ts）：z.output 形状是「必填键、值可为
 * undefined」而非「可选键」——在 exactOptionalPropertyTypes 下可直接赋给带 undefined
 * 联合的字段，无需条件展开。渲染层侧两种写法等价（z.input 均允许整键省略）。
 */
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
  /**
   * 按创建时间倒序（最新在前）；顺序由主进程 GoalService.list 保证。
   *
   * 覆盖式新建不清除旧条目（旧目标留在列表里标记 aborted），消费方靠顺序区分
   * 当前目标与历史条目——渲染层从头找第一个 active/completed 即为当前目标。
   */
  readonly goals: readonly GoalInfo[];
}

/**
 * goal:list 响应 zod schema（R3：响应契约校验）
 *
 * 形状须与 GoalInfo 手工同步（响应侧 interface 无法反向派生 schema）；status 字面量
 * 亦须与 GoalStatus 常量对象同步，两处漂移都只在运行时报「响应契约校验失败」。
 */
export const GoalListResSchema = z.object({
  goals: z.array(
    z.object({
      sessionId: z.string(),
      condition: z.string(),
      status: z.enum(['active', 'completed', 'aborted']),
      iterations: z.number().int().nonnegative(),
      lastReason: z.string().nullable(),
      createdAt: z.number().int(),
      finishedAt: z.number().int().nullable(),
    }),
  ),
});

/** goal:clear 入参 zod schema（清除指定会话目标 = 标记 aborted） */
export const GoalClearReqSchema = z.object({
  sessionId: z.string().min(1),
});

/** goal:clear 响应 payload（同 GoalCreateRes：ok 恒为 true，失败经 IpcResponse.error 上报） */
export interface GoalClearRes {
  readonly ok: boolean;
}

/** goal:clear 响应 zod schema（R3：响应契约校验；形状须与 GoalClearRes 手工同步） */
export const GoalClearResSchema = z.object({
  ok: z.boolean(),
});
