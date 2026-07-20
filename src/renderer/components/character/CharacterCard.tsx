// src/renderer/components/character/CharacterCard.tsx
// 人物卡片组件 · 极简文学风
// ──────────────────────────────────────────────────────────────
// 设计：
// - 卡片为"册页"风格：奶白底 + 微阴影 + 暖米边框
// - 头像占位：深棕底 + 奶白衬线首字
// - 角色徽章颜色按文学风 token：主角(深棕)/反派(朱砂)/配角(墨绿)/龙套(灰墨)
// - 人物姓名用衬线字体
// - 简介用衬线字体，行高放宽
// - 图标统一 strokeWidth=1.5
// ──────────────────────────────────────────────────────────────
//
// 职责：
// - 展示单个人物的头像、姓名、角色徽章、简介
// - 通过 DropdownMenu 提供编辑 / 删除操作入口（具体执行由父组件回调处理）
// - 删除前由父组件弹出 ConfirmDialog 二次确认
//
// 注意：
// - ROLE_BADGE 使用 Map 而非对象字面量：
//   1) Biome useNamingConvention 要求对象属性名为 camelCase，
//      而 CharacterRole 取值为 UPPER_CASE（'PROTAGONIST' / 'ANTAGONIST' / 'SUPPORTING' / 'MINOR'），
//      用 Map 可将角色值作为字符串键传入，绕开属性命名约束；
//   2) Map.get() 返回 T | undefined，正好契合 noUncheckedIndexedAccess 的兜底需求。
// - 头像缺失时用姓名首字母占位，避免布局抖动
// - 简介为 null/undefined 时整行不渲染，避免出现空段落
// - DropdownMenuItem 用 onSelect（Radix 标准事件），且会打开 Dialog 的操作（编辑/删除）
//   需用 setTimeout(0) 延迟回调，避开 DropdownMenu 关闭时派发 pointerDownOutside 事件
//   导致 ConfirmDialog/CharacterFormDialog 立即被关闭的问题

import type { Character, CharacterRole } from '@novel-writer/shared';
import { MoreVertical, Pencil, Trash2 } from 'lucide-react';
import type { ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface CharacterCardProps {
  /** 当前人物数据 */
  character: Character;
  /** 编辑回调（由父组件打开 CharacterFormDialog 编辑模式） */
  onEdit: (character: Character) => void;
  /** 删除回调（由父组件打开 ConfirmDialog 二次确认） */
  onDelete: (id: string) => void;
}

/** 角色徽章配置：label 为中文文案，className 为 Tailwind 颜色类（基于文学风 token） */
interface RoleBadge {
  label: string;
  className: string;
}

/**
 * 角色徽章映射表（文学风配色）
 *
 * 覆盖 CharacterRole 全部取值：
 * - PROTAGONIST：主角（深棕墨水 primary）
 * - ANTAGONIST：反派（朱砂红 error）
 * - SUPPORTING：配角（墨绿 success）
 * - MINOR：龙套（灰墨 muted）
 */
const ROLE_BADGE = new Map<CharacterRole, RoleBadge>([
  ['PROTAGONIST', { label: '主角', className: 'bg-primary/10 text-primary' }],
  ['ANTAGONIST', { label: '反派', className: 'bg-error/10 text-error' }],
  ['SUPPORTING', { label: '配角', className: 'bg-success/10 text-success' }],
  ['MINOR', { label: '龙套', className: 'bg-muted text-muted-foreground' }],
]);

/** 角色徽章兜底值（理论上不会命中，仅为满足 Map.get() 的 undefined 返回） */
const ROLE_BADGE_FALLBACK: RoleBadge = {
  label: '未知',
  className: 'bg-muted text-muted-foreground',
};

/**
 * 从姓名中提取首字母作为头像占位
 *
 * - 中文姓名取第一个字
 * - 英文姓名取首字母大写
 * - 空字符串兜底为"？"
 */
function getInitial(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return '?';
  return trimmed.charAt(0).toUpperCase();
}

/**
 * 人物卡片
 *
 * @example
 * <CharacterCard
 *   character={character}
 *   onEdit={(c) => openEditDialog(c)}
 *   onDelete={(id) => setDeleteTarget(id)}
 * />
 */
export function CharacterCard({ character, onEdit, onDelete }: CharacterCardProps): ReactElement {
  // Map.get() 返回 T | undefined，用兜底值保证安全
  const role = ROLE_BADGE.get(character.role) ?? ROLE_BADGE_FALLBACK;

  // 编辑操作：延迟一帧上抛，避开 DropdownMenu 关闭时派发的 pointerDownOutside 事件
  // 导致 CharacterFormDialog 立即被关闭的问题
  const handleEdit = (): void => {
    setTimeout(() => onEdit(character), 0);
  };

  // 删除操作：延迟一帧上抛，原因同 handleEdit（ConfirmDialog 同样会被影响）
  const handleDelete = (): void => {
    setTimeout(() => onDelete(character.id), 0);
  };

  return (
    <Card className="shadow-paper hover:shadow-paper border-border transition-shadow duration-200">
      <CardHeader>
        <div className="flex items-start gap-3">
          {/* 头像：有 URL 用 img，否则用深棕底 + 奶白衬线首字占位 */}
          {character.avatar !== null && character.avatar !== undefined ? (
            <img
              src={character.avatar}
              alt={character.name}
              className="border-border size-12 shrink-0 rounded-full border object-cover"
            />
          ) : (
            <div className="bg-primary text-card flex size-12 shrink-0 items-center justify-center rounded-full font-serif text-base font-semibold">
              {getInitial(character.name)}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              {/* 人物姓名用衬线字体 */}
              <span className="truncate font-serif text-sm font-semibold tracking-wide">
                {character.name}
              </span>
              {/* 操作菜单：右上角 */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="人物操作">
                    <MoreVertical className="size-4" strokeWidth={1.5} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={handleEdit}>
                    <Pencil className="size-4" strokeWidth={1.5} />
                    编辑
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={handleDelete} className="text-destructive">
                    <Trash2 className="size-4" strokeWidth={1.5} />
                    删除
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {/* 角色徽章：颜色按角色映射（文学风 token） */}
            <span
              className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium tracking-wide ${role.className}`}
            >
              {role.label}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* 简介用衬线字体，行高放宽（呼应正文感） */}
        {character.description !== null && character.description !== undefined && (
          <p className="text-muted-foreground line-clamp-2 font-serif text-xs leading-relaxed">
            {character.description}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
