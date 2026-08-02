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
import type { AgentApprovalRequestPayload } from '@code-agent/shared';
import { AppError, ErrorCode, IPC_CHANNELS } from '@code-agent/shared';
import type { WebContents } from 'electron';
import { logger } from '../../utils/logger';
import type { Tool } from './tool';

/**
 * 权限决策结果
 *
 * - permission：最终权限级别（'auto' 直接执行 / 'ask' 需用户审批）
 * - description：人类可读的操作摘要，用于 ApprovalModal 展示
 */
export interface PermissionDecision {
  /** 最终权限级别 */
  readonly permission: 'auto' | 'ask';
  /** 人类可读的操作摘要（如 "写入文件 /path/to/file.ts"） */
  readonly description: string;
}

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
   * 决策顺序：
   * 1. 检查记忆决策：若用户之前对此 tool+input 组合选了"5分钟内不再询问"且未过期，
   *    返回记忆结果（approved → 'auto'；denied → 'ask' 让用户重新决策）
   * 2. 默认返回 tool.permission
   *
   * @param tool 待执行的工具
   * @param input 工具入参（用于构建记忆 key）
   */
  decide(tool: Tool, input: unknown): PermissionDecision;

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
    webContents: WebContents,
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
  /** pending 审批 Map：approvalId → PendingApproval */
  private readonly pending = new Map<string, PendingApproval>();
  /** 记忆决策 Map：`${toolName}:${hash(input)}` → RememberedDecision */
  private readonly remembered = new Map<string, RememberedDecision>();

  /** @inheritDoc */
  decide(tool: Tool, input: unknown): PermissionDecision {
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

    // 2. 默认返回 tool.permission
    return {
      permission: tool.permission,
      description: tool.description,
    };
  }

  /** @inheritDoc */
  requestApproval(
    payload: AgentApprovalRequestPayload,
    tool: Tool,
    input: unknown,
    webContents: WebContents,
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
        cleanupAbort,
      });

      // 注册 abort 监听（若传入 abortSignal）
      if (abortSignal !== undefined) {
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      // 推送 AGENT_APPROVAL_REQUEST 到渲染层
      if (!webContents.isDestroyed()) {
        webContents.send(IPC_CHANNELS.AGENT_APPROVAL_REQUEST, payload);
        logger.info(
          { approvalId: payload.approvalId, toolName: payload.toolName },
          '审批请求已推送',
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
 * 生成新的 approvalId
 *
 * 暴露给 ToolExecutor 使用，避免 ToolExecutor 直接依赖 node:crypto。
 * approvalId 格式：UUID v4
 */
export function generateApprovalId(): string {
  return randomUUID();
}
