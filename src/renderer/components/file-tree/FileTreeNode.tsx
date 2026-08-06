// src/renderer/components/file-tree/FileTreeNode.tsx
// 文件树节点 · 组装层（菜单/重命名/新建输入提取至独立文件）
// ──────────────────────────────
// 拆分背景（2026-08 重构）：原文件 564 行，按职责拆分：
// - node-menu.tsx：节点右键菜单
// - inline-rename-input.tsx：行内重命名
// - inline-create-input.tsx：行内新建
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

import type { FileEntry } from '@code-agent/shared/renderer';
import { ChevronRight, File, Folder, FolderOpen } from 'lucide-react';
import type { KeyboardEvent, ReactElement } from 'react';
import { useFileTreeOps } from '@/hooks/use-file-tree-ops';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { useFileTreeStore } from '@/stores/transient/file-tree-store';
import { InlineCreateInput } from './inline-create-input';
import { InlineRenameInput } from './inline-rename-input';
import { NodeMenu } from './node-menu';

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

/** 文件类型简化为「目录」或「文件」（symlink 暂按文件渲染） */
type NodeType = 'directory' | 'file';

const EMPTY_ENTRIES: readonly FileEntry[] = [];

export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 静默失败：剪贴板权限被拒或不可用，不影响主流程
  }
}

// 空条目常量：避免每次渲染创建新数组引用导致 memo 失效

interface FileTreeNodeProps {
  /** 节点绝对路径（作为 store key + 唯一标识） */
  readonly path: string;
  /** 显示名称（basename） */
  readonly name: string;
  /** 节点类型 */
  readonly type: NodeType;
  /** 缩进深度（根节点为 0） */
  readonly depth: number;
  /** 文件点击回调（目录不触发） */
  readonly onOpenFile: (path: string) => void;
}

/**
 * 文件树节点
 *
 * 从 store 派生：展开状态、子条目、加载状态、激活状态、内联编辑状态。
 * 当父节点的 expandedPaths 变化时，对应子节点自动重新渲染（store 订阅）。
 */

