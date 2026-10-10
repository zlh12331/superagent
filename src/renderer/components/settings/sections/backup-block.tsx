import type { BackupEntry } from '@code-agent/shared/renderer';
import { History, RotateCcw } from 'lucide-react';
import type { ReactElement } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useBackups, useCreateBackup, useRestoreBackup } from '@/hooks/use-backups';
import { useTranslation } from '@/i18n/use-translation';
import { formatBytes } from '@/lib/format-bytes';
import { cn } from '@/lib/utils';
import { confirm } from '@/stores/transient/confirm-dialog-store';

/** 时间戳 → 本地可读时间（列表展示用；秒级足够） */
function formatBackupTime(ms: number): string {
  if (ms <= 0) {
    return '-';
  }
  return new Date(ms).toLocaleString();
}

/** 启动备份子块（恢复点列表 + 立即备份 + 逐行恢复） */
export function BackupBlock(): ReactElement {
  const { t } = useTranslation();
  const backupsQuery = useBackups();
  const createBackup = useCreateBackup();
  const restoreBackup = useRestoreBackup();

  const backups: readonly BackupEntry[] = backupsQuery.data ?? [];

  const handleCreate = async (): Promise<void> => {
    try {
      await createBackup.mutateAsync();
      toast.success(t('settings.backupCreated'));
    } catch {}
  };

  const handleRestore = async (entry: BackupEntry): Promise<void> => {
    const confirmed = await confirm({
      title: t('settings.backupRestore'),
      message: t('settings.backupRestoreConfirm', { time: formatBackupTime(entry.createdAtMs) }),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await restoreBackup.mutateAsync(entry.name);
    } catch {}
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <History className="text-muted-foreground size-3.5" strokeWidth={1.5} />
        <h4 className="text-foreground text-xs font-semibold">{t('settings.backupTitle')}</h4>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={createBackup.isPending}
          onClick={() => void handleCreate()}
        >
          {t('settings.backupCreate')}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs font-sans">{t('settings.backupHint')}</p>

      {backups.length === 0 ? (
        <p className="text-muted-foreground/70 text-xs font-sans">{t('settings.backupEmpty')}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {backups.map((entry) => (
            <li
              key={entry.name}
              className="border-border bg-muted/20 flex items-center gap-2 rounded-md border px-2.5 py-1.5"
            >
              <span className="text-foreground font-mono text-xs">
                {formatBackupTime(entry.createdAtMs)}
              </span>
              <span className="text-muted-foreground font-mono text-2xs">
                {formatBytes(entry.sizeBytes)}
              </span>
              <span
                className={cn(
                  'text-2xs rounded px-1.5 py-px font-mono',
                  entry.healthy
                    ? 'bg-muted text-muted-foreground'
                    : 'text-error-text bg-error-text/10',
                )}
              >
                {entry.healthy ? t('settings.backupHealthy') : t('settings.backupCorrupt')}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground ml-auto h-6 gap-1 px-2 text-xs"
                disabled={!entry.healthy || restoreBackup.isPending}
                onClick={() => void handleRestore(entry)}
              >
                <RotateCcw className="size-3" strokeWidth={1.5} />
                {t('settings.backupRestore')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
