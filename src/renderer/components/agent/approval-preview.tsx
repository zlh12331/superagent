// approval-preview.tsx（自原 ApprovalDialog 拆分，弹窗已删除）
// 审批载荷结构化预览（命令 / 文件 diff / Git 变更），由 InlineApprovalCard 消费
// ──────────────────────────────────────────────────────────────
// 职责：
// - StructuredPreview：按 ApprovalType 分发的入口组件
//   （run_command 命令预览 / write_file、edit_file diff 预览 / git_* 变更摘要）
// - 结构化展示区使用 monospace 字体 + 边框容器，便于查看代码 / 命令
// 组件化背景（2026-09-15）：原 renderXxx 纯函数形态需调用方穿透 t/useDarkTheme，
// 且在 DevTools 中无组件边界；组件化后依赖自取（useTranslation/useTheme）
// ──────────────────────────────────────────────────────────────

import type { ReactElement, ReactNode } from 'react';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';
import { useTranslation } from '@/i18n/use-translation';
import { useTheme } from '@/providers/ThemeProvider';
import type { ApprovalType } from '@/stores/transient/approvals-store';

import { getBooleanField, getField, getStringArrayField } from './approval-utils';

/** 深色主题读取（ReactDiffViewer 双栏配色跟随全局主题） */
function useIsDarkTheme(): boolean {
  const { resolvedTheme } = useTheme();
  return resolvedTheme === 'dark';
}

/** 审批载荷结构化预览入口（按类型分发；无专属预览的类型返回 null，仅卡片 description） */
export function StructuredPreview({
  type,
  input,
}: {
  readonly type: ApprovalType;
  readonly input: unknown;
}): ReactElement | null {
  if (type === 'git_add' || type === 'git_commit' || type === 'git_push') {
    return <GitPreview type={type} input={input} />;
  }
  if (type === 'run_command') return <CommandPreview input={input} />;
  if (type === 'write_file') return <WriteFilePreview input={input} />;
  if (type === 'edit_file') return <EditFilePreview input={input} />;
  return null;
}

/** run_command：命令文本 + 工作目录 */
function CommandPreview({ input }: { readonly input: unknown }): ReactElement {
  const { t } = useTranslation();
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

/** write_file：路径 + 内容 diff（append 模式标记） */
function WriteFilePreview({ input }: { readonly input: unknown }): ReactElement {
  const { t } = useTranslation();
  const isDarkTheme = useIsDarkTheme();
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
          useDarkTheme={isDarkTheme}
        />
      </div>
    </div>
  );
}

/** edit_file：路径 + oldString/newString diff（replaceAll 标记） */
function EditFilePreview({ input }: { readonly input: unknown }): ReactElement {
  const { t } = useTranslation();
  const isDarkTheme = useIsDarkTheme();
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
          useDarkTheme={isDarkTheme}
        />
      </div>
    </div>
  );
}

/**
 * git 预览的共用外壳（琥珀色边框 + monospace 风格）
 *
 * 抽离动机（2026-09 审计）：三个 git_* 分支此前各自逐字重复这层容器与
 * 「操作」标签行，且整个 GitPreview 因 3 分支 × 多层条件嵌套使认知复杂度达 25
 * （阈值 15）。现拆为单位组件 + 共用外壳，各分支只描述自己的差异。
 */
function GitPreviewShell({ children }: { readonly children: ReactNode }): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="mt-3 flex flex-col gap-2 rounded-md border border-amber/30 bg-muted p-3 font-mono text-sm">
      <div className="text-xs text-muted-foreground">
        <span className="font-sans">{t('approval.operation')}</span>
        {children}
      </div>
    </div>
  );
}

/** git_add：暂存全部或指定路径 */
function GitAddPreview({ input }: { readonly input: unknown }): ReactElement {
  const { t } = useTranslation();
  const paths = getStringArrayField(input, 'paths') ?? [];
  const isAddAll = paths.length === 0;
  return (
    <GitPreviewShell>
      <span>
        {isAddAll ? t('approval.stageAll') : t('approval.stagePaths', { count: paths.length })}
      </span>
      {!isAddAll && (
        <ul className="mt-1.5 flex flex-col gap-0.5 text-foreground">
          {paths.map((p) => (
            <li key={p} className="break-all">
              {/* 装饰性前缀，aria-hidden 避免读屏念出「加号」（路径本身已完整可读） */}
              <span className="text-muted-foreground" aria-hidden="true">
                +
              </span>{' '}
              {p}
            </li>
          ))}
        </ul>
      )}
    </GitPreviewShell>
  );
}

/** git_commit：提交信息 + amend 标注 */
function GitCommitPreview({ input }: { readonly input: unknown }): ReactElement {
  const { t } = useTranslation();
  const message = getField(input, 'message') ?? '';
  const amend = getBooleanField(input, 'amend') ?? false;
  return (
    <GitPreviewShell>
      <span className="ml-1">{amend ? t('approval.commitAmend') : t('approval.commitNew')}</span>
      {amend && (
        // 徽标语义是「不可逆」（amend 覆盖原提交），不是「不可用」——工具本身支持
        // amend（git-commit.tool.ts 的 amend 分支），此前显示「不可用」与能力矛盾。
        // 该误标源于 i18n 收口时把原型的「不可逆」错配到 unavailable key。
        <span className="rounded bg-amber/15 px-1.5 py-0.5 text-2xs text-warn-text">
          {t('approval.irreversible')}
        </span>
      )}
      <div className="mt-1.5 text-xs text-muted-foreground">
        <span className="font-sans">{t('approval.commitMessage')}</span>
      </div>
      <pre className="bg-[var(--glass-bg)] text-foreground mt-1 whitespace-pre-wrap break-all rounded p-2">
        {message}
      </pre>
    </GitPreviewShell>
  );
}

/** git_push：目标 + 上游/强推标记 + 风险提示 */
function GitPushPreview({ input }: { readonly input: unknown }): ReactElement {
  const { t } = useTranslation();
  const remote = getField(input, 'remote') ?? 'origin';
  const refspec = getField(input, 'refspec') ?? '';
  const setUpstream = getBooleanField(input, 'setUpstream') ?? false;
  const force = getBooleanField(input, 'force') ?? false;
  // 未指定 refspec 时展示占位（人类可读，非真实命令 token）
  const target =
    refspec.length > 0 ? `${remote}/${refspec}` : `${remote}/${t('approval.currentBranch')}`;
  return (
    <GitPreviewShell>
      <span className="ml-1">{`git push${setUpstream ? ' -u' : ''}${force ? ' --force-with-lease' : ''} ${target}`}</span>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
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
      <div className="mt-1.5 text-xs text-warn-text">{t('approval.pushWarning')}</div>
    </GitPreviewShell>
  );
}

/** git_* 三命令的分派（早返回，避免长嵌套） */
function GitPreview({
  type,
  input,
}: {
  readonly type: ApprovalType;
  readonly input: unknown;
}): ReactElement | null {
  if (type === 'git_add') return <GitAddPreview input={input} />;
  if (type === 'git_commit') return <GitCommitPreview input={input} />;
  if (type === 'git_push') return <GitPushPreview input={input} />;
  return null;
}
