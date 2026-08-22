// src/main/infra/im/im-agent-bridge.ts
// IM 消息 → Agent 回合桥接（无头执行，安全受控）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 入站 IM 消息 → agent 回合（复用 AgentService.startAgent 无头模式）
// - 回合事件（TEXT_DELTA / TOOL_RESULT / turn-end）→ 渠道回发
// - 会话映射：`${channel}:${chatId}` → sessionId（内存 Map，首次消息自动建会话）
// - Transcript 落库：回合结束把 user + assistant 消息写入会话历史（带 turnId 关联）
//
// 安全设计（对齐"远程执行默认保守"）：
// - 仅 approvalMode 为 auto / yolo 时执行（ask/plan 无审批通道，回发提示）
// - 同一 chatId 串行执行：执行中收到的消息回发"正在处理"提示
// - 工作目录：默认用户主目录（无窗口工作区概念），后续可配置
//
// 依赖注入：imService（回发）/ agentService（执行）/ permissionService（模式检查）/ sessionService（落库）
// ──────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TurnEventType } from '@code-agent/shared/main';
import { app } from 'electron';
import { logger } from '../../utils/logger';
import type { IAgentService } from '../ai/agent/agent-service';
import type { IPermissionService } from '../ai/tools/permission-service';
import type { ISessionService } from '../storage/session-service';
import type { ChannelIncomingMessage } from './channel/types';
import type { ImService } from './im-service';

/** 会话映射 key：`${channel}:${chatId}` */
function sessionKey(channel: string, chatId: string): string {
  return `${channel}:${chatId}`;
}

/**
 * IM 渠道 agent 的沙箱工作目录
 *
 * 安全修复：禁止以用户主目录作为 IM 无头执行的工作目录（否则群聊第三方
 * 可诱导 agent 读取 ~/.ssh、~/.aws 等任意文件并回发群聊）。
 * 改为应用 userData 下的专用沙箱目录，隔离 IM agent 的读写边界。
 */
export const IM_DEFAULT_WORKING_DIR = join(app.getPath('userData'), 'im-workspace');

/**
 * IM 消息 → Agent 桥接（模块单例，由 ServiceContainer 初始化挂载）
 */
export class ImAgentBridge {
  /** 会话映射：`${channel}:${chatId}` → sessionId（重启后由消息重新建立） */
  private readonly sessionMap = new Map<string, string>();
  /** 正在执行的 chatId 集合（串行控制） */
  private readonly busyChats = new Set<string>();
  /** 桥接是否已挂载（防重复 onMessage 订阅） */
  private mounted = false;
  /** mount 注册的取消订阅函数（unmount 用；未挂载时为 null） */
  private unsubscribeMessage: (() => void) | null = null;

  constructor(
    private readonly imService: ImService,
    private readonly agentService: IAgentService,
    private readonly permissionService: IPermissionService,
    private readonly sessionService: ISessionService,
  ) {}

  /**
   * 挂载桥接到 im-service 的消息入口（ServiceContainer 初始化调用，幂等）
   */
  mount(): void {
    if (this.mounted) {
      return;
    }
    this.mounted = true;
    // 安全修复：确保 IM agent 沙箱工作目录存在（首启自动创建）
    try {
      mkdirSync(IM_DEFAULT_WORKING_DIR, { recursive: true });
    } catch (err: unknown) {
      // 目录创建失败不阻断桥接（agent 工具会在无目录时返回明确错误）
      logger.warn({ error: err }, 'IM agent 沙箱工作目录创建失败');
    }
    // P1 修复：保存取消订阅句柄，unmount 时精确移除（此前挂载后无法解除）
    this.unsubscribeMessage = this.imService.onMessage((message) => {
      void this.handleMessage(message);
    });
    logger.info({}, 'IM → Agent 桥接已挂载');
  }

  /**
   * 解除消息订阅（应用退出 / 测试隔离时由 ServiceContainer 调用；幂等）
   */
  unmount(): void {
    if (!this.mounted) {
      return;
    }
    this.unsubscribeMessage?.();
    this.unsubscribeMessage = null;
    this.mounted = false;
    logger.info({}, 'IM → Agent 桥接已解除挂载');
  }

  /**
   * 处理单条入站消息（串行 + 模式检查 + 回合执行）
   */
  private async handleMessage(message: ChannelIncomingMessage): Promise<void> {
    const key = sessionKey(message.channel, message.chatId);

    // 1. 串行控制：同一会话执行中，新消息提示排队
    if (this.busyChats.has(key)) {
      await this.imService.send(
        message.channel,
        message.chatId,
        '⏳ 上一个任务仍在执行中，请稍候…',
      );
      return;
    }

    // 2. 审批模式检查：仅 auto/yolo 允许无头执行（ask/plan 无审批通道）
    const mode = this.permissionService.getApprovalMode();
    if (mode !== 'auto' && mode !== 'yolo') {
      await this.imService.send(
        message.channel,
        message.chatId,
        `⚠️ 当前审批模式为 ${mode}，无头执行需要 auto 或 yolo 模式。\n请在桌面端设置 → 工具审批模式中切换。`,
      );
      return;
    }

    // 3. 建立/复用会话（首次消息：落库创建，标题标记 IM 渠道来源）
    let sessionId = this.sessionMap.get(key);
    if (sessionId === undefined) {
      sessionId = randomUUID();
      try {
        await this.sessionService.create({
          workingDir: IM_DEFAULT_WORKING_DIR,
          title: `IM:${message.channel}:${message.chatId}`,
          messages: undefined,
        });
      } catch (err: unknown) {
        // 会话创建失败不阻断执行（仅影响落库）
        logger.warn({ error: err }, 'IM 会话创建失败');
      }
      this.sessionMap.set(key, sessionId);
    }

    // 4. 执行回合（无头：不传 webContents）
    this.busyChats.add(key);
    try {
      await this.runTurn(message, sessionId);
    } catch (err: unknown) {
      logger.error({ channel: message.channel, chatId: message.chatId, error: err }, 'IM 回合失败');
      await this.imService.send(message.channel, message.chatId, '❌ 执行异常，请查看桌面端日志。');
    } finally {
      this.busyChats.delete(key);
    }
  }

