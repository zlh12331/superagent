// message-item.tsx（自 ChatMessageList 拆分）
// 聊天消息行：消息项 / part 渲染 / 工具调用 / 代码块 / 推理块
// ──────────────────────────────
// 拆分背景：ChatMessageList 685 行，消息渲染逻辑提取为独立文件
// ──────────────────────────────

// src/renderer/components/chat/ChatMessageList.tsx
// 聊天消息列表 · Aurora 设计系统
// ──────────────────────────────────────────────────────────────
// 职责：
// - 渲染 UIMessage 数组（user / assistant / system 三种角色）
// - assistant 消息按 parts 分发渲染（text / reasoning / tool / file / step-start 等）
// - 智能自动滚动：仅当用户在底部附近时跟随，否则显示 scroll-to-bottom 按钮
// - 空状态展示 EmptyState 组件
//
// 设计（对齐原型 docs/prototype/prototype-v2.html）：
// - user 消息：.msg.user > .msg-body > .msg-content（玻璃渐变气泡，靠右由 .msg-content 自身样式实现）
// - assistant 消息：.msg.assistant > .msg-avatar.assistant + .msg-body > .msg-role + .msg-content（无气泡开放排版）
// - tool 调用：.msg.msg-tool > .msg-body > .card.tool-card（可折叠卡片）
// - reasoning：.reasoning-block（折叠式推理块，accent 左光条）
// - system 消息：居中小字
// - streaming 占位：typing-indicator（三个 accent 点弹跳）
// - 滚动到底部按钮：.scroll-to-bottom（距底部 > 80px 时显示，有新消息加 .has-new）
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
import { motion } from 'motion/react';
import { type ReactElement, useState } from 'react';

import { useTranslation } from '@/i18n/use-translation';
import { smoothEaseOut } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { useReasoningCollapseStore } from '@/stores/transient/reasoning-collapse-store';
import { useToolStore } from '@/stores/transient/tool-store';
import { FileChangeCard } from './file-change-card';
import { Markdown } from './Markdown';
import { MsgActions } from './message-actions';
import { extractText, formatJson } from './message-utils';

/** part 类型（UIMessage['parts'][number] 派生） */
type UIMessagePart = UIMessage['parts'][number];

export function MessageItem({
  message,
  onRegenerate,
  disableActions,
}: {
  message: UIMessage;
  onRegenerate: ((messageId: string) => void) | undefined;
  disableActions: boolean;
}): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  // 当前模型（对齐原型 .msg-role 展示模型名）
  const defaultModel = useSettingsStore((state) => state.ai.defaultModel);
  if (message.role === 'user') {
    // user 消息：仅 .msg-body > .msg-content，气泡样式由 .msg-content 提供（玻璃渐变）
    return (
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={smoothEaseOut}
        className="msg user enter-anim"
      >
        <div className="msg-body">
          <div className="msg-content">
            {/* user 消息仅渲染 text parts（拼接为单一字符串，保留换行） */}
            {extractText(message.parts)}
          </div>
        </div>
      </motion.div>
    );
  }

  if (message.role === 'assistant') {
    // assistant 消息：avatar + body（role + parts + actions）
    // 对齐原型 addMsgActions()：仅 assistant 消息显示 hover 操作栏
    return (
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={smoothEaseOut}
        className="msg assistant enter-anim"
      >
        <div className="msg-avatar assistant" aria-hidden="true">
          C
        </div>
        <div className="msg-body">
          {/* 对齐原型 .msg-role（"codex · gpt-5-codex"）：品牌 · 当前模型 */}
          <div className="msg-role assistant">
            {t('chat.assistant')} · {defaultModel}
          </div>
          {/* parts 列表：按 part 类型分别渲染 */}
          {message.parts.map((part, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: parts 是 append-only 序列，index 在单条消息内唯一稳定
            <PartView key={`${message.id}-${index}`} part={part} messageId={message.id} />
          ))}
          {/* hover 操作栏：复制 + 重新生成（对齐原型 .msg-actions） */}
          <MsgActions
            text={extractText(message.parts)}
            messageId={message.id}
            onRegenerate={onRegenerate}
            disabled={disableActions}
          />
        </div>
      </motion.div>
    );
  }

  // system 消息：居中淡灰小字
  return (
    <div className="flex justify-center">
      <div className="text-muted-foreground font-mono text-xs italic">
        {extractText(message.parts)}
      </div>
    </div>
  );
}

