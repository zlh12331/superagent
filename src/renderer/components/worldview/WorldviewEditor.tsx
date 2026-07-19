// src/renderer/components/worldview/WorldviewEditor.tsx
// 世界观节点编辑面板
// 设计文档 §5.1 数据流 + §6.2 Worldview 自关联树形 + §7.10 用户友好提示
//
// 职责：
// - 展示当前选中节点的编辑表单（title / type / icon / content 四个字段）
// - node 为 null 时显示 EmptyState 引导用户选择左侧节点
// - node 切换时通过 useEffect 同步表单值（依赖 node.id）
// - 保存按钮：必填校验 title 非空，调用 onSaved 上抛 WorldviewUpdateInput
// - 取消按钮：重置表单到原始值并调用 onCancel
//
// 注意：
// - exactOptionalPropertyTypes 开启：content/type/icon 空值用 null 显式传递（清空原值）
//   不能用 undefined，因为 schema 中这三个字段是 `string | null`
// - title 必填：前端在 Button disabled 上即时反馈
// - useEffect 依赖 [node]：node 对象引用变化时重新同步（父组件刷新数据后会传入新对象）
// - 顶部显示当前节点标题作为路径简化（不递归查找祖先链，避免额外查询开销）

import type { Worldview, WorldviewUpdateInput } from '@novel-writer/shared';
import { FileText } from 'lucide-react';
import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';

import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface WorldviewEditorProps {
  /** 当前选中节点（null 表示未选中） */
  node: Worldview | null;
  /** 保存回调（传入更新入参） */
  onSaved: (input: WorldviewUpdateInput) => void;
  /** 取消回调 */
  onCancel: () => void;
}

/**
 * 世界观节点编辑面板
 *
 * @example
 * <WorldviewEditor
 *   node={selectedNode}
 *   onSaved={(input) => void updateAsync(input)}
 *   onCancel={() => {}}
 * />
 */
export function WorldviewEditor({ node, onSaved, onCancel }: WorldviewEditorProps): ReactElement {
  // 表单本地状态：四个字段独立 useState，简单直观
  const [title, setTitle] = useState('');
  const [type, setType] = useState('');
  const [icon, setIcon] = useState('');
  const [content, setContent] = useState('');

  /**
   * node 变化时同步表单
   *
   * 依赖 [node]：node 对象引用变化时重新同步（包括 id 变化与同 id 数据刷新两种场景）
   * - node 非 null：用其字段填充表单，null/undefined 字段兜底为空字符串
   * - node 为 null：清空所有字段
   */
  useEffect(() => {
    if (node !== null) {
      setTitle(node.title);
      setType(node.type ?? '');
      setIcon(node.icon ?? '');
      setContent(node.content ?? '');
    } else {
      setTitle('');
      setType('');
      setIcon('');
      setContent('');
    }
  }, [node]);

  /**
   * 保存：必填校验 + 上抛更新入参
   *
   * - title 必填，trim 后非空才允许提交
   * - content/type/icon 空值用 null 传递（schema 中为 `string | null`）
   * - sortOrder 不在表单中修改，此处不传（保持后端原值）
   */
  const handleSave = (): void => {
    if (node === null) return;
    // 必填校验：title 不能为空（仅空白也算空）
    if (title.trim().length === 0) return;

    const trimmedTitle = title.trim();
    const trimmedType = type.trim();
    const trimmedIcon = icon.trim();
    const trimmedContent = content.trim();

    // 构造更新入参：id + title 必传，其他字段空值用 null 显式清空
    const input: WorldviewUpdateInput = {
      id: node.id,
      title: trimmedTitle,
      type: trimmedType.length > 0 ? trimmedType : null,
      icon: trimmedIcon.length > 0 ? trimmedIcon : null,
      content: trimmedContent.length > 0 ? trimmedContent : null,
    };
    onSaved(input);
  };

  /**
   * 取消：重置表单到原始值并上抛 onCancel
   *
   * 重新从 node 读取原始值，丢弃用户未保存的编辑
   */
  const handleCancel = (): void => {
    if (node !== null) {
      setTitle(node.title);
      setType(node.type ?? '');
      setIcon(node.icon ?? '');
      setContent(node.content ?? '');
    }
    onCancel();
  };

  // 空状态：未选中节点时引导用户选择左侧节点
  if (node === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={<FileText className="size-6" />}
          title="未选择节点"
          description="请在左侧树中选择一个节点进行编辑"
        />
      </div>
    );
  }

  // 标题必填：trim 后为空时禁用保存按钮
  const isSaveDisabled = title.trim().length === 0;

  return (
    <div className="flex h-full flex-col">
      {/* 顶部：当前节点标题（简化路径，不递归查找祖先链） */}
      <div className="border-b px-4 py-3">
        <p className="text-muted-foreground text-xs">编辑节点</p>
        <p className="text-foreground truncate text-sm font-semibold">{node.title}</p>
      </div>

      {/* 表单主体：可滚动 */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-4">
          {/* 标题（必填） */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="worldview-title">标题 *</Label>
            <Input
              id="worldview-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="如：玄黄大陆"
              maxLength={200}
            />
          </div>

          {/* 类型（可选） */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="worldview-type">类型</Label>
            <Input
              id="worldview-type"
              value={type}
              onChange={(e) => setType(e.target.value)}
              placeholder="如：大陆 / 国家 / 组织 / 力量体系"
              maxLength={50}
            />
          </div>

          {/* 图标（可选，emoji 或单字） */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="worldview-icon">图标</Label>
            <Input
              id="worldview-icon"
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              placeholder="emoji 或单字，如 🌍 / 国"
              maxLength={10}
            />
          </div>

          {/* 内容（可选，详细设定） */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="worldview-content">内容</Label>
            <Textarea
              id="worldview-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="详细描述此节点的设定，如地理、历史、文化、规则等"
              rows={8}
            />
          </div>
        </div>
      </div>

      {/* 底部操作栏：取消 + 保存 */}
      <div className="flex justify-end gap-2 border-t p-3">
        <Button variant="outline" onClick={handleCancel}>
          取消
        </Button>
        <Button onClick={handleSave} disabled={isSaveDisabled}>
          保存
        </Button>
      </div>
    </div>
  );
}
