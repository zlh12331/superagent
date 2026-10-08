// src/main/infra/ai/tools/tool-executor.ts
// 工具执行器：统一工具执行入口，整合权限检查与审批流程
// ──────────────────────────────────────────────────────────────
// 职责：
// - execute(toolName, input, ctx, webContents)：统一执行入口
//   1. 查找工具（ToolRegistry.get）
//   2. PermissionService.decide(tool, input) 决策权限
//   3. 若 'ask'：推送 AGENT_APPROVAL_REQUEST，等待用户响应
//   4. 若 approved：调用 tool.execute(input, ctx)
//   5. 推送 AGENT_TOOL_RESULT 到渲染层
//   6. 返回 AgentToolResultPayload
//
// 设计原则：
// - 统一入口：所有工具调用都通过 ToolExecutor，确保权限检查与审计一致
// - 错误分类：工具不存在 / 权限拒绝 / 执行失败 / 中断，分别对应不同错误码
// - IPC 推送：执行前推送 AGENT_TOOL_CALL，执行后推送 AGENT_TOOL_RESULT
// - 中断响应：检查 ctx.abortSignal.aborted，及时中止执行
// - 标准化返回：tool.execute 返回 ToolResult（title + output + metadata），
//   对齐 MiMo-Code 的工具返回结构，便于 UI 统一展示
//
// 与 AI SDK v7 的关系：
// - AgentService 把 ToolExecutor 的执行逻辑包装为 AI SDK tool 的 execute 函数
// - toolApproval 配置由 AgentService 负责（基于 ToolExecutor 的 decide 结果）
// - ToolExecutor 不直接调用 streamText，是被 AgentService 调用
// ──────────────────────────────────────────────────────────────

import type { AgentToolCallPayload, AgentToolResultPayload } from '@code-agent/shared/main';
import { AppError, ErrorCode, IPC_DEFINITIONS } from '@code-agent/shared/main';
import type { WebContents } from 'electron';
import { emitEvent } from '../../../utils/emit-event';
import { logger } from '../../../utils/logger';
import { withSpan } from '../../telemetry/otel';
import { HookEventName, hookRegistry } from '../agent/hook-registry';
import type { IPermissionService, PermissionDecision } from './permission-service';
import { generateApprovalId } from './permission-service';
import type { Tool, ToolContext, ToolResult } from './tool';
import type { IToolRegistry } from './tool-registry';

/**
 * ToolExecutor 接口
 *
 * 解耦 AgentService 对具体实现的依赖，便于：
 * - 单元测试：注入 mock 实现，不依赖真实 IPC 推送
 * - 未来扩展：支持批量执行 / 重试 / 限流等策略
 */
export interface IToolExecutor {
  /**
   * 执行工具调用
   *
   * 完整流程：
   * 1. ToolRegistry.get(toolName) 查找工具
   * 2. PermissionService.decide(tool, input) 决策权限
   * 3. 推送 AGENT_TOOL_CALL 事件到渲染层
   * 4. 若 permission='ask'：生成 approvalId，推送 AGENT_APPROVAL_REQUEST，
   *    等待用户通过 agent:approval:response 回传结果
   * 5. 若 approved=false：返回带 TOOL_PERMISSION_DENIED 错误的结果
   * 6. 若 approved=true 或 permission='auto'：调用 tool.execute(input, ctx)
   * 7. 推送 AGENT_TOOL_RESULT 事件到渲染层
   * 8. 返回 AgentToolResultPayload（含 title / output / metadata 或 error）
   *
   * @param toolName 工具名称
   * @param toolCallId AI SDK 生成的工具调用 id（用于事件关联与渲染层 UI 配对）
   * @param input 工具入参（已被 AI SDK 通过 inputSchema 校验）
   * @param ctx 工具执行上下文
   * @param webContents 接收工具事件的窗口
   * @returns 工具执行结果（含 title / output / metadata 或 error）
   */
  execute(
    toolName: string,
    toolCallId: string,
    input: unknown,
    ctx: ToolContext,
    webContents?: WebContents,
  ): Promise<AgentToolResultPayload>;
}

