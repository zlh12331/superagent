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

import {
  AlertTriangle,
  FileDiff,
  FileEdit,
  FilePlus,
  FileX,
  Globe,
  type LucideIcon,
  Package,
  Terminal,
} from 'lucide-react';
import { type ReactElement, useMemo, useState } from 'react';

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
  }
}

/**
 * 按 ApprovalType 获取中文标签
 *
 * 用于 Dialog 标题前缀，让用户一眼看出审批类型。
 * 使用 switch-case 避免对象字面量的 snake_case key 命名冲突。
 */
function getLabelForType(type: ApprovalType): string {
  switch (type) {
    case 'run_command':
      return '执行命令';
    case 'write_file':
      return '写入文件';
    case 'edit_file':
      return '编辑文件';
    case 'delete_file':
      return '删除文件';
    case 'apply_patch':
      return '应用补丁';
    case 'install_package':
      return '安装依赖';
    case 'external_call':
      return '外部调用';
  }
}

/**
 * 判断是否为危险审批类型
 *
 * 涉及不可逆操作（删除文件、执行命令、安装依赖）返回 true，
 * 拒绝按钮使用 destructive variant 以提示风险。
 */
function isDangerousType(type: ApprovalType): boolean {
  return type === 'delete_file' || type === 'run_command' || type === 'install_package';
}

/**
 * 判断是否支持"记住决策"
 *
 * 仅对有副作用的工具类型支持记住决策（run_command / write_file / edit_file）。
 * 危险操作（delete_file / install_package）不提供记住决策，强制每次询问。
 * apply_patch / external_call 因入参差异大，也不提供记住决策。
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
 * - 其他类型: 仅显示 description（已在 DialogDescription 渲染）
 */
function renderStructuredPreview(type: ApprovalType, input: unknown): ReactElement | null {
  if (type === 'run_command') {
    const cmd = getField(input, 'command') ?? '';
    const cwd = getField(input, 'cwd');
    return (
      <div className="mt-3 rounded-md border border-amber-200/60 bg-stone-50 p-3 font-mono text-sm">
        {cwd !== undefined && (
          <div className="mb-2 text-xs text-stone-500">
            <span className="font-sans">工作目录：</span>
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
    const preview =
      content.length > 500
        ? `${content.slice(0, 500)}\n…（已截断，共 ${content.length} 字符）`
        : content;
    return (
      <div className="mt-3 space-y-2">
        <div className="text-xs text-stone-500">
          <span className="font-sans">文件路径：</span>
          <span className="break-all font-mono">{path}</span>
        </div>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-amber-200/60 bg-stone-50 p-3 font-mono text-xs text-stone-800">
          {preview}
        </pre>
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
          <span className="font-sans">文件路径：</span>
          <span className="break-all font-mono">{path}</span>
          {replaceAll && (
            <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">
              替换全部
            </span>
          )}
        </div>
        <div className="space-y-1">
          <div className="text-xs font-sans text-red-700">− 旧内容</div>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md border border-red-200/60 bg-red-50/50 p-2 font-mono text-xs text-red-900">
            {oldStr || '（空）'}
          </pre>
          <div className="text-xs font-sans text-green-700">+ 新内容</div>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md border border-green-200/60 bg-green-50/50 p-2 font-mono text-xs text-green-900">
            {newStr || '（空，表示删除）'}
          </pre>
        </div>
      </div>
    );
  }

  // apply_patch / delete_file / install_package / external_call：不渲染额外预览
  // description 已在 DialogDescription 中展示
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
  // 订阅 pending 队列：只取队首项（一次只处理一个审批）
  const currentPending = useApprovalsStore((state) => state.pending[0]);

  // 记住决策复选框状态：每次切换审批项时重置为 false
  const [rememberDecision, setRememberDecision] = useState(false);

  // 当前审批项的图标与标签（通过 currentPending.type 查表）
  // 使用 lowercase 属性名（icon），在解构时重命名为大写 Icon 以满足 JSX 组件命名要求
  const { icon: Icon, typeLabel } = useMemo(() => {
    if (currentPending === undefined) {
      return { icon: AlertTriangle, typeLabel: '审批' };
    }
    return {
      icon: getIconForType(currentPending.type),
      typeLabel: getLabelForType(currentPending.type),
    };
  }, [currentPending]);

  // 拒绝按钮 variant：危险类型用 destructive，其他用 outline
  const rejectVariant: 'destructive' | 'outline' = useMemo(() => {
    if (currentPending === undefined) {
      return 'outline';
    }
    return isDangerousType(currentPending.type) ? 'destructive' : 'outline';
  }, [currentPending]);

  // 是否支持"记住决策"复选框
  const showRememberCheckbox = useMemo(() => {
    if (currentPending === undefined) return false;
    return canRememberDecision(currentPending.type);
  }, [currentPending]);

  // 结构化预览内容
  const structuredPreview = useMemo(() => {
    if (currentPending === undefined) return null;
    return renderStructuredPreview(currentPending.type, currentPending.input);
  }, [currentPending]);

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
                  <span>记住决策（同类操作本次会话内自动应用）</span>
                </Label>
              ) : (
                <span />
              )}

              {/* 操作按钮 */}
              <div className="flex justify-end gap-2">
                <Button variant={rejectVariant} onClick={handleReject}>
                  拒绝
                </Button>
                <Button variant="default" onClick={handleApprove}>
                  批准
                </Button>
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
