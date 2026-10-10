import type { UpdateCacheInfo } from '@code-agent/shared/renderer';
import { Database } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useClearAllSessions } from '@/hooks/use-sessions';
import { changeLanguage, LANGUAGE_STORAGE_KEY } from '@/i18n/config';
import { useTranslation } from '@/i18n/use-translation';
import { ROUTES } from '@/lib/constants';
import { formatBytes } from '@/lib/format-bytes';
import {
  clearUpdateCache,
  exportAllSessions,
  exportSettingsFile,
  getUpdateCacheInfo,
  importAllSessions,
  importSettingsFile,
  openDataDirChecked,
  resetAllSettings,
} from '@/lib/settings-ops';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';
import {
  applySettingsSnapshot,
  flushPendingSettings,
  useSettingsStore,
} from '@/stores/persistent/settings-store';
import { confirm } from '@/stores/transient/confirm-dialog-store';
import { useUiStore } from '@/stores/transient/ui-store';
import { useUpdateStore } from '@/stores/transient/update-store';

import { BackupBlock } from './backup-block';

/** 数据区块（会话导出/导入 + 设置导出/导入 + 打开数据目录 + 更新缓存） */
export function DataSection(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const closeSettings = useUiStore((s) => s.closeSettings);
  const clearAllSessionsMutation = useClearAllSessions();
  const [cache, setCache] = useState<UpdateCacheInfo | null>(null);
  const downloading = useUpdateStore((s) => s.status?.phase === 'downloading');

  useEffect(() => {
    void (async (): Promise<void> => {
      try {
        setCache(await getUpdateCacheInfo());
      } catch {}
    })();
  }, []);

  const handleClearUpdateCache = async (): Promise<void> => {
    if (cache?.path == null || cache.fileCount === 0 || downloading) return;
    const confirmed = await confirm({
      title: t('settings.clearUpdateCache'),
      message: t('settings.clearUpdateCacheConfirm'),
      danger: true,
    });
    if (!confirmed) return;
    try {
      setCache(await clearUpdateCache());
      toast.success(t('settings.clearUpdateCacheDone'));
    } catch {
      toast.error(t('settings.exportFailed'));
    }
  };

  const handleExportAll = async (): Promise<void> => {
    try {
      const res = await exportAllSessions();
      if (res.saved) {
        toast.success(t('settings.exportSuccess', { path: res.path ?? '' }));
      }
    } catch {
      toast.error(t('settings.exportFailed'));
    }
  };

  const handleImportAll = async (): Promise<void> => {
    const confirmed = await confirm({
      title: t('settings.importSessions'),
      message: t('settings.importSessionsConfirm'),
    });
    if (!confirmed) return;
    try {
      const res = await importAllSessions();
      toast.success(
        t('settings.importSessionsDone', { imported: res.imported, skipped: res.skipped }),
      );
    } catch {
      toast.error(t('settings.importSessionsFailed'));
    }
  };

  const handleExportSettings = async (): Promise<void> => {
    try {
      const res = await exportSettingsFile();
      if (res.saved) {
        toast.success(t('settings.exportSuccess', { path: res.path ?? '' }));
      }
    } catch {
      toast.error(t('settings.exportSettingsFailed'));
    }
  };

  const handleImportSettings = async (): Promise<void> => {
    const confirmed = await confirm({
      title: t('settings.importSettings'),
      message: t('settings.importSettingsConfirm'),
      danger: true,
    });
    if (!confirmed) return;
    try {
      const res = await importSettingsFile();
      toast.success(
        t('settings.importSettingsDone', { imported: res.imported, skipped: res.skipped }),
      );
    } catch {
      toast.error(t('settings.importSettingsFailed'));
    }
  };

  const handleResetAllSettings = async (): Promise<void> => {
    const confirmed = await confirm({
      title: t('settings.resetAllSettings'),
      message: t('settings.resetAllSettingsConfirm'),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await flushPendingSettings();
      const settings = await resetAllSettings();
      applySettingsSnapshot(settings);
      const language = useSettingsStore.getState().language;
      changeLanguage(language);
      try {
        localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
      } catch {}
      toast.success(t('settings.resetAllSettingsDone'));
    } catch {
      toast.error(t('settings.resetAllSettingsFailed'));
    }
  };

  const handleOpenDataDir = async (): Promise<void> => {
    try {
      const res = await openDataDirChecked();
      if (res.ok) {
        toast.success(t('settings.dataDirOpened'));
      } else {
        toast.error(t('settings.exportFailed'));
      }
    } catch {}
  };

  const handleClearAllSessions = async (): Promise<void> => {
    const confirmed = await confirm({
      title: t('settings.clearAllSessions'),
      message: t('settings.clearAllSessionsConfirm'),
      danger: true,
    });
    if (!confirmed) return;
    try {
      const { deleted } = await clearAllSessionsMutation.mutateAsync();
      useActiveSessionStore.getState().clearActiveSession();
      navigate(ROUTES.home);
      closeSettings();
      toast.success(t('settings.clearAllSessionsDone', { count: String(deleted) }));
    } catch {}
  };

  return (
    <div className="flex flex-col gap-3 pt-2">
      <div className="flex items-center gap-2">
        <Database className="size-4 text-muted-foreground" strokeWidth={1.5} />
        <Label className="font-serif text-sm tracking-wide">{t('settings.dataSection')}</Label>
      </div>
      <p className="text-xs text-muted-foreground font-sans">{t('settings.dataHint')}</p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={handleExportAll}>
          {t('settings.exportSessions')}
        </Button>
        <Button variant="outline" size="sm" onClick={handleImportAll}>
          {t('settings.importSessions')}
        </Button>
        <Button variant="outline" size="sm" onClick={handleOpenDataDir}>
          {t('settings.openDataDir')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="text-error-text border-error-text/40 hover:bg-error-text/10 hover:text-error-text"
          disabled={clearAllSessionsMutation.isPending}
          onClick={() => void handleClearAllSessions()}
        >
          {t('settings.clearAllSessions')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground font-sans">{t('settings.settingsDataHint')}</p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={handleExportSettings}>
          {t('settings.exportSettings')}
        </Button>
        <Button variant="outline" size="sm" onClick={handleImportSettings}>
          {t('settings.importSettings')}
        </Button>
        <Button variant="outline" size="sm" onClick={() => void handleResetAllSettings()}>
          {t('settings.resetAllSettings')}
        </Button>
      </div>
      {cache !== null && cache.path !== null && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground font-sans text-xs">
            {t('settings.updateCacheUsage', {
              size: formatBytes(cache.bytes),
              count: String(cache.fileCount),
            })}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={cache.fileCount === 0 || downloading}
            onClick={() => void handleClearUpdateCache()}
          >
            {t('settings.clearUpdateCache')}
          </Button>
        </div>
      )}

      <BackupBlock />
    </div>
  );
}
