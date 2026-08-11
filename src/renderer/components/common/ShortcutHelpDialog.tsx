// src/renderer/components/common/ShortcutHelpDialog.tsx
// 快捷键帮助对话框（对齐参考项目 ShortcutHelpDialog + 原型 #shortcutHelp）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 双列网格展示应用内全部快捷键（kbd + 描述）
// - 触发入口：'?' 全局快捷键（AppShell 挂载）+ 设置抽屉快捷键 pane
// - 描述走 i18n（shortcutHelp.*），按键符号为技术标识不本地化
// ──────────────────────────────────────────────────────────────

import type { ReactElement } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useTranslation } from '@/i18n/use-translation';

/** 单条快捷键项：i18n 描述 key + 按键显示文本 */
interface ShortcutItem {
  readonly descriptionKey: string;
  readonly keys: string;
}

/** 快捷键清单（与应用内实际绑定对齐：settings-store 默认 + 固定键） */
const SHORTCUTS: readonly ShortcutItem[] = [
  // ⌘K 与 ⌘P 等价（对齐参考项目 toggle-command-palette）
  { descriptionKey: 'shortcutHelp.item.openCommandPalette', keys: 'Ctrl + P / Ctrl + K' },
  { descriptionKey: 'shortcutHelp.item.openSettings', keys: 'Ctrl + ,' },
  // F1 与 '?' 等价（对齐参考项目：? / F1 打开快捷键帮助）
  { descriptionKey: 'shortcutHelp.item.openShortcutHelp', keys: '? / F1' },
  { descriptionKey: 'shortcutHelp.item.newSession', keys: 'Ctrl + N' },
  { descriptionKey: 'shortcutHelp.item.toggleTheme', keys: 'Ctrl + Shift + T' },
  // ⌘F 打开文件模糊搜索（对齐参考项目：Ctrl/Cmd + F 触发 FuzzySearchDialog）
  { descriptionKey: 'shortcutHelp.item.searchFiles', keys: 'Ctrl + F' },
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

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="gap-0 p-0">
        <DialogHeader className="border-border border-b px-4 py-3">
          <DialogTitle className="text-[15px] font-semibold">{t('shortcutHelp.title')}</DialogTitle>
          <DialogDescription className="sr-only">{t('shortcutHelp.title')}</DialogDescription>
        </DialogHeader>
        {/* 双列网格（对齐原型 #shortcutHelp：grid-cols-2 + gap-x-6 + gap-y-1） */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 px-5 py-4 text-xs leading-[1.9]">
          {SHORTCUTS.map((item) => (
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
