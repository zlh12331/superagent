import { EDITOR_TAB_SIZES } from '@code-agent/shared/renderer';
import type { ReactElement } from 'react';
import { useTranslation } from '@/i18n/use-translation';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { SectionTitle, SegControl, SettingRow, ToggleRow } from '../settings-controls';

/**
 * 编辑器设置 pane
 */
export function EditorSection(): ReactElement {
  const { t } = useTranslation();
  const editor = useSettingsStore((s) => s.editor);
  const updateEditor = useSettingsStore((s) => s.updateEditor);

  return (
    <div className="flex flex-col gap-2">
      <SectionTitle>{t('settings.editor.display')}</SectionTitle>
      <SettingRow label={t('settings.editor.fontSize')}>
        <SegControl
          value={String(editor.fontSize)}
          onChange={(value) => updateEditor({ fontSize: Number(value) })}
          options={[
            { value: '12', label: '12' },
            { value: '14', label: '14' },
            { value: '16', label: '16' },
          ]}
        />
      </SettingRow>
      <SettingRow
        label={t('settings.editor.tabSize')}
        description={t('settings.editor.tabSizeDesc')}
      >
        <SegControl
          value={String(editor.tabSize)}
          onChange={(value) => updateEditor({ tabSize: Number(value) })}
          options={EDITOR_TAB_SIZES.map((size) => ({ value: String(size), label: String(size) }))}
        />
      </SettingRow>
      <ToggleRow
        name={t('settings.editor.wordWrap')}
        description={t('settings.editor.wordWrapDesc')}
        checked={editor.wordWrap}
        onChange={(checked) => updateEditor({ wordWrap: checked })}
      />

      <SectionTitle>{t('settings.editor.behavior')}</SectionTitle>
      <ToggleRow
        name={t('settings.editor.vimMode')}
        description={t('settings.editor.vimModeDesc')}
        checked={editor.vimMode}
        onChange={(checked) => updateEditor({ vimMode: checked })}
      />
    </div>
  );
}
