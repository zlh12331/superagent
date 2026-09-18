// data-section.tsx（自 SettingsDialog 拆分）
// 设置对话框 · 数据区块（会话导出 + 打开数据目录 + 更新缓存占用与清理，数据极致）
// ──────────────────────────────────────────────
// 拆分背景：SettingsDialog 1052 行多域混合，按域提取为独立文件（高内聚）
// ──────────────────────────────────────────────

import type { UpdateCacheInfo } from '@code-agent/shared/renderer';
import { Database } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n/use-translation';
import { formatBytes } from '@/lib/format-bytes';
import { hasIpcBridge, unwrap } from '@/lib/ipc';
import { confirm } from '@/stores/transient/confirm-dialog-store';
import { useUpdateStore } from '@/stores/transient/update-store';

/** 数据区块（会话导出 + 打开数据目录 + 更新缓存） */
export function DataSection(): React.ReactElement {
  const { t } = useTranslation();
  // 更新缓存占用（path 为 null 表示无法解析缓存目录 → 隐藏该行，不展示猜测值）
  const [cache, setCache] = useState<UpdateCacheInfo | null>(null);
  // 下载中禁止清理：缓存目录含 pending/ 下载中间态，清掉会破坏在途下载
  const downloading = useUpdateStore((s) => s.status?.phase === 'downloading');

  // 挂载时读一次占用（失败静默：不影响本区块其他操作）
  useEffect(() => {
    if (!hasIpcBridge()) return;
    void (async (): Promise<void> => {
      try {
        setCache(unwrap<UpdateCacheInfo>(await window.api.update.getCacheInfo()));
      } catch {
        // 读取失败：不展示该行
      }
    })();
  }, []);

  const handleClearUpdateCache = async (): Promise<void> => {
    if (!hasIpcBridge() || cache?.path == null || cache.fileCount === 0 || downloading) return;
    // 危险操作：删除的是差分更新基线，先确认并说明后果
    const confirmed = await confirm({
      title: t('settings.clearUpdateCache'),
      message: t('settings.clearUpdateCacheConfirm'),
      danger: true,
    });
    if (!confirmed) return;
    try {
      setCache(unwrap<UpdateCacheInfo>(await window.api.update.clearCache()));
      toast.success(t('settings.clearUpdateCacheDone'));
    } catch {
      toast.error(t('settings.exportFailed'));
    }
  };

  const handleExportAll = async (): Promise<void> => {
    if (!hasIpcBridge()) return;
    try {
      const response = await window.api.session.exportAll();
      const res = unwrap<{ saved: boolean; path?: string }>(response);
      if (res.saved) {
        toast.success(t('settings.exportSuccess', { path: res.path ?? '' }));
      }
      // 用户取消：静默
    } catch {
      toast.error(t('settings.exportFailed'));
    }
  };

  const handleOpenDataDir = async (): Promise<void> => {
    // 浏览器模式无桥：直接返回（否则成员访问阶段抛 TypeError，下面的 await 兜不住）
    if (!hasIpcBridge()) return;
    const response = await window.api.app.openDataDir();
    const res = unwrap<{ ok: boolean }>(response);
    if (res.ok) {
      toast.success(t('settings.dataDirOpened'));
    } else {
      toast.error(t('settings.exportFailed'));
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
        <Button variant="outline" size="sm" onClick={handleOpenDataDir}>
          {t('settings.openDataDir')}
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
