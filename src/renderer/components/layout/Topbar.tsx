// src/renderer/components/layout/Topbar.tsx
// 顶部栏 · 极简文学风
// ──────────────────────────────────────────────────────────────
// 设计：
// - 暖米色背景（与 Sidebar 同色），过渡到主内容区
// - 左侧：侧栏折叠按钮 + 面包屑（项目名 / 卷宗 / 章节）
// - 右侧：字数统计 + 主题切换 + 设置
// - 高度 44px，克制装饰，让出空间给主编辑区
//
// 文学风细节：
// - 字数统计用等宽字体（呼应"墨水计数"感）
// - 图标使用 lucide-react 默认线性风格，stroke-width=1.5
// - 主题切换按钮：亮色显示月亮（暗示"切换到夜晚"），暗色显示太阳
// ──────────────────────────────────────────────────────────────

import { Menu, Moon, Settings, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router';

import { Button } from '@/components/ui/button';
import { TOPBAR_HEIGHT } from '@/lib/constants';
import { useUiStore } from '@/stores/ui.store';

/**
 * 顶部栏组件
 */
export function Topbar(): ReactElement {
  const navigate = useNavigate();
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <header
      className="bg-sidebar border-sidebar-border flex items-center justify-between border-b px-4"
      style={{ height: TOPBAR_HEIGHT }}
    >
      {/* 左侧：折叠按钮 + 应用标题 */}
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleSidebar}
          aria-label="切换侧栏"
          className="hover:bg-sidebar-accent text-muted-foreground hover:text-sidebar-accent-foreground h-8 w-8"
        >
          <Menu className="size-4" strokeWidth={1.5} />
        </Button>
        <span className="text-sidebar-foreground font-serif text-sm font-medium tracking-wide">
          网文写作 Agent
        </span>
      </div>

      {/* 右侧：主题切换 + 设置 */}
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          aria-label="切换主题"
          onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
          className="hover:bg-sidebar-accent text-muted-foreground hover:text-sidebar-accent-foreground h-8 w-8"
        >
          {resolvedTheme === 'dark' ? (
            <Sun className="size-4" strokeWidth={1.5} />
          ) : (
            <Moon className="size-4" strokeWidth={1.5} />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="设置"
          onClick={() => navigate('/settings')}
          className="hover:bg-sidebar-accent text-muted-foreground hover:text-sidebar-accent-foreground h-8 w-8"
        >
          <Settings className="size-4" strokeWidth={1.5} />
        </Button>
      </div>
    </header>
  );
}
