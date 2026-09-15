// src/renderer/components/chat/use-composer-suggest.ts
// composer 建议面板状态与键盘处理（自 ChatInput 拆出）
// ──────────────────────────────────────────────
// 职责（单一内聚：斜杠/提及建议的完整行为链）：
// - 触发检测（suggest-trigger.ts 纯函数：slash 1-20 字符、mention ≤30 字符，任意位置触发取靠后）
// - 候选过滤（slash 内置命令；mention search.glob 200ms 防抖委托 use-mention-files）
// - 键盘高亮（ArrowUp/Down 循环选择，Tab/Enter 应用，Esc 清除触发段保留其余输入）
// - 应用建议（带 action 的斜杠命令执行动作不填充文本；mention 替换 @查询 为完整路径）
// 不含渲染（面板 UI 由 SlashSuggestPanel 承担）与 vim/发送逻辑。
// ──────────────────────────────────────────────

import type { KeyboardEvent, RefObject } from 'react';
import { useEffect, useState } from 'react';

import { useTranslation } from '@/i18n/use-translation';

import {
  filterSlashSuggestions,
  findSlashSuggestion,
  type SlashAction,
  type SlashSuggestion,
} from './slash-suggestions';
import { detectSuggestTrigger, type SuggestTrigger } from './suggest-trigger';
import { useMentionFiles } from './use-mention-files';

/** useComposerSuggest 依赖 */
export interface UseComposerSuggestDeps {
  /** 当前输入值（触发检测 / Esc 清段 / mention 替换的基准） */
  readonly value: string;
  /** 写入值（应用建议 / Esc 清段） */
  readonly setValue: (next: string) => void;
  /** 工作目录（mention search.glob 范围；undefined = 不启用提及建议） */
  readonly workingDir: string | undefined;
  /** 带 action 的斜杠命令回调（不填充文本直接执行；undefined = 仅填充） */
  readonly onSlashCommand: ((action: SlashAction) => void) | undefined;
  /** textarea ref（应用建议后聚焦回输入框） */
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** 值写入后回调（autoResize；调用方需传稳定引用） */
  readonly onAfterChange?: () => void;
}

/** useComposerSuggest 返回值 */
export interface UseComposerSuggestResult {
  /** 激活的建议类型（面板渲染触发态） */
  readonly activeTrigger: SuggestTrigger | null;
  /** 建议面板是否打开（slash/mention 候选非空；两者互斥取靠后者） */
  readonly suggestOpen: boolean;
  /** slash 候选（未触发为空数组） */
  readonly filteredSuggestions: readonly SlashSuggestion[];
  /** mention 候选（search.glob 结果） */
  readonly mentionFiles: readonly string[];
  /** 键盘高亮索引（ArrowUp/Down 循环；输入变化重置回 0） */
  readonly suggestIndex: number;
  /** 当前高亮项可读文本（sr-only live region 播报；无高亮为空串） */
  readonly activeSuggestionLabel: string;
  /** 候选总数（sr-only 播报 x/y 用） */
  readonly suggestionTotal: number;
  /** 应用斜杠建议（替换 / 前缀为完整命令；带 action 则执行动作） */
  readonly applySuggestion: (command: string) => void;
  /** 应用提及建议（替换 @查询 为 @完整路径） */
  readonly applyMention: (filePath: string) => void;
  /** 建议面板键盘处理（消费返回 true；未打开返回 false 透传后续逻辑） */
  readonly handleSuggestKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

/** 方向键导航所需上下文 */
interface ArrowNavContext {
  readonly count: number;
  readonly setSuggestIndex: (update: (i: number) => number) => void;
}

/** 方向键循环导航：ArrowDown/ArrowUp 移动高亮（消费返回 true） */
function handleArrowNav(event: KeyboardEvent<HTMLTextAreaElement>, ctx: ArrowNavContext): boolean {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
    return false;
  }
  event.preventDefault();
  if (ctx.count > 0) {
    ctx.setSuggestIndex((i) =>
      event.key === 'ArrowDown' ? (i + 1) % ctx.count : (i - 1 + ctx.count) % ctx.count,
    );
  }
  return true;
}

/** Tab/Enter 应用选中项所需上下文 */
interface ApplyKeyContext {
  readonly slashOpen: boolean;
  readonly mentionOpen: boolean;
  readonly selected: number;
  readonly filteredSuggestions: readonly SlashSuggestion[];
  readonly mentionFiles: readonly string[];
  readonly applySuggestion: (command: string) => void;
  readonly applyMention: (filePath: string) => void;
}

/** Tab/Enter 应用选中建议（消费返回 true；无匹配候选时不消费不换行） */
function handleApplyKey(event: KeyboardEvent<HTMLTextAreaElement>, ctx: ApplyKeyContext): boolean {
  if (event.key !== 'Tab' && event.key !== 'Enter') {
    return false;
  }
  const selectedSuggestion = ctx.filteredSuggestions[ctx.selected];
  const selectedMention = ctx.mentionFiles[ctx.selected];
  if (ctx.slashOpen && selectedSuggestion !== undefined) {
    event.preventDefault();
    ctx.applySuggestion(selectedSuggestion.command);
  } else if (ctx.mentionOpen && selectedMention !== undefined) {
    event.preventDefault();
    ctx.applyMention(selectedMention);
  }
  return true;
}

