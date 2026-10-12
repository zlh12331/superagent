import type { GitFileStatus } from '@code-agent/shared/renderer';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

import { getGitStatusMeta } from './git-status-utils';

interface FileListProps {
  readonly files: readonly GitFileStatus[];
  readonly selectedFilePath: string | null;
  readonly onSelect: (path: string) => void;
}

/** Git 变更文件列表：状态图标 + 文件名，选中高亮（点击回调给父级拉 diff） */
export function FileList({ files, selectedFilePath, onSelect }: FileListProps): ReactElement {
  const { t } = useTranslation();
  return (
    <ul className="flex flex-col gap-0.5 p-1">
      {files.map((file) => {
        const meta = getGitStatusMeta(file.status);
        const Icon = meta.icon;
        const label = t(`git.${file.status}`);
        const isSelected = file.path === selectedFilePath;

        return (
          <li key={file.path}>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                'hover:bg-accent/50 w-full justify-start gap-1.5 rounded px-1.5 py-1 text-left font-normal',
                isSelected && 'bg-accent/70',
              )}
              onClick={() => {
                onSelect(file.path);
              }}
            >
              <Icon className={cn('size-3 shrink-0', meta.iconClassName)} strokeWidth={1.5} />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-2xs font-mono',
                  isSelected ? 'text-foreground' : 'text-muted-foreground',
                )}
                title={file.path}
              >
                {file.path}
              </span>
              <span className={cn('text-2xs shrink-0', meta.labelClassName)}>{label}</span>
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

/** 加载中骨架屏（固定 4 行占位，高度与真实行对齐） */
export function FileListSkeleton(): ReactElement {
  return (
    <ul className="flex flex-col gap-0.5 p-1">
      {Array.from({ length: 4 }).map((_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 静态骨架屏占位，index 稳定且无重排
        <li key={index} className="px-1.5 py-1">
          <Skeleton className="h-3 w-full" />
        </li>
      ))}
    </ul>
  );
}