/**
 * 工具输出统一字节闸门（2026-09-08 性能/成本修复；2026-10-08 窗口感知化）
 *
 * 背景：各工具的截断策略不一致——run_command 100KB、web_fetch 4000 字符，
 * 而 read_file 只透传 fileService 结果（其 2MB 上限是「超过就报错」而非截断），
 * 省略 limit 时读全文 → 2MB ≈ 50 万 token 灌入上下文，足以报废一个回合
 * （既烧钱又挤掉有效上下文）。
 *
 * 位置选择：放在 ToolExecutor 出口而非各工具内——单点保证「任何工具的输出
 * 都不可能无界进上下文」，新增工具无需重复实现。
 *
 * 阈值 = min(绝对上限, 模型窗口的可分配比例)：
 * - 绝对上限 200KB（约 5 万 token）：对 128K+ 窗口成立（原注释的隐含前提），
 *   防单次输出报废回合
 * - 窗口比例上限：**32K 窗口的本地模型若按 200KB 放行，单次输出即占满全部
 *   上下文**（原常量只对 128K+ 成立）。2026-10-08 起按模型窗口收敛——
 *   项目支持 10 家供应商（窗口 32K ~ 1M），单一常量无法同时适配两端
 */
const MAX_TOOL_OUTPUT_BYTES = 200 * 1024;
/** 输出下限（极端小窗口下仍保证有可用输出） */
const MIN_TOOL_OUTPUT_BYTES = 8 * 1024;
/**
 * 单次工具输出占模型窗口的比例上限
 *
 * 保守取 1/4：工具输出只是回合的一轮输入，其后还有模型回复、后续工具调用与
 * 历史消息——留 3/4 给其余部分是"不挤掉上下文"的估计。
 */
const OUTPUT_WINDOW_RATIO = 0.25;
/**
 * token → 字节的估算系数
 *
 * 英文约 4 字符/token、中文约 1.5（UTF-8 下 3 字节/字 → 2 字节/token）——
 * 取保守中位 3，宁可少放行也不挤爆窗口。
 */
const BYTES_PER_TOKEN = 3;

/**
 * 按模型窗口计算输出上限（未提供窗口信息时用绝对上限）
 *
 * @param contextWindowSize 模型上下文窗口（token；取自 ResolvedModel.capabilities）
 * @returns 字节上限（[MIN_TOOL_OUTPUT_BYTES, MAX_TOOL_OUTPUT_BYTES] 区间内）
 */
export function toolOutputLimitFor(contextWindowSize: number | undefined): number {
  if (contextWindowSize === undefined || contextWindowSize <= 0) {
    return MAX_TOOL_OUTPUT_BYTES;
  }
  const windowBudget = contextWindowSize * BYTES_PER_TOKEN * OUTPUT_WINDOW_RATIO;
  return Math.max(MIN_TOOL_OUTPUT_BYTES, Math.min(MAX_TOOL_OUTPUT_BYTES, Math.floor(windowBudget)));
}

/**
 * 按字节截断工具输出（超限时保留头部 + 标注）
 *
 * 用 Buffer 按字节切分再转回字符串，避免按字符数截断导致多字节字符被劈开。
 *
 * @param output 工具输出文本
 * @param contextWindowSize 模型上下文窗口（token；省略 = 用绝对上限，向后兼容）
 */
export function clampToolOutput(output: string, contextWindowSize?: number): string {
  const limit = toolOutputLimitFor(contextWindowSize);
  const bytes = Buffer.byteLength(output, 'utf8');
  if (bytes <= limit) {
    return output;
  }
  const head = Buffer.from(output, 'utf8').subarray(0, limit).toString('utf8');
  // 多字节字符在切点处可能产生替换字符，去掉末尾可能不完整的字符
  const safeHead = head.endsWith('\uFFFD') ? head.slice(0, -1) : head;
  return `${safeHead}\n\n…（输出超过 ${Math.round(limit / 1024)}KB 已截断，共 ${(bytes / 1024).toFixed(0)}KB；请缩小范围或分段读取）`;
}

/**
 * 对 SDK 流式 part 中的工具输出做统一截断（2026-09-08 输出闸门盲区修复）
 *
 * SDK 的 `tool-output-available` / `tool-output-error` part 携带完整
 * input/output（`ai` 包定义），该通道与 ToolExecutor 的 tool-result 通道
 * 是两条独立路径。此前闸门只加在后者，导致 read_file 等大输出仍可原样
 * 经流式通道进入渲染层与后续上下文。
 *
 * 仅处理工具类 part 的字符串字段，其余 part 原样返回（不引入额外分配）。
 * 放在本模块与 clampToolOutput 同源，避免 agent-service 文件净行超限。
 */
