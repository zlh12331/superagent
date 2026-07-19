// src/renderer/routes/worldview.tsx
// 世界观工作台路由（递归树形视图）
// 设计文档 §3 路由结构 + §5.1 数据流 + §6.2 Worldview 自关联树形
//
// 职责：
// - 通过 useWorldviewTree(projectId) 加载扁平 Worldview[]，传给 WorldviewTree 构造递归树
// - 渲染 Loading / Error / 工作台 三种状态（空状态由 WorldviewTree 内部处理）
// - 左侧：WorldviewTree（树形视图 + 新建根节点入口）
// - 右侧：WorldviewEditor（编辑选中节点）
// - 新建根/子节点：内置 Dialog 收集 title（必填） + type/icon（可选）
// - 删除：ConfirmDialog 二次确认
// - 编辑面板保存：调 useUpdateWorldview，成功后用响应数据更新 selectedNode
//
// RR7 lazy 约定：模块需 export function Component（命名导出，非默认导出）

import type { Worldview, WorldviewCreateInput, WorldviewUpdateInput } from '@novel-writer/shared';
import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';

import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ErrorState } from '@/components/common/ErrorState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { WorldviewEditor } from '@/components/worldview/WorldviewEditor';
import { WorldviewTree } from '@/components/worldview/WorldviewTree';
import {
  useCreateWorldview,
  useDeleteWorldview,
  useUpdateWorldview,
  useWorldviewTree,
} from '@/hooks/use-worldview';
import { handleIpcError } from '@/lib/handle-ipc-error';

/**
 * 世界观工作台页面
 *
 * 状态机：
 * - isLoading：展示 LoadingSpinner
 * - error：展示 ErrorState（带重试按钮）
 * - 正常：左侧树 + 右侧编辑面板（空数据由 WorldviewTree 内部 EmptyState 处理）
 */
