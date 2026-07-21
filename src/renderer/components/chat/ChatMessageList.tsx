// src/renderer/components/chat/ChatMessageList.tsx
// 聊天消息列表 · 极简文学风
// ──────────────────────────────────────────────────────────────
// 职责：
// - 渲染 UIMessage 数组（user / assistant / system 三种角色）
// - assistant 消息按 parts 分发渲染（text / reasoning / tool / file / step-start 等）
// - 自动滚动到底部（流式追加时保持视图跟随）
// - 空状态展示 EmptyState 组件
//
// 设计：
// - user 消息靠右，米色气泡（secondary 背景）
// - assistant 消息靠左，无气泡，纯衬线文字（最大化可读性）
// - system 消息居中，淡灰小字
// - reasoning 部分用斜体灰字，加"思考"标签
// - tool 部分用代码块展示（带 type + state 标签）
// - step-start 部分用细分隔线表示新步骤
// - 流式占位：streaming 状态时，最后一条 assistant 消息末尾显示"..."
//
// 文学风细节：
// - 字体使用 font-serif（Noto Serif SC 衬线）
// - 文字行高 1.8（接近书籍排版）
// - 用户气泡用 secondary 暖米色，呼应纸张感
// ──────────────────────────────────────────────────────────────
//
// 说明：
// - 不在此组件内调用 useChat，messages / status 由父组件传入
// - 仅做展示，不做任何业务逻辑
// - 使用 AI SDK 官方类型守卫（isTextUIPart / isReasoningUIPart 等）
// - part 类型用 UIMessage['parts'][number] 派生，避免手写泛型参数

// type-only import：仅引入类型，不引入运行时依赖
import type { UIMessage } from 'ai';
// AI SDK 官方类型守卫：在运行时判断 part 类型并收窄 TypeScript 类型
import {
  isDynamicToolUIPart,
  isFileUIPart,
  isReasoningUIPart,
  isStaticToolUIPart,
  isTextUIPart,
} from 'ai';
import { Sparkles } from 'lucide-react';
import { type ReactElement, useEffect, useRef } from 'react';

import { EmptyState } from '@/components/common/EmptyState';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

/**
 * UIMessage parts 元素类型
 *
 * 从 UIMessage 默认参数化派生，避免手写 `UIMessagePart<UIDataTypes, UITools>`
 * （UIDataTypes / UITools 是 AI SDK 内部类型，外部不应直接引用）。
 */
type UIMessagePart = UIMessage['parts'][number];

interface ChatMessageListProps {
  /** 消息数组（来自 useChat().messages） */
  messages: readonly UIMessage[];
  /** 当前流式状态（'streaming' / 'submitted' 时显示流式占位） */
  status: 'submitted' | 'streaming' | 'ready' | 'error';
  /** 自定义容器类名 */
  className?: string;
}

/**
 * 聊天消息列表
 *
 * 渲染规则：
 * - user 消息：靠右，米色气泡
 * - assistant 消息：靠左，无气泡，按 parts 渲染
 * - system 消息：居中，淡灰小字
 *
 * @example
 * ```tsx
 * <ChatMessageList messages={messages} status={status} />
 * ```
 */
export function ChatMessageList({
  messages,
  status,
  className,
}: ChatMessageListProps): ReactElement {
  // 底部锚点元素：每次 messages 变化时滚动到此处
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // 流式状态（streaming / submitted）时显示占位"..."
  const isStreaming = status === 'streaming' || status === 'submitted';

  // 自动滚动到底部：messages 长度变化或流式状态变化时触发
  // biome-ignore lint/correctness/useExhaustiveDependencies: 故意监听 messages.length 与 isStreaming，触发滚动而不读取其值
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, isStreaming]);

  // 空状态：无消息时展示 EmptyState
  if (messages.length === 0) {
    return (
      <div className={cn('flex h-full items-center justify-center', className)}>
        <EmptyState
          icon={<Sparkles className="size-6" strokeWidth={1.5} />}
          title="开始新对话"
          description="在下方输入框输入你的问题，按 Enter 发送"
        />
      </div>
    );
  }

  return (
    <ScrollArea className={cn('h-full', className)}>
      <div className="flex flex-col gap-4 px-4 py-4">
        {messages.map((message) => (
          <MessageItem key={message.id} message={message} />
        ))}
        {/* 流式占位：assistant 正在响应时显示"..."气泡 */}
        {isStreaming ? <StreamingPlaceholder /> : null}
        {/* 底部锚点 */}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  );
}

