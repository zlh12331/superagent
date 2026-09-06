// src/renderer/components/chat/ChatInput.tsx
// 聊天输入框 + 发送/停止按钮 · Aurora 设计系统
// ──────────────────────────────────────────────
// 约束（调用方须知）：
// - 不在此组件内调用 useChat，所有状态由父组件（ChatPanel）传入
// - 纯展示+交互，可在测试中独立 mock；sendMessage/stop 签名与 useChat 返回值对齐
// ──────────────────────────────────────────────

import { MAX_MESSAGE_LENGTH_CHARS } from '@code-agent/shared/renderer';
import { AtSign, Send, Slash, Square } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type KeyboardEvent, type ReactElement, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from '@/i18n/use-translation';
import { unwrap } from '@/lib/ipc';
import { microTransition, springTransition } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { useDraftStore } from '@/stores/persistent/draft-store';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { attachmentName, buildTextWithAttachments, type ChatAttachment } from './attachments';
import { AttachmentsChips } from './attachments-chips';
import { SlashSuggestPanel } from './slash-suggest-panel';
import {
  filterSlashSuggestions,
  findSlashSuggestion,
  type SlashAction,
  type SlashSuggestion,
} from './slash-suggestions';
import { detectSuggestTrigger } from './suggest-trigger';
import { COMPOSER_AUTO_MAX, useComposerDrag } from './use-composer-drag';
import { useVimMode } from './use-vim-mode';

