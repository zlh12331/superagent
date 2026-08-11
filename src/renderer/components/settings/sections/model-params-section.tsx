// src/renderer/components/settings/sections/model-params-section.tsx
// 模型参数 pane（对齐参考项目 ApiConfigSettingsPane + 原型 seg-control）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 默认模型（文本输入，接 settings-store ai.defaultModel）
// - 默认温度（SegControl 0.3/0.7/1.0，接 settings-store ai.temperature）
// - 数据源：settings-store（persistent，跨重启保留）
// ──────────────────────────────────────────────────────────────

import type { ReactElement } from 'react';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/i18n/use-translation';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { SectionTitle, SegControl, SettingField, SettingRow } from '../settings-controls';

/**
 * 模型参数 pane
 */
export function ModelParamsSection(): ReactElement {
  const { t } = useTranslation();
  const ai = useSettingsStore((s) => s.ai);
  const updateAi = useSettingsStore((s) => s.updateAi);

  return (
    <div className="flex flex-col gap-2">
      <SectionTitle>{t('settings.modelParams.selection')}</SectionTitle>
      <SettingField
        label={t('settings.modelParams.defaultModel')}
        description={t('settings.modelParams.defaultModelDesc')}
      >
        <Input
          value={ai.defaultModel}
          onChange={(e) => updateAi({ defaultModel: e.target.value })}
          className="font-mono"
          spellCheck={false}
        />
      </SettingField>

      <SectionTitle>{t('settings.modelParams.parameters')}</SectionTitle>
      <SettingRow label={t('settings.modelParams.temperature')}>
        <SegControl
          value={String(ai.temperature)}
          onChange={(value) => updateAi({ temperature: Number(value) })}
          options={[
            { value: '0.3', label: '0.3' },
            { value: '0.7', label: '0.7' },
            { value: '1.0', label: '1.0' },
          ]}
        />
      </SettingRow>

      {/* 思考强度（对齐原型 thinking seg-control：off/low/medium/high）
          仅 reasoning 模型生效；透传给主进程覆盖模型级默认档位 */}
      <SettingRow
        label={t('settings.modelParams.thinking')}
        description={t('settings.modelParams.thinkingDesc')}
      >
        <SegControl
          value={ai.thinking}
          onChange={(value) => updateAi({ thinking: value as typeof ai.thinking })}
          options={[
            { value: 'off', label: t('settings.modelParams.thinkingOff') },
            { value: 'low', label: t('settings.modelParams.thinkingLow') },
            { value: 'medium', label: t('settings.modelParams.thinkingMedium') },
            { value: 'high', label: t('settings.modelParams.thinkingHigh') },
          ]}
        />
      </SettingRow>
    </div>
  );
}
