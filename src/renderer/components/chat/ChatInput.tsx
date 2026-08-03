// src/renderer/components/chat/ChatInput.tsx
// 聊天输入框 + 发送 / 停止按钮 · Aurora 设计系统
// ──────────────────────────────────────────────────────────────
// 职责：
// - 多行文本输入（Enter 发送，Shift+Enter 换行）
// - 流式状态时显示"停止"按钮，否则显示"发送"按钮
// - 字符计数（>2000 警告，对齐原型 .char-count）
// - Esc 中断流式生成（对齐原型 composer-hint "Esc 中断"）
// - 透传 disabled / placeholder 等原生属性
//
// 设计（对齐原型 docs/prototype/prototype-v2.html）：
// - 容器：.composer（顶部渐变 + 底部 padding）
// - 输入舱：.composer-box（悬浮卡片 + focus 发光 + 上浮）
// - 文本域：.composer-input（透明背景，focus 时 box 上浮发光）
// - 工具栏：.composer-bar > .composer-hint + .send-btn / .stop-gen-btn
// - 发送按钮：.send-btn（双 accent 渐变 + 发光）
// - 停止按钮：.stop-gen-btn（error 色 + 红色发光）
// ──────────────────────────────────────────────────────────────
//
// 说明：
// - 不在此组件内调用 useChat，所有状态由父组件（ChatPanel）传入
// - 这样 ChatInput 是纯展示+交互组件，可在测试中独立 mock
// - sendMessage / stop 回调签名与 useChat 返回值对齐

import { AtSign, Send, Slash, Square } from 'lucide-react';
import { type KeyboardEvent, type ReactElement, useEffect, useRef, useState } from 'react';

import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

interface ChatInputProps {
  /**
   * 当前流式状态
   * - 'ready' / 'error' / 'submitted'：显示发送按钮
   * - 'streaming'：显示停止按钮
   */
  status: 'submitted' | 'streaming' | 'ready' | 'error';
  /** 发送消息回调（传入文本） */
  onSend: (text: string) => void;
  /** 停止流式回调（父组件调用 useChat().stop） */
  onStop: () => void;
  /** 占位提示文字 */
  placeholder?: string;
  /** 是否禁用（如未配置 API Key 时） */
  disabled?: boolean;
  /** 自定义容器类名 */
  className?: string;
  /**
   * 受控值（可选）
   *
   * 提供时切换为受控模式，由父组件管理输入值（如欢迎页快捷 pill 预填）。
   * 不提供时保持内部 state（默认行为，兼容 ChatPanel 现有用法）。
   */
  value?: string;
  /** 受控值变更回调（受控模式必需） */
  onValueChange?: (value: string) => void;
}

/**
 * 聊天输入框组件
 *
 * @example
 * ```tsx
 * <ChatInput
 *   status={status}
 *   onSend={(text) => sendMessage({ text })}
 *   onStop={stop}
 *   placeholder="输入消息..."
 * />
 * ```
 */