export function FileTreeNode({
  path,
  name,
  type,
  depth,
  onOpenFile,
}: FileTreeNodeProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  // 订阅自身展开状态
  const expanded = useFileTreeStore((s) => s.expandedPaths.has(path));
  // 订阅自身激活状态（仅文件节点）
  const isActive = useFileTreeStore((s) => s.activeFilePath === path);
  // 订阅子条目（目录展开后才有值）
  const entries = useFileTreeStore((s) => s.entries.get(path) ?? EMPTY_ENTRIES);
  // 订阅加载状态
  const isLoading = useFileTreeStore((s) => s.loadingPaths.has(path));
  // 订阅操作中状态
  const isPending = useFileTreeStore((s) => s.pendingOps.has(path));
  // 订阅内联编辑状态
  const renamingPath = useFileTreeStore((s) => s.renamingPath);
  const creatingEntry = useFileTreeStore((s) => s.creatingEntry);

  // store actions
  const toggleExpand = useFileTreeStore((s) => s.toggleExpand);
  const setExpanded = useFileTreeStore((s) => s.setExpanded);
  const setActiveFile = useFileTreeStore((s) => s.setActiveFile);
  const startRename = useFileTreeStore((s) => s.startRename);
  const startCreate = useFileTreeStore((s) => s.startCreate);

  // IPC 操作 hook
  const ops = useFileTreeOps();

  const isRenaming = renamingPath === path;
  const isCreatingHere = creatingEntry?.parentDir === path;

  // 缩进：每层 12px（对齐 VS Code 风格）
  const indentStyle = { paddingLeft: `${depth * 12 + 8}px` };

  // 目录节点
  if (type === 'directory') {
    const handleClick = (): void => {
      toggleExpand(path);
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
      // Enter / Space 触发展开/折叠（与 button 默认键盘行为对齐）
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        e.stopPropagation();
        toggleExpand(path);
      }
    };

    /**
     * 触发新建操作
     *
     * 先展开目录（确保子条目容器可见），然后启动内联编辑流程。
     * 即使目录原本就是展开状态，重复 setExpanded(true) 也不会有副作用。
     */
    const handleStartCreate = (createType: 'file' | 'directory'): void => {
      setExpanded(path, true);
      startCreate(path, createType);
    };

    return (
      <div
        className="ft-node"
        role="treeitem"
        aria-expanded={expanded}
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        <div className="ft-row-wrap" style={indentStyle}>
          <button
            type="button"
            className={cn('ft-row', 'ft-dir', isPending && 'pending')}
            onClick={handleClick}
            // 让外层 treeitem 承担焦点，button 不参与 Tab 序列以避免双重停留
            tabIndex={-1}
            disabled={isRenaming}
          >
            <span className={cn('ft-chevron', expanded && 'expanded')}>
              <ChevronRight size={10} strokeWidth={2.5} />
            </span>
            <span className="ft-icon">
              {expanded ? (
                <FolderOpen size={13} strokeWidth={1.75} />
              ) : (
                <Folder size={13} strokeWidth={1.75} />
              )}
            </span>
            {isRenaming ? (
              <InlineRenameInput
                initialName={name}
                onConfirm={(newName) => void ops.renameEntry(path, newName)}
                onCancel={() => useFileTreeStore.getState().cancelRename()}
              />
            ) : (
              <span className="ft-name" title={name}>
                {name}
              </span>
            )}
          </button>
          {!isRenaming && (
            <NodeMenu
              type="directory"
              disabled={isPending}
              onNewFile={() => handleStartCreate('file')}
              onNewDir={() => handleStartCreate('directory')}
              onRename={() => startRename(path)}
              onDelete={() => void ops.deleteEntry(path)}
              onCopyPath={() => void copyToClipboard(path)}
            />
          )}
        </div>
        {expanded && (
          <fieldset className="ft-children">
            {/* 内联新建临时节点：渲染在子条目顶部 */}
            {isCreatingHere && creatingEntry !== null && (
              <InlineCreateInput
                type={creatingEntry.type}
                depth={depth + 1}
                onConfirm={(newName) => {
                  if (creatingEntry.type === 'file') {
                    void ops.createFile(path, newName);
                  } else {
                    void ops.createDir(path, newName);
                  }
                }}
                onCancel={() => useFileTreeStore.getState().cancelCreate()}
              />
            )}
            {isLoading && entries.length === 0 && !isCreatingHere ? (
              <div className="ft-loading" style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}>
                {t('common.loading')}
              </div>
            ) : entries.length === 0 && !isCreatingHere ? (
              <div className="ft-empty" style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}>
                {t('fileTree.emptyDir')}
              </div>
            ) : (
              entries.map((entry) => (
                <FileTreeNode
                  key={entry.path}
                  path={entry.path}
                  name={entry.name}
                  type={entry.type === 'directory' ? 'directory' : 'file'}
                  depth={depth + 1}
                  onOpenFile={onOpenFile}
                />
              ))
            )}
          </fieldset>
        )}
      </div>
    );
  }

  // 文件节点
  const handleClick = (): void => {
    setActiveFile(path);
    onOpenFile(path);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      e.stopPropagation();
      setActiveFile(path);
      onOpenFile(path);
    }
  };

  return (
    <div
      className="ft-node"
      role="treeitem"
      aria-selected={isActive}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div className="ft-row-wrap" style={indentStyle}>
        <button
          type="button"
          className={cn('ft-row', 'ft-file', isActive && 'active', isPending && 'pending')}
          onClick={handleClick}
          title={name}
          tabIndex={-1}
          disabled={isRenaming}
        >
          <span className="ft-icon ft-file-icon">
            <File size={13} strokeWidth={1.5} />
          </span>
          {isRenaming ? (
            <InlineRenameInput
              initialName={name}
              onConfirm={(newName) => void ops.renameEntry(path, newName)}
              onCancel={() => useFileTreeStore.getState().cancelRename()}
            />
          ) : (
            <span className="ft-name" title={name}>
              {name}
            </span>
          )}
        </button>
        {!isRenaming && (
          <NodeMenu
            type="file"
            disabled={isPending}
            onRename={() => startRename(path)}
            onDelete={() => void ops.deleteEntry(path)}
            onCopyPath={() => void copyToClipboard(path)}
          />
        )}
      </div>
    </div>
  );
}

// ── 子组件：节点「更多操作」菜单 ────────────────────────────

/**
 * 节点「更多操作」按钮 + 下拉菜单
 *
 * 通过 DropdownMenu 实现上下文菜单：
 * - hover 时 ft-node 显示按钮（CSS opacity 控制）
 * - 点击按钮弹出菜单
 * - 菜单项根据节点类型动态生成
 *
 * 设计要点：
 * - 按钮在 ft-node 内部（不在 row button 内），避免 button 嵌套 button（HTML 不允许）
 * - 通过 stopPropagation 避免点击按钮触发 row 的 click
 * - 使用 onSelect + setTimeout(0) 打开后续 Dialog/输入框（Radix 推荐模式）
 */
