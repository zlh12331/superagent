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

import { AtSign, FileText, Send, Slash, Square, X } from 'lucide-react';
import { type KeyboardEvent, type ReactElement, useEffect, useRef, useState } from 'react';

import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

/** 附件项（对齐参考项目 ChatInputAttachments） */
interface ChatAttachment {
  /** 绝对路径（发送时 file:read 读取内容） */
  readonly path: string;
  /** 展示名称（路径 basename） */
  readonly name: string;
}

/** 附件内容读取上限（字符，超出截断避免消息膨胀） */
const ATTACHMENT_MAX_CHARS = 4000;

/** 输入框拖拽高度下限（单行，约 40px） */
const COMPOSER_MIN_H = 40;
/** 输入框拖拽高度上限（对齐原型 maxExtra 300 + 基础 160） */
const COMPOSER_MAX_H = 460;

/** 斜杠命令建议项 */
interface SlashSuggestion {
  readonly command: string;
  readonly labelKey: string;
}

/** 斜杠命令建议列表（对齐参考项目 useSlashSuggest；命令执行链路为后续增强） */
const SLASH_SUGGESTIONS: readonly SlashSuggestion[] = [
  { command: '/help', labelKey: 'chat.slashSuggest.help' },
  { command: '/new', labelKey: 'chat.slashSuggest.newChat' },
  { command: '/clear', labelKey: 'chat.slashSuggest.clear' },
  { command: '/compact', labelKey: 'chat.slashSuggest.compact' },
  { command: '/models', labelKey: 'chat.slashSuggest.models' },
];

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
  // 附件列表（对齐参考项目 ChatInputAttachments：选择 → chip 展示 → 发送时读取拼接）
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
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
    const cap = Number.isFinite(manualCap) && manualCap > 0 ? Math.max(240, manualCap) : 240;
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
  };

  // ── 斜杠建议状态（对齐参考项目 useSlashSuggest 交互）──
  // 输入以 / 开头且当前段无空格时显示建议下拉
  const slashPrefix = value.startsWith('/') && !value.includes(' ') ? value : null;
  const filteredSuggestions =
    slashPrefix !== null ? SLASH_SUGGESTIONS.filter((s) => s.command.startsWith(slashPrefix)) : [];
  const slashOpen = slashPrefix !== null && filteredSuggestions.length > 0;

  /** 应用斜杠建议：替换当前 / 前缀为完整命令 */
  const applySuggestion = (command: string): void => {
    setValue(command);
    autoResize();
    textareaRef.current?.focus();
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

  /** 选择附件（原生文件选择器多选；浏览器模式 window.api 缺失时静默跳过） */
  const handlePickFiles = async (): Promise<void> => {
    if (typeof window === 'undefined' || window.api === undefined) return;
    const response = await window.api.dialog.pickFiles({ multiple: true });
    if ('error' in response && response.error !== undefined) return;
    if ('data' in response && response.data !== undefined) {
      const data = response.data;
      if (data.canceled || data.paths === undefined || data.paths.length === 0) {
        return;
      }
      // 去重（已选路径跳过）
      const existing = new Set(attachments.map((a) => a.path));
      const next = data.paths
        .filter((p) => !existing.has(p))
        .map((p) => ({ path: p, name: p.split(/[\\/]/).pop() ?? p }));
      if (next.length > 0) {
        setAttachments((prev) => [...prev, ...next]);
      }
    }
  };

  /** 移除附件 */
  const removeAttachment = (path: string): void => {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  };

  /**
   * 读取附件内容并拼接进消息文本（file:read 支持 GBK 自动转码）
   * 读取失败（二进制/超大）跳过该附件，不影响发送。
   */
  const buildTextWithAttachments = async (baseText: string): Promise<string> => {
    if (attachments.length === 0 || typeof window === 'undefined' || window.api === undefined) {
      return baseText;
    }
    let text = baseText;
    for (const att of attachments) {
      try {
        const response = await window.api.file.read({
          path: att.path,
          offset: undefined,
          limit: 200,
        });
        if ('error' in response && response.error !== undefined) {
          text += `\n\n[附件: ${att.name}]（内容读取失败）`;
          continue;
        }
        if ('data' in response && response.data !== undefined) {
          const content = response.data.content.slice(0, ATTACHMENT_MAX_CHARS);
          text += `\n\n[附件: ${att.name}]\n\`\`\`\n${content}\n\`\`\``;
        }
      } catch {
        // 读取失败（二进制文件/权限）：仅附加文件名标注，不阻断发送
        text += `\n\n[附件: ${att.name}]（内容读取失败）`;
      }
    }
    return text;
  };

  /**
   * 发送当前文本
   *
   * 清空输入框并触发 onSend 回调。
   * 若文本为空或处于流式状态，直接返回。
   */
  /** 输入框高度拖拽（对齐原型 composerDragHandle：向上拖变高，钳位 [dragMinH, 460]；双击重置） */
  const composerDragRef = useRef<{
    startY: number;
    startH: number;
    dragMinH: number;
  } | null>(null);

  /** 测量 textarea 自然高度（临时解除高度/上限限制，对齐原型 measureNaturalH） */
  const measureNaturalHeight = (el: HTMLTextAreaElement): number => {
    const prevHeight = el.style.height;
    const prevMax = el.style.maxHeight;
    el.style.height = 'auto';
    el.style.maxHeight = 'none';
    const height = el.scrollHeight;
    el.style.height = prevHeight;
    el.style.maxHeight = prevMax;
    return height;
  };

  /** 拖拽开始：记录起点 + 指针捕获，注册全局 pointer 监听（对齐原型 onDown/onMove/onUp） */
  const handleComposerDragStart = (event: React.PointerEvent<HTMLDivElement>): void => {
    const el = textareaRef.current;
    if (el === null) {
      return;
    }
    event.preventDefault();
    // 指针捕获：拖拽过程中 pointer 移出手柄元素不丢失事件
    event.currentTarget.setPointerCapture(event.pointerId);
    // 拖拽下限 = 内容自然高度与 baseMax 的较小者（对齐原型 dragMinH：
    // 拖小不能小于当前内容所需高度，避免内容被裁剪不可见）
    const naturalHeight = measureNaturalHeight(el);
    composerDragRef.current = {
      startY: event.clientY,
      startH: el.offsetHeight,
      dragMinH: Math.min(naturalHeight, 160),
    };
    const handleMove = (ev: PointerEvent): void => {
      const state = composerDragRef.current;
      if (state === null) {
        return;
      }
      // 方向对齐原型：向上拖（clientY 减小）→ dy 增大 → 高度增大（手柄在输入框上方，向上拉高）
      const dy = state.startY - ev.clientY;
      const clamped = Math.max(state.dragMinH, Math.min(COMPOSER_MAX_H, state.startH + dy));
      if (clamped <= state.dragMinH) {
        el.style.maxHeight = '160px';
        el.style.height = `${state.dragMinH}px`;
      } else {
        el.style.maxHeight = `${clamped}px`;
        el.style.height = `${clamped}px`;
      }
    };
    const handleUp = (): void => {
      composerDragRef.current = null;
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleUp);
    };
    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleUp);
  };

  /** 双击手柄重置：恢复自动高度（对齐原型 resetResize：maxHeight 清空 + 自动增长） */
  const handleComposerReset = (): void => {
    const el = textareaRef.current;
    if (el === null) {
      return;
    }
    el.style.maxHeight = '';
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  };

  const handleSend = async (): Promise<void> => {
    if (!canSend) {
      return;
    }
    const text = await buildTextWithAttachments(value);
    onSend(text);
    setValue('');
    setAttachments([]);
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
    // 斜杠建议展开时：Tab/Enter 应用建议，Esc 关闭
    if (slashOpen && filteredSuggestions.length > 0) {
      const firstSuggestion = filteredSuggestions[0];
      if (event.key === 'Tab' || event.key === 'Enter') {
        if (firstSuggestion !== undefined) {
          event.preventDefault();
          applySuggestion(firstSuggestion.command);
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        // 关闭建议：清空斜杠输入（当前整个值即斜杠前缀）
        setValue('');
        return;
      }
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
      {/* 输入框高度拖拽手柄（对齐原型 .composer-drag-handle：hover 显示、ns-resize 调整高度）
          语义：hr + separator（键盘可达：ArrowUp/Down 20px 步进调整） */}
      <hr
        className="composer-drag-handle"
        aria-label={t('chat.resizeComposer')}
        tabIndex={0}
        onPointerDown={handleComposerDragStart}
        onDoubleClick={handleComposerReset}
        onKeyDown={(event) => {
          const el = textareaRef.current;
          if (el === null || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) {
            return;
          }
          event.preventDefault();
          const delta = event.key === 'ArrowUp' ? 20 : -20;
          const current = el.offsetHeight;
          const next = Math.max(COMPOSER_MIN_H, Math.min(COMPOSER_MAX_H, current + delta));
          el.style.maxHeight = `${next}px`;
          el.style.height = `${next}px`;
        }}
      />
      {/* 斜杠建议下拉（输入以 / 开头时显示，对齐参考项目 useSlashSuggest） */}
      {slashOpen && (
        <div
          role="listbox"
          aria-label={t('chat.slashCommand')}
          className="bg-popover text-popover-foreground absolute right-0 bottom-full z-10 mb-2 w-56 overflow-hidden rounded-md border shadow-md"
        >
          {filteredSuggestions.map((s) => (
            <button
              key={s.command}
              type="button"
              role="option"
              onClick={() => applySuggestion(s.command)}
              className="hover:bg-muted flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm transition-colors"
            >
              <Slash className="text-muted-foreground size-3.5 shrink-0" />
              <span className="font-mono text-xs">{s.command}</span>
              <span className="text-muted-foreground ml-auto text-xs">{t(s.labelKey)}</span>
            </button>
          ))}
        </div>
      )}
      {/* 附件 chip 列表（对齐参考项目 ChatInputAttachments） */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pb-1.5">
          {attachments.map((att) => (
            <span
              key={att.path}
              className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
            >
              <FileText className="size-3 shrink-0" />
              <span className="max-w-40 truncate" title={att.path}>
                {att.name}
              </span>
              <button
                type="button"
                onClick={() => removeAttachment(att.path)}
                aria-label={t('common.close')}
                className="hover:text-foreground cursor-pointer rounded-full transition-colors"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      {/* 文本域：.composer-input（透明背景，focus 时 box 上浮发光）
          ref 必须绑定：autoResize 依赖 textareaRef 调整高度（此前漏绑定导致多行不增高） */}
      <textarea
        ref={textareaRef}
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
            className="stop-gen-btn ml-auto"
            onClick={onStop}
            aria-label={t('chat.stopGenerating')}
            title={t('chat.stopGenerating')}
          >
            <Square className="size-3.5" strokeWidth={2.5} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            className="send-btn ml-auto"
            disabled={!canSend}
            onClick={handleSend}
            aria-label={t('chat.sendMessage')}
            title={t('chat.send')}
          >
            <Send className="size-3.5" strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  );
}
