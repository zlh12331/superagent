// src/renderer/components/file-tree/node-menu.tsx
// 文件树节点「更多操作」菜单（hover 显示 … 按钮 + DropdownMenu）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 文件/目录节点通用操作入口：复制路径 / 重命名 / 删除
// - 目录节点额外提供：在目录内新建文件 / 新建目录
// - 重命名/新建走 file-tree-store 内联编辑态（startRename / startCreate）
// - 删除调用 file:delete IPC（useFileTreeOps.deleteEntry：含 pendingOps 与错误 toast）
//
// 设计：
// - 触发器渲染在 .ft-row-wrap 内、行按钮之后（CSS .ft-more-btn：hover 节点才显示）
// - 触发器在行按钮外，避免 button 嵌套 button（HTML 非法）
// - 复制失败 toast 提示（剪贴板权限被拒时用户可知）
// ──────────────────────────────────────────────────────────────

import { Copy, Ellipsis, FilePlus, FolderPlus, Pencil, Trash2 } from 'lucide-react';
import type { ReactElement } from 'react';
import { toast } from 'sonner';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useFileTreeOps } from '@/hooks/use-file-tree-ops';
import { useTranslation } from '@/i18n/use-translation';
import { useFileTreeStore } from '@/stores/transient/file-tree-store';

interface NodeMenuProps {
  /** 节点绝对路径 */
  readonly path: string;
  /** 节点类型（决定菜单项集合） */
  readonly type: 'file' | 'directory';
  /** 禁用触发器（本节点重命名/删除进行中） */
  readonly disabled?: boolean;
}

/**
 * 节点「更多操作」菜单
 *
 * 唯一交互入口补齐（A2 修复）：此前重命名/删除/复制路径虽已实现
 * （store + IPC + hook），但没有任何 UI 触发点，属不可达死代码。
 */
export function NodeMenu({ path, type, disabled = false }: NodeMenuProps): ReactElement {
  const { t } = useTranslation();
  const ops = useFileTreeOps();
  const startRename = useFileTreeStore((s) => s.startRename);
  const startCreate = useFileTreeStore((s) => s.startCreate);
  const setExpanded = useFileTreeStore((s) => s.setExpanded);

  const handleCopyPath = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(path);
      toast.success(t('common.copied'));
    } catch {
      toast.error(t('common.copyFailed'));
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="ft-more-btn"
          aria-label={t('fileTree.moreActions')}
          title={t('fileTree.moreActions')}
          disabled={disabled}
          onClick={(event) => event.stopPropagation()}
        >
          <Ellipsis size={14} strokeWidth={1.5} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {type === 'directory' && (
          <>
            <DropdownMenuItem
              onSelect={() => {
                setExpanded(path, true);
                startCreate(path, 'file');
              }}
            >
              <FilePlus className="size-3.5" strokeWidth={1.5} />
              {t('fileTree.newFile')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                setExpanded(path, true);
                startCreate(path, 'directory');
              }}
            >
              <FolderPlus className="size-3.5" strokeWidth={1.5} />
              {t('fileTree.newDir')}
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuItem onSelect={() => void handleCopyPath()}>
          <Copy className="size-3.5" strokeWidth={1.5} />
          {t('fileTree.copyPath')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => startRename(path)}>
          <Pencil className="size-3.5" strokeWidth={1.5} />
          {t('fileTree.rename')}
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={() => void ops.deleteEntry(path)}>
          <Trash2 className="size-3.5" strokeWidth={1.5} />
          {t('common.delete')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
