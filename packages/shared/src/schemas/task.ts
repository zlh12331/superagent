// task.ts：任务域（task:list）IPC 契约单一真源——入参 schema、响应条目 TaskInfo 与响应契约 schema。
// 消费方：IPC 定义表 packages/shared/src/ipc/definitions.ts（主进程注册层据此校验入参与返回值）、
// 渲染层类型出口 packages/shared/src/renderer.ts（拉取点 src/renderer/lib/task-actions.ts）。
// 边界：只定契约形状——任务状态机与枚举真源（TaskStatus / TaskKind）在主进程
// src/main/infra/ai/agent/task-service.ts；shared 禁依赖 src（tools/depcruise/.dependency-cruiser.cjs
// 的 shared-pure 规则），故此处 kind / status 只作 string 传递。

import { z } from 'zod';

/** 任务条目（task:list 响应条目）：一条委派工作单元的记录（子代理回合 / 后台命令），即主进程 tasks 表行的领域投影 */
export interface TaskInfo {
  /** 任务 id（uuid） */
  readonly id: string;
  /** 所属会话 id（tasks.session_id 有意不加外键：可指向子代理内部回合的会话，未必存在于会话表） */
  readonly sessionId: string;
  /** agent 子代理 / shell 后台命令 */
  readonly kind: string;
  readonly description: string;
  /** pending / running / completed / failed / cancelled；后三者为终态，进入后不再变更 */
  readonly status: string;
  /** 创建时间（Unix 毫秒；create 时即写入，不是转入 running 的时刻） */
  readonly startTime: number;
  /** 结束时间（Unix 毫秒；仅写入终态时落值，未结束为 null） */
  readonly endTime: number | null;
}

/**
 * task:list 入参 zod schema
 *
 * 会话 id 省略 = 全部会话（主进程 TaskService.list 不传参即查全表）。
 * 尾部的 `.optional().transform(v => v ?? undefined)` 是本仓可选入参的统一写法（同 agent.ts / goal.ts）：
 * 运行时与裸 `.optional()` 等价（省略时都不产生该键）；差异在 z.output 类型——本写法为
 * 「键必填、值 string | undefined」，在 exactOptionalPropertyTypes 下可直赋给本仓声明式形状，
 * 裸 `.optional()` 产出的可选键不可赋。
 */
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
  /**
   * 任务条目列表
   *
   * 主进程 TaskService.list 按 startTime 倒序返回（同毫秒以 id 兜底），最新任务在前；
   * 渲染层右面板据此直接顺序渲染，不再二次排序。
   */
  readonly tasks: readonly TaskInfo[];
}

/**
 * task:list 响应 zod schema（R3：响应契约校验）
 *
 * 形状须与 TaskInfo 手工同步（响应侧 interface 无法反向派生 schema）；
 * 主进程注册时 resSchema 必填（src/main/ipc/register.ts 缺即启动抛错），
 * 漂移只在运行时表现为「IPC 响应契约校验失败」。
 * kind / status 此处只校验 string（值域真源在主进程 TaskStatus / TaskKind，shared 不可引用）。
 */
export const TaskListResSchema = z.object({
  tasks: z.array(
    z.object({
      id: z.string(),
      sessionId: z.string(),
      kind: z.string(),
      description: z.string(),
      status: z.string(),
      startTime: z.number().int(),
      endTime: z.number().int().nullable(),
    }),
  ),
});
