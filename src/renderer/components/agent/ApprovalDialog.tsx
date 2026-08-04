// src/renderer/components/agent/ApprovalDialog.tsx
// 审批对话框 · 结构化展示 + 记住决策
// ──────────────────────────────────────────────────────────────
// 职责：
// - 从 useApprovalsStore 读取 pending 队列首项
// - 按 ApprovalType 结构化展示工具入参（命令预览 / 文件路径 / diff 预览）
// - 提供「批准」/「拒绝」两个操作按钮
// - 「记住决策」复选框（透传 rememberDecision 到主进程）
// - pending 为空时自动关闭
//
// 设计：
// - 文学风：衬线字体标题 + 米色背景 + 圆角
// - 不同 ApprovalType 使用不同 lucide 图标（增强视觉辨识）
// - 描述区使用 pre-wrap 保留换行（命令 / diff 内容）
// - 危险操作（delete_file / run_command / install_package）的拒绝按钮使用 destructive variant
// - 结构化展示区使用 monospace 字体 + 暗色背景，便于查看代码 / 命令
// ──────────────────────────────────────────────────────────────

import type { TFunction } from 'i18next';
import {
  AlertTriangle,
  CloudUpload,
  FileDiff,
  FileEdit,
  FilePlus,
  FileX,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  type LucideIcon,
  Package,
  Terminal,
} from 'lucide-react';
import { type ReactElement, useState } from 'react';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n/use-translation';
import { type ApprovalType, useApprovalsStore } from '@/stores/transient/approvals-store';

interface ApprovalDialogProps {
  /**
   * 审批响应回调
   *
   * @param approvalId 审批 id（回传给主进程）
   * @param approved true=批准执行，false=拒绝中止
   * @param rememberDecision 是否记住决策（用户勾选复选框时为 true）
   */
  readonly onRespond: (approvalId: string, approved: boolean, rememberDecision?: boolean) => void;
  /** 自定义容器类名（一般不用） */
  readonly className?: string;
}

/**
 * 安全读取对象字段（类型守卫）
 *
 * 工具入参类型为 unknown，渲染层需安全提取字段。
 * 此函数确保只读取已知字段，且类型缩窄为 string | undefined。
 */
function getField(obj: unknown, key: string): string | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * 安全读取对象布尔字段（类型守卫）
 *
 * 与 getField 类似，但缩窄为 boolean | undefined。
 * 用于读取工具入参中的布尔选项（如 amend / force / setUpstream）。
 */
function getBooleanField(obj: unknown, key: string): boolean | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * 安全读取对象字符串数组字段（类型守卫）
 *
 * 用于读取工具入参中的路径列表（如 git_add 的 paths）。
 * 非数组或元素非字符串时返回 undefined。
 */
function getStringArrayField(obj: unknown, key: string): string[] | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined;
  const value = (obj as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return undefined;
  return value.every((v) => typeof v === 'string') ? (value as string[]) : undefined;
}

/**
 * 按 ApprovalType 获取对应图标
 *
 * 不同审批类型使用不同图标增强视觉辨识：
 * - run_command: Terminal（终端）
 * - write_file: FilePlus（新建文件）
 * - edit_file: FileEdit（编辑文件）
 * - delete_file: FileX（删除文件）
 * - apply_patch: FileDiff（差异补丁）
 * - install_package: Package（安装包）
 * - external_call: Globe（外部调用）
 * - git_add: GitBranch（暂存改动）
 * - git_commit: GitCommitHorizontal（提交）
 * - git_push: CloudUpload（推送到远程）
 *
 * 使用 switch-case 而非对象字面量，避免 snake_case key 触发 useNamingConvention。
 */
function getIconForType(type: ApprovalType): LucideIcon {
  switch (type) {
    case 'run_command':
      return Terminal;
    case 'write_file':
      return FilePlus;
    case 'edit_file':
      return FileEdit;
    case 'delete_file':
      return FileX;
    case 'apply_patch':
      return FileDiff;
    case 'install_package':
      return Package;
    case 'external_call':
      return Globe;
    case 'git_add':
      return GitBranch;
    case 'git_commit':
      return GitCommitHorizontal;
    case 'git_push':
      return CloudUpload;
  }
}

