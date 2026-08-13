// src/main/infra/ai/permission-service.ts
// 权限服务：工具调用的权限决策与审批管理
// ──────────────────────────────────────────────────────────────
// 职责：
// - decide(tool, input)：根据工具 permission 与记忆决策，返回最终权限级别
// - requestApproval(...)：推送 ApprovalRequest 到渲染层，等待用户响应
// - handleApprovalResponse(...)：处理用户响应，resolve 对应 Promise
// - rememberDecision(tool, input, approved)：缓存用户决策，5分钟内自动应用
// - dispose()：清理所有 pending Promise，避免内存泄漏
//
// 设计原则：
// - 用户决策对齐：白名单自动（'auto'）+ 危险询问（'ask'）
// - 记忆决策：用户可选"5分钟内对此工具+入参组合不再询问"
//   - key 格式：`${toolName}:${hash(input)}`，hash 用 stable JSON 序列化后取 SHA-256 前 16 字节
//   - TTL 5 分钟，避免长期缓存导致权限漂移
// - 审批超时：默认 5 分钟，超时后 reject，避免 Promise 长期挂起
// - dispose 清理：应用退出时调用，reject 所有 pending Promise
//
// 与 IPC 的关系：
// - 主进程通过 webContents.send 推送 AGENT_APPROVAL_REQUEST
// - 渲染层通过 ipcRenderer.invoke('agent:approval:response', { approvalId, approved, rememberDecision })
//   回传审批结果，IPC handler 调用 handleApprovalResponse resolve 对应 Promise
// ──────────────────────────────────────────────────────────────

import { createHash, randomUUID } from 'node:crypto';
import type {
  AgentApprovalRequestPayload,
  ApprovalMode,
  WhitelistEntry,
} from '@code-agent/shared/main';
import {
  AppError,
  DEFAULT_APPROVAL_MODE,
  ErrorCode,
  IPC_DEFINITIONS,
} from '@code-agent/shared/main';
import type { WebContents } from 'electron';
import { emitEvent } from '../../../utils/emit-event';
import { logger } from '../../../utils/logger';
import { readWhitelistSync, writeWhitelist } from '../../storage/whitelist-pref';
import type { CommandClassifier } from './command-classifier';
import { detectDangerousCommand, isSafeReadOnlyCommand } from './dangerous-commands';
import type { DenialState } from './denial-tracking';
import {
  createDenialState,
  recordAllowance,
  recordDenial,
  shouldFallbackToManual,
} from './denial-tracking';
import type { Tool } from './tool';

/**
 * 权限决策结果
 *
 * - permission：最终权限级别（'auto' 直接执行 / 'ask' 需用户审批 / 'deny' 拒绝）
 * - description：人类可读的操作摘要，用于 ApprovalModal 展示
 */
export interface PermissionDecision {
  /** 最终权限级别 */
  readonly permission: 'auto' | 'ask' | 'deny';
  /** 人类可读的操作摘要（如 "写入文件 /path/to/file.ts"） */
  readonly description: string;
}

/** 默认审批模式（单一真源：shared schemas/settings.ts，与 approval-pref 共用） */
export { DEFAULT_APPROVAL_MODE } from '@code-agent/shared/main';

/**
 * 审批超时时间（毫秒）
 *
 * 5 分钟，避免用户离开后 Promise 长期挂起。
 * 超时后视为拒绝，工具不会被执行。
 */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 记忆决策有效期（毫秒）
 *
 * 5 分钟，与审批超时对齐。
 * 过期后下次调用同一工具+入参组合会重新询问。
 */
const REMEMBER_TTL_MS = 5 * 60 * 1000;

/**
 * PermissionService 接口
 *
 * 解耦 ToolExecutor 对具体实现的依赖，便于：
 * - 单元测试：注入 mock 实现，不依赖真实 IPC 推送
 * - 未来扩展：支持基于角色/策略的权限系统
 */
