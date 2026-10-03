// src/main/infra/ai/agent/agent-ask-service.ts
// Agent 交互式提问服务（ask_user_question 工具的 pending 闭环）
// ──────────────────────────────────────────────────────────────
// 职责（对齐审批 pending 模式）：
// - ask()：推送提问事件到渲染层 + 注册 pending（await 用户回答）
// - respond()：渲染层回传回答 → resolve 对应 pending
// - expireAsk()：机器 after 超时到期 → 以「未响应」语义 resolve(null)
// - dispose()：清理全部 pending（应用退出/回合中断，避免挂起）
//
// 生命周期订阅（38 号阶段 2 收尾，对齐 permission-service 的 onApprovalLifecycle）：
// 提问同样会挂起工具执行（await 用户回答），机器需据此进入 waitingInput 状态——
// 此前机器完全不感知提问，挂起期间显示 streaming（状态失真）。onAskLifecycle
// 提供 requested/resolved 数据源；超时计时源在机器 after 转换（本服务不自设
// setTimeout），见 AskLifecycleListener 注释。
//
// 与 IPC 的关系：
// - 主进程 emitEvent(IPC_DEFINITIONS.agent.subscribeAsk) 推送提问（统一出口 + dev 契约校验）
// - 渲染层对话框提交后 invoke('agent:ask:respond', req) 回传
// ──────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import type { AgentAnswer, AgentQuestion } from '@code-agent/shared/main';
import { IPC_DEFINITIONS } from '@code-agent/shared/main';
import type { WebContents } from 'electron';
import { emitEvent } from '../../../utils/emit-event';
import { logger } from '../../../utils/logger';

/** 单次提问的 pending 条目 */
interface PendingAsk {
  /** 问题（渲染层展示） */
  readonly questions: readonly AgentQuestion[];
  /** 回答的 resolve（渲染层回传时触发；null = 超时/中断） */
  resolve: (answers: AgentAnswer[] | null) => void;
  /** 所属会话 id（生命周期事件过滤用） */
  readonly sessionId: string;
}

/** 提问决议结果（对齐 ApprovalDecisionOutcome 语义） */
export type AskDecisionOutcome = 'answered' | 'timed-out' | 'aborted';

/** 提问生命周期监听器（Agent 回合状态机 waitingInput 状态的数据源） */
export interface AskLifecycleListener {
  /** 提问已推送（askId + sessionId 供回合过滤） */
  onRequested(payload: { readonly sessionId: string; readonly askId: string }): void;
  /** 提问决议完成（answered/timed-out；aborted 经回合中断路径） */
  onResolved(payload: {
    readonly sessionId: string;
    readonly askId: string;
    readonly decision: AskDecisionOutcome;
  }): void;
}

/**
 * Agent 提问服务（模块级单例，工具系统消费）
 *
 * pending：askId → PendingAsk（一次提问 = 一次 pending）。
 */
export class AgentAskService {
  /** pending 提问 Map */
  private readonly pending = new Map<string, PendingAsk>();
  /** 生命周期监听器（机器 waitingInput 数据源；Set 便于退订） */
  private readonly lifecycleListeners = new Set<AskLifecycleListener>();

  /**
   * 订阅提问生命周期（返回退订函数）
   */
  onAskLifecycle(listener: AskLifecycleListener): () => void {
    this.lifecycleListeners.add(listener);
    return () => {
      this.lifecycleListeners.delete(listener);
    };
  }

  /** 通知监听器（单监听器异常不阻断其他） */
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

  /**
   * 发起提问：推送渲染层 + 等待回答
   *
   * @param webContents 接收提问的窗口
   * @param questions 问题列表（一次可多问）
   * @param sessionId 发起提问的会话（多会话并发时按会话归属弹窗与清理）
   * @returns 用户回答（超时/中断返回 null）
   */
  ask(
    webContents: WebContents,
    questions: readonly AgentQuestion[],
    sessionId: string,
  ): Promise<AgentAnswer[] | null> {
    const askId = randomUUID();
    return new Promise((resolve) => {
      // ⚠️ 38 号阶段 2 收尾：超时计时源在 agent 回合状态机的 after 转换
      // （进入 waitingInput 起算，退出自动取消）；本服务不自设 setTimeout。
      // 超时到期时机器调用 expireAsk（下方）以「未响应」语义 resolve(null)。

      this.pending.set(askId, {
        questions,
        resolve,
        sessionId,
      });

      // P1 修复：webContents 已销毁时立即失败回收（此前无 isDestroyed 守卫，
      // 会 send 到已销毁窗口且 pending 挂满超时）
      if (webContents.isDestroyed()) {
        this.pending.delete(askId);
        logger.warn({ askId }, 'webContents 已销毁，提问直接返回未响应');
        resolve(null);
        return;
      }

      // 推送提问事件到渲染层：走统一出口 emitEvent（dev 环境 payload 契约校验）
      // + 定义表 channel 常量（P1 修复：此前硬编码 'agent:event:ask' 裸字符串，
      // 不在任何真源链上，meta 改名即静默发向死通道）
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

      // 生命周期：真实推送后通知（机器 → waitingInput）
      for (const listener of this.lifecycleListeners) {
        try {
          listener.onRequested({ sessionId, askId });
        } catch (err: unknown) {
          logger.error({ error: err }, '提问生命周期 onRequested 异常');
        }
      }
    });
  }

  /**
   * 渲染层回传回答（agent:ask:respond handler 调用）
   *
   * @param askId 提问 id
   * @param answers 回答列表
   * @returns 是否找到对应 pending（找不到 = 已超时/已响应）
   */
  respond(askId: string, answers: AgentAnswer[]): boolean {
    const entry = this.pending.get(askId);
    if (entry === undefined) {
      logger.warn({ askId }, '回答回传未匹配 pending（已超时或重复响应）');
      return false;
    }
    this.pending.delete(askId);
    entry.resolve(answers);
    logger.info({ askId }, '提问已回答');
    // 生命周期：决议完成（机器 → 回 streaming）
    this.emitResolved({ sessionId: entry.sessionId, askId, decision: 'answered' });
    return true;
  }

  /**
   * 提问超时到期（38 号阶段 2 收尾：由 agent 回合状态机 after 转换调用）
   *
   * 以「未响应」语义 resolve(null)（工具据此返回让 LLM 继续），并通知生命周期
   * decision='timed-out'。askId 不存在时幂等忽略（已被响应/dispose 清理）。
   */
  expireAsk(askId: string): void {
    const entry = this.pending.get(askId);
    if (entry === undefined) {
      return;
    }
    this.pending.delete(askId);
    logger.warn({ askId }, '提问超时（机器 after 转换触发），返回未响应');
    this.emitResolved({ sessionId: entry.sessionId, askId, decision: 'timed-out' });
    entry.resolve(null);
  }

  /** 当前 pending 数（测试/诊断用） */
  getPendingCount(): number {
    return this.pending.size;
  }

  /** 清理全部 pending（应用退出/回合中断） */
  dispose(): void {
    for (const [askId, entry] of this.pending) {
      entry.resolve(null);
      logger.debug({ askId }, 'dispose 时清理 pending 提问');
    }
    this.pending.clear();
  }
}

/** 模块级单例（与 permissionService 生命周期一致） */
export const agentAskService = new AgentAskService();
