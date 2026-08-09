// src/main/infra/ai/cron-service.ts
// 定时任务服务：cron 表达式调度 + sqlite 持久化（对齐 qwen cronScheduler durable 语义收敛）
// ──────────────────────────────────────────────────────────────
// 职责：
// - create/delete/list：cron 任务管理（sqlite 持久化，重启保留）
// - 调度：croner 成熟库（v10）实例化调度——每个任务一个 Cron 实例，
//   秒级内部精度、分钟级表达式天然不重复触发（替代原自研 30s tick）
// - 触发语义：fire 时更新 next_fire_at（下次触发时间）
//
// 借鉴声明：
// 本模块参考 qwen-code 参考项目 packages/core/src/services/cronScheduler.ts
// （Copyright 2026 Qwen Team，SPDX-License-Identifier: Apache-2.0）的
// 调度语义，按我们的技术栈收敛重写：
// - 文件持久化改 sqlite（对齐项目存储体系）
// - 自写 cron-parser 替换为 croner（成熟调度库：校验/时区/秒级精度）
// - 保留核心：表达式调度 + durable 任务 + 到期触发
// ──────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import { eq } from 'drizzle-orm';
import { logger } from '../../utils/logger';
import { getDb } from '../storage/db';
import type { CronTaskRow } from '../storage/schema';
import { cronTasks } from '../storage/schema';

/** cron 任务（领域类型） */
export interface CronTask {
  readonly id: string;
  readonly sessionId: string;
  readonly expression: string;
  readonly description: string;
  readonly nextFireAt: number | null;
  readonly enabled: boolean;
  readonly createdAt: number;
}

/** 触发回调（ServiceContainer 接入 agent 执行；返回 Promise 允许异步处理） */
export type CronFireHandler = (task: CronTask) => Promise<void> | void;

/**
 * 定时任务服务（模块单例）
 */
export class CronService {
  /** taskId → croner 调度实例（运行中任务） */
  private jobs = new Map<string, Cron>();

  /**
   * 创建定时任务（表达式非法抛错）
   *
   * @returns 任务 id
   */
  create(sessionId: string, expression: string, description: string): string {
    const id = randomUUID();
    // croner 构造即校验表达式（非法抛错）；enabled=1 直接运行
    const job = this.createJob(id, expression, false);
    const db = getDb();
    const now = Date.now();
    const nextFireAt = job.nextRun()?.getTime() ?? null;
    db.insert(cronTasks)
      .values({
        id,
        sessionId,
        expression,
        description,
        nextFireAt,
        enabled: 1,
        createdAt: now,
      })
      .run();
    logger.info({ id, expression, nextFireAt }, '定时任务已创建');
    return id;
  }

  /**
   * 删除定时任务（幂等）：停止调度实例 + 删除记录
   */
  delete(taskId: string): boolean {
    const db = getDb();
    const existing = db.select().from(cronTasks).where(eq(cronTasks.id, taskId)).get();
    if (existing === undefined) {
      return false;
    }
    this.stopJob(taskId);
    db.delete(cronTasks).where(eq(cronTasks.id, taskId)).run();
    return true;
  }

  /**
   * 列出定时任务（创建时间倒序 + id 兜底确定性）
   */
  list(): CronTask[] {
    const db = getDb();
    return db
      .select()
      .from(cronTasks)
      .all()
      .map(rowToTask)
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  }

  /**
   * 启用/停用任务（同步调度实例 pause/resume）
   */
  setEnabled(taskId: string, enabled: boolean): boolean {
    const db = getDb();
    const existing = db.select().from(cronTasks).where(eq(cronTasks.id, taskId)).get();
    if (existing === undefined) {
      return false;
    }
    const job = this.jobs.get(taskId);
    if (enabled) {
      // 恢复/新建调度实例：重新计算下次触发
      const active = job ?? this.createJob(taskId, existing.expression, true);
      active.resume();
      const nextFireAt = active.nextRun()?.getTime() ?? null;
      db.update(cronTasks).set({ enabled: 1, nextFireAt }).where(eq(cronTasks.id, taskId)).run();
    } else {
      job?.pause();
      db.update(cronTasks).set({ enabled: 0 }).where(eq(cronTasks.id, taskId)).run();
    }
    return true;
  }