export interface IPermissionService {
  /**
   * 决策工具调用的权限级别
   *
   * 决策顺序（对齐 qwen ApprovalMode + autoMode 三层过滤）：
   * 1. 检查记忆决策：若用户之前对此 tool+input 组合选了"5分钟内不再询问"且未过期，
   *    返回记忆结果（approved → 'auto'；denied → 'ask' 让用户重新决策）
   * 2. 按工具类别 + ApprovalMode 分级决策：
   *    - plan：edit/exec 工具 → 'deny'（只读探索零副作用）；read 工具 → 'auto'
   *    - ask：permission='ask' → 'ask'；permission='auto' → 'auto'（保守默认）
   *    - auto：edit 工具 → 'auto'（工作区编辑快速路径）；exec 工具 → 'ask'（危险命令仍审批）；read → 'auto'
   *    - yolo：全部 → 'auto'（无审批）
   * 3. 工具自身 permission='auto' 时恒为 'auto'（只读白名单，任何模式不弹审批）
   *
   * @param tool 待执行的工具
   * @param input 工具入参（用于构建记忆 key）
   * @param userPrompt 用户原始 prompt（意图豁免：显式提及 discard/wipe 等豁免破坏性拦截）
   */
  decide(tool: Tool, input: unknown, userPrompt?: string): Promise<PermissionDecision>;

  /**
   * 请求用户审批
   *
   * 通过 webContents.send 推送 AGENT_APPROVAL_REQUEST 事件到渲染层，
   * 渲染层弹出 ApprovalModal，用户选择后通过 agent:approval:response 回传。
   *
   * 同时在 pending Map 中保存 tool + input 引用，
   * 用于 handleApprovalResponse 时构建记忆决策 key。
   *
   * abortSignal 支持：若传入 AbortSignal，在等待用户响应期间信号触发 abort 时，
   * 立即 reject Promise（TOOL_ABORTED）。这解决了 ToolExecutor 在 await 期间
   * 无法响应中断的竞态条件。
   *
   * @param payload 审批请求 payload（含 approvalId / toolName / input / description）
   * @param tool 工具实例（用于 rememberDecision 时构建 key）
   * @param input 工具入参（用于 rememberDecision 时构建 key）
   * @param webContents 接收审批请求的窗口
   * @param abortSignal 可选中断信号（用户点"停止"时触发，立即 reject）
   * @returns 用户是否批准（true 执行，false 拒绝）
   */
  requestApproval(
    payload: AgentApprovalRequestPayload,
    tool: Tool,
    input: unknown,
    webContents?: WebContents,
    abortSignal?: AbortSignal,
  ): Promise<boolean>;

  /**
   * 处理审批响应
   *
   * 由 IPC handler（agent:approval:response）调用，resolve 对应 approvalId 的 Promise。
   * 若用户选了 rememberDecision，缓存决策到 remembered Map。
   *
   * @param approvalId 审批请求 id
   * @param approved 用户是否批准
   * @param rememberDecision 是否记忆决策（5分钟内不再询问）
   */
  handleApprovalResponse(approvalId: string, approved: boolean, rememberDecision: boolean): void;

  /**
   * 释放所有 pending Promise 与资源
   *
   * 用于应用退出 / ServiceContainer.dispose 场景，
   * reject 所有未完成的审批 Promise，避免内存泄漏。
   */
  dispose(): void;

  /**
   * 设置审批模式（对齐 qwen ApprovalMode 配置化）
   *
   * 由 settings:setApprovalMode handler 调用；启动时读取 approval-pref 应用。
   */
  setApprovalMode(mode: ApprovalMode): void;

  /** 当前审批模式 */
  getApprovalMode(): ApprovalMode;

  /**
   * 记录一次用户拒绝（AUTO 模式拒绝跟踪：连续拒绝超阈值降级手动确认）
   *
   * 由 ToolExecutor 在用户拒绝工具调用后调用。
   */
  recordUserDenial(): void;

  /**
   * 订阅审批生命周期（Agent 回合状态机 waitingApproval 状态的数据源）
   *
   * - onRequested：审批请求已推送（回合进入等待）
   * - onResolved：审批决议完成（回合恢复执行）
   *
   * @returns 注销函数
   */
  onApprovalLifecycle(listener: ApprovalLifecycleListener): () => void;

  /**
   * 记录一次用户放行/工具成功执行（重置连续拒绝计数）
   */
  recordUserAllowance(): void;

