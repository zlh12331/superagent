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

export interface IToolExecutor {
  execute(
    toolName: string,
    toolCallId: string,
    input: unknown,
    ctx: ToolContext,
    webContents?: WebContents,
  ): Promise<AgentToolResultPayload>;
}

const MAX_TOOL_OUTPUT_BYTES = 200 * 1024;
const MIN_TOOL_OUTPUT_BYTES = 8 * 1024;
const OUTPUT_WINDOW_RATIO = 0.25;
const BYTES_PER_TOKEN = 3;

export function toolOutputLimitFor(contextWindowSize: number | undefined): number {
  if (contextWindowSize === undefined || contextWindowSize <= 0) {
    return MAX_TOOL_OUTPUT_BYTES;
  }
  const windowBudget = contextWindowSize * BYTES_PER_TOKEN * OUTPUT_WINDOW_RATIO;
  return Math.max(MIN_TOOL_OUTPUT_BYTES, Math.min(MAX_TOOL_OUTPUT_BYTES, Math.floor(windowBudget)));
}

export function clampToolOutput(output: string, contextWindowSize?: number): string {
  const limit = toolOutputLimitFor(contextWindowSize);
  const bytes = Buffer.byteLength(output, 'utf8');
  if (bytes <= limit) {
    return output;
  }
  const head = Buffer.from(output, 'utf8').subarray(0, limit).toString('utf8');
  const safeHead = head.endsWith('\uFFFD') ? head.slice(0, -1) : head;
  return `${safeHead}\n\n…（输出超过 ${Math.round(limit / 1024)}KB 已截断，共 ${(bytes / 1024).toFixed(0)}KB；请缩小范围或分段读取）`;
}

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

export class ToolExecutor implements IToolExecutor {
  constructor(
    private readonly registry: IToolRegistry,
    private readonly permissionService: IPermissionService,
  ) {}

  async execute(
    toolName: string,
    toolCallId: string,
    input: unknown,
    ctx: ToolContext,
    webContents?: WebContents,
  ): Promise<AgentToolResultPayload> {
    const startTime = performance.now();
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

    const tool = this.registry.get(toolName);
    if (tool === undefined) {
      logger.warn({ toolName, toolCallId, errorCode: ErrorCode.TOOL_NOT_FOUND }, '工具不存在');
      return fail('工具不存在', ErrorCode.TOOL_NOT_FOUND, `工具不存在：${toolName}`);
    }

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

    this.sendToolCall(webContents, {
      sessionId: ctx.sessionId,
      toolCallId,
      toolName,
      input,
      permission: decision.permission,
    });

    const blocked = await hookRegistry.trigger(HookEventName.PRE_TOOL_USE, {
      sessionId: ctx.sessionId,
      toolCallId,
      toolName,
      input,
    });
    if (blocked !== null) {
      const reasonText = blocked.reason !== '' ? `（${blocked.reason}）` : '';
      logger.info({ toolName, toolCallId, reason: blocked.reason }, '钩子阻止工具执行');
      return fail(
        '钩子阻止',
        ErrorCode.TOOL_PERMISSION_DENIED,
        `工具执行被钩子阻止：${toolName}${reasonText}`,
      );
    }

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

    if (ctx.abortSignal.aborted) {
      logger.info({ toolName, toolCallId }, '工具执行前检测到中断信号');
      return fail('执行中断', ErrorCode.TOOL_ABORTED, '工具执行已被中断');
    }

    try {
      logger.info({ toolName, toolCallId }, '开始执行工具');
      const toolResult: ToolResult = await tool.execute(input, ctx);
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
        output: clampToolOutput(toolResult.output, ctx.contextWindowSize),
        ...(toolResult.metadata !== undefined ? { metadata: toolResult.metadata } : {}),
      };
      this.sendToolResult(webContents, result);
      return result;
    } catch (error: unknown) {
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

    if (decision.permission === 'ask') {
      const outcome = await this.resolveAskGate(args);
      if (outcome !== null) {
        return outcome;
      }
    }

    return null;
  }

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
      approved = await this.permissionService.requestApproval(
        approvalPayload,
        tool,
        input,
        webContents,
        ctx.abortSignal,
      );
    } catch (error: unknown) {
      const { code, message } = this.classifyApprovalFailure(error, ctx.abortSignal);
      logger.warn({ toolName, toolCallId, approvalId, errorCode: code, error }, '审批请求失败');
      return fail('审批失败', code, message);
    }

    if (!approved) {
      logger.info({ toolName, toolCallId, approvalId }, '用户拒绝工具调用');
      this.permissionService.recordUserDenial();
      return fail('用户拒绝', ErrorCode.TOOL_PERMISSION_DENIED, `用户拒绝执行：${toolName}`);
    }

    logger.info({ toolName, toolCallId, approvalId }, '用户批准工具调用');
    this.permissionService.recordUserAllowance();
    return null;
  }

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
      output: null,
      error: { code, message },
    };
  }

  private sendToolCall(webContents: WebContents | undefined, payload: AgentToolCallPayload): void {
    if (webContents !== undefined && !webContents.isDestroyed()) {
      emitEvent(webContents, IPC_DEFINITIONS.agent.subscribeToolCall, payload);
    }
  }

  private sendToolResult(
    webContents: WebContents | undefined,
    payload: AgentToolResultPayload,
  ): void {
    if (webContents !== undefined && !webContents.isDestroyed()) {
      emitEvent(webContents, IPC_DEFINITIONS.agent.subscribeToolResult, payload);
    }
  }
}
