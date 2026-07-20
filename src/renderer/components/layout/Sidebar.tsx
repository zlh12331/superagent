// src/renderer/components/layout/Sidebar.tsx
// 侧边栏 · 极简文学风
// ──────────────────────────────────────────────────────────────
// 设计：
// - 暖米色背景（与 Topbar 同色，形成上下视觉框）
// - 展开态 240px，折叠态 56px（仅图标）
// - 激活态：左侧 3px 墨水条 + 深棕文字 + 暖米高亮底
// - 悬停态：浅暖米底色 + 图标转深棕
// - 图标统一 strokeWidth=1.5，呼应线稿感
//
// 文学风细节：
// - 激活墨水条用 ::before 伪元素（Tailwind before: 修饰符）
// - 折叠态仍保留墨水条（左侧贴边）
// - 文字使用 font-serif 衬线，与 Topbar 标题呼应
//
// 职责分离（避免"项目"导航项混淆）：
// - 项目列表页（/projects）：显示"项目"NavLink，激活态正确
// - 项目内页（/projects/:projectId/*）：顶部显示"返回项目列表"按钮（普通 button，
//   不参与 NavLink 激活态计算），其下显示章节/人物/世界观/AI对话/RAG文档 5 个子导航项
// - 这样"项目列表入口"与"返回按钮"是两个不同的 UI 元素，职责清晰，激活态不会冲突
// ──────────────────────────────────────────────────────────────

import { ArrowLeft, BookOpen, Bot, Database, FolderOpen, Globe, Users } from 'lucide-react';
import type { ReactElement } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SIDEBAR_WIDTH, SIDEBAR_WIDTH_COLLAPSED } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/ui.store';

/** 侧栏导航项定义：标签、图标、目标路径 */
interface NavItem {
  /** 显示名称（折叠态用于 Tooltip） */
  label: string;
  /** 图标 */
  icon: ReactElement;
  /** 目标路由路径（含 :projectId 占位符，运行时替换） */
  to: string;
}

/**
 * 项目内子导航项列表
 *
 * 仅在项目内页显示，列表页（/projects）不显示。
 * 全部依赖 :projectId 路由参数。
 */
const PROJECT_NAV_ITEMS: NavItem[] = [
  {
    label: '章节',
    icon: <BookOpen className="size-4" strokeWidth={1.5} />,
    to: '/projects/:projectId/chapters',
  },
  {
    label: '人物',
    icon: <Users className="size-4" strokeWidth={1.5} />,
    to: '/projects/:projectId/characters',
  },
  {
    label: '世界观',
    icon: <Globe className="size-4" strokeWidth={1.5} />,
    to: '/projects/:projectId/worldview',
  },
  {
    label: 'AI 对话',
    icon: <Bot className="size-4" strokeWidth={1.5} />,
    to: '/projects/:projectId/chat',
  },
  {
    label: 'RAG 文档',
    icon: <Database className="size-4" strokeWidth={1.5} />,
    to: '/projects/:projectId/rag',
  },
];

/**
 * 侧边栏组件
 *
 * 根据 projectId 是否存在分两种渲染模式：
 * - projectId === null：项目列表页，仅显示"项目"NavLink
 * - projectId !== null：项目内页，顶部"返回"按钮 + 项目子导航
 *
 * 折叠态：仅显示图标 + Tooltip（hover 时展开文字），仍保留墨水条
 * 展开态：图标 + 衬线文字横向排列
 *
 * useParams 提供当前路由的 :projectId（如果有），用于替换路径占位符。
 * 同时同步到 useUiStore.setActiveProject 以保持 UI 状态与路由一致。
 */
