// src/renderer/components/git/file-list.tsx
// Git 变更文件列表（变更项 + 骨架屏）
// ──────────────────────────────
// 拆分背景（2026-08 重构）：自 GitPanel 486 行按职责提取。
// 职责：渲染 status.files（图标 + 状态标签 + 路径）与加载骨架屏；
// 选中态由父级 selectedFilePath 驱动，点击只上报 onSelect（不自行取数）。
// ──────────────────────────────

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

export function FileList({ files, selectedFilePath, onSelect }: FileListProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  return (
    <ul className="flex flex-col gap-0.5 p-1">
      {files.map((file) => {
        // 状态元数据单一入口；文案键 = 协议值（git.<status>）
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
              <span className={cn('text-[9px] shrink-0', meta.labelClassName)}>{label}</span>
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
