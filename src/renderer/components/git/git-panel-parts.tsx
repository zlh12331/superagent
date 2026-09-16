// src/renderer/components/git/git-panel-parts.tsx
// Git 面板的小型展示组件（分支信息 / 工作区干净 / 错误提示）
// ──────────────────────────────
// 拆分背景（2026-08 重构）：自 GitPanel 486 行按职责提取。
// 三者都是无状态纯展示（仅消费 props），故同居一文件而非各占一个——
// 体量小、无独立演化需求，拆散只会增加跳转成本。
// ──────────────────────────────

import type { GitStatusRes } from '@code-agent/shared/renderer';
import { AlertCircle, CheckCircle2, GitBranch } from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from '@/i18n/use-translation';

interface BranchInfoProps {
  readonly status: GitStatusRes | undefined;
  readonly isLoading: boolean;
  readonly error: Error | null;
}
/** 分支信息：加载中 / 失败 / 分支名 + ahead(↑)·behind(↓) 标记 */
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
      {status.ahead > 0 && <span className="text-success-text">↑{status.ahead}</span>}
      {status.behind > 0 && <span className="text-warn-text">↓{status.behind}</span>}
    </div>
  );
}

/** 工作区干净提示（无变更时的空态） */
export function CleanHint(): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  return (
    <div className="text-muted-foreground flex flex-col items-center gap-1 p-4 text-center">
      <CheckCircle2 className="size-5 text-success-text" strokeWidth={1.5} />
      <p className="font-serif text-xs tracking-wide">{t('common.cleanWorkingTree')}</p>
      <p className="text-2xs">{t('common.noChanges')}</p>
    </div>
  );
}

/** 错误状态提示（错误消息单行截断，完整内容见 title） */
export function ErrorHint({ message }: { readonly message: string }): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  return (
    <div className="text-error-text flex flex-col items-center gap-1 p-3 text-center">
      <AlertCircle className="size-4" strokeWidth={1.5} />
      <p className="font-serif text-xs">{t('common.gitStatusFailed')}</p>
      <p className="text-muted-foreground truncate text-2xs" title={message}>
        {message}
      </p>
    </div>
  );
}
