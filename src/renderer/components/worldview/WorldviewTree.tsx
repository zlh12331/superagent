// src/renderer/components/worldview/WorldviewTree.tsx
// 世界观树容器组件
// 设计文档 §5.1 数据流 + §6.2 Worldview 自关联树形
//
// 职责：
// - 接收后端返回的扁平 Worldview[]，通过 buildTree 构造为递归树形结构
// - 顶部标题栏"世界观" + "+ 新建根节点"按钮
// - 用 ScrollArea 包裹整棵树，支持超长滚动
// - 空树显示 EmptyState 引导新建第一个根节点
// - 非空时用 WorldviewTreeNode 递归渲染每个根节点
//
// 注意：
// - buildTree 是纯函数，每次渲染都重新构造（数据量可控，无需 memo）
// - parentId 为 null 或 undefined 均视为根节点（schema 允许 nullable + optional）
// - parentId 指向不存在节点时，视为根节点兜底，避免数据丢失
// - sortOrder 升序：根节点与每层子节点都按 sortOrder 排序

import type { Worldview } from '@novel-writer/shared';
import { FolderTree, Plus } from 'lucide-react';
import type { ReactElement } from 'react';

import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  WorldviewTreeNode,
  type WorldviewTreeNode as WorldviewTreeNodeType,
} from './WorldviewTreeNode';

interface WorldviewTreeProps {
  /** 后端返回的扁平数组（含 parentId） */
  nodes: Worldview[];
  /** 当前选中节点 ID（null 表示未选中） */
  selectedId: string | null;
  /** 选中节点回调 */
  onSelect: (node: Worldview) => void;
  /** 新建根节点回调 */
  onCreateRoot: () => void;
  /** 新建子节点回调（传入父节点 ID） */
  onCreateChild: (parentId: string) => void;
  /** 删除节点回调（传入待删除节点 ID） */
  onDelete: (id: string) => void;
}

/**
 * 将扁平数组构造为递归树形结构
 *
 * 算法：
 * 1. 第一遍遍历：用 Map 缓存所有节点（含 children 空数组）
 * 2. 第二遍遍历：根据 parentId 把节点挂到父节点的 children 上，无父节点的视为根
 * 3. 排序：根节点与每层 children 都按 sortOrder 升序
 *
 * 边界处理：
 * - parentId === null 或 undefined：根节点
 * - parentId 指向不存在的节点：视为根节点（避免数据丢失）
 *
 * @param nodes - 后端返回的扁平节点数组
 * @returns 根节点数组（含递归 children）
 */
function buildTree(nodes: Worldview[]): WorldviewTreeNodeType[] {
  // 第一遍：构造 nodeMap（id → TreeNode），children 初始化为空数组
  const nodeMap = new Map<string, WorldviewTreeNodeType>();
  for (const n of nodes) {
    // 浅拷贝原节点，附加 children 字段（避免污染入参）
    nodeMap.set(n.id, { ...n, children: [] });
  }

  // 第二遍：根据 parentId 挂载到父节点 or 收集为根
  const roots: WorldviewTreeNodeType[] = [];
  for (const node of nodeMap.values()) {
    const parentId = node.parentId;
    if (parentId === null || parentId === undefined) {
      // 根节点：parentId 为 null 或 undefined
      roots.push(node);
    } else {
      // 子节点：尝试挂到父节点的 children 上
      const parent = nodeMap.get(parentId);
      if (parent !== undefined) {
        parent.children.push(node);
      } else {
        // 父节点不存在（数据异常）：兜底为根，避免节点丢失
        roots.push(node);
      }
    }
  }

  // 排序：根节点按 sortOrder 升序
  roots.sort((a, b) => a.sortOrder - b.sortOrder);
  // 排序：每层 children 也按 sortOrder 升序
  for (const node of nodeMap.values()) {
    node.children.sort((a, b) => a.sortOrder - b.sortOrder);
  }

  return roots;
}

/**
 * 世界观树容器
 *
 * @example
 * <WorldviewTree
 *   nodes={worldviews}
 *   selectedId={selectedNode?.id ?? null}
 *   onSelect={setSelectedNode}
 *   onCreateRoot={() => openCreateDialog(null)}
 *   onCreateChild={(parentId) => openCreateDialog(parentId)}
 *   onDelete={(id) => setDeleteTarget(id)}
 * />
 */
export function WorldviewTree({
  nodes,
  selectedId,
  onSelect,
  onCreateRoot,
  onCreateChild,
  onDelete,
}: WorldviewTreeProps): ReactElement {
  // 构造递归树（每次渲染重新构造，数据量可控无需 memo）
  const roots = buildTree(nodes);

  return (
    <div className="flex h-full flex-col">
      {/* 顶部标题栏：标题 + 新建根节点按钮 */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h2 className="text-foreground text-sm font-semibold">世界观</h2>
        <Button variant="ghost" size="sm" onClick={onCreateRoot}>
          <Plus className="size-4" />
          新建根节点
        </Button>
      </div>

      {/* 树体：空状态引导，非空用 ScrollArea 包裹递归渲染 */}
      {roots.length === 0 ? (
        <EmptyState
          icon={<FolderTree className="size-6" />}
          title="暂无世界观"
          description="新建第一个根节点，开始构建你的世界设定"
          actionLabel="新建根节点"
          onAction={onCreateRoot}
        />
      ) : (
        <ScrollArea className="flex-1">
          <div className="p-1">
            {roots.map((root) => (
              <WorldviewTreeNode
                key={root.id}
                node={root}
                depth={0}
                selectedId={selectedId}
                onSelect={onSelect}
                onCreateChild={onCreateChild}
                onDelete={onDelete}
              />
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
