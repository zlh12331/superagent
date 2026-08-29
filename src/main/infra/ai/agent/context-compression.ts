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
//   适合按 token 计费的 LLM 供应商做上下文预算控制。
//   估算口径必须覆盖 provider 真实可见的文本（文本段 / 推理块 /
//   工具入参 / 工具结果 / 多模态 part）——只数 text 段会把工具结果
//   这类最大消耗估成 0，预算判定与 over-limit 拒止线双双失真
// - 两档压缩（compressByTokenBudget）：
//   1. 先裁剪低价值 token（旧推理块 + 窗口外的工具调用/结果）：SDK
//      pruneMessages 按 toolCallId 成对删除，不会留下 provider 拒绝的孤儿
//      tool_use，且能在保住对话轮次的前提下回收预算
//   2. 裁剪后仍超预算，才从后往前整条丢弃（先丢最早的消息）。后缀切点
//      可能把 tool-call 与它的 tool-result 劈开，留下孤儿 result →
//      dropOrphanToolResults 按 id 剥掉这些段，补齐切片破坏的配对
// - 压缩服务化（getCompactionBudget / getCompactionDecision）：
//   对标 qwen chatCompressionService 阈值体系：压缩预算按模型窗口比例计算
//   （75% 窗口 − 输出预留），warn 提前缓冲提醒，避免一次性硬压缩
// ──────────────────────────────────────────────────────────────

import { type ModelMessage, pruneMessages } from 'ai';
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

/**
 * 多模态 part 的保守 token 折算额度。
 *
 * image / file 的 base64 负载不能按字符数计 token（一张图会估出几万 token），
 * 供应商按固定块计费；取 1000 作为下界代理，避免「几十张附件仍显示 0 占用」
 * 这一方向的系统性低估。
 */
export const MULTIMODAL_PART_TOKEN_ALLOWANCE = 1_000;

/** 多模态 content part 类型（provider 侧按固定块计费） */
const MULTIMODAL_PART_TYPES = new Set(['image', 'file', 'reasoning-file']);

/**
 * 消息 → 计入估算的文本（provider 真实可见部分）
 *
 * 覆盖文本段、推理块、工具入参、工具结果与内联文本型文件负载；
 * 图片/二进制资产不按字符计数，由 MULTIMODAL_PART_TOKEN_ALLOWANCE 折算。
 */
function messageToText(msg: ModelMessage): string {
  const content = msg.content as unknown;
  if (typeof content === 'string') {
    return content;
  }
  // 非法形状（非 string 非数组）：String() 兜底，不抛错打断回合
  if (!Array.isArray(content)) {
    return String(content ?? '');
  }
  return joinTextParts(content.map((part) => partToText(part)));
}

/** 文本段拼接（丢弃空段，避免空 part 的多余分隔符被计入 token） */
function joinTextParts(texts: string[]): string {
  return texts.filter((text) => text.length > 0).join('\n');
}

/** content part 的宽松读取形状（估算器只取需要的字段，其余形状忽略） */
interface PartShape {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly toolCallId?: unknown;
  readonly toolName?: unknown;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly value?: unknown;
  readonly data?: unknown;
}

/** 消息的 content part 数组（string content 不含 part → 空数组） */
function contentParts(msg: ModelMessage): unknown[] {
  const content = msg.content as unknown;
  return Array.isArray(content) ? content : [];
}

/** content part 的 type 字段（非对象 / 缺失 → 空串） */
function partType(part: unknown): string {
  if (part === null || typeof part !== 'object') {
    return '';
  }
  const kind = (part as PartShape).type;
  return typeof kind === 'string' ? kind : '';
}

/** content part 的 toolCallId（缺失 → 空串；配对时空串视为无调用方可匹配） */
function toolCallIdOf(part: unknown): string {
  if (part === null || typeof part !== 'object') {
    return '';
  }
  const id = (part as PartShape).toolCallId;
  return typeof id === 'string' ? id : '';
}

/** 提取 part 负载中的内联文本（二进制/URL 负载没有文本可计） */
function inlineTextOf(part: PartShape): string {
  const data = part.data;
  if (data !== null && typeof data === 'object') {
    const text = (data as PartShape).text;
    if (typeof text === 'string') {
      return text;
    }
  }
  return '';
}

