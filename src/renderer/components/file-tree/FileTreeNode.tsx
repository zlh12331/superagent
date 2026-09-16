// src/renderer/components/file-tree/FileTreeNode.tsx
// 文件树节点 · 分派层（目录 / 文件两形态各自独立）
// ──────────────────────────────────────────────────────────────
// 结构：
// - FileTreeNode：仅按 type 分派到 DirNode / FileNode
// - DirNode：展开/折叠 + 子区（DirChildren）
// - DirChildren：内联新建输入 + 加载中 / 空目录 / 子节点递归
// - FileNode：文件行（点击或 Enter/Space 打开）
//
// 拆分背景（2026-09 审计）：此前单个函数同时渲染两种节点，认知复杂度 16
// （门禁阈值 15）。两种形态的键盘语义、图标、子区渲染互不相同，各自需要的
// store 切片也不同（文件节点不需要 entries/loadingPaths/creatingEntry）——
// 拆开后各组件只订阅自己需要的部分，复杂度与订阅面双双收窄。
//
// 设计：
// - 缩进按 depth 计算（每层 12px，对齐 VS Code 风格）
// - 记忆化：组件为裸函数，依赖 React Compiler 自动记忆化（未手写 memo）；
//   注意 store 订阅是外部状态，JSX 缓存前提在 store 更新时仍会失效
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

/** 文件类型简化为「目录」或「文件」（symlink 暂按文件渲染） */
type NodeType = 'directory' | 'file';

/** 空条目常量：避免每次渲染创建新数组引用 */
const EMPTY_ENTRIES: readonly FileEntry[] = [];

/** 每层缩进（px） */
const INDENT_PER_DEPTH = 12;

/** 激活键（Enter / Space）：与原生 button 的键盘行为对齐 */
function isActivateKey(key: string): boolean {
  return key === 'Enter' || key === ' ' || key === 'Spacebar';
}

/** 按深度生成缩进内联样式（depth 从 0 起） */
function indentStyle(depth: number): { paddingLeft: string } {
  return { paddingLeft: `${depth * INDENT_PER_DEPTH + 8}px` };
}

interface NodeProps {
  /** 节点绝对路径（作为 store key + 唯一标识） */
  readonly path: string;
  /** 显示名称（basename） */
  readonly name: string;
  /** 缩进深度（根节点为 0） */
  readonly depth: number;
  /** 文件点击回调（目录不触发） */
  readonly onOpenFile: (path: string) => void;
}

interface FileTreeNodeProps extends NodeProps {
  /** 节点类型 */
  readonly type: NodeType;
}

/** 文件树节点（按类型分派） */
export function FileTreeNode({
  path,
  name,
  type,
  depth,
  onOpenFile,
}: FileTreeNodeProps): ReactElement {
  if (type === 'directory') {
    return <DirNode path={path} name={name} depth={depth} onOpenFile={onOpenFile} />;
  }
  return <FileNode path={path} name={name} depth={depth} onOpenFile={onOpenFile} />;
}

// ── 目录节点 ────────────────────────────────────────────────

/** 目录节点：展开/折叠 + 子区 */
function DirNode({ path, name, depth, onOpenFile }: NodeProps): ReactElement {
  const expanded = useFileTreeStore((s) => s.expandedPaths.has(path));
  const isPending = useFileTreeStore((s) => s.pendingOps.has(path));
  const toggleExpand = useFileTreeStore((s) => s.toggleExpand);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // Enter / Space 触发展开/折叠（与 button 默认键盘行为对齐）
    if (isActivateKey(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      toggleExpand(path);
    }
  };

  return (
    <div
      className="ft-node"
      role="treeitem"
      aria-expanded={expanded}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div className="ft-row-wrap" style={indentStyle(depth)}>
        <button
          type="button"
          className={cn('ft-row', 'ft-dir', isPending && 'pending')}
          onClick={() => {
            toggleExpand(path);
          }}
          // 让外层 treeitem 承担焦点，button 不参与 Tab 序列以避免双重停留
          tabIndex={-1}
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
          <span className="ft-name" title={name}>
            {name}
          </span>
        </button>
      </div>
      {expanded && <DirChildren path={path} depth={depth} onOpenFile={onOpenFile} />}
    </div>
  );
}

interface DirChildrenProps {
  readonly path: string;
  readonly depth: number;
  readonly onOpenFile: (path: string) => void;
}

/**
 * 目录子区：内联新建输入 + 加载中 / 空目录 / 子节点列表
 *
 * 优先级（与原实现一致）：新建输入始终渲染在子条目顶部；无子条目且正在新建时
 * 不显示占位（让位给输入框），否则按 isLoading 区分「加载中」与「空目录」。
 */
function DirChildren({ path, depth, onOpenFile }: DirChildrenProps): ReactElement {
  const { t } = useTranslation();
  const entries = useFileTreeStore((s) => s.entries.get(path) ?? EMPTY_ENTRIES);
  const isLoading = useFileTreeStore((s) => s.loadingPaths.has(path));
  const creatingEntry = useFileTreeStore((s) => s.creatingEntry);
  // IPC 操作 hook（新建文件 / 目录）
  const ops = useFileTreeOps();

  const isCreatingHere = creatingEntry !== null && creatingEntry.parentDir === path;
  const childIndent = indentStyle(depth + 1);

  return (
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
      {entries.length === 0 && !isCreatingHere ? (
        <div className={isLoading ? 'ft-loading' : 'ft-empty'} style={childIndent}>
          {isLoading ? t('common.loading') : t('fileTree.emptyDir')}
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
  );
}

// ── 文件节点 ────────────────────────────────────────────────

/** 文件节点：点击或 Enter/Space 打开 */
function FileNode({ path, name, depth, onOpenFile }: NodeProps): ReactElement {
  const isActive = useFileTreeStore((s) => s.activeFilePath === path);
  const isPending = useFileTreeStore((s) => s.pendingOps.has(path));
  const setActiveFile = useFileTreeStore((s) => s.setActiveFile);

  const handleOpen = (): void => {
    setActiveFile(path);
    onOpenFile(path);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // Enter / Space 打开文件（与 button 默认键盘行为对齐）
    if (isActivateKey(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      handleOpen();
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
      <div className="ft-row-wrap" style={indentStyle(depth)}>
        <button
          type="button"
          className={cn('ft-row', 'ft-file', isActive && 'active', isPending && 'pending')}
          onClick={handleOpen}
          title={name}
          tabIndex={-1}
        >
          <span className="ft-icon ft-file-icon">
            <File size={13} strokeWidth={1.5} />
          </span>
          <span className="ft-name" title={name}>
            {name}
          </span>
        </button>
      </div>
    </div>
  );
}