export function Component(): ReactElement {
  const { projectId } = useParams();
  // useParams 返回 string | undefined，hooks 接受 string | null | undefined
  // 此处直接透传，由 hook 内部 enabled 控制

  // 数据 hooks
  const { data: worldviews, isLoading, error, refetch } = useWorldviewTree(projectId);
  const { mutateAsync: createAsync, isPending: isCreating } = useCreateWorldview();
  const { mutateAsync: updateAsync } = useUpdateWorldview();
  const { mutateAsync: deleteAsync } = useDeleteWorldview();

  // 选中节点（null 表示未选中，编辑面板显示空状态）
  const [selectedNode, setSelectedNode] = useState<Worldview | null>(null);

  // 新建对话框状态：open + parentForCreate（null 表示新建根节点，string 表示新建指定父的子节点）
  const [createOpen, setCreateOpen] = useState(false);
  const [parentForCreate, setParentForCreate] = useState<string | null>(null);

  // 新建对话框表单字段
  const [createTitle, setCreateTitle] = useState('');
  const [createType, setCreateType] = useState('');
  const [createIcon, setCreateIcon] = useState('');

  // 待删除节点 ID（null 表示未进入删除确认流程）
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  /**
   * 选中节点存活检查：当 worldviews 刷新后，检查 selectedNode 是否仍存在
   *
   * 仅处理"选中节点被删除"的情况，不主动用 worldviews 数据替换 selectedNode：
   * - 保存后 selectedNode 来自 mutation 响应（比 worldviews 中的同 id 节点更鲜活）
   * - worldviews 的刷新会让树视图自动更新，无需同步到 selectedNode
   * - selectedNode 不在最新 worldviews 中（被删除）→ 清空选中
   *
   * 依赖 [worldviews, selectedNode]：worldviews 刷新或 selectedNode 变化时重新检查
   */
  useEffect(() => {
    if (selectedNode === null) return;
    if (worldviews === undefined) return;
    // 检查选中节点是否仍在最新 worldviews 中
    const stillExists = worldviews.some((w) => w.id === selectedNode.id);
    if (!stillExists) {
      // 选中节点已被删除：清空选中
      setSelectedNode(null);
    }
  }, [worldviews, selectedNode]);

  /**
   * 打开新建对话框（根节点或子节点共用）
   *
   * @param parentId - null 表示新建根节点，string 表示新建指定父的子节点
   */
  const openCreateDialog = (parentId: string | null): void => {
    setParentForCreate(parentId);
    setCreateTitle('');
    setCreateType('');
    setCreateIcon('');
    setCreateOpen(true);
  };

  /**
   * 提交新建：调用 useCreateWorldview，成功后关闭对话框
   *
   * - title 必填，trim 后非空才允许提交
   * - type/icon 空值用条件展开省略属性（exactOptionalPropertyTypes 要求）
   * - parentId 为 null 时不传该字段（后端默认 null）
   * - 失败时不关闭对话框，让用户可以重试
   */
  const handleCreate = async (): Promise<void> => {
    if (projectId === undefined) return;
    if (createTitle.trim().length === 0) return;

    const trimmedTitle = createTitle.trim();
    const trimmedType = createType.trim();
    const trimmedIcon = createIcon.trim();

    // 构造创建入参：projectId + title 必传，parentId 与 type/icon 可选用条件展开
    // sortOrder 显式传 0：z.infer 返回 OUTPUT 类型（含 .default 的字段被视为必填），
    // 后端在多个同级节点时会基于已有 sortOrder 自动重排，此处 0 仅满足类型约束
    const input: WorldviewCreateInput = {
      projectId,
      title: trimmedTitle,
      sortOrder: 0,
      // parentId: null 时不传该字段，由后端默认 null 兜底
      ...(parentForCreate !== null ? { parentId: parentForCreate } : {}),
      ...(trimmedType.length > 0 ? { type: trimmedType } : {}),
      ...(trimmedIcon.length > 0 ? { icon: trimmedIcon } : {}),
    };

    try {
      await createAsync(input);
      // 成功：关闭对话框（表单已在 openCreateDialog 中重置）
      setCreateOpen(false);
    } catch (err) {
      handleIpcError(err);
      // 失败：不关闭对话框，让用户可以重试
    }
  };

  /**
   * 保存编辑：调用 useUpdateWorldview，成功后用响应数据更新 selectedNode
   *
   * - 用 mutation 响应（最新数据）替换 selectedNode，让编辑面板顶部标题立即更新
   * - worldviews 由 mutation onSuccess 自动 invalidate，会异步刷新树视图
   * - 失败时通过 handleIpcError 显示 toast，编辑面板保持当前表单状态
   */
  const handleSave = async (input: WorldviewUpdateInput): Promise<void> => {
    try {
      const updated = await updateAsync(input);
      // 成功：用 mutation 响应更新 selectedNode（树视图稍后由 worldviews 刷新同步）
      setSelectedNode(updated);
    } catch (err) {
      handleIpcError(err);
    }
  };

  /**
   * 删除节点：由 ConfirmDialog 确认后执行
   *
   * 成功后由 useEffect 检测到 selectedNode 不在 worldviews 中而清空选中
   * 失败时通过 handleIpcError 显示 toast
   */
  const handleDelete = async (): Promise<void> => {
    if (deleteTarget === null) return;
    try {
      await deleteAsync(deleteTarget);
    } catch (err) {
      handleIpcError(err);
    }
    setDeleteTarget(null);
  };

  // 加载中：展示旋转加载占位
  if (isLoading) {
    return <LoadingSpinner label="正在加载世界观..." />;
  }

  // 加载失败：展示错误信息 + 重试按钮
  if (error) {
    return <ErrorState error={error} onRetry={() => void refetch()} />;
  }

  // worldviews 可能为 undefined（理论上 isLoading=false 后必定有值，兜底为空数组）
  const safeWorldviews = worldviews ?? [];

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between">
        <h1 className="text-foreground text-lg font-semibold">世界观</h1>
      </div>

      {/* 主体：左侧树 + 右侧编辑面板 */}
      <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-2">
        {/* 左侧：世界观树（含空状态引导） */}
        <div className="bg-card min-h-0 overflow-hidden rounded-md border">
          <WorldviewTree
            nodes={safeWorldviews}
            selectedId={selectedNode?.id ?? null}
            onSelect={setSelectedNode}
            onCreateRoot={() => openCreateDialog(null)}
            onCreateChild={(parentId) => openCreateDialog(parentId)}
            onDelete={(id) => setDeleteTarget(id)}
          />
        </div>

        {/* 右侧：编辑面板 */}
        <div className="bg-card min-h-0 overflow-hidden rounded-md border">
          <WorldviewEditor
            node={selectedNode}
            onSaved={(input) => void handleSave(input)}
            onCancel={() => {
              // 取消：仅作为表单重置后的兜底回调，路由层不做额外操作
              // 编辑面板内部已重置表单到原始值
            }}
          />
        </div>
      </div>

      {/* 新建节点对话框（受控，root 与 child 共用） */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{parentForCreate === null ? '新建根节点' : '新建子节点'}</DialogTitle>
            <DialogDescription>填写节点基本信息，后续可在右侧面板继续编辑</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            {/* 标题（必填） */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="worldview-create-title">标题 *</Label>
              <Input
                id="worldview-create-title"
                value={createTitle}
                onChange={(e) => setCreateTitle(e.target.value)}
                placeholder="如：玄黄大陆"
                maxLength={200}
              />
            </div>
            {/* 类型（可选） */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="worldview-create-type">类型</Label>
              <Input
                id="worldview-create-type"
                value={createType}
                onChange={(e) => setCreateType(e.target.value)}
                placeholder="如：大陆 / 国家 / 组织 / 力量体系"
                maxLength={50}
              />
            </div>
            {/* 图标（可选，emoji 或单字） */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="worldview-create-icon">图标</Label>
              <Input
                id="worldview-create-icon"
                value={createIcon}
                onChange={(e) => setCreateIcon(e.target.value)}
                placeholder="emoji 或单字，如 🌍 / 国"
                maxLength={10}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={isCreating}>
              取消
            </Button>
            <Button
              onClick={() => void handleCreate()}
              disabled={isCreating || createTitle.trim().length === 0}
            >
              {isCreating ? '创建中...' : '创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除二次确认对话框 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="删除节点"
        description="确定删除此节点？其所有子节点也将一并删除，此操作不可恢复。"
        onConfirm={() => void handleDelete()}
      />
    </div>
  );
}

// RR7 lazy 约定的 display name
Component.displayName = 'WorldviewPage';