export function ChatInput({
  status,
  onSend,
  onStop,
  placeholder,
  disabled = false,
  className,
  value: controlledValue,
  onValueChange,
}: ChatInputProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  // 占位符：props 优先，缺省走 i18n
  const effectivePlaceholder = placeholder ?? t('chat.inputPlaceholder');
  // 输入文本：受控模式（controlledValue 提供）或内部 state（默认）
  // 受控模式用于欢迎页快捷 pill 预填场景，ChatPanel 保持非受控以避免父级重渲染
  const [internalValue, setInternalValue] = useState('');
  const isControlled = controlledValue !== undefined;
  const value = isControlled ? controlledValue : internalValue;

  // textarea ref：用于 auto-resize + 快捷 pill 预填后聚焦
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /** 更新值：受控模式触发回调，非受控模式更新内部 state */
  const setValue = (next: string): void => {
    if (!isControlled) {
      setInternalValue(next);
    }
    onValueChange?.(next);
  };

  /**
   * 自动调整 textarea 高度（对齐原型 input.style.height = 'auto' + scrollHeight）
   *
   * - 最小 1 行（约 38px）
   * - 最大 8 行（约 240px，超过则滚动）
   * - 每次值变化后调用
   */
  const autoResize = (): void => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  };

  // 值变化后 auto-resize
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅在 value 变化时 resize
  useEffect(() => {
    autoResize();
  }, [value]);

  // 是否处于流式状态（显示停止按钮）
  const isStreaming = status === 'streaming' || status === 'submitted';

  // 是否可以发送（非空文本 + 非流式 + 未禁用）
  const canSend = value.trim().length > 0 && !isStreaming && !disabled;

  // 字符计数（对齐原型 #charCount：trim 后长度，>2000 警告）
  const charCount = value.trim().length;
  const isOverLimit = charCount > 2000;

  /**
   * 发送当前文本
   *
   * 清空输入框并触发 onSend 回调。
   * 若文本为空或处于流式状态，直接返回。
   */
  const handleSend = () => {
    if (!canSend) {
      return;
    }
    onSend(value);
    setValue('');
  };

  /**
   * 键盘事件处理
   *
   * - Enter（无 Shift）：发送消息，阻止默认换行
   * - Shift+Enter：换行（默认行为，不阻止）
   * - Esc（流式状态）：中断生成，对齐原型 composer-hint "Esc 中断"
   */
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 流式状态按 Esc：中断生成
    if (event.key === 'Escape' && isStreaming) {
      event.preventDefault();
      onStop();
      return;
    }
    // Enter 且无 Shift / Ctrl / Cmd 同时按：发送
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      handleSend();
    }
  };

  return (
    // .composer：输入舱外壳（顶部渐变 + 底部 padding，由父级 footer 提供）
    // 此处仅渲染 .composer-box 内层（外层 .composer 由 ChatPanel footer 提供）
    <div className={cn('composer-box', className)}>
      {/* 文本域：.composer-input（透明背景，focus 时 box 上浮发光） */}
      <textarea
        className="composer-input"
        rows={1}
        aria-label={t('chat.inputLabel')}
        id="chat-input"
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        placeholder={effectivePlaceholder}
        value={value}
        disabled={disabled || isStreaming}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      {/* 工具栏：.composer-bar（顶部发丝分隔 + 右对齐按钮） */}
      <div className="composer-bar">
        {/* 左侧：composer-tools（attach-btn + slash-btn，对齐原型输入舱工具按钮） */}
        <div className="composer-tools">
          <button
            type="button"
            className="composer-tool-btn"
            aria-label={t('chat.attachFile')}
            title={`${t('chat.attachFile')} (@)`}
            onClick={() => {
              /* 功能预留：后续接入文件选择器 */
            }}
          >
            <AtSign className="size-4" strokeWidth={1.5} />
          </button>
          <button
            type="button"
            className="composer-tool-btn"
            aria-label={t('chat.slashCommand')}
            title={`${t('chat.slashCommand')} (/)`}
            onClick={() => {
              setValue(`${value}/`);
              autoResize();
            }}
          >
            <Slash className="size-4" strokeWidth={1.5} />
          </button>
        </div>
        {/* 快捷键提示（等宽字体 kbd） */}
        <span className="composer-hint">
          <kbd>⏎</kbd> {t('chat.send')} · <kbd>⇧⏎</kbd> {t('chat.newline')}
          {isStreaming ? (
            <>
              {' · '}
              <kbd>Esc</kbd> {t('chat.interrupt')}
            </>
          ) : null}
        </span>
        {/* 字符计数（对齐原型 .char-count：trim 后长度，>2000 警告） */}
        <span className={cn('char-count', isOverLimit && 'warn')} aria-live="polite">
          {charCount > 0 ? charCount : ''}
        </span>
        {/* 右侧：发送 / 停止按钮（margin-left:auto 推到右侧） */}
        {isStreaming ? (
          <button
            type="button"
            className="stop-gen-btn"
            onClick={onStop}
            aria-label={t('chat.stopGenerating')}
            title={t('chat.stopGenerating')}
            style={{ marginLeft: 'auto' }}
          >
            <Square className="size-3.5" strokeWidth={2.5} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            className="send-btn"
            disabled={!canSend}
            onClick={handleSend}
            aria-label={t('chat.sendMessage')}
            title={t('chat.send')}
            style={{ marginLeft: 'auto' }}
          >
            <Send className="size-3.5" strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  );
}
