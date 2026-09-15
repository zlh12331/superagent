// src/renderer/components/chat/ChatInput.tsx
// 聊天输入框 + 发送/停止按钮 · Aurora 设计系统
// ─────────────────────────────────────────────
// 约束（调用方须知）：
// - 不在此组件内调用 useChat，所有状态由父组件（ChatPanel）传入
// - 纯展示+交互，可在测试中独立 mock；sendMessage/stop 签名与 useChat 返回值对齐
// - 本组件只做「编排 composer 各 hook + JSX」：input（值/附件/草稿）、
//   drag（高度）、suggest（斜杠/提及）、vim（编辑模式）、send（发送管线）
// ──────────────────────────────────────────────

import { AtSign, Send, Slash, Square } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type KeyboardEvent, type ReactElement, useEffect, useRef } from 'react';
import { useTranslation } from '@/i18n/use-translation';
import { unwrap } from '@/lib/ipc';
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
  // 本地化文案
  const { t } = useTranslation();
  // vim 模式（settings.editor.vimMode 真实消费——此前仅存储无行为）
  const vimEnabled = useSettingsStore((s) => s.editor.vimMode);
  // 输入状态（值 + 附件 + 草稿，自 ChatInput 拆出：use-composer-input.ts）
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
  // 占位符：props 优先，缺省走 i18n
  const effectivePlaceholder = placeholder ?? t('chat.inputPlaceholder');

  // textarea ref：用于 auto-resize + 快捷 pill 预填后聚焦
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // vim 模式状态机（自 ChatInput 拆出：use-vim-mode.ts）
  const { vimState, pendingCursor, processKey, clearPendingCursor } = useVimMode({
    setValue,
  });

  // vim 光标落点：值渲染完成后应用（受控/非受控通用；同时聚焦保持操作连续性）
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
    // 自动增长封顶：手动拖拽/键盘设置过 maxHeight 时跟随手动档，否则默认 240px
    const manualCap = Number.parseFloat(el.style.maxHeight);
    const cap =
      Number.isFinite(manualCap) && manualCap > 0
        ? Math.max(COMPOSER_AUTO_MAX, manualCap)
        : COMPOSER_AUTO_MAX;
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
  };

  // ── 斜杠/提及建议状态机（自 ChatInput 拆出：use-composer-suggest.ts）──
  // 职责：触发检测 / 候选过滤 / 键盘高亮 / 应用建议（Esc 只清触发段保留其余输入）
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

  // 值变化后 auto-resize
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅在 value 变化时 resize
  useEffect(() => {
    autoResize();
  }, [value]);

  // 是否处于流式状态（显示停止按钮）
  const isStreaming = status === 'streaming' || status === 'submitted';

  // 流式期间 window 级 Esc 监听：textarea 未聚焦时也可中断生成
  // （对齐原型 composer-hint "Esc 中断"；disabled 元素收不到键盘事件的补充通道）
  useEffect(() => {
    if (!isStreaming) {
      return;
    }
    const onWindowKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        onStop();
      }
    };
    window.addEventListener('keydown', onWindowKeyDown);
    return () => {
      window.removeEventListener('keydown', onWindowKeyDown);
    };
  }, [isStreaming, onStop]);

  // 发送管线（自 ChatInput 拆出：use-composer-send.ts）
  // 职责：in-flight 守卫 / 超长拦截 / 附件拼接 / 清草稿与输入（三路径统一复位）
  const { canSend, handleSend } = useComposerSend({
    value,
    attachments,
    chatId,
    clearInput,
    onSend,
    isStreaming,
    disabled,
  });

  /** 选择附件（原生文件选择器多选；浏览器模式 window.api 缺失时静默跳过） */
  const handlePickFiles = async (): Promise<void> => {
    if (typeof window === 'undefined' || window.api === undefined) return;
    try {
      // 选择器错误响应/取消均静默（非关键路径，用户可重试）
      const data = unwrap(await window.api.dialog.pickFiles({ multiple: true }));
      if (data.canceled || data.paths === undefined || data.paths.length === 0) return;
      pickAttachments(data.paths);
    } catch {
      // 选择器错误/取消：静默失败（非关键路径，用户可重试）
      // 注：此处不写 `return`——函数已到末尾，bare return 是死语句（noUselessReturn）
    }
  };

  /** 输入框高度拖拽（use-composer-drag.ts：手柄事件 props） */
  const { handleProps: dragHandleProps } = useComposerDrag(textareaRef);

  /**
   * 键盘事件处理
   *
   * - Enter（无 Shift）：发送消息，阻止默认换行
   * - Shift+Enter：换行（默认行为，不阻止）
   * - Esc（流式状态）：中断生成，对齐原型 composer-hint "Esc 中断"
   */
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // ── vim 模式分支（normal 态拦截全部按键；insert 态仅 Esc 切回 normal）──
    if (vimEnabled) {
      // 流式中 Esc 仍走原逻辑（中断生成），vim 不吞掉
      const isStreamEsc = event.key === 'Escape' && isStreaming;
      // 带修饰键的组合（复制/粘贴/全选/系统快捷键）不进 vim 状态机：
      // vim 键表无修饰键概念，Ctrl+V 会命中 'v' 被吞，Ctrl+A 会误入 insert
      if (!isStreamEsc && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const consumed = processKey(
          { key: event.key, selectionStart: event.currentTarget.selectionStart },
          value,
        );
        if (consumed) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
    }
    // 流式状态按 Esc：中断生成
    if (event.key === 'Escape' && isStreaming) {
      event.preventDefault();
      onStop();
      return;
    }
    // 建议面板键盘处理（方向键/录入/Esc）
    if (handleSuggestKeyDown(event)) {
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
    <div className={cn('composer-box relative', className)}>
      {/* 输入框高度拖拽手柄（use-composer-drag.ts：拖拽/双击重置/键盘步进，语义 hr + separator） */}
      <hr
        className="composer-drag-handle"
        aria-label={t('chat.resizeComposer')}
        tabIndex={0}
        {...dragHandleProps}
      />
      {/* 斜杠/提及建议下拉（自 ChatInput 拆出：slash-suggest-panel.tsx） */}
      <SlashSuggestPanel
        trigger={activeTrigger}
        slashSuggestions={filteredSuggestions}
        mentionFiles={mentionFiles}
        activeIndex={suggestIndex}
        onSelectCommand={applySuggestion}
        onSelectFile={applyMention}
      />
      {/* 建议面板当前高亮项的播报：combobox 焦点模型在 textarea 上不合法
          （ARIA in HTML 不允许覆盖 textbox 角色），故用 sr-only live region
          满足 4.1.3 Status Messages——键盘上下移动高亮时读屏可听到当前项 */}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {suggestOpen && activeSuggestionLabel !== ''
          ? t('chat.suggestAnnounce', {
              current: suggestIndex + 1,
              total: suggestionTotal,
              label: activeSuggestionLabel,
            })
          : ''}
      </span>
      {/* 附件 chip 列表（自 ChatInput 拆出：attachments-chips.tsx） */}
      <AttachmentsChips attachments={attachments} onRemove={removeAttachment} />
      {/* 文本域：.composer-input（透明背景，focus 时 box 上浮发光）
          ref 必须绑定：autoResize 依赖 textareaRef 调整高度（此前漏绑定导致多行不增高） */}
      <textarea
        ref={textareaRef}
        className="composer-input"
        rows={1}
        aria-label={t('chat.inputLabel')}
        // 输入框 ↔ 建议面板的程序化关联（aria-controls 是 ARIA 全局属性，合法）；
        // 不用 combobox 角色：ARIA in HTML 规定 textarea 不允许覆盖 textbox 角色，
        // 故当前高亮项改由下方 sr-only live region 播报（见 suggestAnnounce）
        aria-controls={suggestOpen ? 'chat-input-suggest' : undefined}
        id="chat-input"
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        placeholder={effectivePlaceholder}
        value={value}
        // 流式期间不禁用输入框（对齐原型：允许预输入下一条；
        // disabled 会吞掉键盘事件导致 Esc 中断失效——Esc 由 window 级监听处理）
        disabled={disabled}
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
              // 点击斜杠按钮：以 / 开头打开建议面板（对齐原型 suggest-pop）
              // 已有输入时前缀而非覆盖——覆盖会吞掉用户已输入的全文（不可撤销）
              setValue(value.startsWith('/') ? value : `/${value}`);
              textareaRef.current?.focus();
              autoResize();
            }}
          >
            <Slash className="size-4" strokeWidth={1.5} />
          </button>
        </div>
        {/* 快捷键提示（等宽字体 kbd） */}
        <span className="composer-hint">
          {vimEnabled && (
            <span
              className={cn('vim-mode-badge', vimState.mode === 'insert' && 'insert')}
              role="status"
            >
              {vimState.mode === 'normal' ? t('chat.vimNormal') : t('chat.vimInsert')}
            </span>
          )}
          <kbd>⏎</kbd> {t('chat.send')} · <kbd>⇧⏎</kbd> {t('chat.newline')}
          {isStreaming ? (
            <>
              {' · '}
              <kbd>Esc</kbd> {t('chat.interrupt')}
            </>
          ) : null}
        </span>
        {/* 右区：模型选择 + 发送按钮（整体右对齐，用户要求模型紧贴发送按钮左侧） */}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {rightSlot}
          {/* 发送/停止按钮切换：AnimatePresence 实现图标旋转淡入 + 弹簧按压缩放
               （MotionVault button 类交互、motion.dev react-hover-animation 官方模式） */}
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
