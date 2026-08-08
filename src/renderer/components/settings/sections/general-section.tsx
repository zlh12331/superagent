// src/renderer/components/settings/sections/general-section.tsx
// 通用 pane（对齐 Trae Work：语言 / 数据管理 / 遥测聚合）
// ──────────────────────────────────────────────────────────────
// 聚合原散落项：语言切换（i18n 真实）+ 数据管理（原 data pane）+ 遥测（原 telemetry pane）
// ──────────────────────────────────────────────────────────────

import { Check, Database, Languages } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { changeLanguage, SUPPORTED_LANGUAGES, type SupportedLanguage } from '@/i18n/config';
import { useTranslation } from '@/i18n/use-translation';
import { DataSection } from './data-section';
import { TelemetrySection } from './telemetry-section';

/** 语言切换行（真实 i18n：changeLanguage 立即生效） */
function LanguageRow(): ReactElement {
  const { t, i18n } = useTranslation();
  const currentLang = i18n.language?.startsWith('en') ? 'en' : 'zh-CN';
  const [lang, setLang] = useState<string>(currentLang);

  const handleSelect = (next: string): void => {
    setLang(next);
    void changeLanguage(next as SupportedLanguage);
  };

  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <Languages className="text-muted-foreground size-3.5" strokeWidth={1.5} />
        <span className="text-foreground text-sm">{t('settings.language')}</span>
      </div>
      <div className="flex items-center gap-1">
        {SUPPORTED_LANGUAGES.map((code) => (
          <button
            key={code}
            type="button"
            className={cnRow(lang === code)}
            onClick={() => handleSelect(code)}
          >
            {code === 'zh-CN' ? '简体中文' : 'English'}
            {lang === code && <Check className="size-3" strokeWidth={2} />}
          </button>
        ))}
      </div>
    </div>
  );
}

function cnRow(active: boolean): string {
  return [
    'flex cursor-pointer items-center gap-1 rounded border px-2 py-1 text-xs transition-colors',
    active ? 'bg-muted text-foreground border-border' : 'text-muted-foreground border-transparent',
  ].join(' ');
}

/** 通用 pane：语言 + 数据管理 + 遥测 */
export function GeneralSection(): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="space-y-4 pt-2">
      <div>
        <h3 className="text-foreground text-sm font-semibold">{t('settings.generalTitle')}</h3>
        <div className="border-border bg-muted/20 mt-2 rounded-md border p-3">
          <LanguageRow />
        </div>
      </div>

      {/* 数据管理（会话导出 + 打开数据目录） */}
      <div>
        <div className="flex items-center gap-2">
          <Database className="text-muted-foreground size-3.5" strokeWidth={1.5} />
          <h3 className="text-foreground text-sm font-semibold">{t('settings.dataTitle')}</h3>
        </div>
        <div className="mt-2">
          <DataSection />
        </div>
      </div>

      {/* 遥测与隐私 */}
      <div>
        <h3 className="text-foreground text-sm font-semibold">{t('settings.telemetryTitle')}</h3>
        <div className="mt-2">
          <TelemetrySection />
        </div>
      </div>
    </div>
  );
}
