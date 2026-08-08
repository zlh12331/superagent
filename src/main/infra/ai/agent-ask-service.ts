// src/main/infra/ai/agent-ask-service.ts
// Agent 交互式提问服务（ask_user_question 工具的 pending 闭环）
// ──────────────────────────────────────────────────────────────
// 职责（对齐审批 pending 模式）：
// - ask()：推送提问事件到渲染层 + 注册 pending（await 用户回答）
// - respond()：渲染层回传回答 → resolve 对应 pending
// - dispose()：清理全部 pending（应用退出/回合中断，避免挂起）
//
// 与 IPC 的关系：
// - 主进程 webContents.send('agent:event:ask', payload) 推送提问
// - 渲染层对话框提交后 invoke('agent:ask:respond', req) 回传
// ──────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import type { AgentAnswer, AgentQuestion } from '@code-agent/shared/main';
import type { WebContents } from 'electron';
import { logger } from '../../utils/logger';

/** 单次提问的 pending 条目 */
interface PendingAsk {
  /** 问题（渲染层展示） */
  readonly questions: readonly AgentQuestion[];
  /** 回答的 resolve（渲染层回传时触发；null = 超时/中断） */
  resolve: (answers: AgentAnswer[] | null) => void;
  /** 超时清理 */
  timer: NodeJS.Timeout;
}

/** 提问超时（毫秒）：用户长时间未响应，工具返回「未响应」让 LLM 继续 */
const ASK_TIMEOUT_MS = 60_000;

/**
 * Agent 提问服务（模块级单例，工具系统消费）
 *
 * pending：askId → PendingAsk（一次提问 = 一次 pending）。
 */
export class AgentAskService {
  /** pending 提问 Map */
  private readonly pending = new Map<string, PendingAsk>();

  /**
   * 发起提问：推送渲染层 + 等待回答
   *
   * @param webContents 接收提问的窗口
   * @param questions 问题列表（一次可多问）
   * @returns 用户回答（超时返回 null）
   */
  ask(
    webContents: WebContents,
    questions: readonly AgentQuestion[],
  ): Promise<AgentAnswer[] | null> {
    const askId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(askId);
        logger.warn({ askId }, '提问超时（60s），工具返回未响应');
        resolve(null);
      }, ASK_TIMEOUT_MS);

      this.pending.set(askId, {
        questions,
        resolve,
        timer,
      });

      // 推送提问事件到渲染层（Payload 含问题与 askId）
      webContents.send('agent:event:ask', {
        askId,
        questions: questions.map((q) => ({
          question: q.question,
          ...(q.header !== undefined ? { header: q.header } : {}),
          ...(q.options !== undefined ? { options: q.options } : {}),
          ...(q.multiSelect !== undefined ? { multiSelect: q.multiSelect } : {}),
        })),
      });
      logger.info({ askId, questionCount: questions.length }, '提问已推送（ask_user_question）');
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
    clearTimeout(entry.timer);
    this.pending.delete(askId);
    entry.resolve(answers);
    logger.info({ askId }, '提问已回答');
    return true;
  }

  /** 当前 pending 数（测试/诊断用） */
  getPendingCount(): number {
    return this.pending.size;
  }

  /** 清理全部 pending（应用退出/回合中断） */
  dispose(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
    this.pending.clear();
  }
}

/** 模块级单例（与 permissionService 生命周期一致） */
export const agentAskService = new AgentAskService();
