// src/renderer/components/character/CharacterRelationGraph.tsx
// 人物关系图组件（ReactFlow v12）
// 设计文档 §5.1 数据流 + §6.3 AGE 关系图 + §8 Phase 8 Task 3
//
// 职责：
// - 用 ReactFlow 渲染人物关系网络：每个 Character 一个节点，每条 relation 一条边
// - 节点按角色着色（PROTAGONIST/ANTAGONIST/SUPPORTING/MINOR）
// - 节点圆形布局（按角度均匀分布），不依赖 dagre 等布局库
// - 边带动画（animated: true），label 显示关系类型（如"朋友"/"敌人"）
// - 顶部右上角"+ 添加关系"按钮：弹出对话框收集 from/to/type，提交调 onAddRelation
// - 空状态：characters 为空时显示"还没有人物，先创建人物"
// - 关系为空但有人物：仅显示人物节点，提示"还没有关系，点击右上角添加"
//
// 注意：
// - ReactFlow v12 必须导入 CSS：import '@xyflow/react/dist/style.css'
// - 容器必须显式高度，否则节点不渲染
// - 节点用 style 属性传背景色 + 边框色 + 文字色
// - ROLE_NODE_STYLE 使用 Map 而非对象字面量（绕开 useNamingConvention 对 UPPER_CASE 键的限制）

import type { Character, CharacterRelationInput, CharacterRole } from '@novel-writer/shared';
import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  type Node,
  ReactFlow,
} from '@xyflow/react';
import { Plus } from 'lucide-react';
import type { CSSProperties, ReactElement } from 'react';
import { useMemo, useState } from 'react';
import '@xyflow/react/dist/style.css';

import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface CharacterRelationGraphProps {
  /** 人物列表（节点数据源） */
  characters: Character[];
  /** 关系列表（边数据源） */
  relations: CharacterRelationInput[];
  /** 添加关系回调（提交时调用，由父组件触发 useAddCharacterRelation） */
  onAddRelation?: (input: CharacterRelationInput) => void;
}

/** 角色节点样式配置：nodeColor 为背景色，nodeBorder 为边框色，label 为中文文案 */
interface RoleNodeStyle {
  label: string;
  nodeColor: string;
  nodeBorder: string;
}

/**
 * 角色节点样式映射表
 *
 * 颜色与 CharacterCard.ROLE_BADGE 视觉对齐：
 * - PROTAGONIST：主角（琥珀色 amber）
 * - ANTAGONIST：反派（玫红色 rose）
 * - SUPPORTING：配角（天蓝色 sky）
 * - MINOR：龙套（灰色）
 */
const ROLE_NODE_STYLE = new Map<CharacterRole, RoleNodeStyle>([
  ['PROTAGONIST', { label: '主角', nodeColor: '#fef3c7', nodeBorder: '#f59e0b' }],
  ['ANTAGONIST', { label: '反派', nodeColor: '#ffe4e6', nodeBorder: '#f43f5e' }],
  ['SUPPORTING', { label: '配角', nodeColor: '#e0f2fe', nodeBorder: '#0ea5e9' }],
  ['MINOR', { label: '龙套', nodeColor: '#f3f4f6', nodeBorder: '#9ca3af' }],
]);

/** 节点样式兜底值（理论上不会命中） */
const ROLE_NODE_STYLE_FALLBACK: RoleNodeStyle = {
  label: '未知',
  nodeColor: '#f3f4f6',
  nodeBorder: '#9ca3af',
};

/** 圆形布局半径（像素） */
const LAYOUT_RADIUS = 200;
/** 圆形布局中心点 */
const LAYOUT_CENTER = { x: 400, y: 300 };

/**
 * 根据 Character[] 与 CharacterRelationInput[] 计算 ReactFlow 节点与边
 *
 * - 节点：圆形布局（按角度均匀分布），每个节点背景色 + 边框色按角色映射
 * - 边：animated: true 显示流动效果，label 显示 relation.type
 * - 边 id 用 `${from}-${to}-${index}` 避免重复关系覆盖
 */
function useGraphLayout(
  characters: Character[],
  relations: CharacterRelationInput[],
): { nodes: Node[]; edges: Edge[] } {
  return useMemo(() => {
    // 节点：按角度均匀分布在圆周上
    // characters.length 为 0 的空状态由父组件 EmptyState 处理，此处无需兜底
    const count = characters.length;
    const nodes: Node[] = characters.map((c, i) => {
      const style = ROLE_NODE_STYLE.get(c.role) ?? ROLE_NODE_STYLE_FALLBACK;
      // 节点样式：背景色 + 边框色 + 文字色 + 圆角 + 内边距
      const nodeStyle: CSSProperties = {
        background: style.nodeColor,
        border: `2px solid ${style.nodeBorder}`,
        color: '#1f2937',
        borderRadius: '8px',
        padding: '8px 12px',
        fontSize: '14px',
        fontWeight: 500,
      };
      return {
        id: c.id,
        // type: 'input' 使用内置输入节点样式（带连接句柄）
        type: 'input',
        data: { label: c.name },
        position: {
          x: LAYOUT_CENTER.x + LAYOUT_RADIUS * Math.cos((2 * Math.PI * i) / count),
          y: LAYOUT_CENTER.y + LAYOUT_RADIUS * Math.sin((2 * Math.PI * i) / count),
        },
        style: nodeStyle,
      };
    });

    // 边：每条 relation 一条边，带动画 + label
    const edges: Edge[] = relations.map((r, i) => ({
      id: `${r.fromCharacterId}-${r.toCharacterId}-${i}`,
      source: r.fromCharacterId,
      target: r.toCharacterId,
      label: r.type,
      animated: true,
    }));

    return { nodes, edges };
  }, [characters, relations]);
}

