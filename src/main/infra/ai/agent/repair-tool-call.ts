// repair-tool-call.ts：坏工具调用修复——参数校验失败时请 LLM 修复一次（仅一轮，防修复循环）
import { InvalidToolInputError, type NoSuchToolError } from 'ai';
import { z } from 'zod';

import { logger } from '../../../utils/logger';
import type { LlmClient } from '../llm-client/llm-client';

// 只修一轮：修复本身也可能失败，再循环没有意义
const REPAIR_MAX_ATTEMPTS = 1;

interface ToolCallLike {
  readonly type: 'tool-call';
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: string;
}

const RepairedToolCallSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
});

type RepairedToolCall = z.infer<typeof RepairedToolCallSchema>;

export interface CreateRepairToolCallOptions {
  readonly llmClient: LlmClient;
  readonly modelId?: string;
  readonly signal?: AbortSignal;
}

const REPAIR_SYSTEM_PROMPT =
  'You are a tool call repairer. A previous tool call failed argument validation. ' +
  'Fix the arguments so they match the tool input schema. ' +
  'Respond with ONLY the corrected JSON object: ' +
  '{"name": "<tool name>", "arguments": {<corrected arguments>}}. ' +
  'The "name" field MUST be exactly the same tool name as the original call — never change it.';

function buildRepairPrompt(toolCall: ToolCallLike, message: string): string {
  return [
    `Tool name: ${toolCall.toolName}`,
    `Original arguments JSON: ${toolCall.input}`,
    `Validation error: ${message}`,
    '',
    'Corrected tool call JSON:',
  ].join('\n');
}

export function extractRepairedToolCallJson(
  text: string,
  expectedName?: string,
): RepairedToolCall | null {
  const cleaned = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(cleaned);
  const candidate = (fenced?.[1] ?? cleaned).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  const schema =
    expectedName === undefined
      ? RepairedToolCallSchema
      : RepairedToolCallSchema.extend({ name: z.literal(expectedName) });
  const result = schema.safeParse(parsed);
  return result.success ? result.data : null;
}

export function createRepairToolCall(
  options: CreateRepairToolCallOptions,
): (params: {
  toolCall: ToolCallLike;
  error: NoSuchToolError | InvalidToolInputError;
}) => Promise<ToolCallLike | null> {
  return async ({ toolCall, error }) => {
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
      const repaired = extractRepairedToolCallJson(result.text, toolCall.toolName);
      if (repaired === null) {
        logger.warn({ toolName: toolCall.toolName }, '工具调用修复：输出解析失败，放弃修复');
        return null;
      }
      logger.info({ toolName: toolCall.toolName }, '工具调用入参已自动修复');
      return {
        ...toolCall,
        toolName: toolCall.toolName,
        input: JSON.stringify(repaired.arguments),
      };
    } catch (error: unknown) {
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
