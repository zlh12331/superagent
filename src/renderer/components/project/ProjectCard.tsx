// src/renderer/components/project/ProjectCard.tsx
// 项目卡片组件 · 极简文学风
// ──────────────────────────────────────────────────────────────
// 设计：
// - 卡片为"卷宗"风格：奶白底 + 微阴影 + 暖米边框
// - 标题用衬线字体
// - 状态徽章按文学风 token：进行中(墨绿)/已归档(灰墨)/草稿(琥珀)
// - 时间用衬线字体
// - 图标统一 strokeWidth=1.5
// ──────────────────────────────────────────────────────────────
//
// 职责：
// - 展示单个项目的名称、流派、状态、简介、最近更新时间
// - 点击卡片通过 useNavigate 跳转到项目工作台 /projects/:projectId
// - 通过 DropdownMenu 提供归档/删除操作，具体执行由父组件回调处理
//   （删除前由父组件弹出 ConfirmDialog 二次确认）
//
// 注意：
// - 卡片整体可点击跳转，操作菜单触发器需 stopPropagation 避免触发跳转
// - STATUS_BADGE 使用 Map 而非对象字面量：
//   1) Biome useNamingConvention 要求对象属性名为 camelCase，
//      而 Project['status'] 取值为 UPPER_CASE（'ACTIVE' / 'ARCHIVED' / 'DRAFT'），
//      用 Map 可将状态值作为字符串键传入，绕开属性命名约束；
//   2) Map.get() 返回 T | undefined，正好契合 noUncheckedIndexedAccess 的兜底需求。

import type { Project } from '@novel-writer/shared';
import { Archive, MoreVertical, Trash2 } from 'lucide-react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatRelativeTime } from '@/lib/format';

interface ProjectCardProps {
  /** 当前项目数据 */
  project: Project;
  /** 归档回调（由父组件调用 useArchiveProject） */
  onArchive: (id: string) => void;
  /** 删除回调（由父组件打开 ConfirmDialog） */
  onDelete: (id: string) => void;
}

/** 状态徽章配置：label 为中文文案，className 为 Tailwind 颜色类（文学风 token） */
interface StatusBadge {
  label: string;
  className: string;
}

/**
 * 状态徽章映射表（文学风配色）
 *
 * 覆盖 Project['status'] 全部取值：
 * - ACTIVE：进行中（墨绿 success）
 * - ARCHIVED：已归档（灰墨 muted）
 * - DRAFT：草稿（琥珀 warning）
 */
const STATUS_BADGE = new Map<Project['status'], StatusBadge>([
  ['ACTIVE', { label: '进行中', className: 'bg-success/10 text-success' }],
  ['ARCHIVED', { label: '已归档', className: 'bg-muted text-muted-foreground' }],
  ['DRAFT', { label: '草稿', className: 'bg-warning/10 text-warning' }],
]);

/** 状态徽章兜底值（理论上不会命中，仅为满足 Map.get() 的 undefined 返回） */
const STATUS_BADGE_FALLBACK: StatusBadge = {
  label: '未知',
  className: 'bg-muted text-muted-foreground',
};

/**
 * 项目卡片
 *
 * @example
 * <ProjectCard
 *   project={project}
 *   onArchive={(id) => void archiveAsync(id)}
 *   onDelete={(id) => setDeleteTarget(id)}
 * />
 */
export function ProjectCard({ project, onArchive, onDelete }: ProjectCardProps): ReactElement {
  const navigate = useNavigate();
  // Map.get() 返回 T | undefined，用兜底值保证安全
  const status = STATUS_BADGE.get(project.status) ?? STATUS_BADGE_FALLBACK;

  // 点击卡片跳转到项目工作台
  const handleClick = (): void => {
    navigate(`/projects/${project.id}`);
  };

  // 归档操作（直接上抛项目 ID）
  const handleArchive = (): void => {
    onArchive(project.id);
  };

  // 删除操作（上抛项目 ID，由父组件弹出确认框）
  const handleDelete = (): void => {
    onDelete(project.id);
  };

  return (
    <Card
      className="shadow-paper hover:shadow-paper border-border cursor-pointer transition-shadow duration-200"
      onClick={handleClick}
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            {/* 标题用衬线字体 */}
            <CardTitle className="truncate font-serif tracking-wide">{project.name}</CardTitle>
            {/* 描述用衬线字体 */}
            <CardDescription className="mt-1 font-serif">
              {project.genre ?? '未分类'} · 更新于 {formatRelativeTime(project.updatedAt)}
            </CardDescription>
          </div>
          {/* 操作菜单：在触发器 Button 上 stopPropagation，避免触发卡片整体跳转 */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="项目操作"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical className="size-4" strokeWidth={1.5} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleArchive}>
                <Archive className="size-4" strokeWidth={1.5} />
                归档
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleDelete} className="text-destructive">
                <Trash2 className="size-4" strokeWidth={1.5} />
                删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-2">
          {/* 状态徽章：颜色按文学风 token */}
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium tracking-wide ${status.className}`}
          >
            {status.label}
          </span>
          {/* Project.description 类型为 string | null | undefined，需同时排除 null 与 undefined */}
          {project.description !== undefined && project.description !== null && (
            <p className="text-muted-foreground line-clamp-2 font-serif text-xs leading-relaxed">
              {project.description}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
