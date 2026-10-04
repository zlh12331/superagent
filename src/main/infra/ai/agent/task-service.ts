// src/main/infra/ai/agent/task-service.ts
// 任务状态机：委派工作单元的生命周期跟踪（对齐 qwen tasks 语义收敛）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 任务注册表（sqlite 持久化，会话级）：create / update / list / get
// - 任务状态机：pending → running → completed / failed / cancelled
// - 集成：SubagentManager 委派时创建任务（create）并随回合结束更新状态（update）
//
// 借鉴声明：
// 本模块参考 qwen-code 参考项目 packages/core/src/agents/tasks/types.ts
// （Copyright 2026 Qwen Team，SPDX-License-Identifier: Apache-2.0）的
// TaskBase envelope（id/kind/status/startTime/endTime）语义，按我们的
// 技术栈收敛重写：
// - 移除 outputFile / outputOffset（流式输出文件，桌面端由回合事件覆盖）
// - 移除 abortController 联合（我们的中断经 agent-service AbortController 统一管理）
// - 持久化用 sqlite（对齐项目存储体系）
//
// 存储语义（与 schema.ts 的 tasks 表定义一致，勿想当然）：
// tasks.session_id **刻意不加外键**——任务可关联任意 id（含子代理内部回合的
// sessionId）。因此删除会话不会级联删除任务行（session-service.delete 仅删
// sessions 行，级联只覆盖有 FK 的 messages/turns/goals），任务历史按 sessionId
// 独立留存。本文件不提供删除接口，也没有任何其它模块删除 tasks 行。
// ──────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { logger } from '../../../utils/logger';
import { getDb } from '../../storage/db';
import type { TaskRow } from '../../storage/schema';
import { tasks } from '../../storage/schema';

/** 任务状态机的运行时枚举真源（类型 TaskStatus 由本常量表推导，见下） */
export const TaskStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

/** 任务状态机（pending → running → completed/failed/cancelled，见 TaskStatus 常量表） */
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

/** 任务种类的运行时枚举真源（类型 TaskKind 由本常量表推导，见下） */
export const TaskKind = {
  /** 子代理委派回合 */
  AGENT: 'agent',
  /** 后台命令执行（当前仅有枚举定义，尚无写入方使用） */
  SHELL: 'shell',
} as const;

/** 任务种类（agent / shell，见 TaskKind 常量表） */
export type TaskKind = (typeof TaskKind)[keyof typeof TaskKind];

/** 任务条目（list/get 的领域投影，非数据库行本身） */
export interface Task {
  /** 任务 id（uuid） */
  readonly id: string;
  /** 所属会话 id */
  readonly sessionId: string;
  /** 任务种类（agent / shell） */
  readonly kind: TaskKind;
  /** 人类可读描述（任务面板展示） */
  readonly description: string;
  /** 当前状态 */
  readonly status: TaskStatus;
  /** 创建时间（Unix timestamp 毫秒） */
  readonly startTime: number;
  /** 结束时间（未结束为 null） */
  readonly endTime: number | null;
}

/** 终端状态（不可再变更）：update 的幂等锁据此判定 */
const TERMINAL_STATUSES: readonly TaskStatus[] = [
  TaskStatus.COMPLETED,
  TaskStatus.FAILED,
  TaskStatus.CANCELLED,
];

/**
 * 任务服务（模块单例：任务注册表，sqlite 持久化）
 *
 * 无内部状态，全部读写直连 getDb()；类形态仅为便于测试构造与依赖替换。
 */
export class TaskService {
  /**
   * 创建任务（pending），返回 taskId
   *
   * 只写入初始字段：status 固定 PENDING、startTime 取当前时间，endTime 留空
   * （SQLite NULL → 领域层 null）。任务描述不截断，由调用方负责长度。
   */
  create(sessionId: string, kind: TaskKind, description: string): string {
    const id = randomUUID();
    const db = getDb();
    db.insert(tasks)
      .values({
        id,
        sessionId,
        kind,
        description,
        status: TaskStatus.PENDING,
        startTime: Date.now(),
      })
      .run();
    return id;
  }

  /**
   * 更新任务状态（幂等：已结束的任务不再改变——终端状态优先）
   *
   * 终端状态锁定是单向的：一旦任务进入 completed/failed/cancelled，后续任何
   * update 都被拒绝（返回 false），避免迟到的回调把已完成任务改回 running。
   * 仅当目标状态为终端态时才写入 endTime，非终端态保持原 endTime（null）。
   *
   * @returns 是否更新成功（任务不存在或已处于终端态 → false）
   */
  update(taskId: string, status: TaskStatus): boolean {
    const db = getDb();
    const existing = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (existing === undefined) {
      return false;
    }
    // 终端状态锁定
    if (TERMINAL_STATUSES.includes(existing.status as TaskStatus)) {
      return false;
    }
    db.update(tasks)
      .set({
        status,
        // exactOptionalPropertyTypes：非终端状态不写 endTime（保持 null）
        ...(TERMINAL_STATUSES.includes(status) ? { endTime: Date.now() } : {}),
      })
      .where(eq(tasks.id, taskId))
      .run();
    logger.debug({ taskId, status }, '任务状态更新');
    return true;
  }

  /**
   * 列出任务（指定会话或全部；按创建时间倒序 + id 兜底确定性排序）
   *
   * 倒序让最新任务置顶；同毫秒创建的条目用 id 比较兜底，保证同一数据集
   * 多次调用顺序稳定（避免面板抖动）。
   */
  list(sessionId?: string): Task[] {
    const db = getDb();
    const rows =
      sessionId !== undefined
        ? db.select().from(tasks).where(eq(tasks.sessionId, sessionId)).all()
        : db.select().from(tasks).all();
    return rows
      .map(rowToTask)
      .sort((a, b) => b.startTime - a.startTime || b.id.localeCompare(a.id));
  }

  /**
   * 获取单任务（不存在返回 undefined，不抛错）
   */
  get(taskId: string): Task | undefined {
    const db = getDb();
    const row = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    return row === undefined ? undefined : rowToTask(row);
  }

  /**
   * 启动期恢复：把所有残留 running 任务置为 failed（2026-09-08 可靠性修复）
   *
   * 背景：tasks 表持久化 status，但进程异常退出后没有任何恢复逻辑——
   * 任务面板永久显示「运行中」（用户无法分辨是真的在跑还是残留）。
   * 与 sessions 的 markAllInterrupted 同语义，在启动期无条件执行
   * （见 service-container 的 recoverFromCrash 收尾段），不依赖崩溃标记。
   *
   * @returns 被修正的行数
   */
  markAllRunningFailed(): number {
    const db = getDb();
    const result = db
      .update(tasks)
      .set({ status: TaskStatus.FAILED })
      .where(eq(tasks.status, TaskStatus.RUNNING))
      .run();
    return result.changes;
  }
}

/**
 * 行 → 领域类型
 *
 * schema 已用 `$type<TaskKind>()` / `$type<TaskStatus>()` 把列收窄为字面量
 * 联合，此处的 as 断言是把 schema 侧的同形枚举对齐到本模块的本地枚举类型。
 */
function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    sessionId: row.sessionId,
    kind: row.kind as TaskKind,
    description: row.description,
    status: row.status as TaskStatus,
    startTime: row.startTime,
    endTime: row.endTime,
  };
}

/** 模块级单例（ServiceContainer 启动恢复与 SubagentManager / 任务工具共用） */
export const taskService = new TaskService();
