// src/main/infra/ai/tool-executor.ts
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
import type { ToolContext, ToolResult } from './tool';
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
 * 工具输出统一字节闸门（2026-09-08 性能/成本修复）
 *
 * 背景：各工具的截断策略不一致——run_command 100KB、web_fetch 4000 字符，
 * 而 read_file 只透传 fileService 结果（其 2MB 上限是「超过就报错」而非截断），
 * 省略 limit 时读全文 → 2MB ≈ 50 万 token 灌入上下文，足以报废一个回合
 * （既烧钱又挤掉有效上下文）。
 *
 * 位置选择：放在 ToolExecutor 出口而非各工具内——单点保证「任何工具的输出
 * 都不可能无界进上下文」，新增工具无需重复实现。
 *
 * 阈值 200KB（约 5 万 token）：明显高于正常工具输出（读文件按需分段、
 * grep 有 maxResults），又远低于能报废回合的量级。截断保留头部并标注
 * 后续字节数，模型可据此改用 offset/limit 分段读取。
 */
const MAX_TOOL_OUTPUT_BYTES = 200 * 1024;

/**
 * 按字节截断工具输出（超限时保留头部 + 标注）
 *
 * 用 Buffer 按字节切分再转回字符串，避免按字符数截断导致多字节字符被劈开。
 */
export function clampToolOutput(output: string): string {
  const bytes = Buffer.byteLength(output, 'utf8');
  if (bytes <= MAX_TOOL_OUTPUT_BYTES) {
    return output;
  }
  const head = Buffer.from(output, 'utf8').subarray(0, MAX_TOOL_OUTPUT_BYTES).toString('utf8');
  // 多字节字符在切点处可能产生替换字符，去掉末尾可能不完整的字符
  const safeHead = head.endsWith('\uFFFD') ? head.slice(0, -1) : head;
  return `${safeHead}\n\n…（输出超过 ${MAX_TOOL_OUTPUT_BYTES / 1024}KB 已截断，共 ${(bytes / 1024).toFixed(0)}KB；请缩小范围或分段读取）`;
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
    // OpenTelemetry span：工具执行链路（含权限决策 + 审批等待 + 实际执行）
    return withSpan(
      'tool.execute',
      {
        'tool.name': toolName,
        'tool.callId': toolCallId,
        'session.id': ctx.sessionId,
      },
      async (span) => {
        // 1. 查找工具
        const tool = this.registry.get(toolName);
        if (tool === undefined) {
          logger.warn({ toolName, toolCallId, errorCode: ErrorCode.TOOL_NOT_FOUND }, '工具不存在');
          const result = this.buildErrorResult(
            ctx.sessionId,
            toolCallId,
            toolName,
            '工具不存在',
            ErrorCode.TOOL_NOT_FOUND,
            `工具不存在：${toolName}`,
          );
          this.sendToolResult(webContents, result);
          return result;
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
          const result = this.buildErrorResult(
            ctx.sessionId,
            toolCallId,
            toolName,
            '权限决策失败',
            ErrorCode.TOOL_PERMISSION_DENIED,
            `权限决策失败，已拒绝执行：${toolName}`,
          );
          this.sendToolResult(webContents, result);
          return result;
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
        const preAllowed = await hookRegistry.trigger(HookEventName.PRE_TOOL_USE, {
          sessionId: ctx.sessionId,
          toolCallId,
          toolName,
          input,
        });
        if (!preAllowed) {
          logger.info({ toolName, toolCallId }, '钩子阻止工具执行');
          const result = this.buildErrorResult(
            ctx.sessionId,
            toolCallId,
            toolName,
            '钩子阻止',
            ErrorCode.TOOL_PERMISSION_DENIED,
            `工具执行被钩子阻止：${toolName}`,
          );
          this.sendToolResult(webContents, result);
          return result;
        }

        // 4. 权限决策处理
        //    - 'deny'：审批模式拒绝（plan 模式只读约束 / 模式分级决策）
        //    - 'ask'：请求用户审批（plan 模式会话级双保险：直接拒绝写操作，不弹审批框——
        //      保证 plan 阶段零副作用，这是 OpenCode 风格 plan/apply 分离的核心约束）
        if (
          decision.permission === 'deny' ||
          (decision.permission === 'ask' && ctx.mode === 'plan')
        ) {
          logger.info(
            { toolName, toolCallId, sessionId: ctx.sessionId, permission: decision.permission },
            '工具调用被拒绝（只读/模式约束）',
          );
          const result = this.buildErrorResult(
            ctx.sessionId,
            toolCallId,
            toolName,
            '权限拒绝',
            ErrorCode.TOOL_PERMISSION_DENIED,
            `工具调用被拒绝：${toolName}（审批模式 ${decision.permission}；plan 模式只读，如需执行请切换到 build 模式）`,
          );
          this.sendToolResult(webContents, result);
          return result;
        }

        // 4.1 需审批的工具：推送审批请求并等待用户响应
        if (decision.permission === 'ask') {
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
            const isAborted =
              ctx.abortSignal.aborted ||
              (error instanceof AppError && error.code === ErrorCode.TOOL_ABORTED);
            const errorCode = isAborted ? ErrorCode.TOOL_ABORTED : ErrorCode.TOOL_PERMISSION_DENIED;
            const errorMessage = isAborted
              ? '工具执行已被中断'
              : error instanceof Error
                ? error.message
                : '审批请求失败';
            logger.warn({ toolName, toolCallId, approvalId, errorCode, error }, '审批请求失败');
            const result = this.buildErrorResult(
              ctx.sessionId,
              toolCallId,
              toolName,
              '审批失败',
              errorCode,
              errorMessage,
            );
            this.sendToolResult(webContents, result);
            return result;
          }

          if (!approved) {
            // 用户拒绝
            logger.info({ toolName, toolCallId, approvalId }, '用户拒绝工具调用');
            // A4 接线：拒绝计入 PermissionService 拒绝统计（auto 模式连续拒绝
            // 降级手动确认的数据源——此前记录方法存在但无人调用，机制死亡）
            this.permissionService.recordUserDenial();
            const result = this.buildErrorResult(
              ctx.sessionId,
              toolCallId,
              toolName,
              '用户拒绝',
              ErrorCode.TOOL_PERMISSION_DENIED,
              `用户拒绝执行：${toolName}`,
            );
            this.sendToolResult(webContents, result);
            return result;
          }

          logger.info({ toolName, toolCallId, approvalId }, '用户批准工具调用');
          // A4 接线：批准计允许一次，抵消此前累计的拒绝计数
          this.permissionService.recordUserAllowance();
        }

        // 5. 检查中断信号（审批等待期间用户可能中断了对话）
        if (ctx.abortSignal.aborted) {
          logger.info({ toolName, toolCallId }, '工具执行前检测到中断信号');
          const result = this.buildErrorResult(
            ctx.sessionId,
            toolCallId,
            toolName,
            '执行中断',
            ErrorCode.TOOL_ABORTED,
            '工具执行已被中断',
          );
          this.sendToolResult(webContents, result);
          return result;
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
            output: clampToolOutput(toolResult.output),
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
          const result = this.buildErrorResult(
            ctx.sessionId,
            toolCallId,
            toolName,
            '执行失败',
            ErrorCode.TOOL_EXECUTION_FAILED,
            message,
          );
          this.sendToolResult(webContents, result);
          return result;
        }
      },
    );
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
