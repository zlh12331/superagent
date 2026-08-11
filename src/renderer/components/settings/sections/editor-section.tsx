// src/renderer/components/settings/sections/editor-section.tsx
// 编辑器设置 pane（对齐参考项目 superagent EditorSettingsPane）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 字体大小（SegControl 12/14/16）：真实消费方 = 聊天消息区字号（ChatPanel 读取）
// - vim 模式（ToggleRow）：存储于 settings-store（编辑器 vim 支持为后续功能，标注）
// - 数据源：settings-store.editor（persistent）
// ──────────────────────────────────────────────────────────────

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
