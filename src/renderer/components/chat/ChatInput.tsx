import { AtSign, Send, Slash, Square } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type KeyboardEvent, type ReactElement, useEffect, useRef } from 'react';
import { useLatestRef } from '@/hooks/use-latest-ref';
import { useTranslation } from '@/i18n/use-translation';
import { pickFiles } from '@/lib/dialog-actions';
import { microTransition, springTransition } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { AttachmentsChips } from './attachments-chips';
import { SlashSuggestPanel } from './slash-suggest-panel';
import type { SlashAction } from './slash-suggestions';
import { COMPOSER_AUTO_MAX, useComposerDrag } from './use-composer-drag';
import { useComposerInput } from './use-composer-input';
import { useComposerSend } from './use-composer-send';
import { useComposerSuggest } from './use-composer-suggest';
import { useVimMode } from './use-vim-mode';

/**
 * 是否正在 IME 组合中（中文/日文输入法候选窗）
 *
 * React 合成事件不暴露 isComposing，须读原生事件。组合态内按 Enter（选词）/
 * Esc（取消候选）不应被当作「发送」/「中断生成」处理，否则中文用户
 * 「打拼音按 Enter 上字」会把半截文本发出去。
 */
function isImeComposing(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  return event.nativeEvent.isComposing;
}

/**
 * 是否为「发送」快捷键（Enter，且不带 Shift/Ctrl/Cmd/Alt）
 *
 * 排除 Alt 与 handleVimKey 的判定保持一致（那里显式排除 altKey）：Alt+Enter
 * 在 Windows 上是系统级组合键语义，不应被本应用当发送处理。
 */
