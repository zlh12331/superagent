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
// - 压缩服务化（getCompactionBudget / getCompactionDecision）：
//   对标 qwen chatCompressionService 阈值体系：压缩预算按模型窗口比例计算
//   （75% 窗口 − 输出预留），warn 提前缓冲提醒，避免一次性硬压缩
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
    } else if (msg.role === 'tool' || hasToolCalls(msg)) {
      // 真实缺陷修复：带 toolCalls 的 assistant 必须与 tool 结果同列表配对，
      // 否则 mergeToolMessages 收不到调用方 → 工具上下文在压缩时全部丢失
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

/** 判断消息是否携带工具调用（assistant 带 toolCalls 数组且非空） */
function hasToolCalls(msg: ModelMessage): boolean {
  return (
    msg.role === 'assistant' &&
    'toolCalls' in msg &&
    Array.isArray((msg as unknown as { toolCalls: unknown[] | null }).toolCalls) &&
    ((msg as unknown as { toolCalls: unknown[] | null }).toolCalls?.length ?? 0) > 0
  );
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
 * @param maxTokens token 预算（默认 8000；建议用 getCompactionBudget 按窗口计算）
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

/**
 * 合并连续工具调用消息：保留每对（调用 + 结果）的最新一条，最多 20 条
 */
function mergeToolMessages(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return [];

  const merged: ModelMessage[] = [];
  let currentToolCall: ModelMessage | null = null;
  let currentToolResult: ModelMessage | null = null;

  for (const msg of messages) {
    if (msg.role === 'tool') {
      currentToolResult = msg;
    } else if (hasToolCalls(msg)) {
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

// ── 压缩服务化（对标 qwen chatCompressionService 阈值体系）──────────

/** 压缩触发比例：上下文达到窗口 75% 时触发压缩（对标 qwen auto-compaction threshold） */
export const COMPACTION_RATIO = 0.75;

/** 压缩输出预留：压缩后仍需窗口空间生成摘要/继续输出（对标 qwen SUMMARY_RESERVE 20K） */
export const COMPACTION_RESERVE_TOKENS = 20_000;

/** 压缩预算下限（小窗口保护，避免预算算成负数） */
export const MIN_COMPACTION_BUDGET = 8_000;

/**
 * 窗口感知的压缩预算：round(0.75 × window) − 输出预留
 *
 * 预留随窗口缩水（min(20K, 5% × window)），小窗口不会预留过大。
 *
 * @param contextWindowSize 模型上下文窗口（token 数）
 * @returns 压缩目标预算（token 数，至少 MIN_COMPACTION_BUDGET）
 */
export function getCompactionBudget(contextWindowSize: number): number {
  const reserve = Math.min(COMPACTION_RESERVE_TOKENS, Math.round(0.05 * contextWindowSize));
  const budget = Math.round(contextWindowSize * COMPACTION_RATIO) - reserve;
  return Math.max(budget, MIN_COMPACTION_BUDGET);
}

/**
 * 估算消息列表的总 token 数（gpt-tokenizer 精确计数）
 */
export function estimateMessagesTokens(messages: ModelMessage[]): number {
  return messages.reduce((sum, msg) => sum + estimateTokenCount(messageToText(msg)), 0);
}

/** 上下文占用等级：ok（安全）/ warn（接近压缩线）/ compact（应压缩） */
export type CompactionLevel = 'ok' | 'warn' | 'compact';

/**
 * 压缩触发判定（对标 qwen 的 auto/warn 双阈值）
 *
 * - compact 线 = 压缩预算（窗口 75% − 预留）
 * - warn 线 = compact 线 − 5% 窗口缓冲（提前几轮提醒）
 *
 * @param contextTokens 当前上下文 token 数（estimateMessagesTokens 的结果）
 * @param contextWindowSize 模型上下文窗口（token 数）
 */
export function getCompactionDecision(
  contextTokens: number,
  contextWindowSize: number,
): CompactionLevel {
  const compactAt = getCompactionBudget(contextWindowSize);
  const warnBuffer = Math.round(0.05 * contextWindowSize);
  if (contextTokens >= compactAt) {
    return 'compact';
  }
  if (contextTokens >= compactAt - warnBuffer) {
    return 'warn';
  }
  return 'ok';
}

// ── 回合级 token 预算调度（对齐 qwen TokenBudget 回合语义）──────────

/** 回合级 token 预算等级：ok / warn（接近压缩线）/ compact（应压缩）/ over-limit（拒止） */
export type TokenBudgetLevel = 'ok' | 'warn' | 'compact' | 'over-limit';

/**
 * 回合级 token 预算判定结果
 */
export interface TokenBudgetDecision {
  readonly level: TokenBudgetLevel;
  /** 当前上下文 token 数（estimateMessagesTokens 的结果） */
  readonly contextTokens: number;
  /** 模型上下文窗口（token 数） */
  readonly contextWindowSize: number;
  /** 压缩线（窗口 75% − 输出预留） */
  readonly compactAt: number;
  /** 硬上限（窗口 − 输出预留；超过即拒止，防 400） */
  readonly hardLimit: number;
}

/**
 * 回合开始时的 token 预算调度（agent/chat 主流程挂载点）
 *
 * 对齐 qwen TokenBudget 调度语义，三档 + 拒止：
 * - ok：上下文安全，直接执行
 * - warn：接近压缩线（提前几轮提醒，日志/遥测）
 * - compact：达到压缩线（压缩消息历史后执行）
 * - over-limit：超出硬上限（拒绝调用，避免供应商 400 错误）
 *
 * @param contextTokens 当前上下文 token 数
 * @param contextWindowSize 模型上下文窗口（token 数）
 */
export function getTokenBudgetDecision(
  contextTokens: number,
  contextWindowSize: number,
): TokenBudgetDecision {
  const compactAt = getCompactionBudget(contextWindowSize);
  // 硬上限：窗口 − 输出预留（与 maxOutputTokens 钳制同源，保证 prompt + output ≤ window）
  const reserve = Math.min(COMPACTION_RESERVE_TOKENS, Math.round(0.05 * contextWindowSize));
  const hardLimit = contextWindowSize - reserve;

  let level: TokenBudgetLevel;
  if (contextTokens > hardLimit) {
    level = 'over-limit';
  } else {
    level = getCompactionDecision(contextTokens, contextWindowSize);
  }

  return { level, contextTokens, contextWindowSize, compactAt, hardLimit };
}
