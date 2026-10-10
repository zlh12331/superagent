import { randomUUID } from 'node:crypto';
import type { AgentAnswer, AgentQuestion, AskResolvedPayload } from '@code-agent/shared/main';
import { IPC_DEFINITIONS } from '@code-agent/shared/main';
import type { WebContents } from 'electron';
import { emitEvent } from '../../../utils/emit-event';
import { logger } from '../../../utils/logger';

/**
 * 单次提问的挂起条目
 *
 * 只持有解除挂起所需的最小集：resolve 回调 + 归属会话（生命周期事件过滤用）。
 * questions 是推送时刻的快照——服务自身不读它（渲染层经 IPC 载荷拿问题），
 * 保留是为诊断时能从 pending 还原「当时问了什么」。
 */
interface PendingAsk {
  /** 问题快照（诊断用；服务逻辑不读） */
  readonly questions: readonly AgentQuestion[];
  /** 回答的 resolve（三个出口共用：作答传 answers / 超时与退出传 null） */
  resolve: (answers: AgentAnswer[] | null) => void;
  /** 归属会话 id（生命周期事件按会话过滤，多会话并发互不串扰） */
  readonly sessionId: string;
  /**
   * 接收提问的窗口（决议事件回推目标）
   *
   * 超时等**非用户路径**必须让渲染层知道条目已死，否则弹窗永久残留；且
   * 队列化后（前端按 FIFO 逐条呈现）已超时的队头会阻塞后续提问。
   * 与提问推送同源（ask 的入参）——同一窗口收发保证配对。
   */
  readonly webContents: WebContents;
}

/**
 * 提问决议结果（形态对齐 permission-types 的 ApprovalDecisionOutcome）
 *
 * ⚠️ 'aborted' 当前无生产者：用户中断回合时由 dispose() 静默清理（不通知
 * 生命周期——机器直接走 aborted 终态，无需 waitingInput 出口）。保留该值是为
 * 与审批枚举对称，将来若需「提问被中断」的可观测性再接线。
 */
export type AskDecisionOutcome = 'answered' | 'timed-out' | 'aborted';

/**
 * 提问生命周期监听器（agent 回合状态机 waitingInput 状态的数据源）
 *
 * 由 turn-subscriptions.subscribeAskLifecycle 实现：按 sessionId 过滤后
 * send 机器事件（requested → waitingInput；resolved → 回 streaming）。
 */
export interface AskLifecycleListener {
  /** 提问已推送渲染层（真实推送后触发，非注册时） */
  onRequested(payload: { readonly sessionId: string; readonly askId: string }): void;
  /**
   * 提问决议完成（作答 / 超时；'aborted' 不经此回调，见 AskDecisionOutcome）
   */
  onResolved(payload: {
    readonly sessionId: string;
    readonly askId: string;
    readonly decision: AskDecisionOutcome;
  }): void;
}

/**
 * Agent 提问服务
 *
 * 不变量：pending 中的每个 askId 恰好对应一个悬置 Promise，且恰有一条出口
 * 路径（respond / expireAsk / dispose）消费它——三处出口都先 delete 再 resolve，
 * 故重复调用是幂等的（第二个调用找不到条目即返回）。
 */
export class AgentAskService {
  /** pending 提问表（askId → 挂起条目；一次提问一条） */
  private readonly pending = new Map<string, PendingAsk>();
  /** 生命周期监听器（回合结束/机器销毁时退订；单监听器异常不阻断其他） */
  private readonly lifecycleListeners = new Set<AskLifecycleListener>();

  /**
   * 订阅提问生命周期
   *
   * @returns 退订函数（宿主在回合终态 cleanup 中调用，防监听器泄漏）
   */
  onAskLifecycle(listener: AskLifecycleListener): () => void {
    this.lifecycleListeners.add(listener);
    return () => {
      this.lifecycleListeners.delete(listener);
    };
  }

  /**
   * 广播决议完成（respond / expireAsk 两个出口共用）
   *
   * 两条通路：
   * 1. 进程内 lifecycle 监听器（回合状态机 → 退出 waitingInput）
   * 2. 渲染层回推（agent:event:ask:resolved）——**非用户路径**（超时）必须
   *    让前端知道条目已死，否则弹窗永久残留；队列化后已超时的队头还会阻塞
   *    后续提问（2026-10-08 补齐，与此前审批的决议回推对称）
   *
   * 逐个 try/catch：某个监听器抛错不得影响其余监听器，也不得阻断 resolve
   * （挂起解除是主职责，通知是附加语义）。
   */
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
   * 决议回推渲染层（agent:event:ask 的配对事件）
   *
   * @param entry 已出队的 pending 条目（携带发起窗口；已销毁时静默跳过）
   * @param askId 提问 id（渲染层据此定位待答条目）
   * @param decision 决议结果
   */
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

  /**
   * 发起提问：注册挂起 → 推送渲染层 → 返回悬置 Promise
   *
   * @param webContents 接收提问的窗口（调用方已保证非空且未销毁——见工具侧守卫）
   * @param questions 问题列表（一次可多问，渲染层逐题作答）
   * @param sessionId 发起提问的会话（并发回合时按会话归属弹窗与清理）
   * @returns 用户回答数组（顺序与 questions 对齐）；超时/中断/无窗口均为 null
   */
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

  /**
   * 渲染层回传回答（agent-ask.handler 的 respondAsk 调用）
   *
   * @param askId 提问 id
   * @param answers 回答列表（取消/跳过时为空数组——语义上「用户未选择」，
   *   与超时的 null 区分：前者是用户主动行为，后者是无人应答）
   * @returns 是否命中 pending（false = 已超时/已作答/已清理，回传无害丢弃）
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
    this.emitResolved({ sessionId: entry.sessionId, askId, decision: 'answered' });
    this.emitResolvedToRenderer(entry, askId, 'answered');
    return true;
  }

  /**
   * 提问超时到期（agent 回合状态机 after.askTimeout 转换调用）
   *
   * 以「未响应」语义 resolve(null)：工具据此返回让 LLM 继续（不是错误，
   * 与审批超时的 reject 不同——提问是信息收集，缺席不应阻断回合）。
   *
   * 幂等：askId 不存在时静默返回（已被 respond / dispose 消费）。
   */
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

  /**
   * 当前挂起数（测试/诊断用；无生产消费方）
   */
  getPendingCount(): number {
    return this.pending.size;
  }

  /**
   * 清理全部挂起（应用退出 / 回合中断）
   *
   * 由 service-container 的 dispose 链调用（两处：disposeServices 的
   * agentAskService.dispose 步骤 + disposeInfraServices 的服务重置段——
   * 两处均幂等，重复调用无害）。全部 resolve(null)：中断语义与超时一致
   * （工具返回「未响应」，LLM 自行继续），但**不发 onResolved**——回合已中断，
   * 机器走 aborted 终态，无需 waitingInput 出口。
   */
  dispose(): void {
    for (const [askId, entry] of this.pending) {
      entry.resolve(null);
      logger.debug({ askId }, 'dispose 时清理 pending 提问');
    }
    this.pending.clear();
  }
}

/** 模块级单例（调用方：ask 工具 / IPC handler / 回合宿主 / 容器 dispose 链） */
export const agentAskService = new AgentAskService();