  /**
   * 列出全部白名单条目（跨会话持久化）
   */
  listWhitelist(): readonly WhitelistEntry[];

  /**
   * 添加白名单条目（立即持久化；空 pattern = 该工具全部放行）
   */
  addWhitelistEntry(entry: WhitelistEntry): Promise<void>;

  /**
   * 移除白名单条目（立即持久化）
   */
  removeWhitelistEntry(entry: WhitelistEntry): Promise<void>;
}

/**
 * 审批生命周期监听器（Agent 回合状态机 waitingApproval 状态的数据源）
 */
export interface ApprovalLifecycleListener {
  /** 审批请求已推送（approvalId + sessionId，供回合过滤） */
  onRequested(payload: {
    readonly sessionId: string;
    readonly approvalId: string;
    readonly toolName: string;
  }): void;
  /** 审批决议完成（批准/拒绝；带 sessionId 供回合过滤） */
  onResolved(payload: { readonly sessionId: string; readonly approvalId: string }): void;
}

/**
 * pending 审批条目
 *
 * 包含 Promise 的 resolve/reject、超时定时器、
 * 以及用于记忆决策的 tool + input 引用。
 */
interface PendingApproval {
  /** resolve 函数，用户响应后调用 */
  readonly resolve: (approved: boolean) => void;
  /** reject 函数，超时或 dispose 时调用 */
  readonly reject: (error: Error) => void;
  /** 超时定时器，超时后自动 reject */
  readonly timer: ReturnType<typeof setTimeout>;
  /** 关联的工具实例（用于 rememberDecision 时构建 key） */
  readonly tool: Tool;
  /** 关联的工具入参（用于 rememberDecision 时构建 key） */
  readonly input: unknown;
  /** 所属会话 id（审批生命周期事件过滤用） */
  readonly sessionId: string;
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
    // 启动时读入持久化白名单（空列表 = 全部走审批流）
    this.whitelist = readWhitelistSync();
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
  /** 命令白名单（跨会话持久化；空 pattern = 该工具全部放行） */
  private whitelist: WhitelistEntry[];

  /** @inheritDoc */
  setApprovalMode(mode: ApprovalMode): void {
    this.approvalMode = mode;
    // 切换审批模式重置拒绝计数（对齐 qwen：模式切换重置全部计数器）
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
    // 幂等：同工具 + 同模式已存在则不重复添加
    const exists = this.whitelist.some(
      (e) => e.toolName === entry.toolName && e.pattern === entry.pattern,
    );
    if (!exists) {
      this.whitelist = [...this.whitelist, entry];
      await writeWhitelist(this.whitelist);
    }
  }