export function clampToolPartOutput(part: unknown, contextWindowSize?: number): unknown {
  if (typeof part !== 'object' || part === null) {
    return part;
  }
  const record = part as Record<string, unknown>;
  const type = record['type'];
  if (type !== 'tool-output-available' && type !== 'tool-output-error') {
    return part;
  }
  const output = record['output'];
  if (typeof output !== 'string') {
    return part;
  }
  return { ...record, output: clampToolOutput(output, contextWindowSize) };
}

/**
 * ToolExecutor 默认实现
 *
 * 依赖：
 * - IToolRegistry：查找工具实例
 * - IPermissionService：决策权限与请求审批
 *
 * 单例模式：通过 ServiceContainer 持有，整个应用生命周期共享一个实例。
 */
export class ToolExecutor implements IToolExecutor {
  /**
   * @param registry 工具注册表
   * @param permissionService 权限服务
   */
  constructor(
    private readonly registry: IToolRegistry,
    private readonly permissionService: IPermissionService,
  ) {}

  /** @inheritDoc */
  async execute(
    toolName: string,
    toolCallId: string,
    input: unknown,
    ctx: ToolContext,
    webContents?: WebContents,
  ): Promise<AgentToolResultPayload> {
    // 性能埋点：工具执行全流程耗时（含权限检查 + 审批等待 + 工具执行）
    const startTime = performance.now();
    // OpenTelemetry span：仅做埋点包装，执行主体在 runExecution（见其注释）
    return withSpan(
      'tool.execute',
      {
        'tool.name': toolName,
        'tool.callId': toolCallId,
        'session.id': ctx.sessionId,
      },
      async (span) =>
        this.runExecution({ toolName, toolCallId, input, ctx, webContents, startTime, span }),
    );
  }

