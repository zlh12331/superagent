// memory.ts：记忆域 IPC 契约——memory:list / clear / clearAll / status 的入参 schema、响应类型与响应 schema
// 消费方：IPC 定义表（packages/shared/src/ipc/definitions.ts）引用，注册层（src/main/ipc/register.ts）强制
// resSchema 必填（缺失即启动抛错）；响应 interface 与 zod schema 成对手写、无 z.infer 派生，增删字段须两处同步。
// 边界：只定义契约形状；list/clear 按会话 id 取值，L0 记录（引擎原始对话层）的读取与 sidecar 生命周期在 src/main/infra/memory-hub/。

import { z } from 'zod';

// ────────── memory:list：按会话列出 L0 对话记录（读 JSONL 审计镜像，不触发引擎启动） ──────────

/** 记忆条目（memory:list 响应条目） */
export interface MemoryInfo {
  /** 条目 id：取上游记录的 timestamp；时间戳缺失（0）时回落为 1-based 序号——仅作列表 key，不是稳定主键 */
  readonly id: number;
  readonly sessionId: string;
  /** 记录文本（一条 = 一条 L0 消息，user / assistant 各成一条） */
  readonly content: string;
  /** 引擎记录类型（对话记录为 'conversation'；当前 list 只返回对话记录） */
  readonly kind: string;
  /** 记录时间（epoch ms；正常即 id 的取值来源） */
  readonly createdAt: number;
}

/** memory:list 入参 zod schema */
export const MemoryListReqSchema = z.object({
  /** 会话 id（与 list / clear 同键） */
  sessionId: z.string().min(1),
});

/** memory:list 响应 payload */
export interface MemoryListRes {
  readonly memories: readonly MemoryInfo[];
}

/** memory:list 响应 zod schema（响应契约校验用） */
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

// ────────── memory:clear：清除指定会话的记忆 ──────────

/** memory:clear 入参 zod schema */
export const MemoryClearReqSchema = z.object({
  /** 会话 id（与 list 同键） */
  sessionId: z.string().min(1),
});

/** memory:clear 响应 payload */
export interface MemoryClearRes {
  /** 是否成功；false 时渲染层须显式判错（主进程用 ok 而非 error 分支表达失败） */
  readonly ok: boolean;
  /** 实际删除的 L0 条数（上游无该能力/失败时省略或为 0） */
  readonly deletedCount?: number;
}

/** memory:clear 响应 zod schema（响应契约校验用） */
export const MemoryClearResSchema = z.object({
  ok: z.boolean(),
  deletedCount: z.number().int().optional(),
});

// ────────── memory:clearAll：清空全部会话的记忆（危险操作，渲染层走 confirm） ──────────

/** memory:clearAll 入参 zod schema（无入参：清空全部会话记忆） */
export const MemoryClearAllReqSchema = z.object({});

/** memory:clearAll 响应 payload */
export interface MemoryClearAllRes {
  /** 全部会话清除成功才为 true；部分失败也为 false，失败明细看 message */
  readonly ok: boolean;
  /** 清除的会话数（部分失败时 = 成功数，非总尝试数） */
  readonly clearedSessions: number;
  /** 实际删除的 L0 条数（部分失败时为已删部分之和） */
  readonly deletedCount: number;
  /** 失败/部分失败时的说明 */
  readonly message?: string;
}

/** memory:clearAll 响应 zod schema（响应契约校验用） */
export const MemoryClearAllResSchema = z.object({
  ok: z.boolean(),
  clearedSessions: z.number().int().nonnegative(),
  deletedCount: z.number().int().nonnegative(),
  message: z.string().optional(),
});

// ────────── memory:status：设置页状态条读数（全部只读，不触发引擎启动） ──────────

/** memory:status 入参 zod schema（无入参：状态与具体会话无关） */
export const MemoryStatusReqSchema = z.object({});

/**
 * 引擎状态（memory:status 响应 payload）
 *
 * 不触发引擎启动（打开设置页不应有副作用）：running=false 时不探测健康，
 * healthy 报 false——"未运行"与"运行但不健康"由 running 区分。
 */
export interface MemoryStatusRes {
  /** 用户开关（memory.enabled 分组，默认 true；关闭后不捕获新记忆、不注入召回） */
  readonly enabled: boolean;
  /** 引擎是否随包提供（hubRoot 可解析到上游入口；为 false 时其余读数无意义） */
  readonly available: boolean;
  /** sidecar 进程是否已启动 */
  readonly running: boolean;
  /** 运行中时 /health 是否通过（未运行时恒 false） */
  readonly healthy: boolean;
  /** 已有记忆数据的会话数（读审计镜像统计，不触发引擎；清空全部按钮的显示条件） */
  readonly sessionCount: number;
  /** L0 记录总数（同上，读审计镜像） */
  readonly recordCount: number;
}

/** memory:status 响应 zod schema（响应契约校验用） */
export const MemoryStatusResSchema = z.object({
  enabled: z.boolean(),
  available: z.boolean(),
  running: z.boolean(),
  healthy: z.boolean(),
  sessionCount: z.number().int().nonnegative(),
  recordCount: z.number().int().nonnegative(),
});