/**
 * 单个 part 渲染
 *
 * 根据 part.type 分发到不同的展示组件：
 * - 'text'：.msg-content > Markdown（GFM 解析 + shiki 代码高亮）
 * - 'reasoning'：.reasoning-block（折叠式推理块，accent 左光条）
 * - 'tool-*' / 'dynamic-tool'：.card.tool-card（可折叠工具卡片）
 * - 'file'：.card 简易附件卡片
 * - 'step-start'：细分隔线表示新步骤
 * - 其他：fallback 展示 part.type
 */
function PartView({
  part,
  messageId,
}: {
  part: UIMessagePart;
  /** 所属消息 id（推理块折叠态关联 store 用） */
  messageId: string;
}): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  // 文本 part：Markdown 渲染（支持 GFM + 代码语法高亮）
  if (isTextUIPart(part)) {
    if (part.text.length === 0) {
      return <div className="msg-content" />;
    }
    return (
      <div className="msg-content">
        <Markdown content={part.text} />
      </div>
    );
  }

  // 思考 part：.reasoning-block 折叠式推理块
  if (isReasoningUIPart(part)) {
    return <ReasoningBlock text={part.text} messageId={messageId} />;
  }

  // 静态工具调用（tool-{name}）
  // 注意：errorText 在不同 state 下可能为 string 或 undefined，
  // 用 ?? undefined 统一为 string | undefined（兼容 exactOptionalPropertyTypes）
  if (isStaticToolUIPart(part)) {
    // 文件变更工具（edit_file / write_file）：渲染 FileChangeCard（diff 卡片）
    // 对齐参考项目 FileChangeCard——替代通用 JSON 展示，突出文件变更可视化
    if (part.type === 'tool-edit_file' || part.type === 'tool-write_file') {
      return <FileChangeCard toolName={part.type.slice(5)} input={part.input} />;
    }
    return (
      <ToolCallView
        type={part.type}
        toolCallId={part.toolCallId}
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
        toolCallId={part.toolCallId}
        state={part.state}
        input={part.input}
        output={part.output}
        errorText={part.errorText ?? undefined}
      />
    );
  }

  // 文件 part：展示为 .card 简易附件卡片
  if (isFileUIPart(part)) {
    return (
      <div className="card">
        <div className="card-head">
          <span className="card-icon">📎</span>
          <span className="card-title">{t('chat.attachment')}</span>
          <span className="card-status pending">{part.mediaType}</span>
        </div>
      </div>
    );
  }

  // step-start：步骤分隔线
  if (part.type === 'step-start') {
    return (
      <div className="border-border my-2 flex items-center gap-2 border-t pt-1">
        <span className="text-muted-foreground font-mono text-xs italic">{t('chat.nextStep')}</span>
      </div>
    );
  }

  // fallback：未知 part 类型，展示 type 字符串
  return (
    <div className="text-muted-foreground font-mono text-xs italic">
      {t('chat.unknownPart', { type: part.type })}
    </div>
  );
}

/**
 * 工具调用卡片（对齐原型 .card.tool-card）
 *
 * 显示工具名称、状态、入参、输出 / 错误。
 * 可折叠：点击 card-head 切换 .open 类。
 *
 * 注意：可选字段使用 `T | undefined` 而非 `T?`，
 * 以兼容 exactOptionalPropertyTypes（exactOptionalPropertyTypes 下 `T?` 不允许显式传入 undefined）。
 */
interface ToolCallViewProps {
  type: string;
  toolCallId: string;
  state: string;
  input: unknown | undefined;
  output: unknown | undefined;
  errorText: string | undefined;
}