  /**
   * 订阅触发事件（fire 回调；多个订阅者均触发）
   */
  onFire(handler: CronFireHandler): () => void {
    this.fireHandlers.push(handler);
    return () => {
      this.fireHandlers = this.fireHandlers.filter((h) => h !== handler);
    };
  }

  /**
   * 启动调度（应用启动时调用）：从 sqlite 恢复全部启用任务
   * （幂等：已恢复过则直接返回）
   */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    const db = getDb();
    const rows = db.select().from(cronTasks).all();
    let restored = 0;
    for (const row of rows) {
      if (row.enabled !== 1) continue;
      try {
        this.createJob(row.id, row.expression, true);
        restored += 1;
      } catch (err: unknown) {
        // 表达式异常（历史脏数据）：停用任务，防反复失败
        logger.error({ error: err, taskId: row.id }, '定时任务恢复失败，已停用');
        db.update(cronTasks).set({ enabled: 0 }).where(eq(cronTasks.id, row.id)).run();
      }
    }
    logger.info({ restored }, '定时任务调度已启动（croner 恢复）');
  }

  /**
   * 停止调度（应用退出；幂等）：停止全部调度实例
   */
  stop(): void {
    for (const [taskId, job] of this.jobs) {
      try {
        job.stop();
      } catch (err: unknown) {
        logger.warn({ error: err, taskId }, '定时任务停止失败');
      }
    }
    this.jobs.clear();
    this.started = false;
  }

  // ── 内部 ──────────────────────────────────────────────

  private started = false;
  private fireHandlers: CronFireHandler[] = [];

  /**
   * 创建 croner 调度实例并注册到 jobs（表达式非法抛错）
   */
  private createJob(taskId: string, expression: string, initialPaused: boolean): Cron {
    const job = new Cron(
      expression,
      {
        paused: initialPaused, // 本地时区（与 sqlite next_fire_at 语义一致）
      },
      (self) => {
        void this.fire(taskId, expression, self);
      },
    );
    this.jobs.set(taskId, job);
    return job;
  }

  /**
   * 停止并移除调度实例（幂等）
   */
  private stopJob(taskId: string): void {
    const job = this.jobs.get(taskId);
    if (job !== undefined) {
      try {
        job.stop();
      } catch {
        // 已停止实例忽略
      }
      this.jobs.delete(taskId);
    }
  }

  /**
   * 触发：更新 next_fire_at → 通知订阅回调（回调异常不影响调度）
   */
  private async fire(taskId: string, expression: string, job: Cron): Promise<void> {
    const db = getDb();
    const row = db.select().from(cronTasks).where(eq(cronTasks.id, taskId)).get();
    if (row === undefined || row.enabled !== 1) {
      return;
    }
    const nextFireAt = job.nextRun()?.getTime() ?? null;
    db.update(cronTasks).set({ nextFireAt }).where(eq(cronTasks.id, taskId)).run();
    const task: CronTask = { ...rowToTask(row), nextFireAt };
    logger.info({ id: taskId, expression }, '定时任务触发');
    for (const handler of this.fireHandlers) {
      try {
        await handler(task);
      } catch (err: unknown) {
        logger.error({ error: err, taskId }, '定时任务触发回调失败');
      }
    }
  }
}

/** 行 → 领域类型 */
function rowToTask(row: CronTaskRow): CronTask {
  return {
    id: row.id,
    sessionId: row.sessionId,
    expression: row.expression,
    description: row.description,
    nextFireAt: row.nextFireAt,
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
  };
}

/** 模块级单例（ServiceContainer 与工具共用） */
export const cronService = new CronService();
