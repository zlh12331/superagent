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

function sessionKey(channel: string, chatId: string): string {
  return `${channel}:${chatId}`;
}

export function getImDefaultWorkingDir(): string {
  return join(app.getPath('userData'), 'im-workspace');
}

export class ImAgentBridge {
  private readonly sessionMap = new Map<string, string>();
  private readonly busyChats = new Set<string>();
  private mounted = false;
  private unsubscribeMessage: (() => void) | null = null;

  constructor(
    private readonly imService: ImService,
    private readonly agentService: IAgentService,
    private readonly permissionService: IPermissionService,
    private readonly sessionService: ISessionService,
  ) {}

  mount(): void {
    if (this.mounted) {
      return;
    }
    this.mounted = true;
    try {
      mkdirSync(getImDefaultWorkingDir(), { recursive: true });
    } catch (err: unknown) {
      logger.warn({ error: err }, 'IM agent 沙箱工作目录创建失败');
    }
    this.unsubscribeMessage = this.imService.onMessage((message) => {
      void this.handleMessage(message);
    });
    logger.info({}, 'IM → Agent 桥接已挂载');
  }

  unmount(): void {
    if (!this.mounted) {
      return;
    }
    this.unsubscribeMessage?.();
    this.unsubscribeMessage = null;
    this.mounted = false;
    logger.info({}, 'IM → Agent 桥接已解除挂载');
  }

  private async handleMessage(message: ChannelIncomingMessage): Promise<void> {
    const key = sessionKey(message.channel, message.chatId);

    if (this.busyChats.has(key)) {
      await this.imService.send(
        message.channel,
        message.chatId,
        '⏳ 上一个任务仍在执行中，请稍候…',
      );
      return;
    }

    const mode = this.permissionService.getApprovalMode();
    if (mode !== 'auto' && mode !== 'yolo') {
      await this.imService.send(
        message.channel,
        message.chatId,
        `⚠️ 当前审批模式为 ${mode}，无头执行需要 auto 或 yolo 模式。\n请在桌面端设置 → 工具审批模式中切换。`,
      );
      return;
    }

    if (message.channelType === 'group' && !isImGroupAllowed(message.channel, message.chatId)) {
      await this.rejectUnauthorizedGroup(message);
      return;
    }

    let sessionId = this.sessionMap.get(key);
    if (sessionId === undefined) {
      try {
        sessionId = await this.sessionService.create({
          workingDir: getImDefaultWorkingDir(),
          title: `IM:${message.channel}:${message.chatId}`,
          messages: undefined,
        });
        this.sessionMap.set(key, sessionId);
      } catch (err: unknown) {
        logger.warn({ error: err }, 'IM 会话创建失败（本回合降级为一次性执行）');
        sessionId = randomUUID();
      }
    }

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

  private async runTurn(message: ChannelIncomingMessage, sessionId: string): Promise<void> {
    const { channel, chatId } = message;

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

    const turnEvents: string[] = [];
    let completionResolve: (() => void) | undefined;
    const unsubscribe = this.agentService.onTurnEvent((event) => {
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
      const completion = new Promise<void>((resolve) => {
        completionResolve = resolve;
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
      });

      await completion;
    } finally {
      if (fallbackTimer !== undefined) {
        clearTimeout(fallbackTimer);
      }
      unsubscribe();
    }
  }
}
