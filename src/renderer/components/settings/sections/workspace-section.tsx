// src/renderer/components/settings/sections/workspace-section.tsx
// 工作树 pane（对齐 Trae Work：文件树/工作区相关设置）
// ──────────────────────────────────────────────────────────────
// 展示当前工作目录与文件树状态（file-tree-store 真实数据）；
// 文件树配置项（忽略列表/展开层级）规划中，诚实标注。
// ──────────────────────────────────────────────────────────────

import { FolderTree } from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from '@/i18n/use-translation';
import { useFileTreeStore } from '@/stores/transient/file-tree-store';

/** 工作树 pane */
export function WorkspaceSection(): ReactElement {
  const { t } = useTranslation();
  const rootPath = useFileTreeStore((state) => state.rootPath);
  const expandedCount = useFileTreeStore((state) => state.expandedPaths.size);

  return (
    <div className="space-y-3 pt-2">
      <div className="flex items-center gap-2">
        <FolderTree className="text-muted-foreground size-3.5" strokeWidth={1.5} />
        <h3 className="text-foreground text-sm font-semibold">{t('settings.nav.workspace')}</h3>
      </div>

      <div className="border-border bg-muted/20 rounded-md border p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs">{t('settings.workspaceRoot')}</span>
          <span
            className="text-foreground min-w-0 truncate font-mono text-xs"
            title={rootPath ?? undefined}
          >
            {rootPath ?? t('settings.workspaceEmpty')}
          </span>
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs">{t('settings.workspaceExpanded')}</span>
          <span className="text-foreground font-mono text-xs">{expandedCount}</span>
        </div>
      </div>

      <p className="text-muted-foreground max-w-md text-xs leading-relaxed">
        {t('settings.workspaceHint')}
      </p>
    </div>
  );
}
