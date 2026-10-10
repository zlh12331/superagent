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

/** 默认审批模式（单一真源：shared schemas/settings.ts，与 approval-pref 共用） */
export { DEFAULT_APPROVAL_MODE } from '@code-agent/shared/main';
export type {
  ApprovalLifecycleListener,
  IPermissionService,
  PermissionDecision,
} from './permission-types';

/**
 * 审批超时时间已上收 shared 单一真源（APPROVAL_TIMEOUT_MS，38 号 spec 阶段 2）：
 * 此前本文件私有字面量与 shared 的 REMEMBER_TTL_MS 双写，靠注释互锚无机制保证。
 * 超时后视为拒绝，工具不会被执行。
 */

/**
 * pending 审批条目
 *
 * 包含 Promise 的 resolve/reject、超时定时器、
 * 以及用于记忆决策的 tool + input 引用。
 */
interface PendingApproval {
  /** resolve 函数，用户响应后调用 */
  readonly resolve: (approved: boolean) => void;
  /** reject 函数，超时/中断/dispose 时调用 */
  readonly reject: (error: Error) => void;
  /** 关联的工具实例（用于 rememberDecision 时构建 key） */
  readonly tool: Tool;
  /** 关联的工具入参（用于 rememberDecision 时构建 key） */
  readonly input: unknown;
  /** 所属会话 id（审批生命周期事件过滤用） */
  readonly sessionId: string;
  /**
   * 接收审批请求的窗口（决议事件回推目标）
   *
   * 超时/中断/dispose 等**非用户决策**路径必须让渲染层知道条目已死，
   * 否则卡片永久残留（点批准只会得到「approvalId 不存在或已超时」）。
   * 与请求推送同源（requestApproval 的入参）——同一窗口收发保证配对。
   */
  readonly webContents?: WebContents;
  /** abort 监听器清理函数（若注册了 abort 监听则需要清理） */
  readonly cleanupAbort?: () => void;
}

/**
 * 记忆决策条目
 *
 * 缓存用户对某 tool+input 组合的审批结果，
 * 在 REMEMBER_TTL_MS 内自动应用，避免重复询问。
 */
interface RememberedDecision {
  /** 用户是否批准 */
  readonly approved: boolean;
  /** 过期时间戳（Date.now() + REMEMBER_TTL_MS） */
  readonly expireAt: number;
}

