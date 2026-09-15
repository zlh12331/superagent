// src/renderer/components/chat/history-parts.ts
// 持久化历史 → UIMessage 的忠实重建（纯函数，可单测）
// ──────────────────────────────────────────────────────────────
// 背景缺陷：重开会话时历史被压成「单条 text part」，工具调用 / 工具结果 / 推理 /
// 附件全部静默丢失，回显与直播时看到的对话不是同一个东西。
// ──────────────────────────────────────────────────────────────
// 契约（读取侧只依赖存储里真实存在的东西）：
// - messages.content = 单条 ModelMessage 的 JSON（`{ role, content }`），
//   content 可能是 string（纯文本）或 part 数组（text / reasoning / file / tool-call /
//   tool-result / tool-error）
// - 工具结果落在 assistant 消息内，也可能落在独立 role:'tool' 消息里
//   → 两遍扫描：先全局收集 toolCallId 的结果，再重建并把结果合并进对应工具卡
// - 存储里没有的 part 类型不可凭空补：如实登记进 droppedPartTypes，由 UI 显式告知
import type { ChatMessage } from '@code-agent/shared/renderer';
import type { UIMessage } from 'ai';

type UiPart = UIMessage['parts'][number];
type StoredPart = Record<string, unknown>;

/** 重建结果：消息 + 回显能力缺口（供 UI 显式呈现，不假装历史完整） */
export interface ReconstructedHistory {
  readonly messages: UIMessage[];
  /** 存储中出现、但渲染层无法回显的 part 类型（去重） */
  readonly droppedPartTypes: readonly string[];
  /** 是否成功回显出富 part（工具调用 / 推理）——false 且历史非空 ⇒ 只剩文本 */
  readonly hasRichParts: boolean;
}

/** 工具调用的落地结果 */
interface ToolOutcome {
  readonly state: 'output-available' | 'output-error';
  readonly output?: unknown;
  readonly errorText?: string;
}

function isRecord(value: unknown): value is StoredPart {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 兼容 v7 前的 TypedJSONValue 包装（`{ type: 'json' | 'text', value }`）。
 * 新版直接存裸 output，旧数据仍是包装形态——两种都还原成可展示值。
 */
function unwrapOutput(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const kind = value['type'];
  if ((kind === 'json' || kind === 'text') && 'value' in value) return value['value'];
  return value;
}

/** 归一化一条持久化消息（对畸形/旧数据一律降级为空 parts，不抛错） */
function normalizeMessage(raw: unknown): { readonly role: string; readonly parts: StoredPart[] } {
  const record = isRecord(raw) ? raw : {};
  const content = record['content'];
  const role = asString(record['role']) || 'user';
  if (typeof content === 'string') {
    return { role, parts: content.length > 0 ? [{ type: 'text', text: content }] : [] };
  }
  if (Array.isArray(content)) {
    return { role, parts: content.filter(isRecord) };
  }
  // 旧数据兜底：content 直接是单个 part 对象
  if (isRecord(content) && typeof content['type'] === 'string') {
    return { role, parts: [content] };
  }
  return { role, parts: [] };
}

/** 单条 part 的结果归类（tool-call 登记待合并 / result-error 写入结果表） */
function collectPartOutcome(
  part: StoredPart,
  callId: string,
  outcomes: Map<string, ToolOutcome>,
  callIds: Set<string>,
): void {
  switch (part['type']) {
    case 'tool-call':
      callIds.add(callId);
      break;
    case 'tool-result':
      outcomes.set(callId, {
        state: 'output-available',
        output: unwrapOutput(part['output']),
      });
      break;
    case 'tool-error':
      outcomes.set(callId, {
        state: 'output-error',
        errorText: asString(part['errorText']) || 'error',
      });
      break;
    default:
      break;
  }
}

/** 全局收集 toolCallId → 结果（第二遍重建时合并进工具卡） */
function collectOutcomes(messages: readonly { parts: StoredPart[] }[]): {
  outcomes: Map<string, ToolOutcome>;
  callIds: Set<string>;
} {
  const outcomes = new Map<string, ToolOutcome>();
  const callIds = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      const callId = asString(part['toolCallId']);
      if (callId.length > 0) {
        collectPartOutcome(part, callId, outcomes, callIds);
      }
    }
  }
  return { outcomes, callIds };
}

