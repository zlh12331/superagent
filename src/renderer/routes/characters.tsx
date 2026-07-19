// src/renderer/routes/characters.tsx
// 人物卡路由（人物工作台）
// 设计文档 §3 路由结构 + §5.1 数据流 + §6.2 Character 模型 + §6.3 AGE 关系图
//
// 职责：
// - 通过 useCharacterList 加载人物列表，渲染 Loading / Error / Empty / 工作台四种状态
// - 通过 useCharacterRelations 加载人物关系，传给 CharacterRelationGraph 渲染
// - 左侧：人物卡片网格（响应式 1/2 列）+ 顶部"+ 新建人物"按钮
// - 右侧：CharacterRelationGraph（固定 600px 高度）
// - 编辑：CharacterFormDialog（受控，initial 区分创建/编辑模式）
// - 删除：ConfirmDialog 二次确认
// - 添加关系：CharacterRelationGraph 内部触发，回调调用 useAddCharacterRelation
//
// RR7 lazy 约定：模块需 export function Component（命名导出，非默认导出）

import type { Character, CharacterRelationInput } from '@novel-writer/shared';
import { Plus, Users } from 'lucide-react';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { useParams } from 'react-router';

import { CharacterCard } from '@/components/character/CharacterCard';
import { CharacterFormDialog } from '@/components/character/CharacterFormDialog';
import { CharacterRelationGraph } from '@/components/character/CharacterRelationGraph';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { EmptyState } from '@/components/common/EmptyState';
import { ErrorState } from '@/components/common/ErrorState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Button } from '@/components/ui/button';
import {
  useAddCharacterRelation,
  useCharacterList,
  useCharacterRelations,
  useDeleteCharacter,
} from '@/hooks/use-characters';
import { handleIpcError } from '@/lib/handle-ipc-error';

/**
 * 人物卡页面（人物工作台）
 *
 * 状态机：
 * - isLoading：展示 LoadingSpinner
 * - error：展示 ErrorState（带重试按钮）
 * - 空列表：展示 EmptyState + 新建对话框触发
 * - 正常：左侧人物卡片网格 + 右侧 ReactFlow 关系图
 */
export function Component(): ReactElement {
  const { projectId } = useParams();
  // useParams 返回 string | undefined，hooks 接受 string | null | undefined
  // 此处直接透传，由 hook 内部 enabled 控制

  // 数据 hooks
  // 注：createAsync / updateAsync 由 CharacterFormDialog 内部直接调用
  // 此处只保留 list / relations / delete / addRelation 四个 hook
  const { data: characters, isLoading, error, refetch } = useCharacterList(projectId);
  const { data: relations } = useCharacterRelations(projectId);
  const { mutateAsync: deleteAsync } = useDeleteCharacter();
  const { mutateAsync: addRelationAsync } = useAddCharacterRelation();

  // 表单对话框开关 + 编辑中的人物（null 表示创建模式）
  const [formOpen, setFormOpen] = useState(false);
  const [editingCharacter, setEditingCharacter] = useState<Character | null>(null);
  // 待删除人物 ID（null 表示未进入删除确认流程）
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  /**
   * 打开新建对话框
   * 清空 editingCharacter 进入创建模式，然后打开对话框
   */
  const handleOpenCreate = (): void => {
    setEditingCharacter(null);
    setFormOpen(true);
  };

  /**
   * 打开编辑对话框
   * 设置 editingCharacter 进入编辑模式，然后打开对话框
   */
  const handleOpenEdit = (character: Character): void => {
    setEditingCharacter(character);
    setFormOpen(true);
  };

  /**
   * 删除人物：由 ConfirmDialog 确认后执行
   *
   * 失败已由 mutation onError 统一处理（toast），此处无需再处理
   */
  const handleDelete = async (): Promise<void> => {
    if (deleteTarget === null) return;
    try {
      await deleteAsync(deleteTarget);
    } catch {
      // 失败已由 mutation onError 统一处理（toast），此处无需再处理
    }
    setDeleteTarget(null);
  };

  /**
   * 添加人物关系回调
   *
   * 由 CharacterRelationGraph 内部对话框触发，调用 useAddCharacterRelation
   * 失败时通过 handleIpcError 显示 toast
   */
  const handleAddRelation = (input: CharacterRelationInput): void => {
    void addRelationAsync(input).catch(handleIpcError);
  };

  // 加载中：展示旋转加载占位
  if (isLoading) {
    return <LoadingSpinner label="正在加载人物列表..." />;
  }

  // 加载失败：展示错误信息 + 重试按钮
  if (error) {
    return <ErrorState error={error} onRetry={() => void refetch()} />;
  }

  // 空列表：引导用户新建第一个人物
  if (characters === undefined || characters.length === 0) {
    return (
      <>
        <div className="mx-auto max-w-4xl p-6">
          <EmptyState
            icon={<Users className="size-6" />}
            title="还没有人物"
            description="创建你故事中的第一个角色，开始构建人物关系网络"
            actionLabel="新建人物"
            onAction={handleOpenCreate}
          />
        </div>
        {/* 新建人物对话框（创建模式，projectId 必填） */}
        <CharacterFormDialog
          open={formOpen}
          onOpenChange={setFormOpen}
          projectId={projectId ?? ''}
          initial={editingCharacter}
        />
      </>
    );
  }

  // relations 可能为 undefined（仍在加载），用空数组兜底避免 ReactFlow 收到 undefined
  const safeRelations = relations ?? [];

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      {/* 顶部标题栏 + 新建按钮 */}
      <div className="flex items-center justify-between">
        <h1 className="text-foreground text-lg font-semibold">人物卡</h1>
        <Button size="sm" onClick={handleOpenCreate}>
          <Plus className="size-4" />
          新建人物
        </Button>
      </div>

      {/* 主体：左侧人物卡片网格 + 右侧关系图 */}
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-2">
        {/* 左侧：人物卡片网格（响应式 1/2 列），可滚动 */}
        <div className="overflow-y-auto pr-1">
          <div className="grid gap-3 sm:grid-cols-2">
            {characters.map((c) => (
              <CharacterCard
                key={c.id}
                character={c}
                onEdit={handleOpenEdit}
                onDelete={(id) => setDeleteTarget(id)}
              />
            ))}
          </div>
        </div>

        {/* 右侧：ReactFlow 关系图（固定 600px 高度） */}
        <div className="flex items-start justify-center">
          <CharacterRelationGraph
            characters={characters}
            relations={safeRelations}
            onAddRelation={handleAddRelation}
          />
        </div>
      </div>

      {/* 新建/编辑人物对话框（受控，initial 区分模式） */}
      <CharacterFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        projectId={projectId ?? ''}
        initial={editingCharacter}
      />
      {/* 删除二次确认对话框 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="删除人物"
        description="确定删除此人物？该人物的所有关系也将一并删除，此操作不可恢复。"
        onConfirm={() => void handleDelete()}
      />
    </div>
  );
}

// RR7 lazy 约定的 display name
Component.displayName = 'CharactersPage';
