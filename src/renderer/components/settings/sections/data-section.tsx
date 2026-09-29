// data-section.tsx（自 SettingsDialog 拆分）
// 设置对话框 · 数据区块（会话导出/导入 + 设置导出/导入 + 打开数据目录 + 更新缓存 + 清空全部会话，数据极致）
// ──────────────────────────────────────────────
// 拆分背景：SettingsDialog 1052 行多域混合，按域提取为独立文件（高内聚）
// ──────────────────────────────────────────────

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

/** 数据区块（会话导出/导入 + 设置导出/导入 + 打开数据目录 + 更新缓存） */
export function DataSection(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const closeSettings = useUiStore((s) => s.closeSettings);
  const clearAllSessionsMutation = useClearAllSessions();
  // 更新缓存占用（path 为 null 表示无法解析缓存目录 → 隐藏该行，不展示猜测值）
  const [cache, setCache] = useState<UpdateCacheInfo | null>(null);
  // 下载中禁止清理：缓存目录含 pending/ 下载中间态，清掉会破坏在途下载
  const downloading = useUpdateStore((s) => s.status?.phase === 'downloading');

  // 挂载时读一次占用（失败静默：不影响本区块其他操作）
  useEffect(() => {
    void (async (): Promise<void> => {
      try {
        setCache(await getUpdateCacheInfo());
      } catch {
        // 读取失败（含无桥）：不展示该行
      }
    })();
  }, []);

  const handleClearUpdateCache = async (): Promise<void> => {
    if (cache?.path == null || cache.fileCount === 0 || downloading) return;
    // 危险操作：删除的是差分更新基线，先确认并说明后果
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
      // 用户取消 / 无桥：静默
    } catch {
      toast.error(t('settings.exportFailed'));
    }
  };

  // 导入走 confirm（导入入口统一确认）：同 id 会话自动跳过，属合并不覆盖，
  // 故不标 danger；danger 留给真正覆盖式的设置导入
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
      // 用户取消 / 无桥：静默
    } catch {
      toast.error(t('settings.exportSettingsFailed'));
    }
  };

  // 覆盖类危险操作：导入会用文件中的同名设置覆盖当前值，确认标红
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

  // 恢复默认（覆盖类危险操作）：先把在途写穿透落库（防 DELETE 后旧值复活），
  // 再清空 app_settings 设置键；响应为空快照 → applySettingsSnapshot({}) 全量
  // 回落默认（内部含主题首帧镜像）。applySettingsSnapshot 不切 i18n 实例
  // （启动专用假设：此时 i18n 由 detector 读镜像初始化），运行时需显式切回。
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
      } catch {
        // 无痕模式等场景静默（SQLite 真源已是默认）
      }
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
    } catch {
      // 无桥 / IPC 失败：静默（与原「浏览器模式直接返回」一致，不误报）
    }
  };

  // 清空全部会话（36-D）：破坏性 danger 操作——confirm 明示不可恢复后调
  // session:clearAll（运行中回合由主进程拒绝 SESSION_IN_USE）。成功后：激活
  // 会话必已被删 → clearActiveSession + 回首页 + 关设置（对齐 Sidebar 删除
  // 激活会话的回落行为），toast 报告真实删除数
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
    } catch {
      // 错误提示由 useClearAllSessions 的 onError 统一弹出（防双弹约定），
      // 此处仅吞掉 mutateAsync 的 rejection
    }
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
        {/* 清空全部会话（36-D）：danger 覆盖式危险操作，与导出/导入同组 */}
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
    </div>
  );
}