/** 持久化 file part（data 可为 URL / data URL / base64 / Uint8Array）→ UI file part */
function toFilePart(part: StoredPart): UiPart {
  const mediaType = asString(part['mediaType']) || 'application/octet-stream';
  const rawUrl = asString(part['url']);
  const data = part['data'];
  let url = rawUrl;
  if (url.length === 0) {
    if (typeof data === 'string') {
      // 白名单仅认真 URL scheme：裸 base64 可能以 "/" 开头（JPEG 恒为
      // "/9j/..."），早前把 "./|/" 当路径前缀会让整图被当根相对路径裂掉
      url = /^(?:data:|https?:|file:|blob:)/.test(data) ? data : `data:${mediaType};base64,${data}`;
    } else if (data instanceof Uint8Array) {
      let binary = '';
      for (const byte of data) binary += String.fromCharCode(byte);
      url = `data:${mediaType};base64,${btoa(binary)}`;
    }
  }
  const filename = asString(part['filename']);
  return {
    type: 'file',
    mediaType,
    url,
    ...(filename.length > 0 ? { filename } : {}),
  } as UiPart;
}

/** tool-call + 可选结果 → UI 工具 part（type 为 `tool-${name}`，与直播渲染同构） */
function toToolPart(
  toolName: string,
  toolCallId: string,
  input: unknown,
  outcome: ToolOutcome | undefined,
): UiPart {
  const base = { toolCallId, input };
  if (outcome?.state === 'output-error') {
    return {
      type: `tool-${toolName}`,
      ...base,
      state: 'output-error',
      errorText: outcome.errorText ?? 'error',
    } as UiPart;
  }
  if (outcome?.state === 'output-available') {
    return {
      type: `tool-${toolName}`,
      ...base,
      state: 'output-available',
      output: outcome.output,
    } as UiPart;
  }
  return { type: `tool-${toolName}`, ...base, state: 'input-available' } as UiPart;
}

/** 孤儿工具结果（其 tool-call 未被持久化）：不丢弃，独立成卡呈现 */
function toOrphanResultPart(part: StoredPart, outcome: ToolOutcome): UiPart {
  const toolName = asString(part['toolName']) || 'unknown';
  const toolCallId = asString(part['toolCallId']);
  if (outcome.state === 'output-error') {
    return {
      type: 'dynamic-tool',
      toolName,
      toolCallId,
      state: 'output-error',
      input: unwrapOutput(part['input']),
      errorText: outcome.errorText ?? 'error',
    } as UiPart;
  }
  return {
    type: 'dynamic-tool',
    toolName,
    toolCallId,
    state: 'output-available',
    input: unwrapOutput(part['input']),
    output: outcome.output,
  } as UiPart;
}

/** 孤儿结果的兜底 outcome：按 part 自身类型判定（tool-error 不误标成功、不丢 errorText） */
function fallbackOutcome(type: string, part: StoredPart): ToolOutcome {
  if (type === 'tool-error') {
    return { state: 'output-error', errorText: asString(part['errorText']) || 'error' };
  }
  return { state: 'output-available', output: unwrapOutput(part['output']) };
}

/** 存储角色 → UIMessage 角色（未知角色兜底 user，语义对齐 normalizeMessage） */
function toUiRole(role: string): UIMessage['role'] {
  return role === 'assistant' || role === 'system' ? role : 'user';
}

/** part 分类上下文（收敛形参 ≤4；结果表/登记表由 collectOutcomes 产出） */
interface PartContext {
  readonly outcomes: ReadonlyMap<string, ToolOutcome>;
  readonly callIds: ReadonlySet<string>;
  /** 无法回显的 part 类型登记（default 分支写入） */
  readonly dropped: Set<string>;
}

