// src/main/infra/ai/tools/permission-types.ts
// 权限服务契约层（自 permission-service.ts 提取：接口与决策类型单一归属）
// ──────────────────────────────────────────────────────────────
// permission-service.ts 对外 re-export 本文件全部符号（外部 import 路径不变）。
// ──────────────────────────────────────────────────────────────

import type {
  AgentApprovalRequestPayload,
  ApprovalMode,
  WhitelistEntry,
} from '@code-agent/shared/main';
import type { WebContents } from 'electron';

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
   * 2. 工具自身 permission='auto'：只有 **category='read'** 才走免审批快速路径；
   *    非只读的 auto 工具不再无条件短路——先过 Layer-0（危险/复合命令升级为 'ask'），
   *    再在 plan 模式下按控制面逃生舱之外一律 'deny'（P0 修复，详见实现处注释）
   * 3. 用户持久化白名单命中 → 'auto'（空/通配符模式无效，见 addWhitelistEntry）
   * 4. 按工具类别 + ApprovalMode 分级决策：
   *    - plan：edit/exec 工具 → 'deny'（只读探索零副作用）；read 工具 → 'auto'
   *    - ask：permission='ask' → 'ask'；permission='auto' → 'auto'（保守默认）
   *    - auto：edit 工具 → 'auto'（工作区编辑快速路径）；exec 工具 → 'ask'（危险命令仍审批）；read → 'auto'
   *    - yolo：全部 → 'auto'（无审批）
   *
   * @param tool 待执行的工具
   * @param input 工具入参（用于构建记忆 key）
   * @param userPrompt 用户原始 prompt（意图豁免：显式提及 discard/wipe 等豁免破坏性拦截）
   * @param options 可选决策约束：pathBoundary 为本会话工作目录边界——auto 模式下
   *   exec 命令引用边界外的绝对路径（含 ~ 展开的 home 敏感目录）时降级 ask。
   *   P2 修复（IM 外泄向量）：无头 IM 会话的输出直达外部渠道，
   *   `cat ~/.ssh/id_rsa` 这类越界读取此前可被只读快速路径静默放行。
   */
  decide(
    tool: Tool,
    input: unknown,
    userPrompt?: string,
    options?: { readonly pathBoundary?: string },
  ): Promise<PermissionDecision>;

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
