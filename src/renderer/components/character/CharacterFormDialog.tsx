// src/renderer/components/character/CharacterFormDialog.tsx
// 人物创建/编辑共用对话框 · 极简文学风
// ──────────────────────────────────────────────────────────────
// 设计：
// - 对话框标题用衬线字体
// - 表单标签用衬线字体 + 字间距
// - 按钮风格统一文学风
// - 图标统一 strokeWidth=1.5
// ──────────────────────────────────────────────────────────────
//
// 职责：
// - 受控对话框（open + onOpenChange），收集 name/role/avatar/description 四个字段
// - 创建模式（initial 为 null/undefined）：调用 useCreateCharacter mutateAsync
// - 编辑模式（initial 为 Character）：用 initial 填充表单，调用 useUpdateCharacter mutateAsync
// - 成功后清空表单并关闭对话框；失败时不关闭，让用户可以重试
//
// 注意：
// - name 为必填，前端在 Button disabled 上即时反馈
// - mutation 失败的 toast 由 useIpcMutation 内部 onError 统一处理，组件无需关心
// - exactOptionalPropertyTypes 开启：可选字段需用条件展开，不能显式传 undefined
// - 编辑模式下 avatar/description 允许改为 null（清空原值）；创建模式下空值不传属性
// - ROLE_OPTIONS 使用 Map 而非对象字面量：
//   1) Biome useNamingConvention 要求对象属性名为 camelCase，
//      而 CharacterRole 取值为 UPPER_CASE，用 Map 绕开属性命名约束；
//   2) Map.get() 返回 T | undefined，正好契合 noUncheckedIndexedAccess 的兜底需求。

import type { Character, CharacterRole } from '@novel-writer/shared';
import { Check } from 'lucide-react';
import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';

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
import { Textarea } from '@/components/ui/textarea';
import { useCreateCharacter, useUpdateCharacter } from '@/hooks/use-characters';

interface CharacterFormDialogProps {
  /** 是否打开 */
  open: boolean;
  /** 打开状态变更回调（受控） */
  onOpenChange: (open: boolean) => void;
  /** 所属项目 ID（创建模式必填） */
  projectId: string;
  /** 编辑模式时传入的人物数据；null/undefined 为创建模式 */
  initial?: Character | null;
  /** 保存成功回调（可选，父组件可用于刷新或提示） */
  onSaved?: (character: Character) => void;
}

/** 角色选项配置：label 为中文文案，用于下拉菜单显示 */
interface RoleOption {
  label: string;
}

/**
 * 角色选项映射表
 *
 * 覆盖 CharacterRole 全部取值，与 CharacterCard.ROLE_BADGE 文案保持一致。
 */
const ROLE_OPTIONS = new Map<CharacterRole, RoleOption>([
  ['PROTAGONIST', { label: '主角' }],
  ['ANTAGONIST', { label: '反派' }],
  ['SUPPORTING', { label: '配角' }],
  ['MINOR', { label: '龙套' }],
]);

/** 角色选项兜底值 */
const ROLE_OPTION_FALLBACK: RoleOption = {
  label: '未知',
};

/**
 * 人物创建/编辑对话框
 *
 * @example
 * // 创建模式
 * <CharacterFormDialog open={open} onOpenChange={setOpen} projectId={projectId} />
 *
 * // 编辑模式
 * <CharacterFormDialog
 *   open={open}
 *   onOpenChange={setOpen}
 *   projectId={projectId}
 *   initial={editingCharacter}
 *   onSaved={(c) => console.log('saved', c)}
 * />
 */
