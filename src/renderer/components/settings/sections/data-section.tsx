// data-section.tsx（自 SettingsDialog 拆分）
// 设置对话框 · 数据区块（会话导出 + 打开数据目录，数据极致）
// ──────────────────────────────────────────────
// 拆分背景：SettingsDialog 1052 行多域混合，按域提取为独立文件（高内聚）
// ──────────────────────────────────────────────

import { Database } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n/use-translation';
import { unwrap } from '@/lib/ipc';

/** 数据区块（会话导出 + 打开数据目录） */
export function DataSection(): React.ReactElement {
  const { t } = useTranslation();

  const handleExportAll = async (): Promise<void> => {
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
    const response = await window.api.app.openDataDir();
    const res = unwrap<{ ok: boolean }>(response);
    if (res.ok) {
      toast.success(t('settings.dataDirOpened'));
    } else {
      toast.error(t('settings.exportFailed'));
    }
  };

  return (
    <div className="space-y-3 pt-2">
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
    </div>
  );
}