/**
 * 从 ApprovalType 获取本地化 key（组件内 t(`approval.${key}`) 渲染）
 *
 * 用于 Dialog 标题前缀，让用户一眼看出审批类型。
 * 使用 switch-case 避免对象字面量的 snake_case key 命名冲突。
 */
function getLabelKeyForType(type: ApprovalType): string {
  switch (type) {
    case 'run_command':
      return 'runCommand';
    case 'write_file':
      return 'writeFile';
    case 'edit_file':
      return 'editFile';
    case 'delete_file':
      return 'deleteFile';
    case 'apply_patch':
      return 'applyPatch';
    case 'install_package':
      return 'installDependency';
    case 'external_call':
      return 'externalCall';
    case 'git_add':
      return 'gitStage';
    case 'git_commit':
      return 'gitCommit';
    case 'git_push':
      return 'gitPush';
  }
}

/**
 * 判断是否为危险审批类型
 *
 * 涉及不可逆操作或影响他人的工具返回 true：
 * - delete_file：删除文件不可逆
 * - run_command：执行命令可能有副作用
 * - install_package：安装依赖影响整个项目
 * - git_push：推送影响远程仓库与他人协作
 *
 * 拒绝按钮使用 destructive variant 以提示风险。
 */
function isDangerousType(type: ApprovalType): boolean {
  return (
    type === 'delete_file' ||
    type === 'run_command' ||
    type === 'install_package' ||
    type === 'git_push'
  );
}

/**
 * 判断是否支持"记住决策"
 *
 * 仅对有副作用但可重复的工具类型支持记住决策（run_command / write_file / edit_file）。
 * 危险操作（delete_file / install_package / git_push）不提供记住决策，强制每次询问。
 * apply_patch / external_call / git_add / git_commit 因入参差异大或影响仓库状态，也不提供记住决策。
 */
function canRememberDecision(type: ApprovalType): boolean {
  return type === 'run_command' || type === 'write_file' || type === 'edit_file';
}

/**
 * 渲染结构化工具入参预览
 *
 * 按 ApprovalType 渲染不同的预览卡片：
 * - run_command: 命令文本 + 工作目录 + 超时
 * - write_file: 文件路径 + 写入内容预览（前 500 字符）
 * - edit_file: 文件路径 + oldString / newString diff 预览
 * - git_add / git_commit / git_push: 委托 renderGitPreview
 * - 其他类型: 仅显示 description（已在 DialogDescription 渲染）
 */