  /**
   * 执行主体（2026-10-08 从 execute 提取）
   *
   * 提取动机与先例：本流程有 6 个错误出口（工具不存在 / 权限决策异常 / 钩子阻止 /
   * 权限闸 / 中断 / 执行失败），内联展开会把认知复杂度推过门槛（实测 20 > 15）。
   * 与下方 resolvePermissionGate 的拆分同因同法——**每层只留一类判定**，
   * execute 退化为「span 包装 + 委托」。
   *
   * 出口协议：任一步失败即经 fail 构建错误结果（推渲染层）并返回——
   * 调用方（executeHook）以 result.error 是否存在区分成败。
   */
  private async runExecution(args: {
    readonly toolName: string;
    readonly toolCallId: string;
    readonly input: unknown;
    readonly ctx: ToolContext;
    readonly webContents: WebContents | undefined;
    readonly startTime: number;
    readonly span:
      | { setAttribute(key: string, value: string | number | boolean): void }
      | undefined;
  }): Promise<AgentToolResultPayload> {
    const { toolName, toolCallId, input, ctx, webContents, startTime, span } = args;
    /** 统一的失败出口（构建错误结果 + 推送 + 返回） */
    const fail = (title: string, code: string, message: string): AgentToolResultPayload =>
      this.failWith({
        sessionId: ctx.sessionId,
        toolCallId,
        toolName,
        webContents,
        title,
        code,
        message,
      });

    // 1. 查找工具
    const tool = this.registry.get(toolName);
    if (tool === undefined) {
      logger.warn({ toolName, toolCallId, errorCode: ErrorCode.TOOL_NOT_FOUND }, '工具不存在');
      return fail('工具不存在', ErrorCode.TOOL_NOT_FOUND, `工具不存在：${toolName}`);
    }

    // 2. 决策权限（userPrompt 用于意图豁免破坏性拦截）
    // P2（IM 外泄向量）：ctx.workingDir 作为路径边界传入——auto 模式下
    // 命令引用边界外的绝对路径时降级 ask，不再被只读快速路径静默放行
    //
    // fail-closed：decide 内部（stableStringify / 白名单匹配）的异常契约是
    // "由调用方 catch"，而这里是唯一生产调用点。不兜住会让异常冒泡出
    // execute()，AGENT_TOOL_RESULT 永远不推送，渲染层工具卡片卡在"执行中"。
    let decision: PermissionDecision;
    try {
      decision = await this.permissionService.decide(tool, input, ctx.userPrompt, {
        pathBoundary: ctx.workingDir,
      });
    } catch (error: unknown) {
      logger.error({ toolName, toolCallId, error }, '权限决策异常，已拒绝执行');
      return fail(
        '权限决策失败',
        ErrorCode.TOOL_PERMISSION_DENIED,
        `权限决策失败，已拒绝执行：${toolName}`,
      );
    }

    // 3. 推送 AGENT_TOOL_CALL 事件（渲染层据此展示 ToolCallView）
    this.sendToolCall(webContents, {
      sessionId: ctx.sessionId,
      toolCallId,
      toolName,
      input,
      permission: decision.permission,
    });

    // 3.5 生命周期钩子：pre-tool-use（可阻断执行；错误隔离）
    const blocked = await hookRegistry.trigger(HookEventName.PRE_TOOL_USE, {
      sessionId: ctx.sessionId,
      toolCallId,
      toolName,
      input,
    });
    if (blocked !== null) {
      // 阻断原因来自钩子本身（HookDenial.reason）；未提供时回落通用文案
      const reasonText = blocked.reason !== '' ? `（${blocked.reason}）` : '';
      logger.info({ toolName, toolCallId, reason: blocked.reason }, '钩子阻止工具执行');
      return fail(
        '钩子阻止',
        ErrorCode.TOOL_PERMISSION_DENIED,
        `工具执行被钩子阻止：${toolName}${reasonText}`,
      );
    }

    // 4. 权限闸：deny 直接拒绝 / ask 推审批等用户响应（批准/拒绝/超时/中断/销毁五种出口）。
    //    状态机细节与不变量注释见 resolvePermissionGate；返回非 null 即终止本次执行。
    const gate = await this.resolvePermissionGate({
      decision,
      tool,
      toolName,
      toolCallId,
      input,
      ctx,
      webContents,
    });
    if (gate !== null) {
      return gate;
    }

    // 5. 检查中断信号（审批等待期间用户可能中断了对话）
    if (ctx.abortSignal.aborted) {
      logger.info({ toolName, toolCallId }, '工具执行前检测到中断信号');
      return fail('执行中断', ErrorCode.TOOL_ABORTED, '工具执行已被中断');
    }

    // 6. 执行工具
    try {
      logger.info({ toolName, toolCallId }, '开始执行工具');
      const toolResult: ToolResult = await tool.execute(input, ctx);
      // 生命周期钩子：post-tool-use（执行成功；错误隔离）
      void hookRegistry.trigger(HookEventName.POST_TOOL_USE, {
        sessionId: ctx.sessionId,
        toolCallId,
        toolName,
        input,
        result: toolResult,
      });
      const durationMs = Math.round(performance.now() - startTime);
      logger.info({ toolName, toolCallId, durationMs }, '工具执行成功');
      span?.setAttribute('tool.durationMs', durationMs);
      span?.setAttribute('tool.success', true);

      const result: AgentToolResultPayload = {
        sessionId: ctx.sessionId,
        toolCallId,
        toolName,
        title: toolResult.title,
        // 窗口感知截断：小窗口模型（如 32K 本地 ollama）按比例收紧，
        // 防单次输出占满上下文（详见 toolOutputLimitFor 注释）
        output: clampToolOutput(toolResult.output, ctx.contextWindowSize),
        ...(toolResult.metadata !== undefined ? { metadata: toolResult.metadata } : {}),
      };
      this.sendToolResult(webContents, result);
      return result;
    } catch (error: unknown) {
      // 执行失败：包装为 TOOL_EXECUTION_FAILED
      const durationMs = Math.round(performance.now() - startTime);
      logger.error(
        { toolName, toolCallId, errorCode: ErrorCode.TOOL_EXECUTION_FAILED, durationMs, error },
        '工具执行失败',
      );
      span?.setAttribute('tool.durationMs', durationMs);
      span?.setAttribute('tool.success', false);
      const message = error instanceof Error ? error.message : '工具执行失败';
      return fail('执行失败', ErrorCode.TOOL_EXECUTION_FAILED, message);
    }
  }

