// permission-service.ts：权限审批服务——四态模式（plan/ask/auto/yolo）分流、命令白名单/黑名单、
// 审批生命周期（弹窗 + 记住决定 TTL + 拒绝计数降级）、plan 模式只读闸
// 审批等待 = Promise pending（agent-turn-machine 的 approval 嵌套态感知这个生命周期）
import { createHash, randomUUID } from 'node:crypto';
import type {
  AgentApprovalRequestPayload,
  AgentApprovalResolvedPayload,
  ApprovalMode,
  WhitelistEntry,
} from '@code-agent/shared/main';
import {
  AppError,
  DEFAULT_APPROVAL_MODE,
  ErrorCode,
  IPC_DEFINITIONS,
  REMEMBER_TTL_MS,
} from '@code-agent/shared/main';
import type { WebContents } from 'electron';
import { emitEvent } from '../../../utils/emit-event';
import { logger } from '../../../utils/logger';
import { readWhitelistSync, writeWhitelist } from '../../storage/whitelist-pref';
import { isMcpTool } from '../mcp/mcp-types';
import type { CommandClassifier } from './command-classifier';
import {
  commandTargetsOutsideBoundary,
  extractCommandFromInput,
  isCompositeCommand,
  isDeniedByPlanMode,
  isUniversalWhitelistPattern,
  isZeroSideEffectTool,
  matchesWhitelistPattern,
} from './command-guards';
import { detectDangerousCommand, isSafeReadOnlyCommand } from './dangerous-commands';
import type { DenialState } from './denial-tracking';
import {
  createDenialState,
  recordAllowance,
  recordDenial,
  shouldFallbackToManual,
} from './denial-tracking';
import type {
  ApprovalDecisionOutcome,
  ApprovalLifecycleListener,
  IPermissionService,
  PermissionDecision,
} from './permission-types';
import { stableStringify } from './stable-stringify';
import type { Tool } from './tool';

export { DEFAULT_APPROVAL_MODE } from '@code-agent/shared/main';
export type {
  ApprovalLifecycleListener,
  IPermissionService,
  PermissionDecision,
} from './permission-types';

interface PendingApproval {
  readonly resolve: (approved: boolean) => void;
  readonly reject: (error: Error) => void;
  readonly tool: Tool;
  readonly input: unknown;
  readonly sessionId: string;
  readonly webContents?: WebContents;
  readonly cleanupAbort?: () => void;
}

/** 「记住决定」条目（同输入哈希直接复用，REMEMBER_TTL_MS 到期失效） */
interface RememberedDecision {
  readonly approved: boolean;
  readonly expireAt: number;
}

/**
 * 权限服务：构造期同步读白名单（DB 未就绪时的 JSON 文件真源），通用 pattern 条目剔除；
 * approve/deny 经 handleApprovalResponse 从渲染层回传
 */
export class PermissionService implements IPermissionService {
  constructor(classifier?: CommandClassifier) {
    this.classifier = classifier;
    const loaded = readWhitelistSync();
    const valid = loaded.filter((entry) => !isUniversalWhitelistPattern(entry.pattern));
    this.whitelist = valid;
    if (valid.length !== loaded.length) {
      logger.warn(
        { dropped: loaded.length - valid.length, kept: valid.length },
        '白名单存在空/通配符模式条目，已清理并重写持久化文件（这类条目等同放行该工具全部调用）',
      );
      void writeWhitelist(valid).catch((error: unknown) => {
        logger.error({ error }, '白名单清理回写失败（内存侧已生效，下次启动会再次清理）');
      });
    }
  }
  private readonly pending = new Map<string, PendingApproval>();
  private readonly remembered = new Map<string, RememberedDecision>();
  private readonly lifecycleListeners = new Set<ApprovalLifecycleListener>();
  private approvalMode: ApprovalMode = DEFAULT_APPROVAL_MODE;
  private denialState: DenialState = createDenialState();
  private readonly classifier: CommandClassifier | undefined;
  private whitelist: WhitelistEntry[];

  setApprovalMode(mode: ApprovalMode): void {
    this.approvalMode = mode;
    this.denialState = createDenialState();
    logger.info({ mode }, '审批模式已更新');
  }

  getApprovalMode(): ApprovalMode {
    return this.approvalMode;
  }