/** 该 tool-result/error 是否已有对应 tool-call（已合并进卡，无需孤儿呈现） */
function isMergedOutcome(callId: string, callIds: ReadonlySet<string>): boolean {
  return callId.length > 0 && callIds.has(callId);
}

/** 单条 part → UI part（无法回显返回 null；reasoning/工具记富标记） */
function partToUi(part: StoredPart, ctx: PartContext): { part: UiPart | null; rich: boolean } {
  const type = asString(part['type']);
  switch (type) {
    case 'text': {
      const text = asString(part['text']);
      if (text.length > 0) {
        return { part: { type: 'text', text, state: 'done' } as UiPart, rich: false };
      }
      return { part: null, rich: false };
    }
    case 'reasoning': {
      const text = asString(part['text']);
      if (text.length > 0) {
        return { part: { type: 'reasoning', text, state: 'done' } as UiPart, rich: true };
      }
      return { part: null, rich: false };
    }
    case 'file':
      return { part: toFilePart(part), rich: false };
    case 'tool-call': {
      const callId = asString(part['toolCallId']);
      return {
        part: toToolPart(
          asString(part['toolName']) || 'unknown',
          callId,
          unwrapOutput(part['input']),
          callId.length > 0 ? ctx.outcomes.get(callId) : undefined,
        ),
        rich: true,
      };
    }
    case 'tool-result':
    case 'tool-error': {
      // 有对应 tool-call 的结果已合并进上面的卡；孤儿结果单独呈现
      const callId = asString(part['toolCallId']);
      if (isMergedOutcome(callId, ctx.callIds)) {
        return { part: null, rich: false };
      }
      return {
        part: toOrphanResultPart(part, ctx.outcomes.get(callId) ?? fallbackOutcome(type, part)),
        rich: true,
      };
    }
    case 'step-start':
      return { part: { type: 'step-start' } as UiPart, rich: false };
    default:
      if (type.length > 0) ctx.dropped.add(type);
      return { part: null, rich: false };
  }
}

/** 单条消息的 part 分类：返回可渲染 parts 与是否含富 part（reasoning/工具） */
function collectUiParts(
  message: { parts: StoredPart[] },
  ctx: PartContext,
): { parts: UiPart[]; rich: boolean } {
  const parts: UiPart[] = [];
  let rich = false;
  for (const part of message.parts) {
    const { part: ui, rich: isRich } = partToUi(part, ctx);
    if (ui !== null) parts.push(ui);
    if (isRich) rich = true;
  }
  return { parts, rich };
}

/**
 * 重建持久化历史为渲染层 UIMessage[]。
 *
 * 保留存储中真实存在的每一种 part；无法回显的类型登记进 droppedPartTypes。
 * 空消息（无 part 可渲染）整体跳过，避免空气泡。
 */
export function reconstructHistory(rawMessages: readonly ChatMessage[]): ReconstructedHistory {
  const normalized = rawMessages.map((raw) => normalizeMessage(raw));
  const { outcomes, callIds } = collectOutcomes(normalized);
  const dropped = new Set<string>();
  let hasRichParts = false;
  const ctx: PartContext = { outcomes, callIds, dropped };

  const messages: UIMessage[] = [];
  normalized.forEach((message, index) => {
    const { parts, rich } = collectUiParts(message, ctx);
    if (rich) hasRichParts = true;
    if (parts.length === 0) return;
    messages.push({ id: `hist-${index}`, role: toUiRole(message.role), parts });
  });

  return { messages, droppedPartTypes: [...dropped], hasRichParts };
}

/** 兼容旧调用点：只要消息数组（compact 后替换本地态用） */
export function toInitialMessages(messages: readonly ChatMessage[]): UIMessage[] {
  return reconstructHistory(messages).messages;
}