/**
 * PermissionService 默认实现
 *
 * 维护两个 Map：
 * - pending：approvalId → PendingApproval，等待用户响应
 * - remembered：决策 key → RememberedDecision，缓存用户决策
 *
 * 单例模式：通过 ServiceContainer 持有，整个应用生命周期共享一个实例。
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
  /** pending 审批 Map：approvalId → PendingApproval */
  private readonly pending = new Map<string, PendingApproval>();
  /** 记忆决策 Map：`${toolName}:${hash(input)}` → RememberedDecision */
  private readonly remembered = new Map<string, RememberedDecision>();
  /** 审批生命周期监听器（Agent 回合状态机 waitingApproval 数据源） */
  private readonly lifecycleListeners = new Set<ApprovalLifecycleListener>();
  /** 审批模式（默认保守 ask；settings 可配置） */
  private approvalMode: ApprovalMode = DEFAULT_APPROVAL_MODE;
  /** AUTO 模式拒绝跟踪状态（用户拒绝超阈值 → 单次降级手动确认） */
  private denialState: DenialState = createDenialState();
  /** 命令安全分类器（AUTO 模式 exec 命令分层；可选注入，缺省降级保守 ask） */
  private readonly classifier: CommandClassifier | undefined;
  /** 命令白名单（跨会话持久化；模式必须是非空具体前缀，空/通配符一律无效） */
  private whitelist: WhitelistEntry[];

  /** @inheritDoc */
  setApprovalMode(mode: ApprovalMode): void {
    this.approvalMode = mode;
    this.denialState = createDenialState();
    logger.info({ mode }, '审批模式已更新');
  }

  /** @inheritDoc */
  getApprovalMode(): ApprovalMode {
    return this.approvalMode;
  }

  /** @inheritDoc */
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

  /** @inheritDoc */
  recordUserAllowance(): void {
    this.denialState = recordAllowance(this.denialState);
  }

  /** @inheritDoc */
  listWhitelist(): readonly WhitelistEntry[] {
    return this.whitelist;
  }

  /** @inheritDoc */
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

  /** @inheritDoc */
  async removeWhitelistEntry(entry: WhitelistEntry): Promise<void> {
    const next = this.whitelist.filter(
      (e) => !(e.toolName === entry.toolName && e.pattern.trim() === entry.pattern.trim()),
    );
    if (next.length !== this.whitelist.length) {
      this.whitelist = next;
      await writeWhitelist(this.whitelist);
    }
  }

  /** @inheritDoc */
  onApprovalLifecycle(listener: ApprovalLifecycleListener): () => void {
    this.lifecycleListeners.add(listener);
    return () => {
      this.lifecycleListeners.delete(listener);
    };
  }

  /** 通知所有监听器：审批请求已推送 */
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

  /** 通知所有监听器：审批决议完成 */
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

  /**
   * 决议回推渲染层（approval:request 的配对事件）
   *
   * 必要性（2026-10-08）：决议此前只走 notifyApprovalResolved 的**进程内**
   * lifecycle（消费方仅回合状态机与系统通知），渲染层无从得知——超时/中断
   * 等非用户路径下，待审批条目永久残留在界面（卡片不消失、倒计时归零、
   * 点批准只得到「approvalId 不存在或已超时」）。本方法把决议推给发起窗口，
   * 前端据此把条目移出队列，保证「有请求必有决议」的配对闭合。
   *
   * @param approvalId 审批请求 id（渲染层据此定位待审批条目）
   * @param entry 已出队的 pending 条目（携带发起窗口；缺失/已销毁时静默跳过）
   * @param decision 决议结果
   */
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

  /**
   * 白名单匹配：工具名相等 + 命令前缀模式匹配
   *
   * P0 安全修复前的实现为任意位置子串匹配（includes），存在提权路径：
   * 白名单 'git status' 会自动放行 'git status && rm -rf ~' 等复合命令，
   * 整体短路步骤 3 的 Layer-0 危险命令拦截。修复后语义：
   * - 复合命令（含 ; | & ` $() 或换行）一律不命中白名单——前缀只约束
   *   第一段命令，串联/管道的后继段落不在用户放行意图内，必须交回
   *   完整决策链（Layer-0 / 分类器 / 保守 ask）
   * - 非复合命令改用 token 级边界前缀匹配（见 matchesWhitelistPattern），
   *   'echo git status' / 'git status-helper' 不再命中 'git status'
   * - 空 / 纯通配符模式**永不命中**（P0：旧语义「空 = 该工具全部放行」
   *   等同于把 write_file / run_command 变成永久免审批通道）。
   *   这里匹配层再兜一次底：即便持久化文件被手工改坏、或别处直接写入
   *   whitelist 数组，也不会放行。
   * 非命令工具（write_file 等）无 command 字段时不命中任何模式。
   */
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

  /** @inheritDoc */
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

  /**
   * 按审批模式分级决策（仅对 permission='ask' 的工具）
   *
   * 对齐 qwen autoMode 三层过滤的收敛子集：
   * - L1 快速路径：edit 工具在 auto 模式自动放行（工作区编辑）
   * - L2 安全白名单：read 工具恒 auto（permission 已表达）
   * - Layer-0 确定性拦截：exec 工具在 auto 模式下，破坏性命令（git reset --hard /
   *   terraform destroy 等）强制 ask；只读安全命令自动放行；其余 ask（保守）
   * - 拒绝跟踪降级：连续拒绝超阈值 → 单次降级手动确认（防死循环）
   */
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

  /** @inheritDoc */
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

  /** @inheritDoc */
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

  /**
   * 缓存用户决策
   *
   * 由 handleApprovalResponse 在 rememberDecision=true 时调用，
   * 也可由 ToolExecutor 在执行成功后主动调用（如批量操作时复用决策）。
   *
   * @param tool 工具实例
   * @param input 工具入参
   * @param approved 用户是否批准
   */
  rememberDecision(tool: Tool, input: unknown, approved: boolean): void {
    const key = this.buildRememberKey(tool.name, input);
    this.remembered.set(key, {
      approved,
      expireAt: Date.now() + REMEMBER_TTL_MS,
    });
    logger.info({ toolName: tool.name, approved, ttlMs: REMEMBER_TTL_MS }, '用户决策已记忆');
  }

  /** @inheritDoc */
  dispose(): void {
    for (const [approvalId, entry] of this.pending) {
      entry.cleanupAbort?.();
      entry.reject(new AppError(ErrorCode.TOOL_ABORTED, 'PermissionService 已释放'));
      logger.debug({ approvalId }, 'dispose 时 reject pending 审批');
    }
    this.pending.clear();
    this.remembered.clear();
  }

  /**
   * 审批超时到期（38 号阶段 2 收尾：由 agent 回合状态机 after 转换调用）
   *
   * 以「超时」语义拒绝该 pending（区别于用户拒绝 resolve(false)——错误码与文案
   * 不同），并通知审批生命周期（decision='timed-out'）。approvalId 不存在时
   * 幂等忽略（可能已被用户响应/dispose 清理）。
   */
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

  /**
   * 构建记忆决策的 key
   *
   * 格式：`${toolName}:${hash(input)}`
   * - hash 用 stable JSON 序列化后取 SHA-256 前 16 字节（hex 编码）
   * - stable 序列化：Object.keys 排序，避免对象键顺序影响 hash
   *
   * @param toolName 工具名称
   * @param input 工具入参
   * @returns 记忆 key（如 "write_file:a1b2c3d4e5f67890"）
   */
  private buildRememberKey(toolName: string, input: unknown): string {
    const json = stableStringify(input);
    const hash = createHash('sha256').update(json).digest('hex').slice(0, 16);
    return `${toolName}:${hash}`;
  }
}

/**
 * 生成新的 approvalId
 *
 * 暴露给 ToolExecutor 使用，避免 ToolExecutor 直接依赖 node:crypto。
 * approvalId 格式：UUID v4
 */
export function generateApprovalId(): string {
  return randomUUID();
}