function ToolCallView({
  type,
  toolCallId,
  state,
  input,
  output,
  errorText,
}: ToolCallViewProps): ReactElement {
  // 折叠状态：默认折叠（对齐原型 #toolCard 初始无 .open 类）
  const [open, setOpen] = useState(false);
  // 本地化文案
  const { t } = useTranslation();

  // 从 tool-store 查找 title（主进程通过 AgentToolResultPayload 推送的人类可读标题）
  // 没有找到时回退到工具名（type）
  const title = useToolStore((s) => {
    for (const calls of s.callsBySession.values()) {
      const found = calls.find((c) => c.id === toolCallId);
      if (found !== undefined) return found.title;
    }
    return null;
  });

  // 状态映射：AI SDK state → .card-status 类 + 本地化文案
  const statusClass = mapToolStateToStatusClass(state);
  const statusLabel = mapToolStateToStatusLabelKey(state);
  const localizedStatusLabel = t(`chat.${statusLabel}`);

  return (
    <div className="msg msg-tool enter-anim">
      <div className="msg-body">
        <div className={cn('card tool-card', open && 'open')}>
          <button
            type="button"
            className="card-head"
            onClick={() => setOpen((v) => !v)}
            aria-label={t('chat.toggleToolDetails')}
            aria-expanded={open}
          >
            <span className="card-icon">🔧</span>
            <span className="card-title">{title ?? type}</span>
            <span className={cn('card-status', statusClass)}>{localizedStatusLabel}</span>
            <span className="tool-chev">▸</span>
          </button>
          <div className="card-body">
            {/* 入参（JSON 序列化，最多 200 字符避免膨胀） */}
            {input !== undefined && <CodeBlock label="input" content={formatJson(input, t)} />}
            {/* 输出（output 优先于 errorText） */}
            {output !== undefined && <CodeBlock label="output" content={formatJson(output, t)} />}
            {errorText !== undefined && errorText !== '' && (
              <CodeBlock label="error" content={errorText} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 工具状态映射 → 本地化 key（组件内 t(`chat.${key}`) 渲染）
 *
 * AI SDK 的 tool.state 可能值：
 * - 'input-streaming' / 'input-accepted'：输入阶段（等待）
 * - 'output-available'：完成（成功）
 * - 'output-error'：错误（error）
 */
function mapToolStateToStatusLabelKey(state: string): string {
  if (state === 'output-error') {
    return 'statusError';
  }
  if (state === 'output-available') {
    return 'statusSuccess';
  }
  if (state === 'input-streaming' || state === 'input-accepted') {
    return 'statusRunning';
  }
  return 'statusWaiting';
}

/**
 * 工具状态映射 → .card-status 类名
 *
 * AI SDK 的 tool.state 可能值：
 * - 'input-streaming' / 'input-accepted'：输入阶段（pending）
 * - 'output-available'：完成（success）
 * - 'output-error'：错误（error）
 */
function mapToolStateToStatusClass(state: string): string {
  if (state === 'output-error') {
    return 'error';
  }
  if (state === 'output-available') {
    return 'success';
  }
  if (state === 'input-streaming' || state === 'input-accepted') {
    return 'running';
  }
  return 'pending';
}

/**
 * 代码块（带标签 + 内容）
 *
 * 用于展示工具调用的 input / output / error。
 */
function CodeBlock({ label, content }: { label: string; content: string }): ReactElement {
  return (
    <div className="mt-1">
      <div className="text-muted-foreground font-mono text-2xs uppercase tracking-wider">
        {label}
      </div>
      <pre className="bg-background/50 text-foreground mt-0.5 overflow-x-auto rounded p-1.5 font-mono text-xs leading-snug">
        {content}
      </pre>
    </div>
  );
}

/**
 * 推理块（对齐原型 .reasoning-block）
 *
 * 折叠式：默认折叠，点击 head 切换 .open 类。
 * accent 左光条 + 等宽字体展示思考内容。
 */
function ReasoningBlock({ text, messageId }: { text: string; messageId: string }): ReactElement {
  // 折叠态：用户显式覆盖优先（L2 store，滚动卸载不丢失）；未覆盖时实时跟随实验设置
  const reasoningCollapsed = useSettingsStore((s) => s.experimental.reasoningCollapsed);
  const override = useReasoningCollapseStore((s) => s.overrides.get(messageId));
  const setCollapsed = useReasoningCollapseStore((s) => s.setCollapsed);
  const open = override === undefined ? !reasoningCollapsed : !override;
  // 本地化文案
  const { t } = useTranslation();

  return (
    <div className={cn('reasoning-block', open && 'open')}>
      <button
        type="button"
        className="reasoning-head"
        onClick={() => setCollapsed(messageId, open)}
        aria-expanded={open}
      >
        <span className="reasoning-title">{t('chat.thinking')}</span>
        <span className="rh-chevron ml-auto">▸</span>
      </button>
      <div className="reasoning-body">
        <div className="text-muted-foreground font-mono text-xs leading-relaxed whitespace-pre-wrap italic">
          {text}
        </div>
      </div>
    </div>
  );
}

/**
 * 流式占位
 *
 * streaming 状态时显示在消息列表末尾的 typing-indicator（三个 accent 点弹跳），
 * 表示助手正在生成回复。对齐原型 .msg.assistant + .typing-indicator 结构。
 */
