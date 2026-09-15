// approval-preview.tsx（自原 ApprovalDialog 拆分，弹窗已删除仅存渲染函数）
// 审批载荷结构化预览（命令 / 文件 diff / Git 变更），由 InlineApprovalCard 消费
// ──────────────────────────────
// 职责：
// - renderStructuredPreview：按 ApprovalType 结构化展示工具入参
//   （run_command 命令预览 / write_file、edit_file diff 预览 / git_* 变更摘要）
// - 结构化展示区使用 monospace 字体 + 边框容器，便于查看代码 / 命令
// ──────────────────────────────

import type { TFunction } from 'i18next';
import type { ReactElement } from 'react';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';

import type { ApprovalType } from '@/stores/transient/approvals-store';

import { getBooleanField, getField, getStringArrayField } from './approval-utils';

export function renderStructuredPreview(
  type: ApprovalType,
  input: unknown,
  t: TFunction,
  /** 是否深色主题（ReactDiffViewer 的 useDarkTheme 跟随全局主题） */
  useDarkTheme: boolean,
): ReactElement | null {
  // Git 审批类型委托给专用渲染函数
  if (type === 'git_add' || type === 'git_commit' || type === 'git_push') {
    return renderGitPreview(type, input, t);
  }

  if (type === 'run_command') {
    const cmd = getField(input, 'command') ?? '';
    const cwd = getField(input, 'cwd');
    return (
      <div className="mt-3 rounded-md border border-amber/30 bg-muted p-3 font-mono text-sm">
        {cwd !== undefined && (
          <div className="mb-2 text-xs text-muted-foreground">
            <span className="font-sans">{t('approval.workingDir')}</span>
            <span className="break-all">{cwd}</span>
          </div>
        )}
        <pre className="whitespace-pre-wrap break-all text-foreground">{cmd}</pre>
      </div>
    );
  }

  if (type === 'write_file') {
    const path = getField(input, 'path') ?? '';
    const content = getField(input, 'content') ?? '';
    const append = getBooleanField(input, 'append') ?? false;
    return (
      <div className="mt-3 flex flex-col gap-2">
        <div className="text-xs text-muted-foreground">
          <span className="font-sans">{t('approval.filePath')}</span>
          <span className="break-all font-mono">{path}</span>
          {append && (
            <span className="ml-2 rounded bg-amber/15 px-1.5 py-0.5 text-2xs text-warn-text">
              {t('approval.appendMode')}
            </span>
          )}
        </div>
        <div className="approval-diff-wrapper max-h-80 overflow-auto rounded-md border border-amber/30">
          <ReactDiffViewer
            oldValue={append ? t('approval.appendToEnd') : t('approval.newFile')}
            newValue={content}
            splitView={true}
            compareMethod={DiffMethod.LINES}
            hideLineNumbers={false}
            showDiffOnly={false}
            leftTitle={t('approval.original')}
            rightTitle={t('approval.newContent')}
            useDarkTheme={useDarkTheme}
          />
        </div>
      </div>
    );
  }

  if (type === 'edit_file') {
    const path = getField(input, 'path') ?? '';
    const oldStr = getField(input, 'oldString') ?? '';
    const newStr = getField(input, 'newString') ?? '';
    const replaceAll = getBooleanField(input, 'replaceAll') ?? false;
    return (
      <div className="mt-3 flex flex-col gap-2">
        <div className="text-xs text-muted-foreground">
          <span className="font-sans">{t('approval.filePath')}</span>
          <span className="break-all font-mono">{path}</span>
          {replaceAll && (
            <span className="ml-2 rounded bg-amber/15 px-1.5 py-0.5 text-2xs text-warn-text">
              {t('approval.replaceAll')}
            </span>
          )}
        </div>
        <div className="approval-diff-wrapper max-h-96 overflow-auto rounded-md border border-amber/30">
          <ReactDiffViewer
            oldValue={oldStr || t('approval.empty')}
            newValue={newStr || t('approval.emptyMeansDelete')}
            splitView={true}
            compareMethod={DiffMethod.WORDS}
            hideLineNumbers={false}
            showDiffOnly={false}
            leftTitle={t('approval.oldContent')}
            rightTitle={t('approval.newContent')}
            useDarkTheme={useDarkTheme}
          />
        </div>
      </div>
    );
  }

  // apply_patch / delete_file / install_package / external_call：不渲染额外预览
  // description 已在 DialogDescription 中展示
  return null;
}