// ──────────────────────────────────────────────────────────────
// 内部组件
// ──────────────────────────────────────────────────────────────

/**
 * 单条消息渲染
 *
 * 按 message.role 分发到不同的展示样式：
 * - 'user'：靠右米色气泡
 * - 'assistant'：靠左无气泡，按 parts 渲染
 * - 'system'：居中淡灰小字
 */
function MessageItem({ message }: { message: UIMessage }): ReactElement {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="bg-secondary text-secondary-foreground max-w-[80%] rounded-md px-3 py-2 font-serif text-sm leading-relaxed whitespace-pre-wrap">
          {/* user 消息仅渲染 text parts（拼接为单一字符串） */}
          {extractText(message.parts)}
        </div>
      </div>
    );
  }

  if (message.role === 'assistant') {
    return (
      <div className="flex flex-col gap-1.5">
        {/* assistant 标签：左侧细线 + "助手"小字 */}
        <span className="text-muted-foreground font-serif text-xs tracking-wide">助手</span>
        {/* parts 列表：按 part 类型分别渲染 */}
        <div className="flex flex-col gap-2">
          {message.parts.map((part, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: parts 是 append-only 序列，index 在单条消息内唯一稳定
            <PartView key={`${message.id}-${index}`} part={part} />
          ))}
        </div>
      </div>
    );
  }

  // system 消息：居中淡灰小字
  return (
    <div className="flex justify-center">
      <div className="text-muted-foreground font-serif text-xs italic">
        {extractText(message.parts)}
      </div>
    </div>
  );
}

/**
 * 单个 part 渲染
 *
 * 根据 part.type 分发到不同的展示组件：
 * - 'text'：纯文本（保留换行）
 * - 'reasoning'：思考内容（斜体灰字 + "思考"标签）
 * - 'tool-*' / 'dynamic-tool'：工具调用（代码块 + state 标签）
 * - 'file'：文件附件（链接 + mediaType）
 * - 'step-start'：步骤分隔线
 * - 其他：fallback 展示 part.type
 */
function PartView({ part }: { part: UIMessagePart }): ReactElement {
  // 文本 part：纯衬线字体展示，保留换行
  if (isTextUIPart(part)) {
    return (
      <div className="text-foreground font-serif text-sm leading-relaxed whitespace-pre-wrap">
        {part.text}
      </div>
    );
  }

  // 思考 part：斜体灰字 + "思考"标签
  if (isReasoningUIPart(part)) {
    return (
      <div className="bg-muted/50 border-border rounded-md border-l-2 p-2">
        <div className="text-muted-foreground mb-1 font-serif text-xs italic tracking-wide">
          思考
        </div>
        <div className="text-muted-foreground font-serif text-xs leading-relaxed whitespace-pre-wrap italic">
          {part.text}
        </div>
      </div>
    );
  }

  // 静态工具调用（tool-{name}）
  // 注意：errorText 在不同 state 下可能为 string 或 undefined，
  // 用 ?? undefined 统一为 string | undefined（兼容 exactOptionalPropertyTypes）
  if (isStaticToolUIPart(part)) {
    return (
      <ToolCallView
        type={part.type}
        state={part.state}
        input={part.input}
        output={part.output}
        errorText={part.errorText ?? undefined}
      />
    );
  }

  // 动态工具调用（dynamic-tool）
  if (isDynamicToolUIPart(part)) {
    return (
      <ToolCallView
        type={`dynamic-tool: ${part.toolName}`}
        state={part.state}
        input={part.input}
        output={part.output}
        errorText={part.errorText ?? undefined}
      />
    );
  }

  // 文件 part：展示为带 mediaType 的链接占位
  if (isFileUIPart(part)) {
    return (
      <div className="bg-muted/30 border-border rounded-md border p-2">
        <div className="text-muted-foreground font-serif text-xs">附件 · {part.mediaType}</div>
      </div>
    );
  }

  // step-start：步骤分隔线
  if (part.type === 'step-start') {
    return (
      <div className="border-border my-2 flex items-center gap-2 border-t pt-1">
        <span className="text-muted-foreground font-serif text-xs italic">下一步</span>
      </div>
    );
  }

  // fallback：未知 part 类型，展示 type 字符串
  return (
    <div className="text-muted-foreground font-serif text-xs italic">未知消息类型: {part.type}</div>
  );
}