function renderStructuredPreview(
  type: ApprovalType,
  input: unknown,
  t: TFunction,
): ReactElement | null {
  // Git 审批类型委托给专用渲染函数
  if (type === 'git_add' || type === 'git_commit' || type === 'git_push') {
    return renderGitPreview(type, input, t);
  }

  if (type === 'run_command') {
    const cmd = getField(input, 'command') ?? '';
    const cwd = getField(input, 'cwd');
    return (
      <div className="mt-3 rounded-md border border-amber-200/60 bg-stone-50 p-3 font-mono text-sm">
        {cwd !== undefined && (
          <div className="mb-2 text-xs text-stone-500">
            <span className="font-sans">{t('approval.workingDir')}</span>
            <span className="break-all">{cwd}</span>
          </div>
        )}
        <pre className="whitespace-pre-wrap break-all text-stone-800">{cmd}</pre>
      </div>
    );
  }

  if (type === 'write_file') {
    const path = getField(input, 'path') ?? '';
    const content = getField(input, 'content') ?? '';
    const append = (() => {
      if (typeof input === 'object' && input !== null) {
        const v = (input as Record<string, unknown>)['append'];
        return typeof v === 'boolean' ? v : false;
      }
      return false;
    })();
    return (
      <div className="mt-3 space-y-2">
        <div className="text-xs text-stone-500">
          <span className="font-sans">{t('approval.filePath')}</span>
          <span className="break-all font-mono">{path}</span>
          {append && (
            <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">
              {t('approval.appendMode')}
            </span>
          )}
        </div>
        <div className="approval-diff-wrapper max-h-80 overflow-auto rounded-md border border-amber-200/60">
          <ReactDiffViewer
            oldValue={append ? t('approval.appendToEnd') : t('approval.newFile')}
            newValue={content}
            splitView={true}
            compareMethod={DiffMethod.LINES}
            hideLineNumbers={false}
            showDiffOnly={false}
            leftTitle={t('approval.original')}
            rightTitle={t('approval.newContent')}
            useDarkTheme={false}
          />
        </div>
      </div>
    );
  }

  if (type === 'edit_file') {
    const path = getField(input, 'path') ?? '';
    const oldStr = getField(input, 'oldString') ?? '';
    const newStr = getField(input, 'newString') ?? '';
    const replaceAll = (() => {
      if (typeof input === 'object' && input !== null) {
        const v = (input as Record<string, unknown>)['replaceAll'];
        return typeof v === 'boolean' ? v : false;
      }
      return false;
    })();
    return (
      <div className="mt-3 space-y-2">
        <div className="text-xs text-stone-500">
          <span className="font-sans">{t('approval.filePath')}</span>
          <span className="break-all font-mono">{path}</span>
          {replaceAll && (
            <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">
              {t('approval.replaceAll')}
            </span>
          )}
        </div>
        <div className="approval-diff-wrapper max-h-96 overflow-auto rounded-md border border-amber-200/60">
          <ReactDiffViewer
            oldValue={oldStr || t('approval.empty')}
            newValue={newStr || t('approval.emptyMeansDelete')}
            splitView={true}
            compareMethod={DiffMethod.WORDS}
            hideLineNumbers={false}
            showDiffOnly={false}
            leftTitle={t('approval.oldContent')}
            rightTitle={t('approval.newContent')}
            useDarkTheme={false}
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
function renderGitPreview(type: ApprovalType, input: unknown, t: TFunction): ReactElement | null {
  if (type === 'git_add') {
    const paths = getStringArrayField(input, 'paths') ?? [];
    const isAddAll = paths.length === 0;
    return (
      <div className="mt-3 space-y-2 rounded-md border border-amber-200/60 bg-stone-50 p-3 font-mono text-sm">
        <div className="text-xs text-stone-500">
          <span className="font-sans">{t('approval.operation')}</span>
          <span>
            {isAddAll ? t('approval.stageAll') : t('approval.stagePaths', { count: paths.length })}
          </span>
        </div>
        {!isAddAll && (
          <ul className="space-y-0.5 text-stone-800">
            {paths.map((p) => (
              <li key={p} className="break-all">
                <span className="text-stone-400">+</span> {p}
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
      <div className="mt-3 space-y-2 rounded-md border border-amber-200/60 bg-stone-50 p-3 font-mono text-sm">
        <div className="flex items-center gap-2 text-xs text-stone-500">
          <span className="font-sans">{t('approval.operation')}</span>
          <span>{amend ? t('approval.commitAmend') : t('approval.commitNew')}</span>
          {amend && (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">
              {t('approval.unavailable')}
            </span>
          )}
        </div>
        <div className="text-xs text-stone-500">
          <span className="font-sans">{t('approval.commitMessage')}</span>
        </div>
        <pre className="whitespace-pre-wrap break-all rounded bg-white/60 p-2 text-stone-800">
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
      <div className="mt-3 space-y-2 rounded-md border border-amber-200/60 bg-stone-50 p-3 font-mono text-sm">
        <div className="text-xs text-stone-500">
          <span className="font-sans">{t('approval.operation')}</span>
          <span>{`git push${setUpstream ? ' -u' : ''}${force ? ' --force-with-lease' : ''} ${target}`}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {setUpstream && (
            <span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-700">
              {t('approval.setUpstream')}
            </span>
          )}
          {force && (
            <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700">
              {t('approval.forcePush')}
            </span>
          )}
          {!force && !setUpstream && (
            <span className="rounded bg-stone-200 px-1.5 py-0.5 text-stone-600">
              {t('approval.normalPush')}
            </span>
          )}
        </div>
        <div className="text-xs text-amber-700">{t('approval.pushWarning')}</div>
      </div>
    );
  }

  return null;
}

/**
 * 审批对话框
 *
 * 受理 useApprovalsStore.pending 队首项，展示给用户决策。
 * 自动开关：pending 非空时打开，空时关闭。
 *
 * @example
 * ```tsx
 * function AppRoot() {
 *   const { respondApproval } = useApprovalBridge();
 *   return <ApprovalDialog onRespond={respondApproval} />;
 * }
 * ```
 */
export function ApprovalDialog({ onRespond, className }: ApprovalDialogProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  // 订阅 pending 队列：只取队首项（一次只处理一个审批）
  const currentPending = useApprovalsStore((state) => state.pending[0]);

  // 记住决策复选框状态：每次切换审批项时重置为 false
  const [rememberDecision, setRememberDecision] = useState(false);

  // 当前审批项的图标与标签（通过 currentPending.type 查表；React Compiler 自动缓存）
  // 使用 lowercase 属性名（icon），在解构时重命名为大写 Icon 以满足 JSX 组件命名要求
  const { icon: Icon, typeLabel } = (() => {
    if (currentPending === undefined) {
      return { icon: AlertTriangle, typeLabel: t('approval.approval') };
    }
    return {
      icon: getIconForType(currentPending.type),
      typeLabel: t(`approval.${getLabelKeyForType(currentPending.type)}`),
    };
  })();

  // 拒绝按钮 variant：危险类型用 destructive，其他用 outline
  const rejectVariant: 'destructive' | 'outline' =
    currentPending !== undefined && isDangerousType(currentPending.type)
      ? 'destructive'
      : 'outline';

  // 是否支持"记住决策"复选框
  const showRememberCheckbox =
    currentPending !== undefined && canRememberDecision(currentPending.type);

  // 结构化预览内容
  const structuredPreview =
    currentPending === undefined
      ? null
      : renderStructuredPreview(currentPending.type, currentPending.input, t);

  // 处理用户点击批准/拒绝
  // 点击后 store 会自动从 pending 移除该项（由 useApprovalBridge.respondApproval 触发）
  // 同时重置 rememberDecision 为 false（为下一个审批项准备）
  const handleApprove = (): void => {
    if (currentPending === undefined) return;
    onRespond(currentPending.id, true, rememberDecision);
    setRememberDecision(false);
  };
  const handleReject = (): void => {
    if (currentPending === undefined) return;
    onRespond(currentPending.id, false, rememberDecision);
    setRememberDecision(false);
  };

  return (
    <Dialog open={currentPending !== undefined} onOpenChange={() => {}}>
      {/* onOpenChange 空实现：禁止点击遮罩/Esc 关闭，强制用户做出选择 */}
      <DialogContent
        className={className}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        {currentPending !== undefined && (
          <>
            <DialogHeader>
              {/* 标题：图标 + 类型标签 + 工具名 */}
              <DialogTitle className="flex items-center gap-2 font-serif tracking-wide">
                <Icon className="size-5" strokeWidth={1.5} />
                <span>{`${typeLabel} · ${currentPending.title}`}</span>
              </DialogTitle>
              {/* 描述：人类可读的操作摘要（pre-wrap 保留换行） */}
              <DialogDescription className="font-serif leading-relaxed whitespace-pre-wrap">
                {currentPending.description}
              </DialogDescription>
            </DialogHeader>

            {/* 结构化工具入参预览（按 ApprovalType 渲染） */}
            {structuredPreview}

            <DialogFooter className="flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
              {/* 记住决策复选框：仅对支持的工具类型显示 */}
              {showRememberCheckbox ? (
                <Label className="flex cursor-pointer items-center gap-2 text-xs font-sans text-stone-600">
                  <input
                    type="checkbox"
                    checked={rememberDecision}
                    onChange={(e) => setRememberDecision(e.target.checked)}
                    className="size-3.5 cursor-pointer accent-stone-700"
                  />
                  <span>{t('approval.rememberDecision')}</span>
                </Label>
              ) : (
                <span />
              )}

              {/* 操作按钮 */}
              <div className="flex justify-end gap-2">
                <Button variant={rejectVariant} onClick={handleReject}>
                  {t('approval.reject')}
                </Button>
                <Button variant="default" onClick={handleApprove}>
                  {t('approval.approve')}
                </Button>
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
