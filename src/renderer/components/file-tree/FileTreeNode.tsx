import type { FileEntry } from '@code-agent/shared/renderer';
import { ChevronRight, File, Folder, FolderOpen } from 'lucide-react';
import type { KeyboardEvent, ReactElement } from 'react';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { type CreateEntryType, useFileTreeStore } from '@/stores/transient/file-tree-store';
import { indentStyle } from './indent';
import { InlineCreateInput } from './inline-create-input';

/** 文件类型简化为「目录」或「文件」（symlink 暂按文件渲染） */
type NodeType = 'directory' | 'file';

/** 空条目常量：避免每次渲染创建新数组引用 */
const EMPTY_ENTRIES: readonly FileEntry[] = [];

/** 激活键（Enter / Space）：与原生 button 的键盘行为对齐 */
function isActivateKey(key: string): boolean {
  return key === 'Enter' || key === ' ';
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

interface DirProps extends NodeProps {
  /** 内联新建确认回调（父目录 + 类型 + 名称）；仅目录需要（子区才有输入框） */
  readonly onCreate: (parentDir: string, type: CreateEntryType, name: string) => void;
}

interface FileTreeNodeProps extends DirProps {
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
  onCreate,
}: FileTreeNodeProps): ReactElement {
  if (type === 'directory') {
    return (
      <DirNode path={path} name={name} depth={depth} onOpenFile={onOpenFile} onCreate={onCreate} />
    );
  }
  return <FileNode path={path} name={name} depth={depth} onOpenFile={onOpenFile} />;
}

/** 目录节点：展开/折叠 + 子区 */
function DirNode({ path, name, depth, onOpenFile, onCreate }: DirProps): ReactElement {
  const expanded = useFileTreeStore((s) => s.expandedPaths.has(path));
  const isPendingCreate = useFileTreeStore((s) => s.pendingDirs.has(path));
  const toggleExpand = useFileTreeStore((s) => s.toggleExpand);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
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
          className={cn('ft-row', 'ft-dir', isPendingCreate && 'pending')}
          onClick={() => {
            toggleExpand(path);
          }}
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
      {expanded && (
        <DirChildren path={path} depth={depth} onOpenFile={onOpenFile} onCreate={onCreate} />
      )}
    </div>
  );
}

interface DirChildrenProps {
  readonly path: string;
  readonly depth: number;
  readonly onOpenFile: (path: string) => void;
  readonly onCreate: (parentDir: string, type: CreateEntryType, name: string) => void;
}

/**
 * 目录子区：内联新建输入 + 加载中 / 空目录 / 子节点列表
 *
 * 优先级（与原实现一致）：新建输入始终渲染在子条目顶部；无子条目且正在新建时
 * 不显示占位（让位给输入框），否则按 isLoading 区分「加载中」与「空目录」。
 */
function DirChildren({ path, depth, onOpenFile, onCreate }: DirChildrenProps): ReactElement {
  const { t } = useTranslation();
  const entries = useFileTreeStore((s) => s.entries.get(path) ?? EMPTY_ENTRIES);
  const isLoading = useFileTreeStore((s) => s.loadingPaths.has(path));
  const creatingEntry = useFileTreeStore((s) => s.creatingEntry);
  const cancelCreate = useFileTreeStore((s) => s.cancelCreate);

  const creatingHere = creatingEntry?.parentDir === path ? creatingEntry : null;

  return (
    <fieldset className="ft-children">
      {creatingHere !== null && (
        <InlineCreateInput
          type={creatingHere.type}
          depth={depth + 1}
          onConfirm={(newName) => {
            onCreate(path, creatingHere.type, newName);
          }}
          onCancel={cancelCreate}
        />
      )}
      {entries.length === 0 && creatingHere === null ? (
        <div className={isLoading ? 'ft-loading' : 'ft-empty'} style={indentStyle(depth + 1)}>
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
            onCreate={onCreate}
          />
        ))
      )}
    </fieldset>
  );
}

/** 文件节点：点击或 Enter/Space 打开 */
function FileNode({ path, name, depth, onOpenFile }: NodeProps): ReactElement {
  const isActive = useFileTreeStore((s) => s.activeFilePath === path);
  const setActiveFile = useFileTreeStore((s) => s.setActiveFile);

  const handleOpen = (): void => {
    setActiveFile(path);
    onOpenFile(path);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
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
          className={cn('ft-row', 'ft-file', isActive && 'active')}
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
