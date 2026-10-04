// src/main/infra/ai/knowledge/goal-service.ts
// 会话目标服务：目标 CRUD + 回合结束自动判定
// ──────────────────────────────────────────────────────────────
// 职责：
// - 创建/查询/清除目标（goals 表持久化，对齐 qwen /goal 语义）
// - 订阅回合事件（onTurnEvent 类级总线）→ TEXT_DELTA 累积转录 + TURN_END 后判定
// - 判定满足 → 标记 completed；impossible → 标记 aborted（附理由）
//
// 设计：
// - 每会话一个 active 目标（新建覆盖旧——旧目标标记 aborted）
// - 判定输入：TEXT_DELTA 累积的助手全文（user 消息不经事件流，不在证据内；
//   纯工具回合/空转录不判定——无证据）
// - 判定失败默认 not met（安全），不阻塞主流程
// - 依赖：IAgentService（onTurnEvent 类级总线）+ GoalJudge + goals 表（getDb）
//   ——转录经事件累积，不读 ISessionService
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
 * 会话目标服务（由 ServiceContainer 惰性创建并持有：getGoalService 创建即
 * mount；dispose/reset 走 unmount——本类自身不是模块单例）
 */
export class GoalService {
  /** 回合转录累积（sessionId → 文本；回合结束后判定并清理） */
  private readonly transcripts = new Map<string, string>();
  /** 是否已挂载回合监听（幂等） */
  private mounted = false;
  /** mount 注册的取消订阅函数（unmount 用；未挂载时为 null） */
  private unsubscribeTurn: (() => void) | null = null;

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
    // P1 修复：保存取消订阅句柄，unmount 时精确移除（此前挂载后无法解除，
    // 容器 dispose/reset 均不清理，挂载监听成为泄漏源）
    this.unsubscribeTurn = this.agentService.onTurnEvent((event) => {
      void this.handleTurnEvent(event);
    });
    logger.info({}, '目标服务已挂载回合监听');
  }

  /**
   * 解除回合监听（应用退出 / 测试隔离时由 ServiceContainer 调用；幂等）
   */
  unmount(): void {
    if (!this.mounted) {
      return;
    }
    this.unsubscribeTurn?.();
    this.unsubscribeTurn = null;
    this.mounted = false;
    logger.info({}, '目标服务已解除回合监听');
  }

  /**
   * 创建会话目标（新建覆盖旧目标——旧目标标记 aborted）
   *
   * 单事务保证「覆盖旧 + 插入新」原子（两步之间不残留中间态）。
   * goals.session_id 外键引用 sessions.id——目标只能挂在已有会话上。
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
            .orderBy(desc(goals.createdAt), desc(goals.id))
            .all()
        : db.select().from(goals).orderBy(desc(goals.createdAt), desc(goals.id)).all();
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
   * 回合事件处理：累积转录（TEXT_DELTA，助手全文）+ 回合结束判定（TURN_END）
   *
   * 判定是异步副作用（await judge）——onTurnEvent 回调内 void 接住，
   * 本方法自身 try/catch 兜底（判定异常不冒泡到事件总线）。
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
   *
   * 判定后无条件 iterations+1（lastReason 落库）；仅 met/impossible 才收敛
   * 终态并落 finishedAt——not met 保持 active，下回合继续累积判定。
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
