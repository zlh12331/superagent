// message-item.tsx（自 ChatMessageList 拆分）
// 聊天消息行编排：消息项 / part 分发 / 推理块
// ──────────────────────────────
// 子域拆分（2026-09-15 结构审计）：工具卡渲染移至 tool-call-view.tsx，
// 本文件只保留消息/part 编排职责。
// ──────────────────────────────

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
import { memo, type ReactElement, useMemo } from 'react';

import { useTranslation } from '@/i18n/use-translation';
import { extractText } from '@/lib/chat/message-text';
import { smoothEaseOut } from '@/lib/motion';
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

// 记忆化导出：消息未变化（引用不变）时跳过重渲染——
// 去 Virtuoso 后流式场景仅变化消息重渲染，避免全列表 Markdown 重新解析
export const MessageItem = memo(function MessageItem({
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
  // 本地化文案
  const { t } = useTranslation();
  // 当前模型（对齐原型 .msg-role 展示模型名）
  const defaultModel = useSettingsStore((state) => state.ai.defaultModel);

  // parts 预映射：生成稳定 key（含 index 但不暴露给 JSX key，规避 noArrayIndexKey）
  // 并标记**最后一个 part** 的流式光标（仅流式 assistant 消息；user/历史恒 false）。
  // 注意：光标只在走 text 分支的 part 上渲染，故末位 part 是 reasoning/tool 时
  // 不会出现光标（也不再回落到更早的 text part 上）——这是期望行为。
  const partsWithCursor = useMemo(
    () =>
      message.parts.map((part, index) => ({
        part,
        key: `${message.id}-${index}`,
        showCursor:
          message.role === 'assistant' && isStreaming && index === message.parts.length - 1,
      })),
    [message.parts, message.id, isStreaming, message.role],
  );

  if (message.role === 'user') {
    // user 消息：text 拼接为气泡内容；非 text parts（历史重建产生的孤儿
    // 工具结果 / 附件 file）此前一律不渲染——留下空气泡且工具卡丢失
    const text = extractText(message.parts);
    return (
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={smoothEaseOut}
        className="msg user enter-anim"
      >
        <div className="msg-body">
          {text.length > 0 && <div className="msg-content">{text}</div>}
          {partsWithCursor.map(({ part, key }) =>
            isTextUIPart(part) ? null : <PartView key={key} part={part} collapseKey={key} />,
          )}
        </div>
      </motion.div>
    );
  }

  if (message.role === 'assistant') {
    // assistant 消息：avatar + body（role + parts + actions）
    // 对齐原型 addMsgActions()：仅 assistant 消息显示 hover 操作栏
    // 连续 assistant 消息（isContinuation）：隐藏头像与角色标签，内容缩进对齐（照搬参考项目）
    return (
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={smoothEaseOut}
        className="msg assistant enter-anim"
      >
        {!isContinuation && (
          <div className="msg-avatar assistant" aria-hidden="true">
            C
          </div>
        )}
        <div className={cn('msg-body', isContinuation && 'ml-10')}>
          {/* 对齐原型 .msg-role（"codex · gpt-5-codex"）：品牌 · 当前模型 */}
          {!isContinuation && (
            <div className="msg-role assistant">
              {t('chat.assistant')} · {defaultModel}
            </div>
          )}
          {/* parts 列表：按 part 类型分别渲染；流式消息在最后一条文本 part 末尾加闪烁光标 */}
          {partsWithCursor.map(({ part, key, showCursor }) => (
            <PartView
              key={key}
              part={part}
              collapseKey={key}
              showCursor={showCursor}
              // 流式消息跳过高亮（对齐参考项目：流式期间跳过语法高亮，避免每 token 反复高亮）
              highlight={!isStreaming}
            />
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
});

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
  // 本地化文案
  const { t } = useTranslation();

  // 文本 part：Markdown 渲染（支持 GFM + 代码语法高亮）
  if (isTextUIPart(part)) {
    if (part.text.length === 0) {
      return <div className="msg-content" />;
    }
    return (
      <div className="msg-content">
        <Markdown content={part.text} highlight={highlight} />
        {/* 流式光标：当前消息正在输出时，文本末尾显示闪烁光标 */}
        {showCursor && <StreamingCursor />}
      </div>
    );
  }

  // 思考 part：.reasoning-block 折叠式推理块（折叠 key 到 part 级：一条消息可含多段思考）
  if (isReasoningUIPart(part)) {
    return <ReasoningBlock text={part.text} collapseKey={collapseKey} />;
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
          <span className="card-icon" aria-hidden="true">
            📎
          </span>
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
  // 折叠态：用户显式覆盖优先（L2 store，滚动卸载不丢失）；未覆盖时实时跟随实验设置
  const reasoningCollapsed = useSettingsStore((s) => s.experimental.reasoningCollapsed);
  const override = useReasoningCollapseStore((s) => s.overrides.get(collapseKey));
  const setCollapsed = useReasoningCollapseStore((s) => s.setCollapsed);
  const open = override === undefined ? !reasoningCollapsed : !override;
  // 本地化文案
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