  recordUserDenial(): void {
    this.denialState = recordDenial(this.denialState);
    logger.warn(
      {
        consecutive: this.denialState.consecutiveDenials,
        total: this.denialState.totalDenials,
      },
      '用户拒绝工具调用（AUTO 拒绝跟踪）',
    );
  }

  recordUserAllowance(): void {
    this.denialState = recordAllowance(this.denialState);
  }

  listWhitelist(): readonly WhitelistEntry[] {
    return this.whitelist;
  }

  async addWhitelistEntry(entry: WhitelistEntry): Promise<void> {
    if (isUniversalWhitelistPattern(entry.pattern)) {
      throw new AppError(
        ErrorCode.INVALID_INPUT,
        `白名单模式不能为空或纯通配符（等同放行 ${entry.toolName} 的全部调用），请填写具体命令前缀，例如 "npm test"`,
      );
    }
    const exists = this.whitelist.some(
      (e) => e.toolName === entry.toolName && e.pattern.trim() === entry.pattern.trim(),
    );
    if (!exists) {
      this.whitelist = [...this.whitelist, entry];
      await writeWhitelist(this.whitelist);
    }
  }

  async removeWhitelistEntry(entry: WhitelistEntry): Promise<void> {
    const next = this.whitelist.filter(
      (e) => !(e.toolName === entry.toolName && e.pattern.trim() === entry.pattern.trim()),
    );
    if (next.length !== this.whitelist.length) {
      this.whitelist = next;
      await writeWhitelist(this.whitelist);
    }
  }

  onApprovalLifecycle(listener: ApprovalLifecycleListener): () => void {
    this.lifecycleListeners.add(listener);
    return () => {
      this.lifecycleListeners.delete(listener);
    };
  }

  private notifyApprovalRequested(payload: {
    readonly sessionId: string;
    readonly approvalId: string;
    readonly toolName: string;
  }): void {
    for (const listener of this.lifecycleListeners) {
      try {
        listener.onRequested(payload);
      } catch (err: unknown) {
        logger.error({ error: err }, '审批生命周期监听器 onRequested 异常');
      }
    }
  }

  private notifyApprovalResolved(payload: {
    readonly sessionId: string;
    readonly approvalId: string;
    readonly decision: ApprovalDecisionOutcome;
  }): void {
    for (const listener of this.lifecycleListeners) {
      try {
        listener.onResolved(payload);
      } catch (err: unknown) {
        logger.error({ error: err }, '审批生命周期监听器 onResolved 异常');
      }
    }
  }

  private emitResolvedToRenderer(
    approvalId: string,
    entry: PendingApproval,
    decision: ApprovalDecisionOutcome,
  ): void {
    const wc = entry.webContents;
    if (wc === undefined || wc.isDestroyed()) {
      return;
    }
    emitEvent(wc, IPC_DEFINITIONS.agent.subscribeApprovalResolved, {
      sessionId: entry.sessionId,
      approvalId,
      decision,
    } satisfies AgentApprovalResolvedPayload);
  }

  private isWhitelisted(tool: Tool, input: unknown): boolean {
    return this.whitelist.some((entry) => {
      if (entry.toolName !== tool.name) {
        return false;
      }
      if (isUniversalWhitelistPattern(entry.pattern)) {
        return false;
      }
      const command = extractCommandFromInput(input);
      if (command === undefined || isCompositeCommand(command)) {
        return false;
      }
      return matchesWhitelistPattern(command, entry.pattern);
    });
  }

