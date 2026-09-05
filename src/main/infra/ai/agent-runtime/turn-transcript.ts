// src/main/infra/ai/agent-runtime/turn-transcript.ts
// 回合 Transcript 累积 → messages 落库构造（纯函数）
// ──────────────────────────────────────────────
// 背景：助手消息此前仅落库 TEXT_DELTA 拼接的纯文本，工具调用与思考过程
// 重开会话后不可见（渲染层 historyTextOnly 横幅告知的能力缺口）。
// 本模块把回合内累积的 reasoning / tool-call / tool-result 条目构造为
// ModelMessage（AI SDK 类型），part 形态与 SDK response.messages 对齐：
// tool-result.output 用 SDK 包装形态（{type:'json'|'text', value}），
// 渲染层 unwrapOutput 原生解包，无需感知本模块。
//
// 设计取舍：
// - 整个回合的助手产出合并为一条 assistant 消息（parts 按发生顺序）+
//   一条 tool 消息（全部结果），而非逐 step 拆分——渲染层按 toolCallId
//   关联结果合并进工具卡，逐 step 拆分只会增加气泡噪声。
// - 工具 output 落库前截断（MAX_PERSISTED_TOOL_OUTPUT_BYTES）：防止
//   read_file 级大输出膨胀 SQLite；超限给明确标记（展示语义完整）。

import type { ModelMessage, ToolResultPart } from 'ai';

/** assistant 消息 content 数组的 part 联合（从 ModelMessage 提取；'ai' 导出的 AssistantContent 与其不一致） */
type AssistantModelMessage = Extract<ModelMessage, { role: 'assistant' }>;
type AssistantPart = Exclude<AssistantModelMessage['content'], string>[number];

/** 回合内单条转录条目（由 agent-service 在事件/onPart 处累积） */
export interface TurnTranscriptEntry {
  readonly kind: 'reasoning' | 'tool-call' | 'tool-result';
  /** kind='reasoning'：思考文本增量 */
  readonly text?: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  /** kind='tool-call'：工具入参 */
  readonly input?: unknown;
  /** kind='tool-result'：执行输出（成功时） */
  readonly output?: unknown;
  /** kind='tool-result'：失败信息（失败时提供；与 output 互斥） */
  readonly error?: { readonly code: string; readonly message: string };
}

/** 工具 output 落库字节上限（超出截断为占位标记） */
export const MAX_PERSISTED_TOOL_OUTPUT_BYTES = 16 * 1024;

/** JSON 兼容值（SDK ToolResultOutput['value'] 的结构约束；'ai' 不直接导出该类型名） */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const truncatedMark = (totalBytes: number): string =>
  `…[工具输出过长，仅保留存储前 ${MAX_PERSISTED_TOOL_OUTPUT_BYTES} 字节，原始共 ${totalBytes} 字节]`;

interface SafeJson {
  readonly ok: boolean;
  readonly text: string;
}

/** 序列化 output（失败兜底 String 形态——落库要求可序列化，此处保证不抛） */
function safeStringify(value: unknown): SafeJson {
  try {
    return { ok: true, text: JSON.stringify(value) ?? 'null' };
  } catch {
    return { ok: false, text: JSON.stringify(String(value)) ?? '"[不可序列化输出]"' };
  }
}

/**
 * 工具 output → SDK ToolResultOutput 包装形态（渲染层 unwrapOutput 可解包）。
 * 字符串走 {type:'text'}；其余走 {type:'json'}（复用序列化结果，未超限时
 * 不做第二次 stringify/parse 以外的转换）；超限统一截断为标记字符串。
 */
export function toPersistedOutput(
  output: unknown,
  limitBytes: number = MAX_PERSISTED_TOOL_OUTPUT_BYTES,
): ToolResultPart['output'] {
  if (typeof output === 'string') {
    const total = Buffer.byteLength(output, 'utf8');
    if (total <= limitBytes) {
      return { type: 'text', value: output };
    }
    const slice = Buffer.from(output, 'utf8').subarray(0, limitBytes).toString('utf8');
    return { type: 'text', value: `${slice}${truncatedMark(total)}` };
  }
  const json = safeStringify(output);
  const total = Buffer.byteLength(json.text, 'utf8');
  if (total <= limitBytes && json.ok) {
    return { type: 'json', value: JSON.parse(json.text) as JsonValue };
  }
  return { type: 'json', value: truncatedMark(total) };
}

/** 相邻 reasoning 增量合并为单一 part，tool-call 转为 SDK part（保发生顺序），文本殿后 */
function collectAssistantParts(
  entries: readonly TurnTranscriptEntry[],
  assistantText: string,
): AssistantPart[] {
  const parts: AssistantPart[] = [];
  for (const entry of entries) {
    if (entry.kind === 'reasoning' && entry.text !== undefined) {
      const last = parts.at(-1);
      if (last?.type === 'reasoning') {
        parts[parts.length - 1] = { type: 'reasoning', text: last.text + entry.text };
        continue;
      }
      parts.push({ type: 'reasoning', text: entry.text });
      continue;
    }
    if (
      entry.kind === 'tool-call' &&
      entry.toolCallId !== undefined &&
      entry.toolName !== undefined
    ) {
      parts.push({
        type: 'tool-call',
        toolCallId: entry.toolCallId,
        toolName: entry.toolName,
        // ToolCallPart.input 必填（SDK 契约）；无参工具此处为 undefined，符合 unknown
        input: entry.input,
      });
    }
  }
  if (assistantText.length > 0) {
    parts.push({ type: 'text', text: assistantText });
  }
  return parts;
}

/** tool-result 条目 → SDK ToolResultPart（output 截断+包装；失败时 value 为 error 对象，与 LLM 所见一致） */
function collectToolParts(entries: readonly TurnTranscriptEntry[]): ToolResultPart[] {
  const parts: ToolResultPart[] = [];
  for (const entry of entries) {
    if (
      entry.kind !== 'tool-result' ||
      entry.toolCallId === undefined ||
      entry.toolName === undefined
    ) {
      continue;
    }
    parts.push({
      type: 'tool-result',
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      output: toPersistedOutput(entry.error !== undefined ? { error: entry.error } : entry.output),
    });
  }
  return parts;
}

/**
 * 回合结束 → messages 落库内容（agent / chat 共用契约）
 *
 * 返回 [assistant?, tool?]：assistant 内容非空才含 assistant 消息；
 * 存在工具结果才含 tool 消息；全空返回 []（无内容不落库）。
 */
export function buildAssistantTurnMessages(
  assistantText: string,
  entries: readonly TurnTranscriptEntry[],
): ModelMessage[] {
  const assistantContent = collectAssistantParts(entries, assistantText);
  const toolParts = collectToolParts(entries);
  const messages: ModelMessage[] = [];
  if (assistantContent.length > 0) {
    messages.push({ role: 'assistant', content: assistantContent });
  }
  if (toolParts.length > 0) {
    messages.push({ role: 'tool', content: [...toolParts] });
  }
  return messages;
}
