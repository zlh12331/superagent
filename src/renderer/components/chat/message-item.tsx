import type { UIMessage } from 'ai';
import {
  isDynamicToolUIPart,
  isFileUIPart,
  isReasoningUIPart,
  isStaticToolUIPart,
  isTextUIPart,
} from 'ai';
import type { ReactElement } from 'react';

import { useTranslation } from '@/i18n/use-translation';
import { extractText } from '@/lib/chat/message-text';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { useReasoningCollapseStore } from '@/stores/transient/reasoning-collapse-store';
import { FileChangeCard } from './file-change-card';
import { Markdown } from './Markdown';
import { MsgActions } from './message-actions';
import { StreamingCursor } from './streaming-cursor';
import { ToolCallView } from './tool-call-view';

/** part 类型（UIMessage['parts'][number] 派生） */
type UIMessagePart = UIMessage['parts'][number];

/**
 * 单条消息行渲染（user / assistant / system 分发 + parts 展示）
 *
 * 组件级记忆化交给 React Compiler（props 未变时跳过重渲染，覆盖原 memo() 目标）。
 */
export function MessageItem({
  message,
  onRegenerate,
  disableActions,
  isStreaming = false,
  isContinuation = false,
}: {
  message: UIMessage;
  onRegenerate: ((messageId: string) => void) | undefined;
  disableActions: boolean;
  /** 是否为正在流式输出的消息（ChatMessageList 对最后一条 assistant 传入） */
  isStreaming?: boolean;
  /** 是否为连续 assistant 消息（前一条也是 assistant，隐藏头像与角色标签；照搬参考项目 isContinuation） */
  isContinuation?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const defaultModel = useSettingsStore((state) => state.ai.defaultModel);

  const partsWithCursor = message.parts.map((part, index) => ({
    part,
    key: `${message.id}-${index}`,
    showCursor: message.role === 'assistant' && isStreaming && index === message.parts.length - 1,
  }));

  if (message.role === 'user') {
    const text = extractText(message.parts);
    return (
      <div className="msg user enter-anim">
        <div className="msg-body">
          {text.length > 0 && <div className="msg-content">{text}</div>}
          {partsWithCursor.map(({ part, key }) =>
            isTextUIPart(part) ? null : <PartView key={key} part={part} collapseKey={key} />,
          )}
        </div>
      </div>
    );
  }

  if (message.role === 'assistant') {
    return (
      <div className="msg assistant enter-anim">
        {!isContinuation && (
          <div className="msg-avatar assistant" aria-hidden="true">
            C
          </div>
        )}
        <div className={cn('msg-body', isContinuation && 'ml-10')}>
          {!isContinuation && (
            <div className="msg-role assistant">
              {t('chat.assistant')} · {defaultModel}
            </div>
          )}
          {partsWithCursor.map(({ part, key, showCursor }) => (
            <PartView
              key={key}
              part={part}
              collapseKey={key}
              showCursor={showCursor}
              highlight={!isStreaming}
            />
          ))}
          <MsgActions
            text={extractText(message.parts)}
            messageId={message.id}
            onRegenerate={onRegenerate}
            disabled={disableActions}
          />
        </div>
      </div>
    );
  }

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
  collapseKey,
  showCursor = false,
  highlight = true,
}: {
  part: UIMessagePart;
  /** 折叠态 key（`${message.id}-${index}`，part 级：同消息多个推理块各自独立） */
  collapseKey: string;
  /** 流式光标：仅最后一条 text part 渲染（照搬参考项目 StreamingCursor） */
  showCursor?: boolean;
  /** 是否启用代码块语法高亮（流式消息传 false，对齐参考项目流式跳过高亮） */
  highlight?: boolean;
}): ReactElement {
  const { t } = useTranslation();

  if (isTextUIPart(part)) {
    if (part.text.length === 0) {
      return <div className="msg-content" />;
    }
    return (
      <div className="msg-content">
        <Markdown content={part.text} highlight={highlight} />
        {showCursor && <StreamingCursor />}
      </div>
    );
  }

  if (isReasoningUIPart(part)) {
    return <ReasoningBlock text={part.text} collapseKey={collapseKey} />;
  }

  if (isStaticToolUIPart(part)) {
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

  if (isFileUIPart(part)) {
    return (
      <div className="card">
        <div className="card-head">
          <span className="card-icon" aria-hidden="true">
            📎
          </span>
          <span className="card-title">{t('chat.attachment')}</span>
          <span className="card-status pending">{part.mediaType}</span>
        </div>
      </div>
    );
  }

  if (part.type === 'step-start') {
    return (
      <div className="border-border my-2 flex items-center gap-2 border-t pt-1">
        <span className="text-muted-foreground font-mono text-xs italic">{t('chat.nextStep')}</span>
      </div>
    );
  }

  return (
    <div className="text-muted-foreground font-mono text-xs italic">
      {t('chat.unknownPart', { type: part.type })}
    </div>
  );
}

/**
 * 工具调用卡片已提取至 tool-call-view.tsx（ToolCallView + CodeBlock + COMMAND_TOOLS）
 */

/**
 * 推理块（对齐原型 .reasoning-block）
 *
 * 折叠式：默认折叠，点击 head 切换 .open 类。
 * accent 左光条 + 等宽字体展示思考内容。
 */
function ReasoningBlock({
  text,
  collapseKey,
}: {
  text: string;
  collapseKey: string;
}): ReactElement {
  const reasoningCollapsed = useSettingsStore((s) => s.experimental.reasoningCollapsed);
  const override = useReasoningCollapseStore((s) => s.overrides.get(collapseKey));
  const setCollapsed = useReasoningCollapseStore((s) => s.setCollapsed);
  const open = override === undefined ? !reasoningCollapsed : !override;
  const { t } = useTranslation();

  return (
    <div className={cn('reasoning-block', open && 'open')}>
      <button
        type="button"
        className="reasoning-head"
        onClick={() => setCollapsed(collapseKey, open)}
        aria-expanded={open}
      >
        <span className="reasoning-title">{t('chat.thinking')}</span>
        <span className="rh-chevron ml-auto" aria-hidden="true">
          ▸
        </span>
      </button>
      <div className="reasoning-body">
        <div className="text-muted-foreground font-mono text-xs leading-relaxed whitespace-pre-wrap italic">
          {text}
        </div>
      </div>
    </div>
  );
}
