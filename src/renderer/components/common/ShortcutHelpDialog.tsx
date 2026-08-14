// src/renderer/components/common/ShortcutHelpDialog.tsx
// 快捷键帮助对话框（对齐参考项目 ShortcutHelpDialog + 原型 #shortcutHelp）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 双列网格展示应用内全部快捷键（kbd + 描述）
// - 触发入口：'?' 全局快捷键（AppShell 挂载）+ 设置抽屉快捷键 pane
// - 描述走 i18n（shortcutHelp.*），按键符号为技术标识不本地化
// ──────────────────────────────────────────────────────────────

import { type ReactElement, useMemo } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useTranslation } from '@/i18n/use-translation';
import { useSettingsStore } from '@/stores/persistent/settings-store';

/** 单条快捷键项：i18n 描述 key + 按键显示文本 */
interface ShortcutItem {
  readonly descriptionKey: string;
  readonly keys: string;
}

/** 键串展示格式化：Ctrl+Shift+F → Ctrl + Shift + F（kbd 排版用空格分隔） */
function formatKeys(value: string): string {
  return value.replaceAll('+', ' + ');
}

/** 固定键（不可自定义）——与 use-keyboard-shortcuts 的固定绑定一致 */
const FIXED_SHORTCUTS: readonly ShortcutItem[] = [
  // F1 与 '?' 等价（对齐参考项目：? / F1 打开快捷键帮助）
  { descriptionKey: 'shortcutHelp.item.openShortcutHelp', keys: '? / F1' },
  { descriptionKey: 'shortcutHelp.item.toggleSidebar', keys: 'Ctrl + B' },
  { descriptionKey: 'shortcutHelp.item.toggleRightPanel', keys: 'Ctrl + J' },
  // Ctrl+` 打开终端（对齐参考项目 codex.openTerminal 快捷键）
  { descriptionKey: 'shortcutHelp.item.openTerminal', keys: 'Ctrl + `' },
  // Alt+← 返回上一视图（对齐参考项目 backBtn）
  { descriptionKey: 'shortcutHelp.item.back', keys: 'Alt + ←' },
  { descriptionKey: 'shortcutHelp.item.sendMessage', keys: 'Enter' },
  { descriptionKey: 'shortcutHelp.item.newline', keys: 'Shift + Enter' },
  { descriptionKey: 'shortcutHelp.item.closeDialog', keys: 'Esc' },
];

/** ShortcutHelpDialog props */
export interface ShortcutHelpDialogProps {
  /** 是否显示 */
  readonly open: boolean;
  /** 关闭回调 */
  readonly onClose: () => void;
}

/**
 * 快捷键帮助对话框
 */
export function ShortcutHelpDialog({ open, onClose }: ShortcutHelpDialogProps): ReactElement {
  const { t } = useTranslation();
  // 可自定义快捷键读设置真源（此前硬编码默认值：用户改键后帮助表与实际绑定不一致，实测 bug）
  const shortcuts = useSettingsStore((s) => s.shortcuts);
  const items = useMemo<readonly ShortcutItem[]>(
    () => [
      // ⌘K 与 ⌘P 等价（对齐参考项目 toggle-command-palette）
      {
        descriptionKey: 'shortcutHelp.item.openCommandPalette',
        keys: `${formatKeys(shortcuts.commandPalette)} / Ctrl + K`,
      },
      {
        descriptionKey: 'shortcutHelp.item.openSettings',
        keys: formatKeys(shortcuts.openSettings),
      },
      { descriptionKey: 'shortcutHelp.item.newSession', keys: formatKeys(shortcuts.newSession) },
      { descriptionKey: 'shortcutHelp.item.toggleTheme', keys: formatKeys(shortcuts.toggleTheme) },
      { descriptionKey: 'shortcutHelp.item.searchFiles', keys: formatKeys(shortcuts.searchFile) },
      ...FIXED_SHORTCUTS,
    ],
    [shortcuts],
  );

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="gap-0 p-0">
        <DialogHeader className="border-border border-b px-4 py-3">
          <DialogTitle className="text-[15px] font-semibold">{t('shortcutHelp.title')}</DialogTitle>
          <DialogDescription className="sr-only">{t('shortcutHelp.title')}</DialogDescription>
        </DialogHeader>
        {/* 双列网格（对齐原型 #shortcutHelp：grid-cols-2 + gap-x-6 + gap-y-1） */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 px-5 py-4 text-xs leading-[1.9]">
          {items.map((item) => (
            <div key={item.descriptionKey} className="flex items-center gap-1.5">
              <kbd className="text-primary border-border bg-muted inline-flex shrink-0 items-center rounded-[3px] border px-1.5 py-px font-mono text-2xs">
                {item.keys}
              </kbd>
              <span className="text-muted-foreground truncate">{t(item.descriptionKey)}</span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
