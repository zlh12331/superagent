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
  REMEMBER_TTL_MS,
} from '@code-agent/shared/main';
import type { WebContents } from 'electron';
import { emitEvent } from '../../../utils/emit-event';
import { logger } from '../../../utils/logger';
import { readWhitelistSync, writeWhitelist } from '../../storage/whitelist-pref';
import type { CommandClassifier } from './command-classifier';
import {
  commandTargetsOutsideBoundary,
  extractCommandFromInput,
  isCompositeCommand,
  isUniversalWhitelistPattern,
  matchesWhitelistPattern,
  PLAN_MODE_CONTROL_TOOLS,
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
  ApprovalLifecycleListener,
  IPermissionService,
  PermissionDecision,
} from './permission-types';
import { stableStringify } from './stable-stringify';
import type { Tool } from './tool';

/** 默认审批模式（单一真源：shared schemas/settings.ts，与 approval-pref 共用） */
export { DEFAULT_APPROVAL_MODE } from '@code-agent/shared/main';
// 契约层 re-export：外部 import 路径保持 './permission-service' 不变
export type {
  ApprovalLifecycleListener,
  IPermissionService,
  PermissionDecision,
} from './permission-types';

/**
 * 审批超时时间（毫秒）
 *
 * 5 分钟，避免用户离开后 Promise 长期挂起。
 * 超时后视为拒绝，工具不会被执行。
 */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

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
    // P0 修复：加载即迁移——丢弃历史「空模式 / 纯通配符」条目（等同放行该工具
    // 一切调用，且旧版本静默生效）。回写持久化，避免下次启动复活。
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
    // P0 修复：拒绝「等同放行该工具全部调用」的条目。
    // 白名单的合法语义只有「工具 + 具体命令前缀」（见 matchesWhitelistPattern），
    // 空/通配符模式会把 run_command / write_file 变成永久免审批通道。
    // 这里显式报错而不是静默丢弃：调用方（设置页 / agent）必须给出真实范围。
    if (isUniversalWhitelistPattern(entry.pattern)) {
      throw new AppError(
        ErrorCode.INVALID_INPUT,
        `白名单模式不能为空或纯通配符（等同放行 ${entry.toolName} 的全部调用），请填写具体命令前缀，例如 "npm test"`,
      );
    }
    // 幂等：同工具 + 同模式（忽略首尾空白）已存在则不重复添加
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

    // 2. 工具自身 permission='auto'（只读快速路径）
    //
    // P0 修复：此前这里是**无条件短路**（`if (tool.permission === 'auto') return auto`），
    // 排在 plan 模式判定与 Layer-0 危险命令拦截之前，于是：
    // - plan 模式下任何被标成 auto 的写类/执行类工具照样执行（Plan/Apply 分离失效）
    // - auto 工具入参携带 shell 命令时完全绕过 Layer-0 确定性拦截
    // - MCP 工具尤其危险：category 恒为 'exec'，而 permission 只要 server 自报
    //   annotations.readOnlyHint（或用户设 permissionOverride:'auto'）就是 auto
    //   → 一个撒谎/被攻陷的 MCP server 拿到「任何模式免审批」的任意调用通道
    // 现在 auto 只担保「只读工具免打扰」，其余一律回落到完整决策链并 fail closed。
    if (tool.permission === 'auto') {
      // 2a. 只读工具：保持快速路径（plan/auto/ask/yolo 都不弹审批，零副作用）
      if (tool.category === 'read') {
        return { permission: 'auto', description: tool.description };
      }
      // 2b. 命令形状入参：Layer-0 确定性拦截对 auto 同样生效（不可被 auto 标记绕过）
      const command = extractCommandFromInput(input);
      if (command !== undefined) {
        const dangerous = detectDangerousCommand(command, userPrompt);
        if (dangerous.isDangerous) {
          return {
            permission: 'ask',
            description: `${tool.description}（⚠️ ${dangerous.reason}）`,
          };
        }
        // 复合命令（; | && ` $() 换行）：前缀式只读判定不覆盖后继段落，必须确认
        if (isCompositeCommand(command)) {
          return {
            permission: 'ask',
            description: `${tool.description}（复合命令，后继段落不受白名单约束）`,
          };
        }
        // P2 补全：非危险、非复合的只读命令引用工作目录边界外的路径时，
        // 同样降级 ask（与 decideByMode auto 分支同语义）。此前 2b→2d 直达
        // auto，MCP readOnlyHint 工具可借 command 入参越界读取（如 ~/.ssh）。
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
      // 2c. plan 模式：非只读且不在控制面逃生舱内的 auto 工具一律 deny
      if (this.approvalMode === 'plan' && !PLAN_MODE_CONTROL_TOOLS.has(tool.name)) {
        return {
          permission: 'deny',
          description: `${tool.description}（计划模式只读，非只读工具需先退出计划模式）`,
        };
      }
      // 2d. 其余（控制面工具 / 非 plan 模式的无命令 auto 工具）维持免审批
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
            // P0：复合命令不走只读安全快速路径——SAFE_READ_ONLY 的 ^ 前缀锚定
            // 只覆盖第一段命令，'&&'/'|' 后继段落不受任何保护
            if (!isCompositeCommand(command) && isSafeReadOnlyCommand(command)) {
              // P2（IM 外泄向量）：路径边界约束——命令引用工作目录之外的绝对路径
              // （含 ~ 展开的 home 敏感目录）时不走快速路径，降级 ask。
              // 桌面端同样生效：越界读取本就该经用户确认，而非静默放行。
              if (
                options?.pathBoundary !== undefined &&
                commandTargetsOutsideBoundary(command, options.pathBoundary)
              ) {
                return {
                  permission: 'ask',
                  description: `${tool.description}（⚠️ 引用工作目录之外的路径，需确认）`,
                };
              }
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
        // 状态机修复：超时 reject 也必须通知审批决议完成，否则 agent 回合
        // 状态机永久卡在 waitingApproval（stream.finished 转换在该状态下非法）
        this.notifyApprovalResolved({
          sessionId: payload.sessionId,
          approvalId: payload.approvalId,
        });
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
        // 与超时路径同因：abort reject 前通知决议完成，保证状态机出口一致
        this.notifyApprovalResolved({
          sessionId: payload.sessionId,
          approvalId: payload.approvalId,
        });
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
 * 生成新的 approvalId
 *
 * 暴露给 ToolExecutor 使用，避免 ToolExecutor 直接依赖 node:crypto。
 * approvalId 格式：UUID v4
 */
export function generateApprovalId(): string {
  return randomUUID();
}
