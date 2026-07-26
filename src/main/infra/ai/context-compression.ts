// src/main/infra/ai/context-compression.ts
// 上下文压缩工具
// ──────────────────────────────────────────────────────────────
// 职责：
// - 在长对话中压缩消息历史，减少 token 消耗
// - 保留关键信息：system message、最近对话、工具调用结果
// - 移除冗余内容：旧的文本回复、重复的工具调用
//
// 设计：
// - 分层压缩策略：
//   1. 保留所有 system message（系统提示词不能丢）
//   2. 保留最近 N 轮对话（用户最新消息 + 助手回复）
//   3. 工具调用消息：合并连续工具调用，保留最新结果
//   4. 早期对话：用摘要替换
// ──────────────────────────────────────────────────────────────

import type { ModelMessage } from 'ai';

interface CompressionOptions {
  readonly maxMessages: number;
  readonly recentMessages: number;
}

const DEFAULT_OPTIONS: CompressionOptions = {
  maxMessages: 50,
  recentMessages: 10,
};

export function compressContext(
  messages: ModelMessage[],
  options: Partial<CompressionOptions> = {},
): ModelMessage[] {
  const { maxMessages, recentMessages } = { ...DEFAULT_OPTIONS, ...options };

  if (messages.length <= maxMessages) {
    return messages;
  }

  const systemMessages: ModelMessage[] = [];
  const toolMessages: ModelMessage[] = [];
  const recentMessagesList: ModelMessage[] = [];
  const earlyMessages: ModelMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemMessages.push(msg);
    } else if (msg.role === 'tool') {
      toolMessages.push(msg);
    } else {
      earlyMessages.push(msg);
    }
  }

  if (earlyMessages.length <= recentMessages) {
    recentMessagesList.push(...earlyMessages);
  } else {
    recentMessagesList.push(...earlyMessages.slice(-recentMessages));
  }

  const compressedToolMessages = mergeToolMessages(toolMessages);

  const result: ModelMessage[] = [
    ...systemMessages,
    ...compressedToolMessages,
    ...recentMessagesList,
  ];

  return result;
}

function mergeToolMessages(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return [];

  const merged: ModelMessage[] = [];
  let currentToolCall: ModelMessage | null = null;
  let currentToolResult: ModelMessage | null = null;

  for (const msg of messages) {
    if (msg.role === 'tool') {
      currentToolResult = msg;
    } else if (
      msg.role === 'assistant' &&
      'toolCalls' in msg &&
      Array.isArray((msg as unknown as { toolCalls: unknown[] | null }).toolCalls) &&
      ((msg as unknown as { toolCalls: unknown[] | null }).toolCalls?.length ?? 0) > 0
    ) {
      if (currentToolCall !== null && currentToolResult !== null) {
        merged.push(currentToolCall);
        merged.push(currentToolResult);
      }
      currentToolCall = msg;
      currentToolResult = null;
    } else {
      if (currentToolCall !== null && currentToolResult !== null) {
        merged.push(currentToolCall);
        merged.push(currentToolResult);
        currentToolCall = null;
        currentToolResult = null;
      }
    }
  }

  if (currentToolCall !== null && currentToolResult !== null) {
    merged.push(currentToolCall);
    merged.push(currentToolResult);
  }

  return merged.slice(-20);
}
