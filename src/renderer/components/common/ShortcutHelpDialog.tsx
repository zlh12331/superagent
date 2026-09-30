// src/renderer/components/common/ShortcutHelpDialog.tsx
// 快捷键帮助对话框（对齐参考项目 ShortcutHelpDialog + 原型 #shortcutHelp）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 双列网格展示应用内全部快捷键（kbd + 描述）
// - 触发入口：'?' 全局快捷键（AppShell 挂载）+ 设置抽屉快捷键 pane
// - 描述走 i18n（shortcutHelp.*），按键符号为技术标识不本地化
// ──────────────────────────────────────────────────────────────

import { Keyboard } from 'lucide-react';
import type { ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useTranslation } from '@/i18n/use-translation';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { useUiStore } from '@/stores/transient/ui-store';

/** 单条快捷键项：i18n 描述 key + 按键显示文本 */
export interface ShortcutItem {
  readonly descriptionKey: string;
  readonly keys: string;
}

/** 键串展示格式化：Ctrl+Shift+F → Ctrl + Shift + F（kbd 排版用空格分隔） */
export function formatKeys(value: string): string {
  return value.replaceAll('+', ' + ');
}

/**
 * 固定键清单（不可自定义）——与 use-keyboard-shortcuts 的固定绑定一致
 *
 * 唯一真源：ShortcutHelpDialog 帮助表与设置快捷键分区只读小节共用，
 * 防两处清单漂移（36 号 C 曾发生帮助表漏列缩放键）。
 */
export const FIXED_SHORTCUTS: readonly ShortcutItem[] = [
  // F1 与 '?' 等价（对齐参考项目：? / F1 打开快捷键帮助）
  { descriptionKey: 'shortcutHelp.item.openShortcutHelp', keys: '? / F1' },
  { descriptionKey: 'shortcutHelp.item.toggleSidebar', keys: 'Ctrl + B' },
  { descriptionKey: 'shortcutHelp.item.toggleRightPanel', keys: 'Ctrl + J' },
  // Ctrl+` 打开终端（对齐参考项目 codex.openTerminal 快捷键）
  { descriptionKey: 'shortcutHelp.item.openTerminal', keys: 'Ctrl + `' },
  // Alt+← 返回上一视图（对齐参考项目 backBtn）
  { descriptionKey: 'shortcutHelp.item.back', keys: 'Alt + ←' },
  // 界面缩放（35 号固定键区：36 号 C 补录进帮助——此前帮助表漏列）
  { descriptionKey: 'shortcutHelp.item.zoomIn', keys: 'Ctrl + =' },
  { descriptionKey: 'shortcutHelp.item.zoomOut', keys: 'Ctrl + -' },
  { descriptionKey: 'shortcutHelp.item.zoomReset', keys: 'Ctrl + 0' },
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
  // 「自定义快捷键」直达：多入口分区机制复用（openSettings 带分区 id），先关本对话框再开设置
  const openSettings = useUiStore((s) => s.openSettings);
  // 纯派生，交给 React Compiler 记忆化（shortcuts 稳定时复用）
  const items: readonly ShortcutItem[] = [
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
  ];

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
              <kbd className="text-primary border-border bg-muted inline-flex shrink-0 items-center rounded-[calc(var(--radius)-5px)] border px-1.5 py-px font-mono text-2xs">
                {item.keys}
              </kbd>
              <span className="text-muted-foreground truncate">{t(item.descriptionKey)}</span>
            </div>
          ))}
        </div>
        {/* 底部直达：自定义快捷键去设置分区（快速参考与管理面板的联动入口） */}
        <div className="border-border flex justify-end border-t px-5 py-3">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground h-auto gap-1.5 rounded px-2 py-1 text-xs"
            onClick={() => {
              onClose();
              openSettings('shortcuts');
            }}
          >
            <Keyboard className="size-3.5" strokeWidth={1.5} />
            {t('shortcutHelp.customize')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
