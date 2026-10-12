// goal-service.ts：目标服务——按会话维护目标（goals 表），订阅回合事件攒转录，
// 回合结束调 GoalJudge 判定达成/放弃
import type { GoalInfo, GoalStatus, TurnEvent } from '@code-agent/shared/main';
import { TurnEventType } from '@code-agent/shared/main';
import { desc, eq } from 'drizzle-orm';
import { logger } from '../../../utils/logger';
import { getDb } from '../../storage/db';
import { goals } from '../../storage/schema';
import type { IAgentService } from '../agent/agent-service';
import type { GoalJudge } from './goal-judge';

type GoalStatusInternal = 'active' | 'completed' | 'aborted';

/** 目标服务：mount 订阅回合事件（构造即挂），转录按会话内存暂存 */
export class GoalService {
  private readonly transcripts = new Map<string, string>();
  private mounted = false;
  private unsubscribeTurn: (() => void) | null = null;

  constructor(
    private readonly agentService: IAgentService,
    private readonly goalJudge: GoalJudge,
  ) {}

  mount(): void {
    if (this.mounted) {
      return;
    }
    this.mounted = true;
    this.unsubscribeTurn = this.agentService.onTurnEvent((event) => {
      void this.handleTurnEvent(event);
    });
    logger.info({}, '目标服务已挂载回合监听');
  }

  unmount(): void {
    if (!this.mounted) {
      return;
    }
    this.unsubscribeTurn?.();
    this.unsubscribeTurn = null;
    this.mounted = false;
    logger.info({}, '目标服务已解除回合监听');
  }

  async create(sessionId: string, condition: string): Promise<void> {
    const db = getDb();
    db.transaction((tx) => {
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

  async list(sessionId?: string): Promise<GoalInfo[]> {
    const db = getDb();
    const rows =
      sessionId !== undefined
        ? db
            .select()
            .from(goals)
            .where(eq(goals.sessionId, sessionId))
            .orderBy(desc(goals.createdAt), desc(goals.id))
            .all()
        : db.select().from(goals).orderBy(desc(goals.createdAt), desc(goals.id)).all();
    return rows.map(rowToInfo);
  }

  async clear(sessionId: string): Promise<void> {
    const db = getDb();
    db.update(goals)
      .set({ status: 'aborted' as GoalStatusInternal, finishedAt: Date.now() })
      .where(eq(goals.sessionId, sessionId))
      .run();
    this.transcripts.delete(sessionId);
    logger.info({ sessionId }, '会话目标已清除');
  }

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
