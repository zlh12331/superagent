// src/renderer/components/agent/ApprovalDialog.tsx
// 审批对话框 · 占位实现（P8.5）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 从 useApprovalsStore 读取 pending 队列首项
// - 弹出 Dialog 展示审批项（类型图标 + 标题 + 描述）
// - 提供「批准」/「拒绝」两个操作按钮，调用 onRespond 回传结果
// - pending 为空时自动关闭
//
// 设计：
// - 文学风：衬线字体标题 + 米色背景 + 圆角
// - 不同 ApprovalType 使用不同 lucide 图标（增强视觉辨识）
// - 描述区使用 pre-wrap 保留换行（命令 / diff 内容）
// - 危险操作（delete_file / run_command）的拒绝按钮使用 destructive variant
//
// 占位说明：
// - 当前为最小可用版本，仅展示 title + description
// - P9 阶段将扩展：
//   1. 按 type 渲染结构化展示（如 run_command 显示终端预览，edit_file 显示 diff）
//   2. 「记住决策」复选框（rememberDecision 透传到主进程）
//   3. 多审批项队列视图（当前仅处理首项）
//   4. 键盘快捷键（Enter=批准，Esc=拒绝）
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
import { type ReactElement, useMemo } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { type ApprovalType, useApprovalsStore } from '@/stores/transient/approvals-store';

interface ApprovalDialogProps {
  /**
   * 审批响应回调
   *
   * @param approvalId 审批 id（回传给主进程）
   * @param approved true=批准执行，false=拒绝中止
   */
  readonly onRespond: (approvalId: string, approved: boolean) => void;
  /** 自定义容器类名（一般不用） */
  readonly className?: string;
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

  // 处理用户点击批准/拒绝
  // 点击后 store 会自动从 pending 移除该项（由 useApprovalBridge.respondApproval 触发）
  const handleApprove = (): void => {
    if (currentPending === undefined) return;
    onRespond(currentPending.id, true);
  };
  const handleReject = (): void => {
    if (currentPending === undefined) return;
    onRespond(currentPending.id, false);
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
            <DialogFooter>
              <Button variant={rejectVariant} onClick={handleReject}>
                拒绝
              </Button>
              <Button variant="default" onClick={handleApprove}>
                批准
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
