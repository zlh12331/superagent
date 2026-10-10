// agent-ask-service.ts：Agent 主动提问服务——turn 内 ask-user-question 工具的应答中枢
//（渲染层弹卡片，respondAsk IPC 回传答案）；模块级单例（不经容器，AgentService 直引）
import { randomUUID } from 'node:crypto';
import type { AgentAnswer, AgentQuestion, AskResolvedPayload } from '@code-agent/shared/main';
import { IPC_DEFINITIONS } from '@code-agent/shared/main';
import type { WebContents } from 'electron';
import { emitEvent } from '../../../utils/emit-event';
import { logger } from '../../../utils/logger';

interface PendingAsk {
  readonly questions: readonly AgentQuestion[];
  resolve: (answers: AgentAnswer[] | null) => void;
  readonly sessionId: string;
  readonly webContents: WebContents;
}

/** 应答裁决：answered=用户答了 / timed-out=60s 超时 / aborted=回合中止 */
export type AskDecisionOutcome = 'answered' | 'timed-out' | 'aborted';

/** ask 生命周期监听（回合机器据此感知超时；UI 记账用） */
export interface AskLifecycleListener {
  onRequested(payload: { readonly sessionId: string; readonly askId: string }): void;
  onResolved(payload: {
    readonly sessionId: string;
    readonly askId: string;
    readonly decision: AskDecisionOutcome;
  }): void;
}

/** 提问服务：pending 表按 askId 存挂起 Promise，respond 唤醒；超时/中止时 resolve null */
export class AgentAskService {
  private readonly pending = new Map<string, PendingAsk>();
  private readonly lifecycleListeners = new Set<AskLifecycleListener>();

  onAskLifecycle(listener: AskLifecycleListener): () => void {
    this.lifecycleListeners.add(listener);
    return () => {
      this.lifecycleListeners.delete(listener);
    };
  }

  private emitResolved(payload: {
    readonly sessionId: string;
    readonly askId: string;
    readonly decision: AskDecisionOutcome;
  }): void {
    for (const listener of this.lifecycleListeners) {
      try {
        listener.onResolved(payload);
      } catch (err: unknown) {
        logger.error({ error: err }, '提问生命周期 onResolved 异常');
      }
    }
  }

  private emitResolvedToRenderer(
    entry: PendingAsk,
    askId: string,
    decision: AskDecisionOutcome,
  ): void {
    if (entry.webContents.isDestroyed()) {
      return;
    }
    emitEvent(entry.webContents, IPC_DEFINITIONS.agent.subscribeAskResolved, {
      sessionId: entry.sessionId,
      askId,
      decision,
    } satisfies AskResolvedPayload);
  }

  ask(
    webContents: WebContents,
    questions: readonly AgentQuestion[],
    sessionId: string,
  ): Promise<AgentAnswer[] | null> {
    const askId = randomUUID();
    return new Promise((resolve) => {
      this.pending.set(askId, {
        questions,
        resolve,
        sessionId,
        webContents,
      });

      if (webContents.isDestroyed()) {
        this.pending.delete(askId);
        logger.warn({ askId }, 'webContents 已销毁，提问直接返回未响应');
        resolve(null);
        return;
      }

      emitEvent(webContents, IPC_DEFINITIONS.agent.subscribeAsk, {
        sessionId,
        askId,
        questions: questions.map((q) => ({
          question: q.question,
          ...(q.header !== undefined ? { header: q.header } : {}),
          ...(q.options !== undefined ? { options: q.options } : {}),
          ...(q.multiSelect !== undefined ? { multiSelect: q.multiSelect } : {}),
        })),
      });
      logger.info({ askId, questionCount: questions.length }, '提问已推送（ask_user_question）');

      for (const listener of this.lifecycleListeners) {
        try {
          listener.onRequested({ sessionId, askId });
        } catch (err: unknown) {
          logger.error({ error: err }, '提问生命周期 onRequested 异常');
        }
      }
    });
  }

  respond(askId: string, answers: AgentAnswer[]): boolean {
    const entry = this.pending.get(askId);
    if (entry === undefined) {
      logger.warn({ askId }, '回答回传未匹配 pending（已超时或重复响应）');
      return false;
    }
    this.pending.delete(askId);
    entry.resolve(answers);
    logger.info({ askId }, '提问已回答');
    this.emitResolved({ sessionId: entry.sessionId, askId, decision: 'answered' });
    this.emitResolvedToRenderer(entry, askId, 'answered');
    return true;
  }

  expireAsk(askId: string): void {
    const entry = this.pending.get(askId);
    if (entry === undefined) {
      return;
    }
    this.pending.delete(askId);
    logger.warn({ askId }, '提问超时（机器 after 转换触发），返回未响应');
    this.emitResolved({ sessionId: entry.sessionId, askId, decision: 'timed-out' });
    this.emitResolvedToRenderer(entry, askId, 'timed-out');
    entry.resolve(null);
  }

  getPendingCount(): number {
    return this.pending.size;
  }

  dispose(): void {
    for (const [askId, entry] of this.pending) {
      entry.resolve(null);
      logger.debug({ askId }, 'dispose 时清理 pending 提问');
    }
    this.pending.clear();
  }
}

export const agentAskService = new AgentAskService();