  async decide(
    tool: Tool,
    input: unknown,
    userPrompt?: string,
    options?: { readonly pathBoundary?: string },
  ): Promise<PermissionDecision> {
    if (isDeniedByPlanMode(this.approvalMode, tool)) {
      return {
        permission: 'deny',
        description: `${tool.description}（计划模式只读，非只读工具需先退出计划模式）`,
      };
    }

    const key = this.buildRememberKey(tool.name, input);
    const remembered = this.remembered.get(key);
    if (remembered !== undefined) {
      if (remembered.expireAt <= Date.now()) {
        this.remembered.delete(key);
      } else {
        logger.debug(
          { toolName: tool.name, approved: remembered.approved },
          '权限决策命中记忆缓存',
        );
        return {
          permission: remembered.approved ? 'auto' : 'ask',
          description: tool.description,
        };
      }
    }

    if (tool.permission === 'auto') {
      if (isZeroSideEffectTool(tool)) {
        return { permission: 'auto', description: tool.description };
      }
      const command = extractCommandFromInput(input);
      if (command !== undefined) {
        const dangerous = detectDangerousCommand(command, userPrompt);
        if (dangerous.isDangerous) {
          return {
            permission: 'ask',
            description: `${tool.description}（⚠️ ${dangerous.reason}）`,
          };
        }
        if (isCompositeCommand(command)) {
          return {
            permission: 'ask',
            description: `${tool.description}（复合命令，后继段落不受白名单约束）`,
          };
        }
        if (
          options?.pathBoundary !== undefined &&
          commandTargetsOutsideBoundary(command, options.pathBoundary)
        ) {
          return {
            permission: 'ask',
            description: `${tool.description}（⚠️ 引用工作目录之外的路径，需确认）`,
          };
        }
      }
      if (isMcpTool(tool.name)) {
        return {
          permission: 'ask',
          description: `${tool.description}（MCP 工具入参无命令形状，需确认后执行）`,
        };
      }
      return {
        permission: 'auto',
        description: tool.description,
      };
    }

    if (this.isWhitelisted(tool, input)) {
      logger.debug({ toolName: tool.name }, '权限决策命中用户白名单');
      return {
        permission: 'auto',
        description: tool.description,
      };
    }

    const decision = await this.decideByMode(tool, input, userPrompt, options);
    return {
      permission: decision.permission,
      description: decision.description,
    };
  }

  private async decideByMode(
    tool: Tool,
    input: unknown,
    userPrompt?: string,
    options?: { readonly pathBoundary?: string },
  ): Promise<{
    permission: 'auto' | 'ask' | 'deny';
    description: string;
  }> {
    switch (this.approvalMode) {
      case 'plan':
        return isZeroSideEffectTool(tool)
          ? { permission: 'auto', description: tool.description }
          : { permission: 'deny', description: tool.description };
      case 'auto': {
        if (shouldFallbackToManual(this.denialState)) {
          return {
            permission: 'ask',
            description: `${tool.description}（拒绝频繁，降级手动确认）`,
          };
        }
        if (tool.category === 'exec') {
          const command = extractCommandFromInput(input);
          if (command !== undefined) {
            const dangerous = detectDangerousCommand(command, userPrompt);
            if (dangerous.isDangerous) {
              return {
                permission: 'ask',
                description: `${tool.description}（⚠️ ${dangerous.reason}）`,
              };
            }
            if (!isCompositeCommand(command) && isSafeReadOnlyCommand(command)) {
              if (
                options?.pathBoundary !== undefined &&
                commandTargetsOutsideBoundary(command, options.pathBoundary)
              ) {
                return {
                  permission: 'ask',
                  description: `${tool.description}（⚠️ 引用工作目录之外的路径，需确认）`,
                };
              }
              return { permission: 'auto', description: tool.description };
            }
            if (this.classifier !== undefined) {
              const classification = await this.classifier.classify(command, userPrompt);
              if (classification.verdict === 'safe') {
                return { permission: 'auto', description: tool.description };
              }
              return {
                permission: 'ask',
                description: `${tool.description}（分类：${classification.reason}）`,
              };
            }
          }
          return { permission: 'ask', description: tool.description };
        }
        return { permission: 'auto', description: tool.description };
      }
      case 'yolo':
        return { permission: 'auto', description: tool.description };
      default:
        return { permission: 'ask', description: tool.description };
    }
  }