  /**
   * 权限闸（2026-09-12 从 execute 提取）：阶段 4（deny / plan 双保险）与
   * 阶段 4.1（用户审批状态机）的独立状态机。2026-09-12 二次拆分：
   * 'ask' 审批分支独立为 resolveAskGate、失败分类独立为 classifyApprovalFailure，
   * 使每个函数的认知复杂度回到门槛内（此前整体 20）。
   *
   * 出口（五种终止 + 一种放行）：
   * - 'deny'：审批模式拒绝（plan 模式只读约束 / 模式分级决策）
   * - plan 模式下的 'ask'：会话级双保险——直接拒绝写操作，不弹审批框，
   *   保证 plan 阶段零副作用（OpenCode 风格 plan/apply 分离的核心约束）
   * - 'ask' + 审批异常：超时 / webContents 销毁 / 用户中断（H4：传入
   *   ctx.abortSignal，用户在等待期间点"停止"时立即 reject）
   * - 'ask' + 用户拒绝：计拒绝统计（A4：auto 模式连续拒绝降级手动确认的数据源）
   * - 'ask' + 用户批准：计允许一次，放行
   * - 'auto'：不进入审批分支，直接放行
   *
   * @returns null = 放行（调用方继续执行工具）；否则返回终止结果（调用方直接返回它）
   */
  private async resolvePermissionGate(args: {
    readonly decision: PermissionDecision;
    readonly tool: Tool;
    readonly toolName: string;
    readonly toolCallId: string;
    readonly input: unknown;
    readonly ctx: ToolContext;
    readonly webContents: WebContents | undefined;
  }): Promise<AgentToolResultPayload | null> {
    const { decision, toolName, toolCallId, ctx, webContents } = args;
    /** 构建 + 推送 + 返回终止结果（本闸各失败出口共用的出口协议） */
    const fail = (title: string, code: string, message: string): AgentToolResultPayload => {
      const result = this.buildErrorResult(
        ctx.sessionId,
        toolCallId,
        toolName,
        title,
        code,
        message,
      );
      this.sendToolResult(webContents, result);
      return result;
    };

    // ── 4. deny（或 plan 模式下的 ask）：直接拒绝 ──
    if (decision.permission === 'deny' || (decision.permission === 'ask' && ctx.mode === 'plan')) {
      logger.info(
        { toolName, toolCallId, sessionId: ctx.sessionId, permission: decision.permission },
        '工具调用被拒绝（只读/模式约束）',
      );
      return fail(
        '权限拒绝',
        ErrorCode.TOOL_PERMISSION_DENIED,
        `工具调用被拒绝：${toolName}（审批模式 ${decision.permission}；plan 模式只读，如需执行请切换到 build 模式）`,
      );
    }

    // ── 4.1 ask：推送审批请求并等待用户响应（审批状态机见 resolveAskGate）──
    if (decision.permission === 'ask') {
      const outcome = await this.resolveAskGate(args);
      if (outcome !== null) {
        return outcome;
      }
    }

    return null;
  }

  /**
   * 审批失败原因分类（resolveAskGate 的 catch 出口）
   *
   * 三类出口：用户中断（abort 信号或 TOOL_ABORTED 错误）→ TOOL_ABORTED；
   * 其余（审批超时 / webContents 销毁 / IPC 异常）→ TOOL_PERMISSION_DENIED。
   *
   * @returns 终止结果应使用的错误码与用户可见消息
   */
  private classifyApprovalFailure(
    error: unknown,
    abortSignal: AbortSignal,
  ): { code: string; message: string } {
    const isAborted =
      abortSignal.aborted || (error instanceof AppError && error.code === ErrorCode.TOOL_ABORTED);
    if (isAborted) {
      return { code: ErrorCode.TOOL_ABORTED, message: '工具执行已被中断' };
    }
    const message = error instanceof Error ? error.message : '审批请求失败';
    return { code: ErrorCode.TOOL_PERMISSION_DENIED, message };
  }

