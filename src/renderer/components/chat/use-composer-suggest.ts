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

  const { atIndex, slashIndex, activeTrigger, activeQuery } = detectSuggestTrigger(value);

  const filteredSuggestions: readonly SlashSuggestion[] =
    activeTrigger === 'slash' && activeQuery !== null ? filterSlashSuggestions(activeQuery) : [];

  const mentionFiles = useMentionFiles(activeTrigger, activeQuery, workingDir);

  const mentionOpen = activeTrigger === 'mention' && mentionFiles.length > 0;
  const slashOpen = activeTrigger === 'slash' && filteredSuggestions.length > 0;
  const suggestOpen = slashOpen || mentionOpen;

  const [suggestIndex, setSuggestIndex] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 故意监听 value/activeTrigger 变化重置高亮，不读取其值
  useEffect(() => {
    setSuggestIndex(0);
  }, [value, activeTrigger]);

  const activeSuggestionLabel = suggestionLabelText({
    slashOpen,
    filteredSuggestions,
    mentionFiles,
    index: suggestIndex,
    formatCommand: (s) => `${s.command} ${t(s.labelKey)}`,
  });
  const suggestionTotal = slashOpen ? filteredSuggestions.length : mentionFiles.length;

  /**
   * 应用斜杠建议：替换当前 / 触发段为完整命令
   *
   * 清除范围只限「触发段」而非整框（2026-09 审计修复）：触发检测支持任意位置
   * （suggest-trigger 用 lastIndexOf），用户输入「帮我 /he」后点 /help 时，
   * 此前 `setValue('')` 会把「帮我」一并抹掉——与 Esc 路径（已按 lastIndexOf 裁剪）
   * 策略相反，属同类数据丢失在新位置的残留。
   */
  const applySuggestion = (command: string): void => {
    const before = slashIndex < 0 ? value : value.slice(0, slashIndex);
    const suggestion = findSlashSuggestion(command);
    if (suggestion?.action !== undefined) {
      setValue(before);
      onAfterChange?.();
      onSlashCommand?.(suggestion.action);
      return;
    }
    setValue(`${before}${command} `);
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

  /**
   * 建议面板键盘处理：方向键循环选择，Tab/Enter 应用选中项，Esc 关闭仅清除触发段
   *
   * 分发顺序即优先级，**不可调整**：
   * 1. ArrowDown/Up — 仅改高亮，必须最先（否则会被下方 Enter 分支抢先判定）；
   * 2. Tab/Enter — 应用高亮项，须早于 Esc（三键互斥，此序只为可读）；
   * 3. Esc — 兜底清段，返回其 consumed 结果（前两者未消费即交给调用方）。
   * 三个分支各自「消费即 return true」，调用方据此决定是否 preventDefault。
   */
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