  requestApproval(
    payload: AgentApprovalRequestPayload,
    tool: Tool,
    input: unknown,
    webContents?: WebContents,
    abortSignal?: AbortSignal,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      if (abortSignal?.aborted === true) {
        reject(new AppError(ErrorCode.TOOL_ABORTED, '工具执行已被中断'));
        return;
      }

      const onAbort = (): void => {
        const pending = this.pending.get(payload.approvalId);
        this.pending.delete(payload.approvalId);
        logger.info(
          { approvalId: payload.approvalId, toolName: payload.toolName },
          '审批等待期间收到中断信号',
        );
        this.notifyApprovalResolved({
          sessionId: payload.sessionId,
          approvalId: payload.approvalId,
          decision: 'aborted',
        });
        if (pending !== undefined) {
          this.emitResolvedToRenderer(payload.approvalId, pending, 'aborted');
        }
        reject(new AppError(ErrorCode.TOOL_ABORTED, '工具执行已被中断'));
      };

      const cleanupAbort = (): void => {
        if (abortSignal !== undefined) {
          abortSignal.removeEventListener('abort', onAbort);
        }
      };

      this.pending.set(payload.approvalId, {
        resolve,
        reject,
        tool,
        input,
        sessionId: payload.sessionId,
        cleanupAbort,
        ...(webContents !== undefined ? { webContents } : {}),
      });

      if (abortSignal !== undefined) {
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      if (webContents !== undefined && !webContents.isDestroyed()) {
        emitEvent(webContents, IPC_DEFINITIONS.agent.subscribeApprovalRequest, payload);
        logger.info(
          { approvalId: payload.approvalId, toolName: payload.toolName },
          '审批请求已推送',
        );
        this.notifyApprovalRequested({
          sessionId: payload.sessionId,
          approvalId: payload.approvalId,
          toolName: payload.toolName,
        });
      } else if (webContents === undefined) {
        cleanupAbort();
        this.pending.delete(payload.approvalId);
        reject(
          new AppError(ErrorCode.TOOL_PERMISSION_DENIED, '无审批通道（无头执行），工具调用被拒绝'),
        );
      } else {
        cleanupAbort();
        this.pending.delete(payload.approvalId);
        reject(
          new AppError(ErrorCode.TOOL_PERMISSION_DENIED, 'WebContents 已销毁，无法推送审批请求'),
        );
      }
    });
  }

  handleApprovalResponse(approvalId: string, approved: boolean, rememberDecision: boolean): void {
    const entry = this.pending.get(approvalId);
    if (entry === undefined) {
      logger.warn({ approvalId }, '处理审批响应失败：approvalId 不存在或已超时');
      return;
    }

    entry.cleanupAbort?.();
    this.pending.delete(approvalId);

    if (rememberDecision) {
      this.rememberDecision(entry.tool, entry.input, approved);
    }

    entry.resolve(approved);
    logger.info({ approvalId, approved, rememberDecision }, '审批响应已处理');
    this.notifyApprovalResolved({
      sessionId: entry.sessionId,
      approvalId,
      decision: approved ? 'approved' : 'denied',
    });
    this.emitResolvedToRenderer(approvalId, entry, approved ? 'approved' : 'denied');
  }

  rememberDecision(tool: Tool, input: unknown, approved: boolean): void {
    const key = this.buildRememberKey(tool.name, input);
    this.remembered.set(key, {
      approved,
      expireAt: Date.now() + REMEMBER_TTL_MS,
    });
    logger.info({ toolName: tool.name, approved, ttlMs: REMEMBER_TTL_MS }, '用户决策已记忆');
  }

  dispose(): void {
    for (const [approvalId, entry] of this.pending) {
      entry.cleanupAbort?.();
      entry.reject(new AppError(ErrorCode.TOOL_ABORTED, 'PermissionService 已释放'));
      logger.debug({ approvalId }, 'dispose 时 reject pending 审批');
    }
    this.pending.clear();
    this.remembered.clear();
  }

  expireApproval(approvalId: string): void {
    const entry = this.pending.get(approvalId);
    if (entry === undefined) {
      return;
    }
    entry.cleanupAbort?.();
    this.pending.delete(approvalId);
    logger.warn({ approvalId }, '审批超时（机器 after 转换触发）');
    this.notifyApprovalResolved({
      sessionId: entry.sessionId,
      approvalId,
      decision: 'timed-out',
    });
    this.emitResolvedToRenderer(approvalId, entry, 'timed-out');
    entry.reject(new AppError(ErrorCode.TOOL_PERMISSION_DENIED, '审批超时：工具调用被拒绝'));
  }

  private buildRememberKey(toolName: string, input: unknown): string {
    const json = stableStringify(input);
    const hash = createHash('sha256').update(json).digest('hex').slice(0, 16);
    return `${toolName}:${hash}`;
  }
}

export function generateApprovalId(): string {
  return randomUUID();
}
