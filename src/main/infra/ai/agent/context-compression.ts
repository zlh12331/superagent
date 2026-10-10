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

const TOKEN_CACHE_MAX = 512;
const tokenCountCache = new Map<string, number>();

function tokenCacheKey(text: string): string {
  const head = text.slice(0, 64);
  const tail = text.length > 64 ? text.slice(-64) : '';
  return `${text.length}:${head}:${tail}`;
}

export function estimateTokenCount(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const key = tokenCacheKey(text);
  const cached = tokenCountCache.get(key);
  if (cached !== undefined) {
    tokenCountCache.delete(key);
    tokenCountCache.set(key, cached);
    return cached;
  }
  const count = encode(text).length;
  tokenCountCache.set(key, count);
  if (tokenCountCache.size > TOKEN_CACHE_MAX) {
    const oldest = tokenCountCache.keys().next().value;
    if (oldest !== undefined) {
      tokenCountCache.delete(oldest);
    }
  }
  return count;
}

export const MULTIMODAL_PART_TOKEN_ALLOWANCE = 1_000;

const MULTIMODAL_PART_TYPES = new Set(['image', 'file', 'reasoning-file']);

function messageToText(msg: ModelMessage): string {
  const content = msg.content as unknown;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return String(content ?? '');
  }
  return joinTextParts(content.map((part) => partToText(part)));
}

function joinTextParts(texts: string[]): string {
  return texts.filter((text) => text.length > 0).join('\n');
}

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

function contentParts(msg: ModelMessage): unknown[] {
  const content = msg.content as unknown;
  return Array.isArray(content) ? content : [];
}

function partType(part: unknown): string {
  if (part === null || typeof part !== 'object') {
    return '';
  }
  const kind = (part as PartShape).type;
  return typeof kind === 'string' ? kind : '';
}

function toolCallIdOf(part: unknown): string {
  if (part === null || typeof part !== 'object') {
    return '';
  }
  const id = (part as PartShape).toolCallId;
  return typeof id === 'string' ? id : '';
}

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
    return `${String(p.toolName ?? '')} ${stringifyToText(p.input)}`;
  }
  if (kind === 'tool-result') {
    return toolResultToText(p.output);
  }
  if (MULTIMODAL_PART_TYPES.has(kind)) {
    return inlineTextOf(p);
  }
  return '';
}

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

function isMultimodalPart(part: unknown): boolean {
  return MULTIMODAL_PART_TYPES.has(partType(part));
}

function isAssetPart(part: unknown): boolean {
  if (!isMultimodalPart(part)) {
    return false;
  }
  return inlineTextOf(part as PartShape).length === 0;
}

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

function countMessageTokens(msg: ModelMessage): number {
  return (
    estimateTokenCount(messageToText(msg)) + countAssetParts(msg) * MULTIMODAL_PART_TOKEN_ALLOWANCE
  );
}

function hasToolCalls(msg: ModelMessage): boolean {
  return (
    msg.role === 'assistant' &&
    'toolCalls' in msg &&
    Array.isArray((msg as unknown as { toolCalls: unknown[] | null }).toolCalls) &&
    ((msg as unknown as { toolCalls: unknown[] | null }).toolCalls?.length ?? 0) > 0
  );
}

export const TOOL_CONTEXT_KEEP_MESSAGES = 20;

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

export function compressByTokenBudget(messages: ModelMessage[], maxTokens = 8000): ModelMessage[] {
  if (maxTokens <= 0) {
    return [];
  }

  if (estimateMessagesTokens(messages) <= maxTokens) {
    return messages;
  }

  const systemMessages = messages.filter((msg) => msg.role === 'system');
  const others = messages.filter((msg) => msg.role !== 'system');
  const conversationBudget = Math.max(0, maxTokens - estimateMessagesTokens(systemMessages));

  const pruned = pruneContext(others);
  const candidates = estimateMessagesTokens(pruned) <= conversationBudget ? pruned : others;

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
  return systemMessages.length > 0 ? systemMessages : kept;
}

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

export const COMPACTION_RATIO = 0.75;

export const COMPACTION_RESERVE_TOKENS = 20_000;

export const MIN_COMPACTION_BUDGET = 8_000;

export function getCompactionBudget(contextWindowSize: number): number {
  const reserve = Math.min(COMPACTION_RESERVE_TOKENS, Math.round(0.05 * contextWindowSize));
  const budget = Math.round(contextWindowSize * COMPACTION_RATIO) - reserve;
  return Math.max(budget, MIN_COMPACTION_BUDGET);
}

export function estimateMessagesTokens(messages: ModelMessage[]): number {
  return messages.reduce((sum, msg) => sum + countMessageTokens(msg), 0);
}

export type CompactionLevel = 'ok' | 'warn' | 'compact';

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

export type TokenBudgetLevel = 'ok' | 'warn' | 'compact' | 'over-limit';

export interface TokenBudgetDecision {
  readonly level: TokenBudgetLevel;
  readonly contextTokens: number;
  readonly contextWindowSize: number;
  readonly compactAt: number;
  readonly hardLimit: number;
}

export function getTokenBudgetDecision(
  contextTokens: number,
  contextWindowSize: number,
): TokenBudgetDecision {
  const compactAt = getCompactionBudget(contextWindowSize);
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
