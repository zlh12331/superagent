// src/renderer/components/terminal/TerminalTabs.tsx
// 终端标签栏（照搬参考项目 TerminalTabs：tab 列表 + 关闭 + 末尾新建按钮）
// ──────────────────────────────────────────────────────────────
// 每个 Tab：终端图标 + 标题（截断）+ 关闭按钮（×）。激活 Tab 用 accent
// 色 + 底部强调线，非激活 hover 显示淡色背景。关闭按钮激活时常显、
// 非激活 hover 显示。末尾固定「+」新建按钮，标签栏横向可滚动。
// 纯展示组件，数据与回调全部通过 props 传入。
// ──────────────────────────────────────────────────────────────

import { Plus, Terminal as TerminalIcon } from 'lucide-react';
import type { ReactElement } from 'react';

import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import type { TerminalMeta } from '@/stores/transient/terminal-store';

interface TerminalTabsProps {
  /** 终端列表（顺序即 Tab 显示顺序） */
  readonly terminals: readonly TerminalMeta[];
  /** 当前激活的终端 id（用于高亮判定） */
  readonly activeId: string | null;
  /** 点击 Tab 回调（切换激活终端） */
  readonly onSelect: (id: string) => void;
  /** 点击关闭按钮回调（关闭对应终端） */
  readonly onClose: (id: string) => void;
  /** 点击「+」按钮回调（新建终端） */
  readonly onAdd: () => void;
}

/**
 * 终端标签栏组件。
 *
 * 键盘导航：Enter/Space 切换 Tab，Delete/Backspace 关闭 Tab。
 */
export function TerminalTabs({
  terminals,
  activeId,
  onSelect,
  onClose,
  onAdd,
}: TerminalTabsProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();

  return (
    <div
      role="tablist"
      aria-label={t('terminal.tabsAriaLabel')}
      className="bg-background flex shrink-0 items-stretch overflow-x-auto overflow-y-hidden border-b px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {terminals.map((terminal, index) => {
        const isActive = terminal.id === activeId;
        return (
          <div
            key={terminal.id}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            className={cn(
              'group relative flex h-[30px] shrink-0 cursor-pointer items-center gap-1.5 border-r pr-2 pl-2.5 whitespace-nowrap transition-colors',
              index === 0 && 'border-l border-l-border',
              isActive
                ? 'bg-background text-foreground shadow-[inset_0_-1px_0_var(--accent)]'
                : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground bg-transparent',
            )}
            onClick={() => onSelect(terminal.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(terminal.id);
              } else if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                onClose(terminal.id);
              }
            }}
          >
            <TerminalIcon className="text-[var(--accent)] size-3 shrink-0" />
            <span className="max-w-[100px] overflow-hidden text-ellipsis font-mono text-[11px]">
              {terminal.title}
            </span>
            <button
              type="button"
              className={cn(
                'text-muted-foreground hover:bg-destructive/15 hover:text-destructive ml-0.5 inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[3px] border-none bg-transparent text-[14px] leading-none transition-colors',
                isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
              )}
              onClick={(e) => {
                e.stopPropagation();
                onClose(terminal.id);
              }}
              aria-label={t('terminal.closeTerminal')}
              title={t('terminal.closeTerminal')}
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="text-muted-foreground hover:bg-muted/50 hover:text-foreground inline-flex h-[30px] w-7 shrink-0 cursor-pointer items-center justify-center rounded-[3px] border-none bg-transparent transition-colors"
        onClick={onAdd}
        aria-label={t('terminal.newTerminal')}
        title={t('terminal.newTerminal')}
      >
        <Plus className="size-3.5" strokeWidth={1.5} />
      </button>
    </div>
  );
}
