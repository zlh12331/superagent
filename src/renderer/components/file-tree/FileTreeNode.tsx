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
import { ChevronRight, File, Folder, FolderOpen, MoreHorizontal } from 'lucide-react';
import { type KeyboardEvent, memo, type ReactElement, useRef } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useFileTreeOps } from '@/hooks/use-file-tree-ops';
import { cn } from '@/lib/utils';
import { useFileTreeStore } from '@/stores/transient/file-tree-store';

/** 文件类型简化为「目录」或「文件」（symlink 暂按文件渲染） */
type NodeType = 'directory' | 'file';

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
export const FileTreeNode = memo(function FileTreeNode({
  path,
  name,
  type,
  depth,
  onOpenFile,
}: FileTreeNodeProps): ReactElement {
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
                加载中…
              </div>
            ) : entries.length === 0 && !isCreatingHere ? (
              <div className="ft-empty" style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}>
                空目录
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
});

// ── 子组件：节点「更多操作」菜单 ────────────────────────────

interface NodeMenuProps {
  readonly type: 'directory' | 'file';
  readonly disabled: boolean;
  readonly onNewFile?: () => void;
  readonly onNewDir?: () => void;
  readonly onRename: () => void;
  readonly onDelete: () => void;
  readonly onCopyPath: () => void;
}

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
function NodeMenu({
  type,
  disabled,
  onNewFile,
  onNewDir,
  onRename,
  onDelete,
  onCopyPath,
}: NodeMenuProps): ReactElement {
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
          aria-label="更多操作"
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
              新建文件
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={handleItemClick(safeCall(onNewDir))}>
              新建目录
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onSelect={handleItemClick(onRename)}>重命名</DropdownMenuItem>
        <DropdownMenuItem onSelect={handleItemClick(onDelete)} className="ft-menu-danger">
          删除
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={handleItemClick(onCopyPath)}>复制路径</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── 子组件：内联重命名输入框 ────────────────────────────────

interface InlineRenameInputProps {
  readonly initialName: string;
  readonly onConfirm: (newName: string) => void;
  readonly onCancel: () => void;
}

/**
 * 内联重命名输入框
 *
 * 替换节点名称渲染为 input：
 * - 自动聚焦并选中文件名（不含扩展名，对齐 VSCode 行为）
 * - Enter 确认 / Esc 取消 / 失焦确认
 * - 空名称视为取消
 */
function InlineRenameInput({
  initialName,
  onConfirm,
  onCancel,
}: InlineRenameInputProps): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  // 防止 Enter/Esc 触发后 onBlur 重复调用：keydown 先标记，blur 检查后重置
  const handledRef = useRef(false);

  // 选中文件名（不含扩展名）：'foo.ts' → 选中 'foo'，'README' → 全选
  const selectName = (): void => {
    const input = inputRef.current;
    if (input === null) return;
    const dotIdx = initialName.lastIndexOf('.');
    // 仅当 dot 在第 1 个字符之后（避免选中 '.gitignore' 的隐藏文件名）
    if (dotIdx > 0) {
      input.setSelectionRange(0, dotIdx);
    } else {
      input.select();
    }
  };

  const commit = (): void => {
    const input = inputRef.current;
    if (input === null) return;
    const value = input.value.trim();
    if (value === '' || value === initialName) {
      onCancel();
    } else {
      onConfirm(value);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handledRef.current = true;
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handledRef.current = true;
      onCancel();
    }
  };

  const handleBlur = (): void => {
    // keydown 已处理过则跳过，避免双触发
    if (handledRef.current) {
      handledRef.current = false;
      return;
    }
    commit();
  };

  return (
    <input
      ref={inputRef}
      type="text"
      className="ft-rename-input"
      defaultValue={initialName}
      // biome-ignore lint/a11y/noAutofocus: 内联重命名必须立即聚焦以提供 VSCode 风格体验
      autoFocus
      // onFocus 在 autoFocus 后触发，确保选中文件名
      onFocus={selectName}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      // 阻止 click 冒泡到 row button，避免触发展开/打开文件
      onClick={(e) => e.stopPropagation()}
    />
  );
}

// ── 子组件：内联新建输入框 ──────────────────────────────────

interface InlineCreateInputProps {
  readonly type: 'file' | 'directory';
  readonly depth: number;
  readonly onConfirm: (name: string) => void;
  readonly onCancel: () => void;
}

/**
 * 内联新建临时节点
 *
 * 在目录子条目列表顶部渲染一个可编辑节点：
 * - 显示与 type 对应的图标 + input
 * - Enter 确认 / Esc 取消 / 失焦取消
 * - 空名称视为取消
 */
function InlineCreateInput({
  type,
  depth,
  onConfirm,
  onCancel,
}: InlineCreateInputProps): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  // 防止 Enter/Esc 触发后 onBlur 重复调用：keydown 先标记，blur 检查后重置
  const handledRef = useRef(false);
  const indentStyle = { paddingLeft: `${depth * 12 + 8}px` };

  const commit = (): void => {
    const input = inputRef.current;
    if (input === null) return;
    const value = input.value.trim();
    if (value === '') {
      onCancel();
    } else {
      onConfirm(value);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handledRef.current = true;
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handledRef.current = true;
      onCancel();
    }
  };

  const handleBlur = (): void => {
    if (handledRef.current) {
      handledRef.current = false;
      return;
    }
    commit();
  };

  return (
    <div className="ft-row-wrap" style={indentStyle}>
      <button type="button" className="ft-row ft-creating" tabIndex={-1} disabled>
        <span className="ft-chevron" aria-hidden>
          {/* 无展开箭头，对齐文件节点缩进 */}
        </span>
        <span className="ft-icon">
          {type === 'directory' ? (
            <Folder size={13} strokeWidth={1.75} />
          ) : (
            <File size={13} strokeWidth={1.5} />
          )}
        </span>
        <input
          ref={inputRef}
          type="text"
          className="ft-rename-input"
          placeholder={type === 'directory' ? '目录名' : '文件名'}
          // biome-ignore lint/a11y/noAutofocus: 内联新建必须立即聚焦以提供 VSCode 风格体验
          autoFocus
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          onClick={(e) => e.stopPropagation()}
        />
      </button>
    </div>
  );
}

// ── 辅助函数 ──────────────────────────────────────────────

/**
 * 复制文本到剪贴板
 *
 * 使用 navigator.clipboard API，失败时 toast 提示。
 */
async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 静默失败：剪贴板权限被拒或不可用，不影响主流程
  }
}

// 空条目常量：避免每次渲染创建新数组引用导致 memo 失效
const EMPTY_ENTRIES: readonly FileEntry[] = [];
