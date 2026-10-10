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

/**
 * 远程命令 agent 的沙箱工作目录（与 IM 沙箱同级、同策略）
 *
 * 使用点求值（W9 修复）：与 IM 桥同因——模块加载期快照早于 dev 的
 * app.setPath('userData') 重定向，会导致 dev/E2E 数据分叉。
 */
export function getRemoteDefaultWorkingDir(): string {
  return join(app.getPath('userData'), 'remote-workspace');
}

/** 单回合最大工具调用轮数（与 IM 桥接一致） */
const MAX_STEPS = 20;
/** 回合完成兜底超时（HTTP 长请求不宜像 IM 那样挂 30 分钟） */
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
/** 回传文本上限（防单回合超长输出撑爆响应） */
const MAX_REPLY_CHARS = 20_000;

/** 回合结束原因 → 回传文案 */
const REASON_LABELS: Record<string, string> = {
  completed: '✅ 完成',
  aborted: '⏹ 已中断',
  'max-steps': '🔁 达步数上限',
  error: '❌ 异常结束',
  timeout: '⏱ 执行超时',
};

/**
 * 远程命令 → Agent 桥接（由 ServiceContainer 在创建远程控制服务时挂载）
 */
export class RemoteAgentBridge {
  /** 会话映射：clientId → sessionId（重启后由新命令重建） */
  private readonly sessionMap = new Map<string, string>();
  /** 正在执行的 clientId 集合（串行控制） */
  private readonly busyClients = new Set<string>();
  private mounted = false;
  private unsubscribeCommand: (() => void) | null = null;

  constructor(
    private readonly remoteControl: IRemoteControlService,
    private readonly agentService: IAgentService,
    private readonly permissionService: IPermissionService,
    private readonly sessionService: ISessionService,
  ) {}

  /**
   * 挂载到远程控制服务的命令入口（幂等）
   */
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

  /**
   * 解除命令订阅（应用退出 / 测试隔离；幂等）
   */
  unmount(): void {
    if (!this.mounted) {
      return;
    }
    this.unsubscribeCommand?.();
    this.unsubscribeCommand = null;
    this.mounted = false;
    logger.info({}, '远程控制 → Agent 桥接已解除挂载');
  }

  /**
   * 处理单条远程命令（串行 + 模式检查 + 回合执行 + 结果回传）
   *
   * 始终 accepted=true：命令到达即视为已接管，拒绝原因写在 reply 里
   * （移动端拿到的是一条可读的助手回复，而不是无解释的 accepted:false）。
   */
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

  /**
   * 建立/复用会话（首条命令落库创建，标题标记远程控制来源）
   *
   * 关键：sessionId 取 sessionService.create 的返回值——create 内部自行生成 id，
   * 传入自定义 id 不会被采用（沿用调用方 id 会导致后续落库 SESSION_NOT_FOUND）。
   */
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

  /**
   * 执行单回合：回读历史 + 追加本条命令 → startAgent（无头）→ 等待 TURN_END
   *
   * @param emit 增量事件通道（流式请求逐帧回推移动端；非流式为 noop）
   * @returns 回传给移动端的执行结果文本与回合结束原因
   */
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

  /**
   * 回读会话历史（多轮上下文）
   *
   * 读失败降级为空历史（降级为单轮，不因此拒绝执行远程命令）。
   */
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

/** 组装回传文本：正文 + 工具/错误摘要 + 结束状态（超长截断） */
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
