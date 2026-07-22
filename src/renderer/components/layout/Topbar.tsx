// src/renderer/components/layout/Topbar.tsx
// 顶部栏 · 极简文学风
// ──────────────────────────────────────────────────────────────
// 设计：
// - 暖米色背景，过渡到主内容区
// - 左侧：应用标题
// - 右侧：设置按钮 + 主题切换按钮
// - 高度 44px，克制装饰，让出空间给主内容区
//
// 文学风细节：
// - 图标使用 lucide-react 默认线性风格，stroke-width=1.5
// - 主题切换按钮：亮色显示月亮（暗示"切换到夜晚"），暗色显示太阳
// ──────────────────────────────────────────────────────────────

import { Moon, Settings, Sun } from 'lucide-react';
import { type ReactElement, useState } from 'react';

import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { Button } from '@/components/ui/button';
import { TOPBAR_HEIGHT } from '@/lib/constants';
import { useTheme } from '@/providers/ThemeProvider';

/**
 * 顶部栏组件
 *
 * 展示应用标题、设置按钮、主题切换按钮。
 * 设置按钮打开 SettingsDialog（API Key 管理）。
 */
export function Topbar(): ReactElement {
  const { resolvedTheme, setTheme } = useTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <header
      className="bg-sidebar border-sidebar-border flex items-center justify-between border-b px-4"
      style={{ height: TOPBAR_HEIGHT }}
    >
      {/* 左侧：应用标题 */}
      <span className="text-sidebar-foreground font-serif text-sm font-medium tracking-wide">
        网文写作 Agent
      </span>

      {/* 右侧：设置 + 主题切换 */}
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          aria-label="设置"
          onClick={() => setSettingsOpen(true)}
          className="hover:bg-sidebar-accent text-muted-foreground hover:text-sidebar-accent-foreground h-8 w-8"
        >
          <Settings className="size-4" strokeWidth={1.5} />
        </Button>
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
      </div>

      {/* 设置对话框（受控，Topbar 持有开关状态） */}
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </header>
  );
}