/** 单个 content part → 文本 */
function partToText(part: unknown): string {
  if (part === null || typeof part !== 'object') {
    return '';
  }
  const p = part as PartShape;
  const kind = partType(part);
  if (kind === 'text' || kind === 'reasoning') {
    return typeof p.text === 'string' ? p.text : '';
  }
  if (kind === 'tool-call') {
    // 入参由模型生成，provider 会看到序列化后的 JSON → 按文本计入
    return `${String(p.toolName ?? '')} ${stringifyToText(p.input)}`;
  }
  if (kind === 'tool-result') {
    return toolResultToText(p.output);
  }
  if (MULTIMODAL_PART_TYPES.has(kind)) {
    // 资产本体不按字符计数（base64 会高估百倍）→ 由固定额度表达；
    // 内联文本型 file 负载是 provider 真实可见文本 → 照常计入
    return inlineTextOf(p);
  }
  return '';
}

/** tool-result 的 output → 文本（text / json / error-* / content 多段） */
function toolResultToText(output: unknown): string {
  if (output === null || typeof output !== 'object') {
    return stringifyToText(output);
  }
  const o = output as PartShape;
  if (o.type === 'content' && Array.isArray(o.value)) {
    return joinTextParts(o.value.map((item) => partToText(item)));
  }
  if ('value' in o) {
    return stringifyToText(o.value);
  }
  return stringifyToText(o);
}

/** 值 → 文本（字符串原样，其余 JSON 序列化；循环引用等异常吞掉） */
function stringifyToText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/** 判断 content part 是否为多模态负载（image / file / reasoning-file） */
function isMultimodalPart(part: unknown): boolean {
  return MULTIMODAL_PART_TYPES.has(partType(part));
}

/** 是否为按固定块计费的资产 part（多模态且非内联文本） */
function isAssetPart(part: unknown): boolean {
  if (!isMultimodalPart(part)) {
    return false;
  }
  // 内联文本型 file 负载已按文本精确计数，不再叠加固定额度
  return inlineTextOf(part as PartShape).length === 0;
}

/** 消息中资产型 part 数量（含 tool-result 内嵌的 content 段） */
function countAssetParts(msg: ModelMessage): number {
  let count = 0;
  for (const part of contentParts(msg)) {
    if (isAssetPart(part)) {
      count += 1;
      continue;
    }
    const output = (part as { output?: { type?: unknown; value?: unknown } })?.output;
    if (output?.type === 'content' && Array.isArray(output.value)) {
      count += output.value.filter(isAssetPart).length;
    }
  }
  return count;
}

/**
 * 单条消息 token 数（文本精确计数 + 资产型负载固定折算）
 */