/**
 * 人物关系图
 *
 * @example
 * <CharacterRelationGraph
 *   characters={characters}
 *   relations={relations}
 *   onAddRelation={(input) => void addRelationAsync(input)}
 * />
 */
export function CharacterRelationGraph({
  characters,
  relations,
  onAddRelation,
}: CharacterRelationGraphProps): ReactElement {
  // 添加关系对话框开关
  const [addOpen, setAddOpen] = useState(false);
  // 表单：from / to / type
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [type, setType] = useState('');

  const { nodes, edges } = useGraphLayout(characters, relations);

  /**
   * 提交添加关系
   *
   * 校验：
   * - from / to 必填且不能相同（schema 也会校验自环）
   * - type 必填且 trim 后非空
   */
  const handleAddRelation = (): void => {
    if (!onAddRelation) return;
    if (fromId.length === 0 || toId.length === 0) return;
    if (fromId === toId) return;
    if (type.trim().length === 0) return;

    onAddRelation({
      fromCharacterId: fromId,
      toCharacterId: toId,
      type: type.trim(),
    });
    // 提交后关闭对话框 + 清空表单
    setAddOpen(false);
    setFromId('');
    setToId('');
    setType('');
  };

  // 空状态：没有人物时引导用户先创建人物
  if (characters.length === 0) {
    return (
      <div className="border-border bg-card flex h-[600px] items-center justify-center rounded-xl border">
        <EmptyState title="还没有人物" description="先在左侧创建人物，再来这里可视化人物关系" />
      </div>
    );
  }

  // 通过 ID 查找人物姓名（用于下拉菜单显示）
  const findName = (id: string): string => {
    const c = characters.find((item) => item.id === id);
    return c?.name ?? '请选择';
  };

  // 当前选择的人物姓名（用于 DropdownMenu 触发器显示）
  const fromLabel = fromId.length > 0 ? findName(fromId) : '请选择';
  const toLabel = toId.length > 0 ? findName(toId) : '请选择';

  // 提交按钮可用条件
  const canSubmit =
    fromId.length > 0 && toId.length > 0 && fromId !== toId && type.trim().length > 0;

  return (
    <div className="border-border bg-card relative h-[600px] overflow-hidden rounded-xl border">
      {/* 顶部右上角：添加关系按钮 */}
      <div className="absolute top-3 right-3 z-10">
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="size-4" />
          添加关系
        </Button>
      </div>

      {/* 关系为空但有人物：顶部居中提示 */}
      {relations.length === 0 && (
        <div className="bg-muted/80 text-muted-foreground absolute top-3 left-1/2 z-10 -translate-x-1/2 rounded-full px-3 py-1 text-xs">
          还没有关系，点击右上角添加
        </div>
      )}

      {/* ReactFlow 容器：必须显式高度（h-full 配合父容器 h-[600px]） */}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
      >
        {/* 点状背景 */}
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        {/* 缩放/居中控件 */}
        <Controls showInteractive={false} />
      </ReactFlow>

      {/* 添加关系对话框（受控，内部状态管理） */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加人物关系</DialogTitle>
            <DialogDescription>
              选择起始人物与目标人物，并填写关系类型（如"朋友"/"敌人"/"师徒"）
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            {/* 起始人物 */}
            <div className="flex flex-col gap-2">
              <Label>起始人物</Label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    className="justify-between"
                    disabled={characters.length === 0}
                  >
                    {fromLabel}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {characters.map((c) => (
                    <DropdownMenuItem
                      key={c.id}
                      // 已选为目标人物时禁用，避免自环
                      disabled={c.id === toId}
                      onClick={() => setFromId(c.id)}
                    >
                      {c.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* 目标人物 */}
            <div className="flex flex-col gap-2">
              <Label>目标人物</Label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    className="justify-between"
                    disabled={characters.length === 0}
                  >
                    {toLabel}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {characters.map((c) => (
                    <DropdownMenuItem
                      key={c.id}
                      // 已选为起始人物时禁用，避免自环
                      disabled={c.id === fromId}
                      onClick={() => setToId(c.id)}
                    >
                      {c.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* 关系类型 */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="relation-type">关系类型</Label>
              <Input
                id="relation-type"
                value={type}
                onChange={(e) => setType(e.target.value)}
                placeholder="如：朋友 / 敌人 / 师徒"
                maxLength={50}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              取消
            </Button>
            <Button onClick={handleAddRelation} disabled={!canSubmit}>
              添加
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