/**
 * 渲染 Git 审批类型的结构化预览
 *
 * - git_add: 显示待暂存的路径列表（paths 为空时显示「全部改动」）
 * - git_commit: 显示提交信息 + amend 标记
 * - git_push: 显示 remote + refspec + 强制推送 / 设置上游标记
 *
 * 抽离为独立函数避免 renderStructuredPreview 过长，且 Git 类型共享视觉风格（琥珀色边框）。
 */
export function renderGitPreview(
  type: ApprovalType,
  input: unknown,
  t: TFunction,
): ReactElement | null {
  if (type === 'git_add') {
    const paths = getStringArrayField(input, 'paths') ?? [];
    const isAddAll = paths.length === 0;
    return (
      <div className="mt-3 flex flex-col gap-2 rounded-md border border-amber/30 bg-muted p-3 font-mono text-sm">
        <div className="text-xs text-muted-foreground">
          <span className="font-sans">{t('approval.operation')}</span>
          <span>
            {isAddAll ? t('approval.stageAll') : t('approval.stagePaths', { count: paths.length })}
          </span>
        </div>
        {!isAddAll && (
          <ul className="flex flex-col gap-0.5 text-foreground">
            {paths.map((p) => (
              <li key={p} className="break-all">
                <span className="text-muted-foreground">+</span> {p}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  if (type === 'git_commit') {
    const message = getField(input, 'message') ?? '';
    const amend = getBooleanField(input, 'amend') ?? false;
    return (
      <div className="mt-3 flex flex-col gap-2 rounded-md border border-amber/30 bg-muted p-3 font-mono text-sm">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-sans">{t('approval.operation')}</span>
          <span>{amend ? t('approval.commitAmend') : t('approval.commitNew')}</span>
          {amend && (
            <span className="rounded bg-amber/15 px-1.5 py-0.5 text-2xs text-warn-text">
              {t('approval.unavailable')}
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          <span className="font-sans">{t('approval.commitMessage')}</span>
        </div>
        <pre className="bg-[var(--glass-bg)] text-foreground whitespace-pre-wrap break-all rounded p-2">
          {message}
        </pre>
      </div>
    );
  }

  if (type === 'git_push') {
    const remote = getField(input, 'remote') ?? 'origin';
    const refspec = getField(input, 'refspec') ?? '';
    const setUpstream = getBooleanField(input, 'setUpstream') ?? false;
    const force = getBooleanField(input, 'force') ?? false;
    const target = refspec.length > 0 ? `${remote}/${refspec}` : `${remote}/<current-branch>`;
    return (
      <div className="mt-3 flex flex-col gap-2 rounded-md border border-amber/30 bg-muted p-3 font-mono text-sm">
        <div className="text-xs text-muted-foreground">
          <span className="font-sans">{t('approval.operation')}</span>
          <span>{`git push${setUpstream ? ' -u' : ''}${force ? ' --force-with-lease' : ''} ${target}`}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {setUpstream && (
            <span className="rounded bg-info-blue px-1.5 py-0.5 text-2xs text-accent-2">
              {t('approval.setUpstream')}
            </span>
          )}
          {force && (
            <span className="rounded bg-error-bg px-1.5 py-0.5 text-2xs text-error-text">
              {t('approval.forcePush')}
            </span>
          )}
          {!force && !setUpstream && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
              {t('approval.normalPush')}
            </span>
          )}
        </div>
        <div className="text-xs text-warn-text">{t('approval.pushWarning')}</div>
      </div>
    );
  }

  return null;
}
