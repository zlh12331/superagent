// src/renderer/components/settings/sections/about-section.tsx
// 关于 pane（对齐参考项目 AboutSettingsPane / AboutDialog）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 展示应用版本号、运行时版本（Electron/Node/Chromium）与环境信息
// - 数据源：app:getInfo IPC（主进程 app.getVersion + process.versions）
// - 打开数据目录入口（app:openDataDir，与 data-section 共用能力）
// ──────────────────────────────────────────────────────────────

import type { AppInfoRes } from '@code-agent/shared/renderer';
import { Info, Rocket } from 'lucide-react';
import { type ReactElement, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/use-translation';
import { unwrap } from '@/lib/ipc';
import { SectionTitle, SettingRow } from '../settings-controls';

/**
 * 关于 pane
 */
export function AboutSection(): ReactElement {
  const { t } = useTranslation();
  const [info, setInfo] = useState<AppInfoRes | null>(null);

  // app:getInfo：应用版本与环境信息（浏览器模式兜底显示占位）
  useEffect(() => {
    let cancelled = false;
    if (typeof window === 'undefined' || window.api === undefined) {
      setInfo({
        version: 'dev',
        electron: '-',
        node: '-',
        chrome: '-',
        platform: 'browser',
        arch: '-',
        userDataPath: '-',
      });
      return;
    }
    window.api.app
      .getInfo()
      .then((res) => {
        if (!cancelled) {
          setInfo(unwrap<AppInfoRes>(res));
        }
      })
      .catch(() => {
        toast.error(t('settings.aboutLoadFailed'));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  return (
    <div className="space-y-2 pt-2">
      <div className="flex items-center gap-2">
        <Info className="size-4 text-stone-600" strokeWidth={1.5} />
        <span className="text-foreground font-serif text-sm tracking-wide">
          {t('settings.aboutSection')}
        </span>
      </div>

      {/* 应用标识 */}
      <div className="bg-card flex items-center gap-3 rounded-lg border px-3 py-3">
        <div className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-md">
          <Rocket className="size-4.5" strokeWidth={1.5} />
        </div>
        <div className="min-w-0">
          <div className="text-foreground text-sm font-medium">code-agent</div>
          <div className="text-muted-foreground text-[11px]">
            {info === null ? '…' : `v${info.version}`}
          </div>
        </div>
      </div>

      {/* 运行时版本 */}
      <SectionTitle>{t('settings.aboutRuntime')}</SectionTitle>
      <SettingRow label="Electron">
        <span className="text-muted-foreground font-mono text-xs">{info?.electron ?? '…'}</span>
      </SettingRow>
      <SettingRow label="Node.js">
        <span className="text-muted-foreground font-mono text-xs">{info?.node ?? '…'}</span>
      </SettingRow>
      <SettingRow label="Chromium">
        <span className="text-muted-foreground font-mono text-xs">{info?.chrome ?? '…'}</span>
      </SettingRow>

      {/* 环境信息 */}
      <SectionTitle>{t('settings.aboutEnvironment')}</SectionTitle>
      <SettingRow label={t('settings.aboutPlatform')}>
        <span className="text-muted-foreground font-mono text-xs">
          {info === null ? '…' : `${info.platform} ${info.arch}`}
        </span>
      </SettingRow>
      <SettingRow label={t('settings.aboutUserData')}>
        <span
          className="text-muted-foreground min-w-0 max-w-[220px] truncate font-mono text-[11px]"
          title={info?.userDataPath}
        >
          {info?.userDataPath ?? '…'}
        </span>
      </SettingRow>

      {/* 数据目录入口 */}
      <div className="pt-1">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (typeof window === 'undefined' || window.api === undefined) {
              return;
            }
            void window.api.app.openDataDir();
          }}
        >
          {t('settings.aboutOpenDataDir')}
        </Button>
      </div>
    </div>
  );
}
