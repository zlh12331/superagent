// src/renderer/components/settings/sections/editor-section.tsx
// 编辑器设置 pane（对齐参考项目 superagent EditorSettingsPane；37 号 A 补全排版域）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 字体大小（SegControl 12/14/16）：真实消费方 = 聊天消息区字号（ChatPanel 读取）
// - 自动换行（ToggleRow）：真实消费方 = 文件查看器查看/编辑双层（37 号 A）
// - Tab 宽度（SegControl 2/4/8）：经 --code-tab-size 收敛查看器/聊天代码块/diff
// - vim 模式（ToggleRow）：输入舱真实消费（ChatInput，见 vim 键位说明）
// - 数据源：settings-store.editor（persistent）
// ──────────────────────────────────────────────────────────────

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
