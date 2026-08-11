// shortcuts-section.tsx（自 SettingsDialog 拆分）
// 设置对话框 · 快捷键设置
// ──────────────────────────────────────────────
// 拆分背景：SettingsDialog 1052 行多域混合，按域提取为独立文件（高内聚）
// ──────────────────────────────────────────────

import { Keyboard } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n/use-translation';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { ShortcutPicker } from '../shortcut-picker';

/** 快捷键设置区块 */
export function ShortcutsSection(): React.ReactElement {
  const { t } = useTranslation();
  const shortcuts = useSettingsStore((s) => s.shortcuts);
  const updateShortcuts = useSettingsStore((s) => s.updateShortcuts);

  return (
    <div className="flex flex-col gap-3 pt-2">
      <div className="flex items-center gap-2">
        <Keyboard className="text-muted-foreground size-4" strokeWidth={1.5} />
        <Label className="font-serif text-sm tracking-wide">{t('common.shortcuts')}</Label>
      </div>
      <p className="text-xs text-muted-foreground font-sans">{t('common.shortcutsHint')}</p>
      <div className="flex flex-col gap-2">
        {[
          { key: 'commandPalette', labelKey: 'palette.commandPaletteShortcut' },
          { key: 'saveFile', labelKey: 'common.saveFileShortcut' },
          { key: 'searchFile', labelKey: 'common.searchFileShortcut' },
          { key: 'toggleTheme', labelKey: 'common.toggleThemeShortcut' },
          { key: 'openSettings', labelKey: 'common.openSettingsShortcut' },
          { key: 'newSession', labelKey: 'common.newSessionShortcut' },
        ].map((item) => (
          <div key={item.key} className="flex items-center justify-between gap-2">
            <span className="text-foreground text-xs">{t(item.labelKey)}</span>
            <ShortcutPicker
              value={shortcuts[item.key as keyof typeof shortcuts]}
              onChange={(value) =>
                updateShortcuts({ [item.key]: value } as Partial<typeof shortcuts>)
              }
            />
          </div>
        ))}
      </div>
    </div>
  );
}