export function Sidebar(): ReactElement {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const setActiveProject = useUiStore((s) => s.setActiveProject);
  const navigate = useNavigate();
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId ?? null;

  // 同步路由参数到 UI 状态（仅当变化时）
  // 这里使用 useEffect 会过度复杂，直接在渲染时同步即可（Zustand 内部会自动跳过相同值）
  if (projectId !== null) {
    setActiveProject(projectId);
  }

  // 替换路径中的 :projectId 占位符为实际值
  const resolvePath = (to: string): string => to.replace(':projectId', projectId ?? '');

  // 渲染单个 NavLink（共用样式 + 激活墨水条）
  const renderNavLink = (item: NavItem): ReactElement => {
    const to = resolvePath(item.to);
    // 折叠态用 Tooltip 包裹，展开态直接渲染文字
    // 激活态通过 ::before 伪元素绘制左侧墨水条（3px 宽 16px 高，深棕色）
    const link = (
      <NavLink
        key={item.to}
        to={to}
        aria-label={item.label}
        className={({ isActive }) =>
          cn(
            'hover:bg-sidebar-accent group relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors duration-150',
            // 激活态：暖米高亮 + 深棕文字
            isActive
              ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
              : 'text-sidebar-foreground/80 hover:text-sidebar-accent-foreground',
            // 折叠态：图标居中
            collapsed && 'justify-center px-0',
          )
        }
      >
        {({ isActive }) => (
          <>
            {/* 激活态左侧墨水条（3px 宽，深棕色，垂直居中） */}
            {isActive && (
              <span
                aria-hidden
                className={cn(
                  'bg-sidebar-primary absolute top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-[1px]',
                  collapsed ? 'left-1' : 'left-0.5',
                )}
              />
            )}
            {item.icon}
            {!collapsed && <span className="font-serif tracking-wide">{item.label}</span>}
          </>
        )}
      </NavLink>
    );
    return collapsed ? (
      <Tooltip key={item.to}>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right">{item.label}</TooltipContent>
      </Tooltip>
    ) : (
      link
    );
  };

  // 渲染"返回项目列表"按钮（项目内页专用，不参与 NavLink 激活态）
  const renderBackButton = (): ReactElement => {
    const button = (
      <button
        type="button"
        onClick={() => navigate('/projects')}
        aria-label="返回项目列表"
        className={cn(
          'hover:bg-sidebar-accent text-sidebar-foreground/80 hover:text-sidebar-accent-foreground group relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors duration-150',
          collapsed && 'justify-center px-0',
        )}
      >
        <ArrowLeft className="size-4" strokeWidth={1.5} />
        {!collapsed && <span className="font-serif tracking-wide">返回项目列表</span>}
      </button>
    );
    return collapsed ? (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="right">返回项目列表</TooltipContent>
      </Tooltip>
    ) : (
      button
    );
  };

  // 渲染"项目"NavLink（列表页专用）
  const renderProjectsLink = (): ReactElement => {
    const link = (
      <NavLink
        to="/projects"
        aria-label="项目"
        // end：仅精确匹配 /projects 时激活，避免在 /projects/:projectId/* 子路径下误激活
        end
        className={({ isActive }) =>
          cn(
            'hover:bg-sidebar-accent group relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors duration-150',
            isActive
              ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
              : 'text-sidebar-foreground/80 hover:text-sidebar-accent-foreground',
            collapsed && 'justify-center px-0',
          )
        }
      >
        {({ isActive }) => (
          <>
            {isActive && (
              <span
                aria-hidden
                className={cn(
                  'bg-sidebar-primary absolute top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-[1px]',
                  collapsed ? 'left-1' : 'left-0.5',
                )}
              />
            )}
            <FolderOpen className="size-4" strokeWidth={1.5} />
            {!collapsed && <span className="font-serif tracking-wide">项目</span>}
          </>
        )}
      </NavLink>
    );
    return collapsed ? (
      <Tooltip>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right">项目</TooltipContent>
      </Tooltip>
    ) : (
      link
    );
  };

  return (
    <aside
      className="bg-sidebar border-sidebar-border flex flex-col border-r transition-[width] duration-200 ease-out"
      style={{ width: collapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH }}
    >
      <nav className="flex flex-col gap-1 px-2 py-3">
        {/* 项目列表页：仅显示"项目"NavLink */}
        {projectId === null && renderProjectsLink()}

        {/* 项目内页：顶部"返回"按钮 + 项目子导航 */}
        {projectId !== null && (
          <>
            {renderBackButton()}
            {/* 分隔线：返回按钮与项目子导航之间的视觉分隔 */}
            {!collapsed && (
              <div className="border-sidebar-border my-1 ml-3 mr-1 border-t" aria-hidden />
            )}
            {collapsed && <div className="border-sidebar-border mx-2 my-1 border-t" aria-hidden />}
            {PROJECT_NAV_ITEMS.map(renderNavLink)}
          </>
        )}
      </nav>
    </aside>
  );
}
