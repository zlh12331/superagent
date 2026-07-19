// src/renderer/components/layout/Topbar.tsx
// 顶部栏（44px 高）
// 设计文档 §3 顶部工具栏 + §4.10 Zustand 选择性订阅
//
// 职责：
// - 左侧：侧栏折叠/展开按钮（Hamburger 图标）
// - 中间：当前路由对应的标题（占位，Phase 8 由路由数据填充）
// - 右侧：主题切换 + 设置入口
//
// 通过 useUiStore 选择性订阅 sidebarCollapsed 状态，
// 仅该字段变更时触发重渲染，其他 UI 状态变更不会影响 Topbar。

import { Menu, Moon, Settings, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router';

import { Button } from '@/components/ui/button';
import { TOPBAR_HEIGHT } from '@/lib/constants';
import { useUiStore } from '@/stores/ui.store';

/**
 * 顶部栏组件
 *
 * 高度固定 TOPBAR_HEIGHT（44px），使用 flex 布局左右对齐。
 * 侧栏折叠按钮通过 useUiStore 的 toggleSidebar 切换状态。
 * 主题切换通过 next-themes 的 useTheme 切换 light/dark。
 * 设置按钮点击后导航到 /settings 路由。
 */
export function Topbar(): ReactElement {
  const navigate = useNavigate();
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <header
      className="bg-background flex items-center justify-between border-b px-3"
      style={{ height: TOPBAR_HEIGHT }}
    >
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={toggleSidebar} aria-label="切换侧栏">
          <Menu className="size-4" />
        </Button>
        <span className="text-foreground/80 text-sm font-medium">网文写作 Agent</span>
      </div>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          aria-label="切换主题"
          onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
        >
          {resolvedTheme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>
        <Button variant="ghost" size="icon" aria-label="设置" onClick={() => navigate('/settings')}>
          <Settings className="size-4" />
        </Button>
      </div>
    </header>
  );
}
