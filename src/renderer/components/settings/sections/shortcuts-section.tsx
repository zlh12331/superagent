// shortcuts-section.tsx（自 SettingsDialog 拆分）
// 设置 · 快捷键独立分区（36 号 C：录键冲突检测 + 恢复默认；原嵌通用页，后独立成导航项）
// ──────────────────────────────────────────────
// 设计：
// - 冲突检测在 onChange（ShortcutPicker 保持纯录制控件，不知业务清单）：
//   与其他自定义键或固定键冲突 → toast 指明冲突动作并拒绝写入（保留旧值）
// - 恢复默认：单键行内小钮（仅与默认值不同时显示）+ 分区底部一键全部恢复
//   （confirm 确认——覆盖类操作）；DEFAULT_SHORTCUTS 是单一真源
// ──────────────────────────────────────────────

import { Keyboard, RotateCcw } from 'lucide-react';
import type { ReactElement } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/use-translation';
import {
  CUSTOM_SHORTCUT_KEYS,
  type CustomShortcutKey,
  findShortcutConflict,
} from '@/lib/shortcut-conflicts';
import { DEFAULT_SHORTCUTS, useSettingsStore } from '@/stores/persistent/settings-store';
import { confirm } from '@/stores/transient/confirm-dialog-store';
import { ShortcutPicker } from '../shortcut-picker';

/** 自定义键 → 展示名 i18n key（冲突提示与行标签共用） */
const SHORTCUT_ITEMS: readonly { key: CustomShortcutKey; labelKey: string }[] = [
  { key: 'commandPalette', labelKey: 'palette.commandPaletteShortcut' },
  { key: 'saveFile', labelKey: 'common.saveFileShortcut' },
  { key: 'searchFile', labelKey: 'common.searchFileShortcut' },
  { key: 'toggleTheme', labelKey: 'common.toggleThemeShortcut' },
  { key: 'openSettings', labelKey: 'common.openSettingsShortcut' },
  { key: 'newSession', labelKey: 'common.newSessionShortcut' },
];

/** 快捷键设置区块 */
export function ShortcutsSection(): ReactElement {
  const { t } = useTranslation();
  const shortcuts = useSettingsStore((s) => s.shortcuts);
  const updateShortcuts = useSettingsStore((s) => s.updateShortcuts);

  /** 录入回调：冲突 → toast 指明冲突动作并拒绝写入；无冲突 → 写穿透 */
  const handleRecord = (key: CustomShortcutKey, value: string): void => {
    const conflict = findShortcutConflict(value, key, shortcuts);
    if (conflict !== null) {
      const action =
        conflict.kind === 'fixed'
          ? t(conflict.labelKey)
          : (SHORTCUT_ITEMS.find((item) => item.key === conflict.key)?.labelKey ?? '');
      toast.error(t('settings.shortcutConflict', { action }));
      return;
    }
    updateShortcuts({ [key]: value } as Partial<typeof shortcuts>);
  };

  /** 单键恢复默认（仅当前值 ≠ 默认时渲染入口） */
  const handleResetKey = (key: CustomShortcutKey): void => {
    updateShortcuts({ [key]: DEFAULT_SHORTCUTS[key] } as Partial<typeof shortcuts>);
  };

  /** 一键全部恢复默认（覆盖类操作：confirm 确认） */
  const handleResetAll = async (): Promise<void> => {
    const confirmed = await confirm({
      title: t('settings.shortcutResetAll'),
      message: t('settings.shortcutResetAllConfirm'),
      danger: true,
    });
    if (!confirmed) return;
    updateShortcuts({ ...DEFAULT_SHORTCUTS });
    toast.success(t('settings.shortcutResetAllDone'));
  };

  const hasDiffFromDefault = CUSTOM_SHORTCUT_KEYS.some(
    (key) => shortcuts[key] !== DEFAULT_SHORTCUTS[key],
  );

  return (
    <div className="flex flex-col gap-3 pt-2">
      <div className="flex items-center gap-2">
        <Keyboard className="text-muted-foreground size-4" strokeWidth={1.5} />
        <h3 className="text-foreground text-sm font-semibold">{t('settings.shortcuts.title')}</h3>
      </div>
      <p className="text-muted-foreground text-xs font-sans">{t('settings.shortcuts.hint')}</p>
      <div className="flex flex-col gap-2">
        {SHORTCUT_ITEMS.map((item) => {
          const changed = shortcuts[item.key] !== DEFAULT_SHORTCUTS[item.key];
          return (
            <div key={item.key} className="flex items-center justify-between gap-2">
              <span className="text-foreground text-xs">{t(item.labelKey)}</span>
              <div className="flex items-center gap-1.5">
                {changed && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-foreground size-6"
                    aria-label={t('settings.shortcutResetKey')}
                    title={t('settings.shortcutResetKey')}
                    onClick={() => handleResetKey(item.key)}
                  >
                    <RotateCcw className="size-3" strokeWidth={1.5} />
                  </Button>
                )}
                <ShortcutPicker
                  value={shortcuts[item.key]}
                  onChange={(value) => handleRecord(item.key, value)}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={!hasDiffFromDefault}
          onClick={() => void handleResetAll()}
        >
          {t('settings.shortcutResetAll')}
        </Button>
      </div>
    </div>
  );
}
