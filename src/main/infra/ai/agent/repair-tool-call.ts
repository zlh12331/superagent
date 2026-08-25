// src/main/infra/ai/agent/repair-tool-call.ts
// 工具调用自动修复（SDK v7 repairToolCall 钩子实现）
// ──────────────────────────────────────────────────────────────
// 职责：
// - LLM 生成的工具入参 zod 校验失败（InvalidToolInputError）时，用一次轻量
//   LLM 调用（llmClient.generateText side-query 链路）让模型根据错误重生成
//   toolCall JSON，避免该轮工具调用"静默失败"
// - 关键背景：parse 阶段校验失败不会进入 ToolExecutor（execute 不会执行），
//   LLM 也收不到 tool-result 反馈——此前该工具调用直接丢弃。repairToolCall
//   在 parse 失败处兜底修复，修复成功则 SDK 重新解析后正常执行
//
// 修复策略（保守、成本可控）：
// - 只处理 InvalidToolInputError（工具存在但参数不合法）；NoSuchToolError
//   （工具名不存在）返回 null 走 SDK 原逻辑——工具不存在让 LLM 下一轮自行
//   换工具，不值得为一次误调用浪费一次 LLM 生成
// - 修复调用 maxAttempts=1：修复不重试（重试会放大成本，失败即放弃）
// - 任何失败/超时/用户中断 → 返回 null（SDK 流出 invalid tool-call part，
//   与现状等价，绝不阻塞主流程）
// ──────────────────────────────────────────────────────────────

import { InvalidToolInputError, type NoSuchToolError } from 'ai';
import { z } from 'zod';

import { logger } from '../../../utils/logger';
import type { LlmClient } from '../llm-client/llm-client';

/** 修复调用最多尝试次数（修复失败直接放弃，成本控制） */
const REPAIR_MAX_ATTEMPTS = 1;

/**
 * 最小 toolCall 结构（对齐 SDK LanguageModelV4ToolCall 的消费面）
 *
 * SDK 未导出 LanguageModelV4ToolCall（@ai-sdk/provider 内部类型），
 * 此处声明最小结构：SDK 传入的 toolCall 满足本结构（有 toolCallId/toolName/input），
 * 修复后返回的对象也满足 SDK 重新解析所需字段。
 */
interface ToolCallLike {
  readonly type: 'tool-call';
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: string;
}

/** 修复输出结构：模型重生成的 toolCall（name + arguments） */
const RepairedToolCallSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
});

type RepairedToolCall = z.infer<typeof RepairedToolCallSchema>;

/** createRepairToolCall 依赖 */
export interface CreateRepairToolCallOptions {
  /** LLM 客户端（side-query 链路：模型级路由 + per-model 缓存 + 重试/超时/降级） */
  readonly llmClient: LlmClient;
  /** 修复用模型 id（省略 = 默认模型；与主回合同模型保证 schema 认知一致） */
  readonly modelId?: string;
  /** 中断信号（用户停止/模型超时 → 放弃修复） */
  readonly signal?: AbortSignal;
}

/** 修复用系统提示词（指示模型仅输出修正后的 toolCall JSON） */
const REPAIR_SYSTEM_PROMPT =
  'You are a tool call repairer. A previous tool call failed argument validation. ' +
  'Fix the arguments so they match the tool input schema. ' +
  'Respond with ONLY the corrected JSON object: ' +
  '{"name": "<tool name>", "arguments": {<corrected arguments>}}.';

/** 构造修复提示词（含原始调用与校验错误） */
function buildRepairPrompt(toolCall: ToolCallLike, message: string): string {
  return [
    `Tool name: ${toolCall.toolName}`,
    `Original arguments JSON: ${toolCall.input}`,
    `Validation error: ${message}`,
    '',
    'Corrected tool call JSON:',
  ].join('\n');
}

/**
 * 从模型输出提取修复后的 toolCall JSON
 *
 * 容错：剥离 ```json 代码块包裹；解析后经 schema 校验（name + arguments 结构）。
 * 解析失败返回 null（放弃修复）。
 */
export function extractRepairedToolCallJson(text: string): RepairedToolCall | null {
  const cleaned = text.trim();
  // 剥离 ```json ... ``` / ``` ... ``` 代码块包裹（模型可能包代码块输出）
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(cleaned);
  const candidate = (fenced?.[1] ?? cleaned).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  const result = RepairedToolCallSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * 创建 repairToolCall 钩子
 *
 * 每个 agent 回合构造一个（闭包捕获当前会话的 modelId / signal）。
 *
 * @param options 依赖与运行上下文
 * @returns SDK repairToolCall 函数（修复失败/不适用时返回 null）
 */
export function createRepairToolCall(
  options: CreateRepairToolCallOptions,
): (params: {
  toolCall: ToolCallLike;
  error: NoSuchToolError | InvalidToolInputError;
}) => Promise<ToolCallLike | null> {
  return async ({ toolCall, error }) => {
    // 只修复入参非法（工具存在但参数校验失败）；工具不存在走 SDK 原逻辑
    if (!(error instanceof InvalidToolInputError)) {
      return null;
    }
    try {
      const result = await options.llmClient.generateText({
        ...(options.modelId !== undefined ? { model: options.modelId } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        maxAttempts: REPAIR_MAX_ATTEMPTS,
        system: REPAIR_SYSTEM_PROMPT,
        prompt: buildRepairPrompt(toolCall, error.message),
      });
      const repaired = extractRepairedToolCallJson(result.text);
      if (repaired === null) {
        logger.warn({ toolName: toolCall.toolName }, '工具调用修复：输出解析失败，放弃修复');
        return null;
      }
      logger.info({ toolName: toolCall.toolName }, '工具调用入参已自动修复');
      return {
        ...toolCall,
        toolName: repaired.name,
        input: JSON.stringify(repaired.arguments),
      };
    } catch (error: unknown) {
      // 修复调用失败/中断：不阻塞主流程，走 SDK 原逻辑（invalid part 流出）
      logger.warn(
        {
          toolName: toolCall.toolName,
          error: error instanceof Error ? error.message : String(error),
        },
        '工具调用修复失败，放弃修复',
      );
      return null;
    }
  };
}