  /** @inheritDoc */
  async removeWhitelistEntry(entry: WhitelistEntry): Promise<void> {
    const next = this.whitelist.filter(
      (e) => !(e.toolName === entry.toolName && e.pattern === entry.pattern),
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
   * 白名单匹配：工具名相等 + 模式匹配（空模式 = 该工具全部放行）
   *
   * 命令子串匹配（对齐原型 whitelist-panel 的按命令放行语义）：
   * 非命令工具（write_file 等）无 command 字段时仅空模式可命中。
   */
  private isWhitelisted(tool: Tool, input: unknown): boolean {
    return this.whitelist.some((entry) => {
      if (entry.toolName !== tool.name) {
        return false;
      }
      if (entry.pattern === '') {
        return true;
      }
      const command = extractCommandFromInput(input);
      return command?.includes(entry.pattern) === true;
    });
  }

  /** @inheritDoc */
  async decide(tool: Tool, input: unknown, userPrompt?: string): Promise<PermissionDecision> {
    // 1. 检查记忆决策
    const key = this.buildRememberKey(tool.name, input);
    const remembered = this.remembered.get(key);
    if (remembered !== undefined) {
      // 惰性清理过期记忆
      if (remembered.expireAt <= Date.now()) {
        this.remembered.delete(key);
      } else {
        // 记忆未过期
        logger.debug(
          { toolName: tool.name, approved: remembered.approved },
          '权限决策命中记忆缓存',
        );
        // 记忆 approved → 'auto'（直接执行）
        // 记忆 denied → 'ask'（重新询问，让用户有机会改变主意，避免锁死）
        return {
          permission: remembered.approved ? 'auto' : 'ask',
          description: tool.description,
        };
      }
    }

    // 2. 工具自身白名单（permission='auto'）：任何模式自动放行（只读工具）
    if (tool.permission === 'auto') {
      return {
        permission: 'auto',
        description: tool.description,
      };
    }

    // 2.5 用户白名单（跨会话持久化）：命中即自动放行（无需审批）
    if (this.isWhitelisted(tool, input)) {
      logger.debug({ toolName: tool.name }, '权限决策命中用户白名单');
      return {
        permission: 'auto',
        description: tool.description,
      };
    }

    // 3. 按审批模式分级决策（对齐 qwen ApprovalMode 谱系）
    const decision = await this.decideByMode(tool, input, userPrompt);
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
  ): Promise<{
    permission: 'auto' | 'ask' | 'deny';
    description: string;
  }> {
    switch (this.approvalMode) {
      case 'plan':
        // 只读探索：写类工具全部拒绝（Plan/Apply 分离的只读阶段）
        return tool.category === 'read'
          ? { permission: 'auto', description: tool.description }
          : { permission: 'deny', description: tool.description };
      case 'auto': {
        // 拒绝跟踪降级：连续/累计拒绝超阈值 → 本次调用降级手动确认
        if (shouldFallbackToManual(this.denialState)) {
          return {
            permission: 'ask',
            description: `${tool.description}（拒绝频繁，降级手动确认）`,
          };
        }
        // 编辑快速路径自动；命令执行按危险/安全分层
        if (tool.category === 'exec') {
          const command = extractCommandFromInput(input);
          if (command !== undefined) {
            const dangerous = detectDangerousCommand(command, userPrompt);
            if (dangerous.isDangerous) {
              // Layer-0 确定性拦截：破坏性命令强制 ask（不可被绕过）
              return {
                permission: 'ask',
                description: `${tool.description}（⚠️ ${dangerous.reason}）`,
              };
            }
            if (isSafeReadOnlyCommand(command)) {
              // 只读安全命令自动放行（对齐 AUTO 分类器安全命令收敛）
              return { permission: 'auto', description: tool.description };
            }
            // LLM 分类器（可选注入）：safe 自动放行；dangerous/unknown 降级 ask
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
          // 其余命令保守 ask（无分类器时）
          return { permission: 'ask', description: tool.description };
        }
        return { permission: 'auto', description: tool.description };
      }
      case 'yolo':
        // 全部自动（仅信任环境使用；显式 opt-out 所有守卫）
        return { permission: 'auto', description: tool.description };
      default:
        // ask（保守默认）：全部审批
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
      // 已 abort 的信号直接 reject（避免推送无意义的审批请求到已销毁的会话）
      if (abortSignal?.aborted === true) {
        reject(new AppError(ErrorCode.TOOL_ABORTED, '工具执行已被中断'));
        return;
      }

      // 超时定时器：5 分钟后自动 reject
      const timer = setTimeout(() => {
        cleanupAbort();
        this.pending.delete(payload.approvalId);
        logger.warn({ approvalId: payload.approvalId, toolName: payload.toolName }, '审批超时');
        reject(new AppError(ErrorCode.TOOL_PERMISSION_DENIED, `审批超时：${payload.toolName}`));
      }, APPROVAL_TIMEOUT_MS);

      // abort 监听器：用户中断对话时立即 reject（H4 修复）
      // 必须在 pending.set 之前定义，因为 timer 回调中要引用它
      const onAbort = (): void => {
        clearTimeout(timer);
        this.pending.delete(payload.approvalId);
        logger.info(
          { approvalId: payload.approvalId, toolName: payload.toolName },
          '审批等待期间收到中断信号',
        );
        reject(new AppError(ErrorCode.TOOL_ABORTED, '工具执行已被中断'));
      };

      const cleanupAbort = (): void => {
        if (abortSignal !== undefined) {
          abortSignal.removeEventListener('abort', onAbort);
        }
      };

      // 在 pending Map 中保存 tool + input 引用，
      // 用于 handleApprovalResponse 时构建记忆决策 key
      this.pending.set(payload.approvalId, {
        resolve,
        reject,
        timer,
        tool,
        input,
        sessionId: payload.sessionId,
        cleanupAbort,
      });

      // 注册 abort 监听（若传入 abortSignal）
      if (abortSignal !== undefined) {
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      // 推送 AGENT_APPROVAL_REQUEST 到渲染层（R2：统一出口 emitEvent——dev 契约校验）
      if (webContents !== undefined && !webContents.isDestroyed()) {
        emitEvent(webContents, IPC_DEFINITIONS.agent.subscribeApprovalRequest, payload);
        logger.info(
          { approvalId: payload.approvalId, toolName: payload.toolName },
          '审批请求已推送',
        );
        // 审批生命周期：真实推送后通知（Agent 回合状态机 → waitingApproval）
        this.notifyApprovalRequested({
          sessionId: payload.sessionId,
          approvalId: payload.approvalId,
          toolName: payload.toolName,
        });
      } else if (webContents === undefined) {
        // 无头场景（IM 桥接等）无审批通道：自动拒绝（安全优先）
        clearTimeout(timer);
        cleanupAbort();
        this.pending.delete(payload.approvalId);
        reject(
          new AppError(ErrorCode.TOOL_PERMISSION_DENIED, '无审批通道（无头执行），工具调用被拒绝'),
        );
      } else {
        // webContents 已销毁，立即 reject
        clearTimeout(timer);
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

    clearTimeout(entry.timer);
    entry.cleanupAbort?.();
    this.pending.delete(approvalId);

    // 记忆决策（用户选了"5分钟内不再询问"）
    if (rememberDecision) {
      this.rememberDecision(entry.tool, entry.input, approved);
    }

    entry.resolve(approved);
    logger.info({ approvalId, approved, rememberDecision }, '审批响应已处理');
    // 审批生命周期：决议完成通知（Agent 回合状态机 → 恢复 running）
    this.notifyApprovalResolved({ sessionId: entry.sessionId, approvalId });
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
    // reject 所有 pending Promise
    for (const [approvalId, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.cleanupAbort?.();
      entry.reject(new AppError(ErrorCode.TOOL_ABORTED, 'PermissionService 已释放'));
      logger.debug({ approvalId }, 'dispose 时 reject pending 审批');
    }
    this.pending.clear();
    this.remembered.clear();
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
 * 稳定 JSON 序列化
 *
 * 与 JSON.stringify 的区别：对象的键按字典序排序，
 * 确保相同内容不同键顺序的对象生成相同的 hash。
 *
 * 用于 buildRememberKey，避免对象键顺序影响记忆决策的 key。
 */
function stableStringify(value: unknown): string {
  return stableStringifyInternal(value, new WeakSet());
}

/**
 * stableStringify 内部实现，携带已访问对象集合检测循环引用
 *
 * 与原生 JSON.stringify 行为一致：遇到循环引用抛 TypeError，
 * 而非无限递归导致栈溢出（栈溢出会崩溃主进程，TypeError 可被调用方 catch）。
 */
function stableStringifyInternal(value: unknown, visited: WeakSet<object>): string {
  // 对于非对象值（string/number/boolean/null），直接 stringify
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  // 循环引用检测：已访问过的对象抛 TypeError（与 JSON.stringify 行为一致）
  if (visited.has(value)) {
    throw new TypeError('Converting circular structure to JSON in stableStringify');
  }
  visited.add(value);
  // 对于数组，递归处理元素
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringifyInternal(v, visited)).join(',')}]`;
  }
  // 对于对象，按键排序后递归处理值
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map(
      (k) =>
        `${JSON.stringify(k)}:${stableStringifyInternal((value as Record<string, unknown>)[k], visited)}`,
    )
    .join(',')}}`;
}

/**
 * 从工具入参提取命令文本（run_command: { command }；terminal: { command? }）
 *
 * 无命令字段的工具入参返回 undefined（跳过命令级检测）。
 */
function extractCommandFromInput(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const command = record['command'];
  return typeof command === 'string' && command.trim().length > 0 ? command : undefined;
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
