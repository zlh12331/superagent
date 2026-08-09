// src/main/infra/ai/task-service.ts
// 任务状态机：委派工作单元的生命周期跟踪（对齐 qwen tasks 语义收敛）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 任务注册表（sqlite 持久化，会话级）：create / update / list / get
// - 任务状态机：pending → running → completed / failed / cancelled
// - 集成：SubagentManager 委派时创建任务并随回合结束更新
//
// 借鉴声明：
// 本模块参考 qwen-code 参考项目 packages/core/src/agents/tasks/types.ts
// （Copyright 2026 Qwen Team，SPDX-License-Identifier: Apache-2.0）的
// TaskBase envelope（id/kind/status/startTime/endTime）语义，按我们的
// 技术栈收敛重写：
// - 移除 outputFile / outputOffset（流式输出文件，桌面端由回合事件覆盖）
// - 移除 abortController 联合（我们的中断经 agent-service AbortController 统一管理）
// - 持久化用 sqlite（对齐项目存储体系），会话删除级联清理
// ──────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { logger } from '../../../utils/logger';
import { getDb } from '../../storage/db';
import type { TaskRow } from '../../storage/schema';
import { tasks } from '../../storage/schema';

/** 任务状态机（对齐 qwen TaskState 生命周期收敛） */
export const TaskStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

/** 任务种类 */
export const TaskKind = {
  /** 子代理委派回合 */
  AGENT: 'agent',
  /** 后台命令执行 */
  SHELL: 'shell',
} as const;

export type TaskKind = (typeof TaskKind)[keyof typeof TaskKind];

/** 任务条目 */
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

/** 终端状态（不可再变更） */
const TERMINAL_STATUSES: readonly TaskStatus[] = [
  TaskStatus.COMPLETED,
  TaskStatus.FAILED,
  TaskStatus.CANCELLED,
];

/**
 * 任务服务（模块单例：任务注册表，sqlite 持久化）
 */
export class TaskService {
  /**
   * 创建任务（pending），返回 taskId
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
   * @returns 是否更新成功
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
   * 获取单任务
   */
  get(taskId: string): Task | undefined {
    const db = getDb();
    const row = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    return row === undefined ? undefined : rowToTask(row);
  }
}

/** 行 → 领域类型 */
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

/** 模块级单例（ServiceContainer 与 SubagentManager 共用） */
export const taskService = new TaskService();