  /**
   * 权限闸 4.1：'ask' 分支——推送审批请求并等待用户响应
   *
   * 出口：
   * - 用户批准 → recordUserAllowance + 返回 null（放行）
   * - 用户拒绝 → recordUserDenial + 终止结果
   * - 审批超时 / webContents 销毁 / 用户中断 → 终止结果（经 classifyApprovalFailure 分类）
   *
   * @returns null = 放行；否则返回终止结果
   */
  private async resolveAskGate(args: {
    readonly decision: PermissionDecision;
    readonly tool: Tool;
    readonly toolName: string;
    readonly toolCallId: string;
    readonly input: unknown;
    readonly ctx: ToolContext;
    readonly webContents: WebContents | undefined;
  }): Promise<AgentToolResultPayload | null> {
    const { decision, tool, toolName, toolCallId, input, ctx, webContents } = args;
    /** 构建 + 推送 + 返回终止结果（本闸各失败出口共用的出口协议） */
    const fail = (title: string, code: string, message: string): AgentToolResultPayload => {
      const result = this.buildErrorResult(
        ctx.sessionId,
        toolCallId,
        toolName,
        title,
        code,
        message,
      );
      this.sendToolResult(webContents, result);
      return result;
    };

    const approvalId = generateApprovalId();
    const approvalPayload = {
      sessionId: ctx.sessionId,
      approvalId,
      toolCallId,
      toolName,
      input,
      description: decision.description,
    };

    let approved: boolean;
    try {
      // 传入 ctx.abortSignal：用户在审批等待期间点"停止"时立即 reject（H4 修复）
      approved = await this.permissionService.requestApproval(
        approvalPayload,
        tool,
        input,
        webContents,
        ctx.abortSignal,
      );
    } catch (error: unknown) {
      // 审批超时 / webContents 销毁 / 用户中断
      const { code, message } = this.classifyApprovalFailure(error, ctx.abortSignal);
      logger.warn({ toolName, toolCallId, approvalId, errorCode: code, error }, '审批请求失败');
      return fail('审批失败', code, message);
    }

    if (!approved) {
      // 用户拒绝
      logger.info({ toolName, toolCallId, approvalId }, '用户拒绝工具调用');
      // A4 接线：拒绝计入 PermissionService 拒绝统计（auto 模式连续拒绝
      // 降级手动确认的数据源——此前记录方法存在但无人调用，机制死亡）
      this.permissionService.recordUserDenial();
      return fail('用户拒绝', ErrorCode.TOOL_PERMISSION_DENIED, `用户拒绝执行：${toolName}`);
    }

    logger.info({ toolName, toolCallId, approvalId }, '用户批准工具调用');
    // A4 接线：批准计允许一次，抵消此前累计的拒绝计数
    this.permissionService.recordUserAllowance();
    return null;
  }

  /**
   * 统一的失败出口（构建错误结果 + 推送渲染层 + 返回）
   *
   * 本类有 6 个错误出口（工具不存在 / 权限决策异常 / 钩子阻止 / 权限闸各出口 /
   * 中断 / 执行失败），逐个内联展开会把 execute 的认知复杂度推过门槛
   * （实测 20 > 15）。收敛为一处后各出口只表达「什么错、什么码、什么文案」。
   *
   * 入参用对象而非位置参数：7 个位置参数超出规范门槛（≤4），且调用点
   * 全是同型 string 相邻，位置参数极易传错位（title/code/message 互换
   * 不会被类型系统拦住）。
   */
  private failWith(args: {
    readonly sessionId: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly webContents: WebContents | undefined;
    readonly title: string;
    readonly code: string;
    readonly message: string;
  }): AgentToolResultPayload {
    const { sessionId, toolCallId, toolName, webContents, title, code, message } = args;
    const result = this.buildErrorResult(sessionId, toolCallId, toolName, title, code, message);
    this.sendToolResult(webContents, result);
    return result;
  }

  /**
   * 构建错误结果
   *
   * 内部辅助方法，统一构建带 error 字段的 AgentToolResultPayload。
   * title 用简短描述（如 "执行失败" / "用户拒绝"），便于 UI 展示。
   */
  private buildErrorResult(
    sessionId: string,
    toolCallId: string,
    toolName: string,
    title: string,
    code: string,
    message: string,
  ): AgentToolResultPayload {
    return {
      sessionId,
      toolCallId,
      toolName,
      title,
      // 失败时 output 为 null（与成功时的 unknown 区分）
      output: null,
      error: { code, message },
    };
  }

  /**
   * 推送 AGENT_TOOL_CALL 事件
   *
   * 渲染层据此展示 ToolCallView（工具调用 UI），
   * 含权限级别决定是否需要等待审批。
   */
  private sendToolCall(webContents: WebContents | undefined, payload: AgentToolCallPayload): void {
    if (webContents !== undefined && !webContents.isDestroyed()) {
      // R2：统一出口 emitEvent（dev 契约校验）
      emitEvent(webContents, IPC_DEFINITIONS.agent.subscribeToolCall, payload);
    }
  }

  /**
   * 推送 AGENT_TOOL_RESULT 事件
   *
   * 渲染层据此更新 ToolCallView 状态（成功/失败），
   * error 字段存在表示失败，output 字段为工具输出。
   */
  private sendToolResult(
    webContents: WebContents | undefined,
    payload: AgentToolResultPayload,
  ): void {
    if (webContents !== undefined && !webContents.isDestroyed()) {
      // R2：统一出口 emitEvent（dev 契约校验）
      emitEvent(webContents, IPC_DEFINITIONS.agent.subscribeToolResult, payload);
    }
  }
}
