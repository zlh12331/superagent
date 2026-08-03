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
// - token 预算策略（estimateTokenCount / compressByTokenBudget）：
//   用 gpt-tokenizer 精确统计 token，按预算从后往前保留消息，
//   适合按 token 计费的 LLM 供应商做上下文预算控制
// ──────────────────────────────────────────────────────────────

import type { ModelMessage } from 'ai';
import { encode } from 'gpt-tokenizer';

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

/**
 * 估算文本的 token 数（gpt-tokenizer 精确计数，cl100k_base 词表）
 *
 * 用于 token 预算压缩与 UI 展示上下文消耗。
 */
export function estimateTokenCount(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return encode(text).length;
}

/** 消息 → 文本（用于 token 估算） */
function messageToText(msg: ModelMessage): string {
  if (typeof msg.content === 'string') {
    return msg.content;
  }
  // 多段 content（如 toolCalls / 结构化 parts）：拼接全部文本段
  return Array.isArray(msg.content)
    ? msg.content.map((part) => ('text' in part ? String(part.text) : '')).join('\n')
    : String(msg.content ?? '');
}

/**
 * 按 token 预算压缩消息（gpt-tokenizer 精确计数）
 *
 * 策略：
 * - system 消息无条件保留（系统提示词不能丢）
 * - 其余消息按顺序累积 token，直到超出预算：
 *   · 超出前全部保留
 *   · 超出后只保留最近一圈（从后往前补，保证上下文连续性）
 * - 返回压缩后的消息（不改变原始数组）
 *
 * @param messages 原始消息列表
 * @param maxTokens token 预算（默认 8000，约等于 32K 上下文窗口的 1/4 安全线）
 * @returns 压缩后的消息列表
 */
export function compressByTokenBudget(messages: ModelMessage[], maxTokens = 8000): ModelMessage[] {
  if (maxTokens <= 0) {
    return [];
  }

  // system 无条件保留
  const systemMessages = messages.filter((msg) => msg.role === 'system');
  const others = messages.filter((msg) => msg.role !== 'system');

  // 从后往前累积 token（保留最新上下文），前缀超出预算的丢弃
  const kept: ModelMessage[] = [];
  let used = 0;
  for (let i = others.length - 1; i >= 0; i -= 1) {
    const msg = others[i];
    if (msg === undefined) {
      continue;
    }
    const tokens = estimateTokenCount(messageToText(msg));
    if (used + tokens > maxTokens) {
      break;
    }
    kept.unshift(msg);
    used += tokens;
  }

  // 倒序后 kept 为空说明单条消息就超预算：至少保留最后一条，避免空上下文
  if (kept.length === 0 && others.length > 0) {
    const last = others[others.length - 1];
    if (last !== undefined) {
      kept.push(last);
    }
  }

  return [...systemMessages, ...kept];
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
