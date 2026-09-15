// file-list.tsx（自 GitPanel 拆分）
// Git 文件列表（变更文件 + 骨架屏）
// ──────────────────────────────
// 拆分背景：GitPanel 486 行，按职责提取
// ──────────────────────────────

// src/renderer/components/git/GitPanel.tsx
// Git 状态展示面板 · 极简文学风
// ──────────────────────────────────────────────────────────────
// 职责：
// - 调用 useGitStatusQuery 获取当前分支、ahead/behind、变更文件列表
// - 文件列表点击选中 → 调用 useGitDiffQuery 获取该文件的 unified diff
// - 用 <pre> 渲染 diff 文本（绿色 + 绿色 -，等宽字体）
// - 工作区干净时显示「无变更」提示
//
// 设计：
// - 纯只读面板（不提供 commit/push 等写操作，避免误操作主仓库）
// - 文件状态用颜色区分（modified/added/deleted/untracked/conflicted）
// - diff 渲染用 react-diff-viewer-continued（UnifiedDiffView，统一方案）
//   实现：git:diff 返回 unified diff → parseUnifiedDiff 拆 hunk → 双栏渲染
// - 路径必须为绝对路径（由调用方传入）
// ──────────────────────────────────────────────────────────────

import type { GitFileStatus } from '@code-agent/shared/renderer';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

interface FileListProps {
  readonly files: readonly GitFileStatus[];
  readonly selectedFilePath: string | null;
  readonly onSelect: (path: string) => void;
}

import { getGitStatusMeta } from './git-status-utils';

export function FileList({ files, selectedFilePath, onSelect }: FileListProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  return (
    <ul className="flex flex-col gap-0.5 p-1">
      {files.map((file) => {
        // 状态元数据单一入口（图标/颜色类）；文案键 = 协议值（git.<status>）
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
              <Icon className={cn('size-3 shrink-0', meta.className)} strokeWidth={1.5} />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-2xs font-mono',
                  isSelected ? 'text-foreground' : 'text-muted-foreground',
                )}
                title={file.path}
              >
                {file.path}
              </span>
              <span className={cn('text-[9px] shrink-0', meta.className)}>{label}</span>
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

// ── 子组件：文件 diff 视图 ─────────────────────────────────────

/** 文件 diff 视图：可折叠，展示 unified diff 文本 */

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

/** 工作区干净提示 */