/** Esc 清除触发段（消费返回 true）：只删 "/xxx" 或 "@xxx"，保留用户其余输入 */
function handleEscapeClear(
  event: KeyboardEvent<HTMLTextAreaElement>,
  value: string,
  setValue: (next: string) => void,
  slashOpen: boolean,
): boolean {
  if (event.key !== 'Escape') {
    return false;
  }
  event.preventDefault();
  // 关闭建议：只清除触发段（"/xxx" 或 "@xxx"），保留用户其余输入——
  // 此前 setValue('') 会清空整个输入框且同步覆盖草稿（数据丢失）
  const caret = event.currentTarget.selectionStart ?? value.length;
  const triggerChar = slashOpen ? '/' : '@';
  const at = value.lastIndexOf(triggerChar, Math.max(0, caret - 1));
  if (at >= 0) {
    setValue(value.slice(0, at) + value.slice(caret));
  }
  return true;
}

/** 播报文案上下文（sr-only live region） */
interface LabelContext {
  readonly slashOpen: boolean;
  readonly filteredSuggestions: readonly SlashSuggestion[];
  readonly mentionFiles: readonly string[];
  readonly index: number;
  /** 命令 → 可读文本（命令 + 本地化说明） */
  readonly formatCommand: (suggestion: SlashSuggestion) => string;
}

/** 当前高亮项的可读文本（slash 无高亮为空串；mention 取路径，越界为空串） */
function suggestionLabelText(ctx: LabelContext): string {
  if (ctx.slashOpen) {
    const active = ctx.filteredSuggestions[ctx.index];
    return active !== undefined ? ctx.formatCommand(active) : '';
  }
  return ctx.mentionFiles[ctx.index] ?? '';
}

/**
 * composer 建议面板 hook（斜杠 + 提及统一状态机）
 *
 * @example
 * ```tsx
 * const { suggestOpen, handleSuggestKeyDown } = useComposerSuggest({ value, setValue, ... });
 * ```
 */
export function useComposerSuggest({
  value,
  setValue,
  workingDir,
  onSlashCommand,
  textareaRef,
  onAfterChange,
}: UseComposerSuggestDeps): UseComposerSuggestResult {
  const { t } = useTranslation();

  // ── 触发检测（照搬参考项目 useSlashSuggest：支持任意位置触发，取位置靠后者）──
  // 触发检测为纯函数（suggest-trigger.ts）：slash 1-20 字符、mention ≤30 字符（允许空串）
  const { atIndex, activeTrigger, activeQuery } = detectSuggestTrigger(value);

  // slash 建议：内置命令过滤（command 带 '/' 前缀，查询词不含 '/'——对齐参考项目 useSlashSuggest 语义）
  const filteredSuggestions: readonly SlashSuggestion[] =
    activeTrigger === 'slash' && activeQuery !== null ? filterSlashSuggestions(activeQuery) : [];

  // mention 建议：search.glob 按查询过滤（200ms 防抖与生命周期见 use-mention-files.ts）
  const mentionFiles = useMentionFiles(activeTrigger, activeQuery, workingDir);

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

  // 当前高亮建议的可读文本与总数（sr-only live region 播报用；textarea 不允许
  // combobox 角色，故不依赖 aria-activedescendant）
  const activeSuggestionLabel = suggestionLabelText({
    slashOpen,
    filteredSuggestions,
    mentionFiles,
    index: suggestIndex,
    formatCommand: (s) => `${s.command} ${t(s.labelKey)}`,
  });
  const suggestionTotal = slashOpen ? filteredSuggestions.length : mentionFiles.length;

  /** 应用斜杠建议：替换当前 / 前缀为完整命令 */
  const applySuggestion = (command: string): void => {
    // 带 action 的命令：执行动作（对齐参考项目），不填充文本
    const suggestion = findSlashSuggestion(command);
    if (suggestion?.action !== undefined) {
      // 清空输入（suggestOpen 派生自输入值，自动关闭建议面板）
      setValue('');
      onAfterChange?.();
      onSlashCommand?.(suggestion.action);
      return;
    }
    setValue(command);
    onAfterChange?.();
    textareaRef.current?.focus();
  };

  /** 应用提及建议：替换当前 @查询 为 @完整路径 */
  const applyMention = (filePath: string): void => {
    if (atIndex < 0) return;
    const next = `${value.slice(0, atIndex)}@${filePath} `;
    setValue(next);
    onAfterChange?.();
    textareaRef.current?.focus();
  };

  /** 建议面板键盘处理：方向键循环选择，Tab/Enter 应用选中项，Esc 关闭仅清除触发段 */
  const handleSuggestKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!suggestOpen) {
      return false;
    }
    const count = slashOpen ? filteredSuggestions.length : mentionFiles.length;
    const selected = Math.min(suggestIndex, Math.max(0, count - 1));
    if (handleArrowNav(event, { count, setSuggestIndex })) {
      return true;
    }
    if (
      handleApplyKey(event, {
        slashOpen,
        mentionOpen,
        selected,
        filteredSuggestions,
        mentionFiles,
        applySuggestion,
        applyMention,
      })
    ) {
      return true;
    }
    return handleEscapeClear(event, value, setValue, slashOpen);
  };

  return {
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
  };
}
