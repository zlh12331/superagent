// src/renderer/components/worldview/WorldviewTreeNode.tsx
// 世界观树单节点组件（递归）
// 设计文档 §5.1 数据流 + §6.2 Worldview 自关联树形
//
// 职责：
// - 渲染单行节点：展开/折叠箭头 + 图标 + 标题 + 操作菜单
// - 点击节点行上抛 onSelect，由父组件切换 selectedNode
// - 通过 DropdownMenu 提供"新建子节点"与"删除"入口，具体执行由父组件回调处理
// - 自递归渲染 children（depth + 1 缩进）
//
// 注意：
// - 本组件以默认导出形式被 WorldviewTree.tsx 引用，并以自递归方式渲染子孙节点
// - WorldviewTreeNode 类型在此文件定义并通过 `import type` 在容器中复用，
//   避免运行时循环依赖（type-only import 在编译期被擦除）
// - 节点行使用 div + role="treeitem" + tabIndex + onKeyDown 满足 Biome a11y 要求
//   （treeitem 角色支持 aria-selected 与 aria-expanded，且无对应 HTML 元素）
// - DropdownMenu 触发器需 stopPropagation，避免触发节点行的 onSelect

import type { Worldview } from '@novel-writer/shared';
import { ChevronDown, ChevronRight, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import type { KeyboardEvent, ReactElement } from 'react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * 树形节点内部类型
 *
 * 在扁平 Worldview 基础上扩展 children 字段，用于递归渲染。
 * children 由容器组件 buildTree 一次性构造，节点内部不再修改。
 */
export interface WorldviewTreeNode extends Worldview {
  children: WorldviewTreeNode[];
}

interface WorldviewTreeNodeProps {
  /** 当前节点（含 children） */
  node: WorldviewTreeNode;
  /** 当前层级（根节点为 0，每深入一层 +1，用于缩进） */
  depth: number;
  /** 当前选中节点 ID（null 表示未选中） */
  selectedId: string | null;
  /** 选中节点回调 */
  onSelect: (node: Worldview) => void;
  /** 新建子节点回调（传入父节点 ID） */
  onCreateChild: (parentId: string) => void;
  /** 删除节点回调（传入待删除节点 ID） */
  onDelete: (id: string) => void;
}

/**
 * 世界观树单节点（递归组件）
 *
 * @example
 * <WorldviewTreeNode
 *   node={root}
 *   depth={0}
 *   selectedId={selectedId}
 *   onSelect={onSelect}
 *   onCreateChild={onCreateChild}
 *   onDelete={onDelete}
 * />
 */
export function WorldviewTreeNode({
  node,
  depth,
  selectedId,
  onSelect,
  onCreateChild,
  onDelete,
}: WorldviewTreeNodeProps): ReactElement {
  // 展开/折叠状态：默认展开，便于首次进入即看到层级
  const [isExpanded, setIsExpanded] = useState(true);

  const hasChildren = node.children.length > 0;
  const isSelected = selectedId === node.id;

  // 点击节点行：选中该节点（不切换展开状态，避免误操作）
  const handleClick = (): void => {
    onSelect(node);
  };

  // 键盘支持：Enter / Space 触发选中（a11y 要求）
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(node);
    }
  };

  // 点击展开箭头：切换展开状态，并阻止冒泡到节点行（避免重复触发 onSelect）
  const handleToggleExpand = (): void => {
    setIsExpanded((prev) => !prev);
  };

  // 新建子节点：上抛父节点 ID
  const handleCreateChild = (): void => {
    onCreateChild(node.id);
  };

  // 删除节点：上抛节点 ID
  const handleDelete = (): void => {
    onDelete(node.id);
  };

  // 缩进：每层 16px + 基础 8px
  const paddingLeft = depth * 16 + 8;

  return (
    <div>
      <div
        role="treeitem"
        tabIndex={0}
        aria-selected={isSelected}
        aria-expanded={hasChildren ? isExpanded : undefined}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        className={`group flex items-center gap-1 rounded-sm py-1.5 pr-1 transition-colors ${
          isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
        }`}
        style={{ paddingLeft }}
      >
        {/* 展开/折叠箭头：无 children 时占位保持对齐 */}
        {hasChildren ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-5 shrink-0"
            aria-label={isExpanded ? '折叠' : '展开'}
            onClick={(e) => {
              e.stopPropagation();
              handleToggleExpand();
            }}
          >
            {isExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </Button>
        ) : (
          <span className="inline-block size-5 shrink-0" aria-hidden="true" />
        )}

        {/* 节点图标（可选）：来自 node.icon，无则不渲染 */}
        {node.icon !== null && node.icon !== undefined && node.icon.length > 0 && (
          <span className="shrink-0 text-sm" aria-hidden="true">
            {node.icon}
          </span>
        )}

        {/* 标题：自动截断超长文本 */}
        <span className="min-w-0 flex-1 truncate text-sm">{node.title}</span>

        {/* 操作菜单：触发器 stopPropagation 避免触发节点行选中 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              aria-label="节点操作"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={handleCreateChild}>
              <Plus className="size-4" />
              新建子节点
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleDelete} variant="destructive">
              <Trash2 className="size-4" />
              删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 子节点递归渲染：仅当展开且有 children 时显示 */}
      {isExpanded && hasChildren && (
        <div>
          {node.children.map((child) => (
            <WorldviewTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              onCreateChild={onCreateChild}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
