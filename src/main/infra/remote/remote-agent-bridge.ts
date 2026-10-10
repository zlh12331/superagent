// remote-agent-bridge.ts：远程命令 → Agent 回合的桥——收命令、起会话跑回合、流式回传 SSE
// 安全边界：远程回合工作目录锁定在 userData/remote-workspace（绝不碰用户任意路径）
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage } from '@code-agent/shared/main';
import { TurnEventType } from '@code-agent/shared/main';
import { app } from 'electron';
import { logger } from '../../utils/logger';
import type { IAgentService } from '../ai/agent/agent-service';
import type { IPermissionService } from '../ai/tools/permission-service';
import type { ISessionService } from '../storage/session-service';
import type {
  IRemoteControlService,
  RemoteCommand,
  RemoteCommandEmitter,
  RemoteCommandResult,
} from './remote-control';

/** 远程工作区根（固定 userData 下，不让远程客户端指定任意目录） */
export function getRemoteDefaultWorkingDir(): string {
  return join(app.getPath('userData'), 'remote-workspace');
}

// 远程回合护栏：步数 20 / 总时长 10 分钟 / 回复截断 2 万字符——移动端窄屏场景不需要完整深度
const MAX_STEPS = 20;
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_REPLY_CHARS = 20_000;

const REASON_LABELS: Record<string, string> = {
  completed: '✅ 完成',
  aborted: '⏹ 已中断',
  'max-steps': '🔁 达步数上限',
  error: '❌ 异常结束',
  timeout: '⏱ 执行超时',
};

/** 远程命令 → Agent 桥：客户端级互斥（单客户端同时只跑一回合）+ 审批模式前置检查 */
export class RemoteAgentBridge {
  private readonly sessionMap = new Map<string, string>();
  private readonly busyClients = new Set<string>();
  private mounted = false;
  private unsubscribeCommand: (() => void) | null = null;

  constructor(
    private readonly remoteControl: IRemoteControlService,
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
      mkdirSync(getRemoteDefaultWorkingDir(), { recursive: true });
    } catch (err: unknown) {
      logger.warn({ error: err }, '远程控制 agent 沙箱工作目录创建失败');
    }
    this.unsubscribeCommand = this.remoteControl.onCommand((command, emit) =>
      this.handleCommand(command, emit),
    );
    logger.info({}, '远程控制 → Agent 桥接已挂载');
  }

  unmount(): void {
    if (!this.mounted) {
      return;
    }
    this.unsubscribeCommand?.();
    this.unsubscribeCommand = null;
    this.mounted = false;
    logger.info({}, '远程控制 → Agent 桥接已解除挂载');
  }

  private async handleCommand(
    command: RemoteCommand,
    emit: RemoteCommandEmitter,
  ): Promise<RemoteCommandResult> {
    const { clientId, text } = command;

    if (this.busyClients.has(clientId)) {
      return {
        accepted: true,
        reply: '⏳ 上一条命令仍在执行中，请稍候再发送。',
      };
    }

    // 前置检查：远程无人在场点审批，plan/ask 模式会卡死回合——要求 auto/yolo 才放行
    const mode = this.permissionService.getApprovalMode();
    if (mode !== 'auto' && mode !== 'yolo') {
      return {
        accepted: true,
        reply: `⚠️ 当前审批模式为 ${mode}，远程控制需要 auto 或 yolo 模式。\n请在桌面端设置 → 工具审批模式中切换。`,
      };
    }

    this.busyClients.add(clientId);
    try {
      const sessionId = await this.ensureSession(clientId);
      const { reply, reason } = await this.runTurn(sessionId, text, emit);
      return { accepted: true, reply, reason };
    } catch (err: unknown) {
      logger.error({ clientId, error: err }, '远程控制回合失败');
      return { accepted: true, reply: '❌ 执行异常，请查看桌面端日志。' };
    } finally {
      this.busyClients.delete(clientId);
    }
  }

  /** 客户端专属会话（clientId 一对一；创建失败降级一次性 sessionId——无历史但能跑） */
  private async ensureSession(clientId: string): Promise<string> {
    const existing = this.sessionMap.get(clientId);
    if (existing !== undefined) {
      return existing;
    }
    try {
      const sessionId = await this.sessionService.create({
        workingDir: getRemoteDefaultWorkingDir(),
        title: `Remote:${clientId}`,
        messages: undefined,
      });
      this.sessionMap.set(clientId, sessionId);
      return sessionId;
    } catch (err: unknown) {
      logger.warn({ error: err, clientId }, '远程控制会话创建失败（降级为一次性执行）');
      return randomUUID();
    }
  }

  // 跑一回合并等结束：onTurnEvent 边流边 emit，TURN_END/超时先到者触发 completion——
  // 超时只是不再等（回合继续跑完），回复标注 timeout
  private async runTurn(
    sessionId: string,
    userText: string,
    emit: RemoteCommandEmitter,
  ): Promise<{ reply: string; reason: string }> {
    const history = await this.loadHistory(sessionId);
    const messages: ChatMessage[] = [...history, { role: 'user', content: userText }];

    const turnEvents: string[] = [];
    let assistantText = '';
    let reason = 'completed';
    let resolveCompletion!: () => void;

    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const timeout = setTimeout(() => {
      reason = 'timeout';
      resolveCompletion();
    }, TURN_TIMEOUT_MS);
    timeout.unref?.();

    const unsubscribe = this.agentService.onTurnEvent((event) => {
      if (event.sessionId !== undefined && event.sessionId !== sessionId) {
        return;
      }
      switch (event.type) {
        case TurnEventType.TEXT_DELTA: {
          assistantText += event.text;
          emit({ type: 'delta', text: event.text });
          break;
        }
        case TurnEventType.TOOL_CALL: {
          turnEvents.push(`🔧 ${event.toolName}`);
          emit({ type: 'tool', toolName: event.toolName });
          break;
        }
        case TurnEventType.ERROR: {
          turnEvents.push(`❌ ${event.message}`);
          emit({ type: 'error', message: event.message });
          break;
        }
        case TurnEventType.TURN_END: {
          reason = event.reason;
          resolveCompletion();
          break;
        }
        default:
          break;
      }
    });

    try {
      await this.agentService.startAgent({
        messages,
        sessionId,
        workingDir: getRemoteDefaultWorkingDir(),
        systemPrompt: undefined,
        maxSteps: MAX_STEPS,
      });
      await completion;
    } finally {
      clearTimeout(timeout);
      unsubscribe();
    }

    return { reply: buildReply(assistantText, turnEvents, reason), reason };
  }

  private async loadHistory(sessionId: string): Promise<ChatMessage[]> {
    try {
      const res = await this.sessionService.get(sessionId);
      return res.messages as ChatMessage[];
    } catch (err: unknown) {
      logger.warn({ sessionId, error: err }, '远程控制历史回读失败（本回合无上下文）');
      return [];
    }
  }
}

function buildReply(assistantText: string, turnEvents: readonly string[], reason: string): string {
  const blocks: string[] = [];
  const text = assistantText.trim();
  if (text.length > 0) {
    blocks.push(text);
  }
  if (turnEvents.length > 0) {
    blocks.push(turnEvents.join('\n'));
  }
  if (reason !== 'completed') {
    blocks.push(REASON_LABELS[reason] ?? `⚠️ ${reason}`);
  }
  if (blocks.length === 0) {
    blocks.push('（本轮无文本输出）');
  }
  const reply = blocks.join('\n\n');
  return reply.length > MAX_REPLY_CHARS
    ? `${reply.slice(0, MAX_REPLY_CHARS)}\n…（内容已截断）`
    : reply;
}
