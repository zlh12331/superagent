// src/renderer/components/settings/sections/browser-section.tsx
// 浏览器 pane（对齐 Trae Work：浏览器工具设置）
// ──────────────────────────────────────────────────────────────
// 右面板「浏览器」tab 为 iframe 预览工具（渲染层），
// 本 pane 说明其行为；高级策略配置规划中，诚实标注。
// ──────────────────────────────────────────────────────────────

import { Globe } from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from '@/i18n/use-translation';

/** 浏览器 pane */
export function BrowserSection(): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3 pt-2">
      <div className="flex items-center gap-2">
        <Globe className="text-muted-foreground size-3.5" strokeWidth={1.5} />
        <h3 className="text-foreground text-sm font-semibold">{t('settings.nav.browser')}</h3>
      </div>
      <p className="text-muted-foreground max-w-md text-xs leading-relaxed">
        {t('settings.browserHint')}
      </p>
      <div className="border-border bg-muted/20 rounded-md border px-3 py-2.5">
        <span className="text-muted-foreground text-2xs">
          🚧 {t('settings.nav.browser')} · 配置项规划中
        </span>
      </div>
    </div>
  );
}