/**
 * 工具调用展示
 *
 * 显示工具名称、状态、入参、输出 / 错误。
 * 使用代码块风格（font-mono + secondary 背景）。
 *
 * 注意：可选字段使用 `T | undefined` 而非 `T?`，
 * 以兼容 exactOptionalPropertyTypes（exactOptionalPropertyTypes 下 `T?` 不允许显式传入 undefined）。
 */
interface ToolCallViewProps {
  type: string;
  state: string;
  input: unknown | undefined;
  output: unknown | undefined;
  errorText: string | undefined;
}

function ToolCallView({ type, state, input, output, errorText }: ToolCallViewProps): ReactElement {
  return (
    <div className="bg-muted/40 border-border rounded-md border p-2">
      {/* 工具头部：名称 + 状态标签 */}
      <div className="mb-1 flex items-center gap-2">
        <span className="text-foreground font-mono text-xs font-medium">{type}</span>
        <span className="bg-secondary text-secondary-foreground rounded px-1.5 py-0.5 font-mono text-[10px]">
          {state}
        </span>
      </div>
      {/* 入参（JSON 序列化，最多 200 字符避免膨胀） */}
      {input !== undefined && <CodeBlock label="input" content={formatJson(input)} />}
      {/* 输出（output 优先于 errorText） */}
      {output !== undefined && <CodeBlock label="output" content={formatJson(output)} />}
      {errorText !== undefined && errorText !== '' && (
        <CodeBlock label="error" content={errorText} />
      )}
    </div>
  );
}

/**
 * 代码块（带标签 + 内容）
 *
 * 用于展示工具调用的 input / output / error。
 */
function CodeBlock({ label, content }: { label: string; content: string }): ReactElement {
  return (
    <div className="mt-1">
      <div className="text-muted-foreground font-mono text-[10px]">{label}</div>
      <pre className="bg-background/50 text-foreground mt-0.5 overflow-x-auto rounded p-1.5 font-mono text-[11px] leading-snug">
        {content}
      </pre>
    </div>
  );
}

/**
 * 流式占位
 *
 * streaming 状态时显示在消息列表末尾的"..."气泡，
 * 表示助手正在生成回复。
 */
function StreamingPlaceholder(): ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-muted-foreground font-serif text-xs tracking-wide">助手</span>
      <div className="text-muted-foreground font-serif text-sm tracking-widest animate-pulse-soft">
        ...
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────────────────────────

/**
 * 从 parts 中提取所有文本并拼接
 *
 * 用于 user / system 消息（只展示文本内容）。
 */
function extractText(parts: readonly UIMessagePart[]): string {
  return parts
    .filter(isTextUIPart)
    .map((part) => part.text)
    .join('\n');
}

/**
 * JSON 序列化（截断到 200 字符，避免大对象撑爆 UI）
 */
function formatJson(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2) ?? 'undefined';
    return json.length > 200 ? `${json.slice(0, 200)}\n...(已截断)` : json;
  } catch {
    return String(value);
  }
}
