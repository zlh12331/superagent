// node-menu.tsx（自 FileTreeNode 拆分）
// 文件树 · 节点右键菜单
// ──────────────────────────────
// 拆分背景：FileTreeNode 564 行，按职责提取
// ──────────────────────────────

// src/renderer/components/file-tree/FileTreeNode.tsx
// 文件树节点（递归渲染）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 渲染单个目录或文件节点
// - 目录节点：展开/折叠箭头 + 文件夹图标 + 名称 + 递归渲染子节点
// - 文件节点：文件图标 + 名称（点击触发 onOpenFile 回调）
// - 通过 depth 控制缩进层级
// - hover 显示「更多操作」按钮（DropdownMenu 触发）
// - 内联重命名输入框（renamingPath === path 时替换名称为 input）
// - 内联新建临时节点（creatingEntry.parentDir === path 时在子条目顶部渲染 input）
//
// 设计：
// - 自包含：从 store 读取自身展开状态、子条目、加载状态、内联编辑状态
// - memo 优化：仅当 props（path/name/type/depth/onOpenFile）变化时重渲染
// - ft-node 作为 position: relative 承载「更多」按钮的绝对定位
// - 文学风视觉：衬线字体名称 + 等宽元信息 + 文件夹/文件图标
// ──────────────────────────────────────────────────────────────

import { MoreHorizontal } from 'lucide-react';
import type { ReactElement } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTranslation } from '@/i18n/use-translation';

export function NodeMenu({
  type,
  disabled,
  onNewFile,
  onNewDir,
  onRename,
  onDelete,
  onCopyPath,
}: NodeMenuProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  // Radix DropdownMenuItem onSelect 事件签名是 (event: Event) => void
  // 但我们需要在 select 后等待菜单关闭动画再聚焦新 input（Radix 推荐模式）
  const handleItemClick =
    (handler: () => void) =>
    (event: Event): void => {
      event.preventDefault();
      setTimeout(handler, 0);
    };

  // 安全调用包装：未传 handler 时 noop
  const safeCall = (fn?: () => void) => (): void => {
    fn?.();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="ft-more-btn"
          aria-label={t('fileTree.moreActions')}
          // 阻止 click 冒泡到 row button，避免触发展开/打开文件
          onClick={(e) => e.stopPropagation()}
          disabled={disabled}
          tabIndex={-1}
        >
          <MoreHorizontal size={12} strokeWidth={2} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4}>
        {type === 'directory' && (
          <>
            <DropdownMenuItem onSelect={handleItemClick(safeCall(onNewFile))}>
              {t('fileTree.newFile')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={handleItemClick(safeCall(onNewDir))}>
              {t('fileTree.newDir')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onSelect={handleItemClick(onRename)}>
          {t('fileTree.rename')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleItemClick(onDelete)} className="ft-menu-danger">
          {t('common.delete')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={handleItemClick(onCopyPath)}>
          {t('fileTree.copyPath')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── 子组件：内联重命名输入框 ────────────────────────────────

/**
 * 内联重命名输入框
 *
 * 替换节点名称渲染为 input：
 * - 自动聚焦并选中文件名（不含扩展名，对齐 VSCode 行为）
 * - Enter 确认 / Esc 取消 / 失焦确认
 * - 空名称视为取消
 */

interface NodeMenuProps {
  readonly type: 'directory' | 'file';
  readonly disabled: boolean;
  readonly onNewFile?: () => void;
  readonly onNewDir?: () => void;
  readonly onRename: () => void;
  readonly onDelete: () => void;
  readonly onCopyPath: () => void;
}
