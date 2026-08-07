// git-panel-parts.tsx（自 GitPanel 拆分）
// Git 面板辅助组件（分支信息 / 空态 / 错误）
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
// - diff 渲染用 <pre> 而非 react-diff-viewer-continued
//   原因：git:diff 返回 unified diff 原始文本，解析为 oldValue/newValue 较复杂
//   <pre> 渲染已足够展示，且性能更好（避免解析开销）
// - 路径必须为绝对路径（由调用方传入）
// ──────────────────────────────────────────────────────────────

import type { GitStatusRes } from '@code-agent/shared/renderer';
import { AlertCircle, CheckCircle2, GitBranch } from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from '@/i18n/use-translation';

interface BranchInfoProps {
  readonly status: GitStatusRes | undefined;
  readonly isLoading: boolean;
  readonly error: Error | null;
}
export function BranchInfo({ status, isLoading, error }: BranchInfoProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  if (isLoading) {
    return (
      <div className="text-muted-foreground flex items-center gap-1.5 text-2xs">
        <GitBranch className="size-3 animate-pulse" strokeWidth={1.5} />
        <span className="font-serif tracking-wide">{t('common.loading')}</span>
      </div>
    );
  }

  if (error !== null || status === undefined) {
    return (
      <div className="text-muted-foreground flex items-center gap-1.5 text-2xs">
        <AlertCircle className="size-3" strokeWidth={1.5} />
        <span className="font-serif tracking-wide">{t('git.loadFailed')}</span>
      </div>
    );
  }

  return (
    <div className="text-muted-foreground flex items-center gap-1.5 text-2xs">
      <GitBranch className="size-3" strokeWidth={1.5} />
      <span className="text-foreground font-serif tracking-wide">{status.branch}</span>
      {status.ahead > 0 && (
        <span className="text-emerald-600 dark:text-emerald-400">↑{status.ahead}</span>
      )}
      {status.behind > 0 && (
        <span className="text-amber-600 dark:text-amber-400">↓{status.behind}</span>
      )}
    </div>
  );
}

// ── 子组件：变更文件列表 ──────────────────────────────────────

/** 变更文件列表：每项展示图标 + 路径 + 状态标签 */

export function CleanHint(): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  return (
    <div className="text-muted-foreground flex flex-col items-center gap-1 p-4 text-center">
      <CheckCircle2 className="size-5 text-emerald-600 dark:text-emerald-400" strokeWidth={1.5} />
      <p className="font-serif text-xs tracking-wide">{t('common.cleanWorkingTree')}</p>
      <p className="text-2xs">{t('common.noChanges')}</p>
    </div>
  );
}

/** 错误状态提示 */

export function ErrorHint({ message }: { readonly message: string }): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  return (
    <div className="text-destructive flex flex-col items-center gap-1 p-3 text-center">
      <AlertCircle className="size-4" strokeWidth={1.5} />
      <p className="font-serif text-xs">{t('common.gitStatusFailed')}</p>
      <p className="text-muted-foreground truncate text-2xs" title={message}>
        {message}
      </p>
    </div>
  );
}

// ── 兼容导出 ────────────────────────────────────────────────

/** Git 面板默认导出（便于 lazy 加载） */
