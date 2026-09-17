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
// 依赖收敛（2026-09 file-tree 审计）：新建动作此前由 DirChildren 直接
// 调用 useFileTreeOps（每个目录节点各实例化一个 mutation hook），
// 组件测试不得不 mock 整个 hook 模块。现改为回调注入（onCreate 与既有的
// onOpenFile 同构），节点只负责「用户做了什么」，落盘与错误提示留在容器
// （FileTreePanel）——树节点自此不依赖 IPC 层。取消新建仍走 store 自身
// 动作（cancelCreate 无副作用，无需上抛给容器）。
//
// 设计：
// - 缩进按 depth 计算（每层 12px，对齐 VS Code 风格），公式单一真源在 ./indent
// - 记忆化：组件为裸函数，依赖 React Compiler 自动记忆化（未手写 memo）；
//   注意 store 订阅是外部状态，JSX 缓存前提在 store 更新时仍会失效
// - 文学风视觉：衬线字体名称 + 等宽元信息 + 文件夹/文件图标
// ──────────────────────────────────────────────────────────────

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

// ── 目录节点 ────────────────────────────────────────────────

/** 目录节点：展开/折叠 + 子区 */
function DirNode({ path, name, depth, onOpenFile, onCreate }: DirProps): ReactElement {
  const expanded = useFileTreeStore((s) => s.expandedPaths.has(path));
  // 新建在途（本目录下有 create IPC 未完成）→ 行内降透明度 + 拦截点击
  const isPendingCreate = useFileTreeStore((s) => s.pendingDirs.has(path));
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
          className={cn('ft-row', 'ft-dir', isPendingCreate && 'pending')}
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

  // 收窄为本目录的新建状态（null = 新建流程不在本目录，无需二次判空）
  const creatingHere = creatingEntry?.parentDir === path ? creatingEntry : null;

  return (
    // fieldset 是 role="group" 的原生元素（Biome useSemanticElements 亦要求用它
    // 而非 div+role）：可展开 treeitem 的子节点容器恰是 group 语义，非"借表单元素
    // 做样式"。其默认 border/padding/margin 由 .ft-children 重置。
    <fieldset className="ft-children">
      {/* 内联新建临时节点：渲染在子条目顶部 */}
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

// ── 文件节点 ────────────────────────────────────────────────

/** 文件节点：点击或 Enter/Space 打开 */
function FileNode({ path, name, depth, onOpenFile }: NodeProps): ReactElement {
  const isActive = useFileTreeStore((s) => s.activeFilePath === path);
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
