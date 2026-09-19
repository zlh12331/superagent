// src/renderer/components/settings/sections/general-section.tsx
// 通用 pane（对齐 Trae Work：语言 / 数据管理 / 遥测聚合）
// ──────────────────────────────────────────────────────────────
// 聚合原散落项：语言切换（i18n 真实）+ 数据管理（原 data pane）+ 遥测（原 telemetry pane）
// ──────────────────────────────────────────────────────────────

import { Check, Database, Languages } from 'lucide-react';
import { type ReactElement, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { changeLanguage, SUPPORTED_LANGUAGES, type SupportedLanguage } from '@/i18n/config';
import { useTranslation } from '@/i18n/use-translation';
import { hasIpcBridge, unwrap } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { type AppLanguage, useSettingsStore } from '@/stores/persistent/settings-store';
import { SegControl, SettingRow, ToggleRow } from '../settings-controls';
import { DataSection } from './data-section';
import { EditorSection } from './editor-section';
import { PromptSection } from './prompt-section';
import { ShortcutsSection } from './shortcuts-section';
import { TelemetrySection } from './telemetry-section';

/** 语言切换行（真实 i18n：changeLanguage 立即生效；P2：同步写入 SQLite 设置链路） */
function LanguageRow(): ReactElement {
  const { t, i18n } = useTranslation();
  const currentLang = i18n.language?.startsWith('en') ? 'en' : 'zh-CN';
  const [lang, setLang] = useState<string>(currentLang);

  const handleSelect = (next: string): void => {
    setLang(next);
    void changeLanguage(next as SupportedLanguage);
    // P2 修复：语言此前只进 localStorage（detector 缓存），重装/多窗口不同步——
    // 经 settings-store 写穿透落 SQLite 真源
    useSettingsStore.getState().setLanguage(next as AppLanguage);
  };

  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <Languages className="text-muted-foreground size-3.5" strokeWidth={1.5} />
        <span className="text-foreground text-sm">{t('settings.language')}</span>
      </div>
      <div className="flex items-center gap-1">
        {SUPPORTED_LANGUAGES.map((code) => (
          <Button
            key={code}
            variant="ghost"
            size="sm"
            className={cn(
              'h-auto gap-1 rounded px-2 py-1 text-xs',
              lang === code
                ? 'bg-muted text-foreground border-border'
                : 'text-muted-foreground border-transparent',
            )}
            onClick={() => handleSelect(code)}
          >
            {code === 'zh-CN' ? '简体中文' : 'English'}
            {lang === code && <Check className="size-3" strokeWidth={2} />}
          </Button>
        ))}
      </div>
    </div>
  );
}

/** 通用 pane：语言 + 窗口行为 + 数据管理 + 遥测 + 编辑器/快捷键/提示词（导航收敛后并入） */
export function GeneralSection({ drawerOpen }: { readonly drawerOpen: boolean }): ReactElement {
  const { t } = useTranslation();
  const closeAction = useSettingsStore((s) => s.window.closeAction);
  const setWindow = useSettingsStore((s) => s.setWindow);
  const [openAtLogin, setOpenAtLogin] = useState<boolean | null>(null);

  // 开机自启状态挂载时回显（OS 登录项为唯一真源，读取失败隐藏开关避免误导）
  useEffect(() => {
    if (!hasIpcBridge()) return;
    void (async () => {
      try {
        const res = unwrap<{ openAtLogin: boolean }>(await window.api.app.getLoginItemSettings());
        setOpenAtLogin(res.openAtLogin);
      } catch {
        // 读取失败（桥不存在/旧版本）：隐藏开关避免误导
        setOpenAtLogin(null);
      }
    })();
  }, []);

  const handleToggleAutostart = async (checked: boolean): Promise<void> => {
    if (!hasIpcBridge()) return;
    try {
      const res = unwrap<{ openAtLogin: boolean }>(
        await window.api.app.setLoginItemSettings({ openAtLogin: checked }),
      );
      setOpenAtLogin(res.openAtLogin);
    } catch {
      toast.error(t('settings.autostartFailed'));
    }
  };

  return (
    <div className="flex flex-col gap-5 pt-2">
      <div>
        <h3 className="text-foreground text-sm font-semibold">{t('settings.generalTitle')}</h3>
        <div className="border-border bg-muted/20 mt-2 rounded-md border p-3">
          <LanguageRow />
        </div>
      </div>

      {/* 窗口行为（关窗语义 + 开机自启，见 docs/design/28-tray-spec.md） */}
      <div>
        <h3 className="text-foreground text-sm font-semibold">{t('settings.windowTitle')}</h3>
        <div className="mt-2 flex flex-col gap-2">
          <SettingRow
            label={t('settings.closeActionLabel')}
            description={t('settings.closeActionDesc')}
          >
            <SegControl
              value={closeAction}
              options={[
                { value: 'minimize', label: t('settings.closeActionMinimize') },
                { value: 'quit', label: t('settings.closeActionQuit') },
              ]}
              onChange={(value) => setWindow({ closeAction: value as 'quit' | 'minimize' })}
            />
          </SettingRow>
          <ToggleRow
            name={t('settings.autostartLabel')}
            description={t('settings.autostartDesc')}
            checked={openAtLogin ?? false}
            onChange={(checked) => void handleToggleAutostart(checked)}
          />
        </div>
      </div>

      {/* 编辑器 / 快捷键 / 提示词（并入通用） */}
      <div className="flex flex-col gap-4">
        <EditorSection />
        <ShortcutsSection />
        <PromptSection open={drawerOpen} />
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
