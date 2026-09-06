// src/renderer/components/chat/slash-suggest-panel.tsx
// 斜杠/提及建议面板（自 ChatInput 拆出：/ 命令 + @ 文件 建议下拉）
// ──────────────────────────────────────────────
// 只负责渲染建议下拉（listbox 语义 + 键盘高亮索引）；触发状态与选中回调
// 由 ChatInput 持有。纯展示组件，可在测试中独立 mock。
// ──────────────────────────────────────────────

import { FileText, Slash } from 'lucide-react';
import type { ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import type { SlashSuggestion } from './slash-suggestions';

/** 建议面板 props */
export interface SlashSuggestPanelProps {
  /** 当前触发类型（slash=命令 / mention=文件；null 时不渲染） */
  readonly trigger: 'slash' | 'mention' | null;
  /** slash 命令建议列表 */
  readonly slashSuggestions: readonly SlashSuggestion[];
  /** mention 文件建议列表 */
  readonly mentionFiles: readonly string[];
  /** 键盘高亮索引（当前选中项） */
  readonly activeIndex: number;
  /** 选中某个 slash 命令 */
  readonly onSelectCommand: (command: string) => void;
  /** 选中某个 mention 文件 */
  readonly onSelectFile: (filePath: string) => void;
}

/**
 * 斜杠/提及建议面板
 *
 * listbox 语义（role=option + aria-selected）；键盘导航由父组件 ChatInput
 * 管理（ArrowUp/Down + Enter/Tab），本组件只按 activeIndex 高亮。
 */
export function SlashSuggestPanel({
  trigger,
  slashSuggestions,
  mentionFiles,
  activeIndex,
  onSelectCommand,
  onSelectFile,
}: SlashSuggestPanelProps): ReactElement | null {
  const { t } = useTranslation();
  const slashOpen = trigger === 'slash' && slashSuggestions.length > 0;
  const mentionOpen = trigger === 'mention' && mentionFiles.length > 0;
  if (!slashOpen && !mentionOpen) return null;
  return (
    <div
      role="listbox"
      aria-label={t('chat.slashCommand')}
      aria-activedescendant={`suggest-opt-${activeIndex}`}
      tabIndex={-1}
      // 左对齐 + 紧凑上限：此前 left-0 right-0 w-full 拉伸到输入舱全宽（实测 728px），
      // 短命令行的 7 行建议面板过宽失衡；长路径（@ 提及）由 truncate + title 处理
      className="bg-popover text-popover-foreground absolute bottom-full left-0 z-surface mb-2 w-full max-w-sm overflow-hidden rounded-md border shadow-md"
    >
      {slashOpen &&
        slashSuggestions.map((s, i) => (
          <Button
            key={s.command}
            id={`suggest-opt-${i}`}
            variant="ghost"
            size="sm"
            role="option"
            aria-selected={i === activeIndex}
            onClick={() => onSelectCommand(s.command)}
            className={cn(
              'w-full justify-start px-3 py-2 text-left text-sm font-normal',
              i === activeIndex ? 'bg-muted' : 'hover:bg-muted',
            )}
          >
            <Slash className="text-muted-foreground size-3.5 shrink-0" />
            <span className="font-mono text-xs">{s.command}</span>
            <span className="text-muted-foreground ml-auto text-xs">{t(s.labelKey)}</span>
          </Button>
        ))}
      {mentionOpen &&
        mentionFiles.map((filePath, i) => (
          <Button
            key={filePath}
            id={`suggest-opt-${i}`}
            variant="ghost"
            size="sm"
            role="option"
            aria-selected={i === activeIndex}
            onClick={() => onSelectFile(filePath)}
            className={cn(
              'w-full justify-start px-3 py-2 text-left text-sm font-normal',
              i === activeIndex ? 'bg-muted' : 'hover:bg-muted',
            )}
          >
            <FileText className="text-muted-foreground size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={filePath}>
              {filePath}
            </span>
          </Button>
        ))}
    </div>
  );
}
