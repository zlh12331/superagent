// src/renderer/components/terminal/TerminalTabs.tsx
// 终端标签栏（照搬参考项目 TerminalTabs：tab 列表 + 关闭 + 末尾新建按钮）
// ──────────────────────────────────────────────────────────────
// 每个 Tab：终端图标 + 标题（截断）+ 关闭按钮（×）。激活 Tab 用 accent
// 色 + 底部强调线，非激活 hover 显示淡色背景。关闭按钮激活时常显、
// 非激活 hover 显示。末尾固定「+」新建按钮，标签栏横向可滚动。
// 纯展示组件，数据与回调全部通过 props 传入。
// ──────────────────────────────────────────────────────────────

import { Terminal as TerminalIcon } from 'lucide-react';
import { type KeyboardEvent, type ReactElement, useRef } from 'react';

import { Button } from '@/components/ui/button';
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
}

/**
 * 解析 Tab 上的按键意图（纯函数，便于独立推理与单测）
 *
 * 收敛动机（2026-09 审计）：方向键/Home/End/Enter/Space/Delete 的分支此前全部
 * 内联在 JSX 的 onKeyDown 里，外加两处 `target !== undefined` 守卫，把
 * TerminalTabs 的认知复杂度推到 32（阈值 15）。改为「按键 → 意图」的纯映射后，
 * 组件侧只剩一次 switch on intent。
 *
 * @param key 按键名（KeyboardEvent.key）
 * @param index 当前 Tab 下标
 * @param count Tab 总数
 * @returns 意图；null 表示该键与标签栏无关（调用方不得拦截事件）
 */
type TabKeyIntent =
  | { readonly kind: 'select'; readonly index: number }
  | { readonly kind: 'close' };

function resolveTabKeyIntent(key: string, index: number, count: number): TabKeyIntent | null {
  // 列表为空时无目标可算（Home/End/方向键都退化）
  if (count === 0) {
    return key === 'Delete' || key === 'Backspace' ? { kind: 'close' } : null;
  }
  switch (key) {
    case 'ArrowRight':
      return { kind: 'select', index: (index + 1) % count };
    case 'ArrowLeft':
      return { kind: 'select', index: (index - 1 + count) % count };
    case 'Home':
      return { kind: 'select', index: 0 };
    case 'End':
      return { kind: 'select', index: count - 1 };
    case 'Enter':
    case ' ':
      return { kind: 'select', index };
    case 'Delete':
    case 'Backspace':
      return { kind: 'close' };
    default:
      return null;
  }
}

/**
 * 终端标签栏组件。
 *
 * 键盘导航（对齐 a11y spec §「标签页支持方向键导航」）：
 * - ArrowLeft/ArrowRight：在 Tab 间移动焦点并切换激活项（横向 roving tabindex，两端回绕）
 * - Home/End：跳到首/末 Tab
 * - Enter/Space：切换到当前 Tab
 * - Delete/Backspace：关闭当前 Tab
 *
 * 注：自研 tablist 需自行实现方向键——Radix Tabs 内置该行为，但本组件是终端
 * 特有的「可关闭标签」，Radix 无对应形态，故手写等价语义。
 */
export function TerminalTabs({
  terminals,
  activeId,
  onSelect,
  onClose,
}: TerminalTabsProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  // 标签栏容器：方向键切换后把焦点移到新激活项（roving tabindex 约定）
  const listRef = useRef<HTMLDivElement | null>(null);

  /**
   * 移焦到指定 Tab（roving tabindex 要求「焦点与激活项同行」）。
   *
   * 若不移动焦点：激活项换到 tabIndex=0 的新节点，但 DOM 焦点仍停在上一个
   * （现 tabIndex=-1）节点上——视觉焦点环留在非激活项，且用户下次按 Tab 会
   * 直接从 tablist 跳走，等于键盘导航失效。
   */
  const focusTab = (id: string): void => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-terminal-tab="${id}"]`);
    el?.focus();
  };

  /**
   * Tab 按键处理：把纯函数解析出的意图落到回调。
   *
   * @param terminal 当前 Tab 的终端元数据
   * @param index 当前 Tab 下标
   * @param event 键盘事件
   */
  const handleTabKeyDown = (
    terminal: TerminalMeta,
    index: number,
    event: KeyboardEvent<HTMLDivElement>,
  ): void => {
    const intent = resolveTabKeyIntent(event.key, index, terminals.length);
    // 无关按键不拦截（让事件继续冒泡）
    if (intent === null) return;
    event.preventDefault();

    if (intent.kind === 'close') {
      onClose(terminal.id);
      return;
    }
    const target = terminals[intent.index]?.id;
    if (target === undefined) return;
    onSelect(target);
    // 仅方向键/Home/End 需要移焦（Enter/Space 未移动目标）
    if (target !== terminal.id) focusTab(target);
  };

  return (
    <div
      ref={listRef}
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
            data-terminal-tab={terminal.id}
            className={cn(
              'group relative flex h-[30px] shrink-0 cursor-pointer items-center gap-1.5 border-r pr-2 pl-2.5 whitespace-nowrap transition-colors',
              index === 0 && 'border-l border-l-border',
              isActive
                ? 'bg-background text-foreground shadow-[inset_0_-1px_0_var(--accent)]'
                : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground bg-transparent',
            )}
            onClick={() => onSelect(terminal.id)}
            onKeyDown={(e) => handleTabKeyDown(terminal, index, e)}
          >
            <TerminalIcon className="text-accent size-3 shrink-0" />
            <span className="max-w-[100px] overflow-hidden text-ellipsis font-mono text-[11px]">
              {terminal.title}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                'text-muted-foreground hover:bg-destructive/15 hover:text-destructive ml-0.5 size-4 shrink-0 rounded-[3px] text-[14px] leading-none',
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
            </Button>
          </div>
        );
      })}
    </div>
  );
}