export function CharacterFormDialog({
  open,
  onOpenChange,
  projectId,
  initial,
  onSaved,
}: CharacterFormDialogProps): ReactElement {
  // 模式判断：initial 为非空 Character 时进入编辑模式
  const isEdit = initial !== null && initial !== undefined;

  // 表单本地状态：四个字段独立 useState
  const [name, setName] = useState('');
  const [role, setRole] = useState<CharacterRole>('SUPPORTING');
  const [avatar, setAvatar] = useState('');
  const [description, setDescription] = useState('');

  // 创建 / 更新 mutation
  const { mutateAsync: createAsync, isPending: isCreating } = useCreateCharacter();
  const { mutateAsync: updateAsync, isPending: isUpdating } = useUpdateCharacter();
  // 提交中状态：两种模式合并
  const isPending = isCreating || isUpdating;

  /**
   * 打开对话框时同步表单
   *
   * - open=true 时：编辑模式用 initial 填充，创建模式清空
   * - 依赖 [open, initial]：每次 open 或 initial 变化都重新同步
   * - 不依赖其他状态，避免输入过程中表单被重置
   */
  useEffect(() => {
    if (!open) return;
    if (initial !== null && initial !== undefined) {
      // 编辑模式：用 initial 填充表单
      setName(initial.name);
      setRole(initial.role);
      // avatar / description 可能为 null，需兜底为空字符串
      setAvatar(initial.avatar ?? '');
      setDescription(initial.description ?? '');
    } else {
      // 创建模式：清空表单，role 默认 SUPPORTING
      setName('');
      setRole('SUPPORTING');
      setAvatar('');
      setDescription('');
    }
  }, [open, initial]);

  /**
   * 提交表单：创建或更新人物
   *
   * - 必填校验：name 不能为空（仅空白也算空）
   * - avatar/description 在编辑模式下允许传 null（清空原值）
   * - 创建模式下空值不传属性，由后端 default 兜底
   */
  const handleSubmit = async (): Promise<void> => {
    if (name.trim().length === 0) return;

    try {
      // 公共字段：name 与 role 始终传入
      // avatar：编辑模式下允许 null，创建模式下空值不传
      // description：同 avatar
      const trimmedAvatar = avatar.trim();
      const trimmedDescription = description.trim();

      if (isEdit && initial) {
        // 编辑模式：调 updateAsync，传 id 与可空字段
        const updated = await updateAsync({
          id: initial.id,
          name: name.trim(),
          role,
          // 编辑模式：空值显式传 null 以清空原值
          avatar: trimmedAvatar.length > 0 ? trimmedAvatar : null,
          description: trimmedDescription.length > 0 ? trimmedDescription : null,
        });
        onSaved?.(updated);
      } else {
        // 创建模式：调 createAsync，空值用条件展开省略属性
        const created = await createAsync({
          projectId,
          name: name.trim(),
          role,
          ...(trimmedAvatar.length > 0 ? { avatar: trimmedAvatar } : {}),
          ...(trimmedDescription.length > 0 ? { description: trimmedDescription } : {}),
        });
        onSaved?.(created);
      }
      // 成功：关闭对话框（表单在下一次 open 时通过 useEffect 重置）
      onOpenChange(false);
    } catch {
      // 失败：mutation 内部已通过 handleIpcError 显示 toast
      // 此处不关闭对话框，让用户可以重试
    }
  };

  // 当前角色显示文案（用于 DropdownMenu 触发器）
  const currentRole = ROLE_OPTIONS.get(role) ?? ROLE_OPTION_FALLBACK;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          {/* 标题用衬线字体 */}
          <DialogTitle className="font-serif tracking-wide">
            {isEdit ? '编辑人物' : '新建人物'}
          </DialogTitle>
          <DialogDescription>
            {isEdit ? '修改人物基本信息' : '填写人物基本信息，后续可继续编辑'}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          {/* 姓名（必填） */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="character-name" className="font-serif tracking-wide">
              姓名 *
            </Label>
            <Input
              id="character-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：林若曦"
              maxLength={100}
            />
          </div>

          {/* 角色（DropdownMenu 单选） */}
          <div className="flex flex-col gap-2">
            <Label className="font-serif tracking-wide">角色定位</Label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="justify-between" disabled={isPending}>
                  {currentRole.label}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {/* 遍历所有角色选项，选中项显示 Check 图标 */}
                {Array.from(ROLE_OPTIONS.entries()).map(([value, opt]) => (
                  <DropdownMenuItem
                    key={value}
                    onClick={() => setRole(value)}
                    className="justify-between"
                  >
                    {opt.label}
                    {role === value && <Check className="size-4" strokeWidth={1.5} />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* 头像 URL（可选） */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="character-avatar" className="font-serif tracking-wide">
              头像 URL
            </Label>
            <Input
              id="character-avatar"
              value={avatar}
              onChange={(e) => setAvatar(e.target.value)}
              placeholder="https://example.com/avatar.png"
            />
          </div>

          {/* 简介（可选） */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="character-description" className="font-serif tracking-wide">
              简介
            </Label>
            <Textarea
              id="character-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="一句话描述这个人物的性格或背景"
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            取消
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={isPending || name.trim().length === 0}
          >
            {isPending ? '保存中...' : isEdit ? '保存' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