function countMessageTokens(msg: ModelMessage): number {
  return (
    estimateTokenCount(messageToText(msg)) + countAssetParts(msg) * MULTIMODAL_PART_TOKEN_ALLOWANCE
  );
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
 * 工具上下文保留窗口（消息条数）：最近 N 条内的 tool-call / tool-result 不裁剪。
 *
 * 取 20 ≈ 数个 agent 步骤的工作记忆；更早的调用入参与结果已被后续推理消化，
 * 是压缩时最先该回收的低价值 token。
 */
export const TOOL_CONTEXT_KEEP_MESSAGES = 20;

/**
 * 裁剪低价值上下文（SDK pruneMessages 封装）
 *
 * - 旧推理块：只保留最后一条 assistant 的 reasoning（推理过程不回灌）
 * - 窗口外工具上下文：按 toolCallId 成对删除，不会留下 provider 拒绝的孤儿
 *   tool_use / tool_result（手写按角色丢弃极易踩这个坑）
 * - 裁剪后空消息删除：只剩工具调用的壳消息不占预算
 *
 * system 消息与最后一条消息不受影响（SDK 语义保证）。
 *
 * @param messages 原始消息列表（不被修改）
 * @param keepRecentMessages 工具上下文保留窗口，默认 TOOL_CONTEXT_KEEP_MESSAGES
 * @returns 裁剪后的消息列表
 */
export function pruneContext(
  messages: ModelMessage[],
  keepRecentMessages: number = TOOL_CONTEXT_KEEP_MESSAGES,
): ModelMessage[] {
  return pruneMessages({
    messages,
    reasoning: 'before-last-message',
    toolCalls: `before-last-${keepRecentMessages}-messages`,
    emptyMessages: 'remove',
  });
}

/**
 * 丢弃「调用已被切掉」的孤儿 tool_result
 *
 * 第二档保留的是消息后缀，切点可能落在 assistant 的 tool-call 与后续
 * tool-result 之间：结果留在切片里、调用却被切掉 → 供应商 400
 * （tool_result 找不到对应 tool_use）。第一档 pruneMessages 按 id
 * 成对删除，没有这个问题，故只需在切片后补这一刀。
 *
 * 反方向（tool_use 无 result）无需处理：结果总在调用之后，后缀切片
 * 不可能只留调用。剥离后 content 清空的消息整条丢弃。
 *
 * @param messages 切片后的消息列表（不被修改）
 * @returns 配对完整的消息列表
 */
function dropOrphanToolResults(messages: ModelMessage[]): ModelMessage[] {
  const callIds = new Set<string>();
  for (const msg of messages) {
    for (const part of contentParts(msg)) {
      if (partType(part) === 'tool-call') {
        const id = toolCallIdOf(part);
        if (id.length > 0) {
          callIds.add(id);
        }
      }
    }
  }

  const isOrphanResult = (part: unknown): boolean =>
    partType(part) === 'tool-result' && !callIds.has(toolCallIdOf(part));

  const result: ModelMessage[] = [];
  for (const msg of messages) {
    const parts = contentParts(msg);
    if (!parts.some(isOrphanResult)) {
      result.push(msg);
      continue;
    }
    const keptParts = parts.filter((part) => !isOrphanResult(part));
    if (keptParts.length > 0) {
      result.push({ ...msg, content: keptParts } as unknown as ModelMessage);
    }
  }
  return result;
}

/**
 * 按 token 预算压缩消息（gpt-tokenizer 精确计数）
 *
 * 策略（两档，先廉价后昂贵）：
 * - 预算内：原样返回，不做任何有信息损失的裁剪
 * - 第一档：pruneContext 回收旧推理块 + 窗口外工具上下文
 *   → 通常这一步就把预算腾出来了，对话轮次完整保住
 * - 第二档：仍超预算 → 从后往前整条保留（先丢最早的消息），
 *   再用 dropOrphanToolResults 补上切点破坏的工具配对
 * - system 消息无条件保留，且其占用先从预算扣除
 *
 * @param messages 原始消息列表
 * @param maxTokens token 预算（默认 8000；建议用 getCompactionBudget 按窗口计算）
 * @returns 压缩后的消息列表（不改变原始数组）
 */
export function compressByTokenBudget(messages: ModelMessage[], maxTokens = 8000): ModelMessage[] {
  if (maxTokens <= 0) {
    return [];
  }

  if (estimateMessagesTokens(messages) <= maxTokens) {
    return messages;
  }

  // system 无条件保留：先扣它占的额度，剩余才是对话预算
  const systemMessages = messages.filter((msg) => msg.role === 'system');
  const others = messages.filter((msg) => msg.role !== 'system');
  const conversationBudget = Math.max(0, maxTokens - estimateMessagesTokens(systemMessages));

  const pruned = pruneContext(others);
  const candidates = estimateMessagesTokens(pruned) <= conversationBudget ? pruned : others;

  // 从后往前累积 token（保留最新上下文），前缀超出预算的丢弃
  const kept: ModelMessage[] = [];
  let used = 0;
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const msg = candidates[i];
    if (msg === undefined) {
      continue;
    }
    const tokens = countMessageTokens(msg);
    if (used + tokens > conversationBudget) {
      break;
    }
    kept.unshift(msg);
    used += tokens;
  }

  // 倒序后 kept 为空说明单条消息就超预算：至少保留最后一条，避免空上下文
  if (kept.length === 0 && candidates.length > 0) {
    const last = candidates[candidates.length - 1];
    if (last !== undefined) {
      kept.push(last);
    }
  }

  const stripped = dropOrphanToolResults(kept);
  if (stripped.length > 0) {
    return [...systemMessages, ...stripped];
  }
  // 整条切片都是孤儿结果：有 system 就只发 system；连 system 都没有时
  // 带回未剥离的切片——空 messages 会被 SDK 直接拒绝，比配对不全更糟
  return systemMessages.length > 0 ? systemMessages : kept;
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
  return messages.reduce((sum, msg) => sum + countMessageTokens(msg), 0);
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