function isSendShortcut(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  return (
    event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
  );
}

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
   * 会话 id（草稿持久化 key；对齐参考项目 useDraftStore）
   *
   * 提供时：输入文本/附件按会话保存，切换会话恢复草稿，发送成功清除。
   * 欢迎页（无会话）不传——无草稿语义。
   */
  chatId?: string;
  /**
   * 工作目录（可选，@ 文件补全用）
   * 提供时输入 @ 触发 search.glob 文件建议（照搬参考项目 mention 补全）
   */
  workingDir?: string;
  /**
   * 斜杠命令回调（对齐参考项目：/new /clear 等命令可执行）
   *
   * 点击带 action 的建议项时触发（不填充文本）；父组件实现具体动作。
   */
  onSlashCommand?: (action: SlashAction) => void;
  /**
   * 受控值（可选）
   *
   * 提供时切换为受控模式，由父组件管理输入值（如欢迎页快捷 pill 预填）。
   * 不提供时保持内部 state（默认行为，兼容 ChatPanel 现有用法）。
   */
  value?: string;
  /** 受控值变更回调（受控模式必需） */
  onValueChange?: (value: string) => void;
  /**
   * 外部注入值（可选，非受控模式下使用）
   *
   * 提供非 undefined 的新值时同步一次到内部值（保持非受控，不破坏草稿语义）。
   * 对齐参考项目 P2-10：审批拒绝后「编辑重提」把命令填入 composer。
   */
  injectedValue?: string;
  /**
   * 右区插槽（可选）：渲染在发送按钮左侧（用户要求：模型选择等控件放输入框内）
   */
  rightSlot?: ReactElement;
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
  chatId,
  workingDir,
  onSlashCommand,
  injectedValue,
  rightSlot,
}: ChatInputProps): ReactElement {
  const { t } = useTranslation();
  const vimEnabled = useSettingsStore((s) => s.editor.vimMode);
  const {
    value,
    setValue,
    attachments,
    pickAttachments,
    removeAttachment,
    clear: clearInput,
  } = useComposerInput({
    chatId,
    controlledValue,
    onValueChange,
    injectedValue,
  });
  const effectivePlaceholder = placeholder ?? t('chat.inputPlaceholder');

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { vimState, pendingCursor, processKey, clearPendingCursor } = useVimMode({
    setValue,
  });

  useEffect(() => {
    if (pendingCursor === null) return;
    const el = textareaRef.current;
    if (el !== null) {
      el.setSelectionRange(pendingCursor, pendingCursor);
      el.focus();
    }
    clearPendingCursor();
  }, [pendingCursor, clearPendingCursor]);

  /** 自动调整 textarea 高度（对齐原型 input.style.height = 'auto' + scrollHeight）
   *
   * - 最小 1 行（约 38px）
   * - 最大 8 行（约 240px，超过则滚动）
   * - 每次值变化后调用
   */
  const autoResize = (): void => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = 'auto';
    const manualCap = Number.parseFloat(el.style.maxHeight);
    const cap =
      Number.isFinite(manualCap) && manualCap > 0
        ? Math.max(COMPOSER_AUTO_MAX, manualCap)
        : COMPOSER_AUTO_MAX;
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
  };

  const {
    activeTrigger,
    suggestOpen,
    filteredSuggestions,
    mentionFiles,
    suggestIndex,
    activeSuggestionLabel,
    suggestionTotal,
    applySuggestion,
    applyMention,
    handleSuggestKeyDown,
  } = useComposerSuggest({
    value,
    setValue,
    workingDir,
    onSlashCommand,
    textareaRef,
    onAfterChange: autoResize,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅在 value 变化时 resize
  useEffect(() => {
    autoResize();
  }, [value]);

  const isStreaming = status === 'streaming' || status === 'submitted';

  const onStopRef = useLatestRef(onStop);

  // biome-ignore lint/correctness/useExhaustiveDependencies: ref.current 是受控的 latest-ref 读取
  useEffect(() => {
    if (!isStreaming) {
      return;
    }
    const onWindowKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.isComposing) return;
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        onStopRef.current();
      }
    };
    window.addEventListener('keydown', onWindowKeyDown);
    return () => {
      window.removeEventListener('keydown', onWindowKeyDown);
    };
  }, [isStreaming]);

  const { canSend, handleSend } = useComposerSend({
    value,
    attachments,
    chatId,
    clearInput,
    onSend,
    isStreaming,
    disabled,
  });

  /** 选择附件（原生文件选择器多选；浏览器模式无桥时 pickFiles 返回 canceled） */
  const handlePickFiles = async (): Promise<void> => {
    try {
      const data = await pickFiles({ multiple: true });
      if (data.canceled || data.paths === undefined || data.paths.length === 0) return;
      pickAttachments(data.paths);
    } catch {}
  };

  /** 输入框高度拖拽（use-composer-drag.ts：手柄事件 props） */
  const { handleProps: dragHandleProps } = useComposerDrag(textareaRef);

  /**
   * vim 模式按键处理
   *
   * @returns 是否已消费该按键（true = 调用方直接 return，不再走后续分支）
   */
  const handleVimKey = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const isStreamEsc = event.key === 'Escape' && isStreaming;
    if (isStreamEsc || event.ctrlKey || event.metaKey || event.altKey) return false;
    const consumed = processKey(
      { key: event.key, selectionStart: event.currentTarget.selectionStart },
      value,
    );
    if (!consumed) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  /**
   * 键盘事件处理
   *
   * - Enter（无 Shift）：发送消息，阻止默认换行
   * - Shift+Enter：换行（默认行为，不阻止）
   * - Esc（流式状态）：中断生成，对齐原型 composer-hint "Esc 中断"
   */
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeComposing(event)) return;

    if (vimEnabled && handleVimKey(event)) return;

    if (event.key === 'Escape' && isStreaming) {
      event.preventDefault();
      onStop();
      return;
    }
    if (handleSuggestKeyDown(event)) {
      return;
    }
    if (isSendShortcut(event)) {
      event.preventDefault();
      handleSend();
    }
  };

  return (
    <div className={cn('composer-box relative', className)}>
      <hr
        className="composer-drag-handle"
        aria-label={t('chat.resizeComposer')}
        tabIndex={0}
        {...dragHandleProps}
      />
      <SlashSuggestPanel
        trigger={activeTrigger}
        slashSuggestions={filteredSuggestions}
        mentionFiles={mentionFiles}
        activeIndex={suggestIndex}
        onSelectCommand={applySuggestion}
        onSelectFile={applyMention}
      />
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {suggestOpen && activeSuggestionLabel !== ''
          ? t('chat.suggestAnnounce', {
              current: suggestIndex + 1,
              total: suggestionTotal,
              label: activeSuggestionLabel,
            })
          : ''}
      </span>
      <AttachmentsChips attachments={attachments} onRemove={removeAttachment} />
      <textarea
        ref={textareaRef}
        className="composer-input"
        rows={1}
        aria-label={t('chat.inputLabel')}
        aria-controls={suggestOpen ? 'chat-input-suggest' : undefined}
        id="chat-input"
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        placeholder={effectivePlaceholder}
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="composer-bar">
        <div className="composer-tools">
          <button
            type="button"
            className="composer-tool-btn"
            aria-label={t('chat.attachFile')}
            title={`${t('chat.attachFile')} (@)`}
            onClick={() => {
              void handlePickFiles();
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
              setValue(value.startsWith('/') ? value : `/${value}`);
              textareaRef.current?.focus();
              autoResize();
            }}
          >
            <Slash className="size-4" strokeWidth={1.5} />
          </button>
        </div>
        <span className="composer-hint">
          {vimEnabled && (
            <span
              className={cn('vim-mode-badge', vimState.mode === 'insert' && 'insert')}
              role="status"
            >
              {vimState.mode === 'normal' ? t('chat.vimNormal') : t('chat.vimInsert')}
            </span>
          )}
          <kbd>Enter</kbd> {t('chat.send')} · <kbd>Shift+Enter</kbd> {t('chat.newline')}
          {isStreaming ? (
            <>
              {' · '}
              <kbd>Esc</kbd> {t('chat.interrupt')}
            </>
          ) : null}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {rightSlot}
          <AnimatePresence mode="wait" initial={false}>
            {isStreaming ? (
              <motion.button
                key="stop"
                type="button"
                className="stop-gen-btn"
                onClick={onStop}
                aria-label={t('chat.stopGenerating')}
                title={t('chat.stopGenerating')}
                whileHover={{ scale: 1.06 }}
                whileTap={{ scale: 0.92 }}
                transition={springTransition}
              >
                <motion.span
                  className="inline-flex"
                  initial={{ rotate: -90, opacity: 0 }}
                  animate={{ rotate: 0, opacity: 1 }}
                  exit={{ rotate: 90, opacity: 0 }}
                  transition={microTransition}
                >
                  <Square className="size-3.5" strokeWidth={2.5} fill="currentColor" />
                </motion.span>
              </motion.button>
            ) : (
              <motion.button
                key="send"
                type="button"
                className="send-btn"
                disabled={!canSend}
                onClick={handleSend}
                aria-label={t('chat.sendMessage')}
                title={t('chat.send')}
                {...(canSend ? { whileHover: { scale: 1.06 }, whileTap: { scale: 0.92 } } : {})}
                transition={springTransition}
              >
                <motion.span
                  className="inline-flex"
                  initial={{ rotate: 90, opacity: 0 }}
                  animate={{ rotate: 0, opacity: 1 }}
                  exit={{ rotate: -90, opacity: 0 }}
                  transition={microTransition}
                >
                  <Send className="size-3.5" strokeWidth={2.5} />
                </motion.span>
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
