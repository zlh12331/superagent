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
  { descriptionKey: 'shortcutHelp.item.openShortcutHelp', keys: '? / F1' },
  { descriptionKey: 'shortcutHelp.item.toggleSidebar', keys: 'Ctrl + B' },
  { descriptionKey: 'shortcutHelp.item.toggleRightPanel', keys: 'Ctrl + J' },
  { descriptionKey: 'shortcutHelp.item.openTerminal', keys: 'Ctrl + `' },
  { descriptionKey: 'shortcutHelp.item.back', keys: 'Alt + ←' },
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
  const shortcuts = useSettingsStore((s) => s.shortcuts);
  const openSettings = useUiStore((s) => s.openSettings);
  const items: readonly ShortcutItem[] = [
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
          <DialogTitle className="text-md font-semibold">{t('shortcutHelp.title')}</DialogTitle>
          <DialogDescription className="sr-only">{t('shortcutHelp.title')}</DialogDescription>
        </DialogHeader>
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