/** 消息最大长度（对齐 shared 单一真源 MAX_MESSAGE_LENGTH_CHARS=8000） */
const MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH_CHARS;

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
  const [internalValue, setInternalValue] = useState(() => {
    // 草稿恢复：非受控 + 有 chatId 时从 draft-store 初始化（对齐参考项目 useDraftStore）
    return (
      controlledValue ??
      (chatId !== undefined ? useDraftStore.getState().getDraft(chatId).text : '')
    );
  });
  // 占位符：props 优先，缺省走 i18n
  const effectivePlaceholder = placeholder ?? t('chat.inputPlaceholder');
  // 附件列表（对齐参考项目 ChatInputAttachments：选择 → chip 展示 → 发送时读取拼接）
  const [attachments, setAttachments] = useState<ChatAttachment[]>(() => {
    if (chatId === undefined) {
      return [];
    }
    const draft = useDraftStore.getState().getDraft(chatId);
    // 草稿附件恢复：仅恢复仍存在的文件路径（历史路径可能已删除）
    return draft.attachments.map((p) => ({ path: p, name: attachmentName(p) }));
  });
  // 占位符：props 优先，缺省走 i18n
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

  // ── 斜杠/提及建议状态（照搬参考项目 useSlashSuggest：支持任意位置触发，取位置靠后者）──
  // 触发检测为纯函数（suggest-trigger.ts）：slash 1-20 字符、mention ≤30 字符（允许空串）
  const { atIndex, activeTrigger, activeQuery } = detectSuggestTrigger(value);

  // slash 建议：内置命令过滤（command 带 '/' 前缀，查询词不含 '/'——对齐参考项目 useSlashSuggest 语义）
  const filteredSuggestions: readonly SlashSuggestion[] =
    activeTrigger === 'slash' && activeQuery !== null ? filterSlashSuggestions(activeQuery) : [];

  // mention 建议：search.glob 按查询过滤（200ms 防抖，对齐参考项目防抖约定）
  const [mentionFiles, setMentionFiles] = useState<string[]>([]);
  const mentionSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (mentionSearchTimerRef.current !== null) {
      clearTimeout(mentionSearchTimerRef.current);
      mentionSearchTimerRef.current = null;
    }
    if (activeTrigger !== 'mention' || workingDir === undefined) {
      setMentionFiles([]);
      return;
    }
    // 防抖后调 glob（浏览器模式无 window.api 时静默清空）
    mentionSearchTimerRef.current = setTimeout(() => {
      if (typeof window === 'undefined' || window.api === undefined) {
        setMentionFiles([]);
        return;
      }
      void window.api.search
        .glob({
          pattern: `**/*${activeQuery ?? ''}*`,
          path: workingDir,
          includeHidden: false,
          maxResults: 10,
        })
        .then((res) => {
          try {
            setMentionFiles([...unwrap(res).files]);
          } catch {
            // error 响应：清空候选（与下方网络异常同策略）
            setMentionFiles([]);
          }
        })
        .catch(() => {
          setMentionFiles([]);
        });
    }, 200);
    return () => {
      if (mentionSearchTimerRef.current !== null) {
        clearTimeout(mentionSearchTimerRef.current);
      }
    };
  }, [activeTrigger, activeQuery, workingDir]);

  const mentionOpen = activeTrigger === 'mention' && mentionFiles.length > 0;
  const slashOpen = activeTrigger === 'slash' && filteredSuggestions.length > 0;
  // 统一建议面板开关（两者互斥，取靠后者触发）
  const suggestOpen = slashOpen || mentionOpen;
  // 键盘高亮索引：ArrowUp/Down 循环选择，Enter/Tab 应用选中项（此前固定第 0 项，
  // 键盘用户无法选择第 2+ 条建议）；输入内容变化时重置回第一项
  const [suggestIndex, setSuggestIndex] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 故意监听 value/activeTrigger 变化重置高亮，不读取其值
  useEffect(() => {
    setSuggestIndex(0);
  }, [value, activeTrigger]);

  /** 应用斜杠建议：替换当前 / 前缀为完整命令 */
  const applySuggestion = (command: string): void => {
    // 带 action 的命令：执行动作（对齐参考项目），不填充文本
    const suggestion = findSlashSuggestion(command);
    if (suggestion?.action !== undefined) {
      // 清空输入（suggestOpen 派生自输入值，自动关闭建议面板）
      setValue('');
      autoResize();
      onSlashCommand?.(suggestion.action);
      return;
    }
    setValue(command);
    autoResize();
    textareaRef.current?.focus();
  };

  /** 应用提及建议：替换当前 @查询 为 @完整路径 */
  const applyMention = (filePath: string): void => {
    if (atIndex < 0) return;
    const next = `${value.slice(0, atIndex)}@${filePath} `;
    setValue(next);
    autoResize();
    textareaRef.current?.focus();
  };

  // 值变化后 auto-resize
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅在 value 变化时 resize
  useEffect(() => {
    autoResize();
  }, [value]);

  // 外部注入值（编辑重提 / 目标预填）：非受控模式下同步到内部值，保持草稿语义（对齐参考项目 P2-10）
  // 不做 ref 去重：父级“注入 → 重置 undefined → 再注入相同值”循环需要重复生效
  // （React 跳过相同值的 setState，不会重复注入；注入本身幂等）
  // biome-ignore lint/correctness/useExhaustiveDependencies: autoResize 每次渲染新引用，加入依赖会无限循环；其行为仅依赖内部 ref
  useEffect(() => {
    if (injectedValue === undefined) {
      return;
    }
    setInternalValue(injectedValue);
    autoResize();
    textareaRef.current?.focus();
  }, [injectedValue]);

  // 草稿保存：非受控 + 有 chatId 时，文本/附件变化写入 draft-store（对齐参考项目 useDraftStore）
  // 切换帧守卫：chatId 变化的那次渲染 internalValue 仍是旧会话内容，
  // 若此时保存会把旧会话草稿写进新会话 key（交叉污染），故跳过——
  // 旧会话草稿在每次键入时已实时保存，无丢失。
  const draftSyncedChatIdRef = useRef(chatId);
  useEffect(() => {
    if (isControlled || chatId === undefined) {
      return;
    }
    if (chatId !== draftSyncedChatIdRef.current) {
      draftSyncedChatIdRef.current = chatId;
      return;
    }
    useDraftStore.getState().setDraft(chatId, {
      text: internalValue,
      attachments: attachments.map((a) => a.path),
    });
  }, [internalValue, attachments, chatId, isControlled]);

  // 会话切换（chatId 变化）：恢复新会话草稿（对齐参考项目 prevThreadId 模式）
  const prevChatIdRef = useRef(chatId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: autoResize 每次渲染新引用，加入依赖会无限循环；其行为仅依赖内部 ref
  useEffect(() => {
    if (chatId === prevChatIdRef.current || chatId === undefined || isControlled) {
      prevChatIdRef.current = chatId;
      return;
    }
    prevChatIdRef.current = chatId;
    const draft = useDraftStore.getState().getDraft(chatId);
    setInternalValue(draft.text);
    setAttachments(draft.attachments.map((p) => ({ path: p, name: attachmentName(p) })));
    autoResize();
  }, [chatId, isControlled]);

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

  // 是否可以发送（非空文本 + 非流式 + 未禁用）
  // 是否可以发送（非空文本 + 非流式 + 未禁用 + 不在发送中）
  const [sending, setSending] = useState(false);
  /** in-flight 发送守卫（ref 同步拦截同帧重复触发；state 驱动按钮禁用渲染） */
  const sendingRef = useRef(false);
  const canSend = value.trim().length > 0 && !isStreaming && !disabled && !sending;

  /** 选择附件（原生文件选择器多选；浏览器模式 window.api 缺失时静默跳过） */
  const handlePickFiles = async (): Promise<void> => {
    if (typeof window === 'undefined' || window.api === undefined) return;
    try {
      // 选择器错误响应/取消均静默（非关键路径，用户可重试）
      const data = unwrap(await window.api.dialog.pickFiles({ multiple: true }));
      if (data.canceled || data.paths === undefined || data.paths.length === 0) return;
      // 去重（已选路径跳过；filter 内逐步去重，重复路径只留一个）
      const seen = new Set(attachments.map((a) => a.path));
      const next: ChatAttachment[] = [];
      for (const p of data.paths) {
        if (seen.has(p)) continue;
        seen.add(p);
        next.push({ path: p, name: p.split(/[\\/]/).pop() ?? p });
      }
      if (next.length > 0) setAttachments((prev) => [...prev, ...next]);
    } catch {
      return;
    }
  };

  /** 移除附件 */
  const removeAttachment = (path: string): void => {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  };

  /**
   * 附件内容拼接已提取至 attachments.ts（buildTextWithAttachments）：
   * file:read 读取 + GBK 转码 + 失败降级标注，本组件只负责调用。
   */

  /** 输入框高度拖拽（use-composer-drag.ts：手柄事件 props） */
  const { handleProps: dragHandleProps } = useComposerDrag(textareaRef);

  /** 发送当前文本：超长拦截 → 附件拼接 → 清空草稿与输入 */
  const handleSend = async (): Promise<void> => {
    // in-flight 守卫：附件拼接含真实 IPC 往返，await 窗口内 status 仍为
    // ready，二次 Enter/点击会重复发送；此处硬拦截（不依赖渲染期的 canSend）
    if (!canSend || sendingRef.current) {
      return;
    }
    sendingRef.current = true;
    setSending(true);
    // 快照本次发送的输入（供超长校验使用）
    const sentValue = value;
    try {
      // trim：对齐原型 send() 的 input.value.trim()（避免首尾空格进入消息）
      const base = sentValue.trim();
      // 超长拦截（对齐 shared 单一真源 MAX_MESSAGE_LENGTH_CHARS）
      if (base.length > MAX_MESSAGE_LENGTH) {
        toast.error(t('chat.messageTooLong', { max: MAX_MESSAGE_LENGTH }));
        return;
      }
      const text = await buildTextWithAttachments(base, attachments, {
        attached: (name) => t('chat.attachmentLabel', { name }),
        readFailed: (name) => t('chat.attachmentReadFailed', { name }),
      });
      onSend(text);
      // 发送成功：清除本会话草稿（草稿只保留未发送内容）
      if (chatId !== undefined) {
        useDraftStore.getState().clearDraft(chatId);
      }
      // 清空输入与附件（in-flight 守卫已挡住 await 期间的重复发送）
      setValue('');
      setAttachments([]);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

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
    // 斜杠/提及建议展开时：方向键循环选择，Tab/Enter 应用选中项，Esc 关闭
    if (suggestOpen) {
      const count = slashOpen ? filteredSuggestions.length : mentionFiles.length;
      const selected = Math.min(suggestIndex, Math.max(0, count - 1));
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (count > 0) {
          setSuggestIndex((i) =>
            event.key === 'ArrowDown' ? (i + 1) % count : (i - 1 + count) % count,
          );
        }
        return;
      }
      if (event.key === 'Tab' || event.key === 'Enter') {
        const selectedSuggestion = filteredSuggestions[selected];
        const selectedMention = mentionFiles[selected];
        if (slashOpen && selectedSuggestion !== undefined) {
          event.preventDefault();
          applySuggestion(selectedSuggestion.command);
        } else if (mentionOpen && selectedMention !== undefined) {
          event.preventDefault();
          applyMention(selectedMention);
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        // 关闭建议：只清除触发段（"/xxx" 或 "@xxx"），保留用户其余输入——
        // 此前 setValue('') 会清空整个输入框且同步覆盖草稿（数据丢失）
        const caret = event.currentTarget.selectionStart ?? value.length;
        const triggerChar = slashOpen ? '/' : '@';
        const at = value.lastIndexOf(triggerChar, Math.max(0, caret - 1));
        if (at >= 0) {
          setValue(value.slice(0, at) + value.slice(caret));
        }
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
      {/* 附件 chip 列表（自 ChatInput 拆出：attachments-chips.tsx） */}
      <AttachmentsChips attachments={attachments} onRemove={removeAttachment} />
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
