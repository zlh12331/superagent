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
import { isImGroupAllowed } from '../storage/im-allowlist-pref';
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
 *
 * 使用点求值（W9 修复）：模块加载期 app.getPath('userData') 早于 index.ts
 * 的 dev 重定向（app.setPath），快照常量会把沙箱目录落在重定向目标之外
 * （dev/E2E 隔离失效）。改为函数在使用时求值——mount/首回合均发生在
 * whenReady 之后，此时 setPath 已生效。
 */
export function getImDefaultWorkingDir(): string {
  return join(app.getPath('userData'), 'im-workspace');
}

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
      mkdirSync(getImDefaultWorkingDir(), { recursive: true });
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

    // 2.5 发送者鉴权（2026-09-08 安全审计修复）：群聊未登记白名单即拒绝
    if (message.channelType === 'group' && !isImGroupAllowed(message.channel, message.chatId)) {
      await this.rejectUnauthorizedGroup(message);
      return;
    }

    // 3. 建立/复用会话（首次消息：落库创建，标题标记 IM 渠道来源）
    let sessionId = this.sessionMap.get(key);
    if (sessionId === undefined) {
      try {
        // 关键：会话 id 由 create 内部生成并以返回值给出。此前用自造 uuid
        // 当作 id，与落库行不一致 → appendMessage 恒抛 SESSION_NOT_FOUND、
        // markRunning 找不到行，IM 回合 transcript 实际从未落库。
        sessionId = await this.sessionService.create({
          workingDir: getImDefaultWorkingDir(),
          title: `IM:${message.channel}:${message.chatId}`,
          messages: undefined,
        });
        this.sessionMap.set(key, sessionId);
      } catch (err: unknown) {
        // 会话创建失败不阻断执行（仅影响落库）；不缓存一次性 id，下条消息重试建会话
        logger.warn({ error: err }, 'IM 会话创建失败（本回合降级为一次性执行）');
        sessionId = randomUUID();
      }
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
   * 拒绝未授权的群聊（2026-09-08 安全审计修复）
   *
   * 背景：此前只检查审批模式、从不校验 senderId，任何能给机器人发消息的人
   * （群聊任意成员）都能驱动 agent 执行工具；yolo 模式下 decideByMode 无条件
   * 放行且边界检查只存在于 auto 分支 → 可读本机文件并回发群聊。
   * 策略（fail closed）：仅私聊放行，群聊必须显式登记 `${channel}:${chatId}`。
   */
  private async rejectUnauthorizedGroup(message: ChannelIncomingMessage): Promise<void> {
    logger.warn(
      { channel: message.channel, chatId: message.chatId, senderId: message.senderId },
      'IM 群聊未授权，拒绝执行',
    );
    await this.imService.send(
      message.channel,
      message.chatId,
      '⛔ 该群聊未授权执行任务。请在桌面端「设置 → IM 渠道」中把本会话加入允许列表。',
    );
  }

  /**
   * 执行单回合：startAgent（无 webContents）→ 回合事件 → 渠道回发
   */
  private async runTurn(message: ChannelIncomingMessage, sessionId: string): Promise<void> {
    const { channel, chatId } = message;

    // 回发缓冲：TEXT_DELTA 累积后按句回发（减少消息频率）
    let pendingText = '';
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

    // 回合事件订阅：增量文本 / 工具摘要 / 结束汇总（落库由 AgentService 负责）
    const turnEvents: string[] = [];
    let completionResolve: (() => void) | undefined;
    const unsubscribe = this.agentService.onTurnEvent((event) => {
      // P1：onTurnEvent 是类级全局监听，含所有并发会话——仅处理本会话事件
      if (event.sessionId !== undefined && event.sessionId !== sessionId) {
        return;
      }
      try {
        switch (event.type) {
          case TurnEventType.TEXT_DELTA: {
            pendingText += event.text;
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
            // 2026-09-08（S1 重复落库修复）：不再自行落库——AgentService 是唯一
            // 写入方。桥接再写一遍会让同条消息带不同 seq 落库两次（静默重复），
            // 历史翻倍 + token 虚高。桥接只负责回发文本。
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

    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      // 开始执行（无头）：startAgent 立即返回，回合完成由 TURN_END 事件驱动
      const completion = new Promise<void>((resolve) => {
        completionResolve = resolve;
        // 安全兜底：30 分钟超时（流空闲超时已 10 分钟，兜底更长）
        // 2026-09-08 修复：句柄保存并在 finally 清理——此前回合正常结束后
        // 定时器仍存活 30 分钟（持有闭包），且不 unref 会拖慢进程退出。
        fallbackTimer = setTimeout(
          () => {
            completionResolve = undefined;
            resolve();
          },
          30 * 60 * 1000,
        );
        fallbackTimer.unref?.();
      });

      await this.agentService.startAgent({
        messages: [{ role: 'user', content: message.text }],
        sessionId,
        workingDir: getImDefaultWorkingDir(),
        systemPrompt: undefined,
        maxSteps: 20,
        // 无头：不传 webContents（推送跳过；exec 工具拒绝、edit 按 auto 快速路径放行）
      });

      // 等待回合结束事件（或超时兜底）
      await completion;
    } finally {
      if (fallbackTimer !== undefined) {
        clearTimeout(fallbackTimer);
      }
      unsubscribe();
    }
  }
}
