// git-status-utils.ts（自 GitPanel 拆分）
// Git 文件状态 → 图标/颜色/文案（纯函数）
// ──────────────────────────────
// 拆分背景：GitPanel 486 行，纯函数与组件混合，按职责提取
// ──────────────────────────────

import type { GitFileStatus } from '@code-agent/shared/main';
import { AlertCircle, FileEdit, FilePlus, FileQuestion, FileX } from 'lucide-react';

export function getIconForFileStatus(status: GitFileStatus['status']): typeof FileEdit {
  switch (status) {
    case 'modified':
      return FileEdit;
    case 'added':
      return FilePlus;
    case 'deleted':
      return FileX;
    case 'renamed':
      return FileEdit;
    case 'untracked':
      return FileQuestion;
    case 'conflicted':
      return AlertCircle;
  }
}

/**
 * 按文件状态获取颜色 class
 */
export function getColorForFileStatus(status: GitFileStatus['status']): string {
  switch (status) {
    case 'modified':
      return 'text-warn';
    case 'added':
      return 'text-success';
    case 'deleted':
      return 'text-error';
    case 'renamed':
      return 'text-accent-2';
    case 'untracked':
      return 'text-muted-foreground';
    case 'conflicted':
      return 'text-error font-semibold';
  }
}

/**
 * 按文件状态获取本地化 key（组件内 t(`git.${key}`) 渲染）
 */
export function getLabelKeyForFileStatus(status: GitFileStatus['status']): string {
  switch (status) {
    case 'modified':
      return 'statusModified';
    case 'added':
      return 'statusAdded';
    case 'deleted':
      return 'statusDeleted';
    case 'renamed':
      return 'statusRenamed';
    case 'untracked':
      return 'statusUntracked';
    case 'conflicted':
      return 'statusConflict';
  }
}

/**
 * Git 状态展示面板
 *
 * 三段式布局：分支信息 / 变更文件列表 / 选中文件 diff。
 *
 * @example
 * ```tsx
 * <GitPanel path={repoPath} />
 * ```
 */
