// task-service.ts：后台任务跟踪（tasks 表）——agent 子回合与 shell 作业的生命周期记录
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { logger } from '../../../utils/logger';
import { getDb } from '../../storage/db';
import type { TaskRow } from '../../storage/schema';
import { tasks } from '../../storage/schema';

// 状态/类型常量对象（值即类型；崩溃恢复 markAllRunningFailed 依赖 RUNNING 值）
export const TaskStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const TaskKind = {
  AGENT: 'agent',
  SHELL: 'shell',
} as const;

export type TaskKind = (typeof TaskKind)[keyof typeof TaskKind];

/** 任务记录 */
export interface Task {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: TaskKind;
  readonly description: string;
  readonly status: TaskStatus;
  readonly startTime: number;
  readonly endTime: number | null;
}

const TERMINAL_STATUSES: readonly TaskStatus[] = [
  TaskStatus.COMPLETED,
  TaskStatus.FAILED,
  TaskStatus.CANCELLED,
];

/** 任务表 CRUD 服务（模块级单例导出；崩溃恢复由容器 recoverFromCrash 调用） */
export class TaskService {
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

  update(taskId: string, status: TaskStatus): boolean {
    const db = getDb();
    const existing = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (existing === undefined) {
      return false;
    }
    if (TERMINAL_STATUSES.includes(existing.status as TaskStatus)) {
      return false;
    }
    db.update(tasks)
      .set({
        status,
        ...(TERMINAL_STATUSES.includes(status) ? { endTime: Date.now() } : {}),
      })
      .where(eq(tasks.id, taskId))
      .run();
    logger.debug({ taskId, status }, '任务状态更新');
    return true;
  }

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

  get(taskId: string): Task | undefined {
    const db = getDb();
    const row = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    return row === undefined ? undefined : rowToTask(row);
  }

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

export const taskService = new TaskService();