  /**
   * 执行单回合：startAgent（无 webContents）→ 回合事件 → 渠道回发
   */
  private async runTurn(message: ChannelIncomingMessage, sessionId: string): Promise<void> {
    const { channel, chatId } = message;

    // 回发缓冲：TEXT_DELTA 累积后按句回发（减少消息频率）
    let pendingText = '';
    // 回合完整文本（与回发缓冲分离：flush 清空 pendingText 不影响落库）
    let assistantText = '';
    let lastFlushAt = 0;
    const FLUSH_INTERVAL_MS = 800;
    const flush = async (): Promise<void> => {
      if (pendingText.length === 0) {
        return;
      }
      const text = pendingText;
      pendingText = '';
      await this.imService.send(channel, chatId, text);
    };

    // 回合事件订阅：增量文本 / 工具摘要 / 结束汇总 / 落库
    const turnEvents: string[] = [];
    let currentTurnId: string | undefined;
    let completionResolve: (() => void) | undefined;
    const unsubscribe = this.agentService.onTurnEvent((event) => {
      // P1 修复：onTurnEvent 是类级全局监听，事件流包含桌面端所有并发会话。
      // 不按 sessionId 过滤时，其他会话的增量文本会被 flush 回发到本群聊、
      // 工具名混入结束摘要、transcript 落库串入他人会话内容。
      // 仅在事件携带 sessionId 且不同时丢弃——真实翻译器产出的事件恒带
      // sessionId；容忍缺省字段的历史事件（防御性，不改变主流程）。
      if (event.sessionId !== undefined && event.sessionId !== sessionId) {
        return;
      }
      try {
        switch (event.type) {
          case TurnEventType.TURN_START: {
            // 捕获回合 id（Transcript 落库关联）
            currentTurnId = event.turnId;
            break;
          }
          case TurnEventType.TEXT_DELTA: {
            pendingText += event.text;
            assistantText += event.text;
            const now = Date.now();
            if (now - lastFlushAt >= FLUSH_INTERVAL_MS) {
              lastFlushAt = now;
              void flush();
            }
            break;
          }
          case TurnEventType.TOOL_CALL: {
            turnEvents.push(`🔧 ${event.toolName}`);
            break;
          }
          case TurnEventType.ERROR: {
            turnEvents.push(`❌ ${event.message}`);
            break;
          }
          case TurnEventType.TURN_END: {
            // Transcript 落库：user + assistant 消息（带 turnId 关联）
            // 用独立累积的 assistantText（回发缓冲可能已被 flush 清空）
            void this.persistTurnMessages(sessionId, currentTurnId, message.text, assistantText);
            if (pendingText.length > 0) {
              void flush();
            }
            const reasonText: Record<string, string> = {
              completed: '✅ 完成',
              aborted: '⏹ 已中断',
              'max-steps': '🔁 达步数上限',
              error: '❌ 异常结束',
            };
            const summary = [
              reasonText[event.reason] ?? event.reason,
              ...turnEvents,
              event.usage !== undefined
                ? `Tokens: ${event.usage.totalTokens ?? event.usage.inputTokens ?? 0}`
                : '',
            ]
              .filter((line) => line.length > 0)
              .join('\n');
            void this.imService.send(channel, chatId, summary);
            completionResolve?.();
            break;
          }
          default:
            break;
        }
      } catch (err: unknown) {
        logger.error({ error: err }, 'IM 回合事件处理异常');
      }
    });

    try {
      // 开始执行（无头）：startAgent 立即返回，回合完成由 TURN_END 事件驱动
      const completion = new Promise<void>((resolve) => {
        completionResolve = resolve;
        // 安全兜底：30 分钟超时（流空闲超时已 10 分钟，兜底更长）
        setTimeout(
          () => {
            completionResolve = undefined;
            resolve();
          },
          30 * 60 * 1000,
        );
      });

      await this.agentService.startAgent({
        messages: [{ role: 'user', content: message.text }],
        sessionId,
        workingDir: IM_DEFAULT_WORKING_DIR,
        systemPrompt: undefined,
        maxSteps: 20,
        // 无头：不传 webContents（推送跳过；exec 工具拒绝、edit 按 auto 快速路径放行）
      });

      // 等待回合结束事件（或超时兜底）
      await completion;
    } finally {
      unsubscribe();
    }
  }

  /**
   * 回合消息落库（Transcript）：user + assistant 写入会话历史
   *
   * 失败静默（不影响主流程）；assistant 文本为空（纯工具回合）时仅落 user 消息。
   */
  private async persistTurnMessages(
    sessionId: string,
    turnId: string | undefined,
    userText: string,
    assistantText: string,
  ): Promise<void> {
    try {
      const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
        { role: 'user', content: userText },
      ];
      if (assistantText.trim().length > 0) {
        messages.push({ role: 'assistant', content: assistantText });
      }
      await this.sessionService.appendMessage({
        sessionId,
        // exactOptionalPropertyTypes：turnId 未捕获时条件展开
        ...(turnId !== undefined ? { turnId } : {}),
        messages,
      });
    } catch (err: unknown) {
      logger.warn({ sessionId, error: err }, 'IM 回合消息落库失败');
    }
  }
}
