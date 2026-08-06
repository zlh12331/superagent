// src/main/infra/ai/cron-service.ts
// 定时任务服务：cron 表达式调度 + sqlite 持久化（对齐 qwen cronScheduler durable 语义收敛）
// ──────────────────────────────────────────────────────────────
// 职责：
// - create/delete/list：cron 任务管理（sqlite 持久化，重启保留）
// - 调度循环：每 30s tick 检查到期任务 → fire（回调挂载点）
// - 触发语义：fire 时更新 next_fire_at（下次触发时间）
//
// 借鉴声明：
// 本模块参考 qwen-code 参考项目 packages/core/src/services/cronScheduler.ts
// （Copyright 2026 Qwen Team，SPDX-License-Identifier: Apache-2.0）的
// 调度语义，按我们的技术栈收敛重写：
// - 移除文件持久化（改 sqlite，对齐项目存储体系）
// - 移除 cronParser 外部依赖（自写 cron-parser.ts）
// - 保留核心：表达式调度 + durable 任务 + 到期触发
// ──────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { logger } from '../../utils/logger';
import { getDb } from '../storage/db';
import type { CronTaskRow } from '../storage/schema';
import { cronTasks } from '../storage/schema';
import { nextFireTime, parseCron } from './cron-parser';

/** 调度 tick 间隔（毫秒） */
const TICK_INTERVAL_MS = 30_000;

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
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private fireHandlers: CronFireHandler[] = [];
  /** 上次 tick 扫描的分钟（同分钟不重复触发） */
  private lastFiredMinute = -1;

  /**
   * 创建定时任务（表达式非法抛错）
   *
   * @returns 任务 id
   */
  create(sessionId: string, expression: string, description: string): string {
    const schedule = parseCron(expression); // 校验表达式
    const id = randomUUID();
    const now = Date.now();
    const nextFireAt = nextFireTime(schedule, new Date()).getTime();
    const db = getDb();
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
   * 删除定时任务（幂等）
   */
  delete(taskId: string): boolean {
    const db = getDb();
    const existing = db.select().from(cronTasks).where(eq(cronTasks.id, taskId)).get();
    if (existing === undefined) {
      return false;
    }
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
   * 启用/停用任务
   */
  setEnabled(taskId: string, enabled: boolean): boolean {
    const db = getDb();
    const existing = db.select().from(cronTasks).where(eq(cronTasks.id, taskId)).get();
    if (existing === undefined) {
      return false;
    }
    if (enabled) {
      // 重新启用：计算下次触发
      const schedule = parseCron(existing.expression);
      db.update(cronTasks)
        .set({
          enabled: 1,
          nextFireAt: nextFireTime(schedule, new Date()).getTime(),
        })
        .where(eq(cronTasks.id, taskId))
        .run();
    } else {
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
   * 启动调度循环（应用启动时调用；幂等）
   */
  start(): void {
    if (this.tickTimer !== null) {
      return;
    }
    this.tickTimer = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);
    logger.info({}, '定时任务调度循环已启动');
  }

  /**
   * 停止调度循环（应用退出；幂等）
   */
  stop(): void {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /**
   * 调度 tick：扫描到期任务并触发（同分钟不重复）
   */
  async tick(): Promise<void> {
    const now = new Date();
    const minuteKey = now.getMinutes();
    if (minuteKey === this.lastFiredMinute) {
      return;
    }
    this.lastFiredMinute = minuteKey;
    const db = getDb();
    const due = db
      .select()
      .from(cronTasks)
      .all()
      .filter(
        (row) => row.enabled === 1 && row.nextFireAt !== null && row.nextFireAt <= now.getTime(),
      );
    for (const row of due) {
      const task = rowToTask(row);
      // 更新下次触发（先算好，避免重复触发）
      let next: number | null = null;
      try {
        const schedule = parseCron(row.expression);
        next = nextFireTime(schedule, now).getTime();
      } catch {
        // 表达式异常：停用任务（防反复失败）
        next = null;
        db.update(cronTasks).set({ enabled: 0 }).where(eq(cronTasks.id, row.id)).run();
      }
      db.update(cronTasks).set({ nextFireAt: next }).where(eq(cronTasks.id, row.id)).run();
      logger.info({ id: row.id, expression: row.expression }, '定时任务触发');
      for (const handler of this.fireHandlers) {
        try {
          await handler({ ...task, nextFireAt: next });
        } catch (err: unknown) {
          logger.error({ error: err, taskId: row.id }, '定时任务触发回调失败');
        }
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
