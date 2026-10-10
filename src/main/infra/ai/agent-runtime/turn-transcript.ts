import type { ModelMessage, ToolResultPart } from 'ai';

type AssistantModelMessage = Extract<ModelMessage, { role: 'assistant' }>;
type AssistantPart = Exclude<AssistantModelMessage['content'], string>[number];

export interface TurnTranscriptEntry {
  readonly kind: 'reasoning' | 'tool-call' | 'tool-result';
  readonly text?: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

export const MAX_PERSISTED_TOOL_OUTPUT_BYTES = 16 * 1024;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const truncatedMark = (totalBytes: number): string =>
  `…[工具输出过长，仅保留存储前 ${MAX_PERSISTED_TOOL_OUTPUT_BYTES} 字节，原始共 ${totalBytes} 字节]`;

interface SafeJson {
  readonly ok: boolean;
  readonly text: string;
}

function safeStringify(value: unknown): SafeJson {
  try {
    return { ok: true, text: JSON.stringify(value) ?? 'null' };
  } catch {
    return { ok: false, text: JSON.stringify(String(value)) ?? '"[不可序列化输出]"' };
  }
}

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
        input: entry.input,
      });
    }
  }
  if (assistantText.length > 0) {
    parts.push({ type: 'text', text: assistantText });
  }
  return parts;
}

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
