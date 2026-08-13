// src/main/infra/ai/goal-service.ts
// 会话目标服务：目标 CRUD + 回合结束自动判定
// ──────────────────────────────────────────────────────────────
// 职责：
// - 创建/查询/清除目标（goals 表持久化，对齐 qwen /goal 语义）
// - 订阅 agent 回合结束（onTurnEvent 类级总线）→ 自动判定目标满足度
// - 判定满足 → 标记 completed；impossible → 标记 aborted（附理由）
//
// 设计：
// - 每会话一个 active 目标（新建覆盖旧——旧目标标记 aborted）
// - 判定输入：回合转录（TURN_END 前累积的 user/assistant 文本）
// - 判定失败默认 not met（安全），不阻塞主流程
// - 低耦合：仅依赖 ISessionService（转录读取）+ GoalJudge + 事件总线
// ──────────────────────────────────────────────────────────────

import type { GoalInfo, GoalStatus, TurnEvent } from '@code-agent/shared/main';
import { TurnEventType } from '@code-agent/shared/main';
import { desc, eq } from 'drizzle-orm';
import { logger } from '../../../utils/logger';
import { getDb } from '../../storage/db';
import { goals } from '../../storage/schema';
import type { IAgentService } from '../agent/agent-service';
import type { GoalJudge } from './goal-judge';

/** 目标状态内部类型（shared GoalStatus 映射） */
type GoalStatusInternal = 'active' | 'completed' | 'aborted';

/**
 * 会话目标服务（模块单例，由 ServiceContainer 初始化并挂载回合监听）
 */
export class GoalService {
  /** 回合转录累积（sessionId → 文本；回合结束后判定并清理） */
  private readonly transcripts = new Map<string, string>();
  /** 是否已挂载回合监听（幂等） */
  private mounted = false;

  constructor(
    private readonly agentService: IAgentService,
    private readonly goalJudge: GoalJudge,
  ) {}

  /**
   * 挂载回合结束监听（回合结束后自动判定目标；幂等）
   */
  mount(): void {
    if (this.mounted) {
      return;
    }
    this.mounted = true;
    this.agentService.onTurnEvent((event) => {
      void this.handleTurnEvent(event);
    });
    logger.info({}, '目标服务已挂载回合监听');
  }

  /**
   * 创建会话目标（新建覆盖旧目标——旧目标标记 aborted）
   */
  async create(sessionId: string, condition: string): Promise<void> {
    const db = getDb();
    db.transaction((tx) => {
      // 旧 active 目标标记 aborted
      tx.update(goals)
        .set({ status: 'aborted' as GoalStatusInternal, finishedAt: Date.now() })
        .where(eq(goals.sessionId, sessionId))
        .run();
      tx.insert(goals)
        .values({
          sessionId,
          condition,
          status: 'active',
          iterations: 0,
          createdAt: Date.now(),
        })
        .run();
    });
    logger.info({ sessionId, condition }, '会话目标已创建');
  }

  /**
   * 查询目标（指定会话或全部；按创建时间倒序——最新目标在前，
   * 前端 goals[0] 即当前最新目标，避免取到被覆盖的旧 aborted 目标）
   */
  async list(sessionId?: string): Promise<GoalInfo[]> {
    const db = getDb();
    const rows =
      sessionId !== undefined
        ? db
            .select()
            .from(goals)
            .where(eq(goals.sessionId, sessionId))
            .orderBy(desc(goals.createdAt))
            .all()
        : db.select().from(goals).orderBy(desc(goals.createdAt)).all();
    return rows.map(rowToInfo);
  }

  /**
   * 清除会话目标（标记 aborted，幂等）
   */
  async clear(sessionId: string): Promise<void> {
    const db = getDb();
    db.update(goals)
      .set({ status: 'aborted' as GoalStatusInternal, finishedAt: Date.now() })
      .where(eq(goals.sessionId, sessionId))
      .run();
    this.transcripts.delete(sessionId);
    logger.info({ sessionId }, '会话目标已清除');
  }

  /**
   * 回合事件处理：累积转录（TEXT_DELTA）+ 回合结束判定（TURN_END）
   */
  private async handleTurnEvent(event: TurnEvent): Promise<void> {
    try {
      if (event.type === TurnEventType.TEXT_DELTA) {
        const current = this.transcripts.get(event.sessionId) ?? '';
        this.transcripts.set(event.sessionId, current + event.text);
        return;
      }
      if (event.type !== TurnEventType.TURN_END) {
        return;
      }
      const transcript = this.transcripts.get(event.sessionId) ?? '';
      this.transcripts.delete(event.sessionId);
      await this.evaluate(event.sessionId, transcript);
    } catch (err: unknown) {
      logger.error({ error: err }, '目标判定处理异常');
    }
  }

  /**
   * 回合结束后判定目标（无 active 目标跳过）
   */
  private async evaluate(sessionId: string, transcript: string): Promise<void> {
    const db = getDb();
    const active = db
      .select()
      .from(goals)
      .where(eq(goals.sessionId, sessionId))
      .all()
      .find((row) => row.status === 'active');
    if (active === undefined) {
      return;
    }
    // 空转录（纯工具回合）不判定——无证据
    if (transcript.trim().length === 0) {
      return;
    }

    const judgement = await this.goalJudge.judge(active.condition, transcript);
    db.update(goals)
      .set({
        iterations: active.iterations + 1,
        lastReason: judgement.reason,
        ...(judgement.met || judgement.impossible
          ? {
              status: (judgement.met ? 'completed' : 'aborted') as GoalStatusInternal,
              finishedAt: Date.now(),
            }
          : {}),
      })
      .where(eq(goals.id, active.id))
      .run();

    logger.info(
      {
        sessionId,
        met: judgement.met,
        impossible: judgement.impossible,
        iterations: active.iterations + 1,
      },
      judgement.met ? '目标已达成' : '目标未满足（继续）',
    );
  }
}

/** 行 → 共享类型 */
function rowToInfo(row: typeof goals.$inferSelect): GoalInfo {
  return {
    sessionId: row.sessionId,
    condition: row.condition,
    status: row.status as GoalStatus,
    iterations: row.iterations,
    lastReason: row.lastReason,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}
